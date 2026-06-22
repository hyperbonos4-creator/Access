import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class AppController {
  @Get('health')
  @ApiOperation({ summary: 'Liveness del backend (sin auth).' })
  health() {
    return { status: 'ok', service: 'office-access-control', ts: new Date().toISOString() };
  }
}
