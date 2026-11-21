from __future__ import annotations

import logging
from typing import Optional, Sequence

from sqlalchemy.orm import Session

from app.models.all_models import Module, Permission, Role, RolePermission
from app.services.cache_service import invalidate_permissions_cache

logger = logging.getLogger(__name__)

# Sidebar groups in Bidwise prototype v17 order (NAV): Home · Sales · Finance & Field · Intelligence ·
# Automation & Control · Directory · Administration. The older keys stay for custom / legacy modules.
SECTION_SORT_ORDER: dict[str, int] = {
    "home": 10,
    "main": 10,
    "sales": 20,
    "finance": 30,
    "intelligence": 40,
    "automation": 50,
    "management": 50,
    "directory": 60,
    "config": 60,
    "admin": 70,
}

SYSTEM_MODULES = {"dashboard", "users", "settings", "roles"}
# Form Builder is tenant-configurable, like Customers and the other optional
# application modules. Keep only genuinely global modules in this set.
# Notes & Pinboard holds each user's own notes (no permission key), like the header note editor before it.
# Process Designer and Customization Studio are administration (like Settings / Roles): always present, gated by their permissions.
ALWAYS_ENABLED_PERMISSION_MODULES = SYSTEM_MODULES | {"approvals", "oems", "notes", "announcements", "team_chat", "workflow", "form_builder", "datahub", "automation_studio", "funnel_analytics"}
# NOTE: "team_chat" stays in this set so its PERMISSIONS are always seeded/available
# (the footer widget and /team-chat route still need team_chat.use etc.) — it's removed
# from DEFAULT_TENANT_MODULES instead, which is what actually controls the sidebar row.

FEATURE_MODULE_ALIASES: dict[str, tuple[str, ...]] = {
    "dashboard": ("dashboard",),
    "customers": ("customers",),
    "questionnaire": ("questionnaire",),
    # Lead capture forms (web-to-lead) ship with the Leads feature.
    # Forecasts are built from deals, so they ship with the Leads / Deals feature.
    "leads": ("leads", "opportunities", "capture_forms", "forecasts"),
    "tenders": ("tenders",),
    # Product & Price Books (catalogue + price books) ships with Quotes – the quote "From catalog" picker reads it.
    "quotations": ("quotations", "products"),
    "workorders": ("workorders",),
    "emdbg": ("emdbg",),
    "kam": ("kam",),
    "travel": ("travel",),
    "reports": ("reports",),
    "report_engine": ("report_engine",),
    "insights": ("insights",),
    "alerts": ("alerts",),
    # Calendar & Tasks sits with Inbox & Notifications in the Home group and ships with that feature.
    "notifications": ("notifications", "calendar"),
    "roles": ("roles",),
    "masters": ("masters", "competitors"),
    "competitors": ("competitors",),
    "integrations": ("integrations",),
    "workflow": ("workflow",),
    "rfp": ("rfp",),
    "document_management": ("document_management",),
    "letter_management": ("letter_management",),
    "recycle_bin": ("recycle_bin",),
    "audit_logs": ("audit_logs",),
    "users": ("users",),
    "settings": ("settings",),
    "team_chat": ("team_chat",),
}

# module key → (old default display names, old singulars) – compared lower-case with spaces squeezed; see
# upsert_default_tenant_modules. A tenant whose display name is still one of these old defaults gets the current
# label on the next backend start (real custom renames are kept).
LEGACY_DEFAULT_NAMES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "workorders": (("work orders", "work order"), ("work order",)),
    "kam": (("kam 360", "kam"), ("kam activity",)),
    "travel": (("travel management", "travel"), ("travel request",)),
    # prototype v17 / v18 names: Customers & Contacts · Deals · Bids & Tenders · Quotes · Guarantees & Deposits
    "customers": (("customers", "customer", "customer master"), ("customer",)),
    "opportunities": (("opportunities", "opportunity"), ("opportunity",)),
    "tenders": (("tenders", "tender", "tender management", "bids", "bid"), ("tender", "bid")),
    "quotations": (("quotations", "quotation"), ("quotation",)),
    "emdbg": (("emd / bg", "emd/bg", "emd bg", "emd & bg", "emd and bg", "emd / bg management"), ("emd / bg", "emd/bg", "emd bg")),
}


def _legacy_norm(v: object) -> str:
    """'EMD/BG ' → 'emd / bg' – case, surrounding spaces and spacing around '/' and '&' do not matter."""
    import re
    s = re.sub(r"\s*([/&])\s*", r" \1 ", str(v or "").strip().lower())
    return re.sub(r"\s+", " ", s).strip()

