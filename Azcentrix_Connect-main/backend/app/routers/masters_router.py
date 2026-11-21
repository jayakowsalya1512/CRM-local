"""Masters router — all lookup data with full CRUD.
Changes vs previous version:
  • zones  → renamed to regions  (Region model, /masters/regions)
  • NEW    /masters/states        — State (region_id FK, name, description)
  • NEW    /masters/lead-categories
  • NEW    /masters/lead-sub-categories  (category_id FK, name, description)
  • Group  — zone_id → region_id, added state field
  • users-for-select  — zone_id → region_id
"""
import logging
from datetime import datetime
from app.core.timezone import now_ist, today_ist
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy import or_, text as sa_text, func, inspect
from pydantic import BaseModel, field_validator
from app.core.validators import check_name, check_text, field_error
from app.database import TenantBase
from app.core.logging import log_module_action
from app.dependencies import get_tenant_db, get_current_user, get_request_ip, require_permission
from app.models.all_models import (
    LeadSource, Competitor, ProductMaster, OEM, User, Setting,
    AlertRule, VerticalSector, Group, Role,
    LeadCategory, LeadSubCategory, UserReportingHierarchy, OrgTreeNode,
    BusinessCategory, BusinessUnit, VerticalSubSector, Customer,
)

logger = logging.getLogger(__name__)
router = APIRouter()

DEFAULT_VERTICAL_SECTORS = [
    "Government",
    "PSU",
    "Defence",
    "Railways",
    "Smart City",
    "Healthcare",
    "Education",
    "Banking",
    "Private",
    "Other",
]

ROLE_NAME_ALIASES = {
    "manager": {"manager", "sales_head"},
    "sales_head": {"manager", "sales_head"},
}


def _expand_role_names(role_names: list[str]) -> list[str]:
    expanded: set[str] = set()
    for role_name in role_names:
        normalized = (role_name or "").strip().lower()
        if not normalized:
            continue
        expanded.update(ROLE_NAME_ALIASES.get(normalized, {normalized}))
    return list(expanded)


def _ensure_vertical_sector_schema(db: Session) -> None:
    db.execute(sa_text(
        """
        CREATE TABLE IF NOT EXISTS vertical_sectors (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            description VARCHAR(255) NULL,
            display_order INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_vertical_sectors_display_order (display_order)
        )
        """
    ))
    db.commit()
    try:
        db.execute(sa_text("ALTER TABLE vertical_sectors ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0"))
        db.commit()
    except Exception:
        db.rollback()

    try:
        missing_order = db.execute(sa_text(
            "SELECT COUNT(*) FROM vertical_sectors WHERE is_active = 1 AND COALESCE(display_order, 0) <= 0"
        )).scalar() or 0
        if missing_order:
            rows = db.execute(sa_text("""
                SELECT id
                FROM vertical_sectors
                WHERE is_active = 1
                ORDER BY CASE WHEN COALESCE(display_order, 0) <= 0 THEN 1 ELSE 0 END,
                         display_order, name, id
            """)).mappings().all()
            for pos, row in enumerate(rows, start=1):
                db.execute(sa_text(
                    "UPDATE vertical_sectors SET display_order = :pos WHERE id = :id"
                ), {"pos": pos, "id": row["id"]})
            db.commit()
    except Exception:
        db.rollback()


def _next_vertical_sector_order(db: Session) -> int:
    value = db.execute(sa_text(
        "SELECT COALESCE(MAX(display_order), 0) + 1 FROM vertical_sectors WHERE is_active = 1"
    )).scalar()
    return int(value or 1)


def _seed_default_vertical_sectors(db: Session) -> None:
    _ensure_vertical_sector_schema(db)
    if db.query(VerticalSector).count() > 0:
        return

    db.add_all([VerticalSector(name=name, display_order=idx) for idx, name in enumerate(DEFAULT_VERTICAL_SECTORS, start=1)])
    db.commit()

def _parse_ids(value) -> set[int]:
    if not value:
        return set()
    return {
        int(x.strip())
        for x in str(value).split(",")
        if x.strip().isdigit()
    }


def _user_has_group(user: User, group_id: int) -> bool:
    return group_id in _parse_ids(getattr(user, "group_id", None))


# ─── Schemas ──────────────────────────────────────────────────────────────────

class SimpleItem(BaseModel):
    name:        str
    description: Optional[str] = None
    is_active:   bool = True

    # Lead sources / customer segments: same rules as the Masters UI (utils/validation.ts)
    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Name", 2, 100)

    @field_validator("description", mode="before")
    @classmethod
    def _v_description(cls, v):
        return check_text(v, "Description", 0, 255)

class GroupReportingHierarchyItem(BaseModel):
    reporting_user_id: int
    reporting_role: str
    level: int = 1
    is_group_lead: bool = False


class CompetitorIn(BaseModel):
    name:        str
    registration_type: Optional[str] = None
    registration_year: Optional[str] = None
    country: Optional[str] = "India"
    state: Optional[str] = None
    district: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    pincode: Optional[str] = None
    mobile_no: Optional[str] = None
    gst_no: Optional[str] = None
    pan_no: Optional[str] = None
    email: Optional[str] = None
    company_type: Optional[str] = None
    directors: Optional[str] = None
    manpower_strength: Optional[str] = None
    website:     Optional[str] = None
    strengths:   Optional[str] = None
    weaknesses:  Optional[str] = None
    threat_level: Optional[str] = None
    market_reputation: Optional[str] = None
    oem_partnerships: Optional[str] = None
    strong_regions: Optional[str] = None
    strong_departments: Optional[str] = None
    annual_turnover: Optional[str] = None
    support_quality: Optional[str] = None
    internal_notes: Optional[str] = None
    description: Optional[str] = None
    is_active:   bool = True


class ProductIn(BaseModel):
    name:        str
    category:    Optional[str] = None
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Product name", 2, 300)

    @field_validator("category", mode="before")
    @classmethod
    def _v_category(cls, v):
        return check_text(v, "Category", 0, 100)

    @field_validator("description", mode="before")
    @classmethod
    def _v_description(cls, v):
        return check_text(v, "Description", 0, 1000)


class OEMIn(BaseModel):
    product_id:    Optional[int] = None
    name:          str
    contact_name:  Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website:       Optional[str] = None
    notes:         Optional[str] = None


class SettingUpdate(BaseModel):
    value: str


class RegionIn(BaseModel):
    name:        str
    description: Optional[str] = None


class StateIn(BaseModel):
    name:        str
    region_id:   Optional[int] = None
    description: Optional[str] = None


class DistrictIn(BaseModel):
    name:        str
    region_id:   int
    state_id:    int
    description: Optional[str] = None

class GroupIn(BaseModel):
    name:        str
    role_id:     Optional[int] = None
    region_id:   Optional[str] = None   # stored as comma-separated IDs e.g. "1" or "1,2,3"
    state_id:    Optional[str] = None   # stored as comma-separated IDs e.g. "1" or "1,4,5"
    manager_id:  Optional[int] = None
    description: Optional[str] = None
    icon:        Optional[str] = "zap"
    color:       Optional[str] = "violet"
    reporting_hierarchy: List[GroupReportingHierarchyItem] = []


class VerticalSubSectorIn(BaseModel):
    name:      str
    sector_id: int

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Sub-segment name", 2, 100)

    @field_validator("sector_id", mode="before")
    @classmethod
    def _v_sector(cls, v):
        if v in (None, "", 0, "0"):
            raise ValueError("Please select a customer segment.")
        return v

class LeadCategoryIn(BaseModel):
    name:        str
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Name", 2, 100)

    @field_validator("description", mode="before")
    @classmethod
    def _v_description(cls, v):
        return check_text(v, "Description", 0, 255)


class LeadSubCategoryIn(BaseModel):
    name:        str
    category_id: int
    description: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Sub category name", 2, 100)

    @field_validator("category_id", mode="before")
    @classmethod
    def _v_category(cls, v):
        if v in (None, "", 0, "0"):
            raise ValueError("Please select lead category.")
        return v

    @field_validator("description", mode="before")
    @classmethod
    def _v_description(cls, v):
        return check_text(v, "Description", 0, 255)

class OrgTreeNodeIn(BaseModel):
    parent_id: Optional[int] = None
    parent_user_id: Optional[int] = None
    user_id: int
    group_name: Optional[str] = None
    group_lead_id: Optional[int] = None
    position: int = 0

    @field_validator("group_name", mode="before")
    @classmethod
    def _v_group_name(cls, v):
        # required for a new L2 group (checked in the route); never blank / over-long when given
        return check_text(v, "Group name", 2, 150)


class OrgTreeNodeUpdate(BaseModel):
    parent_id: Optional[int] = None
    parent_user_id: Optional[int] = None
    user_id: Optional[int] = None
    group_name: Optional[str] = None
    group_lead_id: Optional[int] = None
    position: Optional[int] = None

class OrgTreeGroupUpdate(BaseModel):
    group_name: str
    group_lead_id: int

    @field_validator("group_name", mode="before")
    @classmethod
    def _v_group_name(cls, v):
        return check_name(v, "Group name", 2, 150)

    @field_validator("group_lead_id", mode="before")
    @classmethod
    def _v_group_lead(cls, v):
        if v in (None, "", 0, "0"):
            raise ValueError("Please select group head.")
        return v


class BusinessCategoryIn(BaseModel):
    name: str

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Vertical name", 2, 100)


class BusinessUnitIn(BaseModel):
    name: str
    category_id: int

    @field_validator("name", mode="before")
    @classmethod
    def _v_name(cls, v):
        return check_name(v, "Unit name", 2, 100)

    @field_validator("category_id", mode="before")
    @classmethod
    def _v_category(cls, v):
        if v in (None, "", 0, "0"):
            raise ValueError("Please select a business vertical.")
        return v


class ReorderIn(BaseModel):
    ids: List[int]


