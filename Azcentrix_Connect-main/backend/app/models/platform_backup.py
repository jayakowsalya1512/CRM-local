from datetime import datetime
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from app.database import Base

class TenantBackup(Base):
    __tablename__ = 'tenant_backups'
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey('tenants.id', ondelete='CASCADE'), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    frequency = Column(String(20), nullable=True)
    status = Column(String(20), nullable=False, default='pending')
    file_name = Column(String(200), nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    next_run_at = Column(DateTime, nullable=True)