DEFAULT_TENANT_MODULES: list[dict[str, object]] = [
    {
        "key": "audit_logs", "label": "Audit Logs", "icon": "eye",
        "route": "/audit-logs", "section": "admin", "sort_order": 76,
        "parent_key": None, "permission_key": "audit_logs.view",
        "is_active": True, "is_system": False,
    },
    {
        "key": "dashboard",
        "label": "Dashboards",
        "icon": "home",
        "route": "/dashboard",
        "section": "home",
        "sort_order": 10,
        "parent_key": None,
        "permission_key": "dashboard.view",
        "is_active": True,
        "is_system": True,
    },
    {
        "key": "customers",
        "label": "Customers & Contacts",
        "icon": "building",
        "route": "/customers",
        "section": "sales",
        "sort_order": 20,
        "parent_key": None,
        "permission_key": "customers.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "questionnaire",
        "label": "Questionnaire",
        "icon": "edit",
        "route": "/questionnaire",
        "section": "sales",
        "sort_order": 29,
        "parent_key": None,
        "permission_key": "questionnaire.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "leads",
        "label": "Leads",
        "icon": "funnel",
        "route": "/leads",
        "section": "sales",
        "sort_order": 22,
        "parent_key": None,
        "permission_key": "leads.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "capture_forms",
        "label": "Capture Forms",
        "icon": "layout",
        "route": "/capture-forms",
        "section": "sales",
        "sort_order": 23,
        "parent_key": None,
        "permission_key": "capture_forms.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "opportunities",
        "label": "Deals",
        "icon": "target",
        "route": "/opportunities",
        "section": "sales",
        "sort_order": 24,
        "parent_key": None,
        "permission_key": "opportunities.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "tenders",
        "label": "Bids & Tenders",
        "icon": "file",
        "route": "/tenders",
        "section": "sales",
        "sort_order": 25,
        "parent_key": None,
        "permission_key": "tenders.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "quotations",
        "label": "Quotes",
        "icon": "doc",
        "route": "/quotations",
        "section": "sales",
        "sort_order": 26,
        "parent_key": None,
        "permission_key": "quotations.view",
        "is_active": True,
        "is_system": False,
    },
    {
        # prototype v17 NAV: Sales → Product & Price Books (icon tag), between Quotes and Forecasts / Orders
        "key": "products",
        "label": "Product & Price Books",
        "icon": "tag",
        "route": "/products",
        "section": "sales",
        "sort_order": 27,
        "parent_key": None,
        "permission_key": "products.view",
        "is_active": True,
        "is_system": False,
    },
    {
        # prototype v17 NAV: Sales → Forecasts (icon chart), after Product & Price Books, before Orders & Projects
        "key": "forecasts",
        "label": "Forecasts",
        "icon": "chart",
        "route": "/forecasts",
        "section": "sales",
        "sort_order": 28,           # same as Orders & Projects – the label tie-break keeps Forecasts first
        "parent_key": None,
        "permission_key": "forecasts.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "workorders",
        "label": "Orders & Projects",
        "icon": "brief",
        "route": "/workorders",
        "section": "sales",
        "sort_order": 28,
        "parent_key": None,
        "permission_key": "workorders.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "emdbg",
        "label": "Guarantees & Deposits",
        "icon": "shield",
        "route": "/emdbg",
        "section": "finance",
        "sort_order": 30,
        "parent_key": None,
        "permission_key": "emdbg.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "kam",
        "label": "Field Sales 360",
        "icon": "users",
        "route": "/kam",
        "section": "finance",
        "sort_order": 31,
        "parent_key": None,
        "permission_key": "kam.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "travel",
        "label": "Travel & Expense",
        "icon": "plane",
        "route": "/travel",
        "section": "finance",
        "sort_order": 32,
        "parent_key": None,
        "permission_key": "travel.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "rfp",
        "label": "RFP Analysis",
        "icon": "scan",
        "route": "/rfp",
        "section": "intelligence",
        "sort_order": 40,
        "parent_key": None,
        "permission_key": "rfp.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "automation_studio",
        "label": "Automation Studio",
        "icon": "git",
        "route": "/automation-studio",
        "section": "automation",
        "sort_order": 50,
        "parent_key": None,
        "permission_key": "automation.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "approvals",
        "label": "Approvals",
        "icon": "check",
        "route": "/approvals",
        "section": "automation",
        "sort_order": 51,
        "parent_key": None,
        "permission_key": "approvals.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "document_management",
        "label": "Document Hub",
        "icon": "folder",
        "route": "/document-management",
        "section": "automation",
        "sort_order": 52,
        "parent_key": None,
        "permission_key": "document_management.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "letter_management",
        "label": "Correspondence",
        "icon": "mail",
        "route": "/letter-management",
        "section": "automation",
        "sort_order": 53,
        "parent_key": None,
        "permission_key": "letter_management.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "datahub",
        "label": "Data Hub",
        "icon": "db",
        "route": "/datahub",
        "section": "automation",
        "sort_order": 66,
        "parent_key": None,
        "permission_key": "datahub.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "recycle_bin",
        "label": "Recycle Bin",
        "icon": "trash",
        "route": "/recycle-bin",
        "section": "admin",
        "sort_order": 99,
        "parent_key": None,
        "permission_key": "recycle_bin.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "report_engine",
        "label": "Analytics",
        "icon": "pie",
        "route": "/intelligence/analytics",
        "section": "intelligence",
        "sort_order": 44,
        "parent_key": None,
        "permission_key": "report_engine.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "funnel_analytics",
        "label": "Funnel",
        "icon": "funnel",
        "route": "/funnel",
        "section": "intelligence",
        "sort_order": 42,
        "parent_key": None,
        "permission_key": "funnel.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "reports",
        "label": "Reports",
        "icon": "table",
        "route": "/analytics",
        "section": "intelligence",
        "sort_order": 43,
        "parent_key": None,
        "permission_key": "reports.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "insights",
        "label": "AI Copilot",
        "icon": "spark",
        "route": "/insights",
        "section": "intelligence",
        "sort_order": 41,
        "parent_key": None,
        "permission_key": "insights.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "alerts",
        "label": "Alerts",
        "icon": "alert",
        "route": "/alerts",
        "section": "intelligence",
        "sort_order": 45,
        "parent_key": None,
        "permission_key": "alerts.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "notifications",
        "label": "Inbox & Notifications",
        "icon": "bell",
        "route": "/notifications",
        "section": "home",
        "sort_order": 15,
        "parent_key": None,
        "permission_key": "notifications.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "calendar",
        "label": "Calendar & Tasks",
        "icon": "cal",
        "route": "/calendar",
        "section": "home",
        "sort_order": 16,
        "parent_key": None,
        "permission_key": "calendar.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "notes",
        "label": "Notes & Pinboard",
        "icon": "note",
        "route": "/notes",
        "section": "home",
        "sort_order": 17,
        "parent_key": None,
        "permission_key": None,
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "oems",
        "label": "Partners & OEM",
        "icon": "chip",
        "route": "/oems",
        "section": "directory",
        "sort_order": 60,
        "parent_key": None,
        "permission_key": "oems.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "masters",
        "label": "Masters",
        "icon": "db",
        "route": "/masters",
        "section": "directory",
        "sort_order": 62,
        "parent_key": None,
        "permission_key": "masters.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "competitors",
        "label": "Competitive Intel",
        "icon": "scale",
        "route": "/competitors",
        "section": "directory",
        "sort_order": 61,
        "parent_key": None,
        "permission_key": "competitors.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "users",
        "label": "Users & Teams",
        "icon": "user",
        "route": "/users",
        "section": "admin",
        "sort_order": 70,
        "parent_key": None,
        "permission_key": "users.view",
        "is_active": True,
        "is_system": True,
    },
    {
        "key": "announcements",
        "label": "Announcements",
        "icon": "megaphone",
        "route": "/announcements",
        "section": "home",
        "sort_order": 18,           # after Notes & Pinboard (prototype Home order; Announcements is app-only)
        "parent_key": None,
        "permission_key": "announcements.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "roles",
        "label": "Roles & Security",
        "icon": "lock",
        "route": "/roles",
        "section": "admin",
        "sort_order": 71,
        "parent_key": None,
        "permission_key": "roles.view",
        "is_active": True,
        "is_system": True,
    },
    {
        "key": "settings",
        "label": "Settings",
        "icon": "gear",
        "route": "/settings",
        "section": "admin",
        "sort_order": 75,
        "parent_key": None,
        "permission_key": "settings.view",
        "is_active": True,
        "is_system": True,
    },
    {
        "key": "integrations",
        "label": "Marketplace & API",
        "icon": "plug",
        "route": "/integrations",
        "section": "admin",
        "sort_order": 74,
        "parent_key": None,
        "permission_key": "integrations.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "workflow",
        "label": "Process Designer",
        "icon": "flow",
        "route": "/workflow",
        "section": "admin",
        "sort_order": 72,
        "parent_key": None,
        "permission_key": "workflow.view",
        "is_active": True,
        "is_system": False,
    },
    {
        "key": "form_builder",
        "label": "Customization Studio",
        "icon": "layout",
        "route": "/form-builder",
        "section": "admin",
        "sort_order": 73,
        "parent_key": None,
        "permission_key": "form_builder.manage",
        "is_active": True,
        "is_system": False,
    },
    {
        # Kept as a normal, active module (so Roles & Permissions can still manage
        # team_chat.* here) — it's just excluded from the rendered sidebar nav list
        # on the frontend (Sidebar.tsx SIDEBAR_HIDDEN_MODULE_KEYS), since it's reached
        # from the footer bar's floating Team Chat widget instead of a sidebar page.
        "key": "team_chat", "label": "Team Chat", "icon": "users",
        "route": "/team-chat", "section": "home", "sort_order": 15,
        "parent_key": None, "permission_key": "team_chat.use",
        "is_active": True, "is_system": False,
    },
]

