import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateCameraDto {
  @IsString()
  @MaxLength(120)
  name: string;

  /** rtsp://user:pass@host:554/Streaming/Channels/101 */
  @IsString()
  rtspUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  nvrChannel?: number;
}

export class UpdateCameraDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  rtspUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalKey?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  nvrChannel?: number;

  @IsOptional()
  @IsString()
  status?: string;
}
