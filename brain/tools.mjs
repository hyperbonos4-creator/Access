// Herramientas de archivo del Cerebro, CONFINADAS a la carpeta `access`.
// Control total (leer/escribir/crear/editar/borrar) pero SIN poder salir de la
// raíz, y sin ejecución de shell. Bloquea .git para no corromper el repo.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.ACCESS_ROOT || 'c:/Users/Hide/Desktop/access');
const ALLOW_WRITE = (process.env.ALLOW_WRITE || 'false') === 'true';
const MAX_READ = 200_000;       // bytes por archivo leído
const MAX_RESULT = 9000;        // chars devueltos al modelo
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'data']);

/** Resuelve una ruta del modelo dentro de ROOT (anti path-traversal). */
function safe(p) {
  let rel = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.toLowerCase() === 'access' || rel.toLowerCase().startsWith('access/')) rel = rel.slice(6).replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('ruta fuera de la carpeta access (no permitido)');
  return full;
}
function relOf(full) { return 'access/' + path.relative(ROOT, full).replace(/\\/g, '/'); }
function assertWrite(full) {
  if (!ALLOW_WRITE) throw new Error('escritura deshabilitada');
  if (/(^|[\/\\])\.git([\/\\]|$)/.test(full)) throw new Error('no se permite modificar .git');
}

/** Esquemas expuestos al modelo (function-calling). */
export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'listar_archivos', description: 'Lista archivos y carpetas dentro de access (recursivo, omite node_modules/.git/dist).', parameters: { type: 'object', properties: { dir: { type: 'string', description: 'subcarpeta relativa, vacío = raíz' } } } } },
  { type: 'function', function: { name: 'leer_archivo', description: 'Lee el contenido de un archivo de access.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'buscar_en_codigo', description: 'Busca un texto/patrón en los archivos de access y devuelve coincidencias con archivo y línea.', parameters: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] } } },
  { type: 'function', function: { name: 'escribir_archivo', description: 'Crea o sobrescribe (edita) un archivo de access con el contenido dado.', parameters: { type: 'object', properties: { path: { type: 'string' }, contenido: { type: 'string' } }, required: ['path', 'contenido'] } } },
  { type: 'function', function: { name: 'crear_archivo', description: 'Crea un archivo nuevo (falla si ya existe).', parameters: { type: 'object', properties: { path: { type: 'string' }, contenido: { type: 'string' } }, required: ['path', 'contenido'] } } },
  { type: 'function', function: { name: 'borrar_archivo', description: 'Borra un archivo de access.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const clip = (s) => (s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n…[recortado]' : s);

export async function execTool(name, args) {
  try {
    switch (name) {
      case 'listar_archivos': return clip(listar(args.dir || ''));
      case 'leer_archivo': return clip(leer(args.path, args.startLine, args.endLine));
      case 'buscar_en_codigo': return clip(buscar(args.consulta));
      case 'escribir_archivo': return escribir(args.path, args.contenido, false);
      case 'crear_archivo': return escribir(args.path, args.contenido, true);
      case 'borrar_archivo': return borrar(args.path);
      default: return `error: herramienta desconocida ${name}`;
    }
  } catch (e) { return `error: ${e.message}`; }
}

function listar(dir) {
  const base = safe(dir);
  const out = [];
  (function walk(d, depth) {
    if (depth > 6) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      out.push((e.isDirectory() ? '[dir] ' : '      ') + relOf(full));
      if (e.isDirectory()) walk(full, depth + 1);
      if (out.length > 600) return;
    }
  })(base, 0);
  return out.join('\n') || '(vacío)';
}

function leer(p, a, b) {
  const full = safe(p);
  const st = fs.statSync(full);
  if (st.size > MAX_READ) return `(archivo muy grande: ${st.size} bytes)`;
  let txt = fs.readFileSync(full, 'utf8');
  if (a || b) {
    const lines = txt.split(/\r?\n/);
    txt = lines.slice((a || 1) - 1, b || lines.length).map((l, i) => `${(a || 1) + i}: ${l}`).join('\n');
  }
  return `# ${relOf(full)}\n${txt}`;
}

function buscar(q) {
  const needle = String(q).toLowerCase();
  const hits = [];
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|dart|md|html|css|scss|sh|ps1|yml|yaml|sql|json|ino|txt)$/i.test(e.name)) continue;
      let txt; try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) { hits.push(`${relOf(full)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`); if (hits.length > 60) return; }
      }
    }
  })(ROOT);
  return hits.length ? hits.join('\n') : 'sin coincidencias';
}

function escribir(p, contenido, mustBeNew) {
  const full = safe(p); assertWrite(full);
  if (mustBeNew && fs.existsSync(full)) throw new Error('ya existe');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String(contenido ?? ''), 'utf8');
  return `ok: ${mustBeNew ? 'creado' : 'guardado'} ${relOf(full)} (${Buffer.byteLength(String(contenido ?? ''))} bytes)`;
}

function borrar(p) {
  const full = safe(p); assertWrite(full);
  if (!fs.existsSync(full)) throw new Error('no existe');
  if (fs.statSync(full).isDirectory()) throw new Error('es una carpeta; solo borro archivos');
  fs.unlinkSync(full);
  return `ok: borrado ${relOf(full)}`;
}