DEFAULT_TENANT_MODULE_KEYS = {
    str(item["key"])
    for item in DEFAULT_TENANT_MODULES
}

DEFAULT_TENANT_PERMISSIONS: list[tuple[str, str, str, str]] = [
    ("audit_logs.view", "audit_logs", "view", "View tenant audit logs"),
    ("dashboard.view", "dashboard", "view", "View dashboard"),
    ("dashboard.customers.view", "dashboard", "customers", "View Customers dashboard"),
    ("dashboard.leads.view", "dashboard", "leads", "View Leads dashboard"),
    ("dashboard.tenders.view", "dashboard", "tenders", "View Tenders dashboard"),
    ("dashboard.emdbg.view", "dashboard", "emdbg", "View EMD / BG dashboard"),
    ("dashboard.kam360.view", "dashboard", "kam360", "View KAM 360 dashboard"),
    ("dashboard.travel.view", "dashboard", "travel", "View Travel dashboard"),
    ("dashboard.login_tracker.view", "dashboard", "login_tracker", "View Login Tracker dashboard"),
    ("dashboard.deals.view", "dashboard", "deals", "View Deals dashboard"),
    ("dashboard.orders.view", "dashboard", "orders", "View Orders & delivery dashboard"),
    ("dashboard.finance.view", "dashboard", "finance", "View Finance dashboard"),
    ("customers.view", "customers", "view", "View customers"),
    ("customers.create", "customers", "create", "Create customers"),
    ("customers.update", "customers", "update", "Update customers"),
    ("customers.delete", "customers", "delete", "Delete customers"),
    ("customers.export", "customers", "export", "Export customers"),
    ("questionnaire.view", "questionnaire", "view", "View questionnaires"),
    ("questionnaire.create", "questionnaire", "create", "Create questionnaires"),
    ("questionnaire.update", "questionnaire", "update", "Update questionnaires"),
    ("questionnaire.delete", "questionnaire", "delete", "Delete questionnaires"),
    ("leads.view", "leads", "view", "View leads"),
    ("capture_forms.view", "capture_forms", "view", "View lead capture forms, their submissions and KPIs"),
    ("capture_forms.create", "capture_forms", "create", "Create lead capture forms"),
    ("capture_forms.update", "capture_forms", "update", "Configure, publish and test lead capture forms"),
    ("leads.create", "leads", "create", "Create leads"),
    ("leads.update", "leads", "update", "Update leads"),
    ("leads.delete", "leads", "delete", "Delete leads"),
    ("leads.export", "leads", "export", "Export leads"),
    ("opportunities.view", "opportunities", "view", "View opportunities"),
    ("opportunities.create", "opportunities", "create", "Create opportunities"),
    ("opportunities.update", "opportunities", "update", "Update opportunities"),
    ("opportunities.delete", "opportunities", "delete", "Delete opportunities"),
    ("opportunities.export", "opportunities", "export", "Export opportunities"),
    ("tenders.view", "tenders", "view", "View tenders"),
    ("tenders.create", "tenders", "create", "Create tenders"),
    ("tenders.update", "tenders", "update", "Update tenders"),
    ("tenders.delete", "tenders", "delete", "Delete tenders"),
    ("tenders.export", "tenders", "export", "Export tenders"),
    ("quotations.view", "quotations", "view", "View quotations"),
    ("quotations.create", "quotations", "create", "Create quotations"),
    ("quotations.update", "quotations", "update", "Update quotations"),
    ("quotations.delete", "quotations", "delete", "Delete quotations"),
    ("quotations.export", "quotations", "export", "Export quotations"),
    ("quotations.manage", "quotations", "manage", "Manage quotation actions"),
    ("products.view", "products", "view", "View the product catalogue and price books"),
    ("products.create", "products", "create", "Create products and price books, import products"),
    ("products.update", "products", "update", "Edit products, prices, price books and overrides"),
    ("products.delete", "products", "delete", "Delete products and price books"),
    ("products.export", "products", "export", "Export the product catalogue"),
    ("forecasts.view", "forecasts", "view", "View forecasts (deals in the role's opportunity data scope)"),
    ("forecasts.adjust", "forecasts", "adjust", "Edit manager adjustments for reps in the team"),
    ("forecasts.submit", "forecasts", "submit", "Submit the forecast of a period for approval"),
    ("workorders.view", "workorders", "view", "View work orders"),
    ("workorders.create", "workorders", "create", "Create work orders"),
    ("workorders.update", "workorders", "update", "Update work orders"),
    ("workorders.delete", "workorders", "delete", "Delete work orders"),
    ("workorders.export", "workorders", "export", "Export work orders"),
    ("emdbg.view", "emdbg", "view", "View EMD / BG"),
    ("emdbg.create", "emdbg", "create", "Create EMD / BG"),
    ("emdbg.update", "emdbg", "update", "Update EMD / BG"),
    ("emdbg.delete", "emdbg", "delete", "Delete EMD / BG"),
    ("emdbg.export", "emdbg", "export", "Export EMD / BG"),
    ("emdbg.approve", "emdbg", "approve", "Confirm instrument release / record expiry (finance)"),
    ("kam.view", "kam", "view", "View KAM"),
    ("kam.create", "kam", "create", "Create KAM activities"),
    ("kam.update", "kam", "update", "Update KAM activities"),
    ("kam.delete", "kam", "delete", "Delete KAM activities"),
    ("kam.export", "kam", "export", "Export KAM activities"),
    ("travel.view", "travel", "view", "View travel and TA / DA"),
    ("travel.create", "travel", "create", "Create travel requests and TA / DA claims"),
    ("travel.update", "travel", "update", "Update travel requests and TA / DA claims"),
    ("travel.delete", "travel", "delete", "Delete TA / DA attachments"),
    ("travel.export", "travel", "export", "Export travel and TA / DA"),
    ("rfp.view", "rfp", "view", "View RFP analysis"),
    ("funnel.view", "funnel_analytics", "view", "View Funnel & analytics"),
    ("automation.view", "automation_studio", "view", "View Automation Studio"),
    ("automation.manage", "automation_studio", "manage", "Create and run workflow rules, scoring, assignment and SLA watchers"),
    ("approvals.view", "approvals", "view", "View approvals"),
    ("document_management.view", "document_management", "view", "View document management"),
    ("document_management.create", "document_management", "create", "Create folders and upload documents"),
    ("document_management.update", "document_management", "update", "Edit folders and restore documents"),
    ("document_management.delete", "document_management", "delete", "Delete folders and documents"),
    ("document_management.export", "document_management", "export", "Export document management data"),
    ("document_management.share", "document_management", "share", "Share documents with users"),
    ("document_management.approve", "document_management", "approve", "Approve or reject documents submitted for approval"),
    ("letter_management.view", "letter_management", "view", "View letter management"),
    ("letter_management.create", "letter_management", "create", "Create letters"),
    ("letter_management.update", "letter_management", "update", "Update letters"),
    ("letter_management.delete", "letter_management", "delete", "Delete letters"),
    ("letter_management.export", "letter_management", "export", "Export letter management data"),
    ("datahub.view", "datahub", "view", "View the Data Hub"),
    ("datahub.manage", "datahub", "manage", "Import, migrate, merge, mass-update and export data"),
    ("recycle_bin.view", "recycle_bin", "view", "View recycle bin"),
    ("recycle_bin.restore", "recycle_bin", "restore", "Restore records from recycle bin"),
    ("recycle_bin.delete", "recycle_bin", "delete", "Permanently delete recycle bin records"),
    ("report_engine.view", "report_engine", "view", "Build and run custom reports"),
    ("reports.view", "reports", "view", "View analytical reports"),
    ("reports.view_all_data", "reports", "view_all_data", "View all users' data in reports (override team/own scope)"),
    ("reports.export", "reports", "export", "Export reports (PDF / Excel / CSV)"),
    ("reports.schedule", "reports", "schedule", "Schedule reports for e-mail delivery"),
    ("reports.share", "reports", "share", "E-mail reports"),
    ("insights.view", "insights", "view", "View AI Insights"),
    ("reports.leads.view",         "reports", "leads",         "View Leads report tab"),
    ("reports.opportunities.view", "reports", "opportunities", "View Opportunities report tab"),
    ("reports.tenders.view",       "reports", "tenders",       "View Tenders report tab"),
    ("reports.quotations.view",    "reports", "quotations",    "View Quotations report tab"),
    ("reports.customers.view",     "reports", "customers",     "View Customers report tab"),
    ("reports.workorders.view", "reports", "workorders", "View Work Orders report tab"),
    ("reports.emdbg.view",      "reports", "emdbg",      "View EMD/BG report tab"),
    ("reports.kam.view",        "reports", "kam",        "View KAM Activities report tab"),
    ("reports.travel.view",      "reports", "travel",     "View Travel report tab"),
    ("reports.tada.view",        "reports", "tada",        "View TA/DA Claims report tab"),
    ("reports.oem.view",         "reports", "oem",         "View OEM report tab"),
    ("reports.competitors.view", "reports", "competitors", "View Competitors report tab"),
    ("reports.questionnaire.view", "reports", "questionnaire", "View Questionnaire report tab"),
    ("alerts.view", "alerts", "view", "View alerts"),
    ("notifications.view", "notifications", "view", "View notifications"),
    ("calendar.view", "calendar", "view", "View calendar & tasks"),
    ("calendar.create", "calendar", "create", "Create tasks"),
    ("calendar.update", "calendar", "update", "Edit tasks and change task status"),
    ("calendar.delete", "calendar", "delete", "Delete tasks"),
    ("announcements.view", "announcements", "view", "View team announcements"),
    ("announcements.create", "announcements", "create", "Post announcements to the team (can be scheduled for a future date)"),
    ("announcements.delete", "announcements", "delete", "Delete any announcement posted in the tenant"),
    ("oems.view", "oems", "view", "View OEMs"),
    ("oems.create", "oems", "create", "Create OEMs"),
    ("oems.update", "oems", "update", "Update OEMs"),
    ("oems.delete", "oems", "delete", "Delete OEMs"),
    ("oems.export", "oems", "export", "Export OEMs"),
    ("masters.view", "masters", "view", "View masters"),
    ("masters.manage", "masters", "manage", "Manage masters — values, custom masters, parent › child links"),
    ("competitors.view", "competitors", "view", "View competitors"),
    ("competitors.create", "competitors", "create", "Create competitors"),
    ("competitors.update", "competitors", "update", "Update competitors"),
    ("competitors.delete", "competitors", "delete", "Delete competitors"),
    ("competitors.export", "competitors", "export", "Export competitors"),
    ("roles.view", "roles", "view", "View roles"),
    ("roles.manage", "roles", "manage", "Manage roles"),
    ("users.view", "users", "view", "View users"),
    ("users.manage", "users", "manage", "Manage users"),
    ("settings.view", "settings", "view", "View settings"),
    ("settings.manage", "settings", "manage", "Manage settings"),
    ("modules.rename", "settings", "rename", "Rename module labels in sidebar"),
    ("integrations.view", "integrations", "view", "View integrations"),
    ("integrations.manage", "integrations", "manage", "Manage integrations — connect apps, API keys and webhooks"),
    ("workflow.view", "workflow", "view", "View the Process Designer"),
    ("workflow.manage", "workflow", "manage", "Manage the Process Designer — stages, pipelines, conversion rules"),
    ("form_builder.manage", "form_builder", "manage", "Manage Form Builder — customize field labels and add custom fields"),
    # action is "view"/"create"/"update"/"delete"/"export" (not the key) so these line up with the
    # fixed VIEW/CREATE/EDIT/DELETE/EXPORT columns in Roles & Permissions (Rolespage.tsx ACTION_ORDER) —
    # a module whose actions don't match that fixed list renders as "–" (not applicable) for that
    # column, with no way for an admin to grant it from the matrix at all.
    ("team_chat.use", "team_chat", "view", "Use Team Chat — send and read individual/group messages"),
    ("team_chat.create_group", "team_chat", "create", "Create group conversations"),
    ("team_chat.manage_group", "team_chat", "update", "Rename groups, change avatar/members, admins, announcement mode"),
    ("team_chat.delete_group", "team_chat", "delete", "Delete a group conversation"),
    ("team_chat.delete_any_message", "team_chat", "delete_any_message", "Delete another member's message"),
    ("team_chat.export", "team_chat", "export", "Export a conversation's history"),
    ("team_chat.share_crm_records", "team_chat", "share_crm_records", "Share Leads/Customers/Quotations/Tenders/Work Orders into chat"),
]

