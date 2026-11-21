"""Field-level validation: shared validators, module schemas and the structured 422 response."""
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core import validators as V


# ── validators ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,ok", [
    ("9876543210", "9876543210"), ("+91 98765 43210", "9876543210"), ("09876543210", "9876543210"), ("", None), (None, None),
])
def test_mobile_valid(raw, ok):
    assert V.check_mobile(raw) == ok


@pytest.mark.parametrize("raw,msg", [
    ("987654321", "exactly 10 digits"), ("98765432101", "Maximum 10 digits"), ("98765abc10", "Only numbers"), ("5876543210", "start with 6"),
])
def test_mobile_invalid(raw, msg):
    with pytest.raises(ValueError, match=msg):
        V.check_mobile(raw)


def test_gstin_checksum():
    assert V.check_gstin("27aapfu0939f1zv") == "27AAPFU0939F1ZV"
    assert V.check_gstin("29AAGCB7383J1Z4") == "29AAGCB7383J1Z4"
    for bad in ("27AAPFU0939F1ZX", "22AAAAA0000A1Z5", "27AAPFU0939F1Z", "99AAPFU0939F1ZV0", "40AAPFU0939F1ZV"):
        with pytest.raises(ValueError):
            V.check_gstin(bad)


def test_pan_pincode_email_url():
    assert V.check_pan("abcpe1234f") == "ABCPE1234F"
    for bad in ("ABCDE1234F", "ABC1234", "ABCPE12345"):
        with pytest.raises(ValueError):
            V.check_pan(bad)
    assert V.check_pincode("560001") == "560001"
    for bad in ("56000", "5600011", "012345", "56a001"):
        with pytest.raises(ValueError):
            V.check_pincode(bad)
    assert V.check_email("user@example.com") == "user@example.com"
    for bad in ("user@ex", "a..b@x.com", "no-at.com", "a@b"):
        with pytest.raises(ValueError):
            V.check_email(bad)
    assert V.check_url("https://www.example.com/x") and V.check_url("example.in")
    with pytest.raises(ValueError):
        V.check_url("http//bad")


def test_text_amount_percent():
    with pytest.raises(ValueError, match="blank"):
        V.check_text("   ", "Customer name", required=True)
    assert V.check_text("   ", "Notes") is None
    with pytest.raises(ValueError, match="at least 2"):
        V.check_text("A", "Name", 2, 10, required=True)
    with pytest.raises(ValueError, match="exceed 5"):
        V.check_text("abcdef", "Code", 0, 5)
    assert V.check_amount("1,000.50") == 1000.5 and V.check_amount(0) == 0
    with pytest.raises(ValueError, match="negative"):
        V.check_amount(-1)
    with pytest.raises(ValueError, match="valid number"):
        V.check_amount("abc")
    assert V.check_percent(100) == 100
    for bad in (-0.1, 100.01, "x"):
        with pytest.raises(ValueError):
            V.check_percent(bad)


def test_custom_data_by_type():
    class F:
        def __init__(self, key, ftype, req=False, label=None):
            self.field_key, self.field_type, self.is_required, self.is_visible, self.label = key, ftype, req, True, label or key
    fields = [F("vendor_email", "email"), F("site_phone", "phone"), F("gstin", "text", label="GSTIN"), F("po_ref", "text", True)]
    with pytest.raises(HTTPException) as e:
        V.validate_custom_data({"vendor_email": "x@", "site_phone": "123", "gstin": "22AAAAA0000A1Z5"}, fields)
    keys = {d["loc"][-1] for d in e.value.detail}
    assert keys == {"vendor_email", "site_phone", "gstin", "po_ref"}
    out = V.validate_custom_data({"vendor_email": "a@b.co", "site_phone": "9876543210", "po_ref": " PO-1 "}, fields)
    assert out["po_ref"] == "PO-1"


# ── schemas + 422 shape ───────────────────────────────────────────────────────
def _client():
    import app.main as M
    from app.routers.bids_router import BidIn
    from app.routers.customer360_router import ContactIn
    from app.routers.customer_router import CustomerCreate
    from app.routers.orders_router import OrderIn
    a = FastAPI()
    a.add_exception_handler(RequestValidationError, M.request_validation_handler)
    @a.post("/bid")
    def bid(x: BidIn):
        return {"ok": 1}

    @a.post("/contact")
    def contact(x: ContactIn):
        return {"phone": x.phone}

    @a.post("/customer")
    def customer(x: CustomerCreate):
        return {"gst": x.gst_number}

    @a.post("/order")
    def order(x: OrderIn):
        return {"ok": 1}
    return TestClient(a)


def test_structured_422():
    c = _client()
    r = c.post("/bid", json={"title": "  ", "nit": "N1", "customer_id": 1, "submit": "2026-13-01", "value": 100, "emd": 10})
    assert r.status_code == 422
    fe = r.json()["field_errors"]
    assert "blank" in fe["title"] and "valid date" in fe["submit"]
    r = c.post("/bid", json={"title": "Supply", "nit": "N1", "customer_id": 1, "submit": "2026-12-01", "value": 100, "emd": 500})
    assert r.status_code == 422 and r.json()["detail"][0]["loc"] == ["body", "emd"]
    r = c.post("/contact", json={"name": "Ravi", "designation": "Mgr", "department": "Ops", "phone": "98765abc10", "email": "x@"})
    assert set(r.json()["field_errors"]) == {"phone", "email"}
    assert c.post("/contact", json={"name": "Ravi", "designation": "Mgr", "department": "Ops", "phone": "+91 98765 43210"}).json() == {"phone": "9876543210"}
    r = c.post("/customer", json={"customer_name": "Acme", "gst_number": "22AAAAA0000A1Z5", "billing_pincode": "5600", "website": "bad url"})
    assert set(r.json()["field_errors"]) == {"gst_number", "billing_pincode", "website"}
    r = c.post("/order", json={"title": "Order 1", "customer_id": 1, "start": "2026-05-02", "due": "2026-05-01"})
    assert r.json()["detail"][0]["loc"] == ["body", "due"]


def test_customer_whitespace_name():
    from app.routers.customer_router import CustomerCreate
    with pytest.raises(ValidationError):
        CustomerCreate(customer_name="   ")
