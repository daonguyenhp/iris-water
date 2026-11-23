"""Unit tests for the multi-task WWTP basin surface analyzer (Tasks 1, 3, 4 & operational scenarios)."""

from __future__ import annotations

import numpy as np

from src.vision.foam_coverage import estimate_foam_coverage
from src.vision.wastewater_analyzer import (
    analyze_basin_surface,
    analyze_sludge_and_bubbles,
    analyze_water_color_and_clarity,
    compensate_natural_lighting,
    detect_floating_debris_and_sheen,
    evaluate_operational_scenarios,
)


def test_lighting_compensation_and_water_pigment() -> None:
    """Task 3: Verify natural lighting compensation and water pigment classification."""
    # Synthetic clear greenish water (BGR)
    bgr_green = np.full((240, 320, 3), (120, 175, 95), dtype=np.uint8)
    non_foam = np.full((240, 320), 255, dtype=np.uint8)

    norm_bgr, light_info = compensate_natural_lighting(bgr_green)
    assert norm_bgr.shape == bgr_green.shape
    assert "condition" in light_info
    assert "brightness_l" in light_info

    water_res = analyze_water_color_and_clarity(bgr_green, non_foam)
    assert "pigment_label" in water_res
    assert "clarity_score" in water_res
    assert "reflection_score" in water_res
    assert 0.0 <= water_res["clarity_score"] <= 100.0


def test_sludge_and_debris_detection() -> None:
    """Task 1 & Task 4: Verify sludge floc dispersion and foreign floating debris detection."""
    frame = np.full((240, 320, 3), (90, 130, 150), dtype=np.uint8)
    foam_mask = np.zeros((240, 320), dtype=np.uint8)
    foam_mask[20:80, 30:110] = 255

    # Draw a vivid red plastic bag on non-foam water
    frame[140:185, 190:245] = (20, 25, 240)

    sludge_res = analyze_sludge_and_bubbles(frame, foam_mask, coverage_pct=15.0)
    assert sludge_res["cluster_count"] >= 1
    assert 0.0 <= sludge_res["dispersion_pct"] <= 100.0
    assert "bubble_state" in sludge_res

    debris_info, items = detect_floating_debris_and_sheen(
        frame, foam_mask, (0, 0, 320, 240)
    )
    assert debris_info["count"] >= 1
    assert len(items) >= 1
    assert items[0]["box"] == [190, 140, 245, 185]


def test_full_basin_surface_and_scenarios() -> None:
    """Verify end-to-end estimate_foam_coverage includes water, sludge, debris, and scenarios."""
    frame = np.full((240, 320, 3), (100, 140, 120), dtype=np.uint8)
    # Add bright white foam patch
    frame[40:140, 50:200] = (245, 245, 245)

    cfg = {
        "model": {"backend": "classical"},
        "thresholds": {"warn_pct": 15.0, "alarm_pct": 40.0},
    }
    res = estimate_foam_coverage(frame, cfg=cfg, draw_overlay=True)
    assert res.error is None
    assert res.coverage_pct > 15.0
    assert res.water is not None
    assert res.sludge is not None
    assert res.debris is not None
    assert res.scenarios is not None and len(res.scenarios) >= 1
    assert res.overlay_bgr is not None
