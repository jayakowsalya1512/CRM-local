import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import api from "@/services/api";
import { useToast } from "@/components/ui/FormComponents";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { vEmail } from "@/utils/validation";
import { useUIStore } from "@/store";
import { useModuleName } from "@/context/ModuleLabelsContext";
import { useFormConfig, type FormFieldConfig } from "@/hooks/useFormConfig";
import { CustomFields } from "@/components/form/CustomFields";
import { Ic } from "@/components/crm/kit";
import "@/pages/notifications/inbox.css";
import "@/pages/customers/c360.css";
import "@/pages/leads/leads.css";

// ─── Role config ──────────────────────────────────────────────────────────────

interface RoleDefinition {
  id: number;
  name: string;
  display_name?: string | null;
  level?: number | null;
  description?: string | null;
  is_active?: boolean;
  permission_count?: number | null;
}

const DEFAULT_ROLE_OPTIONS = [
  { value: "admin", label: "Admin", subtitle: "Full system access" },
  { value: "ceo", label: "CEO", subtitle: "All operations" },
  {
    value: "project_lead",
    label: "Project Lead",
    subtitle: "Project approvals and tracking",
  },
  { value: "vp", label: "Vice President", subtitle: "Vice President" },
  { value: "manager", label: "Sales Head", subtitle: "Team + reports" },
  {
    value: "sales",
    label: "Sales Executive",
    subtitle: "Own leads & customers",
  },
  { value: "accounts", label: "Accounts", subtitle: "Finance & reports" },
  { value: "support", label: "Support", subtitle: "View only" },
];

const MULTI_REGION_STATE_ROLES = ["vp", "manager"];

const DEPTS = [
  "Sales",
  "Support",
  "Accounts",
  "Operations",
  "Management",
  "IT",
  "HR",
];

const NO_ORG_ROLES = ["admin", "ceo"];
const REGION_STATE_ROLES = [
  "sales",
  "manager",
  "vp",
  "support",
  "accounts",
  "project_lead",
];
const TARGET_ROLES = ["vp", "manager", "sales", "support", "accounts"];

function humanizeRoleName(role: string) {
  return role
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeRoleDefinitions(data: unknown): RoleDefinition[] {
  const roles = Array.isArray(data) ? data : [];
  return roles
    .filter(
      (role): role is RoleDefinition =>
        !!role &&
        typeof role === "object" &&
        typeof (role as RoleDefinition).name === "string",
    )
    .sort((a, b) => {
      const levelA = Number(a.level ?? 999);
      const levelB = Number(b.level ?? 999);
      if (levelA !== levelB) return levelA - levelB;
      return (a.display_name || a.name).localeCompare(b.display_name || b.name);
    });
}

const fmtTarget = (n: number) =>
  n >= 10000000
    ? `₹${(n / 10000000).toFixed(1)}Cr`
    : n >= 100000
      ? `₹${(n / 100000).toFixed(1)}L`
      : n >= 1000
        ? `₹${(n / 1000).toFixed(0)}K`
        : `₹${n.toLocaleString("en-IN")}`;

const numberToWords = (num: number): string => {
  if (!num) return "";

  const a = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];

  const b = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  const inWords = (n: number): string => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : "");
    if (n < 1000)
      return (
        a[Math.floor(n / 100)] +
        " Hundred" +
        (n % 100 ? " " + inWords(n % 100) : "")
      );
    if (n < 100000)
      return (
        inWords(Math.floor(n / 1000)) +
        " Thousand" +
        (n % 1000 ? " " + inWords(n % 1000) : "")
      );
    if (n < 10000000)
      return (
        inWords(Math.floor(n / 100000)) +
        " Lakh" +
        (n % 100000 ? " " + inWords(n % 100000) : "")
      );
    return (
      inWords(Math.floor(n / 10000000)) +
      " Crore" +
      (n % 10000000 ? " " + inWords(n % 10000000) : "")
    );
  };

  return inWords(num).trim() + " Only";
};

// ─── RoleBadge ────────────────────────────────────────────────────────────────

function RoleBadge({ role, label }: { role?: string | null; label?: string }) {
  const roleName = String(role ?? "");
  const displayLabel =
    label || (roleName ? humanizeRoleName(roleName) : "No Role");
  return (
    <span className="pill ac">
      <Ic n="shield" size={11} /> {displayLabel}
    </span>
  );
}

function strVal(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "target" in v)
    return (v as React.ChangeEvent<HTMLInputElement>).target.value;
  return "";
}

const numericOnly = (v: string) => v.replace(/[^0-9.]/g, "");

const emptyForm = () => ({
  username: "",
  email: "",
  full_name: "",
  role: "sales",
  department: "Sales",
  designation: "",
  phone: "",
  branch: "",
  employee_code: "",
  reporting_manager_id: null as number | null,
  region_id: null as number | number[] | null,
  state_id: null as number | number[] | null,
  target: "" as string,
  password: "",
  confirm_password: "",
  is_active: true,
});

interface UserFieldMeta {
  label: string;
  required: boolean;
  visible: boolean;
  sortOrder: number;
}

type OrderedUserSectionItem =
  | { kind: "builtin"; key: string; sortOrder: number; defaultOrder: number }
  | {
      kind: "custom";
      field: FormFieldConfig;
      sortOrder: number;
      defaultOrder: number;
    };

const BASIC_FIELD_KEYS = [
  "full_name",
  "username",
  "email",
  "employee_code",
  "phone",
] as const;

const ROLE_FIELD_KEYS = [
  "role",
  "department",
  "designation",
  "branch",
] as const;

const REGION_FIELD_KEYS = ["region_id", "state_id"] as const;

