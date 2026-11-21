"""Compatibility shim — imports from canonical all_models.py"""
from app.models.all_models import (
    OEM, WorkOrder, WOLineItem, WOMilestone, WOInvoice,
    EMDBG, EMDBGRenewalHistory, KAMActivity, KAMTarget,
    TravelRequest, TADAClaim, TADALineItem,
    Alert, AlertRule, RFPAnalysis, ActivityLog, Notification, Setting
)

# Alias Activity -> ActivityLog for backwards compat  
Activity = ActivityLog

__all__ = [
    "OEM", "WorkOrder", "WOLineItem", "WOMilestone", "WOInvoice",
    "EMDBG", "EMDBGRenewalHistory", "KAMActivity", "KAMTarget",
    "TravelRequest", "TADAClaim", "TADALineItem",
    "Alert", "AlertRule", "RFPAnalysis", "ActivityLog", "Activity", "Notification", "Setting"
]
from app.models.all_models import WOIssue
