"""
workorder_router.py — Work Order CRUD + PO document upload
===========================================================
POST  /workorders                → create or update work order
                                   accepts multipart/form-data so the PO doc
                                   can be uploaded in the same request as form fields
GET   /workorders                → list won tenders + their WO data
GET   /workorders/users          → users dropdown + current user id
PATCH /workorders/{id}/progress  → update progress % and status
GET   /workorders/{id}/po-doc    → stream / preview the PO document (inline)
GET   /workorders/{id}/po-doc/download → force-download the PO document

PO document is saved to  <MEDIA_ROOT>/<tenant_slug>/po/<uuid>.<ext>
DB column  workorders.po_doc  stores the relative path  /media/<tenant_slug>/po/<uuid>.<ext>
Same path is mirrored to  tenders.po_doc  when a tender_id is provided.
"""

import os
import json
import logging
from datetime import date, datetime
from app.core.timezone import now_ist, today_ist
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import (
    APIRouter, Depends, HTTPException,
    UploadFile, File, Form, Request
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import bindparam, func, inspect, or_, text, false
from app.dependencies import get_tenant_db, get_current_user, require_permission, ensure_permission
from app.models.all_models import (
    WorkOrder, Tender, TenderProduct, TenderDocument, User,
    ActivityLog, UserReportingHierarchy, OrgTreeNode, Lead,
    Role, Permission, RolePermission, TenderConsignee,
)
from app.core.config import settings
from app.services.dynamic_notification_service import (
    build_notification_change_context,
    emit_notification_event,
    notification_values_equal,
)
from app.services.cache_service import invalidate_badges_cache
from app.services.storage_usage_service import refresh_tenant_storage_usage_for_slug
from app.utils.file_storage import (
    delete_stored_file,
    find_tenant_media_file_by_basename,
    iter_file_chunks,
    media_slug_from_request,
    media_url_to_logical_path,
    open_stored_file,
    resolve_stored_file,
    save_upload_optimized,
    stored_file_accounted_size,
    stored_file_headers,
)

from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)
router = APIRouter()
LEGACY_MEDIA_MODULES = {"tenders", "emdbg", "tada_attachments", "po"}

ADMIN_SCOPE_ROLES = {"admin", "ceo", "super_admin"}


def _ensure_work_order_runtime_schema(db: Session) -> None:
    """Keep older tenant databases compatible with the current WorkOrder model."""
    try:
        inspector = inspect(db.get_bind())
        if "work_orders" not in inspector.get_table_names():
            return

        columns_by_name = {col["name"]: col for col in inspector.get_columns("work_orders")}
        columns = set(columns_by_name)
        statements: list[str] = []
        if "lead_id" not in columns:
            statements.append("ALTER TABLE work_orders ADD COLUMN `lead_id` INT NULL")
        if "quotation_id" not in columns:
            statements.append("ALTER TABLE work_orders ADD COLUMN `quotation_id` INT NULL")
        if "no_of_consignee" not in columns:
            statements.append("ALTER TABLE work_orders ADD COLUMN `no_of_consignee` INT NULL DEFAULT NULL")
        po_doc_length = getattr(columns_by_name.get("po_doc", {}).get("type"), "length", None)
        if "po_doc" in columns and (po_doc_length is None or po_doc_length < 500):
            statements.append("ALTER TABLE work_orders MODIFY COLUMN `po_doc` VARCHAR(500) NULL")

        for statement in statements:
            db.execute(text(statement))

        if statements:
            db.commit()
            logger.info("Work order runtime schema updated: %s", ", ".join(statements))

        # Extend status enum to include Won and Lost
        try:
            db.execute(text(
                "ALTER TABLE work_orders MODIFY COLUMN `status` "
                "ENUM('Draft','Confirmed','In Progress','On Hold','Delayed','Completed','Cancelled','Closed','Won','Lost') "
                "DEFAULT 'Draft'"
            ))
            db.commit()
        except Exception:
            db.rollback()
    except Exception as exc:
        db.rollback()
        logger.warning("Work order runtime schema sync skipped: %s", exc)

def _normalized_role(role: Optional[str]) -> str:
    normalized = (role or "").strip().lower().replace("-", "_").replace(" ", "_")
    return {
        "sales_executive": "sales",
        "salesexecutive": "sales",
        "sales_head": "manager",
        "saleshead": "manager",
    }.get(normalized, normalized)


def _parse_group_ids(value: Optional[str]) -> set[int]:
    if not value:
        return set()

    ids = set()
    for part in str(value).split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids


def _get_org_tree_user_ids(db: Session, user_id: int) -> list[int]:
    """Return all user IDs visible to user_id based on the Group Fixing tree (OrgTreeNode)."""
    user_ids: set[int] = {int(user_id)}
    pending = [int(user_id)]
    while pending:
        current_id = pending.pop(0)
        rows = db.query(OrgTreeNode).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
            or_(
                OrgTreeNode.parent_user_id == current_id,
                OrgTreeNode.group_lead_id == current_id,
            ),
        ).all()
        for row in rows:
            uid = int(row.user_id)
            if uid not in user_ids:
                user_ids.add(uid)
                pending.append(uid)
    return sorted(user_ids)

def _workorder_scope_user_ids(db: Session, current_user: User):
    """Return scoped user ID list for work orders.

    Returns None for "all" scope (no filter), [] for "none",
    or a list of user IDs for "own"/"team".
    """
    scope = get_module_data_scope(db, current_user, "workorders")

    if scope == "all":
        return None

    if scope == "none":
        return []

    if scope == "own":
        return [int(current_user.id)]

    return get_team_user_ids(db, int(current_user.id))

def _scope_user_ids(db: Session, current_user: User) -> Optional[list[int]]:
    return _workorder_scope_user_ids(db, current_user)


def _wo_in_scope(
    db: Session,
    current_user: User,
    wo: Optional["WorkOrder"] = None,
    tender: Optional["Tender"] = None,
) -> bool:
    """True when the work order / tender falls inside the user's configured
    Data Visibility for work orders (owner, project manager, or the linked
    tender's creator / assignee)."""
    scope_ids = _scope_user_ids(db, current_user)
    if scope_ids is None:
        return True
    if not scope_ids:
        return False
    if tender is None and wo is not None and getattr(wo, "tender_id", None):
        tender = db.query(Tender).filter(Tender.id == wo.tender_id).first()
    related: set[int] = set()
    if wo is not None:
        related.update(v for v in (wo.created_by, getattr(wo, "project_manager_id", None)) if v)
    if tender is not None:
        related.update(v for v in (tender.created_by, tender.assigned_to) if v)
    return bool(related & set(int(i) for i in scope_ids))

