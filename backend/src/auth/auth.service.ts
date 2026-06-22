import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';

export interface LoginResult {
  token: string;
  user: { id: string; email: string; name: string; role: string };
}

/**
 * Autenticación mínima de operadores/administradores. Login por email+password
 * (bcrypt) → access JWT stateless. `passwordHash` nunca se serializa (la entidad
 * lo marca `select:false`; aquí se carga explícitamente solo para comparar).
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = email.trim().toLowerCase();
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: normalized })
      .andWhere('u.isActive = true')
      .getOne();

    const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !ok) throw new UnauthorizedException('credenciales_invalidas');

    await this.users.update({ id: user.id }, { lastLoginAt: new Date() });

    const expiresIn = this.config.get<string>('JWT_ACCESS_TTL', '12h');
    const token = this.jwt.sign(
      { sub: user.id, email: user.email, role: user.role, ds: user.demoSessionId ?? null },
      { expiresIn } as JwtSignOptions,
    );
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        role: user.role,
      },
    };
  }
}
