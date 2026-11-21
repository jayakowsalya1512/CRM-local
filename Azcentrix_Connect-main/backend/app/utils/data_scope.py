"""
data_scope.py — Reusable data-visibility helpers for all CRM modules.

Public API
----------
get_module_data_scope(db, user, module_key) → "own" | "team" | "all" | "none"
get_team_user_ids(db, user_id)              → list[int]  (OrgTreeNode BFS)
apply_data_scope(db, query, user,
                 module_key, owner_col,
                 assigned_col=None)         → filtered SQLAlchemy query

Module key → Permission.module alias mapping
--------------------------------------------
  leads       : leads, lead
  customers   : customers, customer
  tenders     : tenders, tender
  workorders  : workorders, workorder, work_orders, work_order
  emdbg       : emdbg, emd_bg, emd, bg
  kam         : kam, kam_activities, activities
  travel      : travel, ta_da, tada
  opportunity : opportunity, opportunities
  competitors : competitors, competitor
  questionnaire : questionnaire, questionnaires
  document_management : document_management, documents, document

Rules applied by apply_data_scope
-----------------------------------
  "all"  → return query unchanged
  "none" → return query.filter(false())
  "own"  → filter owner_col == user.id OR assigned_col == user.id
  "team" → filter owner_col IN team_ids OR assigned_col IN team_ids

Default scope when no RolePermission row is found: "own" (safe default).
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy import or_, false

from app.models.all_models import OrgTreeNode, Permission, Role, RolePermission

# ---------------------------------------------------------------------------
# Module key → Permission.module aliases
# ---------------------------------------------------------------------------

_MODULE_ALIASES: dict[str, list[str]] = {
    "leads":       ["leads", "lead"],
    "customers":   ["customers", "customer"],
    "tenders":     ["tenders", "tender"],
    "workorders":  ["workorders", "workorder", "work_orders", "work_order"],
    "emdbg":       ["emdbg", "emd_bg", "emd", "bg"],
    "kam":         ["kam", "kam_activities", "activities"],
    "travel":      ["travel", "ta_da", "tada"],
    "opportunity": ["opportunity", "opportunities"],
    "competitors": ["competitors", "competitor"],
    "questionnaire": ["questionnaire", "questionnaires"],
    "document_management": ["document_management", "documents", "document"],
}


# ---------------------------------------------------------------------------
# get_module_data_scope
# ---------------------------------------------------------------------------

def get_module_data_scope(db: Session, user, module_key: str) -> str:
    """Return the data_scope string for *user* on *module_key*.

    Reads from RolePermission joined to Permission and Role.
    Falls back to "own" when no row is found (safe default).
    Always returns one of: "all", "team", "own", "none".
    """
    role_row = db.query(Role).filter(
        Role.name == user.role,
        Role.is_active == True,
    ).first()

    if not role_row:
        return "own"

    aliases = _MODULE_ALIASES.get(module_key, [module_key])

    row = (
        db.query(RolePermission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .filter(
            RolePermission.role_id == role_row.id,
            Permission.module.in_(aliases),
        )
        .first()
    )

    scope = (getattr(row, "data_scope", None) or "own").lower() if row else "own"

    if scope not in {"all", "team", "own", "none"}:
        return "own"

    return scope


# ---------------------------------------------------------------------------
# get_team_user_ids
# ---------------------------------------------------------------------------

def get_team_user_ids(db: Session, user_id: int) -> list[int]:
    """Return all user IDs visible to *user_id* via the OrgTreeNode BFS walk.

    Includes the user themselves plus every subordinate found through
    parent_user_id and group_lead_id relationships.
    """
    user_ids: set[int] = {int(user_id)}
    pending = deque([int(user_id)])
    rows = (
        db.query(
            OrgTreeNode.user_id,
            OrgTreeNode.parent_user_id,
            OrgTreeNode.group_lead_id,
        )
        .filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
        )
        .all()
    )
    children_by_manager: dict[int, set[int]] = defaultdict(set)
    for row_user_id, parent_user_id, group_lead_id in rows:
        child_id = int(row_user_id)
        if parent_user_id is not None:
            children_by_manager[int(parent_user_id)].add(child_id)
        if group_lead_id is not None:
            children_by_manager[int(group_lead_id)].add(child_id)

    while pending:
        current_id = pending.popleft()
        for child_id in children_by_manager.get(current_id, set()):
            if child_id not in user_ids:
                user_ids.add(child_id)
                pending.append(child_id)

    return sorted(user_ids)


# ---------------------------------------------------------------------------
# apply_data_scope
# ---------------------------------------------------------------------------

def apply_data_scope(
    db: Session,
    query,
    user,
    module_key: str,
    owner_col,
    assigned_col=None,
):
    """Apply RolePermission.data_scope filtering to *query*.

    Parameters
    ----------
    db          : SQLAlchemy Session
    query       : an active SQLAlchemy Query object
    user        : the current authenticated User ORM instance
    module_key  : one of the keys defined in _MODULE_ALIASES above
    owner_col   : the SQLAlchemy column representing the record creator / owner
                  (e.g. Lead.created_by)
    assigned_col: optional second SQLAlchemy column for the assignee
                  (e.g. Lead.assigned_to).  When None, only owner_col is used.

    Returns
    -------
    The filtered query (may be the original query unchanged for scope=="all").
    """
    scope = get_module_data_scope(db, user, module_key)

    if scope == "all":
        return query

    if scope == "none":
        return query.filter(false())

    if scope == "own":
        user_ids = [int(user.id)]
    else:
        # "team"
        user_ids = get_team_user_ids(db, int(user.id))

    if assigned_col is not None:
        return query.filter(
            or_(
                owner_col.in_(user_ids),
                assigned_col.in_(user_ids),
            )
        )

    return query.filter(owner_col.in_(user_ids))
