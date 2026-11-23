# models/ — Iris WWTP

| Path | Role |
|------|------|
| `foam/` | Foam coverage weights (optional ONNX/YOLO-seg). Classical MVP needs no file here. |
| `checkpoints/` | Reserved for exported WWTP checkpoints (`best_foam_seg.onnx`, …). |
| `pose/`, `detector/`, `tracker/`, `action/`, `anomaly/`, `temporal/` | Legacy fall/stroke layout — unused by Iris WWTP foam path. Safe to empty. |

Put foam seg weights at: `models/foam/best_foam_seg.onnx` when you fine-tune.