def _ensure_location_master_schema(db: Session) -> None:
    db.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS location_masters (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            parent_id INT NULL,
            item_type VARCHAR(20) NOT NULL,
            name VARCHAR(150) NOT NULL,
            description VARCHAR(255) NULL,
            display_order INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,

            INDEX ix_location_parent_id (parent_id),
            INDEX ix_location_type_active (item_type, is_active),
            INDEX ix_location_display_order (item_type, parent_id, display_order),

            CONSTRAINT fk_location_parent
                FOREIGN KEY (parent_id)
                REFERENCES location_masters(id)
                ON DELETE RESTRICT
        )
    """))
    db.commit()

    try:
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS parent_id INT NULL"))
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'region'"))
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS name VARCHAR(150) NOT NULL"))
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS description VARCHAR(255) NULL"))
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0"))
        db.execute(sa_text("ALTER TABLE location_masters ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1"))
        db.commit()
    except Exception:
        db.rollback()


def _next_location_order(db: Session, item_type: str, parent_id: Optional[int] = None) -> int:
    if parent_id is None:
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM location_masters
            WHERE item_type = :item_type
              AND parent_id IS NULL
              AND is_active = 1
        """), {"item_type": item_type}).scalar()
    else:
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM location_masters
            WHERE item_type = :item_type
              AND parent_id = :parent_id
              AND is_active = 1
        """), {
            "item_type": item_type,
            "parent_id": parent_id,
        }).scalar()

    return int(value or 1)


def _get_active_location(db: Session, location_id: int, item_type: str):
    return db.execute(sa_text("""
        SELECT id, parent_id, item_type, name, description, display_order, is_active
        FROM location_masters
        WHERE id = :id
          AND item_type = :item_type
          AND is_active = 1
        LIMIT 1
    """), {
        "id": location_id,
        "item_type": item_type,
    }).mappings().first()


def _duplicate_location_exists(
    db: Session,
    item_type: str,
    name: str,
    parent_id: Optional[int] = None,
    exclude_id: Optional[int] = None,
) -> bool:
    sql = """
        SELECT id
        FROM location_masters
        WHERE item_type = :item_type
          AND LOWER(name) = LOWER(:name)
          AND is_active = 1
    """
    params = {
        "item_type": item_type,
        "name": name,
    }

    if parent_id is None:
        sql += " AND parent_id IS NULL"
    else:
        sql += " AND parent_id = :parent_id"
        params["parent_id"] = parent_id

    if exclude_id is not None:
        sql += " AND id != :exclude_id"
        params["exclude_id"] = exclude_id

    sql += " LIMIT 1"

    row = db.execute(sa_text(sql), params).mappings().first()
    return bool(row)


def _row_to_region(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "is_active": bool(row["is_active"]),
        "display_order": row["display_order"],
    }


def _row_to_state(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "region_id": row["region_id"],
        "region_name": row["region_name"] or "",
        "description": row["description"],
        "is_active": bool(row["is_active"]),
        "display_order": row["display_order"],
    }


def _row_to_district(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "region_id": row["region_id"],
        "state_id": row["state_id"],
        "region_name": row["region_name"] or "",
        "state_name": row["state_name"] or "",
        "description": row["description"],
        "is_active": bool(row["is_active"]),
        "display_order": row["display_order"],
    }


# ─── Lead Sources ─────────────────────────────────────────────────────────────

@router.get("/lead-sources")
def list_lead_sources(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    return db.query(LeadSource).filter(LeadSource.is_active == True).all()


@router.post("/lead-sources", status_code=201)
def create_lead_source(data: SimpleItem, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    if db.query(LeadSource).filter(func.lower(LeadSource.name) == data.name.lower()).first():
        raise field_error("name", "A lead source with this name already exists.", 409)
    s = LeadSource(name=data.name, description=data.description)
    db.add(s); db.commit(); db.refresh(s)
    return s


@router.put("/lead-sources/{id}")
def update_lead_source(id: int, data: SimpleItem, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(LeadSource).filter(LeadSource.id == id).first()
    if not s: raise HTTPException(404, "Not found")
    if db.query(LeadSource).filter(LeadSource.id != id, func.lower(LeadSource.name) == data.name.lower()).first():
        raise field_error("name", "A lead source with this name already exists.", 409)
    s.name = data.name
    if data.description is not None: s.description = data.description
    db.commit(); db.refresh(s)
    return s


@router.delete("/lead-sources/{id}")
def delete_lead_source(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(LeadSource).filter(LeadSource.id == id).first()
    if not s: raise HTTPException(404, "Not found")
    s.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Competitors ──────────────────────────────────────────────────────────────

@router.get("/competitors")
def list_competitors(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    return db.query(Competitor).filter(Competitor.is_active == True).order_by(Competitor.name).all()


@router.post("/competitors", status_code=201)
def create_competitor(data: CompetitorIn, db: Session = Depends(get_tenant_db), _: User = Depends(require_permission("competitors.create"))):
    fields = {col.key for col in Competitor.__table__.columns}
    payload = {k: v for k, v in data.model_dump().items() if k in fields and v is not None}
    existing = db.query(Competitor).filter(Competitor.name == data.name).first()
    if existing:
        if existing.is_active:
            raise HTTPException(400, "Competitor already exists")
        db.delete(existing)
        db.flush()

    c = Competitor(**payload)
    db.add(c)
    db.commit(); db.refresh(c)
    return c


@router.put("/competitors/{id}")
def update_competitor(id: int, data: CompetitorIn, db: Session = Depends(get_tenant_db), _: User = Depends(require_permission("competitors.update"))):
    c = db.query(Competitor).filter(Competitor.id == id, Competitor.is_active == True).first()
    if not c: raise HTTPException(404, "Not found")
    duplicate = db.query(Competitor).filter(
        Competitor.id != id,
        Competitor.name == data.name,
        Competitor.is_active == True,
    ).first()
    if duplicate:
        raise HTTPException(400, "Competitor already exists")
    fields = {col.key for col in Competitor.__table__.columns}
    for f, v in data.model_dump(exclude_unset=True).items():
        if f in fields and hasattr(c, f): setattr(c, f, v)
    db.commit(); db.refresh(c)
    return c


@router.delete("/competitors/{id}")
def delete_competitor(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(require_permission("competitors.delete"))):
    c = db.query(Competitor).filter(Competitor.id == id).first()
    if not c: raise HTTPException(404, "Not found")
    db.delete(c)
    db.commit()
    return {"message": "Deleted"}


# ─── Products ─────────────────────────────────────────────────────────────────

def _ensure_product_schema(db: Session) -> None:
    """Add is_active column to product_masters if missing (older tenant DBs)."""
    try:
        db.execute(sa_text(
            "ALTER TABLE product_masters ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1"
        ))
        db.execute(sa_text(
            "UPDATE product_masters SET is_active = 1 WHERE is_active IS NULL"
        ))
        db.commit()
    except Exception:
        db.rollback()


@router.get("/products")
def list_products(category: Optional[str] = None, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _ensure_product_schema(db)
    q = db.query(ProductMaster).filter(or_(ProductMaster.is_active == True, ProductMaster.is_active == None))
    if category: q = q.filter(ProductMaster.category == category)
    return q.all()


@router.post("/products", status_code=201)
def create_product(data: ProductIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    _ensure_product_schema(db)
    if db.query(ProductMaster).filter(
        func.lower(ProductMaster.name) == data.name.lower(),
        or_(ProductMaster.is_active == True, ProductMaster.is_active == None),
    ).first():
        raise field_error("name", "A product with this name already exists.", 409)
    fields = {col.key for col in ProductMaster.__table__.columns}
    p = ProductMaster(**{k: v for k, v in data.model_dump().items() if k in fields})
    db.add(p); db.commit(); db.refresh(p)
    return p


@router.put("/products/{id}")
def update_product(id: int, data: ProductIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    p = db.query(ProductMaster).filter(ProductMaster.id == id).first()
    if not p: raise HTTPException(404, "Not found")
    if db.query(ProductMaster).filter(
        ProductMaster.id != id,
        func.lower(ProductMaster.name) == data.name.lower(),
        or_(ProductMaster.is_active == True, ProductMaster.is_active == None),
    ).first():
        raise field_error("name", "A product with this name already exists.", 409)
    fields = {col.key for col in ProductMaster.__table__.columns}
    for f, v in data.model_dump(exclude_unset=True).items():
        if f in fields and hasattr(p, f): setattr(p, f, v)
    db.commit(); db.refresh(p)
    return p


@router.delete("/products/{id}")
def delete_product(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    p = db.query(ProductMaster).filter(ProductMaster.id == id).first()
    if not p: raise HTTPException(404, "Not found")
    p.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── OEMs ─────────────────────────────────────────────────────────────────────

@router.get("/oems")
def list_oems(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    oems = db.query(OEM).filter(OEM.is_active == True).order_by(OEM.name).all()
    product_ids = {int(o.product_id) for o in oems if o.product_id}
    product_name_map = {
        int(product_id): name or ""
        for product_id, name in db.query(ProductMaster.id, ProductMaster.name).filter(
            ProductMaster.id.in_(product_ids)
        ).all()
    } if product_ids else {}
    result = []
    for o in oems:
        d = {c.name: getattr(o, c.name) for c in o.__table__.columns}
        d['product_name'] = product_name_map.get(int(o.product_id), '') if o.product_id else ''
        result.append(d)
    return result


@router.get("/product-oem-map")
def product_oem_map(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    rows = db.query(OEM.product_id, OEM.id).filter(OEM.is_active == True, OEM.product_id.isnot(None)).all()
    mapping: dict[int, list[int]] = {}
    for product_id, oem_id in rows:
        mapping.setdefault(int(product_id), []).append(int(oem_id))
    return [{"product_id": pid, "oem_ids": oem_ids} for pid, oem_ids in mapping.items()]


@router.post("/oems", status_code=201)
def create_oem(data: OEMIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    fields = {col.key for col in OEM.__table__.columns}
    oem_data = {k: v for k, v in data.model_dump().items() if k in fields and v is not None}
    oem_data['created_by'] = cu.id
    o = OEM(**oem_data)
    db.add(o); db.commit(); db.refresh(o)
    return o


@router.put("/oems/{id}")
def update_oem(id: int, data: OEMIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    o = db.query(OEM).filter(OEM.id == id).first()
    if not o: raise HTTPException(404, "Not found")
    fields = {col.key for col in OEM.__table__.columns}
    for f, v in data.model_dump(exclude_unset=True).items():
        if f in fields and hasattr(o, f): setattr(o, f, v)
    db.commit(); db.refresh(o)
    return o


@router.delete("/oems/{id}")
def delete_oem(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    o = db.query(OEM).filter(OEM.id == id).first()
    if not o: raise HTTPException(404, "Not found")
    o.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Location Masters - Single Table ──────────────────────────────────────────

def _ensure_location_master_schema(db: Session) -> None:
    db.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS location_masters (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            parent_id INT NULL,
            item_type VARCHAR(20) NOT NULL,
            name VARCHAR(150) NOT NULL,
            description VARCHAR(255) NULL,
            display_order INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,

            INDEX ix_location_parent_id (parent_id),
            INDEX ix_location_type_active (item_type, is_active),
            INDEX ix_location_display_order (item_type, parent_id, display_order),

            CONSTRAINT fk_location_parent
                FOREIGN KEY (parent_id)
                REFERENCES location_masters(id)
                ON DELETE RESTRICT
        )
    """))
    db.commit()


def _next_location_order(db: Session, item_type: str, parent_id: Optional[int] = None) -> int:
    if parent_id is None:
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM location_masters
            WHERE item_type = :item_type
              AND parent_id IS NULL
              AND is_active = 1
        """), {"item_type": item_type}).scalar()
    else:
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM location_masters
            WHERE item_type = :item_type
              AND parent_id = :parent_id
              AND is_active = 1
        """), {
            "item_type": item_type,
            "parent_id": parent_id,
        }).scalar()

    return int(value or 1)


def _get_active_location(db: Session, location_id: int, item_type: str):
    return db.execute(sa_text("""
        SELECT id, parent_id, item_type, name, description, display_order, is_active
        FROM location_masters
        WHERE id = :id
          AND item_type = :item_type
          AND is_active = 1
        LIMIT 1
    """), {
        "id": location_id,
        "item_type": item_type,
    }).mappings().first()


def _duplicate_location_exists(
    db: Session,
    item_type: str,
    name: str,
    parent_id: Optional[int] = None,
    exclude_id: Optional[int] = None,
) -> bool:
    sql = """
        SELECT id
        FROM location_masters
        WHERE item_type = :item_type
          AND LOWER(name) = LOWER(:name)
          AND is_active = 1
    """
    params = {
        "item_type": item_type,
        "name": name,
    }

    if parent_id is None:
        sql += " AND parent_id IS NULL"
    else:
        sql += " AND parent_id = :parent_id"
        params["parent_id"] = parent_id

    if exclude_id is not None:
        sql += " AND id != :exclude_id"
        params["exclude_id"] = exclude_id

    sql += " LIMIT 1"

    row = db.execute(sa_text(sql), params).mappings().first()
    return bool(row)


@router.get("/regions")
def list_regions(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_location_master_schema(db)

    rows = db.execute(sa_text("""
        SELECT
            r.id,
            r.name,
            r.description,
            r.display_order,
            r.is_active,
            (
                SELECT COUNT(*)
                FROM location_masters s
                WHERE s.parent_id = r.id
                  AND s.item_type = 'state'
                  AND s.is_active = 1
            ) AS state_count,
            (
                SELECT COUNT(*)
                FROM location_masters d
                INNER JOIN location_masters s ON s.id = d.parent_id
                WHERE s.parent_id = r.id
                  AND d.item_type = 'district'
                  AND d.is_active = 1
            ) AS district_count
        FROM location_masters r
        WHERE r.item_type = 'region'
          AND r.parent_id IS NULL
          AND r.is_active = 1
        ORDER BY r.display_order, r.name, r.id
    """)).mappings().all()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "is_active": bool(row["is_active"]),
            "display_order": row["display_order"],
            "state_count": int(row["state_count"] or 0),
            "district_count": int(row["district_count"] or 0),
        }
        for row in rows
    ]


