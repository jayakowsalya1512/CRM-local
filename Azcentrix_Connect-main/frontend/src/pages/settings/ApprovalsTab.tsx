import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
  Users,
  X,
  GitBranch,
  ListOrdered,
} from "lucide-react";

import api, { approvalWorkflowApi } from "@/services/api";
import Button from "@/components/ui/Button";
import Card, { CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/FormComponents";
import SearchableSelect, {
  MultiSearchableSelect,
  type SelectOption,
} from "@/components/ui/SearchableSelect";
import SlidePanel from "@/components/ui/SlidePanel";
import FieldError from "@/components/form/FieldError";
import { apiFieldErrors, validate } from "@/utils/validation";
import { useUIStore } from "@/store";

// ── Core types ────────────────────────────────────────────────────────────
type ApprovalModuleAction = { key: string; label: string };
type ApprovalModule = {
  key: string;
  label: string;
  actions: ApprovalModuleAction[];
};
type ApprovalOption = { key: string; label: string };
type ApprovalUser = {
  id: number;
  full_name: string;
  email: string;
  role: string;
};
type ApprovalGroup = {
  id: number;
  name: string;
  // Who currently heads this group (org-tree L2 node) — the same person can head several
  // groups at once; surfacing it here is what lets a multi-group policy make that visible.
  lead_id?: number | null;
  lead_name?: string | null;
};

type ApprovalMeta = {
  modules: ApprovalModule[];
  requester_types: ApprovalOption[];
  approver_types: ApprovalOption[];
  requester_roles: ApprovalOption[];
  approver_roles: ApprovalOption[];
  users: ApprovalUser[];
  groups: ApprovalGroup[];
};

type ApprovalEscalationRule = {
  id: number;
  tenant_id?: number | null;
  module_key: string;
  action_key: string;
  approver_role: string;
  escalation_minutes: number;
  is_active: boolean;
};

type StoredStep = {
  id: number;
  step_no: number;
  approver_type:
    | "reporting_manager"
    | "role"
    | "specific_user"
    | "hierarchy_level";
  approver_role?: string | null;
  approver_user_id?: number | null;
  approver_user_name?: string | null;
  approver_level?: number | null;
  is_required?: boolean;
  stop_on_reject: boolean;
  escalation_minutes?: number | null;
};

type StoredRule = {
  id: number;
  module_key: string;
  action_key: string;
  name: string;
  requester_type?: "role" | "specific_user" | "group" | null;
  requester_role?: string | null;
  requester_user_id?: number | null;
  requester_user_name?: string | null;
  requester_group_id?: number | null;
  requester_group_name?: string | null;
  is_active: boolean;
  approval_type?: string;
  step_count: number;
  steps: StoredStep[];
};

type GroupLevelInfo = {
  level: number;
  level_label: string;
  is_group_lead: boolean;
  is_l1: boolean;
  user_count: number;
  users: { id: number; full_name: string; role: string }[];
};

// ── Simplified form types (UI-facing) ─────────────────────────────────────
type RequesterMode = "user" | "group";
type GroupFlowType = "hierarchy" | "sequential";

type ModuleEntry = {
  row_id: string;
  module_key: string;
  action_keys: string[];
};

type StepDraft = {
  row_id: string;
  approver_type: "specific_user" | "hierarchy_level" | "reporting_manager";
  approver_user_id: string;
  approver_level: number | null;
  stop_on_reject: boolean;
};

type FormDraft = {
  name: string;
  is_active: boolean;
  entries: ModuleEntry[];
  mode: RequesterMode;
  requester_user_ids: string[];
  // Several groups can be picked for one policy — one ApprovalRule row is created per
  // group (same chain applied to each), which is how one head ends up seeing approvals
  // from every group they lead land in the same place.
  requester_group_ids: string[];
  groupFlowType: GroupFlowType;
  steps: StepDraft[];
};

type EscalationFormDraft = {
  module_key: string;
  action_key: string;
  approver_role: string;
  escalation_hours: string;
  is_active: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────────
const RULES_PER_PAGE = 10;

const FALLBACK_META: ApprovalMeta = {
  modules: [
    {
      key: "customer",
      label: "Customer",
      actions: [{ key: "create", label: "Create" }],
    },
    {
      key: "lead",
      label: "Lead",
      actions: [{ key: "convert", label: "Convert" }],
    },
    {
      key: "tender",
      label: "Tender",
      actions: [
        { key: "tender_details", label: "Tender Details" },
        { key: "workings", label: "Workings" },
        { key: "po_details", label: "PO Details" },
      ],
    },
    {
      key: "emdbg",
      label: "EMD / BG",
      actions: [{ key: "release", label: "Release" }],
    },
    {
      key: "travel",
      label: "Travel",
      actions: [{ key: "request", label: "Request" }],
    },
  ],
  requester_types: [
    { key: "role", label: "Role" },
    { key: "specific_user", label: "Specific User" },
    { key: "group", label: "Group" },
  ],
  approver_types: [
    { key: "role", label: "Role" },
    { key: "specific_user", label: "Specific User" },
  ],
  requester_roles: [],
  approver_roles: [],
  users: [],
  groups: [],
};

// Level display colours (by level number, 1=CEO=violet, higher=lower-in-org)
const LEVEL_PALETTE = [
  {
    pill: "bg-violet-600 text-white",
    soft: "bg-violet-50 border-violet-200 text-violet-800",
    dot: "bg-violet-500",
  },
  {
    pill: "bg-blue-600 text-white",
    soft: "bg-blue-50 border-blue-200 text-blue-800",
    dot: "bg-blue-500",
  },
  {
    pill: "bg-emerald-600 text-white",
    soft: "bg-emerald-50 border-emerald-200 text-emerald-800",
    dot: "bg-emerald-500",
  },
  {
    pill: "bg-amber-500 text-white",
    soft: "bg-amber-50 border-amber-200 text-amber-800",
    dot: "bg-amber-500",
  },
  {
    pill: "bg-rose-500 text-white",
    soft: "bg-rose-50 border-rose-200 text-rose-800",
    dot: "bg-rose-500",
  },
];
function lvlPalette(level: number) {
  return LEVEL_PALETTE[Math.max(0, (level - 1) % LEVEL_PALETTE.length)];
}

let _stepCounter = 0;
let _entryCounter = 0;
function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${++_stepCounter}`;
}
function entryId() {
  return `entry-${Date.now()}-${++_entryCounter}`;
}

// ── Pure helpers ──────────────────────────────────────────────────────────
function humanize(v: string) {
  return String(v || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function getErr(err: unknown) {
  return (
    (err as any)?.response?.data?.detail ||
    (err as any)?.message ||
    "Something went wrong."
  );
}
function mergeOptions(
  primary: ApprovalOption[] = [],
  fallback: ApprovalOption[] = [],
) {
  const map = new Map<string, ApprovalOption>();
  fallback.forEach((o) => o?.key && map.set(o.key, o));
  primary.forEach((o) => o?.key && map.set(o.key, o));
  return Array.from(map.values());
}

// ── Form builders ─────────────────────────────────────────────────────────
function emptyStep(): StepDraft {
  return {
    row_id: uid("step"),
    approver_type: "specific_user",
    approver_user_id: "",
    approver_level: null,
    stop_on_reject: true,
  };
}
function emptyEntry(): ModuleEntry {
  return { row_id: entryId(), module_key: "", action_keys: [] };
}
function emptyForm(): FormDraft {
  return {
    name: "",
    is_active: true,
    entries: [],
    mode: "user",
    requester_user_ids: [],
    requester_group_ids: [],
    groupFlowType: "hierarchy",
    steps: [emptyStep()],
  };
}

function emptyEscalationForm(): EscalationFormDraft {
  return {
    module_key: "",
    action_key: "",
    approver_role: "",
    escalation_hours: "",
    is_active: true,
  };
}

function minutesToHoursInput(minutes?: number | null) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "";
  const hours = value / 60;
  return Number(hours.toFixed(2)).toString();
}

function formatHours(minutes?: number | null) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "No SLA";
  const hours = value / 60;
  return `${Number(hours.toFixed(2)).toString()}h`;
}

function hoursInputToMinutes(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("Enter a valid escalation time in hours.");
  }
  return Math.max(1, Math.round(hours * 60));
}

function buildHierarchySteps(levels: GroupLevelInfo[]): StepDraft[] {
  const sortedAsc = [...levels].sort((a, b) => a.level - b.level);

  const approverLevels = sortedAsc.slice(0, -1).reverse();

  return approverLevels.map((l) => ({
    row_id: uid("step"),
    approver_type: "hierarchy_level" as const,
    approver_user_id: "",
    approver_level: l.level,
    stop_on_reject: true,
  }));
}

function ruleToForm(rule: StoredRule): FormDraft {
  const mode: RequesterMode =
    rule.requester_type === "group" ? "group" : "user";

  // Determine groupFlowType from stored approval_type
  const groupFlowType: GroupFlowType =
    mode === "group" && rule.approval_type === "sequential"
      ? "sequential"
      : "hierarchy";

  const formSteps: StepDraft[] =
    Array.isArray(rule.steps) && rule.steps.length
      ? rule.steps
          .slice()
          .sort((a, b) => a.step_no - b.step_no)
          .map((s) => ({
            row_id: uid("step"),
            approver_type:
              s.approver_type === "hierarchy_level"
                ? "hierarchy_level"
                : s.approver_type === "reporting_manager"
                  ? "reporting_manager"
                  : "specific_user",
            approver_user_id:
              s.approver_type === "hierarchy_level" ||
              s.approver_type === "reporting_manager"
                ? ""
                : s.approver_user_id
                  ? String(s.approver_user_id)
                  : "",
            approver_level: s.approver_level ?? null,
            stop_on_reject: s.stop_on_reject !== false,
          }))
      : [emptyStep()];

  return {
    name: rule.name || "",
    is_active: rule.is_active,
    entries: rule.module_key
      ? [
          {
            row_id: entryId(),
            module_key: rule.module_key,
            action_keys: rule.action_key ? [rule.action_key] : [],
          },
        ]
      : [],
    mode,
    requester_user_ids:
      mode === "user" && rule.requester_user_id
        ? [String(rule.requester_user_id)]
        : [],
    // A stored rule is always scoped to exactly one group (the fan-out happens on create,
    // see formToPayload); editing shows that one group pre-selected in the multi-select.
    requester_group_ids:
      mode === "group" && rule.requester_group_id
        ? [String(rule.requester_group_id)]
        : [],
    groupFlowType,
    steps: formSteps,
  };
}

function formToPayload(form: FormDraft) {
  if (!form.entries.length)
    throw new Error("Add at least one module-action pair.");
  for (let i = 0; i < form.entries.length; i++) {
    const e = form.entries[i];
    if (!e.module_key) throw new Error(`Entry ${i + 1}: select a module.`);
    if (!e.action_keys.length)
      throw new Error(`Entry ${i + 1}: select at least one action.`);
  }
  if (form.mode === "user" && !form.requester_user_ids.length)
    throw new Error("Select at least one requester user.");
  if (form.mode === "group" && !form.requester_group_ids.length)
    throw new Error("Select at least one requester group.");
  if (!form.steps.length) throw new Error("Add at least one approval step.");

  for (let i = 0; i < form.steps.length; i++) {
    const s = form.steps[i];
    if (s.approver_type === "specific_user" && !s.approver_user_id) {
      throw new Error(`Step ${i + 1}: select an approver.`);
    }
    if (
      form.mode === "group" &&
      form.groupFlowType === "hierarchy" &&
      !s.approver_level
    )
      throw new Error(`Step ${i + 1}: select an org level.`);
  }

  const pairs = form.entries.flatMap((e) =>
    e.action_keys.map((ak) => ({ module_key: e.module_key, action_key: ak })),
  );
  const isGroup = form.mode === "group";
  const requesterType: "group" | "specific_user" = isGroup
    ? "group"
    : "specific_user";

  // For group mode: use groupFlowType; for user mode: always sequential
  const approvalType = isGroup ? form.groupFlowType : "sequential";

  return {
    module_key: pairs[0]?.module_key || "",
    action_key: pairs[0]?.action_key || "",
    module_keys: pairs.map((p) => p.module_key),
    action_keys: pairs.map((p) => p.action_key),
    module_action_pairs: pairs,
    name: form.name.trim(),
    requester_type: requesterType,
    requester_role: null,
    requester_roles: [],
    requester_user_id:
      !isGroup && form.requester_user_ids[0]
        ? Number(form.requester_user_ids[0])
        : null,
    requester_user_ids: !isGroup
      ? form.requester_user_ids.map(Number).filter(Number.isFinite)
      : [],
    requester_group_id:
      isGroup && form.requester_group_ids[0]
        ? Number(form.requester_group_ids[0])
        : null,
    // One rule per group is created server-side from this same list (see /rules POST),
    // all sharing the chain built below — that is what lets several groups share one policy.
    requester_group_ids: isGroup
      ? form.requester_group_ids.map(Number).filter(Number.isFinite)
      : [],
    is_active: form.is_active,
    approval_type: approvalType,
    steps: form.steps.map((s, i) => ({
      step_no: i + 1,
      approver_type: s.approver_type,
      approver_role: null,
      approver_user_id:
        s.approver_type === "specific_user" && s.approver_user_id
          ? Number(s.approver_user_id)
          : null,
      approver_level:
        s.approver_type === "hierarchy_level" ? s.approver_level : null,
      is_required: true,
      stop_on_reject: s.stop_on_reject,
    })),
  };
}

// ── Field validation (per field, shown under each control) ─────────────────
const RULE_NAME_SPEC = {
  label: "Rule name",
  rule: "text" as const,
  min: 3,
  max: 150,
};
const ESC_HOURS_SPEC = {
  label: "Escalation time",
  rule: "amount" as const,
  max: 8760,
};

/** Every problem in the rule form keyed by an element id (also used to focus the first one). */
function ruleFormErrors(form: FormDraft): Record<string, string> {
  const out: Record<string, string> = {};
  const nameMsg = validate(form.name, RULE_NAME_SPEC);
  if (nameMsg) out["ar-name"] = nameMsg;
  if (!form.entries.length)
    out["ar-entries"] = "Add at least one module and action.";
  form.entries.forEach((e) => {
    if (!e.module_key)
      out[`ar-entry-${e.row_id}-module`] = "Please select a module.";
    else if (!e.action_keys.length)
      out[`ar-entry-${e.row_id}-actions`] =
        "Please select at least one action.";
  });
  if (form.mode === "user" && !form.requester_user_ids.length)
    out["ar-requesters"] = "Please select at least one requester.";
  if (form.mode === "group" && !form.requester_group_id)
    out["ar-group"] = "Please select a requester group.";
  if (!form.steps.length) out["ar-steps"] = "Add at least one approval step.";
  form.steps.forEach((s) => {
    const hierarchy =
      form.mode === "group" && form.groupFlowType === "hierarchy";
    if (
      !hierarchy &&
      s.approver_type === "specific_user" &&
      !s.approver_user_id
    )
      out[`ar-step-${s.row_id}-approver`] = "Please select an approver.";
    if (hierarchy && !s.approver_level)
      out[`ar-step-${s.row_id}-approver`] = "Please select an org level.";
  });
  return out;
}

/** Order of the rule form's error ids as they appear on screen. */
function ruleErrorOrder(form: FormDraft): string[] {
  return [
    "ar-name",
    "ar-entries",
    ...form.entries.flatMap((e) => [
      `ar-entry-${e.row_id}-module`,
      `ar-entry-${e.row_id}-actions`,
    ]),
    "ar-requesters",
    "ar-group",
    "ar-steps",
    ...form.steps.map((s) => `ar-step-${s.row_id}-approver`),
  ];
}

function focusById(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const target = el.matches("input,select,textarea,[tabindex]")
    ? el
    : el.querySelector<HTMLElement>("input,select,textarea,[tabindex]");
  try {
    target?.focus({ preventScroll: true });
  } catch {
    target?.focus();
  }
}

// ── Sub-components ────────────────────────────────────────────────────────
function StatusToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative inline-flex h-6 w-12 items-center rounded-full border transition-colors ${
        enabled
          ? "border-emerald-300 bg-emerald-500"
          : "border-gray-300 bg-gray-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-7" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function SectionNum({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        active ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"
      }`}
    >
      {n}
    </span>
  );
}

