"""OCR de documentos de identidad (KYC) — spec `resident-onboarding-kyc`, K1.

Motor: **RapidOCR** (modelos PP-OCRv4 de PaddleOCR ejecutados sobre el MISMO
onnxruntime ya presente en el servicio). Sin dependencia de PaddlePaddle, 100%
local (Ley 1581), pesos incluidos en el wheel.

Diseño (coherente con el resto del servicio):
- **Carga perezosa** del motor; degradación elegante si el wheel no está (el
  servicio arranca y `/health` lo reporta, igual que el pipeline facial).
- **Seam inyectable** (`_run_ocr`) para testear la extracción de campos sin el
  motor real (los tests pasan líneas OCR sintéticas).
- El Vision_Service SOLO extrae texto/campos crudos + calidad; el **cotejo**
  (`Document_Match`) contra el residente lo hace el Backend (dominio).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from threading import Lock
from typing import List, Optional, Tuple

import numpy as np

from ..config import Settings

logger = logging.getLogger("urban-vision.ocr")


@dataclass
class OcrLine:
    """Una línea reconocida: texto + confianza [0,1]."""

    text: str
    confidence: float


@dataclass
class DocumentFields:
    """Campos estructurados extraídos de un documento de identidad."""

    document_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    # Todas las líneas crudas con su confianza (para auditoría/depuración).
    fields: List[OcrLine] = field(default_factory=list)
    quality: str = "OK"  # OK | NO_DOCUMENT | LOW_QUALITY | GLARE | CROPPED


class OcrNotReadyError(Exception):
    """El motor OCR no pudo cargarse (wheel ausente / provider)."""


# Etiquetas típicas de la cédula colombiana (y genéricas LATAM) que NO son datos.
_LABEL_TOKENS = (
    "REPUBLICA",
    "REPÚBLICA",
    "COLOMBIA",
    "IDENTIFICACION",
    "IDENTIFICACIÓN",
    "PERSONAL",
    "CEDULA",
    "CÉDULA",
    "CIUDADANIA",
    "CIUDADANÍA",
    "NUMERO",
    "NÚMERO",
    "APELLIDOS",
    "NOMBRES",
    "FECHA",
    "NACIMIENTO",
    "LUGAR",
    "SEXO",
    "ESTATURA",
    "G.S.R.H",
    "FIRMA",
    "REGISTRADOR",
    "NACIONAL",
    "DOCUMENTO",
)

# Número de documento: 6–13 dígitos con separadores de miles de punto (no
# espacios, para no fundir una etiqueta adyacente como "NÚMERO" con el valor).
_DOC_NUMBER_RE = re.compile(r"(?<!\d)(\d[\d.]{5,15}\d)(?!\d)")


class DocumentOcr:
    """Lector OCR de documentos, thread-safe y de carga perezosa."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._engine = None  # rapidocr_onnxruntime.RapidOCR (perezoso)
        self._lock = Lock()
        self._load_error: Optional[str] = None

    @property
    def models_loaded(self) -> bool:
        return self._engine is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    # ── Carga perezosa ──────────────────────────────────────────────────
    def ensure_loaded(self) -> None:
        if self._engine is not None:
            return
        with self._lock:
            if self._engine is not None:
                return
            try:
                from rapidocr_onnxruntime import RapidOCR  # import perezoso

                # RapidOCR usa onnxruntime; en CPU por defecto. Los pesos vienen
                # en el wheel, no requieren descarga externa.
                self._engine = RapidOCR()
                self._load_error = None
                logger.info("Motor OCR (RapidOCR/PP-OCRv4) cargado")
            except Exception as exc:  # noqa: BLE001 — degradación elegante
                self._load_error = str(exc)
                logger.error("No se pudo cargar el OCR: %s", exc)
                raise OcrNotReadyError(str(exc)) from exc

    # ── Inferencia ──────────────────────────────────────────────────────
    def read_lines(self, image_bgr: np.ndarray) -> List[OcrLine]:
        """Devuelve las líneas de texto reconocidas en la imagen."""
        self.ensure_loaded()
        return self._run_ocr(image_bgr)

    def _run_ocr(self, image_bgr: np.ndarray) -> List[OcrLine]:
        """Seam inyectable: ejecuta RapidOCR y normaliza el resultado.

        RapidOCR devuelve `(result, elapse)` donde `result` es una lista de
        `[box, text, score]` (o None si no detecta nada).
        """
        assert self._engine is not None
        result, _ = self._engine(image_bgr)
        if not result:
            return []
        lines: List[OcrLine] = []
        for item in result:
            # item = [box, text, score]
            text = str(item[1]).strip()
            score = float(item[2]) if len(item) > 2 else 0.0
            if text:
                lines.append(OcrLine(text=text, confidence=round(score, 4)))
        return lines

    # ── Extracción de campos (independiente del motor → testeable) ───────
    def extract_fields(
        self,
        front_lines: List[OcrLine],
        back_lines: Optional[List[OcrLine]] = None,
    ) -> DocumentFields:
        """Extrae número de documento, nombres y apellidos (best-effort).

        Heurística para cédula colombiana / documentos LATAM: las etiquetas
        (`APELLIDOS`, `NOMBRES`, `NÚMERO`) preceden a sus valores. El cotejo fino
        contra el residente lo hace el Backend; aquí solo se estructura.
        """
        all_lines = list(front_lines) + list(back_lines or [])
        if not all_lines:
            return DocumentFields(quality="NO_DOCUMENT")

        quality = self._assess_quality(all_lines)
        doc_number = self._extract_document_number(all_lines)
        last_name, first_name = self._extract_names(front_lines or all_lines)

        return DocumentFields(
            document_number=doc_number,
            first_name=first_name,
            last_name=last_name,
            fields=all_lines,
            quality=quality,
        )

    def _assess_quality(self, lines: List[OcrLine]) -> str:
        """Calidad agregada: pocas líneas → CROPPED; confianza baja → LOW_QUALITY."""
        if len(lines) < 3:
            return "CROPPED"
        confidences = [ln.confidence for ln in lines if ln.confidence > 0]
        if confidences:
            avg = sum(confidences) / len(confidences)
            if avg < 0.55:
                return "LOW_QUALITY"
        return "OK"

    def _extract_document_number(self, lines: List[OcrLine]) -> Optional[str]:
        """El número con más dígitos plausible (7–11) tras quitar separadores."""
        best: Optional[str] = None
        best_len = 0
        for ln in lines:
            for m in _DOC_NUMBER_RE.finditer(ln.text):
                digits = re.sub(r"\D", "", m.group(1))
                if 7 <= len(digits) <= 11 and len(digits) > best_len:
                    best = digits
                    best_len = len(digits)
        return best

    def _extract_names(
        self, lines: List[OcrLine]
    ) -> Tuple[Optional[str], Optional[str]]:
        """(apellidos, nombres) por etiqueta; fallback a líneas alfabéticas."""
        texts = [ln.text for ln in lines]
        last_name = self._value_after_label(texts, ("APELLIDOS",))
        first_name = self._value_after_label(texts, ("NOMBRES",))

        if last_name or first_name:
            return last_name, first_name

        # Fallback: líneas en mayúsculas, alfabéticas, que no sean etiquetas.
        candidates = [
            t
            for t in texts
            if self._is_name_like(t) and not self._is_label(t)
        ]
        if len(candidates) >= 2:
            return candidates[0], candidates[1]
        if len(candidates) == 1:
            return candidates[0], None
        return None, None

    def _value_after_label(
        self, texts: List[str], labels: Tuple[str, ...]
    ) -> Optional[str]:
        for i, t in enumerate(texts):
            upper = self._strip_accents(t).upper()
            if any(lbl in upper for lbl in labels):
                # Valor en la misma línea tras la etiqueta…
                for lbl in labels:
                    if lbl in upper:
                        tail = upper.split(lbl, 1)[1].strip(" :.-")
                        if self._is_name_like(tail):
                            return self._titlecase(tail)
                # …o en la siguiente línea de tipo nombre.
                for nxt in texts[i + 1 : i + 3]:
                    if self._is_name_like(nxt) and not self._is_label(nxt):
                        return self._titlecase(nxt)
        return None

    @staticmethod
    def _strip_accents(s: str) -> str:
        import unicodedata

        return "".join(
            c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
        )

    def _is_label(self, text: str) -> bool:
        upper = self._strip_accents(text).upper()
        return any(tok in upper for tok in _LABEL_TOKENS)

    @staticmethod
    def _is_name_like(text: str) -> bool:
        cleaned = text.strip()
        if len(cleaned) < 2:
            return False
        letters = [c for c in cleaned if c.isalpha()]
        return len(letters) >= 2 and len(letters) / len(cleaned) > 0.6

    @staticmethod
    def _titlecase(text: str) -> str:
        return " ".join(w.capitalize() for w in text.split())
