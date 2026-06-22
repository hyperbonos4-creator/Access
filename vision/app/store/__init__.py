"""Vector_Store del Vision_Service (Qdrant).

Aislamiento multi-tenant físico: una colección por `conjunto_id`
(`faces_<conjuntoId>`), métrica coseno (Req 9.1, Property 2). El Backend nunca
ve vectores ni IDs internos; solo recibe el `vector_point_id` opaco (Property 6).
"""
