"""Data Hub (prototype v17 R.datahub): Import · Migration · Duplicates · Mass update · Recycle bin · Exports & backups.

Import     the page maps the file's columns to a module's import template and posts the rebuilt CSV to that module's
           existing /import endpoint (validated path, duplicates reported); the run is logged here as a job.
Migration  tenant-side requests against the platform's connector catalogue (credentials sealed, validated when possible).
Duplicates candidates are computed from ONE bounded SELECT per object (normalised name / e-mail / phone keys), ignored
           pairs excluded by one SELECT; merge re-points references with one UPDATE per table.
Mass update one UPDATE with bound parameters over a whitelisted column; the old values are snapshotted in the job so it
           can be undone.
Exports    CSV / ZIP written in a background thread to MEDIA_ROOT/datahub/<tenant>/, streamed back through an authorised
           download endpoint; the recycle bin stays on /api/v1/recycle-bin.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import logging
import os
import re
import threading
import zipfile
from datetime import datetime, timedelta
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.timezone import now_ist
from app.models.all_models import OEM, Competitor, Customer, CustomerContact, Lead, LeadSource, Quotation, Tender, User, WorkOrder
from app.models.datahub import DATAHUB_TABLES, DataJob, DedupeIgnore, MigrationRequest

logger = logging.getLogger(__name__)
_READY: set[str] = set()
_LOCK = threading.Lock()
MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "media")

TABS = ["Import", "Migration", "Duplicates", "Mass update", "Recycle bin", "Exports & backups"]
IMPORT_OBJECTS = {"leads": ("Leads", "/lead360/import", "lead360"), "customers": ("Customers", "/customer360/import", "customer360"),
                  "opps": ("Deals", "/deals/import", "deals"), "bids": ("Bids & Tenders", "/bids/import", "bids"), "products": ("Products", "/masters360/products/import", None)}
EXPORT_OBJECTS = {"customers": ("Customers", Customer, ["id", "customer_name", "account_status", "customer_vertical", "industry", "city", "state", "created_at"]),
                  "leads": ("Leads", Lead, ["id", "lead_ref_id", "lead_title", "status", "est_value", "customer_id", "assigned_to", "created_at"]),
                  "tenders": ("Bids & Tenders", Tender, ["id", "tender_num", "tender_title", "customer_name", "tender_status", "result", "est_value", "emd_amount", "created_at"]),
                  "quotations": ("Quotes", Quotation, ["id", "quotation_number", "subject", "customer_id", "status", "total_amount", "created_at"]),
                  "workorders": ("Orders & Projects", WorkOrder, ["id", "wo_number", "project_title", "customer_name", "status", "wo_value", "created_at"]),
                  "oems": ("Partners & OEM", OEM, ["id", "name", "type", "contact_name", "auth_valid_till", "status"]),
                  "competitors": ("Competitors", Competitor, ["id", "name", "city", "strengths", "weaknesses", "threat_level"])}
# Mass update: module → field → (column, kind, label); values validated per kind (user id / master id / enum / text)
MASS_FIELDS: dict[str, dict[str, tuple[Any, str, str, Any]]] = {
    "customers": {"owner": (Customer.assigned_to, "user", "Key account manager", None), "status": (Customer.account_status, "enum", "Account status", ("Active", "Prospect", "Dormant", "Inactive")),
                  "vertical": (Customer.customer_vertical, "text", "Customer vertical", None)},
    "leads": {"owner": (Lead.assigned_to, "user", "Owner", None), "source": (Lead.source_id, "master", "Source", LeadSource),
              "status": (Lead.status, "enum", "Stage", ("Assigned", "Contacted", "Qualified", "Proposal Pending", "Nurturing"))},
    "opps": {"owner": (Lead.assigned_to, "user", "Owner", None)},
    "tenders": {"status": (Tender.tender_status, "text", "Tender status", None)},
}
MASS_MODELS = {"customers": Customer, "leads": Lead, "opps": Lead, "tenders": Tender}
MASS_LABELS = {"customers": "Customers", "leads": "Leads", "opps": "Deals", "tenders": "Bids & Tenders"}
_STOP = re.compile(r"\b(ltd|limited|pvt|private|corporation|corp|co|company|inc|llp|india|of)\b|[^a-z0-9 ]")


# ─── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(db: Session) -> None:
    slug = str(db.info.get("tenant_slug") or id(db.get_bind()))
    if slug in _READY:
        return
    with _LOCK:
        if slug in _READY:
            return
        bind = db.get_bind()
        for t in DATAHUB_TABLES:
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
        logger.warning("Data hub schema sync: unable to list tenants: %s", exc)
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
            logger.warning("Data hub schema sync failed for %s: %s", slug, exc)


def _d(v) -> Optional[str]:
    return v.isoformat() if v else None


def _aead() -> AESGCM:
    return AESGCM(hashlib.sha256(("datahub-migration:" + settings.SECRET_KEY).encode()).digest())


def _seal(data: dict) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + _aead().encrypt(nonce, json.dumps(data).encode(), b"azx-datahub")).decode()


# ─── jobs ─────────────────────────────────────────────────────────────────────

def _job_dict(j: DataJob, names: dict[int, str]) -> dict:
    return {"id": j.id, "kind": j.kind, "object": j.object, "n": j.name, "d": _d(j.created_at), "finished": _d(j.finished_at), "st": j.status,
            "s": f"{(j.size_kb or 0) / 1000:.1f} MB" if (j.size_kb or 0) >= 1000 else f"{j.size_kb or 0} KB" if j.size_kb else "—", "rows": j.rows_total, "done": j.rows_done,
            "errors": j.rows_error, "by": names.get(j.created_by or 0, "—"), "file": j.file_name, "can_download": bool(j.file_path and j.status == "Done"),
            "can_undo": j.kind == "mass_update" and j.status == "Done", "error": j.error}


def jobs(db: Session, kinds: tuple[str, ...], offset: int, limit: int) -> dict:
    base = db.query(DataJob).filter(DataJob.kind.in_(kinds))
    total = base.with_entities(func.count(DataJob.id)).scalar() or 0
    rows = base.order_by(DataJob.created_at.desc(), DataJob.id.desc()).offset(offset).limit(limit).all()
    ids = {j.created_by for j in rows if j.created_by}
    names = dict(db.query(User.id, User.full_name).filter(User.id.in_(list(ids))).all()) if ids else {}
    return {"items": [_job_dict(j, names) for j in rows], "total": int(total)}


def log_import(db: Session, cu: User, obj: str, file_name: str, rows_total: int, created: int, duplicates: int, errors: int, detail: dict) -> int:
    if obj not in IMPORT_OBJECTS:
        raise HTTPException(422, "Unknown import object")
    j = DataJob(kind="import", object=obj, name=f"{IMPORT_OBJECTS[obj][0]} import · {file_name[:120]}", status="Done" if not errors or created else "Failed",
                rows_total=rows_total, rows_done=created, rows_error=errors, payload={"duplicates": duplicates, **{k: v for k, v in (detail or {}).items() if k in ("errors", "duplicates_list")}},
                created_by=cu.id, finished_at=now_ist())
    db.add(j)
    db.commit()
    return j.id


def import_columns(obj: str) -> dict:
    if obj not in IMPORT_OBJECTS:
        raise HTTPException(404, "Unknown import object")
    label, endpoint, mod = IMPORT_OBJECTS[obj]
    if mod is None:
        return {"object": obj, "label": label, "endpoint": endpoint, "columns": ["Value", "Category", "Description"], "required": ["Value"], "mode": "values"}
    import importlib
    router = importlib.import_module(f"app.routers.{mod}_router")
    cols = list(getattr(router, "IMPORT_COLUMNS", []))
    return {"object": obj, "label": label, "endpoint": endpoint, "columns": cols, "required": cols[:1], "mode": "csv"}


# ─── migration ────────────────────────────────────────────────────────────────

def migration(db: Session) -> dict:
    from app.services import migration_connectors as mc
    reqs = db.query(MigrationRequest, User.full_name).outerjoin(User, User.id == MigrationRequest.created_by).order_by(MigrationRequest.created_at.desc()).limit(50).all()
    return {"sources": [{"n": s, "kind": "file" if s in mc.FILE_SOURCES else "api", "info": mc.FILE_INFO.get(s, ("", []))[0]} for s in mc.SOURCES],
            "requests": [{"id": r.id, "source": r.source, "account": r.account or "", "objects": r.objects or [], "status": r.status, "notes": r.notes or "", "by": n or "—", "d": _d(r.created_at)}
                         for r, n in reqs]}


def request_migration(db: Session, cu: User, source: str, config: dict, objects: list[str], notes: str) -> dict:
    from app.services import migration_connectors as mc
    if source not in mc.SOURCES:
        raise HTTPException(422, "Unknown source")
    req = MigrationRequest(source=source, config_enc=_seal(config) if config else None, objects=[{"name": o} for o in objects[:30]], status="Requested", notes=(notes or "")[:2000] or None, created_by=cu.id)
    if source in mc.CONNECTORS and config:
        try:
            res = mc.validate(source, config)
            req.account, req.objects, req.status = str(res.get("account") or "")[:200], res.get("objects") or req.objects, "Validated"
        except Exception as exc:
            req.notes = f"Connection check failed: {str(exc)[:300]}\n{req.notes or ''}".strip()
    db.add(req)
    db.commit()
    return {"id": req.id, "status": req.status, "account": req.account or ""}


# ─── duplicates ───────────────────────────────────────────────────────────────

def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", _STOP.sub(" ", (s or "").lower())).strip()


def duplicates(db: Session, obj: str, limit: int = 100) -> list[dict]:
    if obj == "customers":
        rows = db.query(Customer.id, Customer.customer_name, Customer.billing_city).filter(Customer.is_deleted.is_(False)).order_by(Customer.id).limit(5000).all()
        recs = [{"id": i, "name": n, "sub": c or "", "keys": [("n", _norm(n))]} for i, n, c in rows]
    elif obj == "leads":
        rows = db.query(Lead.id, Lead.lead_title, Lead.email, Lead.customer_id).filter(Lead.is_deleted.is_(False)).order_by(Lead.id).limit(5000).all()
        recs = [{"id": i, "name": t, "sub": e or "", "keys": [("n", f"{_norm(t)}|{c or 0}")] + ([("e", e.lower().strip())] if e else [])} for i, t, e, c in rows]
    else:
        raise HTTPException(422, "Duplicates are checked for customers and leads")
    ignored = {(a, b) for a, b in db.query(DedupeIgnore.a_id, DedupeIgnore.b_id).filter(DedupeIgnore.object == obj).all()}
    buckets: dict[tuple[str, str], list[dict]] = {}
    for r in recs:
        for k in r["keys"]:
            if k[1]:
                buckets.setdefault(k, []).append(r)
    seen: set[tuple[int, int]] = set()
    out = []
    for key, group in buckets.items():
        if len(group) < 2:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                pair = (min(a["id"], b["id"]), max(a["id"], b["id"]))
                if pair in seen or pair in ignored:
                    continue
                seen.add(pair)
                score = 97 if key[0] == "e" else 90 if a["name"].strip().lower() == b["name"].strip().lower() else 82
                out.append({"id": f"{pair[0]}-{pair[1]}", "a": {"id": a["id"], "name": a["name"], "sub": a["sub"]}, "b": {"id": b["id"], "name": b["name"], "sub": b["sub"]}, "sc": score,
                            "why": "same e-mail" if key[0] == "e" else "same name"})
                if len(out) >= limit:
                    return sorted(out, key=lambda x: -x["sc"])
    return sorted(out, key=lambda x: -x["sc"])


def ignore_pair(db: Session, cu: User, obj: str, a: int, b: int) -> None:
    a, b = min(a, b), max(a, b)
    if not db.query(DedupeIgnore.id).filter(DedupeIgnore.object == obj, DedupeIgnore.a_id == a, DedupeIgnore.b_id == b).first():
        db.add(DedupeIgnore(object=obj, a_id=a, b_id=b, decided_by=cu.id))
        db.commit()


def merge(db: Session, cu: User, obj: str, keep_id: int, drop_id: int) -> dict:
    if keep_id == drop_id:
        raise HTTPException(422, "Choose two different records")
    moved: dict[str, int] = {}
    if obj == "customers":
        keep, drop = db.get(Customer, keep_id), db.get(Customer, drop_id)
        if not keep or not drop or keep.is_deleted or drop.is_deleted:
            raise HTTPException(404, "Customer not found")
        for M, col in ((Lead, Lead.customer_id), (Tender, Tender.customer_id), (Quotation, Quotation.customer_id), (WorkOrder, WorkOrder.customer_id), (CustomerContact, CustomerContact.customer_id)):
            moved[M.__tablename__] = int(db.query(M).filter(col == drop_id).update({col: keep_id}, synchronize_session=False))
        db.query(Tender).filter(Tender.customer_id == keep_id, or_(Tender.customer_name.is_(None), Tender.customer_name == drop.customer_name)).update({Tender.customer_name: keep.customer_name}, synchronize_session=False)
        db.query(WorkOrder).filter(WorkOrder.customer_id == keep_id, WorkOrder.customer_name == drop.customer_name).update({WorkOrder.customer_name: keep.customer_name}, synchronize_session=False)
        drop.is_deleted = True
        drop.is_active = False
    elif obj == "leads":
        keep, drop = db.get(Lead, keep_id), db.get(Lead, drop_id)
        if not keep or not drop or keep.is_deleted or drop.is_deleted:
            raise HTTPException(404, "Lead not found")
        for attr in ("email", "phone", "contact_person", "mobile"):
            if hasattr(keep, attr) and not getattr(keep, attr) and getattr(drop, attr, None):
                setattr(keep, attr, getattr(drop, attr))
        drop.is_deleted = True
    else:
        raise HTTPException(422, "Merge works for customers and leads")
    db.add(DataJob(kind="merge", object=obj, name=f"Merged {obj[:-1]} #{drop_id} into #{keep_id}", status="Done", rows_total=1, rows_done=1, payload={"keep": keep_id, "drop": drop_id, "moved": moved},
                   created_by=cu.id, finished_at=now_ist()))
    db.commit()
    return {"moved": moved}


# ─── mass update ──────────────────────────────────────────────────────────────

def mass_fields(db: Session, module: str) -> dict:
    if module not in MASS_FIELDS:
        raise HTTPException(404, "Unknown module")
    fields = []
    for k, (col, kind, label, extra) in MASS_FIELDS[module].items():
        f: dict[str, Any] = {"k": k, "l": label, "kind": kind}
        if kind == "user":
            f["options"] = [{"v": u.id, "l": u.full_name} for u in db.query(User).filter(User.is_active.is_(True)).order_by(User.full_name).limit(500).all()]
        elif kind == "master":
            f["options"] = [{"v": r.id, "l": r.name} for r in db.query(extra).filter(extra.is_active.is_(True)).order_by(extra.name).limit(500).all()]
        elif kind == "enum":
            f["options"] = [{"v": v, "l": v} for v in extra]
        fields.append(f)
    M = MASS_MODELS[module]
    total = db.query(func.count(M.id)).filter(*_scope(module, "all")).scalar() or 0
    recent = db.query(func.count(M.id)).filter(*_scope(module, "30d")).scalar() or 0
    return {"module": module, "label": MASS_LABELS[module], "fields": fields, "counts": {"all": int(total), "30d": int(recent)}}


def _scope(module: str, scope: str) -> list:
    M = MASS_MODELS[module]
    conds = []
    if hasattr(M, "is_deleted"):
        conds.append(M.is_deleted.is_(False))
    if module == "opps":
        from app.routers.lead_router import _opportunity_clause
        conds.append(_opportunity_clause())
    elif module == "leads":
        from app.routers.lead_router import _opportunity_clause
        conds.append(~_opportunity_clause())
    if scope == "30d":
        conds.append(M.created_at >= now_ist() - timedelta(days=30))
    return conds


def mass_update(db: Session, cu: User, module: str, field: str, value: Any, scope: str) -> dict:
    if module not in MASS_FIELDS or field not in MASS_FIELDS[module]:
        raise HTTPException(422, "Unknown field")
    col, kind, label, extra = MASS_FIELDS[module][field]
    if kind == "user":
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise HTTPException(422, "Choose a user")
        if not db.query(User.id).filter(User.id == value, User.is_active.is_(True)).first():
            raise HTTPException(422, "User not found")
    elif kind == "master":
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise HTTPException(422, f"Choose a {label.lower()}")
        if not db.query(extra.id).filter(extra.id == value).first():
            raise HTTPException(422, f"{label} not found")
    elif kind == "enum":
        if value not in extra:
            raise HTTPException(422, f"{label} must be one of {', '.join(extra)}")
    else:
        value = str(value or "").strip()[:200]
        if not value:
            raise HTTPException(422, "Enter the new value")
    M = MASS_MODELS[module]
    conds = _scope(module, scope if scope in ("all", "30d") else "all")
    old = db.query(M.id, col).filter(*conds).limit(5000).all()
    if len(old) >= 5000:
        raise HTTPException(409, "Mass update is limited to 5,000 records at a time – narrow the scope")
    ids = [i for i, _ in old]
    n = db.query(M).filter(M.id.in_(ids)).update({col: value}, synchronize_session=False) if ids else 0
    j = DataJob(kind="mass_update", object=module, name=f"{MASS_LABELS[module]} · {label} → {value}", status="Done", rows_total=len(ids), rows_done=int(n),
                payload={"field": field, "value": value, "old": {str(i): (v.isoformat() if hasattr(v, "isoformat") else v) for i, v in old}}, created_by=cu.id, finished_at=now_ist())
    db.add(j)
    db.commit()
    return {"updated": int(n), "job_id": j.id}


def undo(db: Session, cu: User, job_id: int) -> int:
    j = db.get(DataJob, job_id)
    if j is None or j.kind != "mass_update":
        raise HTTPException(404, "Job not found")
    if j.status != "Done":
        raise HTTPException(409, "This update was already undone")
    if j.created_at and j.created_at < now_ist() - timedelta(days=7):
        raise HTTPException(409, "Undo is available for 7 days")
    col = MASS_FIELDS[j.object][j.payload["field"]][0]
    M = MASS_MODELS[j.object]
    n = 0
    for sid, v in (j.payload.get("old") or {}).items():
        n += int(db.query(M).filter(M.id == int(sid)).update({col: v}, synchronize_session=False))
    j.status = "Undone"
    db.commit()
    return n


# ─── exports & backups ────────────────────────────────────────────────────────

def _export_dir(slug: str) -> str:
    d = os.path.join(os.path.abspath(MEDIA_ROOT), "datahub", re.sub(r"[^a-z0-9_-]", "", (slug or "tenant").lower()))
    os.makedirs(d, exist_ok=True)
    return d


def _rows_csv(db: Session, M, cols: list[str]) -> tuple[str, int]:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    n = 0
    q = db.query(*[getattr(M, c) for c in cols])
    if hasattr(M, "is_deleted"):
        q = q.filter(M.is_deleted.is_(False))
    for row in q.yield_per(1000):
        w.writerow([("" if v is None else v.isoformat() if hasattr(v, "isoformat") else v) for v in row])
        n += 1
    return buf.getvalue(), n


def _run_export(slug: str, job_id: int) -> None:
    from app.database import get_tenant_session
    db = get_tenant_session(slug)
    db.info["tenant_slug"] = slug
    try:
        j = db.get(DataJob, job_id)
        if j is None:
            return
        j.status = "Running"
        db.commit()
        objs = list(EXPORT_OBJECTS) if j.object == "all" else [j.object]
        stamp = now_ist().strftime("%Y%m%d-%H%M")
        total = 0
        d = _export_dir(slug)
        if len(objs) == 1:
            label, M, cols = EXPORT_OBJECTS[objs[0]]
            data, total = _rows_csv(db, M, cols)
            fname = f"{objs[0]}-{stamp}.csv"
            path = os.path.join(d, f"job{job_id}-{fname}")
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                f.write(data)
        else:
            fname = f"workspace-backup-{stamp}.zip"
            path = os.path.join(d, f"job{job_id}-{fname}")
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
                for o in objs:
                    label, M, cols = EXPORT_OBJECTS[o]
                    data, n = _rows_csv(db, M, cols)
                    total += n
                    z.writestr(f"{o}.csv", "﻿" + data)
        j.file_path, j.file_name, j.size_kb, j.rows_total, j.rows_done, j.status, j.finished_at = path, fname, max(1, os.path.getsize(path) // 1024), total, total, "Done", now_ist()
        db.commit()
    except Exception as exc:
        logger.exception("export job %s failed", job_id)
        try:
            j = db.get(DataJob, job_id)
            if j:
                j.status, j.error, j.finished_at = "Failed", str(exc)[:1000], now_ist()
                db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()


def start_export(db: Session, cu: User, obj: str) -> int:
    if obj != "all" and obj not in EXPORT_OBJECTS:
        raise HTTPException(422, "Unknown export object")
    slug = db.info.get("tenant_slug")
    if not slug:
        raise HTTPException(500, "Tenant not resolved")
    running = db.query(func.count(DataJob.id)).filter(DataJob.kind.in_(("export", "backup")), DataJob.status.in_(("Queued", "Running"))).scalar() or 0
    if running >= 2:
        raise HTTPException(409, "Two exports are already running – wait for them to finish")
    name = "Full workspace backup" if obj == "all" else f"{EXPORT_OBJECTS[obj][0]} export (CSV)"
    j = DataJob(kind="backup" if obj == "all" else "export", object=obj, name=name, status="Queued", created_by=cu.id)
    db.add(j)
    db.commit()
    threading.Thread(target=_run_export, args=(slug, j.id), daemon=True, name=f"datahub-export-{j.id}").start()
    return j.id


def download(db: Session, job_id: int) -> tuple[str, str]:
    j = db.get(DataJob, job_id)
    if j is None or not j.file_path or j.status != "Done":
        raise HTTPException(404, "File not available")
    if not os.path.isfile(j.file_path):
        raise HTTPException(410, "The file has been removed")
    return j.file_path, j.file_name or os.path.basename(j.file_path)
