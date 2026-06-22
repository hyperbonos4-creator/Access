// 📄 backend/src/credential-rotator/credential-rotator.service.ts
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';

interface Account {
  email: string;
  token: string;
  account_id: string;
  isActive: boolean;
  lastUsed?: Date;
  failureCount: number;
}

/**
 * Conexión activa con un proveedor Cloudflare: base URL OpenAI-compatible de
 * Workers AI (derivada del `account_id`) + cabeceras de autorización. Es lo que
 * recibe cada operación rotada (p. ej. el asistente "Vix").
 */
export interface AccountConnection {
  email: string;
  accountId: string;
  token: string;
  /** Base OpenAI-compatible de Workers AI para esta cuenta (sin barra final). */
  baseUrl: string;
  headers: Record<string, string>;
}

/** Códigos HTTP que justifican rotar de cuenta (cuota/límite/auth/proveedor). */
const ROTATABLE_STATUS = new Set([401, 402, 403, 429]);

/**
 * Rotador de cuentas **Cloudflare**. Mantiene un pool de cuentas (token +
 * account_id) cargado de `cuentas.json` y entrega, bajo demanda, la conexión
 * activa para hablar con Cloudflare Workers AI (asistente). La rotación es
 * **reactiva**: ante un 401/402/403/429 o un 5xx del proveedor se marca la
 * cuenta y se pasa a la siguiente. No verifica créditos de forma proactiva ni
 * habla con proveedores ajenos (no hay Venice ni similares).
 *
 * Confidencialidad: los tokens viven solo en memoria; nunca se loguean ni se
 * devuelven al cliente (`getStats()` omite el token).
 */
@Injectable()
export class CredentialRotatorService {
  private readonly logger = new Logger(CredentialRotatorService.name);
  private accounts: Account[] = [];
  private currentIndex = 0;
  private readonly maxFailures = 3;
  private readonly accountsPath: string;
  /** Plantilla de base URL de Workers AI; `{account_id}` se sustituye por cuenta. */
  private readonly baseUrlTemplate: string;

  constructor(private readonly httpService: HttpService) {
    // Ruta a cuentas.json: configurable por env (CUENTAS_PATH) para Docker;
    // por defecto sube tres niveles desde dist/credential-rotator (dev local).
    this.accountsPath =
      process.env.CUENTAS_PATH ??
      path.join(__dirname, '..', '..', '..', 'cuentas', 'cuentas.json');
    this.baseUrlTemplate =
      process.env.CLOUDFLARE_AI_BASE_TEMPLATE ??
      'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1';
    this.loadAccounts();
  }

  private loadAccounts() {
    try {
      const rawData = fs.readFileSync(this.accountsPath, 'utf8');
      const parsed = JSON.parse(rawData);
      this.accounts = parsed.map((acc: any) => ({
        ...acc,
        isActive: true,
        failureCount: 0,
      }));
      this.logger.log(`✅ Cargadas ${this.accounts.length} cuentas Cloudflare`);
    } catch (error) {
      // No tumbar el arranque del backend: el rotador es opcional. Si no hay
      // cuentas, las operaciones que dependan de rotación fallarán de forma
      // controlada (executeWithRotation), pero el resto del sistema arranca.
      this.accounts = [];
      this.logger.warn(
        `⚠️ No se pudieron cargar credenciales desde ${this.accountsPath}: ${error.message}. ` +
          `El rotador queda sin cuentas activas.`,
      );
    }
  }

  /** ¿Hay al menos una cuenta cargada? (la usa el asistente para decidir modo). */
  hasAccounts(): boolean {
    return this.accounts.length > 0;
  }

  getCurrentAccount(): Account | undefined {
    return this.accounts[this.currentIndex];
  }

  /** Base URL de Workers AI para una cuenta concreta. */
  private baseUrlFor(account: Account): string {
    return this.baseUrlTemplate
      .replace('{account_id}', account.account_id)
      .replace(/\/+$/, '');
  }

  getAuthHeaders(): Record<string, string> {
    const account = this.getCurrentAccount();
    if (!account) return {};
    return {
      Authorization: `Bearer ${account.token}`,
      'X-Account-ID': account.account_id,
    };
  }

