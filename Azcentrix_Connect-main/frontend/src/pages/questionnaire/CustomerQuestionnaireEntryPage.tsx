import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ClipboardList,
  Loader2,
  PlayCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import api, { questionnaireApi } from "@/services/api";
import { EmptyState, useToast } from "@/components/ui/FormComponents";
import SearchableSelect, {
  SelectOption,
} from "@/components/ui/SearchableSelect";
import { useUIStore } from "@/store";
import QuestionnaireAnswerField, { QElement } from "./QuestionnaireAnswerField";
import {
  isYesNoAnswerType,
  validateAnswerClient,
  extractSaveErrorMessage,
} from "./questionnaireFormShared";
import { Strip, Panel } from "@/pages/customers/kit";
import "@/pages/notifications/inbox.css";
import "@/pages/customers/c360.css";
import "./questionnaireForm.css";

interface CustomerOptionRow {
  id: number;
  customer_name: string;
  customer_vertical?: string | null;
  assigned_user_name?: string | null;
  approval_status?: string | null;
  approval_display?: string | null;
}

interface CustomerSelectOption extends SelectOption {
  assignedUserName?: string | null;
  customerVertical?: string | null;
  approvalStatus?: string | null;
  approvalDisplay?: string | null;
}

interface Structure {
  id: number;
  parent_id: number | null;
  structure_type: "section" | "subsection";
  structure_name: string;
  structure_code: string;
  display_order: number;
}

interface Answer {
  answer_value: string | null;
  remarks: string | null;
}

type SectionStatus = "complete" | "pending" | "untouched";

function normalizeAnswers(raw: unknown): Record<number, Answer> {
  if (!raw || typeof raw !== "object") return {};
  const next: Record<number, Answer> = {};
  Object.entries(raw as Record<string, any>).forEach(([elementId, answer]) => {
    const id = Number(elementId);
    if (!Number.isFinite(id) || !answer || typeof answer !== "object") return;
    next[id] = {
      answer_value: answer.answer_value ?? null,
      remarks: answer.remarks ?? null,
    };
  });
  return next;
}

function conditionMet(
  operator: string | null | undefined,
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  if (!operator) return true;
  const a = (actual ?? "").toString().trim().toLowerCase();
  const e = (expected ?? "").toString().trim().toLowerCase();
  switch (operator) {
    case "equals":
      return a === e;
    case "not_equals":
      return a !== e;
    case "contains":
      return a.includes(e);
    case "greater_than":
      return parseFloat(a) > parseFloat(e);
    case "less_than":
      return parseFloat(a) < parseFloat(e);
    default:
      return true;
  }
}

function conditionalYesNoFieldVisible(
  field: QElement,
  actual: string | null | undefined,
): boolean {
  const expected = (field.show_when_value ?? "")
    .toString()
    .trim()
    .toLowerCase();
  if (
    field.show_when_operator !== "equals" ||
    (expected !== "yes" && expected !== "no")
  )
    return false;
  return conditionMet(field.show_when_operator, field.show_when_value, actual);
}

function sectionLetterLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function sectionPillVariant(status: SectionStatus): string {
  if (status === "complete") return "ok";
  if (status === "pending") return "inf";
  return "mu";
}

