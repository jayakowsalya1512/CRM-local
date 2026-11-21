"""Questionnaire module — Master Setup, Form Builder, and Customer Questionnaire APIs.

Compact 5-table design: questionnaires, questionnaire_structure (sections +
subsections), questionnaire_form_elements (questions + dependent fields),
customer_questionnaires (per-customer status/progress), and
customer_questionnaire_answers (main + dependent-field answers).
"""
import os
import re
from datetime import datetime
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session, aliased

from app.core.config import settings
from app.core.validators import check_name, check_text, field_error
from app.core.validators import check_email, check_mobile
from app.dependencies import get_current_user, get_tenant_db, require_permission
from app.models.all_models import (
    Customer,
    CustomerQuestionnaire,
    CustomerQuestionnaireAnswer,
    Questionnaire,
    QuestionnaireFormElement,
    QuestionnaireStructure,
    SalesCustomerAssignment,
)
from app.models.user import User
from app.services.cache_service import (
    CACHE_TTL_SECONDS,
    cache_get_json,
    cache_set_json,
    invalidate_questionnaire_config_cache,
    questionnaire_config_cache_key,
    tenant_slug_from_db,
)
from app.services.storage_usage_service import ensure_tenant_storage_available
from app.utils.data_scope import apply_data_scope
from app.utils.file_storage import media_slug_from_request, save_upload_optimized, stored_upload_accounted_size

QUESTIONNAIRE_FILE_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".jpg", ".jpeg", ".png", ".webp"}

router = APIRouter()


# ─── Schema self-heal (mirrors masters_router._ensure_vertical_sector_schema) ──

_schema_ready_tenants: set[str] = set()


def _column_exists(db: Session, table_name: str, column_name: str) -> bool:
    return bool(db.execute(sa_text(
        """
        SELECT COUNT(*)
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :table_name
          AND COLUMN_NAME = :column_name
        """
    ), {"table_name": table_name, "column_name": column_name}).scalar() or 0)


def _index_exists(db: Session, table_name: str, index_name: str) -> bool:
    return bool(db.execute(sa_text(
        """
        SELECT COUNT(*)
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :table_name
          AND INDEX_NAME = :index_name
        """
    ), {"table_name": table_name, "index_name": index_name}).scalar() or 0)


def _has_duplicate_customer_questionnaires(db: Session) -> bool:
    return bool(db.execute(sa_text(
        """
        SELECT COUNT(*)
        FROM (
            SELECT customer_id, questionnaire_id
            FROM customer_questionnaires
            GROUP BY customer_id, questionnaire_id
            HAVING COUNT(*) > 1
        ) duplicate_questionnaires
        """
    )).scalar() or 0)


def _ensure_legacy_questionnaire_version_schema(db: Session) -> bool:
    """Keep tenant DBs that still have the old version columns insertable."""
    try:
        if _column_exists(db, "questionnaires", "version_no"):
            db.execute(sa_text(
                "ALTER TABLE questionnaires MODIFY COLUMN `version_no` INT NOT NULL DEFAULT 1"
            ))
            db.commit()
    except Exception:
        db.rollback()

    try:
        if not _column_exists(db, "customer_questionnaires", "questionnaire_version"):
            return True

        db.execute(sa_text(
            "ALTER TABLE customer_questionnaires "
            "MODIFY COLUMN `questionnaire_version` INT NOT NULL DEFAULT 1"
        ))
        db.commit()
    except Exception:
        db.rollback()
        return False

    try:
        if _has_duplicate_customer_questionnaires(db):
            return True

        if _index_exists(db, "customer_questionnaires", "uq_customer_questionnaire_version"):
            db.execute(sa_text(
                "ALTER TABLE customer_questionnaires DROP INDEX `uq_customer_questionnaire_version`"
            ))
            db.commit()

        if _column_exists(db, "customer_questionnaires", "questionnaire_version"):
            db.execute(sa_text(
                "ALTER TABLE customer_questionnaires DROP COLUMN `questionnaire_version`"
            ))
            db.commit()

        if not _index_exists(db, "customer_questionnaires", "uq_customer_questionnaire"):
            db.execute(sa_text(
                "ALTER TABLE customer_questionnaires "
                "ADD UNIQUE KEY `uq_customer_questionnaire` (`customer_id`, `questionnaire_id`)"
            ))
            db.commit()
    except Exception:
        db.rollback()
    return True


def _ensure_questionnaire_schema(db: Session) -> None:
    tenant_slug = tenant_slug_from_db(db)
    if tenant_slug and tenant_slug in _schema_ready_tenants:
        return

    statements = (
        """
        CREATE TABLE IF NOT EXISTS questionnaires (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            questionnaire_code VARCHAR(50) NOT NULL,
            questionnaire_name VARCHAR(200) NOT NULL,
            description TEXT NULL,
            status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_by INT NULL,
            updated_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_questionnaires_status_active (status, is_active)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS questionnaire_structure (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            questionnaire_id INT NOT NULL,
            parent_id INT NULL,
            structure_type ENUM('section','subsection') NOT NULL,
            structure_code VARCHAR(50) NOT NULL,
            structure_name VARCHAR(200) NOT NULL,
            description TEXT NULL,
            display_order INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_by INT NULL,
            updated_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_qstructure_lookup (questionnaire_id, parent_id, structure_type, is_active, display_order),
            CONSTRAINT fk_qs_questionnaire FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
            CONSTRAINT fk_qs_parent FOREIGN KEY (parent_id) REFERENCES questionnaire_structure(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS questionnaire_form_elements (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            questionnaire_id INT NOT NULL,
            section_id INT NOT NULL,
            subsection_id INT NOT NULL,
            parent_element_id INT NULL,
            element_type ENUM('question','field') NOT NULL,
            element_code VARCHAR(50) NOT NULL,
            element_label VARCHAR(500) NOT NULL,
            input_type VARCHAR(30) NOT NULL,
            is_required TINYINT(1) NOT NULL DEFAULT 0,
            allow_remarks TINYINT(1) NOT NULL DEFAULT 0,
            display_order INT NOT NULL DEFAULT 0,
            show_when_operator VARCHAR(20) NULL,
            show_when_value VARCHAR(200) NULL,
            options_json JSON NULL,
            placeholder VARCHAR(200) NULL,
            default_value VARCHAR(500) NULL,
            validation_json JSON NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_by INT NULL,
            updated_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_qelements_lookup (questionnaire_id, section_id, subsection_id, parent_element_id, element_type, is_active, display_order),
            CONSTRAINT fk_qfe_questionnaire FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
            CONSTRAINT fk_qfe_section FOREIGN KEY (section_id) REFERENCES questionnaire_structure(id) ON DELETE CASCADE,
            CONSTRAINT fk_qfe_subsection FOREIGN KEY (subsection_id) REFERENCES questionnaire_structure(id) ON DELETE CASCADE,
            CONSTRAINT fk_qfe_parent FOREIGN KEY (parent_element_id) REFERENCES questionnaire_form_elements(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS customer_questionnaires (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            customer_id INT NOT NULL,
            questionnaire_id INT NOT NULL,
            status ENUM('not_started','in_progress','completed','reopened') NOT NULL DEFAULT 'not_started',
            total_questions INT NOT NULL DEFAULT 0,
            completed_questions INT NOT NULL DEFAULT 0,
            progress_percentage INT NOT NULL DEFAULT 0,
            started_at DATETIME NULL,
            completed_at DATETIME NULL,
            last_saved_at DATETIME NULL,
            reopened_at DATETIME NULL,
            reopened_by INT NULL,
            reopen_reason TEXT NULL,
            created_by INT NULL,
            updated_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_customer_questionnaire (customer_id, questionnaire_id),
            INDEX ix_cq_customer_lookup (customer_id, questionnaire_id, status),
            INDEX ix_cq_status_saved (status, last_saved_at),
            CONSTRAINT fk_cq_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
            CONSTRAINT fk_cq_questionnaire FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS customer_questionnaire_answers (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            customer_questionnaire_id INT NOT NULL,
            element_id INT NOT NULL,
            answer_value TEXT NULL,
            remarks TEXT NULL,
            answered_by INT NULL,
            answered_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_cqa_element (customer_questionnaire_id, element_id),
            INDEX ix_cqa_lookup (customer_questionnaire_id, element_id),
            CONSTRAINT fk_cqa_cq FOREIGN KEY (customer_questionnaire_id) REFERENCES customer_questionnaires(id) ON DELETE CASCADE,
            CONSTRAINT fk_cqa_element FOREIGN KEY (element_id) REFERENCES questionnaire_form_elements(id) ON DELETE CASCADE
        )
        """,
    )
    for stmt in statements:
        try:
            db.execute(sa_text(stmt))
            db.commit()
        except Exception:
            db.rollback()

    legacy_schema_ready = _ensure_legacy_questionnaire_version_schema(db)

    if tenant_slug and legacy_schema_ready:
        _schema_ready_tenants.add(tenant_slug)


