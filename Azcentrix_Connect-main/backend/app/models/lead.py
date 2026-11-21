"""Compatibility shim — imports from canonical all_models.py"""
from app.models.all_models import Lead, LeadProduct, LeadProductOEM, LeadSource, Competitor
__all__ = ["Lead", "LeadProduct", "LeadProductOEM", "LeadSource", "Competitor"]
