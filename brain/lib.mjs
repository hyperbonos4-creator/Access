// VisionYX Brain — utilidades compartidas (Cloudflare Workers AI + RAG).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  cfg._here = HERE;
  cfg._dataDir = path.join(HERE, 'data');
  cfg._indexFile = path.join(cfg._dataDir, 'index.json');
  return cfg;
}

const CF = (cfg) => `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflare.accountId}`;
const AUTH = (cfg) => ({ Authorization: `Bearer ${cfg.cloudflare.apiToken}`, 'Content-Type': 'application/json' });

/** Embeddings (bge-m3). Devuelve un vector por texto. */
export async function embed(cfg, texts) {
  const url = `${CF(cfg)}/ai/run/${cfg.cloudflare.embedModel}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: AUTH(cfg),
    body: JSON.stringify({ text: texts }),
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'Se agotó la cuota diaria gratis de Cloudflare en esta cuenta. Cambia de cuenta en config.json o activa Workers Paid.' : `embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const vecs = data?.result?.data;
  if (!Array.isArray(vecs)) throw new Error('embed: respuesta inesperada');
  return vecs;
}

/** Proveedor de chat: usa cfg.chat si está; si no, cae a Cloudflare (GLM). */
function chatProvider(cfg) {
  if (cfg.chat && cfg.chat.baseUrl && cfg.chat.apiKey) return cfg.chat;
  return {
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflare.accountId}/ai/v1`,
    apiKey: cfg.cloudflare.apiToken,
    model: cfg.cloudflare.chatModel,
    disableThinking: true,
    tools: true,
  };
}

/** Chat (OpenAI-compat, agnóstico). Cloudflare GLM, Venice u otro: solo cambia cfg.chat. */
export async function chat(cfg, messages, opts = {}) {
  const p = chatProvider(cfg);
  const body = {
    model: p.model,
    messages,
    max_tokens: opts.maxTokens || cfg.maxTokens || 1200,
    temperature: 0.2,
    stream: false,
  };
  // chat_template_kwargs es específico de GLM/Cloudflare; solo si el proveedor lo soporta.
  if (p.disableThinking !== false) body.chat_template_kwargs = { enable_thinking: false };
  // tools: function-calling. Desactívalo en proveedores/modelos que no lo soporten.
  if (opts.tools && p.tools !== false) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'Se agotó la cuota diaria gratis de Cloudflare en esta cuenta. Cambia de cuenta en config.json o activa Workers Paid.' : `chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  const u = data?.usage || {};
  return {
    content: msg.content ? stripThinking(msg.content) : '',
    tool_calls: msg.tool_calls || null,
    usage: { prompt: Number(u.prompt_tokens || 0), completion: Number(u.completion_tokens || 0) },
  };
}

/** Quita el bloque de razonamiento de modelos "thinking" (defensa; GLM va con thinking off). */
function stripThinking(content) {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?(?:think|thinking|reasoning|analysis|reflection)>/gi, '')
    .trim();
}

/** Similitud coseno entre dos vectores. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * Censura valores que parezcan secretos antes de indexar/enviar al modelo.
 * Defensa en profundidad: además NO se indexan archivos .env ni llaves.
 */
export function redactSecrets(text) {
  let t = text;
  // Asignaciones clave = valor sensibles.
  t = t.replace(
    /(\b(?:secret|secreto|password|passwd|pwd|clave|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|client[_-]?secret|jwt[_-]?secret|access[_-]?secret|wompi|integrity|webhook[_-]?secret)\b\s*[:=]\s*["']?)([^\s"'#]{6,})(["']?)/gi,
    '$1[REDACTED]$3',
  );
  // Patrones de tokens conocidos.
  t = t.replace(/cfut_[A-Za-z0-9]{12,}/g, 'cfut_[REDACTED]');
  t = t.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]');
  t = t.replace(/eyJ[A-Za-z0-9_\-]{18,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[REDACTED_JWT]');
  // Cadenas de conexión con credenciales.
  t = t.replace(/([a-z]+:\/\/[^:\/\s]+:)([^@\/\s]{3,})(@)/gi, '$1[REDACTED]$3');
  return t;
}

/** Lista de archivos a indexar bajo un root, aplicando filtros. */
export function walkFiles(root, cfg) {
  const out = [];
  const exclude = new Set(cfg.excludeDirs);
  const globs = cfg.excludeFileGlobs.map(globToRegex);
  const secretNames = new Set(cfg.secretFileNames);
  const exts = new Set(cfg.includeExt);

  function isSecretFile(name) {
    const lower = name.toLowerCase();
    if (secretNames.has(lower) || lower.startsWith('.env')) return true;
    return /\.(pem|key|p12|pfx|keystore|crt|cer)$/i.test(lower);
  }

  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.has(e.name) || e.name.startsWith('.')) {
          if (e.name === '.github' || e.name === '.kiro') { /* permitir docs/configs */ } else continue;
        }
        walk(full);
      } else if (e.isFile()) {
        if (isSecretFile(e.name)) continue;
        if (!exts.has(path.extname(e.name).toLowerCase())) continue;
        if (globs.some((rx) => rx.test(e.name))) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > cfg.maxFileBytes || stat.size === 0) continue;
        out.push(full);
      }
    }
  })(root);
  return out;
}

/** Trocea por líneas para poder citar rangos. */
export function chunkByLines(text, chunkLines, overlap, maxChunks) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let start = 0;
  while (start < lines.length && chunks.length < maxChunks) {
    const end = Math.min(lines.length, start + chunkLines);
    const body = lines.slice(start, end).join('\n').trim();
    if (body) chunks.push({ startLine: start + 1, endLine: end, text: body });
    if (end >= lines.length) break;
    start = end - overlap;
  }
  return chunks;
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

export function projectOf(root) {
  return path.basename(root.replace(/[\/\\]+$/, ''));
}
