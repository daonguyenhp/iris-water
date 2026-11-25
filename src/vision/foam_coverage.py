"""Foam coverage on WWTP basin surface.

Primary backend: YOLO-seg (fine-tuned). Classical HSV is fallback only.
Input is always a frame (from camera/video) or a still image — same function.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple, Union

import cv2
import numpy as np

from src.utils.config import get_project_root, load_config


def imread_unicode(path: Path) -> Optional[np.ndarray]:
    """cv2.imread fails on non-ASCII Windows paths; use fromfile + imdecode."""
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def imwrite_unicode(path: Path, image: np.ndarray) -> bool:
    """cv2.imwrite fails on non-ASCII Windows paths; use imencode + tofile."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix or ".jpg"
    ok, buf = cv2.imencode(ext, image)
    if not ok:
        return False
    buf.tofile(str(path))
    return True


@dataclass
class FoamCoverageResult:
    coverage_pct: float
    level: str  # normal | warn | alarm | error
    latency_ms: float
    roi_box: Optional[Tuple[int, int, int, int]]
    foam_pixels: int
    roi_pixels: int
    error: Optional[str] = None
    overlay_bgr: Optional[np.ndarray] = None
    water: Optional[Dict[str, Any]] = None
    sludge: Optional[Dict[str, Any]] = None
    debris: Optional[Dict[str, Any]] = None
    scenarios: Optional[list[Dict[str, Any]]] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d.pop("overlay_bgr", None)
        return d


def _load_foam_cfg(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return cfg if cfg is not None else load_config("foam.yaml")


def _resolve_roi(
    frame: np.ndarray,
    box: Optional[Sequence[int]],
) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    h, w = frame.shape[:2]
    if not box:
        return frame, (0, 0, w, h)
    x1, y1, x2, y2 = [int(v) for v in box]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"Invalid ROI box={[x1, y1, x2, y2]} for frame {w}x{h}")
    return frame[y1:y2, x1:x2], (x1, y1, x2, y2)


def _level_for(coverage_pct: float, warn_pct: float, alarm_pct: float) -> str:
    if coverage_pct >= alarm_pct:
        return "alarm"
    if coverage_pct >= warn_pct:
        return "warn"
    return "normal"


_yolo_model = None
_yolo_weights_loaded: Optional[str] = None


def _foam_mask_water_foam(
    roi_bgr: np.ndarray,
    cfg: Dict[str, Any],
    *,
    foam_only: bool = False,
) -> Tuple[np.ndarray, np.ndarray]:
    """Run unified bundle on ROI. If foam_only=True, skip SegFormer and treat ROI as water_mask."""
    from src.utils.config import resolve_model_path
    from src.vision.water_foam_model import get_water_foam_predictor

    model_cfg = cfg.get("model", {})
    bundle_rel = model_cfg.get("bundle_path", "models/water_foam/water_foam_bundle.pth")
    bundle_path = resolve_model_path(bundle_rel)
    if bundle_path is None or not Path(bundle_path).exists():
        raise FileNotFoundError(
            f"Unified water+foam bundle missing: {bundle_rel}. "
            "Place water_foam_bundle.pth under models/water_foam/."
        )

    img_size = int(model_cfg.get("img_size", 256))
    water_thresh = float(model_cfg.get("water_thresh", 0.5))
    foam_thresh = float(model_cfg.get("foam_thresh", 0.5))
    device = model_cfg.get("device") or None

    predictor = get_water_foam_predictor(
        bundle_path=bundle_path,
        device=device,
        img_size=img_size,
    )
    if foam_only:
        h, w = roi_bgr.shape[:2]
        water_mask = np.full((h, w), 255, dtype=np.uint8)
        foam_mask = predictor.predict_foam_in_mask(
            roi_bgr,
            water_mask,
            foam_thresh=foam_thresh,
            img_size=img_size,
        )
        return foam_mask, water_mask

    water_mask, foam_mask = predictor.predict(
        roi_bgr,
        water_thresh=water_thresh,
        foam_thresh=foam_thresh,
        img_size=img_size,
    )
    return foam_mask, water_mask


