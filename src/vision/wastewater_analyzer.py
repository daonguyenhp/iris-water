"""Multi-task wastewater basin surface analyzer (OpenCV + Pre-trained Segmentation)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np


def compensate_natural_lighting(bgr: np.ndarray) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Normalize natural lighting variations using Gray-World white balance + LAB L-channel CLAHE."""
    img = bgr.astype(np.float32)
    avg_b = float(np.mean(img[:, :, 0])) + 1e-5
    avg_g = float(np.mean(img[:, :, 1])) + 1e-5
    avg_r = float(np.mean(img[:, :, 2])) + 1e-5
    avg_gray = (avg_b + avg_g + avg_r) / 3.0

    # Clamp gains so extreme single-color water doesn't get washed out
    gain_b = float(np.clip(avg_gray / avg_b, 0.75, 1.35))
    gain_g = float(np.clip(avg_gray / avg_g, 0.75, 1.35))
    gain_r = float(np.clip(avg_gray / avg_r, 0.75, 1.35))

    img[:, :, 0] = np.clip(img[:, :, 0] * gain_b, 0, 255)
    img[:, :, 1] = np.clip(img[:, :, 1] * gain_g, 0, 255)
    img[:, :, 2] = np.clip(img[:, :, 2] * gain_r, 0, 255)
    wb_bgr = img.astype(np.uint8)

    lab = cv2.cvtColor(wb_bgr, cv2.COLOR_BGR2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)
    mean_l = float(np.mean(l_chan))
    std_l = float(np.std(l_chan))

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_norm = clahe.apply(l_chan)
    norm_bgr = cv2.cvtColor(cv2.merge([l_norm, a_chan, b_chan]), cv2.COLOR_LAB2BGR)

    if mean_l > 175:
        light_cond = "Nắng gắt / Ngược sáng"
    elif mean_l < 75:
        light_cond = "Ánh sáng yếu / Ban đêm"
    else:
        light_cond = "Ánh sáng tự nhiên ổn định"

    return norm_bgr, {
        "condition": light_cond,
        "brightness_l": round(mean_l, 1),
        "contrast_l": round(std_l, 1),
        "wb_gains": [round(gain_r, 2), round(gain_g, 2), round(gain_b, 2)],
    }


