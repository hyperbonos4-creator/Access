import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessControlModule } from '../access-control/access-control.module';
import { AssistantModule } from '../assistant/assistant.module';
// CredentialRotatorModule es @Global: su servicio ya está disponible sin import.

import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { ToolsRegistry } from './tools/tools.registry';
import { CopilotConversation } from './entities/copilot-conversation.entity';
import { CopilotMessage } from './entities/copilot-message.entity';
import { CopilotAudit } from './entities/copilot-audit.entity';

/**
 * Módulo del Copiloto interno del panel de administración.
 *
 * Reutiliza `AssistantModule` (LlmProvider: mismo GLM + rotación Cloudflare)
 * y `AccessControlModule` (servicios de dominio que las tools invocan). El
 * rotador de credenciales es `@Global`, así que llega sin import explícito.
 *
 * Tablas propias: `copilot_conversation`, `copilot_message`, `copilot_audit`.
 */
@Module({
  imports: [
    AssistantModule,
    AccessControlModule,
    TypeOrmModule.forFeature([CopilotConversation, CopilotMessage, CopilotAudit]),
  ],
  controllers: [CopilotController],
  providers: [CopilotService, ToolsRegistry],
})
export class CopilotModule {}
