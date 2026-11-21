"""Field-level validation for Settings / Users & Teams / Roles schemas (pure – no database)."""
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.admin360_router import NoteIn, SharingRuleIn, TeamIn, TerritoryIn
from app.routers.approval_workflow_router import ApprovalEscalationSettingsInput, ApprovalRuleUpsertInput, StepEscalationInput
from app.routers.roles_router import RoleCreate, RoleUpdate
from app.routers.theme_router import _validate_company_address_row, _validate_settings_payload
from app.services import app_settings_service as S


def _msgs(exc: ValidationError) -> dict:
    return {".".join(str(x) for x in e["loc"]): e["msg"] for e in exc.errors()}


def _detail(exc: HTTPException) -> dict:
    return {".".join(d["loc"][1:]): d["msg"] for d in exc.detail}


# ── teams / territories / sharing rules / notes ──────────────────────────────
def test_team_name_rules():
    assert TeamIn(name="  Sales North ").name == "Sales North"
    for bad, msg in (("   ", "blank"), ("A", "at least 2"), ("x" * 101, "cannot exceed 100")):
        with pytest.raises(ValidationError) as ei:
            TeamIn(name=bad)
        assert msg in _msgs(ei.value)["name"]


def test_territory_and_rule_limits():
    with pytest.raises(ValidationError) as ei:
        TerritoryIn(name="West", rule="r" * 201)
    assert "200" in _msgs(ei.value)["rule"]
    with pytest.raises(ValidationError) as ei:
        SharingRuleIn(object="Accounts", rule="  ")
    assert "rule" in _msgs(ei.value)
    with pytest.raises(ValidationError):
        NoteIn(text="   ")


# ── roles ────────────────────────────────────────────────────────────────────
def test_role_create_rules():
    r = RoleCreate(name="bid_cell", display_name=" Bid Cell ", description="  ")
    assert r.display_name == "Bid Cell" and r.description is None
    with pytest.raises(ValidationError) as ei:
        RoleCreate(name="x", display_name=" ", level=5000)
    m = _msgs(ei.value)
    assert "display_name" in m and "level" in m and "name" in m
    assert RoleUpdate().display_name is None
    with pytest.raises(ValidationError):
        RoleUpdate(display_name="   ")


# ── approval workflow ────────────────────────────────────────────────────────
def test_approval_rule_name_and_escalation():
    base = {"requester_type": "specific_user"}
    assert ApprovalRuleUpsertInput(**base, name="").name == ""
    with pytest.raises(ValidationError) as ei:
        ApprovalRuleUpsertInput(**base, name="   ")
    assert "blank" in _msgs(ei.value)["name"]
    assert StepEscalationInput(escalation_minutes=None).escalation_minutes is None
    for bad in (-5, 600000):
        with pytest.raises(ValidationError):
            StepEscalationInput(escalation_minutes=bad)
    with pytest.raises(ValidationError):
        ApprovalEscalationSettingsInput(is_enabled=True, default_escalation_minutes=600000)


# ── Settings (theme_router) ──────────────────────────────────────────────────
def test_settings_payload():
    _validate_settings_payload({"company_name": "Acme Ltd", "smtp_user": "", "smtp_port": "587", "theme_primary": "#0B1F3A"})
    with pytest.raises(HTTPException) as ei:
        _validate_settings_payload({"smtp_user": "bad@", "smtp_port": "70000", "smtp_host": "not a host",
                                    "theme_accent": "blue", "travel_request_advance_days": "45", "company_name": "  "})
    d = _detail(ei.value)
    assert set(d) == {"smtp_user", "smtp_port", "smtp_host", "theme_accent", "travel_request_advance_days", "company_name"}


def test_company_address_row():
    ok = {"label": "Head office", "street_address": "12 MG Road", "pincode": "560001", "area_locality": "Ashok Nagar",
          "city_district": "Bengaluru", "state": "Karnataka", "country": "India"}
    _validate_company_address_row(0, ok)
    with pytest.raises(HTTPException) as ei:
        _validate_company_address_row(1, {**ok, "pincode": "012345", "state": ""})
    d = _detail(ei.value)
    assert d["addresses.1.pincode"] == "Pincode cannot start with 0." and "addresses.1.state" in d


# ── App settings (per-field rules) ───────────────────────────────────────────
@pytest.mark.parametrize("cat,key,val,ok", [
    ("company", "gstin", "27aapfu0939f1zv", "27AAPFU0939F1ZV"), ("company", "pin", "560001", "560001"),
    ("company", "phone", "9876543210", "9876543210"), ("tax", "tds", 2, 2), ("security", "pmin", 10, 10), ("company", "gstin", "", ""),
])
def test_app_settings_valid(cat, key, val, ok):
    assert S.normalize(cat, key, val) == ok


@pytest.mark.parametrize("cat,key,val,msg", [
    ("company", "phone", "5876543210", "start with 6"), ("company", "pin", "12345", "6 digits"), ("company", "mail", "x@y", "valid email"),
    ("tax", "tds", 120, "between 0 and 100"), ("security", "pmin", 2, "between 6 and 64"), ("company", "emp", -1, "negative"),
    ("security", "conc", 2.5, "whole number"), ("tax", "hsn", "85", "4 to 8 digits"),
])
def test_app_settings_invalid(cat, key, val, msg):
    with pytest.raises(HTTPException) as ei:
        S.normalize(cat, key, val)
    assert msg in ei.value.detail[0]["msg"]
