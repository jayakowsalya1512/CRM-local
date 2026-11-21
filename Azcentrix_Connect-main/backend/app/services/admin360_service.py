"""Users & Teams / Roles & Security (prototype v17) – queries.

Everything here is one round-trip per screen: the users grid is a single paginated SELECT with a LEFT JOIN for the
manager and an EXISTS for MFA; teams/territories/login history/matrix each load with 1–3 bounded queries and no
per-row lookups.  All filtering goes through SQLAlchemy expressions (bound parameters) and whitelisted columns.
"""
from __future__ import annotations

import logging
import threading
from collections import Counter
from typing import Any, Optional

from fastapi import HTTPException

from app.core import validators as V
from sqlalchemy import and_, case, exists, func, or_
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session, aliased

from app.core.timezone import now_ist
from app.models.admin360 import ADMIN360_TABLES, FieldSecurity, SharingRule, Territory
from app.models.all_models import Customer, FormField, LoginLog, OrgTreeNode, Permission, Role, RolePermission, TrustedDevice, User

logger = logging.getLogger(__name__)

_READY: set[str] = set()
_LOCK = threading.Lock()

# prototype ACT columns → permission actions in this product
ACT = [("View", "view"), ("Create", "create"), ("Edit", "update"), ("Delete", "delete"), ("Approve", "approve"), ("Export", "export")]
SCOPES = [("Own", "own"), ("Own + team", "team"), ("Entire company", "all")]   # prototype labels → role_permissions.data_scope
SHARING_OBJECTS = ["Accounts", "Leads", "Deals", "Bids", "Quotes", "Orders", "Guarantees", "Documents"]
ACCESS_LEVELS = ["Edit", "Read", "Hidden"]
USER_VIEWS = ["All", "Invited", "No MFA"]

# Field-level security: base fields of each module (prototype formDef) – custom / overridden fields come from form_fields.
FLS_MODULES: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "customers": ("Customers", [("name", "Account name"), ("type", "Type"), ("industry", "Industry"), ("city", "City"), ("state", "State"), ("tier", "Tier"),
                                ("kam", "Key account manager"), ("gstin", "GSTIN"), ("credit_limit", "Credit limit"), ("phone", "Phone"), ("email", "E-mail")]),
    "opportunities": ("Deals", [("name", "Deal name"), ("customer", "Customer"), ("type", "Type"), ("value", "Value"), ("close", "Expected close"), ("owner", "Owner"),
                                ("stage", "Stage"), ("probability", "Probability"), ("competitor", "Competitor"), ("notes", "Notes")]),
    "tenders": ("Bids & Tenders", [("title", "Tender title"), ("ref", "Tender reference"), ("customer", "Customer"), ("portal", "Portal"), ("value", "Tender value"),
                                   ("emd", "EMD amount"), ("submit", "Submission deadline"), ("owner", "Bid manager"), ("cost", "Estimated cost"), ("margin", "Target margin")]),
    "quotations": ("Quotes", [("ref", "Quotation number"), ("customer", "Customer"), ("validity", "Validity"), ("amount", "Amount"), ("discount", "Discount"),
                              ("cost", "Cost price"), ("terms", "Terms & conditions"), ("owner", "Owner")]),
    "emd": ("Guarantees & Deposits", [("ref", "Instrument number"), ("type", "Type"), ("bank", "Bank"), ("amount", "Amount"), ("validity", "Valid until"),
                                      ("tender", "Linked tender"), ("status", "Status")]),
}

OPS = {"contains", "ncontains", "eq", "ne", "starts", "gt", "lt", "gte", "lte", "empty", "nempty"}


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in ADMIN360_TABLES:
            t.create(bind=bind, checkfirst=True)
        db.commit()
        _READY.add(slug)