DASHBOARD_TAB_PERMISSION_KEYS = tuple(
    key
    for key, module_name, action, _ in DEFAULT_TENANT_PERMISSIONS
    if module_name == "dashboard" and action != "view"
)

LEGACY_DASHBOARD_TAB_ROLE_NAMES = ("ceo", "vp", "manager")


def _normalize_enabled_modules(enabled_feature_keys: Optional[Sequence[str]]) -> Optional[set[str]]:
    if enabled_feature_keys is None:
        return None

    enabled_modules = set(ALWAYS_ENABLED_PERMISSION_MODULES)
    for feature_key in enabled_feature_keys:
        module_key = str(feature_key or "").strip().lower().split(".", 1)[0]
        if not module_key:
            continue
        enabled_modules.update(FEATURE_MODULE_ALIASES.get(module_key, (module_key,)))
    return enabled_modules


def get_seed_permissions_for_enabled_features(
    enabled_feature_keys: Optional[Sequence[str]] = None,
) -> list[tuple[str, str, str, str]]:
    enabled_modules = _normalize_enabled_modules(enabled_feature_keys)
    if enabled_modules is None:
        return list(DEFAULT_TENANT_PERMISSIONS)

    enabled_keys_set = set(enabled_feature_keys or [])
    result = []
    for key, module_name, action, description in DEFAULT_TENANT_PERMISSIONS:
        if module_name not in enabled_modules:
            continue
        # Sub-feature permissions (e.g. reports.kam.view, dashboard.leads.view) must
        # be explicitly present in enabled_feature_keys — module-level enablement alone
        # is not sufficient for these granular toggles.
        if len(key.split(".")) > 2 and key not in enabled_keys_set:
            continue
        result.append((key, module_name, action, description))
    return result


