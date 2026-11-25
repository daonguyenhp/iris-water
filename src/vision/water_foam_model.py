"""Unified 2-Stage Water + Foam Segmentation Model (SegFormer-B0 + EfficientViT-B0)."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np
import timm
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import SegformerConfig, SegformerForSemanticSegmentation


class EfficientViTB0Foam(nn.Module):
    """EfficientViT-B0 segmentation head for foam mask extraction on water regions."""

    def __init__(self, in_channels: int = 3, num_classes: int = 1, pretrained: bool = False) -> None:
        super().__init__()
        self.encoder = timm.create_model(
            "efficientvit_b0",
            pretrained=pretrained,
            in_chans=in_channels,
            features_only=True,
        )
        embed_dim = 64
        self.p0 = nn.Conv2d(16, embed_dim, kernel_size=1)
        self.p1 = nn.Conv2d(32, embed_dim, kernel_size=1)
        self.p2 = nn.Conv2d(64, embed_dim, kernel_size=1)
        self.p3 = nn.Conv2d(128, embed_dim, kernel_size=1)

        self.fuse = nn.Sequential(
            nn.BatchNorm2d(embed_dim * 4),
            nn.ReLU(inplace=True),
            nn.Conv2d(embed_dim * 4, embed_dim, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(embed_dim),
            nn.ReLU(inplace=True),
            nn.Dropout(0.1),
            nn.Conv2d(embed_dim, num_classes, kernel_size=1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h, w = x.shape[2:]
        f0, f1, f2, f3 = self.encoder(x)

        p0 = self.p0(f0)
        p1 = F.interpolate(self.p1(f1), size=p0.shape[2:], mode="bilinear", align_corners=False)
        p2 = F.interpolate(self.p2(f2), size=p0.shape[2:], mode="bilinear", align_corners=False)
        p3 = F.interpolate(self.p3(f3), size=p0.shape[2:], mode="bilinear", align_corners=False)

        fused = torch.cat([p0, p1, p2, p3], dim=1)
        out = self.fuse(fused)
        return F.interpolate(out, size=(h, w), mode="bilinear", align_corners=False)


class WaterFoamPredictor:
    """Unified 2-stage predictor:
    1) SegFormer-B0 predicts the water surface mask.
    2) EfficientViT-B0 predicts the foam mask inside the extracted water region.
    """

    def __init__(
        self,
        bundle_path: str | Path,
        device: Optional[str] = None,
        img_size: Optional[int] = None,
    ) -> None:
        self.bundle_path = Path(bundle_path)
        if not self.bundle_path.exists():
            raise FileNotFoundError(f"Water+Foam bundle not found: {self.bundle_path}")

        if device:
            self.device = torch.device(device)
        else:
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        bundle = torch.load(str(self.bundle_path), map_location=self.device, weights_only=False)
        if not isinstance(bundle, dict) or "water_state_dict" not in bundle or "foam_state_dict" not in bundle:
            raise ValueError(f"Invalid Water+Foam bundle format: {self.bundle_path}")

        self.img_size = int(img_size or bundle.get("default_img_size", 256))
        self.default_water_thresh = float(bundle.get("default_water_thresh", 0.5))
        self.default_foam_thresh = float(bundle.get("default_foam_thresh", 0.5))

        water_cfg = SegformerConfig.from_dict(bundle["water_config"])
        self.water_model = SegformerForSemanticSegmentation(water_cfg).to(self.device)
        self.water_model.load_state_dict(bundle["water_state_dict"])
        self.water_model.eval()

        self.foam_model = EfficientViTB0Foam(in_channels=3, num_classes=1, pretrained=False).to(self.device)
        self.foam_model.load_state_dict(bundle["foam_state_dict"])
        self.foam_model.eval()

        self._mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
        self._std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)
        self._infer_lock = threading.Lock()

    def _preprocess(self, bgr: np.ndarray, size: int) -> torch.Tensor:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_LINEAR)
        norm = (resized.astype(np.float32) / 255.0 - self._mean) / self._std
        return torch.from_numpy(norm).permute(2, 0, 1).unsqueeze(0).float().to(self.device)

    def predict(
        self,
        img_bgr: np.ndarray,
        water_thresh: Optional[float] = None,
        foam_thresh: Optional[float] = None,
        img_size: Optional[int] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Return (water_mask, foam_mask) as uint8 0/255 arrays matching img_bgr resolution."""
        orig_h, orig_w = img_bgr.shape[:2]
        size = int(img_size or self.img_size)
        w_thr = float(self.default_water_thresh if water_thresh is None else water_thresh)
        f_thr = float(self.default_foam_thresh if foam_thresh is None else foam_thresh)

        with self._infer_lock, torch.no_grad():
            tensor_water = self._preprocess(img_bgr, size)
            out_water = self.water_model(pixel_values=tensor_water)
            upsampled_water = F.interpolate(
                out_water.logits,
                size=(orig_h, orig_w),
                mode="bilinear",
                align_corners=False,
            )
            prob_water = F.softmax(upsampled_water, dim=1)[0, 1].cpu().numpy()
            water_mask = (prob_water >= w_thr).astype(np.uint8) * 255

            water_only_bgr = cv2.bitwise_and(img_bgr, img_bgr, mask=water_mask)
            tensor_foam = self._preprocess(water_only_bgr, size)
            logits_foam = self.foam_model(tensor_foam)
            upsampled_foam = F.interpolate(
                logits_foam,
                size=(orig_h, orig_w),
                mode="bilinear",
                align_corners=False,
            )
            prob_foam = torch.sigmoid(upsampled_foam)[0, 0].cpu().numpy()
            foam_mask = (prob_foam >= f_thr).astype(np.uint8) * 255

        foam_mask = cv2.bitwise_and(foam_mask, water_mask)
        return water_mask, foam_mask

    def predict_foam_in_mask(
        self,
        img_bgr: np.ndarray,
        water_mask: np.ndarray,
        foam_thresh: Optional[float] = None,
        img_size: Optional[int] = None,
    ) -> np.ndarray:
        """Run ONLY the foam model inside a user-supplied water_mask (skips SegFormer)."""
        orig_h, orig_w = img_bgr.shape[:2]
        size = int(img_size or self.img_size)
        f_thr = float(self.default_foam_thresh if foam_thresh is None else foam_thresh)

        water_only_bgr = cv2.bitwise_and(img_bgr, img_bgr, mask=water_mask)
        with self._infer_lock, torch.no_grad():
            tensor_foam = self._preprocess(water_only_bgr, size)
            logits_foam = self.foam_model(tensor_foam)
            upsampled_foam = F.interpolate(
                logits_foam,
                size=(orig_h, orig_w),
                mode="bilinear",
                align_corners=False,
            )
            prob_foam = torch.sigmoid(upsampled_foam)[0, 0].cpu().numpy()
            foam_mask = (prob_foam >= f_thr).astype(np.uint8) * 255

        return cv2.bitwise_and(foam_mask, water_mask)


_cache_lock = threading.Lock()
_cached_predictor: Optional[WaterFoamPredictor] = None
_cached_key: Optional[Tuple[str, str, int]] = None


def get_water_foam_predictor(
    bundle_path: str | Path,
    device: Optional[str] = None,
    img_size: Optional[int] = None,
) -> WaterFoamPredictor:
    """Return a cached WaterFoamPredictor instance for the given bundle path."""
    global _cached_predictor, _cached_key
    resolved = str(Path(bundle_path).resolve())
    dev_key = str(device or "")
    size_key = int(img_size or 0)
    key = (resolved, dev_key, size_key)
    with _cache_lock:
        if _cached_predictor is None or _cached_key != key:
            _cached_predictor = WaterFoamPredictor(
                bundle_path=resolved,
                device=device or None,
                img_size=img_size,
            )
            _cached_key = key
        return _cached_predictor
