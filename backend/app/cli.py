from __future__ import annotations

import argparse
import getpass
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.config import settings
from app.db import DATA_DIR, SessionLocal, engine, init_db
from app.models import EventType, Folder, Role, User, utcnow
from app.security import generate_temp_password, hash_password, validate_password


def _bootstrap_admin(args) -> int:
    init_db()
    db = SessionLocal()
    try:
        if db.scalar(select(User).limit(1)):
            print("A user already exists. Use `reset-password` instead.", file=sys.stderr)
            return 1
        email = args.email.strip().lower()
        password = args.password or getpass.getpass("Password: ")
        problem = validate_password(password, email)
        if problem:
            print(problem, file=sys.stderr)
            return 1
        now = utcnow()
        user = User(
            email=email,
            full_name=args.name,
            password_hash=hash_password(password),
            role=Role.team_lead.value,
            is_admin=True,
            can_review=True,
            is_active=True,
            must_change_password=False,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.commit()
        print(f"Created admin {email} (id={user.id})")
        return 0
    finally:
        db.close()


def _reset_password(args) -> int:
    init_db()
    db = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.email == args.email.strip().lower()))
        if user is None:
            print("No such user.", file=sys.stderr)
            return 1
        password = args.password or generate_temp_password()
        user.password_hash = hash_password(password)
        user.must_change_password = True
        user.updated_at = utcnow()
        from app.models import SessionRow

        db.query(SessionRow).filter(SessionRow.user_id == user.id).delete()
        db.commit()
        print(f"Password reset for {user.email}. Temporary password: {password}")
        return 0
    finally:
        db.close()


DEFAULT_FOLDERS = [
    "Social Media & Content",
    "Campaigns",
    "Leads & Outreach",
    "Events",
    "Competitor Research",
    "Company Resources",
]


def _seed_defaults(_args) -> int:
    """FR-WS-009: idempotent."""
    init_db()
    db = SessionLocal()
    try:
        admin = db.scalar(select(User).where(User.is_admin.is_(True)).order_by(User.id))
        if admin is None:
            print("No admin exists. Run bootstrap-admin first.", file=sys.stderr)
            return 1
        created = 0
        now = utcnow()
        for name in DEFAULT_FOLDERS:
            exists = db.scalar(select(Folder).where(Folder.name == name, Folder.deleted_at.is_(None)))
            if exists:
                continue
            db.add(
                Folder(
                    name=name,
                    description=None,
                    parent_id=None,
                    visibility="all",
                    depth=1,
                    created_by_id=admin.id,
                    created_at=now,
                    updated_at=now,
                )
            )
            created += 1
        db.commit()
        print(f"Created {created} folder(s); {len(DEFAULT_FOLDERS) - created} already existed.")
        return 0
    finally:
        db.close()


def _backup(args) -> int:
    init_db()
    target_dir = Path(args.dir) if args.dir else DATA_DIR / "backups"
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    source = Path(settings.DATABASE_URL.replace("sqlite:///", ""))
    dest = target_dir / f"marketingos-{stamp}.db"
    live = engine.raw_connection()
    try:
        import sqlite3

        backup_conn = sqlite3.connect(dest)
        live.driver_connection.backup(backup_conn)
        backup_conn.close()
    finally:
        live.close()
    print(f"Backup written to {dest} ({dest.stat().st_size} bytes)")
    if source != dest:
        pass
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("bootstrap-admin")
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--password", default=None)
    p.set_defaults(fn=_bootstrap_admin)

    p = sub.add_parser("reset-password")
    p.add_argument("--email", required=True)
    p.add_argument("--password", default=None)
    p.set_defaults(fn=_reset_password)

    p = sub.add_parser("seed-defaults")
    p.set_defaults(fn=_seed_defaults)

    p = sub.add_parser("backup")
    p.add_argument("--dir", default=None)
    p.set_defaults(fn=_backup)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())