"""Emisor de eventos hacia el Backend (tarea 2.2).

Construye el `DomainCameraEvent` firmado y lo entrega por un transporte
conmutable. La preferencia del diseño es **Redis Stream** (hereda backpressure,
ACK y reclaim del `EventBuffer` del Módulo 11); también se soporta webhook HTTP
firmado. El transporte es un seam inyectable: los tests usan uno en memoria.

Seguridad (Req 10.3): cada evento se firma con HMAC-SHA256 usando el
`VISION_SERVICE_TOKEN`; el Backend rechaza eventos sin firma válida.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Protocol

from .config import Settings

logger = logging.getLogger("urban-vision.emitter")


def canonical_body(event: dict) -> bytes:
    """Serialización canónica (claves ordenadas) para firmar de forma estable."""
    return json.dumps(event, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_payload(body: bytes, secret: str) -> str:
    """Firma HMAC-SHA256 en hex del cuerpo canónico."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


class EventTransport(Protocol):
    def send(self, body: bytes, signature: str) -> None: ...


class InMemoryTransport:
    """Transporte de prueba: acumula los envíos."""

    def __init__(self) -> None:
        self.sent: list[tuple[bytes, str]] = []

    def send(self, body: bytes, signature: str) -> None:
        self.sent.append((body, signature))


class RedisStreamTransport:
    """Publica el evento firmado en un Redis Stream (preferido).

    El Backend (`EventBuffer`) lo consume con consumer-group durable. Import
    perezoso de redis para no acoplarlo al arranque ni a los tests.
    """

    def __init__(self, url: str, stream_key: str = "urban:camera-events") -> None:
        self._url = url
        self._stream_key = stream_key
        self._client = None

    def _ensure(self):
        if self._client is None:
            import redis  # import perezoso

            self._client = redis.from_url(self._url)
        return self._client

    def send(self, body: bytes, signature: str) -> None:
        self._ensure().xadd(self._stream_key, {"body": body, "sig": signature})


class HttpWebhookTransport:
    """Entrega el evento firmado por POST al endpoint de ingesta del Backend."""

    def __init__(self, url: str, timeout: float = 3.0) -> None:
        self._url = url
        self._timeout = timeout

    def send(self, body: bytes, signature: str) -> None:
        import httpx  # import perezoso

        httpx.post(
            self._url,
            content=body,
            headers={"Content-Type": "application/json", "X-Vision-Signature": signature},
            timeout=self._timeout,
        )


class EventEmitter:
    """Firma y emite `DomainCameraEvent` por el transporte configurado."""

    def __init__(self, settings: Settings, transport: EventTransport) -> None:
        self._settings = settings
        self._transport = transport

    def emit(self, event: dict) -> None:
        body = canonical_body(event)
        signature = sign_payload(body, self._settings.service_token)
        try:
            self._transport.send(body, signature)
        except Exception as exc:  # noqa: BLE001 — no romper el loop por un envío
            logger.error("Fallo emitiendo evento (%s): %s", event.get("sourceEventId"), exc)
