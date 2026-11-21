"""Data Hub (prototype v17 R.datahub): import / export / backup / mass-update jobs, migration requests, dedupe decisions."""
from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func

from app.models.all_models import TenantBase


class DataJob(TenantBase):
    __tablename__ = "data_jobs"
    __table_args__ = (Index("ix_data_jobs_kind_created", "kind", "created_at"), Index("ix_data_jobs_status", "status"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    kind = Column(String(20), nullable=False)                    # import | export | backup | mass_update
    object = Column(String(40), nullable=True)                   # leads | customers | opps | bids | products | all | …
    name = Column(String(200), nullable=False)
    status = Column(String(20), nullable=False, default="Queued")   # Queued | Running | Done | Failed | Undone
    rows_total = Column(Integer, nullable=False, default=0)
    rows_done = Column(Integer, nullable=False, default=0)
    rows_error = Column(Integer, nullable=False, default=0)
    file_path = Column(String(500), nullable=True)               # exports / backups: absolute path on disk (never returned)
    file_name = Column(String(200), nullable=True)
    size_kb = Column(Integer, nullable=True)
    payload = Column(JSON, nullable=True)                        # mass update snapshot / import summary
    error = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    finished_at = Column(DateTime, nullable=True)


class MigrationRequest(TenantBase):
    __tablename__ = "data_migration_requests"
    __table_args__ = (Index("ix_data_migration_requests_status", "status", "created_at"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(60), nullable=False)                  # migration_connectors.SOURCES
    config_enc = Column(Text, nullable=True)                     # sealed credentials (AES-GCM), never returned
    account = Column(String(200), nullable=True)                 # what the connector reported on validation
    objects = Column(JSON, nullable=True)                        # [{"name", "count"}] from validation, or the requested list
    status = Column(String(20), nullable=False, default="Requested")   # Requested | Validated | In progress | Done | Failed
    notes = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class DedupeIgnore(TenantBase):
    __tablename__ = "data_dedupe_ignores"
    __table_args__ = (UniqueConstraint("object", "a_id", "b_id", name="uq_data_dedupe_ignore"), {"extend_existing": True})

    id = Column(Integer, primary_key=True, autoincrement=True)
    object = Column(String(20), nullable=False)
    a_id = Column(Integer, nullable=False)
    b_id = Column(Integer, nullable=False)
    decided_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


DATAHUB_TABLES = [DataJob.__table__, MigrationRequest.__table__, DedupeIgnore.__table__]
