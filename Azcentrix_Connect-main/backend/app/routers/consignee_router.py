import io
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import bindparam, inspect, text
from pydantic import BaseModel

from app.core.logging import log_module_action
from app.dependencies import get_tenant_db, get_current_user, get_request_ip
from app.models.all_models import User

logger = logging.getLogger(__name__)
router = APIRouter()
_schema_ready_dbs: set[int] = set()


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ConsigneeItemIn(BaseModel):
    tender_product_id: Optional[int] = None
    product_name: str = ""
    quantity: float = 1
    unit: str = ""
    remarks: str = ""

class ConsigneeIn(BaseModel):
    tender_id: Optional[int] = None   # optional: null for direct opportunity flow
    lead_id: Optional[int] = None     # direct opportunity flow (no tender)
    consignee_name: str
    address: str = ""
    city: str = ""
    state: str = ""
    pincode: str = ""
    contact_person: str = ""
    contact_phone: str = ""
    delivery_date: Optional[str] = None
    notes: str = ""
    items: List[ConsigneeItemIn] = []
    max_count: Optional[int] = None  # PO no_of_consignee cap

class ConsigneeUpdate(BaseModel):
    consignee_name: str
    address: str = ""
    city: str = ""
    state: str = ""
    pincode: str = ""
    contact_person: str = ""
    contact_phone: str = ""
    delivery_date: Optional[str] = None
    notes: str = ""
    items: List[ConsigneeItemIn] = []


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _ensure_consignee_schema(db: Session) -> None:
    """Backfill newer consignee columns for older tenant databases."""
    db_id = id(db.get_bind())
    if db_id in _schema_ready_dbs:
        return

    try:
        inspector = inspect(db.get_bind())
        if "tender_consignees" not in inspector.get_table_names():
            _schema_ready_dbs.add(db_id)
            return

        column_info = inspector.get_columns("tender_consignees")
        columns = {col["name"] for col in column_info}
        statements: list[str] = []

        if "lead_id" not in columns:
            statements.append(
                "ALTER TABLE tender_consignees "
                "ADD COLUMN `lead_id` INT NULL COMMENT 'FK to leads.id for direct opportunity flow'"
            )

        tender_id_col = next((c for c in column_info if c["name"] == "tender_id"), None)
        if tender_id_col is not None and not tender_id_col.get("nullable", True):
            # Direct-opportunity consignees have no tender — tender_id must be nullable
            # so a lead_id-only row (see ConsigneeIn / POST /consignees/) can be saved.
            statements.append("ALTER TABLE tender_consignees MODIFY COLUMN `tender_id` INT NULL")

        for statement in statements:
            db.execute(text(statement))

        if statements:
            db.commit()
            logger.info("Consignee runtime schema updated: %s", ", ".join(statements))

        _schema_ready_dbs.add(db_id)
    except Exception as exc:
        db.rollback()
        logger.warning("Consignee runtime schema sync skipped: %s", exc)


def _serialize_one(row, items_rows) -> dict:
    return {
        "id":             row.id,
        "tender_id":      row.tender_id,
        "lead_id":        getattr(row, "lead_id", None),
        "consignee_name": row.consignee_name,
        "address":        row.address or "",
        "city":           row.city or "",
        "state":          row.state or "",
        "pincode":        row.pincode or "",
        "contact_person": row.contact_person or "",
        "contact_phone":  row.contact_phone or "",
        "delivery_date":  str(row.delivery_date) if row.delivery_date else None,
        "notes":          row.notes or "",
        "created_at":     str(row.created_at) if row.created_at else None,
        "items": [
            {
                "id":                i.id,
                "tender_product_id": i.tender_product_id,
                "product_name":      i.product_name,
                "quantity":          float(i.quantity),
                "unit":              i.unit or "",
                "remarks":           i.remarks or "",
            }
            for i in items_rows
        ],
    }


def _insert_items(db: Session, consignee_id: int, items: List[ConsigneeItemIn]):
    for item in items:
        db.execute(text("""
            INSERT INTO tender_consignee_items
                (consignee_id, tender_product_id, product_name, quantity, unit, remarks)
            VALUES (:cid, :tpid, :pname, :qty, :unit, :remarks)
        """), {
            "cid":     consignee_id,
            "tpid":    item.tender_product_id or None,
            "pname":   item.product_name,
            "qty":     item.quantity,
            "unit":    item.unit,
            "remarks": item.remarks,
        })


