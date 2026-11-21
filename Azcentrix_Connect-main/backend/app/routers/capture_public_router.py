"""Lead capture forms – public endpoints (no login).   /api/v1/public/capture

GET  /embed.js                         – embed script: turns <script data-form="<tenant>/<key>"> into an auto-sizing iframe
GET  /f/{tenant}/{key}                 – hosted form page (published forms only)
GET  /f/{tenant}/{key}/challenge       – a new CAPTCHA question (after a wrong answer)
POST /f/{tenant}/{key}/submit          – submission → validation, spam protection, duplicate check, routing, lead

The tenant comes from the URL (it must exist and be active, and its Leads feature must be on); the form key is a
random 12-character token. Pages can be embedded only on the sites listed in the tenant setting
capture_forms_allowed_origins (JSON list of origins; empty = any site), enforced with CSP frame-ancestors.
"""
from __future__ import annotations

import html
import json
import secrets
from contextlib import contextmanager
from typing import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from sqlalchemy.orm import Session

from app.models.all_models import Module, Setting
from app.models.capture_forms import CaptureForm
from app.services import capture_form_service as S

router = APIRouter()
MAX_BODY = 64 * 1024


@contextmanager
def tenant_session(slug: str) -> Iterator[Session]:
    from app.database import MasterSessionLocal, get_tenant_session_by_db_name
    from app.models.tenant import Tenant
    slug = (slug or "").strip().lower()
    m = MasterSessionLocal()
    try:
        t = m.query(Tenant).filter(Tenant.slug == slug).first()
        if not t or t.status not in ("active", "trial"):
            raise HTTPException(404, "Form not found")
        db_name = t.db_name
    finally:
        m.close()
    db = get_tenant_session_by_db_name(db_name, cache_key=slug)
    db.info["tenant_slug"] = slug
    try:
        S.ensure_schema(db)
        yield db
    finally:
        db.close()


def _live_form(db: Session, key: str) -> CaptureForm:
    mod = db.query(Module.is_active).filter(Module.key == "capture_forms").first()
    f = db.query(CaptureForm).filter(CaptureForm.public_key == key).first()
    if not f or not f.is_published or (mod is not None and not mod[0]):
        raise HTTPException(404, "This form is not available")
    return f


def _frame_ancestors(db: Session) -> str:
    row = db.query(Setting).filter(Setting.key == "capture_forms_allowed_origins").first()
    try:
        allowed = [o.strip() for o in json.loads(row.value) if isinstance(o, str) and o.strip()] if row and row.value else []
    except ValueError:
        allowed = []
    return "'self' " + " ".join(allowed) if allowed else "*"


def _headers(db: Session, nonce: str) -> dict[str, str]:
    return {
        "Content-Security-Policy": f"default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; connect-src 'self'; "
                                   f"form-action 'self'; base-uri 'none'; frame-ancestors {_frame_ancestors(db)}",
        "Cache-Control": "no-store", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Content-Type-Options": "nosniff",
    }


CSS = """
:root{--ac:#0F6E8C;--tx:#1f2937;--mu:#64748b;--ln:#d5dbe3;--sf:#fff;--hd:#f5f7fa;--ba:#c2410c;--ok:#15803d}
@media(prefers-color-scheme:dark){:root{--tx:#e5e7eb;--mu:#94a3b8;--ln:#334155;--sf:#0f172a;--hd:#111c2e;--ac:#38a3c4}}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--tx);font:13px/1.45 Inter,"Segoe UI",system-ui,-apple-system,sans-serif}
body{padding:8px}.capp{border:1px dashed var(--ln);border-radius:10px;padding:14px;background:var(--hd);max-width:640px;margin:0 auto}
.capp h3{margin:0 0 6px;font-size:14px;font-weight:600}.capp label{display:block;font-size:11px;margin:8px 0 3px;color:var(--mu)}
.in{width:100%;height:30px;padding:0 8px;border:1px solid var(--ln);border-radius:6px;background:var(--sf);color:var(--tx);font-size:13px;font-family:inherit}
textarea.in{height:auto;padding:6px 8px;resize:vertical}select.in{padding:0 4px}.in:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac) 18%,transparent)}
.in.bad{border-color:var(--ba)}.fe{color:var(--ba);font-size:11.5px;margin-top:3px}.btn{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:6px;
border:1px solid var(--ac);background:var(--ac);color:#fff;font-weight:600;font-size:13px;font-family:inherit;cursor:pointer;margin-top:8px}.btn:disabled{opacity:.6;cursor:default}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.msg{margin-top:8px;font-size:12px;color:var(--ba)}
.done{border:1px solid color-mix(in srgb,var(--ok) 40%,var(--ln));background:color-mix(in srgb,var(--ok) 8%,var(--sf));border-radius:10px;padding:16px;max-width:640px;margin:0 auto;white-space:pre-wrap}
.req{color:var(--ba)}.na{max-width:640px;margin:0 auto;padding:16px;border:1px dashed var(--ln);border-radius:10px;color:var(--mu)}
"""