def upsert_default_tenant_modules(
    db: Session,
    enabled_feature_keys: Optional[Sequence[str]] = None,
) -> None:
    """Upsert all default modules and set is_active based on enabled features.

    System modules and always-enabled modules are never deactivated.
    All other modules are activated only when their corresponding feature key
    is present in enabled_feature_keys (None means no restriction — all active).
    """
    enabled_modules = _normalize_enabled_modules(enabled_feature_keys)

    existing_modules = {
        row.key: row
        for row in db.query(Module).filter(
            Module.key.in_([str(item["key"]) for item in DEFAULT_TENANT_MODULES])
        ).all()
    }

    for item in DEFAULT_TENANT_MODULES:
        key = str(item["key"])
        module = existing_modules.get(key)
        if not module:
            module = Module(key=key)
            db.add(module)

        module.label = str(item["label"])
        module.icon = str(item["icon"])
        module.route = str(item["route"])
        module.section = str(item["section"])
        module.sort_order = int(item["sort_order"])
        module.parent_key = item["parent_key"]
        module.permission_key = item["permission_key"]
        module.is_system = bool(item["is_system"])
        # prototype v17 renamed Work Orders → Orders & Projects: a display name that is just the old default is not a
        # tenant customisation, so it is cleared and the module shows its current label (real renames are kept).
        if key in LEGACY_DEFAULT_NAMES:
            plurals, singulars = LEGACY_DEFAULT_NAMES[key]
            if _legacy_norm(getattr(module, "display_name", None)) in {_legacy_norm(x) for x in plurals}:
                module.display_name = None
            if _legacy_norm(getattr(module, "display_name_singular", None)) in {_legacy_norm(x) for x in singulars}:
                module.display_name_singular = None

        # System modules (dashboard, users, roles, settings) are permanently active
        if bool(item["is_system"]) or key in ALWAYS_ENABLED_PERMISSION_MODULES:
            module.is_active = True
        elif enabled_modules is None:
            # No feature filter supplied — activate everything (fresh provision)
            module.is_active = True
        else:
            module.is_active = key in enabled_modules


