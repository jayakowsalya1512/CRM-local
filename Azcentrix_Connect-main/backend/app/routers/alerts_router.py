"""Alerts router backed by persisted alerts only."""

from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import Alert, User
from app.services.alert_service import serialize_alert, sync_alerts_for_user
from app.services.cache_service import invalidate_badges_cache

router = APIRouter()


@router.get("")
def get_alerts(
    severity: Optional[str] = None,
    category: Optional[str] = None,
    module: Optional[str] = None,
    include_dismissed: bool = False,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    sync_alerts_for_user(db, cu)

    query = db.query(Alert).filter(Alert.user_id == cu.id)
    if not include_dismissed:
        query = query.filter(Alert.is_dismissed == False)
    if severity:
        query = query.filter(Alert.severity == severity)
    if category:
        query = query.filter(Alert.category == category)
    if module:
        query = query.filter(Alert.module == module)

    alerts = query.order_by(Alert.created_at.desc(), Alert.id.desc()).limit(100).all()
    db.commit()
    return [serialize_alert(alert) for alert in alerts]


@router.put("/{alert_id}/read")
def mark_alert_read(
    alert_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    alert = db.query(Alert).filter(Alert.id == alert_id, Alert.user_id == cu.id).first()
    if alert:
        alert.is_read = True
        db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


@router.put("/{alert_id}/dismiss")
def dismiss_alert(
    alert_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    alert = db.query(Alert).filter(Alert.id == alert_id, Alert.user_id == cu.id).first()
    if alert:
        alert.is_dismissed = True
        db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


@router.put("/mark-all-read")
def mark_all_alerts_read(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    db.query(Alert).filter(Alert.user_id == cu.id, Alert.is_read == False).update({"is_read": True})
    db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}


@router.get("/badge")
def get_alerts_badge(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    sync_alerts_for_user(db, cu)
    count = db.query(Alert).filter(Alert.user_id == cu.id, Alert.is_read == False, Alert.is_dismissed == False).count()
    db.commit()
    return {"count": count}


@router.post("/mark-seen")
def mark_alerts_seen(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    db.query(Alert).filter(Alert.user_id == cu.id, Alert.is_read == False).update({"is_read": True})
    db.commit()
    invalidate_badges_cache(db, cu.id)
    return {"ok": True}