@router.post("/regions", status_code=201)
def create_region(
    data: RegionIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage regions")

    _ensure_location_master_schema(db)

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Region name is required")

    if _duplicate_location_exists(db, "region", name):
        raise HTTPException(400, "Region already exists")

    result = db.execute(sa_text("""
        INSERT INTO location_masters
            (parent_id, item_type, name, description, display_order, is_active)
        VALUES
            (NULL, 'region', :name, :description, :display_order, 1)
    """), {
        "name": name,
        "description": data.description,
        "display_order": _next_location_order(db, "region"),
    })

    db.commit()

    return {
        "id": result.lastrowid,
        "name": name,
        "description": data.description,
        "is_active": True,
    }


@router.put("/regions/{id}")
def update_region(
    id: int,
    data: RegionIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage regions")

    _ensure_location_master_schema(db)

    region = _get_active_location(db, id, "region")
    if not region:
        raise HTTPException(404, "Region not found")

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Region name is required")

    if _duplicate_location_exists(db, "region", name, exclude_id=id):
        raise HTTPException(400, "Region already exists")

    db.execute(sa_text("""
        UPDATE location_masters
        SET name = :name,
            description = :description,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'region'
    """), {
        "id": id,
        "name": name,
        "description": data.description,
    })

    db.commit()

    return {
        "id": id,
        "name": name,
        "description": data.description,
        "is_active": True,
    }


@router.delete("/regions/{id}")
def delete_region(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage regions")

    _ensure_location_master_schema(db)

    region = _get_active_location(db, id, "region")
    if not region:
        raise HTTPException(404, "Region not found")

    state_count = db.execute(sa_text("""
        SELECT COUNT(*)
        FROM location_masters
        WHERE parent_id = :id
          AND item_type = 'state'
          AND is_active = 1
    """), {"id": id}).scalar() or 0

    if state_count:
        raise HTTPException(400, f"Cannot delete region - {state_count} state(s) still assigned to it")

    db.execute(sa_text("""
        UPDATE location_masters
        SET is_active = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'region'
    """), {"id": id})

    db.commit()

    return {"message": "Region deleted"}


@router.get("/states")
def list_states(
    region_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_location_master_schema(db)

    sql = """
        SELECT
            s.id,
            s.parent_id AS region_id,
            s.name,
            s.description,
            s.display_order,
            s.is_active,
            r.name AS region_name
        FROM location_masters s
        LEFT JOIN location_masters r
            ON r.id = s.parent_id
           AND r.item_type = 'region'
           AND r.is_active = 1
        WHERE s.item_type = 'state'
          AND s.is_active = 1
    """
    params = {}

    if region_id is not None:
        sql += " AND s.parent_id = :region_id"
        params["region_id"] = region_id

    sql += " ORDER BY r.display_order, r.name, s.display_order, s.name, s.id"

    rows = db.execute(sa_text(sql), params).mappings().all()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "region_id": row["region_id"],
            "region_name": row["region_name"] or "",
            "description": row["description"],
            "is_active": bool(row["is_active"]),
            "display_order": row["display_order"],
        }
        for row in rows
    ]


@router.post("/states", status_code=201)
def create_state(
    data: StateIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage states")

    _ensure_location_master_schema(db)

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "State name is required")

    if not data.region_id:
        raise HTTPException(400, "Region is required")

    region = _get_active_location(db, data.region_id, "region")
    if not region:
        raise HTTPException(400, "Region not found")

    if _duplicate_location_exists(db, "state", name, parent_id=data.region_id):
        raise HTTPException(400, "State already exists under this region")

    result = db.execute(sa_text("""
        INSERT INTO location_masters
            (parent_id, item_type, name, description, display_order, is_active)
        VALUES
            (:region_id, 'state', :name, :description, :display_order, 1)
    """), {
        "region_id": data.region_id,
        "name": name,
        "description": data.description,
        "display_order": _next_location_order(db, "state", data.region_id),
    })

    db.commit()

    return {
        "id": result.lastrowid,
        "name": name,
        "region_id": data.region_id,
        "region_name": region["name"],
        "description": data.description,
        "is_active": True,
    }


@router.put("/states/{id}")
def update_state(
    id: int,
    data: StateIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage states")

    _ensure_location_master_schema(db)

    state = _get_active_location(db, id, "state")
    if not state:
        raise HTTPException(404, "State not found")

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "State name is required")

    if not data.region_id:
        raise HTTPException(400, "Region is required")

    region = _get_active_location(db, data.region_id, "region")
    if not region:
        raise HTTPException(400, "Region not found")

    if _duplicate_location_exists(db, "state", name, parent_id=data.region_id, exclude_id=id):
        raise HTTPException(400, "State already exists under this region")

    db.execute(sa_text("""
        UPDATE location_masters
        SET parent_id = :region_id,
            name = :name,
            description = :description,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'state'
    """), {
        "id": id,
        "region_id": data.region_id,
        "name": name,
        "description": data.description,
    })

    db.commit()

    return {
        "id": id,
        "name": name,
        "region_id": data.region_id,
        "region_name": region["name"],
        "description": data.description,
        "is_active": True,
    }


@router.delete("/states/{id}")
def delete_state(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage states")

    _ensure_location_master_schema(db)

    state = _get_active_location(db, id, "state")
    if not state:
        raise HTTPException(404, "State not found")

    district_count = db.execute(sa_text("""
        SELECT COUNT(*)
        FROM location_masters
        WHERE parent_id = :id
          AND item_type = 'district'
          AND is_active = 1
    """), {"id": id}).scalar() or 0

    if district_count:
        raise HTTPException(400, f"Cannot delete state - {district_count} district(s) still assigned to it")

    db.execute(sa_text("""
        UPDATE location_masters
        SET is_active = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'state'
    """), {"id": id})

    db.commit()

    return {"message": "State deleted"}


@router.get("/districts")
def list_districts(
    region_id: Optional[int] = None,
    state_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_location_master_schema(db)

    sql = """
        SELECT
            d.id,
            d.name,
            d.description,
            d.display_order,
            d.is_active,
            d.parent_id AS state_id,
            s.name AS state_name,
            s.parent_id AS region_id,
            r.name AS region_name
        FROM location_masters d
        INNER JOIN location_masters s
            ON s.id = d.parent_id
           AND s.item_type = 'state'
           AND s.is_active = 1
        INNER JOIN location_masters r
            ON r.id = s.parent_id
           AND r.item_type = 'region'
           AND r.is_active = 1
        WHERE d.item_type = 'district'
          AND d.is_active = 1
    """
    params = {}

    if region_id is not None:
        sql += " AND s.parent_id = :region_id"
        params["region_id"] = region_id

    if state_id is not None:
        sql += " AND d.parent_id = :state_id"
        params["state_id"] = state_id

    sql += """
        ORDER BY r.display_order, r.name,
                 s.display_order, s.name,
                 d.display_order, d.name, d.id
    """

    rows = db.execute(sa_text(sql), params).mappings().all()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "region_id": row["region_id"],
            "state_id": row["state_id"],
            "region_name": row["region_name"] or "",
            "state_name": row["state_name"] or "",
            "description": row["description"],
            "is_active": bool(row["is_active"]),
            "display_order": row["display_order"],
        }
        for row in rows
    ]


@router.post("/districts", status_code=201)
def create_district(
    data: DistrictIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage districts")

    _ensure_location_master_schema(db)

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "District name is required")

    region = _get_active_location(db, data.region_id, "region")
    if not region:
        raise HTTPException(400, "Region not found")

    state = _get_active_location(db, data.state_id, "state")
    if not state:
        raise HTTPException(400, "State not found")

    if int(state["parent_id"]) != int(data.region_id):
        raise HTTPException(400, "Selected state does not belong to selected region")

    if _duplicate_location_exists(db, "district", name, parent_id=data.state_id):
        raise HTTPException(400, "District already exists under this state")

    result = db.execute(sa_text("""
        INSERT INTO location_masters
            (parent_id, item_type, name, description, display_order, is_active)
        VALUES
            (:state_id, 'district', :name, :description, :display_order, 1)
    """), {
        "state_id": data.state_id,
        "name": name,
        "description": data.description,
        "display_order": _next_location_order(db, "district", data.state_id),
    })

    db.commit()

    return {
        "id": result.lastrowid,
        "name": name,
        "region_id": data.region_id,
        "state_id": data.state_id,
        "region_name": region["name"],
        "state_name": state["name"],
        "description": data.description,
        "is_active": True,
    }


@router.put("/districts/{id}")
def update_district(
    id: int,
    data: DistrictIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage districts")

    _ensure_location_master_schema(db)

    district = _get_active_location(db, id, "district")
    if not district:
        raise HTTPException(404, "District not found")

    name = data.name.strip()
    if not name:
        raise HTTPException(400, "District name is required")

    region = _get_active_location(db, data.region_id, "region")
    if not region:
        raise HTTPException(400, "Region not found")

    state = _get_active_location(db, data.state_id, "state")
    if not state:
        raise HTTPException(400, "State not found")

    if int(state["parent_id"]) != int(data.region_id):
        raise HTTPException(400, "Selected state does not belong to selected region")

    if _duplicate_location_exists(db, "district", name, parent_id=data.state_id, exclude_id=id):
        raise HTTPException(400, "District already exists under this state")

    db.execute(sa_text("""
        UPDATE location_masters
        SET parent_id = :state_id,
            name = :name,
            description = :description,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'district'
    """), {
        "id": id,
        "state_id": data.state_id,
        "name": name,
        "description": data.description,
    })

    db.commit()

    return {
        "id": id,
        "name": name,
        "region_id": data.region_id,
        "state_id": data.state_id,
        "region_name": region["name"],
        "state_name": state["name"],
        "description": data.description,
        "is_active": True,
    }


@router.delete("/districts/{id}")
def delete_district(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ("admin", "ceo", "manager"):
        raise HTTPException(403, "Insufficient permissions to manage districts")

    _ensure_location_master_schema(db)

    district = _get_active_location(db, id, "district")
    if not district:
        raise HTTPException(404, "District not found")

    db.execute(sa_text("""
        UPDATE location_masters
        SET is_active = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :id
          AND item_type = 'district'
    """), {"id": id})

    db.commit()

    return {"message": "District deleted"}

@router.get("/vertical-sectors")
def list_vertical_sectors(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _seed_default_vertical_sectors(db)
    return db.query(VerticalSector).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()


@router.put("/vertical-sectors/order")
def reorder_vertical_sectors(data: ReorderIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _seed_default_vertical_sectors(db)
    active_ids = [
        row[0] for row in db.query(VerticalSector.id)
        .filter(VerticalSector.is_active == True)
        .order_by(VerticalSector.display_order, VerticalSector.name, VerticalSector.id)
        .all()
    ]
    seen: set[int] = set()
    ordered_ids = [int(id_) for id_ in data.ids if int(id_) not in seen and not seen.add(int(id_))]
    invalid_ids = [id_ for id_ in ordered_ids if id_ not in active_ids]
    if invalid_ids:
        raise HTTPException(400, "Invalid customer segment in display order")
    final_ids = ordered_ids + [id_ for id_ in active_ids if id_ not in ordered_ids]
    for pos, id_ in enumerate(final_ids, start=1):
        db.query(VerticalSector).filter(VerticalSector.id == id_).update({"display_order": pos})
    db.commit()
    return db.query(VerticalSector).filter(VerticalSector.is_active == True).order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSector.id,
    ).all()


@router.post("/vertical-sectors", status_code=201)
def create_vertical_sector(data: SimpleItem, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _ensure_vertical_sector_schema(db)
    existing = db.query(VerticalSector).filter(VerticalSector.name == data.name).first()
    if existing and existing.is_active:
        raise field_error("name", "A customer segment with this name already exists.", 409)
    if existing:
        existing.description = data.description
        existing.is_active = True
        if not getattr(existing, "display_order", 0):
            existing.display_order = _next_vertical_sector_order(db)
        db.commit(); db.refresh(existing)
        return existing
    item = VerticalSector(name=data.name, description=data.description, display_order=_next_vertical_sector_order(db))
    db.add(item); db.commit(); db.refresh(item)
    return item


def _clean_segment_name(value):
    if not value:
        return ""
    return " ".join(str(value).replace(chr(160), " ").split()).strip()


@router.put("/vertical-sectors/{id}")
def update_vertical_sector(id: int, data: SimpleItem, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _ensure_vertical_sector_schema(db)
    item = db.query(VerticalSector).filter(VerticalSector.id == id).first()
    if not item: raise HTTPException(404, "Vertical / Sector not found")
    duplicate = db.query(VerticalSector).filter(
        VerticalSector.id != id,
        VerticalSector.name == data.name,
    ).first()
    if duplicate:
        raise field_error("name", "A customer segment with this name already exists.", 409)
    old_name = _clean_segment_name(item.name).casefold()
    new_name = data.name
    item.name = new_name
    if data.description is not None: item.description = data.description
    # Customer.customer_vertical is free text, not FK-constrained — cascade the
    # rename to existing customers so historical rows don't silently drift out
    # of sync with the master and disappear from segment filters/reports.
    if old_name and old_name != _clean_segment_name(new_name).casefold():
        for customer in db.query(Customer).filter(Customer.customer_vertical.isnot(None)).all():
            if _clean_segment_name(customer.customer_vertical).casefold() == old_name:
                customer.customer_vertical = new_name
    db.commit(); db.refresh(item)
    return item


@router.delete("/vertical-sectors/{id}")
def delete_vertical_sector(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    _ensure_vertical_sector_schema(db)
    item = db.query(VerticalSector).filter(VerticalSector.id == id).first()
    if not item: raise HTTPException(404, "Vertical / Sector not found")
    active_subs = db.query(VerticalSubSector).filter(
        VerticalSubSector.sector_id == id, VerticalSubSector.is_active == True
    ).count()
    if active_subs:
        raise HTTPException(400, f"Cannot delete — {active_subs} sub-segment(s) still exist")
    item.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Vertical Sub Sectors ─────────────────────────────────────────────────────

@router.get("/vertical-sub-sectors")
def list_vertical_sub_sectors(
    sector_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _seed_default_vertical_sectors(db)
    q = db.query(VerticalSubSector).join(
        VerticalSector,
        VerticalSector.id == VerticalSubSector.sector_id,
    ).filter(
        VerticalSubSector.is_active == True,
        VerticalSector.is_active == True,
    )
    if sector_id:
        q = q.filter(VerticalSubSector.sector_id == sector_id)
    subs = q.order_by(
        VerticalSector.display_order,
        VerticalSector.name,
        VerticalSubSector.name,
        VerticalSubSector.id,
    ).all()
    sector_ids = {s.sector_id for s in subs}
    sector_map = {
        c.id: c for c in db.query(VerticalSector).filter(VerticalSector.id.in_(sector_ids)).all()
    } if sector_ids else {}
    result = []
    for s in subs:
        d = {c.name: getattr(s, c.name) for c in s.__table__.columns}
        sec = sector_map.get(s.sector_id)
        d['sector_name'] = sec.name if sec else ''
        result.append(d)
    return result


@router.post("/vertical-sub-sectors", status_code=201)
def create_vertical_sub_sector(data: VerticalSubSectorIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    sec = db.query(VerticalSector).filter(VerticalSector.id == data.sector_id, VerticalSector.is_active == True).first()
    if not sec:
        raise field_error("sector_id", "Customer segment not found or inactive.", 400)
    if db.query(VerticalSubSector).filter(
        VerticalSubSector.sector_id == data.sector_id,
        VerticalSubSector.name == data.name,
        VerticalSubSector.is_active == True,
    ).first():
        raise field_error("name", "Sub-segment already exists under this segment.", 409)
    s = VerticalSubSector(name=data.name, sector_id=data.sector_id)
    db.add(s); db.commit(); db.refresh(s)
    return s


@router.put("/vertical-sub-sectors/{id}")
def update_vertical_sub_sector(id: int, data: VerticalSubSectorIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(VerticalSubSector).filter(VerticalSubSector.id == id).first()
    if not s: raise HTTPException(404, "Sub-segment not found")
    if not db.query(VerticalSector).filter(VerticalSector.id == data.sector_id, VerticalSector.is_active == True).first():
        raise field_error("sector_id", "Customer segment not found or inactive.", 400)
    dup = db.query(VerticalSubSector).filter(
        VerticalSubSector.id != id,
        VerticalSubSector.sector_id == data.sector_id,
        VerticalSubSector.name == data.name,
        VerticalSubSector.is_active == True,
    ).first()
    if dup: raise field_error("name", "Sub-segment already exists under this segment.", 409)
    s.name = data.name
    s.sector_id = data.sector_id
    db.commit(); db.refresh(s)
    return s


@router.delete("/vertical-sub-sectors/{id}")
def delete_vertical_sub_sector(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(VerticalSubSector).filter(VerticalSubSector.id == id).first()
    if not s: raise HTTPException(404, "Sub-segment not found")
    s.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Lead Categories ──────────────────────────────────────────────────────────

@router.get("/lead-categories")
def list_lead_categories(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    return db.query(LeadCategory).filter(LeadCategory.is_active == True).order_by(LeadCategory.name).all()


@router.post("/lead-categories", status_code=201)
def create_lead_category(data: LeadCategoryIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    if db.query(LeadCategory).filter(LeadCategory.name == data.name, LeadCategory.is_active == True).first():
        raise field_error("name", "A lead category with this name already exists.", 409)
    c = LeadCategory(name=data.name, description=data.description)
    db.add(c); db.commit(); db.refresh(c)
    return c


@router.put("/lead-categories/{id}")
def update_lead_category(id: int, data: LeadCategoryIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    c = db.query(LeadCategory).filter(LeadCategory.id == id).first()
    if not c: raise HTTPException(404, "Not found")
    if db.query(LeadCategory).filter(LeadCategory.id != id, LeadCategory.name == data.name, LeadCategory.is_active == True).first():
        raise field_error("name", "A lead category with this name already exists.", 409)
    c.name = data.name
    if data.description is not None: c.description = data.description
    db.commit(); db.refresh(c)
    return c


@router.delete("/lead-categories/{id}")
def delete_lead_category(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    c = db.query(LeadCategory).filter(LeadCategory.id == id).first()
    if not c: raise HTTPException(404, "Not found")
    active_subs = db.query(LeadSubCategory).filter(
        LeadSubCategory.category_id == id, LeadSubCategory.is_active == True
    ).count()
    if active_subs:
        raise HTTPException(400, f"Cannot delete — {active_subs} sub-category(s) still exist")
    c.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Lead Sub Categories ──────────────────────────────────────────────────────

@router.get("/lead-sub-categories")
def list_lead_sub_categories(
    category_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    q = db.query(LeadSubCategory).filter(LeadSubCategory.is_active == True)
    if category_id: q = q.filter(LeadSubCategory.category_id == category_id)
    subs = q.order_by(LeadSubCategory.name).all()
    cat_ids = {s.category_id for s in subs if s.category_id}
    cat_map: dict = {
        c.id: c for c in db.query(LeadCategory).filter(LeadCategory.id.in_(cat_ids)).all()
    } if cat_ids else {}
    result = []
    for s in subs:
        d = {c.name: getattr(s, c.name) for c in s.__table__.columns}
        cat = cat_map.get(s.category_id)
        d['category_name'] = cat.name if cat else ''
        result.append(d)
    return result


@router.post("/lead-sub-categories", status_code=201)
def create_lead_sub_category(data: LeadSubCategoryIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    cat = db.query(LeadCategory).filter(LeadCategory.id == data.category_id, LeadCategory.is_active == True).first()
    if not cat:
        raise field_error("category_id", "Lead category not found or inactive.", 400)
    if db.query(LeadSubCategory).filter(
        LeadSubCategory.category_id == data.category_id,
        LeadSubCategory.name == data.name,
        LeadSubCategory.is_active == True,
    ).first():
        raise field_error("name", "This sub category already exists under the selected lead category.", 409)
    s = LeadSubCategory(name=data.name, category_id=data.category_id, description=data.description)
    db.add(s); db.commit(); db.refresh(s)
    return s


@router.put("/lead-sub-categories/{id}")
def update_lead_sub_category(id: int, data: LeadSubCategoryIn, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(LeadSubCategory).filter(LeadSubCategory.id == id).first()
    if not s: raise HTTPException(404, "Not found")
    if not db.query(LeadCategory).filter(LeadCategory.id == data.category_id, LeadCategory.is_active == True).first():
        raise field_error("category_id", "Lead category not found or inactive.", 400)
    if db.query(LeadSubCategory).filter(
        LeadSubCategory.id != id,
        LeadSubCategory.category_id == data.category_id,
        LeadSubCategory.name == data.name,
        LeadSubCategory.is_active == True,
    ).first():
        raise field_error("name", "This sub category already exists under the selected lead category.", 409)
    s.name        = data.name
    s.category_id = data.category_id
    if data.description is not None: s.description = data.description
    db.commit(); db.refresh(s)
    return s


@router.delete("/lead-sub-categories/{id}")
def delete_lead_sub_category(id: int, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    s = db.query(LeadSubCategory).filter(LeadSubCategory.id == id).first()
    if not s: raise HTTPException(404, "Not found")
    s.is_active = False; db.commit()
    return {"message": "Deleted"}


# ─── Groups ───────────────────────────────────────────────────────────────────

def _remove_group_id_from_user(db: Session, group_id: int, user_id: int):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return

    group_id_str = str(group_id)

    existing_ids = [
        x.strip()
        for x in str(user.group_id or "").split(",")
        if x.strip()
    ]

    user.group_id = ",".join([
        x for x in existing_ids if x != group_id_str
    ]) or None

def _append_group_id_to_users(db: Session, group_id: int, user_ids: List[int]):
    if not user_ids:
        return

    users = db.query(User).filter(
        User.id.in_(user_ids),
        User.is_active == True,
    ).all()

    for user in users:
        existing_ids = [
            x.strip()
            for x in str(user.group_id or "").split(",")
            if x.strip()
        ]

        group_id_str = str(group_id)

        if group_id_str not in existing_ids:
            existing_ids.append(group_id_str)

        user.group_id = ",".join(existing_ids)


def _sync_group_reporting_hierarchy(
    db: Session,
    group_id: int,
    reporting_hierarchy: List[GroupReportingHierarchyItem],
):
    normalized_rows: list[tuple[int, GroupReportingHierarchyItem, int, str]] = []
    if normalized_rows:
        lead_count = sum(
            1 for _, item, _, _ in normalized_rows
            if bool(item.is_group_lead)
        )

        if lead_count == 0:
            raise HTTPException(400, "Please select one Group Lead from the reporting managers")

        if lead_count > 1:
            raise HTTPException(400, "Only one Group Lead can be selected")

    for index, item in enumerate(reporting_hierarchy or []):
        if not item.reporting_user_id:
            continue

        reporting_user = db.query(User).filter(
            User.id == item.reporting_user_id,
            User.is_active == True,
        ).first()

        if not reporting_user:
            raise HTTPException(400, "Invalid reporting user selected")

        if item.reporting_role not in ("manager", "sales_head", "vp", "ceo"):
            raise HTTPException(400, "Reporting role must be Manager, Sales Head, VP, or CEO")

        normalized_role = "manager" if item.reporting_role == "sales_head" else item.reporting_role
        normalized_rows.append((index, item, int(reporting_user.id), normalized_role))

    for position, (index, item, reporting_user_id, normalized_role) in enumerate(normalized_rows):
        parent_user_id = normalized_rows[position + 1][2] if position + 1 < len(normalized_rows) else None

        existing = db.query(UserReportingHierarchy).filter(
            UserReportingHierarchy.group_id == group_id,
            UserReportingHierarchy.reporting_user_id == reporting_user_id,
            UserReportingHierarchy.reporting_role == normalized_role,
        ).first()

        if not existing:
            db.add(UserReportingHierarchy(
                group_id=group_id,
                reporting_user_id=reporting_user_id,
                parent_user_id=parent_user_id,
                reporting_role=normalized_role,
                level=item.level or index + 1,
                is_group_lead=bool(item.is_group_lead),
                is_active=True,
            ))
        else:
            existing.parent_user_id = parent_user_id
            existing.level = item.level or index + 1
            existing.is_group_lead = bool(item.is_group_lead)
            existing.is_active = True

    reporting_user_ids = [
        item.reporting_user_id
        for item in reporting_hierarchy or []
        if item.reporting_user_id
    ]

    _append_group_id_to_users(db, group_id, reporting_user_ids)

@router.get("/roles-for-select")
def roles_for_select(
    names: Optional[str] = None,   # comma-separated role names to filter e.g. "vp,sales_head"
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    """Return active roles for dropdowns, optionally filtered by name."""
    q = db.query(Role).filter(Role.is_active == True)
    if names:
        name_list = _expand_role_names([n.strip() for n in names.split(',') if n.strip()])
        q = q.filter(Role.name.in_(name_list))
    roles = q.order_by(Role.level).all()
    return [
        {
            "value": r.id,
            "label": r.display_name,
            "name":  r.name,
            "level": r.level,
        }
        for r in roles
    ]
 

@router.get("/groups")
def list_groups(
    region_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    # Use raw SQL to avoid ORM issues when migration is pending
    base_sql = """
        SELECT g.id, g.name, g.role_id, g.region_id, g.state_id,
               g.manager_id, g.description, g.icon, g.color,
               g.is_active, g.created_at, g.updated_at
        FROM `groups` g
        WHERE g.is_active = 1
    """
    params: dict = {}
    if region_id:
        base_sql += " AND g.region_id = :region_id"
        params["region_id"] = str(region_id)
    base_sql += " ORDER BY g.name"

    try:
        rows = db.execute(sa_text(base_sql), params).mappings().all()
    except Exception:
        # role_id column may not exist yet (migration pending); fall back without it
        base_sql_fallback = """
            SELECT g.id, g.name, NULL AS role_id,
                   g.region_id, g.state_id, g.manager_id,
                   g.description, g.icon, g.color,
                   g.is_active, g.created_at, g.updated_at
            FROM `groups` g WHERE g.is_active = 1
        """
        if region_id:
            base_sql_fallback += " AND g.region_id = :region_id"
        base_sql_fallback += " ORDER BY g.name"
        rows = db.execute(sa_text(base_sql_fallback), params).mappings().all()

    # ── Batch-load all lookup data to avoid N+1 per-group queries ──────────────
    region_ids_set = {int(r["region_id"]) for r in rows if r.get("region_id")}
    state_ids_set  = {int(r["state_id"])  for r in rows if r.get("state_id")}
    role_ids_set   = {int(r["role_id"])   for r in rows if r.get("role_id")}
    group_ids_list = [int(r["id"]) for r in rows]

    region_lkp = {}
    if region_ids_set:
        region_rows = db.execute(sa_text("""
            SELECT id, name
            FROM location_masters
            WHERE item_type = 'region'
            AND is_active = 1
            AND id IN :ids
        """), {"ids": tuple(region_ids_set)}).mappings().all()

        region_lkp = {row["id"]: row["name"] for row in region_rows}


    state_lkp = {}
    if state_ids_set:
        state_rows = db.execute(sa_text("""
            SELECT id, name
            FROM location_masters
            WHERE item_type = 'state'
            AND is_active = 1
            AND id IN :ids
        """), {"ids": tuple(state_ids_set)}).mappings().all()

        state_lkp = {row["id"]: row["name"] for row in state_rows}
    role_lkp:   dict = {o.id: o for o in db.query(Role).filter(Role.id.in_(role_ids_set)).all()}       if role_ids_set   else {}

    # Load ALL active users once — replaces per-group full-table scan
    all_active_users = db.query(User).filter(User.is_active == True).all()
    users_by_group: dict = {}
    for _u in all_active_users:
        for _gid in _parse_ids(getattr(_u, "group_id", None)):
            users_by_group.setdefault(_gid, []).append(_u)

    # Load all hierarchy rows for these groups in one query
    all_hierarchy = db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.group_id.in_(group_ids_list),
        UserReportingHierarchy.is_active == True,
    ).all() if group_ids_list else []
    hierarchy_by_group: dict = {}
    for _hr in all_hierarchy:
        hierarchy_by_group.setdefault(int(_hr.group_id), []).append(_hr)
    # ────────────────────────────────────────────────────────────────────────────

    result = []
    for row in rows:
        d = dict(row)

        d["region_name"] = region_lkp.get(int(d.get("region_id"))) if d.get("region_id") else ""

        d["state_name"] = state_lkp.get(int(d.get("state_id"))) if d.get("state_id") else ""

        rl = role_lkp.get(d.get("role_id"))
        d["role"]      = rl.name         if rl else ""
        d["role_name"] = rl.display_name if rl else ""

        group_id_int  = int(d["id"])
        group_members = users_by_group.get(group_id_int, [])
        sales_members = [u for u in group_members if str(u.role or "").lower() == "sales"]

        hierarchy_rows = hierarchy_by_group.get(group_id_int, [])
        lead_user_ids = {
            int(r.reporting_user_id)
            for r in hierarchy_rows
            if r.reporting_user_id and bool(getattr(r, "is_group_lead", False))
        }
        lead_users = [u for u in group_members if int(u.id) in lead_user_ids]

        d["manager_name"] = ", ".join(u.full_name for u in lead_users if u.full_name)
        d["member_count"] = len(group_members)
        d["sales_count"]  = len(sales_members)

        d["members"] = []
        for u in group_members:
            user_role = str(u.role or "").lower()
            role_name = (
                "Sales Head"
                if user_role in ("manager", "sales_head")
                else "VP"
                if user_role == "vp"
                else "Sales Executive"
                if user_role == "sales"
                else user_role.title()
            )
            d["members"].append({
                "id": u.id,
                "name": u.full_name,
                "role": u.role,
                "role_name": role_name,
                "email": u.email,
                "is_group_lead": int(u.id) in lead_user_ids,
                "is_sales": user_role == "sales",
            })
        result.append(d)
    return result


@router.post("/groups", status_code=201)
def create_group(data: GroupIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    if cu.role not in ('admin', 'ceo', 'manager'):
        raise HTTPException(403, "Insufficient permissions to manage groups")
    if db.query(Group).filter(Group.name == data.name, Group.is_active == True).first():
        raise HTTPException(400, "Group name already exists")
    if data.manager_id:
        mgr = db.query(User).filter(User.id == data.manager_id).first()
        if not mgr or mgr.role not in ('manager', 'sales_head', 'vp'):
            raise HTTPException(400, "Group manager must be a user with role 'manager', 'sales_head', or 'vp'")
    g = Group(
        name=data.name, role_id=data.role_id,
        region_id=data.region_id, state_id=data.state_id,
        manager_id=data.manager_id, description=data.description,
        icon=data.icon, color=data.color, updated_at=now_ist(),
    )
    db.add(g)
    db.commit()
    db.refresh(g)

    _sync_group_reporting_hierarchy(db, g.id, data.reporting_hierarchy)
    reporting_user_ids = [
        item.reporting_user_id
        for item in data.reporting_hierarchy
        if item.reporting_user_id
    ]
    _append_group_id_to_users(db, g.id, reporting_user_ids)

    db.commit()
    db.refresh(g)
    return g

@router.get("/groups/{group_id}/reporting-hierarchy")
def get_group_reporting_hierarchy(
    group_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    """Return distinct org-tree levels within the group's subtree plus L1 CEOs.

    group_id here is the OrgTreeNode.id of the L2 group lead node.
    Returns levels sorted ascending (L1 = top, L2 = group lead, L3+ = members).
    """
    _ensure_org_tree_schema(db)

    # The group_id passed from approval rules IS the L2 OrgTreeNode.id
    l2_node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == group_id,
        OrgTreeNode.level == 2,
        OrgTreeNode.is_active == True,
    ).first()

    if not l2_node:
        return []

    subtree_ids = _get_subtree_ids(db, l2_node.id)
    nodes = (
        db.query(OrgTreeNode)
        .filter(OrgTreeNode.id.in_(subtree_ids), OrgTreeNode.is_active == True)
        .order_by(OrgTreeNode.level.asc())
        .all()
    )

    from collections import defaultdict
    level_groups: dict[int, list] = defaultdict(list)
    for node in nodes:
        level_groups[node.level].append(node)

    def _node_user_dict(node: OrgTreeNode) -> dict | None:
        u = node.user
        if not u or not getattr(u, "is_active", True):
            return None
        return {
            "id": u.id,
            "full_name": getattr(u, "full_name", None) or getattr(u, "email", "") or "",
            "role": getattr(u, "role", "") or "",
        }

    def _level_label(level: int, is_group_lead: bool) -> str:
        if level == 1:
            return "L1 — CEO"
        if is_group_lead:
            return f"L{level} — Group Lead"
        return f"L{level}"

    result = []

    # Add L1 CEOs FIRST so result is sorted ascending (L1 at top)
    l1_nodes = (
        db.query(OrgTreeNode)
        .filter(OrgTreeNode.level == 1, OrgTreeNode.is_active == True)
        .all()
    )
    l1_users = [d for d in (_node_user_dict(n) for n in l1_nodes) if d]

    # Fallback: if no L1 org-tree nodes, pull users with role 'ceo'
    if not l1_users:
        ceo_users = (
            db.query(User)
            .filter(User.role == "ceo", User.is_active == True)
            .all()
        )
        l1_users = [
            {"id": u.id, "full_name": u.full_name or u.email or "", "role": u.role or ""}
            for u in ceo_users
        ]

    result.append({
        "level": 1,
        "level_label": "L1 — CEO",
        "is_group_lead": False,
        "is_l1": True,
        "user_count": len(l1_users),
        "users": l1_users,
    })

    # Add L2 and below from the subtree, sorted ascending
    for level in sorted(level_groups.keys()):
        nodes_at_level = level_groups[level]
        is_lead = (level == 2)
        users = [d for d in (_node_user_dict(n) for n in nodes_at_level) if d]
        result.append({
            "level": level,
            "level_label": _level_label(level, is_lead),
            "is_group_lead": is_lead,
            "is_l1": False,
            "user_count": len(nodes_at_level),
            "users": users,
        })

    # Sort the full result ascending by level so L1 is first
    result.sort(key=lambda x: x["level"])

    return result

@router.put("/groups/{id}")
def update_group(id: int, data: GroupIn, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    if cu.role not in ('admin', 'ceo', 'manager'):
        raise HTTPException(403, "Insufficient permissions to manage groups")
    g = db.query(Group).filter(Group.id == id).first()
    if not g: raise HTTPException(404, "Group not found")
    if data.manager_id:
        mgr = db.query(User).filter(User.id == data.manager_id).first()
        if not mgr or mgr.role not in ('manager', 'sales_head', 'vp'):
            raise HTTPException(400, "Group manager must be a user with role 'manager', 'sales_head', or 'vp'")
    g.name        = data.name
    g.role_id     = data.role_id
    g.region_id   = data.region_id
    g.state_id    = data.state_id
    g.manager_id  = data.manager_id
    g.description = data.description
    g.icon        = data.icon
    g.color       = data.color
    g.updated_at  = now_ist()
    _sync_group_reporting_hierarchy(db, g.id, data.reporting_hierarchy)
    # _append_group_id_to_users(db, g.id, data.user_ids)
    db.commit(); db.refresh(g)
    return g

@router.delete("/groups/{group_id}/reporting-hierarchy/{user_id}")
def delete_group_reporting_user(
    group_id: int,
    user_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo', 'manager'):
        raise HTTPException(403, "Insufficient permissions to manage groups")

    deleted = db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.group_id == group_id,
        UserReportingHierarchy.reporting_user_id == user_id,
    ).delete(synchronize_session=False)

    _remove_group_id_from_user(db, group_id, user_id)

    db.commit()

    return {
        "message": "Reporting user removed",
        "deleted": deleted,
    }

@router.delete("/groups/{id}")
def delete_group(
    id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    if cu.role not in ('admin', 'ceo', 'manager'):
        raise HTTPException(403, "Insufficient permissions to manage groups")

    g = db.query(Group).filter(Group.id == id).first()
    if not g:
        raise HTTPException(404, "Group not found")

    # 1. Find all reporting users allotted to this group
    hierarchy_rows = db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.group_id == id
    ).all()

    reporting_user_ids = [
        r.reporting_user_id
        for r in hierarchy_rows
        if r.reporting_user_id
    ]

    # 2. Remove this group id from users.group_id
    for user_id in reporting_user_ids:
        _remove_group_id_from_user(db, id, user_id)

    # 3. Hard delete hierarchy rows against this group
    db.query(UserReportingHierarchy).filter(
        UserReportingHierarchy.group_id == id
    ).delete(synchronize_session=False)

    # 4. Soft delete group
    g.is_active = False
    g.updated_at = now_ist()

    db.commit()

    return {
        "message": "Group deleted",
        "removed_hierarchy_users": len(reporting_user_ids),
    }

# ─── Settings ─────────────────────────────────────────────────────────────────

@router.get("/settings")
def get_all_settings(category: Optional[str] = None, db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    q = db.query(Setting)
    if category: q = q.filter(Setting.category == category)
    return {s.key: {"value": s.value, "type": s.type, "label": s.label, "category": s.category} for s in q.all()}


@router.put("/settings/{key}")
def update_setting(key: str, data: SettingUpdate, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    s = db.query(Setting).filter(Setting.key == key).first()
    if not s: raise HTTPException(404, "Setting not found")
    old_value = s.value
    s.value = data.value; s.updated_by = cu.id
    log_module_action(
        db=db, user_id=cu.id, module="settings", action="configuration_change",
        record_id=None, record_name=s.label or key, ip=get_request_ip(request),
        old_data={key: old_value}, new_data={key: data.value},
    )
    db.commit()
    return {"key": key, "value": data.value}


@router.put("/settings")
def update_settings_bulk(updates: dict, request: Request, db: Session = Depends(get_tenant_db), cu: User = Depends(get_current_user)):
    for key, val in updates.items():
        s = db.query(Setting).filter(Setting.key == key).first()
        if s: s.value = str(val); s.updated_by = cu.id
    log_module_action(
        db=db, user_id=cu.id, module="settings", action="bulk_update",
        record_id=None, record_name=f"{len(updates)} setting(s)", ip=get_request_ip(request),
        new_data=updates,
    )
    db.commit()
    return {"message": "Settings updated", "count": len(updates)}


# ─── Alert / Approval Rules ───────────────────────────────────────────────────

@router.get("/alert-rules")
def list_alert_rules(db: Session = Depends(get_tenant_db), _: User = Depends(get_current_user)):
    return db.query(AlertRule).filter(AlertRule.is_active == True).all()



# ─── Pincode Lookup ───────────────────────────────────────────────────────────

@router.get("/pincode/{pincode}")
async def lookup_pincode(pincode: str):
    if not pincode.isdigit() or len(pincode) != 6:
        raise HTTPException(400, "Must be 6 digits")
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"http://www.postalpincode.in/api/pincode/{pincode}")
            r.raise_for_status()
            data = r.json()
            result = data[0] if isinstance(data, list) and data else data
            post_offices = result.get("PostOffice") if isinstance(result, dict) else None
            if isinstance(result, dict) and result.get("Status") == "Success" and post_offices:
                po = post_offices[0]
                return {"found": True, "pincode": pincode, "country": "India",
                        "state": po.get("State", ""), "city": po.get("District", ""),
                        "area": po.get("Name", "")}
    except Exception:
        pass
    return {"found": False, "pincode": pincode, "country": "India", "state": "", "city": "", "area": ""}


# ─── Users for selects ────────────────────────────────────────────────────────

@router.get("/users-for-select")
def users_for_select(
    roles: Optional[str] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    q = db.query(User).filter(User.is_active == True)
    if roles:
        normalized_roles = _expand_role_names([role.strip() for role in roles.split(',') if role.strip()])
        if normalized_roles:
            q = q.filter(User.role.in_(normalized_roles))
    return [
        {
            "id": u.id,
            "label": u.full_name,
            "value": u.id,
            "subtitle": u.role,
            "role": u.role,                # ← NEW: explicit role field for frontend filtering
            "email": u.email,
            "region_id": u.region_id,
            "group_id": u.group_id,
            "reporting_manager_id": u.reporting_manager_id,
            "state_id": u.state_id,
        }
        for u in q.all()
    ]


# ─── Group Fixing Helpers ──────────────────────────────────────────────────────────────────
 
def _ensure_org_tree_schema(db: Session) -> None:
    db.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS org_tree_nodes (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            parent_id INT NULL,
            parent_user_id INT NULL,
            user_id INT NOT NULL,
            group_name VARCHAR(150) NULL,
            group_lead_id INT NULL,
            level INT NOT NULL DEFAULT 1,
            position INT NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_otn_parent FOREIGN KEY (parent_id)
                REFERENCES org_tree_nodes(id) ON DELETE CASCADE,
            CONSTRAINT fk_otn_parent_user FOREIGN KEY (parent_user_id)
                REFERENCES users(id),
            CONSTRAINT fk_otn_user FOREIGN KEY (user_id)
                REFERENCES users(id),
            CONSTRAINT fk_otn_group_lead FOREIGN KEY (group_lead_id)
                REFERENCES users(id)
        )
    """))

    try:
        db.execute(sa_text("ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS parent_user_id INT NULL"))
        db.execute(sa_text("ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS group_name VARCHAR(150) NULL"))
        db.execute(sa_text("ALTER TABLE org_tree_nodes ADD COLUMN IF NOT EXISTS group_lead_id INT NULL"))
        db.commit()
    except Exception:
        db.rollback()
 
 
def _build_tree(flat_nodes: list[dict], user_map: dict) -> list[dict]:
    by_id: dict[int, dict] = {}
    roots: list[dict] = []

    for n in flat_nodes:
        root_user = user_map.get(n.get("user_id"), {})
        lead_user = user_map.get(n.get("group_lead_id"), {})

        node = {
            "id": n["id"],
            "parent_id": n["parent_id"],
            "parent_user_id": n.get("parent_user_id"),
            "user_id": n.get("user_id"),
            "group_name": n.get("group_name"),
            "group_lead_id": n.get("group_lead_id"),
            "group_lead_name": lead_user.get("full_name", ""),
            "group_lead_email": lead_user.get("email", ""),
            "group_lead_role": lead_user.get("role", ""),
            "group_lead_role_display": _role_display(lead_user.get("role", "")),
            "level": n["level"],
            "position": n["position"],
            "user_name": root_user.get("full_name", ""),
            "user_email": root_user.get("email", ""),
            "user_role": root_user.get("role", ""),
            "user_role_display": _role_display(root_user.get("role", "")),
            "children": [],
        }
        by_id[n["id"]] = node

    for node in by_id.values():
        pid = node["parent_id"]
        if pid and pid in by_id:
            by_id[pid]["children"].append(node)
        else:
            roots.append(node)

    def sort_children(node: dict):
        node["children"].sort(key=lambda c: c["position"])
        for child in node["children"]:
            sort_children(child)

    for r in roots:
        sort_children(r)

    roots.sort(key=lambda r: r["position"])
    return roots

 
def _role_display(role: str) -> str:
    mapping = {
        "ceo": "CEO",
        "vp": "VP",
        "admin": "Admin",
        "manager": "Sales Head",
        "sales_head": "Sales Head",
        "sales": "Sales Executive",
    }
    return mapping.get((role or "").lower(), (role or "").title())
 
 
def _get_subtree_ids(db: Session, node_id: int) -> list[int]:
    """Return all descendant node IDs (including the node itself)."""
    ids = [node_id]
    children = db.query(OrgTreeNode).filter(
        OrgTreeNode.parent_id == node_id,
        OrgTreeNode.is_active == True,
    ).all()
    for child in children:
        ids.extend(_get_subtree_ids(db, child.id))
    return ids
 
# ───Group Fixing Routes ───────────────────────────────────────────────────────────────────
 
# Mount on your existing masters router or a new one:
# router = APIRouter()
 
@router.get("/org-tree")
def get_org_tree(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    """Return the full organisational tree as nested JSON."""
    _ensure_org_tree_schema(db)
 
    nodes = db.query(OrgTreeNode).filter(OrgTreeNode.is_active == True).all()
    flat = [
        {
            "id": n.id,
            "parent_id": n.parent_id,
            "parent_user_id": getattr(n, "parent_user_id", None),
            "user_id": n.user_id,
            "group_name": getattr(n, "group_name", None),
            "group_lead_id": getattr(n, "group_lead_id", None),
            "level": n.level,
            "position": n.position,
        }
        for n in nodes
    ]

    user_ids = list({
        uid
        for n in flat
        for uid in (n.get("user_id"), n.get("group_lead_id"))
        if uid
    })
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    user_map = {
        u.id: {"full_name": u.full_name, "email": u.email, "role": u.role}
        for u in users
    }

    tree = _build_tree(flat, user_map)

    # Keep auto-seed CEO as root:
    if not tree:
        ceo = db.query(User).filter(User.is_active == True, User.role == "ceo").first()
        if ceo:
            root = OrgTreeNode(
                parent_id=None,
                user_id=ceo.id,
                group_name=None,
                group_lead_id=None,
                level=1,
                position=0,
            )
            db.add(root)
            db.commit()
            db.refresh(root)
            tree = _build_tree(
                [{
                    "id": root.id,
                    "parent_id": None,
                    "user_id": ceo.id,
                    "group_name": None,
                    "group_lead_id": None,
                    "level": 1,
                    "position": 0,
                }],
                {ceo.id: {"full_name": ceo.full_name, "email": ceo.email, "role": ceo.role}},
            )

    return tree

 
def _org_group_name_taken(db: Session, name: str, exclude_id: Optional[int] = None) -> bool:
    """True when another active L2 group already uses ``name`` (case / extra-space insensitive)."""
    key = " ".join(name.split()).casefold()
    q = db.query(OrgTreeNode).filter(OrgTreeNode.is_active == True, OrgTreeNode.level == 2, OrgTreeNode.group_name.isnot(None))
    if exclude_id is not None:
        q = q.filter(OrgTreeNode.id != exclude_id)
    return any(" ".join((n.group_name or "").split()).casefold() == key for n in q.all())


@router.post("/org-tree", status_code=201)
def add_org_tree_node(
    data: OrgTreeNodeIn,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _ensure_org_tree_schema(db)

    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage the org tree")

    user = db.query(User).filter(
        User.id == data.user_id,
        User.is_active == True,
    ).first()

    if not user:
        raise field_error("user_id", "User not found or inactive.", 400)

    duplicate = db.query(OrgTreeNode).filter(
        OrgTreeNode.user_id == data.user_id,
        OrgTreeNode.is_active == True,
    ).first()

    if duplicate:
        raise field_error("user_id", f"{user.full_name} is already placed in the tree.", 409)

    # L2 group lead creation:
    # parent_id, parent_user_id are NOT required
    if not data.parent_id:
        group_name = (data.group_name or "").strip()
        group_lead_id = data.group_lead_id or data.user_id

        if not group_name:
            raise field_error("group_name", "Group name is required.", 422)

        if _org_group_name_taken(db, group_name):
            raise field_error("group_name", "A group with this name already exists.", 409)

        if int(group_lead_id) != int(data.user_id):
            raise HTTPException(400, "Group lead and selected user must be the same")

        parent_id = None
        parent_user_id = None
        node_user_id = data.user_id
        level = 2

    # L3 and below:
    # parent_id and parent_user_id are mandatory
    else:
        parent = db.query(OrgTreeNode).filter(
            OrgTreeNode.id == data.parent_id,
            OrgTreeNode.is_active == True,
        ).first()

        if not parent:
            raise HTTPException(400, "Parent node not found")

        if not data.parent_user_id:
            raise HTTPException(400, "parent_user_id is required for L3 and below")

        if int(data.parent_user_id) != int(parent.user_id):
            raise HTTPException(400, "Invalid parent_user_id")

        parent_id = parent.id
        parent_user_id = parent.user_id
        node_user_id = data.user_id
        level = parent.level + 1
        group_name = parent.group_name
        group_lead_id = parent.group_lead_id

    if parent_id is None:
        max_pos = db.query(func.max(OrgTreeNode.position)).filter(
            OrgTreeNode.parent_id.is_(None),
            OrgTreeNode.is_active == True,
        ).scalar() or 0
    else:
        max_pos = db.query(func.max(OrgTreeNode.position)).filter(
            OrgTreeNode.parent_id == parent_id,
            OrgTreeNode.is_active == True,
        ).scalar() or 0

    node = OrgTreeNode(
        parent_id=parent_id,
        parent_user_id=parent_user_id,
        user_id=node_user_id,
        group_name=group_name,
        group_lead_id=group_lead_id,
        level=level,
        position=data.position if data.position else max_pos + 1,
    )

    db.add(node)
    db.commit()
    db.refresh(node)

    return {
        "id": node.id,
        "parent_id": node.parent_id,
        "parent_user_id": getattr(node, "parent_user_id", None),
        "user_id": node.user_id,
        "group_name": node.group_name,
        "group_lead_id": node.group_lead_id,
        "level": node.level,
        "position": node.position,
    }    

@router.get("/org-tree/available-users")
def org_tree_available_users(
    parent_id: Optional[int] = None,
    include_admin: bool = False,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_org_tree_schema(db)

    placed_user_ids = {
        row.user_id
        for row in db.query(OrgTreeNode.user_id).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.user_id.isnot(None),
        ).all()
    }

    query = db.query(User).filter(User.is_active == True)

    if not include_admin:
        query = query.filter(User.role != "admin")

    users = query.order_by(User.full_name).all()

    group_head_user_ids = {
        row.user_id
        for row in db.query(OrgTreeNode.user_id).filter(
            OrgTreeNode.is_active == True,
            OrgTreeNode.level == 2,
            OrgTreeNode.user_id.isnot(None),
        ).all()
    }

    return [
        {
            "id": u.id,
            "value": u.id,
            "label": u.full_name,
            "role": u.role,
            "role_display": _role_display(u.role),
            "email": u.email,
            "already_placed": u.id in placed_user_ids,
            "already_group_head": u.id in group_head_user_ids,
        }
        for u in users
    ]
    
@router.put("/org-tree/{node_id}")
def update_org_tree_node(
    node_id: int,
    data: OrgTreeNodeUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Move a node to a new parent or swap the user."""
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage the org tree")
 
    node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == node_id,
        OrgTreeNode.is_active == True,
    ).first()
    if not node:
        raise HTTPException(404, "Node not found")
 
    if data.user_id is not None:
        dup = db.query(OrgTreeNode).filter(
            OrgTreeNode.user_id == data.user_id,
            OrgTreeNode.is_active == True,
            OrgTreeNode.id != node_id,
        ).first()
        if dup:
            raise HTTPException(400, "That user is already in the tree")
        node.user_id = data.user_id
 
    if data.parent_id is not None:
        # Prevent circular: new parent can't be a descendant of this node
        subtree = _get_subtree_ids(db, node_id)
        if data.parent_id in subtree:
            raise HTTPException(400, "Cannot move a node under its own subtree")
        parent = db.query(OrgTreeNode).filter(
            OrgTreeNode.id == data.parent_id,
            OrgTreeNode.is_active == True,
        ).first()
        if not parent:
            raise HTTPException(400, "New parent not found")
        node.parent_id = data.parent_id
        node.level = parent.level + 1
        # Recursively update levels of descendants
        _update_subtree_levels(db, node.id, node.level)
 
    if data.position is not None:
        node.position = data.position
 
    db.commit()
    db.refresh(node)
    return {"message": "Updated", "id": node.id, "level": node.level}
 
 
def _update_subtree_levels(db: Session, parent_id: int, parent_level: int):
    children = db.query(OrgTreeNode).filter(
        OrgTreeNode.parent_id == parent_id,
        OrgTreeNode.is_active == True,
    ).all()
    for child in children:
        child.level = parent_level + 1
        _update_subtree_levels(db, child.id, child.level)
 
 
@router.delete("/org-tree/{node_id}")
def delete_org_tree_node(
    node_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    """Remove a node and its entire subtree."""
    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage the org tree")
 
    node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == node_id,
        OrgTreeNode.is_active == True,
    ).first()
    if not node:
        raise HTTPException(404, "Node not found")
 
    if node.level == 1:
        raise HTTPException(400, "Cannot remove the CEO / root node")
 
    subtree_ids = _get_subtree_ids(db, node_id)
    removed = db.query(OrgTreeNode).filter(
        OrgTreeNode.id.in_(subtree_ids),
    ).update({"is_active": False}, synchronize_session=False)
 
    db.commit()
    return {"message": "Removed", "nodes_removed": removed}

@router.put("/org-tree/groups/{group_id}")
def update_org_tree_group(
    group_id: int,
    data: OrgTreeGroupUpdate,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _ensure_org_tree_schema(db)

    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage groups")

    group_node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == group_id,
        OrgTreeNode.level == 2,
        OrgTreeNode.is_active == True,
    ).first()

    if not group_node:
        raise HTTPException(404, "Group not found")

    group_name = (data.group_name or "").strip()
    if not group_name:
        raise field_error("group_name", "Group name is required.", 422)

    if _org_group_name_taken(db, group_name, exclude_id=group_id):
        raise field_error("group_name", "A group with this name already exists.", 409)

    new_lead = db.query(User).filter(
        User.id == data.group_lead_id,
        User.is_active == True,
    ).first()

    if not new_lead:
        raise field_error("group_lead_id", "Group head user not found or inactive.", 400)

    # Prevent assigning a user already placed in another active node
    existing_node = db.query(OrgTreeNode).filter(
        OrgTreeNode.user_id == data.group_lead_id,
        OrgTreeNode.is_active == True,
        OrgTreeNode.id != group_id,
    ).first()

    if existing_node:
        raise field_error("group_lead_id", "Selected group head is already placed in another group.", 409)

    old_group_name = group_node.group_name
    old_group_lead_id = group_node.group_lead_id

    # Update all active nodes that belong to this group
    group_rows = db.query(OrgTreeNode).filter(
        OrgTreeNode.is_active == True,
        OrgTreeNode.group_name == old_group_name,
        OrgTreeNode.group_lead_id == old_group_lead_id,
    ).all()

    for row in group_rows:
        row.group_name = group_name
        row.group_lead_id = data.group_lead_id

    # L2 group head node itself should represent the new group head
    group_node.user_id = data.group_lead_id
    group_node.parent_user_id = None
    group_node.group_name = group_name
    group_node.group_lead_id = data.group_lead_id

    db.commit()
    db.refresh(group_node)

    return {"message": "Group updated"}

@router.delete("/org-tree/groups/{group_id}")
def delete_org_tree_group(
    group_id: int,
    db: Session = Depends(get_tenant_db),
    cu: User = Depends(get_current_user),
):
    _ensure_org_tree_schema(db)

    if cu.role not in ("admin", "ceo"):
        raise HTTPException(403, "Only Admin or CEO can manage groups")

    group_node = db.query(OrgTreeNode).filter(
        OrgTreeNode.id == group_id,
        OrgTreeNode.level == 2,
        OrgTreeNode.is_active == True,
    ).first()

    if not group_node:
        raise HTTPException(404, "Group not found")

    old_group_name = group_node.group_name
    old_group_lead_id = group_node.group_lead_id

    rows = db.query(OrgTreeNode).filter(
        OrgTreeNode.is_active == True,
        OrgTreeNode.group_name == old_group_name,
        OrgTreeNode.group_lead_id == old_group_lead_id,
    ).all()

    for row in rows:
        row.is_active = False

    db.commit()

    return {"message": "Group deleted"}


# ─── Business Verticals & Business Units ─────────────────────────────────────
# Single-table storage with clearer business-specific columns:
#   business_category_units
#     parent_category_id = NULL        -> category row
#     parent_category_id = category id -> unit row
#     item_type = 'category' | 'unit'  -> kept for simple filtering/validation
#     business_vertical                -> vertical name only
#     business_unit                    -> unit name only
# The frontend endpoints are kept the same for compatibility.

def _ensure_business_unit_schema(db: Session) -> None:
    db.execute(sa_text("""
        CREATE TABLE IF NOT EXISTS business_category_units (
            id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
            parent_category_id INT          NULL,
            item_type          VARCHAR(20)  NOT NULL,
            business_vertical  VARCHAR(100) NULL,
            business_unit      VARCHAR(100) NULL,
            display_order      INT          NOT NULL DEFAULT 0,
            is_active          TINYINT(1)   NOT NULL DEFAULT 1,
            created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at         DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_bcu_parent_category_id (parent_category_id),
            INDEX ix_bcu_type_active (item_type, is_active),
            INDEX ix_bcu_display_order (item_type, parent_category_id, display_order),
            CONSTRAINT fk_bcu_parent_category FOREIGN KEY (parent_category_id)
                REFERENCES business_category_units(id) ON DELETE CASCADE
        )
    """))
    db.commit()

    # Support tenants that already got the earlier single-table version.
    # MySQL 8 supports ADD COLUMN IF NOT EXISTS. If an older DB rejects it,
    # rollback keeps the request alive and the CREATE TABLE path still works for new tenants.
    try:
        db.execute(sa_text("ALTER TABLE business_category_units ADD COLUMN IF NOT EXISTS parent_category_id INT NULL"))
        db.execute(sa_text("ALTER TABLE business_category_units ADD COLUMN IF NOT EXISTS business_vertical VARCHAR(100) NULL"))
        db.execute(sa_text("ALTER TABLE business_category_units ADD COLUMN IF NOT EXISTS business_unit VARCHAR(100) NULL"))
        db.execute(sa_text("ALTER TABLE business_category_units ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'category'"))
        db.execute(sa_text("ALTER TABLE business_category_units ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0"))
        db.commit()
    except Exception:
        db.rollback()

    # Older single-table deployments may still have a legacy `name` column that is
    # NOT NULL with no default. Current inserts only set business_vertical/business_unit,
    # which trips MySQL error 1364 ("Field 'name' doesn't have a default value") under
    # strict mode. Giving it a default is enough to satisfy that constraint.
    try:
        db.execute(sa_text("ALTER TABLE business_category_units ALTER COLUMN name SET DEFAULT ''"))
        db.commit()
    except Exception:
        db.rollback()

    # Copy values from old column names if they exist in older single-table deployments.
    # This is intentionally best-effort so fresh DBs and migrated DBs both work.
    try:
        db.execute(sa_text("""
            UPDATE business_category_units
            SET parent_category_id = parent_id
            WHERE parent_category_id IS NULL
              AND parent_id IS NOT NULL
        """))
        db.execute(sa_text("""
            UPDATE business_category_units
            SET business_vertical = name
            WHERE item_type = 'category'
              AND business_vertical IS NULL
              AND name IS NOT NULL
        """))
        db.execute(sa_text("""
            UPDATE business_category_units
            SET business_unit = name
            WHERE item_type = 'unit'
              AND business_unit IS NULL
              AND name IS NOT NULL
        """))
        db.commit()
    except Exception:
        db.rollback()

    # One-time migration from the older two-table structure if those tables exist.
    try:
        db.execute(sa_text("""
            INSERT INTO business_category_units
                (id, parent_category_id, item_type, business_vertical, business_unit, is_active, created_at, updated_at)
            SELECT bc.id, NULL, 'category', bc.name, NULL, bc.is_active, bc.created_at, bc.updated_at
            FROM business_categories bc
            WHERE NOT EXISTS (
                SELECT 1 FROM business_category_units bcu
                WHERE bcu.item_type = 'category'
                  AND bcu.id = bc.id
            )
        """))
        db.execute(sa_text("""
            INSERT INTO business_category_units
                (parent_category_id, item_type, business_vertical, business_unit, is_active, created_at, updated_at)
            SELECT bu.category_id, 'unit', NULL, bu.name, bu.is_active, bu.created_at, bu.updated_at
            FROM business_units bu
            INNER JOIN business_category_units bc
                ON bc.id = bu.category_id
               AND bc.item_type = 'category'
            WHERE NOT EXISTS (
                SELECT 1 FROM business_category_units bcu
                WHERE bcu.item_type = 'unit'
                  AND LOWER(bcu.business_unit) = LOWER(bu.name)
            )
        """))
        db.commit()
    except Exception:
        db.rollback()

    try:
        missing_order = db.execute(sa_text("""
            SELECT COUNT(*)
            FROM business_category_units
            WHERE is_active = 1
              AND COALESCE(display_order, 0) <= 0
        """)).scalar() or 0
        if missing_order:
            categories = db.execute(sa_text("""
                SELECT id
                FROM business_category_units
                WHERE item_type = 'category'
                  AND parent_category_id IS NULL
                  AND is_active = 1
                ORDER BY CASE WHEN COALESCE(display_order, 0) <= 0 THEN 1 ELSE 0 END,
                         display_order, business_vertical, id
            """)).mappings().all()
            for pos, row in enumerate(categories, start=1):
                db.execute(sa_text(
                    "UPDATE business_category_units SET display_order = :pos WHERE id = :id"
                ), {"pos": pos, "id": row["id"]})

            parent_ids = [row["id"] for row in categories]
            for parent_id in parent_ids:
                units = db.execute(sa_text("""
                    SELECT id
                    FROM business_category_units
                    WHERE item_type = 'unit'
                      AND parent_category_id = :parent_id
                      AND is_active = 1
                    ORDER BY CASE WHEN COALESCE(display_order, 0) <= 0 THEN 1 ELSE 0 END,
                             display_order, business_unit, id
                """), {"parent_id": parent_id}).mappings().all()
                for pos, row in enumerate(units, start=1):
                    db.execute(sa_text(
                        "UPDATE business_category_units SET display_order = :pos WHERE id = :id"
                    ), {"pos": pos, "id": row["id"]})
            db.commit()
    except Exception:
        db.rollback()


def _next_business_item_order(db: Session, item_type: str, parent_category_id: Optional[int] = None) -> int:
    if item_type == "category":
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM business_category_units
            WHERE item_type = 'category'
              AND parent_category_id IS NULL
              AND is_active = 1
        """)).scalar()
    else:
        value = db.execute(sa_text("""
            SELECT COALESCE(MAX(display_order), 0) + 1
            FROM business_category_units
            WHERE item_type = 'unit'
              AND parent_category_id = :parent_category_id
              AND is_active = 1
        """), {"parent_category_id": parent_category_id}).scalar()
    return int(value or 1)


def _row_to_category(row) -> dict:
    vertical_name = row["business_vertical"]
    return {
        "id": row["id"],
        "name": vertical_name,
        "vertical_name": vertical_name,
        "display_order": row.get("display_order", 0) if hasattr(row, "get") else row["display_order"],
    }


def _row_to_unit(row) -> dict:
    vertical_name = row["vertical_name"] or ""
    return {
        "id": row["id"],
        "name": row["business_unit"],
        "business_unit": row["business_unit"],
        # old field names kept so existing frontend code still works
        "category_id": row["category_id"],
        "category_name": vertical_name,
        # new clearer names
        "vertical_id": row["category_id"],
        "vertical_name": vertical_name,
        "display_order": row.get("display_order", 0) if hasattr(row, "get") else row["display_order"],
    }


def _find_business_item_by_name(
    db: Session,
    item_type: str,
    name: str,
    active_only: bool = False,
    exclude_id: Optional[int] = None,
):
    name_column = "business_vertical" if item_type == "category" else "business_unit"
    sql = f"""
        SELECT id, parent_category_id, item_type, business_vertical, business_unit, is_active
        FROM business_category_units
        WHERE item_type = :item_type
          AND LOWER({name_column}) = LOWER(:name)
    """
    params = {"item_type": item_type, "name": name}
    if active_only:
        sql += " AND is_active = 1"
    if exclude_id is not None:
        sql += " AND id != :exclude_id"
        params["exclude_id"] = exclude_id
    sql += " LIMIT 1"
    return db.execute(sa_text(sql), params).mappings().first()


@router.get("/business-categories")
def list_business_categories(
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    rows = db.execute(sa_text("""
        SELECT id, business_vertical, display_order
        FROM business_category_units
        WHERE item_type = 'category'
          AND parent_category_id IS NULL
          AND business_vertical IS NOT NULL
          AND is_active = 1
        ORDER BY display_order, business_vertical, id
    """)).mappings().all()
    return [_row_to_category(row) for row in rows]


@router.put("/business-categories/order")
def reorder_business_categories(
    data: ReorderIn,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    rows = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE item_type = 'category'
          AND parent_category_id IS NULL
          AND business_vertical IS NOT NULL
          AND is_active = 1
        ORDER BY display_order, business_vertical, id
    """)).mappings().all()
    active_ids = [int(row["id"]) for row in rows]
    seen: set[int] = set()
    ordered_ids = [int(id_) for id_ in data.ids if int(id_) not in seen and not seen.add(int(id_))]
    invalid_ids = [id_ for id_ in ordered_ids if id_ not in active_ids]
    if invalid_ids:
        raise HTTPException(400, "Invalid business vertical in display order")
    final_ids = ordered_ids + [id_ for id_ in active_ids if id_ not in ordered_ids]
    for pos, id_ in enumerate(final_ids, start=1):
        db.execute(sa_text(
            "UPDATE business_category_units SET display_order = :pos WHERE id = :id"
        ), {"pos": pos, "id": id_})
    db.commit()
    rows = db.execute(sa_text("""
        SELECT id, business_vertical, display_order
        FROM business_category_units
        WHERE item_type = 'category'
          AND parent_category_id IS NULL
          AND business_vertical IS NOT NULL
          AND is_active = 1
        ORDER BY display_order, business_vertical, id
    """)).mappings().all()
    return [_row_to_category(row) for row in rows]


@router.post("/business-categories", status_code=201)
def find_or_create_business_category(
    data: BusinessCategoryIn,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    name = (data.name or "").strip()
    if not name:
        raise field_error("name", "Vertical name is required.", 422)

    existing = _find_business_item_by_name(db, "category", name)
    if existing:
        if not existing["is_active"]:
            db.execute(sa_text("""
                UPDATE business_category_units
                SET business_vertical = :name,
                    business_unit = NULL,
                    parent_category_id = NULL,
                    item_type = 'category',
                    is_active = 1,
                    display_order = CASE
                        WHEN COALESCE(display_order, 0) <= 0 THEN :display_order
                        ELSE display_order
                    END
                WHERE id = :id
            """), {"name": name, "id": existing["id"], "display_order": _next_business_item_order(db, "category")})
            db.commit()
        return {"id": existing["id"], "name": name}

    result = db.execute(sa_text("""
        INSERT INTO business_category_units
            (parent_category_id, item_type, business_vertical, business_unit, display_order, is_active)
        VALUES
            (NULL, 'category', :name, NULL, :display_order, 1)
    """), {"name": name, "display_order": _next_business_item_order(db, "category")})
    db.commit()
    return {"id": result.lastrowid, "name": name}


@router.put("/business-categories/{category_id}")
def update_business_category(
    category_id: int,
    data: BusinessCategoryIn,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    category = db.execute(sa_text("""
        SELECT id, business_vertical
        FROM business_category_units
        WHERE id = :category_id
          AND item_type = 'category'
          AND parent_category_id IS NULL
          AND is_active = 1
    """), {"category_id": category_id}).mappings().first()
    if not category:
        raise HTTPException(404, "Business vertical not found")

    name = (data.name or "").strip()
    if not name:
        raise field_error("name", "Vertical name is required.", 422)

    duplicate = _find_business_item_by_name(db, "category", name, exclude_id=category_id)
    if duplicate and duplicate["is_active"]:
        raise field_error("name", "A vertical with this name already exists.", 409)

    if duplicate and not duplicate["is_active"]:
        db.execute(sa_text("""
            UPDATE business_category_units
            SET is_active = 0
            WHERE parent_category_id = :duplicate_id
        """), {"duplicate_id": duplicate["id"]})
        db.execute(sa_text("DELETE FROM business_category_units WHERE id = :duplicate_id"), {"duplicate_id": duplicate["id"]})

    db.execute(sa_text("""
        UPDATE business_category_units
        SET business_vertical = :name,
            business_unit = NULL,
            item_type = 'category',
            parent_category_id = NULL
        WHERE id = :category_id
    """), {"name": name, "category_id": category_id})
    db.commit()
    return {"id": category_id, "name": name}


@router.delete("/business-categories/{category_id}")
def delete_business_category(
    category_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    category = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE id = :category_id
          AND item_type = 'category'
    """), {"category_id": category_id}).mappings().first()
    if not category:
        raise HTTPException(404, "Business vertical not found")

    db.execute(sa_text("""
        UPDATE business_category_units
        SET is_active = 0
        WHERE id = :category_id
           OR parent_category_id = :category_id
    """), {"category_id": category_id})
    db.commit()
    return {"message": "Deleted"}


@router.get("/business-units")
def list_business_units(
    category_id: Optional[int] = None,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    sql = """
        SELECT
            u.id,
            u.business_unit,
            u.parent_category_id AS category_id,
            c.business_vertical AS vertical_name,
            u.display_order
        FROM business_category_units u
        INNER JOIN business_category_units c
            ON c.id = u.parent_category_id
           AND c.item_type = 'category'
           AND c.is_active = 1
        WHERE u.item_type = 'unit'
          AND u.business_unit IS NOT NULL
          AND u.is_active = 1
    """
    params = {}
    if category_id:
        sql += " AND u.parent_category_id = :category_id"
        params["category_id"] = category_id
    sql += " ORDER BY c.display_order, c.business_vertical, u.display_order, u.business_unit, u.id"
    rows = db.execute(sa_text(sql), params).mappings().all()
    return [_row_to_unit(row) for row in rows]


@router.post("/business-units", status_code=201)
def create_business_unit(
    data: BusinessUnitIn,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    category = db.execute(sa_text("""
        SELECT id, business_vertical
        FROM business_category_units
        WHERE id = :category_id
          AND item_type = 'category'
          AND parent_category_id IS NULL
          AND is_active = 1
    """), {"category_id": data.category_id}).mappings().first()
    if not category:
        raise HTTPException(404, "Business vertical not found")

    name = (data.name or "").strip()
    if not name:
        raise field_error("name", "Unit name is required.", 422)

    active_duplicate = db.execute(sa_text("""
        SELECT u.id, u.business_unit, c.business_vertical AS vertical_name
        FROM business_category_units u
        LEFT JOIN business_category_units c ON c.id = u.parent_category_id
        WHERE u.item_type = 'unit'
          AND u.is_active = 1
          AND LOWER(u.business_unit) = LOWER(:name)
        LIMIT 1
    """), {"name": name}).mappings().first()
    if active_duplicate:
        duplicate_vertical_name = active_duplicate["vertical_name"] or "another vertical"
        raise field_error(
            "name",
            f"Business unit '{name}' already exists in vertical '{duplicate_vertical_name}'. A unit can belong to only one vertical.",
            409,
        )

    inactive_duplicate = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE item_type = 'unit'
          AND is_active = 0
          AND LOWER(business_unit) = LOWER(:name)
        LIMIT 1
    """), {"name": name}).mappings().first()
    if inactive_duplicate:
        db.execute(sa_text("""
            UPDATE business_category_units
            SET business_vertical = NULL,
                business_unit = :name,
                parent_category_id = :category_id,
                item_type = 'unit',
                is_active = 1,
                display_order = :display_order
            WHERE id = :id
        """), {
            "name": name,
            "category_id": data.category_id,
            "id": inactive_duplicate["id"],
            "display_order": _next_business_item_order(db, "unit", data.category_id),
        })
        db.commit()
        return {
            "id": inactive_duplicate["id"],
            "name": name,
            "category_id": data.category_id,
            "category_name": category["business_vertical"],
            "vertical_id": data.category_id,
            "vertical_name": category["business_vertical"],
        }

    result = db.execute(sa_text("""
        INSERT INTO business_category_units
            (parent_category_id, item_type, business_vertical, business_unit, display_order, is_active)
        VALUES
            (:category_id, 'unit', NULL, :name, :display_order, 1)
    """), {
        "category_id": data.category_id,
        "name": name,
        "display_order": _next_business_item_order(db, "unit", data.category_id),
    })
    db.commit()
    return {
        "id": result.lastrowid,
        "name": name,
        "category_id": data.category_id,
        "category_name": category["business_vertical"],
            "vertical_id": data.category_id,
            "vertical_name": category["business_vertical"],
    }


@router.put("/business-units/{unit_id}")
def update_business_unit(
    unit_id: int,
    data: BusinessUnitIn,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    unit = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE id = :unit_id
          AND item_type = 'unit'
          AND is_active = 1
    """), {"unit_id": unit_id}).mappings().first()
    if not unit:
        raise HTTPException(404, "Business unit not found")

    category = db.execute(sa_text("""
        SELECT id, business_vertical
        FROM business_category_units
        WHERE id = :category_id
          AND item_type = 'category'
          AND parent_category_id IS NULL
          AND is_active = 1
    """), {"category_id": data.category_id}).mappings().first()
    if not category:
        raise HTTPException(404, "Business vertical not found")

    name = (data.name or "").strip()
    if not name:
        raise field_error("name", "Unit name is required.", 422)

    active_duplicate = db.execute(sa_text("""
        SELECT u.id, u.business_unit, c.business_vertical AS vertical_name
        FROM business_category_units u
        LEFT JOIN business_category_units c ON c.id = u.parent_category_id
        WHERE u.item_type = 'unit'
          AND u.is_active = 1
          AND u.id != :unit_id
          AND LOWER(u.business_unit) = LOWER(:name)
        LIMIT 1
    """), {"unit_id": unit_id, "name": name}).mappings().first()
    if active_duplicate:
        duplicate_vertical_name = active_duplicate["vertical_name"] or "another vertical"
        raise field_error(
            "name",
            f"Business unit '{name}' already exists in vertical '{duplicate_vertical_name}'. A unit can belong to only one vertical.",
            409,
        )

    inactive_duplicate = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE item_type = 'unit'
          AND is_active = 0
          AND id != :unit_id
          AND LOWER(business_unit) = LOWER(:name)
        LIMIT 1
    """), {"unit_id": unit_id, "name": name}).mappings().first()
    if inactive_duplicate:
        db.execute(sa_text("DELETE FROM business_category_units WHERE id = :id"), {"id": inactive_duplicate["id"]})

    db.execute(sa_text("""
        UPDATE business_category_units
        SET business_vertical = NULL,
            business_unit = :name,
            parent_category_id = :category_id,
            item_type = 'unit'
        WHERE id = :unit_id
    """), {"name": name, "category_id": data.category_id, "unit_id": unit_id})
    db.commit()
    return {
        "id": unit_id,
        "name": name,
        "category_id": data.category_id,
        "category_name": category["business_vertical"],
            "vertical_id": data.category_id,
            "vertical_name": category["business_vertical"],
    }


@router.delete("/business-units/{unit_id}")
def delete_business_unit(
    unit_id: int,
    db: Session = Depends(get_tenant_db),
    _: User = Depends(get_current_user),
):
    _ensure_business_unit_schema(db)
    unit = db.execute(sa_text("""
        SELECT id
        FROM business_category_units
        WHERE id = :unit_id
          AND item_type = 'unit'
    """), {"unit_id": unit_id}).mappings().first()
    if not unit:
        raise HTTPException(404, "Business unit not found")
    db.execute(sa_text("""
        UPDATE business_category_units
        SET is_active = 0
        WHERE id = :unit_id
    """), {"unit_id": unit_id})
    db.commit()
    return {"message": "Deleted"}
