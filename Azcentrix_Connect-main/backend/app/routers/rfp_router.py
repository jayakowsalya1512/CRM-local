from __future__ import annotations

"""
Server-safe Sales RFP Analysis module.

This version avoids local LLM/Ollama calls inside the CRM backend because the
previous Ollama based versions can consume CPU/RAM and make the whole Windows
server unresponsive. It reads the complete PDF, performs deterministic tender
extraction, and creates the exact sales-friendly Excel format:

    Field | Values | Page Ref

Optional AI can be enabled later with RFP_ENABLE_AI=true, but it is OFF by
default for server safety.
"""

import json
import logging
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.dependencies import get_current_user, get_tenant_db
from app.models.all_models import ActivityLog, RFPAnalysis, Tender, User
from app.services.storage_usage_service import (
    ensure_tenant_storage_available,
    refresh_tenant_storage_usage_for_slug,
)

logger = logging.getLogger(__name__)
router = APIRouter()

RFP_EXTRACTION_VERSION = "FINAL_PRODUCTION_SENTENCE_RECONSTRUCTION_V6_2026_05_26"

RFP_UPLOAD_SUBDIR = "rfp"
RFP_EXCEL_SUBDIR = "rfp_exports"
KEYWORD_REGISTRY_FILE = "rfp_keyword_registry.json"

MAX_FILE_MB = int(getattr(settings, "RFP_MAX_FILE_MB", os.environ.get("RFP_MAX_FILE_MB", "80")))
# IMPORTANT: OFF by default. Turn on only when Ollama is on another machine or server has enough resources.
RFP_ENABLE_AI = str(os.environ.get("RFP_ENABLE_AI", getattr(settings, "RFP_ENABLE_AI", "false"))).lower() in {"1", "true", "yes"}
OLLAMA_URL = getattr(settings, "RFP_OLLAMA_URL", os.environ.get("RFP_OLLAMA_URL", "http://localhost:11434/api/generate"))
OLLAMA_MODEL = getattr(settings, "RFP_LLM_MODEL", os.environ.get("RFP_LLM_MODEL", "mistral"))
MAX_AI_CHARS = int(getattr(settings, "RFP_MAX_AI_CHARS", os.environ.get("RFP_MAX_AI_CHARS", "12000")))


@dataclass
class KeywordDefinition:
    key: str
    name: str
    aliases: List[str]
    category: str = "Commercial"
    prompt_hint: str = ""
    active: bool = True
    is_default: bool = False


DEFAULT_KEYWORDS: List[KeywordDefinition] = [
    KeywordDefinition("tender_title", "Tender Title", ["tender title", "name of work", "nit title", "bid title", "tender name", "work name"], "Basic", "Tender/work title.", True, True),
    KeywordDefinition("tender_ref_no", "Tender Ref No", ["tender ref", "tender reference", "tender no", "tender number", "bid no", "bid number", "rfp no", "rfp number", "nit no", "notice inviting tender"], "Basic", "Tender/RFP/NIT/Bid reference number.", True, True),
    KeywordDefinition("tender_due_date", "Tender Due Date", ["bid submission", "due date", "last date", "closing date", "bid end date", "submission deadline", "last date and time"], "Dates", "Final bid submission date/time and mode.", True, True),
    KeywordDefinition("pre_bid_date", "Pre-bid Date", ["pre-bid", "pre bid", "prebid", "pre-bid meeting", "pre bid meeting", "clarification", "queries"], "Dates", "Pre-bid query deadline and meeting date/time/venue/link.", True, True),
    KeywordDefinition("tender_fee", "Tender Fee", ["tender fee", "document fee", "bid document fee", "cost of tender", "cost of bid document", "processing fee"], "Commercial", "Tender fee amount and payment mode.", True, True),
    KeywordDefinition("emd", "EMD", ["emd", "earnest money deposit", "earnest money", "bid security"], "Commercial", "Amount, payment mode, last date, validity and exemption.", True, True),
    KeywordDefinition("pbg", "PBG / Performance Bank Guarantee", ["performance bank guarantee", "performance security", "security deposit", "pbg", "bank guarantee", "performance guarantee"], "Commercial", "Amount/percentage, mode, validity, submission timeline and claim period.", True, True),
    KeywordDefinition("scope_of_work", "Scope of Work", ["scope of work", "scope", "work description", "terms of reference", "tor"], "Scope", "Summarise actual work and deliverables.", True, True),
    KeywordDefinition("eligibility_criteria", "Eligibility Criteria", ["eligibility", "pre qualification", "pre-qualification", "qualification criteria", "bidder qualification", "turnover", "experience", "eligible"], "Eligibility", "Bidder eligibility checklist.", True, True),
    KeywordDefinition("technical_details", "Technical Details", ["technical specification", "technical specifications", "technical details", "specification", "boq", "bill of quantity", "bom", "technical requirement"], "Technical", "Technical requirements and quantities.", True, True),
    KeywordDefinition("delivery_period", "Delivery Period", ["delivery period", "delivery schedule", "completion period", "implementation period", "timeline", "contract period", "period of completion", "supply within"], "Delivery", "Exact delivery/completion period.", True, True),
    KeywordDefinition("payment_terms", "Payment Terms", ["payment terms", "payment schedule", "invoice", "milestone payment", "advance payment", "retention", "payment"], "Commercial", "Payment milestones, retention and invoice conditions.", True, True),
    KeywordDefinition("ld_clause", "LD Clause", ["liquidated damages", "ld", "penalty", "delay penalty", "late delivery", "damages"], "Risk", "LD rate, cap and trigger condition.", True, True),
]

DEFAULT_FIELD_ORDER = [
    "tender_title", "tender_ref_no", "tender_due_date", "pre_bid_date",
    "scope_of_work", "eligibility_criteria", "technical_details",
    "delivery_period", "payment_terms", "ld_clause", "emd",
    "tender_fee", "pbg",
]


class KeywordCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    aliases: List[str] = Field(default_factory=list)
    category: str = Field(default="Custom", max_length=80)
    prompt_hint: str = Field(default="", max_length=500)
    active: bool = True


class AnalyzeResponse(BaseModel):
    id: int
    status: str
    document_name: str
    document_pages: Optional[int] = None
    key_points: Optional[Dict[str, Any]] = None
    excel_url: Optional[str] = None
    error: Optional[str] = None


def _safe_slug(value: str, fallback: str = "rfp") -> str:
    value = Path(value or fallback).stem
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_")
    return value[:90] or fallback


def _upload_root() -> Path:
    root = Path(settings.UPLOAD_DIR)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _tenant_upload_root(db: Session) -> Path:
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    return _upload_root() / tenant_slug if tenant_slug else _upload_root()


def _tenant_upload_url(db: Session, subdir: str, filename: str) -> str:
    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    parts = ["uploads", tenant_slug, subdir, filename] if tenant_slug else ["uploads", subdir, filename]
    return "/" + "/".join(part for part in parts if part)


