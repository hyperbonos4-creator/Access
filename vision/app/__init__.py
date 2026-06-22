"""urban-vision — microservicio de visión por computador de URBAN.

Aísla toda la inferencia pesada (detección, liveness, embeddings, búsqueda 1:N y,
en fase 2, LPR) del backend de dominio NestJS. El backend nunca carga modelos ni
abre RTSP: solo recibe `DomainCameraEvent` y consume esta API de gestión.

Ver `.kiro/specs/facial-access-control/` (Módulo 12).
"""

__version__ = "0.1.0"
