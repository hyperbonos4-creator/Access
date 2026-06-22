import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ── Sujetos (empleados) ────────────────────────────────────────────────
export class CreateSubjectDto {
  @IsString()
  @MaxLength(160)
  fullName: string;

  @IsOptional()
  @IsIn(['EMPLOYEE', 'CONTRACTOR', 'STAFF'])
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeCode?: string;
}

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeCode?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: string;
}

export class EnrollDto {
  /** Imagen del rostro en base64 (sin el prefijo data:). */
  @IsString()
  imageB64: string;
}

// ── Registro guiado por liveness activo ─────────────────────────────────
export class LivenessFrameDto {
  @IsIn(['LOOK_LEFT', 'LOOK_RIGHT', 'LOOK_CENTER', 'BLINK'])
  action: string;

  @IsString()
  imageB64: string;
}

export class GuidedEnrollDto {
  @IsString()
  challengeId: string;

  @IsArray()
  @ArrayMinSize(3)
  @ValidateNested({ each: true })
  @Type(() => LivenessFrameDto)
  frames: LivenessFrameDto[];
}

// ── Consentimiento ─────────────────────────────────────────────────────
export class GrantConsentDto {
  @IsString()
  @MaxLength(200)
  purpose: string;

  @IsString()
  @MaxLength(32)
  policyVersion: string;

  @IsOptional()
  @IsString()
  signature?: string;
}

// ── Puntos de acceso ───────────────────────────────────────────────────
export class CreateAccessPointDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsIn(['PEDESTRIAN'])
  kind?: string;

  @IsOptional()
  @IsUUID()
  cameraId?: string;

  @IsOptional()
  @IsIn(['NORMAL', 'HIGH'])
  securityLevel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  matchThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  livenessThreshold?: number;

  @IsOptional()
  @IsIn(['RELAY', 'HTTP', 'HIKVISION_ISAPI', 'SIMULATED', 'NONE'])
  controllerKind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  controllerRef?: string;
}

export class UpdateAccessPointDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(['NORMAL', 'HIGH'])
  securityLevel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  matchThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  livenessThreshold?: number;

  @IsOptional()
  @IsIn(['RELAY', 'HTTP', 'HIKVISION_ISAPI', 'SIMULATED', 'NONE'])
  controllerKind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  controllerRef?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: string;
}

// ── Autorización con horario ───────────────────────────────────────────
export class ScheduleDto {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  to?: string;
}

export class AuthorizeSubjectDto {
  @IsUUID()
  subjectId: string;

  @IsUUID()
  accessPointId: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule?: ScheduleDto;
}
