import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CredentialRotatorService,
  type AccountConnection,
} from '../credential-rotator/credential-rotator.service';

/** Una llamada a herramienta emitida por el modelo (formato OpenAI). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Mensaje de chat. El copiloto interno usa los campos opcionales
 * (`tool_calls`, `tool_call_id`, `name`) para el bucle de function-calling;
 * "Vix" solo usa `role`+`content`.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Solo en mensajes assistant cuando el modelo pide ejecutar herramientas. */
  tool_calls?: ToolCall[];
  /** Solo en mensajes `role:'tool'`, para emparejar con la llamada. */
  tool_call_id?: string;
  /** Nombre de la herramienta (mensajes `tool`). */
  name?: string;
}

/** Esquema de herramienta expuesto al modelo (function-calling OpenAI-compatible). */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  /** Si se pasan, se habilita el function-calling (bucle agéntico). */
  tools?: ToolSchema[];
  /** Modelo a usar para este turno (por defecto ASSISTANT_MODEL). */
  model?: string;
  /** Tope de tokens para este turno (por defecto ASSISTANT_MAX_TOKENS). */
  maxTokens?: number;
}

export interface LlmReply {
  content: string;
  /** Llamadas a herramientas pedidas por el modelo (vacío si no usó tools). */
  toolCalls?: ToolCall[];
  usage?: { prompt: number; completion: number } | null;
  /** Email de la cuenta Cloudflare con la que se respondió (o null si env). */
  account?: string | null;
}

/**
 * Cliente LLM agnóstico (API estilo OpenAI "chat completions") sobre **GLM en
 * Cloudflare Workers AI**. La cuenta Cloudflare la elige el
 * `CredentialRotatorService`: cada turno usa la cuenta activa y, si Cloudflare
 * devuelve límite/cuota/auth (401/402/403/429/5xx), rota a la siguiente cuenta
 * y reintenta — todo transparente para el usuario. Si no hay cuentas en el
 * pool, cae a una única cuenta por env (`ASSISTANT_BASE_URL` + `ASSISTANT_API_KEY`).
 *
 * Confidencialidad: la API key viaja solo en el header Authorization; nunca se
 * loguea ni se devuelve al cliente. GLM es un modelo "thinking": se elimina el
 * bloque de razonamiento antes de devolver la respuesta.
 */
@Injectable()
export class LlmProvider {
  private readonly logger = new Logger('AssistantLlm');
  private readonly envBaseUrl: string;
  private readonly envApiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly disableThinking: boolean;

  constructor(
    config: ConfigService,
    private readonly rotator: CredentialRotatorService,
  ) {
    this.envBaseUrl = (config.get<string>('ASSISTANT_BASE_URL') ?? '').replace(/\/+$/, '');
    this.envApiKey = config.get<string>('ASSISTANT_API_KEY') ?? '';
    this.model = config.get<string>('ASSISTANT_MODEL') ?? '@cf/zai-org/glm-4.7-flash';
    this.maxTokens = config.get<number>('ASSISTANT_MAX_TOKENS', 700);
    this.temperature = config.get<number>('ASSISTANT_TEMPERATURE', 0.4);
    this.timeoutMs = config.get<number>('ASSISTANT_TIMEOUT_MS', 22000);
    // GLM es un modelo "thinking": gasta tokens razonando en un campo aparte y
    // deja `content` vacío. Para un chat ágil lo desactivamos (verificado en
    // Cloudflare con chat_template_kwargs.enable_thinking=false).
    this.disableThinking = config.get<string>('ASSISTANT_DISABLE_THINKING', 'true') !== 'false';
  }

  /** Hay con qué responder: pool del rotador o una cuenta por env. */
  get configured(): boolean {
    return this.rotator.hasAccounts() || (!!this.envBaseUrl && !!this.envApiKey);
  }

  /** Un turno de chat. Devuelve el texto del asistente y la cuenta usada. */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LlmReply> {
    if (!this.configured) throw new Error('assistant_not_configured');

    const tools = options?.tools;
    const model = options?.model;
    const maxTokens = options?.maxTokens;

    // Modo pool: rota entre cuentas Cloudflare ante límite/cuota/auth.
    if (this.rotator.hasAccounts()) {
      const reply = await this.rotator.executeWithRotation((conn: AccountConnection) =>
        this.doChat(conn.baseUrl, conn.token, messages, tools, model, maxTokens),
      );
      return { ...reply, account: this.rotator.getCurrentAccount()?.email ?? null };
    }

    // Modo env (cuenta única).
    const reply = await this.doChat(
      this.envBaseUrl,
      this.envApiKey,
      messages,
      tools,
      model,
      maxTokens,
    );
    return { ...reply, account: null };
  }

  /**
   * Llamada cruda a un endpoint OpenAI-compatible. Lanza un Error con `.status`
   * en fallos HTTP para que el rotador decida si rota de cuenta.
   */
  private async doChat(
    baseUrl: string,
    apiKey: string,
    messages: ChatMessage[],
    tools?: ToolSchema[],
    model?: string,
    maxTokens?: number,
  ): Promise<LlmReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const payload: Record<string, unknown> = {
      model: model ?? this.model,
      messages,
      temperature: this.temperature,
      max_tokens: maxTokens ?? this.maxTokens,
      stream: false,
    };
    // Function-calling (copiloto interno). Si hay tools, NO desactivamos el
    // thinking: la cadena de razonamiento mejora la elección de herramientas.
    if (tools && tools.length) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    } else if (this.disableThinking) {
      // Desactiva el razonamiento del modelo (GLM) para respuestas directas y rápidas.
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string };
      // Timeout o canal caído: marcar como ROTABLE para que el rotador pruebe
      // la siguiente cuenta (una cuenta puede colgarse sin devolver status).
      const rerr: Error & { rotatable?: boolean } = new Error(
        err?.name === 'AbortError' ? 'assistant_timeout' : 'assistant_unreachable',
      );
      rerr.rotatable = true;
      throw rerr;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`LLM HTTP ${res.status}: ${detail.slice(0, 180)}`);
      const err: Error & { status?: number } = new Error(`assistant_http_${res.status}`);
      err.status = res.status; // permite al rotador detectar 401/402/403/429/5xx
      throw err;
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: ToolCall[];
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = data?.choices?.[0]?.message;
    const raw = msg?.content ?? '';
    const toolCalls = msg?.tool_calls?.length ? msg.tool_calls : undefined;
    return {
      content: stripThinking(raw),
      toolCalls,
      usage: data?.usage
        ? {
            prompt: Number(data.usage.prompt_tokens ?? 0),
            completion: Number(data.usage.completion_tokens ?? 0),
          }
        : null,
    };
  }
}

/** Quita el bloque de razonamiento de modelos "thinking" (GLM, DeepSeek-R1, etc.). */
function stripThinking(content: string): string {
  return (content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<\/?(?:think|thinking|reasoning|analysis|reflection)>/gi, '')
    .trim();
}
