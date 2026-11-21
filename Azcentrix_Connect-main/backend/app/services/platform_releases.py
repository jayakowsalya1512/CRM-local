"""Release pipeline (Data & infrastructure → Infrastructure & releases).

The platform keeps the release history and drives every rollout step through the deployment service configured in
PLATFORM_DEPLOY_COMMAND. It never changes servers itself and never records a step as done on its own.

Deployment service contract
    <command> validate <version>
        Synchronous check that the release can be deployed (artifact or tag exists, configuration complete).
        Exit 0 = valid; anything else = invalid and the last output line is shown to the admin. Limit 120 s.
    <command> deploy <version> <percent> <current production version or ->
        Route <percent> % of traffic to <version>; 100 makes it the production release on every server.
    <command> rollback <version> <release being rolled back>
        Restore <version> (a release verified in production before) on every server and route all traffic to it.
    deploy and rollback get AZX_RELEASE_RESULT_FILE and AZX_RELEASE_LOG_FILE. When the step is over the service writes
    {"ok": true|false, "message": "..."} to the result file. A step succeeds only when that file says ok – exiting 0
    is not enough, so the service may detach (systemd-run, a job runner …) and outlive the API restart it causes.
    A non-zero exit fails the step at once; no result within PLATFORM_DEPLOY_TIMEOUT_SECONDS fails it too.
    The service gets no database credentials: tenant databases are only migrated by the new release itself.

States
    deploying → canary (1–99 %) → production (100 %; verified once an API process reports the version and the API
    error rate is within the alert limit). A failed first step → failed. Rollback → rolled_back, and the previous
    release is production again. The next release to reach 100 % supersedes the production one. One release can be
    in flight at a time (MySQL advisory lock + the operation column).
    Steps run in a background thread of the API worker that started them. reconcile() runs every minute in every
    worker: it finishes steps whose thread was lost to a restart, verifies production releases and, when
    "Auto-rollback on error spike" is on, rolls a canary back when the API error rate passes the alert limit.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import shutil
import socket
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import text, update

from app.core.config import BASE_DIR, settings
from app.core.version import RUNNING_VERSION
from app.database import MasterSessionLocal, master_engine
from app.models.platform_release import PlatformRelease, PlatformReleaseStep
from app.services import platform_changes
from app.services import platform_controls as controls
from app.services import platform_monitoring as monitor

logger = logging.getLogger(__name__)

VERSION_RE = re.compile(r"^\d{1,4}\.\d{1,3}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$")
CANARY_STEPS = (10, 25, 50, 100)
IN_FLIGHT = ("deploying", "canary")
OPERATION_TEXT = {"deploy": "deploying", "promote": "being promoted", "rollback": "being rolled back"}
VALIDATE_TIMEOUT_SECONDS = 120
OUTPUT_TAIL = 8000
AUTO_ROLLBACK_WINDOW_MINUTES = 5
AUTO_ROLLBACK_MIN_REQUESTS = 50  # too little traffic says nothing about the error rate
WORKER = f"{socket.gethostname()}:{os.getpid()}"[:80]
_SECRET_ENV = re.compile(r"PASSWORD|SECRET|TOKEN|DATABASE_URL|API_KEY|PRIVATE", re.I)


class ReleaseError(Exception):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if not _schema_ready:
        for model in (PlatformRelease, PlatformReleaseStep):
            model.__table__.create(bind=master_engine, checkfirst=True)
        platform_changes.ensure_schema()  # read by create(); must exist before the request's transaction starts
        _schema_ready = True


def version_key(version: str) -> tuple:
    """Numeric order; a pre-release (2026.11.1-rc.1) sorts before its release."""
    core, _, pre = version.partition("-")
    return tuple(int(part) for part in core.split(".")), pre == "", pre


# ─── Deployment service ──────────────────────────────────────────────────────

def deploy_command() -> Optional[list[str]]:
    raw = (settings.PLATFORM_DEPLOY_COMMAND or "").strip()
    if not raw:
        return None
    return [part.strip('"') for part in shlex.split(raw, posix=os.name != "nt")]


def service_status() -> dict:
    command = deploy_command()
    if not command:
        return {"configured": False, "error": "No deployment service is configured (PLATFORM_DEPLOY_COMMAND) – releases can't be run from the platform."}
    if not (shutil.which(command[0]) or Path(command[0]).is_file()):
        return {"configured": False, "error": f"Deployment service not found on this server: {command[0]}"}
    return {"configured": True, "error": None, "command": Path(command[0]).name}


def _require_service() -> list[str]:
    status = service_status()
    if not status["configured"]:
        raise ReleaseError(status["error"], 503)
    return deploy_command()


def _env(**extra: str) -> dict:
    env = {key: value for key, value in os.environ.items() if not _SECRET_ENV.search(key)}
    env.update(extra)
    return env


def _state_dir() -> Path:
    path = Path(settings.PLATFORM_DEPLOY_STATE_DIR)
    path = path if path.is_absolute() else BASE_DIR / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _step_files(step_id: int) -> tuple[Path, Path]:
    root = _state_dir()
    return root / f"step-{step_id}.result.json", root / f"step-{step_id}.log"


def _last_line(output: str) -> str:
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    return lines[-1][:500] if lines else ""


def _tail(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - OUTPUT_TAIL))
            return handle.read().decode("utf-8", errors="replace") or None
    except OSError:
        return None


def _read_result(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None  # not written yet (or still being written)
    if not isinstance(data, dict) or not isinstance(data.get("ok"), bool):
        return {"ok": False, "message": "The deployment service wrote an invalid result file"}
    return {"ok": data["ok"], "message": str(data.get("message") or "")[:500]}


def validate(version: str) -> str:
    command = _require_service()
    try:
        proc = subprocess.run([*command, "validate", version], capture_output=True, encoding="utf-8", errors="replace",
                              timeout=VALIDATE_TIMEOUT_SECONDS, cwd=str(BASE_DIR), env=_env(), stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise ReleaseError(f"The deployment service did not finish validating {version} within {VALIDATE_TIMEOUT_SECONDS} s", 504)
    except OSError as exc:
        raise ReleaseError(f"The deployment service could not be started: {exc}", 503)
    message = _last_line((proc.stdout or "") + "\n" + (proc.stderr or ""))
    if proc.returncode != 0:
        raise ReleaseError(f"Release {version} failed validation: {message or f'exit code {proc.returncode}'}", 422)
    return message


def _launch(step_id: int, argv: list[str]) -> None:
    """Run one deploy / rollback call in a background thread and record its outcome."""
    result_file, log_file = _step_files(step_id)
    result_file.unlink(missing_ok=True)
    env = _env(AZX_RELEASE_RESULT_FILE=str(result_file), AZX_RELEASE_LOG_FILE=str(log_file), AZX_RELEASE_STEP=str(step_id))
    timeout = settings.PLATFORM_DEPLOY_TIMEOUT_SECONDS

    def run() -> None:
        started = time.time()
        try:
            with open(log_file, "ab") as log:
                detach = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
                proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=str(BASE_DIR), env=env, **detach)
                try:
                    exit_code = proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    finish_step(step_id, False, f"The deployment service did not finish within {timeout} s", None)
                    return
        except OSError as exc:
            finish_step(step_id, False, f"The deployment service could not be started: {exc}", None)
            return
        if exit_code != 0:
            result = _read_result(result_file)
            finish_step(step_id, False, (result or {}).get("message") or _last_line(_tail(log_file) or "") or f"Deployment service exited with code {exit_code}", exit_code)
            return
        while time.time() - started < timeout:  # exit 0 only means the step was handed over
            result = _read_result(result_file)
            if result is not None:
                finish_step(step_id, result["ok"], result["message"], exit_code)
                return
            time.sleep(2)
        finish_step(step_id, False, f"No result from the deployment service within {timeout} s", exit_code)

    threading.Thread(target=run, name=f"release-step-{step_id}", daemon=True).start()


# ─── Pipeline ────────────────────────────────────────────────────────────────

@contextmanager
def _pipeline_lock(db):
    with master_engine.connect() as conn:
        if conn.execute(text("SELECT GET_LOCK('platform_release_pipeline', 5)")).scalar() != 1:
            raise ReleaseError("Another release action is being processed – try again in a moment")
        try:
            db.rollback()  # read the pipeline as it is now, not from a snapshot taken before the lock
            yield
        finally:
            conn.execute(text("SELECT RELEASE_LOCK('platform_release_pipeline')"))


def production(db) -> Optional[PlatformRelease]:
    return db.query(PlatformRelease).filter(PlatformRelease.status == "production").order_by(PlatformRelease.production_at.desc(), PlatformRelease.id.desc()).first()


def in_flight(db) -> Optional[PlatformRelease]:
    return db.query(PlatformRelease).filter((PlatformRelease.status.in_(IN_FLIGHT)) | (PlatformRelease.operation.isnot(None))).first()


def rollback_target(db, release: PlatformRelease) -> Optional[PlatformRelease]:
    """The release a rollback restores: the previous production release, if it was verified in production."""
    if not release.previous_version or release.status not in ("canary", "production", "failed"):
        return None
    if release.status == "production" and production(db) is not release:
        return None
    target = db.query(PlatformRelease).filter(PlatformRelease.version == release.previous_version).first()
    if not target or target.verified_at is None or target.status not in ("production", "superseded"):
        return None
    return target


def next_percent(release: PlatformRelease) -> Optional[int]:
    if release.status != "canary":
        return None
    return next((p for p in CANARY_STEPS if p > release.rollout_percent), 100)


def api_health(db) -> tuple[bool, str]:
    """API error rate over the last 15 minutes against the alert limit (Control Center → Error-rate alert)."""
    limit = float(controls.value(db, "alertErr") or 1)
    stats = monitor.window_stats("api", 15)
    if not stats["requests"]:
        return True, "No API requests in the last 15 min"
    detail = f"{stats['error_rate']}% errors over {stats['requests']} requests in 15 min (limit {limit:g}%)"
    return stats["error_rate"] <= limit, detail


def _ensure_baseline(db) -> None:
    """Before the first tracked release, record the release this API is running as production.

    It counts as verified when it is healthy now: that is the same check a deployed release has to pass.
    """
    if production(db) or not VERSION_RE.match(RUNNING_VERSION):
        return
    if db.query(PlatformRelease).filter(PlatformRelease.version == RUNNING_VERSION).first():
        return
    healthy, _ = api_health(db)
    now = datetime.utcnow()
    db.add(PlatformRelease(version=RUNNING_VERSION, status="production", rollout_percent=100, notes="Release running when release tracking began",
                           created_by="system", created_at=now, started_at=now, production_at=now, verified=healthy, verified_at=now if healthy else None))
    db.flush()


def _audit(db, admin, action: str, release: PlatformRelease, description: str, ip: str = "system", extra: Optional[dict] = None) -> None:
    from app.routers.platform_router import _write_platform_audit

    _write_platform_audit(db, admin, action, "release", release.id, release.version, description, ip,
                          new_data={"status": release.status, "rollout_percent": release.rollout_percent, **(extra or {})})


def _start(db, release: PlatformRelease, action: str, argv_tail: list[str], to_percent: Optional[int], target: str, actor: Optional[str], trigger: str) -> PlatformReleaseStep:
    command = _require_service()
    release.operation = action
    release.last_error = None
    step = PlatformReleaseStep(release_id=release.id, action=action, target_version=target, from_percent=release.rollout_percent,
                               to_percent=to_percent, trigger=trigger, actor=actor, worker=WORKER)
    db.add(step)
    db.flush()
    db.commit()
    _launch(step.id, [*command, *argv_tail])
    return step


def create(db, version: str, notes: Optional[str], admin, ip: str) -> PlatformRelease:
    ensure_schema()
    version = (version or "").strip()
    if not VERSION_RE.match(version):
        raise ReleaseError("Release version must look like 2026.10.4 or 3.1.0 (optionally with a -rc.1 style suffix)", 422)
    canary = bool(controls.value(db, "relCanary"))
    initial = max(1, min(99, int(controls.value(db, "relCanaryPct") or 10))) if canary else 100
    with _pipeline_lock(db):
        _ensure_baseline(db)
        if db.query(PlatformRelease).filter(PlatformRelease.version == version).first():
            raise ReleaseError(f"Release {version} already exists in the release history")
        busy = in_flight(db)
        if busy:
            state = OPERATION_TEXT.get(busy.operation) or f"in {busy.status}"
            raise ReleaseError(f"Release {busy.version} is still {state} – promote it to production or roll it back first")
        current = production(db)
        if current and version_key(version) <= version_key(current.version):
            raise ReleaseError(f"Release {version} must be newer than the production release {current.version}", 422)
        _require_service()
        validation = validate(version)
        try:  # Change & maintenance: the approved Release change for today (Change approval board / change freeze)
            change = platform_changes.authorize_execution(db, "Release", f"release {version}", admin)
        except platform_changes.ChangeError as exc:
            raise ReleaseError(str(exc), exc.status_code)
        release = PlatformRelease(version=version, status="deploying", rollout_percent=0, previous_version=current.version if current else None,
                                  notes=(notes or "").strip()[:2000] or None, config={"canary": canary, "initial_percent": initial},
                                  created_by=getattr(admin, "email", None), started_at=datetime.utcnow())
        db.add(release)
        db.flush()
        _audit(db, admin, "release_created", release, f"Release {version} started: deploying to {initial}%" + (f" ({validation})" if validation else "")
               + (f" under change {platform_changes.code(change)}" if change else ""), ip)
        _start(db, release, "deploy", ["deploy", version, str(initial), current.version if current else "-"], initial, version,
               getattr(admin, "email", None), "manual")
    return release


def promote(db, release: PlatformRelease, admin, ip: str) -> int:
    with _pipeline_lock(db):
        if release.operation:
            raise ReleaseError(f"Release {release.version} is still {OPERATION_TEXT[release.operation]}")
        target = next_percent(release)
        if target is None:
            raise ReleaseError(f"Only a release in canary can be promoted (release {release.version} is {release.status})")
        healthy, detail = api_health(db)
        if not healthy:
            raise ReleaseError(f"Release {release.version} is not healthy enough to promote: {detail}")
        _audit(db, admin, "release_promote", release, f"Release {release.version} promotion started: {release.rollout_percent}% → {target}% ({detail})", ip)
        _start(db, release, "promote", ["deploy", release.version, str(target), release.previous_version or "-"], target, release.version,
               getattr(admin, "email", None), "manual")
    return target


def rollback(db, release: PlatformRelease, admin, ip: str, trigger: str = "manual", reason: str = "") -> PlatformRelease:
    with _pipeline_lock(db):
        if release.operation:
            raise ReleaseError(f"Release {release.version} is still {OPERATION_TEXT[release.operation]}")
        target = rollback_target(db, release)
        if target is None:
            raise ReleaseError(f"Release {release.version} can't be rolled back: no verified previous release is available")
        _audit(db, admin, "release_rollback", release, f"Rollback of {release.version} to {target.version} started" + (f" – {reason}" if reason else ""), ip,
               {"target": target.version, "trigger": trigger})
        _start(db, release, "rollback", ["rollback", target.version, release.version], 0, target.version,
               getattr(admin, "email", None) if admin else "auto-rollback", trigger)
    return target


def finish_step(step_id: int, ok: bool, message: str, exit_code: Optional[int]) -> None:
    """Record a step's outcome and move the release on. Safe to call more than once: only the first call applies."""
    _, log_file = _step_files(step_id)
    now = datetime.utcnow()
    db = MasterSessionLocal()
    try:
        claimed = db.execute(update(PlatformReleaseStep).where(PlatformReleaseStep.id == step_id, PlatformReleaseStep.status == "running").values(
            status="succeeded" if ok else "failed", finished_at=now, exit_code=exit_code, message=(message or None) and message[:500],
            output=_tail(log_file))).rowcount
        if not claimed:
            db.rollback()
            return
        step = db.get(PlatformReleaseStep, step_id)
        release = db.get(PlatformRelease, step.release_id)
        release.operation = None
        outcome = "succeeded" if ok else "failed"
        if step.action in ("deploy", "promote"):
            if ok:
                release.rollout_percent = step.to_percent
                release.status = "production" if step.to_percent >= 100 else "canary"
                if release.status == "production":
                    release.production_at, release.verified = now, False
                    for old in db.query(PlatformRelease).filter(PlatformRelease.status == "production", PlatformRelease.id != release.id).all():
                        old.status, old.rollout_percent, old.ended_at = "superseded", 0, now
            else:
                release.last_error = message or "Deployment step failed"
                if step.action == "deploy":
                    release.status, release.ended_at = "failed", now
            description = f"Release {release.version} {step.action} to {step.to_percent}% {outcome}" + (f": {message}" if message else "")
        else:
            target = db.query(PlatformRelease).filter(PlatformRelease.version == step.target_version).first()
            if ok:
                release.status, release.rollout_percent, release.ended_at, release.verified = "rolled_back", 0, now, False
                if target:
                    # Production again; verified again by reconcile() once the API reports this version.
                    target.status, target.rollout_percent, target.ended_at, target.verified = "production", 100, None, False
            else:
                release.last_error = message or "Rollback failed"
            description = f"Rollback of {release.version} to {step.target_version} {outcome}" + (f": {message}" if message else "")
        _audit(db, None, f"release_{step.action}_{outcome}", release, description, extra={"step": step.id, "trigger": step.trigger})
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Recording release step %s failed", step_id)
    finally:
        db.close()


