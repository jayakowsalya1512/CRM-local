import os
from datetime import date, datetime, timedelta
from types import SimpleNamespace as NS

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DEBUG", "false")

from app.database import get_master_db_dep
from app.dependencies import get_current_user
from app.models.platform_sla import PlatformTicketSla
from app.models.platform_support import PlatformSupportTicket
from app.models.tenant import Plan, PlatformAuditLog, SuperAdmin, Tenant
from app.routers import platform_sla_router, platform_support_router, support_router
from app.services import platform_sla as sla
from app.services import platform_support as support
from app.services.platform_access import enforce_platform_access

CAL = {"days": [1, 2, 3, 4, 5, 6], "day_start": "09:30", "day_end": "18:00", "holidays": [{"date": "2026-11-09", "name": "Test holiday"}]}
IST = timedelta(hours=5, minutes=30)


def ist(*a):
    """Naive UTC for a wall-clock time in India."""
    return datetime(*a) - IST


# ─── Deadlines ───────────────────────────────────────────────────────────────

def test_24x7_counts_wall_clock():
    assert sla.add_hours(ist(2026, 11, 7, 23, 0), 2, None, True) == ist(2026, 11, 8, 1, 0)


def test_business_hours_within_a_day():
    assert sla.add_hours(ist(2026, 11, 4, 10, 0), 2, CAL, False) == ist(2026, 11, 4, 12, 0)


def test_business_hours_carry_overnight_and_start_at_day_start():
    # Wed 17:00 + 2 h = 1 h on Wed, then 1 h from 09:30 Thu
    assert sla.add_hours(ist(2026, 11, 4, 17, 0), 2, CAL, False) == ist(2026, 11, 5, 10, 30)
    # opened before opening time: the clock starts at 09:30
    assert sla.add_hours(ist(2026, 11, 4, 6, 0), 1, CAL, False) == ist(2026, 11, 4, 10, 30)


def test_business_hours_skip_sunday_and_holidays():
    # Sat 17:30 + 1 h: 30 min Sat, Sunday off, Monday 9 Nov is a holiday → Tue 10:00
    assert sla.add_hours(ist(2026, 11, 7, 17, 30), 1, CAL, False) == ist(2026, 11, 10, 10, 0)


def test_business_hours_multi_day_target():
    # 24 working hours from Wed 09:30 at 8.5 h/day: Wed, Thu, Fri = 25.5 h → Fri 16:30
    assert sla.add_hours(ist(2026, 11, 4, 9, 30), 24, CAL, False) == ist(2026, 11, 6, 16, 30)


def test_coverage_rules():
    assert sla.around_clock("24x7", "P3") and sla.around_clock("24x7_p1", "P1")
    assert not sla.around_clock("24x7_p1", "P2") and not sla.around_clock("business", "P1")


def test_channels_label_matches_prototype():
    assert sla.channels_label(["email"]) == "Email"
    assert sla.channels_label(["chat", "email"]) == "Email, chat"
    assert sla.channels_label(["email", "chat", "phone"]) == "Email, chat, phone"
    assert sla.channels_label(["email", "chat", "phone", "manager"]) == "All + dedicated manager"


# ─── Database fixtures ───────────────────────────────────────────────────────

