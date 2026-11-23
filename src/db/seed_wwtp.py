"""Seed master data WWTP (basins / cameras) — không seed sự kiện giả."""

from __future__ import annotations

import json
import sqlite3


def seed_master_if_empty(conn: sqlite3.Connection) -> int:
    """Seed 1 bể + 1 camera mặc định khi bảng master trống."""
    basin_n = conn.execute("SELECT COUNT(*) AS c FROM basins").fetchone()["c"]
    cam_n = conn.execute("SELECT COUNT(*) AS c FROM cameras").fetchone()["c"]
    if int(basin_n) > 0 and int(cam_n) > 0:
        return 0

    conn.execute(
        """
        INSERT OR IGNORE INTO basins (basin_id, name, stage, note)
        VALUES (?, ?, ?, ?)
        """,
        (
            "basin_bio_01",
            "Bể sinh học 01",
            "bio",
            "Điểm quan sát foam MVP",
        ),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO cameras (
            camera_id, basin_id, name, source_type, config_json, active
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "cam_bio_01",
            "basin_bio_01",
            "Camera 01 – Bể sinh học 01",
            "webcam",
            json.dumps({"device_index": 0}, ensure_ascii=False),
            1,
        ),
    )
    conn.commit()
    return 2


# Tên cũ — giữ alias để import cũ không gãy; hành vi mới = seed master only
def seed_wwtp_events_if_empty(conn: sqlite3.Connection) -> int:
    return seed_master_if_empty(conn)
