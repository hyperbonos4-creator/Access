/**
 * Tipos compartidos por las herramientas del Copiloto (sistema y acción).
 *
 * Antes `ToolResult` vivía en `code-tools.ts`, pero esas tools de lectura del
 * repositorio se eliminaron; el tipo se mueve aquí para que las dos familias
 * que siguen (sistema + acción) lo importen sin acoplarse a un módulo muerto.
 */

/** Resultado uniforme de una tool: el `output` va al modelo; `ok` al audit. */
export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Argumentos sueltos que el modelo envía (ya parseados de JSON). */
export type ToolArgs = Record<string, unknown>;
