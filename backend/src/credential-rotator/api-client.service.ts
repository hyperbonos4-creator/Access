// 📄 backend/src/credential-rotator/api-client.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CredentialRotatorService } from './credential-rotator.service';

@Injectable()
export class RotatingApiClient {
  private readonly logger = new Logger(RotatingApiClient.name);

  constructor(
    private readonly rotator: CredentialRotatorService,
    private readonly httpService: HttpService,
  ) {}

  async post(url: string, data: any, config?: any) {
    return this.rotator.executeWithRotation(async (conn) => {
      const response = await firstValueFrom(
        this.httpService.post(url, data, {
          ...config,
          headers: { ...config?.headers, ...conn.headers },
        })
      );
      return response.data;
    });
  }

  async get(url: string, config?: any) {
    return this.rotator.executeWithRotation(async (conn) => {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          ...config,
          headers: { ...config?.headers, ...conn.headers },
        })
      );
      return response.data;
    });
  }
}