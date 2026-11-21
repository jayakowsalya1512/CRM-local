"""Documents & Storage (Data & infrastructure → Documents & storage).

Catalogue (master DB, platform_storage_files) of every file in each tenant's upload folders – the same folders
Usage Monitoring measures (storage_usage_service.tenant_file_storage_totals):
  media     MEDIA_ROOT/<slug>                    files written by save_upload_optimized (+ .uploadmeta.json sidecar)
  uploads   UPLOAD_DIR/<slug>                    older uploads, served as static files
  settings  UPLOAD_DIR/tenant_settings/<slug>    logos and other settings files
Owners and links come from a scan of the tenant's own database for rows that mention the file name.

Tiers on our self-hosted storage:
  Hot   on primary storage, uploaded or opened in the last 30 days
  Warm  on primary storage, untouched for 30+ days
  Cold  moved to STORAGE_COLD_DIR (slower disk / NAS); file reads follow the sidecar's cold_path
Quarantine moves the file into STORAGE_QUARANTINE_DIR, outside every served folder, so downloads stop until release.
Malware scans use ClamAV (clamd or clamscan) or Windows Defender; a file is "Verified" only after a clean scan.

Jobs run from the per-minute platform loop (tick) under a MariaDB advisory lock, so one worker runs them:
  every minute    re-index the folders, scan new files (policy), record file opens
  every 15 min    re-read database references (owners, links, orphans) – or at once via "Scan for orphans"
  every hour      lifecycle policies
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from sqlalchemy import text

from app.core.config import settings
from app.database import MasterSessionLocal, get_tenant_session, master_engine, normalize_tenant_slug
from app.models.platform_storage import PlatformStorageFile, PlatformStoragePolicy
from app.utils import file_storage
from app.utils.file_storage import META_SUFFIX

logger = logging.getLogger(__name__)

HOT_DAYS = 30
COLD_AFTER_DAYS = 180
PURGE_AFTER_DAYS = 30
COMPRESS_OVER_BYTES = 5 * 1024 * 1024
REFS_EVERY_SECONDS = 15 * 60
POLICIES_EVERY_SECONDS = 60 * 60
SCAN_BUDGET_SECONDS = 40
FILE_LIST_LIMIT = 5000

POLICIES = [  # key, prototype label, prototype default
    ("cold_180", "Move files untouched for 180 days to cold tier", True),
    ("purge_30", "Purge soft-deleted files after 30 days", True),
    ("dedup", "De-duplicate identical uploads", True),
    ("scan_uploads", "Scan every upload for malware", True),
    ("block_exec", "Block executable file types", True),
    ("compress_images", "Compress images over 5 MB", False),
]
POLICY_LABELS = {key: label for key, label, _ in POLICIES}

EXEC_EXTS = {"exe", "dll", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse",
             "wsf", "wsh", "hta", "jar", "sh", "apk", "app", "reg", "lnk", "elf", "run"}
_EXEC_MAGIC = (b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe")
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp"}

# Tenant tables that only log activity: a file name in a log line is not a link to the file.
_SKIP_TABLES = re.compile(r"(_logs?|_sessions?|_challenges?)$|^(trusted_devices|quick_pin_credentials|activity_logs|audit_logs)$")
_SKIP_COLUMNS = re.compile(r"hash|token|password|secret|otp", re.I)
_OWNER_COLUMNS = ("uploaded_by", "return_uploaded_by", "created_by", "answered_by", "submitted_by", "employee_id", "user_id", "owner_id")
_TOKEN = re.compile(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,10}")
_HEX_ID = re.compile(r"(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])")


# ─── Paths ───────────────────────────────────────────────────────────────────

def tenant_roots(slug: str) -> dict[str, Path]:
    slug = normalize_tenant_slug(slug)
    return {
        "media": Path(os.path.abspath(settings.MEDIA_ROOT)) / slug,
        "uploads": Path(os.path.abspath(settings.UPLOAD_DIR)) / slug,
        "settings": Path(os.path.abspath(settings.UPLOAD_DIR)) / "tenant_settings" / slug,
    }


def quarantine_dir() -> Path:
    return Path(os.path.abspath(settings.STORAGE_QUARANTINE_DIR))


def cold_dir() -> Optional[Path]:
    return Path(os.path.abspath(settings.STORAGE_COLD_DIR)) if settings.STORAGE_COLD_DIR.strip() else None


def cold_status() -> dict:
    path = cold_dir()
    if path is None:
        return {"configured": False, "path": None, "error": "No cold storage configured (set STORAGE_COLD_DIR to a slower disk or NAS mount)"}
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-test"
        probe.write_bytes(b"")
        probe.unlink()
        return {"configured": True, "path": str(path), "error": None}
    except OSError as exc:
        return {"configured": False, "path": str(path), "error": f"Cold storage not writable: {exc}"}


def logical_path(row: PlatformStorageFile) -> Path:
    root = tenant_roots(row.tenant_slug)[row.root]
    path = (root / row.rel_path).resolve()
    if root.resolve() not in path.parents:  # never act outside the tenant's own folder
        raise ValueError("File path is outside the tenant's storage folder")
    return path


def physical_path(row: PlatformStorageFile) -> Path:
    if row.quarantined and row.quarantine_path:
        return Path(row.quarantine_path)
    physical, _ = file_storage.resolve_stored_file(logical_path(row))
    return physical


_meta_cache: dict[str, tuple[int, int, dict]] = {}  # sidecar path -> (mtime_ns, size, content); opening files is slow on some volumes


def _read_meta(logical: Path) -> dict:
    meta_path = logical.with_name(logical.name + META_SUFFIX)
    try:
        stat = meta_path.stat()
    except OSError:
        return {}
    cached = _meta_cache.get(str(meta_path))
    if cached and cached[:2] == (stat.st_mtime_ns, stat.st_size):
        return dict(cached[2])
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    _meta_cache[str(meta_path)] = (stat.st_mtime_ns, stat.st_size, meta)
    return dict(meta)


def _resolve(logical: Path, meta: dict) -> Path:
    """file_storage.resolve_stored_file, for a sidecar already read."""
    candidates = [Path(meta["cold_path"])] if meta.get("cold_path") else []
    if meta.get("physical_name"):
        candidates.append(logical.with_name(str(meta["physical_name"])))
    candidates += [logical, Path(str(logical) + ".gz")]
    return next((c for c in candidates if c.exists()), logical)


def _write_meta(logical: Path, meta: dict) -> None:
    meta_path = logical.with_name(logical.name + META_SUFFIX)
    tmp = meta_path.with_name(meta_path.name + ".tmp")
    tmp.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, meta_path)


def _is_gzip(physical: Path, meta: dict) -> bool:
    return meta.get("compression_type") == "gzip" or (bool(meta) and physical.suffix == ".gz")


def _open_content(physical: Path, meta: dict):
    """The uploaded bytes (decompressed). Not file_storage.open_stored_file, which would count as a user opening the file."""
    return gzip.open(physical, "rb") if _is_gzip(physical, meta) else open(physical, "rb")


def _content_hash(physical: Path, meta: dict) -> tuple[str, bytes]:
    digest = hashlib.sha256()
    head = b""
    with _open_content(physical, meta) as handle:
        while chunk := handle.read(1024 * 1024):
            if not head:
                head = chunk[:8]
            digest.update(chunk)
    return digest.hexdigest(), head


# ─── Folder walk ─────────────────────────────────────────────────────────────

def _walk_root(root_key: str, root: Path) -> list[dict]:
    """Files below one tenant root, sidecar-aware: one entry per logical file."""
    if not root.is_dir():
        return []
    paths = [Path(dirpath) / name for dirpath, _, names in os.walk(root) for name in names]
    covered: set[Path] = set()
    entries = []
    for path in paths:
        if not path.name.endswith(META_SUFFIX):
            continue
        logical = path.with_name(path.name[: -len(META_SUFFIX)])
        meta = _read_meta(logical)
        physical = _resolve(logical, meta)
        covered.update({path, logical, physical, Path(str(logical) + ".gz")})
        entries.append(_entry(root_key, root, logical, physical, meta))
    for path in paths:
        if path in covered or path.name.endswith((META_SUFFIX, ".tmp", ".linktmp")):
            continue
        entries.append(_entry(root_key, root, path, path, {}))
    return entries


def _entry(root_key: str, root: Path, logical: Path, physical: Path, meta: dict) -> dict:
    try:
        stat = physical.stat()
    except OSError:
        stat = None
    size = int(meta.get("stored_size") or 0) or (stat.st_size if stat else 0)
    ext = logical.suffix.lower().lstrip(".")
    return {
        "root": root_key, "rel": logical.relative_to(root).as_posix(), "logical": logical, "physical": physical, "meta": meta,
        "exists": stat is not None, "name": str(meta.get("original_name") or logical.name)[:255], "ext": ext[:20],
        "size": size, "original": int(meta.get("original_size") or 0) or size,
        "mtime": int(stat.st_mtime) if stat else None, "inode": (stat.st_dev, stat.st_ino) if stat and stat.st_ino else None,
        "nlink": stat.st_nlink if stat else 1,
        "cold": bool(meta.get("cold_path")) and cold_dir() is not None and Path(meta["cold_path"]) == physical,
    }


# ─── Tenant database references ──────────────────────────────────────────────

def _tenant_refs(slug: str, names: set[str]) -> tuple[dict[str, dict], Optional[str]]:
    """{file name: {"live": {(table, id)}, "deleted": {...}, "owner": user name}} read from the tenant's database."""
    found: dict[str, dict] = {}
    if not names:
        return found, None
    odd = {n for n in names if not _TOKEN.fullmatch(n)}  # names with spaces etc. are matched as substrings
    # Uploads are named <32 hex>.<ext>; the id alone also counts, as some rows hold a truncated URL (".../<id>.").
    stems = {n.split(".", 1)[0]: n for n in names if _HEX_ID.fullmatch(n.split(".", 1)[0])}
    try:
        session = get_tenant_session(slug)
    except Exception as exc:
        return found, f"Tenant database unavailable: {type(exc).__name__}"
    try:
        columns = session.execute(text(
            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
            "ORDER BY TABLE_NAME, ORDINAL_POSITION")).fetchall()
        keys = dict(session.execute(text(
            "SELECT TABLE_NAME, MIN(COLUMN_NAME) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() "
            "AND CONSTRAINT_NAME = 'PRIMARY' GROUP BY TABLE_NAME")).fetchall())
        tables: dict[str, dict] = {}
        for table, column, data_type in columns:
            info = tables.setdefault(table, {"all": set(), "text": []})
            info["all"].add(column)
            if data_type in ("char", "varchar", "tinytext", "text", "mediumtext", "longtext", "json") and not _SKIP_COLUMNS.search(column):
                info["text"].append(column)
        users = {}
        if "users" in tables:
            users = {uid: name for uid, name in session.execute(text("SELECT id, COALESCE(NULLIF(full_name, ''), username) FROM users")).fetchall()}
        for table, info in tables.items():
            if _SKIP_TABLES.search(table) or not info["text"] or table not in keys:
                continue
            owner_cols = [f"`{c}`" for c in _OWNER_COLUMNS if c in info["all"]]
            extra = [f"COALESCE({', '.join(owner_cols)}, NULL)" if owner_cols else "NULL",
                     "`deleted_at`" if "deleted_at" in info["all"] else "NULL",
                     "`is_deleted`" if "is_deleted" in info["all"] else "NULL"]
            for column in info["text"]:
                try:
                    rows = session.execute(text(
                        f"SELECT `{keys[table]}`, `{column}`, {', '.join(extra)} FROM `{table}` WHERE `{column}` LIKE '%.%' OR `{column}` LIKE '%/%'")).fetchall()
                except Exception:
                    logger.debug("Reference scan skipped %s.%s", table, column, exc_info=True)
                    continue
                for pk, value, owner, deleted_at, is_deleted in rows:
                    value = value.decode("utf-8", "ignore") if isinstance(value, bytes) else str(value)
                    hits = ({t for t in _TOKEN.findall(value) if t in names} | {n for n in odd if n in value}
                            | {stems[h] for h in _HEX_ID.findall(value) if h in stems})
                    for name in hits:
                        ref = found.setdefault(name, {"live": set(), "deleted": set(), "owner": None})
                        ref["deleted" if deleted_at is not None or is_deleted else "live"].add((table, str(pk)))
                        if ref["owner"] is None and owner is not None:
                            try:
                                ref["owner"] = users.get(int(owner))
                            except (TypeError, ValueError):
                                pass
        return found, None
    except Exception as exc:
        logger.warning("Reference scan failed for tenant %s", slug, exc_info=True)
        return found, f"Reference scan failed: {type(exc).__name__}"
    finally:
        session.close()