def _registry_path() -> Path:
    path = _upload_root() / RFP_UPLOAD_SUBDIR / KEYWORD_REGISTRY_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _keyword_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:80]


def load_keywords() -> List[KeywordDefinition]:
    keywords = {k.key: k for k in DEFAULT_KEYWORDS}
    path = _registry_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for item in data.get("custom_keywords", []):
                if item.get("key") and item.get("name"):
                    keywords[item["key"]] = KeywordDefinition(**item)
        except Exception as exc:
            logger.warning("Failed to load RFP keyword registry: %s", exc)
    return list(keywords.values())


def save_custom_keywords(keywords: Iterable[KeywordDefinition]) -> None:
    custom = [asdict(k) for k in keywords if not k.is_default]
    _registry_path().write_text(json.dumps({"custom_keywords": custom}, indent=2), encoding="utf-8")


@router.get("/keywords")
def get_keywords(_: User = Depends(get_current_user)):
    return [asdict(k) for k in load_keywords()]


@router.post("/keywords", status_code=201)
def add_keyword(payload: KeywordCreate = Body(...), _: User = Depends(get_current_user)):
    keywords = load_keywords()
    key = _keyword_key(payload.name)
    if not key:
        raise HTTPException(400, "Invalid keyword name")
    if any(k.key == key for k in keywords):
        raise HTTPException(409, "Keyword already exists")
    aliases = list(dict.fromkeys([payload.name, *payload.aliases]))
    keyword = KeywordDefinition(
        key=key,
        name=payload.name.strip(),
        aliases=[a.strip() for a in aliases if a.strip()],
        category=payload.category.strip() or "Custom",
        prompt_hint=payload.prompt_hint.strip() or f"Extract final sales-useful answer for {payload.name}.",
        active=payload.active,
        is_default=False,
    )
    keywords.append(keyword)
    save_custom_keywords(keywords)
    return asdict(keyword)


@router.delete("/keywords/{keyword_key}")
def delete_keyword(keyword_key: str, _: User = Depends(get_current_user)):
    keywords = load_keywords()
    target = next((k for k in keywords if k.key == keyword_key), None)
    if not target:
        raise HTTPException(404, "Keyword not found")
    if target.is_default:
        raise HTTPException(400, "Default keywords cannot be deleted")
    save_custom_keywords([k for k in keywords if k.key != keyword_key])
    return {"deleted": True, "key": keyword_key}


# -----------------------------------------------------------------------------
# PDF and text helpers
# -----------------------------------------------------------------------------

def extract_text_from_pdf(file_path: str) -> Tuple[str, int, List[Dict[str, Any]]]:
    pages: List[Dict[str, Any]] = []
    try:
        import pypdf
        with open(file_path, "rb") as f:
            reader = pypdf.PdfReader(f)
            for idx, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                pages.append({"page": idx, "text": text})
            return "\n".join(p["text"] for p in pages), len(reader.pages), pages
    except Exception as exc:
        logger.warning("pypdf extraction failed: %s", exc)
    try:
        import pdfminer.high_level as pdfm
        text = pdfm.extract_text(file_path) or ""
        return text, 0, [{"page": 1, "text": text}]
    except Exception as exc:
        logger.error("PDF extraction failed: %s", exc)
        return "", 0, []


def _norm_spaces(text: str) -> str:
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _lines(text: str) -> List[str]:
    out = []
    for ln in _norm_spaces(text).splitlines():
        ln = ln.strip(" -\t")
        if len(ln) >= 3:
            out.append(ln)
    return out


def _dedupe_keep_order(items: Iterable[str]) -> List[str]:
    seen = set()
    out = []
    for item in items:
        key = re.sub(r"\W+", " ", item.lower()).strip()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out


def _date_patterns() -> str:
    return r"(?:\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{2,4}\b)"


def _time_patterns() -> str:
    return r"(?:\b\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)?\b|\b\d{1,2}\s*(?:AM|PM|am|pm)\b)"


def _amount_patterns() -> str:
    return r"(?:₹\s*[\d,]+(?:\.\d+)?|Rs\.?\s*[\d,]+(?:\.\d+)?|INR\s*[\d,]+(?:\.\d+)?|Rupees\s+[A-Za-z0-9 ,.-]+)"


def _percentage_patterns() -> str:
    return r"(?:\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*percent\b|\b\d+(?:\.\d+)?\s*per cent\b)"


def _period_patterns() -> str:
    return r"(?:\b\d+\s*(?:days?|weeks?|months?|years?)\b|\b\d+\s*calendar\s+days\b|\b\d+\s*working\s+days\b)"


def _find_page_snippets(pages: List[Dict[str, Any]], aliases: List[str], before: int = 600, after: int = 1200, max_snippets: int = 8) -> List[Dict[str, Any]]:
    snippets: List[Dict[str, Any]] = []
    alias_regex = re.compile("|".join(re.escape(a) for a in aliases if a), re.I)
    if not aliases:
        return snippets
    for p in pages:
        text = _norm_spaces(p.get("text") or "")
        for m in alias_regex.finditer(text):
            start = max(0, m.start() - before)
            end = min(len(text), m.end() + after)
            snippet = text[start:end]
            snippets.append({"page": p.get("page"), "text": snippet})
            if len(snippets) >= max_snippets:
                return snippets
    return snippets


def _pages_for_snippets(snippets: List[Dict[str, Any]]) -> str:
    pages = []
    for s in snippets:
        p = s.get("page")
        if p and p not in pages:
            pages.append(p)
    return ", ".join(str(p) for p in pages[:8]) or "-"




def _is_probably_noise_line(line: str) -> bool:
    """Reject headers, footers, disclaimers, TOC rows and repeated document titles."""
    low = re.sub(r"\s+", " ", str(line or "").lower()).strip()
    if not low:
        return True
    noise_patterns = [
        r"^page\s*\d+(?:\s*of\s*\d+)?$",
        r"table of contents", r"^contents$", r"^index$",
        r"this document should not be copied", r"without written permission",
        r"copyright violation", r"use of contents of this document",
        r"terms, condition and scope indicated", r"^tamil nadu grama bank$",
        r"^technology management department$", r"^head office$",
        r"^rfp for procurement of", r"^request for proposal$",
        r"^eligibility cum technical$", r"^bid opening date$", r"reverse auction",
        r"dates and timelines are subject to change", r"liable for rejection",
        r"^signature of", r"^authorized signatory", r"^seal of company",
    ]
    if any(re.search(p, low) for p in noise_patterns):
        return True
    if re.search(r"\.{4,}\s*\d+$", low):
        return True
    # Mostly punctuation/box drawing.
    if re.fullmatch(r"[\W_]{3,}", low):
        return True
    return False