@pytest.fixture
def env(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    event.listen(engine, "connect", lambda c, _r: c.execute("PRAGMA foreign_keys=ON"))
    for model in (Plan, Tenant, SuperAdmin, PlatformAuditLog, PlatformSupportTicket):
        model.__table__.create(bind=engine)
    monkeypatch.setattr(sla, "master_engine", engine)
    monkeypatch.setitem(sla._ready, "schema", False)
    monkeypatch.setitem(support._ready, "schema", True)
    sla.ensure_schema()
    Session = sessionmaker(bind=engine)
    db = Session()
    for i, (name, slug, price) in enumerate([("Core", "core", 100), ("Standard", "standard", 200), ("Premium", "premium", 300),
                                            ("Enterprise", "enterprise", 400), ("Test", "test", 0)], start=1):
        db.add(Plan(id=i, name=name, slug=slug, price_monthly=price, price_yearly=0, max_users=5, is_active=True))
    for tid, plan in ((1, 1), (2, 3), (3, 4)):
        db.add(Tenant(id=tid, name=f"Tenant {tid}", slug=f"t{tid}", subdomain=f"t{tid}", plan_id=plan, status="active", admin_email=f"a{tid}@x.in",
                      admin_name="Admin", db_name=f"digitcrm_t{tid}"))
    db.commit()
    yield NS(db=db, Session=Session, engine=engine)
    db.close()


def raise_at(db, tenant_id, priority, at, user_id=7):
    t = db.get(Tenant, tenant_id)
    ticket = PlatformSupportTicket(ref=f"TMP{at.timestamp()}{priority}", tenant_id=tenant_id, user_id=user_id, requester_name="Riya", requester_email="riya@x.in",
                                   subject="Help", priority=priority, status="open", created_at=at)
    db.add(ticket)
    db.flush()
    ticket.ref = f"SUP-{ticket.id:04d}"
    sla.start(db, ticket, t)
    db.commit()
    return ticket


def test_indexes_exist(env):
    ix = {i["name"]: i["column_names"] for i in inspect(env.engine).get_indexes("platform_ticket_slas")}
    assert ix["ix_platform_ticket_slas_created"] == ["created_at", "priority_code"]
    assert ix["ix_platform_ticket_slas_tenant"] == ["tenant_id", "created_at"]
    assert ix["ix_platform_ticket_slas_first_due"] == ["first_response_at", "first_response_due"]
    assert ix["ix_platform_ticket_slas_resolution_due"] == ["resolved_at", "resolution_due"]
    assert {i["name"] for i in inspect(env.engine).get_indexes("platform_ticket_csat")} >= {"ix_platform_ticket_csat_month"}
    assert {i["name"] for i in inspect(env.engine).get_indexes("platform_ticket_replies")} >= {"ix_platform_ticket_replies_ticket"}


# ─── Policies ────────────────────────────────────────────────────────────────

def test_policies_seeded_from_prototype_tiers(env):
    p = {x["plan"]: x for x in sla.policies(env.db)}
    assert (p["Core"]["first_response_h"], p["Core"]["resolution_h"], p["Core"]["coverage_label"], p["Core"]["channels_label"]) == (24, 120, "Business hours", "Email")
    assert (p["Standard"]["first_response_h"], p["Standard"]["channels_label"]) == (8, "Email, chat")
    assert (p["Premium"]["first_response_h"], p["Premium"]["resolution_h"], p["Premium"]["coverage_label"]) == (2, 24, "24×7 for P1")
    assert (p["Enterprise"]["first_response_h"], p["Enterprise"]["coverage_label"], p["Enterprise"]["channels_label"]) == (1, "24×7", "All + dedicated manager")
    assert p["Test"]["first_response_h"] == 24 and all(x["version"] == 1 for x in p.values())


def test_policy_update_versions_and_validation(env):
    sla.policies(env.db)
    before, after, v = sla.update_policy(env.db, 1, {"first_response_h": 12}, "ops@x.in")
    assert v == 2 and before["first_response_h"] == 24 and after["first_response_h"] == 12
    assert sla.update_policy(env.db, 1, {"first_response_h": 12}, "ops@x.in")[2] is None      # unchanged → no new version
    for bad in ({"first_response_h": 0}, {"first_response_h": -1}, {"resolution_h": 5000}, {"first_response_h": 200}, {"first_response_h": 130},
                {"coverage": "always"}, {"channels": []}, {"channels": ["fax"]}, {"first_response_h": "abc"}):
        with pytest.raises(sla.SlaError):
            sla.update_policy(env.db, 1, bad, "ops@x.in")
    with pytest.raises(sla.SlaError) as e:
        sla.update_policy(env.db, 99, {"first_response_h": 1}, "x")
    assert e.value.status_code == 404


def test_existing_tickets_keep_their_policy_version(env):
    sla.policies(env.db)
    sla.update_policy(env.db, 3, {"coverage": "24x7"}, "x")                  # Premium: 2 h / 24 h, 24×7
    env.db.commit()
    t = raise_at(env.db, 2, "Medium", ist(2026, 11, 4, 10, 0))
    due = env.db.get(PlatformTicketSla, t.id).first_response_due
    assert due == ist(2026, 11, 4, 12, 0)
    sla.update_policy(env.db, 3, {"first_response_h": 1}, "x")
    env.db.commit()
    s = env.db.get(PlatformTicketSla, t.id)
    assert s.first_response_due == due and sla.ticket_sla(env.db, t.id)["policy"]["first_response_h"] == 2


def test_p1_gets_24x7_on_enterprise_tier_others_business_hours(env):
    p1 = raise_at(env.db, 2, "Critical", ist(2026, 11, 7, 20, 0))           # Premium = "24×7 for P1", Saturday evening
    p2 = raise_at(env.db, 2, "High", ist(2026, 11, 7, 20, 0))
    s1, s2 = env.db.get(PlatformTicketSla, p1.id), env.db.get(PlatformTicketSla, p2.id)
    assert (s1.priority_code, s1.coverage, s1.first_response_due) == ("P1", "24x7", ist(2026, 11, 7, 22, 0))
    assert (s2.priority_code, s2.coverage) == ("P2", "business")
    assert s2.first_response_due == ist(2026, 11, 9, 11, 30)               # Sunday off → Mon 09:30 + 2 h (seeded calendar)


# ─── Lifecycle, KPIs, breaches ───────────────────────────────────────────────

def test_lifecycle_breaches_kpis_and_dedup(env):
    db, now = env.db, ist(2026, 11, 20, 12, 0)
    # Enterprise plan (1 h / 12 h, 24×7)
    ok = raise_at(db, 3, "High", now - timedelta(hours=10))
    sla.first_response(db, ok, ok.created_at + timedelta(minutes=30))
    sla.first_response(db, ok, ok.created_at + timedelta(hours=5))         # only the first reply counts
    ok.status, ok.closed_at = "closed", ok.created_at + timedelta(hours=6)
    sla.resolved(db, ok, ok.closed_at)
    both = raise_at(db, 3, "Critical", now - timedelta(hours=20))           # answered late, resolved late → one breach
    sla.first_response(db, both, both.created_at + timedelta(hours=2))
    both.status, both.closed_at = "closed", both.created_at + timedelta(hours=15)
    sla.resolved(db, both, both.closed_at)
    silent = raise_at(db, 3, "Low", now - timedelta(hours=3))               # unanswered past 1 h → breached while open
    running = raise_at(db, 3, "Medium", now - timedelta(minutes=10))        # within deadlines → outcome unknown
    old = raise_at(db, 3, "High", now - timedelta(days=40))                 # outside the 30-day window
    db.commit()

    k = sla.kpis(db, None, now)
    assert k["tickets"] == 4 and k["known"] == 3 and k["met"] == 1
    assert k["sla_met"] == round(100 / 3, 1)
    assert k["breaches"] == 2 and k["first_breaches"] == 2 and k["resolution_breaches"] == 1
    assert k["avg_first_response_h"] == round((0.5 + 2) / 2, 1) and k["first_responses"] == 2
    assert k["avg_resolution_h"] == round((6 + 15) / 2, 1)
    assert k["sla_spark"][-1] == round(100 / 3, 1)

    b = {x["code"]: x for x in sla.breaches_by_priority(db, None, now)}
    assert [x["label"] for x in sla.breaches_by_priority(db, None, now)] == ["P1 – Critical", "P2 – High", "P3 – Normal"]
    assert (b["P1"]["breaches"], b["P1"]["first_response"], b["P1"]["resolution"]) == (1, 1, 1)   # counted once
    assert b["P2"]["breaches"] == 0 and b["P3"]["breaches"] == 1

    assert sla.ticket_sla(db, running.id, now)["first_response"]["state"] == "running"
    assert sla.ticket_sla(db, silent.id, now)["first_response"]["state"] == "breached"
    assert sla.ticket_sla(db, ok.id, now)["resolution"]["state"] == "met"
    assert old.id and sla.kpis(db, {1}, now)["tickets"] == 0                # scope isolation


def test_reopen_clears_resolution_but_keeps_deadline(env):
    t = raise_at(env.db, 3, "High", datetime.utcnow() - timedelta(hours=1))
    s = env.db.get(PlatformTicketSla, t.id)
    due = s.resolution_due
    t.status, t.closed_at = "closed", datetime.utcnow()
    assert sla.resolved(env.db, t, t.closed_at)
    sla.reopened(env.db, t)
    assert s.resolved_at is None and s.resolution_breached is None and s.csat_token_hash is None and s.resolution_due == due


# ─── CSAT ────────────────────────────────────────────────────────────────────

def test_csat_submission_rules_and_trend(env):
    db = env.db
    open_t = raise_at(db, 1, "Medium", datetime(2026, 9, 1))
    with pytest.raises(sla.SlaError):
        sla.submit_csat(db, open_t, 5, "", "u", "app")                        # not resolved yet
    tickets = []
    for i, (when, rating) in enumerate([(datetime(2026, 6, 10), 4), (datetime(2026, 6, 20), 5), (datetime(2026, 8, 5), 3), (datetime(2026, 11, 2), 5)]):
        t = raise_at(db, 1 if i < 3 else 2, "Medium", when - timedelta(days=1))
        t.status, t.closed_at = "closed", when
        sla.submit_csat(db, t, rating, " great ", "riya@x.in", "app", now=when)
        tickets.append(t)
    for bad in (0, 6, "4.5", None):
        t = raise_at(db, 1, "Low", datetime(2026, 10, 1))
        t.status = "closed"
        with pytest.raises(sla.SlaError):
            sla.submit_csat(db, t, bad, "", "u", "app")
    with pytest.raises(sla.SlaError) as e:
        sla.submit_csat(db, tickets[0], 5, "", "u", "app")                    # one rating per ticket
    assert e.value.status_code == 409
    db.commit()
    tr = sla.csat_trend(db, None, now=datetime(2026, 11, 4))
    assert tr["labels"] == ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]
    assert tr["values"] == [4.5, None, 3.0, None, None, 5.0] and tr["responses"] == [2, 0, 1, 0, 0, 1]
    assert sla.csat_trend(db, {1}, now=datetime(2026, 11, 4))["values"][-1] is None   # tenant 2's rating not in tenant 1's scope
    k = sla.kpis(db, None, datetime(2026, 11, 4))
    assert k["csat"] == 5.0 and k["csat_responses"] == 1


