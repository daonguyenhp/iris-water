"""SQLite connection + schema v2 for Iris WWTP monitoring.

File DB mặc định: data/processed/events/events.db

- events: cảnh báo vận hành (giữ tương thích EventLogger / dashboard)
- observations: mỗi lần đo module (foam / color / debris) — kể cả normal
- basins / cameras: master data nguồn quan sát
- evidence: path bằng chứng (overlay / snapshot / clip)
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

DEFAULT_DB_NAME = "events.db"
SCHEMA_VERSION = 2

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS events (
    event_id      TEXT PRIMARY KEY,
    event_type    TEXT NOT NULL,
    timestamp     TEXT NOT NULL,
    source        TEXT,
    source_name   TEXT,
    message       TEXT NOT NULL DEFAULT '',
    snapshot_path TEXT,
    clip_path     TEXT,
    payload       TEXT NOT NULL DEFAULT '{}',
    acknowledged  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS basins (
    basin_id TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    stage    TEXT,
    note     TEXT
);

CREATE TABLE IF NOT EXISTS cameras (
    camera_id   TEXT PRIMARY KEY,
    basin_id    TEXT REFERENCES basins(basin_id),
    name        TEXT NOT NULL,
    source_type TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS observations (
    obs_id       TEXT PRIMARY KEY,
    camera_id    TEXT,
    module       TEXT NOT NULL,
    ts           TEXT NOT NULL,
    level        TEXT,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    latency_ms   REAL,
    model_tag    TEXT,
    ok           INTEGER NOT NULL DEFAULT 1,
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_module ON observations(module);
CREATE INDEX IF NOT EXISTS idx_obs_camera ON observations(camera_id);

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    obs_id      TEXT,
    event_id    TEXT,
    kind        TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_obs ON evidence(obs_id);
CREATE INDEX IF NOT EXISTS idx_evidence_event ON evidence(event_id);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    row = conn.execute(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO schema_version(version) VALUES (?)",
            (SCHEMA_VERSION,),
        )
    elif int(row["version"]) < SCHEMA_VERSION:
        conn.execute(
            "INSERT OR REPLACE INTO schema_version(version) VALUES (?)",
            (SCHEMA_VERSION,),
        )
    conn.commit()
