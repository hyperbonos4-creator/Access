// VisionYX Brain — servidor local (127.0.0.1). Carga el índice, recupera los
// fragmentos relevantes a tu pregunta y le pide a GLM una respuesta con citas.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, embed, chat, cosine } from './lib.mjs';
import { TOOL_SCHEMAS, execTool } from './tools.mjs';
import * as usage from './usage.mjs';

const cfg = loadConfig();
if (!fs.existsSync(cfg._indexFile)) {
  console.error('No hay índice. Ejecuta primero:  npm run index');
  process.exit(1);
}
console.log('Cargando índice…');
const index = JSON.parse(fs.readFileSync(cfg._indexFile, 'utf8'));
console.log(`Índice: ${index.count} fragmentos de ${new Set(index.chunks.map((c) => c.project)).size} proyectos.`);

const UI = fs.readFileSync(path.join(cfg._here, 'ui.html'), 'utf8');
const ACCESS_TOKEN = process.env.BRAIN_TOKEN || cfg.accessToken || '';
if (ACCESS_TOKEN) console.log('🔒 Acceso protegido por clave (BRAIN_TOKEN).');

const SYSTEM = [
  'Eres el "Cerebro VisionYX", el asistente técnico interno y privado del fundador.',
  'Conoces todos sus proyectos por los FRAGMENTOS recuperados, y además tienes HERRAMIENTAS',
  'con control total de archivos SOBRE LA CARPETA "access" (leer, buscar, escribir, crear,',
  'editar y borrar). Solo access; no puedes salir de ahí ni ejecutar comandos.',
  '',
  'REGLAS ESTRICTAS:',
  '- Responde ÚNICAMENTE lo que el usuario pide. Nada que no haya pedido. Sin relleno.',
  '- Si es un saludo, responde en una frase. No enumeres proyectos ni archivos.',
  '- Usa las HERRAMIENTAS cuando la tarea lo requiera:',
  '  • Para leer/encontrar algo en access: leer_archivo / buscar_en_codigo / listar_archivos.',
  '  • Para crear/editar/borrar en access: crear_archivo / escribir_archivo / borrar_archivo.',
  '- Antes de editar un archivo existente, léelo para no romperlo. Tras escribir, confirma en una',
  '  línea qué hiciste (ruta + acción). No vuelques el contenido completo salvo que lo pidan.',
  '- Los FRAGMENTOS recuperados son contexto; no los resumas ni los listes. Úsalos en silencio.',
  '- Cita una fuente (proyecto/ruta:líneas) solo si la usaste. Secretos [REDACTED]: no los inventes.',
  '- Español técnico de Colombia, conciso.',
].join('\n');

function topK(qVec, k) {
  const scored = index.chunks.map((c) => ({ c, s: cosine(qVec, c.vector) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.c);
}

function buildContext(chunks) {
  return chunks
    .map((c) => `### ${c.file}:${c.startLine}-${c.endLine}\n${c.text}`)
    .join('\n\n---\n\n');
}

async function ask(question, history) {
  const acc = { chatCalls: 0, promptTokens: 0, completionTokens: 0, embedCalls: 1, embedItems: 1 };
  const [qVec] = await embed(cfg, [question]);
  const hits = topK(qVec, cfg.topK);
  const context = buildContext(hits);
  const messages = [
    { role: 'system', content: SYSTEM },
    ...(history || []).slice(-4).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) })),
    {
      role: 'user',
      content:
        `CONTEXTO RECUPERADO (úsalo solo si aplica, no lo resumas):\n\n${context}\n\n` +
        `─────────\nPETICIÓN DEL USUARIO: ${question}\n\n` +
        'Responde solo a eso. Usa las herramientas de archivo (access) si la tarea lo requiere.',
    },
  ];

  const usedTools = [];
  const tally = (m) => { acc.chatCalls++; acc.promptTokens += m.usage?.prompt || 0; acc.completionTokens += m.usage?.completion || 0; };
  try {
    for (let round = 0; round < 6; round++) {
      const m = await chat(cfg, messages, { maxTokens: cfg.maxTokens, tools: TOOL_SCHEMAS });
      tally(m);
      if (m.tool_calls && m.tool_calls.length) {
        messages.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
          const result = await execTool(tc.function.name, args);
          usedTools.push(`${tc.function.name}(${args.path || args.dir || args.consulta || ''})`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
        }
        continue;
      }
      usage.record(acc);
      return { answer: m.content || '(sin respuesta)', tools: usedTools };
    }
    const final = await chat(cfg, messages, { maxTokens: cfg.maxTokens });
    tally(final);
    usage.record(acc);
    return { answer: final.content || 'No pude completar la tarea en el límite de pasos.', tools: usedTools };
  } catch (e) {
    usage.record(acc);
    if (String(e.message).includes('cuota diaria')) usage.markExhausted();
    throw e;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(UI);
  }
  if (req.method === 'GET' && req.url === '/usage') {
    if (ACCESS_TOKEN && req.headers['x-brain-token'] !== ACCESS_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(usage.stats()));
  }
  if (req.method === 'POST' && req.url === '/ask') {
    if (ACCESS_TOKEN && req.headers['x-brain-token'] !== ACCESS_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { question, history } = JSON.parse(body || '{}');
        if (!question || typeof question !== 'string') { res.writeHead(400); return res.end('{"error":"question requerido"}'); }
        const out = await ask(question.slice(0, 2000), history);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const HOST = process.env.BRAIN_HOST || '127.0.0.1';
server.listen(cfg.port, HOST, () => {
  console.log(`\n🧠 VisionYX Brain en  http://${HOST}:${cfg.port}\n`);
});