def test_canned_responses_seeded(env):
    assert [c["title"] for c in sla.canned(env.db)] == ["Acknowledge ticket", "Request logs", "Maintenance notice", "Resolved"]
    assert sla.canned(env.db)[0]["body"] == "Thanks for reaching out – we are on it."


# ─── API (platform console, tenant app, rating link) ─────────────────────────

@pytest.fixture
def client(env, monkeypatch):
    app = FastAPI()
    for r in (platform_sla_router.router, platform_sla_router.public_router, platform_support_router.router):
        app.include_router(r)
    app.include_router(support_router.router, prefix="/api/v1/support")
    scope = {"ids": None}

    def access(request=None):
        return None
    app.dependency_overrides[enforce_platform_access] = access

    def db_dep():
        s = env.Session()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_master_db_dep] = db_dep
    user = NS(id=7, email="riya@x.in", username="riya", full_name="Riya", role="sales")
    app.dependency_overrides[get_current_user] = lambda: user
    admin = NS(id=None, email="ops@platform.in", full_name="Ops", username="ops")
    for mod in (platform_sla_router, platform_support_router):
        monkeypatch.setattr(mod, "_get_platform_admin", lambda request: admin)
    monkeypatch.setattr(platform_sla_router, "scoped_tenant_ids", lambda request: scope["ids"])
    monkeypatch.setattr(platform_support_router, "scoped_tenant_ids", lambda request: scope["ids"])
    monkeypatch.setattr(support_router, "_resolve_tenant_slug", lambda request: "t3")
    sent = []
    monkeypatch.setattr(support, "_notify", lambda db, t, subject, body: sent.append((t.requester_email, subject, body)) or "sent")
    from app.core.config import settings
    monkeypatch.setattr(settings, "FRONTEND_BASE_URL", "https://crm.example.in")
    return NS(c=TestClient(app), scope=scope, sent=sent, user=user)


