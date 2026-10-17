from __future__ import annotations

import argparse
import getpass
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, text

from app.config import settings
from app.db import (
    DATA_DIR,
    IS_POSTGRES,
    IS_SQLITE,
    SessionLocal,
    engine,
    init_db,
    wait_for_database,
)
from app.models import Base, EventType, Folder, Role, User, utcnow
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
    if not IS_SQLITE:
        # `live.driver_connection.backup(...)` below is the sqlite3 online-backup
        # API. There is no psycopg equivalent, so silently "succeeding" here
        # would write an empty file and report it as a backup. Refuse, and name
        # the tool that does exist.
        print(
            "The built-in backup is SQLite-only (it uses sqlite3's online-backup API).\n"
            "Back up PostgreSQL with pg_dump instead, for example:\n"
            f"  docker compose exec -T db pg_dump -U $POSTGRES_USER -d $POSTGRES_DB "
            f"--format=custom --file=- > backup.dump\n"
            "or, for a database on the VPS host itself:\n"
            f"  pg_dump '{settings.safe_database_url}' > backup.sql",
            file=sys.stderr,
        )
        return 1
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


# --- schema and connectivity ------------------------------------------------


def _schema(args) -> int:
    """Create or top up the schema. Idempotent, and safe to run on every deploy.

    The application already does this in its startup hook, so this command
    exists so an operator can run it *separately and deliberately* -- before the
    new code starts serving, and with the outcome visible in the deploy log.

    It only ever adds. It never drops, truncates or alters a table, and it never
    needs an SQLite file to exist in order to build a complete PostgreSQL schema.
    """
    wait_for_database()
    init_db()
    print(f"Database: {settings.safe_database_url} ({settings.database_scheme})")
    from sqlalchemy import inspect

    insp = inspect(engine)
    names = sorted(insp.get_table_names())
    missing = sorted(set(Base.metadata.tables) - set(names))
    print(f"Tables present: {len(names)}")
    if missing:
        print(f"STILL MISSING after init: {missing}", file=sys.stderr)
        return 1
    print("Schema is complete.")
    return 0


def _db_info(args) -> int:
    """Prove which database this deployment is actually talking to.

    Prints the redacted URL, the server version, and a row count per table. If
    you expected PostgreSQL and this says sqlite, stop -- something is feeding
    the wrong DATABASE_URL.
    """
    wait_for_database()
    print(f"DATABASE_URL (redacted): {settings.safe_database_url}")
    print(f"Driver:                {engine.dialect.name} / {engine.dialect.driver}")
    print(f"Server:                {engine.dialect.server_version_info}")
    from sqlalchemy import inspect

    insp = inspect(engine)
    for name in sorted(Base.metadata.tables):
        with engine.connect() as conn:
            count = conn.execute(text(f'SELECT count(*) FROM "{name}"')).scalar()
        print(f"  {name:22} {count:>8} rows")
    del insp
    return 0


# --- SQLite -> PostgreSQL data migration -----------------------------------
#
# This is OPT-IN and OFF by default. A production PostgreSQL deployment almost
# always wants an empty schema plus one bootstrap admin (option A), because the
# development database carries demo rows and old sessions. Importing is a
# separate, deliberate act: `--apply` is required, the target must be empty, and
# the source SQLite file is opened read-only and never written.


def _import_sqlite(args) -> int:
    import sqlite3

    from sqlalchemy import create_engine, inspect

    if not IS_POSTGRES:
        print(
            "Nothing to do: DATABASE_URL is not a PostgreSQL URL, so there is no "
            "target to import into. Point DATABASE_URL at PostgreSQL and re-run.",
            file=sys.stderr,
        )
        return 1

    source_path = Path(args.source).resolve()
    if not source_path.is_file():
        print(f"No such file: {source_path}", file=sys.stderr)
        return 1

    init_db()  # the target must have its schema before rows can go in

    # The source is opened through a raw read-only sqlite3 handle rather than a
    # normal SQLAlchemy URL. Read-only is then enforced by SQLite itself instead
    # of by this command remembering not to write; SQLAlchemy's URL form
    # (`?mode=ro`) only reaches sqlite3 when the database is a `file:` URI, and
    # getting that encoding right differs between Windows and Linux paths.
    def _readonly_connection():
        return sqlite3.connect(
            f"file:{source_path.as_posix()}?mode=ro", uri=True, check_same_thread=False
        )

    src = create_engine("sqlite://", creator=_readonly_connection, future=True)
    src_tables = set(inspect(src).get_table_names()) & set(Base.metadata.tables)
    if not src_tables:
        print(f"{source_path} has none of this application's tables.", file=sys.stderr)
        return 1

    plan = _import_plan(src, src_tables)
    rows_per_table = {}
    with src.connect() as conn:
        for name in plan:
            rows_per_table[name] = conn.execute(text(f'SELECT count(*) FROM "{name}"')).scalar()

    # The target must be empty. Importing on top of live rows is how you end up
    # with two people called "lead@x.com" and a unique-violation halfway through.
    non_empty = []
    with engine.connect() as conn:
        for name in plan:
            n = conn.execute(text(f'SELECT count(*) FROM "{name}"')).scalar()
            if n:
                non_empty.append((name, n))
    if non_empty:
        print(
            "Target database is not empty, refusing to import:\n"
            + "\n".join(f"  {n}: {c} rows" for n, c in non_empty)
            + "\nPoint DATABASE_URL at a fresh database, or use the running "
            "application and recreate the few records you actually want.",
            file=sys.stderr,
        )
        return 1

    total = sum(rows_per_table.values())
    print(f"Source:  {source_path}  (read-only)")
    print(f"Target:  {settings.safe_database_url}")
    print("Order (foreign keys first):")
    for name in plan:
        print(f"  {name:22} {rows_per_table[name]:>6} rows")

    if not args.apply:
        print(f"\nDry run. Nothing was written ({total} rows would be copied).")
        print("Re-run with --apply to perform the import.")
        return 0

    with engine.begin() as dst:
        for name in plan:
            with src.connect() as sc:
                payload = [dict(row._mapping) for row in sc.execute(text(f'SELECT * FROM "{name}"'))]
            payload = _parents_first(Base.metadata.tables[name], payload)
            if payload:
                table = Base.metadata.tables[name]
                # `insert()` without an ORM object, so each row keeps the primary
                # key it had in SQLite -- referenced ids in task_logs and
                # audit_events would otherwise dangle.
                dst.execute(table.insert(), payload)
            print(f"  copied {name:22} {len(payload):>6} rows")

        # Inside the same transaction as the copies: the sequences are part of
        # getting those rows into a usable state, not a separate concern.
        if IS_POSTGRES:
            _resync_sequences(dst)

    print("\nVerifying...")
    ok = True
    with engine.connect() as conn:
        for name in plan:
            got = conn.execute(text(f'SELECT count(*) FROM "{name}"')).scalar()
            want = rows_per_table[name]
            if got != want:
                ok = False
            print(f"  {name:22} {got:>6} / {want:<6} {'ok' if got == want else 'MISMATCH'}")
    if not ok:
        print("\nImport finished with MISMATCHES.", file=sys.stderr)
        return 1
    print("\nImport complete.")
    return 0


