"""Tests del EventEmitter y la firma de eventos (tarea 2.2)."""

from __future__ import annotations

from app.config import Settings
from app.emitter import (
    EventEmitter,
    InMemoryTransport,
    canonical_body,
    sign_payload,
)


def _settings(token="secreto-test"):
    return Settings(_env_file=None, service_token=token)


def test_canonical_body_is_sorted_and_compact():
    body = canonical_body({"b": 1, "a": 2})
    assert body == b'{"a":2,"b":1}'


def test_sign_payload_is_deterministic():
    body = b'{"a":1}'
    s1 = sign_payload(body, "k")
    s2 = sign_payload(body, "k")
    assert s1 == s2
    assert sign_payload(body, "otra-clave") != s1


def test_emitter_sends_signed_event():
    transport = InMemoryTransport()
    emitter = EventEmitter(_settings(), transport)
    event = {"source": "VISION", "label": "subjectA", "sourceEventId": "x:y:z"}

    emitter.emit(event)

    assert len(transport.sent) == 1
    body, signature = transport.sent[0]
    assert body == canonical_body(event)
    assert signature == sign_payload(body, "secreto-test")


def test_emitter_swallows_transport_errors():
    class BoomTransport:
        def send(self, body, signature):  # noqa: ANN001
            raise RuntimeError("red caida")

    emitter = EventEmitter(_settings(), BoomTransport())
    # No debe propagar: un fallo de envío no tumba el worker.
    emitter.emit({"sourceEventId": "x"})
