# ASCENT CRM

## Application Workflow and Functional Process Document

**Document Version:** 1.0
**Prepared By:** Project Team
**Prepared Date:** 20 July 2026
**Reviewed By:**
**Approved By:**
**Application:** Ascent CRM (AzcentrixConnect) — SaaS, multi-tenant

---

## Document Control

| Version | Date         | Prepared By  | Description                                                  | Approved By |
| ------- | ------------ | ------------ | -------------------------------------------------------------- | ----------- |
| 1.0     | 20 July 2026 | Project Team | Initial CRM workflow documentation, adapted to actual codebase | Pending     |

---

## 1. Purpose of the Document

This document describes the complete functional workflow of the **Ascent CRM** application, as actually built in this codebase — not a generic CRM template.

It explains how platform operators, tenant administrators, sales teams, tender teams, finance/accounts users and management interact with the system from tenant provisioning through customer management, lead generation, quotations, tenders, work orders, EMD/BG tracking, KAM activities, travel claims, reports and analytical dashboards.

The document is intended for:

* Business users
* CRM administrators
* Sales and tender teams
* Finance/accounts users
* Management users
* Development and testing teams
* Implementation and support teams

> **Note on scope accuracy:** This version removes or renames sections from a generic CRM template that do not match this application (e.g. there is no standalone Invoice or Payment module, and "Opportunity" is a lead stage, not a separate record type). See §3 for a summary of what was removed/renamed.

---

## 2. Scope

This document covers the functional areas that actually exist in Ascent CRM:

1. Platform Administration (multi-tenant SaaS console)
2. Administration and Settings (per tenant)
3. Users, Roles and Permissions
4. Organization, Teams and Masters
5. Customer Management (incl. Customer 360)
6. Lead Management (incl. the Opportunity stage)
7. Quotation Management
8. Tender Management
9. EMD / Bank Guarantee Management
10. Work Order Management (incl. invoices raised against a work order)
11. KAM 360 (Key Account Management)
12. Travel Management (TA/DA claims)
13. RFP Analysis (AI-assisted tender document extraction)
14. Approval Workflows
15. Notifications and Alerts
16. Report Engine (custom/ad-hoc reports)
17. Analytical Reports (fixed dashboards)
18. Module Label Customization
19. Audit History
20. AI Insights

### What this document deliberately does **not** include (present in generic CRM templates but not in this app)

| Not in this app | Why it's removed here |
| ---- | ---- |
| Standalone Invoice Management module | Invoices exist only as line records under a Work Order (`WOInvoice`) |
| Standalone Payment Tracking module | Payment status is tracked inside Work Order invoices and inside EMD/BG records — there is no separate Payments module |
| A distinct "Opportunity" record/table | "Opportunity Created" is a **status** on a Lead, not a separate entity — see §6 |
| Department-level data scope | Data-visibility scope options are **Own / Team / All / None** only — there is no separate "Department" scope |
| Configurable approval on a specific field (e.g. "discount %") | Approval rules are configured per (module, action) pair (e.g. "Quotation → Submit for Approval"), not per field/threshold |

---

## 3. Ascent CRM Application Workflow Overview

The CRM sits on top of a multi-tenant SaaS platform. Before any tenant's business users can log in, a **Platform Super Admin** provisions the tenant; only then does the familiar Administration → Business Operations flow begin.

**Platform Administration (SaaS Super Admin)**

↓

**Tenant Provisioning (company, plan, feature matrix)**

↓

**Administration and Settings (tenant admin)**

↓

**Users, Roles and Permissions**

↓

**Organization, Teams and Masters**

↓

**Customer and Contact Management**

↓

**Lead Management (Assigned → Qualified → Opportunity Created)**

↓

**Quotation and/or Tender Process**

↓

**Work Order and Execution (incl. invoicing)**

↓

**EMD / BG Lifecycle Tracking**

↓

**KAM 360, Travel Claims and Customer Follow-up**

↓

**Reports, Analytical Dashboards and Management Review**

---

## 4. Platform Administration (SaaS Super Admin)

### 4.1 Purpose

Ascent CRM is multi-tenant: every company using the product is a separate **tenant** with its own isolated database. Before a tenant's administrator can do anything, a **Platform Super Admin** — a role entirely separate from any in-tenant role — must create and configure that tenant from a dedicated Platform console (separate login at `/platform/login`, not the regular app login).

