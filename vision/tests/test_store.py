"""Tests del Vector_Store (tarea 1.4).

Verifican el enrolamiento (upsert), borrado y, sobre todo, el **aislamiento
multi-tenant del padrón** (Property 2): cada conjunto usa su propia colección
`faces_<conjuntoId>` y una búsqueda solo consulta la colección de su conjunto.

Usan un cliente Qdrant falso inyectado: no requieren una instancia real.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings
from app.store.qdrant_store import QdrantStore


class FakeQdrantClient:
    """Cliente Qdrant en memoria, suficiente para el contrato que usa QdrantStore."""

    def __init__(self) -> None:
        # collection_name -> { point_id: {"vector": [...], "payload": {...}} }
        self.collections: dict[str, dict] = {}

    def collection_exists(self, collection_name):  # noqa: ANN001
        return collection_name in self.collections

    def create_collection(self, collection_name, vectors_config):  # noqa: ANN001
        self.collections[collection_name] = {}

    def upsert(self, collection_name, points):  # noqa: ANN001
        for p in points:
            self.collections[collection_name][p.id] = {
                "vector": p.vector,
                "payload": p.payload,
            }

    def delete(self, collection_name, points_selector):  # noqa: ANN001
        col = self.collections.get(collection_name, {})
        # PointIdsList expone `.points`; FilterSelector expone `.filter`.
        ids = getattr(points_selector, "points", None)
        if ids is not None:
            for pid in ids:
                col.pop(pid, None)
            return
        # Borrado por filtro de subject_id (revocación / supresión).
        flt = getattr(points_selector, "filter", None)
        subject = flt.must[0].match.value if flt else None
        for pid in [k for k, v in col.items() if v["payload"].get("subject_id") == subject]:
            col.pop(pid, None)

    def search(self, collection_name, query_vector, limit):  # noqa: ANN001
        col = self.collections.get(collection_name, {})
        results = []
        for pid, data in col.items():
            score = float(np.dot(query_vector, data["vector"]))
            obj = type("Hit", (), {"payload": data["payload"], "score": score})
            results.append(obj)
        results.sort(key=lambda h: h.score, reverse=True)
        return results[:limit]

    def get_collections(self):
        return list(self.collections.keys())


@pytest.fixture
def store() -> QdrantStore:
    s = QdrantStore(Settings(_env_file=None))
    s._client = FakeQdrantClient()  # inyección del doble (evita red)
    return s


def _vec(seed: float) -> np.ndarray:
    v = np.full(512, seed, dtype=np.float32)
    return v / np.linalg.norm(v)


def test_collection_name_per_conjunto(store):
    assert store._collection("c1") == "faces_c1"
    assert store._collection("c2") == "faces_c2"


def test_upsert_returns_point_id_and_persists(store):
    pid = store.upsert_template("c1", "subjectA", _vec(1.0))
    assert pid
    assert store._client.collections["faces_c1"][pid]["payload"]["subject_id"] == "subjectA"


def test_isolation_search_only_in_own_collection(store):
    # Mismo embedding enrolado en dos conjuntos distintos.
    store.upsert_template("c1", "subjectA", _vec(1.0))
    store.upsert_template("c2", "intruder", _vec(1.0))

    # Property 2: la búsqueda en c1 jamás devuelve sujetos de c2.
    hits_c1 = store.search("c1", _vec(1.0), limit=5)
    assert [s for s, _ in hits_c1] == ["subjectA"]

    hits_c2 = store.search("c2", _vec(1.0), limit=5)
    assert [s for s, _ in hits_c2] == ["intruder"]


def test_search_missing_collection_returns_empty(store):
    assert store.search("conjunto-inexistente", _vec(1.0)) == []


def test_delete_point(store):
    pid = store.upsert_template("c1", "subjectA", _vec(1.0))
    assert store.delete_point("c1", pid) == 1
    assert pid not in store._client.collections["faces_c1"]


def test_delete_subject_removes_all_templates(store):
    store.upsert_template("c1", "subjectA", _vec(1.0))
    store.upsert_template("c1", "subjectA", _vec(0.5))
    store.upsert_template("c1", "subjectB", _vec(0.2))
    store.delete_subject("c1", "subjectA")
    remaining = {v["payload"]["subject_id"] for v in store._client.collections["faces_c1"].values()}
    assert remaining == {"subjectB"}
