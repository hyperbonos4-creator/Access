import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { KioskRecognitionService } from './kiosk-recognition.service';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Vista remota "Cámara en vivo" (uso familiar), separada del control de acceso.
 *
 * Pensada para verse desde el celular a través del servidor público (Oracle) por
 * un túnel SSH inverso. NO usa el guard de la app: se accede con un **secreto en
 * el enlace** (`FAMILY_STREAM_SECRET`). Defensa en capas reales: el secreto aquí
 * + HTTPS + login de nginx en el borde. Si el secreto está vacío, queda
 * deshabilitada (cerrado por defecto). No expone la cámara directamente: solo
 * reemite snapshots MJPEG por esta conexión autenticada.
 */
@ApiTags('Family View')
@Controller('family')
export class FamilyViewController {
  private static readonly FRAME_GAP_MS = 120; // ~8 fps, suficiente para vigilancia

  constructor(
    private readonly kiosk: KioskRecognitionService,
    private readonly config: ConfigService,
  ) {}

  private secretOk(k: string | undefined): boolean {
    const secret = (this.config.get<string>('FAMILY_STREAM_SECRET') || '').trim();
    return secret.length > 0 && k === secret;
  }

  @Get('view')
  @ApiOperation({ summary: 'Página de visualización (móvil) protegida por secreto.' })
  view(@Query('k') k: string, @Res() res: Response): void {
    if (!this.secretOk(k)) {
      res.status(404).end('not found');
      return;
    }
    const src = `stream.mjpeg?k=${encodeURIComponent(k)}`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.end(`<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
<title>Cámara en vivo</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;background:#03060f;color:#eaf1ff;font-family:system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(80,140,240,.18)}
  .bar b{letter-spacing:2px;background:linear-gradient(90deg,#fff,#1e90ff 60%,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}
  .live{font-size:12px;color:#28e0a0;display:flex;align-items:center;gap:6px}
  .dot{width:8px;height:8px;border-radius:50%;background:#28e0a0;box-shadow:0 0 8px #28e0a0;animation:p 1.4s infinite}
  @keyframes p{50%{opacity:.3}}
  .stage{flex:1;position:relative;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
  img{max-width:100%;max-height:100%;object-fit:contain}
  .off{position:absolute;color:#5e6f93;font-size:14px}
  .foot{padding:8px 16px;font-size:11px;color:#5e6f93;text-align:center}
</style></head>
<body><div class="wrap">
  <div class="bar"><div><b>URBAN</b> · Cámara en vivo</div><div class="live"><span class="dot"></span>EN VIVO</div></div>
  <div class="stage"><div class="off" id="off">Conectando con la cámara…</div><img id="v" alt="" /></div>
  <div class="foot">Conexión privada y cifrada</div>
</div>
<script>
  var img=document.getElementById('v'), off=document.getElementById('off');
  function load(){ img.src=${JSON.stringify(src)}+'&t='+Date.now(); }
  img.onload=function(){ off.style.display='none'; };
  img.onerror=function(){ off.style.display='block'; off.textContent='Reconectando…'; setTimeout(load,2000); };
  load();
</script>
</body></html>`);
  }

  @Get('stream.mjpeg')
  @ApiOperation({ summary: 'Stream MJPEG de la cámara (secreto en el enlace).' })
  async stream(@Query('k') k: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.secretOk(k)) {
      res.status(404).end('not found');
      return;
    }
    const boundary = 'urbancam';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const onClose = () => (closed = true);
    req.on('close', onClose);
    req.on('aborted', onClose);

    let failures = 0;
    try {
      while (!closed && !res.destroyed) {
        let jpeg: Buffer;
        try {
          jpeg = await this.kiosk.captureFamilySnapshot();
          failures = 0;
        } catch {
          if (++failures > 20) break;
          await delay(700);
          continue;
        }
        if (closed || res.destroyed) break;
        res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
        await delay(FamilyViewController.FRAME_GAP_MS);
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
