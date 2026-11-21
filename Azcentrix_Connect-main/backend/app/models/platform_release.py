from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, Integer, String, Text, UniqueConstraint

from app.database import Base


class PlatformRelease(Base):
    """One application release and where its rollout stands (Infrastructure & releases → Release pipeline)."""
    __tablename__ = "platform_releases"
    id = Column(Integer, primary_key=True)
    version = Column(String(40), nullable=False, unique=True)
    # pending | deploying | canary | production | failed | rolled_back | superseded
    status = Column(String(20), nullable=False, default="pending", index=True)
    rollout_percent = Column(Integer, nullable=False, default=0)    # share of traffic the deployment service confirmed
    previous_version = Column(String(40), nullable=True)            # production release when this one started: the rollback target
    operation = Column(String(20), nullable=True)                   # step in progress: deploy | promote | rollback
    notes = Column(Text, nullable=True)
    config = Column(JSON, nullable=True)                            # {"canary": bool, "initial_percent": int}
    verified = Column(Boolean, nullable=False, default=False)       # at 100 %, the API reports this version and is healthy
    verified_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    production_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)                      # failed, rolled back or superseded


class PlatformReleaseStep(Base):
    """One call of the deployment service for a release, with its outcome and output."""
    __tablename__ = "platform_release_steps"
    id = Column(Integer, primary_key=True)
    release_id = Column(Integer, nullable=False, index=True)
    action = Column(String(20), nullable=False)                     # deploy | promote | rollback
    target_version = Column(String(40), nullable=False)
    from_percent = Column(Integer, nullable=True)
    to_percent = Column(Integer, nullable=True)
    status = Column(String(20), nullable=False, default="running")  # running | succeeded | failed
    trigger = Column(String(20), nullable=False, default="manual")  # manual | auto
    actor = Column(String(255), nullable=True)
    exit_code = Column(Integer, nullable=True)
    message = Column(String(500), nullable=True)
    output = Column(Text, nullable=True)                            # tail of the deployment service's output
    worker = Column(String(80), nullable=True)
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)


class PlatformCapacitySample(Base):
    """Hourly storage measurement of one server: fullest disk volume and tenant database size."""
    __tablename__ = "platform_capacity_samples"
    __table_args__ = (UniqueConstraint("hour", "server", name="uq_platform_capacity_sample"),)
    id = Column(Integer, primary_key=True)
    hour = Column(Integer, nullable=False, index=True)              # unix time // 3600
    server = Column(String(120), nullable=False)
    disk_used_gb = Column(Float, nullable=True)
    disk_total_gb = Column(Float, nullable=True)
    db_size_gb = Column(Float, nullable=True)
