"""Reports router — per-module reports with CSV / Excel export + AI cross-module insights.
All date-range reports default to the current calendar month when no date filters are provided.
"""
import logging, csv, io, calendar
from datetime import date, datetime, timedelta
from app.core.timezone import now_ist, today_ist
from typing import Optional, List, Any
from collections import Counter, defaultdict
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, case, literal_column, text, or_, and_, cast, String
from sqlalchemy.orm import Session, aliased
from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import (
    LeadSource,
    Permission, Role, RolePermission,
    Lead, LeadProduct, LeadProductOEM,
    Tender, TenderConsignee, TenderProduct, TenderProductOEM, TenderTechBidBidder,
    WorkOrder, WOLineItem, WOInvoice,
    Approval, Customer, CustomerContact, ProductMaster,
    KAMActivity, EMDBG, TADAClaim, TADALineItem, TravelRequest,
    Quotation, QuotationLineItem, User,
    SalesCustomerAssignment,
    SavedReportView,
    Competitor, TenderLossAnalysis,
    OEM, VerticalSector, VerticalSubSector,
)
from app.utils.data_scope import get_team_user_ids

logger = logging.getLogger(__name__)

REPORT_ACCESS_PERMISSION_KEYS = (
    "reports.view",
    "reports.customers.view",
    "reports.leads.view",
    "reports.opportunities.view",
    "reports.tenders.view",
    "reports.quotations.view",
    "reports.workorders.view",
    "reports.emdbg.view",
    "reports.kam.view",
    "reports.travel.view",
    "reports.tada.view",
    "reports.oem.view",
    "reports.competitors.view",
)


def _require_reports_access(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
) -> User:
    role_row = db.query(Role).filter(
        Role.name == cu.role,
        Role.is_active == True,
    ).first()
    if not role_row:
        raise HTTPException(status_code=403, detail="You don't have permission to view reports")

    granted_keys = {
        key
        for (key,) in (
            db.query(Permission.key)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .filter(RolePermission.role_id == role_row.id)
            .all()
        )
    }
    if "*" in granted_keys or any(key in granted_keys for key in REPORT_ACCESS_PERMISSION_KEYS):
        return cu

    raise HTTPException(status_code=403, detail="You don't have permission to view reports")


router = APIRouter(dependencies=[Depends(_require_reports_access)])


# ─── helpers ──────────────────────────────────────────────────────────────────

def _current_month_range() -> tuple[str, str]:
    """Return (first_day_of_month, today) as ISO strings for default filtering."""
    today = today_ist()
    first = today.replace(day=1)
    return first.isoformat(), today.isoformat()


def _date_filter(q, model, field, date_from, date_to):
    if date_from:
        q = q.filter(getattr(model, field) >= date_from)
    if date_to:
        q = q.filter(getattr(model, field) <= date_to)
    return q


def _username(db: Session, uid) -> str:
    if not uid:
        return ""
    u = db.query(User).filter(User.id == uid).first()
    return u.full_name if u else ""


def _chart(data: list, key: str, value_key: str | None = None) -> list:
    """Build chart_data from a list of dicts grouped by *key*."""
    groups: dict = {}
    for row in data:
        label = str(row.get(key) or "—")
        groups.setdefault(label, {"label": label, "count": 0, "value": 0.0})
        groups[label]["count"] += 1
        if value_key and row.get(value_key):
            groups[label]["value"] += float(row[value_key])
    return [v for v in groups.values() if v["count"] > 0]


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean_value = str(value or "").strip()
        if not clean_value or clean_value in seen:
            continue
        seen.add(clean_value)
        result.append(clean_value)
    return result


def _lead_source_label(lead: Lead, source_map: dict[int, str]) -> str:
    source_name = source_map.get(int(lead.source_id)) if getattr(lead, "source_id", None) else ""
    if source_name:
        return source_name

    channel = str(getattr(lead, "channel", "") or "").strip().lower()
    if channel and channel != "manual":
        return channel.replace("_", " ").title()
    return "Direct"


def _amount(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _to_date(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    return value


def _days_since(value, today: date) -> int:
    dt = _to_date(value)
    if not dt:
        return 0
    return max((today - dt).days, 0)


def _clamp_score(value: float, low: int = 5, high: int = 95) -> int:
    return int(max(low, min(high, round(value))))


def _score_band(value: float, high: int = 70, medium: int = 45) -> str:
    if value >= high:
        return "High"
    if value >= medium:
        return "Medium"
    return "Low"


def _top_signal_payload(signals: list[tuple[float, str, str]], limit: int = 4) -> list[dict]:
    ordered: list[dict] = []
    seen: set[str] = set()
    for weight, text, tone in sorted(signals, key=lambda item: abs(item[0]), reverse=True):
        key = str(text or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append({"text": text, "tone": tone})
        if len(ordered) >= limit:
            break
    return ordered


def _approval_reason_bucket(text: str) -> str:
    note = str(text or "").strip().lower()
    if not note:
        return "Not specified"
    if any(token in note for token in ("price", "pricing", "commercial", "cost", "quote", "quoted", "amount", "bid")):
        return "Pricing / Commercial"
    if any(token in note for token in ("compliance", "document", "documentation", "eligibility", "technical", "spec")):
        return "Compliance / Technical"
    if any(token in note for token in ("missing", "incomplete", "clarification", "details", "data", "pending")):
        return "Incomplete Information"
    if any(token in note for token in ("duplicate", "already", "existing")):
        return "Duplicate / Already Exists"
    if any(token in note for token in ("delay", "timeline", "late", "sla")):
        return "Delay / Timeline"
    return "Other"


def _customer_key(customer_name: str | None, customer_id) -> str:
    clean_name = str(customer_name or "").strip()
    if clean_name:
        return clean_name
    if customer_id:
        return f"customer:{customer_id}"
    return "Unknown"


_EMDBG_TENDER_FEE_TYPES = ("dd", "online payment")
_EMDBG_EMD_TYPES = ("emd",)
_EMDBG_PBG_TYPES = (
    "performance bg",
    "security deposit",
    "advance bg",
    "retention bg",
    "pbg",
    "bg",
    "bank guarantee",
)


def _clean_lower(value: Any) -> str:
    return str(value or "").strip().lower()


def _emdbg_category_from_type(instrument_type: Any) -> str:
    raw = _clean_lower(instrument_type)
    if any(item == raw or item in raw for item in _EMDBG_TENDER_FEE_TYPES):
        return "Tender Fee"
    if any(item == raw or item in raw for item in _EMDBG_EMD_TYPES):
        return "EMD"
    if any(item == raw or item in raw for item in _EMDBG_PBG_TYPES):
        return "PBG"
    return "EMD"


def _emdbg_is_terminal_status(status: Any, return_status: Any) -> bool:
    status_text = _clean_lower(status)
    return_text = _clean_lower(return_status)
    return any(word in status_text for word in ("released", "cancelled", "canceled", "encashed")) or return_text == "confirmed"


def _emdbg_is_expired_status(status: Any, expiry_status: Any, days_to_expiry: Optional[int]) -> bool:
    if _clean_lower(expiry_status) == "expired" or _clean_lower(status) == "expired":
        return True
    return days_to_expiry is not None and days_to_expiry < 0


def _emdbg_is_expiring_within(category: str, days_to_expiry: Optional[int], days: int, terminal: bool) -> bool:
    return category == "PBG" and days_to_expiry is not None and 0 <= days_to_expiry <= days and not terminal


def _emdbg_action_label_for_item(item: dict[str, Any]) -> str:
    approval = _clean_lower(item.get("approval_status") or "none")
    finance = _clean_lower(item.get("finance_status") or "unpaid")
    status = _clean_lower(item.get("status"))
    category = item.get("category") or _emdbg_category_from_type(item.get("instrument_type"))
    terminal = _emdbg_is_terminal_status(item.get("status"), item.get("return_status"))
    expired = _emdbg_is_expired_status(item.get("status"), item.get("expiry_status"), item.get("days_to_expiry"))
    if approval == "rejected":
        return "Approval rejected"
    if approval == "pending":
        return "Approval pending"
    if "pending" in _clean_lower(item.get("return_status")):
        return "Confirm return"
    if category == "PBG" and expired and not terminal:
        return "Expired not released"
    if _emdbg_is_expiring_within(category, item.get("days_to_expiry"), 7, terminal):
        return "Renewal critical"
    if _emdbg_is_expiring_within(category, item.get("days_to_expiry"), 30, terminal):
        return "Renewal watch"
    if approval == "approved" and not item.get("instrument_document_url") and finance != "paid":
        return "Upload instrument"
    if approval == "approved" and item.get("instrument_document_url") and not item.get("instrument_acknowledged") and finance != "paid":
        return "Acknowledge doc"
    if approval == "approved" and item.get("instrument_acknowledged") and not item.get("payment_proof_url") and finance != "paid":
        return "Payment proof pending"
    if finance != "paid" and not terminal:
        return "Finance pending"
    if status == "encashed":
        return "Encashed"
    return "Monitor"


def _emdbg_action_priority(label: str) -> int:
    if label == "Expired not released":
        return 0
    if label == "Renewal critical":
        return 1
    if label == "Confirm return":
        return 2
    if label == "Approval rejected":
        return 3
    if label == "Approval pending":
        return 4
    if label != "Monitor":
        return 5
    return 9


def _build_emdbg_customer_action_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    customer_actions: dict[str, dict[str, Any]] = {}
    for item in items:
        name = str(item.get("customer_name") or item.get("client_name") or "Unassigned").strip() or "Unassigned"
        customer_id = item.get("customer_id")
        key = f"id:{customer_id}" if customer_id else f"name:{name.lower()}"
        category = item.get("category") or _emdbg_category_from_type(item.get("instrument_type"))
        terminal = _emdbg_is_terminal_status(item.get("status"), item.get("return_status"))
        overdue = category == "PBG" and _emdbg_is_expired_status(item.get("status"), item.get("expiry_status"), item.get("days_to_expiry")) and not terminal
        expiring = _emdbg_is_expiring_within(category, item.get("days_to_expiry"), 30, terminal)
        action_label = _emdbg_action_label_for_item({**item, "category": category})
        has_action = action_label != "Monitor"

        summary = customer_actions.get(key)
        if summary is None:
            summary = {
                "name": name,
                "customer_id": int(customer_id) if customer_id else None,
                "count": 0,
                "value": 0.0,
                "action_count": 0,
                "tender_fee_pending": 0,
                "emd_pending": 0,
                "pbg_pending": 0,
                "overdue_count": 0,
                "expiring_count": 0,
                "priority": 9,
                "days_to_expiry": None,
            }
            customer_actions[key] = summary

        amount = float(item.get("amount") or 0)
        summary["count"] += 1
        summary["value"] += amount
        if has_action:
            summary["action_count"] += 1
            summary["priority"] = min(summary["priority"], _emdbg_action_priority(action_label))
            if category == "Tender Fee":
                summary["tender_fee_pending"] += 1
            elif category == "EMD":
                summary["emd_pending"] += 1
            elif category == "PBG":
                summary["pbg_pending"] += 1
        if overdue:
            summary["overdue_count"] += 1
        if expiring:
            summary["expiring_count"] += 1
        days_left = item.get("days_to_expiry")
        if days_left is not None:
            current_days = summary.get("days_to_expiry")
            summary["days_to_expiry"] = days_left if current_days is None else min(current_days, days_left)

    rows = list(customer_actions.values())
    for row in rows:
        row["value"] = round(float(row["value"] or 0), 2)

    def pending_sort(row: dict[str, Any]):
        return (
            int(row["priority"]),
            -int(row["action_count"]),
            -int(row["pbg_pending"]),
            -float(row["value"]),
            str(row["name"]).lower(),
        )

    def overdue_sort(row: dict[str, Any]):
        return (
            -int(row["overdue_count"]),
            -int(row["expiring_count"]),
            -int(row["action_count"]),
            str(row["name"]).lower(),
        )

    def public_row(row: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in row.items()
            if key not in {"priority", "days_to_expiry"}
        }

    pending_rows = [row for row in rows if int(row["action_count"]) > 0]
    overdue_rows = [row for row in rows if int(row["overdue_count"]) > 0 or int(row["expiring_count"]) > 0]
    return {
        "pending_customer_count": len(pending_rows),
        "overdue_customer_count": len(overdue_rows),
        "pending_action_count": sum(int(row["action_count"]) for row in pending_rows),
        "overdue_expiry_count": sum(int(row["overdue_count"]) + int(row["expiring_count"]) for row in overdue_rows),
        "top_pending_customers": [public_row(row) for row in sorted(pending_rows, key=pending_sort)[:10]],
        "top_overdue_customers": [public_row(row) for row in sorted(overdue_rows, key=overdue_sort)[:10]],
    }


def _export(data: list, filename: str, fmt: str):
    if not data:
        return {"message": "No data to export"}
    today = today_ist()
    if fmt == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=list(data[0].keys()))
        writer.writeheader()
        writer.writerows(data)
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}_{today}.csv"},
        )
    # Excel via openpyxl
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = filename.replace("_report", "").title()
        headers = list(data[0].keys())
        hdr_fill = PatternFill(start_color="0B1F3A", end_color="0B1F3A", fill_type="solid")
        thin = Side(style="thin", color="D1D5DB")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        for ci, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=ci, value=h.replace("_", " ").title())
            cell.font = Font(bold=True, color="FFFFFF", size=11)
            cell.fill = hdr_fill
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = border
            ws.column_dimensions[cell.column_letter].width = max(14, len(str(h)) + 6)
        for ri, row in enumerate(data, 2):
            fill = PatternFill(start_color="F8FAFF", end_color="F8FAFF", fill_type="solid") if ri % 2 == 0 else None
            for ci, key in enumerate(headers, 1):
                cell = ws.cell(row=ri, column=ci, value=row.get(key, ""))
                cell.border = border
                if fill:
                    cell.fill = fill
        ws.freeze_panes = "A2"
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}_{today}.xlsx"},
        )
    except ImportError:
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=list(data[0].keys()))
        writer.writeheader()
        writer.writerows(data)
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}_{today}.csv"},
        )


# ─── endpoints ────────────────────────────────────────────────────────────────

# ── date preset helpers ──────────────────────────────────────────────────────

def _resolve_date_preset(preset: Optional[str], date_from: Optional[str], date_to: Optional[str]):
    """Return (date_from, date_to, prev_from, prev_to) ISO strings based on preset or explicit range.
    Returns (None, None, None, None) when no preset and no explicit dates — means show all records."""
    today = today_ist()
    if not preset and not date_from and not date_to:
        # No date filter at all — return None so callers skip date filtering
        return None, None, None, None
    if preset == "this_month":
        df = today.replace(day=1)
        dt = today
    elif preset == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        df = last_prev.replace(day=1)
        dt = last_prev
    elif preset == "this_quarter":
        q = (today.month - 1) // 3
        df = today.replace(month=q * 3 + 1, day=1)
        dt = today
    elif preset == "last_quarter":
        q = (today.month - 1) // 3
        if q == 0:
            df = today.replace(year=today.year - 1, month=10, day=1)
            dt = today.replace(year=today.year - 1, month=12, day=31)
        else:
            df = today.replace(month=(q - 1) * 3 + 1, day=1)
            last_m = q * 3
            dt = today.replace(month=last_m, day=calendar.monthrange(today.year, last_m)[1])
    elif preset == "this_year":
        df = today.replace(month=1, day=1)
        dt = today
    elif preset == "today":
        df = today
        dt = today
    elif preset == "this_week":
        df = today - timedelta(days=today.weekday())
        dt = today
    elif preset == "last_year":
        df = today.replace(year=today.year - 1, month=1, day=1)
        dt = today.replace(year=today.year - 1, month=12, day=31)
    else:
        # custom range — use provided dates or fall back to current month
        df = date.fromisoformat(date_from) if date_from else today.replace(day=1)
        dt = date.fromisoformat(date_to) if date_to else today

    duration = (dt - df).days + 1
    prev_to = df - timedelta(days=1)
    prev_from = prev_to - timedelta(days=duration - 1)
    return df.isoformat(), dt.isoformat(), prev_from.isoformat(), prev_to.isoformat()


def _normalized_role(role) -> str:
    return "_".join(str(role or "").strip().lower().replace("-", " ").split())


def _split_csv_strings(value) -> list[str]:
    return [part.strip() for part in str(value or "").split(",") if str(part).strip()]


def _clean_segment_name(value: Optional[str]) -> str:
    """Customer.customer_vertical is free text, not FK-constrained — collapse
    whitespace / non-breaking spaces so casing/whitespace variants of the same
    master segment don't appear as separate values in reports."""
    if not value:
        return ""
    return " ".join(str(value).replace(chr(160), " ").split()).strip()


def _segment_customer_ids(db: Session, values: list[str]) -> list[int]:
    """Resolve selected customer-segment names (from the Vertical Sector master /
    filter UI) to matching Customer ids using cleaned, case-insensitive comparison.
    Customer.customer_vertical is free text, so an exact/raw match against the
    master's name silently drops customers whose stored value differs only by
    casing or stray whitespace — which is why segment filters were undercounting
    customers that clearly belong to the selected segment."""
    wanted = {_clean_segment_name(v).casefold() for v in values if _clean_segment_name(v)}
    if not wanted:
        return []
    return [
        int(cid) for cid, seg in db.query(Customer.id, Customer.customer_vertical)
        .filter(Customer.is_deleted == False).all()
        if _clean_segment_name(seg).casefold() in wanted
    ]


def _split_csv_ints(value) -> list[int]:
    result: list[int] = []
    for part in _split_csv_strings(value):
        try:
            result.append(int(part))
        except (TypeError, ValueError):
            continue
    return result


def _get_role_perm_keys(db: Session, cu: User) -> set[str]:
    role_row = db.query(Role).filter(Role.name == cu.role, Role.is_active == True).first()
    if not role_row:
        return set()
    return {
        key
        for (key,) in db.query(Permission.key)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .filter(RolePermission.role_id == role_row.id)
        .all()
    }


DATA_SCOPE_ORDER = {"none": 0, "own": 1, "team": 2, "all": 3}
REPORT_TEAM_ROLES = {"manager", "vp", "sales_head", "saleshead"}


def _coerce_data_scope(value) -> str:
    scope = str(value or "own").strip().lower()
    return scope if scope in DATA_SCOPE_ORDER else "own"


def _extract_int_ids(value) -> set[int]:
    if value is None:
        return set()
    if isinstance(value, (list, tuple, set)):
        result: set[int] = set()
        for item in value:
            result.update(_extract_int_ids(item))
        return result
    if isinstance(value, dict):
        result: set[int] = set()
        for item in value.values():
            result.update(_extract_int_ids(item))
        return result
    result: set[int] = set()
    raw = str(value or "").replace("[", ",").replace("]", ",").replace("'", ",").replace('"', ",")
    for part in raw.split(","):
        try:
            result.add(int(str(part).strip()))
        except (TypeError, ValueError):
            continue
    return result


def _get_report_data_scope(db: Session, cu: User) -> str:
    role_row = db.query(Role).filter(Role.name == cu.role, Role.is_active == True).first()
    if not role_row:
        return "own"

    base_scope_row = (
        db.query(RolePermission.data_scope)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(RolePermission.role_id == role_row.id, Permission.key == "reports.view")
        .first()
    )
    if base_scope_row:
        return _coerce_data_scope(base_scope_row[0])

    scopes = [
        _coerce_data_scope(scope)
        for (scope,) in db.query(RolePermission.data_scope)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(
            RolePermission.role_id == role_row.id,
            Permission.key.in_(REPORT_ACCESS_PERMISSION_KEYS),
        )
        .all()
    ]
    if not scopes:
        return "own"
    return max(scopes, key=lambda scope: DATA_SCOPE_ORDER[scope])


def _report_team_user_ids(db: Session, cu: User) -> list[int]:
    if not getattr(cu, "id", None):
        return []
    current_user_id = int(cu.id)
    team_ids = set(get_team_user_ids(db, current_user_id))
    direct_ids = {
        int(user_id)
        for (user_id,) in db.query(User.id).filter(
            User.reporting_manager_id == current_user_id,
            User.is_active == True,
        ).all()
    }
    team_ids.update(direct_ids)
    for user_id, manager_ids in db.query(User.id, User.reporting_manager_ids).filter(User.is_active == True).all():
        if current_user_id in _extract_int_ids(manager_ids):
            team_ids.add(int(user_id))
    team_ids.add(current_user_id)
    return sorted(team_ids)


def _report_scope_user_ids(db: Session, cu: User) -> Optional[list[int]]:
    role = _normalized_role(getattr(cu, "role", ""))
    if role in ("admin", "ceo", "super_admin"):
        return None
    perm_keys = _get_role_perm_keys(db, cu)
    if "*" in perm_keys or "reports.view_all_data" in perm_keys:
        return None
    data_scope = _get_report_data_scope(db, cu)
    if data_scope == "all":
        return None
    if data_scope == "none":
        return []
    if data_scope == "team" or role in REPORT_TEAM_ROLES:
        return _report_team_user_ids(db, cu)
    return [int(cu.id)] if getattr(cu, "id", None) else []


def _build_leads_scope(db: Session, cu: User):
    q = db.query(Lead).filter(Lead.is_deleted == False)
    scope_ids = _report_scope_user_ids(db, cu)
    if scope_ids is not None:
        q = q.filter(or_(Lead.created_by.in_(scope_ids), Lead.assigned_to.in_(scope_ids)))
    return q


