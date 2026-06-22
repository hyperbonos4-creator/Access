import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { LlmProvider } from './llm.provider';

/**
 * Asistente de pre-venta de la web ("Vix"), potenciado por GLM (Cloudflare
 * Workers AI). Endpoint público; el resto de la app no depende de él.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AssistantController],
  providers: [AssistantService, LlmProvider],
})
export class AssistantModule {}