def ensure_schema_all_tenants() -> None:
    from app.database import MasterSessionLocal, get_tenant_session
    from app.models.tenant import Tenant
    master = MasterSessionLocal()
    try:
        slugs = [t.slug for t in master.query(Tenant.slug).all()]
    except Exception as exc:  # pragma: no cover
        logger.warning("Admin360 schema sync: unable to list tenants: %s", exc)
        return
    finally:
        master.close()
    for slug in slugs:
        try:
            db = get_tenant_session(slug)
            try:
                db.info["tenant_slug"] = slug
                ensure_schema(db)
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Admin360 schema sync failed for %s: %s", slug, exc)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _cond(col, op: str, v: str):
    """One advanced-filter condition on a whitelisted column (bound parameters only)."""
    if op not in OPS:
        return None
    if op == "empty":
        return or_(col.is_(None), col == "")
    if op == "nempty":
        return col.isnot(None) & (col != "")
    if op in ("gt", "lt", "gte", "lte"):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return None
        return {"gt": col > n, "lt": col < n, "gte": col >= n, "lte": col <= n}[op]
    s = str(v or "")
    if op == "contains":
        return col.ilike(_like(s))
    if op == "ncontains":
        return ~col.ilike(_like(s))
    if op == "starts":
        return col.ilike(s.replace("%", "\\%") + "%")
    if op == "eq":
        return func.lower(col) == s.lower()
    return func.lower(col) != s.lower()


def _dt(v) -> Optional[str]:
    return v.isoformat() if v else None


def role_labels(db: Session) -> dict[str, str]:
    return {r.name: r.display_name or r.name for r in db.query(Role.name, Role.display_name).all()}


# ─── users grid ───────────────────────────────────────────────────────────────

USER_SORT = {"name": User.full_name, "email": User.email, "role": User.role, "dept": User.department, "last": User.last_login, "status": User.is_active}


def users_meta(db: Session, cu: User, company: str) -> dict:
    roles = [{"name": r.name, "label": r.display_name or r.name} for r in db.query(Role).filter(Role.is_active.is_(True)).order_by(Role.level).all()]
    return {"company": company, "views": USER_VIEWS, "roles": roles, "me": {"id": cu.id, "name": cu.full_name}}


def users_query(db: Session, cu: User, *, view: str, role: str, q: str, f: dict[str, str], adv: dict, sorts: list, offset: int, limit: int) -> dict:
    Mgr = aliased(User)
    mfa = exists().where(and_(TrustedDevice.user_id == User.id, TrustedDevice.is_active.is_(True)))
    base = db.query(User).outerjoin(Mgr, Mgr.id == User.reporting_manager_id)
    if cu.role == "manager":  # same visibility rule as the existing /auth/users
        base = base.filter(or_(User.reporting_manager_id == cu.id, User.id == cu.id))
    if role:
        base = base.filter(User.role == role)
    if q:
        base = base.filter(or_(User.full_name.ilike(_like(q)), User.email.ilike(_like(q)), User.username.ilike(_like(q)), User.department.ilike(_like(q))))
    quick = {"name": User.full_name, "email": User.email, "role": User.role, "dept": User.department, "mgr": Mgr.full_name}
    for k, v in (f or {}).items():
        if k in quick and v:
            base = base.filter(quick[k].ilike(_like(str(v))))
    conds = []
    for c in (adv or {}).get("conds", []) or []:
        col = quick.get(str(c.get("k")))
        if col is None and c.get("k") == "mgr":
            col = Mgr.full_name
        if col is None:
            continue
        expr = _cond(col, str(c.get("op")), str(c.get("v", "")))
        if expr is not None:
            conds.append(expr)
    if conds:
        base = base.filter(or_(*conds) if (adv or {}).get("logic") == "OR" else and_(*conds))

    # view counts in one query (prototype chips show counts for every view)
    cnt = base.with_entities(
        func.count(User.id),
        func.sum(case((User.last_login.is_(None) & User.is_active.is_(True), 1), else_=0)),
        func.sum(case((~mfa, 1), else_=0)),
    ).first()
    counts = {"All": int(cnt[0] or 0), "Invited": int(cnt[1] or 0), "No MFA": int(cnt[2] or 0)}

    rows_q = base
    if view == "Invited":
        rows_q = rows_q.filter(User.last_login.is_(None), User.is_active.is_(True))
    elif view == "No MFA":
        rows_q = rows_q.filter(~mfa)
    total = rows_q.with_entities(func.count(User.id)).scalar() or 0

    order = []
    for s in sorts or []:
        if isinstance(s, (list, tuple)) and len(s) == 2 and s[0] in USER_SORT:
            col = USER_SORT[s[0]]
            order.append(col.desc() if int(s[1]) < 0 else col.asc())
    if not order:
        order = [User.full_name.asc()]
    rows = (rows_q.with_entities(User.id, User.full_name, User.email, User.role, User.department, User.designation, User.last_login, User.is_active,
                                 User.username, User.created_at, Mgr.full_name.label("mgr"), mfa.label("mfa"))
            .order_by(*order).offset(max(0, offset)).limit(max(1, min(limit, 250))).all())
    labels = role_labels(db)
    items = []
    for r in rows:
        status = "Active" if (r.is_active and r.last_login) else ("Invited" if r.is_active else "Inactive")
        items.append({"id": r.id, "name": r.full_name, "email": r.email, "username": r.username, "role": r.role, "role_label": labels.get(r.role, r.role),
                      "dept": r.department or "", "designation": r.designation or "", "mgr": r.mgr or "", "mfa": bool(r.mfa),
                      "last": _dt(r.last_login), "status": status, "is_active": bool(r.is_active), "created": _dt(r.created_at)})
    return {"items": items, "total": int(total), "total_all": counts["All"], "counts": counts}


