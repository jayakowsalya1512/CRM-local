"""Upload storage helpers with forced document compression.

Public file URLs keep the original extension. Document bytes are stored as
``<logical-file>.gz`` and a small JSON sidecar records how to restore the
original file for preview/download routes.
"""

from __future__ import annotations

from dataclasses import dataclass
import gzip
import io
import json
import mimetypes
import os
from pathlib import Path
import threading
import time
import uuid
from typing import BinaryIO
from urllib.parse import urlparse

from app.database import normalize_tenant_slug


MIN_SAVINGS_RATIO = 0.10
META_SUFFIX = ".uploadmeta.json"

ARCHIVE_EXTS = {".zip", ".gz", ".rar", ".7z", ".bz2", ".xz", ".tar", ".tgz"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
GZIP_SKIP_EXTS = ARCHIVE_EXTS


@dataclass
class StoredUpload:
    url: str
    logical_path: Path
    physical_path: Path
    media_slug: str | None
    original_name: str
    content_type: str
    original_size: int
    stored_size: int
    compression_type: str

    @property
    def size_kb(self) -> int:
        return self.stored_size // 1024


def _safe_ext(filename: str | None) -> str:
    ext = Path(filename or "").suffix.lower()
    if not ext or len(ext) > 20:
        return ".bin"
    return ext


def _content_type(filename: str | None, fallback: str | None = None) -> str:
    guessed = mimetypes.guess_type(filename or "")[0]
    return guessed or fallback or "application/octet-stream"


def media_slug_from_request(request) -> str | None:
    raw_slug = None
    tenant = getattr(getattr(request, "state", None), "tenant", None)
    if tenant is not None:
        raw_slug = getattr(tenant, "slug", None)
    raw_slug = raw_slug or getattr(getattr(request, "state", None), "tenant_slug", None)
    if not raw_slug:
        raw_slug = request.headers.get("x-tenant-slug") or request.query_params.get("tenant")
    if not raw_slug:
        return None
    return normalize_tenant_slug(str(raw_slug))


def media_url_to_logical_path(
    *,
    root_dir: str | Path,
    file_url: str,
    url_prefix: str = "/media",
) -> Path:
    parsed_path = urlparse(file_url or "").path
    clean = parsed_path.lstrip("/")
    prefix = url_prefix.strip("/")
    if clean == prefix:
        clean = ""
    elif clean.startswith(prefix + "/"):
        clean = clean[len(prefix) + 1:]
    parts = [part for part in Path(clean).parts if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError("Invalid media path")
    return Path(root_dir).resolve().joinpath(*parts)


def _meta_path(logical_path: Path) -> Path:
    return logical_path.with_name(logical_path.name + META_SUFFIX)


def _write_metadata(upload: StoredUpload) -> None:
    meta = {
        "original_name": upload.original_name,
        "content_type": upload.content_type,
        "original_size": upload.original_size,
        "stored_size": upload.stored_size,
        "compression_type": upload.compression_type,
        "physical_name": upload.physical_path.name,
        "media_slug": upload.media_slug,
    }
    _meta_path(upload.logical_path).write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")


def _read_metadata(logical_path: Path) -> dict:
    path = _meta_path(logical_path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def stored_file_accounted_size(logical_path: str | Path) -> int:
    logical = Path(logical_path)
    meta = _read_metadata(logical)
    for key in ("stored_size", "original_size"):
        try:
            value = int(meta.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value
    physical, _ = resolve_stored_file(logical)
    try:
        return physical.stat().st_size
    except OSError:
        return 0


def stored_upload_accounted_size(
    *,
    original_filename: str | None,
    contents: bytes,
    content_type: str | None = None,
    min_savings_ratio: float = MIN_SAVINGS_RATIO,
    force_compression: bool = True,
) -> int:
    if not contents:
        return 0
    ext = _safe_ext(original_filename)
    stored_bytes, _, _ = _best_stored_bytes(
        contents,
        ext,
        min_savings_ratio,
        force_compression,
    )
    return len(stored_bytes)


def _is_meaningfully_smaller(candidate: bytes, original: bytes, min_savings_ratio: float) -> bool:
    if not original:
        return False
    return len(candidate) <= int(len(original) * (1 - min_savings_ratio))


def _optimize_image(data: bytes, ext: str) -> tuple[bytes, str] | None:
    try:
        from PIL import Image, ImageOps
    except Exception:
        return None

    try:
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image)
            out = io.BytesIO()

            if ext in {".jpg", ".jpeg"}:
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.save(out, format="JPEG", quality=82, optimize=True, progressive=True)
                return out.getvalue(), "image_optimized"

            if ext == ".png":
                image.save(out, format="PNG", optimize=True)
                return out.getvalue(), "image_optimized"

            if ext == ".webp":
                image.save(out, format="WEBP", quality=82, method=6)
                return out.getvalue(), "image_optimized"
    except Exception:
        return None

    return None


def _best_stored_bytes(
    data: bytes,
    ext: str,
    min_savings_ratio: float,
    force_compression: bool,
) -> tuple[bytes, str, str]:
    image_result = _optimize_image(data, ext) if ext in IMAGE_EXTS else None
    if image_result:
        candidate, compression_type = image_result
        if force_compression and len(candidate) <= len(data):
            return candidate, compression_type, ""
        if _is_meaningfully_smaller(candidate, data, min_savings_ratio):
            return candidate, compression_type, ""

    if ext not in GZIP_SKIP_EXTS:
        candidate = gzip.compress(data, compresslevel=6)
        if force_compression:
            return candidate, "gzip", ".gz"
        if _is_meaningfully_smaller(candidate, data, min_savings_ratio):
            return candidate, "gzip", ".gz"

    return data, "none", ""


def _enforce_tenant_storage_limit(media_slug: str | None, extra_bytes: int) -> None:
    from app.services.storage_usage_service import ensure_tenant_storage_available

    ensure_tenant_storage_available(media_slug, extra_bytes)


_block_exec_cache: tuple[float, bool] = (0.0, False)


def _block_executable(ext: str, contents: bytes) -> None:
    """Reject executables while the platform's "Block executable file types" storage policy is on (checked once a minute)."""
    global _block_exec_cache
    if time.time() - _block_exec_cache[0] > 60:
        try:
            from app.database import MasterSessionLocal
            from app.services import platform_storage

            with MasterSessionLocal() as db:
                _block_exec_cache = (time.time(), platform_storage.policy_enabled(db, "block_exec"))
        except Exception:
            _block_exec_cache = (time.time(), _block_exec_cache[1])
    if _block_exec_cache[1]:
        from fastapi import HTTPException
        from app.services.platform_storage import is_executable

        if is_executable(ext, contents[:8]):
            raise HTTPException(status_code=415, detail="Executable files are blocked by the platform storage policy.")


def save_upload_optimized(
    *,
    root_dir: str | Path,
    subfolder: str,
    original_filename: str | None,
    contents: bytes,
    url_prefix: str = "/media",
    media_slug: str | None = None,
    content_type: str | None = None,
    quota_extra_bytes: int | None = None,
    quota_existing_bytes: int | None = None,
    min_savings_ratio: float = MIN_SAVINGS_RATIO,
    force_compression: bool = True,
) -> StoredUpload:
    if not contents:
        raise ValueError("Uploaded file is empty")

    ext = _safe_ext(original_filename)
    _block_executable(ext, contents)
    safe_media_slug = normalize_tenant_slug(media_slug) if media_slug else None
    url_parts = [part for part in (safe_media_slug, subfolder.strip("/")) if part]
    upload_dir = Path(root_dir).resolve().joinpath(*url_parts)
    upload_dir.mkdir(parents=True, exist_ok=True)

    logical_name = f"{uuid.uuid4().hex}{ext}"
    logical_path = upload_dir / logical_name
    stored_bytes, compression_type, physical_suffix = _best_stored_bytes(
        contents,
        ext,
        min_savings_ratio,
        force_compression,
    )
    accounted_extra_bytes = len(stored_bytes)
    if quota_existing_bytes is not None:
        accounted_extra_bytes = max(0, accounted_extra_bytes - int(quota_existing_bytes or 0))
    if quota_extra_bytes is not None:
        accounted_extra_bytes = max(0, int(quota_extra_bytes or 0))
    _enforce_tenant_storage_limit(
        safe_media_slug,
        accounted_extra_bytes,
    )
    physical_path = Path(str(logical_path) + physical_suffix)
    physical_path.write_bytes(stored_bytes)

    upload = StoredUpload(
        url=f"{url_prefix.rstrip('/')}/{'/'.join([*url_parts, logical_name])}",
        logical_path=logical_path,
        physical_path=physical_path,
        media_slug=safe_media_slug,
        original_name=original_filename or logical_name,
        content_type=_content_type(original_filename, content_type),
        original_size=len(contents),
        stored_size=len(stored_bytes),
        compression_type=compression_type,
    )
    _write_metadata(upload)
    if safe_media_slug:
        from app.services.storage_usage_service import refresh_tenant_storage_usage_for_slug

        refresh_tenant_storage_usage_for_slug(safe_media_slug)
    return upload


def resolve_stored_file(logical_path: str | Path) -> tuple[Path, dict]:
    logical = Path(logical_path)
    meta = _read_metadata(logical)
    physical_name = meta.get("physical_name")
    candidates = []
    if meta.get("cold_path"):  # moved to the cold tier by the platform's storage lifecycle
        candidates.append(Path(meta["cold_path"]))
    if physical_name:
        candidates.append(logical.with_name(str(physical_name)))
    candidates.extend([logical, Path(str(logical) + ".gz")])

    for candidate in candidates:
        if candidate.exists():
            return candidate, meta
    return logical, meta


def find_tenant_media_file_by_basename(
    *,
    root_dir: str | Path,
    tenant_slug: str | None,
    filename: str,
) -> Path | None:
    if not tenant_slug:
        return None
    try:
        safe_slug = normalize_tenant_slug(str(tenant_slug))
    except ValueError:
        return None

    basename = Path(urlparse(filename or "").path).name
    if not basename or basename in {".", ".."} or "/" in basename or "\\" in basename:
        return None
    if basename.endswith(META_SUFFIX):
        return None

    tenant_root = Path(root_dir).resolve() / safe_slug
    if not tenant_root.exists() or not tenant_root.is_dir():
        return None

    for candidate in tenant_root.rglob(basename):
        if candidate.is_file():
            return candidate

    gz_name = f"{basename}.gz"
    for candidate in tenant_root.rglob(gz_name):
        if candidate.is_file():
            return Path(str(candidate)[:-3])

    return None


_access_lock = threading.Lock()
_accessed: dict[str, float] = {}


def drain_accesses() -> dict[str, float]:
    """Logical paths opened since the last call (platform storage records them as "last accessed")."""
    global _accessed
    with _access_lock:
        opened, _accessed = _accessed, {}
    return opened


def open_stored_file(logical_path: str | Path) -> tuple[BinaryIO, dict, Path]:
    physical, meta = resolve_stored_file(logical_path)
    if not physical.exists():
        raise FileNotFoundError(str(physical))
    with _access_lock:
        _accessed[os.path.abspath(logical_path)] = time.time()
    if meta.get("compression_type") == "gzip" or physical.suffix == ".gz":
        return gzip.open(physical, "rb"), meta, physical
    return open(physical, "rb"), meta, physical


def iter_file_chunks(file_obj: BinaryIO, chunk_size: int = 1024 * 1024):
    try:
        while True:
            chunk = file_obj.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        file_obj.close()


def delete_stored_file(logical_path: str | Path) -> None:
    logical = Path(logical_path)
    physical, _ = resolve_stored_file(logical)
    candidates = [physical, logical, Path(str(logical) + ".gz"), _meta_path(logical)]
    seen: set[str] = set()

    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass


def stored_file_headers(
    *,
    logical_path: str | Path,
    disposition: str,
    download_name: str | None = None,
) -> tuple[str, dict]:
    logical = Path(logical_path)
    meta = _read_metadata(logical)
    filename = download_name or meta.get("original_name") or logical.name
    content_type = meta.get("content_type") or _content_type(filename)
    return content_type, {"Content-Disposition": f'{disposition}; filename="{filename}"'}
