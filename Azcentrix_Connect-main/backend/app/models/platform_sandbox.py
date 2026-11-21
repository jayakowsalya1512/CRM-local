from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Index, Integer, PrimaryKeyConstraint, String, Text

from app.database import Base


class PlatformSandbox(Base):
    """A tenant sandbox: its own MariaDB database (``<tenant db>_sb_<8 hex>``) and least-privilege database user.

    status: provisioning | active | refreshing | failed | expired | deleted. Only ``active`` sandboxes are usable;
    a sandbox is never shown as Active before its database has been built (and, for masked copies, verified).
    """
    __tablename__ = "platform_sandboxes"
    __table_args__ = (
        Index("ix_platform_sandboxes_tenant_status", "tenant_id", "status"),      # per-tenant limit, tenant pages
        Index("ix_platform_sandboxes_status_expiry", "status", "expires_at"),     # expiry job, "Expiring ≤ 14 days"
    )
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(120), nullable=False)
    source = Column(String(10), nullable=False)                     # masked | full | template | empty
    db_name = Column(String(64), nullable=False, unique=True)
    db_user = Column(String(32), nullable=True)                     # sandbox-only MariaDB account
    db_password = Column(Text, nullable=True)                       # encrypted (AES-GCM, app secret)
    status = Column(String(12), nullable=False, default="provisioning")
    progress = Column(String(200), nullable=True)                   # current provisioning step
    error = Column(Text, nullable=True)
    size_mb = Column(Float, nullable=True)
    masking_verified_at = Column(DateTime, nullable=True)
    created_by_id = Column(Integer, nullable=True)                  # super_admins.id
    created_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    ready_at = Column(DateTime, nullable=True)
    refreshed_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=False)
    heartbeat_at = Column(DateTime, nullable=True)                  # a provisioning worker is alive
    deleted_at = Column(DateTime, nullable=True)


class PlatformSandboxBaseline(Base):
    """Fingerprint of each promotable configuration row when the sandbox was copied (= production at that moment).

    A sandbox row that differs from its baseline is a change; a production row that differs from it was changed in
    production meanwhile, so promoting over it is refused (no unrelated production record is overwritten).
    """
    __tablename__ = "platform_sandbox_baselines"
    __table_args__ = (PrimaryKeyConstraint("sandbox_id", "table_name", "pk"),)
    sandbox_id = Column(Integer, ForeignKey("platform_sandboxes.id", ondelete="CASCADE"), nullable=False)
    table_name = Column(String(64), nullable=False)
    pk = Column(String(64), nullable=False)
    row_hash = Column(String(32), nullable=False)


class PlatformSandboxChangeSet(Base):
    """Configuration changes made in a sandbox, promoted to the tenant's production database item by item.

    status: ready | awaiting_approval | promoting | promoted | failed | rolled_back | superseded
    """
    __tablename__ = "platform_sandbox_change_sets"
    __table_args__ = (
        Index("ix_platform_sandbox_change_sets_status", "status", "id"),          # pending KPI, list order
        Index("ix_platform_sandbox_change_sets_sandbox", "sandbox_id", "status"),  # the open set of a sandbox
    )
    id = Column(Integer, primary_key=True)                          # shown as CS-<id>
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    sandbox_id = Column(Integer, ForeignKey("platform_sandboxes.id", ondelete="SET NULL"), nullable=True)
    sandbox_name = Column(String(120), nullable=False)
    contents = Column(String(500), nullable=False)
    items = Column(Integer, nullable=False, default=0)
    details = Column(JSON, nullable=False)                          # {table: {pk_column, added, changed, removed, hashes}}
    status = Column(String(20), nullable=False, default="ready")
    approval_request_id = Column(Integer, nullable=True)
    requested_by_id = Column(Integer, nullable=True)
    rollback_path = Column(String(500), nullable=True)              # before-images of every promoted row
    rollback_dump = Column(String(500), nullable=True)              # SQL dump of the affected production tables
    rollback_verified_at = Column(DateTime, nullable=True)
    promoted_by = Column(String(200), nullable=True)
    promoted_at = Column(DateTime, nullable=True)
    rolled_back_at = Column(DateTime, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)
