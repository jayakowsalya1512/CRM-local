"""Forecasts (prototype v17 · Sales → Forecasts)   /api/v1/forecasts

Page:        GET  /summary?period=          – everything the page renders in one call: period chips (fiscal calendar),
                                              KPI strip, Forecast by rep, Composition, permissions, latest submission
Parts:       GET  /periods                  – fiscal period chips + default period
             GET  /kpis?period=             – Quota · Closed won · Commit · Best case · Pipeline · Gap to quota
             GET  /reps?period=             – Forecast by rep rows (quota, closed, commit, best case, pipeline, adj., attainment)
             GET  /composition?period=      – doughnut data + centre % ((Closed + Commit) / Quota)
Adjustments: PUT  /adjustments              – inline manager adjustment (forecasts.adjust, team scope) → recalculated summary
             GET  /adjustments/history      – audit trail of adjustments (old → new, editor, time)
Submit:      POST /submit                   – snapshot + approval request (module "forecast", action "submit") + notifications
             GET  /submissions[?period=]    – submission history (every version is kept)
             GET  /submissions/{id}         – one submitted snapshot with its per-rep lines
Settings:    GET / PUT /config              – Forecast settings (thresholds, period type, adjustments, lock) – settings.manage

Permissions: forecasts.view (page), forecasts.adjust (Manager adj.), forecasts.submit (Submit forecast); deal visibility
follows opportunities.view + the role's opportunity data scope (own / team / all).
"""
from __future__ import annotations

from typing import Any, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import forecast_service as S

router = APIRouter()


def forecast_user(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
    if not user_has_permission(db, cu, "forecasts.view"):
        raise HTTPException(403, "You do not have access to Forecasts")
    S.ensure_schema(db)
    return cu


def _period(db: Session, key: Optional[str], cfg: dict[str, Any]) -> S.Period:
    if not key:
        return S.available_periods(cfg)[0]
    return S.parse_period(key, cfg["fy_start_month"])


def _summary(db: Session, cu: User, key: Optional[str]) -> dict[str, Any]:
    cfg = S.config(db)
    p = _period(db, key, cfg)
    res = S.public(S.compute(db, cu, p, cfg))
    periods = S.available_periods(cfg)
    if p.key not in {x.key for x in periods}:          # a period opened from history stays selectable
        periods.append(p)
    res["periods"] = [S._period_json(x) for x in periods]
    res["submission"] = S.latest_submission(db, cu, p.key)
    return res


@router.get("/summary")
def summary(period: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    return _summary(db, cu, period)


@router.get("/periods")
def periods(db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    items = [S._period_json(p) for p in S.available_periods(cfg)]
    return {"items": items, "default": items[0]["key"], "fy_start_month": cfg["fy_start_month"], "period_type": cfg["period"]}


@router.get("/kpis")
def kpis(period: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    res = S.compute(db, cu, _period(db, period, cfg), cfg)
    return {"period": res["period"], "kpis": res["kpis"], "thresholds": res["thresholds"]}


@router.get("/reps")
def reps(period: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    res = S.compute(db, cu, _period(db, period, cfg), cfg)
    return {"period": res["period"], "items": res["rows"], "can": res["can"], "locked": res["locked"]}


@router.get("/composition")
def composition(period: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    res = S.compute(db, cu, _period(db, period, cfg), cfg)
    return {"period": res["period"], **res["composition"]}


class AdjustIn(BaseModel):
    period: str = Field(..., min_length=6, max_length=20)
    rep_id: int = Field(..., gt=0)
    amount: Union[float, int, str, None] = None


@router.put("/adjustments")
def adjust(body: AdjustIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    p = S.parse_period(body.period, cfg["fy_start_month"])
    res = S.set_adjustment(db, cu, request, p, body.rep_id, body.amount)
    return {**res, "summary": _summary(db, cu, p.key)}


@router.get("/adjustments/history")
def adjust_history(period: str, rep_id: Optional[int] = None, limit: int = Query(50, ge=1, le=500),
                   db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    return {"items": S.adjustment_history(db, cu, S.parse_period(period, cfg["fy_start_month"]), rep_id, limit)}


class SubmitIn(BaseModel):
    period: str = Field(..., min_length=6, max_length=20)


@router.post("/submit")
def submit(body: SubmitIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    cfg = S.config(db)
    p = S.parse_period(body.period, cfg["fy_start_month"])
    return S.submit(db, cu, request, p)


@router.get("/submissions")
def submissions(period: Optional[str] = None, limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    if period:
        period = S.parse_period(period, S.config(db)["fy_start_month"]).key
    return {"items": S.submissions(db, cu, period, limit)}


@router.get("/submissions/{sid}")
def submission(sid: int, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    return S.submission_detail(db, cu, sid)


@router.get("/config")
def get_config(db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    return {**S.config(db), "can_configure": user_has_permission(db, cu, "settings.manage")}


class ConfigIn(BaseModel):
    commit_min: Optional[int] = None
    best_min: Optional[int] = None
    period: Optional[str] = None
    adjustments: Optional[bool] = None
    lock: Optional[bool] = None


@router.put("/config")
def put_config(body: ConfigIn, db: Session = Depends(get_tenant_db), cu: User = Depends(forecast_user)):
    if not user_has_permission(db, cu, "settings.manage"):
        raise HTTPException(403, "You do not have permission to change Forecast settings")
    return S.save_config(db, cu, body.model_dump(exclude_none=True))