# ─── GET /consignees/template  ← STATIC — must be before /{consignee_id} ──────

@router.get("/template")
def download_template():
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill
    except ImportError:
        raise HTTPException(500, "openpyxl not installed. Run: pip install openpyxl")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Consignees"

    headers = [
        "consignee_name", "address", "city", "state", "pincode",
        "contact_person", "contact_phone", "delivery_date",
        "product_name", "quantity", "unit", "remarks", "notes",
    ]

    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1D6F42")

    ws.append([
        "Railway Division Mumbai", "CST Building, Fort", "Mumbai",
        "Maharashtra", "400001", "Mr. Sharma", "9876543210",
        "2025-06-30", "Cable 11kV", "100", "RMT",
        "Urgent delivery", "Contact before delivery",
    ])

    col_widths = [25, 30, 15, 15, 10, 20, 15, 15, 25, 10, 8, 20, 25]
    for i, width in enumerate(col_widths, 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = width

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=consignee_template.xlsx"},
    )


# ─── POST /consignees/bulk-import  ← STATIC — must be before /{consignee_id} ──

@router.post("/bulk-import")
async def bulk_import(
    request: Request,
    tender_id: int = Query(...),
    max_import: int = Query(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(500, "openpyxl not installed. Run: pip install openpyxl")

    _ensure_consignee_schema(db)
    contents = await file.read()

    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents))
    except Exception:
        raise HTTPException(400, "Could not read Excel file. Please use .xlsx format.")

    ws = wb.active
    header_row = next(ws.iter_rows(min_row=1, max_row=1), None)
    if not header_row:
        raise HTTPException(400, "Excel file is empty")

    headers = [
        str(c.value).strip().lower().replace(" ", "_") if c.value else ""
        for c in header_row
    ]

    def col(row, name: str, default: str = "") -> str:
        try:
            idx = headers.index(name)
            val = row[idx].value
            return str(val).strip() if val is not None else default
        except (ValueError, IndexError):
            return default

    # Fetch existing consignee names for this tender (for duplicate check)
    existing_rows = db.execute(
        text("SELECT consignee_name FROM tender_consignees WHERE tender_id = :tid"),
        {"tid": tender_id},
    ).fetchall()
    existing_names = {r.consignee_name.strip().lower() for r in existing_rows}
    existing_count = len(existing_rows)

    # How many slots remain
    slots = (max_import - existing_count) if max_import is not None else None

    created = 0
    errors = []
    last_row_num = 1
    imported_names: set = set()   # track names added in this import batch

    for row_num, row in enumerate(ws.iter_rows(min_row=2), start=2):
        last_row_num = row_num
        if not any(c.value for c in row):
            continue

        # Stop if we've hit the slot limit
        if slots is not None and created >= slots:
            errors.append(f"Row {row_num} onwards: skipped — consignee limit ({max_import}) reached")
            break

        name = col(row, "consignee_name") or col(row, "name")
        if not name:
            errors.append(f"Row {row_num}: consignee_name is required — skipped")
            continue

        # Duplicate check against DB and current batch
        name_key = name.strip().lower()
        if name_key in existing_names or name_key in imported_names:
            errors.append(f"Row {row_num}: '{name}' is a duplicate — skipped")
            continue

        try:
            result = db.execute(text("""
                INSERT INTO tender_consignees
                    (tender_id, consignee_name, address, city, state, pincode,
                     contact_person, contact_phone, delivery_date, notes, created_by)
                VALUES
                    (:tid, :name, :addr, :city, :state, :pin,
                     :cp, :phone, :ddate, :notes, :uid)
            """), {
                "tid":   tender_id,
                "name":  name,
                "addr":  col(row, "address"),
                "city":  col(row, "city"),
                "state": col(row, "state"),
                "pin":   col(row, "pincode"),
                "cp":    col(row, "contact_person"),
                "phone": col(row, "contact_phone"),
                "ddate": col(row, "delivery_date") or None,
                "notes": col(row, "notes"),
                "uid":   current_user.id,
            })
            db.commit()
            cid = result.lastrowid

            product = col(row, "product_name")
            qty_raw = col(row, "quantity")

            if product:
                try:
                    qty = float(qty_raw) if qty_raw else 1.0
                except ValueError:
                    qty = 1.0

                db.execute(text("""
                    INSERT INTO tender_consignee_items
                        (consignee_id, product_name, quantity, unit, remarks)
                    VALUES (:cid, :pname, :qty, :unit, :remarks)
                """), {
                    "cid":     cid,
                    "pname":   product,
                    "qty":     qty,
                    "unit":    col(row, "unit"),
                    "remarks": col(row, "remarks"),
                })
                db.commit()

            created += 1
            imported_names.add(name_key)

        except Exception as e:
            db.rollback()
            errors.append(f"Row {row_num}: {str(e)}")

    log_module_action(
        db=db, user_id=current_user.id, module="consignees", action="import",
        record_id=tender_id, record_name=f"{created} consignee(s) imported",
        ip=get_request_ip(request), new_data={"created": created, "errors": len(errors)},
    )
    db.commit()
    return {
        "created":    created,
        "errors":     errors,
        "total_rows": last_row_num - 1,
    }


