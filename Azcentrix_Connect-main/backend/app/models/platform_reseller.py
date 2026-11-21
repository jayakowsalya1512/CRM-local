from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Numeric, String

from app.database import Base


class PlatformReseller(Base):
    """A reseller / partner account (Command → Resellers & partners)."""
    __tablename__ = "platform_resellers"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False, unique=True)
    region = Column(String(120), nullable=True)
    tier = Column(String(20), nullable=False, default="Bronze")              # Bronze | Silver | Gold | Platinum
    commission_pct = Column(Numeric(5, 2), nullable=False, default=20)
    domain = Column(String(253), nullable=False, unique=True)                # proposed white-label host; DNS / SSL not configured here
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True)


class PlatformResellerTenant(Base):
    """A tenant sold through a reseller. tenant_id is unique: a tenant belongs to at most one reseller."""
    __tablename__ = "platform_reseller_tenants"
    id = Column(Integer, primary_key=True)
    reseller_id = Column(Integer, ForeignKey("platform_resellers.id", ondelete="CASCADE"), nullable=False, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, unique=True)
    assigned_by = Column(String(255), nullable=True)
    assigned_at = Column(DateTime, nullable=False, default=datetime.utcnow)
