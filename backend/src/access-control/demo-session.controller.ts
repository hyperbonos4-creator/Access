import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { DemoSessionService } from './demo-session.service';

/**
 * Endpoints PÚBLICOS del demo efímero (sin autenticación): el visitante de la
 * web pulsa "Probar demo" y obtiene credenciales únicas para una sesión aislada
 * que se autodestruye al expirar.
 */
@ApiTags('Demo')
@Controller('access/demo')
export class DemoSessionController {
  constructor(private readonly demo: DemoSessionService) {}

  @Post('session')
  @ApiOperation({ summary: 'Aprovisiona una sesión de demo aislada y efímera (credenciales únicas).' })
  async create() {
    const t = await this.demo.provision();
    return {
      sessionId: t.sessionId,
      email: t.email,
      password: t.password,
      token: t.token,
      displayName: t.displayName,
      pointId: t.pointId,
      expiresAt: t.expiresAt,
      ttlMinutes: t.ttlMinutes,
    };
  }

  @Get('session/:id')
  @ApiOperation({ summary: 'Estado/tiempo restante de una sesión de demo (para el contador).' })
  async status(@Param('id') id: string) {
    const s = await this.demo.status(id);
    if (!s) throw new NotFoundException('demo_session_not_found');
    return s;
  }
}
