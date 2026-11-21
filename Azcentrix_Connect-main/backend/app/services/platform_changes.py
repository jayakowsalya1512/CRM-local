"""Change & maintenance (Data & infrastructure → Change & maintenance).

Change calendar
    Staff schedule a change (description, type, window date). It is stored here and sent to the platform approval
    queue (Platform team → Approval Actions) as an "approve_change" request; its approval status follows that request.
    Approvers need Change & Maintenance manage access and can never approve their own change (queue rule).
Change freeze
    Freeze periods are configured in Control Center (Release & change management → "Change freeze windows" on and
    "Change freeze periods"), and are shown in the calendar as Freeze rows. A change whose window falls in a freeze
    needs two approvals from two different staff, neither of them the requester: approving the first request records
    the approval and opens a second request that the requester and the first approver can't decide.
Execution
    Nothing runs when a change is scheduled or approved. Backend services that change the platform call
    authorize_execution() first: when "Change approval board" is on, or a freeze is in effect, they need an approved,
    unused change of their type scheduled for today, which is then marked executed. The release pipeline does this.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import inspect, text

from app.database import master_engine
from app.models.platform_change import PlatformChange
from app.models.tenant import PlatformApprovalRequest, SuperAdmin
from app.services import platform_controls as controls

logger = logging.getLogger(__name__)

TYPES = ("Release", "Maintenance", "Migration", "Security")  # schedulable types; Freeze rows come from Control Center
RISK_BY_TYPE = {"Release": "Low", "Maintenance": "Medium", "Security": "Medium", "Migration": "High"}
RISK_UP = {"Low": "Medium", "Medium": "High", "High": "High"}  # one level higher inside a freeze
ACTIVE = ("pending", "approved")
APPROVAL_ACTION = "approve_change"
MODULE = "changes"
MAX_DAYS_AHEAD = 365
_PERIOD = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*(?:to|\.\.|–|—|-)\s*(\d{4}-\d{2}-\d{2})$", re.I)


class ChangeError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if not _schema_ready:
        PlatformChange.__table__.create(bind=master_engine, checkfirst=True)
        # Precise window times for maintenance scheduled from Announcements & maintenance (older tables lack them).
        columns = {c["name"] for c in inspect(master_engine).get_columns("platform_changes")}
        missing = [sql for name, sql in (("starts_at", "ADD COLUMN starts_at DATETIME NULL"), ("ends_at", "ADD COLUMN ends_at DATETIME NULL"))
                   if name not in columns]
        if missing:
            with master_engine.begin() as conn:
                conn.execute(text("ALTER TABLE platform_changes " + ", ".join(missing)))
        _schema_ready = True


def code(change: PlatformChange) -> str:
    return f"CHG-{change.id:03d}"


def _fmt(day: date) -> str:
    return day.strftime("%d %b %Y")


def _admin_name(admin) -> Optional[str]:
    return (admin.full_name or admin.username) if admin else None


def _audit(db, admin, action: str, change: PlatformChange, description: str, ip: str = "system") -> None:
    from app.routers.platform_router import _write_platform_audit

    _write_platform_audit(db, admin, action, "change", change.id, code(change), description, ip,
                          new_data={"type": change.type, "window": change.window_start.isoformat(), "status": change.status,
                                    "in_freeze": change.in_freeze, "approvals": len(change.approvals or [])})


# ─── Freeze periods ──────────────────────────────────────────────────────────

def parse_periods(text: str) -> list[tuple[date, date]]:
    """'2026-12-10 to 2027-01-05; 2027-03-28 to 2027-04-02' → [(start, end), …]; raises ValueError when malformed."""
    periods = []
    for part in [p.strip() for p in re.split(r"[;,\n]", text or "") if p.strip()]:
        match = _PERIOD.match(part)
        if not match:
            raise ValueError(f"“{part}” is not a period – use YYYY-MM-DD to YYYY-MM-DD")
        try:
            start, end = (datetime.strptime(match.group(i), "%Y-%m-%d").date() for i in (1, 2))
        except ValueError:
            raise ValueError(f"“{part}” contains an invalid date")
        if end < start:
            raise ValueError(f"“{part}” ends before it starts")
        periods.append((start, end))
    return sorted(periods)


def normalize_periods(text: str) -> str:
    """Control Center validation for "Change freeze periods"."""
    return "; ".join(f"{s.isoformat()} to {e.isoformat()}" for s, e in parse_periods(text))


def freeze_periods(db) -> list[tuple[date, date]]:
    if not controls.value(db, "relFreeze"):
        return []
    try:
        return parse_periods(str(controls.value(db, "relFreezeDates") or ""))
    except ValueError:
        logger.warning("Change freeze periods setting is invalid; no freeze applied")
        return []


def freeze_for(day: date, periods: list[tuple[date, date]]) -> Optional[tuple[date, date]]:
    return next(((s, e) for s, e in periods if s <= day <= e), None)


# ─── Approval requests ───────────────────────────────────────────────────────

def _request_approval(db, change: PlatformChange, exclude: list[int], ip: str = "system") -> PlatformApprovalRequest:
    from app.routers.platform_router import _write_platform_audit

    stage = len(change.approvals or []) + 1
    freeze = " · change freeze: approval {} of {}".format(stage, change.approvals_required) if change.in_freeze else ""
    row = PlatformApprovalRequest(
        action=APPROVAL_ACTION, module=MODULE, entity_type="change", entity_id=change.id, entity_name=code(change),
        summary=f"{code(change)} {change.type} on {_fmt(change.window_start)}: {change.description}{freeze}"[:500],
        payload={"change_id": change.id, "stage": stage, "exclude_approvers": exclude}, status="pending", requested_by=change.requested_by,
    )
    db.add(row)
    db.flush()
    change.approval_request_id = row.id
    requester = db.get(SuperAdmin, change.requested_by) if change.requested_by else None
    _write_platform_audit(db, requester, "request_approval", "approval_request", row.id, code(change),
                          f"Requested approval #{row.id}: {row.summary}", ip, new_data={"action": APPROVAL_ACTION, "payload": row.payload})
    return row


def _withdraw(db, change: PlatformChange, admin, reason: str) -> None:
    row = db.get(PlatformApprovalRequest, change.approval_request_id) if change.approval_request_id else None
    if row is not None and row.status == "pending":
        row.status, row.decided_by, row.decided_at, row.result = "cancelled", admin.id if admin else None, datetime.utcnow(), reason[:500]


def on_approved(db, approver, payload: dict) -> dict:
    """Approval Actions executor: record one approval; finish the change or open the next approval request."""
    change = db.query(PlatformChange).filter(PlatformChange.id == int(payload["change_id"])).with_for_update().first()
    if change is None:
        raise ChangeError("The change no longer exists", 404)
    request_row = db.get(PlatformApprovalRequest, change.approval_request_id) if change.approval_request_id else None
    if change.status != "pending" or request_row is None or request_row.status != "approved" or request_row.entity_id != change.id:
        raise ChangeError(f"{code(change)} is not waiting for this approval (it was rescheduled or decided)")
    approvals = [*(change.approvals or []), {"by": approver.id, "name": _admin_name(approver), "at": datetime.utcnow().isoformat() + "Z",
                                             "note": request_row.decision_note}]
    change.approvals = approvals
    change.updated_at = datetime.utcnow()
    if len(approvals) < change.approvals_required:
        _request_approval(db, change, exclude=[a["by"] for a in approvals])
        _audit(db, approver, "change_approval_recorded", change,
               f"{code(change)}: approval {len(approvals)} of {change.approvals_required} by {_admin_name(approver)} (change freeze) – second approver requested")
        return {"message": f"{code(change)}: approval {len(approvals)} of {change.approvals_required} recorded – the change freeze needs a second approver"}
    change.status, change.decided_by, change.decided_at, change.decision_note = "approved", _admin_name(approver), datetime.utcnow(), request_row.decision_note
    _audit(db, approver, "change_approved", change, f"{code(change)} approved by {_admin_name(approver)}")
    return {"message": f"{code(change)} approved"}


def sync(db) -> None:
    """Follow decisions made in the approval queue (reject / withdraw / failure) and the configured freeze periods."""
    ensure_schema()
    changed = False
    pending = db.query(PlatformChange).filter(PlatformChange.status == "pending", PlatformChange.approval_request_id.isnot(None)).all()
    requests = {r.id: r for r in db.query(PlatformApprovalRequest).filter(PlatformApprovalRequest.id.in_([c.approval_request_id for c in pending])).all()} if pending else {}
    for change in pending:
        row = requests.get(change.approval_request_id)
        if row is None or row.status not in ("rejected", "cancelled", "failed"):
            continue
        decider = db.get(SuperAdmin, row.decided_by) if row.decided_by else None
        # The queue stamps decisions with the database's local NOW(); this table keeps UTC.
        decided_at = row.decided_at - timedelta(minutes=round((datetime.now() - datetime.utcnow()).total_seconds() / 60)) if row.decided_at else datetime.utcnow()
        change.status, change.decided_by, change.decided_at, change.decision_note = row.status, _admin_name(decider), decided_at, row.decision_note or row.result
        change.updated_at = datetime.utcnow()
        _audit(db, decider, f"change_{row.status}", change, f"{code(change)} {row.status} in the approval queue" + (f": {row.decision_note}" if row.decision_note else ""))
        changed = True

    periods = freeze_periods(db)
    keys = {f"{s.isoformat()}..{e.isoformat()}": (s, e) for s, e in periods}
    existing = {c.freeze_key: c for c in db.query(PlatformChange).filter(PlatformChange.freeze_key.isnot(None)).all()}
    for key, (start, end) in keys.items():
        row = existing.get(key)
        if row is None:
            row = PlatformChange(type="Freeze", description=f"Change freeze {_fmt(start)} – {_fmt(end)}", scope="All", window_start=start, window_end=end,
                                 risk="—", owner="Change board", status="approved", approvals_required=0, freeze_key=key, decided_at=datetime.utcnow(),
                                 decided_by="Control Center")
            db.add(row)
            db.flush()
            _audit(db, None, "change_freeze_scheduled", row, f"{code(row)}: change freeze {_fmt(start)} – {_fmt(end)} configured in Control Center")
            changed = True
        elif row.status != "approved":
            row.status = "approved"
            changed = True
    for key, row in existing.items():
        if key not in keys and row.status == "approved":
            row.status, row.decided_at, row.decided_by = "cancelled", datetime.utcnow(), "Control Center"
            _audit(db, None, "change_freeze_removed", row, f"{code(row)}: change freeze removed in Control Center")
            changed = True

    # A changed freeze can move scheduled changes in or out of it; an approved one now inside needs its second approval.
    for change in db.query(PlatformChange).filter(PlatformChange.status.in_(ACTIVE), PlatformChange.type != "Freeze", PlatformChange.executed_at.is_(None)).all():
        inside = freeze_for(change.window_start, periods) is not None
        if inside == change.in_freeze:
            continue
        change.in_freeze, change.approvals_required = inside, 2 if inside else 1
        change.risk = RISK_UP[RISK_BY_TYPE[change.type]] if inside else RISK_BY_TYPE[change.type]
        if inside and change.status == "approved" and len(change.approvals or []) < 2:
            change.status = "pending"
            _request_approval(db, change, exclude=[a["by"] for a in change.approvals or []])
        _audit(db, None, "change_freeze_status", change, f"{code(change)} is {'now inside' if inside else 'no longer inside'} a change freeze")
        changed = True
    if changed:
        db.commit()


# ─── Scheduling ──────────────────────────────────────────────────────────────

def _validate_window(db, window: date, exclude_id: Optional[int] = None) -> None:
    today = date.today()
    if window < today:
        raise ChangeError("The window can't be in the past", 422)
    if window > today + timedelta(days=MAX_DAYS_AHEAD):
        raise ChangeError(f"The window must be within the next {MAX_DAYS_AHEAD} days", 422)
    clash = db.query(PlatformChange).filter(PlatformChange.window_start == window, PlatformChange.type != "Freeze",
                                            PlatformChange.status.in_(ACTIVE), PlatformChange.executed_at.is_(None))
    if exclude_id is not None:
        clash = clash.filter(PlatformChange.id != exclude_id)
    other = clash.first()
    if other:
        raise ChangeError(f"{code(other)} ({other.type}) is already scheduled on {_fmt(window)} – choose another window")


def _classify(change: PlatformChange, periods) -> None:
    inside = freeze_for(change.window_start, periods) is not None
    change.in_freeze, change.approvals_required = inside, 2 if inside else 1
    change.risk = RISK_UP[RISK_BY_TYPE[change.type]] if inside else RISK_BY_TYPE[change.type]


def create(db, admin, description: str, type_: str, window: date, ip: str, *, scope: str = "Prod",
           starts_at: Optional[datetime] = None, ends_at: Optional[datetime] = None) -> PlatformChange:
    ensure_schema()
    description = " ".join((description or "").split())
    if len(description) < 5:
        raise ChangeError("Describe the change (at least 5 characters)", 422)
    if len(description) > 500:
        raise ChangeError("The description can be at most 500 characters", 422)
    if type_ not in TYPES:
        raise ChangeError(f"Type must be one of {', '.join(TYPES)}", 422)
    if admin is None:
        raise ChangeError("A signed-in platform staff member must submit the change", 403)
    _validate_window(db, window)
    change = PlatformChange(type=type_, description=description, scope=scope[:120], window_start=window, window_end=window,
                            starts_at=starts_at, ends_at=ends_at, owner=_admin_name(admin),
                            requested_by=admin.id, status="pending", approvals=[])
    _classify(change, freeze_periods(db))
    db.add(change)
    db.flush()
    _request_approval(db, change, exclude=[], ip=ip)
    _audit(db, admin, "change_created", change, f"{code(change)} scheduled for {_fmt(window)} and submitted for approval"
           + (" (inside a change freeze: two approvals needed)" if change.in_freeze else ""), ip)
    db.commit()
    return change


def reschedule(db, admin, change: PlatformChange, window: date, ip: str) -> PlatformChange:
    if change.type == "Freeze":
        raise ChangeError("Freeze periods are changed in Control Center → Release & change management", 422)
    if change.status not in ACTIVE or change.executed_at:
        raise ChangeError(f"{code(change)} is {change.status if not change.executed_at else 'executed'} and can't be rescheduled", 409)
    if window == change.window_start:
        return change
    _validate_window(db, window, exclude_id=change.id)
    old = change.window_start
    _withdraw(db, change, admin, f"Superseded: {code(change)} rescheduled")
    change.window_start = change.window_end = window
    change.status, change.approvals, change.decided_by, change.decided_at, change.decision_note = "pending", [], None, None, None
    change.updated_at = datetime.utcnow()
    _classify(change, freeze_periods(db))
    _request_approval(db, change, exclude=[], ip=ip)
    _audit(db, admin, "change_rescheduled", change, f"{code(change)} moved from {_fmt(old)} to {_fmt(window)} – approval requested again", ip)
    db.commit()
    return change


def authorize_execution(db, type_: str, ref: str, actor=None) -> Optional[PlatformChange]:
    """For backend services about to run a change: the approved change for today that covers it (marked executed).

    Returns None when no approval is required (Change approval board off and no freeze in effect).
    Raises ChangeError when the change may not run. The caller commits.
    """
    ensure_schema()
    sync(db)
    today = date.today()
    freeze = freeze_for(today, freeze_periods(db))
    if not controls.value(db, "relApprove") and freeze is None:
        return None
    change = db.query(PlatformChange).filter(PlatformChange.type == type_, PlatformChange.status == "approved", PlatformChange.executed_at.is_(None),
                                             PlatformChange.window_start == today).order_by(PlatformChange.id).first()
    if change is None:
        why = f" – a change freeze is in effect until {_fmt(freeze[1])}, so it needs two approvals" if freeze else ""
        raise ChangeError(f"{type_} changes need an approved {type_} change scheduled for today in Change & maintenance{why}", 409)
    change.executed_at, change.execution_ref, change.updated_at = datetime.utcnow(), ref[:200], datetime.utcnow()
    _audit(db, actor, "change_executed", change, f"{code(change)} executed: {ref}")
    return change


# ─── Read model ──────────────────────────────────────────────────────────────

APPROVAL_LABEL = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected", "cancelled": "Cancelled", "failed": "Failed"}


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if isinstance(value, date) and not isinstance(value, datetime) else value.isoformat() + "Z"


def payload(change: PlatformChange, names: dict, request_row: Optional[PlatformApprovalRequest], can_decide: bool) -> dict:
    return {
        "id": change.id, "code": code(change), "description": change.description, "type": change.type, "scope": change.scope,
        "window_start": _iso(change.window_start), "window_end": _iso(change.window_end), "risk": change.risk, "owner": change.owner,
        "status": change.status, "approval": APPROVAL_LABEL.get(change.status, change.status), "in_freeze": change.in_freeze,
        "approvals_required": change.approvals_required, "approvals": change.approvals or [],
        "requested_by": names.get(change.requested_by) if change.requested_by else None, "created_at": _iso(change.created_at),
        "decided_by": change.decided_by, "decided_at": _iso(change.decided_at), "decision_note": change.decision_note,
        "executed_at": _iso(change.executed_at), "execution_ref": change.execution_ref,
        "approval_request_id": request_row.id if request_row is not None and request_row.status == "pending" else None, "can_decide": can_decide,
    }
