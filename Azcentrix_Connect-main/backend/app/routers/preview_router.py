"""
preview_router.py
=================
Serves file previews inline — converts Excel/Word to HTML server-side.
Avoids Google Docs Viewer (requires public internet) and React Router interception.

FIX: openpyxl does not support old .xls format.
     .xls  → xlrd  (pip install xlrd)
     .xlsx / .xlsm / .ods → openpyxl
     Falls back to html-table via xlrd for any xls that openpyxl rejects.

Add to main.py:
    from app.routers.preview_router import router as preview_router
    app.include_router(preview_router, prefix="/api/v1/preview", tags=["preview"])
"""

import os
import io
import mimetypes
import logging
import tempfile
import zipfile
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urlparse
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse, Response
from sqlalchemy.orm import Session
from typing import Optional

from fastapi import Request
from app.dependencies import get_current_user, get_request_ip
from app.core.logging import log_module_action
from app.models.all_models import User
from app.utils.file_storage import (
    find_tenant_media_file_by_basename,
    iter_file_chunks,
    open_stored_file,
    resolve_stored_file,
    stored_file_headers,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_preview_db(
    request: Request,
    tenant: Optional[str] = Query(None, description="Tenant slug (passed by frontend for iframe/download requests)"),
):
    """
    Tenant DB session for preview endpoints.
    Resolution order:
      1. ?tenant= query param  (iframes & direct links can't send headers)
      2. X-Tenant-Slug request header  (normal axios API calls)
      3. Request state attrs set by tenant middleware
      4. Subdomain parsing from Host header  (e.g. acme.crm.example.com)
    """
    from app.database import MasterSessionLocal, get_tenant_session_by_db_name, normalize_tenant_slug
    from app.models.tenant import Tenant

    # 1. Query param — sent by frontend for iframe src and download href
    slug = tenant

    # 2. Header — sent by axios interceptor for normal API calls
    if not slug:
        slug = (
            request.headers.get("x-tenant-slug") or
            request.headers.get("X-Tenant-Slug")
        )

    # 3. Middleware state attrs
    if not slug:
        slug = (
            getattr(request.state, "tenant_slug", None) or
            getattr(request.state, "tenant", None) or
            getattr(request.state, "slug", None) or
            getattr(request.state, "tenant_name", None) or
            getattr(request.state, "db_name", None)
        )

    # 4. Subdomain from Host header (e.g. ascent.crm.com → "ascent")
    if not slug:
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
        slug = host.split(".")[0] if host and "." in host else None
        if slug:
            logger.info(f"_get_preview_db: resolved slug from Host header: {slug!r}")

    if not slug:
        logger.error(
            f"_get_preview_db: could not resolve tenant. "
            f"state={vars(request.state)!r} host={request.headers.get('host')!r}"
        )
        raise HTTPException(400, "Could not resolve tenant for preview")

    try:
        safe_slug = normalize_tenant_slug(str(slug))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    master_db = MasterSessionLocal()
    try:
        tenant_row = master_db.query(Tenant).filter(Tenant.slug == safe_slug).first()
    finally:
        master_db.close()

    if not tenant_row:
        raise HTTPException(404, f"Tenant '{safe_slug}' not found.")

    db = get_tenant_session_by_db_name(tenant_row.db_name, cache_key=tenant_row.slug)
    request.state.tenant_slug = tenant_row.slug
    request.state.tenant = tenant_row
    try:
        yield db
    finally:
        db.close()


# ── Where your media files live ───────────────────────────────────────────────
try:
    from app.core.config import settings as _settings
    MEDIA_ROOT = os.environ.get("MEDIA_ROOT") or getattr(_settings, "MEDIA_ROOT", "media")
except Exception:
    MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")

MEDIA_ROOT = os.path.abspath(MEDIA_ROOT)
logger.info(f"preview_router: MEDIA_ROOT resolved to {MEDIA_ROOT!r}")
LEGACY_MEDIA_MODULES = {"tenders", "emdbg", "tada_attachments", "po"}


def _get_current_user_flexible(
    request: Request,
    token: str | None = None,
    db: Session = None,
):
    """
    Authenticate from either:
      1. Authorization: Bearer <token>  header  (normal API calls via axios)
      2. ?token=<token>                 query   (iframe src — browser never sends auth headers)
    """
    from jose import jwt as pyjwt, JWTError
    from app.core.config import settings
    from app.models.all_models import User as UserModel

    auth_header = request.headers.get("Authorization", "")
    raw_token = None
    if auth_header.startswith("Bearer "):
        raw_token = auth_header[7:]

    if not raw_token and token:
        raw_token = token

    if not raw_token:
        raise HTTPException(401, "Not authenticated — no token in header or query param")

    try:
        secret = (
            getattr(settings, "SECRET_KEY", None) or
            getattr(settings, "JWT_SECRET_KEY", None) or
            getattr(settings, "JWT_SECRET", None) or
            getattr(settings, "ACCESS_TOKEN_SECRET", None)
        )
        if not secret:
            raise ValueError("No JWT secret found in settings")
        algorithm = getattr(settings, "ALGORITHM", None) or getattr(settings, "JWT_ALGORITHM", "HS256")
        payload = pyjwt.decode(raw_token, secret, algorithms=[algorithm])
        user_id = int(payload.get("sub") or payload.get("user_id") or 0)
    except JWTError as e:
        logger.warning(f"Token decode failed: {e}")
        raise HTTPException(401, "Invalid or expired token")
    except Exception as e:
        logger.warning(f"Token decode unexpected error: {e}")
        raise HTTPException(401, "Invalid token")

    if not user_id:
        raise HTTPException(401, "Token has no user id")

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user or not getattr(user, "is_active", True):
        raise HTTPException(401, "User not found or inactive")
    return user


def _resolve_path(file_path: str, request: Request | None = None) -> Path:
    """
    Resolve a relative media path to an absolute filesystem path.
    Strips leading /media/ prefix if present.
    Blocks path traversal via "..".
    """
    if ".." in file_path:
        logger.warning(f"Path traversal attempt blocked: {file_path}")
        raise HTTPException(400, "Invalid file path")

    clean = file_path.lstrip("/")
    if clean.startswith("media/"):
        clean = clean[len("media/"):]

    final = Path(MEDIA_ROOT) / clean
    if request is not None:
        physical, _ = resolve_stored_file(final)
        if not physical.exists():
            parts = [part for part in Path(clean).parts if part not in ("", ".")]
            tenant_slug = getattr(request.state, "tenant_slug", None)
            if tenant_slug and len(parts) >= 2 and parts[0] in LEGACY_MEDIA_MODULES:
                final = Path(MEDIA_ROOT) / tenant_slug / Path(*parts)
                physical, _ = resolve_stored_file(final)
            if not physical.exists():
                basename_match = find_tenant_media_file_by_basename(
                    root_dir=MEDIA_ROOT,
                    tenant_slug=getattr(request.state, "tenant_slug", None),
                    filename=clean,
                )
                if basename_match:
                    final = basename_match

    logger.debug(f"Preview path resolve: input={file_path!r} clean={clean!r} final={final}")

    try:
        final.relative_to(Path(MEDIA_ROOT))
    except ValueError:
        logger.warning(f"Path escapes MEDIA_ROOT: {final}")
        raise HTTPException(400, "Invalid file path")

    return final


def _media_slug_from_path(file_path: str) -> str | None:
    clean = urlparse(file_path or "").path.lstrip("/")
    if clean.startswith("media/"):
        clean = clean[len("media/"):]
    first_part = clean.split("/", 1)[0] if clean else ""
    if first_part and first_part not in LEGACY_MEDIA_MODULES:
        return first_part
    return None


def _ensure_media_path_for_tenant(request: Request, file_path: str) -> None:
    path_slug = _media_slug_from_path(file_path)
    if not path_slug:
        return
    tenant_slug = getattr(request.state, "tenant_slug", None)
    if tenant_slug and path_slug != tenant_slug:
        raise HTTPException(403, "File does not belong to this tenant")


def _ext(path: str) -> str:
    clean = urlparse(path or "").path or str(path or "").split("?", 1)[0]
    return (clean.rsplit(".", 1)[-1] if "." in clean else "").lower()


STREAM_PREVIEW_EXTS = {"pdf", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"}
EXCEL_PREVIEW_EXTS = {"xlsx", "xls", "xlsm", "ods", "csv"}
WORD_PREVIEW_EXTS = {"docx", "doc", "odt"}
KNOWN_PREVIEW_EXTS = STREAM_PREVIEW_EXTS | EXCEL_PREVIEW_EXTS | WORD_PREVIEW_EXTS


def _stored_exists(logical_path: Path) -> bool:
    physical, _ = resolve_stored_file(logical_path)
    return physical.exists()


@contextmanager
def _materialized_preview_path(logical_path: Path):
    file_obj, meta, physical = open_stored_file(logical_path)
    if meta.get("compression_type") != "gzip" and physical.suffix != ".gz":
        file_obj.close()
        yield physical
        return

    suffix = logical_path.suffix or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = Path(tmp.name)
    try:
        with file_obj, tmp:
            tmp.write(file_obj.read())
        yield tmp_path
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _read_stored_head(logical_path: Path, limit: int = 4096) -> bytes:
    file_obj, _, _ = open_stored_file(logical_path)
    try:
        return file_obj.read(limit)
    finally:
        file_obj.close()


def _preview_ext_from_mime(mime: str | None) -> str:
    value = str(mime or "").split(";", 1)[0].strip().lower()
    if value == "application/pdf":
        return "pdf"
    if value.startswith("image/"):
        subtype = value.split("/", 1)[1]
        return "jpg" if subtype == "jpeg" else subtype.replace("+xml", "")
    if value == "text/csv":
        return "csv"
    if "spreadsheet" in value or "excel" in value:
        return "xlsx"
    if value == "application/msword":
        return "doc"
    if "wordprocessingml" in value:
        return "docx"
    return ""


def _preview_mime_for_ext(ext: str, mime: str | None) -> str:
    clean_mime = str(mime or "").split(";", 1)[0].strip().lower()
    if clean_mime and clean_mime != "application/octet-stream":
        return clean_mime
    if ext == "pdf":
        return "application/pdf"
    guessed = mimetypes.guess_type(f"file.{ext}")[0]
    return guessed or clean_mime or "application/octet-stream"


def _zip_office_ext(logical_path: Path) -> str:
    try:
        with _materialized_preview_path(logical_path) as preview_path:
            with zipfile.ZipFile(preview_path) as zf:
                names = set(zf.namelist())
    except Exception:
        return ""
    if any(name == "xl/workbook.xml" or name.startswith("xl/") for name in names):
        return "xlsx"
    if any(name == "word/document.xml" or name.startswith("word/") for name in names):
        return "docx"
    if any(name == "ppt/presentation.xml" or name.startswith("ppt/") for name in names):
        return "pptx"
    return ""


def _detect_preview_ext(logical_path: Path, ext: str) -> str:
    ext = str(ext or "").lower().lstrip(".")
    if ext in KNOWN_PREVIEW_EXTS:
        return ext

    try:
        mime, _ = stored_file_headers(logical_path=logical_path, disposition="inline")
    except Exception:
        mime = ""
    mime_ext = _preview_ext_from_mime(mime)
    if mime_ext:
        return mime_ext

    head = _read_stored_head(logical_path)
    stripped = head.lstrip().lower()
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM"):
        return "bmp"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if stripped.startswith((b"<svg", b"<?xml")) and b"<svg" in stripped[:512]:
        return "svg"
    if head[:4] == b"\x50\x4B\x03\x04":
        return _zip_office_ext(logical_path) or "xlsx"

    excel_format = _sniff_excel_format(head)
    if excel_format in {"xls", "xlsx"}:
        return excel_format
    if excel_format == "html":
        return "xls"
    return ext


# ── GET /api/v1/preview/file?path=... ────────────────────────────────────────

@router.get("/file")
def preview_file(
    request: Request,
    path: str = Query(..., description="Relative media path, e.g. /media/ascent/tenders/doc.xlsx"),
    token: str | None = Query(None, description="JWT token for iframe auth"),
    db: Session = Depends(_get_preview_db),
):
    current_user = _get_current_user_flexible(request, token, db)
    _ensure_media_path_for_tenant(request, path)
    logger.info(f"Preview requested: path={path!r}  MEDIA_ROOT={MEDIA_ROOT!r}  user={current_user.id}")

    """
    Returns an inline preview for any file type:
    - PDF    → streams raw bytes with content-type application/pdf
    - Image  → streams raw bytes with correct image content-type
    - Excel  → converts to HTML table (.xlsx via openpyxl, .xls via xlrd)
    - Word   → converts to HTML via mammoth
    - Other  → returns a download link page
    """
    ext = _ext(path)
    fpath = _resolve_path(path, request)
    if not _stored_exists(fpath):
        raise HTTPException(404, f"File not found: {fpath.name}")
    effective_ext = _detect_preview_ext(fpath, ext)

    # ── PDF & Images — stream raw bytes ──────────────────────────────────────
    if effective_ext in STREAM_PREVIEW_EXTS:
        file_obj, _, _ = open_stored_file(fpath)
        mime, headers = stored_file_headers(
            logical_path=fpath,
            disposition="inline",
        )
        return StreamingResponse(
            iter_file_chunks(file_obj),
            media_type=_preview_mime_for_ext(effective_ext, mime),
            headers={
                **headers,
                "Cache-Control": "private, max-age=3600",
            },
        )

    # ── Excel → HTML ──────────────────────────────────────────────────────────
    if effective_ext in EXCEL_PREVIEW_EXTS:
        try:
            with _materialized_preview_path(fpath) as preview_path:
                html = _excel_to_html(preview_path, effective_ext)
            return HTMLResponse(content=html)
        except Exception as e:
            logger.error(f"Excel preview failed: {e}")
            return HTMLResponse(content=_error_page(fpath.name, str(e)))

    # ── Word → HTML ───────────────────────────────────────────────────────────
    if effective_ext in WORD_PREVIEW_EXTS:
        try:
            import mammoth  # noqa: F401 — check availability before materialising
        except ModuleNotFoundError:
            return HTMLResponse(content=_no_preview_page(fpath.name, path, token=token, tenant=request.query_params.get("tenant")))
        try:
            with _materialized_preview_path(fpath) as preview_path:
                html = _word_to_html(preview_path)
            return HTMLResponse(content=html)
        except Exception as e:
            logger.error(f"Word preview failed: {e}")
            return HTMLResponse(content=_error_page(fpath.name, str(e)))

    # ── Unknown — download link ───────────────────────────────────────────────
    fname = fpath.name
    return HTMLResponse(content=_no_preview_page(fname, path, token=token, tenant=request.query_params.get("tenant")))


# ── Excel converter ───────────────────────────────────────────────────────────

def _sniff_excel_format(raw: bytes) -> str:
    """
    Detect the REAL spreadsheet format from the first 8 bytes.

    openpyxl rejects files with .xls extension even when the content is
    actually xlsx (ZIP-based). This function reads magic bytes so we route
    to the right library regardless of what the filename says.

    Magic signatures:
      50 4B 03 04  (PK...) → ZIP / Office Open XML → use openpyxl via BytesIO
      D0 CF 11 E0          → CFB / BIFF             → genuine old .xls, use xlrd
      anything else        → unknown, try openpyxl then xlrd
    """
    head = raw[:2048]
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    normalized_head = head.lstrip().lower()

    if (
        normalized_head.startswith((b"<!doctype html", b"<html", b"<table"))
        or b"<table" in normalized_head[:1024]
    ):
        return "html"

    if raw[:4] == b"\x50\x4B\x03\x04":
        return "xlsx"   # ZIP-based: xlsx, xlsm, ods
    if raw[:4] == b"\xD0\xCF\x11\xE0":
        return "xls"    # CFB/BIFF: genuine old .xls
    return "unknown"


def _excel_to_html(fpath: Path, ext: str) -> str:
    """
    Convert any spreadsheet to HTML.

    KEY FIX: openpyxl refuses files whose *path* ends in .xls even when the
    content is xlsx (ZIP) format. We fix this by:
      1. Reading the whole file into a BytesIO buffer.
      2. Sniffing the real format from magic bytes.
      3. Passing the BytesIO to openpyxl (it skips the extension check).
      4. Only using xlrd for files whose bytes are genuine BIFF/CFB format.
    """
    import io

    # ── CSV ───────────────────────────────────────────────────────────────────
    if ext == "csv":
        import csv
        rows = []
        with open(fpath, newline="", encoding="utf-8-sig", errors="replace") as f:
            for row in csv.reader(f):
                rows.append(row)
        return _rows_to_html_page(fpath.name, rows)

    # ── Read file once into memory ─────────────────────────────────────────────
    with open(fpath, "rb") as f:
        raw = f.read()

    real_fmt = _sniff_excel_format(raw)
    logger.info(f"Excel: ext={ext!r}  magic={raw[:4].hex()!r}  detected={real_fmt!r}  file={fpath.name!r}")

    if real_fmt == "html":
        return _html_spreadsheet_to_html(raw, fpath.name)

    # ── ZIP-based (xlsx content, any extension) → openpyxl via BytesIO ────────
    if real_fmt == "xlsx":
        return _xlsx_to_html(io.BytesIO(raw))

    # ── Genuine BIFF .xls → xlrd ───────────────────────────────────────────────
    if real_fmt == "xls":
        return _xls_to_html(raw, fpath.name)

    # ── Unknown — try openpyxl first, then xlrd ────────────────────────────────
    try:
        return _xlsx_to_html(io.BytesIO(raw))
    except Exception:
        try:
            return _xls_to_html(raw, fpath.name)
        except Exception as e:
            raise ValueError(f"Cannot parse spreadsheet: {e}")


class _HtmlSpreadsheetParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table_depth = 0
        self._rows: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs):
        tag = tag.lower()
        if tag == "table":
            if self._table_depth == 0:
                self._rows = []
            self._table_depth += 1
            return
        if self._table_depth != 1:
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell_parts = []
        elif tag in ("br", "p", "div") and self._cell_parts is not None:
            self._cell_parts.append(" ")

    def handle_data(self, data: str):
        if self._cell_parts is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag == "table" and self._table_depth > 0:
            self._table_depth -= 1
            if self._table_depth == 0 and self._rows is not None:
                if self._rows:
                    self.tables.append(self._rows)
                self._rows = None
            return
        if self._table_depth != 1:
            return
        if tag in ("td", "th") and self._row is not None and self._cell_parts is not None:
            cell = " ".join("".join(self._cell_parts).split())
            self._row.append(cell)
            self._cell_parts = None
            return
        if tag == "tr" and self._rows is not None and self._row is not None:
            if any(cell.strip() for cell in self._row):
                self._rows.append(self._row)
            self._row = None


def _decode_html_spreadsheet(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _table_rows_to_html(rows: list[list[str]]) -> str:
    header_cells = "".join(f"<th>{_cell(c)}</th>" for c in rows[0])
    body_rows = "".join(
        "<tr>" + "".join(f"<td>{_cell(c)}</td>" for c in row) + "</tr>"
        for row in rows[1:]
    )
    return f"<table><thead><tr>{header_cells}</tr></thead><tbody>{body_rows}</tbody></table>"


def _html_spreadsheet_to_html(raw: bytes, fname: str = "file.xls") -> str:
    parser = _HtmlSpreadsheetParser()
    parser.feed(_decode_html_spreadsheet(raw))
    parser.close()

    tables = [rows for rows in parser.tables if rows]
    if not tables:
        raise ValueError("No table found in HTML spreadsheet")

    if len(tables) == 1:
        return _rows_to_html_page(fname, tables[0])

    sheets_html = [
        (f"Table {index}", _table_rows_to_html(rows))
        for index, rows in enumerate(tables, start=1)
    ]
    return _multi_sheet_page(sheets_html)


def _xls_to_html(raw: bytes, fname: str = "file.xls") -> str:
    """Read genuine BIFF .xls using xlrd (pass raw bytes via xlrd.open_workbook)."""
    try:
        import xlrd
    except ImportError:
        raise ImportError("xlrd is required for .xls files. Install: pip install xlrd")

    wb = xlrd.open_workbook(file_contents=raw)
    sheets_html = []
    for sheet_name in wb.sheet_names():
        ws   = wb.sheet_by_name(sheet_name)
        rows = [[ws.cell_value(rx, cx) for cx in range(ws.ncols)] for rx in range(ws.nrows)]
        if not rows:
            sheets_html.append((sheet_name, "<p style='color:#999;font-size:12px'>Empty sheet</p>"))
            continue
        header_cells = "".join(f"<th>{_cell(c)}</th>" for c in rows[0])
        body_rows    = "".join(
            "<tr>" + "".join(f"<td>{_cell(c)}</td>" for c in row) + "</tr>"
            for row in rows[1:]
        )
        table = f"<table><thead><tr>{header_cells}</tr></thead><tbody>{body_rows}</tbody></table>"
        sheets_html.append((sheet_name, table))
    return _multi_sheet_page(sheets_html)


def _xlsx_to_html(source) -> str:
    """
    Read xlsx/xlsm/ods using openpyxl.
    source: Path | BytesIO — passing BytesIO bypasses openpyxl's extension check,
    which is what lets us handle .xls files that are actually xlsx internally.
    """
    import openpyxl
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)

    sheets_html = []
    for sheet_name in wb.sheetnames:
        ws       = wb[sheet_name]
        rows_raw = list(ws.iter_rows(values_only=True))

        if not rows_raw:
            sheets_html.append((sheet_name, "<p style='color:#999;font-size:12px'>Empty sheet</p>"))
            continue

        header_cells = "".join(f"<th>{_cell(c)}</th>" for c in rows_raw[0])
        body_rows    = "".join(
            "<tr>" + "".join(f"<td>{_cell(c)}</td>" for c in row) + "</tr>"
            for row in rows_raw[1:]
        )
        table = f"<table><thead><tr>{header_cells}</tr></thead><tbody>{body_rows}</tbody></table>"
        sheets_html.append((sheet_name, table))

    wb.close()
    return _multi_sheet_page(sheets_html)


def _multi_sheet_page(sheets_html: list) -> str:
    """Render a tabbed HTML page for multi-sheet workbooks."""
    if not sheets_html:
        return _error_page("Workbook", "No sheets found")

    tabs = "".join(
        f'<button class="tab{" active" if i == 0 else ""}" onclick="showTab({i})">{name}</button>'
        for i, (name, _) in enumerate(sheets_html)
    )
    panels = "".join(
        f'<div class="panel{" active" if i == 0 else ""}" id="panel-{i}">{table}</div>'
        for i, (_, table) in enumerate(sheets_html)
    )

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 12px; background: #f9fafb; color: #111; }}
  .tabs {{ display: flex; gap: 4px; padding: 8px 12px; background: #fff;
           border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; position: sticky; top: 0; z-index: 10; }}
  .tab  {{ padding: 5px 14px; border-radius: 6px; border: 1px solid #d1d5db;
           background: #f3f4f6; cursor: pointer; font-size: 11px; font-weight: 500; }}
  .tab.active {{ background: #4f46e5; color: #fff; border-color: #4f46e5; }}
  .panel {{ display: none; overflow: auto; padding: 12px; max-height: calc(100vh - 52px); }}
  .panel.active {{ display: block; }}
  table {{ border-collapse: collapse; min-width: 100%; white-space: nowrap; }}
  thead tr th {{ background: #f3f4f6; font-weight: 600; position: sticky; top: 0; z-index: 1; }}
  th, td {{ border: 1px solid #e5e7eb; padding: 5px 10px; text-align: left; }}
  tr:nth-child(even) td {{ background: #f9fafb; }}
  tr:hover td {{ background: #eef2ff; }}
</style>
</head>
<body>
<div class="tabs">{tabs}</div>
{panels}
<script>
function showTab(i) {{
  document.querySelectorAll('.tab').forEach((t,j) => t.classList.toggle('active', i===j));
  document.querySelectorAll('.panel').forEach((p,j) => p.classList.toggle('active', i===j));
}}
</script>
</body>
</html>"""


def _cell(val) -> str:
    if val is None:
        return ""
    # xlrd returns floats for integers (e.g. 1.0) — strip trailing .0
    if isinstance(val, float) and val == int(val):
        val = int(val)
    return str(val).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _rows_to_html_page(name: str, rows: list) -> str:
    """Simple single-sheet HTML table — used for CSV."""
    if not rows:
        return _error_page(name, "Empty file")
    head = "<thead><tr>" + "".join(f"<th>{_cell(c)}</th>" for c in rows[0]) + "</tr></thead>"
    body = "<tbody>" + "".join(
        "<tr>" + "".join(f"<td>{_cell(c)}</td>" for c in row) + "</tr>"
        for row in rows[1:]
    ) + "</tbody>"
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body {{ font-family: sans-serif; font-size: 12px; padding: 12px; background: #f9fafb; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #e5e7eb; padding: 5px 10px; text-align: left; }}
  thead th {{ background: #f3f4f6; font-weight: 600; position: sticky; top: 0; }}
  tr:nth-child(even) td {{ background: #fff; }}
  tr:hover td {{ background: #eef2ff; }}
</style></head>
<body>
<p style="margin-bottom:8px;font-size:11px;color:#666">{name}</p>
<table>{head}{body}</table>
</body></html>"""


# ── Word converter ────────────────────────────────────────────────────────────

def _word_to_html(fpath: Path) -> str:
    import mammoth
    with open(fpath, "rb") as f:
        result = mammoth.convert_to_html(f)

    body_html = result.value
    warnings  = result.messages

    warn_html = ""
    if warnings:
        warn_html = (
            "<div style='background:#fef3c7;padding:8px 12px;font-size:11px;"
            "color:#92400e;margin-bottom:12px;border-radius:6px'>" +
            " · ".join(str(w) for w in warnings[:3]) +
            "</div>"
        )

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: 'Georgia', serif; font-size: 13px; line-height: 1.7;
          max-width: 820px; margin: 0 auto; padding: 28px 32px; color: #1a1a1a; background: #fff; }}
  h1,h2,h3,h4 {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                  margin: 1.2em 0 0.4em; color: #111; }}
  p   {{ margin: 0.5em 0; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 12px; }}
  th, td {{ border: 1px solid #d1d5db; padding: 6px 10px; }}
  th  {{ background: #f3f4f6; font-weight: 600; }}
  img {{ max-width: 100%; height: auto; }}
  ul, ol {{ padding-left: 1.5em; margin: 0.5em 0; }}
</style>
</head>
<body>
{warn_html}
{body_html}
</body>
</html>"""


# ── Error / fallback pages ────────────────────────────────────────────────────

def _error_page(name: str, err: str) -> str:
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;padding:24px;color:#b91c1c">
<h3 style="margin-bottom:8px">Preview failed: {name}</h3>
<p style="font-size:12px;color:#666;white-space:pre-wrap">{err}</p>
</body></html>"""


def _no_preview_page(name: str, path: str, token: str | None = None, tenant: str | None = None) -> str:
    params = {"path": path}
    if token:
        params["token"] = token
    if tenant:
        params["tenant"] = tenant
    download_url = f"/api/v1/preview/download?{urlencode(params)}"
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;padding:24px;text-align:center">
<div style="margin-top:60px">
  <div style="font-size:48px">📎</div>
  <p style="font-size:14px;font-weight:600;color:#374151;margin:12px 0 4px">{name}</p>
  <p style="font-size:12px;color:#9ca3af">Preview not available for this file type.</p>
  <a href="{download_url}"
     style="display:inline-block;margin-top:16px;padding:8px 20px;background:#4f46e5;
            color:#fff;border-radius:8px;text-decoration:none;font-size:13px">
    Download File
  </a>
</div>
</body></html>"""


# ── GET /api/v1/preview/download?path=... ────────────────────────────────────

@router.get("/download")
def download_file(
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    db: Session = Depends(_get_preview_db),
):
    current_user = _get_current_user_flexible(request, token, db)
    _ensure_media_path_for_tenant(request, path)
    fpath = _resolve_path(path, request)
    if not _stored_exists(fpath):
        raise HTTPException(404, "File not found")
    file_obj, _, _ = open_stored_file(fpath)
    mime, headers = stored_file_headers(
        logical_path=fpath,
        disposition="attachment",
    )
    log_module_action(
        db=db, user_id=current_user.id, module="document_management", action="download",
        record_id=None, record_name=Path(path).name, ip=get_request_ip(request),
    )
    db.commit()
    return StreamingResponse(
        iter_file_chunks(file_obj),
        media_type=mime,
        headers=headers,
    )