def reconcile() -> dict:
    """Every minute: finish orphaned steps, verify production releases, auto-roll back an unhealthy canary."""
    ensure_schema()
    timeout = settings.PLATFORM_DEPLOY_TIMEOUT_SECONDS
    summary = {"steps_finished": 0, "verified": None, "auto_rollback": None}
    db = MasterSessionLocal()
    try:
        for step in db.query(PlatformReleaseStep).filter(PlatformReleaseStep.status == "running").all():
            result = _read_result(_step_files(step.id)[0])
            if result is not None:
                finish_step(step.id, result["ok"], result["message"], None)
                summary["steps_finished"] += 1
            elif (datetime.utcnow() - step.started_at).total_seconds() > timeout + 60:
                finish_step(step.id, False, f"No result from the deployment service within {timeout} s", None)
                summary["steps_finished"] += 1
        db.rollback()  # new transaction: REPEATABLE READ would hide what finish_step just committed
        if not in_flight(db):
            try:
                with _pipeline_lock(db):
                    _ensure_baseline(db)
                    db.commit()
            except ReleaseError:
                pass  # a release action holds the lock; next minute

        current = production(db)
        if current and not current.verified and not current.operation and current.version == RUNNING_VERSION:
            healthy, detail = api_health(db)
            if healthy:
                current.verified, current.verified_at = True, datetime.utcnow()
                _audit(db, None, "release_verified", current, f"Release {current.version} verified in production on {WORKER}: {detail}")
                db.commit()
                summary["verified"] = current.version

        canary = db.query(PlatformRelease).filter(PlatformRelease.status == "canary", PlatformRelease.operation.is_(None)).first()
        if canary and controls.value(db, "relAuto"):
            limit = float(controls.value(db, "alertErr") or 1)
            stats = monitor.window_stats("api", AUTO_ROLLBACK_WINDOW_MINUTES)
            if stats["requests"] >= AUTO_ROLLBACK_MIN_REQUESTS and stats["error_rate"] > limit and rollback_target(db, canary):
                reason = f"error spike: {stats['error_rate']}% errors over {stats['requests']} requests in {AUTO_ROLLBACK_WINDOW_MINUTES} min (limit {limit:g}%)"
                try:
                    rollback(db, canary, None, "system", trigger="auto", reason=reason)
                    summary["auto_rollback"] = canary.version
                except ReleaseError as exc:
                    logger.warning("Auto-rollback of %s not started: %s", canary.version, exc)
    finally:
        db.close()
    return summary


