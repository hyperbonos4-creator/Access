"""Exporta los pesos de Silent-Face (MiniFASNet) a ONNX para el liveness pasivo.

Genera en /models:
  - minifasnet_v2.onnx     (de 2.7_80x80_MiniFASNetV2.pth,   crop scale 2.7)
  - minifasnet_v1se.onnx   (de 4_0_0_80x80_MiniFASNetV1SE.pth, crop scale 4.0)

El wrapper divide la entrada por 255 DENTRO del grafo ONNX para que coincida con
el preprocesado del servicio (`liveness.py` alimenta BGR en rango 0–255 sin
normalizar). Salida = 3 logits (spoof2D / real / spoof3D); el servicio aplica
softmax y toma la prob. de la clase `real`.
"""
import os
import sys

import torch
import torch.nn as nn

REPO = "/repo"
sys.path.insert(0, REPO)

from src.model_lib.MiniFASNet import (  # noqa: E402
    MiniFASNetV1,
    MiniFASNetV1SE,
    MiniFASNetV2,
    MiniFASNetV2SE,
)
from src.utility import get_kernel, parse_model_name  # noqa: E402

MODEL_MAPPING = {
    "MiniFASNetV1": MiniFASNetV1,
    "MiniFASNetV2": MiniFASNetV2,
    "MiniFASNetV1SE": MiniFASNetV1SE,
    "MiniFASNetV2SE": MiniFASNetV2SE,
}

OUT = {
    "2.7_80x80_MiniFASNetV2.pth": "minifasnet_v2.onnx",
    "4_0_0_80x80_MiniFASNetV1SE.pth": "minifasnet_v1se.onnx",
}


class Wrap(nn.Module):
    """Normaliza 0–255 → 0–1 dentro del grafo (paridad con el servicio)."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x / 255.0)


def main() -> None:
    ckpt_dir = os.path.join(REPO, "resources", "anti_spoof_models")
    os.makedirs("/models", exist_ok=True)
    for fname, outname in OUT.items():
        path = os.path.join(ckpt_dir, fname)
        if not os.path.exists(path):
            raise FileNotFoundError(f"no se encontró el peso: {path}")
        h, w, model_type, scale = parse_model_name(fname)
        kernel = get_kernel(h, w)
        model = MODEL_MAPPING[model_type](conv6_kernel=kernel).to("cpu")
        state = torch.load(path, map_location="cpu")
        keys = list(state.keys())
        if keys and keys[0].startswith("module."):
            state = {k[7:]: v for k, v in state.items()}
        model.load_state_dict(state)
        model.eval()

        wrap = Wrap(model).eval()
        dummy = torch.randn(1, 3, h, w)
        out_path = os.path.join("/models", outname)
        torch.onnx.export(
            wrap,
            dummy,
            out_path,
            input_names=["input"],
            output_names=["logits"],
            opset_version=11,
        )
        print(f"EXPORTED {out_path}  <-  {fname}  input=({h},{w}) type={model_type} scale={scale}")
    print("DONE")


if __name__ == "__main__":
    main()