[SCREENSHOT: Platform Super Admin login page]

### 4.2 Platform Capabilities

| Area | What it does |
| ---- | ---- |
| Tenants | Create / list / update / suspend / reactivate a tenant; force-logout all of a tenant's active sessions; test a tenant's SMTP email config; view storage usage vs. limit; run a DB health check; export/backup a tenant's full SQL data |
| Plans | Define subscription plans with monthly/yearly pricing and a max-user cap |
| Feature Matrix | Toggle which modules/dashboard tabs/report tabs are enabled — per plan, or overridden per individual tenant. This is what actually decides which sidebar modules and permissions get seeded into a tenant's database |
| Platform Audit Log | Every platform-admin action (tenant create/update/suspend, feature changes, backups) is recorded separately from each tenant's own audit log |

[SCREENSHOT: Platform tenant list / feature matrix page]

### 4.3 Tenant Provisioning Workflow

**Super Admin clicks "New Tenant"**

↓

**Enters company name, code, plan**

↓

**System creates isolated tenant database**

↓

**System auto-seeds:** one Administrator user, one `admin` role with full permissions, default lead sources (GEM Portal, E-Procurement, Direct Enquiry, OEM Reference, Website, Referral), and default system reports

↓

**Feature matrix from the assigned plan determines which modules are visible to the tenant**

↓

**Tenant Administrator receives login and begins in-tenant Administration (§5)**

---

## 5. Administration and Settings (Per Tenant)

### 5.1 Purpose

Once a tenant exists, its own administrator configures the application before regular business users start working in it: users, roles, permissions, masters, approval rules, notifications and module labels.

### 5.2 Administration Configuration Order

**User Creation**

↓

**Role Creation (custom roles, beyond the auto-seeded `admin`)**

↓

**Permission Assignment (per module: view / create / update / delete / export / manage, plus a data scope)**

↓

**Master Data Configuration**

↓

**Approval Workflow Configuration**

↓

**Notification Configuration**

↓

