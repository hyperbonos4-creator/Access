import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { getJwtAccessSecret } from '../config/jwt.config';
import { User } from './entities/user.entity';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

/**
 * Estrategia JWT: valida el access token y resuelve el `User` activo. El payload
 * mínimo (`sub/email/role`) basta para los guards; se recarga el usuario para
 * cortar el acceso si fue desactivado tras emitir el token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtAccessSecret(config),
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    const user = await this.users.findOne({ where: { id: payload.sub, isActive: true } });
    if (!user) throw new UnauthorizedException('usuario_invalido');
    return user;
  }
}
