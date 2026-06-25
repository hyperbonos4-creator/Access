import { Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolSchema } from '../../assistant/llm.provider';

/**
 * Herramientas de **código** del Copiloto: lectura del repositorio del
 * proyecto (read-only), confinada a `COPLOT_REPO_ROOT`.
 *
 * Es el port TypeScript de `brain/tools.mjs`, pero **sin escritura ni shell**:
 * el copiloto interno puede inspeccionar el código para razonar sobre el
 * sistema, pero nunca modificarlo. Esto reduce drásticamente la superficie de
 * daño: aunque el modelo "decida" escribir, no hay tool que lo permita.
 *
 * Seguridad:
 *  - `safe()` resuelve rutas dentro de ROOT y rechaza cualquier path-traversal
 *    (`..`, absoluto, fuera de la raíz). Un input malicioso nunca escapa.
 *  - Se omite `.git` y carpetas pesadas en listados/búsquedas.
 *  - Lectura acotada por bytes (`MAX_READ`) y resultado recortado
 *    (`MAX_RESULT`) para no saturar el contexto del modelo.
 */
const MAX_READ = 200_000; // bytes por archivo leído
const MAX_RESULT = 9_000; // chars devueltos al modelo por tool
const MAX_LIST = 600; // entradas máx. en `listar_archivos`
const MAX_LIST_DEPTH = 6; // profundidad de recursión en `listar_archivos`
const MAX_GREP_HITS = 60; // coincidencias máx. en `buscar_en_codigo`
const MAX_GREP_LINE = 160; // chars por línea en `buscar_en_codigo`

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'data',
]);

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|dart|md|html|css|scss|sh|ps1|yml|yaml|sql|json|ino|txt|env)$/i;

/** Resultado uniforme de una tool: el `output` va al modelo; `ok` al audit. */
export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Argumentos sueltos que el modelo envía (ya parseados de JSON). */
type ToolArgs = Record<string, unknown>;

/**
 * Fábrica de tools de código para una raíz dada. El `repoRoot` lo inyecta el
 * servicio desde `ConfigService` (`COPLOT_REPO_ROOT`); nunca se lee de env aquí,
 * para que la tool sea testeable y determinista.
 */
export function createCodeTools(repoRoot: string) {
  const ROOT = path.resolve(repoRoot);
  const logger = new Logger('CopilotCodeTools');

  /** Esquemas expuestos al modelo (function-calling OpenAI-compatible). */
  const schemas: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'listar_archivos',
        description:
          'Lista archivos y carpetas del repositorio (recursivo, omite node_modules/.git/dist). Útil para orientarse antes de leer.',
        parameters: {
          type: 'object',
          properties: {
            dir: {
              type: 'string',
              description: 'Subcarpeta relativa a la raíz del repo; vacío = raíz.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'leer_archivo',
        description: 'Lee el contenido de un archivo del repositorio.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta relativa del archivo.' },
            startLine: { type: 'integer', description: 'Línea inicial (1-base, opcional).' },
            endLine: { type: 'integer', description: 'Línea final inclusive (opcional).' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'buscar_en_codigo',
        description:
          'Busca un texto/patrón (sin regex) en el repositorio y devuelve archivo:línea:extracto.',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'Texto a buscar (case-insensitive).' },
          },
          required: ['consulta'],
        },
      },
    },
  ];

  const names = new Set(schemas.map((s) => s.function.name));

  /** Resuelve una ruta del modelo dentro de ROOT (anti path-traversal). */
  function safe(p: string): string {
    let rel = String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, ''); // quita barras iniciales (evita absolutos)
    // Tolerancia: si el modelo prefija con el nombre de la carpeta raíz, lo quita.
    const rootName = path.basename(ROOT).toLowerCase();
    if (rel.toLowerCase() === rootName || rel.toLowerCase().startsWith(rootName + '/')) {
      rel = rel.slice(rootName.length).replace(/^\/+/, '');
    }
    const full = path.resolve(ROOT, rel);
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
      throw new Error('ruta fuera del repositorio (no permitido)');
    }
    return full;
  }

  /** Ruta relativa bonita para mostrar al modelo. */
  function relOf(full: string): string {
    return path.relative(ROOT, full).replace(/\\/g, '/') || '.';
  }

  function clip(s: string): string {
    return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + '\n…[recortado]' : s;
  }

  function listar(dir: string): string {
    const base = safe(dir);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw new Error('la carpeta no existe');
    }
    const out: string[] = [];
    const walk = (d: string, depth: number): void => {
      if (depth > MAX_LIST_DEPTH || out.length > MAX_LIST) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        if (out.length > MAX_LIST) return;
        const full = path.join(d, e.name);
        out.push((e.isDirectory() ? '[dir] ' : '      ') + relOf(full));
        if (e.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(base, 0);
    return out.length ? out.join('\n') : '(vacío)';
  }

  function leer(p: string, startLine?: number, endLine?: number): string {
    const full = safe(p);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error('no es un archivo');
    if (st.size > MAX_READ) return `(archivo muy grande: ${st.size} bytes; usa buscar_en_codigo)`;
    let txt = fs.readFileSync(full, 'utf8');
    if (startLine || endLine) {
      const lines = txt.split(/\r?\n/);
      const from = Math.max(1, startLine ?? 1);
      txt = lines
        .slice(from - 1, endLine ?? lines.length)
        .map((l, i) => `${from + i}: ${l}`)
        .join('\n');
    }
    return `# ${relOf(full)}\n${txt}`;
  }

  function buscar(q: string): string {
    const needle = String(q ?? '').toLowerCase();
    if (!needle) throw new Error('consulta vacía');
    const hits: string[] = [];
    const walk = (d: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full);
          continue;
        }
        if (!TEXT_EXT.test(e.name)) continue;
        let txt: string;
        try {
          txt = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push(
              `${relOf(full)}:${i + 1}: ${lines[i].trim().slice(0, MAX_GREP_LINE)}`,
            );
            if (hits.length > MAX_GREP_HITS) return;
          }
        }
      }
    };
    walk(ROOT);
    return hits.length ? hits.join('\n') : 'sin coincidencias';
  }

  /**
   * Ejecuta una tool de código por nombre. Nunca lanza: en error devuelve
   * `{ ok:false, output:'error: …' }` para que el modelo pueda reaccionar y la
   * auditoría registre el fallo.
   */
  async function execute(name: string, args: ToolArgs): Promise<ToolResult> {
    if (!names.has(name)) {
      return { ok: false, output: `error: herramienta desconocida ${name}` };
    }
    try {
      switch (name) {
        case 'listar_archivos':
          return { ok: true, output: clip(listar(String(args.dir ?? ''))) };
        case 'leer_archivo':
          return {
            ok: true,
            output: clip(
              leer(
                String(args.path ?? ''),
                toInt(args.startLine),
                toInt(args.endLine),
              ),
            ),
          };
        case 'buscar_en_codigo':
          return { ok: true, output: clip(buscar(String(args.consulta ?? ''))) };
        default:
          return { ok: false, output: `error: herramienta desconocida ${name}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`tool ${name} falló: ${msg}`);
      return { ok: false, output: `error: ${msg}` };
    }
  }

  return { schemas, execute, root: ROOT };
}

function toInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
