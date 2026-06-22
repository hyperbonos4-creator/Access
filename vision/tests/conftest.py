"""Fixtures de test del Vision_Service.

Usan dobles inyectados vía `app.dependency_overrides` para no requerir modelos
ONNX, GPU ni una instancia real de Qdrant en CI.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app, get_pipeline, get_store
from app.pipeline.facade import FaceQualityError, FaceResult


class FakePipeline:
    """Pipeline de prueba: configurable por test."""

    def __init__(self) -> None:
        self.models_loaded = True
        self.load_error = None
        self._next_quality_error: str | None = None

    def fail_next_with(self, reason: str) -> None:
        self._next_quality_error = reason

    def embed_single_face(self, image):  # noqa: ANN001
        if self._next_quality_error:
            reason = self._next_quality_error
            self._next_quality_error = None
            raise FaceQualityError(reason)
        vec = np.ones(512, dtype=np.float32)
        return FaceResult(embedding=vec / np.linalg.norm(vec), quality=0.95)


class FakeStore:
    """Vector_Store en memoria para test (aislado por conjunto)."""

    def __init__(self) -> None:
        self.points: dict[str, dict] = {}
        self.healthy = True

    def upsert_template(self, conjunto_id, subject_id, embedding):  # noqa: ANN001
        pid = f"{conjunto_id}:{subject_id}:{len(self.points)}"
        self.points[pid] = {"conjunto": conjunto_id, "subject": subject_id}
        return pid

    def delete_point(self, conjunto_id, point_id):  # noqa: ANN001
        return 1 if self.points.pop(point_id, None) else 0

    def health(self):
        return self.healthy


@pytest.fixture
def fake_pipeline() -> FakePipeline:
    return FakePipeline()


@pytest.fixture
def fake_store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def client(fake_pipeline, fake_store):
    app.dependency_overrides[get_pipeline] = lambda: fake_pipeline
    app.dependency_overrides[get_store] = lambda: fake_store
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