def audits(env, action):
    s = env.Session()
    try:
        return s.query(PlatformAuditLog).filter(PlatformAuditLog.action == action).all()
    finally:
        s.close()


def test_api_overview_and_policy_update(env, client):
    r = client.c.get("/api/v1/platform/sla")
    assert r.status_code == 200
    j = r.json()
    assert list(j["kpis"]) and len(j["policies"]) == 5 and len(j["breaches"]) == 3 and len(j["canned"]) == 4 and len(j["csat"]["values"]) == 6
    core = next(p for p in j["policies"] if p["plan"] == "Core")
    r = client.c.put(f"/api/v1/platform/sla/policies/{core['plan_id']}", json={"first_response_h": 20, "resolution_h": 100})
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["policy"]["first_response_h"] == 20
    assert client.c.put(f"/api/v1/platform/sla/policies/{core['plan_id']}", json={"first_response_h": 0}).status_code == 422
    a = audits(env, "sla_policy_updated")
    assert len(a) == 1 and a[0].old_data["first_response_h"] == 24 and a[0].new_data["version"] == 2
    client.scope["ids"] = {1}
    assert client.c.put(f"/api/v1/platform/sla/policies/{core['plan_id']}", json={"first_response_h": 10}).status_code == 403
    for path in ("kpis", "policies", "csat", "breaches", "canned-responses", "calendar"):
        assert client.c.get(f"/api/v1/platform/sla/{path}").status_code == 200, path


