# Iris Water — Giám sát Xử lý Nước thải (On-Prem AIoT)

Hệ thống giám sát bề mặt bể xử lý nước thải chạy cục bộ (on-premise) trên CPU, kết hợp Web Dashboard trực quan và các mô hình phân đoạn ngữ nghĩa gọn nhẹ.

> **Phạm vi sử dụng:** Hỗ trợ quan sát bề mặt bể (tỷ lệ bọt phủ, màu nước, độ trong) và cảnh báo vận hành theo thời gian thực. Không thay thế thiết bị đo phòng thí nghiệm (NTU, SVI, DO) và không chẩn đoán quy trình hóa học.

---

## 1. Tính năng chính

- **Khởi động Web-First (không tự chiếm camera):** Khi chạy `main.py`, hệ thống chỉ bật Web Dashboard (`http://localhost:8000`) và chờ thao tác từ người dùng. Chỉ kết nối Webcam / RTSP / Video khi được chỉ định trên Web UI hoặc qua cờ `--connect-camera`.
- **Tab Xử lý ảnh tĩnh (2-Stage Segmentation):**
  - Sử dụng gói model hợp nhất [`models/water_foam/water_foam_bundle.pth`](models/water_foam/water_foam_bundle.pth):
    1. **SegFormer-B0** (`3.36 GFLOPs`, `3.71M` params): tách vùng mặt nước.
    2. **EfficientViT-B0** (`1.46 GFLOPs`, `0.85M` params): tách vùng bọt nổi bên trong mặt nước.
  - Hiển thị đối chiếu song song **Ảnh gốc** – **Ảnh phân đoạn**, tỷ lệ bọt/mặt nước, màu nước và độ trong.
- **Luồng Video / Camera Streaming tối ưu cho CPU (Foam-only + ROI):**
  - Phát video mẫu theo kiểu camera (lặp vô hạn đúng FPS gốc).
  - Trong chế độ **Xem song song** hoặc **Hình thực tế**, người dùng kéo chuột vẽ **1 ô chữ nhật** chọn vùng mặt nước trực tiếp trên khung hình (nếu chưa chọn, hệ thống hiển thị thông báo nhỏ trên ảnh và chưa chạy suy luận).
  - Vùng chữ nhật được dùng làm `water_mask` để đưa thẳng vào **EfficientViT-B0** (`1.4625 GFLOPs`, ~**41.38 ms/frame ≈ 24.17 FPS** trên CPU).
  - Kết hợp lấy mẫu keyframe thưa trên luồng nền (`stride_frames: 15`) và **dịch nhẹ mask** (`cv2.phaseCorrelate` + `cv2.warpAffine`) cho các frame trung gian để luồng MJPEG mượt mà.

---

## 2. Cấu trúc thư mục

```text
iris-water/
├── main.py                     # Điểm khởi chạy chính (mặc định chỉ bật web server)
├── requirements.txt            # Danh sách thư viện Python
├── configs/
│   ├── camera.yaml             # Cấu hình nguồn camera / video mẫu mặc định
│   ├── foam.yaml               # Cấu hình model, ngưỡng bọt, lấy mẫu CPU & live overlay
│   ├── inference.yaml          # Cấu hình runtime (CPU) & hiển thị
│   ├── model.yaml              # Cấu hình model hệ thống
│   └── thresholds.yaml         # Ngưỡng cảnh báo
├── frontend/                   # Giao diện Web Dashboard (HTML/CSS/JS)
│   ├── home.html               # Trang giới thiệu sản phẩm (/)
│   ├── index.html              # Dashboard vận hành & tab Xử lý ảnh tĩnh (/app)
│   ├── huong-dan.html          # Tài liệu hướng dẫn (/huong-dan.html)
│   ├── app.js
│   └── styles.css
├── models/
│   └── water_foam/
│       └── water_foam_bundle.pth  # Gói model hợp nhất SegFormer-B0 + EfficientViT-B0
├── data/
│   ├── videos/                 # Video mẫu (Video Project 2.mp4)
│   ├── foam/overlays/          # Ảnh overlay kết quả
│   └── processed/events/       # SQLite events.db & ảnh chụp sự kiện
└── src/
    ├── api/server.py           # FastAPI server, MJPEG stream, WebSocket & ROI API
    ├── camera/                 # WebcamStream, RTSPStream, VideoFileStream
    ├── vision/
    │   ├── water_foam_model.py # WaterFoamPredictor (2-stage & foam-only ROI)
    │   ├── live_mask_tracker.py# LiveWaterFoamOverlay (keyframe thưa + dịch nhẹ mask)
    │   ├── foam_coverage.py    # Ước lượng độ phủ bọt & vẽ overlay
    │   ├── foam_monitor.py     # Theo dõi định kỳ nền (adaptive theo latency CPU)
    │   ├── foam_video.py       # Phân tích video tải lên theo adaptive_fps
    │   └── wastewater_analyzer.py # Phân tích màu nước, độ trong, bùn & kịch bản vận hành
    ├── alerts/                 # Quản lý cảnh báo, SQLite logger & Telegram
    ├── auth/                   # Xác thực người dùng
    └── utils/                  # Đọc cấu hình YAML & giám sát tài nguyên
```

---

## 3. Hướng dẫn cài đặt & chạy

### Yêu cầu môi trường
- Python 3.11 / 3.12 (đã cài đầy đủ các gói trong `requirements.txt`, bao gồm `torch`, `transformers`, `timm`, `opencv-python`, `fastapi`, `uvicorn`).

### Cài đặt thư viện
```powershell
pip install -r requirements.txt
```

### Khởi chạy hệ thống
```powershell
python main.py
```
Hoặc dùng trực tiếp môi trường Conda đã cấu hình:
```powershell
D:\apps\miniconda\envs\Study\python.exe main.py
```

Sau khi terminal hiển thị:
```text
[3/3] Web Dashboard đã sẵn sàng (CHẾ ĐỘ CHỈ BẬT WEB — CHƯA KẾT NỐI CAMERA).
      Truy cập giao diện web tại: http://localhost:8000
```
Mở trình duyệt tại:
- **Trang chủ:** `http://localhost:8000`
- **Dashboard vận hành:** `http://localhost:8000/app`
- **API Docs (Swagger):** `http://localhost:8000/docs`

### Các tùy chọn dòng lệnh
- Đổi cổng web:
  ```powershell
  python main.py --api-port 8080
  ```
- Tự động kết nối camera ngay khi khởi động:
  ```powershell
  python main.py --connect-camera
  ```

---

## 4. Các API chính

| Method | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/health` | Kiểm tra trạng thái server & CPU/RAM |
| `GET` | `/status` | Trạng thái luồng camera, `water_roi` và kết quả `foam` mới nhất |
| `POST` | `/camera/start` | Bật nguồn hình (`webcam`, `rtsp`, `video`) |
| `POST` | `/camera/stop` | Dừng luồng camera và giải phóng tài nguyên |
| `GET` / `POST` | `/api/vision/roi` | Lấy hoặc cập nhật vùng chữ nhật mặt nước `[nx1, ny1, nx2, ny2]` |
| `POST` | `/api/vision/foam/image` | Phân tích ảnh tĩnh (2-stage SegFormer-B0 + EfficientViT-B0) |
| `POST` | `/api/vision/foam/video` | Phân tích video tải lên theo `adaptive_fps` |
| `GET` | `/stream/mjpeg` | Luồng video MJPEG trực tiếp kèm overlay mask |
