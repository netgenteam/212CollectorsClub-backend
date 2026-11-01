import { Logger } from '@nestjs/common';
import type {
  FxProvider,
  FxProviderResult,
  FxProviderSource,
} from './fx-provider.js';

const ENDPOINTS: Record<
  FxProviderSource,
  { path: '/v1/dolares' | '/v1/euros'; fuente: 'oficial' | 'paralelo' }
> = {
  BCV_USD: { path: '/v1/dolares', fuente: 'oficial' },
  PARALELO_USD: { path: '/v1/dolares', fuente: 'paralelo' },
  BCV_EUR: { path: '/v1/euros', fuente: 'oficial' },
};

export const DEFAULT_FX_PROVIDER_BASE_URL = 'https://ve.dolarapi.com';
export const DEFAULT_FX_PROVIDER_TIMEOUT_MS = 5000;
export const FX_RETRY_DELAY_MS = 500;

class RetryableError extends Error {}

/**
 * Story 18.1 (AD-79, A56): real provider (ve.dolarapi.com). Never throws:
 * every failure is returned as `{ok:false, error}`. One retry after 500 ms
 * only for timeout / network / 5xx (not for 4xx or malformed bodies).
 */
export class DolarApiProvider implements FxProvider {
  readonly name = 'dolarapi';
  private readonly logger = new Logger(DolarApiProvider.name);

  constructor(
    private readonly baseUrl: string = DEFAULT_FX_PROVIDER_BASE_URL,
    private readonly timeoutMs: number = DEFAULT_FX_PROVIDER_TIMEOUT_MS,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async fetchRate(source: FxProviderSource): Promise<FxProviderResult> {
    const cfg = ENDPOINTS[source];
    if (!cfg) return { ok: false, error: `unsupported source ${source}` };
    const url = `${this.baseUrl.replace(/\/+$/, '')}${cfg.path}`;
    try {
      let body: unknown;
      try {
        body = await this.get(url);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        await this.sleep(FX_RETRY_DELAY_MS);
        body = await this.get(url);
      }
      return this.parse(body, cfg.fuente);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`FX provider ${source} failed: ${error}`);
      return { ok: false, error };
    }
  }

  private async get(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new RetryableError(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'provider timeout'
          : 'provider network error',
      );
    }
    if (res.status >= 500) {
      throw new RetryableError(`provider HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error('provider returned invalid JSON');
    }
  }

  private parse(body: unknown, fuente: string): FxProviderResult {
    if (!Array.isArray(body)) {
      return { ok: false, error: 'unexpected shape: body is not an array' };
    }
    const entry = (body as unknown[]).find(
      (e): e is Record<string, unknown> =>
        !!e &&
        typeof e === 'object' &&
        (e as Record<string, unknown>).fuente === fuente,
    );
    if (!entry) {
      return {
        ok: false,
        error: `unexpected shape: fuente "${fuente}" missing`,
      };
    }
    const raw = entry.promedio;
    const rate =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN;
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { ok: false, error: 'unexpected shape: promedio not numeric' };
    }
    if (Number.isNaN(rate)) {
      return { ok: false, error: 'unexpected shape: promedio not numeric' };
    }
    const date = new Date(
      typeof entry.fechaActualizacion === 'string'
        ? entry.fechaActualizacion
        : '',
    );
    if (Number.isNaN(date.getTime())) {
      return {
        ok: false,
        error: 'unexpected shape: fechaActualizacion invalid',
      };
    }
    return { ok: true, reading: { rate, providerUpdatedAt: date } };
  }
}
