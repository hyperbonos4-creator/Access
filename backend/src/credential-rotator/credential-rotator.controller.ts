// 📄 backend/src/credential-rotator/credential-rotator.controller.ts
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CredentialRotatorService } from './credential-rotator.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';

@Controller('admin/credentials')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class CredentialRotatorController {
  constructor(private readonly rotator: CredentialRotatorService) {}

  @Get('status')
  getStatus() {
    return this.rotator.getStats();
  }

  @Post('check-credits')
  async checkCredits() {
    return this.rotator.verifyCurrentAccount();
  }

  @Post('switch')
  async forceSwitch() {
    const previous = this.rotator.getCurrentAccount()?.email ?? null;
    const next = await this.rotator.switchToNextAccount();
    return {
      message: 'Cuenta cambiada',
      newAccount: next?.email ?? null,
      previous,
    };
  }
}