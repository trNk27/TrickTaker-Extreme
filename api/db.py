"""Tiny Neon Postgres helper for the multiplayer endpoints.

Serverless rule: every function invocation opens a short-lived connection to
Neon's *pooled* (pgBouncer) endpoint -- set DATABASE_URL to the connection
string that ends in `-pooler...`. Using the direct (unpooled) URL will exhaust
Postgres connections under concurrent invocations.

Usage:
    from db import tx, query
    rows = query("SELECT id FROM games WHERE id = %s", (gid,))     # autocommit read
    with tx() as cur:                                              # transaction
        cur.execute("SELECT ... FOR UPDATE", ...)
        ...
"""
import os
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

_DSN = os.environ.get("DATABASE_URL")


def _connect(autocommit):
    if not _DSN:
        raise RuntimeError("DATABASE_URL is not set (use the Neon *pooled* connection string)")
    return psycopg.connect(_DSN, autocommit=autocommit, row_factory=dict_row)


def query(sql, params=None, fetch="all"):
    """Run a single autocommit statement. fetch in {'all','one','none'}."""
    with _connect(autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            if fetch == "all":
                return cur.fetchall()
            if fetch == "one":
                return cur.fetchone()
            return None


@contextmanager
def tx():
    """Transaction scope: commits on success, rolls back on error.

    Yields a cursor. Use for the SELECT ... FOR UPDATE [SKIP LOCKED] flows in
    matchmaking and move application so concurrent invocations don't race.
    """
    conn = _connect(autocommit=False)
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
