"""Compatibility shim — imports from canonical all_models.py"""
from app.models.all_models import Tender, TenderProduct, TenderProductOEM, TenderDocument
__all__ = ["Tender", "TenderProduct", "TenderProductOEM", "TenderDocument"]