def user_detail(db: Session, cu: User, user_id: int) -> dict:
    """Prototype openRec('users'): the row plus Activity (module log + last sign-ins) and Notes – four bounded queries."""
    from app.models.all_models import ActivityLog
    Mgr = aliased(User)
    mfa = exists().where(and_(TrustedDevice.user_id == User.id, TrustedDevice.is_active.is_(True)))
    q = db.query(User.id, User.full_name, User.email, User.role, User.department, User.designation, User.last_login, User.is_active, User.username, User.created_at,
                 User.phone, User.branch, User.employee_code, Mgr.full_name.label("mgr"), mfa.label("mfa")).outerjoin(Mgr, Mgr.id == User.reporting_manager_id).filter(User.id == user_id)
    if cu.role == "manager":
        q = q.filter(or_(User.reporting_manager_id == cu.id, User.id == cu.id))
    r = q.first()
    if r is None:
        raise HTTPException(404, "User not found")
    labels = role_labels(db)
    status = "Active" if (r.is_active and r.last_login) else ("Invited" if r.is_active else "Inactive")
    By = aliased(User)
    logs = db.query(ActivityLog, By.full_name).outerjoin(By, By.id == ActivityLog.user_id)         .filter(ActivityLog.module == "users", ActivityLog.record_id == user_id).order_by(ActivityLog.created_at.desc()).limit(60).all()
    notes = [{"id": a.id, "t": a.description, "by": n or "System", "d": _dt(a.created_at)} for a, n in logs if a.action == "note"]
    activity = [{"t": a.description, "by": n or "System", "d": _dt(a.created_at)} for a, n in logs if a.action != "note"]
    logins = db.query(LoginLog).filter(LoginLog.user_id == user_id).order_by(LoginLog.created_at.desc()).limit(10).all()
    return {"id": r.id, "name": r.full_name, "email": r.email, "username": r.username, "role": r.role, "role_label": labels.get(r.role, r.role), "dept": r.department or "",
            "designation": r.designation or "", "mgr": r.mgr or "", "mfa": bool(r.mfa), "last": _dt(r.last_login), "status": status, "is_active": bool(r.is_active),
            "created": _dt(r.created_at), "phone": r.phone or "", "branch": r.branch or "", "employee_code": r.employee_code or "", "activity": activity, "notes": notes,
            "logins": [{"t": _dt(l.created_at), "ip": l.ip_address or "", "d": _device(l.user_agent), "r": "Success" if l.success else "Failed"} for l in logins]}


