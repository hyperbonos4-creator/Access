import { InjectRepository } from '@nestjs/typeorm';
import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { LlmProvider, type ChatMessage, type ToolCall } from '../assistant/llm.provider';
import { User } from '../auth/entities/user.entity';

import { CopilotConversation } from './entities/copilot-conversation.entity';
import { CopilotMessage } from './entities/copilot-message.entity';
import { CopilotAudit } from './entities/copilot-audit.entity';
import { ToolsRegistry } from './tools/tools.registry';
import { buildCopilotSystemPrompt } from './copilot.prompt';

/** Una entrada de la traza de herramientas de un turno del asistente. */
export interface ToolTraceEntry {
  id: string;
  tool: string;
  args: unknown;
  result: string;
  ok: boolean;
}

/** Resultado público de una invocación del copiloto (lo devuelve el controller). */
export interface CopilotTurnResult {
  conversationId: string;
  /** Texto final del asistente (vacío si el modelo no produjo texto). */
  answer: string;
  /** Herramientas usadas en el turno (para la "traza de razonamiento" en la UI). */
  toolTrace: ToolTraceEntry[];
}

/**
 * `CopilotService` — bucle agéntico del copiloto interno.
 *
 * Flujo por turno del usuario:
 *  1. Carga (o crea) la conversación y reconstruye el historial como pares
 *     user/assistant(texto). Los tools de turnos pasados NO se reenvían: ya
 *     se ejecutaron y sus resultados son obsoletos; el modelo solo necesita el
 *     hilo de la conversación. Esto ahorra tokens y evita re-ejecuciones.
 *  2. Añade el mensaje del usuario y arranca el bucle de function-calling: en
 *     cada ronda pide al LLM una respuesta; si pide herramientas, las ejecuta
 *     vía `ToolsRegistry` (atribuidas al `userId`), las audita y devuelve los
 *     resultados para la siguiente ronda. Hasta `COPLOT_MAX_ROUNDS` rondas.
 *  3. Cuando el modelo responde sin pedir tools (o se agotan las rondas),
 *     persiste el turno: un mensaje `user` + un mensaje `assistant` final con
 *     la traza agregada. Cada tool ejecutada genera una fila en `copilot_audit`.
 *
 * Aislamiento: las consultas de tools heredan el `TenantContext` del request
 * del admin (ALS), igual que el resto del panel.
 */
@Injectable()
export class CopilotService {
  private readonly logger = new Logger('CopilotService');
  private readonly maxRounds: number;
  private readonly historyLimit: number;

  constructor(
    config: ConfigService,
    private readonly llm: LlmProvider,
    private readonly registry: ToolsRegistry,
    @InjectRepository(CopilotConversation)
    private readonly conversations: Repository<CopilotConversation>,
    @InjectRepository(CopilotMessage)
    private readonly messages: Repository<CopilotMessage>,
    @InjectRepository(CopilotAudit)
    private readonly audits: Repository<CopilotAudit>,
  ) {
    this.maxRounds = config.get<number>('COPLOT_MAX_ROUNDS', 6);
    this.historyLimit = config.get<number>('COPLOT_HISTORY_LIMIT', 12);
  }

