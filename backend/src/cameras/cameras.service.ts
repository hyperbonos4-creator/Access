import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Camera } from './entities/camera.entity';
import { CreateCameraDto, UpdateCameraDto } from './dto/camera.dto';

/** Vista pública de una cámara: sin `rtspUrl` (contiene credenciales). */
export type CameraView = Omit<Camera, 'rtspUrl'>;

@Injectable()
export class CamerasService {
  constructor(
    @InjectRepository(Camera)
    private readonly cameras: Repository<Camera>,
  ) {}

  async create(dto: CreateCameraDto): Promise<CameraView> {
    const cam = this.cameras.create({
      name: dto.name,
      rtspUrl: dto.rtspUrl,
      externalKey: dto.externalKey ?? null,
      nvrChannel: dto.nvrChannel ?? null,
      status: 'ACTIVE',
    });
    return this.toView(await this.cameras.save(cam));
  }

  async list(): Promise<CameraView[]> {
    const rows = await this.cameras.find({ order: { name: 'ASC' } });
    return rows.map((r) => this.toView(r));
  }

  async update(id: string, dto: UpdateCameraDto): Promise<CameraView> {
    const cam = await this.cameras.findOne({ where: { id } });
    if (!cam) throw new NotFoundException('camera_not_found');
    if (dto.name !== undefined) cam.name = dto.name;
    if (dto.rtspUrl !== undefined) cam.rtspUrl = dto.rtspUrl;
    if (dto.externalKey !== undefined) cam.externalKey = dto.externalKey;
    if (dto.nvrChannel !== undefined) cam.nvrChannel = dto.nvrChannel;
    if (dto.status !== undefined) cam.status = dto.status;
    return this.toView(await this.cameras.save(cam));
  }

  async remove(id: string): Promise<void> {
    const res = await this.cameras.delete({ id });
    if (!res.affected) throw new NotFoundException('camera_not_found');
  }

  private toView(cam: Camera): CameraView {
    const { rtspUrl: _omit, ...view } = cam;
    void _omit;
    return view;
  }
}
