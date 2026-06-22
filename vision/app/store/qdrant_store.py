"""Cliente del Vector_Store (Qdrant) con aislamiento por conjunto.

Una colección por `conjunto_id` (`faces_<conjuntoId>`), creada perezosamente la
primera vez que se enrola en ese conjunto. La búsqueda 1:N (G1) consulta
exclusivamente la colección del conjunto del Access_Point (Property 2).

Operaciones expuestas:
- `upsert_template(conjunto, subject, embedding) -> point_id`  (enrolamiento)
- `delete_point(conjunto, point_id) -> n`                      (borrado de plantilla)
- `delete_subject(conjunto, subject) -> n`                     (supresión / revocación)
- `search(conjunto, embedding, limit)`                         (búsqueda 1:N — G1)
- `health() -> bool`
"""

from __future__ import annotations

import logging
import uuid
from typing import List, Optional, Tuple

import numpy as np

from ..config import Settings

logger = logging.getLogger("urban-vision.store")


class QdrantStore:
    """Envoltura delgada de qdrant-client con colección por conjunto."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = None  # qdrant_client.QdrantClient (perezoso)
        # Colecciones cuya existencia ya confirmamos: evita un round-trip
        # `collection_exists` a Qdrant en CADA reconocimiento (el camino caliente
        # del kiosko). Una colección nunca se elimina en runtime (solo se borran
        # puntos), así que el cache no se invalida.
        self._known_collections: set[str] = set()

    # ── Conexión perezosa ───────────────────────────────────────────────
    def _ensure_client(self):
        if self._client is None:
            from qdrant_client import QdrantClient

            self._client = QdrantClient(
                url=self._settings.qdrant_url,
                api_key=self._settings.qdrant_api_key or None,
                timeout=5.0,
            )
        return self._client

    def _collection(self, conjunto_id: str) -> str:
        return f"{self._settings.qdrant_collection_prefix}{conjunto_id}"

    @staticmethod
    def _is_missing_collection(exc: Exception) -> bool:
        """True si el error de Qdrant indica 'la colección no existe' (404).

        Defensa ante una caché desincronizada: si una colección se elimina por
        fuera del servicio (p. ej. directamente en Qdrant), el cache local
        `_known_collections` puede quedar obsoleto. Detectamos ese 404 para
        autocurarnos (recrear/ignorar) en vez de propagar un 500.
        """
        if getattr(exc, "status_code", None) == 404:
            return True
        msg = str(exc).lower()
        return "doesn't exist" in msg or "not found" in msg

    def _ensure_collection(self, conjunto_id: str) -> str:
        """Crea la colección del conjunto si no existe (coseno, dim configurada)."""
        from qdrant_client.models import Distance, VectorParams

        client = self._ensure_client()
        name = self._collection(conjunto_id)
        if name in self._known_collections:
            return name
        if not client.collection_exists(name):
            client.create_collection(
                collection_name=name,
                vectors_config=VectorParams(
                    size=self._settings.embedding_dim, distance=Distance.COSINE
                ),
            )
            logger.info("Colección creada: %s", name)
        self._known_collections.add(name)
        return name

    # ── Escritura ────────────────────────────────────────────────────────
    def upsert_template(
        self, conjunto_id: str, subject_id: str, embedding: np.ndarray
    ) -> str:
        """Inserta el embedding y devuelve el `vector_point_id` opaco."""
        from qdrant_client.models import PointStruct

        client = self._ensure_client()
        name = self._ensure_collection(conjunto_id)
        point_id = str(uuid.uuid4())
        point = PointStruct(
            id=point_id,
            vector=embedding.tolist(),
            payload={"subject_id": subject_id},
        )
        try:
            client.upsert(collection_name=name, points=[point])
        except Exception as exc:  # noqa: BLE001
            if not self._is_missing_collection(exc):
                raise
            # Caché desincronizada (la colección se borró por fuera): la
            # invalidamos, la recreamos y reintentamos una sola vez.
            logger.warning(
                "Colección %s ausente al enrolar; recreando y reintentando.", name
            )
            self._known_collections.discard(name)
            name = self._ensure_collection(conjunto_id)
            client.upsert(collection_name=name, points=[point])
        return point_id

    # ── Borrado (Req 3.2, 3.5) ─────────────────────────────────────────────
    def delete_point(self, conjunto_id: str, point_id: str) -> int:
        from qdrant_client.models import PointIdsList

        client = self._ensure_client()
        name = self._collection(conjunto_id)
        if not client.collection_exists(name):
            return 0
        client.delete(collection_name=name, points_selector=PointIdsList(points=[point_id]))
        return 1

    def delete_subject(self, conjunto_id: str, subject_id: str) -> int:
        """Borra todos los puntos de un sujeto (revocación / derecho de supresión)."""
        from qdrant_client.models import (
            FieldCondition,
            Filter,
            FilterSelector,
            MatchValue,
        )

        client = self._ensure_client()
        name = self._collection(conjunto_id)
        if not client.collection_exists(name):
            return 0
        flt = Filter(
            must=[FieldCondition(key="subject_id", match=MatchValue(value=subject_id))]
        )
        client.delete(collection_name=name, points_selector=FilterSelector(filter=flt))
        return 1

    def drop_collection(self, conjunto_id: str) -> bool:
        """Elimina por completo la colección del conjunto (autodestrucción de un
        demo efímero). Idempotente: si no existe, no hace nada. Reclama el
        almacenamiento del Vector_Store por completo."""
        client = self._ensure_client()
        name = self._collection(conjunto_id)
        existed = client.collection_exists(name)
        if existed:
            client.delete_collection(collection_name=name)
        self._known_collections.discard(name)
        return existed

    # ── Búsqueda 1:N (se usa en G1) ────────────────────────────────────────
    def search(
        self, conjunto_id: str, embedding: np.ndarray, limit: int = 1
    ) -> List[Tuple[str, float]]:
        """Devuelve [(subject_id, score)] dentro de la colección del conjunto."""
        client = self._ensure_client()
        name = self._collection(conjunto_id)
        if name not in self._known_collections:
            if not client.collection_exists(name):
                return []
            self._known_collections.add(name)
        try:
            hits = client.search(
                collection_name=name, query_vector=embedding.tolist(), limit=limit
            )
        except Exception as exc:  # noqa: BLE001
            if not self._is_missing_collection(exc):
                raise
            # La colección se borró por fuera y el cache estaba obsoleto: no hay
            # plantillas que coincidir → 1:N vacío (en vez de propagar un 500).
            logger.warning(
                "Colección %s ausente al buscar; cache invalidado, 0 coincidencias.",
                name,
            )
            self._known_collections.discard(name)
            return []
        return [(h.payload.get("subject_id", "unknown"), float(h.score)) for h in hits]

    # ── Salud ──────────────────────────────────────────────────────────────
    def health(self) -> bool:
        try:
            self._ensure_client().get_collections()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Qdrant no disponible: %s", exc)
            return False