def _is_workorder_overdue(wo: WorkOrder) -> bool:
    due_date = getattr(wo, "completion_date", None) or getattr(wo, "delivery_date", None) or getattr(wo, "installation_date", None)
    if not due_date:
        return False
    if getattr(wo, "status", None) in {"Completed", "Closed", "Cancelled"}:
        return False
    # Handle both string and date objects
    if isinstance(due_date, str):
        try:
            from datetime import datetime
            due_date = datetime.strptime(due_date, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return False
    return due_date < today_ist()


def _emit_workorder_event(
    db: Session,
    *,
    work_order: WorkOrder,
    event_key: str,
    actor: Optional[User],
    extra_context: Optional[dict[str, Any]] = None,
) -> None:
    try:
        context = {
            "wo_number": getattr(work_order, "wo_number", "") or "",
            "customer_name": getattr(work_order, "customer_name", "") or "",
            "status": getattr(work_order, "status", "") or "",
            "progress_percent": getattr(work_order, "progress_percent", 0) or 0,
            "assignee_user_id": getattr(work_order, "project_manager_id", None),
            "creator_user_id": getattr(work_order, "created_by", None),
            "record_ref": getattr(work_order, "wo_number", "") or "",
        }
        if extra_context:
            context.update(extra_context)
        emit_notification_event(
            db,
            module_key="workorders",
            event_key=event_key,
            record_id=work_order.id,
            actor_user_id=getattr(actor, "id", None),
            context=context,
        )
    except Exception as exc:
        logger.warning("workorder notification failed for work_order=%s event=%s: %s", work_order.id, event_key, exc)

# ─── Media root (same source-of-truth as tender_router) ──────────────────────

def _media_root() -> str:
    """Return absolute path to the media root directory."""
    root = getattr(settings, "MEDIA_ROOT", None) or os.environ.get("MEDIA_ROOT", "media")
    return os.path.abspath(root)


def _save_po_doc(
    request: Request,
    contents: bytes,
    original_filename: str,
    quota_extra_bytes: int | None = None,
    quota_existing_bytes: int | None = None,
) -> str:
    """
    Save PO document bytes to  <MEDIA_ROOT>/<tenant_slug>/po/<uuid>.<ext>.
    Returns the relative web path  /media/<tenant_slug>/po/<uuid>.<ext>
    which is stored in the DB.
    """
    saved = save_upload_optimized(
        root_dir=_media_root(),
        subfolder="po",
        original_filename=original_filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        quota_extra_bytes=quota_extra_bytes,
        quota_existing_bytes=quota_existing_bytes,
    )
    logger.info(
        "_save_po_doc: saved %s bytes -> %s compression=%s stored=%s",
        len(contents), saved.physical_path, saved.compression_type, saved.stored_size,
    )
    return saved.url


def _resolve_media_path(relative_path: str) -> str:
    """
    Convert a stored relative path like /media/<tenant_slug>/po/abc.pdf
    to an absolute filesystem path.
    """
    return str(media_url_to_logical_path(root_dir=_media_root(), file_url=relative_path))


def _tenant_scoped_legacy_media_path(request: Request, file_url: str) -> str | None:
    """
    Older rows stored files as /media/tenders/<file> while newer uploads store
    them as /media/<tenant>/tenders/<file>. Return the tenant-scoped logical
    path only for those legacy module paths.
    """
    clean = urlparse(file_url or "").path.lstrip("/")
    if clean.startswith("media/"):
        clean = clean[len("media/"):]
    parts = [part for part in Path(clean).parts if part not in ("", ".")]
    if len(parts) < 2 or any(part == ".." for part in parts):
        return None
    if parts[0] not in LEGACY_MEDIA_MODULES:
        return None

    tenant_slug = media_slug_from_request(request)
    if not tenant_slug:
        return None
    tenant_url = "/media/" + "/".join([tenant_slug, *parts])
    return _resolve_media_path(tenant_url)


def _resolve_po_doc_file(request: Request, po_doc: str) -> tuple[str, Path]:
    logical_path = _resolve_media_path(po_doc)
    physical_path, _ = resolve_stored_file(logical_path)
    if physical_path.exists():
        return logical_path, physical_path

    legacy_logical_path = _tenant_scoped_legacy_media_path(request, po_doc)
    if legacy_logical_path:
        legacy_physical_path, _ = resolve_stored_file(legacy_logical_path)
        if legacy_physical_path.exists():
            logger.info(
                "PO doc resolved via tenant-scoped legacy fallback: original=%r fallback=%r",
                po_doc,
                legacy_logical_path,
            )
            return legacy_logical_path, legacy_physical_path

    basename_logical_path = find_tenant_media_file_by_basename(
        root_dir=_media_root(),
        tenant_slug=media_slug_from_request(request),
        filename=po_doc,
    )
    if basename_logical_path:
        basename_physical_path, _ = resolve_stored_file(basename_logical_path)
        if basename_physical_path.exists():
            logger.info(
                "PO doc resolved via tenant basename fallback: original=%r fallback=%r",
                po_doc,
                str(basename_logical_path),
            )
            return str(basename_logical_path), basename_physical_path

    return logical_path, physical_path


def _po_doc_path_candidates(db: Session, tender: Tender) -> list[str]:
    _ensure_work_order_runtime_schema(db)
    candidates: list[str] = []

    def add_candidate(value: Any) -> None:
        path = str(value or "").strip()
        if path and path not in candidates:
            candidates.append(path)

    add_candidate(getattr(tender, "po_doc", None))

    wo = None
    if getattr(tender, "wrk_order_id", None):
        wo = db.query(WorkOrder).filter(WorkOrder.wo_number == tender.wrk_order_id).first()
    if not wo:
        wo = db.query(WorkOrder).filter(WorkOrder.tender_id == tender.id).first()
    if wo:
        add_candidate(getattr(wo, "po_doc", None))
        add_candidate(getattr(wo, "po_document_url", None))

    docs = db.query(TenderDocument).filter(
        TenderDocument.tender_id == tender.id,
        TenderDocument.doc_type == "PO Document",
    ).order_by(TenderDocument.id.desc()).all()
    for doc in docs:
        add_candidate(getattr(doc, "file_url", None))

    return candidates


def _resolve_available_po_doc_file(
    request: Request,
    candidates: list[str],
) -> tuple[str, Path, str] | None:
    first_attempt: tuple[str, Path, str] | None = None
    for po_doc in candidates:
        logical_path, physical_path = _resolve_po_doc_file(request, po_doc)
        attempt = (logical_path, physical_path, po_doc)
        if first_attempt is None:
            first_attempt = attempt
        if physical_path.exists():
            return attempt
    return first_attempt

# ─── Tenant-aware DB for file-serving routes ─────────────────────────────────

def _get_wo_db(request: Request):
    """
    Resolves tenant DB session for routes opened directly by the browser
    (e.g. preview/download links in <a href>).

    The browser never sends X-Tenant-Slug on direct navigation, so we
    fall back to extracting the slug from the subdomain in the Host header.
    """
    from app.database import MasterSessionLocal, get_tenant_session_by_db_name, normalize_tenant_slug
    from app.models.tenant import Tenant

    slug = (
        getattr(request.state, "tenant_slug", None) or
        getattr(request.state, "tenant",      None) or
        getattr(request.state, "slug",         None)
    )

    if not slug:
        host = (
            request.headers.get("x-forwarded-host") or
            request.headers.get("host", "")
        )
        if host and "." in host:
            slug = host.split(".")[0]
            logger.info(f"_get_wo_db: resolved tenant from host: {slug!r}")

    if not slug:
        raise HTTPException(400, "Tenant not identified. Could not resolve from request.")

    try:
        safe_slug = normalize_tenant_slug(str(slug))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    master_db = MasterSessionLocal()
    try:
        tenant = master_db.query(Tenant).filter(Tenant.slug == safe_slug).first()
    finally:
        master_db.close()

    if not tenant:
        raise HTTPException(404, f"Tenant '{safe_slug}' not found.")

    db = get_tenant_session_by_db_name(tenant.db_name, cache_key=tenant.slug)
    request.state.tenant_slug = tenant.slug
    request.state.tenant = tenant
    try:
        yield db
    finally:
        db.close()


# ─── WO number generator ─────────────────────────────────────────────────────

def _wo_num(db: Session, po_number: Optional[str] = None) -> str:
    """Orders & Projects → Settings → Order number format (WO-YY-#### · PO-based · Custom)."""
    _ensure_work_order_runtime_schema(db)
    from app.services.order_service import next_number
    return next_number(db, po_number)


def _serialize_final_boq_products(db: Session, tender_id: int) -> list[dict[str, Any]]:
    products = db.query(TenderProduct).filter(
        TenderProduct.tender_id == tender_id,
        TenderProduct.is_final_boq == True,
    ).order_by(TenderProduct.sort_order.asc(), TenderProduct.id.asc()).all()

    rows: list[dict[str, Any]] = []
    for p in products:
        quantity = float(p.quantity or 0)
        unit_price = float(p.unit_price or 0)
        gst_percent = float(p.gst_percent or 0)
        work_unit_rate = float(p.work_unit_rate or 0)
        rate_for_total = work_unit_rate if bool(p.is_works_item) else unit_price
        total_price = float(p.total_price or 0)
        if not total_price and quantity and rate_for_total:
            total_price = round(quantity * rate_for_total * (1 + gst_percent / 100), 2)

        rows.append({
            "id": p.id,
            "product_id": p.product_id,
            "product_name": p.product_name,
            "quantity": quantity,
            "unit_price": unit_price,
            "gst_percent": gst_percent,
            "total_price": total_price,
            "is_final_boq": bool(p.is_final_boq),
            "is_works_item": bool(p.is_works_item),
            "work_type": p.work_type,
            "work_description": p.work_description,
            "work_unit": p.work_unit,
            "work_unit_rate": work_unit_rate,
            "oem_id": p.oem_id,
            "oem_name": p.oem_name,
            "authorization_num": p.authorization_num,
            "oem_authorization": p.oem_authorization,
        })
    return rows


def _serialize_final_boq_products_for_tenders(
    db: Session,
    tender_ids: list[int],
) -> dict[int, list[dict[str, Any]]]:
    if not tender_ids:
        return {}
    rows_by_tender: dict[int, list[dict[str, Any]]] = {}
    products = (
        db.query(TenderProduct)
        .filter(
            TenderProduct.tender_id.in_(tender_ids),
            TenderProduct.is_final_boq == True,
        )
        .order_by(TenderProduct.tender_id.asc(), TenderProduct.sort_order.asc(), TenderProduct.id.asc())
        .all()
    )
    for p in products:
        quantity = float(p.quantity or 0)
        unit_price = float(p.unit_price or 0)
        gst_percent = float(p.gst_percent or 0)
        work_unit_rate = float(p.work_unit_rate or 0)
        rate_for_total = work_unit_rate if bool(p.is_works_item) else unit_price
        total_price = float(p.total_price or 0)
        if not total_price and quantity and rate_for_total:
            total_price = round(quantity * rate_for_total * (1 + gst_percent / 100), 2)

        rows_by_tender.setdefault(int(p.tender_id), []).append({
            "id": p.id,
            "product_id": p.product_id,
            "product_name": p.product_name,
            "quantity": quantity,
            "unit_price": unit_price,
            "gst_percent": gst_percent,
            "total_price": total_price,
            "is_final_boq": bool(p.is_final_boq),
            "is_works_item": bool(p.is_works_item),
            "work_type": p.work_type,
            "work_description": p.work_description,
            "work_unit": p.work_unit,
            "work_unit_rate": work_unit_rate,
            "oem_id": p.oem_id,
            "oem_name": p.oem_name,
            "authorization_num": p.authorization_num,
            "oem_authorization": p.oem_authorization,
        })
    return rows_by_tender


# ─── GET /workorders/users ────────────────────────────────────────────────────

@router.get("/users")
def get_users(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    scope_user_ids = _scope_user_ids(db, cu)
    q = db.query(User).filter(User.is_active == True)
    if scope_user_ids is not None:
        q = q.filter(User.id.in_(scope_user_ids))
    users = q.order_by(User.full_name.asc()).all()
    return {
        "current_user_id": cu.id,
        "users": [
            {"id": u.id, "full_name": u.full_name, "employee_code": getattr(u, "employee_code", "")}
            for u in users
        ],
    }


# ─── GET /workorders ─────────────────────────────────────────────────────────

@router.get("")
def list_workorders(
    search: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.view")),
):
    """
    Returns all Won tenders merged with their work-order data.
    Each row is a Tender with result='Won', enriched with WO fields
    when a work order exists.
    """
    # Ensure consignee_submitted column exists (safe to run repeatedly — IF NOT EXISTS)
    _ensure_work_order_runtime_schema(db)

    try:
        from sqlalchemy import text as _sa_text
        db.execute(_sa_text(
            "ALTER TABLE tenders ADD COLUMN IF NOT EXISTS "
            "`consignee_submitted` TINYINT(1) NOT NULL DEFAULT 0"
        ))
        db.commit()
    except Exception:
        db.rollback()

    q = db.query(Tender).filter(Tender.result == "Won")

# ── Role-based filtering ──────────────────────────────────────────────────
    scope_user_ids = _scope_user_ids(db, cu)

    if scope_user_ids is not None:
        submitted_tender_ids = [
            row.record_id for row in
            db.query(ActivityLog.record_id).filter(
                ActivityLog.user_id.in_(scope_user_ids),
                ActivityLog.module == 'tenders',
                ActivityLog.action == 'consignees_submitted',
            ).all() if row.record_id
        ]

        wo_tender_ids = [
            row.tender_id for row in
            db.query(WorkOrder.tender_id).filter(
                WorkOrder.created_by.in_(scope_user_ids),
                WorkOrder.tender_id != None,
            ).all() if row.tender_id
        ]

        all_tender_ids = list(set(submitted_tender_ids + wo_tender_ids))

        q = q.filter(or_(
            Tender.assigned_to.in_(scope_user_ids),
            Tender.created_by.in_(scope_user_ids),
            Tender.id.in_(all_tender_ids) if all_tender_ids else False,
        ))

    if search:
        q = q.filter(
            Tender.tender_title.contains(search)
            | Tender.customer_name.contains(search)
            | Tender.portal_ref_number.contains(search)
        )

    tender_rows = q.order_by(Tender.updated_at.desc()).all()
    tender_ids = [int(t.id) for t in tender_rows if t.id]
    assigned_user_ids = {int(t.assigned_to) for t in tender_rows if t.assigned_to}
    assigned_users = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(assigned_user_ids)).all()
    } if assigned_user_ids else {}
    final_boq_by_tender = _serialize_final_boq_products_for_tenders(db, tender_ids)

    work_order_filters = []
    if tender_ids:
        work_order_filters.append(WorkOrder.tender_id.in_(tender_ids))
    tender_wo_numbers = [str(t.wrk_order_id) for t in tender_rows if getattr(t, "wrk_order_id", None)]
    if tender_wo_numbers:
        work_order_filters.append(WorkOrder.wo_number.in_(tender_wo_numbers))
    work_orders = (
        db.query(WorkOrder).filter(or_(*work_order_filters)).all()
        if work_order_filters else []
    )
    work_orders_by_tender = {
        int(wo.tender_id): wo
        for wo in work_orders
        if wo.tender_id
    }
    work_orders_by_number = {
        str(wo.wo_number): wo
        for wo in work_orders
        if wo.wo_number
    }

    rows = []
    for t in tender_rows:
        assigned_user = assigned_users.get(int(t.assigned_to)) if t.assigned_to else None
        final_boq_products = final_boq_by_tender.get(int(t.id), [])
        row = {
            # Tender fields
            "id":               t.id,
            "tender_num":       t.tender_num,
            "tender_title":     t.tender_title,
            "customer_name":    t.customer_name,
            "customer_id":      t.customer_id,
            "bid_amount":       float(getattr(t, "bid_amount", 0) or 0),
            "tender_status":    t.tender_status,
            "result":           getattr(t, "result", "Won"),
            "result_date":      t.updated_at.isoformat() if t.updated_at else None,
            "current_step":     getattr(t, "current_step", 1) or 1,
            "po_workflow_status": getattr(t, "po_workflow_status", "draft") or "draft",
            "consignee_submitted": bool(
                getattr(t, "consignee_submitted", False)
                or (getattr(t, "current_step", 0) or 0) >= 7
            ),
            "assigned_to_name": assigned_user.full_name if assigned_user else "—",
            # WO fields mirrored on tender
            "wrk_order_id":     getattr(t, "wrk_order_id",   None),
            "po_num":           getattr(t, "po_num",          None),
            "po_date":          getattr(t, "po_date",         None),
            "po_value":         float(getattr(t, "po_value",  0) or 0),
            "wo_value":         float(getattr(t, "wo_value",  0) or 0),
            "wrnty_mth":        getattr(t, "wrnty_mth",       None),
            "dlvry_date":       getattr(t, "dlvry_date",      None),
            "instln_date":      getattr(t, "instln_date",     None),
            "site_loc":         getattr(t, "site_loc",        None),
            "site_eng":         getattr(t, "site_eng",        None),
            "eng_phone":        getattr(t, "eng_phone",       None),
            "advance":          getattr(t, "advance",         None),
            "retention":        getattr(t, "retention",       None),
            "sow":              getattr(t, "sow",             None),
            "pmnt_terms":       getattr(t, "pmnt_terms",      None),
            "po_doc":           getattr(t, "po_doc",          None),   # ← relative path or None
            # ── Additional PO detail fields ───────────────────────────────────
            "portal_ref_number": getattr(t, "portal_ref_number", None),
            "no_of_consignee":  getattr(t, "no_of_consignee",  None),
            "completion_days":  getattr(t, "completion_days",  None),
            "completion_date":  str(getattr(t, "completion_date", None)) if getattr(t, "completion_date", None) else None,
            "penalty":          bool(getattr(t, "penalty",        False) or False),
            "ld_type":          getattr(t, "ld_type",           None),
            "ld_percent":       float(getattr(t, "ld_percent", 0) or 0) if getattr(t, "ld_percent", None) else None,
            "final_boq_products": final_boq_products,
            "final_boq_total": sum(float(p.get("total_price") or 0) for p in final_boq_products),
        }

        # If a WorkOrder row exists, add WO-specific fields
        wo = None
        if t.wrk_order_id:
            wo = work_orders_by_number.get(str(t.wrk_order_id))
        if not wo:
            wo = work_orders_by_tender.get(int(t.id))
        if not wo and (getattr(t, 'consignee_submitted', False) or (getattr(t, 'current_step', 0) or 0) >= 7):
            # consignees were submitted before auto-WO code existed — create WO now
            prefix   = f"WO-{now_ist().strftime('%Y%m')}-"
            from sqlalchemy import text as _sa_text
            row = db.execute(
                _sa_text("SELECT MAX(CAST(SUBSTRING(wo_number, :offset) AS UNSIGNED)) FROM work_orders WHERE wo_number LIKE :p"),
                {"p": f"{prefix}%", "offset": len(prefix) + 1}
            ).fetchone()
            wo_count = row[0] if row and row[0] else 0
            wo_number = f"{prefix}{(wo_count + 1):04d}"
            wo = WorkOrder(
                wo_number     = wo_number,
                tender_id     = t.id,
                customer_id   = t.customer_id,
                customer_name = t.customer_name or '',
                project_title = t.tender_title or t.portal_ref_number or '',
                po_number     = getattr(t, 'po_num', None) or '',
                po_value      = float(getattr(t, 'po_value', 0) or 0),
                wo_value      = float(getattr(t, 'bid_value', 0) or getattr(t, 'po_value', 0) or 0),
                delivery_date = getattr(t, 'dlvry_date', None),
                status        = 'Draft',
                created_by    = cu.id,
            )
            db.add(wo)
            db.flush()
            t.wrk_order_id = wo_number
            db.commit()
            work_orders_by_tender[int(t.id)] = wo
            work_orders_by_number[str(wo_number)] = wo
        elif wo and not t.wrk_order_id:
            # back-fill missing wrk_order_id on tender
            t.wrk_order_id = wo.wo_number
            db.commit()

        if wo:
            row.update({
                "wo_id":             wo.id,
                "wo_type":           wo.wo_type,
                "wo_status":         wo.status,
                "progress_percent":  wo.progress_percent,
                "project_title":     wo.project_title,
            })

        rows.append(row)

    # ── Direct-opportunity work orders ───────────────────────────────────────
    direct_q = db.query(WorkOrder).filter(
        WorkOrder.lead_id.isnot(None),
        WorkOrder.status.notin_(['Lost', 'Cancelled']),
    )

    if scope_user_ids is not None:
        if not scope_user_ids:
            direct_q = direct_q.filter(false())
        else:
            lead_ids_for_scope = [
                r[0] for r in db.query(Lead.id).filter(
                    Lead.assigned_to.in_(scope_user_ids)
                ).all()
            ]
            direct_q = direct_q.filter(or_(
                WorkOrder.created_by.in_(scope_user_ids),
                WorkOrder.project_manager_id.in_(scope_user_ids),
                *(
                    [WorkOrder.lead_id.in_(lead_ids_for_scope)]
                    if lead_ids_for_scope else []
                ),
            ))

    direct_wos = direct_q.order_by(WorkOrder.updated_at.desc()).all()
    direct_lead_ids = [int(wo.lead_id) for wo in direct_wos if wo.lead_id]
    direct_leads = {
        int(lead.id): lead
        for lead in db.query(Lead).filter(Lead.id.in_(direct_lead_ids)).all()
    } if direct_lead_ids else {}
    direct_assigned_user_ids = {
        int(lead.assigned_to)
        for lead in direct_leads.values()
        if lead.assigned_to
    }
    direct_assigned_users = {
        int(user.id): user
        for user in db.query(User).filter(User.id.in_(direct_assigned_user_ids)).all()
    } if direct_assigned_user_ids else {}
    consignee_counts_by_lead: dict[int, int] = {}
    if direct_lead_ids:
        try:
            count_stmt = text(
                "SELECT lead_id, COUNT(*) AS cnt "
                "FROM tender_consignees WHERE lead_id IN :lead_ids GROUP BY lead_id"
            ).bindparams(bindparam("lead_ids", expanding=True))
            for lead_id, count in db.execute(count_stmt, {"lead_ids": direct_lead_ids}).all():
                if lead_id:
                    consignee_counts_by_lead[int(lead_id)] = int(count or 0)
        except Exception:
            consignee_counts_by_lead = {}

    for wo in direct_wos:
        lead = direct_leads.get(int(wo.lead_id)) if wo.lead_id else None
        assigned_user = direct_assigned_users.get(int(lead.assigned_to)) if lead and lead.assigned_to else None
        consignee_count = consignee_counts_by_lead.get(int(wo.lead_id), 0) if wo.lead_id else 0
        rows.append({
            "id":                wo.lead_id,
            "wo_id":             wo.id,
            "from_direct":       True,
            "tender_title":      wo.project_title or (lead.lead_title if lead else ''),
            "tender_num":        wo.wo_number,
            "customer_name":     wo.customer_name or '',
            "po_num":            wo.po_number or '',
            "po_value":          float(wo.po_value or 0),
            "wo_value":          float(wo.wo_value or 0),
            "dlvry_date":        str(wo.delivery_date) if wo.delivery_date else None,
            "instln_date":       str(wo.installation_date) if wo.installation_date else None,
            "completion_date":   str(wo.completion_date) if wo.completion_date else None,
            "site_loc":          wo.site_location or '',
            "po_doc":            wo.po_doc or None,
            "wo_status":         wo.status,
            "progress_percent":  wo.progress_percent or 0,
            "wo_type":           wo.wo_type or 'Supply',
            "wrk_order_id":      wo.wo_number,
            "assigned_to_name":  assigned_user.full_name if assigned_user else '—',
            "no_of_consignee":   int(getattr(wo, "no_of_consignee", None) or 0),
            "consignee_count":   consignee_count,
            "result":            "Won",
        })

    return rows


