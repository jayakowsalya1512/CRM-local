from collections import defaultdict
from datetime import date, datetime, time
from math import atan2, cos, radians, sin, sqrt
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.timezone import now_ist, today_ist
from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import User, UserLocationLog
from app.routers.kam_router import _get_visible_uids
from app.routers.user_location_router import _ensure_user_location_runtime_schema

router = APIRouter()

LOCATION_RADIUS_METERS = 150.0
TRACKING_GAP_SECONDS = 120
EARTH_RADIUS_METERS = 6371000.0


def _parse_tracking_date(value: Optional[str]) -> date:
    if not value:
        return today_ist()
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid activity_date. Use YYYY-MM-DD.") from exc


def _tracking_window(day_value: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(day_value, time.min),
        datetime.combine(day_value, time.max),
    )


def _to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    lat1_rad = radians(lat1)
    lat2_rad = radians(lat2)
    a = sin(d_lat / 2) ** 2 + cos(lat1_rad) * cos(lat2_rad) * sin(d_lon / 2) ** 2
    return 2 * EARTH_RADIUS_METERS * atan2(sqrt(a), sqrt(max(0.0, 1 - a)))


def _duration_parts(total_seconds: int) -> tuple[int, int, int]:
    safe_seconds = max(0, int(total_seconds or 0))
    hours = safe_seconds // 3600
    minutes = (safe_seconds % 3600) // 60
    seconds = safe_seconds % 60
    return hours, minutes, seconds


def _duration_label(total_seconds: int) -> str:
    hours, minutes, seconds = _duration_parts(total_seconds)
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m"
    return f"{seconds}s"