def _clean_line(line: str, max_len: int = 900) -> str:
    clean = re.sub(r"\s+", " ", str(line or "")).strip()
    clean = clean.strip(" \t:-")
    # Strip common bullet symbols, but keep numbered clauses because they are useful.
    clean = re.sub(r"^[•▪●◦\u2022\-]+\s*", "", clean).strip()
    clean = re.sub(r"^\(?[a-zA-Z]\)\s+", "", clean).strip()
    if len(clean) > max_len:
        clean = clean[: max_len - 3].rstrip() + "..."
    return clean


def _looks_like_heading(line: str) -> bool:
    clean = _clean_line(line, 180)
    if len(clean) > 120:
        return False
    low = clean.lower().strip(" )(")
    heading_words = r"scope|eligibility|pre[- ]?qualification|technical|commercial|payment|delivery|liquidated|penalty|emd|earnest|performance|security|warranty|service level|annexure|schedule|terms and conditions|evaluation|documents|instruction|bid submission|general terms|price|sla|change orders|force majeure|termination|contract period|important dates"
    if re.match(rf"^(?:\d+(?:\.\d+)*\)?\s*)?(?:{heading_words})\b", low, re.I):
        return True
    # All-caps short lines are often section headers.
    letters = re.sub(r"[^A-Za-z]", "", clean)
    return len(letters) >= 6 and letters.upper() == letters and len(clean) <= 80


def _starts_new_bullet_or_clause(line: str) -> bool:
    raw = str(line or "").strip()
    clean = _clean_line(raw, 180)
    return bool(
        re.match(r"^[•▪●◦\u2022]", raw)
        or re.match(r"^\d+(?:\.\d+)*\)?\s+", clean)
        or re.match(r"^\(?[a-zA-Z]\)\s+", raw)
        or re.match(r"^(On Delivery|On Installation|The bidder|The successful bidder|Successful Bidder|If the|In case|Bank may|Bidder should|OEM should|The PC|The Proposed|TDS|GST|Payment|Delivery|Installation)\b", clean, re.I)
    )


def _line_ends_sentence(line: str) -> bool:
    clean = _clean_line(line, 900)
    if not clean:
        return True
    if clean.endswith((".", ";", ":")):
        return True
    if clean.endswith(")") and len(clean) > 25:
        return True
    return False


def _join_wrapped_sentences(lines: List[str], max_items: int = 60) -> List[str]:
    """Join PDF wrapped lines into complete sentences/clauses.

    Many PDFs extract one visual row as multiple broken lines. This method keeps
    real bullets/numbered clauses separate but joins continuation lines until a
    sentence boundary or a new bullet/heading is found.
    """
    items: List[str] = []
    buf = ""
    for raw in lines or []:
        if _is_probably_noise_line(raw):
            continue
        line = _clean_line(raw, 1000)
        if not line:
            continue
        if _looks_like_heading(line) and buf:
            items.append(buf.strip())
            buf = ""
            continue
        if not buf:
            buf = line
            continue
        if _starts_new_bullet_or_clause(raw) or (_line_ends_sentence(buf) and len(buf) > 35):
            items.append(buf.strip())
            buf = line
        else:
            # Continuation line. Avoid double spaces and join words naturally.
            buf = (buf.rstrip(" ,") + " " + line.lstrip()).strip()
        if len(buf) > 1200:
            items.append(buf.strip())
            buf = ""
    if buf:
        items.append(buf.strip())
    cleaned: List[str] = []
    for item in items:
        item = _clean_line(item, 1200)
        if not item or _is_probably_noise_line(item):
            continue
        # Remove repeated section title at start only.
        item = re.sub(r"^(Scope of Work|Eligibility Criteria|Technical Specifications?|Payment Terms|Delivery.*Timeline|Liquidated Damages)\s*[:\-]?\s*", "", item, flags=re.I).strip()
        if len(item) >= 5:
            cleaned.append(item)
    return _dedupe_keep_order(cleaned)[:max_items]


def _summarise_bullets(lines: List[str], max_items: int = 10) -> str:
    joined = _join_wrapped_sentences(lines, max_items=max_items * 2)
    cleaned: List[str] = []
    for item in joined:
        if _looks_like_heading(item) and len(item.split()) <= 5:
            continue
        cleaned.append(item)
    cleaned = _dedupe_keep_order(cleaned)[:max_items]
    if not cleaned:
        return "Not clearly mentioned in the extracted PDF text."
    return "\n".join(f"• {item}" for item in cleaned)

def _page_noise_score(text: str) -> int:
    low = text.lower()
    score = 0
    for phrase in ["copyright", "table of contents", "contents of this document", "should not be copied", "bid opening date", "reverse auction"]:
        if phrase in low:
            score += 1
    score += min(3, len(re.findall(r"\.{4,}\s*\d+", text)))
    return score


def _pages_for_snippets(snippets: List[Dict[str, Any]]) -> str:
    pages = []
    for s in snippets:
        p = s.get("page")
        if p and p not in pages:
            pages.append(p)
    return ", ".join(str(p) for p in pages[:10]) or "-"



def _extract_dates_from_text(text: str) -> List[str]:
    values: List[str] = []
    for m in re.finditer(_date_patterns(), text, re.I):
        start = max(0, m.start() - 80)
        end = min(len(text), m.end() + 90)
        near = text[start:end]
        tm = re.search(_time_patterns(), near, re.I)
        value = m.group(0).strip()
        if tm and tm.group(0).strip() not in value:
            value = f"{value} {tm.group(0).strip()}"
        values.append(value)
    return _dedupe_keep_order(values)


def _date_sort_key(value: str) -> Tuple[int, int, int, int, int]:
    """Best-effort sortable date key. Unknown parts sort low but code never crashes."""
    months = {"jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,"jul":7,"aug":8,"sep":9,"sept":9,"oct":10,"nov":11,"dec":12}
    v = value.strip()
    m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", v)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100: y += 2000
    else:
        m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})", v)
        if not m:
            return (0,0,0,0,0)
        d, mo, y = int(m.group(1)), months.get(m.group(2)[:4].lower(), 0), int(m.group(3))
        if y < 100: y += 2000
    hm = re.search(r"(\d{1,2})[:.](\d{2})\s*(AM|PM|am|pm)?", v)
    hour = minute = 0
    if hm:
        hour, minute = int(hm.group(1)), int(hm.group(2))
        ap = (hm.group(3) or '').lower()
        if ap == 'pm' and hour < 12: hour += 12
        if ap == 'am' and hour == 12: hour = 0
    return (y, mo, d, hour, minute)