def upsert_default_tenant_permissions(
    db: Session,
    enabled_feature_keys: Optional[Sequence[str]] = None,
) -> set[str]:
    permission_rows = get_seed_permissions_for_enabled_features(enabled_feature_keys)
    existing_permissions = {
        row.key: row
        for row in db.query(Permission).filter(
            Permission.key.in_([key for key, _, _, _ in permission_rows])
        ).all()
    }
    created_keys: set[str] = set()

    for key, module_name, action, description in permission_rows:
        permission = existing_permissions.get(key)
        if not permission:
            permission = Permission(key=key)
            db.add(permission)
            created_keys.add(key)

        permission.module = module_name
        permission.action = action
        permission.description = description

    return created_keys


def _grant_permissions_to_role(
    db: Session,
    role: Role,
    permission_keys: Sequence[str],
) -> None:
    if not permission_keys:
        return

    permissions = db.query(Permission).filter(Permission.key.in_(list(permission_keys))).all()
    if not permissions:
        return

    permission_ids = [permission.id for permission in permissions]
    existing_permission_ids = {
        row.permission_id
        for row in db.query(RolePermission).filter(
            RolePermission.role_id == role.id,
            RolePermission.permission_id.in_(permission_ids),
        ).all()
    }

    for permission in permissions:
        if permission.id in existing_permission_ids:
            continue
        db.add(RolePermission(role_id=role.id, permission_id=permission.id))


CALENDAR_PERMISSION_KEYS = ("calendar.view", "calendar.create", "calendar.update", "calendar.delete")
# Everyone can read announcements by default; posting ("announcements.create") stays
# admin-only (granted below with the rest of the admin role's permissions) until a
# tenant admin opts another role in from Roles & Permissions.
ANNOUNCEMENT_VIEW_PERMISSION_KEY = "announcements.view"
# Team Chat: same bootstrap rule — everyone can use chat by default (DMs/group messaging),
# group creation/admin actions stay available per-role via Roles & Permissions.
TEAM_CHAT_USE_PERMISSION_KEY = "team_chat.use"


def _grant_calendar_permissions(db: Session, permission_keys: Sequence[str]) -> None:
    permissions = db.query(Permission).filter(Permission.key.in_(list(permission_keys))).all()
    if not permissions:
        return
    for role in db.query(Role).filter(Role.is_active == True).all():
        existing = {
            row.permission_id
            for row in db.query(RolePermission).filter(
                RolePermission.role_id == role.id,
                RolePermission.permission_id.in_([p.id for p in permissions]),
            ).all()
        }
        for permission in permissions:
            if permission.id not in existing:
                db.add(RolePermission(role_id=role.id, permission_id=permission.id,
                                      data_scope="all" if role.name == "admin" else "own"))
    db.flush()


def _grant_like_quotations(db: Session, product_keys: Sequence[str]) -> None:
    perms = {p.key: p for p in db.query(Permission).filter(Permission.key.in_(list(product_keys))).all()}
    sources = {p.key: p for p in db.query(Permission).filter(Permission.key.in_([k.replace("products.", "quotations.", 1) for k in perms])).all()}
    for key, perm in perms.items():
        src = sources.get(key.replace("products.", "quotations.", 1))
        if not src:
            continue
        holders = db.query(RolePermission).filter(RolePermission.permission_id == src.id).all()
        have = {r.role_id for r in db.query(RolePermission).filter(RolePermission.permission_id == perm.id).all()}
        for rp in holders:
            if rp.role_id not in have:
                db.add(RolePermission(role_id=rp.role_id, permission_id=perm.id, data_scope=getattr(rp, "data_scope", None) or "all"))
                have.add(rp.role_id)
    db.flush()


def _grant_instrument_approve(db: Session) -> None:
    perm = db.query(Permission).filter(Permission.key == "emdbg.approve").first()
    upd = db.query(Permission).filter(Permission.key == "emdbg.update").first()
    if not perm:
        return
    have = {r.role_id for r in db.query(RolePermission).filter(RolePermission.permission_id == perm.id).all()}
    finance = {r.id for r in db.query(Role).filter(Role.is_active == True, Role.name.in_(["accounts", "finance", "finance_controller"])).all()}
    rows = db.query(RolePermission).filter(RolePermission.permission_id == upd.id).all() if upd else []
    for rp in rows:
        scope = getattr(rp, "data_scope", None) or "all"
        if (scope in ("team", "all") or rp.role_id in finance) and rp.role_id not in have:
            db.add(RolePermission(role_id=rp.role_id, permission_id=perm.id, data_scope=scope))
            have.add(rp.role_id)
    for rid in finance - have:
        db.add(RolePermission(role_id=rid, permission_id=perm.id, data_scope="all"))
    db.flush()


