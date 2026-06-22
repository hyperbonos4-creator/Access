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

/**
 * Pool de cuentas Cloudflare para rotación. Usa `cfg.cloudflare.accounts`
 * (array de {accountId, apiToken}) si existe; si no, cae a la cuenta única
 * `cfg.cloudflare.{accountId,apiToken}`. Permite agotar la cuota diaria gratis
 * de una cuenta y seguir con la siguiente, en vez de bloquearse.
 */
function accountPool(cfg) {
  const list = cfg?.cloudflare?.accounts;
  if (Array.isArray(list) && list.length) {
    return list
      .map((a) => ({ accountId: a.accountId ?? a.account_id, apiToken: a.apiToken ?? a.token }))
      .filter((a) => a.accountId && a.apiToken);
  }
  return [{ accountId: cfg.cloudflare.accountId, apiToken: cfg.cloudflare.apiToken }];
}

// Índice de la cuenta activa (persistente en el proceso): al rotar avanza, así
// la siguiente petición arranca en la última cuenta que funcionó. No se marca
// "agotada" de forma permanente, de modo que tras el reinicio de cuota (UTC)
// las cuentas vuelven a probarse solas.
let _accountIdx = 0;

/** Cuenta Cloudflare activa ahora mismo. */
export function currentAccount(cfg) {
  const pool = accountPool(cfg);
  return pool[_accountIdx % pool.length];
}

// Códigos que justifican rotar de cuenta: cuota (429), pago/permiso (402/403)
// o token inválido (401) — en todos esos casos esta cuenta no sirve ahora.
const ROTATABLE = new Set([401, 402, 403, 429]);

/**
 * Ejecuta `fn(account)` rotando de cuenta ante un código rotable (cuota agotada,
 * etc.). Reintenta hasta agotar el pool; solo entonces lanza "todas agotadas".
 */
async function withRotation(cfg, label, fn) {
  const pool = accountPool(cfg);
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const acc = pool[_accountIdx % pool.length];
    try {
      return await fn(acc);
    } catch (e) {
      if (!ROTATABLE.has(e?.status)) throw e;
      console.warn(
        `[rotacion] ${label}: cuenta ${acc.accountId} no disponible (HTTP ${e.status}, intento ${attempt + 1}/${pool.length}); rotando…`,
      );
      _accountIdx = (_accountIdx + 1) % pool.length;
    }
  }
  throw new Error(
    'Se agotó la cuota diaria gratis de Cloudflare en TODAS las cuentas del pool. ' +
      'Espera al reinicio diario (UTC) o activa Workers Paid.',
  );
}

/** fetch contra Cloudflare/OpenAI-compat que marca el 429 para que rote. */
async function _fetchJson(url, apiToken, body, label) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`${label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status; // permite a withRotation detectar el 429
    throw err;
  }
  return res.json();
}

/** Embeddings (bge-m3). Devuelve un vector por texto. Rota de cuenta ante 429. */
export async function embed(cfg, texts) {
  return withRotation(cfg, 'embed', async (acc) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/ai/run/${cfg.cloudflare.embedModel}`;
    const data = await _fetchJson(url, acc.apiToken, { text: texts }, 'embed');
    const vecs = data?.result?.data;
    if (!Array.isArray(vecs)) throw new Error('embed: respuesta inesperada');
    return vecs;
  });
}

/** Chat (OpenAI-compat). Cloudflare GLM rota de cuenta ante 429; un proveedor
 * custom (`cfg.chat`) no rota (cuenta única por configuración). */
export async function chat(cfg, messages, opts = {}) {
  const custom = cfg.chat && cfg.chat.baseUrl && cfg.chat.apiKey ? cfg.chat : null;
  const model = custom ? custom.model : cfg.cloudflare.chatModel;
  const disableThinking = custom ? custom.disableThinking !== false : true;
  const supportsTools = custom ? custom.tools !== false : true;

  const body = {
    model,
    messages,
    max_tokens: opts.maxTokens || cfg.maxTokens || 1200,
    temperature: 0.2,
    stream: false,
  };
  if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };
  if (opts.tools && supportsTools) { body.tools = opts.tools; body.tool_choice = 'auto'; }

  const parse = (data) => {
    const msg = data?.choices?.[0]?.message || {};
    const u = data?.usage || {};
    return {
      content: msg.content ? stripThinking(msg.content) : '',
      tool_calls: msg.tool_calls || null,
      usage: { prompt: Number(u.prompt_tokens || 0), completion: Number(u.completion_tokens || 0) },
    };
  };

  if (custom) {
    const url = `${custom.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    return parse(await _fetchJson(url, custom.apiKey, body, 'chat'));
  }
  return withRotation(cfg, 'chat', async (acc) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/ai/v1/chat/completions`;
    return parse(await _fetchJson(url, acc.apiToken, body, 'chat'));
  });
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