def _page(title: str, body: str, nonce: str, script: str = "") -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="robots" content="noindex"><title>{html.escape(title)}</title><style nonce="{nonce}">{CSS}</style></head>'
            f'<body>{body}{f"<script nonce={chr(34)}{nonce}{chr(34)}>{script}</script>" if script else ""}</body></html>')


SCRIPT = r"""
(function(){var C=JSON.parse(document.getElementById('cfg').textContent),f=document.getElementById('f'),b=f.querySelector('button[type=submit]');
function h(){try{parent.postMessage({type:'azx-capture',key:C.key,h:document.documentElement.scrollHeight},'*')}catch(e){}}
window.addEventListener('load',h);new ResizeObserver(h).observe(document.body);
function clear(){f.querySelectorAll('.fe').forEach(function(x){x.remove()});f.querySelectorAll('.bad').forEach(function(x){x.classList.remove('bad')});document.getElementById('msg').textContent=''}
function mark(k,m){var el=f.querySelector('[name="'+k+'"]');if(!el)return;el.classList.add('bad');var d=document.createElement('div');d.className='fe';d.textContent=m;el.insertAdjacentElement('afterend',d)}
function fresh(){fetch(C.challenge).then(function(r){return r.json()}).then(function(j){if(j.captcha){document.getElementById('cq').textContent=j.captcha.question+' *';C.ct=j.captcha.token;f.ca.value=''}if(j.rt)C.rt=j.rt})}
f.addEventListener('submit',function(e){e.preventDefault();clear();var v={};C.fields.forEach(function(k){var el=f.querySelector('[name="'+k+'"]');if(el)v[k]=el.value});
var miss=C.required.filter(function(k){return !String(v[k]||'').trim()});if(miss.length){miss.forEach(function(k){mark(k,C.labels[k]+' is required')});h();return}
b.disabled=true;b.textContent='Sending…';
fetch(C.submit,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:v,rt:C.rt,hp:f.hp.value,ct:C.ct,ca:f.ca?f.ca.value:'',page:document.referrer||location.href})})
.then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})}).then(function(x){
 if(x.s<300&&x.j.ok){f.hidden=true;var d=document.getElementById('done');d.textContent=x.j.thanks;d.hidden=false;h();return}
 var det=x.j.detail||{};if(typeof det==='string')det={message:det};Object.keys(det.fields||{}).forEach(function(k){mark(k,det.fields[k])});
 document.getElementById('msg').textContent=det.message||'Something went wrong – please try again.';if(det.fields&&det.fields.captcha||x.s===409)fresh();
 b.disabled=false;b.textContent='Submit';h()}).catch(function(){document.getElementById('msg').textContent='Could not send – check your connection and try again.';b.disabled=false;b.textContent='Submit';h()})});
})();
"""


