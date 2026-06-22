"""Tests de la API de gestión (G0).

No requieren modelos ni Qdrant reales (dobles vía conftest). Validan el contrato
HTTP, los rechazos de calidad (Req 2.2) y la confidencialidad (Property 6: el
embedding nunca se devuelve).
"""

from __future__ import annotations

import base64

import cv2
import numpy as np


def _sample_image_b64() -> str:
    """Genera una imagen JPEG pequeña y válida, codificada en base64."""
    img = (np.random.rand(64, 64, 3) * 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode("ascii")


def test_health_ok(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["execution_provider"] == "cpu"
    names = {c["name"] for c in body["components"]}
    assert {"pipeline", "qdrant"} <= names


def test_health_degraded_when_qdrant_down(client, fake_store):
    fake_store.healthy = False
    res = client.get("/health")
    assert res.json()["status"] == "degraded"


def test_metrics(client):
    res = client.get("/metrics")
    assert res.status_code == 200
    assert res.json()["inference_provider"] == "cpu"


def test_enroll_ok_does_not_leak_embedding(client):
    res = client.post(
        "/enroll",
        json={"conjunto_id": "c1", "subject_id": "s1", "image_b64": _sample_image_b64()},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["vector_point_id"]
    # Property 6: ninguna clave del response expone el vector/embedding.
    assert "embedding" not in body and "vector" not in body


def test_enroll_rejects_no_face(client, fake_pipeline):
    fake_pipeline.fail_next_with("NO_FACE")
    res = client.post(
        "/enroll",
        json={"conjunto_id": "c1", "subject_id": "s1", "image_b64": _sample_image_b64()},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["reason"] == "NO_FACE"


def test_enroll_rejects_invalid_base64(client):
    res = client.post(
        "/enroll",
        json={"conjunto_id": "c1", "subject_id": "s1", "image_b64": "%%%not-base64%%%"},
    )
    assert res.status_code == 422


def test_delete_template(client):
    enroll = client.post(
        "/enroll",
        json={"conjunto_id": "c1", "subject_id": "s1", "image_b64": _sample_image_b64()},
    ).json()
    pid = enroll["vector_point_id"]
    res = client.delete(f"/templates/{pid}", params={"conjunto_id": "c1"})
    assert res.status_code == 200
    assert res.json()["deleted"] == 1