# ─── Index ───────────────────────────────────────────────────────────────────
_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    PlatformStorageFile.__table__.create(bind=master_engine, checkfirst=True)
    PlatformStoragePolicy.__table__.create(bind=master_engine, checkfirst=True)
    with MasterSessionLocal() as db:
        existing = {key for (key,) in db.query(PlatformStoragePolicy.key).all()}
        for key, _, default in POLICIES:
            if key not in existing:
                db.add(PlatformStoragePolicy(key=key, enabled=default))
        db.commit()
    _schema_ready = True


def _state(db, key: str) -> PlatformStoragePolicy:
    row = db.get(PlatformStoragePolicy, key)
    if row is None:
        row = PlatformStoragePolicy(key=key, enabled=False)
        db.add(row)
        db.flush()
    return row


def index_tenant(db, slug: str, refs: bool) -> dict:
    """Bring the catalogue in line with the tenant's folders; with refs, also re-read database references."""
    entries = [e for key, root in tenant_roots(slug).items() for e in _walk_root(key, root)]
    existing = {(r.root, r.rel_path): r for r in db.query(PlatformStorageFile).filter(PlatformStorageFile.tenant_slug == slug).all()}
    ref_map, ref_error = _tenant_refs(slug, {e["logical"].name for e in entries}) if refs else ({}, None)
    seen_inodes: set = set()
    now = datetime.utcnow()
    for entry in sorted(entries, key=lambda e: (e["mtime"] or 0, e["rel"])):  # the oldest copy owns shared content
        row = existing.pop((entry["root"], entry["rel"][:500]), None)
        if row is None:
            row = PlatformStorageFile(tenant_slug=slug, root=entry["root"], rel_path=entry["rel"][:500], scan_status="pending",
                                      uploaded_at=datetime.utcfromtimestamp(entry["mtime"]) if entry["mtime"] else now)
            db.add(row)
        if row.quarantined:
            continue  # the quarantined copy is what counts; its folder entry is only the sidecar
        row.name, row.ext, row.size_bytes, row.original_bytes = entry["name"], entry["ext"], entry["size"], entry["original"]
        row.cold = entry["cold"]
        if entry["exists"] and (row.sha256 is None or row.content_mtime != entry["mtime"]):
            try:
                row.sha256, _ = _content_hash(entry["physical"], entry["meta"])
            except Exception as exc:
                row.sha256 = None
                row.scan_detail = f"Unreadable: {type(exc).__name__}"
            if row.content_mtime is not None and row.scan_status != "released":
                row.scan_status = "pending"  # content changed since the last scan
            row.content_mtime = entry["mtime"]
        shared = entry["inode"] is not None and entry["inode"] in seen_inodes  # st_nlink is always 1 on SMB shares
        if entry["inode"] is not None:
            seen_inodes.add(entry["inode"])
        row.shared_bytes = entry["size"] if shared else 0
        if refs and not ref_error:
            ref = ref_map.get(entry["logical"].name)
            row.links = len(ref["live"]) if ref else 0
            row.deleted_links = len(ref["deleted"]) if ref else 0
            row.owner = ref["owner"] if ref else None
            row.refs = [f"{t} #{pk}" for t, pk in sorted(ref["live"] | ref["deleted"])[:5]] if ref else []
        row.indexed_at = now
    for row in existing.values():
        if not row.quarantined:
            db.delete(row)  # removed from disk by the tenant application
    db.flush()
    return {"files": len(entries), "ref_error": ref_error}


