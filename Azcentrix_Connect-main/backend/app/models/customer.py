"""Compatibility shim — imports from canonical all_models.py"""
from app.models.all_models import Customer, CustomerContact
__all__ = ["Customer", "CustomerContact"]
