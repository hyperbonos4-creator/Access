import 'reflect-metadata';
import * as bcrypt from 'bcrypt';

import { AppDataSource } from './data-source';
import { User, UserRole } from '../auth/entities/user.entity';

/**
 * Crea el usuario administrador inicial a partir de SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD. Idempotente: si ya existe, no hace nada.
 *
 *   npm run seed
 */
async function seed(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@office.local').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';

  await AppDataSource.initialize();

  // En dev, asegura el esquema antes de insertar (permite `seed` sin arrancar
  // el backend primero). En producción el esquema lo crean las migraciones.
  if (process.env.DB_SYNCHRONIZE === 'true') {
    await AppDataSource.synchronize();
  }

  const users = AppDataSource.getRepository(User);

  const existing = await users.findOne({ where: { email } });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Admin ya existe: ${email}`);
    await AppDataSource.destroy();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
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