def _foam_mask_yolo(
    roi_bgr: np.ndarray, cfg: Dict[str, Any]
) -> Tuple[np.ndarray, list[Tuple[int, int, int, int, float]]]:
    """Run YOLO-seg on ROI; union masks of configured foam class names.

    Returns (mask, det_boxes) where det_boxes are (x1,y1,x2,y2,conf) in ROI coords.
    """
    global _yolo_model, _yolo_weights_loaded
    from src.utils.config import resolve_model_path

    model_cfg = cfg.get("model", {})
    weights = model_cfg.get("weights_path", "models/foam/best.pt")
    weights_path = resolve_model_path(weights)
    if weights_path is None or not Path(weights_path).exists():
        raise FileNotFoundError(
            f"YOLO weights missing: {weights}. "
            "Train via notebooks/train_foam_yolo_colab.ipynb then place best.pt under models/foam/"
        )
    weights_key = str(weights_path)
    if _yolo_model is None or _yolo_weights_loaded != weights_key:
        from ultralytics import YOLO

        _yolo_model = YOLO(weights_key)
        _yolo_weights_loaded = weights_key

    conf = float(model_cfg.get("conf", 0.25))
    imgsz = int(model_cfg.get("imgsz", 640))
    device = model_cfg.get("device") or None
    class_names = [str(n).lower() for n in model_cfg.get("class_names", ["foam"])]

    results = _yolo_model.predict(
        source=roi_bgr,
        conf=conf,
        imgsz=imgsz,
        device=device,
        verbose=False,
    )
    h, w = roi_bgr.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    det_boxes: list[Tuple[int, int, int, int, float]] = []
    if not results:
        return mask, det_boxes
    r0 = results[0]
    if r0.masks is None or r0.boxes is None or len(r0.boxes) == 0:
        return mask, det_boxes

    names = r0.names or {}
    want = set(class_names)
    masks_data = r0.masks.data.cpu().numpy()
    cls_ids = r0.boxes.cls.cpu().numpy().astype(int)
    xyxy = r0.boxes.xyxy.cpu().numpy()
    confs = r0.boxes.conf.cpu().numpy()
    for i, cls_id in enumerate(cls_ids):
        label = str(names.get(int(cls_id), "")).lower()
        if want and label not in want:
            continue
        m = masks_data[i]
        m_resized = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        mask[m_resized > 0.5] = 255
        x1, y1, x2, y2 = [int(v) for v in xyxy[i]]
        det_boxes.append((x1, y1, x2, y2, float(confs[i])))
    return mask, det_boxes


def _foam_mask_classical(roi_bgr: np.ndarray, cfg: Dict[str, Any]) -> np.ndarray:
    hsv_cfg = cfg.get("hsv", {})
    pre = cfg.get("preprocess", {})
    morph = cfg.get("morphology", {})

    k = int(pre.get("blur_ksize", 5))
    if k > 1 and k % 2 == 0:
        k += 1
    blur = cv2.GaussianBlur(roi_bgr, (k, k), 0) if k > 1 else roi_bgr

    hsv = cv2.cvtColor(blur, cv2.COLOR_BGR2HSV)
    lower = np.array(
        [
            int(hsv_cfg.get("h_min", 0)),
            int(hsv_cfg.get("s_min", 0)),
            int(hsv_cfg.get("v_min", 160)),
        ],
        dtype=np.uint8,
    )
    upper = np.array(
        [
            int(hsv_cfg.get("h_max", 180)),
            int(hsv_cfg.get("s_max", 80)),
            int(hsv_cfg.get("v_max", 255)),
        ],
        dtype=np.uint8,
    )
    mask = cv2.inRange(hsv, lower, upper)

    open_k = int(morph.get("open_ksize", 3))
    close_k = int(morph.get("close_ksize", 7))
    if open_k > 1:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    if close_k > 1:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    min_area = int(morph.get("min_area_px", 80))
    if min_area > 0:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        cleaned = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                cleaned[labels == i] = 255
        mask = cleaned
    return mask