def _apply_leads_filters(q, params: dict, db: Session):
    """Apply all filter params onto a Lead query."""
    if params.get("date_from"):
        q = q.filter(Lead.created_at >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(Lead.created_at <= params["date_to"] + " 23:59:59")
    if params.get("status"):
        vals = [s.strip() for s in params["status"].split(",") if s.strip()]
        q = q.filter(Lead.status.in_(vals))
    if params.get("priority"):
        vals = [s.strip() for s in params["priority"].split(",") if s.strip()]
        q = q.filter(Lead.priority.in_(vals))
    if params.get("lead_type"):
        q = q.filter(Lead.lead_type == params["lead_type"])
    if params.get("assigned_to"):
        vals = [int(x) for x in str(params["assigned_to"]).split(",") if x.strip()]
        q = q.filter(Lead.assigned_to.in_(vals))
    if params.get("created_by"):
        vals = [int(x) for x in str(params["created_by"]).split(",") if x.strip()]
        q = q.filter(Lead.created_by.in_(vals))
    if params.get("source_id"):
        vals = [int(x) for x in str(params["source_id"]).split(",") if x.strip()]
        q = q.filter(Lead.source_id.in_(vals))
    if params.get("customer_id"):
        vals = [int(x) for x in str(params["customer_id"]).split(",") if x.strip()]
        q = q.filter(Lead.customer_id.in_(vals))
    if params.get("est_value_min") is not None:
        q = q.filter(Lead.est_value >= params["est_value_min"])
    if params.get("est_value_max") is not None:
        q = q.filter(Lead.est_value <= params["est_value_max"])
    if params.get("follow_up_from"):
        q = q.filter(Lead.follow_up >= params["follow_up_from"])
    if params.get("follow_up_to"):
        q = q.filter(Lead.follow_up <= params["follow_up_to"])
    if params.get("product_name"):
        lp_sub = db.query(LeadProduct.lead_id).filter(
            LeadProduct.product_name.ilike(f"%{params['product_name']}%")
        ).subquery()
        q = q.filter(Lead.id.in_(lp_sub))
    if params.get("oem_name"):
        oem_sub = (
            db.query(LeadProduct.lead_id)
            .join(LeadProductOEM, LeadProductOEM.lead_product_id == LeadProduct.id)
            .filter(LeadProductOEM.oem_name.ilike(f"%{params['oem_name']}%"))
            .subquery()
        )
        q = q.filter(Lead.id.in_(oem_sub))
    if params.get("region"):
        q = q.filter(Lead.region.ilike(f"%{params['region']}%"))
    if params.get("approval_status"):
        vals = [s.strip() for s in str(params["approval_status"]).split(",") if s.strip()]
        q = q.filter(Lead.approval_status.in_(vals))
    if params.get("branch"):
        vals = [s.strip() for s in str(params["branch"]).split(",") if s.strip()]
        if vals:
            q = q.filter(Lead.branch.in_(vals))
    if params.get("business_vertical_id"):
        vals = [int(x) for x in str(params["business_vertical_id"]).split(",") if x.strip()]
        if vals:
            q = q.filter(Lead.business_vertical_id.in_(vals))
    if params.get("customer_segment"):
        seg_vals = _split_csv_strings(params["customer_segment"])
        if seg_vals:
            q = q.filter(Lead.customer_id.in_(_segment_customer_ids(db, seg_vals) or [-1]))
    if params.get("search"):
        q = q.filter(Lead.lead_title.ilike(f"%{params['search']}%"))
    if params.get("open_only"):
        q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
    if params.get("has_activity") not in (None, ""):
        act_sub = db.query(KAMActivity.lead_id).filter(
            KAMActivity.lead_id.isnot(None)
        ).distinct().subquery()
        if str(params["has_activity"]) == "1":
            q = q.filter(Lead.id.in_(act_sub))
        else:
            q = q.filter(Lead.id.notin_(act_sub))
    if params.get("has_quotation") not in (None, ""):
        qt_sub = db.query(Quotation.lead_id).filter(
            Quotation.lead_id.isnot(None)
        ).distinct().subquery()
        if str(params["has_quotation"]) == "1":
            q = q.filter(Lead.id.in_(qt_sub))
        else:
            q = q.filter(Lead.id.notin_(qt_sub))
    if params.get("quotation_status"):
        vals = [s.strip() for s in str(params["quotation_status"]).split(",") if s.strip()]
        qt_st_sub = db.query(Quotation.lead_id).filter(
            Quotation.lead_id.isnot(None),
            Quotation.status.in_(vals)
        ).distinct().subquery()
        q = q.filter(Lead.id.in_(qt_st_sub))
    if params.get("has_workorder") not in (None, ""):
        wo_sub = db.query(WorkOrder.lead_id).filter(
            WorkOrder.lead_id.isnot(None)
        ).distinct().subquery()
        if str(params["has_workorder"]) == "1":
            q = q.filter(Lead.id.in_(wo_sub))
        else:
            q = q.filter(Lead.id.notin_(wo_sub))
    if params.get("has_travel") not in (None, ""):
        tr_sub = db.query(KAMActivity.lead_id).filter(
            KAMActivity.lead_id.isnot(None),
            KAMActivity.has_travel == True
        ).distinct().subquery()
        if str(params["has_travel"]) == "1":
            q = q.filter(Lead.id.in_(tr_sub))
        else:
            q = q.filter(Lead.id.notin_(tr_sub))
    if params.get("inactive_days"):
        try:
            cutoff = today_ist() - timedelta(days=int(params["inactive_days"]))
            q = q.filter(Lead.updated_at < cutoff)
            q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
        except (TypeError, ValueError):
            pass
    if params.get("no_activity_days"):
        try:
            cutoff = today_ist() - timedelta(days=int(params["no_activity_days"]))
            recent_sub = db.query(KAMActivity.lead_id).filter(
                KAMActivity.lead_id.isnot(None),
                KAMActivity.created_at >= cutoff
            ).distinct().subquery()
            q = q.filter(Lead.id.notin_(recent_sub))
        except (TypeError, ValueError):
            pass
    if params.get("follow_up_overdue"):
        q = q.filter(Lead.follow_up.isnot(None))
        q = q.filter(Lead.follow_up < today_ist())
        q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
    if params.get("follow_up_due_days"):
        try:
            _today = today_ist()
            _due = _today + timedelta(days=int(params["follow_up_due_days"]))
            q = q.filter(Lead.follow_up.isnot(None))
            q = q.filter(Lead.follow_up >= _today)
            q = q.filter(Lead.follow_up <= _due)
        except (TypeError, ValueError):
            pass
    return q


def _fetch_leads_with_aggregates(db: Session, lead_ids: list[int]):
    """Batch-fetch products + OEMs for a page of leads — 2 DB queries, no N+1."""
    if not lead_ids:
        return {}, {}
    products_map: dict[int, list[str]] = defaultdict(list)
    oems_map: dict[int, list[str]] = defaultdict(list)
    prod_id_to_lead: dict[int, int] = {}

    for lp in db.query(LeadProduct).filter(LeadProduct.lead_id.in_(lead_ids)).all():
        products_map[lp.lead_id].append(lp.product_name or "")
        prod_id_to_lead[lp.id] = lp.lead_id

    if prod_id_to_lead:
        for oem in db.query(LeadProductOEM).filter(
            LeadProductOEM.lead_product_id.in_(prod_id_to_lead.keys())
        ).all():
            lid = prod_id_to_lead.get(oem.lead_product_id)
            if lid:
                oems_map[lid].append(oem.oem_name or "")

    return products_map, oems_map


@router.get("/leads/filter-options")
def leads_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Return dropdown options for leads filter panel."""
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    sources = db.query(LeadSource.id, LeadSource.name).order_by(LeadSource.name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    branches = db.query(Lead.branch).filter(Lead.branch.isnot(None), Lead.branch != "", Lead.is_deleted == False).distinct().all()
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        business_verticals = []
    try:
        vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(
            VerticalSector.display_order,
            VerticalSector.name,
            VerticalSector.id,
        ).all()
    except Exception:
        db.rollback()
        vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(VerticalSector.name).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "sources": [{"id": s.id, "name": s.name} for s in sources],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "statuses": ["Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing", "Opportunity Created", "Converted", "Lost"],
        "priorities": ["Low", "Medium", "High"],
        "lead_types": ["lead", "direct_opportunity"],
        "approval_statuses": ["Pending", "Approved", "Rejected"],
        "quotation_statuses": ["Draft", "Submitted", "Sent", "Accepted", "Won", "Rejected", "Lost"],
        "branches": sorted([b[0] for b in branches if b[0]]),
        "business_verticals": business_verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in vertical_sectors],
    }


@router.get("/leads")
def report_leads(
    # date range
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    # filters
    status: Optional[str] = None,
    priority: Optional[str] = None,
    lead_type: Optional[str] = None,
    assigned_to: Optional[str] = None,
    created_by: Optional[str] = None,
    source_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    product_name: Optional[str] = None,
    oem_name: Optional[str] = None,
    region: Optional[str] = None,
    est_value_min: Optional[float] = None,
    est_value_max: Optional[float] = None,
    follow_up_from: Optional[str] = None,
    follow_up_to: Optional[str] = None,
    approval_status: Optional[str] = None,
    open_only: Optional[str] = None,
    branch: Optional[str] = None,
    search: Optional[str] = None,
    has_activity: Optional[str] = None,
    has_quotation: Optional[str] = None,
    quotation_status: Optional[str] = None,
    has_workorder: Optional[str] = None,
    has_travel: Optional[str] = None,
    inactive_days: Optional[str] = None,
    no_activity_days: Optional[str] = None,
    follow_up_overdue: Optional[str] = None,
    follow_up_due_days: Optional[str] = None,
    business_vertical_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    # pagination
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "created_at",
    sort_dir: Optional[str] = "desc",
    # export
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, prev_from, prev_to = _resolve_date_preset(preset, date_from, date_to)
    if assigned_to == "__ME__":
        assigned_to = str(cu.id)

    filter_params = {
        "date_from": df_str, "date_to": dt_str,
        "status": status, "priority": priority, "lead_type": lead_type,
        "assigned_to": assigned_to, "created_by": created_by,
        "source_id": source_id, "customer_id": customer_id,
        "product_name": product_name, "oem_name": oem_name, "region": region,
        "est_value_min": est_value_min, "est_value_max": est_value_max,
        "follow_up_from": follow_up_from, "follow_up_to": follow_up_to,
        "approval_status": approval_status,
        "open_only": open_only,
        "branch": branch,
        "search": search,
        "has_activity": has_activity,
        "has_quotation": has_quotation,
        "quotation_status": quotation_status,
        "has_workorder": has_workorder,
        "has_travel": has_travel,
        "inactive_days": inactive_days,
        "no_activity_days": no_activity_days,
        "follow_up_overdue": follow_up_overdue,
        "follow_up_due_days": follow_up_due_days,
        "business_vertical_id": business_vertical_id,
        "customer_segment": customer_segment,
    }

    # ── main query ────────────────────────────────────────────────────────────
    AssignedUser = aliased(User)
    CreatedUser = aliased(User)

    q = _build_leads_scope(db, cu)
    q = _apply_leads_filters(q, filter_params, db)

    total_count = q.count()

    # sort
    sort_col = getattr(Lead, sort_by, None) if sort_by else None
    if sort_col is None:
        sort_col = Lead.created_at
    if sort_dir == "asc":
        q = q.order_by(sort_col.asc())
    else:
        q = q.order_by(sort_col.desc())

    if export:
        rows = q.all()
    else:
        rows = q.offset((page - 1) * per_page).limit(per_page).all()

    # batch-load products + OEMs (no N+1)
    lead_ids = [r.id for r in rows]
    products_map, oems_map = _fetch_leads_with_aggregates(db, lead_ids)

    # user name cache
    uid_set = set()
    for r in rows:
        if r.assigned_to: uid_set.add(r.assigned_to)
        if r.created_by: uid_set.add(r.created_by)
    user_name_cache: dict[int, str] = {}
    if uid_set:
        for u in db.query(User.id, User.full_name).filter(User.id.in_(uid_set)).all():
            user_name_cache[u.id] = u.full_name or ""

    # source name cache
    source_map: dict[int, str] = {}
    source_rows = db.query(LeadSource.id, LeadSource.name).all()
    for s in source_rows:
        source_map[s.id] = s.name or ""

    page_bv_ids = {int(r.business_vertical_id) for r in rows if getattr(r, "business_vertical_id", None)}
    bv_name_map = _resolve_business_vertical_names(db, page_bv_ids)
    bv_group_map = _resolve_business_vertical_parent_names(db, page_bv_ids)

    page_customer_ids = {r.customer_id for r in rows if r.customer_id}
    customer_segment_map: dict[int, str] = {}
    if page_customer_ids:
        for cid, segment in db.query(Customer.id, Customer.customer_vertical).filter(Customer.id.in_(page_customer_ids)).all():
            customer_segment_map[int(cid)] = _clean_segment_name(segment)

    data = []
    for r in rows:
        prods = list(dict.fromkeys(p for p in products_map.get(r.id, []) if p))
        oems  = list(dict.fromkeys(o for o in oems_map.get(r.id, []) if o))
        source_label = source_map.get(r.source_id, "") if r.source_id else ""
        data.append({
            "id": r.id,
            "lead_ref_id": r.lead_ref_id or "",
            "lead_title": r.lead_title,
            "customer_name": r.customer_name or "",
            "customer_id": r.customer_id,
            "customer_segment": customer_segment_map.get(int(r.customer_id or 0), ""),
            "status": r.status,
            "priority": r.priority or "",
            "lead_type": getattr(r, "lead_type", "") or "",
            "source": source_label,
            "source_id": r.source_id,
            "region": r.region or "",
            "branch": r.branch or "",
            "est_value": float(r.est_value or 0),
            "contact_person": r.contact_person or "",
            "designation": r.designation or "",
            "mobile": r.mobile or "",
            "email": r.email or "",
            "department": r.department or "",
            "timeline": r.timeline or "",
            "product_description": r.product_description or "",
            "products": ", ".join(prods),
            "oems": ", ".join(oems),
            "follow_up": str(r.follow_up) if r.follow_up else "",
            "assigned_to_id": r.assigned_to,
            "assigned_to": user_name_cache.get(r.assigned_to, ""),
            "created_by_id": r.created_by,
            "created_by": user_name_cache.get(r.created_by, ""),
            "approval_status": r.approval_status or "none",
            "rejection_reason": r.rejection_reason or "",
            "converted_at": str(r.converted_at)[:10] if r.converted_at else "",
            "lost_at": str(r.lost_at)[:10] if getattr(r, "lost_at", None) else "",
            "conversion_target": getattr(r, "conversion_target", "") or "",
            "notes": r.notes or "",
            "created_at": str(r.created_at)[:10] if r.created_at else "",
            "business_vertical": bv_name_map.get(int(r.business_vertical_id or 0), "") if r.business_vertical_id else "",
            "business_vertical_group": bv_group_map.get(int(r.business_vertical_id or 0), "") if r.business_vertical_id else "",
        })

    if export:
        return _export(data, "leads_report", export)

    # ── KPI summary (full filtered set, not just current page) ────────────────
    all_q = _build_leads_scope(db, cu)
    all_q = _apply_leads_filters(all_q, filter_params, db)
    all_rows = all_q.with_entities(
        Lead.status, Lead.priority, Lead.est_value, Lead.source_id,
        func.date(Lead.created_at).label("day")
    ).all()

    total = len(all_rows)
    total_value = sum(float(r.est_value or 0) for r in all_rows)
    converted = sum(1 for r in all_rows if r.status == "Converted")
    lost = sum(1 for r in all_rows if r.status == "Lost")

    # ── comparison period (same duration, prev window) ────────────────────────
    prev_params = dict(filter_params)
    prev_params["date_from"] = prev_from
    prev_params["date_to"] = prev_to
    prev_q = _build_leads_scope(db, cu)
    prev_q = _apply_leads_filters(prev_q, prev_params, db)
    prev_rows = prev_q.with_entities(Lead.status, Lead.est_value).all()
    prev_total = len(prev_rows)
    prev_value = sum(float(r.est_value or 0) for r in prev_rows)
    prev_converted = sum(1 for r in prev_rows if r.status == "Converted")

    def _pct_change(curr, prev):
        if prev == 0:
            return None
        return round((curr - prev) / prev * 100, 1)

    summary = {
        "total": total,
        "total_value": round(total_value, 2),
        "converted": converted,
        "lost": lost,
        "in_progress": sum(1 for r in all_rows if r.status not in ("Converted", "Lost")),
        "conversion_rate": round(converted / total * 100, 1) if total else 0.0,
        "avg_value": round(total_value / total, 2) if total else 0.0,
        # trends vs prev period
        "trend_total": _pct_change(total, prev_total),
        "trend_value": _pct_change(total_value, prev_value),
        "trend_converted": _pct_change(converted, prev_converted),
        "_date_from": df_str,
        "_date_to": dt_str,
        "_prev_from": prev_from,
        "_prev_to": prev_to,
    }

    # ── chart data ────────────────────────────────────────────────────────────
    status_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    priority_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    source_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    daily_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})

    for r in all_rows:
        st = r.status or "Unknown"
        status_counts[st]["count"] += 1
        status_counts[st]["value"] += float(r.est_value or 0)

        pr = r.priority or "Unknown"
        priority_counts[pr]["count"] += 1
        priority_counts[pr]["value"] += float(r.est_value or 0)

        src = source_map.get(r.source_id, "Direct") if r.source_id else "Direct"
        source_counts[src]["count"] += 1
        source_counts[src]["value"] += float(r.est_value or 0)

        day = str(r.day) if r.day else ""
        if day:
            daily_counts[day]["count"] += 1
            daily_counts[day]["value"] += float(r.est_value or 0)

    chart_status   = [{"label": k, **v} for k, v in status_counts.items()]
    chart_priority = [{"label": k, **v} for k, v in priority_counts.items()]
    chart_source   = sorted([{"label": k, **v} for k, v in source_counts.items()], key=lambda x: -x["count"])
    chart_daily    = sorted([{"label": k, **v} for k, v in daily_counts.items()], key=lambda x: x["label"])

    # funnel: Assigned → Qualified → Opportunity Created → Converted
    funnel_stages = ["Assigned", "Qualified", "Opportunity Created", "Converted"]
    funnel = [{"stage": s, "count": status_counts[s]["count"]} for s in funnel_stages]

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_data": chart_status,
        "chart_data2": chart_priority,
        "chart_source": chart_source,
        "chart_daily": chart_daily,
        "funnel": funnel,
    }


# ── Tenders helpers ───────────────────────────────────────────────────────────

def _build_tenders_scope(db: Session, cu: User):
    q = db.query(Tender).filter(Tender.is_deleted == False)
    scope_ids = _report_scope_user_ids(db, cu)
    if scope_ids is not None:
        q = q.filter(or_(Tender.created_by.in_(scope_ids), Tender.assigned_to.in_(scope_ids)))
    return q


def _apply_tenders_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(Tender.created_at >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(Tender.created_at <= params["date_to"] + " 23:59:59")
    if params.get("submission_from"):
        q = q.filter(Tender.submission_date >= params["submission_from"])
    if params.get("submission_to"):
        q = q.filter(Tender.submission_date <= params["submission_to"])
    if params.get("status"):
        vals = [s.strip() for s in params["status"].split(",") if s.strip()]
        q = q.filter(Tender.tender_status.in_(vals))
    if params.get("result"):
        vals = [s.strip() for s in params["result"].split(",") if s.strip()]
        q = q.filter(Tender.result.in_(vals))
    if params.get("source_portal"):
        vals = [s.strip() for s in params["source_portal"].split(",") if s.strip()]
        # Resolve source names → source_id (tenders store source_id FK to LeadSource)
        src_ids = [ls.id for ls in db.query(LeadSource.id).filter(LeadSource.name.in_(vals)).all()]
        if src_ids:
            q = q.filter(Tender.source_id.in_(src_ids))
        else:
            q = q.filter(Tender.source_portal.in_(vals))
    if params.get("tech_bid_eligible"):
        q = q.filter(Tender.tech_bid_eligible == params["tech_bid_eligible"])
    if params.get("assigned_to"):
        vals = [int(x) for x in str(params["assigned_to"]).split(",") if x.strip()]
        q = q.filter(Tender.assigned_to.in_(vals))
    if params.get("customer_id"):
        vals = [int(x) for x in str(params["customer_id"]).split(",") if x.strip()]
        q = q.filter(Tender.customer_id.in_(vals))
    if params.get("customer_segment"):
        vals = [s.strip() for s in str(params["customer_segment"]).split(",") if s.strip()]
        if vals:
            q = q.filter(Tender.customer_id.in_(_segment_customer_ids(db, vals) or [-1]))
    if params.get("bid_min") is not None:
        q = q.filter(Tender.bid_amount >= params["bid_min"])
    if params.get("bid_max") is not None:
        q = q.filter(Tender.bid_amount <= params["bid_max"])
    if params.get("emd_required"):
        q = q.filter(Tender.emd_required == (params["emd_required"] == "true"))
    if params.get("reverse_auction"):
        q = q.filter(Tender.reverse_auction == (params["reverse_auction"] == "true"))
    if params.get("product_name"):
        tp_sub = db.query(TenderProduct.tender_id).filter(
            TenderProduct.product_name.ilike(f"%{params['product_name']}%")
        ).subquery()
        q = q.filter(Tender.id.in_(tp_sub))
    if params.get("oem_name"):
        oem_sub = (
            db.query(TenderProduct.tender_id)
            .join(TenderProductOEM, TenderProductOEM.tender_product_id == TenderProduct.id)
            .filter(TenderProductOEM.oem_name.ilike(f"%{params['oem_name']}%"))
            .subquery()
        )
        q = q.filter(Tender.id.in_(oem_sub))
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            Tender.tender_title.ilike(term),
            Tender.tender_num.ilike(term),
            Tender.portal_ref_number.ilike(term),
            Tender.customer_name.ilike(term),
        ))
    if params.get("active_only"):
        q = q.filter(Tender.result == "Pending")
    if params.get("submission_overdue"):
        q = q.filter(Tender.submission_date.isnot(None))
        q = q.filter(Tender.submission_date < today_ist())
        q = q.filter(Tender.result == "Pending")
    if params.get("submission_due_days"):
        try:
            _today = today_ist()
            _due = _today + timedelta(days=int(params["submission_due_days"]))
            q = q.filter(Tender.submission_date.isnot(None))
            q = q.filter(Tender.submission_date >= _today)
            q = q.filter(Tender.submission_date <= _due)
        except (TypeError, ValueError):
            pass
    if params.get("pre_bid_upcoming"):
        q = q.filter(Tender.pre_bid_date.isnot(None))
        q = q.filter(Tender.pre_bid_date > today_ist())
    if params.get("pre_bid_completed"):
        q = q.filter(Tender.pre_bid_date.isnot(None))
        q = q.filter(Tender.pre_bid_date <= today_ist())
    if params.get("has_quotation") not in (None, ""):
        qt_sub = db.query(Quotation.tender_id).filter(Quotation.tender_id.isnot(None)).distinct().subquery()
        if str(params["has_quotation"]) == "1":
            q = q.filter(Tender.id.in_(qt_sub))
        else:
            q = q.filter(Tender.id.notin_(qt_sub))
    if params.get("has_workorder") not in (None, ""):
        if str(params["has_workorder"]) == "1":
            q = q.filter(Tender.wrk_order_id.isnot(None))
        else:
            q = q.filter(Tender.wrk_order_id.is_(None))
    if params.get("emd_pending"):
        q = q.filter(Tender.emd_required == True)
        q = q.filter(Tender.emd_emdbg_id.is_(None))
    if params.get("emd_submitted"):
        q = q.filter(Tender.emd_emdbg_id.isnot(None))
    if params.get("emd_return_pending"):
        q = q.filter(Tender.emd_emdbg_id.isnot(None))
        q = q.filter(Tender.result.in_(["Won", "Lost", "Cancelled"]))
    if params.get("approval_status"):
        val = str(params["approval_status"]).lower()
        if val == "pending":
            q = q.filter(Tender.workflow_status.in_(["step2_pending", "step3_pending"]))
        elif val == "approved":
            q = q.filter(Tender.workflow_status.in_(["active", "step3_active"]))
        elif val == "rejected":
            q = q.filter(Tender.workflow_status == "rejected")
    if params.get("has_activity") not in (None, ""):
        act_sub = db.query(TravelRequest.tender_id).filter(TravelRequest.tender_id.isnot(None)).distinct().subquery()
        if str(params["has_activity"]) == "1":
            q = q.filter(Tender.id.in_(act_sub))
        else:
            q = q.filter(Tender.id.notin_(act_sub))
    if params.get("no_activity_days"):
        try:
            cutoff = today_ist() - timedelta(days=int(params["no_activity_days"]))
            recent_sub = db.query(TravelRequest.tender_id).filter(
                TravelRequest.tender_id.isnot(None),
                TravelRequest.created_at >= cutoff,
            ).distinct().subquery()
            q = q.filter(Tender.id.notin_(recent_sub))
        except (TypeError, ValueError):
            pass
    if params.get("gem_only"):
        q = q.filter(Tender.source_portal == "GeM")
    if params.get("result_pending"):
        q = q.filter(Tender.tender_status == "Submitted")
        q = q.filter(Tender.result == "Pending")
    if params.get("business_vertical_id"):
        vals = [int(x) for x in str(params["business_vertical_id"]).split(",") if x.strip()]
        if vals:
            bv_lead_sub = db.query(Lead.id).filter(Lead.business_vertical_id.in_(vals)).subquery()
            q = q.filter(or_(Tender.business_vertical_id.in_(vals), Tender.lead_id.in_(bv_lead_sub)))
    return q


def _resolve_business_vertical_names(db: Session, vertical_ids: set[int]) -> dict[int, str]:
    ids = sorted({int(v) for v in vertical_ids if v})
    if not ids:
        return {}

    names: dict[int, str] = {}
    id_csv = ", ".join(str(i) for i in ids)
    try:
        rows = db.execute(text(
            "SELECT id, COALESCE(business_unit, business_vertical) AS vname "
            f"FROM business_category_units WHERE id IN ({id_csv})"
        )).mappings().all()
        for row in rows:
            label = (row.get("vname") or "").strip()
            if label:
                names[int(row["id"])] = label
    except Exception:
        pass

    missing = [i for i in ids if i not in names]
    if missing:
        try:
            for sector in db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.id.in_(missing)).all():
                if sector.name:
                    names[int(sector.id)] = sector.name
        except Exception:
            pass

    return names


def _resolve_business_vertical_parent_names(db: Session, vertical_ids: set[int]) -> dict[int, str]:
    ids = sorted({int(v) for v in vertical_ids if v})
    if not ids:
        return {}

    names: dict[int, str] = {}
    id_csv = ", ".join(str(i) for i in ids)
    try:
        rows = db.execute(text(
            "SELECT u.id, COALESCE(c.business_vertical, c.business_unit, u.business_vertical, u.business_unit) AS vname "
            "FROM business_category_units u "
            "LEFT JOIN business_category_units c ON c.id = u.parent_category_id "
            f"WHERE u.id IN ({id_csv})"
        )).mappings().all()
        for row in rows:
            label = (row.get("vname") or "").strip()
            if label:
                names[int(row["id"])] = label
    except Exception:
        pass

    missing = [i for i in ids if i not in names]
    if missing:
        names.update(_resolve_business_vertical_names(db, set(missing)))

    return names


def _fetch_tenders_products(db: Session, tender_ids: list[int]):
    """Batch-load TenderProduct + TenderProductOEM — 2 queries, no N+1."""
    if not tender_ids:
        return {}, {}, {}
    boq_map: dict[int, list[str]] = defaultdict(list)
    final_map: dict[int, list[str]] = defaultdict(list)
    oems_map: dict[int, list[str]] = defaultdict(list)
    prod_id_to_tender: dict[int, int] = {}

    for tp in db.query(TenderProduct).filter(TenderProduct.tender_id.in_(tender_ids)).all():
        prod_id_to_tender[tp.id] = tp.tender_id
        if tp.is_final_boq:
            if tp.product_name:
                final_map[tp.tender_id].append(tp.product_name)
            if getattr(tp, "oem_name", None):
                oems_map[tp.tender_id].append(tp.oem_name)
        else:
            if tp.product_name:
                boq_map[tp.tender_id].append(tp.product_name)

    if prod_id_to_tender:
        for oem in db.query(TenderProductOEM).filter(
            TenderProductOEM.tender_product_id.in_(prod_id_to_tender.keys())
        ).all():
            tid = prod_id_to_tender.get(oem.tender_product_id)
            if tid and oem.oem_name:
                oems_map[tid].append(oem.oem_name)

    return boq_map, final_map, oems_map


def _fetch_primary_customer_contacts(db: Session, customer_ids: list[int]) -> dict[int, CustomerContact]:
    unique_customer_ids = sorted({int(customer_id) for customer_id in customer_ids if customer_id})
    if not unique_customer_ids:
        return {}

    contacts = (
        db.query(CustomerContact)
        .filter(
            CustomerContact.customer_id.in_(unique_customer_ids),
            CustomerContact.is_active == True,
        )
        .order_by(
            CustomerContact.customer_id,
            CustomerContact.is_primary.desc(),
            CustomerContact.id.asc(),
        )
        .all()
    )

    by_customer_id: dict[int, CustomerContact] = {}
    for contact in contacts:
        by_customer_id.setdefault(contact.customer_id, contact)
    return by_customer_id


@router.get("/tenders/filter-options")
def tenders_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        tn_business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        tn_business_verticals = []
    segments = [
        row[0] for row in db.query(Customer.customer_vertical)
        .filter(
            Customer.is_deleted == False,
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
        )
        .distinct().order_by(Customer.customer_vertical).all()
    ]
    try:
        vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(VerticalSector.name).all()
    except Exception:
        vertical_sectors = []
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "statuses": ["Aligned", "Evaluation", "Pre-Bid", "Reverse Auction", "Submitted", "Closed"],
        "results": ["Pending", "Won", "Lost", "Cancelled"],
        "portals": [ls.name for ls in db.query(LeadSource.name).filter(LeadSource.is_active == True).order_by(LeadSource.name).all() if ls.name],
        "tech_bid_options": ["Eligible", "Not Eligible", "Not Evaluated"],
        "approval_statuses": ["Pending", "Approved", "Rejected"],
        "business_verticals": tn_business_verticals,
        "segments": _unique_strings(segments),
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in vertical_sectors],
    }


@router.get("/tenders")
def report_tenders(
    # date range
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    # submission date range (separate from created date)
    submission_from: Optional[str] = None,
    submission_to: Optional[str] = None,
    # filters
    status: Optional[str] = None,
    result: Optional[str] = None,
    source_portal: Optional[str] = None,
    tech_bid_eligible: Optional[str] = None,
    assigned_to: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    product_name: Optional[str] = None,
    oem_name: Optional[str] = None,
    bid_min: Optional[float] = None,
    bid_max: Optional[float] = None,
    emd_required: Optional[str] = None,
    reverse_auction: Optional[str] = None,
    # new filters
    search: Optional[str] = None,
    active_only: Optional[str] = None,
    submission_overdue: Optional[str] = None,
    submission_due_days: Optional[str] = None,
    pre_bid_upcoming: Optional[str] = None,
    pre_bid_completed: Optional[str] = None,
    has_quotation: Optional[str] = None,
    has_workorder: Optional[str] = None,
    emd_pending: Optional[str] = None,
    emd_submitted: Optional[str] = None,
    emd_return_pending: Optional[str] = None,
    approval_status: Optional[str] = None,
    has_activity: Optional[str] = None,
    no_activity_days: Optional[str] = None,
    gem_only: Optional[str] = None,
    result_pending: Optional[str] = None,
    business_vertical_id: Optional[str] = None,
    # pagination
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "created_at",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, prev_from, prev_to = _resolve_date_preset(preset, date_from, date_to)
    if assigned_to == "__ME__":
        assigned_to = str(cu.id)

    filter_params = {
        "date_from": df_str, "date_to": dt_str,
        "submission_from": submission_from, "submission_to": submission_to,
        "status": status, "result": result, "source_portal": source_portal,
        "tech_bid_eligible": tech_bid_eligible,
        "assigned_to": assigned_to, "customer_id": customer_id,
        "customer_segment": customer_segment,
        "product_name": product_name, "oem_name": oem_name,
        "bid_min": bid_min, "bid_max": bid_max,
        "emd_required": emd_required, "reverse_auction": reverse_auction,
        "search": search,
        "active_only": active_only,
        "submission_overdue": submission_overdue,
        "submission_due_days": submission_due_days,
        "pre_bid_upcoming": pre_bid_upcoming,
        "pre_bid_completed": pre_bid_completed,
        "has_quotation": has_quotation,
        "has_workorder": has_workorder,
        "emd_pending": emd_pending,
        "emd_submitted": emd_submitted,
        "emd_return_pending": emd_return_pending,
        "approval_status": approval_status,
        "has_activity": has_activity,
        "no_activity_days": no_activity_days,
        "gem_only": gem_only,
        "result_pending": result_pending,
        "business_vertical_id": business_vertical_id,
    }

    # ── scoped query ──────────────────────────────────────────────────────────
    q = _build_tenders_scope(db, cu)
    q = _apply_tenders_filters(q, filter_params, db)
    total_count = q.count()

    sort_col = getattr(Tender, sort_by, None) if sort_by else None
    if sort_col is None:
        sort_col = Tender.created_at
    q = q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    rows = q.all() if export else q.offset((page - 1) * per_page).limit(per_page).all()

    # batch-load products + OEMs (no N+1)
    tender_ids = [r.id for r in rows]
    boq_map, final_map, oems_map = _fetch_tenders_products(db, tender_ids)

    # user name cache (single query)
    uid_set = {r.assigned_to for r in rows if r.assigned_to} | {r.created_by for r in rows if r.created_by}
    user_cache: dict[int, str] = {}
    if uid_set:
        for u in db.query(User.id, User.full_name).filter(User.id.in_(uid_set)).all():
            user_cache[u.id] = u.full_name or ""

    # source_id → name map for paginated rows (tenders store source_id, not source_portal)
    page_source_ids = {int(r.source_id) for r in rows if getattr(r, "source_id", None)}
    page_source_map: dict[int, str] = {}
    if page_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(page_source_ids)).all():
            page_source_map[int(ls.id)] = ls.name

    # PO value comes from the resulting Work Order, not the tender itself — sum in case of split orders
    po_value_map: dict[int, float] = {}
    if tender_ids:
        for tid, po_total in (
            db.query(WorkOrder.tender_id, func.sum(WorkOrder.po_value))
            .filter(WorkOrder.tender_id.in_(tender_ids))
            .group_by(WorkOrder.tender_id)
            .all()
        ):
            if tid:
                po_value_map[int(tid)] = float(po_total or 0)

    page_customer_ids = {r.customer_id for r in rows if r.customer_id}
    customer_segment_map: dict[int, str] = {}
    if page_customer_ids:
        for cid, segment in db.query(Customer.id, Customer.customer_vertical).filter(Customer.id.in_(page_customer_ids)).all():
            customer_segment_map[int(cid)] = _clean_segment_name(segment)

    page_lead_ids = {r.lead_id for r in rows if r.lead_id}
    page_lead_bv_map: dict[int, int] = {}
    if page_lead_ids:
        for lid, bv_id in db.query(Lead.id, Lead.business_vertical_id).filter(Lead.id.in_(page_lead_ids)).all():
            if bv_id:
                page_lead_bv_map[int(lid)] = int(bv_id)
    page_bv_ids = {
        int(getattr(r, "business_vertical_id", 0) or page_lead_bv_map.get(int(r.lead_id or 0), 0))
        for r in rows
        if getattr(r, "business_vertical_id", None) or page_lead_bv_map.get(int(r.lead_id or 0), 0)
    }
    business_vertical_map = _resolve_business_vertical_names(db, page_bv_ids)
    business_vertical_parent_map = _resolve_business_vertical_parent_names(db, page_bv_ids)

    page_bidder_count_map: dict[int, int] = {}
    if tender_ids:
        for tid, cnt in (
            db.query(TenderTechBidBidder.tender_id, func.count(TenderTechBidBidder.id))
            .filter(TenderTechBidBidder.tender_id.in_(tender_ids))
            .group_by(TenderTechBidBidder.tender_id)
            .all()
        ):
            if tid:
                page_bidder_count_map[int(tid)] = int(cnt or 0)

    data = []
    today_d = today_ist()
    for r in rows:
        bv_id = getattr(r, "business_vertical_id", None) or page_lead_bv_map.get(int(r.lead_id or 0))
        boq_prods = list(dict.fromkeys(p for p in boq_map.get(r.id, []) if p))
        final_prods = list(dict.fromkeys(p for p in final_map.get(r.id, []) if p))
        oems = list(dict.fromkeys(o for o in oems_map.get(r.id, []) if o))
        # days to submission
        days_to_sub = None
        if r.submission_date and r.result == "Pending":
            days_to_sub = (r.submission_date - today_d).days
        data.append({
            "id": r.id,
            "tender_num": r.tender_num or "",
            "tender_title": r.tender_title or "",
            "customer_name": r.customer_name or "",
            "customer_id": r.customer_id,
            "customer_segment": customer_segment_map.get(int(r.customer_id or 0), ""),
            "business_vertical_id": bv_id,
            "business_vertical": business_vertical_map.get(int(bv_id or 0), ""),
            "business_vertical_group": business_vertical_parent_map.get(int(bv_id or 0), ""),
            "source_portal": page_source_map.get(int(r.source_id or 0), None) or str(r.source_portal or ""),
            "portal_ref_number": r.portal_ref_number or "",
            "tender_status": r.tender_status,
            "result": r.result or "Pending",
            "current_step": r.current_step or 1,
            "workflow_status": r.workflow_status or "",
            "published_date": str(r.published_date) if r.published_date else "",
            "pre_bid_date": str(r.pre_bid_date) if r.pre_bid_date else "",
            "submission_date": str(r.submission_date) if r.submission_date else "",
            "result_date": str(r.result_date) if r.result_date else "",
            "days_to_submission": days_to_sub,
            "est_value": float(r.est_value or 0),
            "bid_amount": float(r.bid_amount or 0),
            "po_value": po_value_map.get(r.id, 0.0),
            "reverse_auction_final": float(r.reverse_auction_final_bid or 0),
            "emd_required": "Yes" if r.emd_required else "No",
            "emd_amount": float(r.emd_amount or 0),
            "emd_method": r.emd_payment_method or "",
            "emd_reference": r.emd_reference or "",
            "pbg_required": "Yes" if r.pbg_required else "No",
            "pbg_amount": float(r.pbg_amount or 0),
            "tender_fee_required": "Yes" if r.tender_fee_required else "No",
            "tender_fee_amount": float(r.tender_fee_amount or 0),
            "tech_bid_eligible": str(r.tech_bid_eligible or ""),
            "reverse_auction": "Yes" if r.reverse_auction else "No",
            "split_order": "Yes" if r.split_order else "No",
            "bidder_count": page_bidder_count_map.get(int(r.id), 0),
            "products_boq": ", ".join(boq_prods),
            "oems_boq": ", ".join(oems),
            "products_final": ", ".join(final_prods),
            "assigned_to_id": r.assigned_to,
            "assigned_to": user_cache.get(r.assigned_to, ""),
            "created_by": user_cache.get(r.created_by, ""),
            "notes": r.notes or "",
            "created_at": str(r.created_at)[:10] if r.created_at else "",
        })

    if export:
        return _export(data, "tenders_report", export)

    # ── KPI analytics (full filtered set) ────────────────────────────────────
    all_q = _build_tenders_scope(db, cu)
    all_q = _apply_tenders_filters(all_q, filter_params, db)
    all_rows = all_q.with_entities(
        Tender.id, Tender.tender_num, Tender.tender_title, Tender.customer_name,
        Tender.customer_id, Tender.lead_id,
        Tender.business_vertical_id, Tender.assigned_to, Tender.current_step,
        Tender.result, Tender.tender_status, Tender.source_portal, Tender.source_id,
        Tender.bid_amount, Tender.est_value, Tender.emd_amount,
        Tender.emd_required, Tender.tech_bid_eligible,
        func.date(Tender.created_at).label("day"),
        Tender.created_at, Tender.published_date, Tender.submission_date,
        Tender.result_date,
    ).all()

    total = len(all_rows)
    won   = sum(1 for r in all_rows if r.result == "Won")
    lost  = sum(1 for r in all_rows if r.result == "Lost")
    pend  = sum(1 for r in all_rows if r.result == "Pending")
    total_bid   = sum(float(r.bid_amount or 0) for r in all_rows)
    total_est   = sum(float(r.est_value  or 0) for r in all_rows)
    # EMD at risk = EMD on pending/open tenders only
    emd_at_risk = sum(
        float(r.emd_amount or 0)
        for r in all_rows
        if r.emd_required and r.result == "Pending"
    )

    # ── comparison period ─────────────────────────────────────────────────────
    prev_params = dict(filter_params, date_from=prev_from, date_to=prev_to)
    prev_q  = _build_tenders_scope(db, cu)
    prev_q  = _apply_tenders_filters(prev_q, prev_params, db)
    prev_rows = prev_q.with_entities(Tender.result, Tender.bid_amount).all()
    p_total = len(prev_rows)
    p_won   = sum(1 for r in prev_rows if r.result == "Won")
    p_bid   = sum(float(r.bid_amount or 0) for r in prev_rows)

    def _pct(curr, prev):
        return None if prev == 0 else round((curr - prev) / prev * 100, 1)

    summary = {
        "total": total, "won": won, "lost": lost, "pending": pend,
        "win_rate": round(won / total * 100, 1) if total else 0.0,
        "total_bid_value": round(total_bid, 2),
        "total_est_value": round(total_est, 2),
        "avg_bid": round(total_bid / total, 2) if total else 0.0,
        "emd_at_risk": round(emd_at_risk, 2),
        "bid_to_est_ratio": round(total_bid / total_est * 100, 1) if total_est else None,
        # trends
        "trend_total": _pct(total, p_total),
        "trend_won": _pct(won, p_won),
        "trend_bid": _pct(total_bid, p_bid),
        "_date_from": df_str, "_date_to": dt_str,
        "_prev_from": prev_from, "_prev_to": prev_to,
    }

    # ── source_id → name map (tenders store source_id; source_portal defaults to "Other") ──
    all_source_ids = {int(r.source_id) for r in all_rows if getattr(r, "source_id", None)}
    all_tender_source_map: dict[int, str] = {}
    if all_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(all_source_ids)).all():
            all_tender_source_map[int(ls.id)] = ls.name

    # ── charts ────────────────────────────────────────────────────────────────
    result_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    portal_stats:  dict = defaultdict(lambda: {"count": 0, "won": 0, "value": 0.0})
    status_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    daily_counts:  dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    # tech bid win rates
    tech_stats: dict = defaultdict(lambda: {"total": 0, "won": 0})

    for r in all_rows:
        res = r.result or "Pending"
        result_counts[res]["count"] += 1
        result_counts[res]["value"] += float(r.bid_amount or 0)

        portal = (
            all_tender_source_map.get(int(getattr(r, "source_id", None) or 0), None)
            or str(r.source_portal or "Other")
        )
        portal_stats[portal]["count"] += 1
        portal_stats[portal]["value"] += float(r.bid_amount or 0)
        if res == "Won":
            portal_stats[portal]["won"] += 1

        st = r.tender_status or "Unknown"
        status_counts[st]["count"] += 1
        status_counts[st]["value"] += float(r.bid_amount or 0)

        day = str(r.day) if r.day else ""
        if day:
            daily_counts[day]["count"] += 1
            daily_counts[day]["value"] += float(r.bid_amount or 0)

        tbe = str(r.tech_bid_eligible or "Not Evaluated")
        tech_stats[tbe]["total"] += 1
        if res == "Won":
            tech_stats[tbe]["won"] += 1

    chart_result  = [{"label": k, **v} for k, v in result_counts.items()]
    chart_portal  = sorted([
        {"label": k, "count": v["count"], "value": v["value"],
         "won": v["won"], "win_rate": round(v["won"] / v["count"] * 100, 1) if v["count"] else 0}
        for k, v in portal_stats.items()
    ], key=lambda x: -x["count"])
    chart_status  = [{"label": k, **v} for k, v in status_counts.items()]
    chart_daily   = sorted([{"label": k, **v} for k, v in daily_counts.items()], key=lambda x: x["label"])
    chart_tech    = [
        {"label": k, "total": v["total"], "won": v["won"],
         "win_rate": round(v["won"] / v["total"] * 100, 1) if v["total"] else 0}
        for k, v in tech_stats.items()
    ]

    # ── decision analytics for the Tender Report experience ──────────────────
    all_tender_ids = [int(r.id) for r in all_rows if getattr(r, "id", None)]
    all_customer_ids = {int(r.customer_id) for r in all_rows if getattr(r, "customer_id", None)}
    all_lead_ids = {int(r.lead_id) for r in all_rows if getattr(r, "lead_id", None)}
    all_assigned_ids = {int(r.assigned_to) for r in all_rows if getattr(r, "assigned_to", None)}

    all_customer_segment_map: dict[int, str] = {}
    if all_customer_ids:
        for cid, segment in db.query(Customer.id, Customer.customer_vertical).filter(Customer.id.in_(all_customer_ids)).all():
            all_customer_segment_map[int(cid)] = _clean_segment_name(segment)

    all_lead_bv_map: dict[int, int] = {}
    if all_lead_ids:
        for lid, bv_id in db.query(Lead.id, Lead.business_vertical_id).filter(Lead.id.in_(all_lead_ids)).all():
            if bv_id:
                all_lead_bv_map[int(lid)] = int(bv_id)

    all_bv_ids = {
        int(getattr(r, "business_vertical_id", 0) or all_lead_bv_map.get(int(getattr(r, "lead_id", 0) or 0), 0))
        for r in all_rows
        if getattr(r, "business_vertical_id", None) or all_lead_bv_map.get(int(getattr(r, "lead_id", 0) or 0), 0)
    }
    all_business_vertical_map = _resolve_business_vertical_names(db, all_bv_ids)
    all_business_vertical_parent_map = _resolve_business_vertical_parent_names(db, all_bv_ids)

    all_user_map: dict[int, str] = {}
    if all_assigned_ids:
        for uid, full_name, username in db.query(User.id, User.full_name, User.username).filter(User.id.in_(all_assigned_ids)).all():
            all_user_map[int(uid)] = full_name or username or f"User {uid}"

    all_po_value_map: dict[int, float] = {}
    if all_tender_ids:
        for tid, po_total in (
            db.query(WorkOrder.tender_id, func.sum(WorkOrder.po_value))
            .filter(WorkOrder.tender_id.in_(all_tender_ids))
            .group_by(WorkOrder.tender_id)
            .all()
        ):
            if tid:
                all_po_value_map[int(tid)] = float(po_total or 0)

    all_bidder_count_map: dict[int, int] = {}
    if all_tender_ids:
        for tid, cnt in (
            db.query(TenderTechBidBidder.tender_id, func.count(TenderTechBidBidder.id))
            .filter(TenderTechBidBidder.tender_id.in_(all_tender_ids))
            .group_by(TenderTechBidBidder.tender_id)
            .all()
        ):
            if tid:
                all_bidder_count_map[int(tid)] = int(cnt or 0)

    def _rate(numerator: float, denominator: float) -> float:
        return round((numerator / denominator) * 100, 1) if denominator else 0.0

    def _won_value(item: dict) -> float:
        if item["result"] != "Won":
            return 0.0
        return item["po_value"] or item["bid_amount"]

    analytics_items: list[dict] = []
    for r in all_rows:
        bv_id = getattr(r, "business_vertical_id", None) or all_lead_bv_map.get(int(getattr(r, "lead_id", 0) or 0))
        created_dt = _to_date(getattr(r, "created_at", None)) or _to_date(getattr(r, "day", None))
        published_dt = _to_date(getattr(r, "published_date", None))
        submission_dt = _to_date(getattr(r, "submission_date", None))
        result_dt = _to_date(getattr(r, "result_date", None))
        po_value = all_po_value_map.get(int(r.id), 0.0)
        bid_value = float(r.bid_amount or 0)
        result_value = r.result or "Pending"
        status_value = r.tender_status or "Unknown"
        days_to_submission = (submission_dt - today_d).days if submission_dt else None
        analytics_items.append({
            "id": int(r.id),
            "title": r.tender_title or "",
            "result": result_value,
            "status": status_value,
            "portal": all_tender_source_map.get(int(getattr(r, "source_id", None) or 0), None) or str(r.source_portal or "Other"),
            "business_unit": all_business_vertical_map.get(int(bv_id or 0), "Unclassified"),
            "business_vertical": all_business_vertical_parent_map.get(int(bv_id or 0), "Unclassified"),
            "customer_segment": all_customer_segment_map.get(int(r.customer_id or 0), "Unclassified") or "Unclassified",
            "assigned_to": all_user_map.get(int(r.assigned_to or 0), "Unassigned"),
            "est_value": float(r.est_value or 0),
            "bid_amount": bid_value,
            "po_value": po_value,
            "awarded_value": po_value or (bid_value if result_value == "Won" else 0.0),
            "bidder_count": all_bidder_count_map.get(int(r.id), 0),
            "current_step": int(r.current_step or 1),
            "created_date": created_dt,
            "published_date": published_dt,
            "submission_date": submission_dt,
            "result_date": result_dt,
            "created_month": created_dt.strftime("%Y-%m") if created_dt else "",
            "days_to_submission": days_to_submission,
            "is_open": result_value == "Pending" and status_value != "Closed",
            "is_overdue": days_to_submission is not None and days_to_submission < 0 and result_value == "Pending",
        })

    def _rollup(items: list[dict], key: str, label_key: str = "name") -> list[dict]:
        grouped: dict[str, dict] = defaultdict(lambda: {
            label_key: "",
            "tenders": 0, "won": 0, "lost": 0, "cancelled": 0, "pending": 0,
            "submitted": 0, "open": 0,
            "est_value": 0.0, "bid_value": 0.0, "awarded_value": 0.0,
            "overdue": 0, "urgent": 0, "competitors": 0, "competitor_samples": 0,
        })
        for item in items:
            name = item.get(key) or "Unclassified"
            row = grouped[name]
            row[label_key] = name
            row["tenders"] += 1
            row["won"] += 1 if item["result"] == "Won" else 0
            row["lost"] += 1 if item["result"] == "Lost" else 0
            row["cancelled"] += 1 if item["result"] == "Cancelled" else 0
            row["pending"] += 1 if item["result"] == "Pending" else 0
            row["submitted"] += 1 if item["status"] == "Submitted" else 0
            row["open"] += 1 if item["is_open"] else 0
            row["est_value"] += item["est_value"]
            row["bid_value"] += item["bid_amount"]
            row["awarded_value"] += _won_value(item)
            row["overdue"] += 1 if item["is_overdue"] else 0
            row["urgent"] += 1 if item["days_to_submission"] is not None and 0 <= item["days_to_submission"] <= 7 and item["is_open"] else 0
            if item["bidder_count"] > 0:
                row["competitors"] += item["bidder_count"]
                row["competitor_samples"] += 1
        out = []
        for row in grouped.values():
            decided = row["won"] + row["lost"] + row["cancelled"]
            row["win_rate"] = _rate(row["won"], decided)
            row["success_rate"] = row["win_rate"]
            row["award_gap_pct"] = round(((row["awarded_value"] - row["est_value"]) / row["est_value"]) * 100, 1) if row["est_value"] else 0.0
            row["avg_competitors"] = round(row["competitors"] / row["competitor_samples"], 1) if row["competitor_samples"] else 0.0
            out.append(row)
        return out

    business_unit_rollup = sorted(_rollup(analytics_items, "business_unit"), key=lambda x: x["est_value"], reverse=True)
    business_vertical_rollup = sorted(_rollup(analytics_items, "business_vertical"), key=lambda x: x["est_value"], reverse=True)
    customer_segment_rollup = sorted(_rollup(analytics_items, "customer_segment"), key=lambda x: x["est_value"], reverse=True)
    portal_roi = sorted(_rollup(analytics_items, "portal", "portal"), key=lambda x: x["est_value"], reverse=True)
    kam_performance = sorted(_rollup(analytics_items, "assigned_to", "kam"), key=lambda x: (x["won"], x["awarded_value"]), reverse=True)

    month_rollup = sorted(_rollup(analytics_items, "created_month", "month"), key=lambda x: x["month"])[-12:]
    distribution_months = sorted({i["created_month"] for i in analytics_items if i.get("created_month")})[-6:]

    def _distribution_trend(items: list[dict], key: str, rollup: list[dict], label_key: str = "name") -> list[dict]:
        names = [row.get(label_key) for row in rollup[:6] if row.get(label_key)]
        out: list[dict] = []
        for name in names:
            out.append({
                "name": name,
                "trend": [
                    round(
                        sum(i["est_value"] for i in items if i.get(key) == name and i.get("created_month") == month) / 1e7,
                        1,
                    )
                    for month in distribution_months
                ],
            })
        return out

    distribution_trends = {
        "months": distribution_months,
        "business_units": _distribution_trend(analytics_items, "business_unit", business_unit_rollup),
        "business_verticals": _distribution_trend(analytics_items, "business_vertical", business_vertical_rollup),
        "sources": _distribution_trend(analytics_items, "portal", portal_roi, "portal"),
        "customer_segments": _distribution_trend(analytics_items, "customer_segment", customer_segment_rollup),
    }

    competitor_samples = [i["bidder_count"] for i in analytics_items if i["bidder_count"] > 0]
    competitor_bands = [
        {"label": "1-3 Competitors", "min": 1, "max": 3},
        {"label": "4-7 Competitors", "min": 4, "max": 7},
        {"label": "8+ Competitors", "min": 8, "max": 10_000},
    ]
    competitiveness = {
        "average": round(sum(competitor_samples) / len(competitor_samples), 1) if competitor_samples else 0.0,
        "lowest": min(competitor_samples) if competitor_samples else 0,
        "highest": max(competitor_samples) if competitor_samples else 0,
        "bands": [],
    }
    for band in competitor_bands:
        band_items = [i for i in analytics_items if band["min"] <= i["bidder_count"] <= band["max"]]
        won_count = sum(1 for i in band_items if i["result"] == "Won")
        decided_count = sum(1 for i in band_items if i["result"] in ("Won", "Lost", "Cancelled"))
        competitiveness["bands"].append({
            "label": band["label"],
            "tenders": len(band_items),
            "won": won_count,
            "win_rate": _rate(won_count, decided_count),
            "est_value": round(sum(i["est_value"] for i in band_items), 2),
        })

    def _avg_days(start_key: str, end_key: str) -> float:
        durations = [
            (item[end_key] - item[start_key]).days
            for item in analytics_items
            if item.get(start_key) and item.get(end_key) and item[end_key] >= item[start_key]
        ]
        return round(sum(durations) / len(durations), 1) if durations else 0.0

    lifecycle = [
        {"stage": "Created to Published", "days": _avg_days("created_date", "published_date")},
        {"stage": "Published to Submission", "days": _avg_days("published_date", "submission_date")},
        {"stage": "Submission to Result", "days": _avg_days("submission_date", "result_date")},
        {"stage": "Created to Award", "days": _avg_days("created_date", "result_date")},
    ]

    open_items = [i for i in analytics_items if i["is_open"]]
    due_7 = [i for i in open_items if i["days_to_submission"] is not None and 0 <= i["days_to_submission"] <= 7]
    due_15 = [i for i in open_items if i["days_to_submission"] is not None and 0 <= i["days_to_submission"] <= 15]
    due_30 = [i for i in open_items if i["days_to_submission"] is not None and 0 <= i["days_to_submission"] <= 30]
    overdue_items = [i for i in open_items if i["is_overdue"]]

    focus_items = []
    for row in business_unit_rollup:
        if row["tenders"] >= 2 and row["win_rate"] < 35 and row["est_value"] > 0:
            focus_items.append({
                "type": "Business Unit",
                "title": row["name"],
                "reason": f"Low win rate at {row['win_rate']}% with {row['tenders']} tenders",
                "value": round(row["est_value"], 2),
                "severity": "high" if row["win_rate"] < 20 else "medium",
            })
    for row in customer_segment_rollup:
        if row["tenders"] >= 2 and row["win_rate"] < 35 and row["est_value"] > 0:
            focus_items.append({
                "type": "Customer Segment",
                "title": row["name"],
                "reason": f"Segment conversion is {row['win_rate']}%",
                "value": round(row["est_value"], 2),
                "severity": "high" if row["win_rate"] < 20 else "medium",
            })
    for row in portal_roi:
        if row["tenders"] >= 2 and row["win_rate"] < 35 and row["est_value"] > 0:
            focus_items.append({
                "type": "Portal",
                "title": row["portal"],
                "reason": f"High exposure with {row['win_rate']}% win rate",
                "value": round(row["est_value"], 2),
                "severity": "medium",
            })
    if overdue_items:
        focus_items.append({
            "type": "Submission Risk",
            "title": "Overdue submissions",
            "reason": f"{len(overdue_items)} open tenders are past submission date",
            "value": round(sum(i["est_value"] for i in overdue_items), 2),
            "severity": "high",
        })
    focus_items = sorted(focus_items, key=lambda x: (x["severity"] == "high", x["value"]), reverse=True)[:8]

    decided_total = won + lost + sum(1 for i in analytics_items if i["result"] == "Cancelled")
    analytics_summary = {
        "total": total,
        "won": won,
        "lost": lost,
        "pending": pend,
        "cancelled": sum(1 for i in analytics_items if i["result"] == "Cancelled"),
        "success_rate": _rate(won, decided_total),
        "open_pipeline": round(sum(i["est_value"] for i in open_items), 2),
        "estimated_value": round(sum(i["est_value"] for i in analytics_items), 2),
        "bid_value": round(sum(i["bid_amount"] for i in analytics_items), 2),
        "awarded_value": round(sum(_won_value(i) for i in analytics_items), 2),
        "award_gap_pct": round(((sum(_won_value(i) for i in analytics_items) - sum(i["est_value"] for i in analytics_items)) / sum(i["est_value"] for i in analytics_items)) * 100, 1) if analytics_items and sum(i["est_value"] for i in analytics_items) else 0.0,
        "overdue": len(overdue_items),
        "due_7": len(due_7),
        "due_15": len(due_15),
        "due_30": len(due_30),
        "high_value_pending": round(sum(i["est_value"] for i in sorted(open_items, key=lambda x: x["est_value"], reverse=True)[:10]), 2),
    }

    decision_analytics = {
        "summary": analytics_summary,
        "business_units": business_unit_rollup,
        "business_verticals": business_vertical_rollup,
        "customer_segments": customer_segment_rollup,
        "portal_roi": portal_roi,
        "kam_performance": kam_performance,
        "monthly_matrix": month_rollup,
        "distribution_trends": distribution_trends,
        "competitiveness": competitiveness,
        "lifecycle": lifecycle,
        "forecast": {
            "due_7": {"count": len(due_7), "value": round(sum(i["est_value"] for i in due_7), 2)},
            "due_15": {"count": len(due_15), "value": round(sum(i["est_value"] for i in due_15), 2)},
            "due_30": {"count": len(due_30), "value": round(sum(i["est_value"] for i in due_30), 2)},
            "overdue": {"count": len(overdue_items), "value": round(sum(i["est_value"] for i in overdue_items), 2)},
            "largest_pending": [
                {
                    "id": i["id"],
                    "title": i["title"],
                    "value": round(i["est_value"], 2),
                    "days_to_submission": i["days_to_submission"],
                    "business_unit": i["business_unit"],
                    "customer_segment": i["customer_segment"],
                }
                for i in sorted(open_items, key=lambda x: x["est_value"], reverse=True)[:8]
            ],
        },
        "focus_items": focus_items,
    }

    # ── product analytics (Product Performance & Product Demand panels) ──────
    tender_info_map: dict[int, dict] = {}
    for r in all_rows:
        tid = int(r.id)
        tender_info_map[tid] = {
            "tender_num": r.tender_num or "",
            "tender_title": r.tender_title or "",
            "customer_name": r.customer_name or "",
            "customer_id": int(r.customer_id) if getattr(r, "customer_id", None) else None,
            "tender_status": r.tender_status or "",
            "result": r.result or "Pending",
            "submission_date": str(r.submission_date) if r.submission_date else "",
            "assigned_to": all_user_map.get(int(r.assigned_to or 0), ""),
        }

    products_by_tender: dict[int, list] = defaultdict(list)
    if all_tender_ids:
        for tp in db.query(TenderProduct).filter(TenderProduct.tender_id.in_(all_tender_ids)).all():
            products_by_tender[tp.tender_id].append(tp)

    # OEMs for initial-BOQ products only — final BOQ carries a single oem_name directly
    initial_product_ids = [tp.id for tps in products_by_tender.values() for tp in tps if not tp.is_final_boq]
    oem_by_product_id: dict[int, list[str]] = defaultdict(list)
    if initial_product_ids:
        for oem in db.query(TenderProductOEM).filter(
            TenderProductOEM.tender_product_id.in_(initial_product_ids)
        ).all():
            if oem.oem_name:
                oem_by_product_id[oem.tender_product_id].append(oem.oem_name)

    def _norm_product_name(name: Optional[str]) -> str:
        return " ".join((name or "").strip().lower().split())

    def _product_line_value(tp: TenderProduct) -> float:
        if tp.total_price is not None:
            return float(tp.total_price)
        qty = float(tp.quantity or 0)
        unit_price = float(tp.unit_price or 0)
        gst = float(tp.gst_percent or 0)
        return qty * unit_price * (1 + gst / 100)

    product_perf_map: dict[str, dict] = {}
    product_demand_map: dict[str, dict] = {}
    counted_result_keys: set = set()

    for tid, tps in products_by_tender.items():
        info = tender_info_map.get(tid)
        if not info:
            continue
        # use final BOQ when it exists; never combine final + initial (double counts qty/value)
        final_tps = [tp for tp in tps if tp.is_final_boq]
        use_tps = final_tps if final_tps else [tp for tp in tps if not tp.is_final_boq]
        if not use_tps:
            continue

        result_value = info["result"]
        customer_id = info["customer_id"]

        for tp in use_tps:
            key = f"pid:{tp.product_id}" if tp.product_id else f"name:{_norm_product_name(tp.product_name)}"
            value = _product_line_value(tp)
            qty = float(tp.quantity or 0)
            oem_name = (
                tp.oem_name if tp.is_final_boq
                else ", ".join(dict.fromkeys(oem_by_product_id.get(tp.id, [])))
            ) or ""

            perf = product_perf_map.setdefault(key, {
                "product_id": tp.product_id, "product_name": tp.product_name or "",
                "tender_ids": set(), "won": 0, "lost": 0, "pending": 0, "cancelled": 0,
                "product_value": 0.0, "rows": [],
            })
            demand = product_demand_map.setdefault(key, {
                "product_id": tp.product_id, "product_name": tp.product_name or "",
                "tender_ids": set(), "total_quantity": 0.0, "product_value": 0.0,
                "customer_ids": set(), "rows": [],
            })

            perf["tender_ids"].add(tid)
            perf["product_value"] += value
            demand["tender_ids"].add(tid)
            demand["total_quantity"] += qty
            demand["product_value"] += value
            if customer_id:
                demand["customer_ids"].add(customer_id)

            # count won/lost/pending/cancelled once per (product, tender) — not per BOQ line
            result_key = (key, tid)
            if result_key not in counted_result_keys:
                counted_result_keys.add(result_key)
                if result_value == "Won":
                    perf["won"] += 1
                elif result_value == "Lost":
                    perf["lost"] += 1
                elif result_value == "Cancelled":
                    perf["cancelled"] += 1
                else:
                    perf["pending"] += 1

            row = {
                "product_name": tp.product_name or "",
                "tender_num": info["tender_num"],
                "tender_title": info["tender_title"],
                "customer_name": info["customer_name"],
                "quantity": qty,
                "product_value": round(value, 2),
                "oem_name": oem_name,
                "tender_status": info["tender_status"],
                "result": result_value,
                "submission_date": info["submission_date"],
                "assigned_to": info["assigned_to"],
                "id": tid,
            }
            perf["rows"].append(row)
            demand["rows"].append(row)

    performance = sorted([
        {
            "product_id": perf["product_id"],
            "product_name": perf["product_name"],
            "tender_count": len(perf["tender_ids"]),
            "won": perf["won"], "lost": perf["lost"],
            "pending": perf["pending"], "cancelled": perf["cancelled"],
            "win_rate": _rate(perf["won"], perf["won"] + perf["lost"] + perf["cancelled"]),
            "product_value": round(perf["product_value"], 2),
            "rows": perf["rows"],
        }
        for perf in product_perf_map.values()
    ], key=lambda x: x["product_value"], reverse=True)

    demand_list = sorted([
        {
            "product_id": d["product_id"],
            "product_name": d["product_name"],
            "tender_count": len(d["tender_ids"]),
            "total_quantity": round(d["total_quantity"], 2),
            "product_value": round(d["product_value"], 2),
            "customer_count": len(d["customer_ids"]),
            "rows": d["rows"],
        }
        for d in product_demand_map.values()
    ], key=lambda x: x["product_value"], reverse=True)

    product_analytics = {
        "performance": performance,
        "demand": demand_list,
    }

    # pipeline stages in order
    stage_order = ["Aligned", "Evaluation", "Pre-Bid", "Reverse Auction", "Submitted", "Closed"]
    pipeline_funnel = [{"stage": s, "count": status_counts[s]["count"], "value": status_counts[s]["value"]}
                       for s in stage_order]

    # upcoming submissions (next 30 days, pending tenders)
    upcoming_cutoff = today_d + timedelta(days=30)
    upcoming = sorted([
        {"tender_title": r.tender_title or "", "submission_date": str(r.submission_date),
         "days_to_submission": (r.submission_date - today_d).days,
         "portal": str(r.source_portal or ""), "bid_amount": float(r.bid_amount or 0)}
        for r in all_q.with_entities(
            Tender.tender_title, Tender.submission_date,
            Tender.source_portal, Tender.bid_amount
        ).filter(
            Tender.submission_date >= today_d,
            Tender.submission_date <= upcoming_cutoff,
            Tender.result == "Pending",
        ).all()
        if r.submission_date
    ], key=lambda x: x["submission_date"])

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count, "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_data": chart_result,
        "chart_data2": chart_portal,
        "chart_status": chart_status,
        "chart_daily": chart_daily,
        "chart_tech": chart_tech,
        "pipeline_funnel": pipeline_funnel,
        "upcoming_submissions": upcoming[:10],
        "decision_analytics": decision_analytics,
        "product_analytics": product_analytics,
    }


# ── Customers helpers ─────────────────────────────────────────────────────────

def _build_customers_scope(db: Session, cu: User):
    q = db.query(Customer).filter(Customer.is_deleted == False)
    scope_ids = _report_scope_user_ids(db, cu)
    if scope_ids is not None:
        assigned_customer_ids = db.query(SalesCustomerAssignment.customer_id).filter(
            SalesCustomerAssignment.is_active == True,
            SalesCustomerAssignment.user_id.in_(scope_ids),
        )
        q = q.filter(or_(
            Customer.created_by.in_(scope_ids),
            Customer.assigned_to.in_(scope_ids),
            Customer.id.in_(assigned_customer_ids),
        ))
    return q


def _apply_customers_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(Customer.created_at >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(Customer.created_at <= params["date_to"] + " 23:59:59")
    if params.get("status"):
        vals = [s.strip() for s in params["status"].split(",") if s.strip()]
        q = q.filter(Customer.account_status.in_(vals))
    if params.get("potential"):
        vals = [s.strip() for s in params["potential"].split(",") if s.strip()]
        q = q.filter(Customer.account_potential.in_(vals))
    if params.get("assigned_to"):
        vals = [int(x) for x in str(params["assigned_to"]).split(",") if x.strip()]
        q = q.filter(Customer.assigned_to.in_(vals))
    if params.get("vertical"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, [params["vertical"]]) or [-1]))
    if params.get("industry"):
        q = q.filter(Customer.industry.ilike(f"%{params['industry']}%"))
    if params.get("billing_country"):
        q = q.filter(Customer.billing_country.ilike(f"%{params['billing_country']}%"))
    if params.get("billing_state"):
        q = q.filter(Customer.billing_state.ilike(f"%{params['billing_state']}%"))
    if params.get("billing_city"):
        q = q.filter(Customer.billing_city.ilike(f"%{params['billing_city']}%"))
    if params.get("source"):
        vals = [int(x) for x in str(params["source"]).split(",") if x.strip().isdigit()]
        if vals:
            lead_source_sub = db.query(Lead.customer_id).filter(
                Lead.customer_id != None,
                Lead.is_deleted == False,
                Lead.source_id.in_(vals),
            )
            q = q.filter(Customer.id.in_(lead_source_sub))
    if params.get("created_by"):
        vals = [int(x) for x in str(params["created_by"]).split(",") if x.strip().isdigit()]
        if vals:
            q = q.filter(Customer.created_by.in_(vals))
    if params.get("tags"):
        term = f"%{str(params['tags']).strip()}%"
        q = q.filter(cast(Customer.tags, String).ilike(term))
    if params.get("active_projects"):
        active_project_sub = db.query(WorkOrder.customer_id).filter(
            WorkOrder.customer_id != None,
            WorkOrder.status.in_(["Confirmed", "In Progress", "On Hold", "Delayed", "Won"]),
        )
        if str(params["active_projects"]).lower() in ("1", "true", "yes"):
            q = q.filter(Customer.id.in_(active_project_sub))
        elif str(params["active_projects"]).lower() in ("0", "false", "no"):
            q = q.filter(~Customer.id.in_(active_project_sub))
    if _bool_value(params.get("has_active_lead")):
        active_lead_sub = db.query(Lead.customer_id).filter(
            Lead.customer_id != None,
            Lead.is_deleted == False,
            Lead.status.notin_(["Converted", "Lost"]),
        )
        q = q.filter(Customer.id.in_(active_lead_sub))
    if _bool_value(params.get("has_open_tender")):
        open_tender_sub = db.query(Tender.customer_id).filter(
            Tender.customer_id != None,
            Tender.tender_status != "Closed",
        )
        q = q.filter(Customer.id.in_(open_tender_sub))
    if params.get("last_activity"):
        try:
            days = int(params["last_activity"])
            cutoff = today_ist() - timedelta(days=days)
            recent_activity_sub = db.query(KAMActivity.customer_id).filter(
                KAMActivity.customer_id != None,
                KAMActivity.activity_date >= cutoff,
            )
            q = q.filter(Customer.id.in_(recent_activity_sub))
        except (TypeError, ValueError):
            pass
    if params.get("next_follow_up"):
        try:
            days = int(params["next_follow_up"])
            today = today_ist()
            due_by = today + timedelta(days=days)
            followup_sub = db.query(KAMActivity.customer_id).filter(
                KAMActivity.customer_id != None,
                KAMActivity.next_action_date != None,
                KAMActivity.next_action_date >= today,
                KAMActivity.next_action_date <= due_by,
            )
            q = q.filter(Customer.id.in_(followup_sub))
        except (TypeError, ValueError):
            pass
    if params.get("no_activity_since"):
        try:
            days = int(params["no_activity_since"])
            cutoff = today_ist() - timedelta(days=days)
            recent_activity_sub = db.query(KAMActivity.customer_id).filter(
                KAMActivity.customer_id != None,
                KAMActivity.activity_date >= cutoff,
            )
            q = q.filter(~Customer.id.in_(recent_activity_sub))
        except (TypeError, ValueError):
            pass
    if params.get("search"):
        search_term = f"%{params['search'].strip()}%"
        q = q.filter(
            or_(
                Customer.customer_name.ilike(search_term),
                Customer.customer_vertical.ilike(search_term),
                Customer.billing_city.ilike(search_term),
                Customer.billing_state.ilike(search_term),
                Customer.division.ilike(search_term),
                Customer.group_name.ilike(search_term),
                Customer.id.in_(
                    db.query(CustomerContact.customer_id).filter(
                        CustomerContact.is_active == True,
                        or_(
                            CustomerContact.contact_name.ilike(search_term),
                            CustomerContact.mobile.ilike(search_term),
                            CustomerContact.office_phone.ilike(search_term),
                            CustomerContact.office_email.ilike(search_term),
                        ),
                    )
                ),
            )
        )
    if params.get("potential_value_min") is not None:
        q = q.filter(Customer.potential_value >= params["potential_value_min"])
    if params.get("potential_value_max") is not None:
        q = q.filter(Customer.potential_value <= params["potential_value_max"])
    if params.get("revenue_min") is not None:
        q = q.filter(Customer.annual_revenue >= params["revenue_min"])
    if params.get("revenue_max") is not None:
        q = q.filter(Customer.annual_revenue <= params["revenue_max"])
    return q


@router.get("/customers/filter-options")
def customers_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = [
        r[0] for r in db.query(Customer.customer_name).filter(
            Customer.customer_name != None, Customer.customer_name != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_name).all()
    ]
    # distinct states and verticals from actual data
    states = [
        r[0] for r in db.query(Customer.billing_state).filter(
            Customer.billing_state != None, Customer.billing_state != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.billing_state).all()
    ]
    _raw_verticals = [
        r[0] for r in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None, Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().all()
    ]
    verticals = sorted({
        cleaned for cleaned in (_clean_segment_name(v) for v in _raw_verticals) if cleaned
    })
    industries = [
        r[0] for r in db.query(Customer.industry).filter(
            Customer.industry != None, Customer.industry != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.industry).all()
    ]
    countries = [
        r[0] for r in db.query(Customer.billing_country).filter(
            Customer.billing_country != None, Customer.billing_country != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.billing_country).all()
    ]
    cities = [
        r[0] for r in db.query(Customer.billing_city).filter(
            Customer.billing_city != None, Customer.billing_city != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.billing_city).all()
    ]
    sources = db.query(LeadSource.id, LeadSource.name).order_by(LeadSource.name).all()
    vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(
        VerticalSector.is_active == True,
    ).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    vertical_sub_sectors = (
        db.query(
            VerticalSubSector.id,
            VerticalSubSector.name,
            VerticalSubSector.sector_id,
            VerticalSector.name.label("sector_name"),
        )
        .join(VerticalSector, VerticalSector.id == VerticalSubSector.sector_id)
        .filter(
            VerticalSubSector.is_active == True,
            VerticalSector.is_active == True,
        )
        .order_by(
            VerticalSector.display_order,
            VerticalSector.name,
            VerticalSubSector.name,
            VerticalSubSector.id,
        )
        .all()
    )
    time_windows = [
        {"id": 7, "name": "Last 7 days"},
        {"id": 30, "name": "Last 30 days"},
        {"id": 60, "name": "Last 60 days"},
        {"id": 90, "name": "Last 90 days"},
    ]
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        cust_business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        cust_business_verticals = []
    return {
        "customers": customers,
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "statuses": ["Active", "Inactive", "Prospect", "Churned"],
        "potentials": ["High", "Medium", "Low"],
        "states": states,
        "verticals": verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in vertical_sectors],
        "vertical_sub_sectors": [
            {
                "id": s.id,
                "name": s.name,
                "sector_id": s.sector_id,
                "sector_name": s.sector_name,
            }
            for s in vertical_sub_sectors
        ],
        "industries": industries,
        "countries": countries,
        "cities": cities,
        "sources": [{"id": s.id, "name": s.name} for s in sources],
        "business_verticals": cust_business_verticals,
        "activity_windows": time_windows,
        "followup_windows": time_windows,
    }


@router.get("/customers")
def report_customers(
    # date range
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    # filters
    status: Optional[str] = None,
    potential: Optional[str] = None,
    assigned_to: Optional[str] = None,
    vertical: Optional[str] = None,
    industry: Optional[str] = None,
    billing_country: Optional[str] = None,
    billing_state: Optional[str] = None,
    billing_city: Optional[str] = None,
    source: Optional[str] = None,
    active_projects: Optional[str] = None,
    has_active_lead: Optional[str] = None,
    has_open_tender: Optional[str] = None,
    tags: Optional[str] = None,
    last_activity: Optional[str] = None,
    next_follow_up: Optional[str] = None,
    search: Optional[str] = None,
    no_activity_since: Optional[str] = None,
    created_by: Optional[str] = None,
    potential_value_min: Optional[float] = None,
    potential_value_max: Optional[float] = None,
    revenue_min: Optional[float] = None,
    revenue_max: Optional[float] = None,
    # pagination
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "customer_name",
    sort_dir: Optional[str] = "asc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, prev_from, prev_to = _resolve_date_preset(preset, date_from, date_to)
    if assigned_to == "__ME__":
        assigned_to = str(cu.id)

    filter_params = {
        "date_from": df_str, "date_to": dt_str,
        "status": status, "potential": potential,
        "assigned_to": assigned_to, "vertical": vertical,
        "industry": industry, "billing_country": billing_country,
        "billing_state": billing_state, "billing_city": billing_city,
        "source": source,
        "active_projects": active_projects,
        "has_active_lead": has_active_lead,
        "has_open_tender": has_open_tender,
        "tags": tags,
        "last_activity": last_activity,
        "next_follow_up": next_follow_up,
        "search": search,
        "no_activity_since": no_activity_since,
        "created_by": created_by,
        "potential_value_min": potential_value_min,
        "potential_value_max": potential_value_max,
        "revenue_min": revenue_min,
        "revenue_max": revenue_max,
    }

    q = _build_customers_scope(db, cu)
    q = _apply_customers_filters(q, filter_params, db)
    total_count = q.count()

    sort_col = getattr(Customer, sort_by, None) if sort_by else None
    if sort_col is None:
        sort_col = Customer.customer_name
    q = q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    rows = q.all() if export else q.offset((page - 1) * per_page).limit(per_page).all()

    # user name cache — single query, no N+1
    uid_set = {r.assigned_to for r in rows if r.assigned_to} | {r.created_by for r in rows if r.created_by}
    user_cache: dict[int, str] = {}
    if uid_set:
        for u in db.query(User.id, User.full_name).filter(User.id.in_(uid_set)).all():
            user_cache[u.id] = u.full_name or ""

    # lead counts per customer (single query)
    cids = [r.id for r in rows]
    lead_count_map: dict[int, int] = {}
    if cids:
        for cid, cnt in db.query(Lead.customer_id, func.count(Lead.id)).filter(
            Lead.customer_id.in_(cids), Lead.is_deleted == False
        ).group_by(Lead.customer_id).all():
            lead_count_map[cid] = cnt

    # linked-module counts + value/activity aggregates per customer (one grouped query each)
    tender_count_map: dict[int, int] = {}
    quotation_count_map: dict[int, int] = {}
    workorder_count_map: dict[int, int] = {}
    emdbg_count_map: dict[int, int] = {}
    open_lead_val_map: dict[int, float] = {}
    open_tender_val_map: dict[int, float] = {}
    won_val_map: dict[int, float] = {}
    last_activity_map: dict[int, str] = {}
    if cids:
        for cid, cnt in db.query(Tender.customer_id, func.count(Tender.id)).filter(
            Tender.customer_id.in_(cids), Tender.is_deleted == False
        ).group_by(Tender.customer_id).all():
            tender_count_map[cid] = cnt
        for cid, cnt in db.query(Quotation.customer_id, func.count(Quotation.id)).filter(
            Quotation.customer_id.in_(cids)
        ).group_by(Quotation.customer_id).all():
            quotation_count_map[cid] = cnt
        for cid, cnt in db.query(WorkOrder.customer_id, func.count(WorkOrder.id)).filter(
            WorkOrder.customer_id.in_(cids)
        ).group_by(WorkOrder.customer_id).all():
            workorder_count_map[cid] = cnt
        for cid, cnt in db.query(EMDBG.customer_id, func.count(EMDBG.id)).filter(
            EMDBG.customer_id.in_(cids)
        ).group_by(EMDBG.customer_id).all():
            emdbg_count_map[cid] = cnt
        for cid, sv in db.query(Lead.customer_id, func.sum(Lead.est_value)).filter(
            Lead.customer_id.in_(cids), Lead.is_deleted == False,
            Lead.status.notin_(["Converted", "Lost"]),
        ).group_by(Lead.customer_id).all():
            open_lead_val_map[cid] = float(sv or 0)
        for cid, sv in db.query(Tender.customer_id, func.sum(Tender.est_value)).filter(
            Tender.customer_id.in_(cids), Tender.is_deleted == False,
            or_(Tender.result.is_(None), Tender.result.notin_(["Won", "Lost"])),
        ).group_by(Tender.customer_id).all():
            open_tender_val_map[cid] = float(sv or 0)
        won_value_expr = func.coalesce(func.nullif(Tender.bid_amount, 0), Tender.est_value)
        for cid, sv in db.query(Tender.customer_id, func.sum(won_value_expr)).filter(
            Tender.customer_id.in_(cids), Tender.is_deleted == False,
            Tender.result == "Won",
        ).group_by(Tender.customer_id).all():
            won_val_map[cid] = float(sv or 0)
        for cid, last_dt in db.query(KAMActivity.customer_id, func.max(KAMActivity.activity_date)).filter(
            KAMActivity.customer_id.in_(cids)
        ).group_by(KAMActivity.customer_id).all():
            if last_dt:
                last_activity_map[cid] = str(last_dt)[:10]

    primary_contact_map = _fetch_primary_customer_contacts(db, cids)

    data = []
    for r in rows:
        primary_contact = primary_contact_map.get(r.id)
        data.append({
            "id": r.id,
            "customer_name": r.customer_name,
            "customer_vertical": _clean_segment_name(r.customer_vertical),
            "division": r.division or "",
            "group_name": r.group_name or "",
            "industry": r.industry or "",
            "account_status": r.account_status or "",
            "account_potential": r.account_potential or "",
            "potential_value": float(r.potential_value or 0),
            "annual_revenue": float(r.annual_revenue or 0),
            "employee_count": r.employee_count or 0,
            "gst_number": r.gst_number or "",
            "pan_number": r.pan_number or "",
            "billing_city": r.billing_city or "",
            "billing_state": r.billing_state or "",
            "billing_country": r.billing_country or "",
            "website": r.website or "",
            "remarks": r.remarks or "",
            "primary_contact_name": primary_contact.contact_name if primary_contact else "",
            "primary_contact_mobile": primary_contact.mobile if primary_contact else "",
            "lead_count": lead_count_map.get(r.id, 0),
            "tender_count": tender_count_map.get(r.id, 0),
            "quotation_count": quotation_count_map.get(r.id, 0),
            "workorder_count": workorder_count_map.get(r.id, 0),
            "emdbg_count": emdbg_count_map.get(r.id, 0),
            "open_pipeline_value": round(open_lead_val_map.get(r.id, 0) + open_tender_val_map.get(r.id, 0), 2),
            "won_value": won_val_map.get(r.id, 0),
            "last_activity": last_activity_map.get(r.id, ""),
            "assigned_to": user_cache.get(r.assigned_to, ""),
            "created_by": user_cache.get(r.created_by, ""),
            "created_at": str(r.created_at)[:10] if r.created_at else "",
        })

    if export:
        return _export(data, "customers_report", export)

    # ── KPI analytics (full filtered set) ────────────────────────────────────
    base_filter_params = dict(filter_params, date_from=None, date_to=None)
    all_q = _build_customers_scope(db, cu)
    all_q = _apply_customers_filters(all_q, base_filter_params, db)
    all_rows = all_q.with_entities(
        Customer.id,
        Customer.customer_name,
        Customer.account_status,
        Customer.account_potential,
        Customer.potential_value,
        Customer.annual_revenue,
        Customer.billing_state,
        Customer.customer_vertical,
        func.date(Customer.created_at).label("day"),
    ).all()

    total = len(all_rows)
    active   = sum(1 for r in all_rows if r.account_status == "Active")
    prospect = sum(1 for r in all_rows if r.account_status == "Prospect")
    churned  = sum(1 for r in all_rows if r.account_status == "Churned")
    inactive = sum(1 for r in all_rows if r.account_status == "Inactive")
    high_pot = sum(1 for r in all_rows if r.account_potential == "High")
    total_pv = sum(float(r.potential_value or 0) for r in all_rows)
    total_revenue = sum(float(r.annual_revenue or 0) for r in all_rows)
    customer_ids = [int(r.id) for r in all_rows if r.id]

    # lead coverage: customers with ≥1 lead
    covered_ids = set(
        cid for cid, cnt in db.query(Lead.customer_id, func.count(Lead.id)).filter(
            Lead.customer_id.in_(customer_ids or [0]),
            Lead.is_deleted == False,
        ).group_by(Lead.customer_id).all()
        if cnt > 0
    )

    period_q = _build_customers_scope(db, cu)
    period_q = _apply_customers_filters(period_q, filter_params, db)
    period_rows = period_q.with_entities(
        Customer.account_status,
        func.date(Customer.created_at).label("day"),
    ).all()
    new_customers = len(period_rows)
    period_churned = sum(1 for r in period_rows if r.account_status == "Churned")

    # comparison period
    prev_params = dict(filter_params, date_from=prev_from, date_to=prev_to)
    prev_q = _build_customers_scope(db, cu)
    prev_q = _apply_customers_filters(prev_q, prev_params, db)
    prev_rows = prev_q.with_entities(Customer.account_status).all()
    p_new = len(prev_rows)

    def _pct(curr, prev):
        return None if prev == 0 else round((curr - prev) / prev * 100, 1)

    summary = {
        "total": total, "active": active, "prospect": prospect,
        "prospects": prospect,
        "new_customers": new_customers,
        "churned": churned, "inactive": inactive, "high_potential": high_pot,
        "period_churned": period_churned,
        "active_rate": round(active / total * 100, 1) if total else 0.0,
        "total_potential_value": round(total_revenue, 2),
        "avg_potential_value": round(total_revenue / total, 2) if total else 0.0,
        "total_pipeline_value": round(total_pv, 2),
        "avg_pipeline_value": round(total_pv / total, 2) if total else 0.0,
        "lead_coverage_pct": round(len(covered_ids) / total * 100, 1) if total else 0.0,
        "with_leads": len(covered_ids),
        "without_leads": total - len(covered_ids),
        # trends
        "trend_total": None,
        "trend_active": None,
        "trend_value": None,
        "trend_new": _pct(new_customers, p_new),
        "_date_from": df_str, "_date_to": dt_str,
        "_prev_from": prev_from, "_prev_to": prev_to,
    }

    # ── charts ────────────────────────────────────────────────────────────────
    status_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    potential_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    state_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    vertical_counts: dict = defaultdict(lambda: {"count": 0, "value": 0.0})
    monthly_counts: dict = defaultdict(lambda: {"count": 0, "churned": 0})

    for r in all_rows:
        st = r.account_status or "Unknown"
        status_counts[st]["count"] += 1
        status_counts[st]["value"] += float(r.annual_revenue or 0)

        po = r.account_potential or "Unknown"
        potential_counts[po]["count"] += 1
        potential_counts[po]["value"] += float(r.annual_revenue or 0)

        if r.billing_state:
            state_counts[r.billing_state]["count"] += 1
            state_counts[r.billing_state]["value"] += float(r.annual_revenue or 0)

        vertical_name = _clean_segment_name(r.customer_vertical)
        if vertical_name:
            vertical_counts[vertical_name]["count"] += 1
            vertical_counts[vertical_name]["value"] += float(r.annual_revenue or 0)

    for r in period_rows:
        if r.day:
            month = str(r.day)[:7]  # YYYY-MM
            monthly_counts[month]["count"] += 1
            if r.account_status == "Churned":
                monthly_counts[month]["churned"] += 1

    chart_status   = [{"label": k, **v} for k, v in status_counts.items()]
    chart_potential= [{"label": k, **v} for k, v in potential_counts.items()]
    chart_state    = sorted([{"label": k, **v} for k, v in state_counts.items()],
                            key=lambda x: -x["count"])[:12]
    chart_vertical = sorted([{"label": k, **v} for k, v in vertical_counts.items()],
                            key=lambda x: -x["count"])[:10]
    chart_monthly  = sorted([{"label": k, **v} for k, v in monthly_counts.items()],
                            key=lambda x: x["label"])
    chart_revenue = [
        {"label": r.customer_name or "Unknown", "count": 1, "value": round(float(r.annual_revenue or 0), 2)}
        for r in sorted(all_rows, key=lambda item: float(item.annual_revenue or 0), reverse=True)
    ][:10]

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count, "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_data": chart_status,
        "chart_data2": chart_potential,
        "chart_state": chart_state,
        "chart_vertical": chart_vertical,
        "chart_monthly": chart_monthly,
        "chart_revenue": chart_revenue,
    }


def _apply_workorders_scope(q, scope_user_ids: Optional[list[int]]):
    if scope_user_ids is None:
        return q
    return q.filter(or_(
        WorkOrder.created_by.in_(scope_user_ids),
        WorkOrder.project_manager_id.in_(scope_user_ids),
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))


def _apply_workorders_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(WorkOrder.created_at >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(WorkOrder.created_at <= params["date_to"] + " 23:59:59")
    if params.get("status"):
        q = q.filter(WorkOrder.status.in_(_split_csv_strings(params["status"])))
    if params.get("wo_type"):
        q = q.filter(WorkOrder.wo_type.in_(_split_csv_strings(params["wo_type"])))
    if params.get("customer_id"):
        q = q.filter(WorkOrder.customer_id.in_(_split_csv_ints(params["customer_id"])))
    if params.get("customer_segment"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, _split_csv_strings(params["customer_segment"])) or [-1]))
    if params.get("business_vertical_id"):
        vals = _split_csv_ints(params["business_vertical_id"])
        if vals:
            bv_lead_sub = db.query(Lead.id).filter(Lead.business_vertical_id.in_(vals)).subquery()
            q = q.filter(WorkOrder.lead_id.in_(bv_lead_sub))
    if params.get("project_manager_id"):
        q = q.filter(WorkOrder.project_manager_id.in_(_split_csv_ints(params["project_manager_id"])))
    if params.get("created_by"):
        q = q.filter(WorkOrder.created_by.in_(_split_csv_ints(params["created_by"])))
    if params.get("source_portal"):
        q = q.filter(Tender.source_portal.in_(_split_csv_strings(params["source_portal"])))
    if params.get("tender_result"):
        q = q.filter(Tender.result.in_(_split_csv_strings(params["tender_result"])))
    if params.get("delivery_status"):
        delivery_sub = (
            db.query(WOLineItem.wo_id)
            .filter(WOLineItem.delivery_status.in_(_split_csv_strings(params["delivery_status"])))
            .subquery()
        )
        q = q.filter(WorkOrder.id.in_(delivery_sub))
    if params.get("payment_status"):
        payment_sub = (
            db.query(WOInvoice.wo_id)
            .filter(WOInvoice.payment_status.in_(_split_csv_strings(params["payment_status"])))
            .subquery()
        )
        q = q.filter(WorkOrder.id.in_(payment_sub))
    if params.get("product_name"):
        product_sub = (
            db.query(WOLineItem.wo_id)
            .filter(WOLineItem.product_name.ilike(f"%{params['product_name']}%"))
            .subquery()
        )
        q = q.filter(WorkOrder.id.in_(product_sub))
    if params.get("site_location"):
        q = q.filter(WorkOrder.site_location.ilike(f"%{params['site_location']}%"))
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        product_sub = (
            db.query(WOLineItem.wo_id)
            .filter(WOLineItem.product_name.ilike(term))
            .subquery()
        )
        q = q.filter(or_(
            WorkOrder.wo_number.ilike(term),
            WorkOrder.project_title.ilike(term),
            WorkOrder.customer_name.ilike(term),
            WorkOrder.po_number.ilike(term),
            WorkOrder.site_location.ilike(term),
            Customer.customer_vertical.ilike(term),
            Tender.tender_num.ilike(term),
            WorkOrder.id.in_(product_sub),
        ))
    if params.get("progress_min") is not None:
        q = q.filter(WorkOrder.progress_percent >= params["progress_min"])
    if params.get("progress_max") is not None:
        q = q.filter(WorkOrder.progress_percent <= params["progress_max"])
    if params.get("value_min") is not None:
        q = q.filter(WorkOrder.wo_value >= params["value_min"])
    if params.get("value_max") is not None:
        q = q.filter(WorkOrder.wo_value <= params["value_max"])
    if params.get("delivery_from"):
        q = q.filter(WorkOrder.delivery_date >= params["delivery_from"])
    if params.get("delivery_to"):
        q = q.filter(WorkOrder.delivery_date <= params["delivery_to"])
    if params.get("completion_from"):
        q = q.filter(WorkOrder.completion_date >= params["completion_from"])
    if params.get("completion_to"):
        q = q.filter(WorkOrder.completion_date <= params["completion_to"])
    if params.get("warranty_days") is not None:
        cutoff = today_ist() + timedelta(days=int(params["warranty_days"]))
        q = q.filter(
            WorkOrder.warranty_expiry != None,
            WorkOrder.warranty_expiry <= cutoff,
        )
    return q


def _empty_workorder_rollup() -> dict:
    return {
        "products": [],
        "total_ordered_qty": 0.0,
        "total_delivered_qty": 0.0,
        "delivery_status_counts": Counter(),
        "invoice_count": 0,
        "total_invoiced": 0.0,
        "total_paid": 0.0,
        "due_invoice_amount": 0.0,
        "overdue_invoice_amount": 0.0,
        "payment_status_counts": Counter(),
    }


def _fetch_workorder_rollups(db: Session, wo_ids: list[int]) -> dict[int, dict]:
    if not wo_ids:
        return {}

    rollups: dict[int, dict] = defaultdict(_empty_workorder_rollup)

    for item in db.query(WOLineItem).filter(WOLineItem.wo_id.in_(wo_ids)).all():
        bucket = rollups[item.wo_id]
        if item.product_name:
            bucket["products"].append(item.product_name)
        bucket["total_ordered_qty"] += float(item.quantity or 0)
        bucket["total_delivered_qty"] += float(item.delivered_qty or 0)
        bucket["delivery_status_counts"][str(item.delivery_status or "Pending")] += 1

    for invoice in db.query(WOInvoice).filter(WOInvoice.wo_id.in_(wo_ids)).all():
        bucket = rollups[invoice.wo_id]
        total_amount = _amount(invoice.total_amount or invoice.amount)
        paid_amount = _amount(invoice.paid_amount)
        due_amount = max(total_amount - paid_amount, 0.0)
        bucket["invoice_count"] += 1
        bucket["total_invoiced"] += total_amount
        bucket["total_paid"] += paid_amount
        bucket["due_invoice_amount"] += due_amount
        status = str(invoice.payment_status or "Pending")
        bucket["payment_status_counts"][status] += 1
        if status == "Overdue":
            bucket["overdue_invoice_amount"] += due_amount

    output: dict[int, dict] = {}
    for wo_id, bucket in rollups.items():
        ordered_qty = float(bucket["total_ordered_qty"] or 0)
        delivered_qty = float(bucket["total_delivered_qty"] or 0)

        if ordered_qty > 0 and delivered_qty >= ordered_qty:
            delivery_status = "Delivered"
        elif delivered_qty > 0:
            delivery_status = "Partial"
        elif bucket["delivery_status_counts"]:
            delivery_status = bucket["delivery_status_counts"].most_common(1)[0][0]
        else:
            delivery_status = "Pending"

        payment_counts: Counter = bucket["payment_status_counts"]
        if payment_counts.get("Overdue"):
            payment_status = "Overdue"
        elif payment_counts.get("Partial"):
            payment_status = "Partial"
        elif payment_counts and payment_counts.get("Paid", 0) == sum(payment_counts.values()):
            payment_status = "Paid"
        elif payment_counts:
            payment_status = payment_counts.most_common(1)[0][0]
        else:
            payment_status = "Pending"

        output[wo_id] = {
            "products": ", ".join(dict.fromkeys(bucket["products"])),
            "total_ordered_qty": ordered_qty,
            "total_delivered_qty": delivered_qty,
            "delivery_status": delivery_status,
            "invoice_count": int(bucket["invoice_count"] or 0),
            "total_invoiced": round(float(bucket["total_invoiced"] or 0), 2),
            "total_paid": round(float(bucket["total_paid"] or 0), 2),
            "due_invoice_amount": round(float(bucket["due_invoice_amount"] or 0), 2),
            "overdue_invoice_amount": round(float(bucket["overdue_invoice_amount"] or 0), 2),
            "payment_status": payment_status,
        }
    return output


@router.get("/workorders/filter-options")
def workorders_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    segments = [
        row[0] for row in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_vertical).all()
    ]
    portals = [
        row[0] for row in db.query(Tender.source_portal)
        .join(WorkOrder, WorkOrder.tender_id == Tender.id)
        .filter(Tender.source_portal != None, Tender.source_portal != "")
        .distinct().order_by(Tender.source_portal).all()
    ]
    results = [
        row[0] for row in db.query(Tender.result)
        .join(WorkOrder, WorkOrder.tender_id == Tender.id)
        .filter(Tender.result != None, Tender.result != "")
        .distinct().order_by(Tender.result).all()
    ]
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        wo_business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        wo_business_verticals = []
    wo_vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "segments": segments,
        "statuses": ["Draft", "Confirmed", "In Progress", "On Hold", "Delayed", "Completed", "Cancelled", "Closed", "Won", "Lost"],
        "wo_types": ["Supply", "Supply & Installation", "AMC", "Service", "Turnkey"],
        "portals": _unique_strings(portals),
        "results": _unique_strings(results) or ["Pending", "Won", "Lost", "Cancelled"],
        "payment_statuses": ["Pending", "Partial", "Paid", "Overdue"],
        "delivery_statuses": ["Pending", "Partial", "Delivered"],
        "business_verticals": wo_business_verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in wo_vertical_sectors],
    }


@router.get("/workorders")
def report_workorders(
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    wo_type: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    project_manager_id: Optional[str] = None,
    created_by: Optional[str] = None,
    source_portal: Optional[str] = None,
    tender_result: Optional[str] = None,
    delivery_status: Optional[str] = None,
    payment_status: Optional[str] = None,
    product_name: Optional[str] = None,
    site_location: Optional[str] = None,
    search: Optional[str] = None,
    progress_min: Optional[float] = None,
    progress_max: Optional[float] = None,
    value_min: Optional[float] = None,
    value_max: Optional[float] = None,
    delivery_from: Optional[str] = None,
    delivery_to: Optional[str] = None,
    completion_from: Optional[str] = None,
    completion_to: Optional[str] = None,
    warranty_days: Optional[int] = None,
    business_vertical_id: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "created_at",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, _, _ = _resolve_date_preset(preset, date_from, date_to)
    filter_params = {
        "date_from": df_str,
        "date_to": dt_str,
        "status": status,
        "wo_type": wo_type,
        "customer_id": customer_id,
        "customer_segment": customer_segment,
        "project_manager_id": project_manager_id,
        "created_by": created_by,
        "source_portal": source_portal,
        "tender_result": tender_result,
        "delivery_status": delivery_status,
        "payment_status": payment_status,
        "product_name": product_name,
        "site_location": site_location,
        "search": search,
        "business_vertical_id": business_vertical_id,
        "progress_min": progress_min,
        "progress_max": progress_max,
        "value_min": value_min,
        "value_max": value_max,
        "delivery_from": delivery_from,
        "delivery_to": delivery_to,
        "completion_from": completion_from,
        "completion_to": completion_to,
        "warranty_days": warranty_days,
    }

    scope_user_ids = _report_scope_user_ids(db, cu)
    base_q = (
        db.query(
            WorkOrder,
            Customer.customer_vertical.label("customer_segment"),
            Tender.tender_num.label("tender_num"),
            Tender.result.label("tender_result"),
            Tender.source_portal.label("source_portal"),
            Tender.source_id.label("source_id"),
        )
        .outerjoin(Customer, WorkOrder.customer_id == Customer.id)
        .outerjoin(Tender, WorkOrder.tender_id == Tender.id)
    )
    base_q = _apply_workorders_scope(base_q, scope_user_ids)
    base_q = _apply_workorders_filters(base_q, filter_params, db)
    total_count = base_q.count()

    sort_map = {
        "wo_number": WorkOrder.wo_number,
        "project_title": WorkOrder.project_title,
        "customer_name": WorkOrder.customer_name,
        "wo_type": WorkOrder.wo_type,
        "status": WorkOrder.status,
        "progress_percent": WorkOrder.progress_percent,
        "po_number": WorkOrder.po_number,
        "po_value": WorkOrder.po_value,
        "wo_value": WorkOrder.wo_value,
        "delivery_date": WorkOrder.delivery_date,
        "completion_date": WorkOrder.completion_date,
        "project_manager_id": WorkOrder.project_manager_id,
        "created_at": WorkOrder.created_at,
    }
    sort_col = sort_map.get(str(sort_by or "created_at"), WorkOrder.created_at)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()
    analytics_ids = [int(wo.id) for wo, _, _, _, _, _ in analytics_rows if getattr(wo, "id", None)]
    rollups = _fetch_workorder_rollups(db, analytics_ids)
    today = today_ist()

    analytics_items: list[dict] = []
    for wo, _, _, _, _, _ in analytics_rows:
        rollup = rollups.get(int(wo.id), {})
        delivery_dt = _to_date(wo.delivery_date)
        completion_dt = _to_date(wo.completion_date)
        next_due = completion_dt or delivery_dt
        days_to_due = (next_due - today).days if next_due else None
        status_value = str(wo.status or "")
        analytics_items.append({
            "wo_number": wo.wo_number or "",
            "customer_name": wo.customer_name or "",
            "status": status_value,
            "progress_percent": float(wo.progress_percent or 0),
            "po_value": float(wo.po_value or 0),
            "wo_value": float(wo.wo_value or 0),
            "created_month": str(_to_date(wo.po_date) or _to_date(wo.created_at) or "")[:7],
            "next_due_month": str(next_due)[:7] if next_due else "",
            "is_overdue": bool(days_to_due is not None and days_to_due < 0 and status_value not in ("Completed", "Closed", "Cancelled")),
            "payment_status": rollup.get("payment_status", "Pending"),
            "total_invoiced": float(rollup.get("total_invoiced", 0)),
            "total_paid": float(rollup.get("total_paid", 0)),
            "due_invoice_amount": float(rollup.get("due_invoice_amount", 0)),
        })

    page_user_ids = {
        uid for uid in
        [wo.project_manager_id for wo, _, _, _, _, _ in page_rows] +
        [wo.created_by for wo, _, _, _, _, _ in page_rows]
        if uid
    }
    user_cache = {
        int(u.id): u.full_name
        for u in db.query(User.id, User.full_name).filter(User.id.in_(page_user_ids)).all()
    } if page_user_ids else {}

    # source_id → name map (tenders store source_id; source_portal is rarely
    # set and defaults to "Other" — prefer the resolved lead-source name)
    page_wo_source_ids = {int(sid) for _, _, _, _, _, sid in page_rows if sid}
    page_wo_source_map: dict[int, str] = {}
    if page_wo_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(page_wo_source_ids)).all():
            page_wo_source_map[int(ls.id)] = ls.name

    page_lead_ids_wo = {int(wo.lead_id) for wo, *_ in page_rows if wo.lead_id}
    page_tender_ids_wo = {int(wo.tender_id) for wo, *_ in page_rows if wo.tender_id}
    tender_po_doc_map: dict[int, str] = {}
    if page_tender_ids_wo:
        for tender_id, po_doc in db.query(Tender.id, Tender.po_doc).filter(Tender.id.in_(page_tender_ids_wo)).all():
            tender_po_doc_map[int(tender_id)] = po_doc or ""

    consignee_counts_by_tender: dict[int, int] = {}
    if page_tender_ids_wo:
        for tender_id, count in (
            db.query(TenderConsignee.tender_id, func.count(TenderConsignee.id))
            .filter(TenderConsignee.tender_id.in_(page_tender_ids_wo))
            .group_by(TenderConsignee.tender_id)
            .all()
        ):
            if tender_id:
                consignee_counts_by_tender[int(tender_id)] = int(count or 0)

    consignee_counts_by_lead: dict[int, int] = {}
    if page_lead_ids_wo:
        for lead_id, count in (
            db.query(TenderConsignee.lead_id, func.count(TenderConsignee.id))
            .filter(TenderConsignee.lead_id.in_(page_lead_ids_wo))
            .group_by(TenderConsignee.lead_id)
            .all()
        ):
            if lead_id:
                consignee_counts_by_lead[int(lead_id)] = int(count or 0)

    wo_lead_bv: dict[int, int] = {}
    if page_lead_ids_wo:
        for lid, bv_id in db.query(Lead.id, Lead.business_vertical_id).filter(Lead.id.in_(page_lead_ids_wo)).all():
            if bv_id:
                wo_lead_bv[int(lid)] = int(bv_id)
    _wo_bv_ids = set(wo_lead_bv.values())
    bv_name_map = _resolve_business_vertical_names(db, _wo_bv_ids)
    bv_group_map = _resolve_business_vertical_parent_names(db, _wo_bv_ids)

    data: list[dict] = []
    for wo, customer_segment_value, tender_num_value, tender_result_value, source_portal_value, source_id_value in page_rows:
        rollup = rollups.get(int(wo.id), {})
        delivery_dt = _to_date(wo.delivery_date)
        completion_dt = _to_date(wo.completion_date)
        next_due = completion_dt or delivery_dt
        days_to_due = (next_due - today).days if next_due else None
        warranty_dt = _to_date(wo.warranty_expiry)
        days_to_warranty = (warranty_dt - today).days if warranty_dt else None
        _bv_id = wo_lead_bv.get(int(wo.lead_id or 0)) if wo.lead_id else None
        tender_id = int(wo.tender_id or 0) if wo.tender_id else 0
        lead_id = int(wo.lead_id or 0) if wo.lead_id else 0
        po_doc_value = wo.po_doc or tender_po_doc_map.get(tender_id, "") or ""
        po_document_url_value = wo.po_document_url or ""
        consignee_count = consignee_counts_by_tender.get(tender_id, 0) or consignee_counts_by_lead.get(lead_id, 0)
        declared_consignee_count = int(wo.no_of_consignee or 0)
        consignee_display_count = int(consignee_count or declared_consignee_count or 0)
        data.append({
            "id": wo.id,
            "tender_id": wo.tender_id,
            "lead_id": wo.lead_id,
            "wo_number": wo.wo_number or "",
            "project_title": wo.project_title or "",
            "customer_name": wo.customer_name or "",
            "customer_segment": _clean_segment_name(customer_segment_value),
            "tender_num": tender_num_value or "",
            "tender_result": tender_result_value or "",
            "source_portal": page_wo_source_map.get(int(source_id_value or 0), None) or str(source_portal_value or ""),
            "wo_type": wo.wo_type or "",
            "status": wo.status or "",
            "progress_percent": float(wo.progress_percent or 0),
            "po_number": wo.po_number or "",
            "po_date": str(wo.po_date) if wo.po_date else "",
            "po_value": float(wo.po_value or 0),
            "wo_value": float(wo.wo_value or 0),
            "delivery_date": str(wo.delivery_date) if wo.delivery_date else "",
            "installation_date": str(wo.installation_date) if wo.installation_date else "",
            "completion_date": str(wo.completion_date) if wo.completion_date else "",
            "days_to_due": days_to_due,
            "no_of_consignee": declared_consignee_count,
            "consignee_count": int(consignee_count or 0),
            "consignee_display_count": consignee_display_count,
            "site_location": wo.site_location or "",
            "site_engineer": wo.site_engineer or "",
            "project_manager": user_cache.get(int(wo.project_manager_id), "") if wo.project_manager_id else "",
            "advance_percent": float(wo.advance_percent or 0),
            "advance_amount": float(wo.advance_amount or 0),
            "advance_received": "Yes" if wo.advance_received else "No",
            "retention_percent": float(wo.retention_percent or 0),
            "retention_released": "Yes" if wo.retention_released else "No",
            "warranty_months": int(wo.warranty_months or 0),
            "warranty_expiry": str(wo.warranty_expiry) if wo.warranty_expiry else "",
            "days_to_warranty": days_to_warranty,
            "products": rollup.get("products", ""),
            "delivery_status": rollup.get("delivery_status", "Pending"),
            "total_ordered_qty": float(rollup.get("total_ordered_qty", 0)),
            "total_delivered_qty": float(rollup.get("total_delivered_qty", 0)),
            "payment_status": rollup.get("payment_status", "Pending"),
            "invoice_count": int(rollup.get("invoice_count", 0)),
            "total_invoiced": float(rollup.get("total_invoiced", 0)),
            "total_paid": float(rollup.get("total_paid", 0)),
            "due_invoice_amount": float(rollup.get("due_invoice_amount", 0)),
            "payment_terms": wo.payment_terms or "",
            "scope_of_work": (wo.scope_of_work or "")[:200],
            "notes": (wo.notes or "")[:200],
            "po_doc": po_doc_value,
            "po_document_url": po_document_url_value,
            "document_url": po_document_url_value or po_doc_value,
            "has_po_document": bool(po_doc_value or po_document_url_value),
            "document_count": 1 if (po_doc_value or po_document_url_value) else 0,
            "created_by": user_cache.get(int(wo.created_by), "") if wo.created_by else "",
            "created_at": str(wo.created_at)[:10] if wo.created_at else "",
            "business_vertical": bv_name_map.get(int(_bv_id or 0), "") if _bv_id else "",
            "business_vertical_group": bv_group_map.get(int(_bv_id or 0), "") if _bv_id else "",
        })

    if export:
        return _export(data, "workorders_report", export)

    total_invoiced = sum(item["total_invoiced"] for item in analytics_items)
    total_paid = sum(item["total_paid"] for item in analytics_items)
    completed_value = sum(
        item["wo_value"] for item in analytics_items if item["status"] in ("Completed", "Closed")
    )
    summary = {
        "total": len(analytics_items),
        "total_po_value": round(sum(item["po_value"] for item in analytics_items), 2),
        "total_wo_value": round(sum(item["wo_value"] for item in analytics_items), 2),
        "in_progress": sum(1 for item in analytics_items if item["status"] == "In Progress"),
        "completed": sum(1 for item in analytics_items if item["status"] in ("Completed", "Closed")),
        "completed_value": round(completed_value, 2),
        "delayed": sum(1 for item in analytics_items if item["status"] == "Delayed"),
        "overdue": sum(1 for item in analytics_items if item["is_overdue"]),
        "pending_collection": sum(1 for item in analytics_items if item["payment_status"] in ("Pending", "Partial", "Overdue")),
        "avg_progress": round(sum(item["progress_percent"] for item in analytics_items) / len(analytics_items), 1) if analytics_items else 0,
        "collection_rate": round((total_paid / total_invoiced) * 100, 1) if total_invoiced else 0,
        "total_invoiced_amount": round(total_invoiced, 2),
        "total_amount_received": round(total_paid, 2),
        "invoice_due_amount": round(sum(item["due_invoice_amount"] for item in analytics_items), 2),
    }

    timeline_map: dict[str, dict] = defaultdict(lambda: {"count": 0, "wo_value": 0.0, "po_value": 0.0})
    due_map: dict[str, dict] = defaultdict(lambda: {"count": 0, "wo_value": 0.0})
    scatter_data: list[dict] = []
    outstanding_by_customer: dict[str, float] = defaultdict(float)

    for item in analytics_items:
        if item["created_month"]:
            timeline_map[item["created_month"]]["count"] += 1
            timeline_map[item["created_month"]]["wo_value"] += item["wo_value"]
            timeline_map[item["created_month"]]["po_value"] += item["po_value"]
        if item["next_due_month"] and item["status"] not in ("Completed", "Closed", "Cancelled"):
            due_map[item["next_due_month"]]["count"] += 1
            due_map[item["next_due_month"]]["wo_value"] += item["wo_value"]
        if item["wo_value"] > 0:
            scatter_data.append({
                "label": item["wo_number"],
                "customer_name": item["customer_name"],
                "status": item["status"],
                "progress": item["progress_percent"],
                "value": item["wo_value"],
                "due": item["due_invoice_amount"],
            })
        if item["customer_name"] and item["due_invoice_amount"] > 0:
            outstanding_by_customer[item["customer_name"]] += item["due_invoice_amount"]

    chart_outstanding_by_customer = sorted(
        [{"name": name, "value": round(value, 2)} for name, value in outstanding_by_customer.items()],
        key=lambda item: -item["value"],
    )[:10]

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_timeline": sorted(
            [{"label": label, **payload} for label, payload in timeline_map.items()],
            key=lambda item: item["label"],
        ),
        "chart_due_timeline": sorted(
            [{"label": label, **payload} for label, payload in due_map.items()],
            key=lambda item: item["label"],
        ),
        "chart_progress_scatter": sorted(scatter_data, key=lambda item: item["value"], reverse=True)[:120],
        "chart_value_vs_received": {
            "wo_value": summary["total_wo_value"],
            "received": summary["total_amount_received"],
        },
        "chart_outstanding_by_customer": chart_outstanding_by_customer,
    }


# Legacy implementation kept as fallback reference during the report redesign.
def report_emdbg_legacy(
    instrument_type: Optional[str] = None,
    status: Optional[str] = None,
    expiry_days: Optional[int] = None,
    bank_name: Optional[str] = None,
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    # EMD/BG is expiry-driven — no date range default (show all active by default)
    q = db.query(EMDBG)
    if instrument_type:
        q = q.filter(EMDBG.instrument_type == instrument_type)
    if status:
        q = q.filter(EMDBG.status == status)
    if bank_name:
        q = q.filter(EMDBG.bank_name.ilike(f"%{bank_name}%"))
    rows = q.filter(EMDBG.expiry_date != None).order_by(EMDBG.expiry_date.asc()).all()
    today = today_ist()
    data = []
    for r in rows:
        days = (r.expiry_date - today).days
        if expiry_days is not None and days > expiry_days:
            continue
        data.append({
            "reference_num": r.reference_num,
            "tender_num": r.tender_num or "",
            "client_name": r.client_name,
            "instrument_type": r.instrument_type,
            "instrument_number": r.instrument_number or "",
            "amount": float(r.amount),
            "wo_value": float(r.wo_value or 0),
            "bank_name": r.bank_name or "",
            "bank_branch": r.bank_branch or "",
            "issued_date": str(r.issued_date) if r.issued_date else "",
            "submitted_date": str(r.submitted_date) if r.submitted_date else "",
            "valid_from": str(r.valid_from) if r.valid_from else "",
            "expiry_date": str(r.expiry_date),
            "status": r.status,
            "renewal_status": r.renewal_status or "none",
            "renewal_date": str(r.renewal_date) if r.renewal_date else "",
            "release_date": str(r.release_date) if r.release_date else "",
            "po_number": r.po_number or "",
            "currency": r.currency or "INR",
            "purpose": (r.purpose or "")[:200],
            "notes": (r.notes or "")[:200],
            "days_to_expiry": days,
            "expiry_status": (
                "Expired" if days < 0
                else "Critical" if days <= 7
                else "Warning" if days <= 30
                else "OK"
            ),
            "created_by": _username(db, r.created_by),
            "created_at": str(r.created_at)[:10] if r.created_at else "",
        })
    if export:
        return _export(data, "emdbg_report", export)
    summary = {
        "total": len(data),
        "total_amount": round(sum(d["amount"] for d in data), 2),
        "expired": sum(1 for d in data if d["expiry_status"] == "Expired"),
        "critical": sum(1 for d in data if d["expiry_status"] == "Critical"),
        "warning": sum(1 for d in data if d["expiry_status"] == "Warning"),
        "active_ok": sum(1 for d in data if d["expiry_status"] == "OK"),
    }
    chart_data = _chart(data, "expiry_status", "amount")
    chart_data2 = _chart(data, "instrument_type", "amount")
    return {"summary": summary, "chart_data": chart_data, "chart_data2": chart_data2, "data": data}


def _apply_emdbg_scope(q, scope_user_ids: Optional[list[int]], cu: User):
    role = _normalized_role(getattr(cu, "role", ""))
    if role == "accounts":
        return q.filter(EMDBG.approval_status == "approved")
    if scope_user_ids is None:
        return q
    return q.filter(or_(
        EMDBG.created_by.in_(scope_user_ids),
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))


def _emdbg_expiry_status(record_status: str, days_to_expiry: Optional[int]) -> str:
    if record_status == "Released":
        return "Released"
    if days_to_expiry is None:
        return "No Expiry"
    if days_to_expiry < 0:
        return "Expired"
    if days_to_expiry <= 7:
        return "Critical"
    if days_to_expiry <= 30:
        return "Warning"
    return "OK"


def _apply_emdbg_filters(q, params: dict, db: Session):
    if params.get("instrument_type"):
        q = q.filter(EMDBG.instrument_type.in_(_split_csv_strings(params["instrument_type"])))
    if params.get("status"):
        q = q.filter(EMDBG.status.in_(_split_csv_strings(params["status"])))
    if params.get("approval_status"):
        q = q.filter(EMDBG.approval_status.in_(_split_csv_strings(params["approval_status"])))
    if params.get("finance_status"):
        q = q.filter(EMDBG.finance_status.in_(_split_csv_strings(params["finance_status"])))
    if params.get("return_status"):
        q = q.filter(EMDBG.return_status.in_(_split_csv_strings(params["return_status"])))
    if params.get("renewal_status"):
        q = q.filter(EMDBG.renewal_status.in_(_split_csv_strings(params["renewal_status"])))
    if params.get("customer_id"):
        q = q.filter(EMDBG.customer_id.in_(_split_csv_ints(params["customer_id"])))
    if params.get("customer_segment"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, _split_csv_strings(params["customer_segment"])) or [-1]))
    if params.get("business_vertical_id"):
        vals = _split_csv_ints(params["business_vertical_id"])
        if vals:
            q = q.filter(Lead.business_vertical_id.in_(vals))
    if params.get("work_order_id"):
        q = q.filter(EMDBG.work_order_id.in_(_split_csv_ints(params["work_order_id"])))
    if params.get("source_portal"):
        q = q.filter(Tender.source_portal.in_(_split_csv_strings(params["source_portal"])))
    if params.get("tender_result"):
        q = q.filter(Tender.result.in_(_split_csv_strings(params["tender_result"])))
    if params.get("bank_name"):
        q = q.filter(EMDBG.bank_name.in_(_split_csv_strings(params["bank_name"])))
    if params.get("created_by"):
        q = q.filter(EMDBG.created_by.in_(_split_csv_ints(params["created_by"])))
    if params.get("amount_min") is not None:
        q = q.filter(EMDBG.amount >= params["amount_min"])
    if params.get("amount_max") is not None:
        q = q.filter(EMDBG.amount <= params["amount_max"])
    if params.get("wo_value_min") is not None:
        q = q.filter(EMDBG.wo_value >= params["wo_value_min"])
    if params.get("wo_value_max") is not None:
        q = q.filter(EMDBG.wo_value <= params["wo_value_max"])
    if params.get("issued_from"):
        q = q.filter(EMDBG.issued_date >= params["issued_from"])
    if params.get("issued_to"):
        q = q.filter(EMDBG.issued_date <= params["issued_to"])
    if params.get("expiry_from"):
        q = q.filter(EMDBG.expiry_date >= params["expiry_from"])
    if params.get("expiry_to"):
        q = q.filter(EMDBG.expiry_date <= params["expiry_to"])
    if params.get("expiry_days") is not None:
        cutoff = today_ist() + timedelta(days=int(params["expiry_days"]))
        q = q.filter(EMDBG.expiry_date != None, EMDBG.expiry_date <= cutoff)
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            EMDBG.reference_num.ilike(term),
            EMDBG.tender_num.ilike(term),
            EMDBG.client_name.ilike(term),
            EMDBG.instrument_number.ilike(term),
            EMDBG.bank_name.ilike(term),
            EMDBG.po_number.ilike(term),
            Customer.customer_name.ilike(term),
            WorkOrder.wo_number.ilike(term),
            Tender.tender_title.ilike(term),
        ))
    return q


@router.get("/emdbg/filter-options")
def emdbg_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    workorders = db.query(WorkOrder.id, WorkOrder.wo_number).order_by(WorkOrder.wo_number).all()
    segments = [
        row[0] for row in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_vertical).all()
    ]
    banks = [
        row[0] for row in db.query(EMDBG.bank_name).filter(
            EMDBG.bank_name != None,
            EMDBG.bank_name != "",
        ).distinct().order_by(EMDBG.bank_name).all()
    ]
    portals = [
        row[0] for row in db.query(Tender.source_portal)
        .join(EMDBG, EMDBG.tender_id == Tender.id)
        .filter(Tender.source_portal != None, Tender.source_portal != "")
        .distinct().order_by(Tender.source_portal).all()
    ]
    results = [
        row[0] for row in db.query(Tender.result)
        .join(EMDBG, EMDBG.tender_id == Tender.id)
        .filter(Tender.result != None, Tender.result != "")
        .distinct().order_by(Tender.result).all()
    ]
    finance_statuses = [
        row[0] for row in db.query(EMDBG.finance_status).filter(
            EMDBG.finance_status != None,
            EMDBG.finance_status != "",
        ).distinct().order_by(EMDBG.finance_status).all()
    ]
    return_statuses = [
        row[0] for row in db.query(EMDBG.return_status).filter(
            EMDBG.return_status != None,
            EMDBG.return_status != "",
        ).distinct().order_by(EMDBG.return_status).all()
    ]
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        emdbg_business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        emdbg_business_verticals = []
    emdbg_vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "workorders": [{"id": w.id, "name": w.wo_number} for w in workorders],
        "segments": segments,
        "banks": _unique_strings(banks),
        "portals": _unique_strings(portals),
        "results": _unique_strings(results) or ["Pending", "Won", "Lost", "Cancelled"],
        "statuses": ["Active", "Expired", "Released", "Encashed", "Renewed", "Cancelled"],
        "instrument_types": ["EMD", "Performance BG", "Security Deposit", "Advance BG", "Retention BG", "DD", "Online Payment"],
        "approval_statuses": ["none", "pending", "approved", "rejected"],
        "finance_statuses": _unique_strings(finance_statuses) or ["unpaid", "paid"],
        "return_statuses": _unique_strings(return_statuses) or ["none"],
        "renewal_statuses": ["none", "pending", "renewed"],
        "business_verticals": emdbg_business_verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in emdbg_vertical_sectors],
    }


@router.get("/emdbg")
def report_emdbg(
    instrument_type: Optional[str] = None,
    status: Optional[str] = None,
    approval_status: Optional[str] = None,
    finance_status: Optional[str] = None,
    return_status: Optional[str] = None,
    renewal_status: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    work_order_id: Optional[str] = None,
    source_portal: Optional[str] = None,
    tender_result: Optional[str] = None,
    bank_name: Optional[str] = None,
    created_by: Optional[str] = None,
    search: Optional[str] = None,
    expiry_days: Optional[int] = None,
    issued_from: Optional[str] = None,
    issued_to: Optional[str] = None,
    expiry_from: Optional[str] = None,
    expiry_to: Optional[str] = None,
    amount_min: Optional[float] = None,
    amount_max: Optional[float] = None,
    wo_value_min: Optional[float] = None,
    wo_value_max: Optional[float] = None,
    business_vertical_id: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "expiry_date",
    sort_dir: Optional[str] = "asc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    filter_params = {
        "instrument_type": instrument_type,
        "status": status,
        "approval_status": approval_status,
        "finance_status": finance_status,
        "return_status": return_status,
        "renewal_status": renewal_status,
        "customer_id": customer_id,
        "customer_segment": customer_segment,
        "work_order_id": work_order_id,
        "source_portal": source_portal,
        "tender_result": tender_result,
        "bank_name": bank_name,
        "created_by": created_by,
        "search": search,
        "expiry_days": expiry_days,
        "issued_from": issued_from,
        "issued_to": issued_to,
        "expiry_from": expiry_from,
        "expiry_to": expiry_to,
        "amount_min": amount_min,
        "amount_max": amount_max,
        "wo_value_min": wo_value_min,
        "wo_value_max": wo_value_max,
        "business_vertical_id": business_vertical_id,
    }

    scope_user_ids = _report_scope_user_ids(db, cu)
    base_q = (
        db.query(
            EMDBG,
            Customer.customer_name.label("customer_name"),
            Customer.customer_vertical.label("customer_segment"),
            WorkOrder.wo_number.label("wo_number"),
            WorkOrder.status.label("workorder_status"),
            Tender.source_portal.label("source_portal"),
            Tender.source_id.label("source_id"),
            Tender.result.label("tender_result"),
            Tender.tender_title.label("tender_title"),
            Tender.business_vertical_id.label("tender_business_vertical_id"),
            Lead.business_vertical_id.label("lead_business_vertical_id"),
        )
        .outerjoin(Customer, EMDBG.customer_id == Customer.id)
        .outerjoin(WorkOrder, EMDBG.work_order_id == WorkOrder.id)
        .outerjoin(Lead, WorkOrder.lead_id == Lead.id)
        .outerjoin(Tender, EMDBG.tender_id == Tender.id)
    )
    base_q = _apply_emdbg_scope(base_q, scope_user_ids, cu)
    base_q = _apply_emdbg_filters(base_q, filter_params, db)
    total_count = base_q.count()

    # Business vertical names — resolved once for the ids present in this result set
    _bv_ids_seen: set = set()
    business_vertical_name_map: dict = {}

    sort_map = {
        "reference_num": EMDBG.reference_num,
        "client_name": EMDBG.client_name,
        "instrument_type": EMDBG.instrument_type,
        "amount": EMDBG.amount,
        "wo_value": EMDBG.wo_value,
        "bank_name": EMDBG.bank_name,
        "issued_date": EMDBG.issued_date,
        "expiry_date": EMDBG.expiry_date,
        "status": EMDBG.status,
        "approval_status": EMDBG.approval_status,
        "finance_status": EMDBG.finance_status,
        "created_at": EMDBG.created_at,
    }
    sort_col = sort_map.get(str(sort_by or "expiry_date"), EMDBG.expiry_date)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()
    today = today_ist()

    # Resolve business vertical names for every unit id present in this result set.
    # Prefer the Tender's own business_vertical_id (works for direct tenders too);
    # fall back to the linked Lead's for older/lead-converted tenders.
    for row in analytics_rows:
        bv_id = row[-2] or row[-1]
        if bv_id:
            _bv_ids_seen.add(int(bv_id))
    if _bv_ids_seen:
        try:
            id_csv = ", ".join(str(i) for i in _bv_ids_seen)
            bv_name_rows = db.execute(text(
                f"SELECT id, COALESCE(business_unit, business_vertical) AS vname"
                f" FROM business_category_units WHERE id IN ({id_csv})"
            )).mappings().all()
            for r in bv_name_rows:
                business_vertical_name_map[r["id"]] = (r["vname"] or "").strip() or f"Vertical {r['id']}"
        except Exception:
            pass

    analytics_items: list[dict] = []
    for rec, customer_name_value, _, _, _, _, _, _, _, tender_bv_id_value, lead_bv_id_value in analytics_rows:
        bv_id_value = tender_bv_id_value or lead_bv_id_value
        expiry_dt = _to_date(rec.expiry_date)
        days_to_expiry = (expiry_dt - today).days if expiry_dt else None
        expiry_status_value = _emdbg_expiry_status(str(rec.status or ""), days_to_expiry)
        category_value = _emdbg_category_from_type(rec.instrument_type)
        analytics_items.append({
            "id": rec.id,
            "customer_id": rec.customer_id,
            "customer_name": customer_name_value or rec.client_name or "",
            "reference_num": rec.reference_num or "",
            "client_name": rec.client_name or "",
            "instrument_type": rec.instrument_type or "",
            "category": category_value,
            "amount": float(rec.amount or 0),
            "wo_value": float(rec.wo_value or 0),
            "status": rec.status or "",
            "approval_status": rec.approval_status or "none",
            "finance_status": rec.finance_status or "",
            "return_status": rec.return_status or "",
            "issued_month": str(_to_date(rec.issued_date) or "")[:7],
            "renewal_month": str(_to_date(rec.renewal_date) or "")[:7],
            "release_month": str(_to_date(rec.release_date) or "")[:7],
            "expiry_month": str(expiry_dt or "")[:7],
            "days_to_expiry": days_to_expiry,
            "expiry_status": expiry_status_value,
            "instrument_document_url": rec.instrument_document_url or "",
            "instrument_acknowledged": bool(rec.instrument_acknowledged_at),
            "payment_proof_url": rec.payment_proof_url or "",
            "business_vertical": business_vertical_name_map.get(int(bv_id_value)) if bv_id_value else "",
        })

    page_user_ids = {rec.created_by for rec, *_ in page_rows if getattr(rec, "created_by", None)}
    user_cache = {
        int(u.id): u.full_name
        for u in db.query(User.id, User.full_name).filter(User.id.in_(page_user_ids)).all()
    } if page_user_ids else {}

    # source_id → name map (tenders store source_id; source_portal is rarely
    # set and defaults to "Other" — prefer the resolved lead-source name)
    page_emdbg_source_ids = {int(row[6]) for row in page_rows if row[6]}
    page_emdbg_source_map: dict[int, str] = {}
    if page_emdbg_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(page_emdbg_source_ids)).all():
            page_emdbg_source_map[int(ls.id)] = ls.name

    data: list[dict] = []
    for rec, customer_name_value, customer_segment_value, wo_number_value, workorder_status_value, source_portal_value, source_id_value, tender_result_value, tender_title_value, tender_bv_id_value, lead_bv_id_value in page_rows:
        bv_id_value = tender_bv_id_value or lead_bv_id_value
        expiry_dt = _to_date(rec.expiry_date)
        days_to_expiry = (expiry_dt - today).days if expiry_dt else None
        expiry_status_value = _emdbg_expiry_status(str(rec.status or ""), days_to_expiry)
        data.append({
            "id": rec.id,
            "customer_id": rec.customer_id,
            "tender_id": rec.tender_id,
            "reference_num": rec.reference_num or "",
            "tender_num": rec.tender_num or "",
            "client_name": rec.client_name or "",
            "customer_name": customer_name_value or rec.client_name or "",
            "customer_segment": _clean_segment_name(customer_segment_value),
            "business_vertical": business_vertical_name_map.get(int(bv_id_value)) if bv_id_value else "",
            "wo_number": wo_number_value or "",
            "workorder_status": workorder_status_value or "",
            "source_portal": page_emdbg_source_map.get(int(source_id_value or 0), None) or str(source_portal_value or ""),
            "tender_result": tender_result_value or "",
            "tender_title": tender_title_value or "",
            "instrument_type": rec.instrument_type or "",
            "instrument_number": rec.instrument_number or "",
            "amount": float(rec.amount or 0),
            "wo_value": float(rec.wo_value or 0),
            "bank_name": rec.bank_name or "",
            "bank_branch": rec.bank_branch or "",
            "issued_date": str(rec.issued_date) if rec.issued_date else "",
            "submitted_date": str(rec.submitted_date) if rec.submitted_date else "",
            "valid_from": str(rec.valid_from) if rec.valid_from else "",
            "expiry_date": str(rec.expiry_date) if rec.expiry_date else "",
            "status": rec.status or "",
            "approval_status": rec.approval_status or "none",
            "finance_status": rec.finance_status or "",
            "return_status": rec.return_status or "",
            "instrument_document_url": rec.instrument_document_url or "",
            "instrument_acknowledged": bool(rec.instrument_acknowledged_at),
            "payment_proof_url": rec.payment_proof_url or "",
            "renewal_status": rec.renewal_status or "none",
            "renewal_date": str(rec.renewal_date) if rec.renewal_date else "",
            "release_date": str(rec.release_date) if rec.release_date else "",
            "po_number": rec.po_number or "",
            "currency": rec.currency or "INR",
            "purpose": (rec.purpose or "")[:200],
            "notes": (rec.notes or "")[:200],
            "days_to_expiry": days_to_expiry,
            "expiry_status": expiry_status_value,
            "created_by": user_cache.get(int(rec.created_by), "") if rec.created_by else "",
            "created_at": str(rec.created_at)[:10] if rec.created_at else "",
        })

    if export:
        return _export(data, "emdbg_report", export)

    # EMD/BG has no "paid amount" concept — the meaningful financial states are
    # blocked (Active/Renewed — capital currently held), released, and
    # encashed (the bank paid out against the guarantee).
    summary = {
        "total": len(analytics_items),
        "total_amount": round(sum(item["amount"] for item in analytics_items), 2),
        "active": sum(1 for item in analytics_items if item["status"] in ("Active", "Renewed")),
        "active_amount": round(
            sum(item["amount"] for item in analytics_items if item["status"] in ("Active", "Renewed")), 2
        ),
        "critical": sum(1 for item in analytics_items if item["expiry_status"] == "Critical"),
        "expiring_30": sum(1 for item in analytics_items if item["expiry_status"] in ("Critical", "Warning")),
        "expiring_amount": round(
            sum(item["amount"] for item in analytics_items if item["expiry_status"] in ("Critical", "Warning")), 2
        ),
        "expired": sum(1 for item in analytics_items if item["expiry_status"] == "Expired"),
        "released": sum(1 for item in analytics_items if item["status"] == "Released"),
        "released_amount": round(
            sum(item["amount"] for item in analytics_items if item["status"] == "Released"), 2
        ),
        "encashed": sum(1 for item in analytics_items if item["status"] == "Encashed"),
        "encashed_amount": round(
            sum(item["amount"] for item in analytics_items if item["status"] == "Encashed"), 2
        ),
        "pending_approval": sum(1 for item in analytics_items if item["approval_status"] == "pending"),
        "unpaid": sum(1 for item in analytics_items if item["finance_status"] not in ("paid", "Paid")),
    }

    expiry_timeline: dict[str, dict] = defaultdict(lambda: {"count": 0, "amount": 0.0})
    lifecycle_timeline: dict[str, dict] = defaultdict(lambda: {"issued": 0, "renewed": 0, "released": 0})
    scatter_data: list[dict] = []
    expiry_bucket_amounts = {"30": 0.0, "60": 0.0, "90": 0.0}

    for item in analytics_items:
        if item["expiry_month"]:
            expiry_timeline[item["expiry_month"]]["count"] += 1
            expiry_timeline[item["expiry_month"]]["amount"] += item["amount"]
        if item["issued_month"]:
            lifecycle_timeline[item["issued_month"]]["issued"] += 1
        if item["renewal_month"]:
            lifecycle_timeline[item["renewal_month"]]["renewed"] += 1
        if item["release_month"]:
            lifecycle_timeline[item["release_month"]]["released"] += 1
        if item["days_to_expiry"] is not None:
            scatter_data.append({
                "label": item["reference_num"],
                "client_name": item["client_name"],
                "type": item["instrument_type"],
                "status": item["status"],
                "days": item["days_to_expiry"],
                "amount": item["amount"],
                "wo_value": item["wo_value"],
            })
            days = item["days_to_expiry"]
            if 0 <= days <= 30:
                expiry_bucket_amounts["30"] += item["amount"]
            elif 30 < days <= 60:
                expiry_bucket_amounts["60"] += item["amount"]
            elif 60 < days <= 90:
                expiry_bucket_amounts["90"] += item["amount"]

    chart_expiry_buckets = [
        {"bucket": "0-30 days", "amount": round(expiry_bucket_amounts["30"], 2)},
        {"bucket": "31-60 days", "amount": round(expiry_bucket_amounts["60"], 2)},
        {"bucket": "61-90 days", "amount": round(expiry_bucket_amounts["90"], 2)},
    ]

    return {
        "summary": summary,
        "customer_action_summary": _build_emdbg_customer_action_summary(analytics_items),
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_expiry_timeline": sorted(
            [{"label": label, **payload} for label, payload in expiry_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_lifecycle_timeline": sorted(
            [{"label": label, **payload} for label, payload in lifecycle_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_risk_scatter": sorted(scatter_data, key=lambda item: (abs(item["days"]), -item["amount"]))[:150],
        "chart_blocked_released_encashed": {
            "blocked": summary["active_amount"],
            "released": summary["released_amount"],
            "encashed": summary["encashed_amount"],
        },
        "chart_expiry_buckets": chart_expiry_buckets,
    }


# Legacy implementation kept as fallback reference while the dedicated report view uses the richer endpoint below.
def report_kam_legacy(
    user_id: Optional[int] = None,
    period: Optional[str] = None,
    activity_type: Optional[str] = None,
    mode: Optional[str] = None,
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    # Default to current month — already did this before, kept as-is
    if not period:
        period = now_ist().strftime("%Y-%m")
    year, month = int(period.split("-")[0]), int(period.split("-")[1])
    last_day = calendar.monthrange(year, month)[1]
    q = db.query(KAMActivity).filter(
        KAMActivity.activity_date.between(f"{period}-01", f"{period}-{last_day:02d}")
    )
    if user_id:
        q = q.filter(KAMActivity.user_id == user_id)
    elif cu.role not in ("admin", "ceo", "manager"):
        q = q.filter(KAMActivity.user_id == cu.id)
    if activity_type:
        q = q.filter(KAMActivity.activity_type == activity_type)
    if mode:
        q = q.filter(KAMActivity.mode == mode)
    rows = q.order_by(KAMActivity.activity_date.desc()).all()
    data = [
        {
            "user": _username(db, r.user_id),
            "activity_type": r.activity_type,
            "subject": r.subject,
            "description": (r.description or "")[:200],
            "status": r.status or "",
            "activity_date": str(r.activity_date),
            "mode": r.mode or "",
            "duration_minutes": r.duration_minutes or 0,
            "location": r.location or "",
            "outcome": r.outcome or "",
            "next_action": r.next_action or "",
            "next_action_date": str(r.next_action_date) if r.next_action_date else "",
            "contacts_met": r.contacts_met or "",
            "has_travel": "Yes" if r.has_travel else "No",
            "travel_from": r.travel_from or "",
            "travel_to": r.travel_to or "",
            "travel_mode": r.travel_mode or "",
            "cancellation_reason": r.cancellation_reason or "",
            "created_at": str(r.created_at)[:10] if r.created_at else "",
        }
        for r in rows
    ]
    if export:
        return _export(data, "kam_report", export)
    total = len(data)
    completed = sum(1 for d in data if d["status"] == "Completed")
    summary = {
        "total": total,
        "completed": completed,
        "pending": sum(1 for d in data if d["status"] not in ("Completed", "Cancelled")),
        "cancelled": sum(1 for d in data if d["status"] == "Cancelled"),
        "completion_rate": round(completed / total * 100, 1) if total else 0.0,
        "total_duration_hrs": round(sum(d["duration_minutes"] for d in data) / 60, 1),
        "with_travel": sum(1 for d in data if d["has_travel"] == "Yes"),
        "_period": period,
    }
    chart_data = _chart(data, "activity_type")
    chart_data2 = _chart(data, "mode")
    return {"summary": summary, "chart_data": chart_data, "chart_data2": chart_data2, "data": data}


# Legacy implementation kept as fallback reference while the dedicated report view uses the richer endpoint below.
def report_tada_legacy(
    status: Optional[str] = None,
    employee_id: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    payment_mode: Optional[str] = None,
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    # Default to current month when no date range is given
    if not date_from and not date_to:
        date_from, date_to = _current_month_range()

    q = db.query(TADAClaim)
    if cu.role == "accounts":
        q = q.filter(TADAClaim.overall_status.in_(["Manager Approved", "Accounts Approved", "Paid"]))
    elif cu.role not in ("admin", "ceo"):
        q = q.filter(TADAClaim.employee_id == cu.id)
    if status:
        q = q.filter(TADAClaim.overall_status == status)
    if employee_id:
        q = q.filter(TADAClaim.employee_id == employee_id)
    if payment_mode:
        q = q.filter(TADAClaim.payment_mode == payment_mode)
    q = _date_filter(q, TADAClaim, "claim_date", date_from, date_to)
    rows = q.order_by(TADAClaim.claim_date.desc()).all()
    data = [
        {
            "claim_number": r.claim_number,
            "employee": _username(db, r.employee_id),
            "claim_date": str(r.claim_date),
            "travel_date_from": str(r.travel_date_from) if r.travel_date_from else "",
            "travel_date_to": str(r.travel_date_to) if r.travel_date_to else "",
            "purpose": r.purpose or "",
            "total_amount": float(r.total_amount or 0),
            "advance_taken": float(r.advance_taken or 0),
            "net_payable": float(r.net_payable or 0),
            "manager_status": r.manager_status or "",
            "accounts_status": r.accounts_status or "",
            "overall_status": r.overall_status,
            "payment_mode": r.payment_mode or "",
            "payment_reference": r.payment_reference or "",
            "payment_date": str(r.payment_date) if r.payment_date else "",
            "manager_approved_by": _username(db, r.manager_approved_by),
            "accounts_approved_by": _username(db, r.accounts_approved_by),
            "notes": (r.notes or "")[:200],
        }
        for r in rows
    ]
    if export:
        return _export(data, "tada_report", export)
    summary = {
        "total": len(data),
        "total_claimed": round(sum(d["total_amount"] for d in data), 2),
        "total_payable": round(sum(d["net_payable"] for d in data), 2),
        "paid": round(sum(d["net_payable"] for d in data if d["overall_status"] == "Paid"), 2),
        "pending_payment": round(
            sum(d["net_payable"] for d in data if d["overall_status"] == "Accounts Approved"), 2
        ),
        "rejected": sum(1 for d in data if d["overall_status"] == "Rejected"),
        "_date_from": date_from,
        "_date_to": date_to,
    }
    chart_data = _chart(data, "overall_status", "net_payable")
    chart_data2 = _chart(data, "employee", "net_payable")
    return {"summary": summary, "chart_data": chart_data, "chart_data2": chart_data2, "data": data}


# ─── AI-layer cross-module insights ───────────────────────────────────────────

def _bool_value(value):
    if isinstance(value, bool):
        return value
    text_value = str(value or "").strip().lower()
    if text_value in ("1", "true", "yes", "y"):
        return True
    if text_value in ("0", "false", "no", "n"):
        return False
    return None


def _opportunity_stage_label(status: str, approval_status: str) -> Optional[str]:
    approval = str(approval_status or "").strip().lower()
    if status == "Converted":
        return "Converted"
    if status != "Opportunity Created":
        return None
    if approval == "pending":
        return "Request Conversion"
    if approval in ("rejected", "rejected opportunity"):
        return "Rejected"
    return "Opportunity"


def _apply_kam_scope(q, scope_user_ids: Optional[list[int]]):
    if scope_user_ids is None:
        return q
    return q.filter(or_(
        KAMActivity.user_id.in_(scope_user_ids),
        KAMActivity.on_behalf_of.in_(scope_user_ids),
        KAMActivity.created_by.in_(scope_user_ids),
    ))


def _apply_kam_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(KAMActivity.activity_date >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(KAMActivity.activity_date <= params["date_to"])
    if params.get("user_id"):
        q = q.filter(KAMActivity.user_id.in_(_split_csv_ints(params["user_id"])))
    if params.get("on_behalf_of"):
        q = q.filter(KAMActivity.on_behalf_of.in_(_split_csv_ints(params["on_behalf_of"])))
    if params.get("created_by"):
        q = q.filter(KAMActivity.created_by.in_(_split_csv_ints(params["created_by"])))
    if params.get("customer_id"):
        q = q.filter(KAMActivity.customer_id.in_(_split_csv_ints(params["customer_id"])))
    if params.get("customer_segment"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, _split_csv_strings(params["customer_segment"])) or [-1]))
    if params.get("activity_type"):
        q = q.filter(KAMActivity.activity_type.in_(_split_csv_strings(params["activity_type"])))
    if params.get("status"):
        q = q.filter(KAMActivity.status.in_(_split_csv_strings(params["status"])))
    if params.get("mode"):
        q = q.filter(KAMActivity.mode.in_(_split_csv_strings(params["mode"])))
    if params.get("followup_category"):
        q = q.filter(KAMActivity.followup_category.in_(_split_csv_strings(params["followup_category"])))
    if params.get("travel_mode"):
        q = q.filter(KAMActivity.travel_mode.in_(_split_csv_strings(params["travel_mode"])))
    if params.get("travel_status"):
        q = q.filter(TravelRequest.status.in_(_split_csv_strings(params["travel_status"])))
    if params.get("customer_id"):
        q = q.filter(TravelRequest.customer_id.in_(_split_csv_ints(params["customer_id"])))
    has_travel = _bool_value(params.get("has_travel"))
    if has_travel is not None:
        q = q.filter(KAMActivity.has_travel == has_travel)
    if params.get("next_action_from"):
        q = q.filter(KAMActivity.next_action_date >= params["next_action_from"])
    if params.get("next_action_to"):
        q = q.filter(KAMActivity.next_action_date <= params["next_action_to"])
    if params.get("duration_min") is not None:
        q = q.filter(KAMActivity.duration_minutes >= params["duration_min"])
    if params.get("duration_max") is not None:
        q = q.filter(KAMActivity.duration_minutes <= params["duration_max"])
    if _bool_value(params.get("overdue_only")):
        today = today_ist()
        q = q.filter(
            KAMActivity.status.notin_(["Completed", "Cancelled"]),
            or_(
                and_(KAMActivity.next_action_date != None, KAMActivity.next_action_date < today),
                KAMActivity.activity_date < today,
            ),
        )
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            KAMActivity.subject.ilike(term),
            KAMActivity.description.ilike(term),
            KAMActivity.outcome.ilike(term),
            KAMActivity.next_action.ilike(term),
            Customer.customer_name.ilike(term),
            Lead.lead_title.ilike(term),
            TravelRequest.request_number.ilike(term),
        ))
    return q


@router.get("/kam/filter-options")
def kam_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    segments = [
        row[0] for row in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_vertical).all()
    ]
    activity_types = [
        row[0] for row in db.query(KAMActivity.activity_type).filter(
            KAMActivity.activity_type != None,
            KAMActivity.activity_type != "",
        ).distinct().order_by(KAMActivity.activity_type).all()
    ]
    statuses = [
        row[0] for row in db.query(KAMActivity.status).filter(
            KAMActivity.status != None,
            KAMActivity.status != "",
        ).distinct().order_by(KAMActivity.status).all()
    ]
    modes = [
        row[0] for row in db.query(KAMActivity.mode).filter(
            KAMActivity.mode != None,
            KAMActivity.mode != "",
        ).distinct().order_by(KAMActivity.mode).all()
    ]
    followup_categories = [
        row[0] for row in db.query(KAMActivity.followup_category).filter(
            KAMActivity.followup_category != None,
            KAMActivity.followup_category != "",
        ).distinct().order_by(KAMActivity.followup_category).all()
    ]
    travel_modes = [
        row[0] for row in db.query(KAMActivity.travel_mode).filter(
            KAMActivity.travel_mode != None,
            KAMActivity.travel_mode != "",
        ).distinct().order_by(KAMActivity.travel_mode).all()
    ]
    travel_statuses = [
        row[0] for row in db.query(TravelRequest.status).filter(
            TravelRequest.status != None,
            TravelRequest.status != "",
        ).distinct().order_by(TravelRequest.status).all()
    ]
    vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(
        VerticalSector.is_active == True,
    ).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "segments": _unique_strings(segments),
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in vertical_sectors],
        "activity_types": _unique_strings(activity_types),
        "statuses": _unique_strings(statuses) or ["Planned", "In Progress", "Completed", "Cancelled", "Postponed"],
        "modes": _unique_strings(modes) or ["In-Person", "Phone", "Video Call", "Email"],
        "followup_categories": _unique_strings(followup_categories),
        "travel_modes": _unique_strings(travel_modes),
        "travel_statuses": _unique_strings(travel_statuses),
    }


@router.get("/kam")
def report_kam(
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user_id: Optional[str] = None,
    on_behalf_of: Optional[str] = None,
    created_by: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    activity_type: Optional[str] = None,
    status: Optional[str] = None,
    mode: Optional[str] = None,
    followup_category: Optional[str] = None,
    travel_mode: Optional[str] = None,
    travel_status: Optional[str] = None,
    has_travel: Optional[str] = None,
    overdue_only: Optional[str] = None,
    next_action_from: Optional[str] = None,
    next_action_to: Optional[str] = None,
    duration_min: Optional[int] = None,
    duration_max: Optional[int] = None,
    search: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "activity_date",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, _, _ = _resolve_date_preset(preset, date_from, date_to)
    filter_params = {
        "date_from": df_str,
        "date_to": dt_str,
        "user_id": user_id,
        "on_behalf_of": on_behalf_of,
        "created_by": created_by,
        "customer_id": customer_id,
        "customer_segment": customer_segment,
        "activity_type": activity_type,
        "status": status,
        "mode": mode,
        "followup_category": followup_category,
        "travel_mode": travel_mode,
        "travel_status": travel_status,
        "has_travel": has_travel,
        "overdue_only": overdue_only,
        "next_action_from": next_action_from,
        "next_action_to": next_action_to,
        "duration_min": duration_min,
        "duration_max": duration_max,
        "search": search,
    }

    ActivityUser = aliased(User)
    OnBehalfUser = aliased(User)
    CreatedUser = aliased(User)
    scope_user_ids = _report_scope_user_ids(db, cu)

    base_q = (
        db.query(
            KAMActivity,
            ActivityUser.full_name.label("user_name"),
            OnBehalfUser.full_name.label("on_behalf_name"),
            CreatedUser.full_name.label("created_by_name"),
            Customer.customer_name.label("customer_name"),
            Customer.customer_vertical.label("customer_segment"),
            Lead.lead_title.label("lead_title"),
            Lead.lead_ref_id.label("lead_ref_id"),
            Lead.opportunity_ref_id.label("opportunity_ref_id"),
            TravelRequest.request_number.label("travel_request_number"),
            TravelRequest.status.label("travel_request_status"),
        )
        .outerjoin(ActivityUser, KAMActivity.user_id == ActivityUser.id)
        .outerjoin(OnBehalfUser, KAMActivity.on_behalf_of == OnBehalfUser.id)
        .outerjoin(CreatedUser, KAMActivity.created_by == CreatedUser.id)
        .outerjoin(Customer, KAMActivity.customer_id == Customer.id)
        .outerjoin(Lead, KAMActivity.lead_id == Lead.id)
        .outerjoin(TravelRequest, KAMActivity.travel_request_id == TravelRequest.id)
    )
    base_q = _apply_kam_scope(base_q, scope_user_ids)
    base_q = _apply_kam_filters(base_q, filter_params, db)
    total_count = base_q.count()

    sort_map = {
        "activity_date": KAMActivity.activity_date,
        "user": ActivityUser.full_name,
        "customer_name": Customer.customer_name,
        "subject": KAMActivity.subject,
        "status": KAMActivity.status,
        "duration_minutes": KAMActivity.duration_minutes,
        "next_action_date": KAMActivity.next_action_date,
        "created_at": KAMActivity.created_at,
    }
    sort_col = sort_map.get(str(sort_by or "activity_date"), KAMActivity.activity_date)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()
    today = today_ist()

    analytics_items: list[dict] = []
    for rec, user_name_value, on_behalf_name_value, created_by_name_value, customer_name_value, customer_segment_value, lead_title_value, lead_ref_id_value, opportunity_ref_id_value, travel_request_number_value, travel_request_status_value in analytics_rows:
        activity_dt = _to_date(rec.activity_date)
        next_dt = _to_date(rec.next_action_date)
        days_to_next = (next_dt - today).days if next_dt else None
        is_overdue = bool(
            str(rec.status or "") not in ("Completed", "Cancelled") and (
                (next_dt and next_dt < today) or (activity_dt and activity_dt < today)
            )
        )
        analytics_items.append({
            "user": user_name_value or "",
            "customer_name": customer_name_value or "",
            "status": rec.status or "",
            "activity_day": str(activity_dt) if activity_dt else "",
            "next_action_day": str(next_dt) if next_dt else "",
            "duration_minutes": int(rec.duration_minutes or 0),
            "has_travel": bool(rec.has_travel),
            "days_to_next": days_to_next,
            "is_overdue": is_overdue,
        })

    data: list[dict] = []
    for rec, user_name_value, on_behalf_name_value, created_by_name_value, customer_name_value, customer_segment_value, lead_title_value, lead_ref_id_value, opportunity_ref_id_value, travel_request_number_value, travel_request_status_value in page_rows:
        activity_dt = _to_date(rec.activity_date)
        next_dt = _to_date(rec.next_action_date)
        days_to_next = (next_dt - today).days if next_dt else None
        is_overdue = bool(
            str(rec.status or "") not in ("Completed", "Cancelled") and (
                (next_dt and next_dt < today) or (activity_dt and activity_dt < today)
            )
        )
        data.append({
            "id": rec.id,
            "user": user_name_value or "",
            "on_behalf_of": on_behalf_name_value or "",
            "created_by": created_by_name_value or "",
            "customer_name": customer_name_value or "",
            "customer_segment": _clean_segment_name(customer_segment_value),
            "lead_title": lead_title_value or "",
            "lead_ref_id": lead_ref_id_value or "",
            "opportunity_ref_id": opportunity_ref_id_value or "",
            "activity_type": rec.activity_type or "",
            "subject": rec.subject or "",
            "description": (rec.description or "")[:200],
            "status": rec.status or "",
            "activity_date": str(rec.activity_date) if rec.activity_date else "",
            "mode": rec.mode or "",
            "duration_minutes": int(rec.duration_minutes or 0),
            "location": rec.location or "",
            "outcome": rec.outcome or "",
            "next_action": rec.next_action or "",
            "next_action_date": str(rec.next_action_date) if rec.next_action_date else "",
            "days_to_next": days_to_next,
            "followup_category": rec.followup_category or "",
            "followup_sub_type": rec.followup_sub_type or "",
            "contacts_met": rec.contacts_met or "",
            "has_travel": "Yes" if rec.has_travel else "No",
            "travel_mode": rec.travel_mode or "",
            "travel_from": rec.travel_from or "",
            "travel_to": rec.travel_to or "",
            "travel_request_number": travel_request_number_value or "",
            "travel_request_status": travel_request_status_value or "",
            "travel_approved": (
                "Approved" if rec.travel_approved is True else
                "Rejected" if rec.travel_approved is False else
                ""
            ),
            "cancellation_reason": rec.cancellation_reason or "",
            "is_overdue": "Yes" if is_overdue else "No",
            "created_at": str(rec.created_at)[:10] if rec.created_at else "",
        })

    if export:
        return _export(data, "kam_report", export)

    summary = {
        "total": len(analytics_items),
        "completed": sum(1 for item in analytics_items if item["status"] == "Completed"),
        "open": sum(1 for item in analytics_items if item["status"] in ("Planned", "In Progress", "Postponed")),
        "cancelled": sum(1 for item in analytics_items if item["status"] == "Cancelled"),
        "overdue": sum(1 for item in analytics_items if item["is_overdue"]),
        "with_travel": sum(1 for item in analytics_items if item["has_travel"]),
        "avg_duration_minutes": round(
            sum(item["duration_minutes"] for item in analytics_items) / len(analytics_items), 1
        ) if analytics_items else 0.0,
        "active_customers": len({item["customer_name"] for item in analytics_items if item["customer_name"]}),
        "next_actions_7d": sum(
            1
            for item in analytics_items
            if item["days_to_next"] is not None and 0 <= item["days_to_next"] <= 7
        ),
        "_date_from": df_str,
        "_date_to": dt_str,
    }

    activity_timeline: dict[str, dict] = defaultdict(lambda: {"count": 0, "completed": 0, "duration": 0})
    followup_timeline: dict[str, dict] = defaultdict(lambda: {"due": 0, "overdue": 0, "travel": 0})
    heatmap_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    heatmap_completed: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for item in analytics_items:
        if item["activity_day"]:
            activity_timeline[item["activity_day"]]["count"] += 1
            activity_timeline[item["activity_day"]]["duration"] += item["duration_minutes"]
            if item["status"] == "Completed":
                activity_timeline[item["activity_day"]]["completed"] += 1

            heatmap_counts[item["user"] or "Unassigned"][item["activity_day"]] += 1
            if item["status"] == "Completed":
                heatmap_completed[item["user"] or "Unassigned"][item["activity_day"]] += 1

        anchor_day = item["next_action_day"] or item["activity_day"]
        if anchor_day:
            followup_timeline[anchor_day]["due"] += 1
            if item["is_overdue"]:
                followup_timeline[anchor_day]["overdue"] += 1
            if item["has_travel"]:
                followup_timeline[anchor_day]["travel"] += 1

    heatmap_labels = sorted({day for days in heatmap_counts.values() for day in days.keys()})
    if len(heatmap_labels) > 21:
        heatmap_labels = heatmap_labels[-21:]
    heatmap_rows = []
    for user_name, counts_by_day in sorted(
        heatmap_counts.items(),
        key=lambda item: (-sum(item[1].values()), item[0]),
    )[:10]:
        heatmap_rows.append({
            "user": user_name,
            "values": [counts_by_day.get(label, 0) for label in heatmap_labels],
            "completed": [heatmap_completed[user_name].get(label, 0) for label in heatmap_labels],
            "total": sum(counts_by_day.get(label, 0) for label in heatmap_labels),
        })

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_activity_timeline": sorted(
            [{"label": label, **payload} for label, payload in activity_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_followup_timeline": sorted(
            [{"label": label, **payload} for label, payload in followup_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_team_heatmap": {
            "labels": heatmap_labels,
            "rows": heatmap_rows,
            "max": max((value for row in heatmap_rows for value in row["values"]), default=0),
        },
    }


def _apply_tada_scope(q, cu: User, scope_user_ids: Optional[list[int]]):
    role = _normalized_role(getattr(cu, "role", ""))
    if role == "accounts":
        return q.filter(TADAClaim.overall_status.in_(["Manager Approved", "CEO Approved", "Accounts Approved", "Paid"]))
    if scope_user_ids is None:
        return q
    return q.filter(TADAClaim.employee_id.in_(scope_user_ids))


def _apply_tada_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(TADAClaim.claim_date >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(TADAClaim.claim_date <= params["date_to"])
    if params.get("employee_id"):
        q = q.filter(TADAClaim.employee_id.in_(_split_csv_ints(params["employee_id"])))
    if params.get("status"):
        q = q.filter(TADAClaim.overall_status.in_(_split_csv_strings(params["status"])))
    if params.get("manager_status"):
        q = q.filter(TADAClaim.manager_status.in_(_split_csv_strings(params["manager_status"])))
    if params.get("accounts_status"):
        q = q.filter(TADAClaim.accounts_status.in_(_split_csv_strings(params["accounts_status"])))
    if params.get("claim_type"):
        q = q.filter(TADAClaim.claim_type.in_(_split_csv_strings(params["claim_type"])))
    if params.get("expense_mode"):
        q = q.filter(TADAClaim.expense_mode.in_(_split_csv_strings(params["expense_mode"])))
    if params.get("payment_mode"):
        q = q.filter(TADAClaim.payment_mode.in_(_split_csv_strings(params["payment_mode"])))
    if params.get("department"):
        q = q.filter(TADAClaim.department.in_(_split_csv_strings(params["department"])))
    if params.get("cost_center"):
        q = q.filter(TADAClaim.cost_center.in_(_split_csv_strings(params["cost_center"])))
    if params.get("budget_code"):
        q = q.filter(TADAClaim.budget_code.in_(_split_csv_strings(params["budget_code"])))
    if params.get("mode_of_travel"):
        q = q.filter(TADAClaim.mode_of_travel.in_(_split_csv_strings(params["mode_of_travel"])))
    if params.get("travel_status"):
        q = q.filter(TravelRequest.status.in_(_split_csv_strings(params["travel_status"])))
    if params.get("from_city"):
        q = q.filter(TADAClaim.from_city.in_(_split_csv_strings(params["from_city"])))
    if params.get("to_city"):
        q = q.filter(TADAClaim.to_city.in_(_split_csv_strings(params["to_city"])))
    if params.get("travel_from"):
        q = q.filter(TADAClaim.travel_date_from >= params["travel_from"])
    if params.get("travel_to"):
        q = q.filter(TADAClaim.travel_date_to <= params["travel_to"])
    if params.get("payment_from"):
        q = q.filter(TADAClaim.payment_date >= params["payment_from"])
    if params.get("payment_to"):
        q = q.filter(TADAClaim.payment_date <= params["payment_to"])
    if params.get("expense_from"):
        expense_sub = db.query(TADALineItem.claim_id).filter(
            TADALineItem.expense_date >= params["expense_from"],
        )
        q = q.filter(TADAClaim.id.in_(expense_sub))
    if params.get("expense_to"):
        expense_sub = db.query(TADALineItem.claim_id).filter(
            TADALineItem.expense_date <= params["expense_to"],
        )
        q = q.filter(TADAClaim.id.in_(expense_sub))
    if params.get("total_min") is not None:
        q = q.filter(TADAClaim.total_amount >= params["total_min"])
    if params.get("total_max") is not None:
        q = q.filter(TADAClaim.total_amount <= params["total_max"])
    if params.get("payable_min") is not None:
        q = q.filter(TADAClaim.net_payable >= params["payable_min"])
    if params.get("payable_max") is not None:
        q = q.filter(TADAClaim.net_payable <= params["payable_max"])
    if _bool_value(params.get("pending_payment_only")):
        q = q.filter(TADAClaim.overall_status.in_(["Manager Approved", "CEO Approved", "Accounts Approved"]))
    if params.get("category"):
        category_sub = (
            db.query(TADALineItem.claim_id)
            .filter(TADALineItem.category.in_(_split_csv_strings(params["category"])))
            .subquery()
        )
        q = q.filter(TADAClaim.id.in_(category_sub))
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            TADAClaim.claim_number.ilike(term),
            TADAClaim.purpose.ilike(term),
            TADAClaim.from_city.ilike(term),
            TADAClaim.to_city.ilike(term),
            TADAClaim.payment_reference.ilike(term),
            TravelRequest.request_number.ilike(term),
        ))
    return q


@router.get("/tada/filter-options")
def tada_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    claim_types = [
        row[0] for row in db.query(TADAClaim.claim_type).filter(
            TADAClaim.claim_type != None,
            TADAClaim.claim_type != "",
        ).distinct().order_by(TADAClaim.claim_type).all()
    ]
    expense_modes = [
        row[0] for row in db.query(TADAClaim.expense_mode).filter(
            TADAClaim.expense_mode != None,
            TADAClaim.expense_mode != "",
        ).distinct().order_by(TADAClaim.expense_mode).all()
    ]
    payment_modes = [
        row[0] for row in db.query(TADAClaim.payment_mode).filter(
            TADAClaim.payment_mode != None,
            TADAClaim.payment_mode != "",
        ).distinct().order_by(TADAClaim.payment_mode).all()
    ]
    departments = [
        row[0] for row in db.query(TADAClaim.department).filter(
            TADAClaim.department != None,
            TADAClaim.department != "",
        ).distinct().order_by(TADAClaim.department).all()
    ]
    cost_centers = [
        row[0] for row in db.query(TADAClaim.cost_center).filter(
            TADAClaim.cost_center != None,
            TADAClaim.cost_center != "",
        ).distinct().order_by(TADAClaim.cost_center).all()
    ]
    budget_codes = [
        row[0] for row in db.query(TADAClaim.budget_code).filter(
            TADAClaim.budget_code != None,
            TADAClaim.budget_code != "",
        ).distinct().order_by(TADAClaim.budget_code).all()
    ]
    travel_modes = [
        row[0] for row in db.query(TADAClaim.mode_of_travel).filter(
            TADAClaim.mode_of_travel != None,
            TADAClaim.mode_of_travel != "",
        ).distinct().order_by(TADAClaim.mode_of_travel).all()
    ]
    travel_statuses = [
        row[0] for row in db.query(TravelRequest.status).filter(
            TravelRequest.status != None,
            TravelRequest.status != "",
        ).distinct().order_by(TravelRequest.status).all()
    ]
    cities = [
        row[0] for row in db.query(TADAClaim.from_city).filter(
            TADAClaim.from_city != None,
            TADAClaim.from_city != "",
        ).distinct().order_by(TADAClaim.from_city).all()
    ]
    categories = [
        row[0] for row in db.query(TADALineItem.category).filter(
            TADALineItem.category != None,
            TADALineItem.category != "",
        ).distinct().order_by(TADALineItem.category).all()
    ]
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "claim_types": _unique_strings(claim_types) or ["travel", "daily_allowance", "mixed", "local"],
        "expense_modes": _unique_strings(expense_modes),
        "payment_modes": _unique_strings(payment_modes),
        "departments": _unique_strings(departments),
        "cost_centers": _unique_strings(cost_centers),
        "budget_codes": _unique_strings(budget_codes),
        "travel_modes": _unique_strings(travel_modes),
        "travel_statuses": _unique_strings(travel_statuses),
        "cities": _unique_strings(cities),
        "categories": _unique_strings(categories),
        "statuses": ["Draft", "Submitted", "Manager Approved", "CEO Approved", "Accounts Approved", "Paid", "Rejected"],
        "manager_statuses": ["pending", "approved", "rejected"],
        "accounts_statuses": ["pending", "approved", "rejected", "paid"],
    }


@router.get("/tada")
def report_tada(
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    employee_id: Optional[str] = None,
    status: Optional[str] = None,
    manager_status: Optional[str] = None,
    accounts_status: Optional[str] = None,
    claim_type: Optional[str] = None,
    expense_mode: Optional[str] = None,
    payment_mode: Optional[str] = None,
    department: Optional[str] = None,
    cost_center: Optional[str] = None,
    budget_code: Optional[str] = None,
    mode_of_travel: Optional[str] = None,
    travel_status: Optional[str] = None,
    customer_id: Optional[str] = None,
    from_city: Optional[str] = None,
    to_city: Optional[str] = None,
    category: Optional[str] = None,
    travel_from: Optional[str] = None,
    travel_to: Optional[str] = None,
    payment_from: Optional[str] = None,
    payment_to: Optional[str] = None,
    expense_from: Optional[str] = None,
    expense_to: Optional[str] = None,
    total_min: Optional[float] = None,
    total_max: Optional[float] = None,
    payable_min: Optional[float] = None,
    payable_max: Optional[float] = None,
    pending_payment_only: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "claim_date",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, _, _ = _resolve_date_preset(preset, date_from, date_to)
    filter_params = {
        "date_from": df_str,
        "date_to": dt_str,
        "employee_id": employee_id,
        "status": status,
        "manager_status": manager_status,
        "accounts_status": accounts_status,
        "claim_type": claim_type,
        "expense_mode": expense_mode,
        "payment_mode": payment_mode,
        "department": department,
        "cost_center": cost_center,
        "budget_code": budget_code,
        "mode_of_travel": mode_of_travel,
        "travel_status": travel_status,
        "customer_id": customer_id,
        "from_city": from_city,
        "to_city": to_city,
        "category": category,
        "travel_from": travel_from,
        "travel_to": travel_to,
        "payment_from": payment_from,
        "payment_to": payment_to,
        "expense_from": expense_from,
        "expense_to": expense_to,
        "total_min": total_min,
        "total_max": total_max,
        "payable_min": payable_min,
        "payable_max": payable_max,
        "pending_payment_only": pending_payment_only,
        "search": search,
    }

    EmployeeUser = aliased(User)
    ManagerUser = aliased(User)
    AccountsUser = aliased(User)
    scope_user_ids = _report_scope_user_ids(db, cu)

    base_q = (
        db.query(
            TADAClaim,
            EmployeeUser.full_name.label("employee_name"),
            ManagerUser.full_name.label("manager_name"),
            AccountsUser.full_name.label("accounts_name"),
            TravelRequest.request_number.label("travel_request_number"),
            TravelRequest.status.label("travel_request_status"),
        )
        .outerjoin(EmployeeUser, TADAClaim.employee_id == EmployeeUser.id)
        .outerjoin(ManagerUser, TADAClaim.manager_approved_by == ManagerUser.id)
        .outerjoin(AccountsUser, TADAClaim.accounts_approved_by == AccountsUser.id)
        .outerjoin(TravelRequest, TADAClaim.travel_request_id == TravelRequest.id)
    )
    base_q = _apply_tada_scope(base_q, cu, scope_user_ids)
    base_q = _apply_tada_filters(base_q, filter_params, db)
    total_count = base_q.count()

    sort_map = {
        "claim_date": TADAClaim.claim_date,
        "employee": EmployeeUser.full_name,
        "total_amount": TADAClaim.total_amount,
        "net_payable": TADAClaim.net_payable,
        "overall_status": TADAClaim.overall_status,
        "payment_date": TADAClaim.payment_date,
        "created_at": TADAClaim.created_at,
    }
    sort_col = sort_map.get(str(sort_by or "claim_date"), TADAClaim.claim_date)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()

    page_claim_ids = [rec.id for rec, *_ in page_rows]
    page_item_counts: dict[int, int] = defaultdict(int)
    page_categories: dict[int, set[str]] = defaultdict(set)
    if page_claim_ids:
        for claim_id_value, category_value in db.query(
            TADALineItem.claim_id,
            TADALineItem.category,
        ).filter(TADALineItem.claim_id.in_(page_claim_ids)).all():
            page_item_counts[int(claim_id_value)] += 1
            if category_value:
                page_categories[int(claim_id_value)].add(str(category_value))

    today = today_ist()
    analytics_items: list[dict] = []
    analytics_claim_ids: list[int] = []
    for rec, employee_name_value, manager_name_value, accounts_name_value, travel_request_number_value, travel_request_status_value in analytics_rows:
        analytics_claim_ids.append(int(rec.id))
        claim_dt = _to_date(rec.claim_date)
        payment_dt = _to_date(rec.payment_date)
        settle_days = (payment_dt - claim_dt).days if payment_dt and claim_dt else (
            (today - claim_dt).days if claim_dt else None
        )
        analytics_items.append({
            "id": rec.id,
            "employee": employee_name_value or "",
            "claim_month": str(claim_dt or "")[:7],
            "overall_status": rec.overall_status or "",
            "total_amount": _amount(rec.total_amount),
            "advance_taken": _amount(rec.advance_taken),
            "net_payable": _amount(rec.net_payable),
            "settle_days": settle_days,
        })

    category_heatmap: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    if analytics_claim_ids:
        claim_month_map = {
            int(item["id"]): str(item["claim_month"])
            for item in analytics_items
            if item["claim_month"]
        }
        line_items = db.query(
            TADALineItem.claim_id,
            TADALineItem.category,
            TADALineItem.amount,
        ).filter(TADALineItem.claim_id.in_(analytics_claim_ids)).all()
        for claim_id_value, category_value, amount_value in line_items:
            month_label = claim_month_map.get(int(claim_id_value))
            if not month_label or not category_value:
                continue
            category_heatmap[str(category_value)][month_label] += _amount(amount_value)

    data: list[dict] = []
    for rec, employee_name_value, manager_name_value, accounts_name_value, travel_request_number_value, travel_request_status_value in page_rows:
        claim_id_value = int(rec.id)
        data.append({
            "id": rec.id,
            "claim_number": rec.claim_number or "",
            "employee": employee_name_value or "",
            "claim_date": str(rec.claim_date) if rec.claim_date else "",
            "travel_date_from": str(rec.travel_date_from) if rec.travel_date_from else "",
            "travel_date_to": str(rec.travel_date_to) if rec.travel_date_to else "",
            "travel_request_number": travel_request_number_value or "",
            "travel_request_status": travel_request_status_value or "",
            "claim_type": rec.claim_type or "",
            "from_city": rec.from_city or "",
            "to_city": rec.to_city or "",
            "purpose": rec.purpose or "",
            "mode_of_travel": rec.mode_of_travel or "",
            "expense_mode": rec.expense_mode or "",
            "department": rec.department or "",
            "cost_center": rec.cost_center or "",
            "budget_code": rec.budget_code or "",
            "num_days": int(rec.num_days or 0),
            "item_count": page_item_counts.get(claim_id_value, 0),
            "categories": ", ".join(sorted(page_categories.get(claim_id_value, set()))),
            "total_amount": _amount(rec.total_amount),
            "advance_taken": _amount(rec.advance_taken),
            "net_payable": _amount(rec.net_payable),
            "da_total": _amount(rec.da_total),
            "manager_status": rec.manager_status or "",
            "accounts_status": rec.accounts_status or "",
            "overall_status": rec.overall_status or "",
            "payment_mode": rec.payment_mode or "",
            "payment_reference": rec.payment_reference or "",
            "payment_date": str(rec.payment_date) if rec.payment_date else "",
            "manager_approved_by": manager_name_value or "",
            "accounts_approved_by": accounts_name_value or "",
            "notes": (rec.notes or "")[:200],
            "created_at": str(rec.created_at)[:10] if rec.created_at else "",
        })

    if export:
        return _export(data, "tada_report", export)

    summary = {
        "total": len(analytics_items),
        "total_claimed": round(sum(item["total_amount"] for item in analytics_items), 2),
        "total_payable": round(sum(item["net_payable"] for item in analytics_items), 2),
        "total_advance": round(sum(item["advance_taken"] for item in analytics_items), 2),
        "paid_amount": round(
            sum(item["net_payable"] for item in analytics_items if item["overall_status"] == "Paid"), 2
        ),
        "pending_settlement": round(
            sum(
                item["net_payable"]
                for item in analytics_items
                if item["overall_status"] in ("Manager Approved", "CEO Approved", "Accounts Approved")
            ),
            2,
        ),
        "rejected": sum(1 for item in analytics_items if item["overall_status"] == "Rejected"),
        "avg_claim": round(
            sum(item["total_amount"] for item in analytics_items) / len(analytics_items), 2
        ) if analytics_items else 0.0,
        "_date_from": df_str,
        "_date_to": dt_str,
    }

    claim_timeline: dict[str, dict] = defaultdict(lambda: {"count": 0, "claimed": 0.0, "payable": 0.0})
    status_timeline: dict[str, dict] = defaultdict(lambda: {"submitted": 0, "approved": 0, "paid": 0, "rejected": 0})
    scatter_data: list[dict] = []

    for item in analytics_items:
        if item["claim_month"]:
            claim_timeline[item["claim_month"]]["count"] += 1
            claim_timeline[item["claim_month"]]["claimed"] += item["total_amount"]
            claim_timeline[item["claim_month"]]["payable"] += item["net_payable"]

            status_timeline[item["claim_month"]]["submitted"] += int(item["overall_status"] == "Submitted")
            status_timeline[item["claim_month"]]["approved"] += int(item["overall_status"] in ("Manager Approved", "CEO Approved", "Accounts Approved"))
            status_timeline[item["claim_month"]]["paid"] += int(item["overall_status"] == "Paid")
            status_timeline[item["claim_month"]]["rejected"] += int(item["overall_status"] == "Rejected")

        if item["settle_days"] is not None:
            scatter_data.append({
                "label": str(item["id"]),
                "employee": item["employee"],
                "days": int(item["settle_days"]),
                "payable": item["net_payable"],
                "claimed": item["total_amount"],
                "status": item["overall_status"],
            })

    heatmap_labels = sorted({month for months in category_heatmap.values() for month in months.keys()})
    heatmap_rows = []
    for category_name, amounts_by_month in sorted(
        category_heatmap.items(),
        key=lambda item: -sum(item[1].values()),
    ):
        heatmap_rows.append({
            "category": category_name,
            "values": [round(amounts_by_month.get(label, 0.0), 2) for label in heatmap_labels],
            "total": round(sum(amounts_by_month.values()), 2),
        })

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_claim_timeline": sorted(
            [{"label": label, **payload} for label, payload in claim_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_status_timeline": sorted(
            [{"label": label, **payload} for label, payload in status_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_category_heatmap": {
            "labels": heatmap_labels,
            "rows": heatmap_rows,
            "max": max((value for row in heatmap_rows for value in row["values"]), default=0),
        },
        "chart_settlement_scatter": sorted(
            scatter_data,
            key=lambda item: (item["days"], -item["payable"]),
        )[:150],
    }


def _apply_opportunity_stage_filter(q, stages: list[str]):
    if not stages:
        return q
    approval_lc = func.lower(func.coalesce(Lead.approval_status, ""))
    stage_filters = []
    if "Opportunity" in stages:
        stage_filters.append(and_(
            Lead.status == "Opportunity Created",
            approval_lc.notin_(["pending", "rejected", "rejected opportunity"]),
        ))
    if "Request Conversion" in stages:
        stage_filters.append(and_(
            Lead.status == "Opportunity Created",
            approval_lc == "pending",
        ))
    if "Rejected" in stages:
        stage_filters.append(and_(
            Lead.status == "Opportunity Created",
            approval_lc.in_(["rejected", "rejected opportunity"]),
        ))
    if "Converted" in stages:
        stage_filters.append(Lead.status == "Converted")
    if stage_filters:
        q = q.filter(or_(*stage_filters))
    return q


def _apply_opportunity_filters(q, params: dict, db: Session):
    opportunity_anchor = func.coalesce(Lead.opportunity_created_at, Lead.created_at)
    if params.get("date_from"):
        q = q.filter(opportunity_anchor >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(opportunity_anchor <= params["date_to"] + " 23:59:59")
    if params.get("stage"):
        q = _apply_opportunity_stage_filter(q, _split_csv_strings(params["stage"]))
    if params.get("priority"):
        q = q.filter(Lead.priority.in_(_split_csv_strings(params["priority"])))
    if params.get("lead_type"):
        q = q.filter(Lead.lead_type.in_(_split_csv_strings(params["lead_type"])))
    if params.get("assigned_to"):
        q = q.filter(Lead.assigned_to.in_(_split_csv_ints(params["assigned_to"])))
    if params.get("created_by"):
        q = q.filter(Lead.created_by.in_(_split_csv_ints(params["created_by"])))
    if params.get("source_id"):
        q = q.filter(Lead.source_id.in_(_split_csv_ints(params["source_id"])))
    if params.get("customer_id"):
        q = q.filter(Lead.customer_id.in_(_split_csv_ints(params["customer_id"])))
    if params.get("customer_segment"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, _split_csv_strings(params["customer_segment"])) or [-1]))
    if params.get("approval_status"):
        q = q.filter(Lead.approval_status.in_(_split_csv_strings(params["approval_status"])))
    if params.get("region"):
        q = q.filter(Lead.region.ilike(f"%{params['region']}%"))
    if params.get("follow_up_from"):
        q = q.filter(Lead.follow_up >= params["follow_up_from"])
    if params.get("follow_up_to"):
        q = q.filter(Lead.follow_up <= params["follow_up_to"])
    if params.get("converted_from"):
        q = q.filter(Lead.converted_at >= params["converted_from"])
    if params.get("converted_to"):
        q = q.filter(Lead.converted_at <= params["converted_to"] + " 23:59:59")
    if params.get("est_value_min") is not None:
        q = q.filter(Lead.est_value >= params["est_value_min"])
    if params.get("est_value_max") is not None:
        q = q.filter(Lead.est_value <= params["est_value_max"])
    if params.get("product_name"):
        product_sub = (
            db.query(LeadProduct.lead_id)
            .filter(LeadProduct.product_name.ilike(f"%{params['product_name']}%"))
            .subquery()
        )
        q = q.filter(Lead.id.in_(product_sub))
    if params.get("oem_name"):
        oem_sub = (
            db.query(LeadProduct.lead_id)
            .join(LeadProductOEM, LeadProductOEM.lead_product_id == LeadProduct.id)
            .filter(LeadProductOEM.oem_name.ilike(f"%{params['oem_name']}%"))
            .subquery()
        )
        q = q.filter(Lead.id.in_(oem_sub))
    if params.get("quote_status"):
        quote_sub = (
            db.query(Quotation.lead_id)
            .filter(Quotation.status.in_(_split_csv_strings(params["quote_status"])))
            .subquery()
        )
        q = q.filter(Lead.id.in_(quote_sub))
    has_quotation = _bool_value(params.get("has_quotation"))
    if has_quotation is not None:
        quote_lead_ids = db.query(Quotation.lead_id).filter(Quotation.lead_id != None).distinct().subquery()
        q = q.filter(Lead.id.in_(quote_lead_ids) if has_quotation else Lead.id.notin_(quote_lead_ids))
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            Lead.lead_title.ilike(term),
            Lead.customer_name.ilike(term),
            Lead.contact_person.ilike(term),
            Lead.email.ilike(term),
            Lead.mobile.ilike(term),
            Lead.opportunity_ref_id.ilike(term),
            Lead.lead_ref_id.ilike(term),
        ))
    if params.get("open_only"):
        q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
    if params.get("follow_up_overdue"):
        q = q.filter(Lead.follow_up.isnot(None))
        q = q.filter(Lead.follow_up < today_ist())
        q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
    if params.get("follow_up_due_days"):
        try:
            _today = today_ist()
            _due = _today + timedelta(days=int(params["follow_up_due_days"]))
            q = q.filter(Lead.follow_up.isnot(None))
            q = q.filter(Lead.follow_up >= _today)
            q = q.filter(Lead.follow_up <= _due)
        except (TypeError, ValueError):
            pass
    if params.get("inactive_days"):
        try:
            cutoff = today_ist() - timedelta(days=int(params["inactive_days"]))
            q = q.filter(Lead.updated_at < cutoff)
            q = q.filter(Lead.status.notin_(["Converted", "Lost"]))
        except (TypeError, ValueError):
            pass
    if params.get("no_activity_days"):
        try:
            cutoff = today_ist() - timedelta(days=int(params["no_activity_days"]))
            recent_sub = db.query(KAMActivity.lead_id).filter(
                KAMActivity.lead_id.isnot(None),
                KAMActivity.created_at >= cutoff,
            ).distinct().subquery()
            q = q.filter(Lead.id.notin_(recent_sub))
        except (TypeError, ValueError):
            pass
    if params.get("has_activity") not in (None, ""):
        act_sub = db.query(KAMActivity.lead_id).filter(KAMActivity.lead_id.isnot(None)).distinct().subquery()
        if str(params["has_activity"]) == "1":
            q = q.filter(Lead.id.in_(act_sub))
        else:
            q = q.filter(Lead.id.notin_(act_sub))
    if params.get("has_workorder") not in (None, ""):
        if str(params["has_workorder"]) == "1":
            q = q.filter(Lead.converted_tender_id.isnot(None))
        else:
            q = q.filter(Lead.converted_tender_id.is_(None))
    if params.get("business_vertical_id"):
        vals = [int(x) for x in str(params["business_vertical_id"]).split(",") if x.strip()]
        if vals:
            q = q.filter(Lead.business_vertical_id.in_(vals))
    return q


@router.get("/opportunities/filter-options")
def opportunities_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    sources = db.query(LeadSource.id, LeadSource.name).order_by(LeadSource.name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    segments = [
        row[0] for row in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_vertical).all()
    ]
    quote_statuses = [
        row[0] for row in db.query(Quotation.status).filter(
            Quotation.status != None,
            Quotation.status != "",
        ).distinct().order_by(Quotation.status).all()
    ]
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        business_verticals = []
    vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "sources": [{"id": s.id, "name": s.name} for s in sources],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "segments": _unique_strings(segments),
        "stages": ["Opportunity", "Request Conversion", "Rejected", "Converted"],
        "priorities": ["Low", "Medium", "High"],
        "lead_types": ["lead", "direct_opportunity"],
        "approval_statuses": ["none", "pending", "approved", "rejected", "rejected opportunity"],
        "quote_statuses": _unique_strings(quote_statuses),
        "business_verticals": business_verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in vertical_sectors],
    }


@router.get("/opportunities")
def report_opportunities(
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    stage: Optional[str] = None,
    priority: Optional[str] = None,
    lead_type: Optional[str] = None,
    assigned_to: Optional[str] = None,
    created_by: Optional[str] = None,
    source_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    approval_status: Optional[str] = None,
    quote_status: Optional[str] = None,
    has_quotation: Optional[str] = None,
    product_name: Optional[str] = None,
    oem_name: Optional[str] = None,
    region: Optional[str] = None,
    follow_up_from: Optional[str] = None,
    follow_up_to: Optional[str] = None,
    converted_from: Optional[str] = None,
    converted_to: Optional[str] = None,
    est_value_min: Optional[float] = None,
    est_value_max: Optional[float] = None,
    search: Optional[str] = None,
    open_only: Optional[str] = None,
    follow_up_overdue: Optional[str] = None,
    follow_up_due_days: Optional[str] = None,
    inactive_days: Optional[str] = None,
    no_activity_days: Optional[str] = None,
    has_activity: Optional[str] = None,
    has_workorder: Optional[str] = None,
    business_vertical_id: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "created_at",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, _, _ = _resolve_date_preset(preset, date_from, date_to)
    if assigned_to == "__ME__":
        assigned_to = str(cu.id)
    filter_params = {
        "date_from": df_str,
        "date_to": dt_str,
        "stage": stage,
        "priority": priority,
        "lead_type": lead_type,
        "assigned_to": assigned_to,
        "created_by": created_by,
        "source_id": source_id,
        "customer_id": customer_id,
        "customer_segment": customer_segment,
        "approval_status": approval_status,
        "quote_status": quote_status,
        "has_quotation": has_quotation,
        "product_name": product_name,
        "oem_name": oem_name,
        "region": region,
        "follow_up_from": follow_up_from,
        "follow_up_to": follow_up_to,
        "converted_from": converted_from,
        "converted_to": converted_to,
        "est_value_min": est_value_min,
        "est_value_max": est_value_max,
        "search": search,
        "open_only": open_only,
        "follow_up_overdue": follow_up_overdue,
        "follow_up_due_days": follow_up_due_days,
        "inactive_days": inactive_days,
        "no_activity_days": no_activity_days,
        "has_activity": has_activity,
        "has_workorder": has_workorder,
        "business_vertical_id": business_vertical_id,
    }

    AssignedUser = aliased(User)
    CreatedUser = aliased(User)
    scope_q = _build_leads_scope(db, cu).filter(Lead.status.in_(["Opportunity Created", "Converted"]))
    quote_agg_sub = (
        db.query(
            Quotation.lead_id.label("lead_id"),
            func.count(Quotation.id).label("quotation_count"),
            func.sum(case((Quotation.status == "Accepted", 1), else_=0)).label("accepted_quotes"),
            func.sum(case((Quotation.approval_status == "pending", 1), else_=0)).label("pending_quotes"),
        )
        .filter(Quotation.lead_id != None)
        .group_by(Quotation.lead_id)
        .subquery()
    )
    latest_quote_sub = (
        db.query(
            Quotation.lead_id.label("lead_id"),
            func.max(Quotation.id).label("latest_quote_id"),
        )
        .filter(Quotation.lead_id != None)
        .group_by(Quotation.lead_id)
        .subquery()
    )
    LatestQuote = aliased(Quotation)

    base_q = (
        scope_q.with_entities(
            Lead,
            Customer.customer_vertical.label("customer_segment"),
            AssignedUser.full_name.label("assigned_name"),
            CreatedUser.full_name.label("created_by_name"),
            func.coalesce(quote_agg_sub.c.quotation_count, 0).label("quotation_count"),
            func.coalesce(quote_agg_sub.c.accepted_quotes, 0).label("accepted_quotes"),
            func.coalesce(quote_agg_sub.c.pending_quotes, 0).label("pending_quotes"),
            LatestQuote.status.label("latest_quote_status"),
            LatestQuote.total_amount.label("latest_quote_amount"),
        )
        .outerjoin(Customer, Lead.customer_id == Customer.id)
        .outerjoin(AssignedUser, Lead.assigned_to == AssignedUser.id)
        .outerjoin(CreatedUser, Lead.created_by == CreatedUser.id)
        .outerjoin(quote_agg_sub, quote_agg_sub.c.lead_id == Lead.id)
        .outerjoin(latest_quote_sub, latest_quote_sub.c.lead_id == Lead.id)
        .outerjoin(LatestQuote, LatestQuote.id == latest_quote_sub.c.latest_quote_id)
    )
    base_q = _apply_opportunity_filters(base_q, filter_params, db)
    total_count = base_q.count()

    sort_map = {
        "created_at": Lead.created_at,
        "opportunity_ref_id": Lead.opportunity_ref_id,
        "lead_title": Lead.lead_title,
        "customer_name": Lead.customer_name,
        "est_value": Lead.est_value,
        "priority": Lead.priority,
        "follow_up": Lead.follow_up,
        "converted_at": Lead.converted_at,
    }
    sort_col = sort_map.get(str(sort_by or "created_at"), Lead.created_at)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()

    lead_ids = [lead.id for lead, *_ in page_rows]
    products_map, oems_map = _fetch_leads_with_aggregates(db, lead_ids)
    source_map = {
        row.id: row.name or ""
        for row in db.query(LeadSource.id, LeadSource.name).all()
    }

    today = today_ist()
    analytics_items: list[dict] = []
    for lead, customer_segment_value, assigned_name_value, created_by_name_value, quotation_count_value, accepted_quotes_value, pending_quotes_value, latest_quote_status_value, latest_quote_amount_value in analytics_rows:
        anchor_dt = _to_date(lead.opportunity_created_at or lead.created_at)
        stage_value = _opportunity_stage_label(str(lead.status or ""), str(lead.approval_status or ""))
        age_days = _days_since(anchor_dt, today) if anchor_dt else 0
        source_value = _lead_source_label(lead, source_map)
        analytics_items.append({
            "id": lead.id,
            "stage": stage_value or "",
            "source": source_value or "",
            "assigned_to": assigned_name_value or "",
            "lead_type": lead.lead_type or "",
            "opportunity_month": str(anchor_dt or "")[:7],
            "converted_month": str(_to_date(lead.converted_at) or "")[:7],
            "est_value": _amount(lead.est_value),
            "age_days": age_days,
            "quotation_count": int(quotation_count_value or 0),
        })

    page_bv_ids_opps = {int(lead.business_vertical_id) for lead, *_ in page_rows if getattr(lead, "business_vertical_id", None)}
    bv_name_map = _resolve_business_vertical_names(db, page_bv_ids_opps)
    bv_group_map = _resolve_business_vertical_parent_names(db, page_bv_ids_opps)

    data: list[dict] = []
    for lead, customer_segment_value, assigned_name_value, created_by_name_value, quotation_count_value, accepted_quotes_value, pending_quotes_value, latest_quote_status_value, latest_quote_amount_value in page_rows:
        anchor_dt = _to_date(lead.opportunity_created_at or lead.created_at)
        stage_value = _opportunity_stage_label(str(lead.status or ""), str(lead.approval_status or ""))
        age_days = _days_since(anchor_dt, today) if anchor_dt else 0
        products = list(dict.fromkeys(p for p in products_map.get(lead.id, []) if p))
        oems = list(dict.fromkeys(o for o in oems_map.get(lead.id, []) if o))
        data.append({
            "id": lead.id,
            "opportunity_ref_id": lead.opportunity_ref_id or lead.lead_ref_id or "",
            "lead_ref_id": lead.lead_ref_id or "",
            "lead_title": lead.lead_title or "",
            "stage": stage_value or "",
            "customer_name": lead.customer_name or "",
            "customer_segment": _clean_segment_name(customer_segment_value),
            "lead_type": lead.lead_type or "",
            "priority": lead.priority or "",
            "source": _lead_source_label(lead, source_map),
            "region": lead.region or "",
            "est_value": _amount(lead.est_value),
            "follow_up": str(lead.follow_up) if lead.follow_up else "",
            "age_days": age_days,
            "assigned_to": assigned_name_value or "",
            "created_by": created_by_name_value or "",
            "approval_status": lead.approval_status or "none",
            "quotation_count": int(quotation_count_value or 0),
            "accepted_quotes": int(accepted_quotes_value or 0),
            "pending_quotes": int(pending_quotes_value or 0),
            "latest_quote_status": latest_quote_status_value or "",
            "latest_quote_amount": _amount(latest_quote_amount_value),
            "contact_person": lead.contact_person or "",
            "mobile": lead.mobile or "",
            "email": lead.email or "",
            "products": ", ".join(products),
            "oems": ", ".join(oems),
            "converted_at": str(lead.converted_at)[:10] if lead.converted_at else "",
            "notes": (lead.notes or "")[:200],
            "created_at": str(lead.created_at)[:10] if lead.created_at else "",
            "business_vertical": bv_name_map.get(int(lead.business_vertical_id or 0), "") if lead.business_vertical_id else "",
            "business_vertical_group": bv_group_map.get(int(lead.business_vertical_id or 0), "") if lead.business_vertical_id else "",
        })

    if export:
        return _export(data, "opportunities_report", export)

    stage_strip_map: dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})
    source_counts: dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})
    timeline_map: dict[str, dict] = defaultdict(lambda: {"created": 0, "converted": 0, "value": 0.0})
    owner_stage_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    scatter_data: list[dict] = []

    for item in analytics_items:
        stage_strip_map[item["stage"]]["count"] += 1
        stage_strip_map[item["stage"]]["value"] += item["est_value"]
        source_counts[item["source"] or "Direct"]["count"] += 1
        source_counts[item["source"] or "Direct"]["value"] += item["est_value"]
        if item["opportunity_month"]:
            timeline_map[item["opportunity_month"]]["created"] += 1
            timeline_map[item["opportunity_month"]]["value"] += item["est_value"]
        if item["converted_month"]:
            timeline_map[item["converted_month"]]["converted"] += 1
        owner_stage_counts[item["assigned_to"] or "Unassigned"][item["stage"]] += 1
        scatter_data.append({
            "label": str(item["id"]),
            "stage": item["stage"],
            "age": item["age_days"],
            "value": item["est_value"],
            "quotes": item["quotation_count"],
        })

    stage_labels = ["Opportunity", "Request Conversion", "Rejected", "Converted"]
    matrix_rows = []
    for owner_name, counts_by_stage in sorted(
        owner_stage_counts.items(),
        key=lambda item: -sum(item[1].values()),
    )[:10]:
        matrix_rows.append({
            "owner": owner_name,
            "values": [counts_by_stage.get(label, 0) for label in stage_labels],
            "total": sum(counts_by_stage.values()),
        })

    total = len(analytics_items)
    converted = sum(1 for item in analytics_items if item["stage"] == "Converted")
    summary = {
        "total": total,
        "pipeline_value": round(sum(item["est_value"] for item in analytics_items), 2),
        "active": sum(1 for item in analytics_items if item["stage"] == "Opportunity"),
        "pending_approval": sum(1 for item in analytics_items if item["stage"] == "Request Conversion"),
        "rejected": sum(1 for item in analytics_items if item["stage"] == "Rejected"),
        "converted": converted,
        "with_quotation": sum(1 for item in analytics_items if item["quotation_count"] > 0),
        "direct_opportunities": sum(1 for item in analytics_items if item["lead_type"] == "direct_opportunity"),
        "conversion_rate": round(converted / total * 100, 1) if total else 0.0,
        "avg_age_days": round(sum(item["age_days"] for item in analytics_items) / total, 1) if total else 0.0,
        "_date_from": df_str,
        "_date_to": dt_str,
    }

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "stage_strip": [
            {"label": label, **stage_strip_map.get(label, {"count": 0, "value": 0.0})}
            for label in stage_labels
        ],
        "chart_stage": [
            {"label": label, **stage_strip_map.get(label, {"count": 0, "value": 0.0})}
            for label in stage_labels
        ],
        "chart_source": sorted(
            [{"label": label, **payload} for label, payload in source_counts.items()],
            key=lambda item: (-item["count"], item["label"]),
        ),
        "chart_pipeline_timeline": sorted(
            [{"label": label, **payload} for label, payload in timeline_map.items()],
            key=lambda item: item["label"],
        ),
        "chart_owner_heatmap": {
            "labels": stage_labels,
            "rows": matrix_rows,
            "max": max((value for row in matrix_rows for value in row["values"]), default=0),
        },
        "chart_age_scatter": sorted(
            scatter_data,
            key=lambda item: (item["age"], -item["value"]),
        )[:150],
    }


def _apply_quotation_scope(q, db: Session, cu: User):
    role = _normalized_role(getattr(cu, "role", ""))
    if role in ("admin", "ceo", "accounts", "super_admin"):
        return q
    scope_user_ids = _report_scope_user_ids(db, cu)
    if scope_user_ids is None:
        return q
    return q.filter(or_(
        Quotation.created_by.in_(scope_user_ids),
        Lead.assigned_to.in_(scope_user_ids),
        Lead.created_by.in_(scope_user_ids),
        Tender.assigned_to.in_(scope_user_ids),
        Tender.created_by.in_(scope_user_ids),
    ))


def _apply_quotation_filters(q, params: dict, db: Session):
    if params.get("date_from"):
        q = q.filter(Quotation.created_at >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(Quotation.created_at <= params["date_to"] + " 23:59:59")
    if params.get("status"):
        q = q.filter(Quotation.status.in_(_split_csv_strings(params["status"])))
    if params.get("approval_status"):
        q = q.filter(Quotation.approval_status.in_(_split_csv_strings(params["approval_status"])))
    if params.get("source_type"):
        source_types = _split_csv_strings(params["source_type"])
        source_filters = []
        if "opportunity" in source_types:
            source_filters.append(Quotation.tender_id == None)
        if "tender" in source_types:
            source_filters.append(Quotation.tender_id != None)
        if source_filters:
            q = q.filter(or_(*source_filters))
    if params.get("customer_id"):
        q = q.filter(Quotation.customer_id.in_(_split_csv_ints(params["customer_id"])))
    if params.get("customer_segment"):
        q = q.filter(Customer.id.in_(_segment_customer_ids(db, _split_csv_strings(params["customer_segment"])) or [-1]))
    if params.get("created_by"):
        q = q.filter(Quotation.created_by.in_(_split_csv_ints(params["created_by"])))
    if params.get("signatory_user_id"):
        q = q.filter(Quotation.signatory_user_id.in_(_split_csv_ints(params["signatory_user_id"])))
    if params.get("lead_type"):
        q = q.filter(Lead.lead_type.in_(_split_csv_strings(params["lead_type"])))
    if params.get("business_vertical_id"):
        vals = _split_csv_ints(params["business_vertical_id"])
        if vals:
            q = q.filter(Lead.business_vertical_id.in_(vals))
    if params.get("revision_number"):
        q = q.filter(Quotation.revision_number.in_(_split_csv_ints(params["revision_number"])))
    if params.get("source_portal"):
        q = q.filter(Tender.source_portal.in_(_split_csv_strings(params["source_portal"])))
    if params.get("tender_result"):
        q = q.filter(Tender.result.in_(_split_csv_strings(params["tender_result"])))
    if params.get("valid_until_from"):
        q = q.filter(Quotation.valid_until >= params["valid_until_from"])
    if params.get("valid_until_to"):
        q = q.filter(Quotation.valid_until <= params["valid_until_to"])
    if params.get("amount_min") is not None:
        q = q.filter(Quotation.total_amount >= params["amount_min"])
    if params.get("amount_max") is not None:
        q = q.filter(Quotation.total_amount <= params["amount_max"])
    if params.get("validity_days") is not None:
        cutoff = today_ist() + timedelta(days=int(params["validity_days"]))
        q = q.filter(Quotation.valid_until != None, Quotation.valid_until <= cutoff)
    if _bool_value(params.get("expired_only")):
        q = q.filter(Quotation.valid_until != None, Quotation.valid_until < today_ist())
    if params.get("search"):
        term = f"%{str(params['search']).strip()}%"
        q = q.filter(or_(
            Quotation.quotation_number.ilike(term),
            Quotation.subject.ilike(term),
            Quotation.ref_number.ilike(term),
            Lead.lead_title.ilike(term),
            Lead.opportunity_ref_id.ilike(term),
            Tender.tender_num.ilike(term),
            Tender.tender_title.ilike(term),
            Customer.customer_name.ilike(term),
        ))
    return q


@router.get("/quotations/filter-options")
def quotations_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    users = db.query(User.id, User.full_name).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.is_deleted == False)
        .order_by(Customer.customer_name)
        .all()
    )
    segments = [
        row[0] for row in db.query(Customer.customer_vertical).filter(
            Customer.customer_vertical != None,
            Customer.customer_vertical != "",
            Customer.is_deleted == False,
        ).distinct().order_by(Customer.customer_vertical).all()
    ]
    portals = [
        row[0] for row in db.query(Tender.source_portal)
        .join(Quotation, Quotation.tender_id == Tender.id)
        .filter(Tender.source_portal != None, Tender.source_portal != "")
        .distinct().order_by(Tender.source_portal).all()
    ]
    results = [
        row[0] for row in db.query(Tender.result)
        .join(Quotation, Quotation.tender_id == Tender.id)
        .filter(Tender.result != None, Tender.result != "")
        .distinct().order_by(Tender.result).all()
    ]
    revisions = [
        row[0] for row in db.query(Quotation.revision_number).filter(
            Quotation.revision_number != None,
        ).distinct().order_by(Quotation.revision_number).all()
    ]
    try:
        bv_rows = db.execute(text(
            "SELECT u.id, u.business_unit AS name, c.business_vertical AS subtitle "
            "FROM business_category_units u "
            "INNER JOIN business_category_units c ON c.id = u.parent_category_id "
            "  AND c.item_type = 'category' AND c.is_active = 1 "
            "WHERE u.item_type = 'unit' AND u.business_unit IS NOT NULL AND u.is_active = 1 "
            "ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
        )).fetchall()
        qt_business_verticals = [{"id": r[0], "name": r[1], "subtitle": r[2]} for r in bv_rows]
    except Exception:
        qt_business_verticals = []
    qt_vertical_sectors = db.query(VerticalSector.id, VerticalSector.name).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()
    return {
        "users": [{"id": u.id, "name": u.full_name} for u in users],
        "customers": [{"id": c.id, "name": c.customer_name} for c in customers],
        "segments": _unique_strings(segments),
        "statuses": ["Draft", "Sent", "Approved", "Accepted", "Rejected"],
        "approval_statuses": ["none", "pending", "approved", "rejected"],
        "source_types": ["opportunity", "tender"],
        "lead_types": ["lead", "direct_opportunity"],
        "revisions": [int(value) for value in revisions if value is not None] or [1, 2, 3],
        "portals": _unique_strings(portals),
        "results": _unique_strings(results),
        "business_verticals": qt_business_verticals,
        "vertical_sectors": [{"id": v.id, "name": v.name} for v in qt_vertical_sectors],
    }


@router.get("/quotations")
def report_quotations(
    preset: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    approval_status: Optional[str] = None,
    source_type: Optional[str] = None,
    customer_id: Optional[str] = None,
    customer_segment: Optional[str] = None,
    created_by: Optional[str] = None,
    signatory_user_id: Optional[str] = None,
    lead_type: Optional[str] = None,
    revision_number: Optional[str] = None,
    source_portal: Optional[str] = None,
    tender_result: Optional[str] = None,
    valid_until_from: Optional[str] = None,
    valid_until_to: Optional[str] = None,
    validity_days: Optional[int] = None,
    expired_only: Optional[str] = None,
    amount_min: Optional[float] = None,
    amount_max: Optional[float] = None,
    business_vertical_id: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    per_page: int = 50,
    sort_by: Optional[str] = "created_at",
    sort_dir: Optional[str] = "desc",
    export: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    df_str, dt_str, _, _ = _resolve_date_preset(preset, date_from, date_to)
    filter_params = {
        "date_from": df_str,
        "date_to": dt_str,
        "status": status,
        "approval_status": approval_status,
        "source_type": source_type,
        "customer_id": customer_id,
        "customer_segment": customer_segment,
        "created_by": created_by,
        "signatory_user_id": signatory_user_id,
        "lead_type": lead_type,
        "revision_number": revision_number,
        "source_portal": source_portal,
        "tender_result": tender_result,
        "valid_until_from": valid_until_from,
        "valid_until_to": valid_until_to,
        "validity_days": validity_days,
        "expired_only": expired_only,
        "amount_min": amount_min,
        "amount_max": amount_max,
        "business_vertical_id": business_vertical_id,
        "search": search,
    }

    CreatedUser = aliased(User)
    SignatoryUser = aliased(User)
    line_item_sub = (
        db.query(
            QuotationLineItem.quotation_id.label("quotation_id"),
            func.count(QuotationLineItem.id).label("line_item_count"),
        )
        .group_by(QuotationLineItem.quotation_id)
        .subquery()
    )

    base_q = (
        db.query(
            Quotation,
            Lead.lead_title.label("lead_title"),
            Lead.opportunity_ref_id.label("opportunity_ref_id"),
            Lead.lead_type.label("lead_type"),
            Tender.tender_num.label("tender_num"),
            Tender.tender_title.label("tender_title"),
            Tender.source_portal.label("source_portal"),
            Tender.source_id.label("source_id"),
            Lead.source_id.label("lead_source_id"),
            Tender.result.label("tender_result"),
            Customer.customer_name.label("customer_name"),
            Customer.customer_vertical.label("customer_segment"),
            CreatedUser.full_name.label("created_by_name"),
            SignatoryUser.full_name.label("signatory_name"),
            func.coalesce(line_item_sub.c.line_item_count, 0).label("line_item_count"),
        )
        .outerjoin(Lead, Quotation.lead_id == Lead.id)
        .outerjoin(Tender, Quotation.tender_id == Tender.id)
        .outerjoin(Customer, Quotation.customer_id == Customer.id)
        .outerjoin(CreatedUser, Quotation.created_by == CreatedUser.id)
        .outerjoin(SignatoryUser, Quotation.signatory_user_id == SignatoryUser.id)
        .outerjoin(line_item_sub, line_item_sub.c.quotation_id == Quotation.id)
    )
    base_q = _apply_quotation_scope(base_q, db, cu)
    base_q = _apply_quotation_filters(base_q, filter_params, db)
    total_count = base_q.count()

    sort_map = {
        "created_at": Quotation.created_at,
        "quotation_number": Quotation.quotation_number,
        "status": Quotation.status,
        "total_amount": Quotation.total_amount,
        "valid_until": Quotation.valid_until,
        "revision_number": Quotation.revision_number,
    }
    sort_col = sort_map.get(str(sort_by or "created_at"), Quotation.created_at)
    ordered_q = base_q.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())

    page_rows = ordered_q.all() if export else ordered_q.offset((page - 1) * per_page).limit(per_page).all()
    analytics_rows = base_q.order_by(None).all()
    today = today_ist()

    analytics_items: list[dict] = []
    for rec, lead_title_value, opportunity_ref_id_value, lead_type_value, tender_num_value, tender_title_value, source_portal_value, source_id_value, lead_source_id_value, tender_result_value, customer_name_value, customer_segment_value, created_by_name_value, signatory_name_value, line_item_count_value in analytics_rows:
        valid_dt = _to_date(rec.valid_until)
        days_to_validity = (valid_dt - today).days if valid_dt else None
        analytics_items.append({
            "id": rec.id,
            "status": rec.status or "",
            "approval_status": rec.approval_status or "none",
            "source_type": "tender" if rec.tender_id else "opportunity",
            "created_by": created_by_name_value or "",
            "customer_name": customer_name_value or "",
            "created_month": str(_to_date(rec.created_at) or "")[:7],
            "valid_month": str(valid_dt or "")[:7],
            "total_amount": _amount(rec.total_amount),
            "days_to_validity": days_to_validity,
            "revision_number": int(rec.revision_number or 0),
        })

    page_lead_ids_quot = {int(rec.lead_id) for rec, *_ in page_rows if rec.lead_id}
    page_tender_ids_quot = {int(rec.tender_id) for rec, *_ in page_rows if rec.tender_id}
    quot_lead_bv: dict[int, int] = {}
    if page_lead_ids_quot:
        for lid, bv_id in db.query(Lead.id, Lead.business_vertical_id).filter(Lead.id.in_(page_lead_ids_quot)).all():
            if bv_id:
                quot_lead_bv[int(lid)] = int(bv_id)
    quot_tender_bv: dict[int, int] = {}
    if page_tender_ids_quot:
        for tid, bv_id in db.query(Tender.id, Tender.business_vertical_id).filter(Tender.id.in_(page_tender_ids_quot)).all():
            if bv_id:
                quot_tender_bv[int(tid)] = int(bv_id)
    _quot_bv_all = set(quot_lead_bv.values()) | set(quot_tender_bv.values())
    bv_name_map = _resolve_business_vertical_names(db, _quot_bv_all)
    bv_group_map = _resolve_business_vertical_parent_names(db, _quot_bv_all)

    # source_id → name map (tender/lead store source_id; source_portal is
    # rarely set and defaults to "Other" — prefer the resolved lead-source
    # name, whichever of the tender or the originating lead has it set)
    page_quot_source_ids = {
        int(sid) for row in page_rows for sid in (row[7], row[8]) if sid
    }
    page_quot_source_map: dict[int, str] = {}
    if page_quot_source_ids:
        for ls in db.query(LeadSource).filter(LeadSource.id.in_(page_quot_source_ids)).all():
            page_quot_source_map[int(ls.id)] = ls.name

    data: list[dict] = []
    for rec, lead_title_value, opportunity_ref_id_value, lead_type_value, tender_num_value, tender_title_value, source_portal_value, source_id_value, lead_source_id_value, tender_result_value, customer_name_value, customer_segment_value, created_by_name_value, signatory_name_value, line_item_count_value in page_rows:
        valid_dt = _to_date(rec.valid_until)
        days_to_validity = (valid_dt - today).days if valid_dt else None
        validity_status = (
            "Expired" if days_to_validity is not None and days_to_validity < 0 else
            "Expiring" if days_to_validity is not None and days_to_validity <= 30 else
            "Active" if days_to_validity is not None else
            ""
        )
        _bv_id = quot_lead_bv.get(int(rec.lead_id or 0)) or quot_tender_bv.get(int(rec.tender_id or 0))
        data.append({
            "id": rec.id,
            "quotation_number": rec.quotation_number or "",
            "revision_number": int(rec.revision_number or 0),
            "revision_label": f"Q{int(rec.revision_number or 0)}" if rec.revision_number else "",
            "source_type": "tender" if rec.tender_id else "opportunity",
            "lead_title": lead_title_value or "",
            "opportunity_ref_id": opportunity_ref_id_value or "",
            "lead_type": lead_type_value or "",
            "tender_num": tender_num_value or "",
            "tender_title": tender_title_value or "",
            "source_portal": (
                page_quot_source_map.get(int(source_id_value or 0))
                or page_quot_source_map.get(int(lead_source_id_value or 0))
                or str(source_portal_value or "")
            ),
            "tender_result": tender_result_value or "",
            "customer_name": customer_name_value or "",
            "customer_segment": _clean_segment_name(customer_segment_value),
            "subject": rec.subject or "",
            "status": rec.status or "",
            "approval_status": rec.approval_status or "none",
            "amount": _amount(rec.amount),
            "tax_amount": _amount(rec.tax_amount),
            "total_amount": _amount(rec.total_amount),
            "valid_until": str(rec.valid_until) if rec.valid_until else "",
            "days_to_validity": days_to_validity,
            "validity_status": validity_status,
            "line_item_count": int(line_item_count_value or 0),
            "ref_number": rec.ref_number or "",
            "created_by": created_by_name_value or "",
            "signatory": signatory_name_value or "",
            "notes": (rec.notes or "")[:200],
            "created_at": str(rec.created_at)[:10] if rec.created_at else "",
            "business_vertical": bv_name_map.get(int(_bv_id or 0), "") if _bv_id else "",
            "business_vertical_group": bv_group_map.get(int(_bv_id or 0), "") if _bv_id else "",
        })

    if export:
        return _export(data, "quotations_report", export)

    issue_timeline: dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})
    validity_timeline: dict[str, dict] = defaultdict(lambda: {"count": 0, "accepted": 0, "expired": 0})
    owner_status_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    scatter_data: list[dict] = []
    status_strip_map: dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})

    for item in analytics_items:
        status_strip_map[item["status"]]["count"] += 1
        status_strip_map[item["status"]]["value"] += item["total_amount"]
        if item["created_month"]:
            issue_timeline[item["created_month"]]["count"] += 1
            issue_timeline[item["created_month"]]["value"] += item["total_amount"]
        if item["valid_month"]:
            validity_timeline[item["valid_month"]]["count"] += 1
            validity_timeline[item["valid_month"]]["accepted"] += int(item["status"] == "Accepted")
            validity_timeline[item["valid_month"]]["expired"] += int(
                item["days_to_validity"] is not None and item["days_to_validity"] < 0
            )
        owner_status_counts[item["created_by"] or "Unassigned"][item["status"]] += 1
        if item["days_to_validity"] is not None:
            scatter_data.append({
                "label": str(item["id"]),
                "revision": item["revision_number"],
                "amount": item["total_amount"],
                "days": int(item["days_to_validity"]),
                "status": item["status"],
                "source_type": item["source_type"],
            })

    status_labels = ["Draft", "Sent", "Approved", "Accepted", "Rejected"]
    heatmap_rows = []
    for owner_name, counts_by_status in sorted(
        owner_status_counts.items(),
        key=lambda item: -sum(item[1].values()),
    )[:10]:
        heatmap_rows.append({
            "owner": owner_name,
            "values": [counts_by_status.get(label, 0) for label in status_labels],
            "total": sum(counts_by_status.values()),
        })

    # Quotations never have a "paid amount" — they represent proposed business
    # value. Financial KPIs here are Quoted / Accepted / Rejected / Open value
    # and the average deal size, not anything payment-related.
    rejected_value = sum(item["total_amount"] for item in analytics_items if item["status"] == "Rejected")
    open_value = sum(
        item["total_amount"] for item in analytics_items if item["status"] in ("Draft", "Sent", "Approved")
    )

    summary = {
        "total": len(analytics_items),
        "total_amount": round(sum(item["total_amount"] for item in analytics_items), 2),
        "draft": sum(1 for item in analytics_items if item["status"] == "Draft"),
        "sent": sum(1 for item in analytics_items if item["status"] == "Sent"),
        "accepted": sum(1 for item in analytics_items if item["status"] == "Accepted"),
        "accepted_value": round(
            sum(item["total_amount"] for item in analytics_items if item["status"] == "Accepted"), 2
        ),
        "rejected_value": round(rejected_value, 2),
        "open_value": round(open_value, 2),
        "average_value": round(
            sum(item["total_amount"] for item in analytics_items) / len(analytics_items), 2
        ) if analytics_items else 0,
        "pending_approval": sum(1 for item in analytics_items if item["approval_status"] == "pending"),
        "expiring_30": sum(
            1
            for item in analytics_items
            if item["days_to_validity"] is not None and 0 <= item["days_to_validity"] <= 30
        ),
        "expired": sum(
            1
            for item in analytics_items
            if item["days_to_validity"] is not None and item["days_to_validity"] < 0
        ),
        "_date_from": df_str,
        "_date_to": dt_str,
    }

    customer_value_map: dict[str, float] = defaultdict(float)
    for item in analytics_items:
        if item["customer_name"]:
            customer_value_map[item["customer_name"]] += item["total_amount"]
    chart_top_customers = sorted(
        [{"name": name, "value": round(value, 2)} for name, value in customer_value_map.items()],
        key=lambda item: -item["value"],
    )[:10]

    return {
        "summary": summary,
        "data": data,
        "pagination": {
            "total": total_count,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "status_strip": [
            {"label": label, **status_strip_map.get(label, {"count": 0, "value": 0.0})}
            for label in status_labels
        ],
        "chart_issue_timeline": sorted(
            [{"label": label, **payload} for label, payload in issue_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_validity_timeline": sorted(
            [{"label": label, **payload} for label, payload in validity_timeline.items()],
            key=lambda item: item["label"],
        ),
        "chart_owner_heatmap": {
            "labels": status_labels,
            "rows": heatmap_rows,
            "max": max((value for row in heatmap_rows for value in row["values"]), default=0),
        },
        "chart_revision_scatter": sorted(
            scatter_data,
            key=lambda item: (item["revision"], -item["amount"]),
        )[:150],
        "chart_quoted_vs_accepted": {
            "quoted": summary["total_amount"],
            "accepted": summary["accepted_value"],
        },
        "chart_top_customers": chart_top_customers,
    }


@router.get("/insights")
def report_insights(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    """
    AI-style cross-module intelligence — no date filter (all-time view).
    """
    lead_source_map = {
        int(source.id): str(source.name or "").strip()
        for source in db.query(LeadSource).filter(LeadSource.is_active == True).all()
        if getattr(source, "id", None)
    }

    today = today_ist()
    this_week_start = today - timedelta(days=6)
    last_week_start = today - timedelta(days=13)
    last_week_end = today - timedelta(days=7)
    recent_activity_cutoff = today - timedelta(days=14)
    four_months_ago = now_ist() - timedelta(days=120)
    sla_days = 3

    users = db.query(User).all()
    leads = db.query(Lead).filter(Lead.is_deleted == False).all()
    tenders = db.query(Tender).filter(Tender.is_deleted == False).all()
    approvals = db.query(Approval).all()
    customers = db.query(Customer).filter(Customer.is_deleted == False).all()
    products = db.query(ProductMaster).filter(ProductMaster.is_active == True).all()
    lead_products = db.query(LeadProduct).all()
    tender_products = db.query(TenderProduct).all()
    tender_product_oems = db.query(TenderProductOEM).all()
    kam_activities = db.query(KAMActivity).all()
    work_orders = db.query(WorkOrder).all()
    wo_line_items = db.query(WOLineItem).all()

    user_map = {u.id: u for u in users if getattr(u, "id", None)}
    lead_map = {lead.id: lead for lead in leads if getattr(lead, "id", None)}
    tender_map = {tender.id: tender for tender in tenders if getattr(tender, "id", None)}
    customer_map = {customer.id: customer for customer in customers if getattr(customer, "id", None)}

    def resolve_name(user_id) -> str:
        user = user_map.get(user_id)
        return str(getattr(user, "full_name", "") or "")

    def resolve_role(user_id) -> str:
        user = user_map.get(user_id)
        return str(getattr(user, "role", "") or "")

    lead_products_by_lead: dict[int, list[LeadProduct]] = defaultdict(list)
    for product in lead_products:
        if getattr(product, "lead_id", None):
            lead_products_by_lead[int(product.lead_id)].append(product)

    tender_products_by_tender: dict[int, list[TenderProduct]] = defaultdict(list)
    for product in tender_products:
        if getattr(product, "tender_id", None):
            tender_products_by_tender[int(product.tender_id)].append(product)

    tender_oems_by_product: dict[int, list[TenderProductOEM]] = defaultdict(list)
    for oem in tender_product_oems:
        if getattr(oem, "tender_product_id", None):
            tender_oems_by_product[int(oem.tender_product_id)].append(oem)

    wo_products_map: dict[int, list[str]] = defaultdict(list)
    for line_item in wo_line_items:
        if getattr(line_item, "wo_id", None) and getattr(line_item, "product_name", None):
            wo_products_map[int(line_item.wo_id)].append(str(line_item.product_name))

    activity_template = lambda: {"count": 0, "recent_count": 0, "latest": None}
    lead_activity_stats: dict[int, dict] = defaultdict(activity_template)
    customer_activity_stats: dict[int, dict] = defaultdict(activity_template)

    def register_activity(stat_map: dict[int, dict], key, activity_dt):
        if not key:
            return
        stat = stat_map[int(key)]
        stat["count"] += 1
        if activity_dt and activity_dt >= recent_activity_cutoff:
            stat["recent_count"] += 1
        if activity_dt and (not stat["latest"] or activity_dt > stat["latest"]):
            stat["latest"] = activity_dt

    for activity in kam_activities:
        activity_dt = _to_date(getattr(activity, "activity_date", None)) or _to_date(getattr(activity, "created_at", None))
        register_activity(lead_activity_stats, getattr(activity, "lead_id", None), activity_dt)
        register_activity(customer_activity_stats, getattr(activity, "customer_id", None), activity_dt)

    customer_tender_history: dict[str, dict] = defaultdict(lambda: {
        "total": 0,
        "won": 0,
        "lost": 0,
        "pending": 0,
        "value": 0.0,
    })
    portal_history: dict[str, dict] = defaultdict(lambda: {
        "count": 0,
        "won": 0,
        "lost": 0,
        "value": 0.0,
    })
    latest_won_tender_by_customer: dict[str, Tender] = {}

    for tender in tenders:
        customer_key = _customer_key(getattr(tender, "customer_name", None), getattr(tender, "customer_id", None))
        tender_value = _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
        customer_tender_history[customer_key]["total"] += 1
        customer_tender_history[customer_key]["value"] += tender_value
        portal_key = str(getattr(tender, "source_portal", None) or "Other")
        portal_history[portal_key]["count"] += 1
        portal_history[portal_key]["value"] += tender_value

        result = str(getattr(tender, "result", "") or "Pending")
        if result == "Won":
            customer_tender_history[customer_key]["won"] += 1
            portal_history[portal_key]["won"] += 1
            previous = latest_won_tender_by_customer.get(customer_key)
            prev_date = _to_date(getattr(previous, "created_at", None)) if previous else None
            curr_date = _to_date(getattr(tender, "created_at", None))
            if not previous or (curr_date and (not prev_date or curr_date > prev_date)):
                latest_won_tender_by_customer[customer_key] = tender
        elif result == "Lost":
            customer_tender_history[customer_key]["lost"] += 1
            portal_history[portal_key]["lost"] += 1
        else:
            customer_tender_history[customer_key]["pending"] += 1

    # ── 1. Executive Summary + Phase 1 insight builders ──────────────────────
    open_leads = [lead for lead in leads if str(getattr(lead, "status", "") or "") not in {"Converted", "Lost"}]
    open_tenders = [tender for tender in tenders if str(getattr(tender, "result", "") or "Pending") == "Pending"]

    lead_weight_map = {
        "Assigned": 0.18,
        "Qualified": 0.35,
        "Opportunity Created": 0.55,
    }
    tender_weight_map = {
        "Aligned": 0.28,
        "Pre-Bid": 0.4,
        "Submitted": 0.6,
        "Evaluation": 0.7,
        "Reverse Auction": 0.78,
        "Closed": 0.15,
    }

    this_week_pipeline_value = round(
        sum(
            _amount(getattr(lead, "est_value", None))
            for lead in open_leads
            if (_to_date(getattr(lead, "created_at", None)) or today) >= this_week_start
        )
        + sum(
            _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
            for tender in open_tenders
            if (_to_date(getattr(tender, "created_at", None)) or today) >= this_week_start
        ),
        2,
    )
    last_week_pipeline_value = round(
        sum(
            _amount(getattr(lead, "est_value", None))
            for lead in open_leads
            if last_week_start <= (_to_date(getattr(lead, "created_at", None)) or today) <= last_week_end
        )
        + sum(
            _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
            for tender in open_tenders
            if last_week_start <= (_to_date(getattr(tender, "created_at", None)) or today) <= last_week_end
        ),
        2,
    )
    pipeline_delta_pct = round(
        ((this_week_pipeline_value - last_week_pipeline_value) / last_week_pipeline_value * 100)
        if last_week_pipeline_value
        else (100.0 if this_week_pipeline_value else 0.0),
        1,
    )

    expected_revenue = round(
        sum(
            _amount(getattr(lead, "est_value", None)) * lead_weight_map.get(str(getattr(lead, "status", "") or ""), 0.15)
            for lead in open_leads
        )
        + sum(
            _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
            * tender_weight_map.get(str(getattr(tender, "tender_status", "") or ""), 0.25)
            for tender in open_tenders
        ),
        2,
    )

    this_week_closed_leads = [
        lead for lead in leads
        if (
            (_to_date(getattr(lead, "converted_at", None)) and this_week_start <= _to_date(getattr(lead, "converted_at", None)) <= today)
            or (_to_date(getattr(lead, "lost_at", None)) and this_week_start <= _to_date(getattr(lead, "lost_at", None)) <= today)
        )
    ]
    last_week_closed_leads = [
        lead for lead in leads
        if (
            (_to_date(getattr(lead, "converted_at", None)) and last_week_start <= _to_date(getattr(lead, "converted_at", None)) <= last_week_end)
            or (_to_date(getattr(lead, "lost_at", None)) and last_week_start <= _to_date(getattr(lead, "lost_at", None)) <= last_week_end)
        )
    ]
    this_week_conversions = sum(1 for lead in this_week_closed_leads if getattr(lead, "status", None) == "Converted")
    last_week_conversions = sum(1 for lead in last_week_closed_leads if getattr(lead, "status", None) == "Converted")
    conversion_rate_this_week = round(
        this_week_conversions / len(this_week_closed_leads) * 100, 1
    ) if this_week_closed_leads else 0.0
    conversion_rate_last_week = round(
        last_week_conversions / len(last_week_closed_leads) * 100, 1
    ) if last_week_closed_leads else 0.0
    conversion_delta_pct = round(conversion_rate_this_week - conversion_rate_last_week, 1)

    # ── Approval intelligence ────────────────────────────────────────────────
    def approval_value(approval: Approval) -> float:
        module = str(getattr(approval, "module", "") or "")
        record_id = getattr(approval, "record_id", None)
        if module == "lead":
            lead = lead_map.get(record_id)
            return _amount(getattr(lead, "est_value", None))
        if module == "tender":
            tender = tender_map.get(record_id)
            return _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
        if module == "customer":
            customer = customer_map.get(record_id)
            return _amount(getattr(customer, "potential_value", None) or getattr(customer, "annual_revenue", None))
        return 0.0

    approval_rows = []
    rejection_counter: Counter[str] = Counter()
    for approval in approvals:
        notes = str(getattr(approval, "rejection_reason", None) or getattr(approval, "decision_notes", None) or "")
        if getattr(approval, "status", None) == "rejected":
            rejection_counter[_approval_reason_bucket(notes)] += 1
        approval_rows.append({
            "id": approval.id,
            "module": str(getattr(approval, "module", "") or "").title(),
            "action": str(getattr(approval, "action", "") or "").replace("_", " ").title(),
            "status": str(getattr(approval, "status", "") or ""),
            "record_ref": str(getattr(approval, "record_ref", None) or f"{str(getattr(approval, 'module', '') or 'Record').title()} #{getattr(approval, 'record_id', '')}"),
            "record_id": getattr(approval, "record_id", None),
            "requested_to_id": getattr(approval, "requested_to", None),
            "requested_to": resolve_name(getattr(approval, "requested_to", None)) or "Unassigned",
            "requested_to_role": resolve_role(getattr(approval, "requested_to", None)),
            "requested_by": resolve_name(getattr(approval, "requested_by", None)) or "System",
            "age_days": _days_since(getattr(approval, "created_at", None), today),
            "value": round(approval_value(approval), 2),
            "notes": notes,
        })

    pending_approval_rows = [row for row in approval_rows if row["status"] == "pending"]
    stuck_approval_rows = [row for row in pending_approval_rows if row["age_days"] > sla_days]
    bottleneck_stats: dict[int, dict] = defaultdict(lambda: {
        "approver_name": "Unassigned",
        "approver_role": "",
        "pending_count": 0,
        "total_age": 0,
        "stuck_count": 0,
        "stuck_value": 0.0,
    })
    for row in pending_approval_rows:
        key = int(row["requested_to_id"] or 0)
        stat = bottleneck_stats[key]
        stat["approver_name"] = row["requested_to"]
        stat["approver_role"] = row["requested_to_role"]
        stat["pending_count"] += 1
        stat["total_age"] += int(row["age_days"])
        if row["age_days"] > sla_days:
            stat["stuck_count"] += 1
            stat["stuck_value"] += _amount(row["value"])

    bottlenecks = sorted(
        [
            {
                "approver_name": stat["approver_name"],
                "approver_role": stat["approver_role"] or "—",
                "pending_count": stat["pending_count"],
                "avg_age_days": round(stat["total_age"] / stat["pending_count"], 1) if stat["pending_count"] else 0,
                "stuck_count": stat["stuck_count"],
                "stuck_value": round(stat["stuck_value"], 2),
            }
            for stat in bottleneck_stats.values()
            if stat["pending_count"] > 0
        ],
        key=lambda row: (row["pending_count"], row["avg_age_days"], row["stuck_value"]),
        reverse=True,
    )[:5]
    rejection_patterns = [
        {"reason": reason, "count": count}
        for reason, count in rejection_counter.most_common(5)
    ]

    approval_intelligence = {
        "summary": {
            "pending_count": len(pending_approval_rows),
            "sla_breach_count": len(stuck_approval_rows),
            "pending_value": round(sum(_amount(row["value"]) for row in pending_approval_rows), 2),
            "sla_breach_value": round(sum(_amount(row["value"]) for row in stuck_approval_rows), 2),
            "manager_queue": sum(1 for row in pending_approval_rows if row["requested_to_role"] in {"manager", "vp"}),
            "ceo_queue": sum(1 for row in pending_approval_rows if row["requested_to_role"] in {"ceo", "admin"}),
            "sla_days": sla_days,
        },
        "bottleneck_person": bottlenecks[0] if bottlenecks else None,
        "bottlenecks": bottlenecks,
        "rejection_patterns": rejection_patterns,
        "stuck_items": sorted(
            stuck_approval_rows,
            key=lambda row: (row["age_days"], row["value"]),
            reverse=True,
        )[:8],
    }

    # ── Lead conversion intelligence ─────────────────────────────────────────
    lead_priority_rows = []
    for lead in open_leads:
        lead_value = _amount(getattr(lead, "est_value", None))
        lead_age_days = _days_since(getattr(lead, "created_at", None), today)
        lead_stat = lead_activity_stats.get(int(getattr(lead, "id", 0) or 0))
        customer_stat = customer_activity_stats.get(int(getattr(lead, "customer_id", 0) or 0))
        latest_activity = None
        recent_activity_count = 0
        if lead_stat and lead_stat.get("latest"):
            latest_activity = lead_stat["latest"]
            recent_activity_count = max(recent_activity_count, int(lead_stat.get("recent_count", 0)))
        if customer_stat and customer_stat.get("latest") and (not latest_activity or customer_stat["latest"] > latest_activity):
            latest_activity = customer_stat["latest"]
        if customer_stat:
            recent_activity_count = max(recent_activity_count, int(customer_stat.get("recent_count", 0)))

        idle_days = _days_since(latest_activity, today) if latest_activity else lead_age_days
        follow_up_date = _to_date(getattr(lead, "follow_up", None))
        overdue_days = max((today - follow_up_date).days, 0) if follow_up_date and follow_up_date < today else 0

        score = 24.0
        signals: list[tuple[float, str, str]] = []
        stage = str(getattr(lead, "status", "") or "")
        stage_bonus = {
            "Assigned": 8,
            "Qualified": 18,
            "Opportunity Created": 28,
        }.get(stage, 0)
        if stage_bonus:
            score += stage_bonus
            signals.append((stage_bonus, f"{stage} stage is still moving", "positive"))

        if lead_value >= 10000000:
            score += 20
            signals.append((20, "High-value opportunity", "positive"))
        elif lead_value >= 2500000:
            score += 12
            signals.append((12, "Strong deal value", "positive"))
        elif lead_value >= 500000:
            score += 6
            signals.append((6, "Meaningful pipeline value", "positive"))

        if str(getattr(lead, "priority", "") or "") == "High":
            score += 6
            signals.append((6, "Marked as high priority", "positive"))

        if getattr(lead, "assigned_to", None):
            score += 4
        if getattr(lead, "customer_id", None) or getattr(lead, "customer_name", None):
            score += 6
            signals.append((6, "Linked to a named customer", "positive"))

        if recent_activity_count >= 2 or idle_days <= 7:
            score += 12
            signals.append((12, "Recent follow-up activity recorded", "positive"))
        elif idle_days > 21:
            score -= 18
            signals.append((-18, f"No recent activity for {idle_days} days", "negative"))
        elif idle_days > 14:
            score -= 10
            signals.append((-10, f"Activity slowed over the last {idle_days} days", "negative"))

        if follow_up_date:
            days_to_follow_up = (follow_up_date - today).days
            if days_to_follow_up < 0:
                score -= 10
                signals.append((-10, "Follow-up is overdue", "negative"))
            elif days_to_follow_up <= 3:
                score += 8
                signals.append((8, "Follow-up is already scheduled", "positive"))
            elif days_to_follow_up <= 7:
                score += 4
                signals.append((4, "Follow-up is scheduled this week", "positive"))
        else:
            score -= 5
            signals.append((-5, "No next follow-up date is set", "negative"))

        if lead_age_days > 30 and stage == "Assigned":
            score -= 12
            signals.append((-12, "Assigned lead has aged without moving stages", "negative"))
        elif lead_age_days > 21:
            score -= 6
            signals.append((-6, "Lead has been open for more than 3 weeks", "negative"))

        score = _clamp_score(score)
        temperature = "Hot" if score >= 70 else "Warm" if score >= 45 else "Cold"
        going_cold = idle_days > 10 or overdue_days > 3 or (lead_age_days > 30 and stage == "Assigned")

        if overdue_days > 0:
            next_action = "Call customer and close overdue follow-up"
            action_window = "Today"
        elif not follow_up_date:
            next_action = "Schedule the next follow-up and confirm owner"
            action_window = "Today"
        elif stage == "Assigned":
            next_action = "Qualify the requirement and confirm scope"
            action_window = "48 Hours" if (follow_up_date - today).days <= 2 else "This Week"
        elif stage == "Qualified":
            next_action = "Book meeting/demo and push the next milestone"
            action_window = "48 Hours" if (follow_up_date - today).days <= 2 else "This Week"
        else:
            next_action = "Advance proposal and prepare tender conversion"
            action_window = "This Week"

        priority_score = score + (12 if action_window == "Today" else 6 if action_window == "48 Hours" else 2) + (8 if going_cold else 0)
        lead_priority_rows.append({
            "lead_id": getattr(lead, "id", None),
            "lead_title": str(getattr(lead, "lead_title", None) or "—"),
            "customer_name": str(getattr(lead, "customer_name", None) or "Unknown"),
            "assigned_to": resolve_name(getattr(lead, "assigned_to", None)) or "Unassigned",
            "status": stage or "—",
            "score": score,
            "temperature": temperature,
            "lead_value": round(lead_value, 2),
            "days_idle": idle_days,
            "days_open": lead_age_days,
            "follow_up_priority": action_window,
            "going_cold": going_cold,
            "next_best_action": next_action,
            "signals": _top_signal_payload(signals),
            "priority_score": priority_score,
        })

    lead_priority_rows = sorted(
        lead_priority_rows,
        key=lambda row: (row["priority_score"], row["score"], row["lead_value"]),
        reverse=True,
    )
    lead_conversion_intelligence = {
        "summary": {
            "open_leads": len(open_leads),
            "hot_leads": sum(1 for row in lead_priority_rows if row["temperature"] == "Hot"),
            "warm_leads": sum(1 for row in lead_priority_rows if row["temperature"] == "Warm"),
            "going_cold": sum(1 for row in lead_priority_rows if row["going_cold"]),
            "follow_up_today": sum(1 for row in lead_priority_rows if row["follow_up_priority"] == "Today"),
        },
        "priority_leads": lead_priority_rows[:10],
    }

    # ── Tender win probability ───────────────────────────────────────────────
    tender_probability_rows = []
    for tender in open_tenders:
        tender_value = _amount(getattr(tender, "bid_amount", None) or getattr(tender, "est_value", None))
        tender_status = str(getattr(tender, "tender_status", "") or "")
        workflow_status = str(getattr(tender, "workflow_status", "") or "").lower()
        tech_bid_eligible = str(getattr(tender, "tech_bid_eligible", "") or "")
        customer_key = _customer_key(getattr(tender, "customer_name", None), getattr(tender, "customer_id", None))
        customer_history = customer_tender_history.get(customer_key, {"won": 0, "lost": 0, "total": 0})
        portal_key = str(getattr(tender, "source_portal", None) or "Other")
        portal_stat = portal_history.get(portal_key, {"won": 0, "lost": 0, "count": 0})

        score = 30.0
        signals: list[tuple[float, str, str]] = []
        status_bonus = {
            "Aligned": 8,
            "Pre-Bid": 10,
            "Submitted": 16,
            "Evaluation": 20,
            "Reverse Auction": 18,
            "Closed": -15,
        }.get(tender_status, 0)
        if status_bonus:
            score += status_bonus
            signals.append((status_bonus, f"{tender_status} stage drives current confidence", "positive" if status_bonus > 0 else "negative"))

        current_step = int(getattr(tender, "current_step", 1) or 1)
        if current_step >= 4:
            score += 10
            signals.append((10, "Tender is already in advanced workflow steps", "positive"))
        elif current_step == 3:
            score += 6
            signals.append((6, "Tender has progressed past initial setup", "positive"))
        elif current_step == 1:
            score -= 4
            signals.append((-4, "Tender is still at an early workflow step", "negative"))

        if "active" in workflow_status or "approved" in workflow_status:
            score += 8
            signals.append((8, "Workflow approvals are already in motion", "positive"))
        elif "pending" in workflow_status:
            score += 4
            signals.append((4, "Workflow is pending but still moving", "neutral"))
        elif "rejected" in workflow_status:
            score -= 25
            signals.append((-25, "Workflow already saw a rejection state", "negative"))

        if tech_bid_eligible == "Eligible":
            score += 15
            signals.append((15, "Technical eligibility is confirmed", "positive"))
        elif tech_bid_eligible == "Not Eligible":
            score -= 35
            signals.append((-35, "Technical eligibility is not cleared", "negative"))
        elif tech_bid_eligible and tech_bid_eligible != "Not Evaluated":
            score += 4

        related_products = tender_products_by_tender.get(int(getattr(tender, "id", 0) or 0), [])
        oem_rows = [oem for product in related_products for oem in tender_oems_by_product.get(int(getattr(product, "id", 0) or 0), [])]
        authorized_oem_count = sum(
            1
            for oem in oem_rows
            if getattr(oem, "is_authorized", False) or getattr(oem, "is_preferred", False) or getattr(oem, "authorization_num", None)
        )
        if authorized_oem_count > 0 or any(getattr(product, "oem_name", None) for product in related_products if getattr(product, "is_final_boq", False)):
            score += 10
            signals.append((10, "OEM coverage looks strong for this tender", "positive"))
        elif oem_rows:
            score += 3
        else:
            score -= 10
            signals.append((-10, "Weak OEM coverage for the current tender", "negative"))

        customer_stat = customer_activity_stats.get(int(getattr(tender, "customer_id", 0) or 0))
        latest_customer_activity = customer_stat.get("latest") if customer_stat else None
        idle_days = _days_since(latest_customer_activity, today) if latest_customer_activity else _days_since(getattr(tender, "created_at", None), today)
        if latest_customer_activity and idle_days <= 7:
            score += 8
            signals.append((8, "Recent customer engagement is visible", "positive"))
        elif idle_days > 21:
            score -= 12
            signals.append((-12, f"Low recent activity for {idle_days} days", "negative"))
        elif idle_days > 14:
            score -= 8
            signals.append((-8, "Customer engagement is slowing down", "negative"))

        submission_date = _to_date(getattr(tender, "submission_date", None))
        days_to_submission = (submission_date - today).days if submission_date else None
        if days_to_submission is not None:
            if days_to_submission < 0:
                score -= 15
                signals.append((-15, "Submission date passed but tender is still open", "negative"))
            elif days_to_submission <= 3 and idle_days > 7:
                score -= 12
                signals.append((-12, "Late follow-up before submission deadline", "negative"))
            elif days_to_submission <= 7:
                score += 4
                signals.append((4, "Tender is close enough to convert near term", "neutral"))

        closed_customer_tenders = customer_history.get("won", 0) + customer_history.get("lost", 0)
        customer_win_rate = round(customer_history.get("won", 0) / closed_customer_tenders * 100, 1) if closed_customer_tenders else 0.0
        if closed_customer_tenders >= 2:
            if customer_win_rate >= 40:
                score += 10
                signals.append((10, "Strong past win rate with this customer", "positive"))
            elif customer_win_rate <= 15:
                score -= 8
                signals.append((-8, "Poor past win rate with this customer", "negative"))

        closed_portal_tenders = portal_stat.get("won", 0) + portal_stat.get("lost", 0)
        portal_win_rate = round(portal_stat.get("won", 0) / closed_portal_tenders * 100, 1) if closed_portal_tenders else 0.0
        if closed_portal_tenders >= 3:
            if portal_win_rate >= 35:
                score += 6
                signals.append((6, f"{portal_key} has been a stronger portal historically", "positive"))
            elif portal_win_rate <= 15:
                score -= 6
                signals.append((-6, f"{portal_key} has a weaker recent win profile", "negative"))

        score = _clamp_score(score)
        probability_band = _score_band(score, high=70, medium=45)

        tender_probability_rows.append({
            "tender_id": getattr(tender, "id", None),
            "tender_title": str(getattr(tender, "tender_title", None) or getattr(tender, "portal_ref_number", None) or "—"),
            "customer_name": str(getattr(tender, "customer_name", None) or "Unknown"),
            "assigned_to": resolve_name(getattr(tender, "assigned_to", None)) or "Unassigned",
            "portal": portal_key,
            "status": tender_status or "—",
            "score": score,
            "probability_band": probability_band,
            "tender_value": round(tender_value, 2),
            "days_to_submission": days_to_submission,
            "customer_win_rate": customer_win_rate,
            "portal_win_rate": portal_win_rate,
            "signals": _top_signal_payload(signals),
        })

    tender_probability_rows = sorted(
        tender_probability_rows,
        key=lambda row: (row["score"], row["tender_value"]),
        reverse=True,
    )
    tender_win_probability = {
        "summary": {
            "open_tenders": len(open_tenders),
            "high_probability": sum(1 for row in tender_probability_rows if row["probability_band"] == "High"),
            "medium_probability": sum(1 for row in tender_probability_rows if row["probability_band"] == "Medium"),
            "low_probability": sum(1 for row in tender_probability_rows if row["probability_band"] == "Low"),
            "open_tender_value": round(sum(row["tender_value"] for row in tender_probability_rows), 2),
            "high_probability_value": round(sum(row["tender_value"] for row in tender_probability_rows if row["probability_band"] == "High"), 2),
        },
        "tenders": tender_probability_rows[:10],
    }

    conversion_alerts: list[str] = []
    if conversion_rate_this_week + 5 < conversion_rate_last_week:
        conversion_alerts.append(
            f"Lead conversion rate is down {abs(conversion_delta_pct):.1f} pts versus last week."
        )
    if approval_intelligence["summary"]["sla_breach_count"] > 0:
        conversion_alerts.append(
            f"{approval_intelligence['summary']['sla_breach_count']} approvals are already beyond the {sla_days}-day SLA."
        )
    if tender_win_probability["summary"]["low_probability"] > 0:
        conversion_alerts.append(
            f"{tender_win_probability['summary']['low_probability']} open tenders are in the low-confidence band."
        )

    cold_leads = [row for row in lead_priority_rows if row["going_cold"]]
    high_probability_tenders = [row for row in tender_probability_rows if row["probability_band"] == "High"]
    low_probability_tenders = [row for row in tender_probability_rows if row["probability_band"] == "Low"]
    best_portal = next(
        (
            row for row in sorted(
                [
                    {
                        "portal": portal,
                        "closed": stats["won"] + stats["lost"],
                        "win_rate": round(stats["won"] / (stats["won"] + stats["lost"]) * 100, 1) if (stats["won"] + stats["lost"]) else 0.0,
                    }
                    for portal, stats in portal_history.items()
                    if (stats["won"] + stats["lost"]) >= 2
                ],
                key=lambda row: (row["win_rate"], row["closed"]),
                reverse=True,
            )
        ),
        None,
    )

    top_risks = []
    if approval_intelligence["summary"]["sla_breach_count"] > 0:
        bottleneck_name = approval_intelligence["bottleneck_person"]["approver_name"] if approval_intelligence["bottleneck_person"] else "Approval queue"
        top_risks.append({
            "title": f"{approval_intelligence['summary']['sla_breach_count']} approvals are stuck beyond SLA",
            "detail": f"{bottleneck_name} currently has the heaviest approval bottleneck.",
            "value": approval_intelligence["summary"]["sla_breach_value"],
            "tone": "negative",
        })
    if cold_leads:
        top_risks.append({
            "title": f"{len(cold_leads)} leads are going cold",
            "detail": "These leads need immediate follow-up to avoid conversion drop.",
            "value": round(sum(row["lead_value"] for row in cold_leads), 2),
            "tone": "negative",
        })
    if low_probability_tenders:
        top_risks.append({
            "title": f"{len(low_probability_tenders)} tenders have low win confidence",
            "detail": "Weak OEM coverage, low activity, or poor historical win rate is dragging confidence.",
            "value": round(sum(row["tender_value"] for row in low_probability_tenders), 2),
            "tone": "negative",
        })

    top_opportunities = []
    if high_probability_tenders:
        top_opportunities.append({
            "title": f"{len(high_probability_tenders)} tenders have high win probability",
            "detail": "These are the best near-term tender bets in the current pipeline.",
            "value": round(sum(row["tender_value"] for row in high_probability_tenders), 2),
            "tone": "positive",
        })
    hot_leads = [row for row in lead_priority_rows if row["temperature"] == "Hot"]
    if hot_leads:
        top_opportunities.append({
            "title": f"{len(hot_leads)} leads are ready for focused follow-up",
            "detail": "These leads already have the strongest conversion signals.",
            "value": round(sum(row["lead_value"] for row in hot_leads), 2),
            "tone": "positive",
        })
    if best_portal:
        top_opportunities.append({
            "title": f"{best_portal['portal']} is the strongest portal right now",
            "detail": f"Closed tenders on this portal are winning at {best_portal['win_rate']:.1f}%.",
            "value": 0.0,
            "tone": "positive",
        })

    executive_summary = {
        "pipeline_value_this_week": this_week_pipeline_value,
        "pipeline_value_last_week": last_week_pipeline_value,
        "pipeline_delta_pct": pipeline_delta_pct,
        "expected_revenue": expected_revenue,
        "this_week_conversions": this_week_conversions,
        "last_week_conversions": last_week_conversions,
        "conversion_rate_this_week": conversion_rate_this_week,
        "conversion_rate_last_week": conversion_rate_last_week,
        "conversion_delta_pct": conversion_delta_pct,
        "top_risks": top_risks[:3],
        "top_opportunities": top_opportunities[:3],
        "conversion_alerts": conversion_alerts,
    }

    # ── 2. Top customers by tender bid value ─────────────────────────────────
    cust_tender: dict = defaultdict(lambda: {
        "count": 0, "won": 0, "lost": 0, "pending": 0,
        "total_bid": 0.0, "products": set(), "oems": set(),
    })
    for tender in tenders:
        customer_name = str(getattr(tender, "customer_name", None) or "Unknown")
        cust_tender[customer_name]["count"] += 1
        result = str(getattr(tender, "result", "") or "Pending")
        if result == "Won":
            cust_tender[customer_name]["won"] += 1
        elif result == "Lost":
            cust_tender[customer_name]["lost"] += 1
        else:
            cust_tender[customer_name]["pending"] += 1
        cust_tender[customer_name]["total_bid"] += _amount(getattr(tender, "bid_amount", None))
        for product in tender_products_by_tender.get(int(getattr(tender, "id", 0) or 0), []):
            if getattr(product, "is_final_boq", False):
                continue
            if getattr(product, "product_name", None):
                cust_tender[customer_name]["products"].add(str(product.product_name))
            for oem in tender_oems_by_product.get(int(getattr(product, "id", 0) or 0), []):
                if getattr(oem, "oem_name", None):
                    cust_tender[customer_name]["oems"].add(str(oem.oem_name))

    top_customers = sorted(
        [
            {
                "customer": customer,
                "tender_count": stats["count"],
                "won": stats["won"],
                "lost": stats["lost"],
                "pending": stats["pending"],
                "win_rate": round(stats["won"] / stats["count"] * 100, 1) if stats["count"] else 0,
                "total_bid_value": round(stats["total_bid"], 2),
                "products": ", ".join(list(stats["products"])[:5]),
                "oems": ", ".join(list(stats["oems"])[:5]),
            }
            for customer, stats in cust_tender.items()
        ],
        key=lambda row: row["total_bid_value"],
        reverse=True,
    )[:15]

    # ── 3. Top OEMs by supply frequency ──────────────────────────────────────
    tender_result_map = {
        int(getattr(tender, "id", 0) or 0): (
            str(getattr(tender, "result", "") or "Pending"),
            str(getattr(tender, "customer_name", None) or "Unknown"),
        )
        for tender in tenders
        if getattr(tender, "id", None)
    }
    oem_data: dict = defaultdict(lambda: {
        "tender_count": 0, "won_count": 0, "products": set(), "customers": set()
    })
    for product in tender_products:
        tender_result, tender_customer = tender_result_map.get(int(getattr(product, "tender_id", 0) or 0), ("Pending", "Unknown"))
        for oem in tender_oems_by_product.get(int(getattr(product, "id", 0) or 0), []):
            oem_name = str(getattr(oem, "oem_name", None) or "Unknown OEM")
            oem_data[oem_name]["tender_count"] += 1
            if tender_result == "Won":
                oem_data[oem_name]["won_count"] += 1
            if getattr(product, "product_name", None):
                oem_data[oem_name]["products"].add(str(product.product_name))
            oem_data[oem_name]["customers"].add(tender_customer)

    top_oems = sorted(
        [
            {
                "oem_name": oem_name,
                "tender_count": stats["tender_count"],
                "won_count": stats["won_count"],
                "win_rate": round(stats["won_count"] / stats["tender_count"] * 100, 1) if stats["tender_count"] else 0,
                "products_supplied": ", ".join(list(stats["products"])[:6]),
                "customers_served": ", ".join(list(stats["customers"])[:5]),
            }
            for oem_name, stats in oem_data.items()
        ],
        key=lambda row: row["tender_count"],
        reverse=True,
    )[:15]

    # ── 4. Customer × Product matrix ─────────────────────────────────────────
    cp_matrix: dict = defaultdict(lambda: defaultdict(int))
    for tender in tenders:
        customer_name = str(getattr(tender, "customer_name", None) or "Unknown")
        for product in tender_products_by_tender.get(int(getattr(tender, "id", 0) or 0), []):
            if getattr(product, "is_final_boq", False):
                continue
            if getattr(product, "product_name", None):
                cp_matrix[customer_name][str(product.product_name)] += 1

    customer_product_matrix = [
        {
            "customer": customer,
            "top_products": ", ".join(
                product_name for product_name, _ in sorted(products_map.items(), key=lambda item: item[1], reverse=True)[:5]
            ),
            "product_count": len(products_map),
            "total_occurrences": sum(products_map.values()),
        }
        for customer, products_map in sorted(
            cp_matrix.items(), key=lambda item: sum(item[1].values()), reverse=True
        )[:15]
    ]

    # ── 5. Win/loss by source portal ─────────────────────────────────────────
    portal_analysis = sorted(
        [
            {
                "portal": portal,
                "total": stats["count"],
                "won": stats["won"],
                "lost": stats["lost"],
                "win_rate": round(stats["won"] / stats["count"] * 100, 1) if stats["count"] else 0,
                "total_value": round(stats["value"], 2),
            }
            for portal, stats in portal_history.items()
        ],
        key=lambda row: row["total"],
        reverse=True,
    )

    # ── 6. Top performing staff by wins ──────────────────────────────────────
    staff_stats: dict = defaultdict(lambda: {"leads": 0, "tenders": 0, "won": 0, "value": 0.0})
    for lead in leads:
        assignee_name = resolve_name(getattr(lead, "assigned_to", None)) or "Unassigned"
        staff_stats[assignee_name]["leads"] += 1
    for tender in tenders:
        assignee_name = resolve_name(getattr(tender, "assigned_to", None)) or "Unassigned"
        staff_stats[assignee_name]["tenders"] += 1
        if getattr(tender, "result", None) == "Won":
            staff_stats[assignee_name]["won"] += 1
            staff_stats[assignee_name]["value"] += _amount(getattr(tender, "bid_amount", None))

    top_staff = sorted(
        [
            {
                "name": name,
                "leads": stats["leads"],
                "tenders": stats["tenders"],
                "won": stats["won"],
                "won_value": round(stats["value"], 2),
                "win_rate": round(stats["won"] / stats["tenders"] * 100, 1) if stats["tenders"] else 0,
            }
            for name, stats in staff_stats.items()
            if name != "Unassigned"
        ],
        key=lambda row: row["won_value"],
        reverse=True,
    )[:10]

    # ── 7. Pipeline health ────────────────────────────────────────────────────
    total_leads = len(leads)
    converted_leads = sum(1 for lead in leads if getattr(lead, "status", None) == "Converted")
    total_tenders = len(tenders)
    won_tenders = sum(1 for tender in tenders if getattr(tender, "result", None) == "Won")
    pipeline_health = {
        "total_leads": total_leads,
        "leads_converted": converted_leads,
        "lead_conversion_rate": round(converted_leads / total_leads * 100, 1) if total_leads else 0,
        "total_tenders": total_tenders,
        "tenders_won": won_tenders,
        "tender_win_rate": round(won_tenders / total_tenders * 100, 1) if total_tenders else 0,
    }

    # ── 8. Customers with unconverted leads ──────────────────────────────────
    unconverted_leads: dict = defaultdict(lambda: {
        "lead_count": 0, "products": set(), "lead_titles": []
    })
    for lead in leads:
        if getattr(lead, "status", None) not in {"Assigned", "Qualified", "Lost"}:
            continue
        customer_name = str(getattr(lead, "customer_name", None) or "Unknown")
        unconverted_leads[customer_name]["lead_count"] += 1
        unconverted_leads[customer_name]["lead_titles"].append(str(getattr(lead, "lead_title", None) or "—"))
        for product in lead_products_by_lead.get(int(getattr(lead, "id", 0) or 0), []):
            if getattr(product, "product_name", None):
                unconverted_leads[customer_name]["products"].add(str(product.product_name))

    customers_with_unconverted_leads = sorted(
        [
            {
                "customer": customer,
                "unconverted_lead_count": stats["lead_count"],
                "lead_titles": ", ".join(stats["lead_titles"][:3]),
                "products": ", ".join(list(stats["products"])[:5]),
            }
            for customer, stats in unconverted_leads.items()
        ],
        key=lambda row: row["unconverted_lead_count"],
        reverse=True,
    )[:15]

    # ── 9. Customers with no leads in past 4 months ──────────────────────────
    all_customer_names_from_activity = {
        str(getattr(tender, "customer_name", None) or "").strip()
        for tender in tenders
        if getattr(tender, "customer_name", None)
    } | {
        str(getattr(lead, "customer_name", None) or "").strip()
        for lead in leads
        if getattr(lead, "customer_name", None)
    }
    customers_with_recent_leads = {
        str(getattr(lead, "customer_name", None) or "").strip()
        for lead in leads
        if getattr(lead, "customer_name", None) and getattr(lead, "created_at", None) and lead.created_at >= four_months_ago
    }
    customers_no_recent_leads = all_customer_names_from_activity - customers_with_recent_leads
    inactive_customers = []
    for customer_name in customers_no_recent_leads:
        related_tenders = [tender for tender in tenders if str(getattr(tender, "customer_name", None) or "").strip() == customer_name]
        last_tender = max(
            related_tenders,
            key=lambda tender: _to_date(getattr(tender, "created_at", None)) or date.min,
            default=None,
        )
        last_activity = _to_date(getattr(last_tender, "created_at", None)).isoformat() if last_tender and _to_date(getattr(last_tender, "created_at", None)) else "Never"
        inactive_customers.append({
            "customer": customer_name,
            "total_tenders": len(related_tenders),
            "last_activity": last_activity,
        })
    customers_no_leads_4_months = sorted(
        inactive_customers,
        key=lambda row: row["last_activity"],
        reverse=True,
    )[:15]

    # ── 10. Products not given to any customer ───────────────────────────────
    used_products = {
        str(getattr(product, "product_name", None) or "").strip()
        for product in tender_products
        if getattr(product, "product_name", None)
    } | {
        str(getattr(product, "product_name", None) or "").strip()
        for product in lead_products
        if getattr(product, "product_name", None)
    }
    products_not_used = sorted(
        [
            {
                "product_name": str(getattr(product, "name", None) or "—"),
                "category": str(getattr(product, "category", None) or "—"),
                "description": str(getattr(product, "description", None) or "—"),
            }
            for product in products
            if getattr(product, "name", None) and str(product.name) not in used_products
        ],
        key=lambda row: row["product_name"],
    )[:20]

    # ── 11. Customers not yet contacted (no leads or tenders) ────────────────
    all_customer_names = {
        str(getattr(customer, "customer_name", None) or "").strip()
        for customer in customers
        if getattr(customer, "customer_name", None)
    }
    contacted_customers = {
        str(getattr(lead, "customer_name", None) or "").strip()
        for lead in leads
        if getattr(lead, "customer_name", None)
    } | {
        str(getattr(tender, "customer_name", None) or "").strip()
        for tender in tenders
        if getattr(tender, "customer_name", None)
    }
    customers_not_contacted = sorted(
        [
            {
                "customer_name": customer_name,
                "total_leads": 0,
                "total_tenders": 0,
                "status": "Never Contacted",
            }
            for customer_name in (all_customer_names - contacted_customers)
        ],
        key=lambda row: row["customer_name"],
    )[:15]

    # ── 12. Delivery timeliness insights from work orders ────────────────────
    delivery_health_summary = {
        "scheduled_orders": 0,
        "on_time_completed": 0,
        "delivered_late": 0,
        "currently_delayed": 0,
        "pending_delivery": 0,
        "delivered_without_actual_date": 0,
    }
    delivery_timeliness = []
    completed_statuses = {"Completed", "Closed"}
    ignored_statuses = {"Draft", "Cancelled"}
    delivery_priority = {
        "Currently Delayed": 0,
        "Delivered Late": 1,
        "Pending": 2,
        "On Time": 3,
        "Delivered": 4,
    }
    for work_order in work_orders:
        planned_date = getattr(work_order, "delivery_date", None)
        status = str(getattr(work_order, "status", "") or "")
        actual_date = getattr(work_order, "completion_date", None)
        if not planned_date or status in ignored_statuses:
            continue

        product_names = _unique_strings(wo_products_map.get(int(getattr(work_order, "id", 0) or 0), []))
        delivery_health_summary["scheduled_orders"] += 1

        if status == "Delayed" or (status not in completed_statuses and planned_date < today):
            health = "Currently Delayed"
            days_delta = (today - planned_date).days
            note = f"{days_delta} day{'s' if days_delta != 1 else ''} overdue"
            delivery_health_summary["currently_delayed"] += 1
        elif status in completed_statuses:
            if actual_date:
                if actual_date <= planned_date:
                    health = "On Time"
                    days_early = (planned_date - actual_date).days
                    note = "Delivered on planned date" if days_early == 0 else f"{days_early} day{'s' if days_early != 1 else ''} early"
                    days_delta = days_early
                    delivery_health_summary["on_time_completed"] += 1
                else:
                    health = "Delivered Late"
                    days_late = (actual_date - planned_date).days
                    note = f"{days_late} day{'s' if days_late != 1 else ''} late"
                    days_delta = days_late
                    delivery_health_summary["delivered_late"] += 1
            else:
                health = "Delivered"
                days_delta = None
                note = "Completed, but actual delivery date not recorded"
                delivery_health_summary["delivered_without_actual_date"] += 1
        else:
            health = "Pending"
            days_to_due = (planned_date - today).days
            days_delta = days_to_due
            note = "Due today" if days_to_due == 0 else f"Due in {days_to_due} day{'s' if days_to_due != 1 else ''}"
            delivery_health_summary["pending_delivery"] += 1

        delivery_timeliness.append({
            "wo_number": getattr(work_order, "wo_number", None),
            "customer_name": str(getattr(work_order, "customer_name", None) or "Unknown"),
            "project_title": str(getattr(work_order, "project_title", None) or "—"),
            "products": ", ".join(product_names[:5]) if product_names else "—",
            "product_count": len(product_names),
            "planned_delivery_date": planned_date.isoformat() if planned_date else None,
            "actual_completion_date": actual_date.isoformat() if actual_date else None,
            "work_order_status": status or "—",
            "delivery_health": health,
            "days_delta": days_delta,
            "delivery_note": note,
        })

    delivery_timeliness = sorted(
        delivery_timeliness,
        key=lambda row: (
            delivery_priority.get(str(row.get("delivery_health")), 99),
            str(row.get("planned_delivery_date") or ""),
        ),
    )[:20]

    # ── 13. Lead Source ROI ──────────────────────────────────────────────────
    lead_source_stats: dict = defaultdict(lambda: {"total": 0, "converted": 0, "value": 0.0})
    for lead in leads:
        source = _lead_source_label(lead, lead_source_map)
        lead_source_stats[source]["total"] += 1
        if getattr(lead, "status", None) == "Converted":
            lead_source_stats[source]["converted"] += 1
            customer_key = _customer_key(getattr(lead, "customer_name", None), getattr(lead, "customer_id", None))
            associated_tender = latest_won_tender_by_customer.get(customer_key)
            if associated_tender:
                lead_source_stats[source]["value"] += _amount(getattr(associated_tender, "bid_amount", None))

    lead_source_roi = sorted(
        [
            {
                "source": source,
                "total_leads": stats["total"],
                "converted": stats["converted"],
                "conversion_rate": round(stats["converted"] / stats["total"] * 100, 1) if stats["total"] else 0,
                "revenue_generated": round(stats["value"], 2),
                "avg_revenue_per_convert": round(stats["value"] / stats["converted"], 2) if stats["converted"] else 0,
            }
            for source, stats in lead_source_stats.items()
        ],
        key=lambda row: row["revenue_generated"],
        reverse=True,
    )[:10]

    # ── 14. High-value pending leads ─────────────────────────────────────────
    high_value_threshold = 500000
    high_value_pending_leads = sorted(
        [
            {
                "lead_id": getattr(lead, "id", None),
                "lead_title": str(getattr(lead, "lead_title", None) or "—"),
                "customer_name": str(getattr(lead, "customer_name", None) or "Unknown"),
                "lead_value": round(_amount(getattr(lead, "est_value", None)), 2),
                "status": str(getattr(lead, "status", None) or "—"),
                "assigned_to": resolve_name(getattr(lead, "assigned_to", None)) or "Unassigned",
                "created_date": _to_date(getattr(lead, "created_at", None)).isoformat() if _to_date(getattr(lead, "created_at", None)) else "—",
                "days_pending": _days_since(getattr(lead, "created_at", None), today),
            }
            for lead in leads
            if getattr(lead, "status", None) in {"Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing"}
            and _amount(getattr(lead, "est_value", None)) >= high_value_threshold
        ],
        key=lambda row: row["lead_value"],
        reverse=True,
    )[:15]

    # ── 15. Top customers by revenue (all-time) ──────────────────────────────
    customer_revenue: dict[str, float] = defaultdict(float)
    customer_won_counts: Counter[str] = Counter()
    for tender in tenders:
        if getattr(tender, "result", None) != "Won":
            continue
        customer_name = str(getattr(tender, "customer_name", None) or "Unknown")
        customer_revenue[customer_name] += _amount(getattr(tender, "bid_amount", None))
        customer_won_counts[customer_name] += 1

    top_customers_by_revenue = sorted(
        [
            {
                "customer": customer,
                "total_revenue": round(total_value, 2),
                "tender_count": int(customer_won_counts[customer]),
                "avg_deal_value": round(total_value / customer_won_counts[customer], 2) if customer_won_counts[customer] else 0,
            }
            for customer, total_value in customer_revenue.items()
        ],
        key=lambda row: row["total_revenue"],
        reverse=True,
    )[:15]

    return {
        "executive_summary": executive_summary,
        "approval_intelligence": approval_intelligence,
        "lead_conversion_intelligence": lead_conversion_intelligence,
        "tender_win_probability": tender_win_probability,
        "pipeline_health": pipeline_health,
        "top_customers_by_value": top_customers,
        "top_customers_by_revenue": top_customers_by_revenue,
        "top_oems_supply_chain": top_oems,
        "customer_product_matrix": customer_product_matrix,
        "portal_win_analysis": portal_analysis,
        "top_staff_by_wins": top_staff,
        "customers_with_unconverted_leads": customers_with_unconverted_leads,
        "customers_no_leads_4_months": customers_no_leads_4_months,
        "products_not_used": products_not_used,
        "customers_not_contacted": customers_not_contacted,
        "delivery_health_summary": delivery_health_summary,
        "delivery_timeliness": delivery_timeliness,
        "lead_source_roi": lead_source_roi,
        "high_value_pending_leads": high_value_pending_leads,
    }


# ─── Saved Report Views ────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────────────
# Travel Requests Report
# ──────────────────────────────────────────────────────────────────────────────

def _build_travel_scope(db: Session, cu):
    q = db.query(TravelRequest)
    scope_ids = _report_scope_user_ids(db, cu)
    if scope_ids is None:
        return q, None
    return q, scope_ids


def _apply_travel_filters(q, params: dict):
    if params.get("date_from"):
        q = q.filter(TravelRequest.travel_date >= params["date_from"])
    if params.get("date_to"):
        q = q.filter(TravelRequest.travel_date <= params["date_to"])
    if params.get("status"):
        vals = [v.strip() for v in params["status"].split(",") if v.strip()]
        q = q.filter(TravelRequest.status.in_(vals))
    if params.get("visit_type"):
        vals = [v.strip() for v in params["visit_type"].split(",") if v.strip()]
        q = q.filter(TravelRequest.visit_type.in_(vals))
    if params.get("transport_mode"):
        vals = [v.strip() for v in params["transport_mode"].split(",") if v.strip()]
        q = q.filter(TravelRequest.mode_of_travel.in_(vals))
    if params.get("assigned_to"):
        vals = [int(v) for v in params["assigned_to"].split(",") if v.strip().isdigit()]
        q = q.filter(TravelRequest.employee_id.in_(vals))
    if params.get("customer_id"):
        vals = [int(v) for v in params["customer_id"].split(",") if v.strip().isdigit()]
        q = q.filter(TravelRequest.customer_id.in_(vals))
    if params.get("from_city"):
        q = q.filter(TravelRequest.from_city.ilike(f"%{params['from_city']}%"))
    if params.get("to_city"):
        q = q.filter(TravelRequest.to_city.ilike(f"%{params['to_city']}%"))
    advance = _bool_value(params.get("advance_required"))
    if advance is not None:
        q = q.filter(TravelRequest.advance_required == advance)
    if params.get("source"):
        q = q.filter(TravelRequest.source == params["source"])
    return q


@router.get("/travel/filter-options")
def travel_filter_options(
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    users = db.query(User).filter(User.is_active == True).order_by(User.full_name).all()
    customers = (
        db.query(Customer.id, Customer.customer_name)
        .filter(Customer.customer_name != None)
        .order_by(Customer.customer_name)
        .all()
    )
    statuses = [r[0] for r in db.query(TravelRequest.status).filter(
        TravelRequest.status != None).distinct().order_by(TravelRequest.status).all()]
    visit_types = [r[0] for r in db.query(TravelRequest.visit_type).filter(
        TravelRequest.visit_type != None).distinct().order_by(TravelRequest.visit_type).all()]
    transport_modes = [r[0] for r in db.query(TravelRequest.mode_of_travel).filter(
        TravelRequest.mode_of_travel != None).distinct().order_by(TravelRequest.mode_of_travel).all()]
    return {
        "users":           [{"id": u.id, "name": u.full_name} for u in users],
        "customers":       [{"id": c.id, "name": c.customer_name} for c in customers],
        "statuses":        statuses or ["Draft","Submitted","Approved","Rejected","Completed","Cancelled"],
        "visit_types":     visit_types or ["Customer Visit","Vendor Visit","Site Survey","Training","Conference","Other"],
        "transport_modes": transport_modes or ["Air","Train","Bus","Car (Company)","Car (Personal)","Two Wheeler","Other"],
    }


@router.get("/travel")
def report_travel(
    preset:             Optional[str]  = None,
    date_from:          Optional[str]  = None,
    date_to:            Optional[str]  = None,
    status:             Optional[str]  = None,
    visit_type:         Optional[str]  = None,
    transport_mode:     Optional[str]  = None,
    assigned_to:        Optional[str]  = None,
    customer_id:        Optional[str]  = None,
    from_city:          Optional[str]  = None,
    to_city:            Optional[str]  = None,
    advance_required:   Optional[str]  = None,
    source:             Optional[str]  = None,
    page:               int            = 1,
    per_page:           int            = 50,
    export:             Optional[str]  = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    df_str, dt_str, prev_from, prev_to = _resolve_date_preset(preset, date_from, date_to)
    if assigned_to == "__ME__":
        assigned_to = str(cu.id)
    filter_params = {
        "date_from": df_str, "date_to": dt_str,
        "status": status, "visit_type": visit_type, "transport_mode": transport_mode,
        "assigned_to": assigned_to, "customer_id": customer_id,
        "from_city": from_city, "to_city": to_city,
        "advance_required": advance_required, "source": source,
    }
    filter_params = {k: v for k, v in filter_params.items() if v}

    base_q, scope_ids = _build_travel_scope(db, cu)
    if scope_ids is not None:
        base_q = base_q.filter(TravelRequest.employee_id.in_(scope_ids))
    base_q = _apply_travel_filters(base_q, filter_params)

    total_count = base_q.count()

    # comparison period
    prev_q = db.query(TravelRequest)
    if scope_ids is not None:
        prev_q = prev_q.filter(TravelRequest.employee_id.in_(scope_ids))
    if prev_from:
        prev_q = prev_q.filter(TravelRequest.travel_date >= prev_from,
                                TravelRequest.travel_date <= prev_to)
    prev_total = prev_q.count()
    prev_approved = prev_q.filter(TravelRequest.status == "Approved").count()
    prev_est = float(db.query(func.sum(TravelRequest.estimated_total)).filter(
        TravelRequest.id.in_([r.id for r in prev_q.all()])
    ).scalar() or 0)

    # paginate
    offset = (page - 1) * per_page
    rows = base_q.order_by(TravelRequest.travel_date.desc()).offset(offset).limit(per_page).all()

    # batch-load user names + customer names
    uid_set: set[int] = set()
    cid_set: set[int] = set()
    for r in rows:
        if r.employee_id:   uid_set.add(r.employee_id)
        if r.approved_by:   uid_set.add(r.approved_by)
        if r.customer_id:   cid_set.add(r.customer_id)
    user_cache = {u.id: u.full_name for u in
        db.query(User.id, User.full_name).filter(User.id.in_(uid_set)).all()} if uid_set else {}
    cust_cache = {c.id: c.customer_name for c in
        db.query(Customer.id, Customer.customer_name).filter(Customer.id.in_(cid_set)).all()} if cid_set else {}

    data = []
    for r in rows:
        data.append({
            "id":              r.id,
            "request_number":  r.request_number,
            "employee":        user_cache.get(r.employee_id, ""),
            "purpose":         r.purpose or "",
            "visit_type":      r.visit_type or "",
            "customer_name":   cust_cache.get(r.customer_id, ""),
            "from_city":       r.from_city or "",
            "to_city":         r.to_city or "",
            "travel_date":     str(r.travel_date) if r.travel_date else "",
            "return_date":     str(r.return_date) if r.return_date else "",
            "total_days":      r.total_days or 0,
            "transport_mode":  r.mode_of_travel or "",
            "class_of_travel": r.class_of_travel or "",
            "status":          r.status or "Draft",
            "estimated_total": float(r.estimated_total or 0),
            "advance_required": "Yes" if r.advance_required else "No",
            "advance_amount":  float(r.advance_amount or 0),
            "approved_by":     user_cache.get(r.approved_by, ""),
            "approved_at":     str(r.approved_at)[:10] if r.approved_at else "",
            "source":          r.source or "direct",
            "is_outside_district": "Yes" if r.is_outside_district else "No",
            "accommodation_required": "Yes" if r.accommodation_required else "No",
            "notes":           r.notes or "",
            "created_at":      str(r.created_at)[:10] if r.created_at else "",
        })

    if export:
        return _export(data, "travel_report", export)

    # summary metrics
    all_rows = base_q.all()
    total_est = float(db.query(func.sum(TravelRequest.estimated_total)).filter(
        TravelRequest.id.in_([r.id for r in all_rows])
    ).scalar() or 0)
    approved   = sum(1 for r in all_rows if r.status == "Approved")
    pending    = sum(1 for r in all_rows if r.status in ("Submitted", "Draft"))
    completed  = sum(1 for r in all_rows if r.status == "Completed")
    total_days = sum(r.total_days or 0 for r in all_rows)

    def _trend(curr, prev):
        if prev == 0:
            return None
        return round((curr - prev) / prev * 100, 1)

    # charts
    status_counts: dict[str, int] = defaultdict(int)
    visit_counts: dict[str, int] = defaultdict(int)
    mode_counts: dict[str, int] = defaultdict(int)
    monthly_counts: dict[str, int] = defaultdict(int)
    for r in all_rows:
        if r.status:    status_counts[r.status] += 1
        if r.visit_type: visit_counts[r.visit_type] += 1
        if r.mode_of_travel: mode_counts[r.mode_of_travel] += 1
        if r.travel_date:
            month_key = str(r.travel_date)[:7]
            monthly_counts[month_key] += 1

    chart_status  = [{"label": k, "count": v} for k, v in sorted(status_counts.items(), key=lambda x: -x[1])]
    chart_visit   = [{"label": k, "count": v} for k, v in sorted(visit_counts.items(), key=lambda x: -x[1])]
    chart_mode    = [{"label": k, "count": v} for k, v in sorted(mode_counts.items(), key=lambda x: -x[1])]
    chart_monthly = [{"label": k, "count": v} for k, v in sorted(monthly_counts.items())]

    return {
        "summary": {
            "total":          total_count,
            "approved":       approved,
            "pending":        pending,
            "completed":      completed,
            "total_days":     total_days,
            "total_estimated": total_est,
            "avg_estimated":  round(total_est / total_count, 2) if total_count else 0,
            "approval_rate":  round(approved / total_count * 100, 1) if total_count else 0,
            "trend_total":    _trend(total_count, prev_total),
            "trend_approved": _trend(approved, prev_approved),
            "trend_est":      _trend(total_est, prev_est),
        },
        "data":       data,
        "pagination": {
            "total":       total_count,
            "page":        page,
            "per_page":    per_page,
            "total_pages": max(1, (total_count + per_page - 1) // per_page),
        },
        "chart_data":    chart_status,
        "chart_data2":   chart_visit,
        "chart_mode":    chart_mode,
        "chart_monthly": chart_monthly,
    }


# ─── OEM report ───────────────────────────────────────────────────────────────

@router.get("/oem")
def report_oem(
    preset:      Optional[str] = None,
    date_from:   Optional[str] = None,
    date_to:     Optional[str] = None,
    oem_name:    Optional[str] = None,
    module:      Optional[str] = "all",
    assigned_to: Optional[int] = None,
    view:        Optional[str] = "all",
    export:      Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """OEM performance report — aggregates appearances across leads, tenders, quotations, and work orders."""

    date_from, date_to, _, _ = _resolve_date_preset(preset, date_from, date_to)

    oem_data: dict[str, dict] = {}
    oem_lead_ids: dict[str, set] = defaultdict(set)
    oem_tender_ids: dict[str, set] = defaultdict(set)

    def _ensure(name: str) -> dict:
        if name not in oem_data:
            oem_data[name] = {
                "oem_name": name,
                "lead_count": 0,
                "opportunity_count": 0,
                "tender_count": 0,
                "tender_won_count": 0,
                "tender_lost_count": 0,
                "tender_value": 0.0,
                "quotation_count": 0,
                "quotation_accepted_count": 0,
                "quotation_rejected_count": 0,
                "quotation_pending_count": 0,
                "wo_count": 0,
                "wo_value": 0.0,
                "preferred_count": 0,
                "products": [],
                "customers": [],
                "lead_value": 0.0,
                "last_seen": None,
            }
        return oem_data[name]

    # ── leads ──────────────────────────────────────────────────────────────────
    if module in ("all", "leads"):
        lq = (
            db.query(LeadProductOEM, LeadProduct, Lead)
            .join(LeadProduct, LeadProductOEM.lead_product_id == LeadProduct.id)
            .join(Lead, LeadProduct.lead_id == Lead.id)
            .filter(Lead.is_deleted == False)
        )
        if date_from:
            lq = lq.filter(Lead.created_at >= date_from)
        if date_to:
            lq = lq.filter(Lead.created_at <= date_to)
        if assigned_to:
            lq = lq.filter(Lead.assigned_to == assigned_to)

        for lpo, lp, lead in lq.all():
            name = (lpo.oem_name or "").strip() or "Unknown"
            if oem_name and oem_name.lower() not in name.lower():
                continue
            rec = _ensure(name)
            oem_lead_ids[name].add(lead.id)
            rec["lead_count"] += 1
            if lead.status in ("Opportunity Created", "Converted"):
                rec["opportunity_count"] += 1
            if lpo.is_preferred:
                rec["preferred_count"] += 1
            if lp.product_name and lp.product_name not in rec["products"]:
                rec["products"].append(lp.product_name)
            cust = (lead.customer_name or "").strip()
            if cust and cust not in rec["customers"]:
                rec["customers"].append(cust)
            rec["lead_value"] += float((lp.unit_price or 0) * (lp.quantity or 1))
            seen = str(lead.created_at)[:10] if lead.created_at else None
            if seen and (rec["last_seen"] is None or seen > rec["last_seen"]):
                rec["last_seen"] = seen

    # ── tenders ────────────────────────────────────────────────────────────────
    if module in ("all", "tenders"):
        tq = (
            db.query(TenderProductOEM, TenderProduct, Tender)
            .join(TenderProduct, TenderProductOEM.tender_product_id == TenderProduct.id)
            .join(Tender, TenderProduct.tender_id == Tender.id)
        )
        if date_from:
            tq = tq.filter(Tender.created_at >= date_from)
        if date_to:
            tq = tq.filter(Tender.created_at <= date_to)
        if assigned_to:
            tq = tq.filter(Tender.assigned_to == assigned_to)

        for tpo, tp, tender in tq.all():
            name = (tpo.oem_name or "").strip() or "Unknown"
            if oem_name and oem_name.lower() not in name.lower():
                continue
            rec = _ensure(name)
            oem_tender_ids[name].add(tender.id)
            rec["tender_count"] += 1
            if getattr(tender, "result", None) == "Won":
                rec["tender_won_count"] += 1
            elif getattr(tender, "result", None) == "Lost":
                rec["tender_lost_count"] += 1
            rec["tender_value"] += float(getattr(tender, "bid_amount", None) or 0)
            if tpo.is_preferred:
                rec["preferred_count"] += 1
            if tp.product_name and tp.product_name not in rec["products"]:
                rec["products"].append(tp.product_name)
            cust = (tender.customer_name or "").strip()
            if cust and cust not in rec["customers"]:
                rec["customers"].append(cust)
            seen = str(tender.created_at)[:10] if tender.created_at else None
            if seen and (rec["last_seen"] is None or seen > rec["last_seen"]):
                rec["last_seen"] = seen

    # ── quotations and work orders via lead/tender cross-reference ─────────────
    all_lead_ids = set().union(*oem_lead_ids.values()) if oem_lead_ids else set()
    all_tender_ids = set().union(*oem_tender_ids.values()) if oem_tender_ids else set()

    if all_lead_ids or all_tender_ids:
        lead_to_oems: dict[int, set] = defaultdict(set)
        tender_to_oems: dict[int, set] = defaultdict(set)
        for n, ids in oem_lead_ids.items():
            for lid in ids:
                lead_to_oems[lid].add(n)
        for n, ids in oem_tender_ids.items():
            for tid in ids:
                tender_to_oems[tid].add(n)

        qf = []
        if all_lead_ids:
            qf.append(Quotation.lead_id.in_(all_lead_ids))
        if all_tender_ids:
            qf.append(Quotation.tender_id.in_(all_tender_ids))
        for q in db.query(Quotation).filter(or_(*qf)).all():
            names: set = set()
            if q.lead_id:
                names.update(lead_to_oems.get(q.lead_id, set()))
            if q.tender_id:
                names.update(tender_to_oems.get(q.tender_id, set()))
            for n in names:
                if n in oem_data:
                    r = oem_data[n]
                    r["quotation_count"] += 1
                    if q.status == "Accepted":
                        r["quotation_accepted_count"] += 1
                    elif q.status == "Rejected":
                        r["quotation_rejected_count"] += 1
                    elif q.status in ("Draft", "Sent"):
                        r["quotation_pending_count"] += 1

        wof = []
        if all_lead_ids:
            wof.append(WorkOrder.lead_id.in_(all_lead_ids))
        if all_tender_ids:
            wof.append(WorkOrder.tender_id.in_(all_tender_ids))
        for wo in db.query(WorkOrder).filter(or_(*wof)).all():
            names = set()
            if wo.lead_id:
                names.update(lead_to_oems.get(wo.lead_id, set()))
            if wo.tender_id:
                names.update(tender_to_oems.get(wo.tender_id, set()))
            for n in names:
                if n in oem_data:
                    r = oem_data[n]
                    r["wo_count"] += 1
                    r["wo_value"] += float(wo.wo_value or 0)

    # ── include master OEMs for "without" / "inactive" views ──────────────────
    v = (view or "all").lower()
    if v in ("without_leads", "without_tenders", "without_quotations", "without_work_orders",
             "inactive", "without_opportunities", "without_activity", "without_travel"):
        for oem_row in db.query(OEM).all():
            n = (oem_row.name or "").strip()
            if not n:
                continue
            if oem_name and oem_name.lower() not in n.lower():
                continue
            _ensure(n)

    # ── build flat list ────────────────────────────────────────────────────────
    data = []
    for rec in oem_data.values():
        data.append({
            "oem_name": rec["oem_name"],
            "lead_count": rec["lead_count"],
            "opportunity_count": rec["opportunity_count"],
            "tender_count": rec["tender_count"],
            "tender_won_count": rec["tender_won_count"],
            "tender_lost_count": rec["tender_lost_count"],
            "quotation_count": rec["quotation_count"],
            "quotation_accepted_count": rec["quotation_accepted_count"],
            "quotation_rejected_count": rec["quotation_rejected_count"],
            "quotation_pending_count": rec["quotation_pending_count"],
            "wo_count": rec["wo_count"],
            "wo_value": round(rec["wo_value"], 2),
            "total_count": rec["lead_count"] + rec["tender_count"],
            "preferred_count": rec["preferred_count"],
            "associated_products": ", ".join(rec["products"][:5]),
            "customers": ", ".join(rec["customers"][:5]),
            "lead_value": round(rec["lead_value"], 2),
            "tender_value": round(rec["tender_value"], 2),
            "pipeline_value": round(rec["lead_value"] + rec["tender_value"], 2),
            "last_seen": rec["last_seen"] or "",
        })

    # ── view-specific filter ───────────────────────────────────────────────────
    if v == "active":
        data = [d for d in data if d["total_count"] > 0]
    elif v == "inactive":
        data = [d for d in data if d["total_count"] == 0]
    elif v == "with_leads":
        data = [d for d in data if d["lead_count"] > 0]
    elif v == "without_leads":
        data = [d for d in data if d["lead_count"] == 0]
    elif v == "with_opportunities":
        data = [d for d in data if d["opportunity_count"] > 0]
    elif v == "without_opportunities":
        data = [d for d in data if d["opportunity_count"] == 0]
    elif v == "with_tenders":
        data = [d for d in data if d["tender_count"] > 0]
    elif v == "without_tenders":
        data = [d for d in data if d["tender_count"] == 0]
    elif v == "with_quotations":
        data = [d for d in data if d["quotation_count"] > 0]
    elif v == "without_quotations":
        data = [d for d in data if d["quotation_count"] == 0]
    elif v == "with_work_orders":
        data = [d for d in data if d["wo_count"] > 0]
    elif v == "without_work_orders":
        data = [d for d in data if d["wo_count"] == 0]
    elif v == "revenue_generating":
        data = [d for d in data if d["wo_value"] > 0]
    elif v == "low_conversion":
        data = [d for d in data if (d["lead_count"] + d["quotation_count"]) > 0 and d["wo_count"] == 0]
    elif v == "high_conversion":
        data = [d for d in data if d["wo_count"] > 0 and d["lead_count"] > 0]
    elif v == "quotation_accepted":
        data = [d for d in data if d["quotation_accepted_count"] > 0]
    elif v == "quotation_rejected":
        data = [d for d in data if d["quotation_rejected_count"] > 0]
    elif v == "tender_won":
        data = [d for d in data if d["tender_won_count"] > 0]
    elif v == "tender_lost":
        data = [d for d in data if d["tender_lost_count"] > 0]
    elif v == "pending_quotations":
        data = [d for d in data if d["quotation_pending_count"] > 0]
    elif v == "pending_work_orders":
        data = [d for d in data if (d["tender_won_count"] > 0 or d["quotation_accepted_count"] > 0) and d["wo_count"] == 0]
    elif v in ("with_activity", "fast_moving"):
        data = [d for d in data if d["total_count"] > 0]
    elif v in ("without_activity", "without_travel"):
        data = [d for d in data if d["total_count"] == 0]
    elif v == "with_travel":
        data = [d for d in data if d["total_count"] > 0]
    elif v == "slow_moving":
        data = [d for d in data if 0 < d["total_count"] <= 2]
    elif v == "product_wise":
        data = [d for d in data if d["associated_products"]]
    elif v == "customer_wise":
        data = [d for d in data if d["customers"]]

    # ── sort ───────────────────────────────────────────────────────────────────
    if v in ("top", "high_pipeline", "dependency", "revenue_generating"):
        data.sort(key=lambda x: -(x["pipeline_value"] + x["wo_value"]))
    elif v in ("fast_moving",):
        data.sort(key=lambda x: -x["total_count"])
    elif v == "slow_moving":
        data.sort(key=lambda x: x["total_count"])
    elif v == "high_conversion":
        data.sort(key=lambda x: -(x["wo_count"] / max(x["lead_count"], 1)))
    elif v == "kam_wise":
        data.sort(key=lambda x: x["oem_name"])
    else:
        data.sort(key=lambda x: -x["total_count"])

    if export:
        return _export(data, "oem_report", export)

    # ── summary ────────────────────────────────────────────────────────────────
    total_oems = len(data)
    lead_appearances = sum(d["lead_count"] for d in data)
    tender_appearances = sum(d["tender_count"] for d in data)
    preferred_oems = sum(1 for d in data if d["preferred_count"] > 0)
    total_wo_value = round(sum(d["wo_value"] for d in data), 2)
    total_pipeline = round(sum(d["pipeline_value"] for d in data), 2)

    chart_data = [
        {"name": d["oem_name"], "value": d["total_count"]}
        for d in data[:10]
    ]
    chart_data2 = [
        {"name": d["oem_name"], "value": d["tender_count"]}
        for d in sorted(data, key=lambda x: -x["tender_count"])[:10]
    ]

    return {
        "summary": {
            "total_oems": total_oems,
            "lead_appearances": lead_appearances,
            "tender_appearances": tender_appearances,
            "preferred_oems": preferred_oems,
            "total_wo_value": total_wo_value,
            "total_pipeline": total_pipeline,
        },
        "chart_data": chart_data,
        "chart_data2": chart_data2,
        "data": data,
    }


# ─── Competitors report ────────────────────────────────────────────────────────

@router.get("/competitors")
def report_competitors(
    preset:       Optional[str] = None,
    date_from:    Optional[str] = None,
    date_to:      Optional[str] = None,
    search:       Optional[str] = None,
    country:      Optional[str] = None,
    threat_level: Optional[str] = None,
    export:       Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User    = Depends(get_current_user),
):
    """Competitor landscape report — master list enriched with tender loss data."""

    # ── fetch competitors ──────────────────────────────────────────────────────
    date_from, date_to, _, _ = _resolve_date_preset(preset, date_from, date_to)

    cq = db.query(Competitor)
    if search:
        cq = cq.filter(Competitor.name.ilike(f"%{search}%"))
    if country:
        cq = cq.filter(Competitor.country.ilike(f"%{country}%"))
    if threat_level:
        cq = cq.filter(Competitor.threat_level == threat_level)
    competitors = cq.order_by(Competitor.name).all()

    # ── bulk load TenderLossAnalysis rows ─────────────────────────────────────
    # Optionally filter loss analysis by tender date range
    tla_q = db.query(TenderLossAnalysis)
    if date_from or date_to:
        tla_q = tla_q.join(Tender, TenderLossAnalysis.tender_id == Tender.id)
        if date_from:
            tla_q = tla_q.filter(Tender.created_at >= date_from)
        if date_to:
            tla_q = tla_q.filter(Tender.created_at <= date_to)
    all_tla = tla_q.all()

    # ── build competitor data ──────────────────────────────────────────────────
    data = []
    for comp in competitors:
        comp_name_lower = comp.name.lower()

        # Match TenderLossAnalysis rows where competitor_name ILIKE comp.name
        matched = [
            t for t in all_tla
            if (t.competitor_name or "").lower() == comp_name_lower
            or comp_name_lower in (t.competitor_name or "").lower()
        ]
        tender_loss_count = len(matched)
        total_loss_value = sum(
            float(t.competitor_amount or 0) for t in matched
        )
        l1_count = sum(
            1 for t in matched
            if (t.l1_company or "").lower() == comp_name_lower
            or comp_name_lower in (t.l1_company or "").lower()
        )

        data.append({
            "id": comp.id,
            "name": comp.name,
            "country": comp.country or "",
            "state": comp.state or "",
            "city": comp.city or "",
            "threat_level": comp.threat_level or "",
            "strengths": comp.strengths or "",
            "weaknesses": comp.weaknesses or "",
            "oem_partnerships": comp.oem_partnerships or "",
            "strong_regions": comp.strong_regions or "",
            "tender_loss_count": tender_loss_count,
            "total_loss_value": round(total_loss_value, 2),
            "l1_count": l1_count,
        })

    if export:
        return _export(data, "competitors_report", export)

    # ── summary ────────────────────────────────────────────────────────────────
    total_competitors = len(data)
    high_threat = sum(1 for d in data if (d["threat_level"] or "").lower() == "high")
    appeared_in_tenders = sum(1 for d in data if d["tender_loss_count"] > 0)
    total_lost_to = sum(d["l1_count"] for d in data)

    # chart_data — by threat_level
    threat_counts: dict[str, int] = defaultdict(int)
    for d in data:
        tl = d["threat_level"] or "Unknown"
        threat_counts[tl] += 1
    chart_data = [
        {"label": k, "count": v, "value": 0}
        for k, v in sorted(threat_counts.items(), key=lambda x: -x[1])
    ]

    # chart_data2 — by strong_regions (split on comma)
    region_counts: dict[str, int] = defaultdict(int)
    for d in data:
        raw = d["strong_regions"] or ""
        for region in [r.strip() for r in raw.split(",") if r.strip()]:
            region_counts[region] += 1
    chart_data2 = [
        {"label": k, "count": v, "value": 0}
        for k, v in sorted(region_counts.items(), key=lambda x: -x[1])
    ]

    return {
        "summary": {
            "total_competitors": total_competitors,
            "high_threat": high_threat,
            "appeared_in_tenders": appeared_in_tenders,
            "total_lost_to": total_lost_to,
        },
        "chart_data": chart_data,
        "chart_data2": chart_data2,
        "data": data,
    }


class SavedViewIn(BaseModel):
    report_type: str
    name: str
    filters: dict = {}
    columns: list = []
    is_shared: bool = False


@router.get("/saved-views")
def list_saved_views(
    report_type: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    q = db.query(SavedReportView)
    if report_type:
        q = q.filter(SavedReportView.report_type == report_type)
    # Show own views + shared views
    q = q.filter(
        (SavedReportView.created_by == cu.id) | (SavedReportView.is_shared == True)
    )
    rows = q.order_by(SavedReportView.created_at.desc()).all()
    return [
        {
            "id": r.id,
            "report_type": r.report_type,
            "name": r.name,
            "filters": r.filters or {},
            "columns": r.columns or [],
            "is_shared": r.is_shared,
            "created_by": r.created_by,
            "created_by_name": r.creator.full_name if r.creator else "",
            "created_at": str(r.created_at)[:10] if r.created_at else "",
            "is_mine": r.created_by == cu.id,
        }
        for r in rows
    ]


@router.post("/saved-views")
def create_saved_view(
    body: SavedViewIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    view = SavedReportView(
        report_type=body.report_type,
        name=body.name,
        filters=body.filters,
        columns=body.columns,
        is_shared=body.is_shared,
        created_by=cu.id,
    )
    db.add(view)
    db.commit()
    db.refresh(view)
    return {"id": view.id, "name": view.name, "message": "Saved"}


@router.put("/saved-views/{view_id}")
def update_saved_view(
    view_id: int,
    body: SavedViewIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    view = db.query(SavedReportView).filter(SavedReportView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    if view.created_by != cu.id and cu.role not in ("admin", "ceo"):
        raise HTTPException(status_code=403, detail="Not authorised")
    view.name = body.name
    view.filters = body.filters
    view.columns = body.columns
    view.is_shared = body.is_shared
    db.commit()
    return {"id": view.id, "name": view.name, "message": "Updated"}


@router.delete("/saved-views/{view_id}")
def delete_saved_view(
    view_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    view = db.query(SavedReportView).filter(SavedReportView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    if view.created_by != cu.id and cu.role not in ("admin", "ceo"):
        raise HTTPException(status_code=403, detail="Not authorised")
    db.delete(view)
    db.commit()
    return {"message": "Deleted"}
