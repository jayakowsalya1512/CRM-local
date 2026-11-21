"""Shared IST helpers for database timestamps."""
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def aware_now_ist() -> datetime:
    return datetime.now(IST)


def now_ist() -> datetime:
    return aware_now_ist().replace(tzinfo=None)


def today_ist() -> date:
    return aware_now_ist().date()


def as_ist_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(IST).replace(tzinfo=None)


def as_utc_from_ist(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=IST).astimezone(timezone.utc)
    return value.astimezone(timezone.utc)
