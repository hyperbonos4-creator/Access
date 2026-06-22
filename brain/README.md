# Cerebro VisionYX 🧠

Asistente **local y privado** que conoce todos tus proyectos. Indexa tu código y
documentación, y responde con GLM-5.2 (vía Cloudflare Workers AI) citando archivo
y líneas. Pensado para ti (el fundador), no para clientes.

## Cómo funciona
1. **Indexa** tus proyectos: trocea el código, censura secretos y genera
   embeddings (bge-m3) → `data/index.json` (local).
2. **Pregunta**: tu consulta se convierte en vector, se buscan los fragmentos más
   parecidos y se le pasan a GLM para que responda con citas.

Tu código **no sale de tu máquina** salvo los fragmentos relevantes que se envían
al modelo para responder (con secretos ya censurados).

## Uso
```bash
cd brain
npm run index   # indexa los proyectos de config.json (tarda unos minutos)
npm start       # abre el cerebro en http://127.0.0.1:8799
```

## Configuración (`config.json`)
- `roots`: carpetas de proyectos a indexar.
- `cloudflare`: cuenta, token, modelos (embed + chat).
- Filtros: `excludeDirs`, `includeExt`, `maxChunksTotal`, etc.

## Seguridad
- No indexa `.env`, `*.pem`, `*.key`, ni `node_modules/.git/dist`.
- Censura valores que parezcan secretos (tokens, contraseñas, JWT, cadenas de conexión).
- `config.json` y `data/` están en `.gitignore` (no se suben al repo).

> Cuando termines de probarlo, rota el token de Cloudflare y actualízalo en `config.json`.
