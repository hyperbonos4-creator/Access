"""Worker de stream por Access_Point (tarea 2.2 — capa de I/O).

Consume el sub-stream RTSP/WebRTC que expone go2rtc, muestrea frames con un
throttle, los pasa al `RecognitionService` y emite el evento resultante con el
`EventEmitter`. Reconexión con backoff exponencial (Req 12.2).

La lógica de reconocimiento (testeable) vive en `recognition.py`; aquí solo está
el lazo de captura (I/O), que se valida en el checkpoint de integración con un
stream real.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from .emitter import EventEmitter
from .recognition import AccessPointContext, RecognitionService

logger = logging.getLogger("urban-vision.worker")


class StreamWorker:
    """Lee un stream y produce eventos de acceso.

    `sample_interval_s` evita procesar cada frame (ahorra GPU): muestrea a un
    ritmo fijo suficiente para detectar a quien se presenta en la puerta.
    """

    def __init__(
        self,
        ctx: AccessPointContext,
        stream_url: str,
        recognition: RecognitionService,
        emitter: EventEmitter,
        sample_interval_s: float = 0.5,
        max_backoff_s: float = 30.0,
    ) -> None:
        self._ctx = ctx
        self._stream_url = stream_url
        self._recognition = recognition
        self._emitter = emitter
        self._sample_interval_s = sample_interval_s
        self._max_backoff_s = max_backoff_s
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    def run(self) -> None:
        """Lazo principal: captura → reconoce → emite, con reconexión."""
        import cv2

        backoff = 1.0
        while not self._stop:
            cap = cv2.VideoCapture(self._stream_url)
            if not cap.isOpened():
                logger.warning(
                    "No se pudo abrir el stream %s; reintento en %.1fs",
                    self._ctx.external_camera_key,
                    backoff,
                )
                time.sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff_s)
                continue

            backoff = 1.0  # conexión recuperada
            last_ts = 0.0
            try:
                while not self._stop:
                    # `grab()` avanza al siguiente frame SIN decodificarlo (barato);
                    # solo `retrieve()` (decodifica) el frame que de verdad vamos a
                    # procesar. Evita gastar CPU decodificando los frames que el
                    # throttle (`sample_interval_s`) descarta.
                    if not cap.grab():
                        logger.info("Stream %s interrumpido; reconectando", self._ctx.external_camera_key)
                        break
                    now = time.monotonic()
                    if now - last_ts < self._sample_interval_s:
                        continue  # frame descartado: nunca se decodificó
                    ok, frame = cap.retrieve()
                    if not ok:
                        continue
                    last_ts = now
                    self._process(frame)
            finally:
                cap.release()

    def _process(self, frame) -> None:  # noqa: ANN001
        try:
            event: Optional[dict] = self._recognition.process_frame(self._ctx, frame)
        except Exception as exc:  # noqa: BLE001 — un frame malo no tumba el worker
            logger.error("Error procesando frame de %s: %s", self._ctx.external_camera_key, exc)
            return
        if event is not None:
            self._emitter.emit(event)