def add_user_note(db: Session, cu: User, user_id: int, text_: str) -> dict:
    from app.models.all_models import ActivityLog
    text_ = (text_ or "").strip()[:2000]
    if not text_:
        raise HTTPException(422, "Write the note first")
    if not db.query(User.id).filter(User.id == user_id).first():
        raise HTTPException(404, "User not found")
    row = ActivityLog(user_id=cu.id, module="users", record_id=user_id, action="note", description=text_, icon="📝")
    db.add(row)
    db.commit()
    return {"id": row.id, "t": text_, "by": cu.full_name, "d": _dt(row.created_at or now_ist())}


# ─── teams & territories ──────────────────────────────────────────────────────

def _ensure_group_description_column(db: Session) -> None:
    """org_tree_nodes.description – the one field Group Fixing's L2 nodes never needed until Teams &
    Territories was pointed at them (same table, so a team and a Masters group are now the same record)."""
    key = "org_tree_nodes.description"
    if key in _READY:
        return
    try:
        db.execute(sa_text("ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL"))
        db.commit()
    except Exception:
        db.rollback()
    _READY.add(key)


def _subtree_node_ids(db: Session, node_id: int) -> list[int]:
    ids = [node_id]
    for child in db.query(OrgTreeNode.id).filter(OrgTreeNode.parent_id == node_id, OrgTreeNode.is_active.is_(True)).all():
        ids.extend(_subtree_node_ids(db, child.id))
    return ids


def teams(db: Session) -> list[dict]:
    """Teams & Territories reads the SAME L2 group nodes as Masters → Group Fixing (org_tree_nodes) –
    there is only one "groups" concept in the product, also used by the approval matrix's group policies."""
    _ensure_group_description_column(db)
    groups = db.query(OrgTreeNode).filter(OrgTreeNode.level == 2, OrgTreeNode.is_active.is_(True),
                                           OrgTreeNode.group_name.isnot(None), OrgTreeNode.group_name != "").order_by(OrgTreeNode.group_name).all()
    lead_ids = {g.group_lead_id for g in groups if g.group_lead_id}
    names = {u.id: u.full_name for u in db.query(User.id, User.full_name).filter(User.id.in_(lead_ids)).all()} if lead_ids else {}
    out = []
    for g in groups:
        member_ids = set(_subtree_node_ids(db, g.id))
        member_user_ids = {n.user_id for n in db.query(OrgTreeNode.user_id).filter(OrgTreeNode.id.in_(member_ids), OrgTreeNode.is_active.is_(True)).all()}
        out.append({"id": g.id, "n": g.group_name, "l": names.get(g.group_lead_id, "") if g.group_lead_id else "", "lead_id": g.group_lead_id,
                    "m": len(member_user_ids), "d": getattr(g, "description", None) or ""})
    return out