# ─── POST /workorders  (create or update — accepts multipart/form-data) ──────

@router.post("", status_code=201)
async def create_workorder(
    request: Request,
    # ── PO Document (optional — can be uploaded later) ──────────────────
    po_doc_file: Optional[UploadFile] = File(None, alias="po_doc_file"),
    # ── Form fields ──────────────────────────────────────────────────────
    wrk_order_id:        Optional[str]   = Form(None),
    wo_type:             Optional[str]   = Form("Supply"),
    customer_name:       Optional[str]   = Form(None),
    tender_id:           Optional[int]   = Form(None),
    lead_id:             Optional[int]   = Form(None),
    po_number:           Optional[str]   = Form(None),
    po_date:             Optional[str]   = Form(None),
    po_value:            Optional[float] = Form(None),
    wo_value:            Optional[float] = Form(None),
    project_title:       Optional[str]   = Form(None),
    scope_of_work:       Optional[str]   = Form(None),
    delivery_date:       Optional[str]   = Form(None),
    installation_date:   Optional[str]   = Form(None),
    site_location:       Optional[str]   = Form(None),
    site_engineer:       Optional[str]   = Form(None),
    site_engineer_phone: Optional[str]   = Form(None),
    advance_percent:     Optional[float] = Form(0),
    retention_percent:   Optional[float] = Form(0),
    payment_terms:       Optional[str]   = Form(None),
    warranty_months:     Optional[int]   = Form(12),
    no_of_consignee:     Optional[int]   = Form(None),
    custom_data:         Optional[str]   = Form(None),
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """
    Accepts multipart/form-data.
    Frontend sends all text fields as form fields AND optionally a file
    field named  po_doc_file.

    If po_doc_file is provided → save to disk, store path in DB.
    If not provided            → keep existing po_doc value.
    """
    _ensure_work_order_runtime_schema(db)

    # Upsert endpoint: editing an existing work order needs workorders.update
    # (and the record must be in scope); a brand-new one needs workorders.create.
    _existing_target = None
    if wrk_order_id:
        _existing_target = db.query(WorkOrder).filter(WorkOrder.wo_number == wrk_order_id).first()
    elif lead_id:
        _existing_target = db.query(WorkOrder).filter(WorkOrder.lead_id == lead_id).first()
    if wrk_order_id or _existing_target is not None:
        ensure_permission(db, cu, "workorders.update")
        if _existing_target is not None and not _wo_in_scope(db, cu, wo=_existing_target):
            raise HTTPException(404, f"WorkOrder '{wrk_order_id or _existing_target.wo_number}' not found")
    else:
        ensure_permission(db, cu, "workorders.create")

    # ── Helper: Parse date strings to date objects ──────────────────────
    def parse_date(date_str: Optional[str]):
        if not date_str:
            return None
        if isinstance(date_str, str):
            from datetime import datetime
            try:
                return datetime.strptime(date_str, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                return None
        return date_str

    # Parse dates to date objects
    delivery_date_parsed = parse_date(delivery_date)
    installation_date_parsed = parse_date(installation_date)
    po_date_parsed = parse_date(po_date)

    try:
        was_existing = bool(wrk_order_id)
        previous_status: Optional[str] = None
        update_change_context: dict[str, Any] = {}

        # ── 1. Save PO document if provided ───────────────────────────────
        old_po_doc_path: Optional[str] = None
        old_po_doc_size = 0
        if po_doc_file and po_doc_file.filename:
            if wrk_order_id:
                existing_wo_for_doc = db.query(WorkOrder).filter(
                    WorkOrder.wo_number == wrk_order_id
                ).first()
                if existing_wo_for_doc:
                    old_po_doc_path = getattr(existing_wo_for_doc, "po_doc", None)
            if not old_po_doc_path and tender_id:
                existing_tender_for_doc = db.query(Tender).filter(Tender.id == tender_id).first()
                if existing_tender_for_doc:
                    old_po_doc_path = getattr(existing_tender_for_doc, "po_doc", None)
            if old_po_doc_path:
                try:
                    old_po_doc_size = stored_file_accounted_size(
                        media_url_to_logical_path(root_dir=_media_root(), file_url=old_po_doc_path)
                    )
                except Exception:
                    old_po_doc_size = 0

        po_doc_path: Optional[str] = None
        if po_doc_file and po_doc_file.filename:
            contents = await po_doc_file.read()
            if not contents:
                raise HTTPException(400, "Uploaded PO document is empty.")
            po_doc_path = _save_po_doc(
                request,
                contents,
                po_doc_file.filename,
                quota_existing_bytes=old_po_doc_size,
            )
            logger.info(f"PO doc saved: {po_doc_path}")

        # ── 1b. For direct-opportunity flow: resolve wrk_order_id via lead_id ─
        if lead_id and not wrk_order_id:
            existing_lead_wo = db.query(WorkOrder).filter(WorkOrder.lead_id == lead_id).first()
            if existing_lead_wo:
                wrk_order_id = existing_lead_wo.wo_number

        # ── 2. Create or Update WorkOrder row ────────────────────────────
        if wrk_order_id:
            # ── UPDATE existing work order ────────────────────────────────
            wo = db.query(WorkOrder).filter(
                WorkOrder.wo_number == wrk_order_id
            ).first()

            if not wo:
                raise HTTPException(404, f"WorkOrder '{wrk_order_id}' not found")

            previous_status = getattr(wo, "status", None)
            field_updates = {
                "wo_type": wo_type,
                "customer_name": customer_name,
                "tender_id": tender_id,
                "po_number": po_number,
                "po_date": po_date_parsed,
                "po_value": po_value,
                "wo_value": wo_value,
                "project_title": project_title,
                "scope_of_work": scope_of_work,
                "delivery_date": delivery_date_parsed,
                "installation_date": installation_date_parsed,
                "site_location": site_location,
                "site_engineer": site_engineer,
                "site_engineer_phone": site_engineer_phone,
                "advance_percent": advance_percent,
                "retention_percent": retention_percent,
                "payment_terms": payment_terms,
                "warranty_months": warranty_months,
                "no_of_consignee": no_of_consignee,
            }
            old_field_values = {
                field_name: getattr(wo, field_name, None)
                for field_name in field_updates
            }
            for field_name, field_value in field_updates.items():
                setattr(wo, field_name, field_value)
            if custom_data:
                try:
                    wo.custom_data = json.loads(custom_data)
                except Exception:
                    pass
            wo.updated_at          = now_ist()

            # Only overwrite po_doc if a new file was uploaded
            if po_doc_path:
                wo.po_doc = po_doc_path

            changed_fields = {
                field_name: {
                    "old": old_field_values.get(field_name),
                    "new": getattr(wo, field_name, None),
                }
                for field_name in field_updates
                if not notification_values_equal(old_field_values.get(field_name), getattr(wo, field_name, None))
            }
            note_items = ["PO document uploaded or replaced."] if po_doc_path else []
            update_change_context = build_notification_change_context(
                changes=changed_fields,
                notes=note_items,
            )

            db.flush()
            work_order_id = wrk_order_id
            logger.info(f"WorkOrder UPDATED: {work_order_id}")

        else:
            # ── CREATE new work order ─────────────────────────────────────
            work_order_id = _wo_num(db, po_number)
            wo = WorkOrder(
                wo_number           = work_order_id,
                wo_type             = wo_type,
                customer_name       = customer_name,
                tender_id           = tender_id,
                lead_id             = lead_id,
                po_number           = po_number,
                po_date             = po_date_parsed,
                po_value            = po_value,
                wo_value            = wo_value,
                project_title       = project_title,
                scope_of_work       = scope_of_work,
                delivery_date       = delivery_date_parsed,
                installation_date   = installation_date_parsed,
                site_location       = site_location,
                site_engineer       = site_engineer,
                site_engineer_phone = site_engineer_phone,
                project_manager_id  = cu.id,
                advance_percent     = advance_percent,
                retention_percent   = retention_percent,
                payment_terms       = payment_terms,
                warranty_months     = warranty_months,
                no_of_consignee     = no_of_consignee,
                po_doc              = po_doc_path,       # may be None if not uploaded yet
                status              = "Draft",
                progress_percent    = 0,
                created_by          = cu.id,
                custom_data         = (json.loads(custom_data) if custom_data else None),
            )
            db.add(wo)
            db.flush()
            logger.info(f"WorkOrder CREATED: {work_order_id}")

        # ── 3. Update Tender row ──────────────────────────────────────────
        if tender_id:
            tender = db.query(Tender).filter(Tender.id == tender_id).first()
            if not tender:
                raise HTTPException(404, f"Tender id={tender_id} not found")

            tender.po_num        = po_number
            tender.po_value      = po_value
            tender.wo_value      = wo_value
            tender.wrnty_mth     = warranty_months
            tender.dlvry_date    = delivery_date_parsed
            tender.instln_date   = installation_date_parsed
            tender.po_date       = po_date_parsed
            tender.site_loc      = site_location
            tender.site_eng      = site_engineer
            tender.eng_phone     = site_engineer_phone
            tender.advance       = advance_percent
            tender.retention     = retention_percent
            tender.sow           = scope_of_work
            tender.pmnt_terms    = payment_terms
            tender.wrk_order_id  = work_order_id
            tender.tender_status = "Closed"

            # Mirror po_doc to tender table as well
            if po_doc_path:
                tender.po_doc = po_doc_path

            db.flush()

            db.add(ActivityLog(
                user_id     = cu.id,
                module      = "tenders",
                record_id   = tender.id,
                action      = "wo_created",
                description = f"Work Order {work_order_id} {'updated' if wrk_order_id else 'created'} from this tender",
                icon        = "📋",
                color       = "#F0FDF4",
            ))

        completed_now = getattr(wo, "status", None) == "Completed" and previous_status != "Completed"
        delayed_or_overdue_now = (
            getattr(wo, "status", None) == "Delayed" or _is_workorder_overdue(wo)
        ) and (previous_status != "Delayed" or _is_workorder_overdue(wo))

        primary_event_key = 'created'
        primary_extra_context = None
        if was_existing:
            primary_extra_context = update_change_context or None
            if completed_now:
                primary_event_key = 'completed'
            elif delayed_or_overdue_now:
                primary_event_key = 'delayed_overdue'
            elif po_doc_path:
                primary_event_key = 'po_uploaded'
            else:
                primary_event_key = 'updated'

        _emit_workorder_event(
            db,
            work_order=wo,
            event_key=primary_event_key,
            actor=cu,
            extra_context=primary_extra_context,
        )

        db.commit()
        logger.info("DB COMMIT SUCCESS")
        if po_doc_path and old_po_doc_path and old_po_doc_path != po_doc_path:
            try:
                delete_stored_file(media_url_to_logical_path(root_dir=_media_root(), file_url=old_po_doc_path))
            except Exception:
                logger.warning("Failed to delete replaced work order PO document: %s", old_po_doc_path, exc_info=True)
            tenant_slug = str(db.info.get("tenant_slug") or "").strip()
            if tenant_slug:
                refresh_tenant_storage_usage_for_slug(tenant_slug)

        return {
            "message":    "Work order saved successfully",
            "wo_id":      wo.id,
            "wo_number":  work_order_id,
            "tender_id":  tender_id,
            "po_doc":     po_doc_path or (wo.po_doc if wo else None),
        }

    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.exception(f"create_workorder error: {e}")
        if "Data too long for column 'po_doc'" in str(e):
            raise HTTPException(
                500,
                "PO document path could not be saved.",
            )
        raise HTTPException(500, str(e))


# ─── GET /workorders/by-lead/{lead_id}  (direct opportunity flow) ────────────

def _wo_owner_name(db: Session, wo: WorkOrder) -> str:
    user_id = wo.project_manager_id or wo.created_by
    if not user_id:
        return ""
    user = db.query(User).filter(User.id == user_id).first()
    return user.full_name if user else ""


def _wo_summary_dict(wo: WorkOrder, db: Session | None = None) -> dict:
    return {
        "id":                  wo.id,
        "wo_number":           wo.wo_number,
        "lead_id":             wo.lead_id,
        "quotation_id":        wo.quotation_id,
        "wo_type":             wo.wo_type or "Supply",
        "customer_name":       wo.customer_name or "",
        "project_title":       wo.project_title or "",
        "po_number":           wo.po_number or "",
        "po_date":             str(wo.po_date) if wo.po_date else None,
        "po_value":            float(wo.po_value or 0),
        "wo_value":            float(wo.wo_value or 0),
        "warranty_months":     int(wo.warranty_months or 12),
        "delivery_date":       str(wo.delivery_date) if wo.delivery_date else None,
        "installation_date":   str(wo.installation_date) if wo.installation_date else None,
        "site_location":       wo.site_location or "",
        "site_engineer":       wo.site_engineer,
        "site_engineer_phone": wo.site_engineer_phone or "",
        "advance_percent":     float(wo.advance_percent or 0),
        "retention_percent":   float(wo.retention_percent or 0),
        "payment_terms":       wo.payment_terms or "",
        "scope_of_work":       wo.scope_of_work or "",
        "po_doc":              wo.po_doc or None,
        "wo_status":           wo.status or "Draft",
        "progress_percent":    int(wo.progress_percent or 0),
        "no_of_consignee":     int(getattr(wo, "no_of_consignee", None) or 0),
        "owner_name":          _wo_owner_name(db, wo) if db is not None else "",
    }


@router.get("/by-lead/{lead_id}")
def get_wo_by_lead(
    lead_id: int,
    db: Session  = Depends(get_tenant_db),
    cu: User     = Depends(require_permission("workorders.view")),
):
    _ensure_work_order_runtime_schema(db)

    wo = db.query(WorkOrder).filter(WorkOrder.lead_id == lead_id).first()
    if not wo or not _wo_in_scope(db, cu, wo=wo):
        return None
    return _wo_summary_dict(wo, db)


# ─── GET /workorders/by-quotation/{quotation_id}  (quotation → work order) ───
# A work order can be linked to its source quotation directly (wo.quotation_id)
# even when wo.lead_id is unset — e.g. the quotation's lead was never carried
# onto the work order. by-lead alone misses those; this closes that gap.

@router.get("/by-quotation/{quotation_id}")
def get_wo_by_quotation(
    quotation_id: int,
    db: Session  = Depends(get_tenant_db),
    cu: User     = Depends(require_permission("workorders.view")),
):
    _ensure_work_order_runtime_schema(db)

    wo = db.query(WorkOrder).filter(WorkOrder.quotation_id == quotation_id).first()
    if not wo or not _wo_in_scope(db, cu, wo=wo):
        return None
    return _wo_summary_dict(wo, db)


# ─── GET /workorders/by-tender/{tender_id}  (tender flow) ────────────────────

@router.get("/by-tender/{tender_id}")
def get_wo_by_tender(
    tender_id: int,
    db: Session  = Depends(get_tenant_db),
    cu: User     = Depends(require_permission("workorders.view")),
):
    _ensure_work_order_runtime_schema(db)

    wo = db.query(WorkOrder).filter(WorkOrder.tender_id == tender_id).first()
    if not wo or not _wo_in_scope(db, cu, wo=wo):
        return None
    return {
        "id":                  wo.id,
        "wo_number":           wo.wo_number,
        "tender_id":           wo.tender_id,
        "wo_type":             wo.wo_type or "Supply",
        "customer_name":       wo.customer_name or "",
        "project_title":       wo.project_title or "",
        "po_number":           wo.po_number or "",
        "po_date":             str(wo.po_date) if wo.po_date else None,
        "po_value":            float(wo.po_value or 0),
        "wo_value":            float(wo.wo_value or 0),
        "warranty_months":     int(wo.warranty_months or 12),
        "delivery_date":       str(wo.delivery_date) if wo.delivery_date else None,
        "installation_date":   str(wo.installation_date) if wo.installation_date else None,
        "site_location":       wo.site_location or "",
        "site_engineer":       wo.site_engineer,
        "site_engineer_phone": wo.site_engineer_phone or "",
        "advance_percent":     float(wo.advance_percent or 0),
        "retention_percent":   float(wo.retention_percent or 0),
        "payment_terms":       wo.payment_terms or "",
        "scope_of_work":       wo.scope_of_work or "",
        "po_doc":              wo.po_doc or None,
        "wo_status":           wo.status or "Draft",
        "progress_percent":    int(wo.progress_percent or 0),
        "no_of_consignee":     int(getattr(wo, "no_of_consignee", None) or 0),
        "owner_name":          _wo_owner_name(db, wo),
    }


# ─── PATCH /workorders/{id}/progress ─────────────────────────────────────────

@router.patch("/{wo_id}/progress")
def update_progress(
    wo_id:    int,
    progress: int,
    status:   str,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.update")),
):
    _ensure_work_order_runtime_schema(db)

    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo or not _wo_in_scope(db, cu, wo=wo):
        raise HTTPException(404, "WorkOrder not found")

    previous_status = getattr(wo, "status", None)
    previous_progress = getattr(wo, "progress_percent", None)
    wo.progress_percent = max(0, min(100, progress))
    wo.status           = status
    wo.updated_at       = now_ist()
    if previous_progress != wo.progress_percent or previous_status != wo.status:
        progress_change_context = build_notification_change_context(
            changes={
                "progress_percent": {"old": previous_progress, "new": wo.progress_percent, "label": "Progress"},
                "status": {"old": previous_status, "new": wo.status, "label": "Status"},
            }
        )
        if wo.status == "Completed" and previous_status != "Completed":
            primary_event_key = 'completed'
        elif (wo.status == "Delayed" or _is_workorder_overdue(wo)) and (previous_status != "Delayed" or _is_workorder_overdue(wo)):
            primary_event_key = 'delayed_overdue'
        else:
            primary_event_key = 'progress_changed'

        _emit_workorder_event(
            db,
            work_order=wo,
            event_key=primary_event_key,
            actor=cu,
            extra_context=progress_change_context,
        )
    db.commit()
    return {"id": wo_id, "progress_percent": wo.progress_percent, "status": wo.status}


# ─── GET /workorders/{tender_id}/po-doc  (inline preview) ────────────────────

@router.get("/{tender_id}/po-doc")
def preview_po_doc(
    request: Request,
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.view")),
):
    """
    Stream the PO document inline (for iframe / browser tab preview).
    Looks up po_doc path from the Tender row.
    """
    tender = db.query(Tender).filter(Tender.id == tender_id).first()
    if not tender or not _wo_in_scope(
        db, cu, wo=db.query(WorkOrder).filter(WorkOrder.tender_id == tender_id).first(), tender=tender,
    ):
        raise HTTPException(404, "Tender not found")

    resolved = _resolve_available_po_doc_file(request, _po_doc_path_candidates(db, tender))
    if not resolved:
        raise HTTPException(404, "No PO document uploaded for this work order")

    abs_path, physical_path, po_doc = resolved
    logger.info(f"preview_po_doc: tender_id={tender_id} po_doc={po_doc!r} resolved={physical_path!r}")
    if not physical_path.exists():
        logger.error(f"PO doc file missing on disk: {physical_path!r}  (media_root={_media_root()!r})")
        raise HTTPException(404, f"PO document file not found on server")

    file_obj, _, _ = open_stored_file(abs_path)
    content_type, headers = stored_file_headers(
        logical_path=abs_path,
        disposition="inline",
        download_name=os.path.basename(abs_path),
    )
    return StreamingResponse(iter_file_chunks(file_obj), media_type=content_type, headers=headers)


# ─── GET /workorders/{tender_id}/po-doc/download  (force download) ───────────

@router.get("/{tender_id}/po-doc/download")
def download_po_doc(
    request: Request,
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.view")),
):
    """
    Force-download the PO document with the original extension preserved.
    """
    tender = db.query(Tender).filter(Tender.id == tender_id).first()
    if not tender or not _wo_in_scope(
        db, cu, wo=db.query(WorkOrder).filter(WorkOrder.tender_id == tender_id).first(), tender=tender,
    ):
        raise HTTPException(404, "Tender not found")

    resolved = _resolve_available_po_doc_file(request, _po_doc_path_candidates(db, tender))
    if not resolved:
        raise HTTPException(404, "No PO document uploaded for this work order")

    abs_path, physical_path, po_doc = resolved
    logger.info(f"download_po_doc: tender_id={tender_id} po_doc={po_doc!r} resolved={physical_path!r}")
    if not physical_path.exists():
        logger.error(f"PO doc file missing on disk: {physical_path!r}  (media_root={_media_root()!r})")
        raise HTTPException(404, "PO document file not found on server")

    ext          = os.path.splitext(abs_path)[1].lower()
    wo_ref       = getattr(tender, "wrk_order_id", None) or f"tender-{tender_id}"
    download_name = f"PO-{wo_ref}{ext}"

    file_obj, _, _ = open_stored_file(abs_path)
    content_type, headers = stored_file_headers(
        logical_path=abs_path,
        disposition="attachment",
        download_name=download_name,
    )
    return StreamingResponse(iter_file_chunks(file_obj), media_type=content_type, headers=headers)


# ─── Badge / mark-seen ────────────────────────────────────────────────────────

@router.get("/badge")
def get_workorder_badge(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _ensure_work_order_runtime_schema(db)

    layout = dict(cu.dashboard_layout or {})
    last_seen_str = layout.get("workorders_last_seen_at")
    if not last_seen_str:
        layout["workorders_last_seen_at"] = now_ist().isoformat()
        cu.dashboard_layout = layout; db.commit()
        return {"count": 0}
    try:
        last_seen = datetime.fromisoformat(last_seen_str)
    except ValueError:
        return {"count": 0}
    q = db.query(func.count(WorkOrder.id)).filter(WorkOrder.created_at > last_seen)
    scope_user_ids = _scope_user_ids(db, cu)
    if scope_user_ids is not None:
        q = q.filter(or_(
            WorkOrder.created_by.in_(scope_user_ids),
            WorkOrder.project_manager_id.in_(scope_user_ids),
        ))
    count = q.scalar() or 0
    return {"count": count}


@router.post("/mark-seen")
def mark_workorders_seen(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    layout = dict(cu.dashboard_layout or {})
    layout["workorders_last_seen_at"] = now_ist().isoformat()
    cu.dashboard_layout = layout; db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


# ─── Per-user list-table display preferences (work orders list only) ─────────

class WorkOrdersTablePrefsBody(BaseModel):
    stack_order: dict = {}


@router.get("/table-prefs")
def get_workorders_table_prefs(
    cu: User = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    return layout.get("table_prefs", {}).get("workorders-list", {"stack_order": {}})


@router.post("/table-prefs")
def save_workorders_table_prefs(
    body: WorkOrdersTablePrefsBody,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    layout = dict(cu.dashboard_layout or {})
    table_prefs = dict(layout.get("table_prefs", {}))
    table_prefs["workorders-list"] = {"stack_order": body.stack_order}
    layout["table_prefs"] = table_prefs
    cu.dashboard_layout = layout
    db.commit()
    return {"ok": True}


# ─── DELETE /workorders/by-tender/{tender_id} ────────────────────────────────

@router.delete("/by-tender/{tender_id}")
def delete_workorder_by_tender(
    tender_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.delete")),
):
    """
    Soft-delete a work order and its linked tender by tender ID.
    Requires the workorders.delete permission.
    """
    _ensure_work_order_runtime_schema(db)

    tender = db.query(Tender).filter(Tender.id == tender_id).first()
    if not tender:
        raise HTTPException(404, f"Tender id={tender_id} not found")

    wo = None
    if tender.wrk_order_id:
        wo = db.query(WorkOrder).filter(WorkOrder.wo_number == tender.wrk_order_id).first()
    if not wo:
        wo = db.query(WorkOrder).filter(WorkOrder.tender_id == tender_id).first()

    if not _wo_in_scope(db, cu, wo=wo, tender=tender):
        raise HTTPException(404, f"Tender id={tender_id} not found")

    if wo:
        db.delete(wo)

    tender.is_deleted = True
    db.commit()

    return {"ok": True, "deleted_wo": wo.wo_number if wo else None, "tender_id": tender_id}


# ─── DELETE /workorders/{wo_id}  (direct-opportunity work orders) ─────────────

@router.delete("/{wo_id}")
def delete_workorder_direct(
    wo_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(require_permission("workorders.delete")),
):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo or not _wo_in_scope(db, cu, wo=wo):
        raise HTTPException(404, f"WorkOrder id={wo_id} not found")

    db.delete(wo)
    db.commit()
    return {"ok": True, "deleted_wo": wo.wo_number}