export default function CustomerQuestionnaireEntryPage() {
  const navigate = useNavigate();
  const { customerId: customerIdParam } = useParams<{ customerId?: string }>();
  const { success, error: showError } = useToast();
  const setSidebarCollapsed = useUIStore((state) => state.setSidebarCollapsed);
  const autoStartedForRef = useRef<string | undefined>(undefined);

  const [customerOptions, setCustomerOptions] = useState<
    CustomerSelectOption[]
  >([]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [sections, setSections] = useState<Structure[]>([]);
  const [subsections, setSubsections] = useState<Structure[]>([]);
  const [questions, setQuestions] = useState<QElement[]>([]);
  const [fields, setFields] = useState<QElement[]>([]);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [dirty, setDirty] = useState<
    Record<number, { answer_value: string; remarks?: string }>
  >({});
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
  const [masterOptions, setMasterOptions] = useState<
    Record<string, SelectOption[]>
  >({});
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [loadingQuestionnaire, setLoadingQuestionnaire] = useState(false);
  const [saving, setSaving] = useState(false);
  const [started, setStarted] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    null,
  );
  const [loadedQuestionnaireId, setLoadedQuestionnaireId] = useState<
    number | null
  >(null);

  useEffect(() => {
    const previous = useUIStore.getState().sidebarCollapsed;
    setSidebarCollapsed(true);
    return () => setSidebarCollapsed(previous);
  }, [setSidebarCollapsed]);

  const selectedCustomer =
    customerOptions.find((customer) => Number(customer.value) === customerId) ||
    null;
  const selectedCustomerNeedsApproval =
    (selectedCustomer?.approvalStatus || "").toLowerCase() === "pending";
  const selectedCustomerApprovalMessage = selectedCustomerNeedsApproval
    ? `Approval needed: ${selectedCustomer?.label || "This customer"} is ${selectedCustomer?.approvalDisplay || "Pending"} and cannot be used to create a questionnaire yet.`
    : "";
  const sortedSections = useMemo(
    () =>
      [...sections].sort(
        (a, b) => a.display_order - b.display_order || a.id - b.id,
      ),
    [sections],
  );
  const sortedSubsections = useMemo(
    () =>
      [...subsections].sort(
        (a, b) => a.display_order - b.display_order || a.id - b.id,
      ),
    [subsections],
  );
  const displayedSubsectionIds = useMemo(() => {
    const ids = new Set<number>();
    questions.forEach((question) => {
      if (typeof question.subsection_id === "number")
        ids.add(question.subsection_id);
    });
    return ids;
  }, [questions]);
  const displayedSectionIds = useMemo(() => {
    const ids = new Set<number>();
    const subsectionParentById = new Map(
      sortedSubsections.map((subsection) => [
        subsection.id,
        subsection.parent_id,
      ]),
    );
    questions.forEach((question) => {
      if (typeof question.section_id === "number") ids.add(question.section_id);
      if (typeof question.subsection_id === "number") {
        const parentId = subsectionParentById.get(question.subsection_id);
        if (typeof parentId === "number") ids.add(parentId);
      }
    });
    return ids;
  }, [questions, sortedSubsections]);
  const displayedSections = useMemo(
    () =>
      sortedSections.filter((section) => displayedSectionIds.has(section.id)),
    [displayedSectionIds, sortedSections],
  );
  const displayedSubsections = useMemo(
    () =>
      sortedSubsections.filter((subsection) =>
        displayedSubsectionIds.has(subsection.id),
      ),
    [displayedSubsectionIds, sortedSubsections],
  );
  const groupedSections = useMemo(
    () =>
      displayedSections.map((section) => {
        const sectionSubsections = displayedSubsections
          .filter((subsection) => subsection.parent_id === section.id)
          .map((subsection) => ({
            subsection,
            questions: questions
              .filter((question) => question.subsection_id === subsection.id)
              .sort(
                (a, b) =>
                  (a.display_order || 0) - (b.display_order || 0) ||
                  a.id - b.id,
              ),
          }));
        return { section, subsections: sectionSubsections };
      }),
    [displayedSections, displayedSubsections, questions],
  );

  const fieldsByParentElementId = useMemo(() => {
    const next: Record<number, QElement[]> = {};
    fields.forEach((field) => {
      if (typeof field.parent_element_id !== "number") return;
      next[field.parent_element_id] = [
        ...(next[field.parent_element_id] || []),
        field,
      ];
    });
    Object.values(next).forEach((questionFields) => {
      questionFields.sort(
        (a, b) =>
          (a.display_order || 0) - (b.display_order || 0) || a.id - b.id,
      );
    });
    return next;
  }, [fields]);

  const fieldsOf = (parentElementId: number) =>
    fieldsByParentElementId[parentElementId] || [];

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

  const resetQuestionnaire = () => {
    setStarted(false);
    setSelectedSectionId(null);
    setSections([]);
    setSubsections([]);
    setQuestions([]);
    setFields([]);
    setAnswers({});
    setDirty({});
    setFieldErrors({});
    setMasterOptions({});
    setLoadedQuestionnaireId(null);
  };

  const handleCustomerChange = (value: string | number | null) => {
    setCustomerId(value ? Number(value) : null);
    resetQuestionnaire();
  };

  useEffect(() => {
    setLoadingCustomers(true);
    api
      .get<CustomerOptionRow[]>("/customers/", { params: { limit: 100000 } })
      .then((res) => {
        setCustomerOptions(
          (res.data || []).map((customer) => {
            const assignedUserName =
              customer.assigned_user_name?.trim() || null;
            const customerVertical = customer.customer_vertical?.trim() || null;
            const approvalStatus =
              String(customer.approval_status || "")
                .trim()
                .toLowerCase() || null;
            const approvalDisplay =
              String(customer.approval_display || "").trim() || null;
            return {
              value: customer.id,
              label: customer.customer_name,
              subtitle:
                approvalStatus === "pending"
                  ? `${approvalDisplay || "Pending"} - Approval needed before questionnaire creation`
                  : [
                      customerVertical,
                      assignedUserName ? `Assigned: ${assignedUserName}` : null,
                    ]
                      .filter(Boolean)
                      .join(" | "),
              assignedUserName,
              customerVertical,
              approvalStatus,
              approvalDisplay,
            };
          }),
        );
      })
      .catch(() => showError("Failed to load customers"))
      .finally(() => setLoadingCustomers(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStartQuestionnaire = async (idOverride?: number) => {
    const targetCustomerId = idOverride ?? customerId;
    if (!targetCustomerId) {
      showError("Select a customer");
      return;
    }
    const targetCustomer =
      customerOptions.find(
        (customer) => Number(customer.value) === targetCustomerId,
      ) || null;
    if ((targetCustomer?.approvalStatus || "").toLowerCase() === "pending") {
      showError(
        `Approval needed: ${targetCustomer?.label || "This customer"} is ${targetCustomer?.approvalDisplay || "Pending"} and cannot be used to create a questionnaire yet.`,
      );
      return;
    }

    setLoadingQuestionnaire(true);
    resetQuestionnaire();

    try {
      const res = await questionnaireApi.getCustomerQuestionnaire(
        targetCustomerId,
        { refresh: Date.now() },
      );
      const data = res.data;
      const nextQuestionnaireId = Number(data.questionnaire?.id) || null;
      const nextSections = [...(data.sections || [])].sort(
        (a: Structure, b: Structure) =>
          a.display_order - b.display_order || a.id - b.id,
      );
      const nextSubsections = [...(data.subsections || [])].sort(
        (a: Structure, b: Structure) =>
          a.display_order - b.display_order || a.id - b.id,
      );
      const nextQuestions = (data.questions || []) as QElement[];
      const nextFields = (data.fields || []) as QElement[];
      let nextAnswers = normalizeAnswers(data.answers);
      if (!Object.prototype.hasOwnProperty.call(data, "answers")) {
        const answerResponses = await Promise.allSettled(
          nextSections.map((section) =>
            questionnaireApi.getSection(
              targetCustomerId,
              section.id,
              nextQuestionnaireId
                ? { questionnaire_id: nextQuestionnaireId }
                : undefined,
            ),
          ),
        );
        answerResponses.forEach((result) => {
          if (result.status === "fulfilled") {
            Object.assign(
              nextAnswers,
              normalizeAnswers(result.value.data.answers),
            );
          }
        });
      }
      const subsectionParentById = new Map(
        nextSubsections.map((subsection) => [
          subsection.id,
          subsection.parent_id,
        ]),
      );
      const firstSectionWithQuestions = nextQuestions
        .map((question) => {
          if (typeof question.section_id === "number")
            return question.section_id;
          if (typeof question.subsection_id === "number")
            return subsectionParentById.get(question.subsection_id);
          return null;
        })
        .find(
          (sectionId): sectionId is number => typeof sectionId === "number",
        );

      setSections(nextSections);
      setSubsections(nextSubsections);
      setQuestions(nextQuestions);
      setFields(nextFields);
      setAnswers(nextAnswers);
      setSelectedSectionId(
        firstSectionWithQuestions || nextSections[0]?.id || null,
      );
      setLoadedQuestionnaireId(nextQuestionnaireId);
      setStarted(true);
    } catch (error: any) {
      showError(
        error.response?.data?.detail || "Failed to load questionnaire form",
      );
    } finally {
      setLoadingQuestionnaire(false);
    }
  };

  useEffect(() => {
    if (!customerIdParam || autoStartedForRef.current === customerIdParam)
      return;
    const id = Number(customerIdParam);
    if (!Number.isFinite(id)) return;
    autoStartedForRef.current = customerIdParam;
    setCustomerId(id);
    handleStartQuestionnaire(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerIdParam]);

  useEffect(() => {
    const keys = new Set<string>();
    [...questions, ...fields].forEach((element) => {
      const options = element.options_json as any;
      if (
        options &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        options.source_type === "master" &&
        !masterOptions[options.master_key]
      ) {
        keys.add(options.master_key);
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
  }, [fields, masterOptions, questions]);

  const resolveOptions = (element: QElement): SelectOption[] | undefined => {
    const options = element.options_json as any;
    if (
      options &&
      typeof options === "object" &&
      !Array.isArray(options) &&
      options.source_type === "master"
    ) {
      return masterOptions[options.master_key];
    }
    return undefined;
  };

  const uploadFile = async (elementId: number, file: File) => {
    if (!customerId) return;
    try {
      const res = await questionnaireApi.uploadAnswerFile(
        customerId,
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

  // For Yes/No questions, show only the fields configured under Conditional Fields
  // for the selected answer. Legacy always-visible children stay hidden here.
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

  const visibleDescendantFieldsOf = (element: QElement): QElement[] =>
    visibleFieldsOf(element).flatMap((field) => [
      field,
      ...visibleDescendantFieldsOf(field),
    ]);

  const visibleElementIds = () =>
    questions.flatMap((question) => [
      question.id,
      ...visibleDescendantFieldsOf(question).map((field) => field.id),
    ]);

  const sectionElementIds = (
    sectionSubsections: Array<{ questions: QElement[] }>,
  ) =>
    sectionSubsections.flatMap((item) =>
      item.questions.flatMap((question) => [
        question.id,
        ...visibleDescendantFieldsOf(question).map((field) => field.id),
      ]),
    );

  const hasAnswer = (elementId: number): boolean =>
    currentValue(elementId).trim().length > 0;

  const requiredMissingLabels = (
    sectionSubsections: Array<{ questions: QElement[] }>,
  ) =>
    sectionSubsections.flatMap((item) =>
      item.questions.flatMap((question) => {
        const missing: string[] = [];
        if (
          question.is_required &&
          isYesNoAnswerType(question.input_type) &&
          !hasAnswer(question.id)
        ) {
          missing.push(question.element_label);
        }
        visibleDescendantFieldsOf(question).forEach((field) => {
          if (field.is_required && !hasAnswer(field.id))
            missing.push(field.element_label);
        });
        return missing;
      }),
    );

  const requiredElementIds = (
    sectionSubsections: Array<{ questions: QElement[] }>,
  ) =>
    sectionSubsections.flatMap((item) =>
      item.questions.flatMap((question) => [
        ...(question.is_required && isYesNoAnswerType(question.input_type)
          ? [question.id]
          : []),
        ...visibleDescendantFieldsOf(question)
          .filter((field) => field.is_required)
          .map((field) => field.id),
      ]),
    );

  const questionCompleted = (question: QElement): boolean => {
    const isYesNo = isYesNoAnswerType(question.input_type);
    if (isYesNo && !hasAnswer(question.id)) return false;
    const qFields = visibleDescendantFieldsOf(question);
    if (qFields.length === 0) return isYesNo;
    const requiredFields = qFields.filter((field) => field.is_required);
    if (requiredFields.length > 0)
      return requiredFields.every((field) => hasAnswer(field.id));
    return qFields.every((field) => hasAnswer(field.id));
  };

  const sectionCompletion = (
    sectionSubsections: Array<{ questions: QElement[] }>,
  ) => {
    const sectionQuestions = sectionSubsections.flatMap(
      (item) => item.questions,
    );
    const sectionIds = sectionElementIds(sectionSubsections);
    const requiredIds = requiredElementIds(sectionSubsections);
    const sectionFields = sectionQuestions.flatMap((question) =>
      visibleDescendantFieldsOf(question),
    );
    const completed = sectionQuestions.filter(questionCompleted).length;
    const total = sectionQuestions.length;
    const answeredFields = sectionFields.filter((field) =>
      hasAnswer(field.id),
    ).length;
    const answeredElements = sectionIds.filter((id) => hasAnswer(id)).length;
    const isComplete =
      requiredIds.length > 0
        ? requiredIds.every((id) => hasAnswer(id))
        : total > 0 && answeredElements > 0 && completed === total;
    const status: SectionStatus = isComplete
      ? "complete"
      : answeredElements > 0
        ? "pending"
        : "untouched";
    return {
      completed,
      total,
      answeredFields,
      answeredElements,
      percentage: total ? Math.round((completed / total) * 100) : 0,
      isComplete,
      status,
    };
  };

  const selectedSectionGroup =
    groupedSections.find((item) => item.section.id === selectedSectionId) ||
    groupedSections[0] ||
    null;
  const selectedSectionIndex = selectedSectionGroup
    ? groupedSections.findIndex(
        (item) => item.section.id === selectedSectionGroup.section.id,
      )
    : -1;
  const selectedSectionCompletion = selectedSectionGroup
    ? sectionCompletion(selectedSectionGroup.subsections)
    : null;
  const selectedSectionMissingRequired = selectedSectionGroup
    ? requiredMissingLabels(selectedSectionGroup.subsections)
    : [];
  const firstIncompleteSectionIndex = groupedSections.findIndex(
    (item) => requiredMissingLabels(item.subsections).length > 0,
  );
  const highestUnlockedSectionIndex =
    firstIncompleteSectionIndex === -1
      ? groupedSections.length - 1
      : firstIncompleteSectionIndex;
  const selectedSectionCanMoveNext = Boolean(
    selectedSectionGroup &&
    selectedSectionIndex >= 0 &&
    selectedSectionIndex < groupedSections.length - 1 &&
    selectedSectionMissingRequired.length === 0,
  );

  const sectionStepUnlocked = (sectionIndex: number) =>
    sectionIndex <= highestUnlockedSectionIndex;

  const handleSectionStepClick = (sectionId: number, sectionIndex: number) => {
    if (sectionStepUnlocked(sectionIndex)) {
      setSelectedSectionId(sectionId);
      return;
    }

    const blockingSectionIndex = groupedSections.findIndex(
      (item, index) =>
        index < sectionIndex &&
        requiredMissingLabels(item.subsections).length > 0,
    );
    showError(
      `Complete mandatory questions in Section ${sectionLetterLabel(blockingSectionIndex >= 0 ? blockingSectionIndex : highestUnlockedSectionIndex)} before moving ahead`,
    );
  };

  const sectionSaveMessage = (sectionIndex: number) =>
    `Section ${sectionLetterLabel(sectionIndex)} saved`;

  // scroll to / focus the first answer showing an error (wrappers carry id="qa-<element id>")
  const focusFirstAnswer = (ids: number[]) => {
    requestAnimationFrame(() => {
      const box = ids
        .map((id) => document.getElementById(`qa-${id}`))
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

  const handleSaveSection = async (successMessage?: string) => {
    if (!selectedSectionGroup || selectedSectionIndex < 0) return false;
    const missing = requiredMissingLabels(selectedSectionGroup.subsections);
    if (missing.length) {
      const missingIds = requiredElementIds(
        selectedSectionGroup.subsections,
      ).filter((id) => !hasAnswer(id));
      setFieldErrors((prev) => {
        const next = { ...prev };
        missingIds.forEach((id) => {
          next[id] = "This field is required";
        });
        return next;
      });
      focusFirstAnswer(missingIds);
      showError(
        `Complete required fields in Section ${sectionLetterLabel(selectedSectionIndex)}`,
      );
      return false;
    }
    return saveDraft({
      ids: sectionElementIds(selectedSectionGroup.subsections),
      successMessage:
        successMessage || sectionSaveMessage(selectedSectionIndex),
      forceSaveWhenClean: true,
    });
  };

  const handleSaveAndNextSection = async () => {
    if (!selectedSectionGroup || selectedSectionIndex < 0) return;
    const ok = await handleSaveSection();
    if (!ok) return;
    const nextSection = groupedSections[selectedSectionIndex + 1]?.section;
    if (nextSection) {
      setSelectedSectionId(nextSection.id);
      document
        .getElementById("questionnaire-active-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleSubmitQuestionnaire = async () => {
    const ok = await handleSaveSection("Questionnaire submitted");
    if (!ok) return;
    navigate("/questionnaire");
  };

  const saveDraft = async (options?: {
    ids?: number[];
    successMessage?: string;
    forceSaveWhenClean?: boolean;
  }) => {
    if (!customerId) {
      showError("Select a customer");
      return false;
    }
    if (!started) {
      showError("Start the questionnaire first");
      return false;
    }
    const ids = options?.ids || visibleElementIds();
    const successMessage = options?.successMessage || "Draft saved";
    const dirtyEntries = Object.entries(dirty).filter(([id]) =>
      ids.includes(Number(id)),
    );
    const dirtyIds = new Set(dirtyEntries.map(([id]) => Number(id)));
    const defaultEntries = ids
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
    if (!entries.length && !options?.forceSaveWhenClean) {
      success(successMessage);
      return true;
    }

    const invalidEntries = entries
      .map(([id, value]) => ({
        id: Number(id),
        el: elementById[Number(id)],
        value: value.answer_value,
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
      await questionnaireApi.saveAnswers(customerId, {
        questionnaire_id: loadedQuestionnaireId || undefined,
        answers: entries.map(([element_id, value]) => ({
          element_id: Number(element_id),
          answer_value: value.answer_value,
          remarks: value.remarks,
        })),
      });
      setAnswers((prev) => {
        const next = { ...prev };
        entries.forEach(([id, value]) => {
          next[Number(id)] = {
            answer_value: value.answer_value,
            remarks: value.remarks ?? null,
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
      success(successMessage);
      return true;
    } catch (error: unknown) {
      console.error("[Questionnaire] save failed", error);
      const serverFields = (
        error as {
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
      showError(extractSaveErrorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const canEditQuestions = Boolean(
    customerId && started && !loadingQuestionnaire,
  );
  const totalQuestions = questions.length;
  const totalSubsections = displayedSubsections.length;
  const questionnaireStatusLabel = started
    ? "Questionnaire loaded"
    : customerId
      ? "Ready to start"
      : "Awaiting customer";

  return (
    <div className="bwi fpage">
      <div className="pg">
        <div>
          <div className="crumb">Customer Questionnaires</div>
          <h1>
            {customerIdParam
              ? "Continue Questionnaire"
              : "Add New Questionnaire"}
          </h1>
        </div>
        <span className="fl" />
        <button
          type="button"
          className="btn g"
          onClick={() => navigate("/questionnaire")}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => saveDraft()}
          disabled={saving || !canEditQuestions}
        >
          <Save size={13} /> {saving ? "Saving…" : "Save Draft"}
        </button>
        <button
          type="button"
          className="btn p"
          onClick={() => handleStartQuestionnaire()}
          disabled={
            !customerId ||
            saving ||
            selectedCustomerNeedsApproval ||
            loadingQuestionnaire
          }
        >
          {started ? (
            <RefreshCw
              size={13}
              className={loadingQuestionnaire ? "animate-spin" : ""}
            />
          ) : (
            <PlayCircle size={13} />
          )}
          {started ? "Refresh Questionnaire" : "Start Questionnaire"}
        </button>
      </div>

      <Panel title="Questionnaire Details">
        <p className="mu mb" style={{ fontSize: 12 }}>
          Select a customer, then start to load the complete configured
          questionnaire.
        </p>
        <div
          className="g"
          style={{
            gridTemplateColumns: "minmax(18rem, 34rem) minmax(0, 1fr)",
            alignItems: "end",
          }}
        >
          <SearchableSelect
            label="Customer"
            required
            options={customerOptions}
            value={customerId}
            onChange={handleCustomerChange}
            placeholder={loadingCustomers ? "Loading..." : "Select customer"}
            loading={loadingCustomers}
            disabled={loadingQuestionnaire || saving}
            error={selectedCustomerApprovalMessage || undefined}
          />
          <div
            className="g"
            style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
          >
            <div>
              <small>Assigned user</small>
              <p style={{ fontWeight: 700, fontSize: 13 }}>
                {customerId
                  ? selectedCustomer?.assignedUserName || "Unassigned"
                  : "Select a customer"}
              </p>
            </div>
            <div>
              <small>Status</small>
              <p style={{ fontWeight: 700, fontSize: 13 }}>
                {questionnaireStatusLabel}
              </p>
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="mt" title="Questions" z>
        <Strip
          items={[
            {
              l: "Sections",
              v: started ? displayedSections.length : 0,
              f: "int",
            },
            { l: "Subsections", v: started ? totalSubsections : 0, f: "int" },
            { l: "Questions", v: started ? totalQuestions : 0, f: "int" },
          ]}
        />
        {started && totalQuestions > 0 && (
          <div className="tabs">
            {groupedSections.map(
              ({ section, subsections: sectionSubsections }, sectionIndex) => {
                const completion = sectionCompletion(sectionSubsections);
                const code = sectionLetterLabel(sectionIndex);
                const selected =
                  section.id === selectedSectionGroup?.section.id;
                const locked = !sectionStepUnlocked(sectionIndex);
                return (
                  <button
                    key={section.id}
                    type="button"
                    title={
                      locked
                        ? `Complete mandatory questions in previous sections to unlock Section ${code}`
                        : `${section.structure_name}: ${completion.completed}/${completion.total} questions complete`
                    }
                    aria-disabled={locked}
                    onClick={() =>
                      handleSectionStepClick(section.id, sectionIndex)
                    }
                    className={`tab qf-step ${selected ? "on" : ""} ${sectionPillVariant(completion.status) === "ok" ? "complete" : ""} ${locked ? "locked" : ""}`}
                  >
                    Section {code}
                  </button>
                );
              },
            )}
          </div>
        )}

        <div className="pb">
          {loadingQuestionnaire ? (
            <div className="empty">
              <Loader2 size={18} className="animate-spin" /> Loading
              questions...
            </div>
          ) : !customerId ? (
            <EmptyState
              icon={<ClipboardList size={28} />}
              title="Select a customer to start"
              description="Only the customer is required here. The full questionnaire loads after you start."
            />
          ) : !started ? (
            <EmptyState
              icon={<ClipboardList size={28} />}
              title="Ready to load questionnaire"
              description="Click Start Questionnaire to load all sections, subsections, questions, and dependent fields."
            />
          ) : totalQuestions === 0 ? (
            <EmptyState
              icon={<ClipboardList size={28} />}
              title="No questions configured"
              description="Questions must be configured in the Form Builder module."
            />
          ) : !selectedSectionGroup ? (
            <EmptyState
              icon={<ClipboardList size={28} />}
              title="No section selected"
              description="Select a section tab to view its questions."
            />
          ) : (
            (() => {
              const { section, subsections: sectionSubsections } =
                selectedSectionGroup;
              const sectionIndex = selectedSectionIndex;
              const completion =
                selectedSectionCompletion ||
                sectionCompletion(sectionSubsections);
              const nextSection = groupedSections[sectionIndex + 1]?.section;
              return (
                <div key={section.id} id="questionnaire-active-section">
                  <div
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 10,
                    }}
                  >
                    <span className="row" style={{ gap: 10 }}>
                      <span
                        className={`pill ${sectionPillVariant(completion.status)}`}
                        style={{ fontSize: 13, padding: "3px 10px" }}
                      >
                        {sectionLetterLabel(sectionIndex)}
                      </span>
                      <span>
                        <b style={{ fontSize: 13 }}>{section.structure_name}</b>
                        <small style={{ display: "block" }}>
                          {sectionSubsections.length} subsection
                          {sectionSubsections.length === 1 ? "" : "s"}
                        </small>
                      </span>
                    </span>
                    <span
                      className={`pill ${sectionPillVariant(completion.status)}`}
                    >
                      {completion.total
                        ? `${completion.completed}/${completion.total} done`
                        : "Section"}
                    </span>
                  </div>

                  {sectionSubsections.length === 0 && (
                    <p className="mu mt">
                      No subsections configured for this section.
                    </p>
                  )}
                  {sectionSubsections.map(
                    ({ subsection, questions: subsectionQuestions }) => (
                      <div key={subsection.id} className="mt">
                        <div
                          className="row"
                          style={{ justifyContent: "space-between" }}
                        >
                          <h4 style={{ margin: 0 }}>
                            {subsection.structure_name}
                          </h4>
                          <span className="pill mu">
                            {subsectionQuestions.length} question
                            {subsectionQuestions.length === 1 ? "" : "s"}
                          </span>
                        </div>

                        {subsectionQuestions.length === 0 ? (
                          <p className="mu mt">
                            No questions configured in this subsection.
                          </p>
                        ) : (
                          subsectionQuestions.map((question) => {
                            const dependentFields =
                              visibleDescendantFieldsOf(question);
                            const isYesNoQuestion = isYesNoAnswerType(
                              question.input_type,
                            );
                            return (
                              <div key={question.id} className="qf-qcard mt">
                                <div className="qf-qhead">
                                  <span
                                    className="row"
                                    style={{ gap: 6, alignItems: "flex-start" }}
                                  >
                                    <span
                                      className="qf-qcode"
                                      title={question.element_code}
                                    >
                                      {question.element_code}
                                    </span>
                                    <label className="qf-qlabel">
                                      {question.element_label}
                                      {question.is_required && (
                                        <b style={{ color: "var(--bw-ba)" }}>
                                          {" "}
                                          *
                                        </b>
                                      )}
                                    </label>
                                  </span>
                                  {isYesNoQuestion && (
                                    <div style={{ flexShrink: 0 }}>
                                      <QuestionnaireAnswerField
                                        element={question}
                                        value={currentValue(question.id)}
                                        onChange={(next) =>
                                          setAnswer(question.id, next)
                                        }
                                        error={fieldErrors[question.id]}
                                      />
                                    </div>
                                  )}
                                </div>

                                {dependentFields.length > 0 && (
                                  <div className="qf-fields">
                                    {dependentFields.map((field) => (
                                      <div
                                        key={field.id}
                                        className="qf-field min-w-0"
                                      >
                                        <label>
                                          {field.element_label}
                                          {field.is_required && (
                                            <b
                                              style={{ color: "var(--bw-ba)" }}
                                            >
                                              {" "}
                                              *
                                            </b>
                                          )}
                                        </label>
                                        <QuestionnaireAnswerField
                                          element={field}
                                          value={currentValue(field.id)}
                                          onChange={(next) =>
                                            setAnswer(field.id, next)
                                          }
                                          error={fieldErrors[field.id]}
                                          masterOptions={resolveOptions(field)}
                                          onUploadFile={(file) =>
                                            uploadFile(field.id, file)
                                          }
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    ),
                  )}

                  <div
                    className="row mt"
                    style={{
                      justifyContent: "space-between",
                      borderTop: "1px solid var(--bw-ln2)",
                      paddingTop: 10,
                    }}
                  >
                    <small>
                      Section {sectionLetterLabel(sectionIndex)}{" "}
                      {completion.total
                        ? `- ${completion.completed}/${completion.total} answered`
                        : ""}
                    </small>
                    <div className="row" style={{ gap: 8 }}>
                      {nextSection ? (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleSaveSection()}
                            disabled={saving}
                          >
                            <Save size={13} /> Save Section
                          </button>
                          <button
                            type="button"
                            className="btn p"
                            onClick={handleSaveAndNextSection}
                            disabled={saving || !selectedSectionCanMoveNext}
                          >
                            <PlayCircle size={13} /> Save & Next Section
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn p"
                          onClick={handleSubmitQuestionnaire}
                          disabled={saving}
                        >
                          <Save size={13} /> Submit Questionnaire
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </Panel>
    </div>
  );
}
