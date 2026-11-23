"""Run foam coverage on a short video (sample frames)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from src.utils.config import load_config
from src.vision.foam_coverage import FoamCoverageResult, estimate_foam_coverage, imwrite_unicode


def process_foam_video(
    video_path: Path,
    *,
    every_n_frames: int = 15,
    max_frames: int = 40,
    cfg: Optional[Dict[str, Any]] = None,
    save_overlays: bool = True,
) -> Dict[str, Any]:
    """Sample frames from video and estimate foam coverage on each.

    Returns summary + per-frame metrics. Errors are structured (not silent normal).
    """
    foam_cfg = cfg or load_config("foam.yaml")
    t0 = time.perf_counter()
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return {
            "ok": False,
            "error": f"Cannot open video: {video_path}",
            "frames": [],
            "summary": None,
        }

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    out_dir = Path(
        foam_cfg.get("output", {}).get("overlay_dir", "data/foam/overlays")
    )
    if not out_dir.is_absolute():
        from src.utils.config import get_project_root

        out_dir = get_project_root() / out_dir
    if save_overlays:
        out_dir.mkdir(parents=True, exist_ok=True)

    frames_out: List[Dict[str, Any]] = []
    coverages: List[float] = []
    best_overlay: Optional[np.ndarray] = None
    best_cov = -1.0
    idx = 0
    sampled = 0

    while sampled < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % max(1, every_n_frames) != 0:
            idx += 1
            continue
        result: FoamCoverageResult = estimate_foam_coverage(
            frame, foam_cfg, draw_overlay=True
        )
        sampled += 1
        item = {
            "frame_idx": idx,
            "time_sec": round(idx / fps, 2),
            **result.to_dict(),
        }
        if result.error is None:
            coverages.append(result.coverage_pct)
            if result.coverage_pct >= best_cov and result.overlay_bgr is not None:
                best_cov = result.coverage_pct
                best_overlay = result.overlay_bgr
            if save_overlays and result.overlay_bgr is not None:
                name = f"{video_path.stem}_f{idx:05d}_foam.jpg"
                imwrite_unicode(out_dir / name, result.overlay_bgr)
                item["overlay_path"] = str(out_dir / name)
        frames_out.append(item)
        idx += 1

    cap.release()
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    if not coverages:
        return {
            "ok": False,
            "error": "No successful foam frames (check model weights / video)",
            "frames": frames_out,
            "summary": None,
            "elapsed_ms": round(elapsed_ms, 1),
            "video_fps": fps,
            "video_frames": total,
        }

    avg = sum(coverages) / len(coverages)
    mx = max(coverages)
    thr = foam_cfg.get("thresholds", {})
    warn = float(thr.get("warn_pct", 25.0))
    alarm = float(thr.get("alarm_pct", 40.0))
    if mx >= alarm:
        level = "alarm"
    elif mx >= warn or avg >= warn:
        level = "warn"
    else:
        level = "normal"

    preview_path = None
    if best_overlay is not None and save_overlays:
        preview_path = out_dir / f"{video_path.stem}_preview_foam.jpg"
        imwrite_unicode(preview_path, best_overlay)

    return {
        "ok": True,
        "error": None,
        "frames": frames_out,
        "summary": {
            "avg_coverage_pct": round(avg, 2),
            "max_coverage_pct": round(mx, 2),
            "min_coverage_pct": round(min(coverages), 2),
            "sampled_ok": len(coverages),
            "sampled_total": len(frames_out),
            "level": level,
            "preview_path": str(preview_path) if preview_path else None,
        },
        "elapsed_ms": round(elapsed_ms, 1),
        "video_fps": fps,
        "video_frames": total,
        "every_n_frames": every_n_frames,
    }
