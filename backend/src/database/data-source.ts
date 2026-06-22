import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

import { User } from '../auth/entities/user.entity';
import { Camera } from '../cameras/entities/camera.entity';
import { AccessPoint } from '../access-control/entities/access-point.entity';
import { AccessEvent } from '../access-control/entities/access-event.entity';
import { EnrolledSubject } from '../access-control/entities/enrolled-subject.entity';
import { FaceTemplate } from '../access-control/entities/face-template.entity';
import { SubjectAuthorization } from '../access-control/entities/subject-authorization.entity';
import { BiometricConsent } from '../access-control/entities/biometric-consent.entity';

loadEnv();

/**
 * DataSource para el CLI de TypeORM (migraciones) y el seed. En dev, el esquema
 * lo crea `DB_SYNCHRONIZE=true`; en producción se recomienda migraciones.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [
    User,
    Camera,
    AccessPoint,
    AccessEvent,
    EnrolledSubject,
    FaceTemplate,
    SubjectAuthorization,
    BiometricConsent,
  ],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