# ─── POST /consignees/bulk-import-lead  (Excel import for direct opportunity) ─

@router.post("/bulk-import-lead")
async def bulk_import_lead(
    request: Request,
    lead_id: int = Query(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(500, "openpyxl not installed. Run: pip install openpyxl")

    _ensure_consignee_schema(db)
    contents = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents))
    except Exception:
        raise HTTPException(400, "Could not read Excel file. Please use .xlsx format.")

    ws = wb.active
    header_row = next(ws.iter_rows(min_row=1, max_row=1), None)
    if not header_row:
        raise HTTPException(400, "Excel file is empty")

    headers = [
        str(c.value).strip().lower().replace(" ", "_") if c.value else ""
        for c in header_row
    ]

    def col(row, name: str, default: str = "") -> str:
        try:
            idx = headers.index(name)
            val = row[idx].value
            return str(val).strip() if val is not None else default
        except (ValueError, IndexError):
            return default

    existing_rows = db.execute(
        text("SELECT consignee_name FROM tender_consignees WHERE lead_id = :lid"),
        {"lid": lead_id},
    ).fetchall()
    existing_names = {r.consignee_name.strip().lower() for r in existing_rows}

    # Determine max allowed from work_orders.no_of_consignee
    wo_row = db.execute(
        text("SELECT no_of_consignee FROM work_orders WHERE lead_id = :lid LIMIT 1"),
        {"lid": lead_id},
    ).fetchone()
    max_import = wo_row.no_of_consignee if (wo_row and wo_row.no_of_consignee) else None
    slots = (max_import - len(existing_rows)) if max_import is not None else None

    created = 0
    errors = []
    last_row_num = 1
    imported_names: set = set()

    for row_num, row in enumerate(ws.iter_rows(min_row=2), start=2):
        last_row_num = row_num
        if not any(c.value for c in row):
            continue

        name = col(row, "consignee_name") or col(row, "name")
        if not name:
            errors.append(f"Row {row_num}: consignee_name is required — skipped")
            continue

        name_key = name.strip().lower()
        if name_key in existing_names or name_key in imported_names:
            errors.append(f"Row {row_num}: '{name}' is a duplicate — skipped")
            continue

        # Stop if we've hit the slot limit
        if slots is not None and created >= slots:
            errors.append(f"Row {row_num} onwards: skipped — consignee limit ({max_import}) reached")
            break

        try:
            result = db.execute(text("""
                INSERT INTO tender_consignees
                    (lead_id, consignee_name, address, city, state, pincode,
                     contact_person, contact_phone, delivery_date, notes, created_by)
                VALUES
                    (:lid, :name, :addr, :city, :state, :pin,
                     :cp, :phone, :ddate, :notes, :uid)
            """), {
                "lid":   lead_id,
                "name":  name,
                "addr":  col(row, "address"),
                "city":  col(row, "city"),
                "state": col(row, "state"),
                "pin":   col(row, "pincode"),
                "cp":    col(row, "contact_person"),
                "phone": col(row, "contact_phone"),
                "ddate": col(row, "delivery_date") or None,
                "notes": col(row, "notes"),
                "uid":   current_user.id,
            })
            db.commit()
            cid = result.lastrowid

            product = col(row, "product_name")
            qty_raw = col(row, "quantity")
            if product:
                try:
                    qty = float(qty_raw) if qty_raw else 1.0
                except ValueError:
                    qty = 1.0
                db.execute(text("""
                    INSERT INTO tender_consignee_items
                        (consignee_id, product_name, quantity, unit, remarks)
                    VALUES (:cid, :pname, :qty, :unit, :remarks)
                """), {
                    "cid":     cid,
                    "pname":   product,
                    "qty":     qty,
                    "unit":    col(row, "unit"),
                    "remarks": col(row, "remarks"),
                })
                db.commit()

            created += 1
            imported_names.add(name_key)

        except Exception as e:
            db.rollback()
            errors.append(f"Row {row_num}: {str(e)}")

    log_module_action(
        db=db, user_id=current_user.id, module="consignees", action="import",
        record_id=lead_id, record_name=f"{created} consignee(s) imported",
        ip=get_request_ip(request), new_data={"created": created, "errors": len(errors)},
    )
    db.commit()
    return {
        "created":    created,
        "errors":     errors,
        "total_rows": last_row_num - 1,
    }