# ─── Read model ──────────────────────────────────────────────────────────────

def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


def release_payload(db, release: PlatformRelease) -> dict:
    target = rollback_target(db, release)
    return {
        "id": release.id, "version": release.version, "status": release.status, "rollout_percent": release.rollout_percent,
        "previous_version": release.previous_version, "operation": release.operation, "notes": release.notes, "config": release.config,
        "verified": release.verified, "verified_at": _iso(release.verified_at), "last_error": release.last_error,
        "created_by": release.created_by, "created_at": _iso(release.created_at), "started_at": _iso(release.started_at),
        "production_at": _iso(release.production_at), "ended_at": _iso(release.ended_at),
        "next_percent": next_percent(release), "rollback_to": target.version if target else None,
    }


def step_payload(step: PlatformReleaseStep) -> dict:
    return {"id": step.id, "release_id": step.release_id, "action": step.action, "target_version": step.target_version, "from_percent": step.from_percent,
            "to_percent": step.to_percent, "status": step.status, "trigger": step.trigger, "actor": step.actor, "exit_code": step.exit_code,
            "message": step.message, "started_at": _iso(step.started_at), "finished_at": _iso(step.finished_at)}


def pipeline(db, limit: int = 20) -> dict:
    ensure_schema()
    releases = db.query(PlatformRelease).order_by(PlatformRelease.created_at.desc(), PlatformRelease.id.desc()).limit(limit).all()
    return {
        "releases": [release_payload(db, r) for r in releases],
        "running_version": RUNNING_VERSION,
        "service": service_status(),
        "canary": {"enabled": bool(controls.value(db, "relCanary")), "initial_percent": int(controls.value(db, "relCanaryPct") or 10),
                   "steps": list(CANARY_STEPS), "auto_rollback": bool(controls.value(db, "relAuto"))},
    }


def steps(db, release_id: int) -> list[dict]:
    rows = db.query(PlatformReleaseStep).filter(PlatformReleaseStep.release_id == release_id).order_by(PlatformReleaseStep.id.desc()).all()
    return [{**step_payload(s), "output": s.output} for s in rows]
