"""Jobs & queues: Celery queues on the Redis broker and the platform's scheduled background jobs (platform_jobs).

Under ``/jobs`` (Jobs & Queues permission: view to read, manage to act). Queues and jobs serve every tenant, so pausing,
retrying and running need all-tenant scope; every action is written to the platform audit log.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_master_db_dep, master_engine
from app.dependencies import get_request_ip
from app.routers.platform_router import _get_platform_admin, _write_platform_audit
from app.services import platform_jobs as jobs
from app.services.platform_access import enforce_platform_access, scoped_tenant_ids

router = APIRouter(prefix="/api/v1/platform/jobs", dependencies=[Depends(enforce_platform_access)])


@router.get("")
def overview(request: Request):
    queues = jobs.queues_overview(force=request.query_params.get("refresh") == "1")
    scheduled = jobs.scheduled_overview()
    with master_engine.connect() as conn:
        runs_15 = conn.execute(text("SELECT COUNT(*) FROM platform_job_runs WHERE finished_at >= :s"), {"s": datetime.now() - timedelta(minutes=15)}).scalar()
    tasks_per_min = queues["throughput_per_min"]
    return {
        "generated_at": datetime.now(),
        "kpis": {
            "queued": queues.get("queued"),
            "running": (queues["running"] or 0) + sum(1 for j in scheduled if j["running"]),
            "running_tasks": queues["running"], "running_jobs": sum(1 for j in scheduled if j["running"]),
            "failed_24h": (queues["failed_24h"] or 0) + sum(j["failed_24h"] for j in scheduled),
            "failed_tasks_24h": queues["failed_24h"], "failed_jobs_24h": sum(j["failed_24h"] for j in scheduled),
            "dead_letter": queues["dead_letter"],
            "throughput_per_min": round((tasks_per_min or 0) + runs_15 / 15, 1),
            "tasks_per_min": tasks_per_min, "job_runs_per_min": round(runs_15 / 15, 1),
        },
        "broker": queues["broker"], "workers": queues["workers"], "queues": queues["queues"], "scheduled": scheduled,
        "all_scope": scoped_tenant_ids(request) is None,
    }


def _act(request: Request, db: Session, action: str, name: str, description: str) -> None:
    if scoped_tenant_ids(request) is not None:
        raise HTTPException(status_code=403, detail="Queues and scheduled jobs serve every tenant – this needs all-tenant scope.")
    _write_platform_audit(db, _get_platform_admin(request), action, "job_queue", None, name, description, get_request_ip(request))
    db.commit()


def _queue(name: str) -> str:
    state = jobs.queues_overview(force=True)
    if not state["broker"]["ok"]:
        raise HTTPException(status_code=503, detail=state["broker"]["error"])
    known = {q["name"] for q in state["queues"]}
    if name not in known:
        raise HTTPException(status_code=404, detail="Unknown queue")
    return name


def _broker_call(fn, *args):
    try:
        return fn(*args)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"The Celery broker or workers could not be reached: {exc}")


@router.post("/queues/{name}/pause")
def pause(name: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _queue(name)
    acked = _broker_call(jobs.set_paused, name, True)
    _act(request, db, "queue_paused", name, f"Queue '{name}' paused ({acked} worker(s) stopped consuming)")
    return {"ok": True, "workers": acked}


@router.post("/queues/{name}/resume")
def resume(name: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _queue(name)
    acked = _broker_call(jobs.set_paused, name, False)
    _act(request, db, "queue_resumed", name, f"Queue '{name}' resumed ({acked} worker(s) consuming)")
    return {"ok": True, "workers": acked}


@router.post("/queues/{name}/retry-failed")
def retry_failed(name: str, request: Request, db: Session = Depends(get_master_db_dep)):
    _queue(name)
    sent = _broker_call(jobs.retry_dead, name)
    _act(request, db, "queue_retry_failed", name, f"{sent} failed task(s) re-sent on queue '{name}'")
    return {"ok": True, "retried": sent}


@router.post("/scheduled/{key}/run")
def run_now(key: str, request: Request, db: Session = Depends(get_master_db_dep)):
    if key not in jobs.JOBS:
        raise HTTPException(status_code=404, detail="Unknown job")
    _act(request, db, "scheduled_job_run", key, f"'{jobs.JOBS[key]['name']}' run on demand")
    admin = _get_platform_admin(request)
    if not jobs.run_now(key, getattr(admin, "email", None) or "platform admin"):
        raise HTTPException(status_code=409, detail="This job is already running")
    return {"ok": True}
