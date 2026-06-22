import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import type { Request, Response } from 'express';

import { User, UserRole } from '../auth/entities/user.entity';
import { KioskRecognitionService } from './kiosk-recognition.service';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KIOSK_ROLES = new Set<UserRole>([UserRole.OPERATOR, UserRole.ADMIN]);

/**
 * Stream MJPEG del kiosko (preview fluido de la terminal de puerta) + sesión de
 * dispositivo de larga duración.
 *
 * El stream usa `multipart/x-mixed-replace`: empuja snapshots JPEG de la cámara
 * en una sola conexión (el navegador los renderiza como video nativo en un
 * `<img>`). Como un `<img>` no puede mandar el header Authorization, el stream
 * NO usa el guard de clase: valida un token corto firmado (`scope: kiosk:stream`,
 * atado al punto) que el cliente obtiene por `GET /access/points/:id/stream-token`.
 */
@Controller('access')
export class KioskStreamController {
  private readonly logger = new Logger(KioskStreamController.name);
  private static readonly FRAME_GAP_MS = 30;

  constructor(
    private readonly jwt: JwtService,
    private readonly kiosk: KioskRecognitionService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /**
   * Sesión de kiosko: valida credenciales de un operador/admin y emite un token
   * de dispositivo de larga duración (30d) que la terminal guarda localmente,
   * para no pedir login interactivo en cada arranque.
   */
  @Post('kiosk/session')
  async kioskSession(
    @Body() body: { email?: string; password?: string },
  ): Promise<{ token: string; name: string; role: string }> {
    const email = (body?.email ?? '').trim().toLowerCase();
    const password = body?.password ?? '';
    const fail = (): never => {
      throw new UnauthorizedException('credenciales_invalidas');
    };
    if (!email || !password) fail();

    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email })
      .andWhere('u.isActive = true')
      .getOne();
    if (!user) fail();
    const ok = await bcrypt.compare(password, (user as User).passwordHash);
    if (!ok) fail();
    if (!KIOSK_ROLES.has((user as User).role)) {
      throw new UnauthorizedException('rol_no_autorizado_para_kiosko');
    }

    const u = user as User;
    const token = this.jwt.sign(
      { sub: u.id, email: u.email, role: u.role, ds: u.demoSessionId ?? null },
      { expiresIn: '30d' },
    );
    return { token, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role };
  }

  @Get('points/:id/stream.mjpeg')
  async stream(
    @Param('id') id: string,
    @Query('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let claims: { pt?: string; scope?: string } | null = null;
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      res.status(401).end('unauthorized');
      return;
    }
    if (!claims || claims.scope !== 'kiosk:stream' || claims.pt !== id) {
      res.status(403).end('forbidden');
      return;
    }
    const boundary = 'doorframe';

    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const onClose = () => {
      closed = true;
    };
    req.on('close', onClose);
    req.on('aborted', onClose);

    let failures = 0;
    try {
      while (!closed && !res.destroyed) {
        let jpeg: Buffer;
        try {
          jpeg = await this.kiosk.captureSnapshot(id);
          failures = 0;
        } catch {
          if (++failures > 20) break;
          await delay(500);
          continue;
        }
        if (closed || res.destroyed) break;
        const ok = res.write(
          `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
        );
        res.write(jpeg);
        res.write('\r\n');
        if (!ok) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
        await delay(KioskStreamController.FRAME_GAP_MS);
      }
    } finally {
      req.off('close', onClose);
      req.off('aborted', onClose);
      try {
        res.end();
      } catch {
        /* ya cerrado */
      }
    }
  }
}
