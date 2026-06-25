import 'reflect-metadata';
import * as bcrypt from 'bcrypt';

import { AppDataSource } from './data-source';
import { User, UserRole } from '../auth/entities/user.entity';

/**
 * Crea (o actualiza) el usuario administrador a partir de SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD.
 *
 * - Por defecto es **idempotente**: si el admin ya existe, no hace nada.
 * - Con `FORCE_RESEED_ADMIN=true` hace **upsert**: si existe, reescribe la
 *   contraseña (y la reactiva). Es lo que permite cambiar la clave del admin
 *   sin recrear la base ni tocar SQL a mano.
 *
 *   npm run seed
 *   FORCE_RESEED_ADMIN=true npm run seed   # fuerza el update de la clave
 */
async function seed(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@office.local').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const forceReseed = (process.env.FORCE_RESEED_ADMIN ?? '').toLowerCase() === 'true';

  await AppDataSource.initialize();

  // En dev, asegura el esquema antes de insertar (permite `seed` sin arrancar
  // el backend primero). En producción el esquema lo crean las migraciones.
  if (process.env.DB_SYNCHRONIZE === 'true') {
    await AppDataSource.synchronize();
  }

  const users = AppDataSource.getRepository(User);
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await users.findOne({ where: { email } });
  if (existing) {
    if (!forceReseed) {
      // eslint-disable-next-line no-console
      console.log(`Admin ya existe: ${email} (usa FORCE_RESEED_ADMIN=true para reescribir la clave)`);
      await AppDataSource.destroy();
      return;
    }
    // FORCE_RESEED_ADMIN: actualiza contraseña y reactiva el admin.
    existing.passwordHash = passwordHash;
    existing.isActive = true;
    existing.role = UserRole.ADMIN;
    await users.save(existing);
    // eslint-disable-next-line no-console
    console.log(`Admin actualizado (FORCE_RESEED_ADMIN): ${email}`);
    await AppDataSource.destroy();
    return;
  }

  const admin = users.create({
    email,
    passwordHash,
    firstName: 'Admin',
    lastName: 'Office',
    role: UserRole.ADMIN,
    isActive: true,
  });
  await users.save(admin);
  // eslint-disable-next-line no-console
  console.log(`Admin creado: ${email}`);
  await AppDataSource.destroy();
}

void seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed falló:', err);
  process.exit(1);
});