def _tenant_slugs(db) -> list[str]:
    return [slug for (slug,) in db.execute(text("SELECT slug FROM tenants ORDER BY slug")).fetchall()]


def index_all(refs: bool) -> dict:
    ensure_schema()
    started = time.time()
    with MasterSessionLocal() as db:
        state = _state(db, "_refs" if refs else "_index")
        files, errors = 0, []
        for slug in _tenant_slugs(db):
            try:
                result = index_tenant(db, slug, refs)
                files += result["files"]
                if result["ref_error"]:
                    errors.append(f"{slug}: {result['ref_error']}")
                db.commit()
            except Exception as exc:
                db.rollback()
                logger.exception("Storage index failed for tenant %s", slug)
                errors.append(f"{slug}: {type(exc).__name__}")
        state = _state(db, "_refs" if refs else "_index")
        state.last_run_at = datetime.utcnow()
        if refs:
            orphans = db.query(PlatformStorageFile).filter(PlatformStorageFile.links == 0, PlatformStorageFile.deleted_links == 0,
                                                           PlatformStorageFile.quarantined == False).count()  # noqa: E712
            state.last_result = f"{files} files checked against tenant databases · {orphans} orphaned · {time.time() - started:.1f}s"
        else:
            state.last_result = f"{files} files indexed"
        state.last_error = "; ".join(errors) or None
        db.commit()
    return {"files": files, "errors": errors}


