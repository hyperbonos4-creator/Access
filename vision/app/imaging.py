"""Utilidades de imagen para el Vision_Service."""

from __future__ import annotations

import base64
import binascii

import numpy as np


class ImageDecodeError(Exception):
    """No se pudo decodificar la imagen recibida."""


def decode_base64_image_bgr(image_b64: str) -> np.ndarray:
    """Decodifica una imagen base64 (con o sin prefijo data URL) a BGR (OpenCV).

    Lanza `ImageDecodeError` si el contenido no es una imagen válida, para que
    el endpoint responda 422 en vez de un 500 opaco.
    """
    import cv2

    raw = image_b64.strip()
    if raw.startswith("data:"):
        # data:image/jpeg;base64,XXXX
        _, _, raw = raw.partition(",")

    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageDecodeError("base64_invalido") from exc

    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageDecodeError("imagen_no_decodificable")
    return image
