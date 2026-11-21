"""
user_location_router.py — Store mobile user latitude and longitude
=================================================================

POST /user-locations/store
Stores current logged-in user's mobile location.
Mobile app only needs to send latitude and longitude.
User id is taken from JWT/auth user using get_current_user.
"""

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, get_current_user
from app.models.all_models import User
from app.models.user_location import UserLocationLog

logger = logging.getLogger(__name__)
router = APIRouter()


class UserLocationCreate(BaseModel):
    latitude: Decimal = Field(...)
    longitude: Decimal = Field(...)


def _ensure_user_location_runtime_schema(db: Session) -> None:
    """
    Create user_location_logs table if it does not exist.
    Safe to run repeatedly.
    """
    try:
        inspector = inspect(db.get_bind())
        if "user_location_logs" in inspector.get_table_names():
            return

        db.execute(text("""
            CREATE TABLE IF NOT EXISTS `user_location_logs` (
              `id` INT AUTO_INCREMENT PRIMARY KEY,
              `user_id` INT NOT NULL,
              `latitude` DECIMAL(10,8) NOT NULL,
              `longitude` DECIMAL(11,8) NOT NULL,
              `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              INDEX `idx_user_location_logs_user_id` (`user_id`),
              INDEX `idx_user_location_logs_created_at` (`created_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """))
        db.commit()
        logger.info("user_location_logs table created")
    except Exception as exc:
        db.rollback()
        logger.warning("User location runtime schema sync skipped: %s", exc)


def _validate_latitude(value: Decimal) -> Decimal:
    try:
        lat = Decimal(value)
    except (InvalidOperation, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid latitude",
        )

    if lat < Decimal("-90") or lat > Decimal("90"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Latitude must be between -90 and 90",
        )

    return lat


def _validate_longitude(value: Decimal) -> Decimal:
    try:
        lng = Decimal(value)
    except (InvalidOperation, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid longitude",
        )

    if lng < Decimal("-180") or lng > Decimal("180"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Longitude must be between -180 and 180",
        )

    return lng


def _serialize_location(row: UserLocationLog) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "latitude": float(row.latitude),
        "longitude": float(row.longitude),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/store", status_code=201)
def store_user_location(
    payload: UserLocationCreate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """
    Store logged-in user's mobile location.

    Request body:
    {
      "latitude": 13.082680,
      "longitude": 80.270718
    }

    user_id is automatically taken from current logged-in user.
    """

    _ensure_user_location_runtime_schema(db)

    lat = _validate_latitude(payload.latitude)
    lng = _validate_longitude(payload.longitude)

    try:
        location = UserLocationLog(
            user_id=cu.id,
            latitude=lat,
            longitude=lng,
        )

        db.add(location)
        db.commit()
        db.refresh(location)

        return {
            "message": "User location stored successfully",
            "data": _serialize_location(location),
        }

    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("store_user_location error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to store user location",
        )