  /**
   * Procesa un turno del usuario. `conversationId` opcional: si no se pasa, se
   * crea una conversación nueva (título = resumen del primer mensaje).
   */
  async chat(input: {
    user: User;
    message: string;
    conversationId?: string;
  }): Promise<CopilotTurnResult> {
    const { user, message } = input;

    // 1) Conversación (carga o crea).
    const conversation = input.conversationId
      ? await this.loadConversation(input.conversationId, user.id)
      : await this.createConversation(user.id, message);

    // 2) Historial -> mensajes del LLM (pares user/assistant texto).
    const systemPrompt = buildCopilotSystemPrompt({
      operatorName: `${user.firstName} ${user.lastName}`.trim() || user.email,
      actionsEnabled: this.registry.hasActions,
    });
    const history = await this.loadHistory(conversation.id);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    // 3) Bucle agéntico.
    const tools = this.registry.availableSchemas;
    const trace: ToolTraceEntry[] = [];
    let answer = '';
    let rounds = 0;

    while (rounds < this.maxRounds) {
      rounds++;
      let reply;
      try {
        reply = await this.llm.chat(messages, { tools, maxTokens: 900 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`LLM falló en ronda ${rounds}: ${msg}`);
        throw new BadGatewayException('copilot_unavailable');
      }

      const toolCalls = reply.toolCalls ?? [];

      // Sin tools pedidas => respuesta final.
      if (!toolCalls.length) {
        answer = reply.content;
        // Si el modelo pidió tools en rondas previas, su "respuesta final" puede
        // ir vacía (GLM a veces cierra sin texto). En ese caso resumimos.
        if (!answer && trace.length) {
          answer = 'Listo. Revisé el sistema con las herramientas indicadas arriba.';
        }
        break;
      }

      // 4) Ejecuta cada tool pedida, la audita y adjunta su resultado.
      // El mensaje assistant con tool_calls debe ir antes de los tool results.
      messages.push({
        role: 'assistant',
        content: reply.content ?? '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const args = safeParseArgs(call.function.arguments);
        const res = await this.registry.dispatch(call.function.name, args, user.id);
        trace.push({
          id: call.id,
          tool: call.function.name,
          args,
          result: res.output,
          ok: res.ok,
        });
        // Auditoría append-only de cada tool (qué hizo el agente en mi nombre).
        await this.audits.save(
          this.audits.create({
            userId: user.id,
            conversationId: conversation.id,
            tool: call.function.name,
            args,
            resultSummary: summarize(res.output),
            ok: res.ok,
          }),
        );
        // Resultado de la tool para el modelo (formato OpenAI: role=tool).
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: res.output,
        });
      }

      // Si era la última ronda y aún pedía tools, cortamos con un resumen.
      if (rounds >= this.maxRounds) {
        answer =
          reply.content ||
          `Alcanzado el máximo de pasos (${this.maxRounds}). ` +
            `Revisé ${trace.length} llamadas; dime si quieres que profundice.`;
        this.logger.warn(
          `Copilot alcanzó el tope de rondas (${this.maxRounds}) en conv ${conversation.id}`,
        );
      }
    }

    // 5) Persistencia del turno (user + assistant final).
    await this.messages.save([
      this.messages.create({
        conversationId: conversation.id,
        role: 'user',
        content: message,
        toolTrace: null,
      }),
      this.messages.create({
        conversationId: conversation.id,
        role: 'assistant',
        content: answer,
        toolTrace: trace.length ? trace : null,
      }),
    ]);
    // Refresca updatedAt de la conversación (para ordenar la lista).
    await this.conversations.update(conversation.id, { updatedAt: new Date() });

    return { conversationId: conversation.id, answer, toolTrace: trace };
  }

  /** Lista las conversaciones del usuario (las más recientes primero). */
  async listConversations(userId: string, limit = 30): Promise<CopilotConversation[]> {
    return this.conversations.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: Math.min(limit, 100),
      select: ['id', 'title', 'createdAt', 'updatedAt'],
    });
  }

  /** Carga los mensajes de una conversación (para reconstruir la UI). */
  async listMessages(conversationId: string, userId: string): Promise<CopilotMessage[]> {
    await this.loadConversation(conversationId, userId); // verifica propiedad
    return this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  /** Borra una conversación y todos sus mensajes/auditorías (GDPR-friendly). */
  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    const conv = await this.loadConversation(conversationId, userId);
    await this.messages.delete({ conversationId: conv.id });
    await this.audits.update({ conversationId: conv.id }, { conversationId: null });
    await this.conversations.delete(conv.id);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async loadConversation(
    conversationId: string,
    userId: string,
  ): Promise<CopilotConversation> {
    const conv = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conv || conv.userId !== userId) {
      // Mensaje idéntico al de "no existe" para no filtrar existencia ajena.
      throw new NotFoundException('conversation_not_found');
    }
    return conv;
  }

  private async createConversation(
    userId: string,
    firstMessage: string,
  ): Promise<CopilotConversation> {
    return this.conversations.save(
      this.conversations.create({
        userId,
        title: firstMessage.slice(0, 140).trim() || 'Nueva conversación',
      }),
    );
  }

  /**
   * Historial reconstruido como pares user/assistant(texto). Los `toolTrace`
   * de turnos pasados NO se reinyectan: ya se ejecutaron y sus resultados están
   * obsoletos; el modelo necesita el hilo, no la mecánica.
   */
  private async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      take: this.historyLimit,
    });
    return rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map<ChatMessage>((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }
}

/** Parsea el `arguments` (string JSON) de un tool_call de OpenAI. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Recorta el resultado para el resumen de auditoría (nunca secreto). */
function summarize(output: string): string {
  return output.length > 500 ? output.slice(0, 500) + '…' : output;
}
