"""Source connectors for migrations (Data Export & Migration → Source connectors).

Each CRM connector validates its credentials against the vendor's own API, counts records per object and pulls
objects page by page. Pulled objects are written as CSV snapshots into the migration folder, so the existing
migration engine (tenant_migration: mapping → dry run → import → rollback) handles them like uploaded files.
Credentials are stored AES-GCM encrypted in platform_migration_connectors and never returned to the browser.
File sources (CSV / Excel, SQL dump) need no connection – they are uploaded in the migration wizard.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import logging
import os
import xmlrpc.client
from pathlib import Path
from typing import Callable, Optional

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

logger = logging.getLogger(__name__)

TIMEOUT = 30
FILE_SOURCES = ("CSV / Excel files", "SQL dump / database")


class ConnectorError(Exception):
    """The source rejected the request or could not be reached; the message is shown to platform staff."""


# ─── Credentials at rest ─────────────────────────────────────────────────────

def _key() -> bytes:
    return hashlib.sha256(("migration-connector:" + settings.SECRET_KEY).encode()).digest()


def encrypt_config(config: dict) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_key()).encrypt(nonce, json.dumps(config).encode(), b"connector")).decode()


def decrypt_config(blob: Optional[str]) -> dict:
    if not blob:
        return {}
    raw = base64.b64decode(blob)
    return json.loads(AESGCM(_key()).decrypt(raw[:12], raw[12:], b"connector"))


# ─── HTTP helpers ────────────────────────────────────────────────────────────

def _check(response: requests.Response, vendor: str) -> requests.Response:
    if response.status_code in (401, 403):
        raise ConnectorError(f"{vendor} rejected the credentials ({response.status_code}): {_reason(response)}")
    if response.status_code >= 400:
        raise ConnectorError(f"{vendor} returned HTTP {response.status_code}: {_reason(response)}")
    return response


def _reason(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200] or response.reason
    if isinstance(body, list) and body:
        body = body[0]
    if isinstance(body, dict):
        for key in ("message", "error_description", "error", "errorCode", "msg"):
            value = body.get(key)
            if isinstance(value, dict):
                value = value.get("message") or json.dumps(value)[:200]
            if value:
                return str(value)[:200]
    return json.dumps(body)[:200]


def _call(vendor: str, method: str, url: str, **kwargs) -> requests.Response:
    try:
        return _check(requests.request(method, url, timeout=TIMEOUT, **kwargs), vendor)
    except requests.RequestException as exc:
        raise ConnectorError(f"Could not reach {vendor}: {exc.__class__.__name__}: {str(exc)[:160]}") from exc


def _flat(value) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        for key in ("name", "value", "label", "text", "display_name", "email"):
            if value.get(key) not in (None, ""):
                return _flat(value[key])
        return json.dumps(value, ensure_ascii=False)[:2000]
    if isinstance(value, list):
        if len(value) == 2 and isinstance(value[0], int) and isinstance(value[1], str):  # Odoo many2one [id, name]
            return value[1]
        return "; ".join(_flat(v) for v in value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _url(config: dict, key: str) -> str:
    value = (config.get(key) or "").strip().rstrip("/")
    if not value.startswith("https://"):
        raise ConnectorError(f"{key.replace('_', ' ').capitalize()} must start with https://")
    return value


# ─── Connectors ──────────────────────────────────────────────────────────────
# Each connector: login(config) -> ctx dict (with "account"), count(ctx, obj) -> int|None, rows(ctx, obj) -> iterator of dicts.

class HubSpot:
    method = "Private app token + CRM API v3"
    fields = [("token", "Private app access token", True)]
    objects = ["companies", "contacts", "deals", "quotes", "products", "tasks"]
    base = "https://api.hubapi.com"

    @classmethod
    def login(cls, c):
        h = {"Authorization": f"Bearer {(c.get('token') or '').strip()}"}
        _call("HubSpot", "GET", f"{cls.base}/crm/v3/objects/contacts?limit=1", headers=h)
        try:
            account = f"Portal {_call('HubSpot', 'GET', f'{cls.base}/account-info/v3/details', headers=h).json().get('portalId')}"
        except ConnectorError:
            account = "HubSpot account"
        return {"h": h, "account": account}

    @classmethod
    def count(cls, ctx, obj):
        return _call("HubSpot", "POST", f"{cls.base}/crm/v3/objects/{obj}/search", headers=ctx["h"], json={"limit": 1}).json().get("total")

    @classmethod
    def rows(cls, ctx, obj):
        props = [p["name"] for p in _call("HubSpot", "GET", f"{cls.base}/crm/v3/properties/{obj}", headers=ctx["h"]).json().get("results", [])
                 if not p.get("hidden")][:150]
        after = None
        while True:
            params = {"limit": 100, "properties": ",".join(props), **({"after": after} if after else {})}
            body = _call("HubSpot", "GET", f"{cls.base}/crm/v3/objects/{obj}", headers=ctx["h"], params=params).json()
            for r in body.get("results", []):
                yield {"id": r.get("id"), **{k: _flat(v) for k, v in (r.get("properties") or {}).items()}}
            after = (body.get("paging") or {}).get("next", {}).get("after")
            if not after:
                return


class Pipedrive:
    method = "API token + REST API v1"
    fields = [("token", "API token", True), ("company_domain", "Company domain (optional, yourcompany.pipedrive.com)", False)]
    objects = ["organizations", "persons", "leads", "deals", "products", "activities"]

    @classmethod
    def login(cls, c):
        domain = (c.get("company_domain") or "").strip().replace("https://", "").split("/")[0]
        base = f"https://{domain}/api/v1" if domain else "https://api.pipedrive.com/v1"
        params = {"api_token": (c.get("token") or "").strip()}
        me = _call("Pipedrive", "GET", f"{base}/users/me", params=params).json().get("data") or {}
        return {"base": base, "p": params, "account": me.get("company_name") or me.get("company_domain") or "Pipedrive company"}

    @classmethod
    def count(cls, ctx, obj):
        return None  # Pipedrive has no record-count endpoint; counted while pulling

    @classmethod
    def rows(cls, ctx, obj):
        start = 0
        while True:
            body = _call("Pipedrive", "GET", f"{ctx['base']}/{obj}", params={**ctx["p"], "start": start, "limit": 500}).json()
            for r in body.get("data") or []:
                yield {k: _flat(v) for k, v in r.items()}
            page = (body.get("additional_data") or {}).get("pagination") or {}
            if not page.get("more_items_in_collection"):
                return
            start = page.get("next_start", start + 500)


class ZohoCRM:
    method = "OAuth 2.0 refresh token + CRM API v6"
    fields = [("client_id", "Client ID", False), ("client_secret", "Client secret", True), ("refresh_token", "Refresh token", True),
              ("accounts_domain", "Accounts domain (optional – accounts.zoho.com, .in or .eu)", False)]
    objects = ["Accounts", "Contacts", "Leads", "Deals", "Quotes", "Products", "Tasks"]

    @classmethod
    def login(cls, c):
        domain = (c.get("accounts_domain") or "accounts.zoho.com").strip().replace("https://", "").rstrip("/")
        token = _call("Zoho", "POST", f"https://{domain}/oauth/v2/token", params={
            "grant_type": "refresh_token", "client_id": c.get("client_id"), "client_secret": c.get("client_secret"), "refresh_token": c.get("refresh_token")}).json()
        if "access_token" not in token:
            raise ConnectorError(f"Zoho rejected the credentials: {token.get('error', 'no access token returned')}")
        h = {"Authorization": f"Zoho-oauthtoken {token['access_token']}"}
        api = token.get("api_domain", "https://www.zohoapis.com")
        org = (_call("Zoho", "GET", f"{api}/crm/v6/org", headers=h).json().get("org") or [{}])[0]
        return {"h": h, "api": api, "account": org.get("company_name") or "Zoho CRM org"}

    @classmethod
    def count(cls, ctx, obj):
        return _call("Zoho", "GET", f"{ctx['api']}/crm/v6/{obj}/actions/count", headers=ctx["h"]).json().get("count")

    @classmethod
    def rows(cls, ctx, obj):
        fields = [f["api_name"] for f in _call("Zoho", "GET", f"{ctx['api']}/crm/v6/settings/fields", headers=ctx["h"], params={"module": obj}).json().get("fields", [])][:50]
        token = None
        while True:
            params = {"fields": ",".join(fields), "per_page": 200, **({"page_token": token} if token else {})}
            response = _call("Zoho", "GET", f"{ctx['api']}/crm/v6/{obj}", headers=ctx["h"], params=params)
            if response.status_code == 204:
                return
            body = response.json()
            for r in body.get("data", []):
                yield {k: _flat(v) for k, v in r.items()}
            info = body.get("info") or {}
            token = info.get("next_page_token")
            if not info.get("more_records") or not token:
                return


class Salesforce:
    method = "OAuth 2.0 client credentials + REST API"
    fields = [("instance_url", "My Domain URL (https://yourcompany.my.salesforce.com)", False), ("client_id", "Consumer key", False),
              ("client_secret", "Consumer secret", True)]
    objects = ["Account", "Contact", "Lead", "Opportunity", "Quote", "Product2", "Task"]
    version = "v60.0"

    @classmethod
    def login(cls, c):
        token = _call("Salesforce", "POST", f"{_url(c, 'instance_url')}/services/oauth2/token",
                      data={"grant_type": "client_credentials", "client_id": c.get("client_id"), "client_secret": c.get("client_secret")}).json()
        inst, h = token.get("instance_url") or _url(c, "instance_url"), {"Authorization": f"Bearer {token.get('access_token')}"}
        org = _call("Salesforce", "GET", f"{inst}/services/data/{cls.version}/query", headers=h, params={"q": "SELECT Name FROM Organization"}).json()
        return {"h": h, "inst": inst, "account": (org.get("records") or [{}])[0].get("Name") or "Salesforce org"}

    @classmethod
    def count(cls, ctx, obj):
        return _call("Salesforce", "GET", f"{ctx['inst']}/services/data/{cls.version}/query", headers=ctx["h"], params={"q": f"SELECT COUNT() FROM {obj}"}).json().get("totalSize")

    @classmethod
    def rows(cls, ctx, obj):
        described = _call("Salesforce", "GET", f"{ctx['inst']}/services/data/{cls.version}/sobjects/{obj}/describe", headers=ctx["h"]).json()
        names = [f["name"] for f in described.get("fields", []) if f.get("type") not in ("address", "location", "base64")][:150]
        body = _call("Salesforce", "GET", f"{ctx['inst']}/services/data/{cls.version}/query", headers=ctx["h"], params={"q": f"SELECT {', '.join(names)} FROM {obj}"}).json()
        while True:
            for r in body.get("records", []):
                yield {k: _flat(v) for k, v in r.items() if k != "attributes"}
            if body.get("done", True) or not body.get("nextRecordsUrl"):
                return
            body = _call("Salesforce", "GET", f"{ctx['inst']}{body['nextRecordsUrl']}", headers=ctx["h"]).json()


class Dynamics365:
    method = "Microsoft Entra ID app + Dataverse Web API"
    fields = [("org_url", "Environment URL (https://yourorg.crm.dynamics.com)", False), ("tenant_id", "Directory (tenant) ID", False),
              ("client_id", "Application (client) ID", False), ("client_secret", "Client secret", True)]
    objects = ["accounts", "contacts", "leads", "opportunities", "quotes", "products", "tasks"]

    @classmethod
    def login(cls, c):
        org = _url(c, "org_url")
        token = _call("Microsoft", "POST", f"https://login.microsoftonline.com/{(c.get('tenant_id') or '').strip()}/oauth2/v2.0/token",
                      data={"grant_type": "client_credentials", "client_id": c.get("client_id"), "client_secret": c.get("client_secret"), "scope": f"{org}/.default"}).json()
        h = {"Authorization": f"Bearer {token.get('access_token')}", "Accept": "application/json", "OData-Version": "4.0"}
        _call("Dynamics 365", "GET", f"{org}/api/data/v9.2/WhoAmI", headers=h)
        name = (_call("Dynamics 365", "GET", f"{org}/api/data/v9.2/organizations?$select=name", headers=h).json().get("value") or [{}])[0].get("name")
        return {"h": h, "org": org, "account": name or org}

    @classmethod
    def count(cls, ctx, obj):
        return int(_call("Dynamics 365", "GET", f"{ctx['org']}/api/data/v9.2/{obj}/$count", headers=ctx["h"]).text.strip("﻿ \n") or 0)

    @classmethod
    def rows(cls, ctx, obj):
        url = f"{ctx['org']}/api/data/v9.2/{obj}"
        while url:
            body = _call("Dynamics 365", "GET", url, headers={**ctx["h"], "Prefer": "odata.maxpagesize=500"}).json()
            for r in body.get("value", []):
                yield {k: _flat(v) for k, v in r.items() if not k.startswith("@")}
            url = body.get("@odata.nextLink")


class _Transport(xmlrpc.client.SafeTransport):
    def make_connection(self, host):
        connection = super().make_connection(host)
        connection.timeout = TIMEOUT
        return connection


class Odoo:
    method = "XML-RPC (database, user and API key)"
    fields = [("url", "Odoo URL (https://yourcompany.odoo.com)", False), ("database", "Database", False), ("username", "User (login e-mail)", False),
              ("api_key", "API key", True)]
    objects = ["res.partner", "crm.lead", "sale.order", "product.product"]
    SCALAR = {"char", "text", "html", "integer", "float", "monetary", "date", "datetime", "boolean", "selection", "many2one"}

    @classmethod
    def login(cls, c):
        url = _url(c, "url")
        try:
            common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common", transport=_Transport(), allow_none=True)
            version = common.version().get("server_version", "?")
            uid = common.authenticate(c.get("database"), c.get("username"), c.get("api_key"), {})
        except (OSError, xmlrpc.client.Error) as exc:
            raise ConnectorError(f"Could not reach Odoo: {str(exc)[:200]}") from exc
        if not uid:
            raise ConnectorError("Odoo rejected the database, user or API key")
        models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object", transport=_Transport(), allow_none=True)
        call = lambda model, method, *args, **kw: models.execute_kw(c.get("database"), uid, c.get("api_key"), model, method, list(args), kw)  # noqa: E731
        return {"call": call, "account": f"{c.get('database')} · Odoo {version}"}

    @classmethod
    def count(cls, ctx, obj):
        try:
            return ctx["call"](obj, "search_count", [])
        except xmlrpc.client.Fault as exc:
            raise ConnectorError(f"Odoo: {exc.faultString[:200]}") from exc

    @classmethod
    def rows(cls, ctx, obj):
        meta = ctx["call"](obj, "fields_get", attributes=["type"])
        names = [n for n, m in meta.items() if m.get("type") in cls.SCALAR][:150]
        offset = 0
        while True:
            batch = ctx["call"](obj, "search_read", [], fields=names, offset=offset, limit=500, order="id")
            for r in batch:
                yield {k: "" if v is False and meta.get(k, {}).get("type") != "boolean" else _flat(v) for k, v in r.items()}
            if len(batch) < 500:
                return
            offset += 500


class Monday:
    method = "API v2 token (GraphQL)"
    fields = [("token", "Personal API token", True)]
    objects: list[str] = []  # boards are listed from the account
    api = "https://api.monday.com/v2"

    @classmethod
    def _q(cls, ctx, query, variables=None):
        body = _call("monday.com", "POST", cls.api, headers=ctx["h"], json={"query": query, "variables": variables or {}}).json()
        if body.get("errors") or body.get("error_message"):
            raise ConnectorError(f"monday.com: {(body.get('errors') or [{}])[0].get('message') or body.get('error_message')}")
        return body["data"]

    @classmethod
    def login(cls, c):
        ctx = {"h": {"Authorization": (c.get("token") or "").strip(), "API-Version": "2024-10"}}
        me = cls._q(ctx, "{ me { name account { name } } }")["me"]
        ctx["boards"] = {f"{b['name']} ({b['id']})": b for b in cls._q(ctx, "{ boards(limit: 100) { id name items_count } }")["boards"]}
        ctx["account"] = (me.get("account") or {}).get("name") or me.get("name")
        return ctx

    @classmethod
    def count(cls, ctx, obj):
        return (ctx["boards"].get(obj) or {}).get("items_count")

    @classmethod
    def rows(cls, ctx, obj):
        board = ctx["boards"][obj]["id"]
        item = "id name created_at column_values { column { title } text }"
        page = cls._q(ctx, f"query ($b: [ID!]) {{ boards(ids: $b) {{ items_page(limit: 500) {{ cursor items {{ {item} }} }} }} }}", {"b": [board]})["boards"][0]["items_page"]
        while True:
            for it in page["items"]:
                yield {"id": it["id"], "Name": it["name"], "created_at": it.get("created_at") or "", **{cv["column"]["title"]: cv.get("text") or "" for cv in it["column_values"]}}
            if not page.get("cursor"):
                return
            page = cls._q(ctx, f"query ($c: String!) {{ next_items_page(limit: 500, cursor: $c) {{ cursor items {{ {item} }} }} }}", {"c": page["cursor"]})["next_items_page"]


class GoHighLevel:
    method = "Private integration token + API v2"
    fields = [("token", "Private integration token", True), ("location_id", "Location (sub-account) ID", False)]
    objects = ["contacts", "opportunities"]
    base = "https://services.leadconnectorhq.com"

    @classmethod
    def login(cls, c):
        h = {"Authorization": f"Bearer {(c.get('token') or '').strip()}", "Version": "2021-07-28", "Accept": "application/json"}
        location = (c.get("location_id") or "").strip()
        info = _call("GoHighLevel", "GET", f"{cls.base}/locations/{location}", headers=h).json().get("location") or {}
        return {"h": h, "loc": location, "account": info.get("name") or location}

    @classmethod
    def count(cls, ctx, obj):
        if obj == "contacts":
            return _call("GoHighLevel", "POST", f"{cls.base}/contacts/search", headers=ctx["h"], json={"locationId": ctx["loc"], "pageLimit": 1}).json().get("total")
        return (_call("GoHighLevel", "GET", f"{cls.base}/opportunities/search", headers=ctx["h"], params={"location_id": ctx["loc"], "limit": 1}).json().get("meta") or {}).get("total")

    @classmethod
    def rows(cls, ctx, obj):
        page = 1
        while True:
            if obj == "contacts":
                items = _call("GoHighLevel", "POST", f"{cls.base}/contacts/search", headers=ctx["h"], json={"locationId": ctx["loc"], "pageLimit": 100, "page": page}).json().get("contacts", [])
            else:
                items = _call("GoHighLevel", "GET", f"{cls.base}/opportunities/search", headers=ctx["h"], params={"location_id": ctx["loc"], "limit": 100, "page": page}).json().get("opportunities", [])
            for r in items:
                yield {k: _flat(v) for k, v in r.items()}
            if len(items) < 100:
                return
            page += 1


CONNECTORS = {"Salesforce": Salesforce, "Zoho CRM": ZohoCRM, "HubSpot": HubSpot, "Microsoft Dynamics 365": Dynamics365, "Pipedrive": Pipedrive,
              "Odoo CRM": Odoo, "monday.com": Monday, "GoHighLevel": GoHighLevel}
SOURCES = list(CONNECTORS) + list(FILE_SOURCES)  # prototype order
FILE_INFO = {"CSV / Excel files": ("File upload (.csv, .xlsx)", ["Any sheet"]), "SQL dump / database": ("MariaDB / MySQL dump file (.sql)", ["Any table"])}


def validate(source: str, config: dict) -> dict:
    """Log in and count each object. Returns {"account", "objects": [{"name", "count"}]}; raises ConnectorError."""
    connector = CONNECTORS[source]
    missing = [label for key, label, _ in connector.fields if "optional" not in label and not (config.get(key) or "").strip()]
    if missing:
        raise ConnectorError(f"Fill in: {', '.join(missing)}")
    ctx = connector.login(config)
    objects = []
    for name in (connector.objects or list(ctx.get("boards", {}))):
        try:
            objects.append({"name": name, "count": connector.count(ctx, name)})
        except ConnectorError as exc:
            objects.append({"name": name, "count": None, "error": str(exc)[:200]})
    return {"account": ctx.get("account"), "objects": objects}


def pull(source: str, config: dict, objects: list[str], folder: Path, progress: Callable[[str, int], None]) -> list[tuple[str, str]]:
    """Write each object to <folder>/<object>.csv; returns [(file name, object name)]."""
    connector = CONNECTORS[source]
    ctx = connector.login(config)
    written = []
    for obj in objects:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in obj)[:80] or "object"
        jsonl, columns, count = folder / f"{safe}.jsonl", {}, 0
        with jsonl.open("w", encoding="utf-8") as out:
            for row in connector.rows(ctx, obj):
                for key in row:
                    columns.setdefault(key, None)
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                count += 1
                if count % 500 == 0:
                    progress(obj, count)
        with jsonl.open(encoding="utf-8") as src, (folder / f"{safe}.csv").open("w", encoding="utf-8", newline="") as dst:
            writer = csv.DictWriter(dst, fieldnames=list(columns), restval="")
            writer.writeheader()
            for line in src:
                writer.writerow(json.loads(line))
        jsonl.unlink()
        progress(obj, count)
        written.append((f"{safe}.csv", obj))
    return written