def _context_windows(pages: List[Dict[str, Any]], aliases: List[str], before_lines: int = 1, after_lines: int = 8, min_page: int = 1) -> List[Dict[str, Any]]:
    """Line-by-line keyword windows. Only returns windows where the keyword actually appears."""
    alias_re = re.compile("|".join(re.escape(a) for a in aliases if a), re.I)
    if not aliases:
        return []
    out: List[Dict[str, Any]] = []
    for p in pages:
        page_no = int(p.get('page') or 0)
        if page_no < min_page:
            continue
        lines = _lines(p.get('text') or '')
        for i, ln in enumerate(lines):
            if not alias_re.search(ln):
                continue
            if _is_probably_noise_line(ln):
                continue
            start = max(0, i - before_lines)
            end = min(len(lines), i + after_lines + 1)
            window = [_clean_line(x, 420) for x in lines[start:end] if not _is_probably_noise_line(x)]
            if window:
                out.append({'page': page_no, 'line_index': i, 'lines': window, 'hit': _clean_line(ln, 420), 'text': '\n'.join(window)})
    return out


def _pages_from_windows(windows: List[Dict[str, Any]], limit: int = 10) -> str:
    refs: List[str] = []
    for w in windows:
        pg = str(w.get('page') or '-')
        if pg != '-' and pg not in refs:
            refs.append(pg)
        if len(refs) >= limit:
            break
    return ', '.join(refs) or '-'


def _line_value_after_label(line: str, aliases: List[str]) -> Optional[str]:
    clean = _clean_line(line, 360)
    # Remove label text up to colon/dash when present.
    if re.search(r"[:：]", clean):
        rhs = re.split(r"[:：]", clean, maxsplit=1)[1].strip(' -')
        if len(rhs) >= 2:
            return rhs
    alias_re = re.compile("|".join(re.escape(a) for a in aliases if a), re.I)
    rhs = alias_re.sub('', clean).strip(' :-')
    return rhs if len(rhs) >= 2 and rhs.lower() != clean.lower() else None


def _extract_tender_ref(pages: List[Dict[str, Any]]) -> Tuple[str, str]:
    patterns = [
        r"\bRFP\s*(?:Ref(?:erence)?\s*)?No\.?\s*[:：-]?\s*([A-Z0-9][A-Z0-9/._-]{4,})",
        r"\bTender\s*(?:Ref(?:erence)?\s*)?(?:No|Number)\.?\s*[:：-]?\s*([A-Z0-9][A-Z0-9/._-]{4,})",
        r"\bBid\s*(?:No|Number)\.?\s*[:：-]?\s*([A-Z0-9][A-Z0-9/._-]{4,})",
        r"\bNIT\s*(?:No|Number)\.?\s*[:：-]?\s*([A-Z0-9][A-Z0-9/._-]{4,})",
    ]
    best: List[Tuple[int, str, str]] = []
    for p in pages[:12]:
        page_no = str(p.get('page') or '-')
        for ln in _lines(p.get('text') or ''):
            clean = _clean_line(ln, 280)
            if _is_probably_noise_line(clean):
                continue
            for pat in patterns:
                m = re.search(pat, clean, re.I)
                if not m:
                    continue
                full = m.group(0).strip(' :-')
                val = m.group(1).strip(' .,:;-')
                # Reject placeholder labels like "tender Reference number".
                if re.fullmatch(r"(?:tender|bid|rfp)?\s*(?:reference|number|no)\s*", val, re.I):
                    continue
                score = 100
                if 'rfp' in clean.lower(): score += 20
                if '/' in val or '-' in val: score += 20
                if page_no == '1': score += 10
                best.append((score, page_no, full))
    if best:
        best.sort(key=lambda x: x[0], reverse=True)
        return best[0][2], best[0][1]
    return "Not clearly mentioned in the extracted PDF text.", "-"


def _extract_tender_title(pages: List[Dict[str, Any]], document_name: str) -> Tuple[str, str]:
    # Prefer explicit RFP/request lines containing the procurement/work description.
    candidates: List[Tuple[int, str, str]] = []
    for p in pages[:5]:
        page_no = str(p.get('page') or '-')
        lines = _lines(p.get('text') or '')
        for i, ln in enumerate(lines[:100]):
            clean = _clean_line(ln, 320)
            if _is_probably_noise_line(clean):
                continue
            joined = _clean_line(' '.join(lines[i:i+2]), 420)
            for text_line in (clean, joined):
                low = text_line.lower()
                score = 0
                if re.search(r"request\s+for\s+proposal|\brfp\b", low): score += 70
                if re.search(r"procurement|supply|installation|selection|hiring|work|desktop|server|software|amc", low): score += 50
                if re.search(r"\bfor\b", low): score += 10
                if re.fullmatch(r"tamil nadu grama bank|technology management department|head office", low): score -= 100
                if re.search(r"ref\s*no|dated|submission|pre[- ]?bid|opening date", low): score -= 60
                if 18 <= len(text_line) <= 260 and score > 0:
                    # Clean common prefixes but keep actual title.
                    title = re.sub(r"^\s*(?:sub(?:ject)?\s*[:：-]\s*)", "", text_line, flags=re.I).strip()
                    candidates.append((score, page_no, title))
    if candidates:
        candidates.sort(key=lambda x: (x[0], -len(x[2])), reverse=True)
        title = candidates[0][2]
        # If line is "Sub: Request for Proposal for ...", keep from Request for Proposal.
        m = re.search(r"(Request\s+for\s+Proposal\s+for\s+.+)", title, re.I)
        if m:
            title = m.group(1).strip(' .')
        return title, candidates[0][1]
    return _safe_slug(document_name), "-"



def _first_date_after_label(ctx: str, label_match: re.Match) -> Optional[str]:
    """Return the first date/time after the matched label, not the latest date in the row."""
    after = ctx[label_match.end(): label_match.end() + 180]
    dates = _extract_dates_from_text(after)
    if dates:
        return dates[0]
    # Some extracted tables place value immediately before the label.
    before = ctx[max(0, label_match.start() - 120): label_match.start()]
    dates = _extract_dates_from_text(before)
    return dates[-1] if dates else None


