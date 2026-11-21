from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session, object_session

from app.models.all_models import Group, User, UserReportingHierarchy

logger = logging.getLogger(__name__)


def parse_user_group_ids(value: Any) -> list[int]:
    group_ids: list[int] = []
    seen_group_ids: set[int] = set()

    for part in str(value or "").split(","):
        normalized = part.strip()
        if not normalized:
            continue

        try:
            group_id = int(normalized)
        except (TypeError, ValueError):
            continue

        if group_id <= 0 or group_id in seen_group_ids:
            continue

        seen_group_ids.add(group_id)
        group_ids.append(group_id)

    return group_ids


def get_effective_user_group_ids(
    user: Optional[User],
    db: Optional[Session] = None,
) -> list[int]:
    if not user:
        return []

    effective_group_ids = parse_user_group_ids(getattr(user, "group_id", None))
    seen_group_ids = set(effective_group_ids)

    def append_group_id(raw_group_id: Any) -> None:
        try:
            group_id = int(raw_group_id)
        except (TypeError, ValueError):
            return

        if group_id <= 0 or group_id in seen_group_ids:
            return

        seen_group_ids.add(group_id)
        effective_group_ids.append(group_id)

    resolved_db = db or object_session(user)
    user_id = getattr(user, "id", None)
    if resolved_db is None or not user_id:
        return effective_group_ids

    try:
        managed_group_rows = (
            resolved_db.query(Group.id)
            .filter(
                Group.manager_id == int(user_id),
                Group.is_active == True,
            )
            .order_by(Group.id.asc())
            .all()
        )
        for row in managed_group_rows:
            append_group_id(getattr(row, "id", None))

        hierarchy_rows = (
            resolved_db.query(UserReportingHierarchy.group_id)
            .filter(
                UserReportingHierarchy.reporting_user_id == int(user_id),
                UserReportingHierarchy.is_active == True,
                UserReportingHierarchy.group_id.is_not(None),
            )
            .order_by(
                UserReportingHierarchy.level.asc(),
                UserReportingHierarchy.id.asc(),
            )
            .all()
        )
        for row in hierarchy_rows:
            append_group_id(getattr(row, "group_id", None))
    except Exception:
        logger.exception("Failed to resolve effective working groups for user %s", user_id)

    return effective_group_ids
