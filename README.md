# Iris Water — Smart Wastewater Treatment Monitoring System

Enterprise computer-vision and operational decision-support system for Wastewater Treatment Plants (WWTP). Built with **Python 3.11**, **FastAPI**, **OpenCV**, and **YOLOv8-seg** to observe physicochemical and biological treatment basins in real time.

---

## 1. Key Capabilities

### Physicochemical Stage (Coagulation & Flotation)
- **Inlet & Outlet Water Color**: Outdoor sunlight compensation via Gray-World white balance and CIE-LAB lightness normalization to detect residual industrial dyes or untreated compounds.
- **Water Clarity & Surface Reflection**: Estimates clarity from infrastructure reflection sharpness across the water surface.
- **Floating & Settling Flocs**: Evaluates floc binding, cluster count, and surface dispersion while warning early of unsettled carryover into downstream biological tanks.
- **Mechanical & Pump Protection**: Detects large floating objects and surface oil sheen while correlating mixer rotation speed (`RPM`).

### Biological Stage & Effluent Disinfection
- **Activated Sludge Health**: Monitors sludge color, particle size, and spatial dispersion across the basin.
- **Aeration Bubble Texture**: Detects under-aeration (low oxygen risk to biomass) and over-aeration (excessive foam and wasted blower electricity).
- **Foreign Debris & Plastics**: Highlights floating plastic bags, fragments, and abnormal surface dust.
- **Effluent Quality & UV Disinfection**: Combines outlet clarity, UV lamp coverage status, Dissolved Oxygen (`DO`), and `pH` readings into actionable operator guidance.

---

## 2. Project Structure

```text
├── configs/                  # YAML configurations (foam, camera, inference, security, notifications)
├── data/                     # Runtime storage (SQLite events DB, sample videos, live overlays)
├── datasets/foam/            # Wastewater foam & basin sample imagery (Foam IPAL v4, be_1.png)
├── frontend/                 # Bilingual (VI/EN) Web UI (home.html, huong-dan.html, index.html, styles.css, app.js)
├── inference/                # Batch and real-time inference runners
├── installer/                # Windows Inno Setup installer configuration
├── models/                   # Pre-trained weights (YOLOv8-seg foam model & ONNX checkpoints)
├── notebooks/                # Model training & evaluation notebooks
├── scripts/                  # CLI utilities, ONNX export, and service management scripts
├── src/
│   ├── alerts/               # Event logger, clip recorder, and Telegram notification service
│   ├── api/                  # FastAPI REST & WebSocket server
│   ├── auth/                 # JWT authentication & LAN request guard
│   ├── camera/               # Self-healing Webcam, RTSP/ONVIF, and VideoFile streams
│   ├── db/                   # SQLite connection and schema initialization
│   ├── pipeline/             # Decoupled real-time & multi-camera processing pipelines
│   ├── utils/                # Configuration loader, profiler, and SSL utilities
│   └── vision/               # Foam coverage segmentation & multi-task wastewater surface analyzer
└── tests/                    # Automated unit and integration test suite
```

---

## 3. Quick Start

### Option A: One-Click Windows Scripts
1. Run `1_Cai_Dat_Tu_Dong.bat` once to create `.venv` and install dependencies.
2. Run `2_Chay_He_Thong.bat` to start the server and open the web interface.

### Option B: Command Line (Python 3.11)
```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py --no-gui
```

- **Overview & Guide**: `http://localhost:8000/`
- **Live Monitoring Console**: `http://localhost:8000/app`

---

## 4. Running Tests

```powershell
.\.venv\Scripts\python.exe -c "import tests.test_wastewater_analyzer as t; [getattr(t, fn)() for fn in dir(t) if fn.startswith('test_')]; print('ALL TESTS PASSED')"
```
