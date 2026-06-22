# urban-vision — imagen del microservicio de visión (CPU por defecto).
#
# Para GPU NVIDIA (producción), ver README §GPU: se parte de una base CUDA y se
# instala onnxruntime-gpu. Esta imagen base CPU sirve para desarrollo (incluida
# la GPU AMD vía DirectML, que requiere onnxruntime-directml en Windows host).

FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Dependencias de sistema para opencv / insightface (build de onnx).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        build-essential \
        cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app

# Usuario no-root (buenas prácticas de seguridad).
RUN useradd --create-home --uid 10001 vision \
    && mkdir -p /models && chown -R vision:vision /app /models
USER vision

EXPOSE 8200

# Los pesos ONNX se montan/descargan en /models (no van en la imagen ni en git).
VOLUME ["/models"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8200/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
