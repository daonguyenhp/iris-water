"""Offline foam coverage runner (Iris WWTP).

Examples:
  python scripts/run_foam_coverage.py path/to/image.jpg
  python scripts/run_foam_coverage.py path/to/clip.mp4
  python scripts/run_foam_coverage.py path/to/folder --log-event
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.utils.config import get_project_root, load_config
from src.vision.foam_coverage import (
    estimate_foam_coverage,
    imread_unicode,
    imwrite_unicode,
)


VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}


def _iter_images(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    return sorted(p for p in path.rglob("*") if p.suffix.lower() in exts)


def main() -> int:
    parser = argparse.ArgumentParser(description="Iris foam coverage (image or video)")
    parser.add_argument("input", type=str, help="Image, video, or folder")
    parser.add_argument("--no-overlay", action="store_true")
    parser.add_argument(
        "--log-event",
        action="store_true",
        help="Write foam_coverage event to SQLite when level is warn/alarm",
    )
    parser.add_argument("--every-n-frames", type=int, default=15)
    parser.add_argument("--max-frames", type=int, default=40)
    args = parser.parse_args()

    root = get_project_root()
    src = Path(args.input)
    if not src.is_absolute():
        src = (Path.cwd() / src).resolve()
    if not src.exists():
        print(f"[error] not found: {src}")
        return 1

    cfg = load_config("foam.yaml")
    out_dir = root / cfg.get("output", {}).get("overlay_dir", "data/foam/overlays")
    out_dir.mkdir(parents=True, exist_ok=True)

    logger = None
    if args.log_event:
        from src.alerts.event_logger import EventLogger

        logger = EventLogger()

    if src.is_file() and src.suffix.lower() in VIDEO_EXTS:
        from src.vision.foam_video import process_foam_video

        result = process_foam_video(
            src,
            every_n_frames=args.every_n_frames,
            max_frames=args.max_frames,
            cfg=cfg,
            save_overlays=not args.no_overlay,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if logger and result.get("ok") and result.get("summary", {}).get("level") in ("warn", "alarm"):
            summary = result["summary"]
            preview = summary.get("preview_path")
            frame = imread_unicode(Path(preview)) if preview else None
            ev = logger.log_event(
                person_id=0,
                risk_score=min(1.0, float(summary["max_coverage_pct"]) / 100.0),
                evidence={
                    "coverage_pct": summary["max_coverage_pct"],
                    "avg_coverage_pct": summary["avg_coverage_pct"],
                    "level": summary["level"],
                    "source_video": str(src),
                },
                frame=frame,
                camera_id="foam_video",
                camera_name="Foam video",
                event_type="foam_coverage",
            )
            print(f"  event -> {ev.event_id}")
        return 0 if result.get("ok") else 1

    images = _iter_images(src)
    if not images:
        print("[error] no images")
        return 1

    for img_path in images:
        result = estimate_foam_coverage(
            img_path, cfg, draw_overlay=not args.no_overlay
        )
        print(json.dumps({"file": str(img_path), **result.to_dict()}, ensure_ascii=False))

        if result.error:
            continue

        if result.overlay_bgr is not None and cfg.get("output", {}).get("save_overlay", True):
            out_path = out_dir / f"{img_path.stem}_foam.jpg"
            imwrite_unicode(out_path, result.overlay_bgr)
            print(f"  overlay -> {out_path}")

        if logger and result.level in ("warn", "alarm"):
            frame = result.overlay_bgr
            if frame is None:
                frame = imread_unicode(img_path)
            ev = logger.log_event(
                person_id=0,
                risk_score=min(1.0, result.coverage_pct / 100.0),
                evidence={
                    "coverage_pct": result.coverage_pct,
                    "level": result.level,
                    "latency_ms": result.latency_ms,
                    "source_image": str(img_path),
                    "roi_box": list(result.roi_box) if result.roi_box else None,
                },
                frame=frame,
                camera_id="foam_offline",
                camera_name="Foam offline",
                event_type="foam_coverage",
            )
            print(f"  event -> {ev.event_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