def _parents_first(table, rows: list[dict]) -> list[dict]:
    """Order rows so a self-referencing row's parent is written before it.

    `sort_tables` fixes the order *between* tables, but `workspace_folders`
    points at itself through `parent_id`, and PostgreSQL checks that immediately
    on every insert -- a child row written first fails the foreign key. Ordering
    on the referencing column with NULLs first is enough, because a parent is
    always created before its child, so `parent_id < id` holds for every child.
    """
    self_ref = next(
        (
            fk.parent
            for fk in table.foreign_keys
            if fk.parent.table is table and fk.column.table is table
        ),
        None,
    )
    if self_ref is None:
        return rows
    pk = next(iter(table.primary_key.columns))
    return sorted(
        rows,
        key=lambda r: (r[self_ref.name] is not None, r[self_ref.name] or 0, r.get(pk.name) or 0),
    )


def _import_plan(src_engine, src_tables: set[str]) -> list[str]:
    """Tables in foreign-key order, so parents always exist before children.

    Derived by reflecting the *source* and using SQLAlchemy's own dependency
    sort, rather than from a hand-written list that could drift out of step with
    the models. Rows *within* a self-referencing table are ordered separately --
    see `_parents_first`.
    """
    from sqlalchemy import MetaData
    from sqlalchemy.schema import sort_tables

    reflected = MetaData()
    reflected.reflect(bind=src_engine)
    # Sorted input so the printed plan is the same on every run; `src_tables`
    # arrives as a set and `sort_tables` preserves input order among tables that
    # have no dependency between them.
    tables = [reflected.tables[n] for n in sorted(src_tables)]
    return [t.name for t in sort_tables(tables)]


def _resync_sequences(conn) -> None:
    """Advance every identity sequence past the highest id actually stored.

    PostgreSQL hands out ids from a sequence that an explicit-value INSERT does
    not move. Without this, the first user created after an import would be
    offered id=1, collide with the imported row, and fail on the primary key.

    `pg_get_serial_sequence` supplies the column -> sequence mapping, so nothing
    is hard-coded and a newly added table is covered automatically. Tables whose
    primary key is not a single integer column are skipped -- `role_permissions`
    is keyed on `role`, a string, and has no sequence at all.
    """
    from sqlalchemy import Integer

    for table in Base.metadata.sorted_tables:
        pk = list(table.primary_key.columns)
        if len(pk) != 1 or not isinstance(pk[0].type, Integer):
            continue
        column = pk[0].name
        seq = conn.execute(
            text("SELECT pg_get_serial_sequence(:t, :c)"), {"t": table.name, "c": column}
        ).scalar()
        if not seq:
            continue
        conn.execute(
            text(
                "SELECT setval(CAST(:seq AS regclass), COALESCE("
                f'(SELECT max("{column}") FROM "{table.name}"), 1), true)'
            ),
            {"seq": seq},
        )
        print(f"  sequence {seq} resynchronised for {table.name}")


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

    p = sub.add_parser(
        "schema",
        help="Create or top up the schema. Idempotent; adds only, never drops.",
    )
    p.set_defaults(fn=_schema)

    p = sub.add_parser(
        "db-info",
        help="Print the redacted URL, server version and row counts.",
    )
    p.set_defaults(fn=_db_info)

    p = sub.add_parser(
        "import-sqlite",
        help="Copy rows from a SQLite file into this PostgreSQL database. Dry run unless --apply.",
    )
    p.add_argument("--from", dest="source", required=True, help="Path to the SQLite file to read")
    p.add_argument("--apply", action="store_true", help="Actually write. Without this, only report.")
    p.set_defaults(fn=_import_sqlite)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
