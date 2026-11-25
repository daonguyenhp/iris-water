"""Background foam coverage monitor on the live camera frame."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional

import numpy as np

from src.utils.config import get_project_root, load_config
from src.vision.foam_coverage import estimate_foam_coverage, imwrite_unicode


class FoamMonitor:
    """Sample the latest BGR frame on an interval and publish foam metrics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.enabled = True
        self.log_event = True
        self._last: Optional[Dict[str, Any]] = None
        self._session_max = 0.0
        self._last_event_ts = 0.0
        self._last_latency_ms = 0.0
        self._get_frame: Optional[Callable[[], Optional[np.ndarray]]] = None
        # Callback every sample: (payload, frame_bgr, create_event: bool)
        self._persist_cb: Optional[
            Callable[[Dict[str, Any], Optional[np.ndarray], bool], None]
        ] = None

    def configure(
        self,
        *,
        get_frame: Callable[[], Optional[np.ndarray]],
        log_event_cb: Optional[
            Callable[[Dict[str, Any], Optional[np.ndarray], bool], None]
        ] = None,
        persist_cb: Optional[
            Callable[[Dict[str, Any], Optional[np.ndarray], bool], None]
        ] = None,
    ) -> None:
        self._get_frame = get_frame
        # log_event_cb kept for backward compat (= persist_cb)
        self._persist_cb = persist_cb or log_event_cb

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="FoamMonitor")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            self.enabled = bool(enabled)

    def set_log_event(self, log_event: bool) -> None:
        with self._lock:
            self.log_event = bool(log_event)

    def reset_session(self) -> None:
        with self._lock:
            self._session_max = 0.0

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "enabled": self.enabled,
                "log_event": self.log_event,
                "session_max_pct": round(self._session_max, 2),
                "last": dict(self._last) if self._last else None,
            }

    def _loop(self) -> None:
        while not self._stop.is_set():
            cfg = load_config("foam.yaml")
            loop_cfg = cfg.get("camera_loop", {})
            base_interval = float(loop_cfg.get("interval_sec", 0.25))
            base_interval = max(0.15, min(base_interval, 30.0))
            adaptive = bool(loop_cfg.get("adaptive", True))
            duty_factor = float(loop_cfg.get("duty_factor", 3.0))
            cooldown = float(cfg.get("thresholds", {}).get("cooldown_sec", 60))

            with self._lock:
                active = self.enabled
                last_ms = self._last_latency_ms
            if active and self._get_frame is not None:
                frame = self._get_frame()
                if frame is not None:
                    self._analyze(frame, cfg, cooldown)
                    with self._lock:
                        last_ms = self._last_latency_ms

            wait_sec = base_interval
            if adaptive and last_ms > 0:
                wait_sec = max(base_interval, min(5.0, (last_ms / 1000.0) * duty_factor))
            self._stop.wait(wait_sec)

    def _analyze(self, frame: np.ndarray, cfg: Dict[str, Any], cooldown: float) -> None:
        from src.vision.live_mask_tracker import live_water_foam_overlay, resolve_roi_box_from_norm

        fh, fw = frame.shape[:2]
        roi_box = resolve_roi_box_from_norm(live_water_foam_overlay.get_roi_norm(), fw, fh)
        if roi_box is None:
            with self._lock:
                self._last = {
                    "ok": False,
                    "roi_required": True,
                    "coverage_pct": None,
                    "level": "waiting",
                    "error": None,
                    "ts": time.time(),
                }
            return

        result = estimate_foam_coverage(
            frame,
            cfg,
            draw_overlay=True,
            roi_box_override=roi_box,
            foam_only=True,
        )
        overlay_path = None
        if result.overlay_bgr is not None and result.error is None:
            out_dir = get_project_root() / "data" / "foam" / "overlays"
            out_dir.mkdir(parents=True, exist_ok=True)
            # One live file — avoid filling disk with per-sample overlays
            overlay_path = out_dir / "live_latest_foam.jpg"
            imwrite_unicode(overlay_path, result.overlay_bgr)

        payload = {
            **result.to_dict(),
            "ok": result.error is None,
            "overlay_path": str(overlay_path) if overlay_path else None,
            "ts": time.time(),
        }

        create_event = False
        with self._lock:
            self._last = payload
            self._last_latency_ms = float(result.latency_ms)
            if result.error is None and result.coverage_pct > self._session_max:
                self._session_max = float(result.coverage_pct)
            create_event = (
                self.log_event
                and result.error is None
                and result.level in ("warn", "alarm")
                and (time.time() - self._last_event_ts) >= cooldown
            )
            if create_event:
                self._last_event_ts = time.time()

        # Always persist observation; event only when create_event
        if self._persist_cb is not None:
            try:
                self._persist_cb(payload, result.overlay_bgr, create_event)
            except Exception as exc:  # noqa: BLE001
                print(f"[FoamMonitor] persist failed: {exc}")


foam_monitor = FoamMonitor()
