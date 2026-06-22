"""Tests del liveness ACTIVO server-side (ADR facial-liveness §3).

Cubren:
- `headpose`: estimación de yaw y clasificación de acción (funciones puras).
- `ActiveLivenessService` con dobles (sin modelos reales).
- Contrato HTTP de `/liveness/active` (override de get_active_liveness).

No requieren modelos ONNX ni Qdrant.
"""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.active_liveness import ActiveLivenessService
from app.main import app, get_active_liveness
from app.pipeline.facade import FaceDetection
from app.pipeline.headpose import (
    classify_action,
    estimate_yaw_ratio,
    is_centered,
    is_turned,
)


def _img_b64() -> str:
    img = (np.random.rand(48, 48, 3) * 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode("ascii")


# Keypoints sintéticos: [ojo_izq, ojo_der, nariz, boca_izq, boca_der].
def _kps(nose_x: float) -> np.ndarray:
    return np.array(
        [[30, 40], [70, 40], [nose_x, 60], [40, 80], [60, 80]], dtype=np.float32
    )


# ── headpose (puro) ──────────────────────────────────────────────────────────


def test_estimate_yaw_centered_is_near_zero():
    # nariz en el punto medio de los ojos (x=50) → ratio ~0
    ratio = estimate_yaw_ratio(_kps(50))
    assert ratio is not None and abs(ratio) < 1e-6


def test_estimate_yaw_none_without_keypoints():
    assert estimate_yaw_ratio(None) is None


def test_centered_vs_turned_bands():
    centered = estimate_yaw_ratio(_kps(50))
    turned = estimate_yaw_ratio(_kps(85))  # nariz desplazada hacia el ojo derecho
    assert is_centered(centered) is True
    assert is_turned(centered) is False
    assert is_turned(turned) is True
    assert is_centered(turned) is False


def test_classify_action_requires_face():
    assert classify_action("LOOK_CENTER", 0.0, has_face=False) is False


def test_classify_center_and_movement():
    assert classify_action("LOOK_CENTER", 0.0, has_face=True) is True
    assert classify_action("LOOK_CENTER", 0.5, has_face=True) is False
    assert classify_action("LOOK_LEFT", -0.4, has_face=True) is True
    assert classify_action("LOOK_RIGHT", 0.4, has_face=True) is True
    assert classify_action("LOOK_LEFT", 0.0, has_face=True) is False


def test_classify_blink_satisfied_with_face():
    # El parpadeo no es verificable server-side en un frame estático.
    assert classify_action("BLINK", 0.0, has_face=True) is True
    assert classify_action("BLINK", None, has_face=False) is False


# ── ActiveLivenessService con dobles ─────────────────────────────────────────


class _Face:
    def __init__(self, nose_x):
        self.embedding = np.zeros(512, dtype=np.float32)
        self.bbox = (0, 0, 100, 100)
        self.quality = 0.9
        self.keypoints = _kps(nose_x)


class FakePipeline:
    def __init__(self, faces):
        self._faces = list(faces)

    def primary_face(self, image_bgr):
        return self._faces.pop(0) if self._faces else None


class FakeLiveness:
    def __init__(self, score=0.95, raises=False):
        self._score = score
        self._raises = raises

    def score(self, image_bgr, bbox):
        if self._raises:
            raise RuntimeError("model_missing")
        return self._score


def _frames(n):
    return [np.zeros((10, 10, 3), np.uint8) for _ in range(n)]


def test_service_accepts_valid_sequence():
    # LOOK_LEFT (nariz a la izquierda), BLINK (frontal), LOOK_CENTER (frontal)
    svc = ActiveLivenessService(
        FakePipeline([_Face(15), _Face(50), _Face(50)]), FakeLiveness(0.9)
    )
    res = svc.verify(_frames(3), ["LOOK_LEFT", "BLINK", "LOOK_CENTER"])
    assert res.ok is True
    assert [o.satisfied for o in res.observed] == [True, True, True]
    assert res.passive_available is True
    assert res.passive_score == 0.9


def test_service_rejects_when_center_not_centered():
    # La acción CENTER recibe una cara girada → no satisface.
    svc = ActiveLivenessService(FakePipeline([_Face(85)]), FakeLiveness())
    res = svc.verify(_frames(1), ["LOOK_CENTER"])
    assert res.ok is False
    assert res.reason == "ACTION_FAILED"


def test_service_no_face_is_failsecure():
    svc = ActiveLivenessService(FakePipeline([None]), FakeLiveness())
    res = svc.verify(_frames(1), ["LOOK_CENTER"])
    assert res.ok is False
    assert res.reason == "NO_FACE"


def test_service_passive_unavailable_flagged():
    svc = ActiveLivenessService(FakePipeline([_Face(50)]), FakeLiveness(raises=True))
    res = svc.verify(_frames(1), ["LOOK_CENTER"])
    # La acción se cumple, pero el pasivo no estuvo disponible (lo decide el Backend).
    assert res.observed[0].satisfied is True
    assert res.passive_available is False
    assert res.passive_score == 0.0


def test_service_frame_count_mismatch():
    svc = ActiveLivenessService(FakePipeline([]), FakeLiveness())
    res = svc.verify(_frames(2), ["LOOK_CENTER"])
    assert res.ok is False
    assert res.reason == "FRAME_COUNT_MISMATCH"


def test_service_passive_is_minimum_across_frames():
    svc = ActiveLivenessService(
        FakePipeline([_Face(15), _Face(50)]),
        # dos frames con scores distintos
        _VaryingLiveness([0.8, 0.6]),
    )
    res = svc.verify(_frames(2), ["LOOK_LEFT", "LOOK_CENTER"])
    assert res.passive_score == 0.6  # el más débil manda (fail-secure)


class _VaryingLiveness:
    def __init__(self, scores):
        self._scores = list(scores)

    def score(self, image_bgr, bbox):
        return self._scores.pop(0)


# ── Contrato HTTP ─────────────────────────────────────────────────────────────


class StubActive:
    def verify(self, frames, actions):
        from app.active_liveness import ActionObservation, ActiveLivenessResult

        return ActiveLivenessResult(
            ok=True,
            observed=[ActionObservation(action=a, satisfied=True) for a in actions],
            passive_score=0.91,
            passive_available=True,
            reason=None,
        )


@pytest.fixture
def active_client():
    app.dependency_overrides[get_active_liveness] = lambda: StubActive()
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_active_endpoint_ok(active_client):
    res = active_client.post(
        "/liveness/active",
        json={
            "conjunto_id": "c1",
            "frames_b64": [_img_b64(), _img_b64()],
            "actions": ["LOOK_LEFT", "LOOK_CENTER"],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["passive_score"] == 0.91
    assert [o["action"] for o in body["observed"]] == ["LOOK_LEFT", "LOOK_CENTER"]


def test_active_endpoint_length_mismatch(active_client):
    res = active_client.post(
        "/liveness/active",
        json={
            "conjunto_id": "c1",
            "frames_b64": [_img_b64()],
            "actions": ["LOOK_LEFT", "LOOK_CENTER"],
        },
    )
    assert res.status_code == 422
