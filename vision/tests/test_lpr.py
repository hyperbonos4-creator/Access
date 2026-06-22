"""Tests del pipeline LPR (G6) — normalización/validación y selección."""

from __future__ import annotations

import numpy as np

from app.config import Settings
from app.pipeline.lpr import LprPipeline


def _lpr() -> LprPipeline:
    return LprPipeline(Settings(_env_file=None))


def test_normalize_valid_car_plate():
    assert LprPipeline.normalize_plate("abc-123") == "ABC123"
    assert LprPipeline.normalize_plate("ABC 123") == "ABC123"


def test_normalize_valid_moto_plate():
    assert LprPipeline.normalize_plate("xyz12a") == "XYZ12A"


def test_normalize_rejects_garbage():
    assert LprPipeline.normalize_plate("!!") is None
    assert LprPipeline.normalize_plate("12") is None
    assert LprPipeline.normalize_plate("") is None


def test_read_plate_picks_highest_confidence(monkeypatch):
    lpr = _lpr()
    # Evita la carga real del modelo e inyecta el seam de inferencia.
    lpr.ensure_loaded = lambda: None  # type: ignore[method-assign]
    lpr._run = lambda img: [("abc123", 0.7), ("ABC123", 0.95), ("zzz", 0.99)]  # type: ignore[assignment]
    res = lpr.read_plate(np.zeros((10, 10, 3), dtype=np.uint8))
    assert res is not None
    assert res.text == "ABC123"
    assert res.confidence == 0.95


def test_read_plate_none_when_no_valid(monkeypatch):
    lpr = _lpr()
    lpr.ensure_loaded = lambda: None  # type: ignore[method-assign]
    lpr._run = lambda img: [("!!", 0.9)]  # type: ignore[assignment]
    assert lpr.read_plate(np.zeros((10, 10, 3), dtype=np.uint8)) is None