def create_team(db: Session, cu: User, name: str, manager_id: Optional[int], description: str) -> dict:
    """Creates a new top-level (L2) group in the SAME org tree Masters → Group Fixing manages, with the
    team lead placed as that group's head – mirrors add_org_tree_node's L2 branch in masters_router.py."""
    _ensure_group_description_column(db)
    name = (name or "").strip()
    if not name:
        raise HTTPException(422, "Name the team")
    if not manager_id:
        raise HTTPException(422, "Pick a team lead")
    lead = db.query(User.id).filter(User.id == manager_id, User.is_active.is_(True)).first()
    if not lead:
        raise HTTPException(404, "Team lead not found")
    if db.query(OrgTreeNode.id).filter(OrgTreeNode.level == 2, OrgTreeNode.group_name == name, OrgTreeNode.is_active.is_(True)).first():
        raise HTTPException(409, "A team with this name already exists")
    if db.query(OrgTreeNode.id).filter(OrgTreeNode.user_id == manager_id, OrgTreeNode.is_active.is_(True)).first():
        raise HTTPException(400, f"That user is already placed in the organisation tree – pick another lead or remove them from the tree first")
    max_pos = db.query(func.max(OrgTreeNode.position)).filter(OrgTreeNode.parent_id.is_(None), OrgTreeNode.is_active.is_(True)).scalar() or 0
    node = OrgTreeNode(parent_id=None, parent_user_id=None, user_id=manager_id, group_name=name, group_lead_id=manager_id,
                        level=2, position=max_pos + 1, description=(description or "").strip() or None)
    db.add(node)
    db.commit()
    db.refresh(node)
    return {"id": node.id, "n": node.group_name}


def territories(db: Session) -> list[dict]:
    rows = db.query(Territory, User.full_name).outerjoin(User, User.id == Territory.owner_id).filter(Territory.is_active.is_(True)).order_by(Territory.name).all()
    # accounts per state – one GROUP BY, then summed per territory in Python
    by_state: dict[str, int] = {}
    for state, n in db.query(func.lower(func.trim(Customer.billing_state)), func.count(Customer.id)).group_by(func.lower(func.trim(Customer.billing_state))).all():
        if state:
            by_state[state] = int(n)
    out = []
    for t, owner in rows:
        states = [s.strip() for s in (t.states or "").split(",") if s.strip()]
        out.append({"id": t.id, "t": t.name, "states": states, "s": ", ".join(states) if states else (t.rule or ""), "rule": t.rule or "",
                    "o": owner or "", "owner_id": t.owner_id, "a": sum(by_state.get(s.lower(), 0) for s in states)})
    return out


def save_territory(db: Session, cu: User, data: dict, territory_id: Optional[int] = None) -> dict:
    name = str(data.get("name") or "").strip()
    if not name:
        raise V.field_error("name", "Territory name is required.")
    states = [str(s).strip()[:80] for s in (data.get("states") or []) if str(s).strip()][:60]
    owner_id = data.get("owner_id")
    if owner_id and not db.query(User.id).filter(User.id == owner_id).first():
        raise V.field_error("owner_id", "Selected owner was not found.", 404)
    dup = db.query(Territory.id).filter(func.lower(Territory.name) == name.lower(), Territory.id != (territory_id or 0)).first()
    if dup:
        raise V.field_error("name", f'A territory named "{name}" already exists. Please use a different name.', 409)
    if territory_id:
        t = db.query(Territory).filter(Territory.id == territory_id).first()
        if not t:
            raise HTTPException(404, "Territory not found")
    else:
        t = Territory()
        db.add(t)
    t.name, t.states, t.rule, t.owner_id = name, ", ".join(states), str(data.get("rule") or "").strip()[:200] or None, owner_id or None
    t.is_active = True
    db.commit()
    return {"id": t.id}


def delete_territory(db: Session, territory_id: int) -> None:
    t = db.query(Territory).filter(Territory.id == territory_id).first()
    if not t:
        raise HTTPException(404, "Territory not found")
    t.is_active = False
    db.commit()


# ─── login history ────────────────────────────────────────────────────────────

def login_history(db: Session, *, q: str, result: str, offset: int, limit: int) -> dict:
    base = db.query(LoginLog, User.full_name).outerjoin(User, User.id == LoginLog.user_id)
    if q:
        base = base.filter(or_(LoginLog.username.ilike(_like(q)), User.full_name.ilike(_like(q)), LoginLog.ip_address.ilike(_like(q))))
    if result == "Success":
        base = base.filter(LoginLog.success.is_(True))
    elif result == "Failed":
        base = base.filter(LoginLog.success.is_(False))
    total = base.with_entities(func.count(LoginLog.id)).scalar() or 0
    rows = base.order_by(LoginLog.created_at.desc(), LoginLog.id.desc()).offset(max(0, offset)).limit(max(1, min(limit, 250))).all()
    items = [{"id": l.id, "u": name or l.username, "t": _dt(l.created_at), "ip": l.ip_address or "", "d": _device(l.user_agent),
              "r": "Success" if l.success else "Failed", "reason": l.failure_reason or ""} for l, name in rows]
    return {"items": items, "total": int(total)}


