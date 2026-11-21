from datetime import datetime

from sqlalchemy import JSON, BigInteger, Boolean, Column, DateTime, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformStorageFile(Base):
    """One stored tenant file, indexed from the tenant's upload folders and its database references."""
    __tablename__ = "platform_storage_files"
    __table_args__ = (UniqueConstraint("tenant_slug", "root", "rel_path", name="uq_platform_storage_file"),)
    id = Column(Integer, primary_key=True)
    tenant_slug = Column(String(100), nullable=False, index=True)
    root = Column(String(20), nullable=False)          # media | uploads | settings (see platform_storage.ROOTS)
    rel_path = Column(String(500), nullable=False)     # logical path below the tenant's root folder
    name = Column(String(255), nullable=False)         # original upload name when known
    ext = Column(String(20), nullable=False, default="")
    size_bytes = Column(BigInteger, nullable=False, default=0)       # bytes on disk (after compression)
    original_bytes = Column(BigInteger, nullable=False, default=0)   # bytes as uploaded
    sha256 = Column(String(64), nullable=True, index=True)           # of the uploaded content
    content_mtime = Column(Integer, nullable=True)                   # physical mtime the hash/scan belong to
    uploaded_at = Column(DateTime, nullable=True)
    last_accessed_at = Column(DateTime, nullable=True)               # tracked opens; None = not opened since tracking began
    cold = Column(Boolean, nullable=False, default=False)
    shared_bytes = Column(BigInteger, nullable=False, default=0)     # bytes saved because the content is a hard link of another file
    scan_status = Column(String(20), nullable=False, default="pending")  # pending | clean | infected | error | released
    scan_detail = Column(String(500), nullable=True)
    scanned_at = Column(DateTime, nullable=True)
    scanner = Column(String(60), nullable=True)
    quarantined = Column(Boolean, nullable=False, default=False, index=True)
    quarantine_reason = Column(String(500), nullable=True)
    quarantine_path = Column(String(700), nullable=True)
    quarantine_from = Column(String(700), nullable=True)             # physical path to restore on release
    quarantined_at = Column(DateTime, nullable=True)
    owner = Column(String(255), nullable=True)
    links = Column(Integer, nullable=False, default=0)               # live database rows referring to the file
    deleted_links = Column(Integer, nullable=False, default=0)       # soft-deleted rows referring to it (restorable)
    refs = Column(JSON, nullable=True)                               # up to 5 "table #id" references
    indexed_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class PlatformStoragePolicy(Base):
    """A lifecycle policy switch and the outcome of its last scheduled run. Keys starting with "_" hold job state."""
    __tablename__ = "platform_storage_policies"
    key = Column(String(40), primary_key=True)
    enabled = Column(Boolean, nullable=False, default=False)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    last_run_at = Column(DateTime, nullable=True)
    last_result = Column(Text, nullable=True)
    last_error = Column(Text, nullable=True)