def _extract_best_date_line(pages: List[Dict[str, Any]], target: str) -> Tuple[Optional[str], str, Optional[str]]:
    if target == 'due':
        must = re.compile(r"(last\s+date\s+(?:for\s+)?(?:receipt\s+of\s+)?bids|last\s+date\s+of\s+submission(?:\s+of\s+rfp\s+response)?|submission\s+deadline|bid\s+submission\s*end|closing\s+date|bid\s+end\s+date)", re.I)
        bad = re.compile(r"(pre[- ]?bid|clarification|queries|opening|reverse auction|start date|publication|document download)", re.I)
        label = "Final submission"
    else:
        must = re.compile(r"(date\s+and\s+time\s+of\s+pre[- ]?bid\s+meeting|pre[- ]?bid\s+meeting|pre\s+bid\s+meeting|prebid\s+meeting)", re.I)
        bad = re.compile(r"(last\s+date\s+for\s+receipt\s+of\s+bids|submission\s+deadline|bid\s+end|closing\s+date|opening|reverse auction|emd|security)", re.I)
        label = "Pre-bid"
    candidates: List[Tuple[int, str, str, str]] = []
    for p in pages:
        page_no = int(p.get('page') or 0)
        if page_no <= 0:
            continue
        lines = _lines(p.get('text') or '')
        for i, ln in enumerate(lines):
            ctx = _clean_line(' '.join(lines[max(0, i-2):i+3]), 800)
            mm = must.search(ctx)
            if not mm:
                continue
            near_bad = bad.search(ctx)
            if near_bad and target == 'prebid' and near_bad.start() < mm.start():
                # Row may contain due date before prebid. Still use date after prebid label.
                pass
            elif near_bad and target == 'due' and near_bad.start() < mm.start():
                continue
            val = _first_date_after_label(ctx, mm)
            if not val:
                continue
            score = 100
            if page_no <= 5: score += 15
            if re.search(r"date\s+and\s+time", ctx, re.I): score += 20
            if re.search(r"\bAM\b|\bPM\b|:\d{2}", val, re.I): score += 15
            if target == 'due' and re.search(r"offline|online|portal|receipt of bids|rfp response", ctx, re.I): score += 15
            if target == 'prebid' and re.search(r"meeting", ctx, re.I): score += 25
            candidates.append((score, str(page_no), val, ctx))
    if not candidates:
        return None, '-', None
    candidates.sort(key=lambda x: (x[0], _date_sort_key(x[2])), reverse=True)
    _, page_ref, date_val, evidence = candidates[0]
    return f"{label}: {date_val}", page_ref, evidence

def _heading_match(line: str, headings: List[str]) -> bool:
    clean = _clean_line(line, 180).lower()
    clean = re.sub(r"^[•\-\s]+", "", clean)
    clean_no_num = re.sub(r"^\d+(?:\.\d+)*\)?\s*", "", clean)
    for h in headings:
        hlow = h.lower()
        if clean_no_num == hlow:
            return True
        if clean_no_num.startswith(hlow + ':'):
            return True
        if hlow in clean_no_num and len(clean_no_num) <= len(hlow) + 30 and not re.search(r"date|opening|contents|index|reverse", clean_no_num):
            return True
    return False



def _is_major_heading(line: str) -> bool:
    clean = _clean_line(line, 180)
    if len(clean) > 130:
        return False
    clean = clean.strip(" )(")
    return bool(re.match(r"^(?:\d+(?:\.\d+)*\)?\s*)?(scope|eligibility|pre[- ]?qualification|technical|commercial|payment|delivery|liquidated|penalty|emd|earnest|performance|security|warranty|service level|annexure|schedule|terms and conditions|evaluation|documents|instruction|bid submission|general terms|price|sla|change orders|force majeure|termination|contract period|important dates)\b", clean, re.I))


def _extract_section_by_heading(pages: List[Dict[str, Any]], headings: List[str], max_lines: int = 16, min_page: int = 1, required_content: str = "") -> Tuple[List[str], str]:
    req = re.compile(required_content, re.I) if required_content else None
    best: List[Tuple[int, List[str], List[str]]] = []
    for pi, p in enumerate(pages):
        page_no = int(p.get('page') or 0)
        if page_no < min_page:
            continue
        page_text = p.get('text') or ''
        if _page_noise_score(page_text) >= 2 and page_no <= 6:
            continue
        lines = _lines(page_text)
        for i, line in enumerate(lines):
            if not _heading_match(line, headings):
                continue
            raw_collected: List[str] = []
            refs: List[str] = []
            stop = False
            # Continue across pages because scope/eligibility/spec tables often span pages.
            for p2 in pages[pi:min(len(pages), pi + 8)]:
                p2_no = str(p2.get('page') or '-')
                p2_lines = _lines(p2.get('text') or '')
                start_idx = i + 1 if p2 is p else 0
                for cand in p2_lines[start_idx:]:
                    clean = _clean_line(cand, 1000)
                    if not clean or _is_probably_noise_line(clean):
                        continue
                    # Stop only after we have useful content. This prevents early stop on repeated header lines.
                    if raw_collected and _is_major_heading(clean) and not _heading_match(clean, headings):
                        stop = True
                        break
                    if len(clean) >= 3:
                        raw_collected.append(clean)
                        if p2_no not in refs:
                            refs.append(p2_no)
                    # collect extra raw lines because wrapped lines will be merged later.
                    if len(raw_collected) >= max_lines * 3:
                        stop = True
                        break
                if stop:
                    break
            paragraphs = _join_wrapped_sentences(raw_collected, max_items=max_lines)
            if paragraphs:
                useful_count = len([x for x in paragraphs if (not req or req.search(x))])
                score = useful_count * 45 + len(paragraphs)
                if page_no <= 5: score -= 40
                if req and useful_count == 0: score -= 90
                # Prefer sections with several complete sentences over fragments.
                score += len([x for x in paragraphs if len(x) > 80]) * 5
                best.append((score, paragraphs[:max_lines], refs))
    if best:
        best.sort(key=lambda x: x[0], reverse=True)
        return _dedupe_keep_order(best[0][1])[:max_lines], ', '.join(best[0][2]) or '-'
    return [], '-'


def _find_relevant_lines(pages: List[Dict[str, Any]], include: str, exclude: str = r"$a", max_lines: int = 12, min_page: int = 1, require_keyword_window: Optional[List[str]] = None) -> Tuple[List[str], str]:
    inc = re.compile(include, re.I)
    exc = re.compile(exclude, re.I) if exclude else None
    scored: List[Tuple[int, str, str]] = []
    if require_keyword_window:
        windows = _context_windows(pages, require_keyword_window, before_lines=0, after_lines=max_lines * 2, min_page=min_page)
        iterable = []
        for w in windows:
            for ln in _join_wrapped_sentences(w['lines'], max_items=max_lines * 2):
                iterable.append((int(w['page']), ln))
    else:
        iterable = []
        for p in pages:
            page_no = int(p.get('page') or 0)
            if page_no < min_page:
                continue
            paragraphs = _join_wrapped_sentences(_lines(p.get('text') or ''), max_items=100)
            for line in paragraphs:
                iterable.append((page_no, line))
    for page_no, line in iterable:
        clean = _clean_line(line, 1000)
        if not clean or _is_probably_noise_line(clean):
            continue
        if not inc.search(clean):
            continue
        if exc and exc.search(clean):
            continue
        score = 10 + len(re.findall(include, clean, re.I)) * 5
        if len(clean) > 80: score += 8
        if page_no <= 5: score -= 5
        scored.append((score, str(page_no), clean))
    scored.sort(key=lambda x: x[0], reverse=True)
    lines: List[str] = []
    refs: List[str] = []
    for _, pg, ln in scored:
        if ln not in lines:
            lines.append(ln)
        if pg not in refs:
            refs.append(pg)
        if len(lines) >= max_lines:
            break
    return lines, ', '.join(refs[:10]) or '-'

