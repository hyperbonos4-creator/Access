"""Recognition_Pipeline del Vision_Service.

Secuencia (design §Recognition_Pipeline):
    SCRFD (detección) → MiniFASNet (liveness, G1) → align → ArcFace/AdaFace
    (embedding) → Qdrant (búsqueda 1:N).

En G0 se implementan detección y embedding (vía InsightFace) con carga perezosa
y degradación elegante. El liveness (MiniFASNet) llega en G1 (tarea 2.1) y el
LPR (fast-alpr) en G6 (tarea 7.1).
"""