def test_api_calendar_update(env, client):
    r = client.c.put("/api/v1/platform/sla/calendar", json={"days": [1, 2, 3, 4, 5], "day_start": "10:00", "day_end": "19:00",
                                                           "holidays": [{"date": "2026-12-31", "name": "Year end"}]})
    assert r.status_code == 200 and r.json()["days"] == [1, 2, 3, 4, 5]
    assert client.c.put("/api/v1/platform/sla/calendar", json={"days": [1], "day_start": "18:00", "day_end": "09:00"}).status_code == 422
    assert len(audits(env, "sla_calendar_updated")) == 1


def test_support_desk_flow_with_csat_link(env, client):
    db = env.Session()
    t = raise_at(db, 3, "High", datetime.utcnow() - timedelta(minutes=20))
    tid = t.id
    db.close()
    # staff reply = first response; e-mailed to the requester
    r = client.c.post(f"/api/v1/platform/support/tickets/{tid}/replies", json={"body": "Thanks for reaching out – we are on it."})
    assert r.status_code == 201 and r.json()["email"] == "sent"
    assert r.json()["ticket"]["sla"]["first_response"]["state"] == "met"
    assert client.c.post(f"/api/v1/platform/support/tickets/{tid}/replies", json={"body": "  "}).status_code == 422
    # resolve → rating link e-mailed
    r = client.c.post(f"/api/v1/platform/support/tickets/{tid}/resolve")
    assert r.status_code == 200 and r.json()["rating_link"] is True and r.json()["ticket"]["status"] == "closed"
    assert client.c.post(f"/api/v1/platform/support/tickets/{tid}/resolve").status_code == 409
    link = next(b for _, s, b in client.sent if "Resolved" in s).split("https://crm.example.in/csat/")[1].split()[0]
    assert client.c.get(f"/api/v1/support-csat/{link}").json()["ref"] == f"SUP-{tid:04d}"
    assert client.c.post(f"/api/v1/support-csat/{link}", json={"rating": 9}).status_code == 422
    r = client.c.post(f"/api/v1/support-csat/{link}", json={"rating": 4, "feedback": "Quick fix"})
    assert r.status_code == 201 and r.json()["rating"] == 4 and r.json()["channel"] == "email"
    assert client.c.get(f"/api/v1/support-csat/{link}").status_code == 404        # works once
    assert client.c.post(f"/api/v1/support/tickets/{tid}/satisfaction", json={"rating": 5}).status_code == 409
    assert {a.action for a in audits(env, "support_csat_submitted")} == {"support_csat_submitted"}
    assert len(audits(env, "support_ticket_reply")) == 1 and len(audits(env, "support_ticket_resolved")) == 1
    # tenant reply reopens the resolved ticket
    r = client.c.post(f"/api/v1/support/tickets/{tid}/replies", json={"body": "Still broken"})
    assert r.status_code == 201 and r.json()["reopened"] is True
    detail = client.c.get(f"/api/v1/platform/support/tickets/{tid}").json()
    assert detail["status"] == "open" and [x["kind"] for x in detail["replies"]] == ["staff", "tenant"] and detail["csat"]["rating"] == 4
    # scoped staff can't see another tenant's ticket; open list carries SLA state
    client.scope["ids"] = {1}
    assert client.c.get(f"/api/v1/platform/support/tickets/{tid}").status_code == 404
    client.scope["ids"] = None
    items = client.c.get("/api/v1/platform/support/tickets").json()["items"]
    assert items[0]["sla"]["code"] == "P2"


def test_tenant_rating_needs_requester_or_admin(env, client):
    db = env.Session()
    t = raise_at(db, 3, "Low", datetime.utcnow() - timedelta(hours=1), user_id=99)   # raised by another user
    t.status, t.closed_at = "closed", datetime.utcnow()
    db.commit()
    tid = t.id
    db.close()
    assert client.c.post(f"/api/v1/support/tickets/{tid}/satisfaction", json={"rating": 5}).status_code == 404
    client.user.role = "admin"
    r = client.c.post(f"/api/v1/support/tickets/{tid}/satisfaction", json={"rating": 5, "feedback": "ok"})
    assert r.status_code == 201 and r.json()["channel"] == "app"