def _device(ua: Optional[str]) -> str:
    ua = ua or ""
    low = ua.lower()
    browser = "Edge" if "edg/" in low else "Chrome" if "chrome" in low else "Firefox" if "firefox" in low else "Safari" if "safari" in low else "App" if low else "Unknown"
    os_ = "Windows" if "windows" in low else "iPhone" if "iphone" in low else "Android" if "android" in low else "Mac" if "mac os" in low else "Linux" if "linux" in low else ""
    return f"{browser} · {os_}" if os_ else browser


# ─── roles matrix ─────────────────────────────────────────────────────────────

def roles_matrix(db: Session) -> dict:
    from app.routers.roles_router import _permissions_grouped
    roles = db.query(Role).order_by(Role.level, Role.display_name).all()
    user_counts = dict(db.query(User.role, func.count(User.id)).filter(User.is_active.is_(True)).group_by(User.role).all())
    grouped = _permissions_grouped(db)
    modules = []
    for g in grouped:
        by_action = {}
        more = []
        for p in g["permissions"]:
            a = (p.get("action") or "").strip().lower()
            if a in dict(ACT).values() and a not in by_action:
                by_action[a] = {"id": p["id"], "key": p["key"], "d": p.get("description") or ""}
            else:
                more.append({"id": p["id"], "key": p["key"], "d": p.get("description") or "", "a": a})
        modules.append({"key": g["module"], "label": g["label"], "section": g.get("section"), "acts": by_action, "more": more})
    grants: dict[int, list[int]] = {}
    scopes: dict[int, Counter] = {}
    for rp in db.query(RolePermission.role_id, RolePermission.permission_id, RolePermission.data_scope).all():
        grants.setdefault(rp.role_id, []).append(rp.permission_id)
        scopes.setdefault(rp.role_id, Counter())[(rp.data_scope or "own")] += 1
    return {
        "acts": [{"l": l, "a": a} for l, a in ACT],
        "scopes": [{"l": l, "v": v} for l, v in SCOPES],
        "roles": [{"id": r.id, "name": r.name, "label": r.display_name or r.name, "users": int(user_counts.get(r.name, 0)), "is_system": bool(r.is_system),
                   "is_active": bool(r.is_active), "level": r.level, "scope": (scopes.get(r.id) or Counter({"own": 1})).most_common(1)[0][0]} for r in roles],
        "modules": modules,
        "grants": {str(k): v for k, v in grants.items()},
    }


# ─── sharing rules ────────────────────────────────────────────────────────────

def sharing_rules(db: Session) -> list[dict]:
    rows = db.query(SharingRule).filter(SharingRule.is_active.is_(True)).order_by(SharingRule.object, SharingRule.id).all()
    labels = role_labels(db)
    out = []
    for r in rows:
        w = {"team": f"Team: {r.shared_with_ref}", "role": f"Role: {labels.get(r.shared_with_ref or '', r.shared_with_ref)}",
             "hierarchy": "Hierarchy", "everyone": "Everyone"}.get(r.shared_with_type, r.shared_with_ref or "")
        out.append({"id": r.id, "o": r.object, "r": r.rule, "w": w, "a": r.access, "type": r.shared_with_type, "ref": r.shared_with_ref or ""})
    return out