const TARGET_FIELD_KEYS = ["target"] as const;

const STATUS_FIELD_KEYS = ["is_active"] as const;

const USER_FORM_TIPS = [
  "Required fields are marked with *.",
  "Everything you enter here can be changed later.",
  "Username can't be changed once the user is created.",
  "Region, state and target only apply to field and sales roles.",
];

const normalizeMobileNumber = (value: string) =>
  value.replace(/\D/g, "").slice(0, 10);
const hasSpecialCharacter = (value: string) => /[^A-Za-z0-9\s]/.test(value);
/** Error value that only turns the field red (the toast explains the problem). */
const FIELD_HIGHLIGHT = " ";
/** Indian mobile number: exactly 10 digits. */
const hasValidMobileNumber = (value: string) => /^\d{10}$/.test(String(value ?? "").trim());
/** Problem with one field of the user form ('' = fine) – the rules handleSave applies. */
const fieldIssue = (f: Record<string, any>, k: string, isEdit: boolean): string => {
  const v = String(f[k] ?? "");
  switch (k) {
    case "full_name":
    case "username":
      return v.trim() ? "" : FIELD_HIGHLIGHT;
    case "email":
      return !v.trim() || vEmail(v) ? FIELD_HIGHLIGHT : "";
    case "phone":
      return v && !hasValidMobileNumber(v) ? FIELD_HIGHLIGHT : "";
    case "password":
      return isEdit ? "" : !v || passwordMessage(v) ? FIELD_HIGHLIGHT : "";
    case "confirm_password":
      return isEdit ? "" : !v || v !== String(f.password ?? "") ? FIELD_HIGHLIGHT : "";
    default:
      return "";
  }
};

// ── field validation (shared rules in utils/validation.ts; backend mirrors them) ──
/** Form ids in on-screen order – the first invalid one is focused on save. */
const FIELD_ORDER = [
  "full_name",
  "username",
  "email",
  "employee_code",
  "phone",
  "role",
  "department",
  "designation",
  "branch",
  "region_id",
  "state_id",
  "target",
  "add_amount",
  "password",
  "confirm_password",
];
const FIELD_SECTION: Record<string, string> = {
  full_name: "basic",
  username: "basic",
  email: "basic",
  employee_code: "basic",
  phone: "basic",
  role: "role",
  department: "role",
  designation: "role",
  branch: "role",
  region_id: "region",
  state_id: "region",
  target: "target",
  add_amount: "target",
  password: "password",
  confirm_password: "password",
};
const passwordMessage = (pw: string) => {
  if (!pw) return "";
  const c = getPasswordChecks(pw);
  if (!c.minLength) return "Password must be at least 8 characters.";
  if (!c.uppercase) return "Password must include an uppercase letter.";
  if (!c.lowercase) return "Password must include a lowercase letter.";
  if (!c.number) return "Password must include a number.";
  if (!c.special) return "Password must include a special character.";
  return "";
};
/** Map a plain-text server error (e.g. "Username already exists") onto the field it is about. */
const fieldForServerMessage = (msg: string): string | null => {
  const m = msg.toLowerCase();
  if (m.includes("username")) return "username";
  if (m.includes("email")) return "email";
  if (m.includes("mobile") || m.includes("phone")) return "phone";
  if (m.includes("confirm password") || m.includes("must match"))
    return "confirm_password";
  if (m.includes("password")) return "password";
  if (m.includes("role")) return "role";
  return null;
};

const getPasswordChecks = (password: string) => ({
  minLength: password.length >= 8,
  uppercase: /[A-Z]/.test(password),
  lowercase: /[a-z]/.test(password),
  number: /\d/.test(password),
  special: hasSpecialCharacter(password),
});

function parseIdList(value: any): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number).filter(Boolean);
  return String(value)
    .split(",")
    .map((x) => Number(x.trim()))
    .filter(Boolean);
}

function firstId(value: number | number[] | null): number | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function isMultiRegionStateRole(role: string) {
  return MULTI_REGION_STATE_ROLES.includes(role);
}

