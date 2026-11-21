"""
Report Engine — metadata-driven report builder, runner, and saved report management.

Design:
  - report_types + report_type_fields in DB  → field metadata (labels, data-types, filter ops)
                                               + SQL source mapping (expression, join_key,
                                                 filter_expression) — primary source for runner
  - REPORT_ENGINE_CONFIG in code             → JOIN library + data-scope columns + fallback
                                               expressions for any field not yet in DB
  - saved_reports + report_permissions in DB → persisted report definitions
  - POST /engine/run                         → generic SQL runner

All existing /reports/* endpoints are left completely untouched.
New endpoints live under /api/v1/reports/engine/
"""

from __future__ import annotations

import logging
import csv
import io
import re
from typing import Any, Optional
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text, update as sa_update
from sqlalchemy.sql import func
from sqlalchemy.orm import Session

from app.dependencies import get_tenant_db, get_current_user, get_request_ip
from app.core.logging import log_module_action
from app.models.all_models import (
    Permission, Role, RolePermission, Module,
    ReportType, ReportTypeField, ReportFolder, SavedReport, ReportSavedFilter,
    User, Customer, Questionnaire, QuestionnaireStructure, QuestionnaireFormElement,
    CustomerQuestionnaire, CustomerQuestionnaireAnswer, SalesCustomerAssignment,
)
from app.services.tenant_module_service import DEFAULT_TENANT_MODULE_KEYS
from app.utils.data_scope import apply_data_scope, get_module_data_scope, get_team_user_ids

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Report Engine"])

_QUESTIONNAIRE_ASSIGNED_USER_EXPR = (
    "COALESCE(("
    "SELECT sca.user_id FROM sales_customer_assignments sca "
    "WHERE sca.customer_id = cust.id AND sca.is_active = 1 "
    "ORDER BY sca.updated_at DESC, sca.id DESC LIMIT 1"
    "), cust.assigned_to)"
)

_QUESTIONNAIRE_LAST_ACTIVITY_EXPR = "COALESCE(cq.last_saved_at, cq.completed_at, cq.started_at, cq.created_at)"

# Guard against any injection in DB-stored expressions (seeded by the app, but
# validate anyway so a hand-edited row can never escalate to arbitrary SQL).
_DANGEROUS_SQL = re.compile(
    r"(--|;\s|/\*|\*/|\bxp_|\bexec\b|\bdrop\b|\binsert\b|\bupdate\b|\bdelete\b|\bunion\b|\binto\b)",
    re.IGNORECASE,
)

def _safe_expr(expr: str) -> str:
    if _DANGEROUS_SQL.search(expr):
        raise HTTPException(500, "Invalid expression in report field configuration")
    return expr

# ---------------------------------------------------------------------------
# SQL-level report engine configuration (secure — not stored in DB)
# Each entry defines: base SQL, JOIN library, field→expression map,
#                     filter-field map, and data-scope columns.
# ---------------------------------------------------------------------------