@router.get("/f/{slug}/{key}", response_class=HTMLResponse)
def hosted_form(slug: str, key: str, request: Request):
    nonce = secrets.token_urlsafe(12)
    try:
        with tenant_session(slug) as db:
            f = _live_form(db, key)
            hdr = _headers(db, nonce)
            parts = [f'<form class="capp" id="f" novalidate><h3>{html.escape(f.name)}</h3>']
            req = set(f.required or [])
            prods = S.products(db) if "interest" in (f.fields or []) else []
            sts = S.states(db) if "state" in (f.fields or []) else []
            for k in S.clean_fields(f.fields or []):
                lab = html.escape(S.LABEL[k]) + (' <span class="req">*</span>' if k in req else "")
                kind, attrs = S.KIND[k], f'id="f-{k}" name="{k}" class="in"' + (" required" if k in req else "")
                parts.append(f'<label for="f-{k}">{lab}</label>')
                if kind == "textarea":
                    parts.append(f'<textarea {attrs} rows="3" maxlength="5000"></textarea>')
                elif kind in ("product", "state"):
                    opts = prods if kind == "product" else sts
                    parts.append(f'<select {attrs}><option value="">Select…</option>' + "".join(
                        f'<option value="{o["id"]}">{html.escape(o["name"])}</option>' for o in opts) + "</select>")
                else:
                    typ = {"email": "email", "tel": "tel", "number": "number"}.get(kind, "text")
                    extra = ' min="0" step="any" inputmode="decimal"' if kind == "number" else (' autocomplete="email"' if kind == "email" else "")
                    parts.append(f'<input {attrs} type="{typ}" maxlength="300"{extra}>')
            parts.append('<div class="hp" aria-hidden="true"><label for="f-hp">Leave this empty</label><input id="f-hp" name="hp" tabindex="-1" autocomplete="off"></div>')
            cap = S.captcha(slug, key) if "CAPTCHA" in (f.spam or "") else None
            if cap:
                parts.append(f'<label for="f-ca" id="cq">{html.escape(cap["question"])} <span class="req">*</span></label>'
                             '<input id="f-ca" name="ca" class="in" inputmode="numeric" autocomplete="off" maxlength="4">')
            parts.append('<div class="msg" id="msg" role="alert"></div><button class="btn" type="submit">Submit</button></form>'
                         '<div class="done" id="done" role="status" hidden></div>')
            base = f"/api/v1/public/capture/f/{slug}/{key}"
            cfg = {"key": key, "submit": f"{base}/submit", "challenge": f"{base}/challenge", "rt": S.render_token(slug, key), "ct": cap["token"] if cap else None,
                   "fields": S.clean_fields(f.fields or []), "required": [r for r in f.required or [] if r in (f.fields or [])], "labels": S.LABEL}
            safe = json.dumps(cfg).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")   # no </script> break-out
            parts.append(f'<script type="application/json" id="cfg">{safe}</script>')
            return HTMLResponse(_page(f.name, "".join(parts), nonce, SCRIPT), headers=hdr)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return HTMLResponse(_page("Form not available", '<div class="na">This form is not available. It may have been unpublished.</div>', nonce),
                            status_code=404, headers={"Content-Security-Policy": f"default-src 'none'; style-src 'nonce-{nonce}'", "Cache-Control": "no-store"})


@router.get("/f/{slug}/{key}/challenge")
def new_challenge(slug: str, key: str):
    with tenant_session(slug) as db:
        f = _live_form(db, key)
        return JSONResponse({"rt": S.render_token(slug, key), "captcha": S.captcha(slug, key) if "CAPTCHA" in (f.spam or "") else None},
                            headers={"Cache-Control": "no-store"})


@router.post("/f/{slug}/{key}/submit")
async def submit(slug: str, key: str, request: Request):
    if int(request.headers.get("content-length") or 0) > MAX_BODY:
        raise HTTPException(413, "Submission too large")
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "Submission too large")
    try:
        body = json.loads(raw or b"{}")
        if not isinstance(body, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "Invalid submission")
    with tenant_session(slug) as db:
        f = _live_form(db, key)
        res = S.submit(db, slug, f, body, request)
        # visitors only see the thank-you message; references stay internal
        return JSONResponse({"ok": True, "thanks": res.get("thanks") or "Thank you!"}, headers={"Cache-Control": "no-store"})


EMBED_JS = r"""
(function(){var me=document.currentScript,base=me?new URL(me.src).origin:'';
function mount(s){if(s.getAttribute('data-azx-done'))return;var id=s.getAttribute('data-form');if(!id)return;s.setAttribute('data-azx-done','1');
 var p=id.split('/'),f=document.createElement('iframe');f.src=(s.src?new URL(s.src).origin:base)+'/api/v1/public/capture/f/'+encodeURIComponent(p[0])+'/'+encodeURIComponent(p[1]);
 f.title='Enquiry form';f.loading='lazy';f.style.cssText='width:100%;max-width:680px;border:0;height:560px;display:block;background:transparent';f.setAttribute('allowtransparency','true');
 s.parentNode.insertBefore(f,s.nextSibling);
 window.addEventListener('message',function(e){if(e.source===f.contentWindow&&e.data&&e.data.type==='azx-capture'&&e.data.h){f.style.height=Math.min(4000,e.data.h+4)+'px'}})}
document.querySelectorAll('script[data-form]').forEach(mount);})();
"""


@router.get("/embed.js")
def embed_js():
    return Response(EMBED_JS, media_type="application/javascript; charset=utf-8",
                    headers={"Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff"})