// Prototype-styled multi-select: an `.in` trigger + a portaled checkbox list, same visual language as the
// rest of the form. Portals into `.crm-shell` (not document.body) so it inherits the --bw-* theme tokens.
function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  options: { value: number; label: string }[];
  value: number[];
  onChange: (value: number[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menuRect, setMenuRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const selected = options.filter((o) => value.includes(Number(o.value)));

  const toggle = (id: number) => {
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
    );
  };

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect)
        setMenuRect({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div>
      <label className="lb">{label}</label>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="in"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected.length ? (
            selected.length <= 2 ? (
              selected.map((item) => item.label).join(", ")
            ) : (
              `${selected.length} selected`
            )
          ) : (
            <span className="mu">{placeholder}</span>
          )}
        </span>
        <ChevronDown size={14} className="mu" style={{ flex: "none" }} />
      </button>

      {open &&
        menuRect &&
        createPortal(
          <div
            ref={listRef}
            style={{
              position: "fixed",
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
              zIndex: 9999,
            }}
            className="panel"
          >
            <div className="pb" style={{ maxHeight: 220, overflowY: "auto" }}>
              {options.map((opt) => (
                <label
                  key={opt.value}
                  className="row"
                  style={{ gap: 8, padding: "6px 4px", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={value.includes(Number(opt.value))}
                    onChange={() => toggle(Number(opt.value))}
                  />
                  <span style={{ fontSize: 13 }}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>,
          document.querySelector(".crm-shell") ?? document.body,
        )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function UserFormPage() {
  const { label: usersLabel, singular: userSingular } = useModuleName("users");
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { id: routeUserId } = useParams();
  const routeState = location.state as { user?: any } | null;

  const wasCollapsed = useRef(sidebarCollapsed);
  useEffect(() => {
    setSidebarCollapsed(true);
    return () => {
      setSidebarCollapsed(wasCollapsed.current);
    };
  }, [setSidebarCollapsed]);

  const isEdit = !!routeUserId;
  const [editUser, setEditUser] = useState<any>(routeState?.user ?? null);

  const [form, setForm] = useState(emptyForm());
  const fe = useFieldErrors();
  const errs = fe.errors;
  const setFieldErrors = fe.setErrors;
  const clearFieldError = (key: string) => fe.clear(key);
  /** Space string: red border without a message under the field. */
  const errProp = (key: string): string | undefined => (errs[key] ? " " : undefined);
  /** While typing: a field already marked red is re-checked and clears as soon as it is valid. */
  const check = (next: Record<string, any>, k: string, _mode: "change" | "blur") => {
    if (!errs[k]) return;
    const msg = fieldIssue(next, k, !!editUser);
    if (msg) fe.setError(k, msg);
    else fe.clear(k);
  };
  const [saving, setSaving] = useState(false);
  const [customData, setCustomData] = useState<Record<string, unknown>>({});
  const { fields: formConfigFields } = useFormConfig("users");
  const [targetMode, setTargetMode] = useState<"add" | "replace">("replace");
  const [addAmount, setAddAmount] = useState("");
  const { success, error: showError } = useToast();

  const [regions, setRegions] = useState<{ value: number; label: string }[]>(
    [],
  );
  const [states, setStates] = useState<
    { value: number; label: string; region_id?: number }[]
  >([]);
  const [roleDefinitions, setRoleDefinitions] = useState<RoleDefinition[]>([]);

  // Fetch user from API if editing but no state was passed
  useEffect(() => {
    if (isEdit && !routeState?.user) {
      api
        .get(`/auth/users/${routeUserId}`)
        .then((r) => {
          const u = r.data;
          setEditUser(u);
          setForm({
            ...emptyForm(),
            ...u,
            password: "",
            region_id: isMultiRegionStateRole(u.role)
              ? parseIdList(u.region_id)
              : u.region_id
                ? Number(u.region_id)
                : null,
            state_id: isMultiRegionStateRole(u.role)
              ? parseIdList(u.state_id)
              : u.state_id
                ? Number(u.state_id)
                : null,
            target: u.target != null ? String(u.target) : "",
          });
          setTargetMode("replace");
          setAddAmount("");
          setCustomData(u.custom_data ?? {});
        })
        .catch(() => showError("Failed to load user"));
    } else if (isEdit && routeState?.user) {
      const u = routeState.user;
      setForm({
        ...emptyForm(),
        ...u,
        password: "",
        region_id: isMultiRegionStateRole(u.role)
          ? parseIdList(u.region_id)
          : u.region_id
            ? Number(u.region_id)
            : null,
        state_id: isMultiRegionStateRole(u.role)
          ? parseIdList(u.state_id)
          : u.state_id
            ? Number(u.state_id)
            : null,
        target: u.target != null ? String(u.target) : "",
      });
      setTargetMode("replace");
      setAddAmount("");
      setCustomData(u.custom_data ?? {});
    }
  }, [routeUserId, isEdit]);

  const roleLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    roleDefinitions.forEach((role) => {
      if (role.name)
        map.set(role.name, role.display_name || humanizeRoleName(role.name));
    });
    return map;
  }, [roleDefinitions]);

  const getRoleLabel = (role?: string | null) => {
    const roleName = String(role ?? "");
    if (!roleName) return "";
    return roleLabelMap.get(roleName) || humanizeRoleName(roleName);
  };

  const roleOptions = useMemo(() => {
    const activeRoles = roleDefinitions.filter(
      (role) => role.is_active !== false,
    );
    if (!activeRoles.length) return DEFAULT_ROLE_OPTIONS;

    return activeRoles.map((role) => ({
      value: role.name,
      label: role.display_name || humanizeRoleName(role.name),
      subtitle:
        role.description || `${Number(role.permission_count ?? 0)} permissions`,
    }));
  }, [roleDefinitions]);

  useEffect(() => {
    api
      .get("/roles")
      .then((r) => setRoleDefinitions(normalizeRoleDefinitions(r.data)))
      .catch(() => {});
    api
      .get("/masters/regions")
      .then((r) =>
        setRegions(
          (r.data as any[]).map((x) => ({ value: x.id, label: x.name })),
        ),
      )
      .catch(() => {});
    api
      .get("/masters/states")
      .then((r) =>
        setStates(
          (r.data as any[]).map((x) => ({
            value: x.id,
            label: x.name,
            region_id: x.region_id ?? null,
          })),
        ),
      )
      .catch(() => {});
  }, []);

  const builtinFieldOverrides = useMemo(() => {
    const map = new Map<string, FormFieldConfig>();
    formConfigFields
      .filter((field) => !field.is_custom)
      .forEach((field) =>
        map.set(`${field.section}.${field.field_key}`, field),
      );
    return map;
  }, [formConfigFields]);

  const fieldMeta = (
    section: string,
    key: string,
    fallbackLabel: string,
    fallbackRequired = false,
    fallbackSortOrder = 0,
  ): UserFieldMeta => {
    const override = builtinFieldOverrides.get(`${section}.${key}`);
    return {
      label: override?.label || fallbackLabel,
      required: override?.is_required ?? fallbackRequired,
      visible: override?.is_visible ?? true,
      sortOrder:
        override?.sort_order && override.sort_order > 0
          ? override.sort_order
          : fallbackSortOrder,
    };
  };

  const basicFieldMeta = useMemo<Record<string, UserFieldMeta>>(
    () => ({
      full_name: fieldMeta("basic", "full_name", "Full Name", true),
      username: fieldMeta("basic", "username", "Username", true),
      email: fieldMeta("basic", "email", "Email", true),
      employee_code: fieldMeta("basic", "employee_code", "Employee Code"),
      phone: fieldMeta("basic", "phone", "Phone"),
    }),
    [builtinFieldOverrides],
  );

  const roleFieldMeta = useMemo<Record<string, UserFieldMeta>>(
    () => ({
      role: fieldMeta("role", "role", "Role", true),
      department: fieldMeta("role", "department", "Department"),
      designation: fieldMeta("role", "designation", "Designation"),
      branch: fieldMeta("role", "branch", "Branch"),
    }),
    [builtinFieldOverrides],
  );

  const regionFieldMeta = useMemo<Record<string, UserFieldMeta>>(
    () => ({
      region_id: fieldMeta("region", "region_id", "Region"),
      state_id: fieldMeta("region", "state_id", "State"),
    }),
    [builtinFieldOverrides],
  );

  const targetFieldMeta = useMemo<Record<string, UserFieldMeta>>(
    () => ({
      target: fieldMeta("target", "target", "Target Amount (₹)"),
    }),
    [builtinFieldOverrides],
  );

  const statusFieldMeta = useMemo<Record<string, UserFieldMeta>>(
    () => ({
      is_active: fieldMeta("status", "is_active", "Active Status"),
    }),
    [builtinFieldOverrides],
  );

  const customFieldsForSection = (section: string) =>
    formConfigFields
      .filter((field) => field.section === section && field.is_custom)
      .sort((a, b) => {
        const aOrder =
          a.sort_order && a.sort_order > 0
            ? a.sort_order
            : Number.MAX_SAFE_INTEGER;
        const bOrder =
          b.sort_order && b.sort_order > 0
            ? b.sort_order
            : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.id - b.id;
      });

  const orderedSectionItems = (
    section: string,
    keys: readonly string[],
    metaMap: Record<string, UserFieldMeta>,
  ): OrderedUserSectionItem[] => {
    const builtins: OrderedUserSectionItem[] = keys.map((key, index) => ({
      kind: "builtin",
      key,
      sortOrder:
        metaMap[key]?.sortOrder && metaMap[key].sortOrder > 0
          ? metaMap[key].sortOrder
          : index + 1,
      defaultOrder: index + 1,
    }));

    const custom = customFieldsForSection(section).map((field, index) => ({
      kind: "custom" as const,
      field,
      sortOrder:
        field.sort_order && field.sort_order > 0
          ? field.sort_order
          : keys.length + index + 1,
      defaultOrder: keys.length + index + 1,
    }));

    return [...builtins, ...custom].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.defaultOrder - b.defaultOrder;
    });
  };

  const orderedBasicItems = useMemo(
    () => orderedSectionItems("basic", BASIC_FIELD_KEYS, basicFieldMeta),
    [formConfigFields, basicFieldMeta],
  );

  const orderedRoleItems = useMemo(
    () => orderedSectionItems("role", ROLE_FIELD_KEYS, roleFieldMeta),
    [formConfigFields, roleFieldMeta],
  );

  const orderedRegionItems = useMemo(
    () => orderedSectionItems("region", REGION_FIELD_KEYS, regionFieldMeta),
    [formConfigFields, regionFieldMeta],
  );

  const orderedTargetItems = useMemo(
    () => orderedSectionItems("target", TARGET_FIELD_KEYS, targetFieldMeta),
    [formConfigFields, targetFieldMeta],
  );

  const orderedStatusItems = useMemo(
    () => orderedSectionItems("status", STATUS_FIELD_KEYS, statusFieldMeta),
    [formConfigFields, statusFieldMeta],
  );

  const selectedRegionIds = parseIdList(form.region_id);

  const filteredStates = selectedRegionIds.length
    ? states.filter(
        (s) => !s.region_id || selectedRegionIds.includes(Number(s.region_id)),
      )
    : states;

  const passwordChecks = getPasswordChecks(form.password || "");
  const isCreatePasswordValid = Object.values(passwordChecks).every(Boolean);
  const doCreatePasswordsMatch = Boolean(
    form.password &&
    form.confirm_password &&
    form.password === form.confirm_password,
  );

  const needsOrgInfo = !NO_ORG_ROLES.includes(form.role);
  const needsRegionState = REGION_STATE_ROLES.includes(form.role);
  const needsTarget =
    TARGET_ROLES.includes(form.role) && form.department === "Sales";

  const requiredChecks = useMemo(() => {
    const checks: {
      key: string;
      label: string;
      filled: boolean;
      sectionId: string;
    }[] = [];
    const push = (
      meta: UserFieldMeta | undefined,
      key: string,
      value: unknown,
      sectionId: string,
    ) => {
      if (!meta?.visible || !meta.required) return;
      const filled = Array.isArray(value)
        ? value.length > 0
        : typeof value === "string"
          ? value.trim().length > 0
          : value != null && value !== "";
      checks.push({ key, label: meta.label, filled, sectionId });
    };
    push(basicFieldMeta.full_name, "full_name", form.full_name, "basic");
    push(basicFieldMeta.username, "username", form.username, "basic");
    push(basicFieldMeta.email, "email", form.email, "basic");
    push(
      basicFieldMeta.employee_code,
      "employee_code",
      form.employee_code,
      "basic",
    );
    push(basicFieldMeta.phone, "phone", form.phone, "basic");
    push(roleFieldMeta.role, "role", form.role, "role");
    if (needsOrgInfo) {
      push(roleFieldMeta.department, "department", form.department, "role");
      push(roleFieldMeta.designation, "designation", form.designation, "role");
      push(roleFieldMeta.branch, "branch", form.branch, "role");
    }
    if (needsRegionState) {
      push(regionFieldMeta.region_id, "region_id", form.region_id, "region");
      push(regionFieldMeta.state_id, "state_id", form.state_id, "region");
    }
    if (needsTarget)
      push(targetFieldMeta.target, "target", form.target, "target");
    if (!editUser) {
      checks.push({
        key: "password",
        label: "Password",
        filled: !!form.password,
        sectionId: "password",
      });
      checks.push({
        key: "confirm_password",
        label: "Confirm Password",
        filled: !!form.confirm_password,
        sectionId: "password",
      });
    }
    return checks;
  }, [
    basicFieldMeta,
    roleFieldMeta,
    regionFieldMeta,
    targetFieldMeta,
    needsOrgInfo,
    needsRegionState,
    needsTarget,
    editUser,
    form,
  ]);

  const missingChecks = requiredChecks.filter((c) => !c.filled);
  const completenessPct = requiredChecks.length
    ? Math.round(
        ((requiredChecks.length - missingChecks.length) /
          requiredChecks.length) *
          100,
      )
    : 100;

  const jumpToSection = (sectionId: string) => {
    document
      .getElementById(`section-${sectionId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const setF = (k: string, v: any) => {
    const next = { ...form, [k]: v };
    setForm((p) => ({ ...p, [k]: v }));
    check(next, k, "change");
    if (k === "password" && next.confirm_password)
      check(next, "confirm_password", "change");
  };

  const handleRegionChange = (v: any) => {
    setForm((p) => ({
      ...p,
      region_id: isMultiRegionStateRole(p.role)
        ? parseIdList(v)
        : v !== null && v !== ""
          ? Number(v)
          : null,
      state_id: null,
    }));
    fe.clear("region_id");
  };

  const handleStateChange = (v: any) => {
    setForm((p) => ({
      ...p,
      state_id: isMultiRegionStateRole(p.role)
        ? parseIdList(v)
        : v !== null && v !== ""
          ? Number(v)
          : null,
    }));
    fe.clear("state_id");
  };

  const handleRoleChange = (v: string | number | null) => {
    const role = (v ?? "") as string;
    setForm((p) => ({
      ...p,
      role,
      ...(NO_ORG_ROLES.includes(role) && {
        department: "",
        designation: "",
        branch: "",
        region_id: null,
        state_id: null,
      }),
      ...(!REGION_STATE_ROLES.includes(role) && {
        region_id: null,
        state_id: null,
      }),
      ...(!TARGET_ROLES.includes(role) && { target: "" }),
      reporting_manager_id: null,
    }));
    if (role) fe.clear("role");
    else
      fe.blur("role", "", { label: "a role", rule: "select", required: true });
    // fields that no longer apply to the new role lose their messages
    if (NO_ORG_ROLES.includes(role))
      ["department", "designation", "branch"].forEach((k) => fe.clear(k));
    if (!REGION_STATE_ROLES.includes(role))
      ["region_id", "state_id"].forEach((k) => fe.clear(k));
    if (!TARGET_ROLES.includes(role))
      ["target", "add_amount"].forEach((k) => fe.clear(k));
  };

  const handleSave = async (addAnother = false) => {
    const errors: Record<string, string> = {};
    if (!form.full_name?.trim()) errors.full_name = FIELD_HIGHLIGHT;
    if (!form.username?.trim()) errors.username = FIELD_HIGHLIGHT;
    if (!form.email?.trim()) errors.email = FIELD_HIGHLIGHT;
    if (!editUser && !form.password) errors.password = FIELD_HIGHLIGHT;
    if (!editUser && !form.confirm_password)
      errors.confirm_password = FIELD_HIGHLIGHT;
    if (!editUser && form.password && !isCreatePasswordValid)
      errors.password = FIELD_HIGHLIGHT;
    if (!editUser && form.confirm_password && !doCreatePasswordsMatch)
      errors.confirm_password = FIELD_HIGHLIGHT;
    if (form.phone && !hasValidMobileNumber(form.phone))
      errors.phone = FIELD_HIGHLIGHT;
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      if (errors.phone) {
        showError("Mobile number must be exactly 10 digits");
      } else if (errors.password || errors.confirm_password) {
        showError("Please enter a valid password and confirmation");
      } else {
        showError("Please fill in all required fields");
      }
      return;
    }
    setSaving(true);
    try {
      const payload: any = { ...form };
      payload.region_id = Array.isArray(form.region_id)
        ? form.region_id.join(",")
        : form.region_id;

      payload.state_id = Array.isArray(form.state_id)
        ? form.state_id.join(",")
        : form.state_id;
      payload.custom_data = Object.keys(customData).length ? customData : null;
      delete payload.group_id;
      if (editUser) delete payload.confirm_password;
      if (NO_ORG_ROLES.includes(payload.role)) {
        payload.department = "";
        payload.designation = "";
        payload.branch = "";
        payload.region_id = null;
        payload.state_id = null;
      }
      if (!REGION_STATE_ROLES.includes(payload.role)) {
        payload.region_id = null;
        payload.state_id = null;
      }
      if (!TARGET_ROLES.includes(payload.role)) payload.target = null;
      payload.target =
        payload.target !== "" && payload.target != null
          ? Number(payload.target)
          : null;
      payload.reporting_manager_id = null;
      payload.reporting_manager_ids = [];
      if (editUser) {
        await api.put(`/auth/users/${editUser.id}`, payload);
        success("User updated");
      } else {
        await api.post("/auth/users", payload);
        success("User created");
      }
      if (addAnother && !editUser) {
        setForm(emptyForm());
        setCustomData({});
        setFieldErrors({});
      } else {
        navigate("/users");
      }
    } catch (e: any) {
      showError(e.response?.data?.detail || "Failed to save user");
    } finally {
      setSaving(false);
    }
  };

  const renderCustomField = (section: string, field: FormFieldConfig) => (
    <CustomFields
      key={`custom-${section}-${field.id}`}
      section={section}
      fields={[field]}
      values={customData}
      onChange={(k, v) => setCustomData((p) => ({ ...p, [k]: v }))}
    />
  );

  // Native `.lb`/`.in` field wrapper – the same markup LeadFormV17 renders for its own fields.
  const fieldWrap = (
    key: string,
    label: string,
    required: boolean,
    node: React.ReactNode,
    hint?: React.ReactNode,
    wide?: boolean,
  ) => (
    <div key={key} className={wide ? "f1" : ""}>
      <label className="lb">
        {label}
        {required && <b> *</b>}
      </label>
      {node}
      {hint && <small className="mu">{hint}</small>}
    </div>
  );

  const renderBasicField = (key: string) => {
    const meta = basicFieldMeta[key];
    if (!meta?.visible) return null;

    if (key === "full_name") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className={`in ${errProp("full_name") ? "err" : ""}`}
          value={form.full_name}
          onChange={(e) => setF("full_name", e.target.value)}
        />,
      );
    }

    if (key === "username") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className={`in ${errProp("username") ? "err" : ""}`}
          value={form.username}
          disabled={!!editUser}
          onChange={(e) =>
            setF(
              "username",
              strVal(e.target.value).toLowerCase().replace(/\s+/g, ""),
            )
          }
        />,
        editUser ? "Username cannot be changed" : "Lowercase, no spaces",
      );
    }

    if (key === "email") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className={`in ${errProp("email") ? "err" : ""}`}
          type="email"
          value={form.email}
          onChange={(e) => setF("email", e.target.value)}
        />,
      );
    }

    if (key === "employee_code") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className="in"
          value={form.employee_code}
          onChange={(e) => setF("employee_code", e.target.value)}
        />,
        "Optional — e.g. EMP001",
      );
    }

    if (key === "phone") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className={`in ${errProp("phone") ? "err" : ""}`}
          value={form.phone}
          maxLength={10}
          inputMode="numeric"
          onChange={(e) => setF("phone", normalizeMobileNumber(e.target.value))}
        />,
      );
    }

    return null;
  };

  const renderRoleField = (key: string) => {
    const meta = roleFieldMeta[key];
    if (!meta?.visible) return null;

    if (key === "role") {
      return (
        <div key={key}>
          <label className="lb">
            {meta.label}
            {meta.required && <b> *</b>}
          </label>
          <select
            className="in"
            value={form.role}
            onChange={(e) => handleRoleChange(e.target.value)}
          >
            {roleOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {form.role && (
            <div className="row mt" style={{ gap: 6 }}>
              <small className="mu">Preview:</small>
              <RoleBadge role={form.role} label={getRoleLabel(form.role)} />
            </div>
          )}
        </div>
      );
    }

    if (!needsOrgInfo) return null;

    if (key === "department") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <select
          className="in"
          value={form.department}
          onChange={(e) => setF("department", e.target.value)}
        >
          {DEPTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>,
      );
    }

    if (key === "designation") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className="in"
          value={form.designation}
          placeholder="e.g. Senior Sales Executive"
          onChange={(e) => setF("designation", e.target.value)}
        />,
      );
    }

    if (key === "branch") {
      return fieldWrap(
        key,
        meta.label,
        meta.required,
        <input
          className="in"
          value={form.branch}
          onChange={(e) => setF("branch", e.target.value)}
        />,
      );
    }

    return null;
  };

  const renderRegionField = (key: string) => {
    const meta = regionFieldMeta[key];
    if (!meta?.visible) return null;

    if (key === "region_id") {
      return isMultiRegionStateRole(form.role) ? (
        <MultiSelect
          key={key}
          label={meta.label}
          options={regions}
          value={parseIdList(form.region_id)}
          onChange={(ids) =>
            setForm((p) => ({ ...p, region_id: ids, state_id: [] }))
          }
          placeholder="Select regions…"
        />
      ) : (
        fieldWrap(
          key,
          meta.label,
          meta.required,
          <select
            className="in"
            value={firstId(form.region_id) ?? ""}
            onChange={(e) => handleRegionChange(e.target.value)}
          >
            <option value="">Select region…</option>
            {regions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>,
        )
      );
    }

    if (key === "state_id") {
      return isMultiRegionStateRole(form.role) ? (
        <MultiSelect
          key={key}
          label={meta.label}
          options={filteredStates}
          value={parseIdList(form.state_id)}
          onChange={(ids) => setForm((p) => ({ ...p, state_id: ids }))}
          placeholder="Select states…"
        />
      ) : (
        fieldWrap(
          key,
          meta.label,
          meta.required,
          <select
            className="in"
            value={firstId(form.state_id) ?? ""}
            disabled={!firstId(form.region_id)}
            onChange={(e) => handleStateChange(e.target.value)}
          >
            <option value="">
              {firstId(form.region_id)
                ? "Select state…"
                : "Select a region first"}
            </option>
            {filteredStates.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>,
          firstId(form.region_id) ? "Filtered by selected region" : undefined,
        )
      );
    }

    return null;
  };

  const renderTargetField = (key: string) => {
    const meta = targetFieldMeta[key];
    if (!meta?.visible) return null;
    if (key !== "target") return null;

    return targetMode === "replace" || !editUser ? (
      <div key={key}>
        <label className="lb">
          {meta.label}
          {meta.required && <b> *</b>}
        </label>
        <div className="cur-in">
          <span>₹</span>
          <input
            className="in"
            inputMode="decimal"
            placeholder="e.g. 500000"
            value={form.target || ""}
            onChange={(e) => setF("target", numericOnly(e.target.value))}
          />
        </div>
        <small className="mu">
          Enter target in rupees — leave blank if not applicable
        </small>
        {form.target && Number(form.target) > 0 && (
          <div
            className="mu"
            style={{ fontSize: 11, fontStyle: "italic", marginTop: 2 }}
          >
            {numberToWords(Number(form.target))}
          </div>
        )}
      </div>
    ) : (
      <div key={key}>
        <div
          className="row"
          style={{ justifyContent: "space-between", fontSize: 12 }}
        >
          <span className="mu">Current target</span>
          <b>{fmtTarget(Number(editUser.target || 0))}</b>
        </div>
        <label className="lb mt">Amount to Add (₹)</label>
        <input
          className="in"
          inputMode="decimal"
          placeholder="e.g. 100000"
          value={addAmount}
          onChange={(e) => {
            const val = numericOnly(e.target.value);
            setAddAmount(val);
            const total = Number(editUser.target || 0) + (Number(val) || 0);
            setF("target", total > 0 ? String(total) : "");
          }}
        />
        <small className="mu">Will be added to the current target</small>
        {Number(addAmount) > 0 && (
          <div
            className="row mt"
            style={{
              justifyContent: "space-between",
              background: "var(--bw-ok)",
              color: "#fff",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
            }}
          >
            <b>Total Target</b>
            <b>{fmtTarget(Number(editUser.target || 0) + Number(addAmount))}</b>
          </div>
        )}
      </div>
    );
  };

  const renderStatusField = (key: string) => {
    const meta = statusFieldMeta[key];
    if (!meta?.visible) return null;
    if (key !== "is_active") return null;

    return (
      <label key={key} className="row" style={{ gap: 8, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={form.is_active}
          onChange={(e) => setF("is_active", e.target.checked)}
        />
        <span>
          <b>{meta.label}</b>
          <br />
          <small className="mu">
            Inactive users cannot log in but their data is preserved
          </small>
        </span>
      </label>
    );
  };

  const sectionCount = (items: OrderedUserSectionItem[]) => items.length;

  return (
    <div className="bwi fpage">
      <div className="crumb">
        <a onClick={() => navigate("/users")}>{usersLabel}</a> /{" "}
        {isEdit ? form.full_name || userSingular : "New"}
      </div>
      <div className="fph">
        <div className="fpi">
          <Ic n="user" size={22} />
        </div>
        <div className="fl">
          <h1>
            {isEdit ? "Edit" : "New"} {userSingular.toLowerCase()}
          </h1>
          <div className="mu">
            {isEdit
              ? "Update the user details, access, and organisational assignment below."
              : "Fill in the essentials – you can add more detail any time. Fields marked * are required."}
          </div>
        </div>
      </div>

      <div className="fp-grid">
        <div className="fp-main">
          {/* ── Basic Information ── */}
          <section id="section-basic" className="fsec">
            <div className="fsh">
              <span className="fsi">
                <Ic n="user" />
              </span>
              <b>Basic Information</b>
              <small className="mu">
                {sectionCount(orderedBasicItems)} fields
              </small>
            </div>
            <div className="fg">
              {orderedBasicItems.map((item) =>
                item.kind === "custom"
                  ? renderCustomField("basic", item.field)
                  : renderBasicField(item.key),
              )}
            </div>
          </section>

          {/* ── Role & Department ── */}
          <section id="section-role" className="fsec">
            <div className="fsh">
              <span className="fsi">
                <Ic n="shield" />
              </span>
              <b>Role &amp; Department</b>
              <small className="mu">
                {sectionCount(orderedRoleItems)} fields
              </small>
            </div>
            <div className="fg">
              {orderedRoleItems.map((item) =>
                item.kind === "custom"
                  ? renderCustomField("role", item.field)
                  : renderRoleField(item.key),
              )}
            </div>
            {!needsOrgInfo && (
              <div className="note inf mt">
                <b>{getRoleLabel(form.role)}</b> is a top-level role —
                department, designation and branch are not applicable.
              </div>
            )}
          </section>

          {/* ── Region & State ── */}
          {needsRegionState && (
            <section id="section-region" className="fsec">
              <div className="fsh">
                <span className="fsi">
                  <Ic n="pin" />
                </span>
                <b>Region &amp; State</b>
                <small className="mu">
                  {sectionCount(orderedRegionItems)} fields
                </small>
              </div>
              <div className="fg">
                {orderedRegionItems.map((item) =>
                  item.kind === "custom"
                    ? renderCustomField("region", item.field)
                    : renderRegionField(item.key),
                )}
              </div>
            </section>
          )}

          {/* ── Sales Target ── */}
          {needsTarget && (
            <section id="section-target" className="fsec">
              <div className="fsh">
                <span className="fsi">
                  <Ic n="target" />
                </span>
                <b>Sales Target</b>
              </div>
              {editUser && (
                <div className="tabs mb">
                  <div
                    role="tab"
                    className={`tab ${targetMode === "add" ? "on" : ""}`}
                    onClick={() => {
                      setTargetMode("add");
                      setAddAmount("");
                    }}
                  >
                    + Add to Target
                  </div>
                  <div
                    role="tab"
                    className={`tab ${targetMode === "replace" ? "on" : ""}`}
                    onClick={() => {
                      setTargetMode("replace");
                      setAddAmount("");
                    }}
                  >
                    Replace Target
                  </div>
                </div>
              )}
              <div className="fg">
                {orderedTargetItems.map((item) =>
                  item.kind === "custom"
                    ? renderCustomField("target", item.field)
                    : renderTargetField(item.key),
                )}
              </div>
            </section>
          )}

          {/* ── Password (new user only) ── */}
          {!editUser && (
            <section id="section-password" className="fsec">
              <div className="fsh">
                <span className="fsi">
                  <Ic n="lock" />
                </span>
                <b>Password</b>
              </div>
              <div className="fg">
                {fieldWrap(
                  "password",
                  "Password",
                  true,
                  <input
                    className={`in ${errProp("password") ? "err" : ""}`}
                    type="password"
                    value={form.password}
                    onChange={(e) => {
                      setF("password", e.target.value);
                      clearFieldError("confirm_password");
                    }}
                  />,
                  "Min 8 chars — must include uppercase, number and special character",
                )}
                {fieldWrap(
                  "confirm_password",
                  "Confirm Password",
                  true,
                  <input
                    className={`in ${errProp("confirm_password") || (form.confirm_password && !doCreatePasswordsMatch) ? "err" : ""}`}
                    type="password"
                    value={form.confirm_password}
                    onChange={(e) => setF("confirm_password", e.target.value)}
                  />,
                  form.confirm_password && doCreatePasswordsMatch
                    ? "Passwords match"
                    : "Re-enter the same password to confirm",
                )}
                <div className="panel" style={{ gridColumn: "span 1" }}>
                  <div className="pb">
                    <b
                      className={isCreatePasswordValid ? "tok" : ""}
                      style={{ fontSize: 12 }}
                    >
                      {isCreatePasswordValid
                        ? "Password is OK"
                        : "Password requirements"}
                    </b>
                    <div className="list mt" style={{ gap: 4 }}>
                      {[
                        {
                          key: "minLength",
                          label: "At least 8 characters",
                          ok: passwordChecks.minLength,
                        },
                        {
                          key: "uppercase",
                          label: "One uppercase letter",
                          ok: passwordChecks.uppercase,
                        },
                        {
                          key: "lowercase",
                          label: "One lowercase letter",
                          ok: passwordChecks.lowercase,
                        },
                        {
                          key: "number",
                          label: "One number",
                          ok: passwordChecks.number,
                        },
                        {
                          key: "special",
                          label: "One special character",
                          ok: passwordChecks.special,
                        },
                      ].map((rule) => (
                        <div
                          key={rule.key}
                          className="row"
                          style={{ gap: 6, fontSize: 12 }}
                        >
                          <span className={rule.ok ? "tok" : "mu"}>
                            {rule.ok ? <Ic n="check" size={12} /> : "•"}
                          </span>
                          <span className={rule.ok ? "" : "mu"}>
                            {rule.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Account Status (edit only) ── */}
          {editUser && (
            <section id="section-status" className="fsec">
              <div className="fsh">
                <span className="fsi">
                  <Ic n="flow" />
                </span>
                <b>Account Status</b>
              </div>
              <div className="fg">
                {orderedStatusItems.map((item) =>
                  item.kind === "custom"
                    ? renderCustomField("status", item.field)
                    : renderStatusField(item.key),
                )}
              </div>
            </section>
          )}
        </div>

        <aside className="fp-side">
          <div className="panel">
            <div className="ph">
              <Ic n="spark" /> Summary
            </div>
            <div className="pb">
              <b style={{ fontSize: 15, display: "block", minHeight: 20 }}>
                {form.full_name?.trim() || <span className="mu">Untitled</span>}
              </b>
              <small className="mu">
                {[form.username, form.email].filter(Boolean).join(" · ") ||
                  "No details yet"}
              </small>
              {form.role && (
                <div className="row wrap mt" style={{ gap: 6 }}>
                  <RoleBadge role={form.role} label={getRoleLabel(form.role)} />
                  {form.department && (
                    <span className="pill mu">{form.department}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="panel mt">
            <div className="ph">
              <Ic n="check" /> Completeness
            </div>
            <div className="pb">
              <div className="pm">
                <i
                  style={{
                    width: `${completenessPct}%`,
                    background: missingChecks.length
                      ? "var(--bw-wa)"
                      : "var(--bw-ok)",
                  }}
                />
              </div>
              <div className="mt" style={{ fontSize: 12 }}>
                {missingChecks.length ? (
                  <>
                    <span className="twarn">
                      {missingChecks.length} required:
                    </span>{" "}
                    {missingChecks.map((c, i) => (
                      <span key={c.key}>
                        {i > 0 && ", "}
                        <a onClick={() => jumpToSection(c.sectionId)}>
                          {c.label}
                        </a>
                      </span>
                    ))}
                  </>
                ) : (
                  <span
                    className="tok"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Ic n="check" size={13} /> All required fields are filled
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="panel mt">
            <div className="ph">
              <Ic n="spark" /> Tips
            </div>
            <div className="pb">
              <ul className="tips">
                {USER_FORM_TIPS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </div>

      <div className="fmbar">
        <span className="mu">
          {isEdit
            ? `Editing ${form.full_name || userSingular}`
            : "Fields marked * are required"}
        </span>
        <span className="fl" />
        <button
          type="button"
          className="btn"
          onClick={() => navigate("/users")}
          disabled={saving}
        >
          Cancel
        </button>
        {!isEdit && (
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => handleSave(true)}
          >
            Create &amp; add another
          </button>
        )}
        <button
          type="button"
          className="btn p"
          disabled={saving}
          onClick={() => handleSave(false)}
        >
          <Ic n="check" />{" "}
          {saving
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : `Create ${userSingular.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}
