import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CamerasController } from './cameras.controller';
import { CamerasService } from './cameras.service';
import { Camera } from './entities/camera.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Camera])],
  controllers: [CamerasController],
  providers: [CamerasService],
  exports: [TypeOrmModule],
})
export class CamerasModule {}
