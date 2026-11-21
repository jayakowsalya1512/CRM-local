from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Integer, String

from app.database import Base


class PlatformRegion(Base):
    """A region of the self-hosted infrastructure registry (PLATFORM_SERVERS ``region``) registered in Regions & capacity.

    Live regions come straight from the inventory; a row is kept for them once a failover test has run. A region whose
    servers are all ``planned`` in PLATFORM_SERVERS is registered here with status ``planned``; it becomes live only
    when those servers are set up and in the live inventory – never by changing this row.
    """
    __tablename__ = "platform_regions"
    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False, unique=True)          # the region label used in PLATFORM_SERVERS
    status = Column(String(12), nullable=False, default="planned")   # planned | active
    registered_by = Column(String(200), nullable=True)
    registered_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_failover_at = Column(DateTime, nullable=True)
    last_failover = Column(JSON, nullable=True)                     # {passed, checks, backups, by}
    updated_at = Column(DateTime, nullable=True)
