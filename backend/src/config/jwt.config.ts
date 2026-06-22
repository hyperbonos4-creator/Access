import { ConfigService } from '@nestjs/config';

/**
 * Resolución centralizada del secreto JWT (defensa en profundidad). Nunca
 * devuelve un default: si la variable falta o es demasiado corta, lanza.
 * Heredado de URBAN (ADR auth-service-architecture).
 */
export function getJwtAccessSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_ACCESS_SECRET');
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_ACCESS_SECRET no está configurado o es demasiado corto (min 16). ' +
        'Verifica las variables de entorno antes de iniciar el servicio.',
    );
  }
  return secret;
}

/** Identificador del sitio (reemplaza el `conjuntoId` multi-tenant de URBAN). */
export function getSiteId(config: ConfigService): string {
  return config.get<string>('SITE_ID') ?? 'office';
}