def _grant_forecast_permissions(db: Session, keys: Sequence[str]) -> None:
    """First time Forecasts exists in a tenant: every role holding opportunities.view gets forecasts.view; roles that see
    team or all opportunities (managers) and also hold opportunities.update get forecasts.adjust and forecasts.submit."""
    perms = {p.key: p for p in db.query(Permission).filter(Permission.key.in_(list(keys))).all()}
    src = {p.key: p for p in db.query(Permission).filter(Permission.key.in_(["opportunities.view", "opportunities.update"])).all()}
    if "opportunities.view" not in src:
        return
    view_rows = db.query(RolePermission).filter(RolePermission.permission_id == src["opportunities.view"].id).all()
    upd_roles = {r.role_id for r in db.query(RolePermission).filter(RolePermission.permission_id == src["opportunities.update"].id).all()}         if "opportunities.update" in src else set()
    for key, perm in perms.items():
        have = {r.role_id for r in db.query(RolePermission).filter(RolePermission.permission_id == perm.id).all()}
        for rp in view_rows:
            scope = getattr(rp, "data_scope", None) or "all"
            if key != "forecasts.view" and (rp.role_id not in upd_roles or scope not in ("team", "all")):
                continue
            if rp.role_id not in have:
                db.add(RolePermission(role_id=rp.role_id, permission_id=perm.id, data_scope=scope))
                have.add(rp.role_id)
    db.flush()


def _bootstrap_report_permissions(db: Session) -> None:
    from app.models.all_models import Setting
    marker = "reports_v17_permissions_bootstrapped"
    try:
        if db.query(Setting.id).filter(Setting.key == marker).first():
            return
        admin_ids = [r.id for r in db.query(Role.id).filter(Role.name == "admin").all()]
        keys = []
        for p in db.query(Permission).filter(Permission.key.in_(["reports.export", "reports.schedule", "reports.share"])).all():
            # a key some non-admin role already holds was configured on purpose (e.g. an existing reports.export) – leave it
            if not db.query(RolePermission.id).filter(RolePermission.permission_id == p.id, RolePermission.role_id.notin_(admin_ids or [-1])).first():
                keys.append(p.key)
        if keys:
            _grant_report_permissions(db, keys)
        db.add(Setting(key=marker, value="1"))
        db.flush()
    except Exception as exc:  # never block the catalogue sync
        logger.warning("report permission bootstrap skipped: %s", exc)


# Dashboard tab permission → the permissions a role must already hold to receive it (data scope copied from the last one).
_DASHBOARD_TAB_GRANTS = {
    "dashboard.deals.view": ("dashboard.view", "opportunities.view"),
    "dashboard.orders.view": ("dashboard.view", "workorders.view"),
    "dashboard.finance.view": ("dashboard.emdbg.view",),       # Finance replaces the Guarantees (EMD / BG) dashboard
}


def _bootstrap_dashboard_permissions(db: Session, enabled_feature_keys: Optional[Sequence[str]] = None) -> None:
    """Dashboards (prototype v17): the Deals, Orders & delivery and Finance tab permissions were added after tenants configured
    their roles, so no role holds them and the tabs stay hidden even for admins. Once the tenant is entitled to a tab (platform
    plan / tenant features), its permission is granted to the roles that already hold the prerequisites. A marker per tab is set
    only after the grant, so a tab that is not entitled yet is picked up later; Roles & Permissions changes are never overridden."""
    from app.models.all_models import Setting
    try:
        entitled = {k for k, _, _, _ in get_seed_permissions_for_enabled_features(enabled_feature_keys)}
        perms = {p.key: p for p in db.query(Permission).filter(Permission.key.in_(
            list(_DASHBOARD_TAB_GRANTS) + [k for req in _DASHBOARD_TAB_GRANTS.values() for k in req])).all()}
        for key, req in _DASHBOARD_TAB_GRANTS.items():
            marker = f"dashboard_v17_tab_granted:{key}"
            perm = perms.get(key)
            if key not in entitled or not perm or any(p not in perms for p in req):
                continue
            if db.query(Setting.id).filter(Setting.key == marker).first():
                continue
            if not db.query(RolePermission.id).filter(RolePermission.permission_id == perm.id).first():   # configured on purpose – keep it
                holders = None
                for rk in req:
                    ids = {r.role_id for r in db.query(RolePermission.role_id).filter(RolePermission.permission_id == perms[rk].id).all()}
                    holders = ids if holders is None else holders & ids
                scope = {r.role_id: (getattr(r, "data_scope", None) or "all")
                         for r in db.query(RolePermission).filter(RolePermission.permission_id == perms[req[-1]].id).all()}
                for rid in sorted(holders or ()):
                    db.add(RolePermission(role_id=rid, permission_id=perm.id, data_scope=scope.get(rid, "all")))
            db.add(Setting(key=marker, value="1"))
        db.flush()
    except Exception as exc:  # never block the catalogue sync
        logger.warning("dashboard permission bootstrap skipped: %s", exc)


def _grant_report_permissions(db: Session, keys: Sequence[str]) -> None:
    """Reports (prototype v17): the first time export / schedule / share exist in a tenant, every role that can view reports
    gets them with the same data scope, so nothing that worked before is taken away (later Roles & Permissions changes are kept)."""
    src = db.query(Permission).filter(Permission.key == "reports.view").first()
    if not src:
        return
    view_rows = db.query(RolePermission).filter(RolePermission.permission_id == src.id).all()
    for perm in db.query(Permission).filter(Permission.key.in_(list(keys))).all():
        have = {r.role_id for r in db.query(RolePermission).filter(RolePermission.permission_id == perm.id).all()}
        for rp in view_rows:
            if rp.role_id not in have:
                db.add(RolePermission(role_id=rp.role_id, permission_id=perm.id, data_scope=getattr(rp, "data_scope", None) or "all"))
                have.add(rp.role_id)
    db.flush()