def save_sharing_rule(db: Session, cu: User, data: dict, rule_id: Optional[int] = None) -> dict:
    obj = str(data.get("object") or "").strip()
    rule = str(data.get("rule") or "").strip()
    typ = str(data.get("shared_with_type") or "role").strip().lower()
    access = str(data.get("access") or "Read").strip()
    if obj not in SHARING_OBJECTS:
        raise V.field_error("object", "Please select an object.")
    if not rule:
        raise V.field_error("rule", "Rule is required.")
    if typ not in ("team", "role", "hierarchy", "everyone"):
        raise V.field_error("shared_with_type", "Please select who the records are shared with.")
    if access not in ("Read", "Read / Write"):
        raise V.field_error("access", "Access must be Read or Read / Write.")
    ref = str(data.get("shared_with_ref") or "").strip()[:120] or None
    if typ in ("team", "role") and not ref:
        raise V.field_error("shared_with_ref", "Please select the role or team the records are shared with.")
    if rule_id:
        r = db.query(SharingRule).filter(SharingRule.id == rule_id).first()
        if not r:
            raise HTTPException(404, "Rule not found")
    else:
        r = SharingRule(created_by=cu.id)
        db.add(r)
    r.object, r.rule, r.shared_with_type, r.shared_with_ref, r.access, r.is_active = obj, rule[:300], typ, ref, access, True
    db.commit()
    return {"id": r.id}


def delete_sharing_rule(db: Session, rule_id: int) -> None:
    r = db.query(SharingRule).filter(SharingRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    r.is_active = False
    db.commit()


# ─── field-level security ─────────────────────────────────────────────────────

def field_security(db: Session, module: str) -> dict:
    if module not in FLS_MODULES:
        raise HTTPException(404, "Unknown module")
    label, base = FLS_MODULES[module]
    fields = [{"k": k, "l": l, "custom": False} for k, l in base]
    seen = {k for k, _ in base}
    ff_module = "opportunities" if module == "opportunities" else module
    for ff in db.query(FormField.field_key, FormField.label, FormField.is_custom).filter(FormField.module == ff_module, FormField.is_visible.is_(True)).order_by(FormField.sort_order).all():
        if ff.field_key and ff.field_key not in seen:
            fields.append({"k": ff.field_key, "l": ff.label or ff.field_key, "custom": bool(ff.is_custom)})
            seen.add(ff.field_key)
    roles = [{"id": r.id, "label": r.display_name or r.name, "name": r.name} for r in db.query(Role).filter(Role.is_active.is_(True)).order_by(Role.level).all()]
    cells: dict[str, dict[str, str]] = {}
    for fs in db.query(FieldSecurity.field_key, FieldSecurity.role_id, FieldSecurity.access).filter(FieldSecurity.module == module).all():
        cells.setdefault(fs.field_key, {})[str(fs.role_id)] = fs.access
    return {"module": module, "label": label, "modules": [{"k": k, "l": v[0]} for k, v in FLS_MODULES.items()], "fields": fields, "roles": roles,
            "levels": ACCESS_LEVELS, "cells": cells}


def set_field_security(db: Session, cu: User, module: str, field_key: str, role_id: int, access: str) -> None:
    if module not in FLS_MODULES:
        raise HTTPException(404, "Unknown module")
    if access not in ACCESS_LEVELS:
        raise HTTPException(422, "Access must be Edit, Read or Hidden")
    if not db.query(Role.id).filter(Role.id == role_id).first():
        raise HTTPException(404, "Role not found")
    field_key = (field_key or "").strip()[:100]
    if not field_key:
        raise HTTPException(422, "Field is required")
    row = db.query(FieldSecurity).filter(FieldSecurity.module == module, FieldSecurity.field_key == field_key, FieldSecurity.role_id == role_id).first()
    if access == "Edit":  # default – nothing to store
        if row:
            db.delete(row)
    elif row:
        row.access, row.updated_by, row.updated_at = access, cu.id, now_ist()
    else:
        db.add(FieldSecurity(module=module, field_key=field_key, role_id=role_id, access=access, updated_by=cu.id, updated_at=now_ist()))
    db.commit()
