"""Compatibility shim — all classes come from all_models.py"""
from app.database import TenantBase
from app.models.all_models import (
    User, AuditLog, UserSession, UserPushToken, Notification, Approval, ApprovalRule, ActivityLog, LoginLog, LoginOTPChallenge
)

# Aliases for backward compat
LoginAttempt = LoginLog

__all__ = ["TenantBase","User","AuditLog","UserSession","UserPushToken","LoginAttempt","LoginLog","LoginOTPChallenge",
           "Notification","Approval","ApprovalRule","ActivityLog"]
