"""Intelligence → Funnel & analytics (Phase 1 of 5). Mounted at /api/v1/funnel

GET  /meta                          objects / periods / dimensions / owners / flows for the control bar
GET  /board                         KPI strip + funnel steps for the current object/period/filters/drill-down
GET  /drill                         split-by table / stage×dimension matrix for a chosen dimension
GET  /stuck                         records open beyond their stage's SLA
GET  /records                       the 11-column records table (paginated)
GET  /export                        the same, filtered rowset as a CSV download

Reads need funnel.view (or an admin role); the module has no write actions in Phase 1 besides export.
"""
from __future__ import annotations

import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_tenant_db, user_has_permission
from app.models.all_models import User
from app.services import funnel_service as S

router = APIRouter(tags=["Funnel & Analytics"])

ADMIN_ROLES = ("admin", "ceo")
VIEW_ROLES = ("admin", "ceo", "manager", "vp")


def _guard(perm: str, roles: tuple[str, ...], what: str):
    def dep(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)) -> User:
        if (cu.role or "") not in roles and not user_has_permission(db, cu, perm):
            raise HTTPException(403, f"You don't have access to {what}")
        S.ensure_schema(db)
        return cu
    return dep


viewer = _guard("funnel.view", VIEW_ROLES, "Funnel & analytics")


def _drill_parse(drill: Optional[str]) -> list[tuple[str, str]]:
    if not drill:
        return []
    out = []
    for part in drill.split(";"):
        if "=" not in part:
            continue
        dim, val = part.split("=", 1)
        if dim in dict(S.DIMENSIONS):
            out.append((dim, val))
    return out


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"objects": S.OBJECTS, "periods": list(S.PERIODS), "dimensions": [{"key": k, "label": l} for k, l in S.DIMENSIONS],
            "owners": S.owners_list(db)}


@router.get("/flows")
def flows(obj: str = Query(...), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return {"items": S.flows_for_object(db, obj)}


def _board_rows(db: Session, obj: str, period: str, flow: Optional[str], open_only: bool, owner_id: Optional[int], drill: str):
    period_start = S._period_start(period)
    drill_pairs = _drill_parse(drill)
    if obj == "Whole journey":
        rows = S.whole_journey_rows(db, period_start)
    else:
        rows = S._object_rows(db, obj, period_start, flow)
    return S._apply_filters(rows, open_only=open_only, owner_id=owner_id, drill=drill_pairs), drill_pairs


@router.get("/board")
def board(obj: str = Query("Whole journey"), period: str = Query("All"), flow: Optional[str] = None,
          open_only: bool = False, owner_id: Optional[int] = None, drill: Optional[str] = None,
          db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    if obj not in S.OBJECTS:
        raise HTTPException(400, "Unknown object")
    rows, _ = _board_rows(db, obj, period, flow, open_only, owner_id, drill)
    stages = [] if obj == "Whole journey" else S._flow_stages(db, obj, flow)
    steps = S.whole_journey_steps(rows) if obj == "Whole journey" else S.funnel_steps(rows, stages)
    return {"kpi": S.kpi_strip(rows, steps), "steps": steps, "row_count": len(rows)}


@router.get("/drill")
def drill(obj: str = Query("Whole journey"), period: str = Query("All"), flow: Optional[str] = None,
          open_only: bool = False, owner_id: Optional[int] = None, drill: Optional[str] = None,
          dim: str = Query("segment"), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    if dim not in dict(S.DIMENSIONS):
        raise HTTPException(400, "Unknown dimension")
    rows, _ = _board_rows(db, obj, period, flow, open_only, owner_id, drill)
    stages = [{"name": s["l"], "kind": "open", "sla": s.get("sla")} for s in (S.whole_journey_steps(rows) if obj == "Whole journey" else S.funnel_steps(rows, S._flow_stages(db, obj, flow)))[:-1]]
    return {"split": S.group_rows(rows, dim), "matrix": S.stage_matrix(rows, stages, dim)}


@router.get("/stuck")
def stuck(obj: str = Query("Whole journey"), period: str = Query("All"), flow: Optional[str] = None,
          owner_id: Optional[int] = None, drill: Optional[str] = None,
          db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    rows, _ = _board_rows(db, obj, period, flow, False, owner_id, drill)
    items = sorted(S.stuck_rows(rows), key=lambda r: -S._num(r["value"]))[:50]
    return {"items": [{"id": r["id"], "type": r["kind"], "name": r["name"], "stage": r["stage"], "age_days": r["age_days"],
                       "sla_days": r["sla_days"], "owner": r["owner_name"], "owner_id": r["owner_id"], "value": S._num(r["value"])} for r in items]}


@router.get("/records")
def records(obj: str = Query("Whole journey"), period: str = Query("All"), flow: Optional[str] = None,
            open_only: bool = False, owner_id: Optional[int] = None, drill: Optional[str] = None,
            q: str = "", sort: str = "value", offset: int = 0, limit: int = 80,
            db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    rows, _ = _board_rows(db, obj, period, flow, open_only, owner_id, drill)
    return S.records_table(rows, q=q.strip()[:120], sort=sort, offset=max(0, offset), limit=min(200, max(1, limit)))


@router.get("/export")
def export(obj: str = Query("Whole journey"), period: str = Query("All"), flow: Optional[str] = None,
           open_only: bool = False, owner_id: Optional[int] = None, drill: Optional[str] = None,
           db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    rows, _ = _board_rows(db, obj, period, flow, open_only, owner_id, drill)
    csv_text = S.export_csv(rows)
    return StreamingResponse(io.StringIO(csv_text), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="funnel_export.csv"'})


@router.get("/journey")
def journey(period: str = Query("All"), db: Session = Depends(get_tenant_db), _: User = Depends(viewer)):
    return S.journey_trends(db, period)


@router.get("/data")
def module_data(db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    """Prototype v17 Funnel & analytics – every view's data: lead / deal / bid / quote rows (each module's own permissions and
    data visibility), orders, flows with stage SLAs, Customer 360 accounts, the FY target and the forecast thresholds."""
    if not user_has_permission(db, cu, "funnel.view"):
        raise HTTPException(403, "You don't have access to Funnel & analytics")
    from app.core.timezone import today_ist
    from app.services import dashboard_v9 as V
    from app.services.dashboard_funnel import module_data as build
    ctx = V.Ctx(db, cu, None, "FY", today_ist(), set())
    return build(ctx)
