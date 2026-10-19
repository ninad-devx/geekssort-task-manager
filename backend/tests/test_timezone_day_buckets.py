"""Day boundaries belong to the app's timezone, not the server's.

The reported symptom: work done late at night showed up under yesterday, and the
"today" figures on the dashboard described a day that had already ended. Both are
the same defect -- every timestamp is stored as naive UTC, and `func.date()`
buckets by the database's day, which on a UTC server is six hours out from
Asia/Dhaka midnight.

These tests pin the conversion itself. The offset lookup in particular has a
failure mode that looks like success: `ZoneInfo.utcoffset(None)` returns `None`,
and `None or timedelta(0)` is a +00:00 modifier, which is *correct* on a UTC
zone and silently wrong everywhere else. The suite runs in UTC, so only a test
that moves the zone can see it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from tests.conftest import CSRF, login

# 18:30 UTC on the 18th is 00:30 on the 19th in Dhaka. It is the only kind of
# row that exposes the difference, so every test below uses it.
UTC_LATE = datetime(2026, 10, 18, 18, 30)
UTC_EARLY = datetime(2026, 10, 18, 9, 0)


@pytest.fixture()
def dhaka(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "APP_TIMEZONE", "Asia/Dhaka")
    return settings


def _bucket(session, naive_utc: datetime) -> str:
    """The calendar day a naive-UTC timestamp is filed under, as a string.

    The expression is evaluated against the literal rather than against
    `task_logs`, so the answer does not depend on what happens to be in the
    table.
    """
    from sqlalchemy import DateTime, literal, select

    from app.aggregate import local_date_expr

    return str(session.execute(select(local_date_expr(literal(naive_utc, DateTime)))).scalar())


def _insert_session(db, user_id, task_id, started: datetime, hours: int):
    from app.models import EntryType, Source, WorkSession, utcnow

    db.add(
        WorkSession(
            task_id=task_id,
            user_id=user_id,
            entry_type=EntryType.work_session.value,
            source=Source.manual.value,
            started_at=started,
            ended_at=started + timedelta(hours=hours),
            duration_seconds=hours * 3600,
            created_at=utcnow(),
        )
    )
    db.commit()


def test_the_zone_offset_lookup_actually_returns_an_offset(dhaka):
    """`ZoneInfo.utcoffset(None)` is None, and zero is a valid-looking answer.

    This is the whole bug in two lines: falling back to timedelta(0) produces a
    +00:00 SQLite modifier, which is right for UTC and wrong for every other
    zone, and nothing else fails.
    """
    assert ZoneInfo("Asia/Dhaka").utcoffset(None) is None
    offset = datetime.now(dhaka.tz).utcoffset()
    assert offset is not None
    assert offset == timedelta(hours=6)


def test_a_timestamp_after_local_midnight_files_under_the_local_day(client, users, dhaka):
    from app.db import SessionLocal

    db = SessionLocal()
    try:
        assert _bucket(db, UTC_EARLY) == "2026-10-18", "morning UTC is still the 18th in Dhaka"
        assert _bucket(db, UTC_LATE) == "2026-10-19", "00:30 local on the 19th is not the 18th"
    finally:
        db.close()


def test_the_daily_strip_uses_the_app_timezone(client, users, dhaka):
    """End to end: a late session lands on the day the person actually worked."""
    from app.db import SessionLocal

    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Late work"}).json()

    db = SessionLocal()
    try:
        _insert_session(db, users["lead"], task["id"], UTC_LATE, 1)
        _insert_session(db, users["lead"], task["id"], UTC_EARLY, 1)
    finally:
        db.close()

    daily = {
        d["day"]: d["seconds"] for d in client.get("/api/dashboard/personal?days=30").json()["daily"]
    }
    assert daily.get("2026-10-19") == 3600
    assert daily.get("2026-10-18") == 3600


def test_today_counts_agree_with_the_local_day(client, users, dhaka):
    """The window and the buckets must agree, or "today" is a day long."""
    from app.db import SessionLocal
    from app.serializers import local_today

    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Late work"}).json()
    db = SessionLocal()
    try:
        # A session on the local day that is currently open, whatever that is.
        _insert_session(
            db, users["lead"], task["id"], datetime.combine(local_today(), datetime.min.time()) + timedelta(hours=9), 1
        )
    finally:
        db.close()

    summary = client.get("/api/time/summary?days=1").json()
    # Both the window start and the buckets follow APP_TIMEZONE. The window
    # start is *reported* in UTC, so Dhaka midnight legitimately reads as
    # 18:00 on the previous UTC day -- compare it as an instant, not as a date.
    start = datetime.fromisoformat(summary["range"]["from"]).replace(tzinfo=timezone.utc)
    expected = datetime.combine(
        local_today(), datetime.min.time(), tzinfo=dhaka.tz
    ).astimezone(timezone.utc)
    assert start == expected
    assert summary["total_seconds"] == 3600