# ─── Master-key options (safe, fixed allow-list — no arbitrary tables) ────────

ALLOWED_MASTER_KEYS = {"customer_categories", "states", "district", "service_types", "contract_types"}


def _resolve_master_options(db: Session, master_key: str) -> List[dict]:
    if master_key not in ALLOWED_MASTER_KEYS:
        raise HTTPException(400, f"Unknown master key: {master_key}")

    if master_key == "customer_categories":
        rows = (
            db.query(Customer.customer_vertical)
            .filter(Customer.customer_vertical.isnot(None), Customer.customer_vertical != "")
            .distinct()
            .all()
        )
        return [{"label": r[0], "value": r[0]} for r in rows if r[0]]

    if master_key == "states":
        rows = (
            db.query(Customer.billing_state)
            .filter(Customer.billing_state.isnot(None), Customer.billing_state != "")
            .distinct()
            .all()
        )
        return [{"label": r[0], "value": r[0]} for r in rows if r[0]]

    # district / service_types / contract_types: no dedicated master table exists
    # yet in this CRM — return empty rather than guessing at a table name.
    return []


def _allowed_option_values(db: Session, element: QuestionnaireFormElement) -> Optional[set]:
    opts = element.options_json
    if isinstance(opts, list):
        return {str(o.get("value")) for o in opts if isinstance(o, dict) and "value" in o}
    if isinstance(opts, dict) and opts.get("source_type") == "master":
        try:
            resolved = _resolve_master_options(db, str(opts.get("master_key", "")))
        except HTTPException:
            return None
        return {str(o["value"]) for o in resolved}
    return None


# ─── Validation ────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MOBILE_RE = re.compile(r"^\d{10}$")


def _condition_met(operator: Optional[str], expected: Optional[str], actual: Optional[str]) -> bool:
    if not operator:
        return True
    actual_s = "" if actual is None else str(actual).strip().lower()
    expected_s = "" if expected is None else str(expected).strip().lower()
    try:
        if operator == "equals":
            return actual_s == expected_s
        if operator == "not_equals":
            return actual_s != expected_s
        if operator == "contains":
            return expected_s in actual_s
        if operator == "greater_than":
            return float(actual_s) > float(expected_s)
        if operator == "less_than":
            return float(actual_s) < float(expected_s)
    except (TypeError, ValueError):
        return False
    return True


def _is_yes_no_input_type(input_type: Optional[str]) -> bool:
    return input_type in ("yes_no", "yes_no_direct", "yes_no_conditional")


def _is_configured_yes_no_condition(element: QuestionnaireFormElement) -> bool:
    expected = "" if element.show_when_value is None else str(element.show_when_value).strip().lower()
    return element.show_when_operator == "equals" and expected in ("yes", "no")


def _dependent_visible_for_parent(
    element: QuestionnaireFormElement,
    parent: Optional[QuestionnaireFormElement],
    parent_answer: Optional[str],
) -> bool:
    if parent and _is_yes_no_input_type(parent.input_type):
        return _is_configured_yes_no_condition(element) and _condition_met(
            element.show_when_operator,
            element.show_when_value,
            parent_answer,
        )
    return _condition_met(element.show_when_operator, element.show_when_value, parent_answer)


def _visible_fields_by_question_for_answers(
    elements: List[QuestionnaireFormElement],
    answers: dict[int, Optional[str]],
) -> dict[int, List[QuestionnaireFormElement]]:
    children_by_parent: dict[int, List[QuestionnaireFormElement]] = {}
    for element in elements:
        if element.parent_element_id is None:
            continue
        children_by_parent.setdefault(int(element.parent_element_id), []).append(element)

    visible_by_question: dict[int, List[QuestionnaireFormElement]] = {}

    def walk(parent: QuestionnaireFormElement, question_id: int) -> None:
        parent_answer = answers.get(parent.id)
        for child in children_by_parent.get(parent.id, []):
            if child.element_type != "field":
                continue
            if _dependent_visible_for_parent(child, parent, parent_answer):
                visible_by_question.setdefault(question_id, []).append(child)
                walk(child, question_id)

    for element in elements:
        if element.element_type == "question":
            visible_by_question.setdefault(element.id, [])
            walk(element, element.id)

    return visible_by_question


def _visible_field_ids_for_answers(
    elements: List[QuestionnaireFormElement],
    answers: dict[int, Optional[str]],
) -> List[int]:
    visible_by_question = _visible_fields_by_question_for_answers(elements, answers)
    return [field.id for fields in visible_by_question.values() for field in fields]


def _has_answer(answers: dict[int, Optional[str]], element_id: int) -> bool:
    value = answers.get(element_id)
    return value is not None and str(value).strip() != ""


def _question_completed_for_answers(
    question: QuestionnaireFormElement,
    visible_fields: List[QuestionnaireFormElement],
    answers: dict[int, Optional[str]],
) -> bool:
    is_yes_no = _is_yes_no_input_type(question.input_type)
    if is_yes_no and not _has_answer(answers, question.id):
        return False
    if not visible_fields:
        return is_yes_no

    required_fields = [field for field in visible_fields if field.is_required]
    if required_fields:
        return all(_has_answer(answers, field.id) for field in required_fields)
    return all(_has_answer(answers, field.id) for field in visible_fields)


def _question_progress_counts(
    elements: List[QuestionnaireFormElement],
    answers: dict[int, Optional[str]],
) -> tuple[int, int, int]:
    questions = [element for element in elements if element.element_type == "question"]
    visible_by_question = _visible_fields_by_question_for_answers(elements, answers)
    total = len(questions)
    completed = sum(
        1
        for question in questions
        if _question_completed_for_answers(question, visible_by_question.get(question.id, []), answers)
    )
    percentage = int(round((completed / total) * 100)) if total else 0
    return total, completed, percentage


def _answer_values_have_any(answers: dict[int, Optional[str]]) -> bool:
    return any(value is not None and str(value).strip() != "" for value in answers.values())


def _normalized_questionnaire_status(
    current_status: Optional[str],
    total: int,
    completed: int,
    answered_any: bool,
) -> str:
    if total > 0 and completed >= total:
        return "completed"
    if current_status == "reopened":
        return "reopened"
    if answered_any or current_status in ("completed", "in_progress"):
        return "in_progress"
    return "not_started"


def _active_questionnaire_elements(db: Session, questionnaire_id: int) -> List[QuestionnaireFormElement]:
    return (
        db.query(QuestionnaireFormElement)
        .filter(
            QuestionnaireFormElement.questionnaire_id == questionnaire_id,
            QuestionnaireFormElement.is_active == True,
        )
        .all()
    )


def _customer_questionnaire_answer_values(db: Session, cq_id: int) -> dict[int, Optional[str]]:
    return {
        a.element_id: a.answer_value
        for a in db.query(CustomerQuestionnaireAnswer)
        .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id == cq_id)
        .all()
    }


def _live_questionnaire_progress(
    db: Session,
    cq: CustomerQuestionnaire,
) -> tuple[List[QuestionnaireFormElement], dict[int, Optional[str]], int, int, int, bool, str]:
    elements = _active_questionnaire_elements(db, cq.questionnaire_id)
    answer_values = _customer_questionnaire_answer_values(db, cq.id)
    total, completed, percentage = _question_progress_counts(elements, answer_values)
    answered_any = _answer_values_have_any(answer_values)
    status = _normalized_questionnaire_status(cq.status, total, completed, answered_any)
    return elements, answer_values, total, completed, percentage, answered_any, status


