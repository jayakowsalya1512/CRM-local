"""Product & Price Books (prototype v17 · Sales → Product & Price Books) – side tables.

The catalogue itself stays in the shared ``products_master`` table (Masters, Leads, Bids, Quotes, Capture forms and
reports already read it). product_service adds the catalogue columns it needs (sku, oem_id, unit, std_cost,
availability, list_price, gst_percent, custom_data, audit columns) with additive ALTERs and reads / writes them with
explicit SQL, so the shared ProductMaster ORM model – and every module that loads it – is unchanged.

price_books          – the tenant's price books: name, currency (+ rate to the base currency for foreign books),
                       percentage adjustment on list price, whether it covers every product, status (active /
                       pending approval / rejected) and the adjustment waiting for approval.
price_book_items     – products of a book: membership (books that do not cover every product) and an optional
                       fixed book price override, with an override waiting for approval.
product_price_history – every change of list price, standard cost, book adjustment or override (old → new, who, when).
product_notes        – Notes tab of the product drawer (v17; kept for history).

Prototype v18 adds the company product model and the record-level tables:
product_models         – the company's product model (template, name, grouping label, roles, delivery lifecycle,
                         units, code format, default specification parameters and pricing / locking rules).
product_categories     – configured product categories (internal groupings are hidden from customers).
product_stages         – rows of the category map (process stage / application / segment … per model).
product_statuses       – ordered record statuses; exactly one is the approved (locked) status.
product_fields         – configurable product fields (label, shown, required, guidance) per model.
product_specs          – specification rows of a product (five-column template structure).
product_category_maps  – product → category × stage with role (Primary / Supporting) and remarks.
product_change_log     – append-only change history of products and price books (field, previous → new value,
                         reason, changed by, approver, approval status).
product_change_windows – change windows opened (through Approvals) to edit an approved / locked record.
"""
from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class PriceBook(TenantBase):
    __tablename__ = "price_books"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), nullable=False)
    currency = Column(String(10), nullable=False, default="INR")
    exchange_rate = Column(Numeric(14, 6), nullable=True)          # base-currency units per 1 book-currency unit
    adjustment = Column(Numeric(7, 2), nullable=False, default=0)  # % on list price (−8 = 8 % below list)
    all_products = Column(Boolean, nullable=False, default=True)
    is_default = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    status = Column(String(20), nullable=False, default="active")   # active | pending | rejected
    pending_adjustment = Column(Numeric(7, 2), nullable=True)
    approval_request_id = Column(Integer, nullable=True)
    description = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class PriceBookItem(TenantBase):
    __tablename__ = "price_book_items"
    __table_args__ = (UniqueConstraint("price_book_id", "product_id", name="uq_price_book_items_book_product"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    price_book_id = Column(Integer, ForeignKey("price_books.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = Column(Integer, nullable=False, index=True)        # products_master.id
    price = Column(Numeric(15, 2), nullable=True)                   # fixed book price (book currency); NULL = book rule
    pending_price = Column(Numeric(15, 2), nullable=True)
    approval_request_id = Column(Integer, nullable=True)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ProductPriceHistory(TenantBase):
    __tablename__ = "product_price_history"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, nullable=True, index=True)
    price_book_id = Column(Integer, nullable=True, index=True)
    field = Column(String(30), nullable=False)                      # list_price | std_cost | adjustment | override
    old_value = Column(Numeric(15, 2), nullable=True)
    new_value = Column(Numeric(15, 2), nullable=True)
    note = Column(String(300), nullable=True)
    changed_by = Column(Integer, nullable=True)
    changed_at = Column(DateTime, server_default=func.now())


class ProductNote(TenantBase):
    __tablename__ = "product_notes"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, nullable=False, index=True)
    body = Column(Text, nullable=False)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ProductModel(TenantBase):
    __tablename__ = "product_models"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    company_key = Column(String(64), nullable=False, default="default", unique=True)
    template = Column(String(20), nullable=False, default="mfg")
    name = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    grouping = Column(String(60), nullable=False, default="Application")   # label of the category-map rows
    roles = Column(JSON, nullable=False)              # mapping roles, e.g. ["Primary", "Supporting"]
    lifecycle = Column(JSON, nullable=False)          # delivery lifecycle steps
    units = Column(JSON, nullable=False)
    code_format = Column(String(40), nullable=False, default="{CAT}-{NNNN}")
    default_specs = Column(JSON, nullable=False)      # [[parameter, value, unit, standard, remarks], …]
    rules = Column(JSON, nullable=False)              # minMargin, discLimit, floorPolicy, quoteApproved, quoteDiscApproval, lockEdits, log, hideInternal
    updated_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ProductCategory(TenantBase):
    __tablename__ = "product_categories"
    __table_args__ = (UniqueConstraint("name", name="uq_product_categories_name"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(150), nullable=False)
    is_internal = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)


class ProductStage(TenantBase):
    __tablename__ = "product_stages"
    __table_args__ = (UniqueConstraint("name", name="uq_product_stages_name"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(150), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)


class ProductStatus(TenantBase):
    __tablename__ = "product_statuses"
    __table_args__ = (UniqueConstraint("name", name="uq_product_statuses_name"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(60), nullable=False)
    color = Column(String(10), nullable=False, default="inf")      # pill tone: mu | wa | ok | inf | ba
    is_lock = Column(Boolean, nullable=False, default=False)       # the approved / released (locked) status
    sort_order = Column(Integer, nullable=False, default=0)


class ProductField(TenantBase):
    __tablename__ = "product_fields"
    __table_args__ = (UniqueConstraint("field_key", name="uq_product_fields_key"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    field_key = Column(String(60), nullable=False)
    label = Column(String(150), nullable=False)
    field_type = Column(String(20), nullable=False, default="text")  # text | ta | num | cur | date | sel | cat | unit | code | status | oem
    options = Column(JSON, nullable=True)
    source = Column(String(10), nullable=False, default="custom")   # core | com | x (model) | custom
    is_on = Column(Boolean, nullable=False, default=True)
    is_required = Column(Boolean, nullable=False, default=False)
    help = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)


class ProductSpec(TenantBase):
    __tablename__ = "product_specs"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products_master.id", ondelete="CASCADE"), nullable=False, index=True)
    parameter = Column(String(200), nullable=False)
    value = Column(String(300), nullable=True)
    unit = Column(String(60), nullable=True)
    standard = Column(String(300), nullable=True)
    remarks = Column(String(500), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ProductCategoryMap(TenantBase):
    __tablename__ = "product_category_maps"
    __table_args__ = (UniqueConstraint("product_id", "category_id", "stage_id", name="uq_product_category_maps"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products_master.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("product_categories.id"), nullable=False, index=True)
    stage_id = Column(Integer, ForeignKey("product_stages.id"), nullable=False, index=True)
    role = Column(String(40), nullable=False, default="Primary")
    remarks = Column(String(500), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)


class ProductChangeLog(TenantBase):
    """Append-only: the application never updates or deletes these rows."""
    __tablename__ = "product_change_log"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, nullable=True, index=True)
    price_book_id = Column(Integer, nullable=True, index=True)
    product_code = Column(String(60), nullable=True)
    product_name = Column(String(300), nullable=True)
    field = Column(String(200), nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    reason = Column(String(500), nullable=True)
    changed_by = Column(Integer, nullable=True, index=True)
    approver_name = Column(String(150), nullable=True)
    approval_status = Column(String(20), nullable=True)            # Approved | Pending | Rejected | Not required
    approval_request_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)


class ProductChangeWindow(TenantBase):
    __tablename__ = "product_change_windows"
    __table_args__ = {"extend_existing": True}

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products_master.id", ondelete="CASCADE"), nullable=False, index=True)
    reason = Column(String(500), nullable=False)
    status = Column(String(20), nullable=False, default="pending")  # pending | open | rejected | closed
    approval_request_id = Column(Integer, nullable=True)
    approver_name = Column(String(150), nullable=True)
    opened_by = Column(Integer, nullable=True)
    opened_at = Column(DateTime, server_default=func.now())
    closed_at = Column(DateTime, nullable=True)


PRODUCT_TABLES = [PriceBook.__table__, PriceBookItem.__table__, ProductPriceHistory.__table__, ProductNote.__table__, ProductModel.__table__,
                  ProductCategory.__table__, ProductStage.__table__, ProductStatus.__table__, ProductField.__table__, ProductSpec.__table__,
                  ProductCategoryMap.__table__, ProductChangeLog.__table__, ProductChangeWindow.__table__]