# ─── File access tracking ────────────────────────────────────────────────────

def flush_accesses() -> None:
    opened = file_storage.drain_accesses()
    if not opened:
        return
    ensure_schema()
    # Callers pass drive-letter or UNC forms of the same path (a mapped network drive); compare real paths.
    opened = {os.path.normcase(os.path.realpath(path)): ts for path, ts in opened.items()}
    with MasterSessionLocal() as db:
        state = _state(db, "_access")
        state.last_run_at = state.last_run_at or datetime.utcnow()  # tracking start, shown on the page
        for slug in _tenant_slugs(db):
            for root_key, root in tenant_roots(slug).items():
                root = Path(os.path.normcase(os.path.realpath(root)))
                for path, ts in opened.items():
                    try:
                        rel = Path(path).relative_to(root).as_posix()
                    except ValueError:
                        continue
                    row = db.query(PlatformStorageFile).filter_by(tenant_slug=slug, root=root_key, rel_path=rel).first()
                    when = datetime.utcfromtimestamp(ts)
                    if row is not None and (row.last_accessed_at is None or row.last_accessed_at < when):
                        row.last_accessed_at = when
        db.commit()


# ─── Malware scanning ────────────────────────────────────────────────────────
_scanner_cache: tuple[float, dict] | None = None


def _defender_path() -> Optional[str]:
    if os.name != "nt":
        return None
    path = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Windows Defender" / "MpCmdRun.exe"
    return str(path) if path.exists() else None


def _clamd(command: bytes, payload: Optional[bytes] = None, stream=None) -> str:
    with socket.create_connection((settings.CLAMAV_HOST, int(settings.CLAMAV_PORT)), timeout=60) as sock:
        sock.sendall(command)
        if stream is not None:
            while chunk := stream.read(64 * 1024):
                sock.sendall(struct.pack("!L", len(chunk)) + chunk)
            sock.sendall(struct.pack("!L", 0))
        reply = b""
        while not reply.endswith(b"\0") and (part := sock.recv(4096)):
            reply += part
    return reply.rstrip(b"\0").decode("utf-8", "replace").strip()


