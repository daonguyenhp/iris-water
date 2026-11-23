"""Structured event logger — SQLite backend (thay events.jsonl).

API công khai giữ nguyên: log_event / get_recent_events / delete_event / clear_events
để pipeline, API và test cũ không phải đổi hết một lần.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import cv2
import numpy as np

from src.db.connection import DEFAULT_DB_NAME, connect, init_db
from src.db.seed_wwtp import seed_master_if_empty
from src.utils.config import get_project_root, load_config

_SEED_EVENT_IDS = (
    "evt_foam_seed_001",
    "evt_color_seed_001",
    "evt_obj_seed_001",
    "evt_clarity_seed_001",
)

_DB_LOCK = threading.RLock()


@dataclass
class AlertEvent:
    """Represents a validated emergency event."""

    event_id: str
    event_type: str
    person_id: int
    timestamp: str
    risk_score: float
    evidence: Dict[str, Any]
    snapshot_path: Optional[str] = None
    clip_path: Optional[str] = None
    message: str = (
        "Phát hiện bất thường quan sát được trên bể. Vui lòng kiểm tra hiện trường."
    )
    camera_id: Optional[str] = None
    camera_name: Optional[str] = None


def safe_file_tag(value: str) -> str:
    """Camera id reduced to characters that are safe inside a file name / event id."""
    return re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-")[:32]


class EventLogger:
    """Persists alert events to local SQLite (+ snapshot files on disk)."""

    def __init__(
        self,
        log_dir: Optional[Union[str, Path]] = None,
        retention_days: Optional[float] = None,
        save_snapshots: Optional[bool] = None,
    ) -> None:
        if log_dir is None:
            self.log_dir = get_project_root() / "data" / "processed" / "events"
        else:
            self.log_dir = Path(log_dir)

        privacy_cfg: Dict[str, Any] = {}
        try:
            privacy_cfg = (load_config("inference.yaml") or {}).get("privacy", {}) or {}
        except Exception:
            pass
        self.retention_days = float(
            retention_days
            if retention_days is not None
            else privacy_cfg.get("retention_days", 7)
        )
        self.save_snapshots = bool(
            save_snapshots
            if save_snapshots is not None
            else privacy_cfg.get("save_snapshots", True)
        )

        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir = self.log_dir / "snapshots"
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)

        # Giữ attribute cũ để test/migration nhận ra đường dẫn legacy
        self.jsonl_file = self.log_dir / "events.jsonl"
        self.db_path = self.log_dir / DEFAULT_DB_NAME
        self._conn = connect(self.db_path)
        init_db(self._conn)
        self._migrate_jsonl_if_needed()
        with _DB_LOCK:
            seed_master_if_empty(self._conn)
            self._purge_legacy_seed_events()
        self.purge_expired()

    def _purge_legacy_seed_events(self) -> None:
        """Xóa sự kiện seed demo cũ (không còn seed events giả)."""
        self._conn.executemany(
            "DELETE FROM events WHERE event_id = ?",
            [(eid,) for eid in _SEED_EVENT_IDS],
        )
        self._conn.commit()

    def _migrate_jsonl_if_needed(self) -> None:
        """Một lần: nếu còn events.jsonl và DB trống thì import sang SQLite."""
        if not self.jsonl_file.exists():
            return
        with _DB_LOCK:
            count = self._conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]
            if int(count) > 0:
                return
            imported = 0
            with open(self.jsonl_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    self._insert_dict(data)
                    imported += 1
            self._conn.commit()
            if imported:
                bak = self.jsonl_file.with_suffix(".jsonl.bak")
                try:
                    self.jsonl_file.replace(bak)
                except OSError:
                    pass

    def _payload_from_event(self, event: AlertEvent) -> dict[str, Any]:
        return {
            "person_id": event.person_id,
            "risk_score": event.risk_score,
            "evidence": event.evidence,
        }

    def _insert_dict(self, data: Dict[str, Any]) -> None:
        payload = {
            "person_id": data.get("person_id", -1),
            "risk_score": data.get("risk_score", 0.0),
            "evidence": data.get("evidence") or {},
        }
        self._conn.execute(
            """
            INSERT OR REPLACE INTO events (
                event_id, event_type, timestamp, source, source_name,
                message, snapshot_path, clip_path, payload, acknowledged
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("event_id"),
                data.get("event_type", "possible_medical_emergency"),
                data.get("timestamp", ""),
                data.get("camera_id"),
                data.get("camera_name"),
                data.get("message", ""),
                data.get("snapshot_path"),
                data.get("clip_path"),
                json.dumps(payload, ensure_ascii=False),
                int(bool(data.get("acknowledged", False))),
            ),
        )

    def _insert_event(self, event: AlertEvent) -> None:
        self._conn.execute(
            """
            INSERT OR REPLACE INTO events (
                event_id, event_type, timestamp, source, source_name,
                message, snapshot_path, clip_path, payload, acknowledged
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.event_id,
                event.event_type,
                event.timestamp,
                event.camera_id,
                event.camera_name,
                event.message,
                event.snapshot_path,
                event.clip_path,
                json.dumps(self._payload_from_event(event), ensure_ascii=False),
                0,
            ),
        )

    def _row_to_dict(self, row: Any) -> Dict[str, Any]:
        payload = json.loads(row["payload"] or "{}")
        return {
            "event_id": row["event_id"],
            "event_type": row["event_type"],
            "person_id": payload.get("person_id", -1),
            "timestamp": row["timestamp"],
            "risk_score": payload.get("risk_score", 0.0),
            "evidence": payload.get("evidence") or {},
            "snapshot_path": row["snapshot_path"],
            "clip_path": row["clip_path"],
            "message": row["message"] or "",
            "camera_id": row["source"],
            "camera_name": row["source_name"],
            "acknowledged": bool(row["acknowledged"]),
        }

    def purge_expired(self, now: Optional[float] = None) -> int:
        """Delete snapshots/clips/rows older than retention_days."""
        if self.retention_days <= 0:
            return 0
        cutoff = (now if now is not None else time.time()) - self.retention_days * 86400.0
        removed = 0
        for img in self.snapshots_dir.glob("*.jpg"):
            try:
                if img.stat().st_mtime < cutoff:
                    img.unlink()
                    removed += 1
            except OSError:
                pass

        with _DB_LOCK:
            rows = self._conn.execute("SELECT * FROM events").fetchall()
            for row in rows:
                data = self._row_to_dict(row)
                try:
                    ts = str(data["timestamp"]).rstrip("Z")
                    ts_epoch = (
                        datetime.fromisoformat(ts)
                        .replace(tzinfo=timezone.utc)
                        .timestamp()
                    )
                    if ts_epoch < cutoff:
                        self._remove_media(data)
                        self._conn.execute(
                            "DELETE FROM events WHERE event_id = ?",
                            (data["event_id"],),
                        )
                        removed += 1
                except (ValueError, KeyError, TypeError):
                    continue
            self._conn.commit()
        return removed

    def log_observation(
        self,
        *,
        module: str,
        metrics: Dict[str, Any],
        level: Optional[str] = None,
        camera_id: Optional[str] = None,
        camera_name: Optional[str] = None,
        latency_ms: Optional[float] = None,
        model_tag: Optional[str] = None,
        ok: bool = True,
        error: Optional[str] = None,
        overlay_path: Optional[str] = None,
        frame: Optional[np.ndarray] = None,
        create_event: bool = False,
        event_message: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ghi 1 lần đo module (observations). Tuỳ chọn tạo events + evidence."""
        now = datetime.utcnow()
        ts = now.isoformat() + "Z"
        cam_tag = safe_file_tag(camera_id or "cam")
        obs_id = f"obs_{module}_{now.strftime('%Y%m%d_%H%M%S_%f')}_{cam_tag}"

        with _DB_LOCK:
            self._conn.execute(
                """
                INSERT INTO observations (
                    obs_id, camera_id, module, ts, level, metrics_json,
                    latency_ms, model_tag, ok, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    obs_id,
                    camera_id,
                    module,
                    ts,
                    level,
                    json.dumps(metrics or {}, ensure_ascii=False),
                    latency_ms,
                    model_tag,
                    1 if ok else 0,
                    error,
                ),
            )
            evidence_id = None
            if overlay_path:
                evidence_id = f"evd_{uuid.uuid4().hex[:12]}"
                self._conn.execute(
                    """
                    INSERT INTO evidence (evidence_id, obs_id, event_id, kind, path)
                    VALUES (?, ?, NULL, ?, ?)
                    """,
                    (evidence_id, obs_id, "overlay", str(overlay_path)),
                )
            self._conn.commit()

        event: Optional[AlertEvent] = None
        if create_event and ok and level in ("warn", "alarm"):
            cov = metrics.get("coverage_pct") if isinstance(metrics, dict) else None
            risk = min(1.0, float(cov) / 100.0) if cov is not None else 0.0
            evidence = {
                **(metrics or {}),
                "obs_id": obs_id,
                "module": module,
                "overlay_path": overlay_path,
            }
            msg = event_message or (
                f"Foam coverage {cov}% — mức {level}."
                if module == "foam" and cov is not None
                else f"Cảnh báo module {module} — mức {level}."
            )
            event = self.log_event(
                person_id=0,
                risk_score=risk,
                evidence=evidence,
                frame=frame,
                camera_id=camera_id,
                camera_name=camera_name,
                event_type=f"{module}_coverage" if module == "foam" else module,
            )
            # override message for WWTP clarity
            with _DB_LOCK:
                self._conn.execute(
                    "UPDATE events SET message = ? WHERE event_id = ?",
                    (msg, event.event_id),
                )
                if evidence_id:
                    self._conn.execute(
                        "UPDATE evidence SET event_id = ? WHERE evidence_id = ?",
                        (event.event_id, evidence_id),
                    )
                elif overlay_path:
                    self._conn.execute(
                        """
                        INSERT INTO evidence (evidence_id, obs_id, event_id, kind, path)
                        VALUES (?, ?, ?, 'overlay', ?)
                        """,
                        (f"evd_{uuid.uuid4().hex[:12]}", obs_id, event.event_id, str(overlay_path)),
                    )
                self._conn.commit()
            event.message = msg

        return {
            "obs_id": obs_id,
            "event_id": event.event_id if event else None,
            "ts": ts,
            "level": level,
        }

    def log_event(
        self,
        person_id: int,
        risk_score: float,
        evidence: Dict[str, Any],
        frame: Optional[np.ndarray] = None,
        clip_path: Optional[str] = None,
        camera_id: Optional[str] = None,
        camera_name: Optional[str] = None,
        event_type: str = "foam_coverage",
    ) -> AlertEvent:
        """Create, record, and persist a new operational alert event."""
        now = datetime.utcnow()
        timestamp_str = now.isoformat() + "Z"
        cam_tag = f"_{safe_file_tag(camera_id)}" if camera_id else ""
        type_tag = {
            "fall": "_fall",
            "stroke_warning": "_stroke",
            "foam_coverage": "_foam",
        }.get(event_type, "")
        event_id = f"evt_{now.strftime('%Y%m%d_%H%M%S')}{cam_tag}_trk{person_id}{type_tag}"

        snapshot_rel_path = None
        if frame is not None and self.save_snapshots:
            filename = f"{event_id}.jpg"
            save_path = self.snapshots_dir / filename
            cv2.imwrite(str(save_path), frame)
            try:
                snapshot_rel_path = str(save_path.relative_to(get_project_root()))
            except ValueError:
                snapshot_rel_path = str(save_path)

        event = AlertEvent(
            event_id=event_id,
            event_type=event_type,
            person_id=person_id if person_id is not None else 0,
            timestamp=timestamp_str,
            risk_score=round(risk_score, 3),
            evidence=evidence,
            snapshot_path=snapshot_rel_path,
            clip_path=clip_path,
            camera_id=camera_id,
            camera_name=camera_name,
        )

        with _DB_LOCK:
            self._insert_event(event)
            self._conn.commit()

        self.purge_expired()
        return event

    def get_recent_events(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Retrieve the most recent logged events (newest last, như JSONL cũ)."""
        limit = max(1, int(limit))
        with _DB_LOCK:
            rows = self._conn.execute(
                """
                SELECT * FROM events
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        events = [self._row_to_dict(r) for r in rows]
        events.reverse()  # API cũ: oldest → newest trong cửa sổ gần đây
        return events

    def clear_events(self) -> None:
        """Clear all historical logged events, snapshots and clips."""
        with _DB_LOCK:
            for evt in self.get_recent_events(limit=10**9):
                self._remove_media(evt)
            self._conn.execute("DELETE FROM events")
            self._conn.commit()
            if self.jsonl_file.exists():
                try:
                    self.jsonl_file.unlink()
                except OSError:
                    pass

    def delete_event(self, event_id: str) -> bool:
        """Permanently remove a single event by event_id from storage and disk."""
        with _DB_LOCK:
            row = self._conn.execute(
                "SELECT * FROM events WHERE event_id = ?", (event_id,)
            ).fetchone()
            if not row:
                return False
            self._remove_media(self._row_to_dict(row))
            self._conn.execute("DELETE FROM events WHERE event_id = ?", (event_id,))
            self._conn.commit()
            return True

    @staticmethod
    def _remove_media(event: Dict[str, Any]) -> None:
        """Delete the snapshot and clip files that belong to an event record."""
        from src.alerts.clip_recorder import find_clip_file

        files = []
        if event.get("snapshot_path"):
            files.append(get_project_root() / event["snapshot_path"])
        clip = find_clip_file(event.get("clip_path"))
        if clip is not None:
            files.append(clip)
        for path in files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
