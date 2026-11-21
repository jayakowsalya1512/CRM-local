"""Reports (prototype v17 · Intelligence → Reports) – /api/v1/report-catalogue

Catalogue (ready-made + custom reports the user may run), favourites, report runs with a reporting period, server-side
exports (PDF / Excel / CSV), e-mail via the Inbox composer, schedules and execution history, and the Builder (data sources,
columns, live preview, save) on top of the existing report engine. Permissions: reports.view to open the module; each
ready-made report additionally needs the permissions of the modules it reads; report_engine.view for the Builder;
reports.export / reports.schedule / reports.share for those actions.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, require_permission
from app.models.all_models import User
from app.services import reports_v17_service as S

router = APIRouter(tags=["Reports"])


def rp_user(db: Session = Depends(get_tenant_db), cu: User = Depends(require_permission("reports.view"))) -> User:
    S.ensure_schema(db)
    return cu


class FavIn(BaseModel):
    on: bool


class ScheduleIn(BaseModel):
    frequency: str
    format: str
    recipients: str = Field(..., max_length=4000)
    period: str = "FY"


class ExportIn(BaseModel):
    period: str = "FY"
    format: str = "PDF"


class PreviewIn(BaseModel):
    source: str
    fields: list[str] = []
    group: Optional[str] = None


class SaveIn(PreviewIn):
    name: str = Field(..., max_length=150)
    description: Optional[str] = Field(None, max_length=500)
    visibility: str = "private"


@router.get("/catalogue")
def catalogue(db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.catalogue(db, cu)


@router.put("/favourites/{key}")
def favourite(key: str, body: FavIn, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.set_favourite(db, cu, key, body.on)


@router.get("/reports/{key}")
def run(key: str, period: str = Query("FY"), db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.run(db, cu, key, period)


@router.get("/reports/{key}/export")
def export(key: str, period: str = Query("FY"), fmt: str = Query("PDF"), db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    data, name, mime = S.export(db, cu, key, period, fmt)
    return Response(content=data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


@router.post("/reports/{key}/email")
def email(key: str, body: ExportIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.email_file(db, cu, key, body.period, body.format, request)


@router.put("/reports/{key}/schedule")
def save_schedule(key: str, body: ScheduleIn, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.save_schedule(db, cu, key, body)


@router.delete("/reports/{key}/schedule")
def remove_schedule(key: str, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.remove_schedule(db, cu, key)


@router.get("/runs")
def runs(key: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return {"items": S.history(db, cu, key)}


@router.get("/builder/sources")
def sources(db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return {"items": S.builder_sources(db, cu)}


@router.get("/builder/fields")
def fields(source: str, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return {"items": S.builder_fields(db, cu, source)}


@router.post("/builder/preview")
def preview(body: PreviewIn, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.builder_preview(db, cu, body.source, body.fields, body.group or None)


@router.post("/builder/save", status_code=201)
def save(body: SaveIn, db: Session = Depends(get_tenant_db), cu: User = Depends(rp_user)):
    return S.builder_save(db, cu, body)