REPORT_ENGINE_CONFIG: dict[str, dict] = {
    "leads": {
        "base":              "FROM leads l",
        "default_where":     ["l.is_deleted = 0"],
        "date_field":        "l.created_at",
        "scope_created_col": "l.created_by",
        "scope_assigned_col": "l.assigned_to",
        "module_key":        "leads",
        "joins": {
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = l.assigned_to",
            "created_user":  "LEFT JOIN users created_user  ON created_user.id  = l.created_by",
            "lead_source":   "LEFT JOIN lead_sources lsrc   ON lsrc.id          = l.source_id",
            "vertical":      "LEFT JOIN vertical_sectors vs  ON vs.id            = l.business_vertical_id",
            "customer":      "LEFT JOIN customers cust       ON cust.id          = l.customer_id",
        },
        "fields": {
            "id":               ("l.id",                   []),
            "lead_ref_id":      ("l.lead_ref_id",          []),
            "lead_title":       ("l.lead_title",           []),
            "customer_name":    ("l.customer_name",        []),
            "customer_id":      ("l.customer_id",          []),
            "status":           ("l.status",               []),
            "priority":         ("l.priority",             []),
            "est_value":        ("l.est_value",            []),
            "region":           ("l.region",               []),
            "branch":           ("l.branch",               []),
            "created_at":       ("l.created_at",           []),
            "updated_at":       ("l.updated_at",           []),
            "follow_up":        ("l.follow_up",            []),
            "timeline":         ("l.timeline",             []),
            "converted_at":     ("l.converted_at",         []),
            "assigned_to_name": ("assigned_user.full_name", ["assigned_user"]),
            "created_by_name":  ("created_user.full_name",  ["created_user"]),
            "source_name":      ("lsrc.name",        ["lead_source"]),
            "vertical_name":    ("vs.name",                 ["vertical"]),
            "contact_person":   ("l.contact_person",       []),
            "mobile":           ("l.mobile",               []),
            "email":            ("l.email",                []),
            # Linked-record counts — self-contained correlated subqueries, no join required.
            # Shown only in the "Linked Records" view; Standard view never selects these.
            "tender_count":     ("(SELECT COUNT(*) FROM tenders t WHERE t.lead_id = l.id AND t.is_deleted = 0)", []),
            "quotation_count":  ("(SELECT COUNT(*) FROM quotations q WHERE q.lead_id = l.id)", []),
            "work_order_count": ("(SELECT COUNT(*) FROM work_orders wo WHERE wo.lead_id = l.id)", []),
            "activity_count":   ("(SELECT COUNT(*) FROM kam_activities ka WHERE ka.lead_id = l.id)", []),
        },
        "filter_fields": {
            "id":            ("l.id",          "number"),
            "status":        ("l.status",      "enum"),
            "priority":      ("l.priority",    "enum"),
            "assigned_to":   ("l.assigned_to", "number"),
            "created_by":    ("l.created_by",  "number"),
            "customer_id":   ("l.customer_id", "number"),
            "est_value":     ("l.est_value",   "number"),
            "region":        ("l.region",      "text"),
            "branch":        ("l.branch",      "text"),
            "created_at":    ("l.created_at",  "date"),
            "follow_up":     ("l.follow_up",   "date"),
            "timeline":      ("l.timeline",    "date"),
            "converted_at":  ("l.converted_at","date"),
            "contact_person":("l.contact_person","text"),
            "mobile":        ("l.mobile",       "text"),
            "email":         ("l.email",        "text"),
        },
        "quick_search_fields": ["lead_title", "customer_name"],
    },

    "customers": {
        "base":              "FROM customers c",
        "default_where":     [],
        "date_field":        "c.created_at",
        "scope_created_col": "c.created_by",
        "scope_assigned_col": None,
        "module_key":        "customers",
        "joins": {
            "created_user":  "LEFT JOIN users created_user ON created_user.id = c.created_by",
            "updated_user":  "LEFT JOIN users updated_user ON updated_user.id = c.updated_by",
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = c.assigned_to",
            "parent_account":"LEFT JOIN customers parent_account ON parent_account.id = c.parent_account_id",
        },
        "fields": {
            "id":                       ("c.id",                       []),
            "customer_name":            ("c.customer_name",            []),
            "customer_vertical":       ("c.customer_vertical",        []),
            "division":                 ("c.division",                 []),
            "group_name":               ("c.group_name",               []),
            "industry":                 ("c.industry",                 []),
            "tags":                     ("c.tags",                     []),
            "parent_account_id":        ("c.parent_account_id",        []),
            "parent_account_name":      ("parent_account.customer_name", ["parent_account"]),
            "billing_address":          ("c.billing_address",          []),
            "billing_pincode":          ("c.billing_pincode",          []),
            "billing_country":          ("c.billing_country",          []),
            "billing_state":            ("c.billing_state",            []),
            "billing_city":             ("c.billing_city",             []),
            "billing_area":             ("c.billing_area",             []),
            "shipping_same_as_billing": ("c.shipping_same_as_billing", []),
            "shipping_address":         ("c.shipping_address",         []),
            "shipping_pincode":         ("c.shipping_pincode",         []),
            "shipping_country":         ("c.shipping_country",         []),
            "shipping_state":           ("c.shipping_state",           []),
            "shipping_city":            ("c.shipping_city",            []),
            "shipping_area":            ("c.shipping_area",            []),
            "gst_number":               ("c.gst_number",               []),
            "pan_number":               ("c.pan_number",               []),
            "annual_revenue":           ("c.annual_revenue",           []),
            "employee_count":           ("c.employee_count",           []),
            "website":                  ("c.website",                  []),
            "region":                   ("c.billing_state",            []),
            "account_status":           ("c.account_status",           []),
            "account_potential":        ("c.account_potential",        []),
            "potential_value":          ("c.potential_value",          []),
            "assigned_to":              ("c.assigned_to",              []),
            "assigned_to_name":         ("assigned_user.full_name",    ["assigned_user"]),
            "remarks":                  ("c.remarks",                  []),
            "is_active":                ("c.is_active",                []),
            "approval_status":          ("c.approval_status",          []),
            "custom_data":              ("c.custom_data",              []),
            "is_deleted":               ("c.is_deleted",                []),
            "created_by":               ("c.created_by",               []),
            "created_by_name":          ("created_user.full_name",     ["created_user"]),
            "updated_by":               ("c.updated_by",                []),
            "updated_by_name":          ("updated_user.full_name",     ["updated_user"]),
            "created_at":               ("c.created_at",               []),
            "updated_at":               ("c.updated_at",               []),
            # Linked-record counts — self-contained correlated subqueries, no join required.
            "lead_count":         ("(SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.is_deleted = 0 AND l.lead_type = 'lead')", []),
            "opportunity_count":  ("(SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.is_deleted = 0 AND l.lead_type = 'direct_opportunity')", []),
            "tender_count":       ("(SELECT COUNT(*) FROM tenders t WHERE t.customer_id = c.id AND t.is_deleted = 0)", []),
            "quotation_count":    ("(SELECT COUNT(*) FROM quotations q WHERE q.customer_id = c.id)", []),
            "work_order_count":   ("(SELECT COUNT(*) FROM work_orders wo WHERE wo.customer_id = c.id)", []),
        },
        "filter_fields": {
            "customer_vertical": ("c.customer_vertical", "text"),
            "division":          ("c.division",          "text"),
            "group_name":        ("c.group_name",        "text"),
            "industry":          ("c.industry",          "text"),
            "billing_country":   ("c.billing_country",   "text"),
            "billing_state":     ("c.billing_state",     "text"),
            "billing_city":      ("c.billing_city",      "text"),
            "region":            ("c.billing_state",     "text"),
            "gst_number":        ("c.gst_number",         "text"),
            "pan_number":        ("c.pan_number",         "text"),
            "annual_revenue":    ("c.annual_revenue",     "number"),
            "employee_count":    ("c.employee_count",     "number"),
            "account_status":    ("c.account_status",    "enum"),
            "account_potential": ("c.account_potential",  "enum"),
            "potential_value":   ("c.potential_value",    "number"),
            "assigned_to":       ("c.assigned_to",        "number"),
            "is_active":         ("c.is_active",          "boolean"),
            "approval_status":   ("c.approval_status",    "text"),
            "created_at":        ("c.created_at",         "date"),
            "updated_at":        ("c.updated_at",         "date"),
            "created_by":        ("c.created_by",         "number"),
        },
        "quick_search_fields": ["customer_name", "gst_number", "pan_number", "website"],
    },

    "tenders": {
        "base":              "FROM tenders t",
        "default_where":     ["t.is_deleted = 0"],
        "date_field":        "t.created_at",
        "scope_created_col": "t.created_by",
        "scope_assigned_col": "t.assigned_to",
        "module_key":        "tenders",
        "joins": {
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to",
            "created_user":  "LEFT JOIN users created_user  ON created_user.id  = t.created_by",
            "customer":      "LEFT JOIN customers cust       ON cust.id          = t.customer_id",
            "vertical":      "LEFT JOIN vertical_sectors vs  ON vs.id            = t.business_vertical_id",
            "lead":          "LEFT JOIN leads l              ON l.id             = t.lead_id",
        },
        "fields": {
            "id":               ("t.id",                   []),
            "tender_ref_id":    ("t.tender_num",           []),
            "tender_title":     ("t.tender_title",         []),
            "customer_name":    ("t.customer_name",        []),
            "customer_id":      ("t.customer_id",          []),
            "lead_id":          ("t.lead_id",              []),
            "lead_title":       ("l.lead_title",            ["lead"]),
            "status":           ("t.tender_status",        []),
            "result":           ("t.result",               []),
            "bid_amount":       ("t.bid_amount",           []),
            "est_value":        ("t.est_value",            []),
            "current_step":     ("t.current_step",         []),
            "tender_date":      ("t.published_date",       []),
            "submission_date":  ("t.submission_date",      []),
            "result_date":      ("t.result_date",          []),
            "created_at":       ("t.created_at",           []),
            "assigned_to_name": ("assigned_user.full_name", ["assigned_user"]),
            "created_by_name":  ("created_user.full_name",  ["created_user"]),
            "vertical_name":    ("vs.name",                 ["vertical"]),
            # Linked-record counts — self-contained correlated subqueries, no join required.
            "quotation_count":  ("(SELECT COUNT(*) FROM quotations q WHERE q.tender_id = t.id)", []),
            "work_order_count": ("(SELECT COUNT(*) FROM work_orders wo WHERE wo.tender_id = t.id)", []),
            "emdbg_count":      ("(SELECT COUNT(*) FROM emdbg e WHERE e.tender_id = t.id)", []),
        },
        "filter_fields": {
            "id":              ("t.id",              "number"),
            "status":          ("t.tender_status",   "enum"),
            "result":          ("t.result",          "enum"),
            "assigned_to":     ("t.assigned_to",     "number"),
            "created_by":      ("t.created_by",      "number"),
            "customer_id":     ("t.customer_id",     "number"),
            "created_at":      ("t.created_at",      "date"),
            "submission_date": ("t.submission_date", "date"),
            "result_date":     ("t.result_date",     "date"),
            "bid_amount":      ("t.bid_amount",      "number"),
        },
        "quick_search_fields": ["tender_ref_id", "tender_title", "customer_name"],
    },

    "opportunities": {
        "base":              "FROM leads l",
        "default_where":     ["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        "date_field":        "l.created_at",
        "scope_created_col": "l.created_by",
        "scope_assigned_col": "l.assigned_to",
        "module_key":        "opportunity",
        "joins": {
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = l.assigned_to",
            "created_user":  "LEFT JOIN users created_user  ON created_user.id  = l.created_by",
            "vertical":      "LEFT JOIN vertical_sectors vs  ON vs.id            = l.business_vertical_id",
        },
        "fields": {
            "id":               ("l.id",                   []),
            "lead_title":       ("l.lead_title",           []),
            "customer_name":    ("l.customer_name",        []),
            "customer_id":      ("l.customer_id",          []),
            "status":           ("l.status",               []),
            "priority":         ("l.priority",             []),
            "est_value":        ("l.est_value",            []),
            "region":           ("l.region",               []),
            "created_at":       ("l.created_at",           []),
            "assigned_to_name": ("assigned_user.full_name", ["assigned_user"]),
            "created_by_name":  ("created_user.full_name",  ["created_user"]),
            "vertical_name":    ("vs.name",                 ["vertical"]),
            # Linked-record counts — self-contained correlated subqueries, no join required.
            "tender_count":     ("(SELECT COUNT(*) FROM tenders t WHERE t.lead_id = l.id AND t.is_deleted = 0)", []),
            "quotation_count":  ("(SELECT COUNT(*) FROM quotations q WHERE q.lead_id = l.id)", []),
            "work_order_count": ("(SELECT COUNT(*) FROM work_orders wo WHERE wo.lead_id = l.id)", []),
            "activity_count":   ("(SELECT COUNT(*) FROM kam_activities ka WHERE ka.lead_id = l.id)", []),
        },
        "filter_fields": {
            "id":           ("l.id",          "number"),
            "status":       ("l.status",      "enum"),
            "priority":     ("l.priority",    "enum"),
            "assigned_to":  ("l.assigned_to", "number"),
            "created_by":   ("l.created_by",  "number"),
            "customer_id":  ("l.customer_id", "number"),
            "region":       ("l.region",      "text"),
            "created_at":   ("l.created_at",  "date"),
        },
    },

    "workorders": {
        "base":              "FROM work_orders wo",
        "default_where":     [],
        "date_field":        "wo.created_at",
        "scope_created_col": "wo.created_by",
        "scope_assigned_col": None,
        "module_key":        "workorders",
        "joins": {
            "created_user": "LEFT JOIN users created_user ON created_user.id = wo.created_by",
            "customer":     "LEFT JOIN customers cust      ON cust.id         = wo.customer_id",
            "lead":         "LEFT JOIN leads l              ON l.id            = wo.lead_id",
        },
        "fields": {
            "id":               ("wo.id",                  []),
            "wo_number":        ("wo.wo_number",           []),
            "project_title":    ("wo.project_title",       []),
            "customer_name":    ("wo.customer_name",       []),
            "customer_id":      ("wo.customer_id",         []),
            "lead_id":          ("wo.lead_id",             []),
            "lead_title":       ("l.lead_title",            ["lead"]),
            "wo_type":          ("wo.wo_type",             []),
            "po_number":        ("wo.po_number",           []),
            "po_value":         ("wo.po_value",            []),
            "wo_value":         ("wo.wo_value",            []),
            "progress_percent": ("wo.progress_percent",    []),
            "status":           ("wo.status",              []),
            "delivery_date":    ("wo.delivery_date",       []),
            "created_at":       ("wo.created_at",          []),
            "created_by_name":  ("created_user.full_name", ["created_user"]),
        },
        "filter_fields": {
            "id":         ("wo.id",       "number"),
            "wo_type":    ("wo.wo_type",   "text"),
            "status":     ("wo.status",    "text"),
            "created_at": ("wo.created_at","date"),
            "created_by": ("wo.created_by","number"),
            "po_value":   ("wo.po_value",  "number"),
            "wo_value":   ("wo.wo_value",  "number"),
        },
        "quick_search_fields": ["wo_number", "project_title", "customer_name"],
    },

    "emdbg": {
        "base":              "FROM emdbg e",
        "default_where":     [],
        "date_field":        "e.created_at",
        "scope_created_col": "e.created_by",
        "scope_assigned_col": None,
        "module_key":        "emdbg",
        "joins": {
            "created_user": "LEFT JOIN users created_user ON created_user.id = e.created_by",
            "tender":       "LEFT JOIN tenders t           ON t.id            = e.tender_id",
        },
        "fields": {
            "id":               ("e.id",                   []),
            "instrument_type":  ("e.instrument_type",      []),
            "instrument_number":("e.instrument_number",    []),
            "bank_name":        ("e.bank_name",            []),
            "amount":           ("e.amount",               []),
            "issue_date":       ("e.issued_date",           []),
            "expiry_date":      ("e.expiry_date",          []),
            "status":           ("e.status",               []),
            "customer_name":    ("e.client_name",           []),
            "customer_id":      ("e.customer_id",          []),
            "tender_id":        ("e.tender_id",            []),
            "tender_title":     ("t.tender_title",          ["tender"]),
            "created_at":       ("e.created_at",           []),
            "created_by_name":  ("created_user.full_name", ["created_user"]),
        },
        "filter_fields": {
            "id":              ("e.id",              "number"),
            "instrument_type": ("e.instrument_type", "text"),
            "status":          ("e.status",          "text"),
            "issue_date":      ("e.issued_date",       "date"),
            "expiry_date":     ("e.expiry_date",      "date"),
            "created_at":      ("e.created_at",       "date"),
            "amount":          ("e.amount",           "number"),
            "created_by":      ("e.created_by",       "number"),
        },
        "quick_search_fields": ["instrument_number", "tender_title", "customer_name"],
    },

    "travel": {
        "base":              "FROM travel_requests tr",
        "default_where":     [],
        "date_field":        "tr.created_at",
        "scope_created_col": "tr.employee_id",
        "scope_assigned_col": None,
        "module_key":        "travel",
        "joins": {
            "employee": "LEFT JOIN users employee ON employee.id = tr.employee_id",
            # travel_requests has no created_by column — the requester is the employee
            "created_user": "LEFT JOIN users created_user ON created_user.id = tr.employee_id",
        },
        "fields": {
            "id":                  ("tr.id",               []),
            "purpose":             ("tr.purpose",          []),
            "from_city":           ("tr.from_city",        []),
            "to_city":             ("tr.to_city",          []),
            "travel_date":         ("tr.travel_date",      []),
            "return_date":         ("tr.return_date",      []),
            "visit_type":          ("tr.visit_type",       []),
            "status":              ("tr.status",           []),
            "advance_required":    ("tr.advance_required", []),
            "advance_amount":      ("tr.advance_amount",   []),
            "created_at":          ("tr.created_at",       []),
            "employee_name":       ("employee.full_name",  ["employee"]),
            "created_by_name":     ("created_user.full_name", ["created_user"]),
        },
        "filter_fields": {
            "status":       ("tr.status",      "text"),
            "visit_type":   ("tr.visit_type",  "text"),
            "travel_date":  ("tr.travel_date", "date"),
            "created_at":   ("tr.created_at",  "date"),
            "employee_id":  ("tr.employee_id", "number"),
        },
    },

    "questionnaire": {
        "base":              "FROM customer_questionnaires cq",
        "default_where":     [],
        "date_field":        "cq.created_at",
        "scope_created_col": "cq.created_by",
        "scope_assigned_col": None,
        "module_key":        "questionnaire",
        "joins": {
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = cq.questionnaire_id",
            "customer":      "LEFT JOIN customers cust ON cust.id = cq.customer_id",
            "created_user":  "LEFT JOIN users created_user ON created_user.id = cq.created_by",
            "reopened_user": "LEFT JOIN users reopened_user ON reopened_user.id = cq.reopened_by",
        },
        "fields": {
            "id":                    ("cq.id",                    []),
            "questionnaire_id":      ("cq.questionnaire_id",       []),
            "questionnaire_code":    ("qn.questionnaire_code",     ["questionnaire"]),
            "questionnaire_name":    ("qn.questionnaire_name",     ["questionnaire"]),
            "customer_id":           ("cq.customer_id",            []),
            "customer_name":        ("cust.customer_name",        ["customer"]),
            "status":                ("cq.status",                []),
            "total_questions":       ("cq.total_questions",        []),
            "completed_questions":   ("cq.completed_questions",    []),
            "progress_percentage":   ("cq.progress_percentage",    []),
            "stale_days":            ("(CASE WHEN cq.status IN ('completed') THEN NULL ELSE DATEDIFF(CURDATE(), COALESCE(cq.last_saved_at, cq.started_at, cq.created_at)) END)", []),
            "started_at":            ("cq.started_at",             []),
            "completed_at":          ("cq.completed_at",           []),
            "last_saved_at":         ("cq.last_saved_at",          []),
            "reopened_at":           ("cq.reopened_at",            []),
            "reopened_by_name":      ("reopened_user.full_name",   ["reopened_user"]),
            "reopen_reason":         ("cq.reopen_reason",          []),
            "created_by":            ("cq.created_by",             []),
            "created_by_name":       ("created_user.full_name",    ["created_user"]),
            "created_at":            ("cq.created_at",             []),
            "updated_at":            ("cq.updated_at",             []),
        },
        "filter_fields": {
            "questionnaire_id":     ("cq.questionnaire_id",   "number"),
            "customer_id":          ("cq.customer_id",        "number"),
            "status":               ("cq.status",             "enum"),
            "progress_percentage":  ("cq.progress_percentage", "number"),
            "last_saved_at":        ("cq.last_saved_at",      "date"),
            "stale_days":           ("(CASE WHEN cq.status IN ('completed') THEN NULL ELSE DATEDIFF(CURDATE(), COALESCE(cq.last_saved_at, cq.started_at, cq.created_at)) END)", "number"),
            "started_at":           ("cq.started_at",         "date"),
            "completed_at":         ("cq.completed_at",       "date"),
            "created_at":           ("cq.created_at",         "date"),
        },
        "quick_search_fields": ["questionnaire_code", "questionnaire_name", "customer_name"],
    },

    "questionnaire_user": {
        "report_type_name":  "Role-wise Questionnaire Summary",
        "description":       "Role-wise questionnaire completion, pending work, and rating summary",
        "module_permission_key": "reports.questionnaire.view",
        "permission_keys":   ("reports.questionnaire.view",),
        "sort_order":        23,
        "base":              "FROM customer_questionnaires cq",
        "default_where":     [],
        "date_field":        _QUESTIONNAIRE_LAST_ACTIVITY_EXPR,
        "scope_created_col": "cust.created_by",
        "scope_assigned_col": _QUESTIONNAIRE_ASSIGNED_USER_EXPR,
        "module_key":        "questionnaire",
        "joins": {
            "customer":      "LEFT JOIN customers cust ON cust.id = cq.customer_id",
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = cq.questionnaire_id",
            "owner_user":    f"LEFT JOIN users owner_user ON owner_user.id = {_QUESTIONNAIRE_ASSIGNED_USER_EXPR}",
            "owner_role":    "LEFT JOIN roles owner_role ON owner_role.name = owner_user.role",
            "answer":        "LEFT JOIN customer_questionnaire_answers cqa ON cqa.customer_questionnaire_id = cq.id",
            "element":       "LEFT JOIN questionnaire_form_elements qfe ON qfe.id = cqa.element_id",
            "section":       "LEFT JOIN questionnaire_structure qsec ON qsec.id = qfe.section_id",
            "subsection":    "LEFT JOIN questionnaire_structure qsub ON qsub.id = qfe.subsection_id",
        },
        "fields": {
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, ["customer"]),
            "user_name":          ("COALESCE(owner_user.full_name, 'Unassigned')", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role, 'Unassigned')", ["customer", "owner_user", "owner_role"]),
            "users":              ("0", []),
            "customers":          ("0", []),
            "questions":          ("0", []),
            "answered":           ("0", []),
            "pending":            ("0", []),
            "completed":          ("0", []),
            "in_progress":        ("0", []),
            "completed_customers": ("0", []),
            "completion_pct":     ("0", []),
            "last_activity_at":   (_QUESTIONNAIRE_LAST_ACTIVITY_EXPR, []),
            "customer_id":        ("cq.customer_id", []),
            "customer_name":      ("cust.customer_name", ["customer"]),
            "category":           ("cust.customer_vertical", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", []),
            "questionnaire_name": ("qn.questionnaire_name", ["questionnaire"]),
            "section_id":         ("qfe.section_id", ["answer", "element"]),
            "section_name":       ("qsec.structure_name", ["answer", "element", "section"]),
            "subsection_id":      ("qfe.subsection_id", ["answer", "element"]),
            "subsection_name":    ("qsub.structure_name", ["answer", "element", "subsection"]),
            "answer_value":       ("cqa.answer_value", ["answer"]),
            "status":             ("cq.status", []),
        },
        "filter_fields": {
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, "number", ["customer"]),
            "user_name":          ("owner_user.full_name", "text", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role)", "text", ["customer", "owner_user", "owner_role"]),
            "customer_id":        ("cq.customer_id", "number"),
            "customer_name":      ("cust.customer_name", "text", ["customer"]),
            "category":           ("cust.customer_vertical", "text", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", "number"),
            "questionnaire_name": ("qn.questionnaire_name", "text", ["customer", "questionnaire"]),
            "section_id":         ("qfe.section_id", "number", ["customer", "answer", "element"]),
            "section_name":       ("qsec.structure_name", "text", ["customer", "answer", "element", "section"]),
            "subsection_id":      ("qfe.subsection_id", "number", ["customer", "answer", "element"]),
            "subsection_name":    ("qsub.structure_name", "text", ["customer", "answer", "element", "subsection"]),
            "answer_value":       ("cqa.answer_value", "text", ["customer", "answer"]),
            "status":             ("cq.status", "enum"),
            "last_activity_at":   (_QUESTIONNAIRE_LAST_ACTIVITY_EXPR, "datetime"),
        },
        "field_metadata": {
            "user_id": {"label": "User ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 0},
            "user_name": {"label": "User", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 1},
            "role_name": {"label": "Role", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 2},
            "users": {"label": "Users", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 3},
            "customers": {"label": "Customers", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 4},
            "questions": {"label": "Total Questions", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 5},
            "answered": {"label": "Answered", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 6},
            "pending": {"label": "Pending", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 7},
            "completed": {"label": "Completed", "data_type": "number", "is_default_column": False, "is_aggregatable": True, "display_order": 8},
            "in_progress": {"label": "In-Progress", "data_type": "number", "is_default_column": False, "is_aggregatable": True, "display_order": 9},
            "completed_customers": {"label": "Completed Customers", "data_type": "number", "is_default_column": False, "is_aggregatable": True, "display_order": 10},
            "completion_pct": {"label": "Completion %", "data_type": "number", "is_default_column": True, "is_aggregatable": True, "display_order": 11},
            "last_activity_at": {"label": "Last Activity", "data_type": "datetime", "is_default_column": False, "is_filterable": True, "display_order": 13},
            "customer_id": {"label": "Customer ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 90},
            "customer_name": {"label": "Customer", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 91},
            "category": {"label": "Category", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 92},
            "questionnaire_id": {"label": "Questionnaire ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 93},
            "questionnaire_name": {"label": "Questionnaire", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 94},
            "section_id": {"label": "Section ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 95},
            "section_name": {"label": "Section", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 96},
            "subsection_id": {"label": "Subsection ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 97},
            "subsection_name": {"label": "Subsection", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 98},
            "answer_value": {"label": "Answer", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 99},
            "status": {"label": "Status", "data_type": "enum", "is_default_column": False, "is_filterable": True, "display_order": 100, "enum_values": ["not_started", "in_progress", "completed", "reopened"], "allowed_operators": ["eq", "neq", "in", "not_in"]},
        },
        "quick_search_fields": ["user_name", "role_name", "customer_name", "questionnaire_name"],
    },

    "questionnaire_user_customer": {
        "base":              "FROM customer_questionnaires cq",
        "default_where":     [],
        "date_field":        _QUESTIONNAIRE_LAST_ACTIVITY_EXPR,
        "scope_created_col": "cust.created_by",
        "scope_assigned_col": _QUESTIONNAIRE_ASSIGNED_USER_EXPR,
        "module_key":        "questionnaire",
        "permission_keys":   ("reports.questionnaire.view",),
        "joins": {
            "customer":      "LEFT JOIN customers cust ON cust.id = cq.customer_id",
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = cq.questionnaire_id",
            "owner_user":    f"LEFT JOIN users owner_user ON owner_user.id = {_QUESTIONNAIRE_ASSIGNED_USER_EXPR}",
            "owner_role":    "LEFT JOIN roles owner_role ON owner_role.name = owner_user.role",
            "answer":        "LEFT JOIN customer_questionnaire_answers cqa ON cqa.customer_questionnaire_id = cq.id",
            "element":       "LEFT JOIN questionnaire_form_elements qfe ON qfe.id = cqa.element_id",
            "section":       "LEFT JOIN questionnaire_structure qsec ON qsec.id = qfe.section_id",
            "subsection":    "LEFT JOIN questionnaire_structure qsub ON qsub.id = qfe.subsection_id",
        },
        "fields": {
            "id":                 ("cq.id", []),
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, ["customer"]),
            "user_name":          ("COALESCE(owner_user.full_name, 'Unassigned')", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role, 'Unassigned')", ["customer", "owner_user", "owner_role"]),
            "customer_id":        ("cq.customer_id", []),
            "customer_name":      ("cust.customer_name", ["customer"]),
            "category":           ("cust.customer_vertical", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", []),
            "questionnaire_name": ("qn.questionnaire_name", ["questionnaire"]),
            "status":             ("cq.status", []),
            "questions":          ("0", []),
            "answered":           ("0", []),
            "pending":            ("0", []),
            "completion_pct":     ("0", []),
            "last_activity_at":   (_QUESTIONNAIRE_LAST_ACTIVITY_EXPR, []),
        },
        "filter_fields": {
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, "number", ["customer"]),
            "user_name":          ("owner_user.full_name", "text", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role)", "text", ["customer", "owner_user", "owner_role"]),
            "customer_id":        ("cq.customer_id", "number"),
            "customer_name":      ("cust.customer_name", "text", ["customer"]),
            "category":           ("cust.customer_vertical", "text", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", "number"),
            "questionnaire_name": ("qn.questionnaire_name", "text", ["customer", "questionnaire"]),
            "status":             ("cq.status", "enum"),
            "last_activity_at":   (_QUESTIONNAIRE_LAST_ACTIVITY_EXPR, "datetime"),
        },
        "quick_search_fields": ["user_name", "customer_name", "questionnaire_name"],
    },

    "questionnaire_user_detail": {
        "report_type_name":  "User-wise Questionnaire Detail",
        "description":       "Detailed user/customer questionnaire answers including dependent and additional fields",
        "visible":           False,
        "module_permission_key": "reports.questionnaire.view",
        "permission_keys":   ("reports.questionnaire.view",),
        "sort_order":        24,
        "base":              "FROM customer_questionnaires cq",
        "default_where":     [],
        "date_field":        _QUESTIONNAIRE_LAST_ACTIVITY_EXPR,
        "scope_created_col": "cust.created_by",
        "scope_assigned_col": _QUESTIONNAIRE_ASSIGNED_USER_EXPR,
        "module_key":        "questionnaire",
        "joins": {
            "customer":      "LEFT JOIN customers cust ON cust.id = cq.customer_id",
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = cq.questionnaire_id",
            "owner_user":    f"LEFT JOIN users owner_user ON owner_user.id = {_QUESTIONNAIRE_ASSIGNED_USER_EXPR}",
            "owner_role":    "LEFT JOIN roles owner_role ON owner_role.name = owner_user.role",
            "answer":        "LEFT JOIN customer_questionnaire_answers cqa ON cqa.customer_questionnaire_id = cq.id",
            "element":       "LEFT JOIN questionnaire_form_elements qfe ON qfe.id = cqa.element_id",
            "section":       "LEFT JOIN questionnaire_structure qsec ON qsec.id = qfe.section_id",
            "subsection":    "LEFT JOIN questionnaire_structure qsub ON qsub.id = qfe.subsection_id",
            "answered_user": "LEFT JOIN users answered_user ON answered_user.id = cqa.answered_by",
        },
        "fields": {
            "id":                 ("cq.id", []),
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, ["customer"]),
            "user_name":          ("COALESCE(owner_user.full_name, 'Unassigned')", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role, 'Unassigned')", ["customer", "owner_user", "owner_role"]),
            "customer_id":        ("cq.customer_id", []),
            "customer_name":      ("cust.customer_name", ["customer"]),
            "category":           ("cust.customer_vertical", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", []),
            "questionnaire_name": ("qn.questionnaire_name", ["questionnaire"]),
            "section_id":         ("qfe.section_id", ["answer", "element"]),
            "section_name":       ("qsec.structure_name", ["answer", "element", "section"]),
            "subsection_id":      ("qfe.subsection_id", ["answer", "element"]),
            "subsection_name":    ("qsub.structure_name", ["answer", "element", "subsection"]),
            "question_id":        ("qfe.id", ["answer", "element"]),
            "question_code":      ("qfe.element_code", ["answer", "element"]),
            "question_label":     ("qfe.element_label", ["answer", "element"]),
            "field_id":           ("qfe.id", ["answer", "element"]),
            "field_label":        ("qfe.element_label", ["answer", "element"]),
            "element_type":       ("qfe.element_type", ["answer", "element"]),
            "input_type":         ("qfe.input_type", ["answer", "element"]),
            "answer_value":       ("cqa.answer_value", ["answer"]),
            "remarks":            ("cqa.remarks", ["answer"]),
            "answered_by_name":   ("answered_user.full_name", ["answer", "answered_user"]),
            "answered_at":        ("cqa.answered_at", ["answer"]),
            "status":             ("cq.status", []),
            "completion_pct":     ("0", []),
        },
        "filter_fields": {
            "user_id":            (_QUESTIONNAIRE_ASSIGNED_USER_EXPR, "number", ["customer"]),
            "user_name":          ("owner_user.full_name", "text", ["customer", "owner_user"]),
            "role_name":          ("COALESCE(owner_role.display_name, owner_user.role)", "text", ["customer", "owner_user", "owner_role"]),
            "customer_id":        ("cq.customer_id", "number"),
            "customer_name":      ("cust.customer_name", "text", ["customer"]),
            "category":           ("cust.customer_vertical", "text", ["customer"]),
            "questionnaire_id":   ("cq.questionnaire_id", "number"),
            "questionnaire_name": ("qn.questionnaire_name", "text", ["customer", "questionnaire"]),
            "section_id":         ("qfe.section_id", "number", ["customer", "answer", "element"]),
            "section_name":       ("qsec.structure_name", "text", ["customer", "answer", "element", "section"]),
            "subsection_id":      ("qfe.subsection_id", "number", ["customer", "answer", "element"]),
            "subsection_name":    ("qsub.structure_name", "text", ["customer", "answer", "element", "subsection"]),
            "answer_value":       ("cqa.answer_value", "text", ["customer", "answer"]),
            "status":             ("cq.status", "enum"),
            "answered_at":        ("cqa.answered_at", "datetime", ["answer"]),
            "last_activity_at":   (_QUESTIONNAIRE_LAST_ACTIVITY_EXPR, "datetime"),
        },
        "field_metadata": {
            "id": {"label": "ID", "data_type": "text", "is_default_column": False, "display_order": 0},
            "user_id": {"label": "User ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 1},
            "user_name": {"label": "User", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 2},
            "role_name": {"label": "Role", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 3},
            "customer_id": {"label": "Customer ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 4},
            "customer_name": {"label": "Customer", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 5},
            "category": {"label": "Category", "data_type": "text", "is_default_column": False, "is_filterable": True, "display_order": 6},
            "questionnaire_id": {"label": "Questionnaire ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 7},
            "questionnaire_name": {"label": "Questionnaire", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 8},
            "section_id": {"label": "Section ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 9},
            "section_name": {"label": "Section", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 10},
            "subsection_id": {"label": "Subsection ID", "data_type": "number", "is_default_column": False, "is_filterable": True, "display_order": 11},
            "subsection_name": {"label": "Subsection", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 12},
            "question_id": {"label": "Question ID", "data_type": "number", "is_default_column": False, "display_order": 13},
            "question_code": {"label": "Question Code", "data_type": "text", "is_default_column": True, "display_order": 14},
            "question_label": {"label": "Question", "data_type": "text", "is_default_column": True, "display_order": 15},
            "field_id": {"label": "Field ID", "data_type": "number", "is_default_column": False, "display_order": 16},
            "field_label": {"label": "Field", "data_type": "text", "is_default_column": True, "display_order": 17},
            "element_type": {"label": "Row Type", "data_type": "text", "is_default_column": False, "display_order": 18},
            "input_type": {"label": "Input Type", "data_type": "text", "is_default_column": False, "display_order": 19},
            "answer_value": {"label": "Answer", "data_type": "text", "is_default_column": True, "is_filterable": True, "display_order": 20},
            "remarks": {"label": "Remarks", "data_type": "text", "is_default_column": False, "display_order": 21},
            "answered_by_name": {"label": "Answered By", "data_type": "text", "is_default_column": False, "display_order": 22},
            "answered_at": {"label": "Answered At", "data_type": "datetime", "is_default_column": True, "is_filterable": True, "display_order": 23},
            "status": {"label": "Status", "data_type": "enum", "is_default_column": True, "is_filterable": True, "display_order": 24, "enum_values": ["not_started", "in_progress", "completed", "reopened"], "allowed_operators": ["eq", "neq", "in", "not_in"]},
            "completion_pct": {"label": "Completion %", "data_type": "number", "is_default_column": False, "display_order": 25},
        },
        "quick_search_fields": ["user_name", "customer_name", "questionnaire_name", "question_label", "field_label", "answer_value"],
    },

    "questionnaire_adoption": {
        "base":              "FROM questionnaires qn",
        "default_where":     [],
        "date_field":        "qn.created_at",
        "scope_created_col": "qn.created_by",
        "scope_assigned_col": None,
        "module_key":        "questionnaire",
        "joins": {
            "created_user": "LEFT JOIN users created_user ON created_user.id = qn.created_by",
        },
        "fields": {
            "id":                  ("qn.id",                 []),
            "questionnaire_code":  ("qn.questionnaire_code",  []),
            "questionnaire_name":  ("qn.questionnaire_name",  []),
            "status":              ("qn.status",              []),
            "total_assigned":      ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id)", []),
            "not_started_count":   ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id AND cq.status = 'not_started')", []),
            "in_progress_count":   ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id AND cq.status = 'in_progress')", []),
            "completed_count":     ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id AND cq.status = 'completed')", []),
            "reopened_count":      ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id AND cq.status = 'reopened')", []),
            "completion_rate_pct": ("(SELECT ROUND(SUM(CASE WHEN cq.status = 'completed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id)", []),
            "avg_days_to_complete": ("(SELECT ROUND(AVG(TIMESTAMPDIFF(DAY, cq.started_at, cq.completed_at)), 1) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qn.id AND cq.status = 'completed' AND cq.started_at IS NOT NULL)", []),
            "created_by_name":     ("created_user.full_name", ["created_user"]),
            "created_at":          ("qn.created_at",          []),
        },
        "filter_fields": {
            "status":       ("qn.status", "enum"),
            "created_at":   ("qn.created_at", "date"),
        },
        "quick_search_fields": ["questionnaire_code", "questionnaire_name"],
    },

    "questionnaire_sections": {
        "base":              "FROM questionnaire_structure qs",
        "default_where":     ["qs.is_active = 1"],
        "date_field":        "qs.created_at",
        "scope_created_col": "qs.created_by",
        "scope_assigned_col": None,
        "module_key":        "questionnaire",
        "joins": {
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = qs.questionnaire_id",
            "parent_section": "LEFT JOIN questionnaire_structure parent_qs ON parent_qs.id = qs.parent_id",
        },
        "fields": {
            "id":                  ("qs.id",                     []),
            "questionnaire_id":    ("qs.questionnaire_id",       []),
            "questionnaire_name":  ("qn.questionnaire_name",     ["questionnaire"]),
            "structure_type":      ("qs.structure_type",         []),
            "section_name":        ("qs.structure_name",         []),
            "parent_section_name": ("parent_qs.structure_name",  ["parent_section"]),
            "display_order":       ("qs.display_order",          []),
            "total_questions": (
                "(SELECT COUNT(*) FROM questionnaire_form_elements qfe WHERE qfe.element_type = 'question' AND qfe.is_active = 1 "
                "AND ((qs.structure_type = 'section' AND qfe.section_id = qs.id) OR (qs.structure_type = 'subsection' AND qfe.subsection_id = qs.id)))",
                [],
            ),
            # Total questions per section is fixed (not per-customer), so avg-of-ratios
            # across customers reduces to total-answered / (customers * per-section-total).
            # Written as plain correlated scalar subqueries — MySQL/MariaDB does not allow
            # a derived table (subquery in FROM) to reference an outer query's columns
            # without LATERAL, which the earlier per-customer GROUP BY version required.
            "avg_completion_pct": (
                "(SELECT ROUND("
                "(SELECT COUNT(*) FROM customer_questionnaire_answers cqa "
                "JOIN questionnaire_form_elements qfe ON qfe.id = cqa.element_id AND qfe.element_type = 'question' AND qfe.is_active = 1 "
                "AND ((qs.structure_type = 'section' AND qfe.section_id = qs.id) OR (qs.structure_type = 'subsection' AND qfe.subsection_id = qs.id)) "
                "JOIN customer_questionnaires cq ON cq.id = cqa.customer_questionnaire_id AND cq.questionnaire_id = qs.questionnaire_id "
                "WHERE cqa.answer_value IS NOT NULL AND cqa.answer_value <> '') * 100.0"
                " / NULLIF("
                "(SELECT COUNT(*) FROM customer_questionnaires cq2 WHERE cq2.questionnaire_id = qs.questionnaire_id) *"
                "(SELECT COUNT(*) FROM questionnaire_form_elements qfe2 WHERE qfe2.element_type = 'question' AND qfe2.is_active = 1 "
                "AND ((qs.structure_type = 'section' AND qfe2.section_id = qs.id) OR (qs.structure_type = 'subsection' AND qfe2.subsection_id = qs.id)))"
                ", 0)"
                ", 1))",
                [],
            ),
            # "Fully completed" = no question in this section is left unanswered by that
            # customer. EXISTS/NOT EXISTS are correlated subqueries in WHERE, not derived
            # tables, so nesting them is fine — unlike the GROUP-BY-over-derived-table
            # approach above.
            "fully_completed_customers": (
                "(SELECT COUNT(*) FROM customer_questionnaires cq "
                "WHERE cq.questionnaire_id = qs.questionnaire_id "
                "AND EXISTS (SELECT 1 FROM questionnaire_form_elements qfe3 WHERE qfe3.element_type = 'question' AND qfe3.is_active = 1 "
                "AND ((qs.structure_type = 'section' AND qfe3.section_id = qs.id) OR (qs.structure_type = 'subsection' AND qfe3.subsection_id = qs.id))) "
                "AND NOT EXISTS ("
                "SELECT 1 FROM questionnaire_form_elements qfe WHERE qfe.element_type = 'question' AND qfe.is_active = 1 "
                "AND ((qs.structure_type = 'section' AND qfe.section_id = qs.id) OR (qs.structure_type = 'subsection' AND qfe.subsection_id = qs.id)) "
                "AND NOT EXISTS ("
                "SELECT 1 FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.customer_questionnaire_id = cq.id "
                "AND cqa.answer_value IS NOT NULL AND cqa.answer_value <> ''"
                ")))",
                [],
            ),
        },
        "filter_fields": {
            "questionnaire_id": ("qs.questionnaire_id", "number"),
            "structure_type":   ("qs.structure_type",   "enum"),
        },
        "quick_search_fields": ["section_name"],
    },

    "questionnaire_answers": {
        "base":              "FROM customer_questionnaire_answers cqa",
        "default_where":     [],
        "date_field":        "cqa.created_at",
        "scope_created_col": "cqa.answered_by",
        "scope_assigned_col": None,
        "module_key":        "questionnaire",
        "joins": {
            "cq":            "LEFT JOIN customer_questionnaires cq ON cq.id = cqa.customer_questionnaire_id",
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = cq.questionnaire_id",
            "customer":      "LEFT JOIN customers cust ON cust.id = cq.customer_id",
            "element":       "LEFT JOIN questionnaire_form_elements qfe ON qfe.id = cqa.element_id",
            "section":       "LEFT JOIN questionnaire_structure qsec ON qsec.id = qfe.section_id",
            "subsection":    "LEFT JOIN questionnaire_structure qsub ON qsub.id = qfe.subsection_id",
            "answered_user": "LEFT JOIN users answered_user ON answered_user.id = cqa.answered_by",
        },
        "fields": {
            "id":                  ("cqa.id",                    []),
            "questionnaire_id":    ("cq.questionnaire_id",       ["cq"]),
            "questionnaire_name":  ("qn.questionnaire_name",     ["cq", "questionnaire"]),
            "customer_id":         ("cq.customer_id",            ["cq"]),
            "customer_name":       ("cust.customer_name",        ["cq", "customer"]),
            "section_id":          ("qfe.section_id",            ["element"]),
            "section_name":        ("qsec.structure_name",       ["element", "section"]),
            "subsection_id":       ("qfe.subsection_id",         ["element"]),
            "subsection_name":     ("qsub.structure_name",       ["element", "subsection"]),
            "element_id":          ("cqa.element_id",            []),
            "question_code":       ("qfe.element_code",          ["element"]),
            "question_label":      ("qfe.element_label",         ["element"]),
            "input_type":          ("qfe.input_type",            ["element"]),
            "element_type":        ("qfe.element_type",          ["element"]),
            "parent_element_id":   ("qfe.parent_element_id",     ["element"]),
            "answer_value":        ("cqa.answer_value",          []),
            "remarks":             ("cqa.remarks",               []),
            "answered_by_name":    ("answered_user.full_name",   ["answered_user"]),
            "answered_at":         ("cqa.answered_at",           []),
            "created_at":          ("cqa.created_at",            []),
        },
        "filter_fields": {
            "questionnaire_id": ("cq.questionnaire_id", "number", ["cq"]),
            "customer_id":      ("cq.customer_id",       "number", ["cq"]),
            "section_id":       ("qfe.section_id",       "number", ["element"]),
            "subsection_id":    ("qfe.subsection_id",    "number", ["element"]),
            "element_id":       ("cqa.element_id",       "number"),
            "input_type":       ("qfe.input_type",       "text", ["element"]),
            "answered_at":      ("cqa.answered_at",      "date"),
            "created_at":       ("cqa.created_at",       "date"),
        },
        "quick_search_fields": ["question_label", "answer_value", "remarks"],
    },

    "questionnaire_questions": {
        "base":              "FROM questionnaire_form_elements qfe",
        "default_where":     ["qfe.element_type = 'question'", "qfe.is_active = 1"],
        "date_field":        "qfe.created_at",
        "scope_created_col": "qfe.created_by",
        "scope_assigned_col": None,
        "module_key":        "questionnaire",
        "joins": {
            "questionnaire": "LEFT JOIN questionnaires qn ON qn.id = qfe.questionnaire_id",
            "section":       "LEFT JOIN questionnaire_structure qsec ON qsec.id = qfe.section_id",
            "subsection":    "LEFT JOIN questionnaire_structure qsub ON qsub.id = qfe.subsection_id",
        },
        "fields": {
            "id":                 ("qfe.id",                 []),
            "questionnaire_id":   ("qfe.questionnaire_id",   []),
            "questionnaire_name": ("qn.questionnaire_name",  ["questionnaire"]),
            "section_name":       ("qsec.structure_name",    ["section"]),
            "subsection_name":    ("qsub.structure_name",    ["subsection"]),
            "question_label":     ("qfe.element_label",      []),
            "input_type":         ("qfe.input_type",         []),
            "is_required":        ("qfe.is_required",        []),
            "total_assigned": ("(SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qfe.questionnaire_id)", []),
            "answered_count": ("(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value IS NOT NULL AND cqa.answer_value <> '')", []),
            "skipped_count": (
                "((SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qfe.questionnaire_id) - "
                "(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value IS NOT NULL AND cqa.answer_value <> ''))",
                [],
            ),
            "skip_rate_pct": (
                "(ROUND(((SELECT COUNT(*) FROM customer_questionnaires cq WHERE cq.questionnaire_id = qfe.questionnaire_id) - "
                "(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value IS NOT NULL AND cqa.answer_value <> '')) "
                "* 100.0 / NULLIF((SELECT COUNT(*) FROM customer_questionnaires cq2 WHERE cq2.questionnaire_id = qfe.questionnaire_id), 0), 1))",
                [],
            ),
            "yes_count": ("(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value = 'Yes')", []),
            "no_count":  ("(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value = 'No')", []),
            "na_count":  ("(SELECT COUNT(*) FROM customer_questionnaire_answers cqa WHERE cqa.element_id = qfe.id AND cqa.answer_value = 'NA')", []),
        },
        "filter_fields": {
            "questionnaire_id": ("qfe.questionnaire_id", "number"),
            "section_id":       ("qfe.section_id",       "number"),
            "subsection_id":    ("qfe.subsection_id",    "number"),
            "input_type":       ("qfe.input_type",       "text"),
            "is_required":      ("qfe.is_required",      "boolean"),
        },
        "quick_search_fields": ["question_label"],
    },

    "quotations": {
        "base":              "FROM quotations q",
        "default_where":     [],
        "date_field":        "q.created_at",
        "scope_created_col": "q.created_by",
        "scope_assigned_col": None,
        "module_key":        "opportunity",
        "joins": {
            "created_user": "LEFT JOIN users created_user ON created_user.id = q.created_by",
            "customer":     "LEFT JOIN customers cust      ON cust.id         = q.customer_id",
            "lead":         "LEFT JOIN leads l              ON l.id            = q.lead_id",
        },
        "fields": {
            "id":               ("q.id",                   []),
            "quotation_number": ("q.quotation_number",     []),
            "subject":          ("q.subject",              []),
            "amount":           ("q.amount",               []),
            "total_amount":     ("q.total_amount",         []),
            "status":           ("q.status",               []),
            "valid_until":      ("q.valid_until",          []),
            "customer_name":    ("cust.customer_name",      ["customer"]),
            "customer_id":      ("q.customer_id",          []),
            "lead_id":          ("q.lead_id",               []),
            "lead_title":       ("l.lead_title",            ["lead"]),
            "created_at":       ("q.created_at",           []),
            "created_by_name":  ("created_user.full_name", ["created_user"]),
        },
        "filter_fields": {
            "id":          ("q.id",          "number"),
            "status":      ("q.status",      "enum"),
            "created_at":  ("q.created_at",  "date"),
            "valid_until": ("q.valid_until", "date"),
            "total_amount":("q.total_amount","number"),
            "created_by":  ("q.created_by",  "number"),
        },
        "quick_search_fields": ["quotation_number", "subject", "customer_name"],
    },

    # ── Customer → Leads (cross-module join report) ──────────────────────────
    # customers is always joined in the base FROM so customer fields can be
    # filtered/sorted without requiring the user to select a customer column.
    "customer_leads": {
        "base":              "FROM leads l LEFT JOIN customers c ON c.id = l.customer_id",
        "default_where":     ["l.is_deleted = 0"],
        "date_field":        "l.created_at",
        "scope_created_col": "l.created_by",
        "scope_assigned_col": "l.assigned_to",
        "module_key":        "leads",
        "joins": {
            # customers is already in the base — no entry needed here
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = l.assigned_to",
            "created_user":  "LEFT JOIN users created_user  ON created_user.id  = l.created_by",
            "lead_source":   "LEFT JOIN lead_sources lsrc   ON lsrc.id          = l.source_id",
            "vertical":      "LEFT JOIN vertical_sectors vs  ON vs.id            = l.business_vertical_id",
        },
        "fields": {
            # ── Customer fields (c.* — always available, no join_key needed) ──
            "customer_name":     ("c.customer_name",      []),
            "customer_id":       ("l.customer_id",        []),
            "customer_vertical": ("c.customer_vertical",  []),
            "account_status":    ("c.account_status",     []),
            "customer_region":   ("c.billing_state",             []),
            "division":          ("c.division",           []),
            "group_name":        ("c.group_name",         []),
            # ── Lead fields (l.*) ─────────────────────────────────────────────
            "id":                ("l.id",                 []),
            "lead_ref_id":       ("l.lead_ref_id",        []),
            "lead_title":        ("l.lead_title",         []),
            "status":            ("l.status",             []),
            "priority":          ("l.priority",           []),
            "est_value":         ("l.est_value",          []),
            "branch":            ("l.branch",             []),
            "created_at":        ("l.created_at",         []),
            "follow_up":         ("l.follow_up",          []),
            "converted_at":      ("l.converted_at",       []),
            # ── Join fields ───────────────────────────────────────────────────
            "assigned_to_name":  ("assigned_user.full_name", ["assigned_user"]),
            "created_by_name":   ("created_user.full_name",  ["created_user"]),
            "source_name":       ("lsrc.name",        ["lead_source"]),
            "vertical_name":     ("vs.name",                 ["vertical"]),
        },
        "filter_fields": {
            # Lead filters
            "status":            ("l.status",            "enum"),
            "priority":          ("l.priority",          "enum"),
            "assigned_to":       ("l.assigned_to",       "number"),
            "created_by":        ("l.created_by",        "number"),
            "est_value":         ("l.est_value",         "number"),
            "created_at":        ("l.created_at",        "date"),
            "follow_up":         ("l.follow_up",         "date"),
            "converted_at":      ("l.converted_at",      "date"),
            # Customer filters (c.* always safe since customer is in the base JOIN)
            "customer_id":       ("l.customer_id",       "number"),
            "account_status":    ("c.account_status",    "text"),
            "customer_vertical": ("c.customer_vertical", "text"),
            "customer_region":   ("c.billing_state",            "text"),
        },
    },

    "customer_pipeline": {
        "base":              "FROM customers c",
        "default_where":     ["c.is_deleted = 0"],
        "date_field":        "c.created_at",
        "scope_created_col": "c.created_by",
        "scope_assigned_col": "c.assigned_to",
        "module_key":        "customers",
        "permission_keys":   ["reports.customers.view", "reports.leads.view", "reports.quotations.view"],
        "joins": {
            "lead":          "LEFT JOIN leads l          ON l.customer_id = c.id AND l.is_deleted = 0",
            "quotation":     "LEFT JOIN quotations q     ON q.customer_id = c.id AND (q.lead_id = l.id OR q.lead_id IS NULL)",
            "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = l.assigned_to",
        },
        "fields": {
            "id":                 ("c.id",                    []),
            "lead_id":            ("l.id",                    ["lead"]),
            "customer_name":      ("c.customer_name",         []),
            "customer_vertical":  ("c.customer_vertical",     []),
            "billing_city":       ("c.billing_city",          []),
            "customer_region":    ("c.billing_state",         []),
            "customer_status":    ("c.account_status",        []),
            "account_potential":  ("c.account_potential",     []),
            "group_name":         ("c.group_name",            []),
            "lead_ref_id":        ("l.lead_ref_id",           ["lead"]),
            "lead_title":         ("l.lead_title",            ["lead"]),
            "lead_status":        ("l.status",                ["lead"]),
            "lead_value":         ("l.est_value",             ["lead"]),
            "quotation_number":   ("q.quotation_number",      ["lead", "quotation"]),
            "quotation_status":   ("q.status",                ["lead", "quotation"]),
            "quotation_amount":   ("q.total_amount",          ["lead", "quotation"]),
            "assigned_to_name":   ("assigned_user.full_name", ["lead", "assigned_user"]),
            "created_at":         ("c.created_at",            []),
        },
        "filter_fields": {
            "id":                 ("c.id",               "number", []),
            "lead_status":        ("l.status",           "enum",   ["lead"]),
            "quotation_status":   ("q.status",           "enum",   ["lead", "quotation"]),
            "customer_region":    ("c.billing_state",    "text",   []),
            "customer_status":    ("c.account_status",   "text",   []),
            "account_potential":  ("c.account_potential","text",   []),
            "group_name":         ("c.group_name",       "text",   []),
            "assigned_to":        ("l.assigned_to",      "number", ["lead"]),
            "created_at":         ("c.created_at",       "date",   []),
            "lead_value":         ("l.est_value",        "number", ["lead"]),
            "quotation_amount":   ("q.total_amount",     "number", ["lead", "quotation"]),
        },
        "quick_search_fields": ["customer_name", "lead_title", "quotation_number"],
    },

    "lead_quotation": {
        "base":              "FROM leads l",
        "default_where":     ["l.is_deleted = 0"],
        "date_field":        "l.created_at",
        "scope_created_col": "l.created_by",
        "scope_assigned_col": "l.assigned_to",
        "module_key":        "leads",
        "permission_keys":   ["reports.leads.view", "reports.quotations.view"],
        "joins": {
            "customer":      "LEFT JOIN customers cust       ON cust.id = l.customer_id",
            "quotation":     "LEFT JOIN quotations q         ON q.lead_id = l.id",
            "assigned_user": "LEFT JOIN users assigned_user  ON assigned_user.id = l.assigned_to",
        },
        "fields": {
            "id":                   ("l.id",                    []),
            "lead_ref_id":          ("l.lead_ref_id",           []),
            "lead_title":           ("l.lead_title",            []),
            "customer_name":        ("cust.customer_name",      ["customer"]),
            "lead_status":          ("l.status",                []),
            "lead_value":           ("l.est_value",             []),
            "quotation_number":     ("q.quotation_number",      ["quotation"]),
            "quotation_status":     ("q.status",                ["quotation"]),
            "quotation_amount":     ("q.total_amount",          ["quotation"]),
            "quotation_created_at": ("q.created_at",            ["quotation"]),
            "assigned_to_name":     ("assigned_user.full_name", ["assigned_user"]),
            "created_at":           ("l.created_at",            []),
        },
        "filter_fields": {
            "lead_status":      ("l.status",       "enum",   []),
            "quotation_status": ("q.status",       "enum",   ["quotation"]),
            "assigned_to":      ("l.assigned_to",  "number", []),
            "customer_id":      ("l.customer_id",  "number", []),
            "created_at":       ("l.created_at",   "date",   []),
        },
    },

    "quotation_workorder": {
        "base":              "FROM quotations q",
        "default_where":     [],
        "date_field":        "q.created_at",
        "scope_created_col": "q.created_by",
        "scope_assigned_col": None,
        "module_key":        "opportunity",
        "permission_keys":   ["reports.quotations.view", "reports.workorders.view", "reports.leads.view", "reports.customers.view"],
        "joins": {
            "lead":      "LEFT JOIN leads l       ON l.id = q.lead_id AND l.is_deleted = 0",
            "customer":  "LEFT JOIN customers cust ON cust.id = q.customer_id",
            "workorder": "LEFT JOIN work_orders wo ON (wo.quotation_id = q.id OR (q.lead_id IS NOT NULL AND wo.lead_id = q.lead_id))",
        },
        "fields": {
            "id":                 ("q.id",               []),
            "lead_id":            ("l.id",               ["lead"]),
            "quotation_number":   ("q.quotation_number", []),
            "quotation_status":   ("q.status",           []),
            "quotation_amount":   ("q.total_amount",     []),
            "lead_title":         ("l.lead_title",       ["lead"]),
            "customer_name":      ("cust.customer_name", ["customer"]),
            "work_order_number":  ("wo.wo_number",       ["workorder"]),
            "work_order_value":   ("wo.wo_value",        ["workorder"]),
            "work_order_status":  ("wo.status",          ["workorder"]),
            "created_at":         ("q.created_at",       []),
        },
        "filter_fields": {
            "quotation_status":  ("q.status",      "enum",   []),
            "work_order_status": ("wo.status",     "text",   ["workorder"]),
            "customer_id":       ("q.customer_id", "number", []),
            "created_at":        ("q.created_at",  "date",   []),
        },
    },

    "tender_workorder": {
        "base":              "FROM tenders t",
        "default_where":     ["t.is_deleted = 0"],
        "date_field":        "t.created_at",
        "scope_created_col": "t.created_by",
        "scope_assigned_col": "t.assigned_to",
        "module_key":        "tenders",
        "permission_keys":   ["reports.tenders.view", "reports.workorders.view", "reports.customers.view"],
        "joins": {
            "customer":      "LEFT JOIN customers cust       ON cust.id = t.customer_id",
            "workorder":     "LEFT JOIN work_orders wo       ON (wo.tender_id = t.id OR wo.wo_number = t.wrk_order_id)",
            "assigned_user": "LEFT JOIN users assigned_user  ON assigned_user.id = t.assigned_to",
        },
        "fields": {
            "id":                 ("t.id",                    []),
            "tender_ref_id":      ("t.tender_num",         []),
            "tender_title":       ("t.tender_title",          []),
            "tender_result":      ("t.result",                []),
            "bid_amount":         ("t.bid_amount",            []),
            "customer_name":      ("cust.customer_name",      ["customer"]),
            "work_order_number":  ("wo.wo_number",            ["workorder"]),
            "work_order_value":   ("wo.wo_value",             ["workorder"]),
            "work_order_status":  ("wo.status",               ["workorder"]),
            "assigned_to_name":   ("assigned_user.full_name", ["assigned_user"]),
            "created_at":         ("t.created_at",            []),
        },
        "filter_fields": {
            "tender_result":     ("t.result",      "enum",   []),
            "work_order_status": ("wo.status",     "text",   ["workorder"]),
            "assigned_to":       ("t.assigned_to", "number", []),
            "customer_id":       ("t.customer_id", "number", []),
            "created_at":        ("t.created_at",  "date",   []),
        },
    },

    # ── Linkage reports — drilldown destinations for identity fields ──────────
    # Each shows the source record plus its related tender/quotation/work-order/
    # EMD-BG data in one place, so an identity-field click (lead_title,
    # tender_ref_id, quotation_number, wo_number, instrument_number) lands on a
    # report with real linkage instead of a single bare row.

    "lead_linkage": {
        "base":              "FROM leads l",
        "default_where":     ["l.is_deleted = 0"],
        "date_field":        "l.created_at",
        "scope_created_col": "l.created_by",
        "scope_assigned_col": "l.assigned_to",
        "module_key":        "leads",
        "permission_keys":   ["reports.leads.view", "reports.tenders.view", "reports.quotations.view", "reports.workorders.view"],
        "joins": {
            "customer":  "LEFT JOIN customers cust  ON cust.id = l.customer_id",
            "tender":    "LEFT JOIN tenders t       ON t.lead_id = l.id",
            "quotation": "LEFT JOIN quotations q    ON q.lead_id = l.id",
            "workorder": "LEFT JOIN work_orders wo  ON wo.lead_id = l.id",
        },
        "fields": {
            "id":                 ("l.id",                   []),
            "lead_ref_id":        ("l.lead_ref_id",           []),
            "lead_title":         ("l.lead_title",            []),
            "status":             ("l.status",                []),
            "priority":           ("l.priority",              []),
            "est_value":          ("l.est_value",             []),
            "customer_name":      ("l.customer_name",         []),
            "customer_id":        ("l.customer_id",           []),
            "tender_ref_id":      ("t.tender_num",            ["tender"]),
            "tender_title":       ("t.tender_title",          ["tender"]),
            "tender_status":      ("t.tender_status",         ["tender"]),
            "quotation_number":   ("q.quotation_number",      ["quotation"]),
            "quotation_status":   ("q.status",                ["quotation"]),
            "quotation_amount":   ("q.total_amount",          ["quotation"]),
            "work_order_number":  ("wo.wo_number",            ["workorder"]),
            "work_order_status":  ("wo.status",               ["workorder"]),
            "work_order_value":   ("wo.wo_value",             ["workorder"]),
            "activity_count":     ("(SELECT COUNT(*) FROM kam_activities ka WHERE ka.lead_id = l.id)", []),
            "last_activity_date": ("(SELECT MAX(ka.activity_date) FROM kam_activities ka WHERE ka.lead_id = l.id)", []),
            "last_activity_type": ("(SELECT ka2.activity_type FROM kam_activities ka2 WHERE ka2.lead_id = l.id ORDER BY ka2.activity_date DESC LIMIT 1)", []),
            "next_followup_date": ("(SELECT MAX(ka.next_action_date) FROM kam_activities ka WHERE ka.lead_id = l.id)", []),
            "created_at":         ("l.created_at",            []),
        },
        "filter_fields": {
            "id":                ("l.id",           "number", []),
            "status":            ("l.status",       "enum",   []),
            "tender_status":     ("t.tender_status","enum",   ["tender"]),
            "quotation_status":  ("q.status",       "enum",   ["quotation"]),
            "work_order_status": ("wo.status",      "text",   ["workorder"]),
            "customer_id":       ("l.customer_id",  "number", []),
            "created_at":        ("l.created_at",   "date",   []),
            "est_value":         ("l.est_value",         "number", []),
            "quotation_amount":  ("q.total_amount",      "number", ["quotation"]),
            "work_order_value":  ("wo.wo_value",         "number", ["workorder"]),
        },
        "quick_search_fields": ["lead_title", "tender_title", "quotation_number", "work_order_number"],
    },

    "tender_linkage": {
        "base":              "FROM tenders t",
        "default_where":     ["t.is_deleted = 0"],
        "date_field":        "t.created_at",
        "scope_created_col": "t.created_by",
        "scope_assigned_col": "t.assigned_to",
        "module_key":        "tenders",
        "permission_keys":   ["reports.tenders.view", "reports.leads.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        "joins": {
            "lead":      "LEFT JOIN leads l          ON l.id = t.lead_id",
            "customer":  "LEFT JOIN customers cust   ON cust.id = t.customer_id",
            "emdbg":     "LEFT JOIN emdbg e          ON e.tender_id = t.id",
            "quotation": "LEFT JOIN quotations q     ON q.tender_id = t.id",
            "workorder": "LEFT JOIN work_orders wo   ON wo.tender_id = t.id",
        },
        "fields": {
            "id":                ("t.id",                  []),
            "tender_ref_id":     ("t.tender_num",           []),
            "tender_title":      ("t.tender_title",         []),
            "status":            ("t.tender_status",        []),
            "result":            ("t.result",               []),
            "bid_amount":        ("t.bid_amount",           []),
            "customer_name":     ("t.customer_name",        []),
            "customer_id":       ("t.customer_id",          []),
            "lead_id":           ("t.lead_id",              []),
            "lead_title":        ("l.lead_title",           ["lead"]),
            "emd_bg_number":     ("e.instrument_number",    ["emdbg"]),
            "emd_bg_amount":     ("e.amount",                ["emdbg"]),
            "emd_bg_status":     ("e.status",                ["emdbg"]),
            "quotation_number":  ("q.quotation_number",     ["quotation"]),
            "quotation_status":  ("q.status",                ["quotation"]),
            "work_order_number": ("wo.wo_number",           ["workorder"]),
            "work_order_status": ("wo.status",               ["workorder"]),
            "work_order_value":  ("wo.wo_value",            ["workorder"]),
            "created_at":        ("t.created_at",           []),
        },
        "filter_fields": {
            "id":         ("t.id",          "number", []),
            "lead_id":    ("t.lead_id",     "number", []),
            "status":     ("t.tender_status","enum",  []),
            "result":     ("t.result",      "enum",   []),
            "customer_id":("t.customer_id", "number", []),
            "created_at": ("t.created_at",  "date",   []),
            "quotation_status":  ("q.status",   "enum",   ["quotation"]),
            "work_order_status": ("wo.status",  "text",   ["workorder"]),
            "emd_bg_status":     ("e.status",   "text",   ["emdbg"]),
            "bid_amount":        ("t.bid_amount",   "number", []),
            "emd_bg_amount":     ("e.amount",       "number", ["emdbg"]),
            "work_order_value":  ("wo.wo_value",    "number", ["workorder"]),
        },
        "quick_search_fields": ["tender_ref_id", "tender_title", "quotation_number", "work_order_number", "emd_bg_number"],
    },

    "quotation_linkage": {
        "base":              "FROM quotations q",
        "default_where":     [],
        "date_field":        "q.created_at",
        "scope_created_col": "q.created_by",
        "scope_assigned_col": None,
        "module_key":        "opportunity",
        "permission_keys":   ["reports.quotations.view", "reports.leads.view", "reports.tenders.view", "reports.workorders.view"],
        "joins": {
            "lead":      "LEFT JOIN leads l         ON l.id = q.lead_id",
            "customer":  "LEFT JOIN customers cust  ON cust.id = q.customer_id",
            "tender":    "LEFT JOIN tenders t       ON t.id = q.tender_id",
            "workorder": "LEFT JOIN work_orders wo  ON (wo.quotation_id = q.id OR (q.lead_id IS NOT NULL AND wo.lead_id = q.lead_id))",
        },
        "fields": {
            "id":                ("q.id",                  []),
            "quotation_number":  ("q.quotation_number",     []),
            "subject":           ("q.subject",              []),
            "amount":            ("q.amount",               []),
            "total_amount":      ("q.total_amount",         []),
            "status":            ("q.status",               []),
            "customer_name":     ("cust.customer_name",     ["customer"]),
            "customer_id":       ("q.customer_id",          []),
            "lead_id":           ("q.lead_id",              []),
            "lead_title":        ("l.lead_title",           ["lead"]),
            "tender_ref_id":     ("t.tender_num",           ["tender"]),
            "tender_title":      ("t.tender_title",         ["tender"]),
            "work_order_number": ("wo.wo_number",           ["workorder"]),
            "work_order_status": ("wo.status",               ["workorder"]),
            "work_order_value":  ("wo.wo_value",            ["workorder"]),
            "created_at":        ("q.created_at",           []),
        },
        "filter_fields": {
            "id":         ("q.id",          "number", []),
            "lead_id":    ("q.lead_id",     "number", []),
            "tender_id":  ("q.tender_id",   "number", []),
            "status":     ("q.status",      "enum",   []),
            "customer_id":("q.customer_id", "number", []),
            "created_at": ("q.created_at",  "date",   []),
            "work_order_status": ("wo.status", "text",   ["workorder"]),
            "amount":            ("q.amount",      "number", []),
            "total_amount":      ("q.total_amount", "number", []),
            "work_order_value":  ("wo.wo_value",    "number", ["workorder"]),
        },
        "quick_search_fields": ["quotation_number", "subject", "lead_title", "tender_title", "work_order_number"],
    },

    "workorder_linkage": {
        "base":              "FROM work_orders wo",
        "default_where":     [],
        "date_field":        "wo.created_at",
        "scope_created_col": "wo.created_by",
        "scope_assigned_col": None,
        "module_key":        "workorders",
        "permission_keys":   ["reports.workorders.view", "reports.leads.view", "reports.tenders.view", "reports.quotations.view"],
        "joins": {
            "lead":      "LEFT JOIN leads l         ON l.id = wo.lead_id",
            "customer":  "LEFT JOIN customers cust  ON cust.id = wo.customer_id",
            "tender":    "LEFT JOIN tenders t       ON t.id = wo.tender_id",
            "quotation": "LEFT JOIN quotations q    ON q.id = wo.quotation_id",
        },
        "fields": {
            "id":               ("wo.id",                 []),
            "wo_number":        ("wo.wo_number",          []),
            "project_title":    ("wo.project_title",      []),
            "wo_type":          ("wo.wo_type",            []),
            "status":           ("wo.status",             []),
            "po_number":        ("wo.po_number",          []),
            "po_value":         ("wo.po_value",           []),
            "wo_value":         ("wo.wo_value",           []),
            "customer_name":    ("wo.customer_name",      []),
            "customer_id":      ("wo.customer_id",        []),
            "lead_id":          ("wo.lead_id",            []),
            "lead_title":       ("l.lead_title",          ["lead"]),
            "tender_ref_id":    ("t.tender_num",          ["tender"]),
            "tender_title":     ("t.tender_title",        ["tender"]),
            "quotation_number": ("q.quotation_number",    ["quotation"]),
            "quotation_status": ("q.status",               ["quotation"]),
            "created_at":       ("wo.created_at",         []),
        },
        "filter_fields": {
            "id":         ("wo.id",          "number", []),
            "lead_id":    ("wo.lead_id",     "number", []),
            "tender_id":  ("wo.tender_id",   "number", []),
            "status":     ("wo.status",      "text",   []),
            "customer_id":("wo.customer_id", "number", []),
            "created_at": ("wo.created_at",  "date",   []),
            "quotation_status": ("q.status", "enum",   ["quotation"]),
            "po_value":          ("wo.po_value", "number", []),
            "wo_value":          ("wo.wo_value",  "number", []),
        },
        "quick_search_fields": ["wo_number", "project_title", "lead_title", "tender_title", "quotation_number"],
    },

    "emdbg_linkage": {
        "base":              "FROM emdbg e",
        "default_where":     [],
        "date_field":        "e.created_at",
        "scope_created_col": "e.created_by",
        "scope_assigned_col": None,
        "module_key":        "emdbg",
        "permission_keys":   ["reports.emdbg.view", "reports.tenders.view", "reports.leads.view", "reports.workorders.view"],
        "joins": {
            "tender":    "LEFT JOIN tenders t        ON t.id = e.tender_id",
            "lead":      "LEFT JOIN leads l           ON l.id = t.lead_id",
            "customer":  "LEFT JOIN customers cust    ON cust.id = e.customer_id",
            "workorder": "LEFT JOIN work_orders wo    ON wo.id = e.work_order_id",
        },
        "fields": {
            "id":                ("e.id",                  []),
            "instrument_type":   ("e.instrument_type",      []),
            "instrument_number": ("e.instrument_number",    []),
            "bank_name":         ("e.bank_name",            []),
            "amount":            ("e.amount",               []),
            "issue_date":        ("e.issued_date",          []),
            "expiry_date":       ("e.expiry_date",          []),
            "status":            ("e.status",               []),
            "tender_id":         ("e.tender_id",            []),
            "tender_ref_id":     ("t.tender_num",           ["tender"]),
            "tender_title":      ("t.tender_title",         ["tender"]),
            "customer_name":     ("e.client_name",          []),
            "customer_id":       ("e.customer_id",          []),
            "lead_id":           ("l.id",                   ["tender", "lead"]),
            "lead_title":        ("l.lead_title",           ["tender", "lead"]),
            "work_order_number": ("wo.wo_number",           ["workorder"]),
            "work_order_status": ("wo.status",               ["workorder"]),
            "created_at":        ("e.created_at",           []),
        },
        "filter_fields": {
            "id":        ("e.id",        "number", []),
            "tender_id": ("e.tender_id", "number", []),
            "status":    ("e.status",    "text",   []),
            "work_order_status": ("wo.status", "text",   ["workorder"]),
            "amount":            ("e.amount",     "number", []),
            "expiry_date":       ("e.expiry_date","date",   []),
        },
        "quick_search_fields": ["instrument_number", "tender_ref_id", "tender_title", "lead_title", "work_order_number"],
    },
}

REPORT_ENGINE_CONFIG["questionnaire_role_user"] = {
    **REPORT_ENGINE_CONFIG["questionnaire_user"],
    "report_type_name": None,
    "description": "Internal user-level questionnaire summary for a selected role",
    "visible": False,
}


def _merge_meta(*parts: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for part in parts:
        merged.update(part)
    return merged


def _chain_report_config(
    *,
    name: str,
    description: str,
    base: str,
    default_where: list[str],
    date_field: str,
    scope_created_col: str,
    scope_assigned_col: Optional[str],
    module_key: str,
    permission_keys: list[str],
    joins: dict[str, str],
    fields: dict[str, tuple[str, list[str]]],
    filter_fields: dict[str, tuple],
    sort_order: int,
) -> dict[str, Any]:
    return {
        "report_type_name": name,
        "description": description,
        "base": base,
        "default_where": default_where,
        "date_field": date_field,
        "scope_created_col": scope_created_col,
        "scope_assigned_col": scope_assigned_col,
        "module_key": module_key,
        "permission_keys": permission_keys,
        "module_permission_key": permission_keys[0] if permission_keys else None,
        "joins": joins,
        "fields": fields,
        "filter_fields": filter_fields,
        "sort_order": sort_order,
    }


_CUSTOMER_FIELDS = {
    "customer_name":   ("c.customer_name",   ["customer"]),
    "customer_region": ("c.billing_state",   ["customer"]),
    "customer_status": ("c.account_status",  ["customer"]),
}
_LEAD_FIELDS = {
    "lead_ref_id":      ("l.lead_ref_id",              ["lead"]),
    "lead_title":       ("l.lead_title",               ["lead"]),
    "lead_status":      ("l.status",                   ["lead"]),
    "lead_value":       ("l.est_value",                ["lead"]),
    "lead_created_at":  ("l.created_at",               ["lead"]),
    "assigned_to_name": ("assigned_user.full_name",    ["assigned_user"]),
}
_TENDER_FIELDS = {
    "tender_ref_id":     ("t.tender_num",    ["tender"]),
    "tender_title":      ("t.tender_title",  ["tender"]),
    "tender_status":     ("t.tender_status", ["tender"]),
    "tender_result":     ("t.result",        ["tender"]),
    "bid_amount":        ("t.bid_amount",    ["tender"]),
    "tender_created_at": ("t.created_at",   ["tender"]),
}
_QUOTATION_FIELDS = {
    "quotation_number": ("q.quotation_number", ["quotation"]),
    "quotation_subject": ("q.subject", ["quotation"]),
    "quotation_status": ("q.status", ["quotation"]),
    "quotation_amount": ("q.total_amount", ["quotation"]),
    "quotation_created_at": ("q.created_at", ["quotation"]),
}
_QUOTATION_BASE_FIELDS = {
    "quotation_number": ("q.quotation_number", []),
    "quotation_subject": ("q.subject", []),
    "quotation_status": ("q.status", []),
    "quotation_amount": ("q.total_amount", []),
    "quotation_created_at": ("q.created_at", []),
}
_WORKORDER_FIELDS = {
    "work_order_number": ("wo.wo_number", ["workorder"]),
    "work_order_title": ("wo.project_title", ["workorder"]),
    "work_order_status": ("wo.status", ["workorder"]),
    "work_order_value": ("wo.wo_value", ["workorder"]),
    "work_order_created_at": ("wo.created_at", ["workorder"]),
}
_WORKORDER_BASE_FIELDS = {
    "work_order_number": ("wo.wo_number", []),
    "work_order_title": ("wo.project_title", []),
    "work_order_status": ("wo.status", []),
    "work_order_value": ("wo.wo_value", []),
    "work_order_created_at": ("wo.created_at", []),
}
_EMDBG_FIELDS = {
    "emdbg_reference": ("e.reference_num", ["emdbg"]),
    "instrument_type": ("e.instrument_type", ["emdbg"]),
    "instrument_number": ("e.instrument_number", ["emdbg"]),
    "bank_name": ("e.bank_name", ["emdbg"]),
    "emdbg_amount": ("e.amount", ["emdbg"]),
    "emdbg_status": ("e.status", ["emdbg"]),
    "expiry_date": ("e.expiry_date", ["emdbg"]),
}
_EMDBG_BASE_FIELDS = {
    "emdbg_reference": ("e.reference_num", []),
    "instrument_type": ("e.instrument_type", []),
    "instrument_number": ("e.instrument_number", []),
    "bank_name": ("e.bank_name", []),
    "emdbg_amount": ("e.amount", []),
    "emdbg_status": ("e.status", []),
    "expiry_date": ("e.expiry_date", []),
}
_KAM_FIELDS = {
    "kam_subject": ("ka.subject", ["kam_activity"]),
    "kam_activity_type": ("ka.activity_type", ["kam_activity"]),
    "kam_mode": ("ka.mode", ["kam_activity"]),
    "kam_status": ("ka.status", ["kam_activity"]),
    "kam_activity_date": ("ka.activity_date", ["kam_activity"]),
    "next_action_date": ("ka.next_action_date", ["kam_activity"]),
    "duration_minutes": ("ka.duration_minutes", ["kam_activity"]),
    "kam_owner_name": ("owner_user.full_name", ["kam_activity", "kam_user"]),
}
_KAM_BASE_FIELDS = {
    "kam_subject": ("ka.subject", []),
    "kam_activity_type": ("ka.activity_type", []),
    "kam_mode": ("ka.mode", []),
    "kam_status": ("ka.status", []),
    "kam_activity_date": ("ka.activity_date", []),
    "next_action_date": ("ka.next_action_date", []),
    "duration_minutes": ("ka.duration_minutes", []),
    "kam_owner_name": ("owner_user.full_name", ["kam_user"]),
}

_JOIN_CUSTOMER_FROM_LEAD = "LEFT JOIN customers c ON c.id = l.customer_id"
_JOIN_CUSTOMER_FROM_TENDER = "LEFT JOIN customers c ON c.id = t.customer_id"
_JOIN_CUSTOMER_FROM_QUOTATION = "LEFT JOIN customers c ON c.id = q.customer_id"
_JOIN_CUSTOMER_FROM_WORKORDER = "LEFT JOIN customers c ON c.id = wo.customer_id"
_JOIN_LEAD_FROM_CUSTOMER = "LEFT JOIN leads l ON l.customer_id = c.id AND l.is_deleted = 0"
_JOIN_LEAD_FROM_QUOTATION = "LEFT JOIN leads l ON l.id = q.lead_id AND l.is_deleted = 0"
_JOIN_TENDER_FROM_CUSTOMER = "LEFT JOIN tenders t ON t.customer_id = c.id AND t.is_deleted = 0"
_JOIN_QUOTATION_FROM_LEAD = "LEFT JOIN quotations q ON q.lead_id = l.id"
_JOIN_QUOTATION_FROM_TENDER = "LEFT JOIN quotations q ON q.tender_id = t.id"
_JOIN_QUOTATION_FROM_CUSTOMER_LEAD = "LEFT JOIN quotations q ON q.customer_id = c.id AND (q.lead_id = l.id OR q.lead_id IS NULL)"
_JOIN_WORKORDER_FROM_QUOTATION_LEAD = "LEFT JOIN work_orders wo ON (wo.quotation_id = q.id OR wo.lead_id = l.id)"
_JOIN_WORKORDER_FROM_TENDER_QUOTATION = "LEFT JOIN work_orders wo ON (wo.quotation_id = q.id OR wo.tender_id = t.id OR wo.wo_number = t.wrk_order_id)"
_JOIN_WORKORDER_FROM_TENDER = "LEFT JOIN work_orders wo ON (wo.tender_id = t.id OR wo.wo_number = t.wrk_order_id)"
_JOIN_WORKORDER_FROM_CUSTOMER_PIPELINE = "LEFT JOIN work_orders wo ON (wo.quotation_id = q.id OR wo.lead_id = l.id)"
_JOIN_EMDBG_FROM_TENDER = "LEFT JOIN emdbg e ON e.tender_id = t.id"
_JOIN_EMDBG_FROM_WORKORDER = "LEFT JOIN emdbg e ON (e.work_order_id = wo.id OR (wo.tender_id IS NOT NULL AND e.tender_id = wo.tender_id))"
_JOIN_EMDBG_FROM_PIPELINE = "LEFT JOIN emdbg e ON (e.work_order_id = wo.id OR (wo.tender_id IS NOT NULL AND e.tender_id = wo.tender_id))"
_JOIN_KAM_FROM_LEAD = "LEFT JOIN kam_activities ka ON ka.lead_id = l.id"
_JOIN_KAM_FROM_CUSTOMER = "LEFT JOIN kam_activities ka ON ka.customer_id = c.id"
_JOIN_KAM_USER = "LEFT JOIN users owner_user ON owner_user.id = ka.user_id"
_JOIN_ASSIGNED_USER = "LEFT JOIN users assigned_user ON assigned_user.id = l.assigned_to"

REPORT_ENGINE_CONFIG.update({
    "kam_activities": _chain_report_config(
        name="KAM Activities",
        description="KAM activity records with customer and lead context",
        base="FROM kam_activities ka",
        default_where=[],
        date_field="ka.activity_date",
        scope_created_col="ka.created_by",
        scope_assigned_col="ka.user_id",
        module_key="kam",
        permission_keys=["reports.kam.view"],
        joins={
            "customer": "LEFT JOIN customers c ON c.id = ka.customer_id",
            "lead": "LEFT JOIN leads l ON l.id = ka.lead_id AND l.is_deleted = 0",
            "kam_user": _JOIN_KAM_USER,
        },
        fields=_merge_meta(
            {"id": ("ka.id", [])},
            _KAM_BASE_FIELDS,
            {"customer_name": ("c.customer_name", ["customer"]), "lead_title": ("l.lead_title", ["lead"]), "created_at": ("ka.created_at", [])},
        ),
        filter_fields={
            "kam_activity_type": ("ka.activity_type", "text"),
            "kam_status": ("ka.status", "text"),
            "kam_mode": ("ka.mode", "text"),
            "kam_activity_date": ("ka.activity_date", "date"),
            "next_action_date": ("ka.next_action_date", "date"),
            "customer_id": ("ka.customer_id", "number"),
            "lead_id": ("ka.lead_id", "number"),
            "user_id": ("ka.user_id", "number"),
            "created_at": ("ka.created_at", "date"),
        },
        sort_order=20,
    ),
    "lead_workorder": _chain_report_config(
        name="Lead to Work Order",
        description="Leads and linked direct work orders",
        base="FROM leads l",
        default_where=["l.is_deleted = 0"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="leads",
        permission_keys=["reports.leads.view", "reports.workorders.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "workorder": "LEFT JOIN work_orders wo ON wo.lead_id = l.id", "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "assigned_to": ("l.assigned_to", "number"),
            "customer_id": ("l.customer_id", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=21,
    ),
    "lead_quotation_workorder": _chain_report_config(
        name="Lead to Quotation to Work Order",
        description="Leads with linked quotations and work orders",
        base="FROM leads l",
        default_where=["l.is_deleted = 0"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="leads",
        permission_keys=["reports.leads.view", "reports.quotations.view", "reports.workorders.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "assigned_to": ("l.assigned_to", "number"),
            "customer_id": ("l.customer_id", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=22,
    ),
    "lead_quotation_workorder_emdbg": _chain_report_config(
        name="Lead to Quotation to Work Order to EMD/BG",
        description="Leads, quotations, work orders, and linked EMD/BG instruments",
        base="FROM leads l",
        default_where=["l.is_deleted = 0"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="leads",
        permission_keys=["reports.leads.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "emdbg": _JOIN_EMDBG_FROM_PIPELINE, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=23,
    ),
    "lead_quotation_workorder_kam_activities": _chain_report_config(
        name="Lead Pipeline with KAM Activities",
        description="Leads, quotations, work orders, and KAM activities connected to the lead",
        base="FROM leads l",
        default_where=["l.is_deleted = 0"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="leads",
        permission_keys=["reports.leads.view", "reports.quotations.view", "reports.workorders.view", "reports.kam.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "kam_activity": _JOIN_KAM_FROM_LEAD, "kam_user": _JOIN_KAM_USER, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "kam_status": ("ka.status", "text", ["kam_activity"]),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=24,
    ),
    "lead_kam_activities": _chain_report_config(
        name="Leads with KAM Activities",
        description="Leads and their KAM activities",
        base="FROM leads l",
        default_where=["l.is_deleted = 0"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="leads",
        permission_keys=["reports.leads.view", "reports.kam.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "kam_activity": _JOIN_KAM_FROM_LEAD, "kam_user": _JOIN_KAM_USER, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "kam_status": ("ka.status", "text", ["kam_activity"]),
            "assigned_to": ("l.assigned_to", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=25,
    ),
    "customer_kam_activities": _chain_report_config(
        name="Customers with KAM Activities",
        description="Customers and their KAM activities",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.kam.view"],
        joins={"kam_activity": _JOIN_KAM_FROM_CUSTOMER, "kam_user": _JOIN_KAM_USER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "kam_status": ("ka.status", "text", ["kam_activity"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=26,
    ),
    "customer_pipeline_workorder": _chain_report_config(
        name="Customer to Lead to Quotation to Work Order",
        description="Customers with linked leads, quotations, and work orders",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.leads.view", "reports.quotations.view", "reports.workorders.view"],
        joins={"lead": _JOIN_LEAD_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_CUSTOMER_LEAD, "workorder": _JOIN_WORKORDER_FROM_CUSTOMER_PIPELINE, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _LEAD_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "lead_status": ("l.status", "enum", ["lead"]),
            "quotation_status": ("q.status", "enum", ["lead", "quotation"]),
            "work_order_status": ("wo.status", "text", ["lead", "quotation", "workorder"]),
            "assigned_to": ("l.assigned_to", "number", ["lead"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=27,
    ),
    "customer_pipeline_workorder_emdbg": _chain_report_config(
        name="Customer Pipeline with EMD/BG",
        description="Customers, leads, quotations, work orders, and EMD/BG instruments",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.leads.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"lead": _JOIN_LEAD_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_CUSTOMER_LEAD, "workorder": _JOIN_WORKORDER_FROM_CUSTOMER_PIPELINE, "emdbg": _JOIN_EMDBG_FROM_PIPELINE, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _LEAD_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "lead_status": ("l.status", "enum", ["lead"]),
            "quotation_status": ("q.status", "enum", ["lead", "quotation"]),
            "work_order_status": ("wo.status", "text", ["lead", "quotation", "workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=28,
    ),
    "customer_pipeline_workorder_kam_activities": _chain_report_config(
        name="Customer Pipeline with KAM Activities",
        description="Customers, leads, quotations, work orders, and KAM activities",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.leads.view", "reports.quotations.view", "reports.workorders.view", "reports.kam.view"],
        joins={"lead": _JOIN_LEAD_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_CUSTOMER_LEAD, "workorder": _JOIN_WORKORDER_FROM_CUSTOMER_PIPELINE, "kam_activity": _JOIN_KAM_FROM_LEAD, "kam_user": _JOIN_KAM_USER, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _LEAD_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "lead_status": ("l.status", "enum", ["lead"]),
            "quotation_status": ("q.status", "enum", ["lead", "quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=29,
    ),
    "customer_tenders": _chain_report_config(
        name="Customers with Tenders",
        description="Customers and their linked tenders",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "tender_result": ("t.result", "enum", ["tender"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=30,
    ),
    "customer_tender_quotation": _chain_report_config(
        name="Customer to Tender to Quotation",
        description="Customers, tenders, and linked quotations",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.quotations.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_TENDER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _QUOTATION_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=31,
    ),
    "customer_tender_workorder": _chain_report_config(
        name="Customer to Tender to Work Order",
        description="Customers, tenders, and linked work orders",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.workorders.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "workorder": _JOIN_WORKORDER_FROM_TENDER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=32,
    ),
    "customer_tender_emdbg": _chain_report_config(
        name="Customer to Tender to EMD/BG",
        description="Customers, tenders, and linked EMD/BG instruments",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.emdbg.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "emdbg": _JOIN_EMDBG_FROM_TENDER},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "tender_result": ("t.result", "enum", ["tender"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=33,
    ),
    "customer_tender_workorder_emdbg": _chain_report_config(
        name="Customer to Tender to Work Order to EMD/BG",
        description="Customers, tenders, work orders, and linked EMD/BG instruments",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "workorder": _JOIN_WORKORDER_FROM_TENDER, "emdbg": _JOIN_EMDBG_FROM_PIPELINE},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=34,
    ),
    "customer_tender_quotation_workorder": _chain_report_config(
        name="Customer to Tender to Quotation to Work Order",
        description="Customers, tenders, quotations, and linked work orders",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.quotations.view", "reports.workorders.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_TENDER, "workorder": _JOIN_WORKORDER_FROM_TENDER_QUOTATION},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=35,
    ),
    "customer_tender_quotation_workorder_emdbg": _chain_report_config(
        name="Customer Tender Pipeline with EMD/BG",
        description="Customers, tenders, quotations, work orders, and EMD/BG instruments",
        base="FROM customers c",
        default_where=["c.is_deleted = 0"],
        date_field="c.created_at",
        scope_created_col="c.created_by",
        scope_assigned_col="c.assigned_to",
        module_key="customers",
        permission_keys=["reports.customers.view", "reports.tenders.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"tender": _JOIN_TENDER_FROM_CUSTOMER, "quotation": _JOIN_QUOTATION_FROM_TENDER, "workorder": _JOIN_WORKORDER_FROM_TENDER_QUOTATION, "emdbg": _JOIN_EMDBG_FROM_PIPELINE},
        fields=_merge_meta({"id": ("c.id", [])}, _CUSTOMER_FIELDS, _TENDER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "customer_status": ("c.account_status", "text"),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "created_at": ("c.created_at", "date"),
        },
        sort_order=36,
    ),
    "tender_quotation": _chain_report_config(
        name="Tender to Quotation",
        description="Tenders and linked quotations",
        base="FROM tenders t",
        default_where=["t.is_deleted = 0"],
        date_field="t.created_at",
        scope_created_col="t.created_by",
        scope_assigned_col="t.assigned_to",
        module_key="tenders",
        permission_keys=["reports.tenders.view", "reports.quotations.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_TENDER, "quotation": _JOIN_QUOTATION_FROM_TENDER, "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to"},
        fields=_merge_meta({"id": ("t.id", [])}, _TENDER_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, {"assigned_to_name": ("assigned_user.full_name", ["assigned_user"])}),
        filter_fields={
            "tender_status": ("t.tender_status", "enum"),
            "tender_result": ("t.result", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "assigned_to": ("t.assigned_to", "number"),
            "customer_id": ("t.customer_id", "number"),
            "created_at": ("t.created_at", "date"),
        },
        sort_order=35,
    ),
    "tender_quotation_workorder": _chain_report_config(
        name="Tender to Quotation to Work Order",
        description="Tenders, quotations, and linked work orders",
        base="FROM tenders t",
        default_where=["t.is_deleted = 0"],
        date_field="t.created_at",
        scope_created_col="t.created_by",
        scope_assigned_col="t.assigned_to",
        module_key="tenders",
        permission_keys=["reports.tenders.view", "reports.quotations.view", "reports.workorders.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_TENDER, "quotation": _JOIN_QUOTATION_FROM_TENDER, "workorder": _JOIN_WORKORDER_FROM_TENDER_QUOTATION, "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to"},
        fields=_merge_meta({"id": ("t.id", [])}, _TENDER_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, {"assigned_to_name": ("assigned_user.full_name", ["assigned_user"])}),
        filter_fields={
            "tender_status": ("t.tender_status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "assigned_to": ("t.assigned_to", "number"),
            "created_at": ("t.created_at", "date"),
        },
        sort_order=36,
    ),
    "tender_emdbg": _chain_report_config(
        name="Tender to EMD/BG",
        description="Tenders and linked EMD/BG instruments",
        base="FROM tenders t",
        default_where=["t.is_deleted = 0"],
        date_field="t.created_at",
        scope_created_col="t.created_by",
        scope_assigned_col="t.assigned_to",
        module_key="tenders",
        permission_keys=["reports.tenders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_TENDER, "emdbg": _JOIN_EMDBG_FROM_TENDER, "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to"},
        fields=_merge_meta({"id": ("t.id", [])}, _TENDER_FIELDS, _CUSTOMER_FIELDS, _EMDBG_FIELDS, {"assigned_to_name": ("assigned_user.full_name", ["assigned_user"])}),
        filter_fields={
            "tender_status": ("t.tender_status", "enum"),
            "tender_result": ("t.result", "enum"),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "created_at": ("t.created_at", "date"),
        },
        sort_order=37,
    ),
    "tender_workorder_emdbg": _chain_report_config(
        name="Tender to Work Order to EMD/BG",
        description="Tenders, work orders, and linked EMD/BG instruments",
        base="FROM tenders t",
        default_where=["t.is_deleted = 0"],
        date_field="t.created_at",
        scope_created_col="t.created_by",
        scope_assigned_col="t.assigned_to",
        module_key="tenders",
        permission_keys=["reports.tenders.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_TENDER, "workorder": _JOIN_WORKORDER_FROM_TENDER, "emdbg": _JOIN_EMDBG_FROM_PIPELINE, "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to"},
        fields=_merge_meta({"id": ("t.id", [])}, _TENDER_FIELDS, _CUSTOMER_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS, {"assigned_to_name": ("assigned_user.full_name", ["assigned_user"])}),
        filter_fields={
            "tender_status": ("t.tender_status", "enum"),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "created_at": ("t.created_at", "date"),
        },
        sort_order=38,
    ),
    "tender_quotation_workorder_emdbg": _chain_report_config(
        name="Tender to Quotation to Work Order to EMD/BG",
        description="Tenders, quotations, work orders, and linked EMD/BG instruments",
        base="FROM tenders t",
        default_where=["t.is_deleted = 0"],
        date_field="t.created_at",
        scope_created_col="t.created_by",
        scope_assigned_col="t.assigned_to",
        module_key="tenders",
        permission_keys=["reports.tenders.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_TENDER, "quotation": _JOIN_QUOTATION_FROM_TENDER, "workorder": _JOIN_WORKORDER_FROM_TENDER_QUOTATION, "emdbg": _JOIN_EMDBG_FROM_PIPELINE, "assigned_user": "LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to"},
        fields=_merge_meta({"id": ("t.id", [])}, _TENDER_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS, {"assigned_to_name": ("assigned_user.full_name", ["assigned_user"])}),
        filter_fields={
            "tender_status": ("t.tender_status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "created_at": ("t.created_at", "date"),
        },
        sort_order=39,
    ),
    "quotation_workorder_emdbg": _chain_report_config(
        name="Quotation to Work Order to EMD/BG",
        description="Quotations, work orders, and linked EMD/BG instruments",
        base="FROM quotations q",
        default_where=[],
        date_field="q.created_at",
        scope_created_col="q.created_by",
        scope_assigned_col=None,
        module_key="opportunity",
        permission_keys=["reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"lead": _JOIN_LEAD_FROM_QUOTATION, "customer": _JOIN_CUSTOMER_FROM_QUOTATION, "workorder": "LEFT JOIN work_orders wo ON (wo.quotation_id = q.id OR (q.lead_id IS NOT NULL AND wo.lead_id = q.lead_id))", "emdbg": _JOIN_EMDBG_FROM_PIPELINE},
        fields=_merge_meta({"id": ("q.id", [])}, _QUOTATION_BASE_FIELDS, _LEAD_FIELDS, _CUSTOMER_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "quotation_status": ("q.status", "enum"),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "customer_id": ("q.customer_id", "number"),
            "created_at": ("q.created_at", "date"),
        },
        sort_order=40,
    ),
    "workorder_emdbg": _chain_report_config(
        name="Work Order to EMD/BG",
        description="Work orders and linked EMD/BG instruments",
        base="FROM work_orders wo",
        default_where=[],
        date_field="wo.created_at",
        scope_created_col="wo.created_by",
        scope_assigned_col=None,
        module_key="workorders",
        permission_keys=["reports.workorders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_WORKORDER, "emdbg": _JOIN_EMDBG_FROM_WORKORDER},
        fields=_merge_meta({"id": ("wo.id", [])}, _WORKORDER_BASE_FIELDS, _CUSTOMER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "work_order_status": ("wo.status", "text"),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "customer_id": ("wo.customer_id", "number"),
            "created_at": ("wo.created_at", "date"),
        },
        sort_order=41,
    ),
    "workorder_execution": _chain_report_config(
        name="Work Order Execution",
        description="Work orders with customer, quotation, tender, and EMD/BG source context",
        base="FROM work_orders wo",
        default_where=[],
        date_field="wo.created_at",
        scope_created_col="wo.created_by",
        scope_assigned_col=None,
        module_key="workorders",
        permission_keys=[
            "reports.workorders.view",
            "reports.customers.view",
            "reports.quotations.view",
            "reports.tenders.view",
        ],
        joins={
            "customer": _JOIN_CUSTOMER_FROM_WORKORDER,
            "quotation": "LEFT JOIN quotations q ON (q.id = wo.quotation_id OR (wo.lead_id IS NOT NULL AND q.lead_id = wo.lead_id) OR (wo.tender_id IS NOT NULL AND q.tender_id = wo.tender_id))",
            "tender": "LEFT JOIN tenders t ON (t.id = wo.tender_id OR t.wrk_order_id = wo.wo_number)",
            "emdbg": _JOIN_EMDBG_FROM_WORKORDER,
        },
        fields=_merge_meta(
            {"id": ("wo.id", [])},
            _WORKORDER_BASE_FIELDS,
            _CUSTOMER_FIELDS,
            _QUOTATION_FIELDS,
            _TENDER_FIELDS,
            _EMDBG_FIELDS,
        ),
        filter_fields={
            "work_order_status": ("wo.status", "text"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "tender_status": ("t.tender_status", "enum", ["tender"]),
            "tender_result": ("t.result", "enum", ["tender"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "instrument_type": ("e.instrument_type", "text", ["emdbg"]),
            "customer_id": ("wo.customer_id", "number"),
            "created_at": ("wo.created_at", "date"),
        },
        sort_order=42,
    ),
    "opportunity_quotation": _chain_report_config(
        name="Opportunity to Quotation",
        description="Direct opportunities and linked quotations",
        base="FROM leads l",
        default_where=["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="opportunity",
        permission_keys=["reports.opportunities.view", "reports.quotations.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "assigned_to": ("l.assigned_to", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=43,
    ),
    "opportunity_quotation_workorder": _chain_report_config(
        name="Opportunity to Quotation to Work Order",
        description="Direct opportunities, quotations, and linked work orders",
        base="FROM leads l",
        default_where=["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="opportunity",
        permission_keys=["reports.opportunities.view", "reports.quotations.view", "reports.workorders.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "assigned_to": ("l.assigned_to", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=44,
    ),
    "opportunity_quotation_workorder_emdbg": _chain_report_config(
        name="Opportunity Pipeline with EMD/BG",
        description="Direct opportunities, quotations, work orders, and EMD/BG instruments",
        base="FROM leads l",
        default_where=["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="opportunity",
        permission_keys=["reports.opportunities.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "emdbg": _JOIN_EMDBG_FROM_PIPELINE, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _EMDBG_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "emdbg_status": ("e.status", "text", ["emdbg"]),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=45,
    ),
    "opportunity_quotation_workorder_kam_activities": _chain_report_config(
        name="Opportunity Pipeline with KAM Activities",
        description="Direct opportunities, quotations, work orders, and KAM activities",
        base="FROM leads l",
        default_where=["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="opportunity",
        permission_keys=["reports.opportunities.view", "reports.quotations.view", "reports.workorders.view", "reports.kam.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "quotation": _JOIN_QUOTATION_FROM_LEAD, "workorder": _JOIN_WORKORDER_FROM_QUOTATION_LEAD, "kam_activity": _JOIN_KAM_FROM_LEAD, "kam_user": _JOIN_KAM_USER, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _QUOTATION_FIELDS, _WORKORDER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "quotation_status": ("q.status", "enum", ["quotation"]),
            "work_order_status": ("wo.status", "text", ["workorder"]),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=46,
    ),
    "opportunity_kam_activities": _chain_report_config(
        name="Opportunities with KAM Activities",
        description="Direct opportunities and their KAM activities",
        base="FROM leads l",
        default_where=["l.is_deleted = 0", "l.lead_type = 'direct_opportunity'"],
        date_field="l.created_at",
        scope_created_col="l.created_by",
        scope_assigned_col="l.assigned_to",
        module_key="opportunity",
        permission_keys=["reports.opportunities.view", "reports.kam.view"],
        joins={"customer": _JOIN_CUSTOMER_FROM_LEAD, "kam_activity": _JOIN_KAM_FROM_LEAD, "kam_user": _JOIN_KAM_USER, "assigned_user": _JOIN_ASSIGNED_USER},
        fields=_merge_meta({"id": ("l.id", [])}, _LEAD_FIELDS, _CUSTOMER_FIELDS, _KAM_FIELDS),
        filter_fields={
            "lead_status": ("l.status", "enum"),
            "kam_activity_type": ("ka.activity_type", "text", ["kam_activity"]),
            "kam_status": ("ka.status", "text", ["kam_activity"]),
            "assigned_to": ("l.assigned_to", "number"),
            "created_at": ("l.created_at", "date"),
        },
        sort_order=47,
    ),
})

# ---------------------------------------------------------------------------
# Safe UI metadata (module relations and field grouping)
# ---------------------------------------------------------------------------

MODULE_CATALOG: dict[str, dict[str, Any]] = {
    "customers": {"module_key": "customers", "label": "Customers", "sort_order": 10},
    "leads": {"module_key": "leads", "label": "Leads", "sort_order": 20},
    "opportunities": {"module_key": "opportunities", "label": "Opportunities", "sort_order": 30},
    "tenders": {"module_key": "tenders", "label": "Tenders", "sort_order": 40},
    "quotations": {"module_key": "quotations", "label": "Quotations", "sort_order": 50},
    "workorders": {"module_key": "workorders", "label": "Work Orders", "sort_order": 60},
    "emdbg": {"module_key": "emdbg", "label": "EMD / BG", "sort_order": 70},
    "kam_activities": {"module_key": "kam_activities", "label": "KAM Activities", "sort_order": 75},
    "travel": {"module_key": "travel", "label": "Travel", "sort_order": 80},
    "questionnaire": {"module_key": "questionnaire", "label": "Questionnaire", "sort_order": 85},
    "users": {"module_key": "users", "label": "Users", "sort_order": 900},
    "lead_sources": {"module_key": "lead_sources", "label": "Lead Sources", "sort_order": 910},
    "verticals": {"module_key": "verticals", "label": "Verticals", "sort_order": 920},
    "pipeline": {"module_key": "pipeline", "label": "Pipeline", "sort_order": 930},
}


REPORT_BUSINESS_CATEGORIES: list[dict[str, Any]] = [
    {"category_key": "sales_reports", "label": "Sales Reports", "sort_order": 10},
    {"category_key": "customer_reports", "label": "Customer Reports", "sort_order": 20},
    {"category_key": "tender_reports", "label": "Tender Reports", "sort_order": 30},
    {"category_key": "work_order_reports", "label": "Work Order Reports", "sort_order": 40},
    {"category_key": "kam_activity_reports", "label": "KAM Activity Reports", "sort_order": 50},
    {"category_key": "travel_reports", "label": "Travel Reports", "sort_order": 60},
]


def _combo(primary_module: str, *related_modules: str) -> tuple[str, ...]:
    return (primary_module, *related_modules)


def _business_template(
    *,
    template_key: str,
    template_name: str,
    category: str,
    description: str,
    primary_module: str,
    allowed_related_modules: list[str],
    default_related_modules: list[str],
    report_type_key_map: dict[tuple[str, ...], str],
    default_fields: dict[str, list[str]],
    permission_keys: list[str],
) -> dict[str, Any]:
    return {
        "template_key": template_key,
        "template_name": template_name,
        "category": category,
        "description": description,
        "primary_module": primary_module,
        "allowed_related_modules": allowed_related_modules,
        "default_related_modules": default_related_modules,
        "allowed_combinations": list(report_type_key_map.keys()),
        "report_type_key_map": report_type_key_map,
        "default_fields": default_fields,
        "permission_keys": permission_keys,
    }


REPORT_BUSINESS_TEMPLATES: list[dict[str, Any]] = [
    _business_template(
        template_key="lead_pipeline_report",
        template_name="Lead Pipeline Report",
        category="sales_reports",
        description="Track leads from creation to quotation and work order.",
        primary_module="leads",
        allowed_related_modules=["customers", "quotations", "workorders", "kam_activities"],
        default_related_modules=["customers", "quotations", "workorders"],
        report_type_key_map={
            _combo("leads"): "leads",
            _combo("leads", "customers"): "leads",
            _combo("leads", "quotations"): "lead_quotation",
            _combo("leads", "customers", "quotations"): "lead_quotation",
            _combo("leads", "workorders"): "lead_workorder",
            _combo("leads", "customers", "workorders"): "lead_workorder",
            _combo("leads", "quotations", "workorders"): "lead_quotation_workorder",
            _combo("leads", "customers", "quotations", "workorders"): "lead_quotation_workorder",
            _combo("leads", "kam_activities"): "lead_kam_activities",
            _combo("leads", "customers", "kam_activities"): "lead_kam_activities",
            _combo("leads", "quotations", "workorders", "kam_activities"): "lead_quotation_workorder_kam_activities",
            _combo("leads", "customers", "quotations", "workorders", "kam_activities"): "lead_quotation_workorder_kam_activities",
        },
        default_fields={
            "__default__": [
                "lead_ref_id", "lead_title", "customer_name", "lead_status", "lead_value",
                "quotation_number", "quotation_status", "quotation_amount",
                "work_order_number", "work_order_status", "work_order_value", "assigned_to_name",
            ],
        },
        permission_keys=["reports.leads.view", "reports.quotations.view", "reports.workorders.view"],
    ),
    _business_template(
        template_key="opportunity_conversion_report",
        template_name="Opportunity Conversion Report",
        category="sales_reports",
        description="Track opportunity conversion through quotation, work order, and follow-up activity.",
        primary_module="opportunities",
        allowed_related_modules=["customers", "quotations", "workorders", "kam_activities"],
        default_related_modules=["customers", "quotations", "workorders"],
        report_type_key_map={
            _combo("opportunities"): "opportunities",
            _combo("opportunities", "customers"): "opportunities",
            _combo("opportunities", "quotations"): "opportunity_quotation",
            _combo("opportunities", "customers", "quotations"): "opportunity_quotation",
            _combo("opportunities", "quotations", "workorders"): "opportunity_quotation_workorder",
            _combo("opportunities", "customers", "quotations", "workorders"): "opportunity_quotation_workorder",
            _combo("opportunities", "kam_activities"): "opportunity_kam_activities",
            _combo("opportunities", "customers", "kam_activities"): "opportunity_kam_activities",
            _combo("opportunities", "quotations", "workorders", "kam_activities"): "opportunity_quotation_workorder_kam_activities",
            _combo("opportunities", "customers", "quotations", "workorders", "kam_activities"): "opportunity_quotation_workorder_kam_activities",
        },
        default_fields={
            "__default__": [
                "lead_title", "customer_name", "lead_status", "lead_value",
                "quotation_number", "quotation_status", "quotation_amount",
                "work_order_number", "work_order_status", "work_order_value", "assigned_to_name",
            ],
        },
        permission_keys=["reports.opportunities.view", "reports.quotations.view", "reports.workorders.view"],
    ),
    _business_template(
        template_key="customer_business_report",
        template_name="Customer Business Report",
        category="customer_reports",
        description="Show the complete customer business pipeline.",
        primary_module="customers",
        allowed_related_modules=["leads", "quotations", "workorders", "kam_activities"],
        default_related_modules=["leads", "quotations", "workorders"],
        report_type_key_map={
            _combo("customers"): "customers",
            _combo("customers", "leads"): "customer_leads",
            _combo("customers", "leads", "quotations"): "customer_pipeline",
            _combo("customers", "leads", "quotations", "workorders"): "customer_pipeline_workorder",
            _combo("customers", "leads", "quotations", "workorders", "kam_activities"): "customer_pipeline_workorder_kam_activities",
            _combo("customers", "kam_activities"): "customer_kam_activities",
        },
        default_fields={
            "__default__": [
                "customer_name", "customer_region", "customer_status",
                "lead_title", "lead_status", "lead_value",
                "quotation_number", "quotation_status", "quotation_amount",
                "work_order_number", "work_order_status", "work_order_value", "assigned_to_name",
            ],
        },
        permission_keys=["reports.customers.view", "reports.leads.view", "reports.quotations.view", "reports.workorders.view"],
    ),
    _business_template(
        template_key="customer_activity_report",
        template_name="Customer Activity Report",
        category="customer_reports",
        description="Track customer engagement, follow-ups, and lead activity.",
        primary_module="customers",
        allowed_related_modules=["kam_activities", "leads"],
        default_related_modules=["kam_activities"],
        report_type_key_map={
            _combo("customers"): "customers",
            _combo("customers", "kam_activities"): "customer_kam_activities",
            _combo("customers", "leads"): "customer_leads",
        },
        default_fields={
            "__default__": [
                "customer_name", "customer_region", "customer_status",
                "kam_subject", "kam_activity_type", "kam_status", "kam_activity_date",
                "next_action_date", "kam_owner_name", "lead_title",
            ],
        },
        permission_keys=["reports.customers.view", "reports.kam.view", "reports.leads.view"],
    ),
    _business_template(
        template_key="tender_performance_report",
        template_name="Tender Performance Report",
        category="tender_reports",
        description="Track tender progress, result, conversion, and financial instruments.",
        primary_module="tenders",
        allowed_related_modules=["customers", "quotations", "workorders", "emdbg"],
        default_related_modules=["customers", "quotations", "workorders"],
        report_type_key_map={
            _combo("tenders"): "tenders",
            _combo("tenders", "customers"): "tenders",
            _combo("tenders", "quotations"): "tender_quotation",
            _combo("tenders", "customers", "quotations"): "tender_quotation",
            _combo("tenders", "workorders"): "tender_workorder",
            _combo("tenders", "customers", "workorders"): "tender_workorder",
            _combo("tenders", "emdbg"): "tender_emdbg",
            _combo("tenders", "customers", "emdbg"): "tender_emdbg",
            _combo("tenders", "quotations", "workorders"): "tender_quotation_workorder",
            _combo("tenders", "customers", "quotations", "workorders"): "tender_quotation_workorder",
            _combo("tenders", "workorders", "emdbg"): "tender_workorder_emdbg",
            _combo("tenders", "customers", "workorders", "emdbg"): "tender_workorder_emdbg",
            _combo("tenders", "quotations", "workorders", "emdbg"): "tender_quotation_workorder_emdbg",
            _combo("tenders", "customers", "quotations", "workorders", "emdbg"): "tender_quotation_workorder_emdbg",
        },
        default_fields={
            "__default__": [
                "tender_ref_id", "tender_title", "customer_name", "tender_status",
                "tender_result", "bid_amount", "quotation_number", "quotation_status",
                "work_order_number", "work_order_status", "emdbg_amount", "emdbg_status",
                "assigned_to_name",
            ],
        },
        permission_keys=["reports.tenders.view", "reports.quotations.view", "reports.workorders.view", "reports.emdbg.view"],
    ),
    _business_template(
        template_key="work_order_execution_report",
        template_name="Work Order Execution Report",
        category="work_order_reports",
        description="Track work order value, progress, and linked source.",
        primary_module="workorders",
        allowed_related_modules=["customers", "quotations", "tenders", "emdbg"],
        default_related_modules=["customers", "quotations", "tenders"],
        report_type_key_map={
            _combo("workorders"): "workorders",
            _combo("workorders", "customers"): "workorders",
            _combo("workorders", "emdbg"): "workorder_emdbg",
            _combo("workorders", "customers", "emdbg"): "workorder_emdbg",
            _combo("workorders", "quotations"): "workorder_execution",
            _combo("workorders", "tenders"): "workorder_execution",
            _combo("workorders", "customers", "quotations"): "workorder_execution",
            _combo("workorders", "customers", "tenders"): "workorder_execution",
            _combo("workorders", "quotations", "tenders"): "workorder_execution",
            _combo("workorders", "customers", "quotations", "tenders"): "workorder_execution",
            _combo("workorders", "quotations", "emdbg"): "workorder_execution",
            _combo("workorders", "tenders", "emdbg"): "workorder_execution",
            _combo("workorders", "customers", "quotations", "emdbg"): "workorder_execution",
            _combo("workorders", "customers", "tenders", "emdbg"): "workorder_execution",
            _combo("workorders", "quotations", "tenders", "emdbg"): "workorder_execution",
            _combo("workorders", "customers", "quotations", "tenders", "emdbg"): "workorder_execution",
        },
        default_fields={
            "__default__": [
                "work_order_number", "work_order_title", "customer_name", "quotation_number",
                "tender_ref_id", "tender_title", "work_order_status", "work_order_value",
                "emdbg_status", "expiry_date",
            ],
        },
        permission_keys=["reports.workorders.view", "reports.customers.view", "reports.quotations.view", "reports.tenders.view"],
    ),
    _business_template(
        template_key="kam_activity_report",
        template_name="KAM Activity Report",
        category="kam_activity_reports",
        description="Track sales activities and follow-ups.",
        primary_module="kam_activities",
        allowed_related_modules=["customers", "leads", "opportunities"],
        default_related_modules=["customers", "leads"],
        report_type_key_map={
            _combo("kam_activities"): "kam_activities",
            _combo("kam_activities", "customers"): "kam_activities",
            _combo("kam_activities", "leads"): "kam_activities",
            _combo("kam_activities", "opportunities"): "kam_activities",
            _combo("kam_activities", "customers", "leads"): "kam_activities",
            _combo("kam_activities", "customers", "opportunities"): "kam_activities",
            _combo("kam_activities", "leads", "opportunities"): "kam_activities",
            _combo("kam_activities", "customers", "leads", "opportunities"): "kam_activities",
        },
        default_fields={
            "__default__": [
                "kam_subject", "kam_activity_type", "kam_mode", "kam_status",
                "kam_activity_date", "next_action_date", "customer_name",
                "lead_title", "kam_owner_name",
            ],
        },
        permission_keys=["reports.kam.view"],
    ),
    _business_template(
        template_key="travel_request_report",
        template_name="Travel Request Report",
        category="travel_reports",
        description="Track employee travel requests, routes, dates, advances, and approval status.",
        primary_module="travel",
        allowed_related_modules=["users"],
        default_related_modules=["users"],
        report_type_key_map={
            _combo("travel"): "travel",
            _combo("travel", "users"): "travel",
        },
        default_fields={
            "__default__": [
                "purpose", "from_city", "to_city", "travel_date", "return_date",
                "visit_type", "status", "advance_required", "advance_amount", "employee_name",
            ],
        },
        permission_keys=["reports.travel.view"],
    ),
]

REPORT_BUSINESS_TEMPLATE_INDEX: dict[str, dict[str, Any]] = {
    template["template_key"]: template for template in REPORT_BUSINESS_TEMPLATES
}


# Business-approved relation tree exposed to the Create Report flow. It is the
# only source the frontend uses to discover valid chains.
REPORT_MODULE_RELATION_TREE: dict[str, dict[str, Any]] = {
    "customers": {
        "module_key": "customers",
        "label": "Customers",
        "description": "Show all Customers",
        "report_type_key": "customers",
        "children": {
            "leads": {
                "module_key": "leads",
                "label": "Leads",
                "description": "Show all Customers created with or without Leads",
                "report_type_key": "customer_leads",
                "children": {
                    "quotations": {
                        "module_key": "quotations",
                        "label": "Quotations",
                        "description": "Show all Leads created with or without Quotations",
                        "report_type_key": "customer_pipeline",
                        "children": {
                            "workorders": {
                                "module_key": "workorders",
                                "label": "Work Orders",
                                "description": "Show all Quotations created with or without Work Orders",
                                "report_type_key": "customer_pipeline_workorder",
                                "children": {
                                    "emdbg": {
                                        "module_key": "emdbg",
                                        "label": "EMD / BG",
                                        "description": "Show all Work Orders created with or without EMD/BG instruments",
                                        "report_type_key": "customer_pipeline_workorder_emdbg",
                                    },
                                    "kam_activities": {
                                        "module_key": "kam_activities",
                                        "label": "KAM Activities",
                                        "description": "Show all Work Orders with KAM activities connected to the Lead",
                                        "report_type_key": "customer_pipeline_workorder_kam_activities",
                                    },
                                },
                            },
                        },
                    },
                },
            },
            "tenders": {
                "module_key": "tenders",
                "label": "Tenders",
                "description": "Show all Customers created with or without Tenders",
                "report_type_key": "customer_tenders",
                "children": {
                    "quotations": {
                        "module_key": "quotations",
                        "label": "Quotations",
                        "description": "Show all Tenders created with or without Quotations",
                        "report_type_key": "customer_tender_quotation",
                        "children": {
                            "workorders": {
                                "module_key": "workorders",
                                "label": "Work Orders",
                                "description": "Show all Quotations created with or without Work Orders",
                                "report_type_key": "customer_tender_quotation_workorder",
                                "children": {
                                    "emdbg": {
                                        "module_key": "emdbg",
                                        "label": "EMD / BG",
                                        "description": "Show all Work Orders created with or without EMD/BG instruments",
                                        "report_type_key": "customer_tender_quotation_workorder_emdbg",
                                    },
                                },
                            },
                        },
                    },
                    "workorders": {
                        "module_key": "workorders",
                        "label": "Work Orders",
                        "description": "Show all Tenders created with or without Work Orders",
                        "report_type_key": "customer_tender_workorder",
                        "children": {
                            "emdbg": {
                                "module_key": "emdbg",
                                "label": "EMD / BG",
                                "description": "Show all Work Orders created with or without EMD/BG instruments",
                                "report_type_key": "customer_tender_workorder_emdbg",
                            },
                        },
                    },
                    "emdbg": {
                        "module_key": "emdbg",
                        "label": "EMD / BG",
                        "description": "Show all Tenders created with or without EMD/BG instruments",
                        "report_type_key": "customer_tender_emdbg",
                    },
                },
            },
            "kam_activities": {
                "module_key": "kam_activities",
                "label": "KAM Activities",
                "description": "Show all Customers created with or without KAM Activities",
                "report_type_key": "customer_kam_activities",
            },
        },
    },
    "leads": {
        "module_key": "leads",
        "label": "Leads",
        "description": "Show all Leads",
        "report_type_key": "leads",
        "children": {
            "quotations": {
                "module_key": "quotations",
                "label": "Quotations",
                "description": "Show all Leads created with or without Quotations",
                "report_type_key": "lead_quotation",
                "children": {
                    "workorders": {
                        "module_key": "workorders",
                        "label": "Work Orders",
                        "description": "Show all Quotations created with or without Work Orders",
                        "report_type_key": "lead_quotation_workorder",
                        "children": {
                            "emdbg": {
                                "module_key": "emdbg",
                                "label": "EMD / BG",
                                "description": "Show all Work Orders created with or without EMD/BG instruments",
                                "report_type_key": "lead_quotation_workorder_emdbg",
                            },
                            "kam_activities": {
                                "module_key": "kam_activities",
                                "label": "KAM Activities",
                                "description": "Show all Work Orders with KAM activities connected to the Lead",
                                "report_type_key": "lead_quotation_workorder_kam_activities",
                            },
                        },
                    },
                },
            },
            "workorders": {
                "module_key": "workorders",
                "label": "Work Orders",
                "description": "Show all Leads created with or without direct Work Orders",
                "report_type_key": "lead_workorder",
            },
            "kam_activities": {
                "module_key": "kam_activities",
                "label": "KAM Activities",
                "description": "Show all Leads created with or without KAM Activities",
                "report_type_key": "lead_kam_activities",
            },
        },
    },
    "opportunities": {
        "module_key": "opportunities",
        "label": "Opportunities",
        "description": "Show all Opportunities",
        "report_type_key": "opportunities",
        "children": {
            "quotations": {
                "module_key": "quotations",
                "label": "Quotations",
                "description": "Show all Opportunities created with or without Quotations",
                "report_type_key": "opportunity_quotation",
                "children": {
                    "workorders": {
                        "module_key": "workorders",
                        "label": "Work Orders",
                        "description": "Show all Quotations created with or without Work Orders",
                        "report_type_key": "opportunity_quotation_workorder",
                        "children": {
                            "emdbg": {
                                "module_key": "emdbg",
                                "label": "EMD / BG",
                                "description": "Show all Work Orders created with or without EMD/BG instruments",
                                "report_type_key": "opportunity_quotation_workorder_emdbg",
                            },
                            "kam_activities": {
                                "module_key": "kam_activities",
                                "label": "KAM Activities",
                                "description": "Show all Work Orders with KAM activities connected to the Opportunity",
                                "report_type_key": "opportunity_quotation_workorder_kam_activities",
                            },
                        },
                    },
                },
            },
            "kam_activities": {
                "module_key": "kam_activities",
                "label": "KAM Activities",
                "description": "Show all Opportunities created with or without KAM Activities",
                "report_type_key": "opportunity_kam_activities",
            },
        },
    },
    "tenders": {
        "module_key": "tenders",
        "label": "Tenders",
        "description": "Show all Tenders",
        "report_type_key": "tenders",
        "children": {
            "quotations": {
                "module_key": "quotations",
                "label": "Quotations",
                "description": "Show all Tenders created with or without Quotations",
                "report_type_key": "tender_quotation",
                "children": {
                    "workorders": {
                        "module_key": "workorders",
                        "label": "Work Orders",
                        "description": "Show all Quotations created with or without Work Orders",
                        "report_type_key": "tender_quotation_workorder",
                        "children": {
                            "emdbg": {
                                "module_key": "emdbg",
                                "label": "EMD / BG",
                                "description": "Show all Work Orders created with or without EMD/BG instruments",
                                "report_type_key": "tender_quotation_workorder_emdbg",
                            },
                        },
                    },
                },
            },
            "workorders": {
                "module_key": "workorders",
                "label": "Work Orders",
                "description": "Show all Tenders created with or without Work Orders",
                "report_type_key": "tender_workorder",
                "children": {
                    "emdbg": {
                        "module_key": "emdbg",
                        "label": "EMD / BG",
                        "description": "Show all Work Orders created with or without EMD/BG instruments",
                        "report_type_key": "tender_workorder_emdbg",
                    },
                },
            },
            "emdbg": {
                "module_key": "emdbg",
                "label": "EMD / BG",
                "description": "Show all Tenders created with or without EMD/BG instruments",
                "report_type_key": "tender_emdbg",
            },
        },
    },
    "quotations": {
        "module_key": "quotations",
        "label": "Quotations",
        "description": "Show all Quotations",
        "report_type_key": "quotations",
        "children": {
            "workorders": {
                "module_key": "workorders",
                "label": "Work Orders",
                "description": "Show all Quotations created with or without Work Orders",
                "report_type_key": "quotation_workorder",
                "children": {
                    "emdbg": {
                        "module_key": "emdbg",
                        "label": "EMD / BG",
                        "description": "Show all Work Orders created with or without EMD/BG instruments",
                        "report_type_key": "quotation_workorder_emdbg",
                    },
                },
            },
        },
    },
    "workorders": {
        "module_key": "workorders",
        "label": "Work Orders",
        "description": "Show all Work Orders",
        "report_type_key": "workorders",
        "children": {
            "emdbg": {
                "module_key": "emdbg",
                "label": "EMD / BG",
                "description": "Show all Work Orders created with or without EMD/BG instruments",
                "report_type_key": "workorder_emdbg",
            },
        },
    },
    "emdbg": {
        "module_key": "emdbg",
        "label": "EMD / BG",
        "description": "Show all EMD/BG instruments",
        "report_type_key": "emdbg",
    },
    "kam_activities": {
        "module_key": "kam_activities",
        "label": "KAM Activities",
        "description": "Show all KAM Activities",
        "report_type_key": "kam_activities",
    },
    "travel": {
        "module_key": "travel",
        "label": "Travel",
        "description": "Show all Travel Requests",
        "report_type_key": "travel",
    },
}


def _chain_key(chain: list[str]) -> str:
    return "__".join(chain)


def _iter_relation_tree(
    parent_module: str,
    node: dict[str, Any],
    chain: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    report_type_key = node.get("report_type_key")
    children = node.get("children") or {}
    if report_type_key:
        rows.append({
            "parent_module": parent_module,
            "child_module": chain[-1],
            "child_modules": chain if len(chain) == 1 else chain[1:],
            "module_chain": chain,
            "chain": chain,
            "chain_key": _chain_key(chain),
            "level": len(chain) - 1,
            "report_type_key": report_type_key,
            "label": node.get("label") or MODULE_CATALOG.get(chain[-1], {}).get("label") or chain[-1].replace("_", " ").title(),
            "description": node.get("description"),
            "allow_next_children": bool(children),
            "next_children": list(children.keys()),
        })
    for child_key, child_node in children.items():
        rows.extend(_iter_relation_tree(parent_module, child_node, [*chain, child_key]))
    return rows


def _flatten_report_module_relations() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for parent_key, node in REPORT_MODULE_RELATION_TREE.items():
        rows.extend(_iter_relation_tree(parent_key, node, [parent_key]))
    return rows


REPORT_MODULE_RELATIONS: list[dict[str, Any]] = _flatten_report_module_relations()

REPORT_TYPE_BASE_MODULES: dict[str, str] = {
    "leads": "leads",
    "customers": "customers",
    "tenders": "tenders",
    "opportunities": "opportunities",
    "workorders": "workorders",
    "emdbg": "emdbg",
    "travel": "travel",
    "quotations": "quotations",
    "customer_leads": "leads",
    "customer_pipeline": "customers",
    "lead_quotation": "leads",
    "quotation_workorder": "quotations",
    "tender_workorder": "tenders",
    "workorder_execution": "workorders",
}

for _relation in REPORT_MODULE_RELATIONS:
    REPORT_TYPE_BASE_MODULES.setdefault(_relation["report_type_key"], _relation["parent_module"])

REPORT_TYPE_ALIAS_MODULES: dict[str, dict[str, str]] = {
    "leads": {
        "l": "leads", "assigned_user": "users", "created_user": "users",
        "lsrc": "lead_sources", "vs": "verticals", "cust": "customers",
    },
    "customers": {"c": "customers", "created_user": "users"},
    "tenders": {
        "t": "tenders", "assigned_user": "users", "created_user": "users",
        "cust": "customers", "vs": "verticals",
    },
    "opportunities": {
        "l": "opportunities", "assigned_user": "users",
        "created_user": "users", "vs": "verticals",
    },
    "workorders": {"wo": "workorders", "created_user": "users", "cust": "customers"},
    "emdbg": {"e": "emdbg", "created_user": "users", "t": "tenders"},
    "travel": {"tr": "travel", "created_user": "users"},
    "quotations": {"q": "quotations", "created_user": "users", "cust": "customers"},
    "customer_leads": {
        "c": "customers", "l": "leads", "assigned_user": "users",
        "created_user": "users", "lsrc": "lead_sources", "vs": "verticals",
    },
    "customer_pipeline": {
        "c": "customers", "l": "leads", "q": "quotations",
        "assigned_user": "users",
    },
    "lead_quotation": {
        "l": "leads", "cust": "customers", "q": "quotations",
        "assigned_user": "users",
    },
    "quotation_workorder": {
        "q": "quotations", "l": "leads", "cust": "customers", "wo": "workorders",
    },
    "tender_workorder": {
        "t": "tenders", "cust": "customers", "wo": "workorders",
        "assigned_user": "users",
    },
}

_CHAIN_ALIAS_MODULES = {
    "c": "customers",
    "l": "leads",
    "t": "tenders",
    "q": "quotations",
    "wo": "workorders",
    "e": "emdbg",
    "ka": "kam_activities",
    "owner_user": "users",
    "assigned_user": "users",
    "kam_user": "users",
    "customer": "customers",
    "lead": "leads",
    "tender": "tenders",
    "quotation": "quotations",
    "workorder": "workorders",
    "emdbg": "emdbg",
    "kam_activity": "kam_activities",
}
for _rt_key in REPORT_ENGINE_CONFIG.keys():
    REPORT_TYPE_ALIAS_MODULES.setdefault(_rt_key, dict(_CHAIN_ALIAS_MODULES))

# ---------------------------------------------------------------------------
# Permission helpers
# ---------------------------------------------------------------------------

REPORT_ENGINE_PERMISSION_KEYS = (
    "reports.view",
    "reports.leads.view",
    "reports.customers.view",
    "reports.tenders.view",
    "reports.opportunities.view",
    "reports.workorders.view",
    "reports.emdbg.view",
    "reports.kam.view",
    "reports.travel.view",
    "reports.tada.view",
    "reports.oem.view",
    "reports.competitors.view",
    "reports.quotations.view",
    "reports.questionnaire.view",
)

REPORT_TYPE_PERMISSION_KEYS: dict[str, tuple[str, ...]] = {
    "leads":               ("reports.leads.view",),
    "customers":           ("reports.customers.view",),
    "tenders":             ("reports.tenders.view",),
    "opportunities":       ("reports.opportunities.view",),
    "workorders":          ("reports.workorders.view",),
    "emdbg":               ("reports.emdbg.view",),
    "travel":              ("reports.travel.view",),
    "quotations":          ("reports.quotations.view",),
    "questionnaire":           ("reports.questionnaire.view",),
    "questionnaire_adoption":  ("reports.questionnaire.view",),
    "questionnaire_sections":  ("reports.questionnaire.view",),
    "questionnaire_answers":   ("reports.questionnaire.view",),
    "questionnaire_questions": ("reports.questionnaire.view",),
    "customer_pipeline":   ("reports.customers.view", "reports.leads.view", "reports.quotations.view"),
    "lead_quotation":      ("reports.leads.view", "reports.quotations.view"),
    "quotation_workorder": ("reports.quotations.view", "reports.workorders.view", "reports.leads.view", "reports.customers.view"),
    "tender_workorder":    ("reports.tenders.view", "reports.workorders.view", "reports.customers.view"),
}


def _granted_permission_keys(db: Session, cu: User) -> set[str]:
    role_row = db.query(Role).filter(Role.name == cu.role, Role.is_active == True).first()
    if not role_row:
        return set()
    return {
        k for (k,) in db.query(Permission.key)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .filter(RolePermission.role_id == role_row.id).all()
    }


def _require_engine_access(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
) -> User:
    granted = _granted_permission_keys(db, cu)
    if "*" not in granted and not any(k in granted for k in REPORT_ENGINE_PERMISSION_KEYS):
        raise HTTPException(403, "No report access")
    return cu


def _report_type_permission_keys(rt_key: str) -> tuple[str, ...]:
    cfg_keys = REPORT_ENGINE_CONFIG.get(rt_key, {}).get("permission_keys")
    if cfg_keys:
        return tuple(cfg_keys)
    return REPORT_TYPE_PERMISSION_KEYS.get(rt_key, ())


def _module_enabled_for_tenant(db: Session, module_key: Optional[str]) -> bool:
    """Gate #1: the underlying business module must be enabled for this tenant.

    This is independent of role permissions — a role may be granted
    reports.<x>.view, but if the tenant hasn't enabled module <x> at all,
    its reports must not appear or run.
    """
    if not module_key:
        return True
    module = db.query(Module).filter(Module.key == module_key).first()
    if module_key in DEFAULT_TENANT_MODULE_KEYS and not module:
        return False
    if module and not bool(module.is_active):
        return False
    return True


def _has_report_type_access(
    rt_key: str,
    db: Session,
    cu: User,
    granted: Optional[set[str]] = None,
) -> bool:
    if rt_key not in REPORT_ENGINE_CONFIG:
        return False
    if not _module_enabled_for_tenant(db, REPORT_ENGINE_CONFIG[rt_key].get("module_key")):
        return False
    granted = granted if granted is not None else _granted_permission_keys(db, cu)
    if "*" in granted or "reports.view" in granted:
        return True
    required = _report_type_permission_keys(rt_key)
    if not required:
        return any(k in granted for k in REPORT_ENGINE_PERMISSION_KEYS)
    return all(k in granted for k in required)


def _require_report_type_access(rt_key: str, db: Session, cu: User) -> None:
    if rt_key not in REPORT_ENGINE_CONFIG:
        raise HTTPException(400, f"Unknown report type: {rt_key}")
    if not _has_report_type_access(rt_key, db, cu):
        raise HTTPException(403, "No access to this report type")


def _can_view_report(report: SavedReport, cu: User) -> bool:
    """
    A user can view a saved report if any of:
      - it's a system report (seeded, always public)
      - they created it
      - its visibility is 'org' (shared with whole organisation)
      - they are admin/superadmin
    Data-row access is still governed by RolePermission.data_scope (own/team/all)
    via get_module_data_scope() in the SQL builder — no extra ACL needed.
    """
    if report.is_system:
        return True
    if str(cu.role).lower() in ("admin", "superadmin"):
        return True
    if report.created_by == cu.id:
        return True
    if report.visibility == "org":
        return True
    return False


def _can_edit_report(report: SavedReport, cu: User) -> bool:
    """Only the creator or admins can edit a saved report."""
    if report.is_system:
        return False
    if str(cu.role).lower() in ("admin", "superadmin"):
        return True
    return report.created_by == cu.id


# ---------------------------------------------------------------------------
# Metadata and config validation helpers
# ---------------------------------------------------------------------------

_TYPE_DEFAULT_OPERATORS: dict[str, tuple[str, ...]] = {
    "text": ("eq", "neq", "contains", "starts_with", "is_null", "is_not_null"),
    "number": ("eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"),
    "currency": ("eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"),
    "date": ("eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"),
    "datetime": ("eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"),
    "enum": ("eq", "neq", "in", "not_in", "is_null", "is_not_null"),
    "boolean": ("eq",),
}


def _module_label(module_key: Optional[str]) -> str:
    if not module_key:
        return "Other"
    return MODULE_CATALOG.get(module_key, {}).get("label") or module_key.replace("_", " ").title()


def _split_join_keys(join_key: Optional[str]) -> list[str]:
    return [j.strip() for j in (join_key or "").split(",") if j.strip()]


def _cfg_filter_info(value: tuple) -> tuple[str, str, list[str]]:
    expr = value[0]
    data_type = value[1] if len(value) > 1 else "text"
    joins = list(value[2]) if len(value) > 2 and value[2] else []
    return expr, data_type, joins


def _field_module_key(rt_key: str, expression: Optional[str], joins: list[str]) -> str:
    alias_map = REPORT_TYPE_ALIAS_MODULES.get(rt_key, {})
    expr = expression or ""
    match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\.", expr)
    if match and match.group(1) in alias_map:
        return alias_map[match.group(1)]
    for join_key in joins:
        if join_key in alias_map:
            return alias_map[join_key]
    return REPORT_TYPE_BASE_MODULES.get(rt_key) or REPORT_ENGINE_CONFIG.get(rt_key, {}).get("module_key") or rt_key


def _visible_report_relations(db: Session, cu: User) -> list[dict[str, Any]]:
    granted = _granted_permission_keys(db, cu)
    visible = []
    for relation in REPORT_MODULE_RELATIONS:
        rt_key = relation["report_type_key"]
        if _has_report_type_access(rt_key, db, cu, granted):
            visible.append(relation)
    return visible


def _normalize_module_chain(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple)):
        return [str(part).strip() for part in value if str(part).strip()]
    raise HTTPException(400, "module_chain must be a list of module keys")


def _chain_from_legacy_children(parent_module: Optional[str], child_modules: Any) -> list[str]:
    if not parent_module:
        return []
    children = _normalize_module_chain(child_modules)
    if not children:
        return [parent_module]
    if children[0] == parent_module:
        return children
    if len(children) == 1 and children[0] == parent_module:
        return [parent_module]
    return [parent_module, *children]


def _relation_for_chain(parent_module: str, chain: list[str]) -> Optional[dict[str, Any]]:
    chain_key = _chain_key(chain)
    return next(
        (
            relation for relation in REPORT_MODULE_RELATIONS
            if relation["parent_module"] == parent_module and relation["chain_key"] == chain_key
        ),
        None,
    )


def _relation_for_report_type(rt_key: str) -> Optional[dict[str, Any]]:
    return next((r for r in REPORT_MODULE_RELATIONS if r["report_type_key"] == rt_key), None)


def _relation_for_report_config(rt_key: str, config: dict) -> Optional[dict[str, Any]]:
    raw_chain = config.get("module_chain") if "module_chain" in config else config.get("chain")
    parent_module = config.get("parent_module")
    child_modules = config.get("child_modules")

    if raw_chain is None and parent_module is None and child_modules is None:
        return _relation_for_report_type(rt_key)

    chain = _normalize_module_chain(raw_chain)
    if not chain:
        chain = _chain_from_legacy_children(parent_module, child_modules)
    if not chain:
        raise HTTPException(400, "module_chain is required for related-module reports")

    if parent_module and chain[0] != parent_module:
        raise HTTPException(400, "Invalid parent module for selected module chain")

    relation = _relation_for_chain(chain[0], chain)
    if not relation:
        raise HTTPException(400, "Selected module chain is not allowed")
    if relation["report_type_key"] != rt_key:
        raise HTTPException(400, "report_type_key does not belong to selected module chain")
    return relation


def _validate_report_relation(rt_key: str, config: dict) -> Optional[dict[str, Any]]:
    relation = _relation_for_report_config(rt_key, config)
    if relation and relation["report_type_key"] != rt_key:
        raise HTTPException(400, "Invalid module chain for report type")
    return relation


def _load_report_runtime_fields(rt_key: str, db: Session) -> tuple[Optional[ReportType], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    cfg = REPORT_ENGINE_CONFIG.get(rt_key)
    if not cfg:
        raise HTTPException(400, f"Unknown report type: {rt_key}")

    rt_row = db.query(ReportType).filter(ReportType.key == rt_key, ReportType.is_active == True).first()
    db_fields = {f.field_key: f for f in (rt_row.fields if rt_row else [])}
    cfg_fields = cfg.get("fields", {})
    cfg_filters = cfg.get("filter_fields", {})

    ordered_keys: list[str] = []
    if rt_row:
        ordered_keys.extend([f.field_key for f in sorted(rt_row.fields, key=lambda row: row.display_order or 0)])
    ordered_keys.extend([fk for fk in cfg_fields.keys() if fk not in ordered_keys])

    select_fields: dict[str, dict[str, Any]] = {}
    filter_fields: dict[str, dict[str, Any]] = {}

    for fk in ordered_keys:
        fdb = db_fields.get(fk)
        cfg_expr, cfg_joins = cfg_fields.get(fk, (None, []))
        expression = (fdb.expression if fdb and fdb.expression else cfg_expr)
        if not expression:
            continue
        joins = _split_join_keys(fdb.join_key if fdb else None) or list(cfg_joins or [])
        expression = _safe_expr(expression)
        data_type = (fdb.data_type if fdb else None)
        if not data_type and fk in cfg_filters:
            _, data_type, _ = _cfg_filter_info(cfg_filters[fk])
        data_type = data_type or "text"
        allowed_ops = fdb.allowed_operators if fdb and fdb.allowed_operators else list(_TYPE_DEFAULT_OPERATORS.get(data_type, ("eq", "neq")))
        module_key = _field_module_key(rt_key, expression, joins)

        select_fields[fk] = {
            "id": fdb.id if fdb else 0,
            "field_key": fk,
            "label": fdb.label if fdb else fk.replace("_", " ").title(),
            "data_type": data_type,
            "expression": expression,
            "joins": joins,
            "module_key": module_key,
            "module_label": _module_label(module_key),
            "is_default_column": bool(fdb.is_default_column) if fdb else False,
            "is_filterable": bool(fdb.is_filterable) if fdb else fk in cfg_filters,
            "is_groupable": bool(fdb.is_groupable) if fdb else False,
            "is_sortable": bool(fdb.is_sortable) if fdb else True,
            "is_aggregatable": bool(fdb.is_aggregatable) if fdb else False,
            "allowed_operators": allowed_ops,
            "enum_values": fdb.enum_values if fdb else None,
            "format": fdb.format if fdb else None,
            "drilldown_kind": fdb.drilldown_kind if fdb else None,
            "drilldown_target": fdb.drilldown_target if fdb else None,
            "drilldown_id_field": fdb.drilldown_id_field if fdb else None,
            "drilldown_filter_field": fdb.drilldown_filter_field if fdb else None,
            "display_order": fdb.display_order if fdb else len(select_fields),
        }

        filter_expression = None
        filter_joins = joins
        filter_type = data_type
        if fdb and fdb.is_filterable and fdb.filter_expression:
            filter_expression = fdb.filter_expression
        elif fk in cfg_filters:
            filter_expression, filter_type, filter_joins = _cfg_filter_info(cfg_filters[fk])
        elif fdb and fdb.is_filterable:
            filter_expression = expression
        if filter_expression:
            filter_fields[fk] = {
                "field_key": fk,
                "expression": _safe_expr(filter_expression),
                "joins": filter_joins,
                "data_type": filter_type,
                "allowed_operators": allowed_ops,
            }

    for fk, cfg_filter in cfg_filters.items():
        if fk in filter_fields:
            continue
        expr, data_type, joins = _cfg_filter_info(cfg_filter)
        filter_fields[fk] = {
            "field_key": fk,
            "expression": _safe_expr(expr),
            "joins": joins,
            "data_type": data_type,
            "allowed_operators": list(_TYPE_DEFAULT_OPERATORS.get(data_type, ("eq", "neq"))),
        }

    return rt_row, select_fields, filter_fields


def _sanitize_report_config(rt_key: str, config: Optional[dict], db: Session) -> dict:
    raw = dict(config or {})
    cfg = REPORT_ENGINE_CONFIG.get(rt_key) or {}
    _, select_fields, filter_fields = _load_report_runtime_fields(rt_key, db)
    business_resolution = _business_resolution_from_config(rt_key, raw)
    relation = None if business_resolution else _validate_report_relation(rt_key, raw)

    requested_fields = raw.get("fields")
    if requested_fields is None:
        selected_fields = [fk for fk, meta in select_fields.items() if meta["is_default_column"]]
        if not selected_fields:
            selected_fields = list(select_fields.keys())[:6]
    else:
        if not isinstance(requested_fields, list):
            raise HTTPException(400, "fields must be a list of field keys")
        selected_fields = []
        for field_key in requested_fields:
            if field_key not in select_fields:
                raise HTTPException(400, f"Invalid report field: {field_key}")
            selected_fields.append(str(field_key))
    if not selected_fields:
        raise HTTPException(400, "Select at least one report field")

    sanitized_filters: list[dict[str, Any]] = []
    raw_filters = raw.get("filters") or []
    if not isinstance(raw_filters, list):
        raise HTTPException(400, "filters must be a list")
    for idx, item in enumerate(raw_filters):
        if not isinstance(item, dict):
            raise HTTPException(400, f"Invalid filter at position {idx + 1}")
        field_key = str(item.get("field") or "")
        operator = str(item.get("operator") or "eq")
        if field_key == "__quick_search":
            if operator != "quick_search":
                raise HTTPException(400, "__quick_search only supports the 'quick_search' operator")
            if not cfg.get("quick_search_fields"):
                raise HTTPException(400, f"Quick search is not supported for report type: {rt_key}")
            sanitized_filters.append({"field": field_key, "operator": operator, "value": item.get("value")})
            continue
        if field_key not in filter_fields:
            raise HTTPException(400, f"Invalid filter field: {field_key}")
        allowed_ops = filter_fields[field_key].get("allowed_operators") or ()
        if operator not in allowed_ops:
            raise HTTPException(400, f"Operator '{operator}' is not allowed for {field_key}")
        value = item.get("value")
        if operator == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise HTTPException(400, f"Filter {field_key} requires two values")
        elif operator in ("in", "not_in"):
            if not isinstance(value, list):
                raise HTTPException(400, f"Filter {field_key} requires a list value")
        elif operator in ("is_null", "is_not_null"):
            value = None
        sanitized_filters.append({"field": field_key, "operator": operator, "value": value})

    sanitized_sort: list[dict[str, str]] = []
    raw_sort = raw.get("sort") or []
    if raw_sort and not isinstance(raw_sort, list):
        raise HTTPException(400, "sort must be a list")
    for idx, item in enumerate(raw_sort):
        if not isinstance(item, dict):
            raise HTTPException(400, f"Invalid sort at position {idx + 1}")
        field_key = str(item.get("field") or "")
        if field_key not in select_fields:
            raise HTTPException(400, f"Invalid sort field: {field_key}")
        if not select_fields[field_key]["is_sortable"]:
            raise HTTPException(400, f"Field is not sortable: {field_key}")
        direction = "asc" if str(item.get("direction", "desc")).lower() == "asc" else "desc"
        sanitized_sort.append({"field": field_key, "direction": direction})

    if not sanitized_sort and "id" in select_fields and select_fields["id"]["is_sortable"]:
        sanitized_sort = [{"field": "id", "direction": "desc"}]

    sanitized: dict[str, Any] = {
        "report_type_key": rt_key,
        "fields": selected_fields,
        "filters": sanitized_filters,
        "sort": sanitized_sort,
    }
    for key in ("date_from", "date_to"):
        if raw.get(key):
            sanitized[key] = str(raw[key])
    for key, default, minimum, maximum in (("page", 1, 1, 10_000_000), ("per_page", 50, 1, 500)):
        try:
            value = int(raw.get(key) or default)
        except (TypeError, ValueError):
            value = default
        sanitized[key] = min(maximum, max(minimum, value))

    if relation:
        chain = list(relation["module_chain"])
        sanitized["parent_module"] = relation["parent_module"]
        sanitized["module_chain"] = chain
        sanitized["child_modules"] = chain if len(chain) == 1 else chain[1:]
        sanitized["chain_key"] = relation["chain_key"]
    elif business_resolution:
        chain = list(business_resolution["module_chain"])
        sanitized["template_key"] = business_resolution["template_key"]
        sanitized["primary_module"] = business_resolution["primary_module"]
        sanitized["related_modules"] = list(business_resolution["related_modules"])
        sanitized["module_chain"] = chain
        sanitized["child_modules"] = list(business_resolution["related_modules"])
        sanitized["chain_key"] = business_resolution["chain_key"]

    return sanitized


def _resolve_report_type_key_for_save(body: "SavedReportCreate", db: Session, cu: User) -> tuple[str, int]:
    rt_key = body.report_type_key
    rt_id = body.report_type_id
    if rt_id:
        db_key = db.query(ReportType.key).filter(ReportType.id == rt_id, ReportType.is_active == True).scalar()
        if not db_key:
            raise HTTPException(400, "Invalid report type")
        if rt_key and rt_key != db_key:
            raise HTTPException(400, "report_type_key does not match report_type_id")
        rt_key = db_key
    if not rt_key:
        raise HTTPException(400, "report_type_key is required")
    rt = db.query(ReportType).filter(ReportType.key == rt_key, ReportType.is_active == True).first()
    if not rt:
        raise HTTPException(400, "Invalid report type")
    _require_report_type_access(rt_key, db, cu)
    return rt_key, int(rt.id)


# ---------------------------------------------------------------------------
# Dynamic SQL query builder
# ---------------------------------------------------------------------------

_OPERATOR_MAP = {
    "eq":         "= :p_{i}",
    "neq":        "!= :p_{i}",
    "contains":   "LIKE :p_{i}",
    "starts_with":"LIKE :p_{i}",
    "gt":         "> :p_{i}",
    "gte":        ">= :p_{i}",
    "lt":         "< :p_{i}",
    "lte":        "<= :p_{i}",
    "is_null":    "IS NULL",
    "is_not_null":"IS NOT NULL",
    # 'between' and 'in'/'not_in' are handled separately
}


def _apply_data_scope_clauses(cfg: dict, cu: User, db: Session, where_clauses: list, params: dict) -> None:
    """Append the role/hierarchy data-scope conditions for a report type to a WHERE list."""
    scope = get_module_data_scope(db, cu, cfg["module_key"])
    if scope == "none":
        where_clauses.append("1 = 0")
    elif scope == "own":
        params["__scope_uid"] = int(cu.id)
        cond = f"{cfg['scope_created_col']} = :__scope_uid"
        if cfg.get("scope_assigned_col"):
            cond = f"({cond} OR {cfg['scope_assigned_col']} = :__scope_uid)"
        where_clauses.append(cond)
    elif scope == "team":
        team_ids = get_team_user_ids(db, int(cu.id))
        if team_ids:
            placeholders = ", ".join(f":__tid_{j}" for j in range(len(team_ids)))
            for j, user_id in enumerate(team_ids):
                params[f"__tid_{j}"] = user_id
            cond = f"{cfg['scope_created_col']} IN ({placeholders})"
            if cfg.get("scope_assigned_col"):
                cond = f"({cond} OR {cfg['scope_assigned_col']} IN ({placeholders}))"
            where_clauses.append(cond)
        else:
            where_clauses.append("1 = 0")


def _build_report_sql(
    rt_key: str,
    config: dict,
    cu: User,
    db: Session,
    count_only: bool = False,
    export: bool = False,
) -> tuple[str, dict, list[str]]:
    """Strict SQL builder: every selectable/filter/sort expression comes from backend metadata.

    Returns (sql, params, visible_fields) — visible_fields is the field-picker-facing column
    list. When a selected field has drilldown_id_field metadata, that ID field is folded into
    the SQL SELECT (so the runner can resolve the drilldown target) but is kept out of
    visible_fields so it never appears as a real report column or in exports.
    """
    cfg = REPORT_ENGINE_CONFIG.get(rt_key)
    if not cfg:
        raise HTTPException(400, f"Unknown report type: {rt_key}")

    _, select_fields, filter_fields = _load_report_runtime_fields(rt_key, db)

    requested_fields: list[str] = config.get("fields") or [
        fk for fk, meta in select_fields.items() if meta.get("is_default_column")
    ] or list(select_fields.keys())[:6]
    selected: list[str] = []
    for field_key in requested_fields:
        if field_key not in select_fields:
            raise HTTPException(400, f"Invalid report field: {field_key}")
        selected.append(field_key)
    if not selected and not count_only:
        raise HTTPException(400, "Select at least one report field")

    # Hidden ID fields — resolved through the same field catalog as any normal field,
    # never special-cased SQL. Only added when not already visible.
    hidden_fields: list[str] = []
    for field_key in selected:
        hid_fk = select_fields[field_key].get("drilldown_id_field")
        if hid_fk and hid_fk not in selected and hid_fk not in hidden_fields and hid_fk in select_fields:
            hidden_fields.append(hid_fk)
    all_fields = selected + hidden_fields

    needed_joins: set[str] = set()
    for field_key in all_fields:
        needed_joins.update(select_fields[field_key]["joins"])

    params: dict[str, Any] = {}
    where_clauses: list[str] = list(cfg["default_where"])

    date_field = cfg["date_field"]
    date_from = config.get("date_from")
    date_to = config.get("date_to")
    if date_from:
        where_clauses.append(f"{date_field} >= :__date_from")
        params["__date_from"] = date_from
    if date_to:
        where_clauses.append(f"{date_field} <= :__date_to")
        params["__date_to"] = date_to + " 23:59:59" if len(str(date_to)) == 10 else date_to

    for i, flt in enumerate(config.get("filters") or []):
        field_key = flt.get("field", "")
        operator = flt.get("operator", "eq")
        value = flt.get("value")

        if field_key == "__quick_search":
            quick_search_fields = cfg.get("quick_search_fields") or []
            if not quick_search_fields:
                raise HTTPException(400, f"Quick search is not supported for report type: {rt_key}")
            resolved_exprs: list[str] = []
            for qf_key in quick_search_fields:
                qf_meta = filter_fields.get(qf_key) or select_fields.get(qf_key)
                if not qf_meta:
                    continue
                resolved_exprs.append(qf_meta["expression"])
                needed_joins.update(qf_meta["joins"])
            if resolved_exprs and value not in (None, ""):
                params[f"p_{i}"] = f"%{value}%"
                or_clause = " OR ".join(f"{expr} LIKE :p_{i}" for expr in resolved_exprs)
                where_clauses.append(f"({or_clause})")
            continue

        if field_key not in filter_fields:
            raise HTTPException(400, f"Invalid filter field: {field_key}")
        filter_meta = filter_fields[field_key]
        if operator not in (filter_meta.get("allowed_operators") or ()):
            raise HTTPException(400, f"Operator '{operator}' is not allowed for {field_key}")
        col_expr = filter_meta["expression"]
        needed_joins.update(filter_meta["joins"])

        if operator == "between":
            if isinstance(value, list) and len(value) == 2:
                params[f"p_{i}_a"] = value[0]
                params[f"p_{i}_b"] = value[1]
                where_clauses.append(f"{col_expr} BETWEEN :p_{i}_a AND :p_{i}_b")
        elif operator in ("in", "not_in"):
            if isinstance(value, list) and value:
                placeholders = ", ".join(f":p_{i}_{j}" for j in range(len(value)))
                for j, item in enumerate(value):
                    params[f"p_{i}_{j}"] = item
                op_str = "IN" if operator == "in" else "NOT IN"
                where_clauses.append(f"{col_expr} {op_str} ({placeholders})")
        elif operator in ("is_null", "is_not_null"):
            where_clauses.append(f"{col_expr} {'IS NULL' if operator == 'is_null' else 'IS NOT NULL'}")
        elif operator in _OPERATOR_MAP:
            params[f"p_{i}"] = f"%{value}%" if operator == "contains" else (f"{value}%" if operator == "starts_with" else value)
            where_clauses.append(f"{col_expr} {_OPERATOR_MAP[operator].format(i=i)}")

    _apply_data_scope_clauses(cfg, cu, db, where_clauses, params)

    for sort_item in config.get("sort") or []:
        field_key = sort_item.get("field", "")
        if field_key not in select_fields:
            raise HTTPException(400, f"Invalid sort field: {field_key}")
        if not select_fields[field_key]["is_sortable"]:
            raise HTTPException(400, f"Field is not sortable: {field_key}")
        needed_joins.update(select_fields[field_key]["joins"])

    join_sql = ""
    all_joins = cfg.get("joins", {})
    for alias, join_clause in all_joins.items():
        if alias in needed_joins:
            join_sql += f"\n  {join_clause}"

    where_sql = ""
    if where_clauses:
        where_sql = "\nWHERE " + "\n  AND ".join(where_clauses)

    if count_only:
        return f"SELECT COUNT(*) AS total\n  {cfg['base']}{join_sql}{where_sql}", params, selected

    select_sql = ",\n  ".join(
        f"{select_fields[field_key]['expression']} AS `{field_key}`"
        for field_key in all_fields
    )

    order_parts: list[str] = []
    for sort_item in config.get("sort") or []:
        field_key = sort_item.get("field", "")
        direction = "ASC" if sort_item.get("direction", "desc").lower() == "asc" else "DESC"
        order_parts.append(f"{select_fields[field_key]['expression']} {direction}")
    order_sql = "\nORDER BY " + ", ".join(order_parts) if order_parts else ""

    limit_sql = ""
    if not export:
        page = max(1, int(config.get("page", 1)))
        per_page = min(500, max(1, int(config.get("per_page", 50))))
        params["__limit"] = per_page
        params["__offset"] = (page - 1) * per_page
        limit_sql = "\nLIMIT :__limit OFFSET :__offset"

    sql = f"SELECT\n  {select_sql}\n  {cfg['base']}{join_sql}{where_sql}{order_sql}{limit_sql}"
    return sql, params, selected


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class FilterItem(BaseModel):
    field: str
    operator: str = "eq"
    value: Any = None


class SortItem(BaseModel):
    field: str
    direction: str = "desc"


class ReportRunRequest(BaseModel):
    report_type:     Optional[str] = None  # legacy client name
    report_type_key: Optional[str] = None
    template_key:    Optional[str] = None
    primary_module:  Optional[str] = None
    related_modules: Optional[list[str]] = None
    parent_module:   Optional[str] = None
    module_chain:    Optional[list[str]] = None
    child_modules:   Optional[list[str]] = None
    fields:          Optional[list[str]] = None
    filters:         Optional[list[FilterItem]] = None
    sort:            Optional[list[SortItem]] = None
    date_from:       Optional[str] = None
    date_to:         Optional[str] = None
    page:            int = Field(default=1, ge=1)
    per_page:        int = Field(default=50, ge=1, le=500)
    export:          Optional[str] = None   # "csv" | "xlsx"


class BusinessTemplateResolveRequest(BaseModel):
    template_key: str
    primary_module: str
    related_modules: list[str] = Field(default_factory=list)


class SavedReportCreate(BaseModel):
    name:              str
    description:       Optional[str] = None
    report_type_key:   Optional[str] = None
    report_type_id:    Optional[int] = None
    folder_id:         Optional[int] = None
    visibility:        str = "private"   # "private" | "org"
    config_json:       Optional[dict] = None
    chart_config_json: Optional[dict] = None


class SavedReportUpdate(BaseModel):
    name:              Optional[str] = None
    description:       Optional[str] = None
    folder_id:         Optional[int] = None
    config_json:       Optional[dict] = None
    chart_config_json: Optional[dict] = None


class SavedFilterCreate(BaseModel):
    report_type_key: str
    filter_name:     str
    filter_type:     str = "mixed"   # "quick" | "advanced" | "mixed"
    visibility:      str = "private"  # "private" | "org"
    config_json:     dict


class SavedFilterUpdate(BaseModel):
    filter_name: Optional[str] = None
    filter_type: Optional[str] = None
    visibility:  Optional[str] = None
    config_json: Optional[dict] = None


class FolderCreate(BaseModel):
    name:        str
    description: Optional[str] = None
    parent_id:   Optional[int] = None
    visibility:  str = "org"


class SavedReportVisibility(BaseModel):
    visibility: str  # "private" | "org"


# ---------------------------------------------------------------------------
# Report Types  (catalog endpoints)
# ---------------------------------------------------------------------------

def _active_report_type_keys(db: Session) -> set[str]:
    return {
        key for (key,) in db.query(ReportType.key).filter(ReportType.is_active == True).all()
    }


def _report_type_names(db: Session) -> dict[str, str]:
    return {
        key: name for key, name in db.query(ReportType.key, ReportType.name)
        .filter(ReportType.is_active == True)
        .all()
    }


def _node_for_chain(parent_module: str, chain: list[str]) -> dict[str, Any]:
    if not chain or chain[0] != parent_module:
        raise HTTPException(400, "chain must start with parent_module")
    node = REPORT_MODULE_RELATION_TREE.get(parent_module)
    if not node:
        raise HTTPException(404, "Parent module not found")
    for module_key in chain[1:]:
        children = node.get("children") or {}
        node = children.get(module_key)
        if not node:
            raise HTTPException(400, "Selected module chain is not allowed")
    return node


def _relation_is_visible(
    relation: dict[str, Any],
    active_type_keys: set[str],
    granted: set[str],
    db: Session,
    cu: User,
) -> bool:
    rt_key = relation["report_type_key"]
    return rt_key in active_type_keys and _has_report_type_access(rt_key, db, cu, granted)


def _relation_can_continue(
    relation: dict[str, Any],
    active_type_keys: set[str],
    granted: set[str],
    db: Session,
    cu: User,
) -> bool:
    chain = list(relation["module_chain"])
    node = _node_for_chain(relation["parent_module"], chain)
    for child_key in (node.get("children") or {}).keys():
        child_relation = _relation_for_chain(relation["parent_module"], [*chain, child_key])
        if child_relation and _relation_is_visible(child_relation, active_type_keys, granted, db, cu):
            return True
    return False


def _relation_option(
    relation: dict[str, Any],
    type_names: dict[str, str],
    active_type_keys: set[str],
    granted: set[str],
    db: Session,
    cu: User,
    *,
    module_key: Optional[str] = None,
    label: Optional[str] = None,
    description: Optional[str] = None,
    can_continue: Optional[bool] = None,
) -> dict[str, Any]:
    chain = list(relation["module_chain"])
    option_module_key = module_key or relation["child_module"]
    return {
        "module_key": option_module_key,
        "label": label or relation["label"],
        "module_label": _module_label(option_module_key) if option_module_key != "none" else "-None-",
        "description": description if description is not None else relation.get("description"),
        "report_type_key": relation["report_type_key"],
        "report_type_name": type_names.get(relation["report_type_key"], relation["label"]),
        "parent_module": relation["parent_module"],
        "child_modules": list(relation.get("child_modules") or chain),
        "module_chain": chain,
        "chain": chain,
        "chain_key": relation["chain_key"],
        "level": relation["level"],
        "can_continue": (
            _relation_can_continue(relation, active_type_keys, granted, db, cu)
            if can_continue is None else can_continue
        ),
    }


def _business_category_label(category_key: str) -> str:
    category = next((item for item in REPORT_BUSINESS_CATEGORIES if item["category_key"] == category_key), None)
    return category["label"] if category else category_key.replace("_", " ").title()


def _module_option_payload(module_key: str) -> dict[str, Any]:
    catalog = MODULE_CATALOG.get(module_key, {})
    return {
        "module_key": module_key,
        "label": _module_label(module_key),
        "sort_order": catalog.get("sort_order", 999),
    }


def _normalize_template_related_modules(template: dict[str, Any], related_modules: Any) -> list[str]:
    related = _normalize_module_chain(related_modules)
    primary_module = template["primary_module"]
    if related and related[0] == primary_module:
        related = related[1:]

    allowed = list(template.get("allowed_related_modules") or [])
    allowed_set = set(allowed)
    invalid = [module_key for module_key in related if module_key not in allowed_set]
    if invalid:
        raise HTTPException(400, f"Related module is not allowed for this template: {invalid[0]}")

    requested = set(related)
    return [module_key for module_key in allowed if module_key in requested]


def _business_combo_key(template: dict[str, Any], related_modules: Any) -> tuple[str, ...]:
    related = _normalize_template_related_modules(template, related_modules)
    return (template["primary_module"], *related)


def _business_fields_endpoint(report_type_key: str) -> str:
    return f"/reports/engine/types/{report_type_key}/fields"


def _business_template_default_fields(template: dict[str, Any], report_type_key: str, db: Session) -> list[str]:
    field_map = template.get("default_fields") or {}
    configured = field_map.get(report_type_key) or field_map.get("__default__") or []
    _, select_fields, _ = _load_report_runtime_fields(report_type_key, db)
    selected = [field_key for field_key in configured if field_key in select_fields]
    if len(selected) >= 3:
        return selected

    defaults = [
        field_key for field_key, meta in select_fields.items()
        if meta.get("is_default_column")
    ]
    return defaults[:10] if defaults else list(select_fields.keys())[:10]


def _business_template_combinations(
    template: dict[str, Any],
    active_type_keys: set[str],
    granted: set[str],
    db: Session,
    cu: User,
) -> list[dict[str, Any]]:
    allowed_order = {
        module_key: index for index, module_key in enumerate(template.get("allowed_related_modules") or [])
    }
    combinations: list[dict[str, Any]] = []
    for combo, rt_key in (template.get("report_type_key_map") or {}).items():
        if not combo or combo[0] != template["primary_module"]:
            continue
        if rt_key not in active_type_keys or not _has_report_type_access(rt_key, db, cu, granted):
            continue
        related_modules = list(combo[1:])
        module_chain = [template["primary_module"], *related_modules]
        combinations.append({
            "primary_module": template["primary_module"],
            "primary_module_label": _module_label(template["primary_module"]),
            "related_modules": related_modules,
            "related_module_labels": [_module_label(module_key) for module_key in related_modules],
            "module_chain": module_chain,
            "report_type_key": rt_key,
            "fields_endpoint": _business_fields_endpoint(rt_key),
        })

    combinations.sort(
        key=lambda item: (
            len(item["related_modules"]),
            [allowed_order.get(module_key, 999) for module_key in item["related_modules"]],
        )
    )
    return combinations


def _business_template_default_combo(
    template: dict[str, Any],
    combinations: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not combinations:
        return None
    default_key = _business_combo_key(template, template.get("default_related_modules") or [])
    for combination in combinations:
        if tuple(combination["module_chain"]) == default_key:
            return combination
    return combinations[0]


def _business_template_payload(
    template: dict[str, Any],
    active_type_keys: set[str],
    granted: set[str],
    db: Session,
    cu: User,
    *,
    detail: bool = False,
) -> Optional[dict[str, Any]]:
    combinations = _business_template_combinations(template, active_type_keys, granted, db, cu)
    default_combo = _business_template_default_combo(template, combinations)
    if not default_combo:
        return None

    payload: dict[str, Any] = {
        "template_key": template["template_key"],
        "template_name": template["template_name"],
        "category": template["category"],
        "category_label": _business_category_label(template["category"]),
        "description": template.get("description"),
        "primary_module": template["primary_module"],
        "primary_module_label": _module_label(template["primary_module"]),
        "allowed_related_modules": [
            _module_option_payload(module_key)
            for module_key in template.get("allowed_related_modules") or []
        ],
        "default_related_modules": list(default_combo["related_modules"]),
        "default_report_type_key": default_combo["report_type_key"],
        "default_module_chain": list(default_combo["module_chain"]),
        "fields_endpoint": default_combo["fields_endpoint"],
        "default_fields": _business_template_default_fields(template, default_combo["report_type_key"], db),
        "permission_keys": list(template.get("permission_keys") or []),
    }

    if detail:
        payload["allowed_combinations"] = combinations
        payload["available_combinations"] = combinations
        payload["report_type_key_map"] = [
            {
                "module_chain": list(combo),
                "primary_module": combo[0],
                "related_modules": list(combo[1:]),
                "report_type_key": rt_key,
            }
            for combo, rt_key in (template.get("report_type_key_map") or {}).items()
            if any(item["module_chain"] == list(combo) for item in combinations)
        ]

    return payload


def _resolve_business_template_selection(
    template_key: str,
    primary_module: str,
    related_modules: Any,
    db: Session,
    cu: User,
) -> dict[str, Any]:
    template = REPORT_BUSINESS_TEMPLATE_INDEX.get(template_key)
    if not template:
        raise HTTPException(404, "Business report template not found")
    if primary_module != template["primary_module"]:
        raise HTTPException(400, "Primary module does not match the selected business template")

    related = _normalize_template_related_modules(template, related_modules)
    combo = (primary_module, *related)
    report_type_key = (template.get("report_type_key_map") or {}).get(combo)
    if not report_type_key:
        raise HTTPException(400, "Selected related module combination is not allowed for this template")

    if report_type_key not in _active_report_type_keys(db):
        raise HTTPException(400, "Resolved report type is not active")
    _require_report_type_access(report_type_key, db, cu)

    module_chain = [primary_module, *related]
    return {
        "template_key": template["template_key"],
        "template_name": template["template_name"],
        "category": template["category"],
        "category_label": _business_category_label(template["category"]),
        "description": template.get("description"),
        "primary_module": primary_module,
        "primary_module_label": _module_label(primary_module),
        "related_modules": related,
        "related_module_labels": [_module_label(module_key) for module_key in related],
        "report_type_key": report_type_key,
        "module_chain": module_chain,
        "chain_key": _chain_key(module_chain),
        "fields_endpoint": _business_fields_endpoint(report_type_key),
        "default_fields": _business_template_default_fields(template, report_type_key, db),
        "permission_keys": list(_report_type_permission_keys(report_type_key)),
    }


def _business_resolution_from_config(rt_key: str, config: dict) -> Optional[dict[str, Any]]:
    template_key = config.get("template_key")
    if not template_key:
        return None

    template = REPORT_BUSINESS_TEMPLATE_INDEX.get(str(template_key))
    if not template:
        raise HTTPException(400, "Invalid business report template")

    primary_module = str(
        config.get("primary_module")
        or config.get("parent_module")
        or template["primary_module"]
    )
    if primary_module != template["primary_module"]:
        raise HTTPException(400, "Primary module does not match the selected business template")

    related_modules = config.get("related_modules")
    if related_modules is None and config.get("module_chain") is not None:
        chain = _normalize_module_chain(config.get("module_chain"))
        related_modules = chain[1:] if chain and chain[0] == primary_module else chain
    if related_modules is None:
        related_modules = config.get("child_modules") or []

    related = _normalize_template_related_modules(template, related_modules)
    combo = (primary_module, *related)
    report_type_key = (template.get("report_type_key_map") or {}).get(combo)
    if not report_type_key:
        raise HTTPException(400, "Selected related module combination is not allowed for this template")
    if report_type_key != rt_key:
        raise HTTPException(400, "report_type_key does not belong to the selected business template")

    module_chain = [primary_module, *related]
    return {
        "template_key": template["template_key"],
        "primary_module": primary_module,
        "related_modules": related,
        "module_chain": module_chain,
        "chain_key": _chain_key(module_chain),
    }


# ---------------------------------------------------------------------------
# System default reports - seeded per tenant on creation or on-demand
#
# Field lists below intentionally include every business-relevant column for
# each report type (not just a curated handful) so a system report reads like
# the module's full list page. Raw foreign-key ids, internal/audit columns
# (is_deleted, custom_data) and linked-record counts (Linked Records view
# only) are left out.
# ---------------------------------------------------------------------------

_ALL_TENDER_FIELDS = [
    "tender_ref_id", "tender_title", "customer_name", "lead_title", "status", "result",
    "bid_amount", "est_value", "current_step", "tender_date", "submission_date",
    "result_date", "assigned_to_name", "created_by_name", "vertical_name",
]

_ALL_EMDBG_FIELDS = [
    "instrument_type", "instrument_number", "bank_name", "amount", "issue_date",
    "expiry_date", "status", "customer_name", "tender_title", "created_by_name",
]

_ALL_LEAD_FIELDS = [
    "lead_ref_id", "lead_title", "customer_name", "status", "priority", "est_value",
    "region", "branch", "follow_up", "timeline", "converted_at", "assigned_to_name",
    "created_by_name", "source_name", "vertical_name",
]

_ALL_OPPORTUNITY_FIELDS = [
    "lead_title", "customer_name", "status", "priority", "est_value", "region",
    "assigned_to_name", "created_by_name", "vertical_name",
]

_ALL_CUSTOMER_FIELDS = [
    "customer_name", "customer_vertical", "division", "group_name", "industry",
    "parent_account_name", "billing_address", "billing_city", "billing_state",
    "billing_area", "billing_country", "billing_pincode", "shipping_address",
    "shipping_city", "shipping_state", "shipping_area", "shipping_country",
    "shipping_pincode", "gst_number", "pan_number", "annual_revenue", "employee_count",
    "website", "account_status", "account_potential", "potential_value",
    "assigned_to_name", "approval_status", "remarks",
    "created_by_name", "updated_by_name",
]

_ALL_WORKORDER_FIELDS = [
    "wo_number", "project_title", "customer_name", "lead_title", "wo_type", "po_number",
    "po_value", "wo_value", "progress_percent", "status", "delivery_date",
    "created_by_name",
]

_ALL_QUOTATION_FIELDS = [
    "quotation_number", "subject", "customer_name", "lead_title", "amount",
    "total_amount", "status", "valid_until", "created_by_name",
]

_ALL_TRAVEL_FIELDS = [
    "purpose", "from_city", "to_city", "travel_date", "return_date", "visit_type",
    "status", "advance_required", "advance_amount", "employee_name",
]

_ALL_QUESTIONNAIRE_FIELDS = [
    "customer_name", "status",
    "progress_percentage", "started_at", "completed_at", "last_saved_at", "created_by_name",
]

_ALL_QUESTIONNAIRE_ADOPTION_FIELDS = [
    "status", "total_assigned",
    "not_started_count", "in_progress_count", "completed_count", "reopened_count",
    "completion_rate_pct", "avg_days_to_complete",
]

_ALL_QUESTIONNAIRE_SECTION_FIELDS = [
    "structure_type", "section_name", "total_questions",
    "avg_completion_pct", "fully_completed_customers",
]

_ALL_QUESTIONNAIRE_ANSWER_FIELDS = [
    "customer_name", "section_name", "question_label",
    "answer_value", "answered_by_name", "answered_at",
]

_ALL_QUESTIONNAIRE_QUESTION_FIELDS = [
    "section_name", "question_label", "input_type",
    "total_assigned", "answered_count", "skipped_count", "skip_rate_pct",
]

_ALL_QUESTIONNAIRE_USER_FIELDS = [
    "role_name", "users", "customers", "questions", "answered",
    "pending", "completion_pct",
]

_ALL_QUESTIONNAIRE_ROLE_USER_FIELDS = [
    "user_name", "customers", "questions", "answered", "pending",
    "completion_pct", "completed_customers",
]

_ALL_QUESTIONNAIRE_USER_DETAIL_FIELDS = [
    "user_name", "role_name", "customer_name", "questionnaire_name",
    "section_name", "subsection_name", "question_code", "question_label",
    "field_label", "answer_value", "status", "answered_at",
]

_SYSTEM_REPORTS: list[dict] = [
    # ── Tender Reports ───────────────────────────────────────────────────────
    {
        "folder": "Tender Reports",
        "name": "All Tenders",
        "description": "Complete list of all tenders with key details",
        "report_type_key": "tenders",
        "config": {"fields": _ALL_TENDER_FIELDS},
    },
    {
        "folder": "Tender Reports",
        "name": "Won Tenders",
        "description": "Tenders where result is Won",
        "report_type_key": "tenders",
        "config": {
            "fields": _ALL_TENDER_FIELDS,
            "filters": [{"field": "result", "operator": "eq", "value": "Won"}],
        },
    },
    {
        "folder": "Tender Reports",
        "name": "Top Tenders by Bid Value",
        "description": "All tenders ranked by bid amount",
        "report_type_key": "tenders",
        "config": {"fields": _ALL_TENDER_FIELDS},
    },
    {
        "folder": "Tender Reports",
        "name": "Submitted Tenders",
        "description": "Tenders currently in Submitted stage",
        "report_type_key": "tenders",
        "config": {
            "fields": _ALL_TENDER_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Submitted"}],
        },
    },
    {
        "folder": "Tender Reports",
        "name": "Lost Tenders",
        "description": "Tenders where result is Lost",
        "report_type_key": "tenders",
        "config": {
            "fields": _ALL_TENDER_FIELDS,
            "filters": [{"field": "result", "operator": "eq", "value": "Lost"}],
        },
    },
    # ── EMD / BG Register ───────────────────────────────────────────────────
    {
        "folder": "EMD / BG Register",
        "name": "All EMD / BG",
        "description": "Complete EMD and Bank Guarantee register",
        "report_type_key": "emdbg",
        "config": {"fields": _ALL_EMDBG_FIELDS},
    },
    {
        "folder": "EMD / BG Register",
        "name": "Active EMD / BG",
        "description": "Instruments currently in Active status",
        "report_type_key": "emdbg",
        "config": {
            "fields": _ALL_EMDBG_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Active"}],
        },
    },
    {
        "folder": "EMD / BG Register",
        "name": "Total EMD / BG Value",
        "description": "All instruments showing amount — review total exposure",
        "report_type_key": "emdbg",
        "config": {"fields": _ALL_EMDBG_FIELDS},
    },
    {
        "folder": "EMD / BG Register",
        "name": "Expiring EMD / BG",
        "description": "Active instruments sorted by earliest expiry date",
        "report_type_key": "emdbg",
        "config": {
            "fields": _ALL_EMDBG_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Active"}],
        },
    },
    {
        "folder": "EMD / BG Register",
        "name": "Released / Returned EMD / BG",
        "description": "Instruments with Released status",
        "report_type_key": "emdbg",
        "config": {
            "fields": _ALL_EMDBG_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Released"}],
        },
    },
    # ── Lead Reports ─────────────────────────────────────────────────────────
    {
        "folder": "Lead Reports",
        "name": "Lead Pipeline",
        "description": "All active leads in the pipeline",
        "report_type_key": "leads",
        "config": {"fields": _ALL_LEAD_FIELDS},
    },
    {
        "folder": "Lead Reports",
        "name": "High Priority Leads",
        "description": "Leads marked as High priority",
        "report_type_key": "leads",
        "config": {
            "fields": _ALL_LEAD_FIELDS,
            "filters": [{"field": "priority", "operator": "eq", "value": "High"}],
        },
    },
    {
        "folder": "Lead Reports",
        "name": "Converted Leads",
        "description": "Leads successfully converted to opportunities",
        "report_type_key": "leads",
        "config": {
            "fields": _ALL_LEAD_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Converted"}],
        },
    },
    {
        "folder": "Lead Reports",
        "name": "Lost Leads",
        "description": "Leads that were lost",
        "report_type_key": "leads",
        "config": {
            "fields": _ALL_LEAD_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Lost"}],
        },
    },
    # ── Opportunity Reports ──────────────────────────────────────────────────
    {
        "folder": "Opportunity Reports",
        "name": "Opportunity Pipeline",
        "description": "All direct opportunities",
        "report_type_key": "opportunities",
        "config": {"fields": _ALL_OPPORTUNITY_FIELDS},
    },
    {
        "folder": "Opportunity Reports",
        "name": "High Value Opportunities",
        "description": "Opportunities by highest estimated value",
        "report_type_key": "opportunities",
        "config": {"fields": _ALL_OPPORTUNITY_FIELDS},
    },
    # ── Customer Reports ─────────────────────────────────────────────────────
    {
        "folder": "Customer Reports",
        "name": "All Customers",
        "description": "Complete customer master list",
        "report_type_key": "customers",
        "config": {"fields": _ALL_CUSTOMER_FIELDS},
    },
    {
        "folder": "Customer Reports",
        "name": "Active Customers",
        "description": "Customers with Active account status",
        "report_type_key": "customers",
        "config": {
            "fields": _ALL_CUSTOMER_FIELDS,
            "filters": [{"field": "account_status", "operator": "eq", "value": "Active"}],
        },
    },
    # ── Work Order Reports ───────────────────────────────────────────────────
    {
        "folder": "Work Order Reports",
        "name": "All Work Orders",
        "description": "Complete work order register",
        "report_type_key": "workorders",
        "config": {"fields": _ALL_WORKORDER_FIELDS},
    },
    {
        "folder": "Work Order Reports",
        "name": "Work Orders In Progress",
        "description": "Work orders currently being executed",
        "report_type_key": "workorders",
        "config": {
            "fields": _ALL_WORKORDER_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "In Progress"}],
        },
    },
    {
        "folder": "Work Order Reports",
        "name": "Work Orders by Value",
        "description": "Work orders ranked by order value",
        "report_type_key": "workorders",
        "config": {"fields": _ALL_WORKORDER_FIELDS},
    },
    # ── Quotation Reports ────────────────────────────────────────────────────
    {
        "folder": "Quotation Reports",
        "name": "All Quotations",
        "description": "Complete quotation register",
        "report_type_key": "quotations",
        "config": {"fields": _ALL_QUOTATION_FIELDS},
    },
    # ── Travel Reports ───────────────────────────────────────────────────────
    {
        "folder": "Travel Reports",
        "name": "Travel Requests",
        "description": "All employee travel requests",
        "report_type_key": "travel",
        "config": {"fields": _ALL_TRAVEL_FIELDS},
    },
    {
        "folder": "Travel Reports",
        "name": "Submitted Travel Requests",
        "description": "Travel requests awaiting approval",
        "report_type_key": "travel",
        "config": {
            "fields": _ALL_TRAVEL_FIELDS,
            "filters": [{"field": "status", "operator": "eq", "value": "Submitted"}],
        },
    },
    # ── Questionnaire Reports ────────────────────────────────────────────────
    {
        "folder": "Questionnaire Reports",
        "name": "Role-wise Questionnaire Summary",
        "description": "Role-wise questionnaire completion, pending questions, status split, and average rating",
        "report_type_key": "questionnaire_user",
        "config": {"fields": _ALL_QUESTIONNAIRE_USER_FIELDS},
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Questionnaire Completion",
        "description": "Per-customer questionnaire completion status and progress",
        "report_type_key": "questionnaire",
        "config": {"fields": _ALL_QUESTIONNAIRE_FIELDS},
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Pending Questionnaires",
        "description": "Questionnaires not yet completed by the customer",
        "report_type_key": "questionnaire",
        "config": {
            "fields": _ALL_QUESTIONNAIRE_FIELDS,
            "filters": [{"field": "status", "operator": "in", "value": ["not_started", "in_progress"]}],
        },
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Questionnaire Adoption Summary",
        "description": "Rollout progress per questionnaire — assigned customers, status breakdown, completion rate",
        "report_type_key": "questionnaire_adoption",
        "config": {"fields": _ALL_QUESTIONNAIRE_ADOPTION_FIELDS},
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Section Completion Analysis",
        "description": "Section/subsection-wise completion across all customers",
        "report_type_key": "questionnaire_sections",
        "config": {"fields": _ALL_QUESTIONNAIRE_SECTION_FIELDS},
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Question Response Analysis",
        "description": "Per-question response and skip rate across all customers",
        "report_type_key": "questionnaire_questions",
        "config": {"fields": _ALL_QUESTIONNAIRE_QUESTION_FIELDS},
    },
    {
        "folder": "Questionnaire Reports",
        "name": "Questionnaire Answer Detail",
        "description": "Raw answer-level export — every customer's response to every question",
        "report_type_key": "questionnaire_answers",
        "config": {"fields": _ALL_QUESTIONNAIRE_ANSWER_FIELDS},
    },
]


_DEPRECATED_SYSTEM_REPORT_NAMES = {
    "User-wise Questionnaire Detail",
}

_SYSTEM_REPORT_NAME_RENAMES = {
    "User-wise Questionnaire Summary": "Role-wise Questionnaire Summary",
}


def _saved_report_display_name(report: SavedReport) -> str:
    if report.is_system:
        return _SYSTEM_REPORT_NAME_RENAMES.get(report.name, report.name)
    return report.name


def _saved_report_display_description(report: SavedReport) -> Optional[str]:
    if report.is_system and _saved_report_display_name(report) == "Role-wise Questionnaire Summary":
        return "Role-wise questionnaire completion, pending questions, status split, and average rating"
    return report.description


def _saved_report_config_for_runtime(report: SavedReport, rt_key: Optional[str]) -> dict:
    config = dict(report.config_json or {})
    if report.is_system and rt_key == "questionnaire_user":
        config["fields"] = list(_ALL_QUESTIONNAIRE_USER_FIELDS)
    return config


def seed_system_reports(db: Session) -> int:
    """Create system default reports for a tenant. Idempotent — skips existing names."""
    rt_map: dict[str, int] = {
        key: rt_id
        for key, rt_id in db.query(ReportType.key, ReportType.id)
            .filter(ReportType.is_active == True)
            .all()
    }

    existing: dict[str, SavedReport] = {
        report.name: report for report in db.query(SavedReport)
            .filter(SavedReport.is_system == True)
            .all()
    }

    for old_name, new_name in _SYSTEM_REPORT_NAME_RENAMES.items():
        old_report = existing.get(old_name)
        new_report = existing.get(new_name)
        if old_report and new_report and old_report.id != new_report.id:
            old_report.is_active = False
        elif old_report and not new_report:
            old_report.name = new_name
            existing[new_name] = old_report
            existing.pop(old_name, None)

    for deprecated_name in _DEPRECATED_SYSTEM_REPORT_NAMES:
        deprecated_report = existing.get(deprecated_name)
        if deprecated_report and deprecated_report.is_active:
            deprecated_report.is_active = False

    folder_map: dict[str, int] = {}
    created = 0

    for spec in _SYSTEM_REPORTS:
        rt_key = spec["report_type_key"]
        if rt_key not in rt_map:
            continue
        existing_report = existing.get(spec["name"])
        if existing_report is not None:
            # Keep the system report's column set in sync with the current
            # definition so tenants seeded before a template update still
            # pick up newly added fields.
            existing_report.config_json = spec["config"]
            continue

        folder_name = spec["folder"]
        if folder_name not in folder_map:
            folder = db.query(ReportFolder).filter(
                ReportFolder.name == folder_name,
                ReportFolder.is_system == True,
            ).first()
            if not folder:
                folder = ReportFolder(
                    name=folder_name,
                    is_system=True,
                    visibility="org",
                    created_by=None,
                )
                db.add(folder)
                db.flush()
            folder_map[folder_name] = folder.id

        db.add(SavedReport(
            name=spec["name"],
            description=spec.get("description"),
            report_type_id=rt_map[rt_key],
            folder_id=folder_map[folder_name],
            is_system=True,
            visibility="org",
            created_by=None,
            config_json=spec["config"],
        ))
        created += 1

    if created:
        db.flush()
    return created


@router.post("/engine/admin/seed-system-reports", status_code=200)
def seed_system_reports_endpoint(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Seed system default reports for this tenant. Admin only. Idempotent."""
    if cu.role != "admin":
        raise HTTPException(403, "Admin only")
    n = seed_system_reports(db)
    db.commit()
    return {"created": n, "message": f"{n} system report(s) seeded"}


@router.get("/engine/business-templates")
def list_business_templates(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Return business report categories and backend-approved templates."""
    active_type_keys = _active_report_type_keys(db)
    granted = _granted_permission_keys(db, cu)

    templates_by_category: dict[str, list[dict[str, Any]]] = {
        category["category_key"]: [] for category in REPORT_BUSINESS_CATEGORIES
    }
    flat_templates: list[dict[str, Any]] = []

    for template in REPORT_BUSINESS_TEMPLATES:
        payload = _business_template_payload(template, active_type_keys, granted, db, cu)
        if not payload:
            continue
        templates_by_category.setdefault(template["category"], []).append(payload)
        flat_templates.append(payload)

    categories = []
    for category in sorted(REPORT_BUSINESS_CATEGORIES, key=lambda item: item["sort_order"]):
        category_templates = templates_by_category.get(category["category_key"], [])
        if not category_templates:
            continue
        categories.append({
            "category_key": category["category_key"],
            "label": category["label"],
            "sort_order": category["sort_order"],
            "templates": category_templates,
        })

    return {
        "categories": categories,
        "templates": flat_templates,
    }


@router.get("/engine/business-templates/{template_key}")
def get_business_template(
    template_key: str,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Return one business template with available related-module combinations."""
    template = REPORT_BUSINESS_TEMPLATE_INDEX.get(template_key)
    if not template:
        raise HTTPException(404, "Business report template not found")

    active_type_keys = _active_report_type_keys(db)
    granted = _granted_permission_keys(db, cu)
    payload = _business_template_payload(template, active_type_keys, granted, db, cu, detail=True)
    if not payload:
        raise HTTPException(403, "No accessible report combinations for this template")
    return payload


@router.post("/engine/business-templates/resolve")
def resolve_business_template(
    body: BusinessTemplateResolveRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Resolve a business template selection to the backend-owned report type key."""
    return _resolve_business_template_selection(
        body.template_key,
        body.primary_module,
        body.related_modules,
        db,
        cu,
    )


@router.get("/engine/module-relations")
def list_module_relations(
    parent_module: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Return backend-approved parent modules for report creation."""
    active_type_keys = _active_report_type_keys(db)
    all_visible = [
        relation for relation in _visible_report_relations(db, cu)
        if relation["report_type_key"] in active_type_keys
    ]
    parent_keys = sorted(
        {relation["parent_module"] for relation in all_visible},
        key=lambda key: MODULE_CATALOG.get(key, {}).get("sort_order", 999),
    )
    parents = [
        {
            "module_key": key,
            "label": _module_label(key),
            "sort_order": MODULE_CATALOG.get(key, {}).get("sort_order", 999),
        }
        for key in parent_keys
    ]
    payload = {
        "parent_modules": parents,
        "selected_parent": parent_module,
        "child_modules": [],
    }
    if parent_module:
        granted = _granted_permission_keys(db, cu)
        type_names = _report_type_names(db)
        parent_node = REPORT_MODULE_RELATION_TREE.get(parent_module)
        if parent_node:
            children: list[dict[str, Any]] = []
            root_relation = _relation_for_chain(parent_module, [parent_module])
            if root_relation and _relation_is_visible(root_relation, active_type_keys, granted, db, cu):
                children.append(_relation_option(
                    root_relation, type_names, active_type_keys, granted, db, cu, can_continue=False,
                ))
            for child_key in sorted(
                (parent_node.get("children") or {}).keys(),
                key=lambda key: MODULE_CATALOG.get(key, {}).get("sort_order", 999),
            ):
                relation = _relation_for_chain(parent_module, [parent_module, child_key])
                if relation and _relation_is_visible(relation, active_type_keys, granted, db, cu):
                    children.append(_relation_option(relation, type_names, active_type_keys, granted, db, cu))
            payload["child_modules"] = children
    return payload


@router.get("/engine/module-relations/children")
def list_module_relation_children(
    parent_module: str = Query(...),
    chain: str = Query(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Return backend-approved next child modules for a selected module chain."""
    active_type_keys = _active_report_type_keys(db)
    type_names = _report_type_names(db)
    granted = _granted_permission_keys(db, cu)
    selected_chain = _normalize_module_chain(chain) or [parent_module]
    if selected_chain[0] != parent_module:
        raise HTTPException(400, "chain must start with parent_module")

    node = _node_for_chain(parent_module, selected_chain)
    current_relation = _relation_for_chain(parent_module, selected_chain)
    children: list[dict[str, Any]] = []

    if current_relation and _relation_is_visible(current_relation, active_type_keys, granted, db, cu):
        if len(selected_chain) == 1:
            children.append(_relation_option(
                current_relation, type_names, active_type_keys, granted, db, cu, can_continue=False,
            ))
        else:
            children.append(_relation_option(
                current_relation,
                type_names,
                active_type_keys,
                granted,
                db,
                cu,
                module_key="none",
                label="-None-",
                description="Stop here",
                can_continue=False,
            ))

    for child_key in sorted(
        (node.get("children") or {}).keys(),
        key=lambda key: MODULE_CATALOG.get(key, {}).get("sort_order", 999),
    ):
        relation = _relation_for_chain(parent_module, [*selected_chain, child_key])
        if relation and _relation_is_visible(relation, active_type_keys, granted, db, cu):
            children.append(_relation_option(relation, type_names, active_type_keys, granted, db, cu))

    return {
        "parent_module": parent_module,
        "chain": selected_chain,
        "child_modules": children,
    }


@router.get("/engine/types")
def list_report_types(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """List all active report types with their field metadata."""
    types = db.query(ReportType).filter(ReportType.is_active == True).order_by(ReportType.sort_order).all()
    granted = _granted_permission_keys(db, cu)
    result = []
    for rt in types:
        if REPORT_ENGINE_CONFIG.get(rt.key, {}).get("visible") is False:
            continue
        if not _has_report_type_access(rt.key, db, cu, granted):
            continue
        result.append({
            "id":                    rt.id,
            "key":                   rt.key,
            "name":                  rt.name,
            "description":           rt.description,
            "base_table":            rt.key,
            "base_module_key":       REPORT_TYPE_BASE_MODULES.get(rt.key),
            "base_module_label":     _module_label(REPORT_TYPE_BASE_MODULES.get(rt.key)),
            "data_scope_module":     REPORT_ENGINE_CONFIG.get(rt.key, {}).get("module_key"),
            "module_permission_key": rt.module_permission_key,
            "default_date_field":    rt.default_date_field,
            "supports_charts":       rt.supports_charts,
            "supports_grouping":     rt.supports_grouping,
        })
    return result


@router.get("/engine/types/{type_key}/fields")
def get_report_type_fields(
    type_key: str,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Return all field definitions for a report type — drives the UI field picker."""
    rt = db.query(ReportType).filter(ReportType.key == type_key, ReportType.is_active == True).first()
    if not rt:
        raise HTTPException(404, "Report type not found")
    _require_report_type_access(type_key, db, cu)
    _, fields, _ = _load_report_runtime_fields(type_key, db)
    return [
        {
            "id":                f["id"],
            "field_key":         f["field_key"],
            "label":             f["label"],
            "module_key":        f["module_key"],
            "module_label":      f["module_label"],
            "data_type":         f["data_type"],
            "is_default_column": f["is_default_column"],
            "is_filterable":     f["is_filterable"],
            "is_groupable":      f["is_groupable"],
            "is_sortable":       f["is_sortable"],
            "is_aggregatable":   f["is_aggregatable"],
            "allowed_operators": f["allowed_operators"],
            "enum_values":       f["enum_values"],
            "format":            f["format"],
            "display_order":     f["display_order"],
            "drilldown_kind":          f["drilldown_kind"],
            "drilldown_target":        f["drilldown_target"],
            "drilldown_id_field":      f["drilldown_id_field"],
            "drilldown_filter_field":  f["drilldown_filter_field"],
        }
        for f in fields.values()
    ]


@router.get("/engine/types/{type_key}/filter-values")
def get_filter_field_values(
    type_key: str,
    field: str,
    q: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Distinct values for a filter field — drives the filter-value dropdown in the UI.

    Values come from the tenant's actual data, restricted by the same role/hierarchy
    data scope as report runs so a user never sees values from records outside their scope.
    """
    cfg = REPORT_ENGINE_CONFIG.get(type_key)
    if not cfg:
        raise HTTPException(404, "Report type not found")
    _require_report_type_access(type_key, db, cu)

    _, select_fields, filter_fields = _load_report_runtime_fields(type_key, db)
    meta = filter_fields.get(field) or select_fields.get(field)
    if not meta:
        raise HTTPException(400, f"Unknown filter field: {field}")

    # Seeded enum values win — no query needed
    enum_values = (select_fields.get(field) or {}).get("enum_values")
    if enum_values:
        values = [v for v in enum_values if not q or q.lower() in str(v).lower()]
        return {"field": field, "values": values[:100], "source": "enum"}

    if meta.get("data_type") not in (None, "text"):
        return {"field": field, "values": [], "source": "unsupported"}

    expr = meta["expression"]
    params: dict[str, Any] = {}
    where_clauses: list[str] = list(cfg["default_where"])
    where_clauses.append(f"{expr} IS NOT NULL")
    where_clauses.append(f"{expr} <> ''")
    if q:
        params["__q"] = f"%{q}%"
        where_clauses.append(f"{expr} LIKE :__q")
    _apply_data_scope_clauses(cfg, cu, db, where_clauses, params)

    join_sql = ""
    all_joins = cfg.get("joins", {})
    for alias, join_clause in all_joins.items():
        if alias in set(meta.get("joins") or []):
            join_sql += f"\n  {join_clause}"

    sql = (
        f"SELECT DISTINCT {expr} AS v\n  {cfg['base']}{join_sql}\n"
        f"WHERE {' AND '.join(where_clauses)}\n"
        f"ORDER BY v ASC\nLIMIT 100"
    )
    rows = db.execute(text(sql), params).fetchall()
    return {"field": field, "values": [r[0] for r in rows if r[0] is not None], "source": "data"}


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

@router.get("/engine/folders")
def list_folders(
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    folders = db.query(ReportFolder).order_by(ReportFolder.is_system.desc(), ReportFolder.name).all()
    return [
        {
            "id":          f.id,
            "name":        f.name,
            "description": f.description,
            "parent_id":   f.parent_id,
            "is_system":   f.is_system,
            "visibility":  f.visibility,
            "created_by":  f.created_by,
        }
        for f in folders
    ]


@router.post("/engine/folders", status_code=201)
def create_folder(
    body: FolderCreate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    f = ReportFolder(
        name=body.name,
        description=body.description,
        parent_id=body.parent_id,
        visibility=body.visibility,
        is_system=False,
        created_by=cu.id,
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id, "name": f.name}


@router.delete("/engine/folders/{folder_id}", status_code=204)
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    f = db.query(ReportFolder).filter(ReportFolder.id == folder_id).first()
    if not f:
        raise HTTPException(404, "Folder not found")
    if f.is_system:
        raise HTTPException(403, "Cannot delete system folders")
    if f.created_by != cu.id and str(cu.role).lower() not in ("admin", "superadmin"):
        raise HTTPException(403, "Not allowed")
    db.delete(f)
    db.commit()


# ---------------------------------------------------------------------------
# Saved Reports  (CRUD)
# ---------------------------------------------------------------------------

@router.get("/engine/saved")
def list_saved_reports(
    folder_id:       Optional[int] = None,
    report_type_key: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    q = db.query(SavedReport).filter(SavedReport.is_active == True)
    if folder_id:
        q = q.filter(SavedReport.folder_id == folder_id)
    if report_type_key:
        rt = db.query(ReportType).filter(ReportType.key == report_type_key).first()
        if rt:
            q = q.filter(SavedReport.report_type_id == rt.id)

    reports = q.order_by(SavedReport.is_system.desc(), SavedReport.name).all()
    granted = _granted_permission_keys(db, cu)
    result = []
    for r in reports:
        rt_key = db.query(ReportType.key).filter(ReportType.id == r.report_type_id).scalar()
        if r.is_system and (r.name in _DEPRECATED_SYSTEM_REPORT_NAMES or rt_key == "questionnaire_user_detail"):
            continue
        if _can_view_report(r, cu) and rt_key and _has_report_type_access(rt_key, db, cu, granted):
            result.append({
                "id":              r.id,
                "name":            _saved_report_display_name(r),
                "description":     _saved_report_display_description(r),
                "report_type_id":  r.report_type_id,
                "report_type_key": rt_key,
                "folder_id":       r.folder_id,
                "is_system":       r.is_system,
                "visibility":      r.visibility,
                "is_clone_of":     r.is_clone_of,
                "created_at":        r.created_at.isoformat() if r.created_at else None,
                "updated_at":        r.updated_at.isoformat() if r.updated_at else None,
                "last_accessed_at":  r.last_accessed_at.isoformat() if r.last_accessed_at else None,
                "last_run_at":       r.last_run_at.isoformat() if r.last_run_at else None,
                "run_count":         r.run_count or 0,
                "can_edit":          _can_edit_report(r, cu),
                            })
    return result


@router.post("/engine/saved", status_code=201)
def create_saved_report(
    body: SavedReportCreate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    rt_key, rt_id = _resolve_report_type_key_for_save(body, db, cu)
    config_json = _sanitize_report_config(rt_key, body.config_json or {}, db)
    r = SavedReport(
        name=body.name,
        description=body.description,
        report_type_id=rt_id,
        folder_id=body.folder_id,
        visibility=body.visibility if body.visibility in ("private", "org") else "private",
        config_json=config_json,
        chart_config_json=body.chart_config_json,
        is_system=False,
        created_by=cu.id,
        updated_by=cu.id,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return {"id": r.id, "name": r.name}


@router.get("/engine/saved/{report_id}")
def get_saved_report(
    report_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if not _can_view_report(r, cu):
        raise HTTPException(403, "No access")
    rt_key = db.query(ReportType.key).filter(ReportType.id == r.report_type_id).scalar()
    if rt_key:
        _require_report_type_access(rt_key, db, cu)
    # Stamp last_accessed_at silently (best-effort, don't fail the request)
    try:
        db.execute(
            sa_update(SavedReport)
            .where(SavedReport.id == report_id)
            .values(last_accessed_at=func.now())
        )
        db.commit()
    except Exception:
        db.rollback()
    config_json = _saved_report_config_for_runtime(r, rt_key)
    if rt_key:
        config_json.setdefault("report_type_key", rt_key)
        relation = _relation_for_report_type(rt_key)
        if relation:
            config_json.setdefault("parent_module", relation["parent_module"])
            config_json.setdefault("module_chain", list(relation["module_chain"]))
            config_json.setdefault("chain_key", relation["chain_key"])
            config_json.setdefault(
                "child_modules",
                list(relation.get("child_modules") or [relation["child_module"]]),
            )
    return {
        "id":                r.id,
        "name":              _saved_report_display_name(r),
        "description":       _saved_report_display_description(r),
        "report_type_id":    r.report_type_id,
        "report_type_key":   rt_key,
        "folder_id":         r.folder_id,
        "is_system":         r.is_system,
        "visibility":        r.visibility,
        "is_clone_of":       r.is_clone_of,
        "config_json":       config_json,
        "chart_config_json": r.chart_config_json,
        "created_by":        r.created_by,
        "created_at":        r.created_at.isoformat() if r.created_at else None,
        "last_run_at":       r.last_run_at.isoformat() if r.last_run_at else None,
        "last_accessed_at":  r.last_accessed_at.isoformat() if r.last_accessed_at else None,
        "run_count":         r.run_count or 0,
        "can_edit":          _can_edit_report(r, cu),
    }


@router.put("/engine/saved/{report_id}")
def update_saved_report(
    report_id: int,
    body: SavedReportUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if r.is_system:
        raise HTTPException(403, "System reports cannot be edited — clone first")
    if not _can_edit_report(r, cu):
        raise HTTPException(403, "No edit access")
    rt_key = db.query(ReportType.key).filter(ReportType.id == r.report_type_id).scalar()
    if rt_key:
        _require_report_type_access(rt_key, db, cu)
    if body.name is not None:        r.name = body.name
    if body.description is not None: r.description = body.description
    if body.folder_id is not None:   r.folder_id = body.folder_id
    if body.config_json is not None:
        if not rt_key:
            raise HTTPException(400, "Report has no report type configured")
        r.config_json = _sanitize_report_config(rt_key, body.config_json, db)
    if body.chart_config_json is not None: r.chart_config_json = body.chart_config_json
    r.updated_by = cu.id
    db.commit()
    return {"id": r.id, "name": r.name}


@router.post("/engine/saved/{report_id}/clone", status_code=201)
def clone_saved_report(
    report_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Clone any report (including system reports) into a personal copy."""
    src = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not src:
        raise HTTPException(404, "Report not found")
    if not _can_view_report(src, cu):
        raise HTTPException(403, "No access")
    rt_key = db.query(ReportType.key).filter(ReportType.id == src.report_type_id).scalar()
    if rt_key:
        _require_report_type_access(rt_key, db, cu)

    # Find 'My Reports' folder or create it
    my_folder = db.query(ReportFolder).filter(
        ReportFolder.name == "My Reports",
        ReportFolder.created_by == cu.id,
    ).first()
    if not my_folder:
        my_folder = ReportFolder(
            name="My Reports",
            visibility="private",
            is_system=False,
            created_by=cu.id,
        )
        db.add(my_folder)
        db.flush()

    clone = SavedReport(
        name=f"Copy of {src.name}",
        description=src.description,
        report_type_id=src.report_type_id,
        folder_id=my_folder.id,
        is_system=False,
        is_clone_of=src.id,
        config_json=src.config_json,
        chart_config_json=src.chart_config_json,
        created_by=cu.id,
        updated_by=cu.id,
    )
    db.add(clone)
    db.commit()
    db.refresh(clone)
    return {"id": clone.id, "name": clone.name}


@router.delete("/engine/saved/{report_id}", status_code=204)
def delete_saved_report(
    report_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if r.is_system:
        raise HTTPException(403, "System reports cannot be deleted")
    if not _can_edit_report(r, cu):
        raise HTTPException(403, "No access")
    r.is_active = False
    r.updated_by = cu.id
    db.commit()


# ---------------------------------------------------------------------------
# Visibility toggle  (replaces per-report ACL — uses existing role/scope system)
# ---------------------------------------------------------------------------

@router.patch("/engine/saved/{report_id}/visibility")
def set_report_visibility(
    report_id: int,
    body: SavedReportVisibility,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Toggle a saved report between private (creator only) and org (everyone with report access)."""
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if r.is_system:
        raise HTTPException(403, "System reports are always visible to all")
    if not _can_edit_report(r, cu):
        raise HTTPException(403, "Only the creator can change visibility")
    if body.visibility not in ("private", "org"):
        raise HTTPException(400, "visibility must be 'private' or 'org'")
    r.visibility = body.visibility
    r.updated_by = cu.id
    db.commit()
    return {"id": r.id, "visibility": r.visibility}


# ---------------------------------------------------------------------------
# Saved Filter Presets  (quick + advanced filters, distinct from SavedReport —
# lockedFilters from drilldown are never stored here; see SavedFilterCreate)
# ---------------------------------------------------------------------------

def _can_view_saved_filter(f: ReportSavedFilter, cu: User) -> bool:
    if str(cu.role).lower() in ("admin", "superadmin"):
        return True
    if f.created_by == cu.id:
        return True
    return f.visibility == "org"


def _can_edit_saved_filter(f: ReportSavedFilter, cu: User) -> bool:
    if str(cu.role).lower() in ("admin", "superadmin"):
        return True
    return f.created_by == cu.id


@router.get("/engine/saved-filters")
def list_saved_filters(
    report_type_key: str = Query(...),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Private filters created by the current user + org filters for this report type."""
    _require_report_type_access(report_type_key, db, cu)
    rows = (
        db.query(ReportSavedFilter)
        .filter(ReportSavedFilter.report_type_key == report_type_key)
        .filter((ReportSavedFilter.created_by == cu.id) | (ReportSavedFilter.visibility == "org"))
        .order_by(ReportSavedFilter.filter_name)
        .all()
    )
    return [
        {
            "id": f.id,
            "report_type_key": f.report_type_key,
            "filter_name": f.filter_name,
            "filter_type": f.filter_type,
            "visibility": f.visibility,
            "config_json": f.config_json,
            "created_by": f.created_by,
            "created_at": f.created_at.isoformat() if f.created_at else None,
            "can_edit": _can_edit_saved_filter(f, cu),
        }
        for f in rows
        if _can_view_saved_filter(f, cu)
    ]


@router.post("/engine/saved-filters", status_code=201)
def create_saved_filter(
    body: SavedFilterCreate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    _require_report_type_access(body.report_type_key, db, cu)
    if body.filter_type not in ("quick", "advanced", "mixed"):
        raise HTTPException(400, "filter_type must be 'quick', 'advanced', or 'mixed'")
    if body.visibility not in ("private", "org"):
        raise HTTPException(400, "visibility must be 'private' or 'org'")
    config_json = dict(body.config_json or {})
    config_json.pop("locked_filters", None)  # locked/drilldown filters are never part of a preset
    f = ReportSavedFilter(
        report_type_key=body.report_type_key,
        filter_name=body.filter_name,
        filter_type=body.filter_type,
        visibility=body.visibility,
        config_json=config_json,
        created_by=cu.id,
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id, "filter_name": f.filter_name}


@router.put("/engine/saved-filters/{filter_id}")
def update_saved_filter(
    filter_id: int,
    body: SavedFilterUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    f = db.query(ReportSavedFilter).filter(ReportSavedFilter.id == filter_id).first()
    if not f:
        raise HTTPException(404, "Saved filter not found")
    if not _can_edit_saved_filter(f, cu):
        raise HTTPException(403, "No edit access")
    if body.filter_name is not None:
        f.filter_name = body.filter_name
    if body.filter_type is not None:
        if body.filter_type not in ("quick", "advanced", "mixed"):
            raise HTTPException(400, "filter_type must be 'quick', 'advanced', or 'mixed'")
        f.filter_type = body.filter_type
    if body.visibility is not None:
        if body.visibility not in ("private", "org"):
            raise HTTPException(400, "visibility must be 'private' or 'org'")
        f.visibility = body.visibility
    if body.config_json is not None:
        config_json = dict(body.config_json)
        config_json.pop("locked_filters", None)
        f.config_json = config_json
    db.commit()
    return {"id": f.id, "filter_name": f.filter_name}


@router.delete("/engine/saved-filters/{filter_id}", status_code=204)
def delete_saved_filter(
    filter_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    f = db.query(ReportSavedFilter).filter(ReportSavedFilter.id == filter_id).first()
    if not f:
        raise HTTPException(404, "Saved filter not found")
    if not _can_edit_saved_filter(f, cu):
        raise HTTPException(403, "No access")
    db.delete(f)
    db.commit()


# ---------------------------------------------------------------------------
# Generic Report Runner  — POST /engine/run  and  POST /engine/saved/{id}/run
# ---------------------------------------------------------------------------

def _stamp_run(db: Session, report_id: int) -> None:
    """Atomically increment run_count and update last_run_at for a saved report."""
    db.execute(
        sa_update(SavedReport)
        .where(SavedReport.id == report_id)
        .values(
            run_count=SavedReport.run_count + 1,
            last_run_at=func.now(),
            last_accessed_at=func.now(),
        )
    )
    db.commit()


_QUESTIONNAIRE_USER_REPORT_TYPES = {
    "questionnaire_user",
    "questionnaire_role_user",
    "questionnaire_user_customer",
    "questionnaire_user_detail",
}

_QUESTIONNAIRE_SCOPE_FILTERS = {"section_id", "section_name", "subsection_id", "subsection_name"}
_QUESTIONNAIRE_CONTEXT_FILTERS = {
    "user_id",
    "user_name",
    "role_name",
    "customer_id",
    "customer_name",
    "category",
    "questionnaire_id",
    "questionnaire_name",
    "status",
    "last_activity_at",
}


def _as_number(value: Any) -> Optional[float]:
    try:
        if value is None or str(value).strip() == "":
            return None
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _dateish(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value or "")


def _matches_report_value(actual: Any, operator: str, expected: Any, data_type: str = "text") -> bool:
    if operator == "is_null":
        return actual is None or actual == ""
    if operator == "is_not_null":
        return actual is not None and actual != ""

    if operator in ("in", "not_in"):
        values = expected if isinstance(expected, list) else [expected]
        actual_s = "" if actual is None else str(actual)
        matched = any(actual_s == str(item) for item in values)
        return matched if operator == "in" else not matched

    if operator == "between":
        if not isinstance(expected, list) or len(expected) != 2:
            return True
        if data_type in ("number", "currency"):
            actual_n = _as_number(actual)
            lo = _as_number(expected[0])
            hi = _as_number(expected[1])
            if actual_n is None or lo is None or hi is None:
                return False
            return lo <= actual_n <= hi
        actual_s = _dateish(actual)[:19]
        if len(str(expected[0])) == 10 and len(str(expected[1])) == 10:
            actual_s = actual_s[:10]
        return str(expected[0]) <= actual_s <= str(expected[1])

    if data_type in ("number", "currency") or operator in ("gt", "gte", "lt", "lte"):
        actual_n = _as_number(actual)
        expected_n = _as_number(expected)
        if actual_n is None or expected_n is None:
            return False
        if operator == "eq":
            return actual_n == expected_n
        if operator == "neq":
            return actual_n != expected_n
        if operator == "gt":
            return actual_n > expected_n
        if operator == "gte":
            return actual_n >= expected_n
        if operator == "lt":
            return actual_n < expected_n
        if operator == "lte":
            return actual_n <= expected_n

    if data_type in ("date", "datetime"):
        actual_s = _dateish(actual)[:19]
        expected_s = str(expected or "")
        if len(expected_s) == 10:
            actual_s = actual_s[:10]
        if operator == "eq":
            return actual_s == expected_s
        if operator == "neq":
            return actual_s != expected_s
        if operator == "gt":
            return actual_s > expected_s
        if operator == "gte":
            return actual_s >= expected_s
        if operator == "lt":
            return actual_s < expected_s
        if operator == "lte":
            return actual_s <= expected_s

    actual_s = "" if actual is None else str(actual)
    expected_s = "" if expected is None else str(expected)
    if operator == "eq":
        return actual_s == expected_s
    if operator == "neq":
        return actual_s != expected_s
    if operator == "contains":
        return expected_s.lower() in actual_s.lower()
    if operator == "starts_with":
        return actual_s.lower().startswith(expected_s.lower())
    return True


def _last_activity(cq: CustomerQuestionnaire) -> Optional[datetime]:
    return cq.last_saved_at or cq.completed_at or cq.started_at or cq.created_at


def _serialize_report_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _latest_assignment_map(db: Session, customer_ids: list[int]) -> dict[int, int]:
    if not customer_ids:
        return {}
    out: dict[int, int] = {}
    try:
        rows = (
            db.query(SalesCustomerAssignment)
            .filter(
                SalesCustomerAssignment.customer_id.in_(customer_ids),
                SalesCustomerAssignment.is_active == True,
            )
            .order_by(
                SalesCustomerAssignment.customer_id,
                SalesCustomerAssignment.updated_at.desc(),
                SalesCustomerAssignment.id.desc(),
            )
            .all()
        )
        for row in rows:
            out.setdefault(int(row.customer_id), int(row.user_id))
    except Exception:
        db.rollback()
    return out


def _questionnaire_filter_type(field_key: str) -> str:
    cfg = REPORT_ENGINE_CONFIG.get("questionnaire_user", {})
    filter_info = cfg.get("filter_fields", {}).get(field_key)
    if filter_info:
        return _cfg_filter_info(filter_info)[1]
    if field_key.endswith("_id") or field_key in {"user_id", "customers", "questions", "answered", "pending", "completed", "in_progress", "completion_pct", "avg_rating"}:
        return "number"
    if field_key.endswith("_at"):
        return "datetime"
    return "text"


def _questionnaire_structure_names(structures: dict[int, QuestionnaireStructure], element: QuestionnaireFormElement) -> tuple[str, str]:
    section_name = structures.get(int(element.section_id)).structure_name if element.section_id and int(element.section_id) in structures else ""
    subsection_name = structures.get(int(element.subsection_id)).structure_name if element.subsection_id and int(element.subsection_id) in structures else ""
    return section_name, subsection_name


def _questionnaire_element_matches_scope(
    element: QuestionnaireFormElement,
    filters: list[dict[str, Any]],
    structures: dict[int, QuestionnaireStructure],
) -> bool:
    if not filters:
        return True
    section_name, subsection_name = _questionnaire_structure_names(structures, element)
    values = {
        "section_id": element.section_id,
        "section_name": section_name,
        "subsection_id": element.subsection_id,
        "subsection_name": subsection_name,
    }
    return all(
        _matches_report_value(values.get(flt["field"]), flt.get("operator", "eq"), flt.get("value"), _questionnaire_filter_type(flt["field"]))
        for flt in filters
        if flt.get("field") in _QUESTIONNAIRE_SCOPE_FILTERS
    )


def _questionnaire_answers_match(
    answers: list[CustomerQuestionnaireAnswer],
    filters: list[dict[str, Any]],
    scoped_element_ids: set[int],
) -> bool:
    answer_filters = [flt for flt in filters if flt.get("field") == "answer_value"]
    if not answer_filters:
        return True
    for answer in answers:
        if int(answer.element_id) not in scoped_element_ids:
            continue
        if all(
            _matches_report_value(answer.answer_value, flt.get("operator", "eq"), flt.get("value"), "text")
            for flt in answer_filters
        ):
            return True
    return False


def _questionnaire_context_matches(
    values: dict[str, Any],
    filters: list[dict[str, Any]],
    *,
    skip_answer: bool = True,
) -> bool:
    for flt in filters:
        field = flt.get("field")
        if field in _QUESTIONNAIRE_SCOPE_FILTERS:
            continue
        if skip_answer and field == "answer_value":
            continue
        if field not in values:
            continue
        if not _matches_report_value(values.get(field), flt.get("operator", "eq"), flt.get("value"), _questionnaire_filter_type(str(field))):
            return False
    return True


def _collect_questionnaire_user_contexts(config: dict, cu: User, db: Session) -> list[dict[str, Any]]:
    from app.routers.questionnaire_router import (
        _answer_values_have_any,
        _normalized_questionnaire_status,
        _question_progress_counts,
    )

    filters = config.get("filters") or []

    query = (
        db.query(CustomerQuestionnaire, Customer, Questionnaire)
        .join(Customer, Customer.id == CustomerQuestionnaire.customer_id)
        .join(Questionnaire, Questionnaire.id == CustomerQuestionnaire.questionnaire_id)
        .filter(Customer.is_deleted == False)
    )
    query = apply_data_scope(db, query, cu, "questionnaire", Customer.created_by, Customer.assigned_to)
    rows = query.all()
    if not rows:
        return []

    customer_ids = [int(customer.id) for _, customer, _ in rows]
    cq_ids = [int(cq.id) for cq, _, _ in rows]
    questionnaire_ids = sorted({int(qn.id) for _, _, qn in rows})

    assignment_by_customer = _latest_assignment_map(db, customer_ids)
    owner_ids = {
        assignment_by_customer.get(int(customer.id)) or (int(customer.assigned_to) if customer.assigned_to else None)
        for _, customer, _ in rows
    }
    owner_ids.discard(None)
    users_by_id: dict[int, User] = {}
    if owner_ids:
        users_by_id = {int(user.id): user for user in db.query(User).filter(User.id.in_(owner_ids)).all()}

    role_names = {
        role.name: role.display_name
        for role in db.query(Role).filter(Role.is_active == True).all()
    }

    elements_by_questionnaire: dict[int, list[QuestionnaireFormElement]] = {qid: [] for qid in questionnaire_ids}
    if questionnaire_ids:
        for element in (
            db.query(QuestionnaireFormElement)
            .filter(
                QuestionnaireFormElement.questionnaire_id.in_(questionnaire_ids),
                QuestionnaireFormElement.is_active == True,
            )
            .order_by(
                QuestionnaireFormElement.questionnaire_id,
                QuestionnaireFormElement.section_id,
                QuestionnaireFormElement.subsection_id,
                QuestionnaireFormElement.display_order,
                QuestionnaireFormElement.id,
            )
            .all()
        ):
            elements_by_questionnaire.setdefault(int(element.questionnaire_id), []).append(element)

    structure_ids = {
        int(element.section_id)
        for elements in elements_by_questionnaire.values()
        for element in elements
        if element.section_id
    } | {
        int(element.subsection_id)
        for elements in elements_by_questionnaire.values()
        for element in elements
        if element.subsection_id
    }
    structures_by_id: dict[int, QuestionnaireStructure] = {}
    if structure_ids:
        structures_by_id = {
            int(item.id): item
            for item in db.query(QuestionnaireStructure).filter(QuestionnaireStructure.id.in_(structure_ids)).all()
        }

    answers_by_cq: dict[int, list[CustomerQuestionnaireAnswer]] = {cq_id: [] for cq_id in cq_ids}
    if cq_ids:
        for answer in (
            db.query(CustomerQuestionnaireAnswer)
            .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id.in_(cq_ids))
            .all()
        ):
            answers_by_cq.setdefault(int(answer.customer_questionnaire_id), []).append(answer)

    contexts: list[dict[str, Any]] = []
    for cq, customer, questionnaire in rows:
        owner_id = assignment_by_customer.get(int(customer.id)) or (int(customer.assigned_to) if customer.assigned_to else None)
        owner = users_by_id.get(owner_id) if owner_id else None
        user_name = owner.full_name if owner else "Unassigned"
        role_key = owner.role if owner else None
        role_name = role_names.get(role_key or "", role_key or "Unassigned")

        all_elements = elements_by_questionnaire.get(int(questionnaire.id), [])
        scoped_elements = [
            element for element in all_elements
            if _questionnaire_element_matches_scope(element, filters, structures_by_id)
        ]
        scoped_question_count = sum(1 for element in scoped_elements if element.element_type == "question")
        if any(flt.get("field") in _QUESTIONNAIRE_SCOPE_FILTERS for flt in filters) and scoped_question_count == 0:
            continue

        answers = answers_by_cq.get(int(cq.id), [])
        answer_values = {int(answer.element_id): answer.answer_value for answer in answers}
        scoped_element_ids = {int(element.id) for element in scoped_elements}
        if not _questionnaire_answers_match(answers, filters, scoped_element_ids):
            continue

        total, completed, percentage = _question_progress_counts(scoped_elements, answer_values)
        scoped_answer_values = {
            element_id: value for element_id, value in answer_values.items()
            if element_id in scoped_element_ids
        }
        answered_any = _answer_values_have_any(scoped_answer_values)
        status = _normalized_questionnaire_status(cq.status, total, completed, answered_any)
        last_activity = _last_activity(cq)

        rating_values = []
        element_by_id = {int(element.id): element for element in all_elements}
        for answer in answers:
            element = element_by_id.get(int(answer.element_id))
            if not element or element.input_type != "rating" or int(element.id) not in scoped_element_ids:
                continue
            numeric = _as_number(answer.answer_value)
            if numeric is not None:
                rating_values.append(numeric)

        context_values = {
            "user_id": owner_id,
            "user_name": user_name,
            "role_name": role_name,
            "customer_id": int(customer.id),
            "customer_name": customer.customer_name,
            "category": customer.customer_vertical,
            "questionnaire_id": int(questionnaire.id),
            "questionnaire_name": questionnaire.questionnaire_name,
            "status": status,
            "last_activity_at": last_activity,
        }
        if not _questionnaire_context_matches(context_values, filters):
            continue

        if config.get("date_from") and not _matches_report_value(last_activity, "gte", config["date_from"], "datetime"):
            continue
        if config.get("date_to") and not _matches_report_value(last_activity, "lte", config["date_to"], "datetime"):
            continue

        contexts.append({
            **context_values,
            "cq": cq,
            "customer": customer,
            "questionnaire": questionnaire,
            "elements": all_elements,
            "scoped_elements": scoped_elements,
            "structures": structures_by_id,
            "answers": answers,
            "answer_values": answer_values,
            "total_questions": total,
            "completed_questions": completed,
            "pending_questions": max(0, total - completed),
            "completion_pct": round((completed * 100.0 / total), 1) if total else 0,
            "rating_values": rating_values,
        })

    return contexts


def _questionnaire_completed_customer_count(customer_progress: dict[Any, dict[str, int]]) -> int:
    return sum(
        1
        for progress in customer_progress.values()
        if int(progress.get("questions") or 0) > 0
        and int(progress.get("answered") or 0) >= int(progress.get("questions") or 0)
    )


def _questionnaire_role_summary_rows(contexts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for ctx in contexts:
        role_name = ctx.get("role_name") or "Unassigned"
        row = grouped.setdefault(str(role_name), {
            "role_name": role_name,
            "user_ids": set(),
            "customer_ids": set(),
            "customers": 0,
            "users": 0,
            "questions": 0,
            "answered": 0,
            "pending": 0,
            "completed": 0,
            "in_progress": 0,
            "completed_customers": 0,
            "completion_pct": 0,
            "avg_rating": None,
            "last_activity_at": None,
            "_ratings": [],
            "_customer_progress": {},
        })
        user_key = ctx.get("user_id") or f"unassigned:{ctx.get('user_name') or 'Unassigned'}"
        customer_id = ctx.get("customer_id")
        row["user_ids"].add(user_key)
        row["customer_ids"].add(customer_id)
        row["questions"] += int(ctx["total_questions"] or 0)
        row["answered"] += int(ctx["completed_questions"] or 0)
        row["pending"] += int(ctx["pending_questions"] or 0)
        if ctx["status"] == "completed":
            row["completed"] += 1
        elif ctx["status"] in ("in_progress", "reopened"):
            row["in_progress"] += 1
        row["_ratings"].extend(ctx.get("rating_values") or [])
        progress = row["_customer_progress"].setdefault(customer_id, {"questions": 0, "answered": 0})
        progress["questions"] += int(ctx["total_questions"] or 0)
        progress["answered"] += int(ctx["completed_questions"] or 0)
        if not row["last_activity_at"] or (ctx.get("last_activity_at") and ctx["last_activity_at"] > row["last_activity_at"]):
            row["last_activity_at"] = ctx.get("last_activity_at")

    rows: list[dict[str, Any]] = []
    for row in grouped.values():
        row["users"] = len(row.pop("user_ids"))
        row["customers"] = len(row.pop("customer_ids"))
        ratings = row.pop("_ratings")
        row["completed_customers"] = _questionnaire_completed_customer_count(row.pop("_customer_progress"))
        row["completion_pct"] = round(row["answered"] * 100.0 / row["questions"], 1) if row["questions"] else 0
        row["avg_rating"] = round(sum(ratings) / len(ratings), 1) if ratings else None
        rows.append(row)
    return rows


def _questionnaire_user_summary_rows(contexts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for ctx in contexts:
        key = str(ctx.get("user_id") or "unassigned")
        row = grouped.setdefault(key, {
            "user_id": ctx.get("user_id"),
            "user_name": ctx.get("user_name") or "Unassigned",
            "role_name": ctx.get("role_name") or "Unassigned",
            "customer_ids": set(),
            "customers": 0,
            "questions": 0,
            "answered": 0,
            "pending": 0,
            "completed": 0,
            "in_progress": 0,
            "completed_customers": 0,
            "completion_pct": 0,
            "avg_rating": None,
            "last_activity_at": None,
            "_ratings": [],
            "_customer_progress": {},
        })
        row["customer_ids"].add(ctx["customer_id"])
        row["questions"] += int(ctx["total_questions"] or 0)
        row["answered"] += int(ctx["completed_questions"] or 0)
        row["pending"] += int(ctx["pending_questions"] or 0)
        if ctx["status"] == "completed":
            row["completed"] += 1
        elif ctx["status"] in ("in_progress", "reopened"):
            row["in_progress"] += 1
        row["_ratings"].extend(ctx.get("rating_values") or [])
        progress = row["_customer_progress"].setdefault(ctx["customer_id"], {"questions": 0, "answered": 0})
        progress["questions"] += int(ctx["total_questions"] or 0)
        progress["answered"] += int(ctx["completed_questions"] or 0)
        if not row["last_activity_at"] or (ctx.get("last_activity_at") and ctx["last_activity_at"] > row["last_activity_at"]):
            row["last_activity_at"] = ctx.get("last_activity_at")

    rows: list[dict[str, Any]] = []
    for row in grouped.values():
        row["customers"] = len(row.pop("customer_ids"))
        ratings = row.pop("_ratings")
        row["completed_customers"] = _questionnaire_completed_customer_count(row.pop("_customer_progress"))
        row["completion_pct"] = round(row["answered"] * 100.0 / row["questions"], 1) if row["questions"] else 0
        row["avg_rating"] = round(sum(ratings) / len(ratings), 1) if ratings else None
        rows.append(row)
    return rows


def _questionnaire_user_customer_rows(contexts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for ctx in contexts:
        ratings = ctx.get("rating_values") or []
        rows.append({
            "id": int(ctx["cq"].id),
            "user_id": ctx.get("user_id"),
            "user_name": ctx.get("user_name"),
            "role_name": ctx.get("role_name"),
            "customer_id": ctx.get("customer_id"),
            "customer_name": ctx.get("customer_name"),
            "category": ctx.get("category"),
            "questionnaire_id": ctx.get("questionnaire_id"),
            "questionnaire_name": ctx.get("questionnaire_name"),
            "status": ctx.get("status"),
            "questions": int(ctx.get("total_questions") or 0),
            "answered": int(ctx.get("completed_questions") or 0),
            "pending": int(ctx.get("pending_questions") or 0),
            "completion_pct": ctx.get("completion_pct"),
            "avg_rating": round(sum(ratings) / len(ratings), 1) if ratings else None,
            "last_activity_at": ctx.get("last_activity_at"),
        })
    return rows


def _questionnaire_user_detail_rows(db: Session, contexts: list[dict[str, Any]], filters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from app.routers.questionnaire_router import _visible_fields_by_question_for_answers

    answer_filters = [flt for flt in filters if flt.get("field") == "answer_value"]
    rows: list[dict[str, Any]] = []

    for ctx in contexts:
        structures = ctx["structures"]
        elements: list[QuestionnaireFormElement] = ctx["elements"]
        scoped_ids = {int(element.id) for element in ctx["scoped_elements"]}
        element_by_id = {int(element.id): element for element in elements}
        answers_by_element = {int(answer.element_id): answer for answer in ctx["answers"]}
        visible_by_question = _visible_fields_by_question_for_answers(elements, ctx["answer_values"])

        questions = [
            element for element in ctx["scoped_elements"]
            if element.element_type == "question"
        ]
        questions.sort(key=lambda item: (
            int(item.section_id or 0),
            int(item.subsection_id or 0),
            int(item.display_order or 0),
            int(item.id),
        ))

        def append_element_row(question: QuestionnaireFormElement, element: QuestionnaireFormElement, row_type: str) -> None:
            answer = answers_by_element.get(int(element.id))
            answer_value = answer.answer_value if answer else None
            if answer_filters and not all(
                _matches_report_value(answer_value, flt.get("operator", "eq"), flt.get("value"), "text")
                for flt in answer_filters
            ):
                return
            section_name, subsection_name = _questionnaire_structure_names(structures, element)
            answered_user = None
            if answer and answer.answered_by:
                answered_user = answer.answered_by
            detail_row = {
                "id": f"{ctx['cq'].id}:{element.id}:{row_type}",
                "user_id": ctx.get("user_id"),
                "user_name": ctx.get("user_name"),
                "role_name": ctx.get("role_name"),
                "customer_id": ctx.get("customer_id"),
                "customer_name": ctx.get("customer_name"),
                "category": ctx.get("category"),
                "questionnaire_id": ctx.get("questionnaire_id"),
                "questionnaire_name": ctx.get("questionnaire_name"),
                "section_id": element.section_id,
                "section_name": section_name,
                "subsection_id": element.subsection_id,
                "subsection_name": subsection_name,
                "question_id": int(question.id),
                "question_code": question.element_code,
                "question_label": question.element_label,
                "field_id": int(element.id) if row_type == "field" else None,
                "field_label": element.element_label if row_type == "field" else "",
                "element_type": row_type,
                "input_type": element.input_type,
                "answer_value": answer_value,
                "remarks": answer.remarks if answer else None,
                "answered_by_name": None,
                "answered_by": answered_user,
                "answered_at": answer.answered_at if answer else None,
                "status": ctx.get("status"),
                "completion_pct": ctx.get("completion_pct"),
            }
            if not _questionnaire_context_matches(detail_row, filters, skip_answer=False):
                return
            rows.append(detail_row)

        for question in questions:
            append_element_row(question, question, "question")
            fields = [
                field for field in visible_by_question.get(int(question.id), [])
                if int(field.id) in scoped_ids and element_by_id.get(int(field.id))
            ]
            fields.sort(key=lambda item: (int(item.display_order or 0), int(item.id)))
            for field in fields:
                append_element_row(question, field, "field")

    answered_user_ids = {
        int(row["answered_by"])
        for row in rows
        if row.get("answered_by")
    }
    names_by_id: dict[int, str] = {}
    if answered_user_ids:
        names_by_id = {
            int(user.id): user.full_name
            for user in db.query(User).filter(User.id.in_(answered_user_ids)).all()
        }
    for row in rows:
        if row.get("answered_by"):
            row["answered_by_name"] = names_by_id.get(int(row["answered_by"]))
        row.pop("answered_by", None)
    return rows


def _sort_questionnaire_rows(rows: list[dict[str, Any]], config: dict, default_field: str) -> list[dict[str, Any]]:
    sort_items = config.get("sort") or []
    if not sort_items:
        sort_items = [{"field": default_field, "direction": "asc"}]

    sorted_rows = list(rows)
    for item in reversed(sort_items):
        field = item.get("field") or default_field
        reverse = str(item.get("direction", "asc")).lower() == "desc"
        sorted_rows.sort(
            key=lambda row: (
                row.get(field) is None,
                str(row.get(field)).lower() if not isinstance(row.get(field), (int, float)) else row.get(field),
            ),
            reverse=reverse,
        )
    return sorted_rows


def _questionnaire_stream_csv(rt_key: str, rows: list[dict[str, Any]], visible_fields: list[str]) -> StreamingResponse:
    def _gen():
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=visible_fields, extrasaction="ignore")
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate()
        for row in rows:
            writer.writerow({key: _serialize_report_value(value) for key, value in row.items()})
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()

    return StreamingResponse(
        _gen(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{rt_key}_report.csv"'},
    )


def _run_questionnaire_user_report(
    rt_key: str,
    config: dict,
    cu: User,
    db: Session,
    export_fmt: Optional[str] = None,
) -> Any:
    _require_report_type_access(rt_key, db, cu)
    if export_fmt and export_fmt != "csv":
        raise HTTPException(400, "Only CSV export is currently supported")

    config = _sanitize_report_config(rt_key, config, db)
    contexts = _collect_questionnaire_user_contexts(config, cu, db)

    if rt_key == "questionnaire_user":
        all_rows = _questionnaire_role_summary_rows(contexts)
        default_sort = "role_name"
    elif rt_key == "questionnaire_role_user":
        all_rows = _questionnaire_user_summary_rows(contexts)
        default_sort = "user_name"
    elif rt_key == "questionnaire_user_customer":
        all_rows = _questionnaire_user_customer_rows(contexts)
        default_sort = "customer_name"
    else:
        all_rows = _questionnaire_user_detail_rows(db, contexts, config.get("filters") or [])
        default_sort = "customer_name"

    sorted_rows = _sort_questionnaire_rows(all_rows, config, default_sort)
    visible_fields = config.get("fields") or list(REPORT_ENGINE_CONFIG[rt_key].get("fields", {}).keys())

    if export_fmt == "csv":
        return _questionnaire_stream_csv(rt_key, sorted_rows, visible_fields)

    page = max(1, int(config.get("page", 1)))
    per_page = min(500, max(1, int(config.get("per_page", 50))))
    start = (page - 1) * per_page
    paged_rows = sorted_rows[start:start + per_page]

    return {
        "report_type": rt_key,
        "total": len(sorted_rows),
        "page": page,
        "per_page": per_page,
        "pages": (len(sorted_rows) + per_page - 1) // per_page if per_page else 1,
        "columns": visible_fields,
        "rows": [
            {key: _serialize_report_value(value) for key, value in row.items()}
            for row in paged_rows
        ],
    }


def _run_report(
    rt_key: str,
    config: dict,
    cu: User,
    db: Session,
    export_fmt: Optional[str] = None,
) -> Any:
    """Execute a report query and return rows + metadata, or a StreamingResponse for export."""
    _require_report_type_access(rt_key, db, cu)
    if rt_key in _QUESTIONNAIRE_USER_REPORT_TYPES:
        return _run_questionnaire_user_report(rt_key, config, cu, db, export_fmt=export_fmt)
    if export_fmt and export_fmt != "csv":
        raise HTTPException(400, "Only CSV export is currently supported")
    config = _sanitize_report_config(rt_key, config, db)

    # --- count ---
    count_sql, count_params, _ = _build_report_sql(rt_key, config, cu, db, count_only=True)
    total_row = db.execute(text(count_sql), count_params).fetchone()
    total = int(total_row[0]) if total_row else 0

    if export_fmt:
        data_sql, data_params, visible_fields = _build_report_sql(rt_key, config, cu, db, export=True)
    else:
        data_sql, data_params, visible_fields = _build_report_sql(rt_key, config, cu, db)

    result_proxy = db.execute(text(data_sql), data_params)
    col_names = list(result_proxy.keys())  # includes hidden drilldown-ID columns, if any
    rows_raw   = result_proxy.fetchall()

    def _serialize(v: Any) -> Any:
        if isinstance(v, (datetime, date)):
            return v.isoformat()
        return v

    rows = [dict(zip(col_names, [_serialize(c) for c in row])) for row in rows_raw]

    if export_fmt == "csv":
        def _gen():
            buf = io.StringIO()
            # extrasaction='ignore' drops any hidden drilldown-ID columns from the export —
            # only fields explicitly selected as visible columns are written.
            writer = csv.DictWriter(buf, fieldnames=visible_fields, extrasaction='ignore')
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        return StreamingResponse(
            _gen(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{rt_key}_report.csv"'},
        )

    page     = max(1, int(config.get("page", 1)))
    per_page = min(500, max(1, int(config.get("per_page", 50))))

    return {
        "report_type": rt_key,
        "total":       total,
        "page":        page,
        "per_page":    per_page,
        "pages":       (total + per_page - 1) // per_page if per_page else 1,
        "columns":     visible_fields,  # hidden drilldown-ID fields stay in `rows` only
        "rows":        rows,
    }


@router.post("/engine/run")
def run_report_adhoc(
    body: ReportRunRequest,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Ad-hoc report run — supply report_type + config inline. No save required."""
    rt_key = body.report_type_key or body.report_type
    if not rt_key:
        raise HTTPException(400, "report_type_key is required")
    config = {
        "report_type_key": rt_key,
        "template_key": body.template_key,
        "primary_module": body.primary_module,
        "related_modules": body.related_modules,
        "parent_module": body.parent_module,
        "module_chain": body.module_chain,
        "child_modules": body.child_modules,
        "fields":    body.fields if body.fields else None,
        "filters":   [f.model_dump() for f in body.filters] if body.filters else [],
        "sort":      [s.model_dump() for s in body.sort] if body.sort else [],
        "date_from": body.date_from,
        "date_to":   body.date_to,
        "page":      body.page,
        "per_page":  body.per_page,
    }
    return _run_report(rt_key, config, cu, db, export_fmt=body.export)

@router.post("/engine/saved/{report_id}/run")
def run_saved_report(
    report_id: int,
    page:     int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=500),
    export:   Optional[str] = Query(default=None),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Run a saved report. Uses the report's stored config_json."""
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if not _can_view_report(r, cu):
        raise HTTPException(403, "No access")

    rt_key = db.query(ReportType.key).filter(ReportType.id == r.report_type_id).scalar()
    if not rt_key:
        raise HTTPException(400, "Report has no report type configured")

    config = _saved_report_config_for_runtime(r, rt_key)
    config["page"]     = page
    config["per_page"] = per_page

    result = _run_report(rt_key, config, cu, db, export_fmt=export)
    # Stamp audit fields after a successful run (skip for exports — they get their own stamp)
    if not export:
        _stamp_run(db, report_id)
    return result


@router.post("/engine/saved/{report_id}/export")
def export_saved_report(
    report_id: int,
    request: Request,
    fmt: str = Query(default="csv", pattern="^(csv|xlsx)$"),
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(_require_engine_access),
):
    """Export a saved report to CSV (xlsx support can be added)."""
    r = db.query(SavedReport).filter(SavedReport.id == report_id, SavedReport.is_active == True).first()
    if not r:
        raise HTTPException(404, "Report not found")
    if not _can_view_report(r, cu):
        raise HTTPException(403, "No access")

    rt_key = db.query(ReportType.key).filter(ReportType.id == r.report_type_id).scalar()
    config = _saved_report_config_for_runtime(r, rt_key)
    result = _run_report(rt_key, config, cu, db, export_fmt=fmt)
    log_module_action(
        db=db, user_id=cu.id, module="reports", action="export",
        record_id=r.id, record_name=r.name, ip=get_request_ip(request),
        new_data={"format": fmt},
    )
    _stamp_run(db, report_id)
    return result