def _draw_overlay(
    frame: np.ndarray,
    mask: np.ndarray,
    roi_box: Tuple[int, int, int, int],
    coverage_pct: float,
    level: str,
    *,
    det_boxes: Optional[Sequence[Tuple[int, int, int, int, float]]] = None,
    debris_items: Optional[Sequence[Dict[str, Any]]] = None,
    roi_is_full_frame: bool = False,
    water_mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Overlay highlights water mask (blue) + foam mask (level color) inside ROI."""
    out = frame.copy()
    x1, y1, x2, y2 = roi_box
    # OpenCV BGR: green / yellow-ish / red-ish
    bgr = {
        "normal": (83, 168, 52),
        "warn": (4, 188, 251),
        "alarm": (53, 67, 234),
    }.get(level, (180, 180, 180))

    overlay = out[y1:y2, x1:x2].copy()
    tint = overlay.copy()
    if water_mask is not None:
        tint[water_mask > 0] = (225, 145, 20)
    tint[mask > 0] = bgr
    blended = cv2.addWeighted(overlay, 0.58, tint, 0.42, 0)
    out[y1:y2, x1:x2] = blended

    if water_mask is not None:
        w_contours, _ = cv2.findContours(water_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if w_contours:
            w_shifted = [c + np.array([[x1, y1]]) for c in w_contours]
            cv2.drawContours(out, w_shifted, -1, (255, 180, 0), 2)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        shifted = [c + np.array([[x1, y1]]) for c in contours]
        cv2.drawContours(out, shifted, -1, bgr, 2)

    if det_boxes:
        for bx1, by1, bx2, by2, conf in det_boxes:
            cv2.rectangle(
                out,
                (x1 + bx1, y1 + by1),
                (x1 + bx2, y1 + by2),
                bgr,
                1,
            )
            cv2.putText(
                out,
                f"{conf:.2f}",
                (x1 + bx1 + 4, max(16, y1 + by1 - 4)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                bgr,
                1,
                cv2.LINE_AA,
            )

    if debris_items:
        debris_color = (20, 100, 255)
        for item in debris_items:
            dbox = item.get("box")
            if dbox and len(dbox) == 4:
                dx1, dy1, dx2, dy2 = [int(v) for v in dbox]
                cv2.rectangle(out, (dx1, dy1), (dx2, dy2), debris_color, 2)
                cv2.putText(
                    out,
                    "DEBRIS",
                    (dx1 + 2, max(16, dy1 - 5)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.48,
                    debris_color,
                    2,
                    cv2.LINE_AA,
                )

    if not roi_is_full_frame:
        cv2.rectangle(out, (x1, y1), (x2, y2), (160, 160, 160), 1)
        cv2.putText(
            out,
            "ROI",
            (x1 + 4, max(16, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (160, 160, 160),
            1,
            cv2.LINE_AA,
        )

    label_y = 28 if roi_is_full_frame else max(28, y1 + 24)
    cv2.putText(
        out,
        f"foam {coverage_pct:.1f}% [{level}]",
        (8 if roi_is_full_frame else x1 + 8, label_y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        bgr,
        2,
        cv2.LINE_AA,
    )
    return out


def estimate_foam_coverage(
    image: Union[str, Path, np.ndarray],
    cfg: Optional[Dict[str, Any]] = None,
    *,
    draw_overlay: bool = True,
    roi_box_override: Optional[Sequence[int]] = None,
    foam_only: bool = False,
) -> FoamCoverageResult:
    """Estimate foam coverage percentage inside configured ROI."""
    t0 = time.perf_counter()
    foam_cfg = _load_foam_cfg(cfg)
    thr = foam_cfg.get("thresholds", {})

    try:
        if isinstance(image, (str, Path)):
            path = Path(image)
            if not path.is_absolute():
                path = get_project_root() / path
            frame = imread_unicode(path)
            if frame is None:
                raise FileNotFoundError(f"Cannot read image: {path}")
        else:
            frame = image
            if frame is None or not hasattr(frame, "shape"):
                raise ValueError("image ndarray is empty")

        backend = str(foam_cfg.get("model", {}).get("backend", "water_foam")).lower()
        roi_cfg = roi_box_override if roi_box_override is not None else foam_cfg.get("roi", {}).get("box")
        roi, roi_box = _resolve_roi(frame, roi_cfg)
        fh, fw = frame.shape[:2]
        roi_is_full_frame = roi_box == (0, 0, fw, fh)
        det_boxes: list[Tuple[int, int, int, int, float]] = []
        water_mask: Optional[np.ndarray] = None
        if backend in ("water_foam", "two_stage", "unified"):
            mask, water_mask = _foam_mask_water_foam(roi, foam_cfg, foam_only=foam_only)
        elif backend in ("yolo", "yolo_seg", "ultralytics"):
            mask, det_boxes = _foam_mask_yolo(roi, foam_cfg)
        elif backend == "classical":
            mask = _foam_mask_classical(roi, foam_cfg)
        else:
            raise NotImplementedError(f"Unknown foam backend: {backend!r}")
        foam_px = int(cv2.countNonZero(mask))
        if water_mask is not None:
            water_px = int(cv2.countNonZero(water_mask))
            roi_px = water_px if water_px > 0 else int(roi.shape[0] * roi.shape[1])
            coverage = (100.0 * foam_px / water_px) if water_px > 0 else 0.0
        else:
            roi_px = int(roi.shape[0] * roi.shape[1])
            if roi_px <= 0:
                raise ValueError("ROI has zero area")
            coverage = 100.0 * foam_px / roi_px
        level = _level_for(
            coverage,
            float(thr.get("warn_pct", 25.0)),
            float(thr.get("alarm_pct", 40.0)),
        )
        from src.vision.wastewater_analyzer import analyze_basin_surface

        surface_analysis = analyze_basin_surface(
            frame=frame,
            foam_mask=mask,
            roi_box=roi_box,
            coverage_pct=round(coverage, 2),
            foam_level=level,
            cfg=foam_cfg,
            water_mask=water_mask,
        )
        debris_items: list[Dict[str, Any]] = []
        latency_ms = (time.perf_counter() - t0) * 1000.0
        overlay = (
            _draw_overlay(
                frame,
                mask,
                roi_box,
                coverage,
                level,
                det_boxes=det_boxes,
                debris_items=debris_items,
                roi_is_full_frame=roi_is_full_frame,
                water_mask=water_mask,
            )
            if draw_overlay
            else None
        )
        return FoamCoverageResult(
            coverage_pct=round(coverage, 2),
            level=level,
            latency_ms=round(latency_ms, 2),
            roi_box=roi_box,
            foam_pixels=foam_px,
            roi_pixels=roi_px,
            error=None,
            overlay_bgr=overlay,
            water=surface_analysis.get("water"),
            sludge=surface_analysis.get("sludge"),
            debris=surface_analysis.get("debris"),
            scenarios=surface_analysis.get("scenarios"),
        )
    except Exception as exc:  # noqa: BLE001 — surface as structured error
        latency_ms = (time.perf_counter() - t0) * 1000.0
        return FoamCoverageResult(
            coverage_pct=0.0,
            level="error",
            latency_ms=round(latency_ms, 2),
            roi_box=None,
            foam_pixels=0,
            roi_pixels=0,
            error=str(exc),
            overlay_bgr=None,
        )
