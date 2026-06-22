"""Tests del RecognitionService (tarea 2.2).

Validan el contrato del `DomainCameraEvent`, el umbral de match (identificado vs
`unknown`) y el comportamiento fail-secure del liveness (si falla, score=0.0).
Usan dobles: no requieren modelos ni Qdrant.
"""

from __future__ import annotations

import numpy as np

from app.pipeline.facade import FaceDetection
from app.recognition import AccessPointContext, RecognitionService


class FakePipeline:
    def __init__(self, face=None):
        self._face = face

    def primary_face(self, image_bgr):  # noqa: ANN001
        return self._face


class FakeStore:
    def __init__(self, hits):
        self._hits = hits

    def search(self, conjunto_id, embedding, limit=1):  # noqa: ANN001
        return self._hits


class FakeLiveness:
    def __init__(self, value=0.9, raises=False):
        self._value = value
        self._raises = raises

    def score(self, image_bgr, bbox):  # noqa: ANN001
        if self._raises:
            raise RuntimeError("modelo no disponible")
        return self._value


def _img():
    return np.zeros((480, 640, 3), dtype=np.uint8)


def _face():
    return FaceDetection(embedding=np.ones(512, dtype=np.float32), bbox=(10, 20, 100, 120), quality=0.99)


def _ctx():
    return AccessPointContext(conjunto_id="c1", external_camera_key="puerta-lobby", match_threshold=0.5)


def test_no_face_returns_none():
    svc = RecognitionService(FakePipeline(face=None), FakeStore([]), FakeLiveness())
    assert svc.process_frame(_ctx(), _img()) is None


def test_identified_when_match_above_threshold():
    svc = RecognitionService(FakePipeline(_face()), FakeStore([("subjectA", 0.82)]), FakeLiveness(0.95))
    ev = svc.process_frame(_ctx(), _img())
    assert ev["source"] == "VISION"
    assert ev["processorType"] == "FACE"
    assert ev["eventType"] == "ALERT"
    assert ev["label"] == "subjectA"
    assert ev["score"] == 0.82
    assert ev["detection"]["livenessScore"] == 0.95
    assert ev["detection"]["bbox"] == [10, 20, 100, 120]
    assert ev["externalCameraKey"] == "puerta-lobby"


def test_unknown_when_match_below_threshold():
    svc = RecognitionService(FakePipeline(_face()), FakeStore([("subjectA", 0.30)]), FakeLiveness(0.95))
    ev = svc.process_frame(_ctx(), _img())
    assert ev["label"] == "unknown"


def test_unknown_when_no_hits():
    svc = RecognitionService(FakePipeline(_face()), FakeStore([]), FakeLiveness(0.95))
    ev = svc.process_frame(_ctx(), _img())
    assert ev["label"] == "unknown"
    assert ev["score"] == 0.0


def test_liveness_failure_is_fail_secure_zero():
    # Si el liveness no está disponible, score=0.0 (nunca asumir "vivo").
    svc = RecognitionService(FakePipeline(_face()), FakeStore([("subjectA", 0.9)]), FakeLiveness(raises=True))
    ev = svc.process_frame(_ctx(), _img())
    assert ev["detection"]["livenessScore"] == 0.0


def test_source_event_id_is_stable_per_track_and_ts():
    from datetime import datetime, timezone

    ts = datetime(2026, 6, 9, 12, 0, 0, tzinfo=timezone.utc)
    svc = RecognitionService(FakePipeline(_face()), FakeStore([("subjectA", 0.9)]), FakeLiveness(0.9))
    a = svc.process_frame(_ctx(), _img(), track_id="t1", recorded_at=ts)
    b = svc.process_frame(_ctx(), _img(), track_id="t1", recorded_at=ts)
    assert a["sourceEventId"] == b["sourceEventId"]  # idempotencia (Property 5)