**Module Label Configuration (optional — rename modules to match the org's terminology)**

↓

**Application Ready for Business Users**

[SCREENSHOT: Settings landing page]

### 5.3 Administration Actors

| Role | Responsibility |
| ---- | ---- |
| Platform Super Admin | Provisions and manages tenants at the SaaS level (§4) — not part of any tenant |
| Administrator (`admin`) | The only role auto-seeded per tenant; full permissions across every module |
| CEO / VP / Manager (a.k.a. "Sales Head") / Sales / Accounts / Support | Common role **names** used by convention across the app's approval and dashboard logic — these are not auto-created; the tenant admin creates them (or equivalents) via the Roles screen and assigns permissions/scope as needed |

> Unlike a generic template, only **one** role ("Administrator") is created automatically. Every other role is a tenant admin's own configuration, though the approval engine and dashboards recognize the conventional names `sales`, `manager`, `vp`, `ceo`, `accounts`, `support` if used.

### 5.4 Role & Permission Model

* Permissions are keyed as `<module>.<action>`, e.g. `customers.view`, `customers.create`, `customers.update`, `customers.delete`, `quotations.export`, `roles.manage`, `users.manage`, `settings.manage`, `modules.rename`, `form_builder.manage`.
* Core actions used across modules: **View, Create, Update, Delete**; a few modules add **Export** or **Manage**.
* Every module permission also carries a **data scope**:

| Scope | Meaning |
| ---- | ---- |
| Own | Only records the user created/is assigned |
| Team | Records visible to the user's reporting hierarchy/org-tree team |
| All | No visibility restriction |
| None | Module hidden / no records returned |

[SCREENSHOT: Roles & Permissions matrix screen]

### 5.5 Master Data (Configuration section)

Manageable via the Masters screen:

* Lead Sources
* Lead Categories
* Lead Sub Categories
* Products
* Locations (Region → State → District, plus pincode lookup)
* Customer Segments (internally: Vertical Sectors / Sub-Sectors)
* Groups (org-tree grouping)
* Business Verticals

OEMs and Competitors are managed as their own top-level sidebar modules rather than as Masters tabs.

[SCREENSHOT: Masters page — Lead Sources tab]

### 5.6 Module Label Customization

Any module's sidebar label (and its singular form) can be renamed tenant-wide — e.g. "Leads" → "Enquiries" — by double-clicking the label in the sidebar (for users holding `modules.rename` or `settings.manage`). The change is saved for the whole tenant, not just the editing user, and is cached locally for instant repaint.

[SCREENSHOT: Sidebar with an inline label being edited]

### 5.7 Administration Business Rules

* Only users with the relevant `*.manage` permission can access Administration screens.
* A user must have at least one active role to log in.
* Inactive users cannot log in.
* Data-scope changes apply on next login/token refresh.
* Tenant users only ever see their own tenant's data — enforced at the database level (separate DB per tenant).

---

## 6. Customer Management

### 6.1 Overview

Customers are account records with billing/shipping details, consignees and zones. Unlike Leads/Tenders/Work Orders, a **Customer has no pipeline/status stage** — it's the base account entity that Leads, Quotations, Tenders and Work Orders all attach to.

### 6.2 Customer 360

Every customer has a detailed **Customer 360** view aggregating:

* Lead pipeline for that customer
* Tender pipeline
* Work orders
* Payments — billed / collected / pending / overdue (drawn from Work Order invoices, since there is no separate Payments module)
* Products supplied / demanded
* KAM activity history
* EMD / BG records
* Smart account-health flags

[SCREENSHOT: Customer list page]
[SCREENSHOT: Customer 360 view]

---

## 7. Lead Management (including the "Opportunity" stage)

### 7.1 Overview

Leads follow a 3-step flow:

**Step 1 — Lead Info**

↓

**Step 2 — Opportunity Details**

↓

**Step 3 — Conversion (to Quotation or Tender)**

Status values on a Lead: **Assigned → Qualified → Opportunity Created → Converted / Lost**. "Opportunity Created" is simply a lead status — there is no separate Opportunity record. Where the sidebar shows an "Opportunity" module, it is a filtered view of leads currently at that status.

Conversion (Lead → Quotation/Tender) requires approval unless the requester is Admin/CEO (auto-approved); otherwise it routes through the approval-workflow engine (§14), surfaced on the kanban board as "Pending Approval" / "Rejected Opportunity" columns.

[SCREENSHOT: Leads list page]
[SCREENSHOT: Leads kanban / pipeline board]

---

## 8. Quotation Management

Flow: **Opportunity → Quotation (with Q1/Q2/Q3 revisions) → PO + Consignee → Work Order.**

Quotation status: **Draft → Sent → Approved → Accepted / Rejected**, with a separate internal `approval_status` (none / pending / approved / rejected) governing the submit-for-approval step.

[SCREENSHOT: Quotation list / form]

---

## 9. Tender Management

A 5-step workflow with role-based approval at two sub-steps (Sales → Manager → CEO; VP/Manager can skip to CEO; CEO/Admin auto-approve).

`tender_status`: **Aligned → Evaluation → Pre-Bid → Reverse Auction → Submitted → Closed**
Internal `workflow_status` (separate from the above): draft / active / step2_pending / step3_pending / step3_active / rejected.

Configurable approval sub-steps specifically for Tenders: **Tender Details**, **Workings**, **PO Details** (§14).

[SCREENSHOT: Tender list page]
[SCREENSHOT: Tender step-based form]

---

## 10. EMD / Bank Guarantee Management

Covers instrument types: EMD, Performance BG, Security Deposit, Advance BG, Retention BG, DD, Online Payment.

Unified workflow: **Approved → Document Uploaded (Accounts) → Acknowledged (Sales) → Payment Proof (Accounts) → Paid (Accounts)** → on Won/Lost → **Return Document Upload (Sales) → Confirm Return (Accounts)**.

Lifecycle status: **Active → Expired / Released / Encashed / Renewed / Cancelled.**

[SCREENSHOT: EMD/BG list page]

---

## 11. Work Order Management

Created from a won tender plus its PO document. Includes line items, milestones (Delivery / Installation / Testing / Sign-off / Payment), and per-work-order **invoices** — the closest thing this system has to invoicing/payment tracking.

Work Order status: **Draft → Confirmed → In Progress → On Hold → Delayed → Completed → Cancelled → Closed** (plus Won/Lost).
Invoice status (per work order): **Pending → Partial → Paid → Overdue.**

[SCREENSHOT: Work Order list page]
[SCREENSHOT: Work Order — invoices tab]

---

## 12. KAM 360 (Key Account Management)

Activity and sales-target tracking scoped to the user's org-hierarchy, with 360° summary cards (customers, activities, leads, tenders, work orders) and a team-360 rollup view for managers.

[SCREENSHOT: KAM 360 dashboard]

---

## 13. Travel Management

Travel Request → TA/DA claim workflow, with manager/CEO approval and mandatory receipt attachment per claimed line item before submission.

[SCREENSHOT: Travel request / claim form]

---

## 14. RFP Analysis

Uploads a tender RFP PDF and extracts a sales-friendly Field / Value / Page-Reference table into Excel. Deterministic extraction by default; optional AI-assisted extraction can be enabled via configuration (off by default).

[SCREENSHOT: RFP Analysis upload/result screen]

---

## 15. Approval Workflows

Rule-driven, generic engine — approval rules are configured per (module, action) pair, not per arbitrary field or threshold. Actual configurable catalog:

| Module | Action(s) |
| ---- | ---- |
| Customer | Create |
| Lead | Convert |
| Tender | Tender Details, Workings, PO Details |
| EMD / BG | Release |
| Travel | Request |
| Quotation | Submit for Approval |

Each rule is either a **Company-defined Chain** (sequential, explicit steps) or a **Legacy Hierarchy** (approval climbs the reporting-manager chain). Approver per step can be a reporting manager, a named role, a specific user, or a hierarchy level. Escalation rules can auto-escalate a stalled approval step.

[SCREENSHOT: Approval rule configuration screen]
[SCREENSHOT: My Approvals / pending approvals inbox]

---

## 16. Notifications and Alerts

Notification categories: **Approval, Alert, Event.** Default event catalog exists per module (Leads, Tenders, Work Orders, EMD/BG, Customers); Quotations and Travel also trigger notifications through the same underlying engine when their approval steps fire. Recipients can be the assignee, their manager, the approver, or a named role; each event has a templated title/body and an action link into the relevant record.

[SCREENSHOT: Notifications panel]

---

## 17. Report Engine (Custom / Ad-hoc Reports)

A metadata-driven report builder, distinct from the fixed Analytical Reports:

* Business templates as starting points
* Cross-module relations for joined reports
* Field metadata per report "type" (drives available columns/filters)
* Folders to organize saved reports
* Saved reports (with clone) and saved filters
* Run-and-export, both ad-hoc and for saved reports
* **Drilldowns** — clicking a cell (e.g. a customer name) opens a linked report pre-filtered to that record

[SCREENSHOT: Report Engine — report builder]
[SCREENSHOT: Report Engine — drilldown view]

---

## 18. Analytical Reports

Fixed, pre-built analytical dashboards (separate sidebar entry from the Report Engine above) — e.g. Customers, Leads, Tenders, Quotations, Work Orders, Travel/TADA, KAM report views. Visibility to "all data" vs. scoped data is governed by the `reports.view_all_data` permission independent of a user's normal own/team/all scope elsewhere.

[SCREENSHOT: Analytical Reports — Tenders report view]

---

## 19. AI Insights

A dedicated tab surfacing AI-assisted insights across modules (referenced in the sidebar under Management); pairs with the RFP Analysis feature's optional AI extraction path.

[SCREENSHOT: AI Insights page]

---

## 20. Audit History

Four distinct layers exist:

| Log | Purpose |
| ---- | ---- |
| `AuditLog` (per-tenant) | Business-change audit trail: user, module, action, record id, old/new values, IP, timestamp |
| `ActivityLog` (per-tenant) | Lighter UI-facing activity feed (e.g. Customer 360 timeline) |
| `ApiLog` / `ErrorLog` (per-tenant) | Technical request/error logs, not business-facing |
| `PlatformAuditLog` (platform-level) | Separate trail for Platform Super Admin actions only |

[SCREENSHOT: Audit history view]

---

## 21. Completion Criteria (Go-Live Checklist)

A tenant is considered ready for business users when:

* Tenant is provisioned and its feature matrix is confirmed
* Required users are created with correct roles and data scope
* Required masters are configured
* Approval rules are active for every module that needs them
* Notification events are enabled where required
* Module labels match the organization's terminology (if customized)
* Login and permission testing is complete
* Audit logging is confirmed functioning

---

*End of document. Sections marked with a screenshot placeholder should have the corresponding page/screen inserted before distribution.*