def _extract_payment_mode_from_text(text: str) -> Optional[str]:
    low = text.lower()
    modes = []
    checks = [
        ("Bank Guarantee", ["bank guarantee", "bg"]),
        ("Demand Draft", ["demand draft", "dd"]),
        ("NEFT / RTGS", ["neft", "rtgs", "fund transfer"]),
        ("Online payment", ["online", "portal", "e-payment", "epayment"]),
        ("FDR", ["fdr", "fixed deposit"]),
        ("Banker cheque", ["banker cheque", "banker's cheque", "pay order"]),
    ]
    for label, keys in checks:
        if any(k in low for k in keys):
            modes.append(label)
    return " / ".join(_dedupe_keep_order(modes)) if modes else None


def _extract_financial_field(pages: List[Dict[str, Any]], aliases: List[str], field_key: str) -> Tuple[Optional[str], str]:
    windows = _context_windows(pages, aliases, before_lines=1, after_lines=7, min_page=2)
    if not windows:
        return None, '-'
    alias_re = re.compile("|".join(re.escape(a) for a in aliases if a), re.I)
    good_windows: List[Tuple[int, Dict[str, Any]]] = []
    for w in windows:
        txt = w['text']
        score = 0
        if alias_re.search(w['hit']): score += 40
        if re.search(_amount_patterns(), txt, re.I): score += 35
        if re.search(_percentage_patterns(), txt, re.I): score += 20
        if re.search(r"valid|days|bank guarantee|demand draft|neft|rtgs|exempt|msme|startup|payable|amount|security", txt, re.I): score += 25
        if field_key == 'pbg' and re.search(r"earnest money|emd", txt, re.I): score -= 35
        if field_key == 'emd' and re.search(r"performance security|performance bank guarantee|pbg", txt, re.I): score -= 20
        good_windows.append((score, w))
    good_windows.sort(key=lambda x: x[0], reverse=True)
    selected = [w for score, w in good_windows[:6] if score > 0]
    if not selected:
        return None, '-'
    all_lines = _dedupe_keep_order([ln for w in selected for ln in w['lines']])
    all_text = '\n'.join(all_lines)
    amount = None
    for ln in all_lines:
        if alias_re.search(ln) or re.search(r"amount|security|fee|deposit|guarantee", ln, re.I):
            m = re.search(_amount_patterns() + "|" + _percentage_patterns(), ln, re.I)
            if m:
                amount = m.group(0).strip(); break
    if not amount:
        m = re.search(_amount_patterns() + "|" + _percentage_patterns(), all_text, re.I)
        amount = m.group(0).strip() if m else None
    period = None
    for ln in all_lines:
        if re.search(r"valid|validity|period|days", ln, re.I):
            m = re.search(_period_patterns(), ln, re.I)
            if m:
                period = m.group(0).strip(); break
    mode = _extract_payment_mode_from_text(all_text)
    exemption = next((_clean_line(ln, 260) for ln in all_lines if re.search(r"exempt|msme|startup|exemption|mse", ln, re.I)), None)
    parts = [
        _value("Amount / percentage", amount),
        _value("Payment method / format", mode),
        _value("Validity / period", period),
        _value("Exemption", exemption),
    ]
    useful = [ln for ln in all_lines if alias_re.search(ln) or re.search(r"amount|valid|exempt|msme|bank guarantee|demand draft|neft|rtgs|payable|security|deposit|fee", ln, re.I)]
    bullets = _summarise_bullets(useful, max_items=8)
    if bullets != "Not clearly mentioned in the extracted PDF text.":
        parts.append("Important extracted lines:\n" + bullets)
    value = "\n".join(p for p in parts if p)
    return (value if value else None), _pages_from_windows(selected)


def _split_extra_keywords(extra_keywords: Optional[str]) -> List[KeywordDefinition]:
    if not extra_keywords:
        return []
    out: List[KeywordDefinition] = []
    for raw in re.split(r"[,\n;]+", extra_keywords):
        name = raw.strip()
        if len(name) < 2:
            continue
        key = _keyword_key(name)
        out.append(KeywordDefinition(key=key, name=name, aliases=[name], category="One-time", prompt_hint=f"Extract {name}.", active=True, is_default=False))
    return out



def _value(label: str, val: Optional[str]) -> Optional[str]:
    """Return a labelled value line only when a value exists.

    This helper is intentionally kept in the same file so the router is
    self-contained and does not fail at runtime with missing helper errors.
    """
    if val is None:
        return None
    value = str(val).strip()
    if not value or value in {"-", "Not clearly mentioned in the extracted PDF text."}:
        return None
    return f"{label}: {value}"

# -----------------------------------------------------------------------------
# Sales extraction without server-heavy LLM
# -----------------------------------------------------------------------------