def scanner() -> dict:
    """The malware scanner in use: {"available", "name", "kind", "error"} (cached 5 min)."""
    global _scanner_cache
    if _scanner_cache and time.time() - _scanner_cache[0] < 300:
        return _scanner_cache[1]
    choice = (settings.MALWARE_SCANNER or "auto").lower()
    info = {"available": False, "name": None, "kind": None, "error": "No malware scanner found (install ClamAV or set CLAMAV_HOST)"}
    if choice == "none":
        info["error"] = "Malware scanning is switched off (MALWARE_SCANNER=none)"
    else:
        if settings.CLAMAV_HOST and choice in ("auto", "clamd"):
            try:
                if _clamd(b"zPING\0") == "PONG":
                    info = {"available": True, "name": f"ClamAV daemon ({settings.CLAMAV_HOST})", "kind": "clamd", "error": None}
                else:
                    info["error"] = "ClamAV daemon did not answer PING"
            except OSError as exc:
                info["error"] = f"ClamAV daemon unreachable: {exc}"
        if not info["available"] and choice in ("auto", "clamscan"):
            for binary in ("clamdscan", "clamscan"):
                if shutil.which(binary):
                    info = {"available": True, "name": f"ClamAV ({binary})", "kind": binary, "error": None}
                    break
        if not info["available"] and choice in ("auto", "defender") and _defender_path():
            info = {"available": True, "name": "Microsoft Defender", "kind": "defender", "error": None}
    _scanner_cache = (time.time(), info)
    return info