def _serialize_dt(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _tracking_status(day_value: date, last_seen: Optional[datetime]) -> str:
    if not last_seen:
        return "No Data"
    if day_value != today_ist():
        return "Tracked"

    gap_minutes = max(0.0, (now_ist() - last_seen).total_seconds() / 60.0)
    if gap_minutes <= 5:
        return "Active"
    if gap_minutes <= 30:
        return "Idle"
    return "Offline"


def _group_location_logs(logs: list[UserLocationLog]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None

    def start_group(log: UserLocationLog) -> dict[str, Any]:
        lat = _to_float(log.latitude)
        lng = _to_float(log.longitude)
        return {
            "group_index": len(groups) + 1,
            "arrival_time": log.created_at,
            "departure_time": log.created_at,
            "sum_latitude": lat,
            "sum_longitude": lng,
            "avg_latitude": lat,
            "avg_longitude": lng,
            "gps_record_count": 1,
        }

    def finalize_group(group: dict[str, Any]) -> dict[str, Any]:
        count = max(1, int(group["gps_record_count"]))
        avg_latitude = float(group["sum_latitude"]) / count
        avg_longitude = float(group["sum_longitude"]) / count
        arrival = group["arrival_time"]
        departure = group["departure_time"]
        duration_seconds = max(0, int((departure - arrival).total_seconds())) if arrival and departure else 0
        return {
            "group_index": int(group["group_index"]),
            "avg_latitude": avg_latitude,
            "avg_longitude": avg_longitude,
            "arrival_time": _serialize_dt(arrival),
            "departure_time": _serialize_dt(departure),
            "duration_seconds": duration_seconds,
            "duration_label": _duration_label(duration_seconds),
            "gps_record_count": count,
        }

    for log in logs:
        if not getattr(log, "created_at", None):
            continue

        lat = _to_float(log.latitude)
        lng = _to_float(log.longitude)
        if not current:
            current = start_group(log)
            continue

        gap_seconds = max(0, int((log.created_at - current["departure_time"]).total_seconds()))
        distance = _haversine_meters(
            float(current["avg_latitude"]),
            float(current["avg_longitude"]),
            lat,
            lng,
        )
        if gap_seconds > TRACKING_GAP_SECONDS or distance > LOCATION_RADIUS_METERS:
            groups.append(finalize_group(current))
            current = start_group(log)
            continue

        current["departure_time"] = log.created_at
        current["gps_record_count"] += 1
        current["sum_latitude"] += lat
        current["sum_longitude"] += lng
        current["avg_latitude"] = float(current["sum_latitude"]) / int(current["gps_record_count"])
        current["avg_longitude"] = float(current["sum_longitude"]) / int(current["gps_record_count"])

    if current:
        groups.append(finalize_group(current))

    total_groups = len(groups)
    for index, group in enumerate(groups):
        if total_groups == 1:
            marker_type = "latest"
        elif index == 0:
            marker_type = "start"
        elif index == total_groups - 1:
            marker_type = "latest"
        else:
            marker_type = "stay"
        group["marker_type"] = marker_type
        group["is_start"] = index == 0
        group["is_end"] = index == total_groups - 1
    return groups


def _user_location_summary_row(day_value: date, user_row: User, logs: list[UserLocationLog]) -> dict[str, Any]:
    ordered_logs = sorted(
        [log for log in logs if getattr(log, "created_at", None)],
        key=lambda row: (row.created_at, int(getattr(row, "id", 0) or 0)),
    )
    grouped_locations = _group_location_logs(ordered_logs)
    stopped_time_seconds = sum(int(group["duration_seconds"]) for group in grouped_locations)
    last_seen = ordered_logs[-1].created_at if ordered_logs else None
    return {
        "user_id": int(user_row.id),
        "user_name": getattr(user_row, "full_name", None) or getattr(user_row, "username", None) or f"User {user_row.id}",
        "employee_code": getattr(user_row, "employee_code", None) or "",
        "last_location_time": _serialize_dt(last_seen),
        "tracking_status": _tracking_status(day_value, last_seen),
        "location_count": len(ordered_logs),
        "stopped_time_seconds": stopped_time_seconds,
        "stopped_time_label": _duration_label(stopped_time_seconds),
        "group_count": len(grouped_locations),
        "can_view_map": len(grouped_locations) > 0,
    }


@router.get("/user-location-day-summary")
def get_user_location_day_summary(
    activity_date: Optional[str] = None,
    user_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _ensure_user_location_runtime_schema(db)

    day_value = _parse_tracking_date(activity_date)
    visible_user_ids = _get_visible_uids(cu, db, requested_uid=user_id)
    if not visible_user_ids:
        return {
            "activity_date": day_value.isoformat(),
            "user_options": [],
            "rows": [],
            "summary": {
                "tracked_users": 0,
                "active_users": 0,
                "total_logs": 0,
                "total_stopped_seconds": 0,
                "total_stopped_time": _duration_label(0),
            },
        }

    users = db.query(User).filter(
        User.id.in_(visible_user_ids),
        User.is_active == True,
    ).order_by(User.full_name.asc(), User.username.asc()).all()
    user_by_id = {int(row.id): row for row in users if getattr(row, "id", None)}

    start_at, end_at = _tracking_window(day_value)
    log_rows = (
        db.query(UserLocationLog)
        .filter(
            UserLocationLog.user_id.in_(visible_user_ids),
            UserLocationLog.created_at >= start_at,
            UserLocationLog.created_at <= end_at,
        )
        .order_by(UserLocationLog.user_id.asc(), UserLocationLog.created_at.asc(), UserLocationLog.id.asc())
        .all()
    )
    logs_by_user: dict[int, list[UserLocationLog]] = defaultdict(list)
    for log in log_rows:
        if getattr(log, "user_id", None):
            logs_by_user[int(log.user_id)].append(log)

    rows = [
        _user_location_summary_row(day_value, row, logs_by_user.get(int(row.id), []))
        for row in users
    ]

    summary = {
        "tracked_users": sum(1 for row in rows if row["location_count"] > 0),
        "active_users": sum(1 for row in rows if row["tracking_status"] == "Active"),
        "total_logs": sum(int(row["location_count"]) for row in rows),
        "total_stopped_seconds": sum(int(row["stopped_time_seconds"]) for row in rows),
    }
    summary["total_stopped_time"] = _duration_label(summary["total_stopped_seconds"])

    return {
        "activity_date": day_value.isoformat(),
        "user_options": [
            {
                "user_id": int(row.id),
                "user_name": getattr(row, "full_name", None) or getattr(row, "username", None) or f"User {row.id}",
                "employee_code": getattr(row, "employee_code", None) or "",
            }
            for row in users
        ],
        "rows": rows,
        "summary": summary,
    }


@router.get("/user-location-day-map")
def get_user_location_day_map(
    user_id: int,
    activity_date: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _ensure_user_location_runtime_schema(db)

    day_value = _parse_tracking_date(activity_date)
    visible_user_ids = _get_visible_uids(cu, db, requested_uid=user_id)
    if not visible_user_ids:
        raise HTTPException(status_code=404, detail="No visible user found")

    user_row = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    start_at, end_at = _tracking_window(day_value)
    log_rows = (
        db.query(UserLocationLog)
        .filter(
            UserLocationLog.user_id == int(user_id),
            UserLocationLog.created_at >= start_at,
            UserLocationLog.created_at <= end_at,
        )
        .order_by(UserLocationLog.created_at.asc(), UserLocationLog.id.asc())
        .all()
    )

    groups = _group_location_logs(log_rows)
    summary_row = _user_location_summary_row(day_value, user_row, log_rows)

    return {
        "activity_date": day_value.isoformat(),
        "user": {
            "user_id": int(user_row.id),
            "user_name": getattr(user_row, "full_name", None) or getattr(user_row, "username", None) or f"User {user_row.id}",
            "employee_code": getattr(user_row, "employee_code", None) or "",
        },
        "summary": summary_row,
        "groups": groups,
        "route": [
            {
                "group_index": int(group["group_index"]),
                "latitude": float(group["avg_latitude"]),
                "longitude": float(group["avg_longitude"]),
                "arrival_time": group["arrival_time"],
                "departure_time": group["departure_time"],
                "duration_seconds": int(group["duration_seconds"]),
                "duration_label": group["duration_label"],
                "gps_record_count": int(group["gps_record_count"]),
                "marker_type": group["marker_type"],
                "is_start": bool(group["is_start"]),
                "is_end": bool(group["is_end"]),
            }
            for group in groups
        ],
        "raw_location_count": len(log_rows),
    }