def analyze_rfp_sales_safe(text: str, pages: List[Dict[str, Any]], keywords: List[KeywordDefinition]) -> Dict[str, Any]:
    fields: List[Dict[str, Any]] = []

    def add(field_key: str, field_name: str, value: Optional[str], page_ref: str, include_if_missing: bool = True):
        if not value or not str(value).strip() or str(value).strip() == "Not clearly mentioned in the extracted PDF text.":
            if not include_if_missing:
                return
            value = "Not clearly mentioned in the extracted PDF text."
            page_ref = page_ref if page_ref and page_ref != '-' else '-'
        fields.append({"key": field_key, "field": field_name, "value": str(value).strip(), "page_ref": page_ref or "-"})

    title, title_ref = _extract_tender_title(pages, document_name="rfp")
    add("tender_title", "Tender Title", title, title_ref)

    ref_value, ref_page = _extract_tender_ref(pages)
    add("tender_ref_no", "Tender Ref No", ref_value, ref_page)

    due_value, due_page, due_evidence = _extract_best_date_line(pages, "due")
    if due_value:
        mode = "Online portal" if re.search(r"portal|online|eproc|e-proc|gem", text, re.I) else None
        if mode:
            due_value += f"\nSubmission mode: {mode}"
        if due_evidence:
            due_value += f"\nEvidence: {due_evidence}"
    add("tender_due_date", "Tender Due Date", due_value, due_page)

    pre_value, pre_page, pre_evidence = _extract_best_date_line(pages, "prebid")
    if pre_value and pre_evidence:
        pre_value += f"\nEvidence: {pre_evidence}"
    add("pre_bid_date", "Pre-bid Date", pre_value, pre_page)

    section_specs = [
        ("scope_of_work", "Scope of Work", ["scope of work", "scope of supply", "scope", "work description", "terms of reference"], 30,
         r"supply|installation|install|commission|desktop|computer|pc|amc|warranty|support|deliver|location|quantity|software|oem|monitor"),
        ("eligibility_criteria", "Eligibility Criteria", ["eligibility criteria", "minimum eligibility criteria", "eligibility", "pre qualification", "pre-qualification", "qualification criteria", "bidder qualification"], 32,
         r"bidder|company|registered|eligible|turnover|experience|years|similar|certificate|oem|authori[sz]ed|blacklisted|net worth|profit|audited|documentary"),
        ("technical_details", "Technical Details", ["technical specifications", "technical specification", "minimum technical specifications", "technical details", "technical requirement", "specification", "boq", "bill of quantity"], 36,
         r"processor|ram|memory|ssd|hdd|monitor|keyboard|mouse|operating system|windows|warranty|desktop|pc|display|chipset|ports|ethernet|tpm|bios|usb"),
    ]
    for key, name, headings, max_lines, req in section_specs:
        lines, refs = _extract_section_by_heading(pages, headings, max_lines=max_lines, min_page=5, required_content=req)
        if not lines or len([x for x in lines if re.search(req, x, re.I)]) < 3:
            fallback_lines, fallback_refs = _find_relevant_lines(pages, req, r"copyright|copied|permission|opening date|reverse auction", max_lines=max_lines, min_page=5, require_keyword_window=headings)
            if len(fallback_lines) > len(lines):
                lines, refs = fallback_lines, fallback_refs
        add(key, name, _summarise_bullets(lines, max_items=max_lines), refs)

    lines, refs = _extract_section_by_heading(pages, ["delivery & installation timeline", "delivery and installation timeline", "delivery period", "delivery schedule", "completion period", "implementation period", "period of completion", "period of contract"], max_lines=16, min_page=5, required_content=r"delivery|install|complete|week|day|month|contract")
    if not lines:
        lines, refs = _find_relevant_lines(pages, r"delivery|completion|implementation|installation|contract period|period of contract|within\s+\d+\s+(?:days|weeks|months)", max_lines=14, min_page=5)
    add("delivery_period", "Delivery Period", _summarise_bullets(lines, max_items=16), refs)

    lines, refs = _extract_section_by_heading(pages, ["payment terms", "payment schedule", "terms of payment"], max_lines=12, min_page=5, required_content=r"payment|invoice|delivery|installation|percent|%|tds|penalty")
    if not lines:
        lines, refs = _find_relevant_lines(pages, r"payment|invoice|advance|retention|milestone|on delivery|on installation|percent|%", max_lines=16, min_page=5)
    add("payment_terms", "Payment Terms", _summarise_bullets(lines, max_items=12), refs)

    lines, refs = _extract_section_by_heading(pages, ["liquidated damages", "ld clause", "penalty for delay", "delay penalty", "late delivery"], max_lines=16, min_page=5, required_content=r"liquidated|delay|penalty|0\.5|per week|maximum|deduct")
    if not lines:
        lines, refs = _find_relevant_lines(pages, r"liquidated damages|delay penalty|penalty|late delivery|per week|per day|0\.5%|maximum.*10%", r"opening date|liable for rejection", max_lines=14, min_page=5)
    add("ld_clause", "LD Clause", _summarise_bullets(lines, max_items=16), refs)

    for key, name, aliases in [
        ("emd", "EMD", ["emd", "earnest money deposit", "earnest money", "bid security"]),
        ("tender_fee", "Tender Fee", ["tender fee", "document fee", "bid document fee", "cost of tender", "cost of bid document", "processing fee"]),
        ("pbg", "PBG / Performance Bank Guarantee", ["performance bank guarantee", "performance security", "security deposit", "performance guarantee", "pbg"]),
    ]:
        value, refs = _extract_financial_field(pages, aliases, key)
        add(key, name, value, refs)

    default_keys = set(DEFAULT_FIELD_ORDER)
    existing_keys = {f["key"] for f in fields}
    for kw in keywords:
        if kw.key in existing_keys or kw.key in default_keys or not kw.active:
            continue
        lines, refs = _extract_section_by_heading(pages, kw.aliases or [kw.name], max_lines=14, min_page=3)
        if not lines:
            windows = _context_windows(pages, kw.aliases or [kw.name], before_lines=0, after_lines=8, min_page=3)
            lines = _dedupe_keep_order([ln for w in windows for ln in w['lines']])[:14]
            refs = _pages_from_windows(windows)
        # Custom/extra keyword rule requested by user: if keyword does not exist, do not print it.
        value = _summarise_bullets(lines, max_items=14)
        add(kw.key, kw.name, value if value != "Not clearly mentioned in the extracted PDF text." else None, refs, include_if_missing=False)

    by_key = {f["key"]: f for f in fields}
    ordered = [by_key.pop(k) for k in DEFAULT_FIELD_ORDER if k in by_key]
    ordered.extend(by_key.values())
    return {
        "summary_type": "server_safe_exact_keyword_line_scan_v5",
        "fields": ordered,
        "note": f"{RFP_EXTRACTION_VERSION}: CPU-safe scalable extraction. It scans line-by-line, matches values only against each field's keywords, uses scored section headings, picks one best due/pre-bid date, and omits missing custom fields.",
    }


# -----------------------------------------------------------------------------
# Optional AI refinement - OFF by default
# -----------------------------------------------------------------------------

