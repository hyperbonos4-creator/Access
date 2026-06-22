"""Tests de configuración refinada (Environment, dim derivada, tamaño máx)."""

from __future__ import annotations

from app.config import EmbeddingModel, Environment, ExecutionProvider, Settings


def _settings(**kw):
    return Settings(_env_file=None, **kw)


def test_env_is_enum_and_is_production():
    assert _settings(env="production").is_production is True
    assert _settings(env="development").is_production is False
    assert _settings(env="staging").env is Environment.STAGING


def test_embedding_dim_is_derived_from_model_not_env():
    # No es configurable por env: se deriva del modelo (evita romper Qdrant).
    assert _settings(embedding_model="arcface").embedding_dim == 512
    assert _settings(embedding_model="adaface").embedding_dim == 512


def test_max_image_bytes_from_mb():
    s = _settings(max_image_size_mb=2)
    assert s.max_image_bytes == 2 * 1024 * 1024


def test_provider_fallback_includes_cpu():
    assert ExecutionProvider.CUDA.to_ort_providers()[-1] == "CPUExecutionProvider"
    assert ExecutionProvider.TENSORRT.to_ort_providers()[-1] == "CPUExecutionProvider"


def test_embedding_model_enum_values():
    assert EmbeddingModel.ARCFACE.value == "arcface"
