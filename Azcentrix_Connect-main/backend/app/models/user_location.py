from sqlalchemy import Column, Integer, DateTime, Numeric, func

from app.database import TenantBase


class UserLocationLog(TenantBase):
    __tablename__ = "user_location_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    latitude = Column(Numeric(10, 8), nullable=False)
    longitude = Column(Numeric(11, 8), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())