import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
  AlertTriangle,
  Lock,
  ListChecks,
  CheckCircle,
  Circle,
  MessageCircle,
  FileText,
  Info,
} from "lucide-react";
import { questionnaireApi } from "@/services/api";
import { useToast } from "@/components/ui/FormComponents";
import { Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { usePermissions } from "@/hooks";
import QuestionnaireAnswerField, { QElement } from "./QuestionnaireAnswerField";
import { SelectOption } from "@/components/ui/SearchableSelect";
import {
  isYesNoAnswerType,
  validateAnswerClient,
  extractSaveErrorMessage,
} from "./questionnaireFormShared";
import FilePreviewModal from "./FilePreviewModal";
import { Strip, Panel } from "@/pages/customers/kit";
import "@/pages/notifications/inbox.css";
import "@/pages/customers/c360.css";
import "./questionnaireForm.css";

interface Structure {
  id: number;
  parent_id: number | null;
  structure_type: "section" | "subsection";
  structure_name: string;
  structure_code: string;
  display_order: number;
}
interface Progress {
  id: number;
  status: "not_started" | "in_progress" | "completed" | "reopened";
  total_questions: number;
  completed_questions: number;
  progress_percentage: number;
  last_saved_at: string | null;
  completed_at: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
}
interface Answer {
  answer_value: string | null;
  remarks: string | null;
}
interface LatestLocation {
  element_id: number | null;
  question_id: number | null;
  section_id: number | null;
  subsection_id: number | null;
}

const STATUS_LABEL: Record<Progress["status"], string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
  reopened: "Reopened",
};

const STATUS_PILL: Record<Progress["status"], string> = {
  not_started: "mu",
  in_progress: "inf",
  completed: "ok",
  reopened: "wa",
};

function conditionMet(
  operator: string | null | undefined,
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  if (!operator) return true;
  const actualValue = (actual ?? "").toString().trim().toLowerCase();
  const expectedValue = (expected ?? "").toString().trim().toLowerCase();

  switch (operator) {
    case "equals":
      return actualValue === expectedValue;
    case "not_equals":
      return actualValue !== expectedValue;
    case "contains":
      return actualValue.includes(expectedValue);
    case "greater_than":
      return parseFloat(actualValue) > parseFloat(expectedValue);
    case "less_than":
      return parseFloat(actualValue) < parseFloat(expectedValue);
    default:
      return true;
  }
}

function conditionalYesNoFieldVisible(
  field: QElement,
  actual: string | null | undefined,
): boolean {
  const expectedValue = (field.show_when_value ?? "")
    .toString()
    .trim()
    .toLowerCase();
  if (
    field.show_when_operator !== "equals" ||
    (expectedValue !== "yes" && expectedValue !== "no")
  )
    return false;
  return conditionMet(field.show_when_operator, field.show_when_value, actual);
}

