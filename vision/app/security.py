"""Autenticación del canal Backend ↔ Vision_Service (Req 10.1, 10.3).

Esquema simple y robusto: bearer con secreto compartido. El Backend incluye
`Authorization: Bearer <VISION_SERVICE_TOKEN>` en cada llamada de gestión; el
Vision_Service lo verifica con comparación en tiempo constante.

En desarrollo, si `VISION_SERVICE_TOKEN` está vacío, la verificación se omite
(facilita pruebas locales). En producción el arranque exige el token (ver
`main.py: lifespan`).
"""

from __future__ import annotations

import hmac

from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings


def require_service_auth(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """Dependencia FastAPI que valida el bearer del canal de servicio."""
    expected = settings.service_token

    # Dev sin token configurado → se omite (no en producción, ver lifespan).
    if not expected:
        return

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing_or_malformed_authorization",
        )

    provided = authorization.removeprefix("Bearer ").strip()
    # Comparación en tiempo constante para evitar timing attacks.
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_service_token",
        )
