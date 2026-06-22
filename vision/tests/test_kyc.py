"""Tests KYC (spec resident-onboarding-kyc, K1/K2).

Cubren:
- Extracción de campos del documento (`DocumentOcr.extract_fields`) sin motor real.
- `KycService` (liveness/face-match) con dobles.
- Contrato HTTP de `/ocr/document`, `/liveness`, `/face-match` (override de get_kyc).

No requieren modelos ONNX, RapidOCR ni Qdrant reales (Property 4: inferencia local
y sin fuga de datos sensibles — los embeddings/textos nunca se devuelven crudos a
terceros; aquí se valida el contrato).
"""

from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest

from app.kyc import FaceMatchResult, KycService, LivenessResult
from app.main import app, get_kyc
from app.pipeline.facade import FaceDetection
from app.pipeline.ocr import DocumentFields, DocumentOcr, OcrLine
from app.config import get_settings
from fastapi.testclient import TestClient


def _img_b64() -> str:
    img = (np.random.rand(48, 48, 3) * 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode("ascii")


# ── Extracción de campos (motor no requerido) ────────────────────────────────


def _ocr() -> DocumentOcr:
    return DocumentOcr(get_settings())


def test_extract_cedula_colombiana_fields():
    front = [
        OcrLine("REPÚBLICA DE COLOMBIA", 0.99),
        OcrLine("IDENTIFICACIÓN PERSONAL", 0.98),
        OcrLine("CÉDULA DE CIUDADANÍA", 0.98),
        OcrLine("NÚMERO 79.123.456", 0.97),
        OcrLine("APELLIDOS", 0.96),
        OcrLine("GARCIA LOPEZ", 0.95),
        OcrLine("NOMBRES", 0.96),
        OcrLine("JUAN CARLOS", 0.95),
    ]
    fields = _ocr().extract_fields(front)
    assert fields.document_number == "79123456"
    assert fields.last_name == "Garcia Lopez"
    assert fields.first_name == "Juan Carlos"
    assert fields.quality == "OK"


def test_extract_fields_no_document():
    fields = _ocr().extract_fields([])
    assert fields.quality == "NO_DOCUMENT"
    assert fields.document_number is None


def test_extract_fields_cropped_when_few_lines():
    fields = _ocr().extract_fields([OcrLine("12.345.678", 0.9)])
    assert fields.quality == "CROPPED"


def test_extract_fields_low_quality_when_low_confidence():
    lines = [OcrLine("REPUBLICA", 0.3), OcrLine("NUMERO 1234567", 0.2), OcrLine("X Y Z", 0.3)]
    fields = _ocr().extract_fields(lines)
    assert fields.quality == "LOW_QUALITY"


def test_document_number_picks_longest_plausible():
    lines = [
        OcrLine("FECHA 12 01 1990", 0.9),
        OcrLine("1.234.567.890", 0.95),
        OcrLine("SERIE 12", 0.9),
    ]
    fields = _ocr().extract_fields(lines)
    assert fields.document_number == "1234567890"


# ── KycService con dobles ────────────────────────────────────────────────────


class _Face:
    def __init__(self, vec, bbox=(0, 0, 10, 10)):
        self.embedding = np.asarray(vec, dtype=np.float32)
        self.bbox = bbox
        self.quality = 0.9


class FakePipeline:
    def __init__(self, faces):
        self._faces = list(faces)

    def primary_face(self, image_bgr):
        return self._faces.pop(0) if self._faces else None


class FakeLiveness:
    def __init__(self, score=0.9, raises=False):
        self._score = score
        self._raises = raises

    def score(self, image_bgr, bbox):
        if self._raises:
            raise RuntimeError("model_missing")
        return self._score


class FakeOcr:
    def read_lines(self, image_bgr):
        return [OcrLine("NÚMERO 79.123.456", 0.97)]

    def extract_fields(self, front_lines, back_lines=None):
        return DocumentFields(document_number="79123456", quality="OK", fields=front_lines)


def test_liveness_no_face():
    svc = KycService(FakePipeline([None]), FakeLiveness(), FakeOcr())
    res = svc.liveness(np.zeros((10, 10, 3), np.uint8))
    assert res.ok is False and res.reason == "NO_FACE"


def test_liveness_score_passthrough():
    svc = KycService(FakePipeline([_Face([1, 0, 0])]), FakeLiveness(score=0.83), FakeOcr())
    res = svc.liveness(np.zeros((10, 10, 3), np.uint8))
    assert res.ok is True and abs(res.score - 0.83) < 1e-6


def test_liveness_unavailable_is_failsecure_zero():
    svc = KycService(FakePipeline([_Face([1, 0, 0])]), FakeLiveness(raises=True), FakeOcr())
    res = svc.liveness(np.zeros((10, 10, 3), np.uint8))
    assert res.ok is True and res.score == 0.0 and res.reason == "LIVENESS_UNAVAILABLE"


def test_face_match_same_person_high_score():
    same = [1.0, 0.0, 0.0]
    svc = KycService(FakePipeline([_Face(same), _Face(same)]), FakeLiveness(), FakeOcr())
    res = svc.face_match(np.zeros((10, 10, 3), np.uint8), np.zeros((10, 10, 3), np.uint8))
    assert res.ok is True and res.match_score > 0.99


def test_face_match_different_person_low_score():
    svc = KycService(
        FakePipeline([_Face([1.0, 0.0, 0.0]), _Face([0.0, 1.0, 0.0])]),
        FakeLiveness(),
        FakeOcr(),
    )
    res = svc.face_match(np.zeros((10, 10, 3), np.uint8), np.zeros((10, 10, 3), np.uint8))
    assert res.ok is True and res.match_score < 0.5


def test_face_match_no_face_in_selfie():
    svc = KycService(FakePipeline([None]), FakeLiveness(), FakeOcr())
    res = svc.face_match(np.zeros((10, 10, 3), np.uint8), np.zeros((10, 10, 3), np.uint8))
    assert res.ok is False and res.reason == "NO_FACE_SELFIE"


# ── Contrato HTTP (override de get_kyc) ───────────────────────────────────────


class StubKyc:
    def ocr_document(self, front_bgr, back_bgr=None):
        return DocumentFields(
            document_number="79123456",
            first_name="Juan",
            last_name="Garcia",
            fields=[OcrLine("NÚMERO 79.123.456", 0.97)],
            quality="OK",
        )

    def liveness(self, image_bgr, mode="PASSIVE"):
        return LivenessResult(ok=True, score=0.88)

    def face_match(self, selfie_bgr, document_bgr):
        return FaceMatchResult(ok=True, match_score=0.71)


@pytest.fixture
def kyc_client():
    app.dependency_overrides[get_kyc] = lambda: StubKyc()
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_ocr_endpoint(kyc_client):
    res = kyc_client.post(
        "/ocr/document", json={"conjunto_id": "c1", "front_b64": _img_b64()}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["document_number"] == "79123456"
    assert body["quality"] == "OK"


def test_liveness_endpoint(kyc_client):
    res = kyc_client.post(
        "/liveness", json={"conjunto_id": "c1", "image_b64": _img_b64()}
    )
    assert res.status_code == 200
    assert res.json()["score"] == 0.88


def test_face_match_endpoint(kyc_client):
    res = kyc_client.post(
        "/face-match",
        json={"conjunto_id": "c1", "selfie_b64": _img_b64(), "document_b64": _img_b64()},
    )
    assert res.status_code == 200
    assert res.json()["match_score"] == 0.71


def test_ocr_endpoint_rejects_invalid_base64(kyc_client):
    res = kyc_client.post(
        "/ocr/document", json={"conjunto_id": "c1", "front_b64": "%%%bad%%%"}
    )
    assert res.status_code == 422