function normalizeCustomerIdParam(value: string | undefined) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function CustomerQuestionnaireFormPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { success, error: showError } = useToast();
  const { can } = usePermissions();
  const canAnswer = can("questionnaire.update");
  const canReopen = can("questionnaire.update");
  const formMode = searchParams.get("mode") === "edit" ? "edit" : "view";
  const viewMode = formMode === "view";
  const customerNumericId = useMemo(
    () => normalizeCustomerIdParam(customerId),
    [customerId],
  );

  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState<{
    id: number;
    customer_code: string;
    customer_name: string;
    customer_category: string | null;
  } | null>(null);
  const [questionnaireMeta, setQuestionnaireMeta] = useState<{
    questionnaire_name: string;
  } | null>(null);
  const [sections, setSections] = useState<Structure[]>([]);
  const [subsections, setSubsections] = useState<Structure[]>([]);
  const [questions, setQuestions] = useState<QElement[]>([]);
  const [fields, setFields] = useState<QElement[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);

  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    null,
  );
  const [selectedSubsectionId, setSelectedSubsectionId] = useState<
    number | null
  >(null);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [loadedSections, setLoadedSections] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState<
    Record<number, { answer_value: string; remarks?: string }>
  >({});
  const [saving, setSaving] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [masterOptions, setMasterOptions] = useState<
    Record<string, SelectOption[]>
  >({});
  const [pendingQuestionId, setPendingQuestionId] = useState<number | null>(
    null,
  );
  const [expandedRemarks, setExpandedRemarks] = useState<Set<number>>(
    new Set(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});

  const readOnly = viewMode || !canAnswer || progress?.status === "completed";

  const load = () => {
    if (!customerNumericId) {
      showError("Cannot load questionnaire: customer id is missing");
      navigate("/questionnaire", { replace: true });
      return;
    }
    setLoading(true);
    questionnaireApi
      .getCustomerQuestionnaire(customerNumericId)
      .then((res) => {
        const d = res.data;
        const nextSections = [...(d.sections || [])].sort(
          (a: Structure, b: Structure) => a.display_order - b.display_order,
        );
        const nextSubsections = [...(d.subsections || [])].sort(
          (a: Structure, b: Structure) => a.display_order - b.display_order,
        );
        const latest = (d.latest_location || null) as LatestLocation | null;

        setCustomer(d.customer);
        setQuestionnaireMeta(d.questionnaire);
        setSections(nextSections);
        setSubsections(nextSubsections);
        setQuestions(d.questions || []);
        setFields(d.fields || []);
        setProgress(d.progress);
        setAnswers({});
        setLoadedSections(new Set());
        setDirty({});

        const firstSection = nextSections[0];
        const latestSection =
          formMode === "edit" && latest?.section_id
            ? nextSections.find((section) => section.id === latest.section_id)
            : null;
        const initialSection = latestSection || firstSection;
        if (initialSection) {
          setSelectedSectionId(initialSection.id);
          const subs = nextSubsections
            .filter((s: Structure) => s.parent_id === initialSection.id)
            .sort(
              (a: Structure, b: Structure) => a.display_order - b.display_order,
            );
          const latestSub =
            formMode === "edit" && latest?.subsection_id
              ? subs.find((sub) => sub.id === latest.subsection_id)
              : null;
          const initialSub = latestSub || subs[0];
          setSelectedSubsectionId(initialSub?.id ?? null);
        } else {
          setSelectedSectionId(null);
          setSelectedSubsectionId(null);
        }
        setPendingQuestionId(
          formMode === "edit" ? (latest?.question_id ?? null) : null,
        );
      })
      .catch(() => showError("Failed to load questionnaire"))
      .finally(() => setLoading(false));
  };

  useEffect(load, [customerNumericId, formMode]); // eslint-disable-line

  useEffect(() => {
    if (
      !customerNumericId ||
      !selectedSectionId ||
      loadedSections.has(selectedSectionId)
    )
      return;
    questionnaireApi
      .getSection(customerNumericId, selectedSectionId)
      .then((res) => {
        setAnswers((prev) => ({ ...prev, ...res.data.answers }));
        setLoadedSections((prev) => new Set(prev).add(selectedSectionId));
      })
      .catch(() => showError("Failed to load section answers"));
  }, [customerNumericId, selectedSectionId]); // eslint-disable-line

  useEffect(() => {
    if (!customerNumericId || !viewMode || !sections.length) return;
    const missingSectionIds = sections
      .map((section) => section.id)
      .filter((sectionId) => !loadedSections.has(sectionId));
    if (!missingSectionIds.length) return;

    Promise.all(
      missingSectionIds.map((sectionId) =>
        questionnaireApi
          .getSection(customerNumericId, sectionId)
          .then((res) => ({ sectionId, answers: res.data.answers || {} })),
      ),
    )
      .then((results) => {
        setAnswers((prev) => {
          const next = { ...prev };
          results.forEach((result) => Object.assign(next, result.answers));
          return next;
        });
        setLoadedSections((prev) => {
          const next = new Set(prev);
          results.forEach((result) => next.add(result.sectionId));
          return next;
        });
      })
      .catch(() => showError("Failed to load saved questionnaire answers"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerNumericId, viewMode, sections]);

  // Resolve master-sourced dropdown options lazily
  useEffect(() => {
    const keys = new Set<string>();
    [...questions, ...fields].forEach((el) => {
      const opts = el.options_json as any;
      if (
        opts &&
        typeof opts === "object" &&
        !Array.isArray(opts) &&
        opts.source_type === "master" &&
        !masterOptions[opts.master_key]
      ) {
        keys.add(opts.master_key);
      }
    });
    keys.forEach((key) => {
      questionnaireApi
        .getMasterOptions(key)
        .then((res) =>
          setMasterOptions((prev) => ({ ...prev, [key]: res.data || [] })),
        )
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, fields]);

  const subsectionsOfSelected = subsections
    .filter((s) => s.parent_id === selectedSectionId)
    .sort((a, b) => a.display_order - b.display_order);
  const questionsOfSelected = questions
    .filter((q) => q.subsection_id === selectedSubsectionId)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  const sectionQuestionGroups = subsectionsOfSelected.map((sub) => ({
    subsection: sub,
    questions: questions
      .filter((q) => q.subsection_id === sub.id)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0)),
  }));
  const fieldsOf = (questionId: number) =>
    fields
      .filter((f) => f.parent_element_id === questionId)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const defaultValueByElementId = useMemo(() => {
    const next: Record<number, string> = {};
    [...questions, ...fields].forEach((element) => {
      if (
        element.default_value != null &&
        String(element.default_value).length > 0
      ) {
        next[element.id] = String(element.default_value);
      }
    });
    return next;
  }, [fields, questions]);

  const currentValue = (elementId: number): string =>
    dirty[elementId]?.answer_value ??
    answers[elementId]?.answer_value ??
    defaultValueByElementId[elementId] ??
    "";
  const currentRemarks = (elementId: number): string =>
    dirty[elementId]?.remarks ?? answers[elementId]?.remarks ?? "";

  const elementById = useMemo(() => {
    const map: Record<number, QElement> = {};
    [...questions, ...fields].forEach((el) => {
      map[el.id] = el;
    });
    return map;
  }, [questions, fields]);

  const setAnswer = (elementId: number, value: string) => {
    if (readOnly) return;
    setDirty((prev) => ({
      ...prev,
      [elementId]: {
        answer_value: value,
        remarks: prev[elementId]?.remarks ?? currentRemarks(elementId),
      },
    }));
    const el = elementById[elementId];
    if (el) {
      const err = validateAnswerClient(el.input_type, el.is_required, value);
      setFieldErrors((prev) => {
        if (!err) {
          if (!(elementId in prev)) return prev;
          const next = { ...prev };
          delete next[elementId];
          return next;
        }
        // while typing only format errors appear; "required" shows on save (or stays if it was already shown)
        if (!value.trim() && !(elementId in prev)) return prev;
        return { ...prev, [elementId]: err };
      });
    }
  };

  // scroll to / focus the first answer showing an error (wrappers carry id="qf-<element id>")
  const focusFirstAnswer = (ids: number[]) => {
    requestAnimationFrame(() => {
      const box = ids
        .map((id) => document.getElementById(`qf-${id}`))
        .find(Boolean);
      if (!box) return;
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      box
        .querySelector<HTMLElement>(
          "input:not([type=hidden]),select,textarea,button",
        )
        ?.focus({ preventScroll: true });
    });
  };

  const setRemarks = (elementId: number, remarks: string) => {
    if (readOnly) return;
    setDirty((prev) => ({
      ...prev,
      [elementId]: {
        answer_value: prev[elementId]?.answer_value ?? currentValue(elementId),
        remarks,
      },
    }));
  };

  const visibleFieldsOf = (question: QElement) => {
    const answer = currentValue(question.id);
    if (isYesNoAnswerType(question.input_type)) {
      return fieldsOf(question.id).filter((field) =>
        conditionalYesNoFieldVisible(field, answer),
      );
    }
    return fieldsOf(question.id).filter((field) =>
      conditionMet(field.show_when_operator, field.show_when_value, answer),
    );
  };

  const saveAnswers = async (elementIds?: number[]): Promise<boolean> => {
    const visibleSelectedIds = questionsOfSelected.flatMap((q) => [
      q.id,
      ...visibleFieldsOf(q).map((f) => f.id),
    ]);
    const idsForDefaults = elementIds || visibleSelectedIds;
    const dirtyEntries = Object.entries(dirty).filter(
      ([id]) => !elementIds || elementIds.includes(Number(id)),
    );
    const dirtyIds = new Set(dirtyEntries.map(([id]) => Number(id)));
    const defaultEntries = idsForDefaults
      .filter(
        (id) =>
          !dirtyIds.has(id) &&
          answers[id]?.answer_value == null &&
          defaultValueByElementId[id] != null,
      )
      .map((id) => {
        const answerValue = defaultValueByElementId[id] ?? "";
        return [
          String(id),
          {
            answer_value: answerValue,
            remarks: answers[id]?.remarks ?? undefined,
          },
        ] as [string, { answer_value: string; remarks?: string }];
      });
    const entries = [...dirtyEntries, ...defaultEntries];
    if (!entries.length) return true;

    const invalidEntries = entries
      .map(([id, v]) => ({
        id: Number(id),
        el: elementById[Number(id)],
        value: v.answer_value,
      }))
      .filter((e) => e.el)
      .map((e) => ({
        ...e,
        err: validateAnswerClient(e.el.input_type, e.el.is_required, e.value),
      }))
      .filter((e) => e.err);
    if (invalidEntries.length) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        invalidEntries.forEach((e) => {
          next[e.id] = e.err as string;
        });
        return next;
      });
      focusFirstAnswer(invalidEntries.map((e) => e.id));
      showError(
        invalidEntries.map((e) => `${e.el.element_label}: ${e.err}`).join("; "),
      );
      return false;
    }

    setSaving(true);
    try {
      const res = await questionnaireApi.saveAnswers(customerNumericId, {
        answers: entries.map(([element_id, v]) => ({
          element_id: Number(element_id),
          answer_value: v.answer_value,
          remarks: v.remarks,
        })),
      });
      setAnswers((prev) => {
        const next = { ...prev };
        entries.forEach(([id, v]) => {
          next[Number(id)] = {
            answer_value: v.answer_value,
            remarks: v.remarks ?? null,
          };
        });
        return next;
      });
      setDirty((prev) => {
        const next = { ...prev };
        entries.forEach(([id]) => {
          delete next[Number(id)];
        });
        return next;
      });
      if (res.data.progress)
        setProgress((prev) =>
          prev ? { ...prev, ...res.data.progress } : prev,
        );
      success("Saved");
      return true;
    } catch (e: unknown) {
      const serverFields = (
        e as {
          response?: {
            data?: { detail?: { fields?: Record<string, string> } };
          };
        }
      )?.response?.data?.detail?.fields;
      if (
        serverFields &&
        typeof serverFields === "object" &&
        Object.keys(serverFields).length
      ) {
        setFieldErrors((prev) => ({
          ...prev,
          ...Object.fromEntries(
            Object.entries(serverFields).map(([id, m]) => [Number(id), m]),
          ),
        }));
        focusFirstAnswer(Object.keys(serverFields).map(Number));
      }
      showError(extractSaveErrorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const goToSubsection = (dir: -1 | 1) => {
    const idx = subsectionsOfSelected.findIndex(
      (s) => s.id === selectedSubsectionId,
    );
    const nextIdx = idx + dir;
    if (nextIdx >= 0 && nextIdx < subsectionsOfSelected.length) {
      setSelectedSubsectionId(subsectionsOfSelected[nextIdx].id);
      return;
    }
    // move to adjacent section's first/last subsection
    const secIdx = sections.findIndex((s) => s.id === selectedSectionId);
    const nextSecIdx = secIdx + dir;
    if (nextSecIdx >= 0 && nextSecIdx < sections.length) {
      const nextSection = sections[nextSecIdx];
      setSelectedSectionId(nextSection.id);
      const subs = subsections
        .filter((s) => s.parent_id === nextSection.id)
        .sort((a, b) => a.display_order - b.display_order);
      const targetSub = dir === 1 ? subs[0] : subs[subs.length - 1];
      if (targetSub) setSelectedSubsectionId(targetSub.id);
    }
  };

  const goToSection = (dir: -1 | 1) => {
    const idx = sections.findIndex((s) => s.id === selectedSectionId);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= sections.length) return;
    const nextSection = sections[nextIdx];
    setSelectedSectionId(nextSection.id);
    const subs = subsections
      .filter((s) => s.parent_id === nextSection.id)
      .sort((a, b) => a.display_order - b.display_order);
    setSelectedSubsectionId(subs[0]?.id ?? null);
  };

  const handleSaveAndNext = async () => {
    const ids = questionsOfSelected.flatMap((q) => [
      q.id,
      ...visibleFieldsOf(q).map((f) => f.id),
    ]);
    // required answers of this subsection must be filled before moving on
    const missing = ids.filter(
      (id) => elementById[id]?.is_required && !currentValue(id).trim(),
    );
    if (missing.length) {
      setFieldErrors((prev) => ({
        ...prev,
        ...Object.fromEntries(
          missing.map((id) => [id, "This field is required"]),
        ),
      }));
      focusFirstAnswer(missing);
      showError("Complete the required fields before moving on");
      return;
    }
    const ok = await saveAnswers(ids);
    if (ok) goToSubsection(1);
  };

  const handleComplete = async () => {
    const ok = await saveAnswers();
    if (!ok) return;
    try {
      await questionnaireApi.complete(customerNumericId);
      success("Questionnaire completed");
      load();
    } catch (e: unknown) {
      showError(extractSaveErrorMessage(e));
    }
  };

  const handleReopen = async () => {
    if (!reopenReason.trim()) {
      showError("Reopen reason is required");
      return;
    }
    try {
      await questionnaireApi.reopen(customerNumericId, reopenReason.trim());
      success("Questionnaire reopened");
      setReopenOpen(false);
      setReopenReason("");
      load();
    } catch {
      showError("Failed to reopen");
    }
  };

  const uploadFile = async (elementId: number, file: File) => {
    if (readOnly) return;
    try {
      const res = await questionnaireApi.uploadAnswerFile(
        customerNumericId,
        elementId,
        file,
      );
      setAnswers((prev) => ({
        ...prev,
        [elementId]: {
          answer_value: res.data.url,
          remarks: prev[elementId]?.remarks ?? null,
        },
      }));
      success("File uploaded");
    } catch {
      showError("File upload failed");
    }
  };

  const resolveOptions = (el: QElement): SelectOption[] | undefined => {
    const opts = el.options_json as any;
    if (
      opts &&
      typeof opts === "object" &&
      !Array.isArray(opts) &&
      opts.source_type === "master"
    )
      return masterOptions[opts.master_key];
    return undefined;
  };

  const selectedSection = sections.find((s) => s.id === selectedSectionId);
  const selectedSubsection = subsections.find(
    (s) => s.id === selectedSubsectionId,
  );
  const isFirstSubsection = useMemo(
    () =>
      sections[0]?.id === selectedSectionId &&
      subsectionsOfSelected[0]?.id === selectedSubsectionId,
    [sections, selectedSectionId, subsectionsOfSelected, selectedSubsectionId],
  );
  const isLastSubsection = useMemo(() => {
    const lastSection = sections[sections.length - 1];
    const lastSub = subsections
      .filter((s) => s.parent_id === lastSection?.id)
      .sort((a, b) => b.display_order - a.display_order)[0];
    return (
      lastSection?.id === selectedSectionId &&
      lastSub?.id === selectedSubsectionId
    );
  }, [sections, subsections, selectedSectionId, selectedSubsectionId]);
  const selectedSectionIdx = sections.findIndex(
    (s) => s.id === selectedSectionId,
  );
  const isFirstSection = selectedSectionIdx <= 0;
  const isLastSection = selectedSectionIdx === sections.length - 1;

  useEffect(() => {
    if (formMode !== "edit" || !pendingQuestionId || !selectedSubsectionId)
      return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-question-id="${pendingQuestionId}"]`,
      );
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      setPendingQuestionId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    formMode,
    pendingQuestionId,
    selectedSubsectionId,
    questionsOfSelected.length,
  ]);

  const toggleRemarks = (id: number) =>
    setExpandedRemarks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Derived, read-only stats for the view-mode layout — mirrors the backend's per-question
  // progress definition (_question_progress_counts) so header and sidebar totals agree:
  // "total" counts questions (not fields), and a question counts as answered only once its
  // visible required fields (or, absent any, all visible fields) are filled in.
  const allVisibleDescendantFieldsOf = (element: QElement): QElement[] => {
    const direct = visibleFieldsOf(element);
    return direct.flatMap((field) => [
      field,
      ...allVisibleDescendantFieldsOf(field),
    ]);
  };
  const isQuestionAnswered = (question: QElement): boolean => {
    const isYesNo = isYesNoAnswerType(question.input_type);
    if (isYesNo && currentValue(question.id).trim() === "") return false;
    const visible = allVisibleDescendantFieldsOf(question);
    if (visible.length === 0) return isYesNo;
    const hasAnswer = (el: QElement) => currentValue(el.id).trim() !== "";
    const required = visible.filter((field) => field.is_required);
    return required.length > 0
      ? required.every(hasAnswer)
      : visible.every(hasAnswer);
  };
  const sectionStats = (sectionId: number) => {
    const qs = questions.filter(
      (q) => q.section_id === sectionId && q.is_active !== false,
    );
    const total = qs.length;
    const answered = qs.filter(isQuestionAnswered).length;
    const allFields = qs.flatMap((q) => allVisibleDescendantFieldsOf(q));
    const mandatory =
      qs.filter((q) => q.is_required).length +
      allFields.filter((f) => f.is_required).length;
    const documents = allFields.filter(
      (f) => f.input_type === "file" && currentValue(f.id).trim() !== "",
    ).length;
    const comments = [...qs, ...allFields].filter(
      (el) => currentRemarks(el.id).trim() !== "",
    ).length;
    const pct = total ? Math.round((answered / total) * 100) : 0;
    return {
      total,
      answered,
      remaining: total - answered,
      mandatory,
      documents,
      comments,
      pct,
    };
  };
  const formatAnswerValue = (el: QElement, value: string): string => {
    if (!value) return "";
    if (isYesNoAnswerType(el.input_type))
      return value === "yes" ? "Yes" : value === "no" ? "No" : value;
    if (el.input_type === "yes_no_na")
      return value === "not_applicable"
        ? "N/A"
        : value.charAt(0).toUpperCase() + value.slice(1);
    if (el.input_type === "file") return value ? "Uploaded" : "";
    if (el.input_type === "rating") {
      const n = parseInt(value, 10) || 0;
      return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
    }
    return value;
  };

  if (loading) {
    return (
      <div className="bwi fpage">
        <div className="empty">Loading questionnaire…</div>
      </div>
    );
  }
  if (!customer || !progress) {
    return (
      <div className="bwi fpage">
        <div className="empty">Not found</div>
      </div>
    );
  }

  if (readOnly) {
    const selectedSectionStats = selectedSectionId
      ? sectionStats(selectedSectionId)
      : {
          total: 0,
          answered: 0,
          remaining: 0,
          mandatory: 0,
          documents: 0,
          comments: 0,
          pct: 0,
        };

    return (
      <div className="bwi fpage">
        <div className="pg">
          <button
            type="button"
            className="btn g s"
            onClick={() => navigate("/questionnaire")}
            title="Back"
          >
            <ArrowLeft size={14} />
          </button>
          <div>
            <div className="crumb">Customer Questionnaire</div>
            <h1>{customer.customer_name}</h1>
          </div>
          {customer.customer_category && (
            <span className="pill mu">{customer.customer_category}</span>
          )}
          <span className={`pill ${STATUS_PILL[progress.status]}`}>
            {STATUS_LABEL[progress.status]}
          </span>
          <span className="fl" />
          {progress.status === "completed" && canReopen && !viewMode && (
            <button
              type="button"
              className="btn s"
              onClick={() => setReopenOpen(true)}
            >
              <RotateCcw size={13} /> Reopen
            </button>
          )}
        </div>

        <Strip
          items={[
            {
              l: "Overall Progress",
              v: progress.progress_percentage,
              f: "pct",
            },
            {
              l: "Completed",
              v: `${progress.completed_questions} / ${progress.total_questions}`,
              f: "text",
            },
            {
              l: "Last Saved",
              v: progress.last_saved_at
                ? new Date(progress.last_saved_at).toLocaleString()
                : "-",
              f: "text",
            },
          ]}
        />

        <div
          className="note inf row wrap mb"
          style={{ justifyContent: "space-between" }}
        >
          <span className="row" style={{ gap: 6 }}>
            <Info size={13} /> Viewing saved questionnaire responses in
            read-only mode.
          </span>
          <span className="pill mu">
            <Lock size={10} /> Read-only
          </span>
        </div>
        {progress.status === "reopened" && progress.reopen_reason && (
          <div
            className="note mb"
            style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
          >
            <AlertTriangle
              size={13}
              className="mt-0.5"
              style={{ flexShrink: 0 }}
            />
            <span>
              <b>Reopened</b> — {progress.reopen_reason}
            </span>
          </div>
        )}

        <div
          className="qf-layout"
          style={{
            gridTemplateColumns: sidebarCollapsed
              ? "minmax(0, 1fr)"
              : "260px minmax(0, 1fr)",
          }}
        >
          {!sidebarCollapsed && (
            <Panel
              z
              title={
                <>
                  Questionnaire Sections
                  <span className="fl" />
                  <button
                    type="button"
                    className="btn g s"
                    onClick={() => setSidebarCollapsed(true)}
                    title="Collapse"
                  >
                    <ChevronsLeft size={13} />
                  </button>
                </>
              }
            >
              <div className="list qf-sidebar">
                {sections.map((s) => {
                  const stats = sectionStats(s.id);
                  const isSelected = s.id === selectedSectionId;
                  return (
                    <div
                      key={s.id}
                      className={isSelected ? "un" : ""}
                      style={{
                        cursor: "pointer",
                        flexDirection: "column",
                        alignItems: "stretch",
                        gap: 4,
                      }}
                      onClick={() => {
                        setSelectedSectionId(s.id);
                        const firstSub = subsections
                          .filter((x) => x.parent_id === s.id)
                          .sort((a, b) => a.display_order - b.display_order)[0];
                        if (firstSub) setSelectedSubsectionId(firstSub.id);
                      }}
                    >
                      <span
                        className="row"
                        style={{
                          gap: 6,
                          fontSize: 13,
                          fontWeight: 600,
                          color: isSelected ? "var(--bw-ac)" : "var(--bw-tx)",
                        }}
                      >
                        {stats.total > 0 && stats.answered === stats.total ? (
                          <CheckCircle
                            size={14}
                            className="tok"
                            style={{ flexShrink: 0 }}
                          />
                        ) : (
                          <Circle
                            size={14}
                            className={stats.answered > 0 ? "" : "mu"}
                            style={{
                              flexShrink: 0,
                              color:
                                stats.answered > 0 ? "var(--bw-ac)" : undefined,
                            }}
                          />
                        )}
                        <span className="qf-sidebar-label">
                          {s.structure_code}. {s.structure_name}
                        </span>
                      </span>
                      <div
                        className="row"
                        style={{ justifyContent: "space-between" }}
                      >
                        <small>
                          {stats.answered} / {stats.total}
                        </small>
                        <small>{stats.pct}%</small>
                      </div>
                      <div className="pm">
                        <i
                          style={{
                            width: `${stats.pct}%`,
                            background: "var(--bw-ok)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="qf-legend">
                <span className="row" style={{ gap: 5 }}>
                  <i className="qf-dot ok" /> Completed
                </span>
                <span className="row" style={{ gap: 5 }}>
                  <i className="qf-dot inf" /> In Progress
                </span>
                <span className="row" style={{ gap: 5 }}>
                  <i className="qf-dot mu" /> Pending
                </span>
              </div>
            </Panel>
          )}

          <div>
            <Panel
              title={
                <>
                  {sidebarCollapsed && (
                    <button
                      type="button"
                      className="btn g s"
                      onClick={() => setSidebarCollapsed(false)}
                      title="Expand"
                    >
                      <ChevronsRight size={13} />
                    </button>
                  )}
                  {selectedSection && (
                    <span>
                      {selectedSection.structure_code}.{" "}
                      {selectedSection.structure_name}
                    </span>
                  )}
                </>
              }
            >
              {subsectionsOfSelected.length === 0 && (
                <p className="mu">No subsections in this section.</p>
              )}
              {sectionQuestionGroups.map(
                ({ subsection, questions: subQuestions }) => (
                  <div key={subsection.id} className="mb">
                    {subsectionsOfSelected.length > 1 && (
                      <h3
                        className="mb"
                        style={{
                          textTransform: "uppercase",
                          letterSpacing: ".03em",
                          fontSize: 11,
                        }}
                      >
                        {subsection.structure_name}
                      </h3>
                    )}
                    {subQuestions.map((q) => {
                      const dependentFields = visibleFieldsOf(q);
                      const value = currentValue(q.id);
                      const remarks = currentRemarks(q.id);
                      const displayValue = formatAnswerValue(q, value);
                      const isYes = value === "yes";
                      const isAnswered = value.trim() !== "";
                      return (
                        <div
                          key={q.id}
                          data-question-id={q.id}
                          className="qf-qcard"
                        >
                          <div className="qf-qhead">
                            <span
                              className="row"
                              style={{ gap: 6, alignItems: "flex-start" }}
                            >
                              <span className="qf-qcode">{q.element_code}</span>
                              <label className="qf-qlabel">
                                {q.element_label}
                              </label>
                            </span>
                            <span
                              className="row"
                              style={{ gap: 6, flexShrink: 0 }}
                            >
                              {isAnswered ? (
                                <span
                                  className={`pill ${isYesNoAnswerType(q.input_type) ? (isYes ? "ok" : "mu") : "inf"}`}
                                >
                                  Answer: {displayValue}
                                </span>
                              ) : (
                                <span className="pill mu">Not answered</span>
                              )}
                              {q.allow_remarks && (
                                <button
                                  type="button"
                                  onClick={() => toggleRemarks(q.id)}
                                  className="btn g s"
                                  title={
                                    remarks ? "View remarks" : "No remarks"
                                  }
                                  style={{
                                    color: remarks
                                      ? "var(--bw-ac)"
                                      : "var(--bw-mu)",
                                  }}
                                >
                                  <MessageCircle size={13} />
                                </button>
                              )}
                            </span>
                          </div>

                          {q.allow_remarks &&
                            remarks &&
                            expandedRemarks.has(q.id) && (
                              <p className="qf-remarks">{remarks}</p>
                            )}

                          {dependentFields.length > 0 && (
                            <div className="qf-fields">
                              {dependentFields.map((f) => {
                                const fValue = currentValue(f.id);
                                const fRemarks = currentRemarks(f.id);
                                const fAnswered = fValue.trim() !== "";
                                return (
                                  <div key={f.id} className="qf-field min-w-0">
                                    <div
                                      className="row"
                                      style={{
                                        justifyContent: "space-between",
                                      }}
                                    >
                                      <label>
                                        {f.element_label}
                                        {f.is_required && (
                                          <b style={{ color: "var(--bw-ba)" }}>
                                            {" "}
                                            *
                                          </b>
                                        )}
                                      </label>
                                      {f.allow_remarks && fRemarks && (
                                        <button
                                          type="button"
                                          onClick={() => toggleRemarks(f.id)}
                                          className="btn g s"
                                          title="View remarks"
                                          style={{ color: "var(--bw-ac)" }}
                                        >
                                          <MessageCircle size={12} />
                                        </button>
                                      )}
                                    </div>
                                    {fAnswered ? (
                                      f.input_type === "file" ? (
                                        <button
                                          type="button"
                                          onClick={() => setPreviewFile(fValue)}
                                          className="row"
                                          style={{
                                            gap: 4,
                                            color: "var(--bw-ac)",
                                            fontWeight: 600,
                                            fontSize: 13,
                                          }}
                                        >
                                          <FileText size={13} /> View document
                                        </button>
                                      ) : (
                                        <p
                                          style={{
                                            fontSize: 13,
                                            fontWeight: 600,
                                          }}
                                        >
                                          {formatAnswerValue(f, fValue)}
                                        </p>
                                      )
                                    ) : (
                                      <p
                                        className="mu"
                                        style={{ fontSize: 13 }}
                                      >
                                        Not answered
                                      </p>
                                    )}
                                    {f.allow_remarks &&
                                      fRemarks &&
                                      expandedRemarks.has(f.id) && (
                                        <p className="qf-remarks">{fRemarks}</p>
                                      )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {subQuestions.length === 0 && (
                      <p className="mu">No questions in this subsection.</p>
                    )}
                  </div>
                ),
              )}
            </Panel>
            <div className="fmbar">
              <button
                type="button"
                className="btn"
                onClick={() => goToSection(-1)}
                disabled={isFirstSection}
              >
                <ChevronLeft size={14} /> Previous Section
              </button>
              <span className="fl" />
              <span className="mu" style={{ fontSize: 12 }}>
                Section {selectedSectionIdx + 1} / {sections.length} ·{" "}
                {selectedSectionStats.answered} / {selectedSectionStats.total}{" "}
                Answered in this section
              </span>
              <span className="fl" />
              <button
                type="button"
                className="btn"
                onClick={() => goToSection(1)}
                disabled={isLastSection}
              >
                Next Section <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>

        <Modal
          open={reopenOpen}
          onClose={() => setReopenOpen(false)}
          title="Reopen Questionnaire"
          footer={
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="btn g"
                onClick={() => setReopenOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn p" onClick={handleReopen}>
                Reopen
              </button>
            </div>
          }
        >
          <Textarea
            label="Reason for reopening"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            rows={3}
            required
          />
        </Modal>
        {previewFile && (
          <FilePreviewModal
            fileUrl={previewFile}
            onClose={() => setPreviewFile(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="bwi fpage">
      <div className="pg">
        <button
          type="button"
          className="btn g s"
          onClick={() => navigate("/questionnaire")}
        >
          <ArrowLeft size={13} /> Back
        </button>
        <div>
          <div className="crumb">{questionnaireMeta?.questionnaire_name}</div>
          <h1>{customer.customer_name}</h1>
        </div>
        <span className="pill mu">{customer.customer_code}</span>
        {customer.customer_category && (
          <span className="pill mu">{customer.customer_category}</span>
        )}
        <span className={`pill ${STATUS_PILL[progress.status]}`}>
          {STATUS_LABEL[progress.status]}
        </span>
        <span className="fl" />
        {progress.status === "completed" && canReopen && !viewMode && (
          <button
            type="button"
            className="btn s"
            onClick={() => setReopenOpen(true)}
          >
            <RotateCcw size={13} /> Reopen
          </button>
        )}
      </div>

      <Strip
        items={[
          {
            l: "Completed",
            v: `${progress.completed_questions} / ${progress.total_questions}`,
            f: "text",
          },
          { l: "Progress", v: progress.progress_percentage, f: "pct" },
          {
            l: "Last Saved",
            v: progress.last_saved_at
              ? new Date(progress.last_saved_at).toLocaleString()
              : "-",
            f: "text",
          },
        ]}
      />

      {progress.status === "reopened" && progress.reopen_reason && (
        <div
          className="note mb"
          style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
        >
          <AlertTriangle
            size={13}
            style={{ flexShrink: 0 }}
            className="mt-0.5"
          />
          <span>
            <b>Reopened</b> — {progress.reopen_reason}
          </span>
        </div>
      )}
      {viewMode && (
        <div className="note inf mb row" style={{ gap: 6 }}>
          <Lock size={13} style={{ flexShrink: 0 }} />
          Viewing saved questionnaire responses in read-only mode.
        </div>
      )}
      {!viewMode && progress.status === "completed" && (
        <div
          className="note mb row"
          style={{
            gap: 6,
            background: "color-mix(in srgb, var(--bw-ok) 10%, var(--bw-sf))",
            borderColor: "color-mix(in srgb, var(--bw-ok) 35%, var(--bw-ln))",
          }}
        >
          <Lock size={13} style={{ flexShrink: 0 }} />
          This questionnaire is completed and shown in read-only mode.
        </div>
      )}

      <div
        className="qf-layout"
        style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}
      >
        <Panel
          title={
            <>
              <ListChecks size={13} /> Overall Progress
              <span className="fl" />
              <b>{progress.progress_percentage}%</b>
            </>
          }
        >
          <div className="pm mb">
            <i
              style={{
                width: `${progress.progress_percentage}%`,
                background: "var(--bw-ac)",
              }}
            />
          </div>
          <div className="list qf-sidebar">
            {sections.map((s) => (
              <div
                key={s.id}
                className={s.id === selectedSectionId ? "un" : ""}
                style={{
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 13,
                  color:
                    s.id === selectedSectionId
                      ? "var(--bw-ac)"
                      : "var(--bw-tx)",
                }}
                onClick={() => {
                  setSelectedSectionId(s.id);
                  const firstSub = subsections
                    .filter((x) => x.parent_id === s.id)
                    .sort((a, b) => a.display_order - b.display_order)[0];
                  if (firstSub) setSelectedSubsectionId(firstSub.id);
                }}
              >
                {s.structure_code}. {s.structure_name}
              </div>
            ))}
          </div>
        </Panel>

        <div>
          <Panel
            title={
              <>
                {selectedSection && (
                  <span className="mu">
                    {selectedSection.structure_code}.{" "}
                    {selectedSection.structure_name}
                  </span>
                )}
                {selectedSection && selectedSubsection && (
                  <span className="mu">›</span>
                )}
                {selectedSubsection && (
                  <span>{selectedSubsection.structure_name}</span>
                )}
              </>
            }
            z
          >
            <div className="tabs">
              {subsectionsOfSelected.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  className={`tab ${sub.id === selectedSubsectionId ? "on" : ""}`}
                  onClick={() => setSelectedSubsectionId(sub.id)}
                >
                  {sub.structure_name}
                </button>
              ))}
            </div>
            <div className="pb">
              {!selectedSubsection && (
                <p className="mu">No subsections in this section.</p>
              )}
              {questionsOfSelected.map((q) => {
                const dependentFields = visibleFieldsOf(q);
                const isYesNoQuestion = isYesNoAnswerType(q.input_type);
                return (
                  <div key={q.id} data-question-id={q.id} className="qf-qcard">
                    <div className="qf-qhead">
                      <span
                        className="row"
                        style={{ gap: 6, alignItems: "flex-start" }}
                      >
                        <span className="qf-qcode">{q.element_code}</span>
                        <label className="qf-qlabel">{q.element_label}</label>
                      </span>
                      {isYesNoQuestion && (
                        <div style={{ flexShrink: 0 }}>
                          <QuestionnaireAnswerField
                            element={q}
                            value={currentValue(q.id)}
                            onChange={(value) => setAnswer(q.id, value)}
                            readOnly={readOnly}
                            error={fieldErrors[q.id]}
                            masterOptions={resolveOptions(q)}
                            onUploadFile={(file) => uploadFile(q.id, file)}
                          />
                        </div>
                      )}
                    </div>

                    {(!isYesNoQuestion || q.allow_remarks) && (
                      <div className="mt">
                        {!isYesNoQuestion && (
                          <QuestionnaireAnswerField
                            element={q}
                            value={currentValue(q.id)}
                            onChange={(value) => setAnswer(q.id, value)}
                            readOnly={readOnly}
                            error={fieldErrors[q.id]}
                            masterOptions={resolveOptions(q)}
                            onUploadFile={(file) => uploadFile(q.id, file)}
                          />
                        )}
                        {q.allow_remarks && (
                          <Textarea
                            label="Remarks"
                            value={currentRemarks(q.id)}
                            onChange={(event) =>
                              setRemarks(q.id, event.target.value)
                            }
                            rows={2}
                            disabled={readOnly}
                            className="mt-3"
                          />
                        )}
                      </div>
                    )}

                    {dependentFields.length > 0 && (
                      <div className="qf-fields">
                        {dependentFields.map((f) => (
                          <div key={f.id} className="qf-field min-w-0">
                            <div
                              className="row"
                              style={{ gap: 6, alignItems: "flex-start" }}
                            >
                              <span className="qf-qcode">{f.element_code}</span>
                              <label>
                                {f.element_label}
                                {f.is_required && (
                                  <b style={{ color: "var(--bw-ba)" }}> *</b>
                                )}
                              </label>
                            </div>
                            <QuestionnaireAnswerField
                              element={f}
                              value={currentValue(f.id)}
                              onChange={(v) => setAnswer(f.id, v)}
                              readOnly={readOnly}
                              error={fieldErrors[f.id]}
                              masterOptions={resolveOptions(f)}
                              onUploadFile={(file) => uploadFile(f.id, file)}
                            />
                            {f.allow_remarks && (
                              <Textarea
                                label="Remarks"
                                value={currentRemarks(f.id)}
                                onChange={(event) =>
                                  setRemarks(f.id, event.target.value)
                                }
                                rows={2}
                                disabled={readOnly}
                                className="mt-3"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {questionsOfSelected.length === 0 && (
                <p className="mu">No questions in this subsection.</p>
              )}
            </div>
          </Panel>

          {!readOnly && (
            <div className="fmbar">
              <button
                type="button"
                className="btn"
                onClick={() => goToSubsection(-1)}
                disabled={isFirstSubsection}
              >
                <ChevronLeft size={14} /> Previous Subsection
              </button>
              <span className="fl" />
              <button
                type="button"
                className="btn"
                onClick={() => saveAnswers()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save Draft"}
              </button>
              {!isLastSubsection && (
                <button
                  type="button"
                  className="btn p"
                  onClick={handleSaveAndNext}
                  disabled={saving}
                >
                  Save and Next Subsection <ChevronRight size={14} />
                </button>
              )}
              {isLastSubsection && (
                <button
                  type="button"
                  className="btn p"
                  onClick={handleComplete}
                  disabled={saving}
                >
                  <CheckCircle2 size={14} /> Complete Questionnaire
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        title="Reopen Questionnaire"
        footer={
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="btn g"
              onClick={() => setReopenOpen(false)}
            >
              Cancel
            </button>
            <button type="button" className="btn p" onClick={handleReopen}>
              Reopen
            </button>
          </div>
        }
      >
        <Textarea
          label="Reason for reopening"
          value={reopenReason}
          onChange={(e) => setReopenReason(e.target.value)}
          rows={3}
          required
        />
      </Modal>
    </div>
  );
}