def scan_file(physical: Path, meta: dict) -> tuple[str, str]:
    """("clean" | "infected" | "error", detail). Compressed files are scanned as uploaded."""
    info = scanner()
    if not info["available"]:
        return "error", info["error"]
    temp = None
    try:
        if info["kind"] == "clamd":
            with _open_content(physical, meta) as handle:
                reply = _clamd(b"zINSTREAM\0", stream=handle)
            if reply.endswith("OK"):
                return "clean", info["name"]
            if reply.endswith("FOUND"):
                return "infected", reply.split(":", 1)[-1].replace("FOUND", "").strip()
            return "error", reply[:300]
        target = physical
        if _is_gzip(physical, meta):
            scratch = quarantine_dir() / ".scan"
            scratch.mkdir(parents=True, exist_ok=True)
            temp = scratch / f"{os.getpid()}_{threading.get_ident()}_{physical.name[:-3] if physical.suffix == '.gz' else physical.name}"
            with _open_content(physical, meta) as src, open(temp, "wb") as dst:
                shutil.copyfileobj(src, dst)
            target = temp
        if info["kind"] in ("clamdscan", "clamscan"):
            proc = subprocess.run([info["kind"], "--no-summary", str(target)], capture_output=True, text=True, timeout=300)
            if proc.returncode == 0:
                return "clean", info["name"]
            if proc.returncode == 1:
                return "infected", proc.stdout.strip().split(":", 1)[-1].replace("FOUND", "").strip()[:300]
            return "error", (proc.stderr or proc.stdout).strip()[:300]
        proc = subprocess.run([_defender_path(), "-Scan", "-ScanType", "3", "-File", str(target), "-DisableRemediation"],
                              capture_output=True, text=True, timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if proc.returncode == 0:
            return "clean", info["name"]
        if proc.returncode == 2:
            threat = re.search(r"Threat\s*:\s*(.+)", proc.stdout)
            return "infected", (threat.group(1).strip() if threat else "Threat found")[:300]
        return "error", f"Defender exit {proc.returncode}: {proc.stdout.strip()[-200:]}"
    except Exception as exc:
        return "error", f"{type(exc).__name__}: {exc}"[:300]
    finally:
        if temp is not None:
            try:
                temp.unlink()
            except OSError:
                pass  # real-time protection may already have removed an infected copy


def scan_pending(db, budget: float = SCAN_BUDGET_SECONDS, slugs: Optional[list[str]] = None) -> dict:
    if not scanner()["available"]:
        return {"scanned": 0, "infected": 0}
    deadline = time.time() + budget
    scanned = infected = 0
    query = db.query(PlatformStorageFile).filter(PlatformStorageFile.scan_status == "pending", PlatformStorageFile.quarantined == False)  # noqa: E712
    if slugs is not None:
        query = query.filter(PlatformStorageFile.tenant_slug.in_(slugs))
    rows = query.order_by(PlatformStorageFile.id.desc()).limit(500).all()  # newest uploads first
    for row in rows:
        if time.time() > deadline:
            break
        try:
            logical = logical_path(row)
            physical, meta = file_storage.resolve_stored_file(logical)
            if not physical.exists():
                continue
            status, detail = scan_file(physical, meta)
        except Exception as exc:
            status, detail = "error", f"{type(exc).__name__}"
        row.scan_status, row.scan_detail, row.scanned_at, row.scanner = status, detail, datetime.utcnow(), scanner()["name"]
        scanned += 1
        if status == "infected":
            infected += 1
            quarantine(db, row, f"Malware detected: {detail}")
            _audit(db, None, "storage_quarantine", row, f"Quarantined {row.name} ({row.tenant_slug}): malware detected – {detail}")
        db.commit()
    return {"scanned": scanned, "infected": infected}


# ─── File actions ────────────────────────────────────────────────────────────

def _audit(db, admin, action: str, row: Optional[PlatformStorageFile], description: str, ip: str = "system", new: Optional[dict] = None) -> None:
    from app.routers.platform_router import _write_platform_audit

    _write_platform_audit(db, admin, action, "storage_file", row.id if row else None, row.name if row else None, description, ip, new_data=new)


def _refresh_usage(slug: str) -> None:
    from app.services.storage_usage_service import refresh_tenant_storage_usage_for_slug

    refresh_tenant_storage_usage_for_slug(slug)


def quarantine(db, row: PlatformStorageFile, reason: str) -> None:
    if row.quarantined:
        return
    source = physical_path(row)
    if not source.exists():
        raise FileNotFoundError("The file is no longer on disk")
    target_dir = quarantine_dir() / normalize_tenant_slug(row.tenant_slug)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{row.id}_{source.name}"
    shutil.move(str(source), str(target))
    row.quarantined, row.quarantine_reason, row.quarantine_path = True, reason[:500], str(target)
    row.quarantine_from, row.quarantined_at = str(source), datetime.utcnow()
    db.flush()


def release(db, row: PlatformStorageFile) -> None:
    if not row.quarantined:
        raise ValueError("The file is not in quarantine")
    source, target = Path(row.quarantine_path), Path(row.quarantine_from)
    if not source.exists():
        raise FileNotFoundError("The quarantined copy is missing")
    if target.exists():
        raise FileExistsError("Another file now occupies the original location")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    row.quarantined, row.quarantine_path, row.quarantine_from, row.quarantined_at = False, None, None, None
    if row.scan_status in ("infected", "error", "pending"):
        row.scan_status = "released"  # reviewed by staff; not scanned or blocked again unless the content changes
    row.scan_detail = f"Released after manual review ({row.quarantine_reason or 'no reason recorded'})"[:500]
    row.quarantine_reason = None
    db.flush()


def delete(db, row: PlatformStorageFile) -> None:
    if row.quarantined and row.quarantine_path:
        try:
            Path(row.quarantine_path).unlink()
        except FileNotFoundError:
            pass
    file_storage.delete_stored_file(logical_path(row))  # also removes the sidecar and a cold copy
    slug = row.tenant_slug
    db.delete(row)
    db.flush()
    _refresh_usage(slug)


def move_to_cold(db, row: PlatformStorageFile) -> None:
    status = cold_status()
    if not status["configured"]:
        raise RuntimeError(status["error"])
    if row.cold:
        return
    if row.quarantined:
        raise RuntimeError("Release the file from quarantine first")
    if row.root != "media":
        raise RuntimeError("Only files served through the document routes can move to cold storage")
    logical = logical_path(row)
    physical, meta = file_storage.resolve_stored_file(logical)
    if not physical.exists():
        raise FileNotFoundError("The file is no longer on disk")
    target = cold_dir() / normalize_tenant_slug(row.tenant_slug) / Path(row.rel_path).parent / physical.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(physical, target)  # copy, record, then remove: a crash in between leaves a readable file
    if not meta:
        meta = {"original_name": row.name, "content_type": file_storage._content_type(row.name), "original_size": row.original_bytes,
                "stored_size": row.size_bytes, "compression_type": "none", "physical_name": physical.name,
                "media_slug": row.tenant_slug}
    meta["cold_path"] = str(target)
    _write_meta(logical, meta)
    physical.unlink()
    row.cold = True
    db.flush()


def is_executable(ext: str, head: bytes) -> bool:
    return ext.lower().lstrip(".") in EXEC_EXTS or any(head.startswith(m) for m in _EXEC_MAGIC)


# ─── Lifecycle policies ──────────────────────────────────────────────────────

def policy_enabled(db, key: str) -> bool:
    ensure_schema()
    row = db.get(PlatformStoragePolicy, key)
    return bool(row and row.enabled)


def policy_availability(key: str) -> Optional[str]:
    """None when the policy can run here, else why not."""
    if key == "cold_180":
        status = cold_status()
        return None if status["configured"] else status["error"]
    if key == "scan_uploads":
        info = scanner()
        return None if info["available"] else info["error"]
    if key == "compress_images":
        try:
            import PIL  # noqa: F401
        except ImportError:
            return "Pillow is not installed"
    return None


def _run_cold(db) -> str:
    cutoff = datetime.utcnow() - timedelta(days=COLD_AFTER_DAYS)
    moved, errors = 0, 0
    for row in db.query(PlatformStorageFile).filter(PlatformStorageFile.cold == False, PlatformStorageFile.quarantined == False,  # noqa: E712
                                                    PlatformStorageFile.root == "media").all():
        if max(row.last_accessed_at or datetime.min, row.uploaded_at or datetime.min) >= cutoff:
            continue
        try:
            move_to_cold(db, row)
            moved += 1
        except Exception:
            errors += 1
            logger.warning("Cold move failed for storage file %s", row.id, exc_info=True)
        db.commit()
    return f"{moved} file(s) moved to cold storage" + (f", {errors} failed" if errors else "")


def _run_purge(db) -> str:
    """Permanently delete Documents-module files that sit in the recycle bin for over 30 days (as the bin's own delete does)."""
    from app.core.timezone import now_ist
    from app.models.all_models import AuditLog, DocumentManagementFile
    from app.routers.recycle_bin_router import _delete_document
    from sqlalchemy import case, func

    cutoff = now_ist() - timedelta(days=PURGE_AFTER_DAYS)
    purged, errors = 0, []
    for slug in _tenant_slugs(db):
        try:
            session = get_tenant_session(slug)
        except Exception:
            errors.append(slug)
            continue
        try:
            document_id = func.concat("standalone:", case((func.coalesce(DocumentManagementFile.linked_source, "standalone") == "standalone", 0),
                                                         else_=func.coalesce(DocumentManagementFile.linked_record_id, 0)),
                                      ":", DocumentManagementFile.id, ":",
                                      func.lower(func.replace(func.coalesce(DocumentManagementFile.doc_type, "Uploaded Document"), " ", "_")))
            due = session.query(document_id, DocumentManagementFile.name).filter(
                DocumentManagementFile.deleted_at.isnot(None), DocumentManagementFile.deleted_at < cutoff).all()
            for record_id, name in due:
                _delete_document(session, record_id, None)
                session.add(AuditLog(user_id=None, module="recycle_bin", action="delete", record_name=name, ip_address="system",
                                     description=f"Purged from the recycle bin after {PURGE_AFTER_DAYS} days (platform storage policy)"))
                session.commit()
                for file_url in session.info.pop("recycle_files", []):
                    try:
                        file_storage.delete_stored_file(file_storage.media_url_to_logical_path(root_dir=os.path.abspath(settings.MEDIA_ROOT), file_url=file_url))
                    except Exception:
                        logger.warning("Purged document file could not be removed: %s", file_url, exc_info=True)
                purged += 1
            if due:
                _refresh_usage(slug)
        except Exception:
            session.rollback()
            logger.exception("Recycle-bin purge failed for tenant %s", slug)
            errors.append(slug)
        finally:
            session.close()
    return f"{purged} soft-deleted document(s) purged" + (f"; failed for {', '.join(errors)}" if errors else "")


def _run_dedup(db, slugs: Optional[list[str]] = None) -> str:
    """Within each tenant, make identical uploads share one copy on disk (hard links); every file keeps its own name and sidecar."""
    linked, saved, errors = 0, 0, 0
    rows = db.query(PlatformStorageFile).filter(PlatformStorageFile.sha256.isnot(None), PlatformStorageFile.quarantined == False,  # noqa: E712
                                                PlatformStorageFile.cold == False, PlatformStorageFile.size_bytes > 0)
    if slugs is not None:
        rows = rows.filter(PlatformStorageFile.tenant_slug.in_(slugs))
    rows = rows.order_by(PlatformStorageFile.uploaded_at, PlatformStorageFile.id).all()
    groups: dict[tuple, list[PlatformStorageFile]] = {}
    for row in rows:
        groups.setdefault((row.tenant_slug, row.sha256), []).append(row)
    for group in (g for g in groups.values() if len(g) > 1):
        keeper = None
        for row in group:
            try:
                physical, meta = file_storage.resolve_stored_file(logical_path(row))
                if not physical.exists():
                    continue
                if keeper is None:
                    keeper = (physical, _is_gzip(physical, meta))
                    continue
                if _is_gzip(physical, meta) != keeper[1] or os.path.samefile(physical, keeper[0]):
                    continue  # stored differently, or already shared
                tmp = physical.with_name(physical.name + ".linktmp")
                os.link(keeper[0], tmp)
                os.replace(tmp, physical)
                linked += 1
                saved += row.size_bytes
            except Exception:
                errors += 1
                logger.warning("De-duplication failed for storage file %s", row.id, exc_info=True)
    return f"{linked} duplicate(s) now share storage, {saved / 1048576:.1f} MB reclaimed" + (f", {errors} failed" if errors else "")


def _run_block_exec(db, slugs: Optional[list[str]] = None) -> str:
    blocked = 0
    rows = db.query(PlatformStorageFile).filter(PlatformStorageFile.quarantined == False,  # noqa: E712
                                                PlatformStorageFile.scan_status != "released")
    for row in (rows.filter(PlatformStorageFile.tenant_slug.in_(slugs)) if slugs is not None else rows).all():
        try:
            physical, meta = file_storage.resolve_stored_file(logical_path(row))
            if not physical.exists():
                continue
            with _open_content(physical, meta) as handle:
                head = handle.read(8)
            if not is_executable(row.ext, head):
                continue
            quarantine(db, row, "Executable file type blocked by policy")
            _audit(db, None, "storage_quarantine", row, f"Quarantined {row.name} ({row.tenant_slug}): executable file type blocked by policy")
            db.commit()
            blocked += 1
        except Exception:
            db.rollback()
            logger.warning("Executable check failed for storage file %s", row.id, exc_info=True)
    return f"{blocked} executable file(s) quarantined"


def _run_compress(db) -> str:
    from PIL import Image, ImageOps

    done, saved = 0, 0
    for row in db.query(PlatformStorageFile).filter(PlatformStorageFile.ext.in_(IMAGE_EXTS), PlatformStorageFile.size_bytes > COMPRESS_OVER_BYTES,
                                                    PlatformStorageFile.quarantined == False).all():  # noqa: E712
        try:
            logical = logical_path(row)
            physical, meta = file_storage.resolve_stored_file(logical)
            if meta.get("policy_compressed") or not physical.exists():
                continue
            with _open_content(physical, meta) as handle:
                image = ImageOps.exif_transpose(Image.open(handle))
                image.load()
            image.thumbnail((4096, 4096))
            import io

            out = io.BytesIO()
            if row.ext in ("jpg", "jpeg"):
                image.convert("RGB").save(out, format="JPEG", quality=75, optimize=True, progressive=True)
            elif row.ext == "webp":
                image.save(out, format="WEBP", quality=75, method=6)
            else:
                image.save(out, format="PNG", optimize=True)
            data = out.getvalue()
            data = gzip.compress(data, compresslevel=6) if _is_gzip(physical, meta) else data
            if len(data) >= row.size_bytes * 0.9:
                continue
            tmp = physical.with_name(physical.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, physical)  # a new file: a hard-linked duplicate keeps the original bytes
            if meta or row.root == "media":
                meta = meta or {"original_name": row.name, "content_type": file_storage._content_type(row.name), "original_size": row.original_bytes,
                                "compression_type": "none", "physical_name": physical.name, "media_slug": row.tenant_slug}
                meta.update(stored_size=len(data), policy_compressed=True)
                _write_meta(logical, meta)
            saved += row.size_bytes - len(data)
            done += 1
            _refresh_usage(row.tenant_slug)
        except Exception:
            logger.warning("Image compression failed for storage file %s", row.id, exc_info=True)
    return f"{done} image(s) compressed, {saved / 1048576:.1f} MB saved"


_RUNNERS = {"cold_180": _run_cold, "purge_30": _run_purge, "dedup": _run_dedup, "block_exec": _run_block_exec, "compress_images": _run_compress}


def run_policies(db, keys: Optional[list[str]] = None) -> None:
    for key in keys or list(_RUNNERS):
        policy = db.get(PlatformStoragePolicy, key)
        if policy is None or not policy.enabled or key not in _RUNNERS:
            continue
        reason = policy_availability(key)
        try:
            result, error = (None, reason) if reason else (_RUNNERS[key](db), None)
        except Exception as exc:
            db.rollback()
            logger.exception("Storage policy %s failed", key)
            result, error = None, f"{type(exc).__name__}: {exc}"[:500]
        policy = db.get(PlatformStoragePolicy, key)
        policy.last_run_at, policy.last_result, policy.last_error = datetime.utcnow(), result, error
        if result and not result.startswith("0 "):
            _audit(db, None, "storage_policy_run", None, f"{POLICY_LABELS[key]}: {result}")
        db.commit()


# ─── Scheduler ───────────────────────────────────────────────────────────────
_run_lock = threading.Lock()
_force_refs = threading.Event()


def _due(db, key: str, every: float) -> bool:
    row = db.get(PlatformStoragePolicy, key)
    return row is None or row.last_run_at is None or (datetime.utcnow() - row.last_run_at).total_seconds() >= every


def _run_jobs() -> None:
    with master_engine.connect() as lock_connection:
        if lock_connection.execute(text("SELECT GET_LOCK('platform_storage_jobs', 0)")).scalar() != 1:
            return
        try:
            with MasterSessionLocal() as db:
                refs = _force_refs.is_set() or _due(db, "_refs", REFS_EVERY_SECONDS)
                policies = _due(db, "_policies", POLICIES_EVERY_SECONDS)
            if refs:
                _force_refs.clear()
            index_all(refs=refs)
            with MasterSessionLocal() as db:
                if policy_enabled(db, "scan_uploads"):
                    scan_pending(db)
                if policies:
                    _state(db, "_policies").last_run_at = datetime.utcnow()
                    db.commit()
                    run_policies(db)
            if policies:
                index_all(refs=False)  # pick up what the policies moved, merged or removed
        finally:
            lock_connection.execute(text("SELECT RELEASE_LOCK('platform_storage_jobs')"))


def _background() -> None:
    try:
        _run_jobs()
    except Exception:
        logger.exception("Storage jobs failed")
    finally:
        _run_lock.release()


def tick() -> None:
    """Called every minute by each API worker: record file opens, then start the storage jobs unless already running."""
    try:
        flush_accesses()
    except Exception:
        logger.warning("Storage access flush failed", exc_info=True)
    if _run_lock.acquire(blocking=False):
        threading.Thread(target=_background, name="platform-storage-jobs", daemon=True).start()


def request_orphan_scan() -> bool:
    """Re-read every tenant's database references now. False when a run is already in progress (it is queued for the next one)."""
    ensure_schema()
    _force_refs.set()
    if _run_lock.acquire(blocking=False):
        threading.Thread(target=_background, name="platform-storage-orphans", daemon=True).start()
        return True
    return False


def is_running() -> bool:
    return _run_lock.locked()