def analyze_water_color_and_clarity(
    roi_bgr: np.ndarray,
    non_foam_mask: np.ndarray,
    cfg: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Task 3: Estimate water pigment, clarity, and surface reflection on non-foam water pixels."""
    w_cfg = (cfg or {}).get("water_analysis", {})
    use_comp = bool(w_cfg.get("illumination_compensation", True))

    norm_bgr, light_info = (
        compensate_natural_lighting(roi_bgr)
        if use_comp
        else (roi_bgr, {"condition": "Mặc định", "brightness_l": 128.0, "contrast_l": 40.0})
    )

    hsv = cv2.cvtColor(norm_bgr, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(norm_bgr, cv2.COLOR_BGR2LAB)

    valid_pixels = non_foam_mask > 0
    if int(np.count_nonzero(valid_pixels)) < 50:
        valid_pixels = np.ones(roi_bgr.shape[:2], dtype=bool)

    h_vals = hsv[:, :, 0][valid_pixels]
    s_vals = hsv[:, :, 1][valid_pixels]
    v_vals = hsv[:, :, 2][valid_pixels]
    b_vals = roi_bgr[:, :, 0][valid_pixels]
    g_vals = roi_bgr[:, :, 1][valid_pixels]
    r_vals = roi_bgr[:, :, 2][valid_pixels]

    mean_h = float(np.median(h_vals))
    mean_s = float(np.mean(s_vals))
    mean_v = float(np.mean(v_vals))
    mean_r = float(np.mean(r_vals))
    mean_g = float(np.mean(g_vals))
    mean_b = float(np.mean(b_vals))
    hex_color = f"#{int(mean_r):02x}{int(mean_g):02x}{int(mean_b):02x}"

    # Classify pigment (Màu nước dễ hiểu, không mở ngoặc)
    if mean_v < 58:
        pigment_code = "dark_anaerobic"
        pigment_label = "Đen sẫm · Bùn thiếu khí"
        status = "alarm"
    elif 10 <= mean_h <= 26 and mean_s >= 48:
        if mean_v >= 115:
            pigment_code = "yellow_turbid"
            pigment_label = "Nâu vàng · Bùn vi sinh"
            status = "normal"
        else:
            pigment_code = "brown_sludge"
            pigment_label = "Nâu sẫm · Bùn đặc"
            status = "warn"
    elif 27 <= mean_h <= 42 and mean_s >= 45:
        pigment_code = "yellow_green"
        pigment_label = "Vàng lục · Còn rêu hoặc chất bẩn"
        status = "warn"
    elif 43 <= mean_h <= 108:
        if mean_s < 75 and mean_v > 110:
            pigment_code = "green_clear"
            pigment_label = "Xanh trong · Nước sạch đạt chuẩn"
            status = "normal"
        else:
            pigment_code = "green_algae"
            pigment_label = "Xanh đậm · Nhiều tảo"
            status = "warn"
    elif mean_h > 135 or (mean_h < 10 and mean_s > 85):
        pigment_code = "chemical_tint"
        pigment_label = "Ánh đỏ tím · Còn lẫn phẩm màu"
        status = "alarm"
    else:
        pigment_code = "gray_turbid"
        pigment_label = "Xám đục · Nhiều cặn lơ lửng"
        status = "warn"

    # Surface reflection & clarity estimation (thử phản xạ hình ảnh hạ tầng xung quanh bể)
    gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    sobely = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    grad_mag = float(np.mean(np.hypot(sobelx, sobely)))

    # Reflection index combines high-frequency infrastructure edge reflection and specular contrast
    reflection_score = float(np.clip((lap_var / 12.0) * 0.5 + (grad_mag / 1.8) * 0.5, 5.0, 98.0))
    # Clarity index inversely relates to suspended solid saturation/turbidity
    turbidity_penalty = float(np.clip((mean_s / 255.0) * 55.0 + (1.0 - mean_v / 255.0) * 35.0, 0.0, 85.0))
    clarity_score = float(np.clip(100.0 - turbidity_penalty + (reflection_score * 0.15), 8.0, 96.0))

    clear_thr = float(w_cfg.get("clarity_clear_threshold", 55.0))
    mod_thr = float(w_cfg.get("clarity_moderate_threshold", 25.0))
    if clarity_score >= clear_thr:
        clarity_label = "Trong — Phản xạ rõ hạ tầng"
    elif clarity_score >= mod_thr:
        clarity_label = "Bán trong — Có bông cặn lơ lửng"
    else:
        clarity_label = "Đục cao — Nguy cơ tràn bùn / cặn nổi"

    return {
        "pigment_code": pigment_code,
        "pigment_label": pigment_label,
        "hex_color": hex_color,
        "hsv_mean": [round(mean_h, 1), round(mean_s, 1), round(mean_v, 1)],
        "clarity_score": round(clarity_score, 1),
        "clarity_label": clarity_label,
        "reflection_score": round(reflection_score, 1),
        "lighting": light_info,
        "status": status,
    }


def analyze_sludge_and_bubbles(
    roi_bgr: np.ndarray,
    foam_mask: np.ndarray,
    coverage_pct: float,
) -> Dict[str, Any]:
    """Analyze biological sludge maturity, floc dispersion, and aeration bubble texture."""
    h, w = roi_bgr.shape[:2]
    total_px = max(1, h * w)

    # Connected components of foam/floc clusters
    num_labels, _, stats, _ = cv2.connectedComponentsWithStats(foam_mask, connectivity=8)
    areas = [int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, num_labels) if stats[i, cv2.CC_STAT_AREA] >= 25]
    cluster_count = len(areas)
    mean_cluster_px = float(np.mean(areas)) if areas else 0.0

    # Grid-based spatial dispersion index (4x4 grid entropy / uniformity)
    gh, gw = max(1, h // 4), max(1, w // 4)
    cell_covs: List[float] = []
    for r in range(4):
        for c in range(4):
            cell = foam_mask[r * gh : min(h, (r + 1) * gh), c * gw : min(w, (c + 1) * gw)]
            if cell.size > 0:
                cell_covs.append(float(np.count_nonzero(cell)) / float(cell.size))
    active_cells = sum(1 for v in cell_covs if v > 0.03)
    dispersion_pct = round(100.0 * active_cells / max(1, len(cell_covs)), 1)

    # Bubble texture & aeration diagnosis
    if coverage_pct < 2.0:
        bubble_state = "Bọt khí rất ít — Cảnh báo thiếu oxy / vi sinh suy giảm"
        bubble_level = "warn"
    elif coverage_pct <= 25.0:
        bubble_state = "Bọt khí & bùn phân tán đều — Sục khí tối ưu"
        bubble_level = "normal"
    elif coverage_pct <= 40.0:
        bubble_state = "Bọt khí dày cục bộ — Chú ý tải hữu cơ / dư khí"
        bubble_level = "warn"
    else:
        bubble_state = "Bọt phủ dày toàn bể — Lãng phí điện sục khí / Nguy cơ tràn bọt"
        bubble_level = "alarm"

    # Floc size category (Cặn nổi / bùn)
    rel_floc_size = 100.0 * mean_cluster_px / total_px
    if cluster_count == 0:
        floc_label = "Không có cặn nổi"
    elif rel_floc_size < 0.35:
        floc_label = f"Hạt bùn mịn · {cluster_count} cụm, phủ đều {dispersion_pct}%"
    elif rel_floc_size < 2.0:
        floc_label = f"Bùn khỏe kết dính tốt · {cluster_count} cụm, phủ đều {dispersion_pct}%"
    else:
        floc_label = f"Mảng bọt đóng váng lớn · {cluster_count} mảng, phủ {dispersion_pct}%"

    return {
        "cluster_count": cluster_count,
        "dispersion_pct": dispersion_pct,
        "floc_label": floc_label,
        "bubble_state": bubble_state,
        "bubble_level": bubble_level,
    }


def detect_floating_debris_and_sheen(
    roi_bgr: np.ndarray,
    foam_mask: np.ndarray,
    roi_box: Tuple[int, int, int, int],
    cfg: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Task 4: Detect foreign floating objects (plastic bags, debris) & oil sheen anomalies in the basin."""
    d_cfg = (cfg or {}).get("debris_detection", {})
    min_area = int(d_cfg.get("min_area_px", 180))
    max_ratio = float(d_cfg.get("max_area_ratio", 0.14))

    h, w = roi_bgr.shape[:2]
    total_area = float(max(1, h * w))
    rx1, ry1, _, _ = roi_box

    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    non_foam = cv2.bitwise_not(foam_mask)

    # 1. Colorful foreign objects (plastic bags, colored nylon/debris with high saturation distinct from water/sludge)
    # Exclude typical brown/green water hues (10..95) when saturation is moderate; catch vivid plastics (red, blue, bright yellow, white/black sharp objects)
    vivid_mask1 = cv2.inRange(hsv, np.array([0, 125, 70], dtype=np.uint8), np.array([9, 255, 255], dtype=np.uint8))
    vivid_mask2 = cv2.inRange(hsv, np.array([100, 115, 70], dtype=np.uint8), np.array([180, 255, 255], dtype=np.uint8))
    vivid_mask = cv2.bitwise_or(vivid_mask1, vivid_mask2)
    vivid_mask = cv2.bitwise_and(vivid_mask, non_foam)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    vivid_mask = cv2.morphologyEx(vivid_mask, cv2.MORPH_OPEN, kernel)
    vivid_mask = cv2.morphologyEx(vivid_mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(vivid_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    items: List[Dict[str, Any]] = []
    for cnt in contours:
        area = float(cv2.contourArea(cnt))
        if area < min_area or (area / total_area) > max_ratio:
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        aspect = float(bw) / float(max(1, bh))
        if aspect > 8.0 or aspect < 0.12:
            continue
        peri = float(cv2.arcLength(cnt, True))
        circularity = 4.0 * np.pi * area / max(1.0, peri * peri)
        kind = "Túi nilon / Mảnh nhựa nổi" if circularity < 0.55 else "Dị vật nổi"
        items.append(
            {
                "kind": kind,
                "box": [int(rx1 + x), int(ry1 + y), int(rx1 + x + bw), int(ry1 + y + bh)],
                "area_px": int(area),
            }
        )

    # 2. Oil sheen estimation (Váng dầu: iridescent multi-hue variance on high-reflection patches)
    sheen_mask = cv2.inRange(hsv, np.array([95, 45, 130], dtype=np.uint8), np.array([165, 160, 255], dtype=np.uint8))
    sheen_mask = cv2.bitwise_and(sheen_mask, non_foam)
    sheen_pct = round(100.0 * float(np.count_nonzero(sheen_mask)) / total_area, 2)

    count = len(items)
    warn_cnt = int(d_cfg.get("warn_count", 1))
    alarm_cnt = int(d_cfg.get("alarm_count", 3))
    if count >= alarm_cnt or sheen_pct >= 8.0:
        level = "alarm"
        summary = f"Phát hiện {count} mảnh rác nổi · Váng dầu {sheen_pct}% · Nguy cơ kẹt bơm"
    elif count >= warn_cnt or sheen_pct >= 3.5:
        level = "warn"
        summary = f"Phát hiện {count} mảnh rác nổi trên mặt bể · Váng dầu {sheen_pct}%"
    else:
        level = "normal"
        summary = "Mặt bể sạch, không có rác lớn hay váng dầu"

    return (
        {
            "count": count,
            "oil_sheen_pct": sheen_pct,
            "level": level,
            "summary": summary,
        },
        items[:8],
    )


def evaluate_operational_scenarios(
    coverage_pct: float,
    foam_level: str,
    water_info: Dict[str, Any],
    sludge_info: Dict[str, Any],
    debris_info: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Combine AI surface metrics into pre-scripted WWTP operational scenarios (Hóa lý & Sinh học)."""
    scenarios: List[Dict[str, Any]] = []

    # 1. Biological Aeration & Foam Scenario
    if foam_level == "alarm":
        scenarios.append(
            {
                "code": "BIO_FOAM_OVERLOAD",
                "stage": "Bể Sinh học",
                "severity": "alarm",
                "title": "Lượng bọt nổi quá nhiều · Trên 40% mặt bể",
                "diagnosis": f"Tỷ lệ bọt {coverage_pct:.1f}%, độ phủ đều {sludge_info['dispersion_pct']}%. Nguy cơ bọt tràn qua thành bể hoặc máy sục khí đang bật quá mạnh gây tốn điện.",
                "action": "Giảm bớt máy thổi khí khoảng 10–15% và mở vòi phun nước dập bọt trên mặt bể.",
            }
        )
    elif foam_level == "warn":
        scenarios.append(
            {
                "code": "BIO_FOAM_RISING",
                "stage": "Bể Sinh học",
                "severity": "warn",
                "title": "Lượng bọt mặt bể đang tăng cao · Từ 25% đến 40%",
                "diagnosis": f"Tỷ lệ bọt {coverage_pct:.1f}%, {sludge_info['floc_label']}. Mặt bể bắt đầu xuất hiện nhiều mảng bọt dày.",
                "action": "Theo dõi sát lượng oxy trong nước và kiểm tra chất lượng bùn vi sinh.",
            }
        )
    elif coverage_pct < 1.5:
        scenarios.append(
            {
                "code": "BIO_LOW_AERATION",
                "stage": "Bể Sinh học",
                "severity": "warn",
                "title": "Mặt bể hầu như không có bọt khí sục",
                "diagnosis": "Rất ít bọt khí nổi lên trên mặt bể — có thể máy thổi khí đang yếu hoặc ngừng chạy làm vi sinh vật thiếu oxy.",
                "action": "Kiểm tra lại máy thổi khí, đường ống dẫn khí và đo lại lượng oxy trong bể.",
            }
        )

    # 2. Water Color, Clarity & Settling Floc (Hóa lý & Đầu ra)
    if water_info["status"] == "alarm":
        scenarios.append(
            {
                "code": "PHYS_WATER_COLOR_ALARM",
                "stage": "Bể Hóa lý & Đầu ra",
                "severity": "alarm",
                "title": f"Màu nước bất thường: {water_info['pigment_label']}",
                "diagnosis": f"Độ trong {water_info['clarity_score']}% · {water_info['clarity_label']}. Nước còn lẫn phẩm màu chưa xử lý hết hoặc bùn đen tràn sang bể sau.",
                "action": "Kiểm tra lại lượng hóa chất châm vào bể hóa lý và lấy mẫu nước đầu ra để kiểm tra.",
            }
        )
    elif water_info["clarity_score"] < 30.0:
        scenarios.append(
            {
                "code": "PHYS_FLOC_CARRYOVER",
                "stage": "Bể Hóa lý",
                "severity": "warn",
                "title": "Nước bị đục · Nguy cơ cặn tràn sang bể vi sinh",
                "diagnosis": f"Độ trong chỉ đạt {water_info['clarity_score']}%, độ nét bóng nước {water_info['reflection_score']}%. Cặn chưa lắng hết xuống đáy bể.",
                "action": "Chỉnh lại lượng hóa chất kết dính cặn và kiểm tra thanh gạt bùn trên mặt bể.",
            }
        )

    # 3. Foreign Debris & Oil Sheen Scenario
    if debris_info["level"] in ("warn", "alarm"):
        scenarios.append(
            {
                "code": "MECH_FOREIGN_DEBRIS",
                "stage": "Mặt bể & Máy bơm",
                "severity": debris_info["level"],
                "title": "Phát hiện rác trôi nổi hoặc váng dầu trên mặt bể",
                "diagnosis": debris_info["summary"],
                "action": "Vớt ngay túi nilon, mảnh nhựa trên mặt bể hoặc tại lưới chắn rác để tránh làm kẹt máy khuấy và nghẹt bơm.",
            }
        )

    if not scenarios:
        scenarios.append(
            {
                "code": "WWTP_NORMAL_OPERATION",
                "stage": "Toàn bộ bể",
                "severity": "normal",
                "title": "Bể đang hoạt động ổn định, các chỉ số bình thường",
                "diagnosis": f"Tỷ lệ bọt {coverage_pct:.1f}%, màu nước '{water_info['pigment_label']}', độ trong {water_info['clarity_score']}%, mặt bể sạch sẽ.",
                "action": "Giữ nguyên chế độ máy sục khí và lưu lượng nước như hiện tại.",
            }
        )

    return scenarios


def analyze_basin_surface(
    frame: np.ndarray,
    foam_mask: np.ndarray,
    roi_box: Tuple[int, int, int, int],
    coverage_pct: float,
    foam_level: str,
    cfg: Optional[Dict[str, Any]] = None,
    water_mask: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """Run complete physicochemical + biological surface analysis in ~5-15ms on ROI."""
    x1, y1, x2, y2 = roi_box
    roi_bgr = frame[y1:y2, x1:x2]
    non_foam_mask = cv2.bitwise_not(foam_mask)
    if water_mask is not None:
        non_foam_mask = cv2.bitwise_and(water_mask, non_foam_mask)

    water_info = analyze_water_color_and_clarity(roi_bgr, non_foam_mask, cfg)
    sludge_info = analyze_sludge_and_bubbles(roi_bgr, foam_mask, coverage_pct)
    debris_info = {
        "count": 0,
        "oil_sheen_pct": 0.0,
        "level": "normal",
        "summary": "Không bật nhận diện rác nổi",
    }
    debris_items: List[Dict[str, Any]] = []
    scenarios = evaluate_operational_scenarios(
        coverage_pct, foam_level, water_info, sludge_info, debris_info
    )

    return {
        "water": water_info,
        "sludge": sludge_info,
        "debris": {**debris_info, "items": debris_items},
        "scenarios": scenarios,
    }
