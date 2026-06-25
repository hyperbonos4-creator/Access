import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

/** Cuerpo de `POST /admin/copilot/chat`. */
export class CopilotChatDto {
  @IsString()
  @MaxLength(4000)
  message: string;

  /** Si se omite, se arranca una conversación nueva. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

/** Top10 de herramientas más usadas (panel de uso del copiloto). */
export class CopilotUsageDto {
  tool: string;
  count: number;
  ok: number;
}
