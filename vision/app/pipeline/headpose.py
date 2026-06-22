"""Estimación de pose de cabeza para liveness ACTIVO — funciones PURAS.

Revalidación server-side (coarse) del reto de liveness (ADR
`facial-liveness-architecture` §3). El cliente (Flutter + MediaPipe) hace la
verificación fina on-device; el servidor NO confía en ese veredicto y aquí
comprueba, de forma independiente y barata, que:

- En los frames de movimiento la cabeza está claramente girada.
- En el frame `LOOK_CENTER` la cabeza está centrada (frame frontal limpio).

Usa los 5 keypoints de InsightFace (SCRFD): [ojo_izq, ojo_der, nariz,
boca_izq, boca_der] en coordenadas de imagen. El `yaw_ratio` es el
desplazamiento horizontal de la nariz respecto al punto medio de los ojos,
normalizado por la distancia interocular → invariante a escala.

Convención de signo (imagen tal cual la entrega la cámara): `yaw_ratio > 0`
nariz hacia el ojo derecho de la imagen. El emparejamiento de dirección tolera
el espejado de la cámara frontal priorizando la MAGNITUD del giro (el valor
anti-spoof real es "hubo giro vs. estuvo centrado"); la dirección fina la
garantiza el cliente.
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

# Bandas con histéresis: dentro de CENTER_BAND = centrado; más allá de
# MOVE_BAND = giro claro. La zona intermedia es ambigua (no se da por válida).
# El cliente exige un giro mucho más marcado (≈0.42) antes de capturar, así que
# este umbral solo aporta margen ante la diferencia de escala entre la métrica
# del cliente (MediaPipe/iris) y la del servidor (InsightFace/keypoints).
CENTER_BAND = 0.12
MOVE_BAND = 0.15


def estimate_yaw_ratio(keypoints: Optional[Sequence[Sequence[float]]]) -> Optional[float]:
    """Desplazamiento horizontal nariz↔ojos normalizado por la distancia
    interocular. `None` si no hay keypoints utilizables."""
    if keypoints is None:
        return None
    kp = np.asarray(keypoints, dtype=np.float32)
    if kp.shape[0] < 3:
        return None
    eye_l, eye_r, nose = kp[0], kp[1], kp[2]
    eyes_mid_x = (eye_l[0] + eye_r[0]) / 2.0
    inter_ocular = float(np.hypot(eye_r[0] - eye_l[0], eye_r[1] - eye_l[1]))
    if inter_ocular <= 1e-6:
        return None
    return float((nose[0] - eyes_mid_x) / inter_ocular)


def is_centered(yaw_ratio: Optional[float]) -> bool:
    return yaw_ratio is not None and abs(yaw_ratio) <= CENTER_BAND


def is_turned(yaw_ratio: Optional[float]) -> bool:
    return yaw_ratio is not None and abs(yaw_ratio) >= MOVE_BAND


def classify_action(action: str, yaw_ratio: Optional[float], has_face: bool) -> bool:
    """¿El frame satisface la acción pedida? (revalidación coarse server-side).

    - Sin rostro → nunca satisface (fail-secure).
    - `LOOK_CENTER` → cabeza centrada.
    - `LOOK_LEFT` / `LOOK_RIGHT` → cabeza claramente girada (magnitud; la
      dirección fina la valida el cliente con MediaPipe).
    - `BLINK` → no es verificable de forma fiable en un frame estático
      server-side; se da por satisfecha si hay un rostro presente (la prueba
      temporal del parpadeo es on-device).
    """
    if not has_face:
        return False
    if action == "LOOK_CENTER":
        return is_centered(yaw_ratio)
    if action in ("LOOK_LEFT", "LOOK_RIGHT"):
        return is_turned(yaw_ratio)
    if action == "BLINK":
        return True
    return False
