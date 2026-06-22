import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { CamerasModule } from '../cameras/cameras.module';

import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';
import { FamilyViewController } from './family-view.controller';
import { AccessPointsService } from './access-points.service';
import { ConsentService } from './consent.service';
import { EnrollmentService } from './enrollment.service';
import { KioskRecognitionService } from './kiosk-recognition.service';
import { KioskStreamController } from './kiosk-stream.controller';
import { DemoSessionController } from './demo-session.controller';
import { DemoSessionService } from './demo-session.service';
import { VisionServiceClient } from './vision-service.client';
import { LivenessChallengeService } from './liveness/liveness-challenge.service';
import { LivenessEnrollmentService } from './liveness/liveness-enrollment.service';
import { DOOR_CONTROLLER } from './door/door-controller.port';
import { DoorControllerService } from './door/door-controller.service';
import { DoorStateService } from './door/door-state.service';

import { AccessEvent } from './entities/access-event.entity';
import { AccessPoint } from './entities/access-point.entity';
import { BiometricConsent } from './entities/biometric-consent.entity';
import { DemoSession } from './entities/demo-session.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { FaceTemplate } from './entities/face-template.entity';
import { SubjectAuthorization } from './entities/subject-authorization.entity';

/**
 * Módulo de control de acceso facial para la puerta de oficina.
 *
 * Reutiliza `AuthModule` (JWT + User) y `CamerasModule` (Camera + snapshot). La
 * decisión fail-secure vive en `AccessControlService`; la actuación física en
 * `DOOR_CONTROLLER` (relé ESP32/maglock por HTTP). No carga IA: habla con el
 * microservicio `vision` por HTTP.
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    AuthModule,
    CamerasModule,
    TypeOrmModule.forFeature([
      EnrolledSubject,
      BiometricConsent,
      FaceTemplate,
      AccessPoint,
      SubjectAuthorization,
      AccessEvent,
      DemoSession,
    ]),
  ],
  controllers: [
    AccessControlController,
    KioskStreamController,
    FamilyViewController,
    DemoSessionController,
  ],
  providers: [
    EnrollmentService,
    ConsentService,
    AccessControlService,
    AccessPointsService,
    KioskRecognitionService,
    DemoSessionService,
    VisionServiceClient,
    LivenessChallengeService,
    LivenessEnrollmentService,
    DoorStateService,
    { provide: DOOR_CONTROLLER, useClass: DoorControllerService },
  ],
  exports: [EnrollmentService, ConsentService, AccessControlService, VisionServiceClient],
})
export class AccessControlModule {}