def maybe_refine_with_ai(result: Dict[str, Any], pages: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not RFP_ENABLE_AI:
        return result
    try:
        import urllib.request
        compact_text = []
        for p in pages:
            txt = _norm_spaces(p.get("text") or "")
            if txt:
                compact_text.append(f"[Page {p.get('page')}]\n{txt[:2500]}")
        doc = "\n\n".join(compact_text)[:MAX_AI_CHARS]
        prompt = f"""
You are a sales tender analyst. Improve the following extracted RFP summary using the document text.
Return ONLY JSON in this exact format:
{{"fields":[{{"key":"emd","field":"EMD","value":"Amount: ...\nPayment method: ...","page_ref":"1, 2"}}]}}
Do not paste raw paragraphs. Keep Field, Values and Page Ref only.

Current extraction:
{json.dumps(result.get('fields', []), ensure_ascii=False)}

Document text:
{doc}
"""
        body = {"model": OLLAMA_MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0.1, "num_predict": 1800}}
        req = urllib.request.Request(OLLAMA_URL, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        response = data.get("response", "")
        if "```" in response:
            response = response.split("```", 2)[1].replace("json", "", 1).strip()
        parsed = json.loads(response)
        if isinstance(parsed.get("fields"), list) and parsed["fields"]:
            result["fields"] = parsed["fields"]
            result["summary_type"] = "sales_ai_refined"
    except Exception as exc:
        logger.warning("Optional AI refinement failed; using safe extraction: %s", exc)
    return result


# -----------------------------------------------------------------------------
# Excel generation
# -----------------------------------------------------------------------------

def create_sales_excel(document_name: str, result: Dict[str, Any], output_dir: Path) -> str:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    output_dir.mkdir(parents=True, exist_ok=True)
    base = _safe_slug(document_name)
    out_path = output_dir / f"{base}_sales_tender_summary.xlsx"

    wb = Workbook()
    ws = wb.active
    ws.title = "RFP Summary"
    ref_ws = wb.create_sheet("Page References")

    headers = ["Field", "Values", "Page Ref"]
    ws.append(headers)
    ref_ws.append(["Field", "Page Ref", "Extracted Value / Evidence"])

    for item in result.get("fields", []):
        field = item.get("field") or item.get("key") or "-"
        value = item.get("value") or "Not clearly mentioned in the extracted PDF text."
        page_ref = item.get("page_ref") or "-"
        ws.append([field, value, page_ref])
        ref_ws.append([field, page_ref, value])

    header_fill = PatternFill("solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True, size=12)
    thin = Side(style="thin", color="D9E2F3")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for sheet in (ws, ref_ws):
        for cell in sheet[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = border
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
                cell.border = border
            row[0].font = Font(bold=True, color="1F4E78")
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions

    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 120
    ws.column_dimensions["C"].width = 18
    ref_ws.column_dimensions["A"].width = 34
    ref_ws.column_dimensions["B"].width = 18
    ref_ws.column_dimensions["C"].width = 120

    for sheet in (ws, ref_ws):
        for row_idx in range(2, sheet.max_row + 1):
            sheet.row_dimensions[row_idx].height = 72

    wb.save(out_path)
    return str(out_path)


def _serialize_analysis(a: RFPAnalysis) -> Dict[str, Any]:
    return {c.name: getattr(a, c.name) for c in a.__table__.columns}


def _set_attr_if_exists(obj: Any, name: str, value: Any) -> None:
    if hasattr(obj, name):
        setattr(obj, name, value)


def _analysis_excel_url(analysis_id: int) -> str:
    return f"/api/v1/rfp/{analysis_id}/excel"


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------

@router.post("/analyze", status_code=201, response_model=AnalyzeResponse)
async def analyze_rfp(
    tender_id: Optional[int] = Form(None),
    extra_keywords: Optional[str] = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    content = await file.read()
    if len(content) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(413, f"File too large. Max allowed size is {MAX_FILE_MB} MB")

    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    ensure_tenant_storage_available(tenant_slug, len(content))

    upload_dir = _tenant_upload_root(db) / RFP_UPLOAD_SUBDIR
    export_dir = _tenant_upload_root(db) / RFP_EXCEL_SUBDIR
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}_{_safe_slug(file.filename)}.pdf"
    filepath = upload_dir / filename
    filepath.write_bytes(content)
    refresh_tenant_storage_usage_for_slug(tenant_slug)
    file_url = _tenant_upload_url(db, RFP_UPLOAD_SUBDIR, filename)

    analysis = RFPAnalysis(
        tender_id=tender_id,
        document_name=file.filename,
        document_url=file_url,
        status="Processing",
        created_by=cu.id,
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    start = time.time()
    try:
        text, pages_count, pages = await run_in_threadpool(extract_text_from_pdf, str(filepath))
        if not text.strip():
            raise ValueError("Could not extract text from PDF. This may be a scanned PDF; OCR is required.")

        keywords = load_keywords() + _split_extra_keywords(extra_keywords)
        result = await run_in_threadpool(analyze_rfp_sales_safe, text, pages, keywords)
        # AI is disabled by default. If enabled, this still runs once only.
        result = await run_in_threadpool(maybe_refine_with_ai, result, pages)
        excel_path = await run_in_threadpool(create_sales_excel, file.filename, result, export_dir)
        refresh_tenant_storage_usage_for_slug(tenant_slug)

        analysis.status = "Completed"
        analysis.document_pages = pages_count
        analysis.key_points = result
        analysis.raw_summary = text[:2000]
        analysis.processing_ms = int((time.time() - start) * 1000)
        analysis.model_used = RFP_EXTRACTION_VERSION if not RFP_ENABLE_AI else f"{RFP_EXTRACTION_VERSION} + {OLLAMA_MODEL} optional refinement"
        _set_attr_if_exists(analysis, "excel_url", _analysis_excel_url(analysis.id))
        _set_attr_if_exists(analysis, "excel_path", excel_path)

        if tender_id:
            tender = db.query(Tender).filter(Tender.id == tender_id).first()
            if tender:
                tender.rfp_document_url = file_url
                tender.ai_key_points = result

        db.add(ActivityLog(
            user_id=cu.id,
            module="rfp",
            record_id=analysis.id,
            action="analyzed",
            description=f"RFP '{file.filename}' analyzed safely ({pages_count} pages)",
            icon="📊",
            color="#EDE9FE",
        ))
    except Exception as exc:
        logger.exception("RFP analysis failed")
        analysis.status = "Failed"
        analysis.error_message = str(exc)
    finally:
        db.commit()
        db.refresh(analysis)

    return AnalyzeResponse(
        id=analysis.id,
        status=analysis.status,
        document_name=analysis.document_name,
        document_pages=analysis.document_pages,
        key_points=analysis.key_points,
        excel_url=_analysis_excel_url(analysis.id) if analysis.status == "Completed" else None,
        error=analysis.error_message,
    )


@router.get("")
def list_analyses(
    tender_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    q = db.query(RFPAnalysis)
    if tender_id:
        q = q.filter(RFPAnalysis.tender_id == tender_id)
    analyses = q.order_by(RFPAnalysis.created_at.desc()).all()
    rows = []
    for a in analyses:
        item = _serialize_analysis(a)
        if a.status == "Completed":
            item["excel_url"] = _analysis_excel_url(a.id)
        rows.append(item)
    return rows


@router.get("/{analysis_id}")
def get_analysis(
    analysis_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    a = db.query(RFPAnalysis).filter(RFPAnalysis.id == analysis_id).first()
    if not a:
        raise HTTPException(404, "Analysis not found")
    item = _serialize_analysis(a)
    if a.status == "Completed":
        item["excel_url"] = _analysis_excel_url(a.id)
    return item


@router.get("/{analysis_id}/excel")
def download_excel(
    analysis_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    a = db.query(RFPAnalysis).filter(RFPAnalysis.id == analysis_id).first()
    if not a:
        raise HTTPException(404, "Analysis not found")
    if a.status != "Completed":
        raise HTTPException(400, "Analysis is not completed yet")

    filename = f"{_safe_slug(a.document_name)}_sales_tender_summary.xlsx"
    stored_excel_path = str(getattr(a, "excel_path", "") or "").strip()
    path = Path(stored_excel_path) if stored_excel_path else _tenant_upload_root(db) / RFP_EXCEL_SUBDIR / filename
    export_dir = path.parent
    if not path.exists():
        # recreate if file was deleted
        if not a.key_points:
            raise HTTPException(404, "Excel file not found")
        create_sales_excel(a.document_name, a.key_points, export_dir)
    return FileResponse(
        str(path),
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