def _apply_progress_snapshot(
    cq: CustomerQuestionnaire,
    total: int,
    completed: int,
    percentage: int,
    answered_any: bool,
    status: str,
    *,
    touch_saved_at: bool = False,
) -> None:
    now = datetime.utcnow()
    cq.total_questions = total
    cq.completed_questions = completed
    cq.progress_percentage = percentage
    if touch_saved_at:
        cq.last_saved_at = now
    if answered_any and not cq.started_at:
        cq.started_at = now
    if status == "completed" and cq.status != "completed":
        cq.completed_at = cq.completed_at or now
    cq.status = status


def _validate_answer(db: Session, element: QuestionnaireFormElement, value: Optional[str]) -> Optional[str]:
    if element.is_required and (value is None or str(value).strip() == ""):
        return "This field is required"
    if value is None or str(value).strip() == "":
        return None

    v = str(value).strip()
    t = element.input_type

    if t in ("yes_no", "yes_no_direct", "yes_no_conditional"):
        if v.lower() not in ("yes", "no"):
            return "Must be Yes or No"
    elif t == "yes_no_na":
        if v.lower() not in ("yes", "no", "unknown", "not_applicable"):
            return "Invalid value"
    elif t == "checkbox":
        if v.lower() not in ("true", "false"):
            return "Invalid value"
    elif t == "rating":
        try:
            n = int(v)
        except ValueError:
            return "Must be a whole number"
        if n < 1 or n > 5:
            return "Must be between 1 and 5"
    elif t == "number":
        try:
            int(v)
        except ValueError:
            return "Must be a whole number"
    elif t == "decimal":
        try:
            float(v)
        except ValueError:
            return "Must be a number"
    elif t == "percentage":
        try:
            n = float(v)
        except ValueError:
            return "Must be a number"
        if n < 0 or n > 100:
            return "Must be between 0 and 100"
    elif t == "currency":
        try:
            float(v)
        except ValueError:
            return "Must be a valid amount"
    elif t == "date":
        try:
            d = datetime.fromisoformat(v[:10])
        except ValueError:
            return "Must be a valid date (YYYY-MM-DD)"
        if not 1900 <= d.year <= 2100:
            return "Date must be between 1900 and 2100"
    elif t == "year":
        if not re.fullmatch(r"\d{4}", v):
            return "Must be a valid 4-digit year"
        if not 1900 <= int(v) <= 2100:
            return "Year must be between 1900 and 2100"
    elif t == "time":
        try:
            datetime.strptime(v, "%H:%M")
        except ValueError:
            return "Must be a valid time (HH:MM)"
    elif t == "email":
        try:
            check_email(v)
        except ValueError as e:
            return str(e)
    elif t == "mobile":
        try:
            check_mobile(v, "Mobile number")
        except ValueError as e:
            return str(e)
    elif t in ("single_select", "multi_select"):
        allowed = _allowed_option_values(db, element)
        if allowed is not None:
            values = [v] if t == "single_select" else [x.strip() for x in v.split(",") if x.strip()]
            invalid = [x for x in values if x not in allowed]
            if invalid:
                return f"Invalid option: {', '.join(invalid)}"
    elif t == "text":
        max_len = (element.validation_json or {}).get("max_length") if isinstance(element.validation_json, dict) else None
        if max_len and len(v) > int(max_len):
            return f"Must be at most {max_len} characters"
        if len(v) > 5000:
            return "Must be at most 5000 characters"
    elif t == "textarea" and len(v) > 20000:
        return "Must be at most 20000 characters"
    return None


# ─── Serialization / config assembly (cached only when published) ────────────

def _serialize_structure(s: QuestionnaireStructure) -> dict:
    return {
        "id": s.id, "questionnaire_id": s.questionnaire_id, "parent_id": s.parent_id,
        "structure_type": s.structure_type, "structure_code": s.structure_code,
        "structure_name": s.structure_name, "description": s.description,
        "display_order": s.display_order, "is_active": s.is_active,
    }


def _serialize_element(e: QuestionnaireFormElement) -> dict:
    return {
        "id": e.id, "questionnaire_id": e.questionnaire_id, "section_id": e.section_id,
        "subsection_id": e.subsection_id, "parent_element_id": e.parent_element_id,
        "element_type": e.element_type, "element_code": e.element_code, "element_label": e.element_label,
        "input_type": e.input_type, "is_required": e.is_required, "allow_remarks": e.allow_remarks,
        "display_order": e.display_order, "show_when_operator": e.show_when_operator,
        "show_when_value": e.show_when_value, "options_json": e.options_json,
        "placeholder": e.placeholder, "default_value": e.default_value,
        "validation_json": e.validation_json, "is_active": e.is_active,
    }


def _build_questionnaire_config(db: Session, questionnaire: Questionnaire) -> dict:
    structures = (
        db.query(QuestionnaireStructure)
        .filter(QuestionnaireStructure.questionnaire_id == questionnaire.id, QuestionnaireStructure.is_active == True)
        .order_by(QuestionnaireStructure.display_order, QuestionnaireStructure.id)
        .all()
    )
    elements = (
        db.query(QuestionnaireFormElement)
        .filter(QuestionnaireFormElement.questionnaire_id == questionnaire.id, QuestionnaireFormElement.is_active == True)
        .order_by(QuestionnaireFormElement.display_order, QuestionnaireFormElement.id)
        .all()
    )
    questions = [_serialize_element(e) for e in elements if e.element_type == "question"]
    fields = [_serialize_element(e) for e in elements if e.element_type == "field"]
    return {
        "questionnaire": {
            "id": questionnaire.id, "questionnaire_code": questionnaire.questionnaire_code,
            "questionnaire_name": questionnaire.questionnaire_name,
            "status": questionnaire.status,
        },
        "sections": [_serialize_structure(s) for s in structures if s.structure_type == "section"],
        "subsections": [_serialize_structure(s) for s in structures if s.structure_type == "subsection"],
        "questions": questions,
        "fields": fields,
        # Questions are headings only — fields are the actual answerable units.
        "total_questions": len(questions),
    }


def _get_questionnaire_config(db: Session, questionnaire: Questionnaire) -> dict:
    cache_key = None
    if questionnaire.status == "published":
        tenant_slug = tenant_slug_from_db(db)
        if tenant_slug:
            cache_key = questionnaire_config_cache_key(tenant_slug, questionnaire.id)
            cached = cache_get_json(cache_key, "questionnaire-config")
            if cached is not None:
                return cached

    config = _build_questionnaire_config(db, questionnaire)
    if cache_key:
        cache_set_json(cache_key, config, CACHE_TTL_SECONDS["questionnaire_config"])
    return config


def _latest_questionnaire_locations(db: Session, customer_questionnaire_ids: List[int]) -> dict[int, dict]:
    if not customer_questionnaire_ids:
        return {}

    try:
        section_alias = aliased(QuestionnaireStructure)
        subsection_alias = aliased(QuestionnaireStructure)
        answer_rows = (
            db.query(
                CustomerQuestionnaireAnswer.customer_questionnaire_id,
                CustomerQuestionnaireAnswer.element_id,
                QuestionnaireFormElement.element_type,
                QuestionnaireFormElement.parent_element_id,
                QuestionnaireFormElement.section_id,
                QuestionnaireFormElement.subsection_id,
                section_alias.structure_code.label("section_code"),
                section_alias.structure_name.label("section_name"),
                subsection_alias.structure_code.label("subsection_code"),
                subsection_alias.structure_name.label("subsection_name"),
            )
            .join(QuestionnaireFormElement, QuestionnaireFormElement.id == CustomerQuestionnaireAnswer.element_id)
            .outerjoin(section_alias, section_alias.id == QuestionnaireFormElement.section_id)
            .outerjoin(subsection_alias, subsection_alias.id == QuestionnaireFormElement.subsection_id)
            .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id.in_(customer_questionnaire_ids))
            .order_by(
                CustomerQuestionnaireAnswer.customer_questionnaire_id,
                CustomerQuestionnaireAnswer.answered_at.desc(),
                CustomerQuestionnaireAnswer.created_at.desc(),
                CustomerQuestionnaireAnswer.id.desc(),
            )
            .all()
        )
    except Exception:
        db.rollback()
        return {}

    latest_locations: dict[int, dict] = {}
    for row in answer_rows:
        cq_id = int(row.customer_questionnaire_id)
        if cq_id in latest_locations:
            continue
        question_id = row.element_id if row.element_type == "question" else row.parent_element_id
        latest_locations[cq_id] = {
            "element_id": row.element_id,
            "question_id": question_id,
            "section_id": row.section_id,
            "subsection_id": row.subsection_id,
            "section_code": row.section_code,
            "section_name": row.section_name,
            "subsection_code": row.subsection_code,
            "subsection_name": row.subsection_name,
        }
    return latest_locations


