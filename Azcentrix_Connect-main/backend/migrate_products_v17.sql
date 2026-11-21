-- Product & Price Books (prototype v17 · Sales → Product & Price Books) – run once per TENANT database.
-- Additive only: nothing is dropped; existing products keep their rows, ids and names. The application applies the
-- same changes at startup (product_service.ensure_schema_all_tenants), so running this script is optional.
--
--   * products_master: catalogue columns (SKU, Principal / OEM, unit, list price, standard cost, GST %, availability,
--     custom fields, audit columns). Existing products get an SKU from the series at first start.
--   * price_books / price_book_items / product_price_history / product_notes
--   * the four prototype price books are created by the application for a tenant that has none (editable).

ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `sku` VARCHAR(40) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `oem_id` INT NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `unit` VARCHAR(30) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `list_price` DECIMAL(15,2) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `std_cost` DECIMAL(15,2) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `gst_percent` DECIMAL(5,2) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `availability` VARCHAR(30) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `custom_data` JSON NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `created_by` INT NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `updated_by` INT NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `updated_at` DATETIME NULL;
CREATE INDEX IF NOT EXISTS ix_products_master_sku ON products_master (sku);

CREATE TABLE IF NOT EXISTS price_books (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    exchange_rate DECIMAL(14,6) NULL,
    adjustment DECIMAL(7,2) NOT NULL DEFAULT 0,
    all_products TINYINT(1) NOT NULL DEFAULT 1,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    pending_adjustment DECIMAL(7,2) NULL,
    approval_request_id INT NULL,
    description TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_book_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    price_book_id INT NOT NULL,
    product_id INT NOT NULL,
    price DECIMAL(15,2) NULL,
    pending_price DECIMAL(15,2) NULL,
    approval_request_id INT NULL,
    updated_by INT NULL,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_price_book_items_book_product (price_book_id, product_id),
    KEY ix_price_book_items_product (product_id),
    CONSTRAINT fk_price_book_items_book FOREIGN KEY (price_book_id) REFERENCES price_books (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_price_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NULL,
    price_book_id INT NULL,
    field VARCHAR(30) NOT NULL,
    old_value DECIMAL(15,2) NULL,
    new_value DECIMAL(15,2) NULL,
    note VARCHAR(300) NULL,
    changed_by INT NULL,
    changed_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_product_price_history_product (product_id),
    KEY ix_product_price_history_book (price_book_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    body TEXT NOT NULL,
    created_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_product_notes_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
