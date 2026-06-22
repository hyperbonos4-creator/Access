import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AssistantService } from './assistant.service';
import { ChatDto } from './dto';

/**
 * Endpoint PÚBLICO del asistente de la web ("Vix"). Sin autenticación (es un bot
 * de pre-venta), por eso lleva límites defensivos: tope de tamaño de payload
 * (DTO) y un rate-limit por IP en memoria para no quemar la cuota del modelo ni
 * exponerse a abuso. CORS ya restringe los orígenes (visionyx.lat / demo).
 */
@ApiTags('Assistant')
@Controller('assistant')
export class AssistantController {
  private readonly hits = new Map<string, number[]>();
  private static readonly WINDOW_MS = 5 * 60_000;
  private static readonly MAX_PER_WINDOW = 30;

  constructor(private readonly assistant: AssistantService) {}

  @Post('chat')
  @ApiOperation({ summary: 'Conversa con el asistente de pre-venta de VisionYX (GLM).' })
  async chat(@Body() dto: ChatDto, @Ip() ip: string) {
    this.rateLimit(ip || 'unknown');
    return this.assistant.chat(dto.messages);
  }

  /** Rate-limit por IP en ventana deslizante (en memoria, best-effort). */
  private rateLimit(ip: string): void {
    const now = Date.now();
    const since = now - AssistantController.WINDOW_MS;
    const arr = (this.hits.get(ip) ?? []).filter((t) => t > since);
    if (arr.length >= AssistantController.MAX_PER_WINDOW) {
      throw new HttpException(
        { code: 'rate_limited', message: 'Demasiados mensajes. Espera un momento, por favor.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    arr.push(now);
    this.hits.set(ip, arr);
    // Limpieza ocasional para no crecer sin límite.
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        const f = v.filter((t) => t > since);
        if (f.length) this.hits.set(k, f);
        else this.hits.delete(k);
      }
    }
  }
}