def _resolve_questionnaire(db: Session, questionnaire_id: Optional[int]) -> Optional[Questionnaire]:
    if questionnaire_id:
        row = db.query(Questionnaire).filter(Questionnaire.id == questionnaire_id).first()
        if row:
            return row
    return (
        db.query(Questionnaire)
        .filter(Questionnaire.status == "published", Questionnaire.is_active == True)
        .order_by(Questionnaire.id.desc())
        .first()
    )


def _dependent_subtree_ids(db: Session, parent_id: int) -> List[int]:
    children = (
        db.query(QuestionnaireFormElement)
        .filter(QuestionnaireFormElement.parent_element_id == parent_id)
        .all()
    )
    ids: List[int] = []
    for child in children:
        ids.append(child.id)
        ids.extend(_dependent_subtree_ids(db, child.id))
    return ids


def _clear_hidden_dependent_answers(db: Session, cq_id: int, parent_id: int, new_answer_value: Optional[str]) -> None:
    parent = db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id == parent_id).first()
    dependents = (
        db.query(QuestionnaireFormElement)
        .filter(QuestionnaireFormElement.parent_element_id == parent_id, QuestionnaireFormElement.is_active == True)
        .all()
    )
    if not dependents:
        return
    hide_ids: List[int] = []
    visible_ids: List[int] = []
    for dependent in dependents:
        if _dependent_visible_for_parent(dependent, parent, new_answer_value):
            visible_ids.append(dependent.id)
        else:
            hide_ids.append(dependent.id)
            hide_ids.extend(_dependent_subtree_ids(db, dependent.id))
    if hide_ids:
        db.query(CustomerQuestionnaireAnswer).filter(
            CustomerQuestionnaireAnswer.customer_questionnaire_id == cq_id,
            CustomerQuestionnaireAnswer.element_id.in_(hide_ids),
        ).delete(synchronize_session=False)
    if visible_ids:
        visible_answers = {
            answer.element_id: answer.answer_value
            for answer in db.query(CustomerQuestionnaireAnswer)
            .filter(
                CustomerQuestionnaireAnswer.customer_questionnaire_id == cq_id,
                CustomerQuestionnaireAnswer.element_id.in_(visible_ids),
            )
            .all()
        }
        for visible_id in visible_ids:
            _clear_hidden_dependent_answers(db, cq_id, visible_id, visible_answers.get(visible_id))


def _recalc_progress(db: Session, cq: CustomerQuestionnaire) -> None:
    # Flush pending answer inserts/updates so the counts below see them (session uses autoflush=False).
    db.flush()
    _, _, total, completed, percentage, answered_any, status = _live_questionnaire_progress(db, cq)
    _apply_progress_snapshot(cq, total, completed, percentage, answered_any, status, touch_saved_at=True)


# ─── Pydantic schemas ──────────────────────────────────────────────────────────

class QuestionnaireCreate(BaseModel):
    questionnaire_code: str
    questionnaire_name: str
    description: Optional[str] = None


class QuestionnaireUpdate(BaseModel):
    questionnaire_name: Optional[str] = None
    description: Optional[str] = None


class StructureCreate(BaseModel):
    questionnaire_id: int
    parent_id: Optional[int] = None
    structure_type: str
    structure_code: str
    structure_name: str
    description: Optional[str] = None
    display_order: int = 0

    # same rules as the Questionnaire master UI (utils/validation.ts)
    @field_validator("structure_name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Name", 2, 200)

    @field_validator("structure_code", mode="before")
    @classmethod
    def _v_code(cls, v):
        return check_text(v, "Code", 1, 50, required=True)

    @field_validator("display_order", mode="before")
    @classmethod
    def _v_order(cls, v):
        if v is not None and isinstance(v, (int, float)) and v < 0:
            raise ValueError("Display order cannot be negative.")
        return v