# ─── GET /consignees/ ─────────────────────────────────────────────────────────

@router.get("/")
def list_consignees(
    tender_id: Optional[int] = Query(None),
    lead_id: Optional[int] = Query(None),
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_consignee_schema(db)
    if lead_id is not None:
        rows = db.execute(
            text("SELECT * FROM tender_consignees WHERE lead_id = :lid ORDER BY id"),
            {"lid": lead_id},
        ).fetchall()
    elif tender_id is not None:
        rows = db.execute(
            text("SELECT * FROM tender_consignees WHERE tender_id = :tid ORDER BY id"),
            {"tid": tender_id},
        ).fetchall()
    else:
        raise HTTPException(400, "Either tender_id or lead_id is required")

    consignee_ids = [int(r.id) for r in rows if getattr(r, "id", None)]
    items_by_consignee: dict[int, list] = {cid: [] for cid in consignee_ids}
    if consignee_ids:
        item_stmt = text(
            "SELECT * FROM tender_consignee_items "
            "WHERE consignee_id IN :ids ORDER BY consignee_id, id"
        ).bindparams(bindparam("ids", expanding=True))
        for item in db.execute(item_stmt, {"ids": consignee_ids}).fetchall():
            items_by_consignee.setdefault(int(item.consignee_id), []).append(item)

    result = []
    for r in rows:
        items = items_by_consignee.get(int(r.id), [])
        result.append(_serialize_one(r, items))
    return result


# ─── POST /consignees/ ────────────────────────────────────────────────────────

@router.post("/")
def create_consignee(
    payload: ConsigneeIn,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_consignee_schema(db)
    if not payload.consignee_name.strip():
        raise HTTPException(422, "consignee_name is required")
    if not payload.tender_id and not payload.lead_id:
        raise HTTPException(422, "Either tender_id or lead_id is required")

    if payload.tender_id:
        duplicate = db.execute(
            text("SELECT id FROM tender_consignees WHERE tender_id = :tid AND LOWER(consignee_name) = LOWER(:name)"),
            {"tid": payload.tender_id, "name": payload.consignee_name.strip()},
        ).fetchone()
        if duplicate:
            raise HTTPException(422, f"A consignee named '{payload.consignee_name.strip()}' already exists for this tender")

        if payload.max_count is not None:
            current_count = db.execute(
                text("SELECT COUNT(*) FROM tender_consignees WHERE tender_id = :tid"),
                {"tid": payload.tender_id},
            ).scalar()
            if current_count >= payload.max_count:
                raise HTTPException(422, f"Consignee limit reached ({payload.max_count} allowed for this tender)")

    if payload.lead_id:
        wo_row = db.execute(
            text("SELECT no_of_consignee FROM work_orders WHERE lead_id = :lid LIMIT 1"),
            {"lid": payload.lead_id},
        ).fetchone()
        if wo_row and wo_row.no_of_consignee:
            current_count = db.execute(
                text("SELECT COUNT(*) FROM tender_consignees WHERE lead_id = :lid"),
                {"lid": payload.lead_id},
            ).scalar()
            if current_count >= wo_row.no_of_consignee:
                raise HTTPException(422, f"Consignee limit reached ({wo_row.no_of_consignee} allowed per PO details)")

    result = db.execute(text("""
        INSERT INTO tender_consignees
            (tender_id, lead_id, consignee_name, address, city, state, pincode,
             contact_person, contact_phone, delivery_date, notes, created_by)
        VALUES
            (:tender_id, :lead_id, :name, :address, :city, :state, :pincode,
             :contact_person, :contact_phone, :delivery_date, :notes, :created_by)
    """), {
        "tender_id":      payload.tender_id,
        "lead_id":        payload.lead_id,
        "name":           payload.consignee_name.strip(),
        "address":        payload.address,
        "city":           payload.city,
        "state":          payload.state,
        "pincode":        payload.pincode,
        "contact_person": payload.contact_person,
        "contact_phone":  payload.contact_phone,
        "delivery_date":  payload.delivery_date or None,
        "notes":          payload.notes,
        "created_by":     current_user.id,
    })
    db.commit()
    cid = result.lastrowid

    _insert_items(db, cid, payload.items)
    db.commit()

    row = db.execute(
        text("SELECT * FROM tender_consignees WHERE id = :id"), {"id": cid}
    ).fetchone()
    items = db.execute(
        text("SELECT * FROM tender_consignee_items WHERE consignee_id = :cid ORDER BY id"),
        {"cid": cid},
    ).fetchall()
    return _serialize_one(row, items)


# ─── GET /consignees/{consignee_id}  ← DYNAMIC — must be after static routes ──

@router.get("/{consignee_id}")
def get_consignee(
    consignee_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_consignee_schema(db)
    row = db.execute(
        text("SELECT * FROM tender_consignees WHERE id = :id"), {"id": consignee_id}
    ).fetchone()
    if not row:
        raise HTTPException(404, "Consignee not found")
    items = db.execute(
        text("SELECT * FROM tender_consignee_items WHERE consignee_id = :cid ORDER BY id"),
        {"cid": consignee_id},
    ).fetchall()
    return _serialize_one(row, items)


# ─── PUT /consignees/{consignee_id} ───────────────────────────────────────────

@router.put("/{consignee_id}")
def update_consignee(
    consignee_id: int,
    payload: ConsigneeUpdate,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_consignee_schema(db)
    existing = db.execute(
        text("SELECT id FROM tender_consignees WHERE id = :id"), {"id": consignee_id}
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Consignee not found")

    db.execute(text("""
        UPDATE tender_consignees SET
            consignee_name  = :name,
            address         = :address,
            city            = :city,
            state           = :state,
            pincode         = :pincode,
            contact_person  = :contact_person,
            contact_phone   = :contact_phone,
            delivery_date   = :delivery_date,
            notes           = :notes,
            updated_at      = NOW()
        WHERE id = :id
    """), {
        "id":             consignee_id,
        "name":           payload.consignee_name.strip(),
        "address":        payload.address,
        "city":           payload.city,
        "state":          payload.state,
        "pincode":        payload.pincode,
        "contact_person": payload.contact_person,
        "contact_phone":  payload.contact_phone,
        "delivery_date":  payload.delivery_date or None,
        "notes":          payload.notes,
    })

    db.execute(
        text("DELETE FROM tender_consignee_items WHERE consignee_id = :cid"),
        {"cid": consignee_id},
    )
    _insert_items(db, consignee_id, payload.items)
    db.commit()

    row = db.execute(
        text("SELECT * FROM tender_consignees WHERE id = :id"), {"id": consignee_id}
    ).fetchone()
    items = db.execute(
        text("SELECT * FROM tender_consignee_items WHERE consignee_id = :cid ORDER BY id"),
        {"cid": consignee_id},
    ).fetchall()
    return _serialize_one(row, items)


# ─── DELETE /consignees/{consignee_id} ────────────────────────────────────────

@router.delete("/{consignee_id}")
def delete_consignee(
    consignee_id: int,
    db: Session = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_consignee_schema(db)
    existing = db.execute(
        text("SELECT id FROM tender_consignees WHERE id = :id"), {"id": consignee_id}
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Consignee not found")

    db.execute(
        text("DELETE FROM tender_consignees WHERE id = :id"), {"id": consignee_id}
    )
    db.commit()
    return {"message": "Deleted"}