  /** Conexión activa (cuenta + base URL + headers) lista para usar. */
  currentConnection(): AccountConnection {
    const account = this.getCurrentAccount();
    if (!account) {
      throw new HttpException(
        'No hay cuentas Cloudflare disponibles',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      email: account.email,
      accountId: account.account_id,
      token: account.token,
      baseUrl: this.baseUrlFor(account),
      headers: this.getAuthHeaders(),
    };
  }

  async switchToNextAccount(): Promise<Account | null> {
    const startIndex = this.currentIndex;
    const total = this.accounts.length;

    for (let i = 1; i <= total; i++) {
      const nextIndex = (startIndex + i) % total;
      const candidate = this.accounts[nextIndex];

      if (candidate.isActive && candidate.failureCount < this.maxFailures) {
        this.currentIndex = nextIndex;
        candidate.lastUsed = new Date();
        this.logger.log(`🔄 Cambio a cuenta: ${candidate.email}`);
        return candidate;
      }
    }

    this.logger.error('❌ No hay cuentas disponibles');
    return null;
  }

  markCurrentAccountFailed(reason: string) {
    const account = this.getCurrentAccount();
    if (!account) return;
    account.failureCount++;
    if (account.failureCount >= this.maxFailures) {
      account.isActive = false;
      this.logger.warn(`⛔ Cuenta desactivada ${account.email}: ${reason}`);
    }
  }

  /**
   * Verifica que el token de la cuenta actual sigue siendo válido en Cloudflare
   * (`/user/tokens/verify`). Reemplaza la antigua comprobación de "créditos"
   * contra un proveedor ajeno. Best-effort: cualquier fallo => no verificado.
   */
  async verifyCurrentAccount(): Promise<{ email: string | null; valid: boolean }> {
    const account = this.getCurrentAccount();
    if (!account) return { email: null, valid: false };
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          'https://api.cloudflare.com/client/v4/user/tokens/verify',
          {
            headers: { Authorization: `Bearer ${account.token}` },
            timeout: 5000,
          },
        ),
      );
      const data = response.data as { success?: boolean; result?: { status?: string } };
      const valid = Boolean(data?.success) && data?.result?.status === 'active';
      this.logger.log(`🔐 ${account.email}: token ${valid ? 'válido' : 'inválido'}`);
      return { email: account.email, valid };
    } catch (error: any) {
      this.logger.warn(
        `⚠️ No se pudo verificar el token de ${account.email}: ${error?.message}`,
      );
      return { email: account.email, valid: false };
    }
  }

  /** ¿Este error justifica rotar de cuenta? (límite/cuota/auth/5xx o timeout). */
  private isRotatable(error: any): boolean {
    // Errores transitorios marcados explícitamente (timeout / canal caído):
    // una cuenta puede colgarse sin devolver código HTTP.
    if (error?.rotatable === true) return true;
    const status: number | undefined = error?.status ?? error?.response?.status;
    if (status == null) return false;
    return ROTATABLE_STATUS.has(status) || status >= 500;
  }

  /**
   * Ejecuta `operation` con la conexión Cloudflare activa. Si la operación
   * falla con un código rotable, marca la cuenta, pasa a la siguiente y
   * reintenta hasta agotar el pool. Errores no rotables se propagan tal cual.
   */
  async executeWithRotation<T>(
    operation: (conn: AccountConnection) => Promise<T>,
  ): Promise<T> {
    if (!this.hasAccounts()) {
      throw new HttpException(
        'No hay cuentas Cloudflare configuradas',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const maxAttempts = this.accounts.length;
    let attempts = 0;
    let lastError: unknown;

    while (attempts < maxAttempts) {
      const account = this.getCurrentAccount();
      if (!account || !account.isActive) {
        const next = await this.switchToNextAccount();
        if (!next) break;
        attempts++;
        continue;
      }

      try {
        const result = await operation(this.currentConnection());
        account.failureCount = 0; // éxito: reset
        return result;
      } catch (error: any) {
        lastError = error;
        if (!this.isRotatable(error)) throw error;

        const status = error?.status ?? error?.response?.status;
        this.logger.warn(`⚠️ Límite/fallo (${status}) en ${account.email}`);
        this.markCurrentAccountFailed(`HTTP ${status}`);

        const next = await this.switchToNextAccount();
        if (!next) {
          throw new HttpException(
            'Todas las cuentas Cloudflare agotadas o limitadas',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        attempts++;
      }
    }

    if (lastError) throw lastError;
    throw new HttpException(
      'Agotados los reintentos de rotación',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  getStats() {
    const current = this.getCurrentAccount();
    return {
      total: this.accounts.length,
      active: this.accounts.filter((a) => a.isActive).length,
      current: current?.email ?? null,
      currentAccountId: current?.account_id ?? null,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        accountId: a.account_id,
        active: a.isActive,
        failures: a.failureCount,
        lastUsed: a.lastUsed,
      })),
    };
  }
}
