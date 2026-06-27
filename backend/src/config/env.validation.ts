import * as Joi from 'joi';

/**
 * Validación de variables de entorno al arrancar (fail-fast). Si falta un
 * secreto o tiene un placeholder conocido en producción, el server NO arranca.
 *
 * Heredado de URBAN (ADR bootstrap-and-error-shape), simplificado a una sola
 * oficina (sin multi-tenant): se valida `SITE_ID` en lugar de `conjuntoId`.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGIN: Joi.string().default('http://localhost:3001'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').optional(),

  SITE_ID: Joi.string().min(1).default('office'),

  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),
  DB_SYNCHRONIZE: Joi.string().valid('true', 'false').default('false'),

  JWT_ACCESS_SECRET: Joi.string()
    .min(16)
    .required()
    .invalid('change_me_in_production', 'changeme', 'secret')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('change_me_dev_only_min_16_chars'),
    }),
  JWT_ACCESS_TTL: Joi.string().default('12h'),

  SEED_ADMIN_EMAIL: Joi.string()
    .email({ tlds: { allow: false } })
    .optional(),
  SEED_ADMIN_PASSWORD: Joi.string().optional(),

  VISION_SERVICE_URL: Joi.string().uri().default('http://localhost:8200'),
  VISION_SERVICE_TOKEN: Joi.string().allow('').default(''),
  VISION_SERVICE_TIMEOUT_MS: Joi.number().default(5000),
  VISION_ACTIVE_LIVENESS_TIMEOUT_MS: Joi.number().default(45000),

  // Puerta única: un empleado enrolado queda habilitado automáticamente en las
  // puertas (sin paso manual de "autorizar"). Poner 'false' para gestión
  // explícita de permisos por punto (modelo multi-puerta).
  AUTO_AUTHORIZE_ENROLLED: Joi.string().valid('true', 'false').default('true'),

  // Ventana de apertura de la puerta (ms): tras conceder permanece ABIERTA este
  // tiempo y re-bloquea automáticamente (estado en vivo del kiosko/admin).
  DOOR_OPEN_HOLD_MS: Joi.number().default(6000),

  CAMERA_ISAPI_PORT: Joi.number().default(80),

  // Exigir anti-spoofing PASIVO (MiniFASNet) en el registro guiado. true en
  // producción; 'false' en entornos sin los pesos (demo) — el reto ACTIVO basta.
  LIVENESS_REQUIRE_PASSIVE: Joi.string().valid('true', 'false').default('true'),

  // Vista remota "Cámara en vivo" (familiar), separada del control de acceso.
  // Si el secreto está vacío, la vista queda DESHABILITADA (cerrado por defecto).
  // Acceso: HTTPS + login de nginx + este secreto en el enlace.
  FAMILY_STREAM_SECRET: Joi.string().allow('').default(''),
  // Punto de acceso cuya cámara se transmite (vacío = el primero con cámara).
  FAMILY_ACCESS_POINT_ID: Joi.string().allow('').default(''),

  // ── Demo público efímero y aislado ──────────────────────────────────
  // Cada visitante recibe una sesión propia (usuario+clave únicos, datos
  // aislados) que se AUTODESTRUYE al expirar. 'true' habilita el endpoint
  // público de aprovisionamiento y el barrido de autodestrucción.
  DEMO_MODE: Joi.string().valid('true', 'false').default('false'),
  DEMO_TTL_MINUTES: Joi.number().min(5).default(60),
  DEMO_MAX_ACTIVE_SESSIONS: Joi.number().min(1).default(40),
  DEMO_SWEEP_SECONDS: Joi.number().min(15).default(60),
  DEMO_EMAIL_DOMAIN: Joi.string().default('demo.visionyx.lat'),

  // ── Asistente de la web ("Vix") — GLM vía Cloudflare Workers AI ─────
  // OpenAI-compatible: BASE_URL = https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
  // MODEL = @cf/zai-org/glm-4.7-flash · API_KEY = token de Cloudflare (solo en .env).
  ASSISTANT_BASE_URL: Joi.string().allow('').default(''),
  ASSISTANT_API_KEY: Joi.string().allow('').default(''),
  ASSISTANT_MODEL: Joi.string().default('@cf/zai-org/glm-4.7-flash'),
  ASSISTANT_MAX_TOKENS: Joi.number().default(1000),
  ASSISTANT_TEMPERATURE: Joi.number().default(0.4),
  ASSISTANT_TIMEOUT_MS: Joi.number().default(22000),
  ASSISTANT_DISABLE_THINKING: Joi.string().valid('true', 'false').default('true'),

  // ── Copiloto interno del panel de administración ─────────────────────
  // Reutiliza el LlmProvider del asistente. ACTIONS_ENABLED=false => el
  // copiloto opera en modo "solo lectura" (no publica abrir_puerta ni
  // rotar_credenciales al modelo). REPO_ROOT confina la lectura de código.
  COPLOT_ACTIONS_ENABLED: Joi.string().valid('true', 'false').default('true'),
  COPLOT_REPO_ROOT: Joi.string().allow('').default(''),
  COPLOT_MAX_ROUNDS: Joi.number().integer().min(1).max(10).default(6),
  COPLOT_HISTORY_LIMIT: Joi.number().integer().min(2).max(40).default(12),
  COPLOT_RATE_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  COPLOT_RATE_MAX: Joi.number().integer().min(1).default(12),
});
