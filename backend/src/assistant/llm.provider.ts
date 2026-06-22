import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CredentialRotatorService,
  type AccountConnection,
} from '../credential-rotator/credential-rotator.service';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmReply {
  content: string;
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
  async chat(messages: ChatMessage[]): Promise<LlmReply> {
    if (!this.configured) throw new Error('assistant_not_configured');

    // Modo pool: rota entre cuentas Cloudflare ante límite/cuota/auth.
    if (this.rotator.hasAccounts()) {
      const reply = await this.rotator.executeWithRotation((conn: AccountConnection) =>
        this.doChat(conn.baseUrl, conn.token, messages),
      );
      return { ...reply, account: this.rotator.getCurrentAccount()?.email ?? null };
    }

    // Modo env (cuenta única).
    const reply = await this.doChat(this.envBaseUrl, this.envApiKey, messages);
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
  ): Promise<LlmReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    };
    // Desactiva el razonamiento del modelo (GLM) para respuestas directas y rápidas.
    if (this.disableThinking) payload.chat_template_kwargs = { enable_thinking: false };
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
      if (err?.name === 'AbortError') throw new Error('assistant_timeout');
      throw new Error('assistant_unreachable');
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
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = data?.choices?.[0]?.message?.content ?? '';
    return {
      content: stripThinking(raw),
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
