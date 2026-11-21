"""Analytics (prototype v17 · Intelligence → Analytics) – /api/v1/analytics-v17

GET  /meta              fiscal years (Settings fiscal_year_start) + tabs + what the user may do
GET  /tabs/{tab}?fy=    one tab's KPIs, charts and table for a fiscal year (module permissions / data scope applied)
POST /share             PDF snapshot of the tab for the FY → Document Hub → pre-filled Inbox composer (reports.share)
Access: report_engine.view (the Analytics module permission).
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, require_permission, user_has_permission
from app.models.all_models import User
from app.services import analytics_v17_service as A

router = APIRouter(tags=["Analytics"])
an_user = require_permission(A.PERM)


class ShareIn(BaseModel):
    tab: str
    fy: Optional[str] = None


@router.get("/meta")
def meta(db: Session = Depends(get_tenant_db), cu: User = Depends(an_user)):
    from app.services.reports_v17_service import company_name
    return {"tabs": A.TABS, "fys": A.fiscal_years(db), "company": company_name(db),
            "can": {"share": user_has_permission(db, cu, "reports.share") and user_has_permission(db, cu, "document_management.view")}}


@router.get("/tabs/{tab:path}")                       # tab names contain "/" ("Win / loss & competitors")
def tab(tab: str, fy: Optional[str] = None, db: Session = Depends(get_tenant_db), cu: User = Depends(an_user)):
    return A.run(db, cu, tab, fy)


def _val(v: Any, f: str) -> str:
    from app.services.reports_v17_service import _inr
    if v is None or v == "":
        return "—"
    if f in ("inr",):
        return _inr(v)
    if f == "inr_day":
        return f"{_inr(v)} / day"
    if f in ("pct", "pctv", "bar"):
        return f"{v}%"
    if f == "delta":
        return f"{'+' if float(v) > 0 else ''}{v}%"
    if f == "days":
        return f"{v} d"
    return str(v)


def snapshot(out: dict) -> dict:
    """Flatten a tab into the Reports export shape: KPIs + one row per chart point / heat-map cell / table row."""
    rows = []
    for c in out.get("c", []) + out.get("c2", []):
        if c.get("type") == "table":
            for r in c["rows"]:
                rows.append({"s": c["t"], "i": r.get("n") or r.get("name") or "", "v": " · ".join(f"{col['t']} {_val(r.get(col['k']), col.get('f'))}" for col in c["cols"][1:])})
        elif c.get("ser"):
            for s in c["ser"]:
                rows.append({"s": c["t"], "i": s["n"], "v": " · ".join(f"{lbl} {_val(v, c.get('f'))}" for lbl, v in zip(c["labels"], s["v"]) if v is not None)})
        else:
            for d in c["d"]:
                rows.append({"s": c["t"], "i": d["l"], "v": _val(d.get("v"), c.get("f"))})
    h = out.get("heat")
    if h:
        src = h.get("raw") or h["v"]
        for i, rname in enumerate(h["rows"]):
            rows.append({"s": h["t"], "i": rname, "v": " · ".join(f"{cn[-5:] if len(cn) > 5 else cn} {_val(src[i][j], h.get('fmt') or 'int')}" for j, cn in enumerate(h["cols"]))})
    t = out.get("table")
    if t:
        for r in t["rows"]:
            first = t["cols"][0]["k"]
            rows.append({"s": t["t"], "i": str(r.get(first) or ""), "v": " · ".join(f"{col['t']} {_val(r.get(col['k']), col.get('f'))}" for col in t["cols"][1:])})
    return {"n": f"Analytics – {out['tab']}", "cat": "Analytics", "company": out["company"], "period_label": out["fy_label"], "start": out["start"], "end": out["end"],
            "generated": out["generated"], "basis": "Fiscal year", "note": None, "total": len(rows),
            "k": [{"l": k["l"], "v": _val(k["v"], k["f"]) if k["f"] not in ("inr", "pct") else k["v"], "f": k["f"] if k["f"] in ("inr", "pct") else "text"} for k in out.get("k", [])],
            "cols": [{"k": "s", "t": "Section", "f": "text", "w": 170}, {"k": "i", "t": "Item", "f": "text", "w": 170}, {"k": "v", "t": "Value", "f": "text", "w": 420}],
            "rows": rows}


@router.post("/share")
def share(body: ShareIn, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(an_user)):
    if not user_has_permission(db, cu, "reports.share"):
        raise HTTPException(403, "You don't have permission to share analytics")
    if not user_has_permission(db, cu, "document_management.view"):
        raise HTTPException(403, "Sharing a snapshot needs Document Hub access")
    from app.core.config import settings
    from app.core.timezone import today_ist
    from app.models.all_models import DocumentManagementFile
    from app.routers.document_management_router import _standalone_document_id
    from app.services.reports_v17_service import ensure_schema, to_pdf
    from app.models.reports360 import ReportRun
    from app.utils.file_storage import media_slug_from_request, save_upload_optimized
    out = A.run(db, cu, body.tab, body.fy)                   # same permissions / scope as viewing the tab
    snap = snapshot(out)
    data = to_pdf(snap)
    name = f"Analytics_{re.sub(r'[^A-Za-z0-9]+', '_', out['tab']).strip('_')}_{out['fy_label'].replace(' ', '_')}_{today_ist().strftime('%Y%m%d')}.pdf"
    saved = save_upload_optimized(root_dir=os.path.abspath(settings.MEDIA_ROOT), subfolder="document-management", original_filename=name,
                                  contents=data, media_slug=media_slug_from_request(request), content_type="application/pdf")
    doc = DocumentManagementFile(name=name[:300], description=f"Analytics snapshot – {out['tab']}, {out['fy_label']} (generated {out['generated'].replace('T', ' ')})"[:500],
                                 file_url=saved.url, file_size_kb=saved.size_kb, uploaded_by=cu.id, doc_type="Report")
    db.add(doc)
    db.flush()
    ensure_schema(db)
    db.add(ReportRun(report_key=f"analytics:{out['tab']}"[:80], report_name=snap["n"][:200], user_id=cu.id, trigger="email", fmt="PDF", period=str(out["fy"]),
                     rows=snap["total"], file_name=name, file_url=saved.url, file_size_kb=saved.size_kb, document_id=doc.id, status="ok"))
    db.commit()
    gen = datetime.fromisoformat(out["generated"]).strftime("%d %b %Y %H:%M")
    return {"attachment": {"key": f"doc:{_standalone_document_id(doc)}", "name": name}, "subject": f"Analytics snapshot – {out['tab']} ({out['fy_label']})",
            "body": f"Hi,\n\nPlease find attached the Analytics snapshot for \"{out['tab']}\" – {out['fy_label']}, {out['company']}.\nGenerated: {gen} IST\n\nRegards,\n{cu.full_name}"}
