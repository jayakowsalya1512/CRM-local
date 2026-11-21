"""Shared field validation for request bodies – the server-side twin of frontend/src/utils/validation.ts.

Every create / update schema uses these so that the UI rules cannot be bypassed with a direct API call. Each
validator raises ``ValueError`` with a user-facing message; ``main.py`` turns those into a 422 response carrying
``field_errors: {field: message}`` so the form can show the message under the right field.

Use either the ``Annotated`` types (``Mobile``, ``Email``, ``GSTIN`` …) on a model field, or call the ``check_*``
functions from a ``field_validator``.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Any, Iterable, Optional

from fastapi import HTTPException
from pydantic import AfterValidator, BeforeValidator

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._%+'-]{0,62}[A-Za-z0-9_%+'-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$"
)
PAN_RE = re.compile(r"^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$")
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
URL_RE = re.compile(
    r"^(https?://)?(www\.)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(:\d{2,5})?(/\S*)?$", re.I
)
_GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _s(v: Any) -> str:
    return "" if v is None else str(v).strip()


def gstin_check_char(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        p = _GST_CHARS.index(ch) * (2 if i % 2 else 1)
        total += p // 36 + p % 36
    return _GST_CHARS[(36 - total % 36) % 36]


# ── checks (None / blank → None, otherwise normalised value or ValueError) ────
def check_mobile(v: Any, label: str = "Phone number") -> Optional[str]:
    """Indian mobile: exactly 10 digits starting 6–9. Spaces / hyphens and a +91 or leading 0 prefix are tolerated
    on input (imports, integrations) and stripped before storing."""
    s = _s(v)
    if not s:
        return None
    d = re.sub(r"[\s\-()]", "", s)
    if d.startswith("+91"):
        d = d[3:]
    elif len(d) == 12 and d.startswith("91"):
        d = d[2:]
    elif len(d) == 11 and d.startswith("0"):
        d = d[1:]
    if not d.isdigit():
        raise ValueError("Only numbers are allowed.")
    if len(d) > 10:
        raise ValueError("Maximum 10 digits allowed.")
    if len(d) < 10:
        raise ValueError(f"{label} must contain exactly 10 digits.")
    if d[0] not in "6789":
        raise ValueError(f"{label} must start with 6, 7, 8 or 9.")
    return d


def check_phone(v: Any, label: str = "Phone number") -> Optional[str]:
    """Office / landline: 10 digits (STD code + number)."""
    s = _s(v)
    if not s:
        return None
    d = re.sub(r"[\s\-()]", "", s)
    if d.startswith("+91"):
        d = d[3:]
    elif len(d) == 11 and d.startswith("0"):
        d = d[1:]
    if not d.isdigit():
        raise ValueError("Only numbers are allowed.")
    if len(d) > 10:
        raise ValueError("Maximum 10 digits allowed.")
    if len(d) < 10:
        raise ValueError(f"{label} must contain exactly 10 digits.")
    return d


def check_email(v: Any) -> Optional[str]:
    s = _s(v)
    if not s:
        return None
    if len(s) > 254 or not EMAIL_RE.match(s) or ".." in s:
        raise ValueError("Enter a valid email address (e.g. user@example.com).")
    return s


def check_pan(v: Any) -> Optional[str]:
    s = _s(v).upper()
    if not s:
        return None
    if len(s) != 10:
        raise ValueError("PAN must be exactly 10 characters.")
    if not PAN_RE.match(s):
        raise ValueError("Enter a valid PAN (e.g. ABCPE1234F).")
    return s


def check_gstin(v: Any) -> Optional[str]:
    s = _s(v).upper()
    if not s:
        return None
    if len(s) != 15:
        raise ValueError("GSTIN must be exactly 15 characters.")
    if not GSTIN_RE.match(s):
        raise ValueError("Enter a valid GSTIN (e.g. 27AAPFU0939F1ZV).")
    code = int(s[:2])
    if not (1 <= code <= 38 or code in (97, 99)):
        raise ValueError("GSTIN state code (first 2 digits) is not valid.")
    if not PAN_RE.match(s[2:12]):
        raise ValueError("GSTIN characters 3–12 must be a valid PAN.")
    if gstin_check_char(s[:14]) != s[14]:
        raise ValueError("GSTIN checksum is invalid – please re-check the number.")
    return s


def check_pincode(v: Any) -> Optional[str]:
    s = _s(v)
    if not s:
        return None
    if not s.isdigit():
        raise ValueError("Only numbers are allowed.")
    if len(s) != 6:
        raise ValueError("Pincode must be exactly 6 digits.")
    if s[0] == "0":
        raise ValueError("Pincode cannot start with 0.")
    return s


def check_url(v: Any) -> Optional[str]:
    s = _s(v)
    if not s:
        return None
    if len(s) > 255 or not URL_RE.match(s):
        raise ValueError("Enter a valid website URL (e.g. https://www.example.com).")
    return s


def check_text(v: Any, label: str = "This field", min_len: int = 0, max_len: Optional[int] = None,
               required: bool = False) -> Optional[str]:
    s = "" if v is None else str(v).strip()
    if not s:   # empty and whitespace-only are never a value
        if required:
            raise ValueError(f"{label} is required." if v is None or str(v) == "" else f"{label} cannot be blank or only spaces.")
        return None
    if min_len and len(s) < min_len:
        raise ValueError(f"{label} must be at least {min_len} characters.")
    if max_len and len(s) > max_len:
        raise ValueError(f"{label} cannot exceed {max_len} characters.")
    return s


def check_name(v: Any, label: str = "Name", min_len: int = 2, max_len: int = 200) -> str:
    out = check_text(v, label, min_len, max_len, required=True)
    return out  # type: ignore[return-value]


def check_amount(v: Any, label: str = "Amount", max_value: float = 1e13) -> Optional[float]:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = float(str(v).replace(",", "")) if not isinstance(v, (int, float)) else float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a valid number.")
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError(f"{label} must be a valid number.")
    if n < 0:
        raise ValueError(f"{label} cannot be negative.")
    if n > max_value:
        raise ValueError(f"{label} is too large.")
    return n


def check_percent(v: Any, label: str = "Percentage") -> Optional[float]:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a valid number.")
    if not (0 <= n <= 100):
        raise ValueError(f"{label} must be between 0 and 100.")
    return n


def check_date_range(d: Optional[date], label: str = "Date") -> Optional[date]:
    if d is None:
        return None
    if not (1900 <= d.year <= 2100):
        raise ValueError(f"{label} must be between 1900 and 2100.")
    return d


# ── Annotated types for models ───────────────────────────────────────────────
def _lbl(fn, label):
    return lambda v: fn(v, label)


Mobile = Annotated[Optional[str], BeforeValidator(check_mobile)]
Phone = Annotated[Optional[str], BeforeValidator(check_phone)]
Email = Annotated[Optional[str], BeforeValidator(check_email)]
GSTIN = Annotated[Optional[str], BeforeValidator(check_gstin)]
PAN = Annotated[Optional[str], BeforeValidator(check_pan)]
Pincode = Annotated[Optional[str], BeforeValidator(check_pincode)]
WebURL = Annotated[Optional[str], BeforeValidator(check_url)]
Amount = Annotated[Optional[float], BeforeValidator(check_amount)]
Percent = Annotated[Optional[float], BeforeValidator(check_percent)]
SaneDate = Annotated[Optional[date], AfterValidator(check_date_range)]


def NonBlank(label: str = "This field", min_len: int = 1, max_len: Optional[int] = None):
    """Required text that cannot be empty or whitespace-only; stored trimmed."""
    return Annotated[str, BeforeValidator(lambda v: check_text(v, label, min_len, max_len, required=True))]


def OptText(label: str = "This field", max_len: Optional[int] = None):
    """Optional text; whitespace-only becomes None; stored trimmed."""
    return Annotated[Optional[str], BeforeValidator(lambda v: check_text(v, label, 0, max_len))]


# ── structured errors raised from route / service code ────────────────────────
def field_error(field: str, message: str, status: int = 422) -> HTTPException:
    """An HTTPException the frontend maps onto one field (same shape as a Pydantic 422)."""
    return HTTPException(status, detail=[{"loc": ["body", field], "msg": message, "type": "value_error"}])


def raise_field_errors(errors: dict[str, str], status: int = 422) -> None:
    if errors:
        raise HTTPException(status, detail=[{"loc": ["body", *k.split(".")], "msg": m, "type": "value_error"} for k, m in errors.items()])


# ── tenant custom fields (Form Builder) ───────────────────────────────────────
_RULE_BY_KEY = (
    (re.compile(r"\bgst(in)?\b|gst_number", re.I), check_gstin),
    (re.compile(r"\bpan\b|pan_number", re.I), check_pan),
    (re.compile(r"pin ?code|\bpin\b|postal|zip", re.I), check_pincode),
)


def _rule_for(field_type: str, key: str, label: str):
    k = f"{key} {label}".replace("_", " ")
    ft = (field_type or "text").lower()
    if ft == "email" or re.search(r"\be-?mail\b", k, re.I):
        return check_email
    for rx, fn in _RULE_BY_KEY:
        if rx.search(k):
            return fn
    if ft == "url" or re.search(r"website|\burl\b", k, re.I):
        return check_url
    if ft in ("phone", "tel") or re.search(r"mobile|phone|whatsapp", k, re.I):
        return check_phone if re.search(r"office|landline|fax", k, re.I) else check_mobile
    if re.search(r"percent|%|\bpct\b", k, re.I):
        return check_percent
    if ft == "number":
        return check_amount
    return None


def validate_custom_data(data: Optional[dict[str, Any]], fields: Iterable[Any], prefix: str = "custom_data") -> Optional[dict[str, Any]]:
    """Validate tenant custom field values by their configured type (email / phone / url / number …) and their
    required flag. ``fields`` are FormFieldConfig-like objects (field_key, label, field_type, is_required, is_visible).
    Returns the normalised dict; raises a 422 with one entry per bad field."""
    if data is None:
        data = {}
    out = dict(data)
    errs: dict[str, str] = {}
    for f in fields:
        key = getattr(f, "field_key", None)
        if not key or getattr(f, "is_visible", True) is False:
            continue
        label = getattr(f, "label", None) or key
        val = out.get(key)
        empty = val is None or val is False or (isinstance(val, str) and not val.strip())
        if empty:
            if getattr(f, "is_required", False):
                errs[f"{prefix}.{key}"] = f"{label} is required."
            continue
        fn = _rule_for(getattr(f, "field_type", "text"), key, label)
        if fn is None:
            if isinstance(val, str):
                out[key] = val.strip()
            continue
        try:
            res = fn(val, label) if fn in (check_mobile, check_phone, check_amount, check_percent) else fn(val)
            out[key] = res
        except ValueError as e:
            errs[f"{prefix}.{key}"] = str(e)
    raise_field_errors(errs)
    return out or None


def validate_module_custom_data(db: Any, module: str, data: Optional[dict[str, Any]], prefix: str = "custom_data",
                                enforce_required: bool = True) -> Optional[dict[str, Any]]:
    """``validate_custom_data`` for the visible custom fields configured for ``module`` in the Form Builder."""
    from app.models.all_models import FormField  # local import: models import this package's config
    fields = db.query(FormField).filter(FormField.module == module, FormField.is_custom == True,  # noqa: E712
                                        FormField.is_visible == True).all()  # noqa: E712
    if not enforce_required:
        class _F:  # same field, required flag off (e.g. partial PATCH updates)
            def __init__(self, f): self.__dict__.update({k: getattr(f, k) for k in ("field_key", "label", "field_type")}); self.is_required = False; self.is_visible = True
        fields = [_F(f) for f in fields]
    if not data and not any(getattr(f, "is_required", False) for f in fields):
        return data
    return validate_custom_data(data, fields, prefix)


def detail_text(detail: Any, fallback: str = "Invalid value") -> str:
    """Plain text of an HTTPException detail – string, {message} dict or a field-error list."""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("msg") or fallback)
    if isinstance(detail, list) and detail:
        return "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)
    return fallback
