import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User, UserRole } from '../auth/entities/user.entity';

import { CopilotService } from './copilot.service';
import { CopilotAudit } from './entities/copilot-audit.entity';
import { CopilotChatDto } from './dto/copilot.dto';

/**
 * Throttler en memoria **por usuario** para el copiloto. Sin dependencias
 * externas (`@nestjs/throttler` no está instalado y un copiloto agéntico es
 * caro: un solo turno puede ser varias llamadas LLM). Ventana fija de
 * `windowMs` con `max` turnos; el bucket se reinicia al expirar la ventana.
 */
@Injectable()
class CopilotThrottler {
  private readonly logger = new Logger('CopilotThrottler');
  private readonly windowMs: number;
  private readonly max: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(config: ConfigService) {
    this.windowMs = config.get<number>('COPLOT_RATE_WINDOW_MS', 60_000);
    this.max = config.get<number>('COPLOT_RATE_MAX', 12);
  }

  /** Lanza 429 si el usuario excede el límite en la ventana. */
  tryTake(userId: string): void {
    const now = Date.now();
    const entry = this.hits.get(userId);
    if (!entry || now > entry.resetAt) {
      this.hits.set(userId, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count++;
    if (entry.count > this.max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      this.logger.warn(`Rate limit copilot para ${userId}: ${entry.count}/${this.max}`);
      throw new HttpException(
        `too_many_requests (reintenta en ${retry}s)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/**
 * Endpoints del Copiloto interno del panel de administración.
 *
 * Seguridad:
 * - JWT obligatorio + rol ADMIN/OPERATOR (igual que el resto del panel).
 * - Rate-limit por usuario (un turno agéntico consume varios LLM calls).
 * - Cada conversación está aislada por `userId` (un admin no ve la de otro).
 * - Las acciones que el copiloto ejecuta se auditan en `copilot_audit` a
 *   nombre del usuario, además de los `Access_Events` que el flujo existente
 *   ya genera (p. ej. abrir puerta).
 */
@ApiTags('Copilot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/copilot')
export class CopilotController {
  private readonly throttler: CopilotThrottler;

  constructor(
    config: ConfigService,
    private readonly copilot: CopilotService,
    @InjectRepository(CopilotAudit)
    private readonly audits: Repository<CopilotAudit>,
  ) {
    this.throttler = new CopilotThrottler(config);
  }

  /** Lista las conversaciones del operador (sidebar). */
  @Get('conversations')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Lista las conversaciones del copiloto del operador.' })
  listConversations(@CurrentUser() user: User) {
    return this.copilot.listConversations(user.id);
  }

  /** Carga los mensajes de una conversación (al abrirla en la UI). */
  @Get('conversations/:id/messages')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Carga los mensajes de una conversación.' })
  listMessages(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.copilot.listMessages(id, user.id);
  }

  /** Envía un mensaje al copiloto (bucle agéntico). */
  @Post('chat')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Envía un mensaje al copiloto y devuelve la respuesta + traza.' })
  async chat(@Body() dto: CopilotChatDto, @CurrentUser() user: User) {
    this.throttler.tryTake(user.id);
    return this.copilot.chat({
      user,
      message: dto.message,
      conversationId: dto.conversationId,
    });
  }

  /** Borra una conversación (y sus mensajes/auditorías). */
  @Delete('conversations/:id')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Borra una conversación del copiloto.' })
  async deleteConversation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    await this.copilot.deleteConversation(id, user.id);
    return { ok: true };
  }

  /**
   * Panel de uso del copiloto: top herramientas usadas por el operador.
   * Útil para ver de un vistazo qué hace el agente en mi nombre.
   */
  @Get('usage')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Uso de herramientas del copiloto (top por operador).' })
  async usage(@CurrentUser() user: User) {
    const rows = await this.audits
      .createQueryBuilder('a')
      .select('a.tool', 'tool')
      .addSelect('COUNT(*)', 'count')
      .addSelect("SUM(CASE WHEN a.ok THEN 1 ELSE 0 END)", 'ok')
      .where('a.user_id = :userId', { userId: user.id })
      .groupBy('a.tool')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany<{ tool: string; count: string; ok: string }>();
    return rows.map((r) => ({
      tool: r.tool,
      count: Number(r.count),
      ok: Number(r.ok),
    }));
  }
}