function SectionHeader({
  n,
  title,
  subtitle,
}: {
  n: number;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <SectionNum n={n} active />
      <div>
        <p className="text-sm font-bold text-gray-900 leading-tight">{title}</p>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function DupBadge() {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wide text-red-500">
      Duplicate
    </span>
  );
}

// ── Main Component ────────────────────────────────────────────────────────
export default function ApprovalsTab({
  standalone = false,
  view = "all",
}: {
  standalone?: boolean;
  view?: "all" | "approvals" | "escalations";
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [escalationSaving, setEscalationSaving] = useState(false);
  const [rules, setRules] = useState<StoredRule[]>([]);
  const [stepEscMinutes, setStepEscMinutes] = useState<Record<number, string>>(
    {},
  );
  const [stepEscSaving, setStepEscSaving] = useState<Set<number>>(new Set());
  const [escalationSubTab, setEscalationSubTab] = useState<"role" | "approval">(
    "approval",
  );
  const [ruleEscSaving, setRuleEscSaving] = useState<Set<number>>(new Set());
  const [escalationRules, setEscalationRules] = useState<
    ApprovalEscalationRule[]
  >([]);
  const [meta, setMeta] = useState<ApprovalMeta>(FALLBACK_META);
  const [escalationForm, setEscalationForm] =
    useState<EscalationFormDraft>(emptyEscalationForm);
  const [editingEscalationRuleId, setEditingEscalationRuleId] = useState<
    number | null
  >(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<StoredRule | null>(null);
  const [rulePage, setRulePage] = useState(1);
  const [ruleSearch, setRuleSearch] = useState("");
  const [form, setForm] = useState<FormDraft>(emptyForm);
  const [groupLevels, setGroupLevels] = useState<GroupLevelInfo[]>([]);
  const [groupLevelsLoading, setGroupLevelsLoading] = useState(false);
  // Level picked in the "add another org level" control (hierarchy flow, group mode) —
  // lets an admin extend or shorten that specific policy's escalation levels by hand.
  const [addLevelChoice, setAddLevelChoice] = useState<string | null>(null);

  const dragRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const sidebarSnap = useRef(false);

  const { success, error } = useToast();
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const showApprovalMatrix = view !== "escalations";
  const showEscalationOverrides = view !== "approvals";

  // ── Derived maps ───────────────────────────────────────────────────────
  const moduleLabelMap = useMemo(
    () => new Map((meta.modules || []).map((m) => [m.key, m.label] as const)),
    [meta.modules],
  );
  const actionLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    (meta.modules || []).forEach((m) =>
      m.actions.forEach((a) => {
        map.set(`${m.key}:${a.key}`, a.label);
        if (!map.has(a.key)) map.set(a.key, a.label);
      }),
    );
    return map;
  }, [meta.modules]);
  const userLabelMap = useMemo(
    () =>
      new Map(
        (meta.users || []).map(
          (u) =>
            [u.id, `${u.full_name} (${humanize(u.role || "user")})`] as const,
        ),
      ),
    [meta.users],
  );
  const groupLabelMap = useMemo(
    () => new Map((meta.groups || []).map((g) => [g.id, g.name] as const)),
    [meta.groups],
  );

  const moduleOptions = useMemo<SelectOption[]>(
    () => meta.modules.map((m) => ({ value: m.key, label: m.label })),
    [meta.modules],
  );
  const userOptions = useMemo<SelectOption[]>(
    () =>
      meta.users.map((u) => ({
        value: String(u.id),
        label: u.full_name,
        subtitle: humanize(u.role || "user"),
      })),
    [meta.users],
  );
  const groupOptions = useMemo<SelectOption[]>(
    () => meta.groups.map((g) => ({ value: String(g.id), label: g.name })),
    [meta.groups],
  );
  const approverRoleOptions = useMemo<SelectOption[]>(
    () =>
      (meta.approver_roles || []).map((role) => ({
        value: role.key,
        label: role.label,
      })),
    [meta.approver_roles],
  );
  const escalationActionOptions = useMemo<SelectOption[]>(
    () =>
      (
        meta.modules.find((module) => module.key === escalationForm.module_key)
          ?.actions || []
      ).map((action) => ({
        value: action.key,
        label: action.label,
      })),
    [meta.modules, escalationForm.module_key],
  );

  const totalActive = useMemo(
    () => rules.filter((r) => r.is_active).length,
    [rules],
  );
  const totalSteps = useMemo(
    () => rules.reduce((s, r) => s + Number(r.step_count || 0), 0),
    [rules],
  );
  const activeEscalationRules = useMemo(
    () => escalationRules.filter((rule) => rule.is_active).length,
    [escalationRules],
  );
  const escalationModulesCovered = useMemo(
    () => new Set(escalationRules.map((rule) => rule.module_key)).size,
    [escalationRules],
  );
  const escalationRolesCovered = useMemo(
    () => new Set(escalationRules.map((rule) => rule.approver_role)).size,
    [escalationRules],
  );
  const statCards = useMemo(() => {
    if (view === "approvals") {
      return [
        {
          label: "Approval Matrix",
          value: rules.length,
          desc: "Configured rules across all modules",
          color: "blue",
          Icon: Users,
        },
        {
          label: "Active Rules",
          value: totalActive,
          desc: "Currently routing live approvals",
          color: "emerald",
          Icon: CheckCircle2,
        },
        {
          label: "Total Steps",
          value: totalSteps,
          desc: "Sequential steps saved across rules",
          color: "amber",
          Icon: GripVertical,
        },
      ];
    }
    if (view === "escalations") {
      return [
        {
          label: "Overrides",
          value: escalationRules.length,
          desc: "Module and role-specific SLA exceptions",
          color: "rose",
          Icon: Clock3,
        },
        {
          label: "Active Overrides",
          value: activeEscalationRules,
          desc:
            activeEscalationRules > 0
              ? "Overrides currently enforcing custom escalation time"
              : "No overrides enabled right now",
          color: "amber",
          Icon: CheckCircle2,
        },
        {
          label: "Modules Covered",
          value: escalationModulesCovered,
          desc:
            escalationRolesCovered > 0
              ? `${escalationRolesCovered} approver role${escalationRolesCovered === 1 ? "" : "s"} covered`
              : "No approver roles covered yet",
          color: "blue",
          Icon: GitBranch,
        },
      ];
    }
    return [
      {
        label: "Approval Matrix",
        value: rules.length,
        desc: "Configured rules across all modules",
        color: "blue",
        Icon: Users,
      },
      {
        label: "Active Rules",
        value: totalActive,
        desc: "Currently routing live approvals",
        color: "emerald",
        Icon: CheckCircle2,
      },
      {
        label: "Total Steps",
        value: totalSteps,
        desc: "Sequential steps saved across rules",
        color: "amber",
        Icon: GripVertical,
      },
      {
        label: "Escalation Rules",
        value: activeEscalationRules,
        desc:
          activeEscalationRules > 0
            ? "Active SLA overrides currently in force"
            : "No active overrides configured",
        color: "rose",
        Icon: Clock3,
      },
    ];
  }, [
    activeEscalationRules,
    escalationModulesCovered,
    escalationRolesCovered,
    escalationRules.length,
    rules.length,
    totalActive,
    totalSteps,
    view,
  ]);

  const filteredRules = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => {
      const ml = moduleLabelMap.get(r.module_key) || r.module_key;
      const al =
        actionLabelMap.get(`${r.module_key}:${r.action_key}`) || r.action_key;
      return [
        ml,
        al,
        r.name,
        r.module_key,
        r.action_key,
        r.requester_role,
        r.requester_user_name,
      ].some((v) => (v || "").toLowerCase().includes(q));
    });
  }, [rules, ruleSearch, moduleLabelMap, actionLabelMap]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredRules.length / RULES_PER_PAGE),
  );
  const pageRules = useMemo(() => {
    const start = (rulePage - 1) * RULES_PER_PAGE;
    return filteredRules.slice(start, start + RULES_PER_PAGE);
  }, [filteredRules, rulePage]);

  const allPairs = useMemo(
    () =>
      form.entries.flatMap((e) =>
        e.action_keys.map((ak) => ({
          module_key: e.module_key,
          action_key: ak,
        })),
      ),
    [form.entries],
  );

  // ── Group level options derived from loaded hierarchy ──────────────────
  // Sorted ascending: L1 (CEO) first, highest level last
  const levelOptions = useMemo<SelectOption[]>(
    () =>
      [...groupLevels]
        .sort((a, b) => a.level - b.level)
        .map((l) => ({ value: String(l.level), label: l.level_label })),
    [groupLevels],
  );

  // ── Data loading ───────────────────────────────────────────────────────
  const loadGroupLevels = async (
    groupId: string,
  ): Promise<GroupLevelInfo[]> => {
    setGroupLevelsLoading(true);
    try {
      const { data } = await api.get(
        `/masters/groups/${groupId}/reporting-hierarchy`,
      );
      const levels: GroupLevelInfo[] = Array.isArray(data) ? data : [];
      setGroupLevels(levels);
      return levels;
    } catch (err) {
      setGroupLevels([]);
      error(getErr(err));
      return [];
    } finally {
      setGroupLevelsLoading(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [metaRes, rulesRes, escalationRulesRes] = await Promise.allSettled([
        approvalWorkflowApi.getMeta(),
        approvalWorkflowApi.listRules(),
        approvalWorkflowApi.listEscalationRules(),
      ]);

      const fetchGroups = async () => {
        try {
          const res = await api.get("/masters/groups");
          return Array.isArray(res.data)
            ? res.data
                .map((g: any) => ({
                  id: Number(g.id),
                  name: String(g.name || "").trim(),
                }))
                .filter((g: ApprovalGroup) => g.id && g.name)
            : [];
        } catch {
          return [];
        }
      };

      let nextMeta = FALLBACK_META;
      if (metaRes.status === "fulfilled") {
        const d = metaRes.value.data || {};
        let groups = Array.isArray(d.groups) ? d.groups : [];
        if (!groups.length) groups = await fetchGroups();
        nextMeta = {
          modules:
            Array.isArray(d.modules) && d.modules.length
              ? d.modules
              : FALLBACK_META.modules,
          requester_types: mergeOptions(
            Array.isArray(d.requester_types) ? d.requester_types : [],
            FALLBACK_META.requester_types,
          ),
          approver_types: mergeOptions(
            Array.isArray(d.approver_types) ? d.approver_types : [],
            FALLBACK_META.approver_types,
          ),
          requester_roles: Array.isArray(d.requester_roles)
            ? d.requester_roles
            : [],
          approver_roles: Array.isArray(d.approver_roles)
            ? d.approver_roles
            : [],
          users: Array.isArray(d.users) ? d.users : [],
          groups,
        };
      } else {
        nextMeta = { ...FALLBACK_META, groups: await fetchGroups() };
        error(`Metadata fallback active: ${getErr((metaRes as any).reason)}`);
      }

      setMeta(nextMeta);
      if (rulesRes.status === "fulfilled") {
        setRules(Array.isArray(rulesRes.value.data) ? rulesRes.value.data : []);
      } else {
        setRules([]);
        error(getErr((rulesRes as any).reason));
      }

      if (escalationRulesRes.status === "fulfilled") {
        const rows = Array.isArray(escalationRulesRes.value.data)
          ? escalationRulesRes.value.data
          : [];
        setEscalationRules(
          rows.map((row: any) => ({
            id: Number(row.id),
            tenant_id:
              typeof row.tenant_id === "number" &&
              Number.isFinite(row.tenant_id)
                ? row.tenant_id
                : null,
            module_key: String(row.module_key || "")
              .trim()
              .toLowerCase(),
            action_key: String(row.action_key || "")
              .trim()
              .toLowerCase(),
            approver_role: String(row.approver_role || "")
              .trim()
              .toLowerCase(),
            escalation_minutes: Number(row.escalation_minutes || 0),
            is_active: !!row.is_active,
          })),
        );
      } else {
        setEscalationRules([]);
        error(getErr((escalationRulesRes as any).reason));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);
  useEffect(() => {
    setRulePage((p) => Math.min(p, totalPages));
  }, [totalPages]);
  useEffect(() => {
    setRulePage(1);
  }, [ruleSearch]);
  useEffect(() => {
    return () => {
      if (panelOpen && !sidebarSnap.current) setSidebarCollapsed(false);
    };
  }, [panelOpen, setSidebarCollapsed]);

  // ── Panel open/close ───────────────────────────────────────────────────
  const openCreate = () => {
    sidebarSnap.current = sidebarCollapsed;
    if (!sidebarCollapsed) setSidebarCollapsed(true);
    setEditingRule(null);
    setGroupLevels([]);
    setForm(emptyForm());
    setRuleSubmitted(false);
    setRuleServerErrs({});
    setPanelOpen(true);
  };

  const openEdit = (rule: StoredRule) => {
    sidebarSnap.current = sidebarCollapsed;
    if (!sidebarCollapsed) setSidebarCollapsed(true);
    setEditingRule(rule);
    const f = ruleToForm(rule);
    setForm(f);
    setRuleSubmitted(false);
    setRuleServerErrs({});
    setGroupLevels([]);
    if (rule.requester_type === "group" && rule.requester_group_id) {
      void loadGroupLevels(String(rule.requester_group_id));
    }
    setPanelOpen(true);
  };

  const closePanel = (force = false) => {
    if (saving && !force) return;
    if (!sidebarSnap.current) setSidebarCollapsed(false);
    setPanelOpen(false);
    setEditingRule(null);
  };

  // ── Form setters ───────────────────────────────────────────────────────
  const setF = (patch: Partial<FormDraft>) =>
    setForm((c) => ({ ...c, ...patch }));

  const setEscalationF = (patch: Partial<EscalationFormDraft>) =>
    setEscalationForm((current) => ({ ...current, ...patch }));

  const resetEscalationForm = () => {
    setEditingEscalationRuleId(null);
    setEscalationForm(emptyEscalationForm());
  };

  const handleSaveEscalationRule = async () => {
    setEscalationSaving(true);
    try {
      if (!escalationForm.module_key) throw new Error("Select a module.");
      if (!escalationForm.action_key) throw new Error("Select an action.");
      if (!escalationForm.approver_role) {
        throw new Error("Select an approver role.");
      }

      const escalation_minutes = hoursInputToMinutes(
        escalationForm.escalation_hours,
      );
      if (escalation_minutes === null) {
        throw new Error("Enter escalation time in hours.");
      }

      const payload = {
        module_key: escalationForm.module_key,
        action_key: escalationForm.action_key,
        approver_role: escalationForm.approver_role,
        escalation_minutes,
        is_active: escalationForm.is_active,
      };

      if (editingEscalationRuleId) {
        await approvalWorkflowApi.updateEscalationRule(
          editingEscalationRuleId,
          payload,
        );
        success("Escalation override updated");
      } else {
        await approvalWorkflowApi.createEscalationRule(payload);
        success("Escalation override created");
      }

      await loadData();
      resetEscalationForm();
    } catch (err) {
      error(getErr(err));
    } finally {
      setEscalationSaving(false);
    }
  };

  const handleEditEscalationRule = (rule: ApprovalEscalationRule) => {
    setEditingEscalationRuleId(rule.id);
    setEscalationForm({
      module_key: rule.module_key,
      action_key: rule.action_key,
      approver_role: rule.approver_role,
      escalation_hours: minutesToHoursInput(rule.escalation_minutes),
      is_active: rule.is_active,
    });
  };

  const handleDeleteEscalationRule = async (rule: ApprovalEscalationRule) => {
    if (
      !window.confirm(
        `Delete escalation override for ${humanize(rule.module_key)} / ${humanize(rule.action_key)} / ${humanize(rule.approver_role)}?`,
      )
    ) {
      return;
    }
    try {
      await approvalWorkflowApi.deleteEscalationRule(rule.id);
      success("Escalation override deleted");
      await loadData();
      if (editingEscalationRuleId === rule.id) {
        resetEscalationForm();
      }
    } catch (err) {
      error(getErr(err));
    }
  };

  const handleToggleEscalationRule = async (rule: ApprovalEscalationRule) => {
    try {
      const { data } = await approvalWorkflowApi.setEscalationRuleStatus(
        rule.id,
        !rule.is_active,
      );
      setEscalationRules((current) =>
        current.map((item) =>
          item.id === rule.id
            ? {
                ...item,
                is_active: !!data?.is_active,
                escalation_minutes: Number(
                  data?.escalation_minutes ?? item.escalation_minutes,
                ),
              }
            : item,
        ),
      );
      success(`Escalation rule ${data?.is_active ? "activated" : "disabled"}`);
    } catch (err) {
      error(getErr(err));
    }
  };

  // Entries
  const addEntry = () => setF({ entries: [...form.entries, emptyEntry()] });
  const removeEntry = (id: string) =>
    setF({ entries: form.entries.filter((e) => e.row_id !== id) });
  const updateEntry = (id: string, patch: Partial<ModuleEntry>) =>
    setF({
      entries: form.entries.map((e) =>
        e.row_id === id ? { ...e, ...patch } : e,
      ),
    });
  const changeEntryModule = (id: string, moduleKey: string) => {
    const mod = meta.modules.find((m) => m.key === moduleKey);
    updateEntry(id, {
      module_key: moduleKey,
      action_keys: mod?.actions.map((a) => a.key) || [],
    });
  };

  // Steps
  const patchStep = (id: string, patch: Partial<StepDraft>) =>
    setF({
      steps: form.steps.map((s) => (s.row_id === id ? { ...s, ...patch } : s)),
    });
  const addStep = () => {
    setF({ steps: [...form.steps, emptyStep()] });
  };
  const removeStep = (id: string) => {
    const next = form.steps.filter((s) => s.row_id !== id);
    // For user mode always keep at least 1 step
    if (form.mode === "user" && next.length < 1) return;
    setF({ steps: next });
  };

  // Mode change
  const changeMode = async (mode: RequesterMode) => {
    setF({
      mode,
      requester_user_ids: [],
      requester_group_ids: [],
      groupFlowType: "hierarchy",
      steps: mode === "user" ? [emptyStep()] : [],
    });
    setGroupLevels([]);
    setAddLevelChoice(null);
  };

  // Group change — any number of groups may be selected. The SAME approval chain is
  // applied to every one of them (the backend fans this out into one ApprovalRule per
  // group), so when the same person already heads several of the selected groups their
  // approvals from all of them land on them automatically — nothing extra to configure.
  // The org-level picker reflects the FIRST selected group; the same level numbers are
  // reused for the others.
  const changeGroups = async (groupIds: string[]) => {
    setF({ requester_group_ids: groupIds, steps: [] });
    setGroupLevels([]);
    setAddLevelChoice(null);
    const refGroupId = groupIds[0];
    if (!refGroupId) return;
    const levels = await loadGroupLevels(refGroupId);
    if (levels.length) {
      const autoSteps = buildHierarchySteps(levels);
      setF({ steps: autoSteps.length ? autoSteps : [] });
    }
  };

  // Group flow type change
  const changeGroupFlowType = (flowType: GroupFlowType) => {
    setAddLevelChoice(null);
    if (flowType === "hierarchy") {
      // Re-populate from loaded hierarchy levels
      const autoSteps = groupLevels.length
        ? buildHierarchySteps(groupLevels)
        : [];
      setF({ groupFlowType: flowType, steps: autoSteps });
    } else {
      // Sequential: start with a single blank step (no level tag)
      setF({ groupFlowType: flowType, steps: [emptyStep()] });
    }
  };

  // Add one more org level (e.g. "the group head's own manager") to this specific
  // policy's escalation chain by hand, on top of whatever auto-populated. Removing a
  // level uses the same trash icon every other step already has.
  const addHierarchyLevel = () => {
    if (!addLevelChoice) return;
    setF({
      steps: [
        ...form.steps,
        {
          row_id: uid("step"),
          approver_type: "hierarchy_level",
          approver_user_id: "",
          approver_level: Number(addLevelChoice),
          stop_on_reject: true,
        },
      ],
    });
    setAddLevelChoice(null);
  };

  // Drag-drop
  const onDragStart = (e: DragEvent, i: number) => {
    e.dataTransfer.effectAllowed = "move";
    dragRef.current = i;
    setDragging(i);
  };
  const onDragOver = (e: DragEvent, i: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOver !== i) setDragOver(i);
  };
  const onDragLeave = () => setDragOver(null);
  const onDragEnd = () => {
    dragRef.current = null;
    setDragging(null);
    setDragOver(null);
  };
  const onDrop = (e: DragEvent, dropIdx: number) => {
    e.preventDefault();
    const from = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    setDragOver(null);
    if (from === null || from === dropIdx) return;
    const next = [...form.steps];
    const [moved] = next.splice(from, 1);
    next.splice(dropIdx, 0, moved);
    setF({ steps: next });
  };

  // Save / Delete / Toggle
  const handleSave = async () => {
    setRuleSubmitted(true);
    const bad = ruleFormErrors(form);
    if (Object.keys(bad).length) {
      const first = ruleErrorOrder(form).find((id) => bad[id]);
      if (first) window.setTimeout(() => focusById(first), 30);
      return;
    }
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (editingRule) {
        await approvalWorkflowApi.updateRule(editingRule.id, payload);
        success("Approval rule updated");
      } else {
        const { data } = await approvalWorkflowApi.createRule(payload);
        const n = Number(data?.count || 0);
        success(
          n > 1 ? `${n} approval rules created` : "Approval rule created",
        );
      }
      await loadData();
      closePanel(true);
    } catch (err) {
      const fx = apiFieldErrors(err);
      if (fx.name) {
        setRuleServerErrs({ "ar-name": fx.name });
        focusById("ar-name");
      } else
        error(
          typeof getErr(err) === "string"
            ? getErr(err)
            : "Failed to save approval rule",
        );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingRule || !window.confirm(`Delete "${editingRule.name}"?`))
      return;
    try {
      await approvalWorkflowApi.deleteRule(editingRule.id);
      success("Approval rule deleted");
      await loadData();
      closePanel();
    } catch (err) {
      error(getErr(err));
    }
  };

  const handleToggle = async (rule: StoredRule) => {
    try {
      const { data } = await approvalWorkflowApi.setRuleStatus(
        rule.id,
        !rule.is_active,
      );
      setRules((c) => c.map((r) => (r.id === rule.id ? data : r)));
      success(`Rule ${data.is_active ? "activated" : "disabled"}`);
    } catch (err) {
      error(getErr(err));
    }
  };

  const handleStepEscSave = async (
    ruleId: number,
    stepId: number,
    minutes: number | null,
  ) => {
    setStepEscSaving((prev) => new Set(prev).add(stepId));
    try {
      await approvalWorkflowApi.updateStepEscalation(ruleId, stepId, minutes);
      setRules((prev) =>
        prev.map((r) =>
          r.id !== ruleId
            ? r
            : {
                ...r,
                steps: r.steps.map((s) =>
                  s.id !== stepId ? s : { ...s, escalation_minutes: minutes },
                ),
              },
        ),
      );
      success("Escalation time saved");
    } catch {
      error("Failed to save escalation time");
    } finally {
      setStepEscSaving((prev) => {
        const n = new Set(prev);
        n.delete(stepId);
        return n;
      });
    }
  };

  const handleRuleEscSave = async (rule: StoredRule) => {
    const nonLastSteps = rule.steps
      .slice()
      .sort((a, b) => a.step_no - b.step_no)
      .slice(0, -1);
    const badStep = nonLastSteps.find((s) => escErr(s.id));
    if (badStep) {
      focusById(`esc-${badStep.id}`);
      return;
    }
    setRuleEscSaving((prev) => new Set(prev).add(rule.id));
    try {
      await Promise.all(
        nonLastSteps.map((step) => {
          const currentVal =
            stepEscMinutes[step.id] !== undefined
              ? stepEscMinutes[step.id]
              : minutesToHoursDisplay(step.escalation_minutes);
          return approvalWorkflowApi.updateStepEscalation(
            rule.id,
            step.id,
            hoursInputToMinutes(currentVal),
          );
        }),
      );
      setRules((prev) =>
        prev.map((r) => {
          if (r.id !== rule.id) return r;
          const nonLastIds = new Set(
            r.steps
              .slice()
              .sort((a, b) => a.step_no - b.step_no)
              .slice(0, -1)
              .map((s) => s.id),
          );
          return {
            ...r,
            steps: r.steps.map((s) => {
              if (!nonLastIds.has(s.id)) return s;
              const val =
                stepEscMinutes[s.id] !== undefined
                  ? stepEscMinutes[s.id]
                  : minutesToHoursDisplay(s.escalation_minutes);
              return { ...s, escalation_minutes: hoursInputToMinutes(val) };
            }),
          };
        }),
      );
      success("Escalation times saved");
    } catch {
      error("Failed to save escalation times");
    } finally {
      setRuleEscSaving((prev) => {
        const n = new Set(prev);
        n.delete(rule.id);
        return n;
      });
    }
  };

  const hoursInputToMinutes = (val: string): number | null => {
    const parsed = parseFloat(val);
    if (isNaN(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 60);
  };

  const minutesToHoursDisplay = (mins: number | null | undefined): string =>
    mins ? String(parseFloat((mins / 60).toFixed(2))) : "";

  // per-step escalation time: blank = no SLA; otherwise a positive number of hours (max 1 year)
  const escErr = (stepId: number): string => {
    const v = stepEscMinutes[stepId];
    if (v === undefined) return "";
    const m = validate(v, ESC_HOURS_SPEC);
    if (m) return m;
    return v.trim() && Number(v) <= 0
      ? "Escalation time must be greater than 0 hours (leave blank for no SLA)."
      : "";
  };

  // ── Helpers for display ────────────────────────────────────────────────
  const describeRequester = (rule: StoredRule) => {
    if (rule.requester_type === "specific_user")
      return (
        rule.requester_user_name ||
        (rule.requester_user_id
          ? userLabelMap.get(rule.requester_user_id) ||
            `User #${rule.requester_user_id}`
          : "Specific User")
      );
    if (rule.requester_type === "group")
      return (
        rule.requester_group_name ||
        (rule.requester_group_id
          ? groupLabelMap.get(rule.requester_group_id) ||
            `Group #${rule.requester_group_id}`
          : "Group")
      );
    return humanize(rule.requester_role || "role");
  };

  const describeStep = (step: StoredStep) => {
    if (step.approver_type === "hierarchy_level")
      return step.approver_level
        ? `L${step.approver_level} Approver`
        : "Org Level";
    if (step.approver_type === "specific_user") {
      const name =
        step.approver_user_name ||
        (step.approver_user_id
          ? userLabelMap.get(step.approver_user_id) ||
            `User #${step.approver_user_id}`
          : "User");
      return step.approver_level ? `L${step.approver_level}: ${name}` : name;
    }
    return humanize(step.approver_role || "role");
  };

  const hasDuplicate = (entry: ModuleEntry) =>
    form.entries.some(
      (e) =>
        e.row_id !== entry.row_id &&
        e.module_key === entry.module_key &&
        e.module_key !== "" &&
        e.action_keys.length > 0 &&
        entry.action_keys.length > 0 &&
        e.action_keys.some((ak) => entry.action_keys.includes(ak)),
    );

  const pageStart = filteredRules.length
    ? (rulePage - 1) * RULES_PER_PAGE + 1
    : 0;
  const pageEnd = Math.min(rulePage * RULES_PER_PAGE, filteredRules.length);

  // ── Approval chain section subtitle ───────────────────────────────────
  const chainSubtitle = useMemo(() => {
    if (form.mode === "group" && form.groupFlowType === "hierarchy")
      return "Steps route up the org tree. Levels at or below the requester's org level are skipped automatically at runtime.";
    if (form.mode === "group" && form.groupFlowType === "sequential")
      return "Fixed approver chain applied to all group members regardless of their org level.";
    return "Define the ordered list of approvers. Requests must pass each step sequentially.";
  }, [form.mode, form.groupFlowType]);

  // ── Panel footer ───────────────────────────────────────────────────────
  const panelFooter = (
    <>
      {editingRule && (
        <Button
          variant="danger"
          onClick={handleDelete}
          icon={<Trash2 size={14} />}
        >
          Delete
        </Button>
      )}
      <div className="flex-1" />
      <Button variant="outline" onClick={() => closePanel()}>
        Cancel
      </Button>
      <Button onClick={handleSave} loading={saving}>
        {editingRule ? "Save Rule" : "Create Rule"}
      </Button>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Stats */}
      <div
        className={`grid gap-4 md:grid-cols-2 ${
          statCards.length >= 4 ? "xl:grid-cols-4" : "xl:grid-cols-3"
        }`}
      >
        {statCards.map(({ label, value, desc, color, Icon }) => (
          <Card key={label}>
            <div className="p-5 flex items-start justify-between">
              <div>
                <p
                  className={`text-xs font-semibold uppercase tracking-[0.18em] text-${color}-500`}
                >
                  {label}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-gray-900">
                  {value}
                </h3>
                <p className="mt-1 text-sm text-gray-500">{desc}</p>
              </div>
              <div
                className={`flex h-11 w-11 items-center justify-center rounded-2xl bg-${color}-50 text-${color}-600`}
              >
                <Icon size={18} />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {showEscalationOverrides && (
        <Card>
          <CardHeader
            title="Escalation Overrides"
            subtitle="Configure role-wise SLA overrides or set per-step escalation time on multi-step approval rules."
            actions={undefined}
          />

          {/* Sub-tab switcher — hidden for now (Role Wise tab disabled) */}

          {false && (
            <>
              <div className="grid gap-4 border-b border-gray-100 px-5 py-4 lg:grid-cols-[1.2fr_1.2fr_1fr_0.8fr_auto_auto]">
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Module
                  </p>
                  <SearchableSelect
                    options={moduleOptions}
                    value={escalationForm.module_key || null}
                    onChange={(value) =>
                      setEscalationForm((current) => ({
                        ...current,
                        module_key: value ? String(value) : "",
                        action_key:
                          current.module_key === value
                            ? current.action_key
                            : "",
                      }))
                    }
                    placeholder="Select module…"
                    clearable
                  />
                </div>

                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Action
                  </p>
                  <SearchableSelect
                    options={escalationActionOptions}
                    value={escalationForm.action_key || null}
                    onChange={(value) =>
                      setEscalationF({ action_key: value ? String(value) : "" })
                    }
                    placeholder="Select action…"
                    clearable
                  />
                </div>

                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Current Approver Role
                  </p>
                  <SearchableSelect
                    options={approverRoleOptions}
                    value={escalationForm.approver_role || null}
                    onChange={(value) =>
                      setEscalationF({
                        approver_role: value ? String(value) : "",
                      })
                    }
                    placeholder="Select role…"
                    clearable
                  />
                </div>

                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Hours
                  </p>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={escalationForm.escalation_hours}
                    onChange={(e) =>
                      setEscalationF({ escalation_hours: e.target.value })
                    }
                    placeholder="12"
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>

                <div className="flex items-end">
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                      Active
                    </p>
                    <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5">
                      <StatusToggle
                        enabled={escalationForm.is_active}
                        onToggle={() =>
                          setEscalationF({
                            is_active: !escalationForm.is_active,
                          })
                        }
                      />
                      <span className="text-xs text-gray-500">
                        {escalationForm.is_active ? "Yes" : "No"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-end">
                  <Button
                    onClick={handleSaveEscalationRule}
                    loading={escalationSaving}
                  >
                    {editingEscalationRuleId ? "Save Override" : "Add Override"}
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-5 py-3">Module</th>
                      <th className="px-5 py-3">Action</th>
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3">SLA</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Edit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-5 py-10 text-center text-gray-400"
                        >
                          Loading escalation overrides...
                        </td>
                      </tr>
                    ) : !escalationRules.length ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-5 py-10 text-center text-gray-400"
                        >
                          No escalation overrides configured yet.
                        </td>
                      </tr>
                    ) : (
                      escalationRules.map((rule) => (
                        <tr
                          key={rule.id}
                          className="border-b border-gray-100 text-gray-700 last:border-b-0"
                        >
                          <td className="px-5 py-4 font-medium text-gray-900">
                            {moduleLabelMap.get(rule.module_key) ||
                              humanize(rule.module_key)}
                          </td>
                          <td className="px-5 py-4">
                            {actionLabelMap.get(
                              `${rule.module_key}:${rule.action_key}`,
                            ) || humanize(rule.action_key)}
                          </td>
                          <td className="px-5 py-4">
                            <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                              {humanize(rule.approver_role)}
                            </span>
                          </td>
                          <td className="px-5 py-4 font-medium text-gray-900">
                            {formatHours(rule.escalation_minutes)}
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <StatusToggle
                                enabled={rule.is_active}
                                onToggle={() =>
                                  handleToggleEscalationRule(rule)
                                }
                              />
                              <span
                                className={`rounded-full px-3 py-1 text-xs font-medium ${
                                  rule.is_active
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-gray-100 text-gray-500"
                                }`}
                              >
                                {rule.is_active ? "Active" : "Inactive"}
                              </span>
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleEditEscalationRule(rule)}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 text-gray-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteEscalationRule(rule)}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 text-gray-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Approvals Wise */}
          {(() => {
            const multiStepRules = rules.filter((r) => r.steps.length > 1);
            return (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-5 py-3">Module</th>
                      <th className="px-5 py-3">Action</th>
                      <th className="px-5 py-3">Requester</th>
                      <th className="px-5 py-3">
                        Approval Chain &amp; Escalation (hrs)
                      </th>
                      <th className="px-5 py-3 text-right">Save</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-5 py-10 text-center text-gray-400"
                        >
                          Loading...
                        </td>
                      </tr>
                    ) : !multiStepRules.length ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-5 py-10 text-center text-gray-400"
                        >
                          No multi-step approval rules found. Rules with a
                          single approval step do not need per-step escalation.
                        </td>
                      </tr>
                    ) : (
                      multiStepRules.map((rule) => {
                        const isSaving = ruleEscSaving.has(rule.id);
                        return (
                          <tr
                            key={rule.id}
                            className="border-b border-gray-100 text-gray-700 last:border-b-0"
                          >
                            <td className="px-5 py-4 font-medium text-gray-900">
                              {moduleLabelMap.get(rule.module_key) ||
                                humanize(rule.module_key)}
                            </td>
                            <td className="px-5 py-4">
                              {actionLabelMap.get(
                                `${rule.module_key}:${rule.action_key}`,
                              ) || humanize(rule.action_key)}
                            </td>
                            <td className="px-5 py-4">
                              <span
                                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                                  rule.requester_type === "group"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : rule.requester_type === "specific_user"
                                      ? "bg-blue-50 text-blue-700"
                                      : "bg-gray-100 text-gray-600"
                                }`}
                              >
                                {rule.requester_type === "specific_user"
                                  ? "By User"
                                  : rule.requester_type === "group"
                                    ? "By Group"
                                    : humanize(rule.requester_type || "role")}
                              </span>
                              <p className="mt-1 text-xs text-gray-500">
                                {describeRequester(rule)}
                              </p>
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex flex-wrap items-start gap-2">
                                {rule.steps
                                  .slice()
                                  .sort((a, b) => a.step_no - b.step_no)
                                  .map((step, i) => {
                                    const isLast = i === rule.steps.length - 1;
                                    const currentVal =
                                      stepEscMinutes[step.id] !== undefined
                                        ? stepEscMinutes[step.id]
                                        : minutesToHoursDisplay(
                                            step.escalation_minutes,
                                          );
                                    return (
                                      <div
                                        key={`esc-${rule.id}-${step.id || i}`}
                                        className="flex items-start gap-1.5"
                                      >
                                        <div className="flex flex-col items-center gap-1">
                                          <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                                            {describeStep(step)}
                                          </span>
                                          {!isLast && (
                                            <div className="flex items-center gap-1">
                                              <Clock3
                                                size={10}
                                                className="text-gray-400"
                                              />
                                              <input
                                                id={`esc-${step.id}`}
                                                type="number"
                                                min="0.25"
                                                step="0.25"
                                                placeholder="hrs"
                                                title="Escalation time before advancing to next step (hours)"
                                                value={currentVal}
                                                onChange={(e) =>
                                                  setStepEscMinutes((prev) => ({
                                                    ...prev,
                                                    [step.id]: e.target.value,
                                                  }))
                                                }
                                                aria-invalid={
                                                  escErr(step.id)
                                                    ? true
                                                    : undefined
                                                }
                                                disabled={isSaving}
                                                className={`w-16 rounded border border-gray-200 px-1.5 py-0.5 text-center text-xs text-gray-700 focus:border-blue-400 focus:outline-none disabled:opacity-50 ${escErr(step.id) ? "err" : ""}`}
                                              />
                                              <span className="text-xs text-gray-400">
                                                hr
                                              </span>
                                            </div>
                                          )}
                                          {!isLast && (
                                            <FieldError
                                              id={`esc-${step.id}`}
                                              msg={escErr(step.id)}
                                            />
                                          )}
                                        </div>
                                        {i < rule.steps.length - 1 && (
                                          <ChevronRight
                                            size={12}
                                            className="mt-1 shrink-0 text-gray-300"
                                          />
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            </td>
                            <td className="px-5 py-4 text-right">
                              <button
                                type="button"
                                disabled={isSaving}
                                onClick={() => handleRuleEscSave(rule)}
                                className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                              >
                                {isSaving ? "Saving…" : "Save"}
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </Card>
      )}

      {/* Rules table */}
      {showApprovalMatrix && (
        <Card>
          <CardHeader
            title="Approval Matrix"
            subtitle={
              standalone
                ? "Configure group-aware approval chains for every module and action from one screen."
                : "Configure group-aware approval chains for every module and action."
            }
            actions={
              <>
                <Button
                  variant="outline"
                  onClick={loadData}
                  icon={<RefreshCw size={14} />}
                >
                  Refresh
                </Button>
                <Button onClick={openCreate} icon={<Plus size={14} />}>
                  Add Rule
                </Button>
              </>
            }
          />

          {/* Search */}
          <div className="border-b border-gray-100 px-5 py-3">
            <div className="relative max-w-sm">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                value={ruleSearch}
                onChange={(e) => setRuleSearch(e.target.value)}
                placeholder="Search by module, action, or name…"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-8 text-sm text-gray-800 outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
              />
              {ruleSearch && (
                <button
                  type="button"
                  onClick={() => setRuleSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {ruleSearch.trim() && (
              <p className="mt-1.5 text-xs text-gray-400">
                {filteredRules.length} of {rules.length} rules match
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-5 py-3">Module</th>
                  <th className="px-5 py-3">Action</th>
                  <th className="px-5 py-3">Requester</th>
                  <th className="px-5 py-3">Approval Chain</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Edit</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-gray-400"
                    >
                      Loading approval rules…
                    </td>
                  </tr>
                ) : !pageRules.length ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-gray-400"
                    >
                      {ruleSearch.trim()
                        ? `No rules match "${ruleSearch.trim()}"`
                        : "No approval rules configured yet."}
                    </td>
                  </tr>
                ) : (
                  pageRules.map((rule) => (
                    <tr
                      key={rule.id}
                      className="border-b border-gray-100 text-gray-700 last:border-b-0"
                    >
                      <td className="px-5 py-4 font-medium text-gray-900">
                        {moduleLabelMap.get(rule.module_key) ||
                          humanize(rule.module_key)}
                      </td>
                      <td className="px-5 py-4">
                        {actionLabelMap.get(
                          `${rule.module_key}:${rule.action_key}`,
                        ) || humanize(rule.action_key)}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                            rule.requester_type === "group"
                              ? "bg-emerald-50 text-emerald-700"
                              : rule.requester_type === "specific_user"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {rule.requester_type === "specific_user"
                            ? "By User"
                            : rule.requester_type === "group"
                              ? "By Group"
                              : humanize(rule.requester_type || "role")}
                        </span>
                        <p className="mt-1 text-xs text-gray-500">
                          {describeRequester(rule)}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        {Array.isArray(rule.steps) && rule.steps.length ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {rule.steps
                              .slice()
                              .sort((a, b) => a.step_no - b.step_no)
                              .map((step, i) => (
                                <div
                                  key={`${rule.id}-${step.id || i}`}
                                  className="flex items-center gap-1"
                                >
                                  <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                                    {describeStep(step)}
                                  </span>
                                  {i < rule.steps.length - 1 && (
                                    <ChevronRight
                                      size={12}
                                      className="text-gray-300"
                                    />
                                  )}
                                </div>
                              ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">
                            No steps
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <StatusToggle
                            enabled={rule.is_active}
                            onToggle={() => handleToggle(rule)}
                          />
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              rule.is_active
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-gray-100 text-gray-500"
                            }`}
                          >
                            {rule.is_active ? "Active" : "Inactive"}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(rule)}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 text-gray-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                        >
                          <Pencil size={14} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {filteredRules.length > RULES_PER_PAGE && (
            <div className="flex items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/50 px-5 py-3">
              <p className="text-xs font-medium text-gray-500">
                {pageStart}–{pageEnd} of {filteredRules.length}
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={rulePage === 1}
                  onClick={() => setRulePage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="text-sm font-semibold text-gray-600">
                  Page {rulePage} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={rulePage >= totalPages}
                  onClick={() =>
                    setRulePage((p) => Math.min(totalPages, p + 1))
                  }
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── Slide Panel ────────────────────────────────────────────────── */}
      {showApprovalMatrix && (
        <SlidePanel
          open={panelOpen}
          onClose={closePanel}
          title={editingRule ? "Edit Approval Rule" : "New Approval Rule"}
          subtitle={
            editingRule
              ? "Update this rule's configuration."
              : "Define who can request and who must approve."
          }
          width="w-full"
          insetLeft={sidebarCollapsed ? "60px" : "220px"}
          footer={panelFooter}
        >
          <div className="space-y-6 pb-4">
            {/* ── ① Rule Details ─────────────────────────────────────── */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <SectionHeader
                n={1}
                title="Rule Details"
                subtitle="Give this rule a name and set its initial status."
              />
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">
                    Rule Name
                  </label>
                  <input
                    id="ar-name"
                    value={form.name}
                    onChange={(e) => {
                      setF({ name: e.target.value });
                      setRuleServerErrs((x) => {
                        const n = { ...x };
                        delete n["ar-name"];
                        return n;
                      });
                    }}
                    aria-invalid={rErr("ar-name") ? true : undefined}
                    placeholder="e.g. Tender Approval – Sales Team"
                    className={`w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${rErr("ar-name") ? "err" : ""}`}
                  />
                  <FieldError id="ar-name" msg={rErr("ar-name")} />
                  {!rErr("ar-name") && (
                    <p className="mt-1 text-xs text-gray-400">
                      Optional — auto-generated if left blank.
                    </p>
                  )}
                </div>
                <div className="flex items-end">
                  <div className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        Rule Status
                      </p>
                      <p className="text-xs text-gray-500">
                        {form.is_active
                          ? "Active — routes live approvals"
                          : "Inactive — not applied yet"}
                      </p>
                    </div>
                    <StatusToggle
                      enabled={form.is_active}
                      onToggle={() => setF({ is_active: !form.is_active })}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── ② Module & Actions ─────────────────────────────────── */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <SectionHeader
                n={2}
                title="Module & Actions"
                subtitle="Select which modules and actions this rule applies to. One rule is created per combination."
              />

              {form.entries.length === 0 && (
                <div className="mb-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-8">
                  <p className="text-sm text-gray-400 font-medium">
                    No modules added yet
                  </p>
                  <p className="text-xs text-gray-300 mt-0.5">
                    Click "Add Module" to begin
                  </p>
                </div>
              )}

              <div className="space-y-3">
                {form.entries.map((entry, idx) => {
                  const mod = meta.modules.find(
                    (m) => m.key === entry.module_key,
                  );
                  const dup = hasDuplicate(entry);
                  return (
                    <div
                      key={entry.row_id}
                      className={`grid grid-cols-[auto_1fr_auto_1fr_auto_auto] items-center gap-3 rounded-xl border bg-white p-3 ${
                        dup ? "border-red-300 bg-red-50/30" : "border-gray-200"
                      }`}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gray-100 text-xs font-bold text-gray-500">
                        {idx + 1}
                      </span>
                      <div id={`ar-entry-${entry.row_id}-module`}>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                          Module
                        </p>
                        <SearchableSelect
                          options={moduleOptions}
                          value={entry.module_key}
                          onChange={(v) =>
                            changeEntryModule(entry.row_id, String(v))
                          }
                          placeholder="Select module"
                          error={rErr(`ar-entry-${entry.row_id}-module`)}
                        />
                      </div>
                      <ChevronRight size={14} className="text-gray-300 mt-4" />
                      <div id={`ar-entry-${entry.row_id}-actions`}>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                          Actions{" "}
                          {entry.action_keys.length > 0 && (
                            <span className="ml-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">
                              {entry.action_keys.length}
                            </span>
                          )}
                        </p>
                        {!entry.module_key ? (
                          <p className="py-2.5 text-xs text-gray-400">
                            Select module first
                          </p>
                        ) : (
                          <MultiSearchableSelect
                            options={(mod?.actions || []).map((a) => ({
                              value: a.key,
                              label: a.label,
                            }))}
                            value={entry.action_keys}
                            onChange={(vals) =>
                              updateEntry(entry.row_id, {
                                action_keys: vals.map(String),
                              })
                            }
                            placeholder="Select actions"
                            error={rErr(`ar-entry-${entry.row_id}-actions`)}
                          />
                        )}
                      </div>
                      {dup ? <DupBadge /> : <span />}
                      <button
                        type="button"
                        onClick={() => removeEntry(entry.row_id)}
                        className="mt-4 rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                id="ar-entries"
                onClick={addEntry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border-2 border-dashed border-blue-300 bg-white px-4 py-2 text-xs font-semibold text-blue-600 hover:border-blue-400 hover:bg-blue-50 transition-all"
              >
                <Plus size={13} /> Add Module
              </button>
              <FieldError id="ar-entries" msg={rErr("ar-entries")} />

              {form.entries.length > 0 && allPairs.length > 0 && (
                <p className="mt-2 text-[11px] text-gray-400">
                  {allPairs.length} rule{allPairs.length !== 1 ? "s" : ""} will
                  be created.
                </p>
              )}
            </div>

            {/* ── ③ Who Can Request ──────────────────────────────────── */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <SectionHeader
                n={3}
                title="Who Can Request"
                subtitle="Define which users or group members are allowed to submit approval requests."
              />

              {/* Mode toggle */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                {[
                  {
                    mode: "user" as const,
                    Icon: User,
                    title: "By User",
                    desc: "Specific named users can submit requests",
                  },
                  {
                    mode: "group" as const,
                    Icon: Users,
                    title: "By Group",
                    desc: "Any member of a selected org group",
                  },
                ].map(({ mode, Icon, title, desc }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => changeMode(mode)}
                    className={`flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all ${
                      form.mode === mode
                        ? "border-blue-500 bg-blue-50 shadow-sm"
                        : "border-gray-200 bg-white hover:border-blue-200 hover:bg-blue-50/30"
                    }`}
                  >
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                        form.mode === mode
                          ? "bg-blue-600 text-white"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      <Icon size={16} />
                    </div>
                    <div>
                      <p
                        className={`text-sm font-bold ${form.mode === mode ? "text-blue-900" : "text-gray-800"}`}
                      >
                        {title}
                      </p>
                      <p
                        className={`text-xs mt-0.5 ${form.mode === mode ? "text-blue-700" : "text-gray-500"}`}
                      >
                        {desc}
                      </p>
                    </div>
                    {form.mode === mode && (
                      <div className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600">
                        <CheckCircle2 size={12} className="text-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>

              {/* User mode: multi-select requesters */}
              {form.mode === "user" && (
                <div id="ar-requesters">
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">
                    Select Requesters
                  </label>
                  <MultiSearchableSelect
                    options={userOptions}
                    value={form.requester_user_ids}
                    onChange={(vals) =>
                      setF({ requester_user_ids: vals.map(String) })
                    }
                    placeholder="Search and select users…"
                    error={rErr("ar-requesters")}
                  />
                  {form.requester_user_ids.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {form.requester_user_ids.map((uid) => {
                        const u = meta.users.find((u) => String(u.id) === uid);
                        return u ? (
                          <span
                            key={uid}
                            className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800"
                          >
                            {u.full_name}
                            <button
                              type="button"
                              onClick={() =>
                                setF({
                                  requester_user_ids:
                                    form.requester_user_ids.filter(
                                      (id) => id !== uid,
                                    ),
                                })
                              }
                              className="text-blue-400 hover:text-blue-700"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  <p className="mt-1.5 text-xs text-gray-400">
                    These users will be able to submit requests that follow this
                    approval chain.
                  </p>
                </div>
              )}

              {/* Group mode: multi-select + org tree */}
              {form.mode === "group" && (
                <div id="ar-group">
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">
                    Select Group(s)
                  </label>
                  <MultiSearchableSelect
                    options={groupOptions}
                    value={form.requester_group_ids}
                    onChange={(vals) => {
                      void changeGroups(vals.map(String));
                    }}
                    placeholder="Search and select one or more groups…"
                  />
                  {form.requester_group_ids.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {form.requester_group_ids.map((gid) => {
                        const g = meta.groups.find(
                          (gr) => String(gr.id) === gid,
                        );
                        if (!g) return null;
                        const sharedWith = form.requester_group_ids
                          .filter((otherId) => otherId !== gid)
                          .map((otherId) =>
                            meta.groups.find((gr) => String(gr.id) === otherId),
                          )
                          .filter(
                            (gr): gr is ApprovalGroup =>
                              !!gr && !!gr.lead_id && gr.lead_id === g.lead_id,
                          );
                        return (
                          <span
                            key={gid}
                            title={
                              sharedWith.length
                                ? `${g.lead_name} also heads: ${sharedWith.map((gr) => gr.name).join(", ")}`
                                : undefined
                            }
                            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800"
                          >
                            <Users size={11} />
                            {g.name}
                            {g.lead_name && (
                              <span className="font-normal text-emerald-600/80">
                                · Head: {g.lead_name}
                                {sharedWith.length > 0 && " ★"}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void changeGroups(
                                  form.requester_group_ids.filter(
                                    (id) => id !== gid,
                                  ),
                                )
                              }
                              className="text-emerald-500 hover:text-emerald-800"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {form.requester_group_ids.length > 1 && (
                    <p className="mt-1.5 text-xs text-emerald-600">
                      One policy, {form.requester_group_ids.length} groups — a
                      separate rule is saved per group below, each with the same
                      approval chain. A head marked ★ already leads more than
                      one of the groups you picked, so their pending approvals
                      from all of them land in the same place without anything
                      extra to configure.
                    </p>
                  )}

                  {groupLevelsLoading && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                      <RefreshCw size={12} className="animate-spin" /> Loading
                      group hierarchy…
                    </div>
                  )}

                  {!groupLevelsLoading &&
                    form.requester_group_ids.length > 0 &&
                    !groupLevels.length && (
                      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                        <p className="text-xs text-gray-400">
                          No hierarchy found for this group. You can add steps
                          manually below.
                        </p>
                      </div>
                    )}

                  {/* Org level summary pills — shown after hierarchy loads */}
                  {!groupLevelsLoading && groupLevels.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {[...groupLevels]
                        .sort((a, b) => a.level - b.level)
                        .map((lvl) => {
                          const pal = lvlPalette(lvl.level);
                          return (
                            <span
                              key={lvl.level}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${pal.soft}`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${pal.dot}`}
                              />
                              {lvl.level_label}
                              <span className="opacity-60">
                                · {lvl.user_count}
                              </span>
                            </span>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── ④ Approval Chain ───────────────────────────────────── */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <SectionNum n={4} active />
                  <div>
                    <p className="text-sm font-bold text-gray-900">
                      Approval Chain
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {chainSubtitle}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    form.mode === "group" && form.groupFlowType === "hierarchy"
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-blue-50 text-blue-600"
                  }`}
                >
                  {form.steps.length} step{form.steps.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* ── Group flow type toggle ─────────────────────────── */}
              {form.mode === "group" && form.requester_group_ids.length > 0 && (
                <div className="mb-5 grid grid-cols-2 gap-3">
                  {[
                    {
                      type: "hierarchy" as const,
                      Icon: GitBranch,
                      title: "Org hierarchy flow",
                      desc: "Skips levels at or below the requester automatically",
                    },
                    {
                      type: "sequential" as const,
                      Icon: ListOrdered,
                      title: "Custom workflow",
                      desc: "Fixed approver chain for all group members",
                    },
                  ].map(({ type, Icon, title, desc }) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => changeGroupFlowType(type)}
                      className={`flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all ${
                        form.groupFlowType === type
                          ? "border-emerald-500 bg-emerald-50 shadow-sm"
                          : "border-gray-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/30"
                      }`}
                    >
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                          form.groupFlowType === type
                            ? "bg-emerald-600 text-white"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        <Icon size={15} />
                      </div>
                      <div>
                        <p
                          className={`text-sm font-bold ${
                            form.groupFlowType === type
                              ? "text-emerald-900"
                              : "text-gray-800"
                          }`}
                        >
                          {title}
                        </p>
                        <p
                          className={`text-xs mt-0.5 ${
                            form.groupFlowType === type
                              ? "text-emerald-700"
                              : "text-gray-500"
                          }`}
                        >
                          {desc}
                        </p>
                      </div>
                      {form.groupFlowType === type && (
                        <div className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600">
                          <CheckCircle2 size={12} className="text-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Flow preview strip */}
              {form.steps.length > 0 && (
                <div className="mb-5 flex flex-wrap items-center gap-1.5">
                  {form.steps.map((step, i) => {
                    const lvlInfo = groupLevels.find(
                      (l) => l.level === step.approver_level,
                    );
                    const isHierarchyStep =
                      form.mode === "group" &&
                      form.groupFlowType === "hierarchy";
                    const label = isHierarchyStep
                      ? (lvlInfo?.level_label ??
                        (step.approver_level ? `L${step.approver_level}` : "?"))
                      : step.approver_user_id
                        ? (meta.users.find(
                            (u) => String(u.id) === step.approver_user_id,
                          )?.full_name ?? `User #${step.approver_user_id}`)
                        : `Step ${i + 1}`;
                    const pal =
                      isHierarchyStep && step.approver_level
                        ? lvlPalette(step.approver_level)
                        : null;
                    return (
                      <div
                        key={step.row_id}
                        className="flex items-center gap-1"
                      >
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                            pal
                              ? `${pal.soft} border`
                              : "bg-blue-50 border border-blue-100 text-blue-700"
                          }`}
                        >
                          <span className="opacity-60">#{i + 1}</span> {label}
                        </span>
                        {i < form.steps.length - 1 && (
                          <ChevronRight size={12} className="text-gray-300" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Step list */}
              <div className="space-y-2" id="ar-steps">
                {form.steps.length === 0 && (
                  <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-8">
                    <p className="text-sm text-gray-400 font-medium">
                      {form.mode === "group" && !form.requester_group_ids.length
                        ? "Select a group first to auto-populate the approval chain."
                        : "No steps yet. Add a step below."}
                    </p>
                  </div>
                )}

                {form.steps.map((step, idx) => {
                  const isDragging = dragging === idx;
                  const isOver = dragOver === idx;
                  const lvlInfo = groupLevels.find(
                    (l) => l.level === step.approver_level,
                  );
                  const pal = step.approver_level
                    ? lvlPalette(step.approver_level)
                    : null;
                  const isL1 = lvlInfo?.is_l1 || step.approver_level === 1;
                  // A step is a "hierarchy step" if group mode + hierarchy flow type + has approver_level
                  const isHierarchyStep =
                    form.mode === "group" && form.groupFlowType === "hierarchy";

                  return (
                    <div
                      key={step.row_id}
                      draggable
                      onDragStart={(e) => onDragStart(e, idx)}
                      onDragOver={(e) => onDragOver(e, idx)}
                      onDragLeave={onDragLeave}
                      onDrop={(e) => onDrop(e, idx)}
                      onDragEnd={onDragEnd}
                      className={`rounded-xl border-2 bg-white transition-all duration-150 select-none ${
                        isDragging
                          ? "border-blue-300 opacity-50 shadow-lg"
                          : isOver
                            ? "border-blue-400 scale-[1.01] shadow-md"
                            : "cursor-grab border-gray-200 hover:border-gray-300 hover:shadow-sm"
                      }`}
                    >
                      {/* Step header */}
                      <div
                        className={`flex items-center justify-between rounded-t-xl border-b border-gray-100 px-4 py-2.5 ${
                          isHierarchyStep && pal
                            ? "bg-transparent"
                            : "bg-gray-50/60"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <GripVertical
                            size={14}
                            className="text-gray-300 shrink-0"
                          />
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white border border-gray-200 text-xs font-bold text-gray-600 shadow-sm">
                            {idx + 1}
                          </span>

                          {/* Hierarchy mode: show level badge */}
                          {isHierarchyStep && step.approver_level && (
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${pal ? pal.pill : "bg-gray-200 text-gray-600"}`}
                            >
                              {lvlInfo?.level_label ??
                                `L${step.approver_level}`}
                            </span>
                          )}

                          {/* Sequential or user mode label */}
                          {!isHierarchyStep && (
                            <span className="text-xs font-semibold text-gray-600">
                              Approver
                            </span>
                          )}

                          {/* L1 / CEO badge */}
                          {isHierarchyStep && isL1 && (
                            <span className="text-[10px] font-bold uppercase text-violet-500 tracking-wide">
                              Final Sign-off
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeStep(step.row_id)}
                          disabled={
                            form.mode === "user" && form.steps.length <= 1
                          }
                          className="text-gray-300 hover:text-red-500 disabled:opacity-30 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {/* Step body */}
                      <div className="p-4">
                        {/* ── HIERARCHY GROUP MODE ───────────────── */}
                        {isHierarchyStep && (
                          <div
                            id={`ar-step-${step.row_id}-approver`}
                            className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3"
                          >
                            <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600">
                              Resolved at Runtime
                            </p>
                            <p className="text-sm font-semibold text-emerald-800">
                              Approver will be resolved from org tree using{" "}
                              {levelOptions.find(
                                (o) => Number(o.value) === step.approver_level,
                              )?.label || `L${step.approver_level}`}
                            </p>
                            <p className="mt-1 text-xs text-emerald-700/80">
                              No approver selection is needed here. You can
                              reorder the step using drag and drop, or remove it
                              using the delete icon.
                            </p>
                            <FieldError
                              id={`ar-step-${step.row_id}-approver`}
                              msg={rErr(`ar-step-${step.row_id}-approver`)}
                            />
                          </div>
                        )}

                        {/* ── USER MODE or SEQUENTIAL GROUP MODE ─── */}
                        {!isHierarchyStep && (
                          <div className="grid grid-cols-[1fr_auto_auto] gap-4 items-end">
                            <div id={`ar-step-${step.row_id}-approver`}>
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                                Approver
                              </p>
                              <SearchableSelect
                                options={userOptions}
                                value={step.approver_user_id || null}
                                onChange={(v) =>
                                  patchStep(step.row_id, {
                                    approver_user_id: v ? String(v) : "",
                                  })
                                }
                                placeholder="Select approver…"
                                clearable
                                error={rErr(`ar-step-${step.row_id}-approver`)}
                              />
                            </div>
                            <div className="text-right">
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                                Stop on Reject
                              </p>
                              <div className="flex items-center gap-2 pt-1.5">
                                <StatusToggle
                                  enabled={step.stop_on_reject}
                                  onToggle={() =>
                                    patchStep(step.row_id, {
                                      stop_on_reject: !step.stop_on_reject,
                                    })
                                  }
                                />
                                <span className="text-xs text-gray-500">
                                  {step.stop_on_reject ? "Yes" : "No"}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add step (user / sequential-group) — or add one more org level by hand
                to this specific policy's hierarchy (remove uses each step's own trash icon) */}
              {form.mode === "group" &&
              form.groupFlowType === "hierarchy" &&
              form.requester_group_ids.length > 0 ? (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1">
                    <SearchableSelect
                      options={levelOptions.filter(
                        (o) =>
                          !form.steps.some(
                            (s) => String(s.approver_level) === o.value,
                          ),
                      )}
                      value={addLevelChoice}
                      onChange={(v) => setAddLevelChoice(v ? String(v) : null)}
                      placeholder="Add another org level to this chain…"
                      clearable
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!addLevelChoice}
                    onClick={addHierarchyLevel}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border-2 border-dashed border-emerald-300 px-4 py-2.5 text-xs font-semibold text-emerald-600 hover:border-emerald-400 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40 transition-all"
                  >
                    <Plus size={13} /> Add Level
                  </button>
                </div>
              ) : (
                (form.mode === "user" ||
                  (form.mode === "group" &&
                    form.requester_group_ids.length > 0 &&
                    form.groupFlowType !== "hierarchy")) && (
                  <button
                    type="button"
                    onClick={addStep}
                    className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed py-3 text-xs font-semibold transition-all ${
                      form.mode === "group"
                        ? "border-emerald-300 text-emerald-500 hover:border-emerald-400 hover:bg-emerald-50"
                        : "border-blue-300 text-blue-500 hover:border-blue-400 hover:bg-blue-50"
                    }`}
                  >
                    <Plus size={14} />
                    {form.mode === "group" ? "Add Extra Step" : "Add Step"}
                  </button>
                )
              )}

              <FieldError id="ar-steps" msg={rErr("ar-steps")} />

              {form.steps.length > 1 && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-400">
                  <GripVertical size={11} /> Drag steps to reorder the approval
                  sequence
                </p>
              )}
            </div>
          </div>
        </SlidePanel>
      )}
    </div>
  );
}