def sync_tenant_runtime_catalog(
    db: Session,
    *,
    enabled_feature_keys: Optional[Sequence[str]] = None,
    assign_permissions_to_admin_role: bool = True,
) -> None:
    upsert_default_tenant_modules(db, enabled_feature_keys)
    created_permission_keys = upsert_default_tenant_permissions(db, enabled_feature_keys)
    db.flush()

    created_dashboard_keys = [
        key
        for key in DASHBOARD_TAB_PERMISSION_KEYS
        if key in created_permission_keys
    ]
    if created_dashboard_keys:
        for role in db.query(Role).filter(
            Role.name.in_(LEGACY_DASHBOARD_TAB_ROLE_NAMES),
            Role.is_active == True,
        ).all():
            _grant_permissions_to_role(db, role, created_dashboard_keys)

    # Calendar & Tasks is a personal workspace module: the first time it is enabled in a tenant
    # (no role holds any calendar permission yet) every active role gets it – own tasks only, Admin
    # sees all. After that, changes made in Roles & Permissions are left alone.
    seeded_keys = {key for key, _, _, _ in get_seed_permissions_for_enabled_features(enabled_feature_keys)}
    if "calendar.view" in seeded_keys:
        already_granted = (
            db.query(RolePermission.id)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .filter(Permission.key.in_(CALENDAR_PERMISSION_KEYS))
            .first()
        )
        if not already_granted:
            _grant_calendar_permissions(db, CALENDAR_PERMISSION_KEYS)

    # Announcements: same bootstrap rule as Calendar & Tasks above — the first time the
    # view permission exists, give every active role read access to the feed. Posting
    # rights are deliberately NOT auto-granted beyond Admin; a tenant admin turns
    # "Create" on for other roles explicitly in Roles & Permissions.
    if ANNOUNCEMENT_VIEW_PERMISSION_KEY in seeded_keys:
        view_already_granted = (
            db.query(RolePermission.id)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .filter(Permission.key == ANNOUNCEMENT_VIEW_PERMISSION_KEY)
            .first()
        )
        if not view_already_granted:
            view_permission = db.query(Permission).filter(Permission.key == ANNOUNCEMENT_VIEW_PERMISSION_KEY).first()
            if view_permission:
                for role in db.query(Role).filter(Role.is_active == True).all():
                    exists = db.query(RolePermission.id).filter(
                        RolePermission.role_id == role.id,
                        RolePermission.permission_id == view_permission.id,
                    ).first()
                    if not exists:
                        db.add(RolePermission(role_id=role.id, permission_id=view_permission.id))
                db.flush()

    if TEAM_CHAT_USE_PERMISSION_KEY in seeded_keys:
        use_already_granted = (
            db.query(RolePermission.id)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .filter(Permission.key == TEAM_CHAT_USE_PERMISSION_KEY)
            .first()
        )
        if not use_already_granted:
            use_permission = db.query(Permission).filter(Permission.key == TEAM_CHAT_USE_PERMISSION_KEY).first()
            if use_permission:
                for role in db.query(Role).filter(Role.is_active == True).all():
                    exists = db.query(RolePermission.id).filter(
                        RolePermission.role_id == role.id,
                        RolePermission.permission_id == use_permission.id,
                    ).first()
                    if not exists:
                        db.add(RolePermission(role_id=role.id, permission_id=use_permission.id))
                db.flush()

    # Revoke disabled platform permissions from every role. We keep Permission
    # rows so re-enabling a module does not need a schema/catalog rebuild, but
    # RolePermission grants must disappear so disabled modules are inaccessible.
    if enabled_feature_keys is not None:
        enabled_permission_keys = {
            key
            for key, _, _, _ in get_seed_permissions_for_enabled_features(enabled_feature_keys)
        }
        all_default_permission_keys = {key for key, _, _, _ in DEFAULT_TENANT_PERMISSIONS}
        keys_to_revoke = sorted(all_default_permission_keys - enabled_permission_keys)
        if keys_to_revoke:
            perms_to_revoke = db.query(Permission).filter(Permission.key.in_(keys_to_revoke)).all()
            if perms_to_revoke:
                revoke_ids = [p.id for p in perms_to_revoke]
                db.query(RolePermission).filter(
                    RolePermission.permission_id.in_(revoke_ids)
                ).delete(synchronize_session=False)
        db.flush()

    # Product & Price Books: the first time its permissions exist in a tenant, every role that already works with
    # quotations gets the matching product permission (view → view, create → create …). Later changes made in
    # Roles & Permissions are left alone.
    new_product_keys = [k for k in created_permission_keys if k.startswith("products.")]
    if new_product_keys:
        _grant_like_quotations(db, new_product_keys)

    # Guarantees & Deposits: emdbg.approve the first time it exists – finance roles and roles that edit EMD / BG with
    # team or all visibility (later Roles & Permissions changes are kept).
    if "emdbg.approve" in created_permission_keys:
        _grant_instrument_approve(db)

    # Forecasts: first-time grants derived from the Deals permissions (later Roles & Permissions changes are kept).
    new_forecast_keys = [k for k in created_permission_keys if k.startswith("forecasts.")]
    if new_forecast_keys:
        _grant_forecast_permissions(db, new_forecast_keys)

    # Reports: export / schedule / share – granted once to every role holding reports.view (marker in tenant settings, so later
    # Roles & Permissions changes are never overridden).
    _bootstrap_report_permissions(db)
    # Dashboards: Deals / Orders & delivery / Finance tabs – granted once to roles that already see the matching data.
    _bootstrap_dashboard_permissions(db, enabled_feature_keys)

    if not assign_permissions_to_admin_role:
        invalidate_permissions_cache(db)
        return

    admin_role = db.query(Role).filter(Role.name == "admin", Role.is_active == True).first()
    if not admin_role:
        invalidate_permissions_cache(db)
        return

    permission_keys = [key for key, _, _, _ in get_seed_permissions_for_enabled_features(enabled_feature_keys)]
    _grant_permissions_to_role(db, admin_role, permission_keys)
    invalidate_permissions_cache(db)
