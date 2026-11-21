"""Security & compliance (Governance): the platform's security posture as the backend actually knows it.

Under ``/security`` (Settings permission, view). Each panel reports real state or says why it is unavailable:

* Compliance controls – Control Center security / identity / privacy controls that the platform enforces and that are on.
* Certifications & frameworks – the Control Center framework switches (Data residency & compliance).
* Data subject requests, support impersonation – not handled on this platform yet (no request store, no impersonation).
* Encryption keys (KMS) – read from the MariaDB server: shown only when data-at-rest encryption is enabled.
* Critical vulnerabilities – no vulnerability scanner is connected.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_master_db_dep
from app.services import platform_controls as controls
from app.services.platform_access import enforce_platform_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/platform/security", dependencies=[Depends(enforce_platform_access)])

# Control Center categories that make up the security & compliance posture.
POSTURE_CATEGORIES = ("Identity, SSO & directory", "Authentication policy", "Platform roles & four-eyes", "Support & impersonation",
                      "Security & threat protection", "Data residency & compliance", "Privacy & data requests")
# Prototype framework rows → Control Center switches.
FRAMEWORKS = [("ISO 27001", "compIso"), ("SOC 2 Type II", "compSoc"), ("GDPR", "compGdpr"), ("India DPDP Act", "compDpdp"),
              ("HIPAA (optional add-on)", "compHipaa")]
ENFORCED = ("live", "fixed")


def _posture(values: dict, catalogue: list[dict]) -> dict:
    items = [c for cat in catalogue if cat["name"] in POSTURE_CATEGORIES for g in cat["groups"] for c in g["controls"]]
    in_force = [c for c in items if c["status"] in ENFORCED and (c["type"] != "sw" or values[c["key"]] is True)]
    return {"in_force": len(in_force), "total": len(items), "percent": round(100 * len(in_force) / len(items)) if items else None,
            "categories": list(POSTURE_CATEGORIES)}


def _encryption(db: Session) -> dict:
    """Data-at-rest encryption of the platform's MariaDB server; key rows only when it is actually on."""
    try:
        variables = dict(db.execute(text("SHOW VARIABLES WHERE Variable_name IN ('innodb_encrypt_tables', 'innodb_encrypt_log')")).all())
        plugins = [r[0] for r in db.execute(text("SELECT PLUGIN_NAME FROM information_schema.PLUGINS "
                                                     "WHERE PLUGIN_TYPE = 'ENCRYPTION' AND PLUGIN_STATUS = 'ACTIVE'")).all()]
    except Exception as exc:  # noqa: BLE001 - reported as unavailable, never guessed
        logger.warning("Encryption status unavailable: %s", exc)
        return {"available": False, "reason": "The database server's encryption status could not be read", "keys": []}
    on = str(variables.get("innodb_encrypt_tables", "OFF")).upper() in ("ON", "FORCE")
    if not plugins or not on:
        why = "no key-management plugin is loaded" if not plugins else "table encryption (innodb_encrypt_tables) is off"
        return {"available": False, "reason": f"Data-at-rest encryption is not enabled on the MariaDB server: {why}", "keys": [],
                "plugin": plugins[0] if plugins else None, "encrypt_tables": variables.get("innodb_encrypt_tables"),
                "encrypt_log": variables.get("innodb_encrypt_log")}
    # Key id / version per tenant database; MariaDB records no rotation dates, so those stay empty.
    rows = db.execute(text(
        "SELECT SUBSTRING_INDEX(NAME, '/', 1) AS db_name, CURRENT_KEY_ID, MAX(CURRENT_KEY_VERSION) "
        "FROM information_schema.INNODB_TABLESPACES_ENCRYPTION WHERE NAME LIKE 'digitcrm\\_%' "
        "GROUP BY SUBSTRING_INDEX(NAME, '/', 1), CURRENT_KEY_ID ORDER BY 1")).all()
    return {"available": True, "reason": None, "plugin": plugins[0], "keys": [
        {"key": f"{r[0]} · key {r[1]} v{r[2]}", "rotated": None, "next": None} for r in rows]}


@router.get("")
def overview(db: Session = Depends(get_master_db_dep)):
    values = controls.platform_values(db)
    return {
        "compliance": _posture(values, controls.schema(db)),
        "frameworks": [{"name": name, "key": key, "enabled": bool(values[key])} for name, key in FRAMEWORKS],
        "dsr": {"available": False, "reason": "Data-subject requests are not handled on this platform yet", "items": []},
        "vulnerabilities": {"available": False, "reason": "No vulnerability scanner is connected"},
        "encryption": _encryption(db),
        "impersonation": {"available": False, "items": [],
                          "reason": "Support impersonation isn't available: Open workspace only opens the tenant's sign-in page"},
    }
