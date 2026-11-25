"""Live frame-by-frame Foam-only overlay inside a user-drawn water ROI rectangle."""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional, Sequence, Tuple

import cv2
import numpy as np

from src.utils.config import load_config, resolve_model_path
from src.vision.foam_coverage import _draw_overlay, _level_for
from src.vision.water_foam_model import get_water_foam_predictor


def _shift_mask(mask: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Translate a binary uint8 mask by (dx, dy) pixels."""
    if abs(dx) < 0.15 and abs(dy) < 0.15:
        return mask
    h, w = mask.shape[:2]
    mat = np.float32([[1.0, 0.0, dx], [0.0, 1.0, dy]])
    return cv2.warpAffine(
        mask,
        mat,
        (w, h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def resolve_roi_box_from_norm(
    roi_norm: Optional[Tuple[float, float, float, float]],
    frame_w: int,
    frame_h: int,
) -> Optional[Tuple[int, int, int, int]]:
    """Convert normalized (nx1, ny1, nx2, ny2) to clamped pixel (x1, y1, x2, y2)."""
    if roi_norm is None:
        return None
    nx1, ny1, nx2, ny2 = roi_norm
    x1 = max(0, min(frame_w - 2, int(round(nx1 * frame_w))))
    y1 = max(0, min(frame_h - 2, int(round(ny1 * frame_h))))
    x2 = max(x1 + 2, min(frame_w, int(round(nx2 * frame_w))))
    y2 = max(y1 + 2, min(frame_h, int(round(ny2 * frame_h))))
    if x2 <= x1 + 4 or y2 <= y1 + 4:
        return None
    return (x1, y1, x2, y2)


class LiveWaterFoamOverlay:
    """Runs Foam-only segmentation inside a user-drawn water rectangle every N frames,
    and gently shifts the foam mask across the next N intermediate frames.
    When no ROI rectangle is selected, does not run inference and returns raw frames.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._worker_busy = False
        self._frame_idx = 0

        # User-drawn normalized ROI: (nx1, ny1, nx2, ny2) in [0, 1]
        self._roi_norm: Optional[Tuple[float, float, float, float]] = None

        # Latest keyframe foam mask (cropped to ROI) + metrics
        self._foam_mask_roi: Optional[np.ndarray] = None
        self._last_roi_box: Optional[Tuple[int, int, int, int]] = None
        self._coverage_pct: float = 0.0
        self._level: str = "normal"

        # Motion tracking for gentle mask shift between sparse keyframes
        self._prev_small_gray: Optional[np.ndarray] = None
        self._cum_dx: float = 0.0
        self._cum_dy: float = 0.0
        self._vel_dx: float = 0.0
        self._vel_dy: float = 0.0
        self._frames_since_keyframe: int = 0
        self._small_size: Tuple[int, int] = (160, 90)
        self._hann: Optional[np.ndarray] = None

    def set_roi_norm(self, roi: Optional[Sequence[float]]) -> Optional[Tuple[float, float, float, float]]:
        with self._lock:
            if roi is None or len(roi) != 4:
                self._roi_norm = None
            else:
                nx1, ny1, nx2, ny2 = [float(v) for v in roi]
                nx1, nx2 = max(0.0, min(1.0, min(nx1, nx2))), max(0.0, min(1.0, max(nx1, nx2)))
                ny1, ny2 = max(0.0, min(1.0, min(ny1, ny2))), max(0.0, min(1.0, max(ny1, ny2)))
                if (nx2 - nx1) < 0.02 or (ny2 - ny1) < 0.02:
                    self._roi_norm = None
                else:
                    self._roi_norm = (round(nx1, 4), round(ny1, 4), round(nx2, 4), round(ny2, 4))
            self._clear_masks_locked()
            return self._roi_norm

    def get_roi_norm(self) -> Optional[Tuple[float, float, float, float]]:
        with self._lock:
            return self._roi_norm

    def _clear_masks_locked(self) -> None:
        self._frame_idx = 0
        self._foam_mask_roi = None
        self._last_roi_box = None
        self._coverage_pct = 0.0
        self._level = "normal"
        self._prev_small_gray = None
        self._cum_dx = 0.0
        self._cum_dy = 0.0
        self._vel_dx = 0.0
        self._vel_dy = 0.0
        self._frames_since_keyframe = 0

    def reset(self) -> None:
        with self._lock:
            self._clear_masks_locked()

    def _to_small_gray(self, frame_bgr: np.ndarray) -> np.ndarray:
        small = cv2.resize(frame_bgr, self._small_size, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if self._hann is None or self._hann.shape != gray.shape:
            self._hann = cv2.createHanningWindow((gray.shape[1], gray.shape[0]), cv2.CV_32F)
        return gray

    def _estimate_step_shift(
        self,
        prev_gray: Optional[np.ndarray],
        curr_gray: np.ndarray,
        frame_w: int,
        frame_h: int,
    ) -> Tuple[float, float]:
        if prev_gray is None or prev_gray.shape != curr_gray.shape:
            return 0.0, 0.0
        try:
            (sx, sy), response = cv2.phaseCorrelate(prev_gray, curr_gray, self._hann)
            if response < 0.08:
                return 0.0, 0.0
            scale_x = frame_w / float(self._small_size[0])
            scale_y = frame_h / float(self._small_size[1])
            dx = float(np.clip(sx * scale_x, -6.0, 6.0))
            dy = float(np.clip(sy * scale_y, -6.0, 6.0))
            return dx, dy
        except Exception:
            return 0.0, 0.0

    def _run_keyframe_async(
        self,
        frame_bgr: np.ndarray,
        roi_box: Tuple[int, int, int, int],
        cfg: Dict[str, Any],
    ) -> None:
        try:
            model_cfg = cfg.get("model", {})
            thr = cfg.get("thresholds", {})
            bundle_rel = model_cfg.get("bundle_path", "models/water_foam/water_foam_bundle.pth")
            bundle_path = resolve_model_path(bundle_rel)
            if bundle_path is None:
                return

            img_size = int(model_cfg.get("img_size", 256))
            foam_thresh = float(model_cfg.get("foam_thresh", 0.5))
            device = model_cfg.get("device") or "cpu"

            predictor = get_water_foam_predictor(
                bundle_path=bundle_path,
                device=device,
                img_size=img_size,
            )

            x1, y1, x2, y2 = roi_box
            roi_bgr = frame_bgr[y1:y2, x1:x2]
            rh, rw = roi_bgr.shape[:2]
            if rh <= 0 or rw <= 0:
                return

            # User-drawn rectangle IS the water mask; run ONLY foam_model
            roi_water_mask = np.full((rh, rw), 255, dtype=np.uint8)
            foam_mask_roi = predictor.predict_foam_in_mask(
                roi_bgr,
                roi_water_mask,
                foam_thresh=foam_thresh,
                img_size=img_size,
            )

            foam_px = int(cv2.countNonZero(foam_mask_roi))
            water_px = int(rh * rw)
            coverage = (100.0 * foam_px / water_px) if water_px > 0 else 0.0
            level = _level_for(
                coverage,
                float(thr.get("warn_pct", 25.0)),
                float(thr.get("alarm_pct", 40.0)),
            )

            small_gray = self._to_small_gray(roi_bgr)
            with self._lock:
                self._foam_mask_roi = foam_mask_roi
                self._last_roi_box = roi_box
                self._coverage_pct = round(coverage, 2)
                self._level = level
                self._prev_small_gray = small_gray
                self._cum_dx = 0.0
                self._cum_dy = 0.0
                self._vel_dx = 0.0
                self._vel_dy = 0.0
                self._frames_since_keyframe = 0
        except Exception as exc:
            print(f"[LiveWaterFoamOverlay] keyframe error: {exc}")
        finally:
            with self._lock:
                self._worker_busy = False

    def process_frame(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Process one video/camera frame:
        - If no ROI is selected yet, return raw frame without running AI.
        - If ROI is selected, run foam-only model on ROI every `stride_frames` and shift mask in between.
        """
        h, w = frame_bgr.shape[:2]
        with self._lock:
            roi_norm = self._roi_norm
        roi_box = resolve_roi_box_from_norm(roi_norm, w, h)
        if roi_box is None:
            return frame_bgr

        cfg = load_config("foam.yaml")
        live_cfg = cfg.get("live_overlay", {})
        stride = max(1, int(live_cfg.get("stride_frames", 15)))
        max_shift_px = float(live_cfg.get("max_shift_px", 18.0))

        x1, y1, x2, y2 = roi_box
        roi_bgr = frame_bgr[y1:y2, x1:x2]
        rh, rw = roi_bgr.shape[:2]
        curr_gray = self._to_small_gray(roi_bgr)

        should_infer = False
        with self._lock:
            self._frame_idx += 1
            if not self._worker_busy and (
                self._foam_mask_roi is None
                or self._last_roi_box != roi_box
                or (self._frame_idx - 1) % stride == 0
            ):
                self._worker_busy = True
                should_infer = True

            if self._foam_mask_roi is not None and self._last_roi_box == roi_box:
                step_dx, step_dy = self._estimate_step_shift(
                    self._prev_small_gray, curr_gray, rw, rh
                )
                self._vel_dx = 0.6 * self._vel_dx + 0.4 * step_dx
                self._vel_dy = 0.6 * self._vel_dy + 0.4 * step_dy
                self._cum_dx = float(np.clip(self._cum_dx + self._vel_dx, -max_shift_px, max_shift_px))
                self._cum_dy = float(np.clip(self._cum_dy + self._vel_dy, -max_shift_px, max_shift_px))
                self._frames_since_keyframe += 1

                dx, dy = self._cum_dx, self._cum_dy
                f_mask = self._foam_mask_roi
                cov = self._coverage_pct
                lvl = self._level
            else:
                dx, dy = 0.0, 0.0
                f_mask = None
                cov = 0.0
                lvl = "normal"

            self._prev_small_gray = curr_gray

        if should_infer:
            threading.Thread(
                target=self._run_keyframe_async,
                args=(frame_bgr.copy(), roi_box, cfg),
                daemon=True,
                name="LiveWaterFoamWorker",
            ).start()

        if f_mask is None:
            out = frame_bgr.copy()
            cv2.rectangle(out, (x1, y1), (x2, y2), (255, 180, 0), 2)
            return out

        if f_mask.shape[:2] != (rh, rw):
            f_mask = cv2.resize(f_mask, (rw, rh), interpolation=cv2.INTER_NEAREST)

        shifted_foam = _shift_mask(f_mask, dx, dy)
        return _draw_overlay(
            frame_bgr,
            shifted_foam,
            roi_box,
            cov,
            lvl,
            roi_is_full_frame=False,
            water_mask=None,
        )


live_water_foam_overlay = LiveWaterFoamOverlay()