class StructureUpdate(BaseModel):
    structure_code: Optional[str] = None
    structure_name: Optional[str] = None
    description: Optional[str] = None
    display_order: Optional[int] = None

    @field_validator("structure_name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return None if v is None else check_name(v, "Name", 2, 200)

    @field_validator("structure_code", mode="before")
    @classmethod
    def _v_code(cls, v):
        return None if v is None else check_text(v, "Code", 1, 50, required=True)

    @field_validator("display_order", mode="before")
    @classmethod
    def _v_order(cls, v):
        if v is not None and isinstance(v, (int, float)) and v < 0:
            raise ValueError("Display order cannot be negative.")
        return v


def _structure_name_taken(db: Session, questionnaire_id: int, structure_type: str, parent_id: Optional[int],
                          name: str, exclude_id: Optional[int] = None):
    """Existing section (per questionnaire) or subsection (per parent section) with the same name, if any."""
    key = " ".join(name.split()).casefold()
    q = db.query(QuestionnaireStructure).filter(
        QuestionnaireStructure.questionnaire_id == questionnaire_id,
        QuestionnaireStructure.structure_type == structure_type,
    )
    q = q.filter(QuestionnaireStructure.parent_id == parent_id) if parent_id else q.filter(QuestionnaireStructure.parent_id.is_(None))
    if exclude_id is not None:
        q = q.filter(QuestionnaireStructure.id != exclude_id)
    for row in q.all():
        if " ".join((row.structure_name or "").split()).casefold() == key:
            return row
    return None


def _structure_dup_error(structure_type: str, row) -> HTTPException:
    what = "A section" if structure_type == "section" else "A subsection in this section"
    tail = "" if row.is_active else " (inactive – activate it instead)"
    return field_error("structure_name", f"{what} with this name already exists{tail}.", 409)


class ElementCreate(BaseModel):
    questionnaire_id: int
    section_id: int
    subsection_id: int
    parent_element_id: Optional[int] = None
    element_type: str
    element_code: str
    element_label: str
    input_type: str
    is_required: bool = False
    allow_remarks: bool = False
    display_order: int = 0
    show_when_operator: Optional[str] = None
    show_when_value: Optional[str] = None
    options_json: Optional[Any] = None
    placeholder: Optional[str] = None
    default_value: Optional[str] = None
    validation_json: Optional[Any] = None


class ElementUpdate(BaseModel):
    element_code: Optional[str] = None
    element_label: Optional[str] = None
    input_type: Optional[str] = None
    is_required: Optional[bool] = None
    allow_remarks: Optional[bool] = None
    display_order: Optional[int] = None
    show_when_operator: Optional[str] = None
    show_when_value: Optional[str] = None
    options_json: Optional[Any] = None
    placeholder: Optional[str] = None
    default_value: Optional[str] = None
    validation_json: Optional[Any] = None


class StatusIn(BaseModel):
    is_active: bool


class ReorderIn(BaseModel):
    ids: List[int]


class AnswerIn(BaseModel):
    element_id: int
    answer_value: Optional[str] = None
    remarks: Optional[str] = None


class AnswersSaveIn(BaseModel):
    questionnaire_id: Optional[int] = None
    answers: List[AnswerIn] = Field(default_factory=list)


class ReopenIn(BaseModel):
    reason: str


ALLOWED_INPUT_TYPES = {
    "yes_no", "yes_no_direct", "yes_no_conditional", "yes_no_na", "text", "textarea",
    "checkbox", "rating", "number", "decimal", "percentage", "currency", "date", "year", "time", "email", "mobile",
    "single_select", "multi_select", "file",
}
ALLOWED_OPERATORS = {"equals", "not_equals", "contains", "greater_than", "less_than"}


# ─── Questionnaires (admin creates the questionnaire itself) ──────────────────

@router.get("/questionnaires")
def list_questionnaires(
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    return db.query(Questionnaire).filter(Questionnaire.is_active == True).order_by(Questionnaire.id.desc()).all()


@router.post("/questionnaires", status_code=201)
def create_questionnaire(
    data: QuestionnaireCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.create")),
):
    _ensure_questionnaire_schema(db)
    row = Questionnaire(
        questionnaire_code=data.questionnaire_code,
        questionnaire_name=data.questionnaire_name,
        description=data.description,
        status="draft",
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/questionnaires/{id}")
def update_questionnaire(
    id: int,
    data: QuestionnaireUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(Questionnaire).filter(Questionnaire.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    if row.status != "draft":
        raise HTTPException(400, "Only a draft questionnaire's name/description can be edited")
    if data.questionnaire_name is not None:
        row.questionnaire_name = data.questionnaire_name
    if data.description is not None:
        row.description = data.description
    row.updated_by = current_user.id
    db.commit()
    db.refresh(row)
    return row


@router.patch("/questionnaires/{id}/archive")
def archive_questionnaire(
    id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(Questionnaire).filter(Questionnaire.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    row.status = "archived"
    row.updated_by = current_user.id
    db.commit()
    invalidate_questionnaire_config_cache(db, row.id)
    return {"id": row.id, "status": row.status}


@router.get("/preview")
def preview_questionnaire(
    questionnaire_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.create")),
):
    questionnaire = db.query(Questionnaire).filter(Questionnaire.id == questionnaire_id).first()
    if not questionnaire:
        raise HTTPException(404, "Not found")
    return _build_questionnaire_config(db, questionnaire)  # always live, bypasses cache


@router.post("/publish")
def publish_questionnaire(
    questionnaire_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    questionnaire = db.query(Questionnaire).filter(Questionnaire.id == questionnaire_id).first()
    if not questionnaire:
        raise HTTPException(404, "Not found")
    if questionnaire.status == "published":
        return questionnaire

    has_questions = (
        db.query(QuestionnaireFormElement.id)
        .filter(
            QuestionnaireFormElement.questionnaire_id == questionnaire.id,
            QuestionnaireFormElement.element_type == "question",
            QuestionnaireFormElement.is_active == True,
        )
        .first()
    )
    if not has_questions:
        raise HTTPException(400, "Add at least one question before publishing")

    questionnaire.status = "published"
    questionnaire.updated_by = current_user.id
    db.commit()
    db.refresh(questionnaire)
    invalidate_questionnaire_config_cache(db, questionnaire.id)
    return questionnaire


# ─── Master Setup: sections + subsections (questionnaire_structure) ───────────

@router.get("/structure")
def list_structure(
    questionnaire_id: int,
    include_inactive: bool = False,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    q = db.query(QuestionnaireStructure).filter(QuestionnaireStructure.questionnaire_id == questionnaire_id)
    if not include_inactive:
        q = q.filter(QuestionnaireStructure.is_active == True)
    return q.order_by(QuestionnaireStructure.structure_type, QuestionnaireStructure.display_order, QuestionnaireStructure.id).all()


@router.post("/structure", status_code=201)
def create_structure(
    data: StructureCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.create")),
):
    _ensure_questionnaire_schema(db)
    if data.structure_type not in ("section", "subsection"):
        raise field_error("structure_type", "structure_type must be 'section' or 'subsection'", 400)
    if data.structure_type == "subsection":
        if not data.parent_id:
            raise field_error("parent_id", "Please select a parent section.", 400)
        parent = (
            db.query(QuestionnaireStructure)
            .filter(
                QuestionnaireStructure.id == data.parent_id,
                QuestionnaireStructure.structure_type == "section",
                QuestionnaireStructure.is_active == True,
            )
            .first()
        )
        if not parent:
            raise field_error("parent_id", "Parent section not found or inactive.", 400)
    taken = _structure_name_taken(
        db, data.questionnaire_id, data.structure_type,
        data.parent_id if data.structure_type == "subsection" else None, data.structure_name,
    )
    if taken:
        raise _structure_dup_error(data.structure_type, taken)
    row = QuestionnaireStructure(
        questionnaire_id=data.questionnaire_id, parent_id=data.parent_id,
        structure_type=data.structure_type, structure_code=data.structure_code,
        structure_name=data.structure_name, description=data.description,
        display_order=data.display_order, created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    invalidate_questionnaire_config_cache(db, row.questionnaire_id)
    return row


@router.put("/structure/{id}")
def update_structure(
    id: int,
    data: StructureUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(QuestionnaireStructure).filter(QuestionnaireStructure.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    if data.structure_name is not None:
        taken = _structure_name_taken(
            db, row.questionnaire_id, row.structure_type,
            row.parent_id if row.structure_type == "subsection" else None, data.structure_name, exclude_id=row.id,
        )
        if taken:
            raise _structure_dup_error(row.structure_type, taken)
    for field in ("structure_code", "structure_name", "description", "display_order"):
        val = getattr(data, field)
        if val is not None:
            setattr(row, field, val)
    row.updated_by = current_user.id
    questionnaire_id = row.questionnaire_id
    db.commit()
    db.refresh(row)
    invalidate_questionnaire_config_cache(db, questionnaire_id)
    return row


@router.patch("/structure/{id}/status")
def set_structure_status(
    id: int,
    data: StatusIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(QuestionnaireStructure).filter(QuestionnaireStructure.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    row.is_active = data.is_active
    row.updated_by = current_user.id
    if not data.is_active and row.structure_type == "section":
        db.query(QuestionnaireStructure).filter(QuestionnaireStructure.parent_id == row.id).update({"is_active": False})
    questionnaire_id = row.questionnaire_id
    db.commit()
    invalidate_questionnaire_config_cache(db, questionnaire_id)
    return {"id": row.id, "is_active": row.is_active}


@router.delete("/structure/{id}")
def delete_structure(
    id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(QuestionnaireStructure).filter(QuestionnaireStructure.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")

    if row.structure_type == "section":
        if db.query(QuestionnaireStructure).filter(QuestionnaireStructure.parent_id == row.id).first():
            raise HTTPException(400, "Delete its subsections first")
        if db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.section_id == row.id).first():
            raise HTTPException(400, "Section still has questions/fields — remove them first")
    else:
        if db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.subsection_id == row.id).first():
            raise HTTPException(400, "Subsection still has questions/fields — remove them first")

    questionnaire_id = row.questionnaire_id
    db.delete(row)
    db.commit()
    invalidate_questionnaire_config_cache(db, questionnaire_id)
    return {"deleted": True}


@router.post("/structure/reorder")
def reorder_structure(
    data: ReorderIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    questionnaire_ids = {
        questionnaire_id
        for (questionnaire_id,) in db.query(QuestionnaireStructure.questionnaire_id)
        .filter(QuestionnaireStructure.id.in_(data.ids))
        .distinct()
        .all()
    }
    for pos, sid in enumerate(data.ids, start=1):
        db.query(QuestionnaireStructure).filter(QuestionnaireStructure.id == sid).update({"display_order": pos})
    db.commit()
    for questionnaire_id in questionnaire_ids:
        invalidate_questionnaire_config_cache(db, questionnaire_id)
    return {"reordered": len(data.ids)}


# ─── Form Builder: questions + dependent fields (questionnaire_form_elements) ─

@router.get("/elements")
def list_elements(
    questionnaire_id: int,
    subsection_id: Optional[int] = None,
    include_inactive: bool = False,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    q = db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.questionnaire_id == questionnaire_id)
    if subsection_id:
        q = q.filter(QuestionnaireFormElement.subsection_id == subsection_id)
    if not include_inactive:
        q = q.filter(QuestionnaireFormElement.is_active == True)
    return q.order_by(QuestionnaireFormElement.display_order, QuestionnaireFormElement.id).all()


@router.get("/elements/master-options")
def get_master_options(
    master_key: str,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    return _resolve_master_options(db, master_key)


@router.post("/elements", status_code=201)
def create_element(
    data: ElementCreate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.create")),
):
    _ensure_questionnaire_schema(db)
    if data.element_type not in ("question", "field"):
        raise HTTPException(400, "element_type must be 'question' or 'field'")
    if data.input_type not in ALLOWED_INPUT_TYPES:
        raise HTTPException(400, f"Unsupported input_type: {data.input_type}")
    if data.element_type == "field" and not data.parent_element_id:
        raise HTTPException(400, "Dependent field requires a parent question")
    if data.show_when_operator and data.show_when_operator not in ALLOWED_OPERATORS:
        raise HTTPException(400, f"Unsupported show_when_operator: {data.show_when_operator}")
    row = QuestionnaireFormElement(
        questionnaire_id=data.questionnaire_id, section_id=data.section_id, subsection_id=data.subsection_id,
        parent_element_id=data.parent_element_id, element_type=data.element_type,
        element_code=data.element_code, element_label=data.element_label, input_type=data.input_type,
        is_required=data.is_required, allow_remarks=data.allow_remarks, display_order=data.display_order,
        show_when_operator=data.show_when_operator, show_when_value=data.show_when_value,
        options_json=data.options_json, placeholder=data.placeholder, default_value=data.default_value,
        validation_json=data.validation_json, created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    invalidate_questionnaire_config_cache(db, row.questionnaire_id)
    return row


@router.put("/elements/{id}")
def update_element(
    id: int,
    data: ElementUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    if data.input_type is not None and data.input_type not in ALLOWED_INPUT_TYPES:
        raise HTTPException(400, f"Unsupported input_type: {data.input_type}")
    if data.show_when_operator not in (None, "") and data.show_when_operator not in ALLOWED_OPERATORS:
        raise HTTPException(400, f"Unsupported show_when_operator: {data.show_when_operator}")
    provided_fields = getattr(data, "model_fields_set", None) or getattr(data, "__fields_set__", set())
    for field in (
        "element_code", "element_label", "input_type", "is_required", "allow_remarks",
        "display_order", "show_when_operator", "show_when_value", "options_json",
        "placeholder", "default_value", "validation_json",
    ):
        if field in provided_fields:
            setattr(row, field, getattr(data, field))
    row.updated_by = current_user.id
    questionnaire_id = row.questionnaire_id
    db.commit()
    db.refresh(row)
    invalidate_questionnaire_config_cache(db, questionnaire_id)
    return row


@router.patch("/elements/{id}/status")
def set_element_status(
    id: int,
    data: StatusIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    row = db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id == id).first()
    if not row:
        raise HTTPException(404, "Not found")
    row.is_active = data.is_active
    row.updated_by = current_user.id
    if not data.is_active:
        child_ids = _dependent_subtree_ids(db, row.id)
        if child_ids:
            db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id.in_(child_ids)).update({"is_active": False})
    questionnaire_id = row.questionnaire_id
    db.commit()
    invalidate_questionnaire_config_cache(db, questionnaire_id)
    return {"id": row.id, "is_active": row.is_active}


@router.post("/elements/reorder")
def reorder_elements(
    data: ReorderIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    questionnaire_ids = {
        questionnaire_id
        for (questionnaire_id,) in db.query(QuestionnaireFormElement.questionnaire_id)
        .filter(QuestionnaireFormElement.id.in_(data.ids))
        .distinct()
        .all()
    }
    for pos, eid in enumerate(data.ids, start=1):
        db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id == eid).update({"display_order": pos})
    db.commit()
    for questionnaire_id in questionnaire_ids:
        invalidate_questionnaire_config_cache(db, questionnaire_id)
    return {"reordered": len(data.ids)}


# ─── Customer Questionnaire List (server-side paginated) ──────────────────────

@router.get("/customers")
def list_customer_questionnaires(
    page: int = 1,
    per_page: int = 20,
    search: Optional[str] = None,
    category: Optional[str] = None,
    status: Optional[str] = None,
    updated_from: Optional[str] = None,
    updated_to: Optional[str] = None,
    questionnaire_id: Optional[int] = None,
    sort_by: str = "customer_name",
    sort_dir: str = "asc",
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    questionnaire = _resolve_questionnaire(db, questionnaire_id)

    q = db.query(Customer).filter(Customer.is_deleted == False)
    q = apply_data_scope(db, q, current_user, "questionnaire", Customer.created_by, Customer.assigned_to)

    if search:
        like = f"%{search}%"
        q = q.filter((Customer.customer_name.ilike(like)) | (Customer.customer_vertical.ilike(like)))
    if category:
        q = q.filter(Customer.customer_vertical == category)

    if questionnaire:
        q = q.outerjoin(
            CustomerQuestionnaire,
            (CustomerQuestionnaire.customer_id == Customer.id)
            & (CustomerQuestionnaire.questionnaire_id == questionnaire.id),
        )
        q = q.filter(CustomerQuestionnaire.status != "not_started")  # only customers who have actually filled the questionnaire
        if status:
            q = q.filter(CustomerQuestionnaire.status == status)
        if updated_from:
            q = q.filter(CustomerQuestionnaire.last_saved_at >= updated_from)
        if updated_to:
            q = q.filter(CustomerQuestionnaire.last_saved_at <= updated_to)
    else:
        q = q.filter(Customer.id == -1)  # no questionnaire configured yet — nobody has started

    total = q.count()

    order_col = Customer.customer_name
    if questionnaire and sort_by == "status":
        order_col = CustomerQuestionnaire.status
    elif questionnaire and sort_by == "last_saved_at":
        order_col = CustomerQuestionnaire.last_saved_at
    order_clause = order_col.desc() if sort_dir == "desc" else order_col.asc()

    id_rows = (
        q.order_by(order_clause, Customer.id.asc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .with_entities(Customer.id)
        .all()
    )
    customer_ids = [r[0] for r in id_rows]

    customers_by_id = {}
    if customer_ids:
        customers_by_id = {c.id: c for c in db.query(Customer).filter(Customer.id.in_(customer_ids)).all()}

    cq_by_customer_id = {}
    if customer_ids and questionnaire:
        cq_by_customer_id = {
            cq.customer_id: cq
            for cq in db.query(CustomerQuestionnaire)
            .filter(
                CustomerQuestionnaire.customer_id.in_(customer_ids),
                CustomerQuestionnaire.questionnaire_id == questionnaire.id,
            )
            .all()
        }

    default_total_questions = 0
    configured_elements: List[QuestionnaireFormElement] = []
    if questionnaire:
        try:
            default_total_questions = int((_get_questionnaire_config(db, questionnaire) or {}).get("total_questions") or 0)
        except Exception:
            db.rollback()
        configured_elements = (
            db.query(QuestionnaireFormElement)
            .filter(
                QuestionnaireFormElement.questionnaire_id == questionnaire.id,
                QuestionnaireFormElement.is_active == True,
            )
            .all()
        )
        default_total_questions = len([element for element in configured_elements if element.element_type == "question"])

    assigned_user_id_by_customer: dict[int, int] = {}
    if customer_ids:
        try:
            assignments = (
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
            for assignment in assignments:
                assigned_user_id_by_customer.setdefault(int(assignment.customer_id), int(assignment.user_id))
        except Exception:
            db.rollback()

    user_ids = set()
    for cid in customer_ids:
        c = customers_by_id.get(cid)
        if not c:
            continue
        assigned_user_id = assigned_user_id_by_customer.get(int(c.id))
        if assigned_user_id:
            user_ids.add(assigned_user_id)
        elif c.assigned_to:
            user_ids.add(int(c.assigned_to))

    user_names = {}
    if user_ids:
        try:
            user_names = {
                int(user_id): full_name
                for user_id, full_name in db.query(User.id, User.full_name).filter(User.id.in_(user_ids)).all()
            }
        except Exception:
            db.rollback()

    progress_by_customer_id: dict[int, tuple[int, int, int, bool]] = {}
    if configured_elements and cq_by_customer_id:
        cq_ids = [int(cq.id) for cq in cq_by_customer_id.values()]
        answers_by_cq_id: dict[int, dict[int, Optional[str]]] = {cq_id: {} for cq_id in cq_ids}
        if cq_ids:
            answer_rows = (
                db.query(CustomerQuestionnaireAnswer)
                .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id.in_(cq_ids))
                .all()
            )
            for answer in answer_rows:
                answers_by_cq_id.setdefault(int(answer.customer_questionnaire_id), {})[int(answer.element_id)] = answer.answer_value
        for customer_id, cq in cq_by_customer_id.items():
            answer_values = answers_by_cq_id.get(int(cq.id), {})
            total_questions, completed_questions, progress_percentage = _question_progress_counts(
                configured_elements,
                answer_values,
            )
            progress_by_customer_id[int(customer_id)] = (
                total_questions,
                completed_questions,
                progress_percentage,
                _answer_values_have_any(answer_values),
            )

    items = []
    start_no = (page - 1) * per_page + 1
    for idx, cid in enumerate(customer_ids, start=start_no):
        c = customers_by_id.get(cid)
        if not c:
            continue
        cq = cq_by_customer_id.get(cid)
        progress_total, progress_completed, progress_percentage, progress_answered_any = progress_by_customer_id.get(
            int(cid),
            (
                default_total_questions,
                int(cq.completed_questions or 0) if cq else 0,
                int(cq.progress_percentage or 0) if cq else 0,
                bool(cq and (cq.started_at or cq.last_saved_at or cq.status in ("in_progress", "completed", "reopened"))),
            ),
        )
        assigned_user_id = assigned_user_id_by_customer.get(int(c.id)) or (int(c.assigned_to) if c.assigned_to else None)
        display_status = _normalized_questionnaire_status(
            cq.status if cq else "not_started",
            progress_total,
            progress_completed,
            progress_answered_any,
        )
        items.append({
            "s_no": idx,
            "customer_id": c.id,
            "customer_code": f"CUST-{c.id:06d}",
            "customer_name": c.customer_name,
            "customer_category": c.customer_vertical,
            "assigned_to": assigned_user_id,
            "assigned_user_name": user_names.get(assigned_user_id) if assigned_user_id else None,
            "total_questions": progress_total,
            "completed_questions": progress_completed,
            "progress_percentage": progress_percentage,
            "status": display_status,
            "last_updated": cq.last_saved_at if cq else None,
        })

    return {
        "items": items, "total": total, "page": page, "per_page": per_page,
        "questionnaire_id": questionnaire.id if questionnaire else None,
    }


# ─── Customer Questionnaire Form ───────────────────────────────────────────────

@router.get("/customers/{customer_id}")
def get_customer_questionnaire(
    customer_id: int,
    questionnaire_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    customer = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not customer:
        raise HTTPException(404, "Customer not found")

    questionnaire = _resolve_questionnaire(db, questionnaire_id)
    if not questionnaire:
        raise HTTPException(404, "No published questionnaire available")

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(
            CustomerQuestionnaire.customer_id == customer_id,
            CustomerQuestionnaire.questionnaire_id == questionnaire.id,
        )
        .first()
    )
    # Customer entry must reflect Form Builder edits immediately. The list view can
    # use cached published totals, but this screen needs the live question tree.
    config = _build_questionnaire_config(db, questionnaire)

    if not cq:
        cq = CustomerQuestionnaire(
            customer_id=customer_id, questionnaire_id=questionnaire.id,
            status="not_started",
            total_questions=config["total_questions"], completed_questions=0, progress_percentage=0,
            created_by=current_user.id,
        )
        db.add(cq)
        db.commit()
        db.refresh(cq)

    latest_location = _latest_questionnaire_locations(db, [cq.id]).get(int(cq.id))
    answer_rows = (
        db.query(CustomerQuestionnaireAnswer)
        .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id == cq.id)
        .all()
    )
    answers = {a.element_id: {"answer_value": a.answer_value, "remarks": a.remarks} for a in answer_rows}

    # cq.total_questions/completed_questions are only refreshed on save (_recalc_progress),
    # so they go stale as soon as Form Builder adds/removes questions after the customer's
    # last save. This screen already shows the live question tree, so compute the progress
    # numbers live too — otherwise the header total drifts from the per-section counts below.
    live_elements = (
        db.query(QuestionnaireFormElement)
        .filter(
            QuestionnaireFormElement.questionnaire_id == questionnaire.id,
            QuestionnaireFormElement.is_active == True,
        )
        .all()
    )
    live_answer_values = {element_id: data["answer_value"] for element_id, data in answers.items()}
    total_questions, completed_questions, progress_percentage = _question_progress_counts(live_elements, live_answer_values)
    progress_status = _normalized_questionnaire_status(
        cq.status,
        total_questions,
        completed_questions,
        _answer_values_have_any(live_answer_values),
    )

    return {
        "customer": {
            "id": customer.id, "customer_code": f"CUST-{customer.id:06d}",
            "customer_name": customer.customer_name, "customer_category": customer.customer_vertical,
        },
        "questionnaire": config["questionnaire"],
        "sections": config["sections"], "subsections": config["subsections"],
        "questions": config["questions"], "fields": config["fields"],
        "answers": answers,
        "latest_location": latest_location,
        "progress": {
            "id": cq.id, "status": progress_status, "total_questions": total_questions,
            "completed_questions": completed_questions, "progress_percentage": progress_percentage,
            "last_saved_at": cq.last_saved_at, "completed_at": cq.completed_at,
            "reopened_at": cq.reopened_at, "reopen_reason": cq.reopen_reason,
        },
    }


@router.get("/customers/{customer_id}/sections/{section_id}")
def get_customer_questionnaire_section(
    customer_id: int,
    section_id: int,
    questionnaire_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.view")),
):
    _ensure_questionnaire_schema(db)
    questionnaire = _resolve_questionnaire(db, questionnaire_id)
    if not questionnaire:
        raise HTTPException(404, "No published questionnaire available")

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(
            CustomerQuestionnaire.customer_id == customer_id,
            CustomerQuestionnaire.questionnaire_id == questionnaire.id,
        )
        .first()
    )
    if not cq:
        return {"answers": {}}

    element_ids = [
        r[0]
        for r in db.query(QuestionnaireFormElement.id)
        .filter(
            QuestionnaireFormElement.questionnaire_id == questionnaire.id,
            QuestionnaireFormElement.section_id == section_id,
            QuestionnaireFormElement.is_active == True,
        )
        .all()
    ]
    answers: dict[int, dict] = {}
    if element_ids:
        rows = (
            db.query(CustomerQuestionnaireAnswer)
            .filter(
                CustomerQuestionnaireAnswer.customer_questionnaire_id == cq.id,
                CustomerQuestionnaireAnswer.element_id.in_(element_ids),
            )
            .all()
        )
        answers = {a.element_id: {"answer_value": a.answer_value, "remarks": a.remarks} for a in rows}
    return {"answers": answers}


@router.post("/customers/{customer_id}/answers")
def save_customer_questionnaire_answers(
    customer_id: int,
    data: AnswersSaveIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    customer = db.query(Customer).filter(Customer.id == customer_id, Customer.is_deleted == False).first()
    if not customer:
        raise HTTPException(404, "Customer not found")

    questionnaire = _resolve_questionnaire(db, data.questionnaire_id)
    if not questionnaire:
        raise HTTPException(404, "No published questionnaire available")

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(
            CustomerQuestionnaire.customer_id == customer_id,
            CustomerQuestionnaire.questionnaire_id == questionnaire.id,
        )
        .first()
    )
    if not cq and not data.questionnaire_id:
        cq = (
            db.query(CustomerQuestionnaire)
            .filter(CustomerQuestionnaire.customer_id == customer_id)
            .order_by(CustomerQuestionnaire.id.desc())
            .first()
        )
        if cq:
            existing_questionnaire = db.query(Questionnaire).filter(Questionnaire.id == cq.questionnaire_id).first()
            if existing_questionnaire:
                questionnaire = existing_questionnaire
    if not cq:
        raise HTTPException(400, "Questionnaire not started for this customer")
    if cq.status == "completed":
        _, _, total, completed, percentage, answered_any, live_status = _live_questionnaire_progress(db, cq)
        if live_status == "completed":
            raise HTTPException(400, "Questionnaire is completed and read-only. Reopen it to make changes.")
        _apply_progress_snapshot(cq, total, completed, percentage, answered_any, live_status)

    if not data.answers:
        _recalc_progress(db, cq)
        db.commit()
        return {
            "saved": 0,
            "progress": {
                "status": cq.status,
                "total_questions": cq.total_questions,
                "completed_questions": cq.completed_questions,
                "progress_percentage": cq.progress_percentage,
                "last_saved_at": cq.last_saved_at,
            },
        }

    element_ids = [a.element_id for a in data.answers]
    elements_by_id = {
        e.id: e
        for e in db.query(QuestionnaireFormElement)
        .filter(QuestionnaireFormElement.id.in_(element_ids), QuestionnaireFormElement.questionnaire_id == questionnaire.id)
        .all()
    }

    errors = []
    field_errs: dict[str, str] = {}   # element id → message, so the form can show it under the field
    for a in data.answers:
        el = elements_by_id.get(a.element_id)
        if not el:
            errors.append(f"Unknown element {a.element_id}")
            continue
        err = _validate_answer(db, el, a.answer_value)
        if err:
            errors.append(f"{el.element_label}: {err}")
            field_errs[str(el.id)] = err
    if errors:
        raise HTTPException(422, {"errors": errors, "fields": field_errs})

    existing_answers = {
        a.element_id: a
        for a in db.query(CustomerQuestionnaireAnswer)
        .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id == cq.id, CustomerQuestionnaireAnswer.element_id.in_(element_ids))
        .all()
    }

    now = datetime.utcnow()
    for a in data.answers:
        el = elements_by_id.get(a.element_id)
        if not el:
            continue
        row = existing_answers.get(a.element_id)
        if row:
            row.answer_value = a.answer_value
            row.remarks = a.remarks
            row.answered_by = current_user.id
            row.answered_at = now
        else:
            db.add(CustomerQuestionnaireAnswer(
                customer_questionnaire_id=cq.id, element_id=a.element_id,
                answer_value=a.answer_value, remarks=a.remarks,
                answered_by=current_user.id, answered_at=now,
            ))
        _clear_hidden_dependent_answers(db, cq.id, el.id, a.answer_value)

    _recalc_progress(db, cq)
    db.commit()
    return {
        "saved": len(data.answers),
        "progress": {
            "status": cq.status, "total_questions": cq.total_questions,
            "completed_questions": cq.completed_questions, "progress_percentage": cq.progress_percentage,
            "last_saved_at": cq.last_saved_at,
        },
    }


@router.post("/customers/{customer_id}/answers/{element_id}/upload")
async def upload_answer_file(
    customer_id: int,
    element_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    element = db.query(QuestionnaireFormElement).filter(QuestionnaireFormElement.id == element_id).first()
    if not element or element.input_type != "file":
        raise HTTPException(400, "Not a file-type element")

    ext = os.path.splitext(file.filename or "")[-1].lower()
    if ext not in QUESTIONNAIRE_FILE_EXTENSIONS:
        raise HTTPException(400, f"File type '{ext}' not allowed.")

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "Uploaded file is empty.")

    tenant_slug = str(db.info.get("tenant_slug") or "").strip()
    stored_bytes = stored_upload_accounted_size(original_filename=file.filename, contents=contents, content_type=file.content_type)
    ensure_tenant_storage_available(tenant_slug, stored_bytes)

    saved = save_upload_optimized(
        root_dir=os.path.abspath(settings.MEDIA_ROOT),
        subfolder="questionnaire_answers",
        original_filename=file.filename,
        contents=contents,
        media_slug=media_slug_from_request(request),
        content_type=file.content_type,
    )

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(CustomerQuestionnaire.customer_id == customer_id, CustomerQuestionnaire.questionnaire_id == element.questionnaire_id)
        .order_by(CustomerQuestionnaire.id.desc())
        .first()
    )
    if not cq:
        raise HTTPException(400, "Questionnaire not started for this customer")
    if cq.status == "completed":
        _, _, total, completed, percentage, answered_any, live_status = _live_questionnaire_progress(db, cq)
        if live_status == "completed":
            raise HTTPException(400, "Questionnaire is completed and read-only. Reopen it to make changes.")
        _apply_progress_snapshot(cq, total, completed, percentage, answered_any, live_status)

    row = (
        db.query(CustomerQuestionnaireAnswer)
        .filter(CustomerQuestionnaireAnswer.customer_questionnaire_id == cq.id, CustomerQuestionnaireAnswer.element_id == element_id)
        .first()
    )
    now = datetime.utcnow()
    if row:
        row.answer_value = saved.url
        row.answered_by = current_user.id
        row.answered_at = now
    else:
        db.add(CustomerQuestionnaireAnswer(
            customer_questionnaire_id=cq.id, element_id=element_id,
            answer_value=saved.url, answered_by=current_user.id, answered_at=now,
        ))
    _recalc_progress(db, cq)
    db.commit()
    return {"url": saved.url}


@router.post("/customers/{customer_id}/complete")
def complete_customer_questionnaire(
    customer_id: int,
    questionnaire_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    questionnaire = _resolve_questionnaire(db, questionnaire_id)
    if not questionnaire:
        raise HTTPException(404, "No published questionnaire available")

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(
            CustomerQuestionnaire.customer_id == customer_id,
            CustomerQuestionnaire.questionnaire_id == questionnaire.id,
        )
        .first()
    )
    if not cq:
        raise HTTPException(400, "Questionnaire not started for this customer")

    elements = _active_questionnaire_elements(db, questionnaire.id)
    answers = _customer_questionnaire_answer_values(db, cq.id)
    visible_field_ids = set(_visible_field_ids_for_answers(elements, answers))

    missing = []
    for el in elements:
        if el.element_type == "question":
            if el.is_required and not answers.get(el.id):
                missing.append(el.element_label)
        else:
            if el.id in visible_field_ids and el.is_required and not answers.get(el.id):
                missing.append(el.element_label)

    if missing:
        raise HTTPException(422, {"errors": [f"Required: {m}" for m in missing]})

    total, completed, percentage = _question_progress_counts(elements, answers)
    if total <= 0 or completed != total:
        raise HTTPException(422, {"errors": [f"Complete all questions before marking completed ({completed} of {total} answered)."]})

    _apply_progress_snapshot(cq, total, completed, percentage, True, "completed")
    cq.completed_at = datetime.utcnow()
    cq.updated_by = current_user.id
    db.commit()
    return {
        "status": cq.status,
        "completed_at": cq.completed_at,
        "total_questions": cq.total_questions,
        "completed_questions": cq.completed_questions,
        "progress_percentage": cq.progress_percentage,
    }


@router.post("/customers/{customer_id}/reopen")
def reopen_customer_questionnaire(
    customer_id: int,
    data: ReopenIn,
    questionnaire_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(require_permission("questionnaire.update")),
):
    _ensure_questionnaire_schema(db)
    if not data.reason or not data.reason.strip():
        raise HTTPException(422, "Reopen reason is required")

    questionnaire = _resolve_questionnaire(db, questionnaire_id)
    if not questionnaire:
        raise HTTPException(404, "No published questionnaire available")

    cq = (
        db.query(CustomerQuestionnaire)
        .filter(
            CustomerQuestionnaire.customer_id == customer_id,
            CustomerQuestionnaire.questionnaire_id == questionnaire.id,
        )
        .first()
    )
    if not cq or cq.status != "completed":
        raise HTTPException(400, "Only a completed questionnaire can be reopened")

    cq.status = "reopened"
    cq.reopened_at = datetime.utcnow()
    cq.reopened_by = current_user.id
    cq.reopen_reason = data.reason.strip()
    cq.updated_by = current_user.id
    db.commit()
    return {"status": cq.status, "reopened_at": cq.reopened_at, "reopen_reason": cq.reopen_reason}
