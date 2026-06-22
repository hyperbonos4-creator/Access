import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';

import { CamerasService } from './cameras.service';
import { CreateCameraDto, UpdateCameraDto } from './dto/camera.dto';

@ApiTags('Cameras')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('cameras')
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Registra una cámara IP (no expone el rtspUrl).' })
  create(@Body() dto: CreateCameraDto) {
    return this.cameras.create(dto);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Lista las cámaras (sin credenciales).' })
  list() {
    return this.cameras.list();
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Edita una cámara.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCameraDto) {
    return this.cameras.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Elimina una cámara.' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.cameras.remove(id);
    return { ok: true };
  }
}
