import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User, UserRole } from '../auth/entities/user.entity';

import { ConsentService } from './consent.service';
import { EnrollmentService } from './enrollment.service';
import { AccessControlService } from './access-control.service';
import { AccessPointsService } from './access-points.service';
import { KioskRecognitionService } from './kiosk-recognition.service';
import { VisionServiceClient } from './vision-service.client';
import { LivenessEnrollmentService } from './liveness/liveness-enrollment.service';
import {
  AuthorizeSubjectDto,
  CreateAccessPointDto,
  CreateSubjectDto,
  EnrollDto,
  GrantConsentDto,
  GuidedEnrollDto,
  UpdateAccessPointDto,
  UpdateSubjectDto,
} from './dto/access-control.dto';

/**
 * Endpoints de gestión del control de acceso facial.
 *
 * Seguridad:
 * - JWT obligatorio; gestión de empleados/plantillas/puntos solo ADMIN.
 * - Operación (kiosko, eventos, apertura manual) ADMIN u OPERATOR.
 * - Nunca se exponen embeddings, `controllerRef` ni `rtspUrl` al cliente.
 */
@ApiTags('Access Control')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('access')
export class AccessControlController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly consents: ConsentService,
    private readonly accessPoints: AccessPointsService,
    private readonly access: AccessControlService,
    private readonly vision: VisionServiceClient,
    private readonly kiosk: KioskRecognitionService,
    private readonly liveness: LivenessEnrollmentService,
    private readonly jwt: JwtService,
  ) {}

  // ── Empleados ───────────────────────────────────────────────────────
  @Post('subjects')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Crea un empleado enrolable.' })
  createSubject(@Body() dto: CreateSubjectDto) {
    return this.enrollment.createSubject(dto);
  }

  @Get('subjects')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Lista los empleados con su estado biométrico y último acceso.' })
  listSubjects() {
    return this.enrollment.listSubjectsDetailed();
  }

  @Patch('subjects/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Edita o desactiva un empleado.' })
  updateSubject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSubjectDto) {
    return this.enrollment.updateSubject(id, dto);
  }

  // ── Consentimiento (precede al enrolamiento) ────────────────────────
  @Post('subjects/:id/consent')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Registra el consentimiento biométrico (Ley 1581).' })
  grantConsent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantConsentDto,
    @CurrentUser() user: User,
    @Ip() ip: string,
  ) {
    return this.consents.grant(
      id,
      { purpose: dto.purpose, policyVersion: dto.policyVersion, signature: dto.signature, ipAddress: ip },
      user.id,
    );
  }

  @Delete('subjects/:id/consent')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Revoca el consentimiento y borra las plantillas en cascada.' })
  revokeConsent(@Param('id', ParseUUIDPipe) id: string) {
    return this.consents.revoke(id);
  }

  // ── Enrolamiento ─────────────────────────────────────────────────────
  @Post('subjects/:id/enroll')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Enrola un rostro (requiere consentimiento ACTIVE).' })
  enroll(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EnrollDto) {
    return this.enrollment.enroll(id, dto.imageB64);
  }

  @Get('subjects/:id/templates')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Lista metadatos de plantillas del empleado (sin vectores).' })
  listTemplates(@Param('id', ParseUUIDPipe) id: string) {
    return this.enrollment.listTemplates(id);
  }

  @Delete('subjects/:id/templates/:templateId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Borra una plantilla (vector + metadatos).' })
  async deleteTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    await this.enrollment.deleteTemplate(id, templateId);
    return { ok: true };
  }

  @Delete('subjects/:id/biometrics')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Derecho de supresión: borra toda la biometría del empleado.' })
  eraseBiometrics(@Param('id', ParseUUIDPipe) id: string) {
    return this.enrollment.eraseBiometrics(id);
  }

  // ── Registro guiado por liveness activo (gira/parpadea en vivo) ─────
  @Post('subjects/:id/liveness/challenge')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Emite un reto de liveness activo para el registro guiado.' })
  livenessChallenge(@Param('id', ParseUUIDPipe) id: string) {
    const ch = this.liveness.issueChallenge(id);
    return { challengeId: ch.challengeId, actions: ch.actions, expiresAt: ch.expiresAt };
  }

  @Post('subjects/:id/liveness/enroll')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Registro guiado: revalida el reto (pose + anti-spoofing) y enrola el frame frontal.',
  })
  guidedEnroll(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GuidedEnrollDto) {
    return this.liveness.guidedEnroll(id, dto.challengeId, dto.frames);
  }

  // ── Puntos de acceso y umbrales (ADMIN) ─────────────────────────────
  @Post('points')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Registra un punto de acceso (no expone controllerRef).' })
  createPoint(@Body() dto: CreateAccessPointDto) {
    return this.accessPoints.create(dto);
  }

  @Get('points')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Lista los puntos de acceso (sin secretos).' })
  listPoints() {
    return this.accessPoints.list();
  }

  @Patch('points/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Edita umbrales/seguridad/actuador de un punto.' })
  updatePoint(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAccessPointDto) {
    return this.accessPoints.update(id, dto);
  }

  @Post('authorizations')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Autoriza un empleado en un punto (con horario opcional).' })
  authorize(@Body() dto: AuthorizeSubjectDto) {
    return this.accessPoints.authorize(dto);
  }

  @Delete('authorizations/:subjectId/:accessPointId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Revoca la autorización de un empleado en un punto.' })
  async deauthorize(
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Param('accessPointId', ParseUUIDPipe) accessPointId: string,
  ) {
    await this.accessPoints.deauthorize(subjectId, accessPointId);
    return { ok: true };
  }

  // ── Kiosko de reconocimiento (terminal de puerta) ───────────────────
  @Post('points/:id/recognize')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Captura un frame, reconoce 1:N y decide el acceso (kiosko).' })
  recognizeAtPoint(@Param('id', ParseUUIDPipe) id: string) {
    return this.kiosk.recognizeAtPoint(id);
  }

  @Post('points/:id/recognize-image')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({
    summary: 'Reconoce 1:N desde una imagen del cliente (webcam) y decide el acceso.',
  })
  recognizeImageAtPoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { imageB64?: string },
  ) {
    return this.kiosk.recognizeImageAtPoint(id, body?.imageB64 ?? '');
  }

  @Get('points/:id/snapshot')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Snapshot JPEG de la cámara del punto (preview, sin IA).' })
  async snapshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const jpeg = await this.kiosk.captureSnapshot(id);
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Content-Length': String(jpeg.length),
    });
    res.end(jpeg);
  }

  @Get('points/:id/stream-token')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Token corto para abrir el stream MJPEG del kiosko desde un <img>.' })
  streamToken(@Param('id', ParseUUIDPipe) id: string) {
    const token = this.jwt.sign({ pt: id, scope: 'kiosk:stream' }, { expiresIn: '1800s' });
    return { token };
  }

  // ── Eventos de acceso y apertura manual ─────────────────────────────
  @Get('events')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Histórico de eventos de acceso (filtros).' })
  listEvents(
    @Query('accessPointId') accessPointId?: string,
    @Query('decision') decision?: string,
    @Query('limit') limit?: string,
  ) {
    return this.access.listEvents({
      accessPointId,
      decision,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('events/:id/manual-open')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Apertura manual del operador tras una denegación (auditada).' })
  manualOpen(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.access.manualOpen(id, user.id);
  }

  // ── Estado en vivo de la puerta (demo sin hardware / sensor real) ───
  @Get('points/:id/door-status')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Estado en vivo de la puerta (CERRADA/ABRIENDO/ABIERTA/CERRANDO).' })
  doorStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.access.doorStatus(id);
  }

  @Post('points/:id/door/test-open')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Apertura de prueba del actuador (anima la puerta), auditada.' })
  testOpenDoor(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.access.testOpenDoor(id, user.id);
  }

  // ── Salud del Vision_Service ────────────────────────────────────────
  @Get('health')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Salud del microservicio de visión (proxy).' })
  health() {
    return this.vision.health();
  }

  // ── Diagnóstico del sistema (panel "Sistema") ───────────────────────
  @Get('diagnostics')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Estado de Visión, Base de datos, Qdrant, cámaras y controladores.' })
  async diagnostics() {
    const [vision, database, cameras] = await Promise.all([
      this.vision.health(),
      this.access.pingDb(),
      this.kiosk.diagnoseCameras(),
    ]);
    return { vision, database, cameras };
  }
}
