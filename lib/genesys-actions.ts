import { getConfig } from './config';
import logger from './logger';
import { getGenesysOAuthToken } from './genesys-auth';

type JsonSchema = { [key: string]: any };

export class GenesysActionsClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    const config = getConfig();
    this.baseUrl = (opts.baseUrl || config.GENESYS_BASE_URL || this.deriveBaseUrl()) as string;
    this.timeoutMs = opts.timeoutMs || config.GENESYS_HTTP_TIMEOUT_MS;
  }

  private deriveBaseUrl(): string {
    const config = getConfig();
    if (config.GENESYS_BASE_URL) return config.GENESYS_BASE_URL;
    if (config.GENESYS_REGION) {
      // A host suffix such as "mypurecloud.de" or "euw2.pure.cloud"; a bare segment keeps the legacy form.
      return config.GENESYS_REGION.includes('.')
        ? `https://api.${config.GENESYS_REGION}`
        : `https://api.${config.GENESYS_REGION}.mypurecloud.com`;
    }
    return 'https://api.mypurecloud.com';
  }

  private async get<T>(path: string): Promise<T> {
    const { accessToken } = await getGenesysOAuthToken();
    let attempt = 0;
    const config = getConfig();
    const url = `${this.baseUrl}${path}`;
    const doFetch = async (): Promise<T> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const start = Date.now();
        const res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        const durationMs = Date.now() - start;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 1;
          logger.warn({ msg: 'Genesys GET rate limited', path, retryAfter, durationMs, attempt });
          if (attempt >= config.GENESYS_HTTP_RETRY_MAX) {
            throw new Error(`rate_limited_max_retries:${res.status}`);
          }
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          throw new Error('retry');
        }
        if (!res.ok) {
          const text = await res.text();
          logger.warn({ msg: 'Genesys GET non-OK', path, status: res.status, durationMs });
          throw new Error(`http_error:${res.status}:${text}`);
        }
        const json = (await res.json()) as T;
        logger.debug({ msg: 'Genesys GET ok', path, durationMs });
        return json;
      } catch (e: any) {
        if (e.name === 'AbortError') {
          logger.error({ msg: 'Genesys GET timeout', path });
          throw new Error('timeout');
        }
        if (e.message === 'retry') {
          attempt += 1;
          if (attempt <= config.GENESYS_HTTP_RETRY_MAX) {
            return doFetch();
          }
          throw new Error('max_retries_exceeded');
        }
        attempt += 1;
        if (attempt <= config.GENESYS_HTTP_RETRY_MAX) {
          const backoff = config.GENESYS_HTTP_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, backoff));
          return doFetch();
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }
    return doFetch();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { accessToken } = await getGenesysOAuthToken();
    let attempt = 0;
    const config = getConfig();
    const url = `${this.baseUrl}${path}`;
    const doFetch = async (): Promise<T> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const start = Date.now();
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const durationMs = Date.now() - start;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 1;
          logger.warn({ msg: 'Genesys POST rate limited', path, retryAfter, durationMs, attempt });
          if (attempt >= config.GENESYS_HTTP_RETRY_MAX) {
            throw new Error(`rate_limited_max_retries:${res.status}`);
          }
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          throw new Error('retry');
        }
        if (!res.ok) {
          const text = await res.text();
          logger.warn({ msg: 'Genesys POST non-OK', path, status: res.status, durationMs });
          throw new Error(`http_error:${res.status}:${text}`);
        }
        const json = (await res.json()) as T;
        logger.debug({ msg: 'Genesys POST ok', path, durationMs });
        return json;
      } catch (e: any) {
        if (e.name === 'AbortError') {
          logger.error({ msg: 'Genesys POST timeout', path });
          throw new Error('timeout');
        }
        if (e.message === 'retry') {
          attempt += 1;
          if (attempt <= config.GENESYS_HTTP_RETRY_MAX) {
            return doFetch();
          }
          throw new Error('max_retries_exceeded');
        }
        attempt += 1;
        if (attempt <= config.GENESYS_HTTP_RETRY_MAX) {
          const backoff = config.GENESYS_HTTP_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, backoff));
          return doFetch();
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    };
    return doFetch();
  }

  async getInputSchema(dataActionId: string): Promise<JsonSchema> {
    const schema = await this.get<JsonSchema>(`/api/v2/integrations/actions/${encodeURIComponent(dataActionId)}/schemas/inputschema.json`);
    if (!schema || typeof schema !== 'object') {
      throw new Error('invalid_input_schema');
    }
    const normalizedSchema = {
      type: 'object',
      properties: {},
      ...schema,
    };
    return normalizedSchema;
  }

  async getSuccessSchema(dataActionId: string): Promise<JsonSchema> {
    const schema = await this.get<JsonSchema>(`/api/v2/integrations/actions/${encodeURIComponent(dataActionId)}/schemas/successschema.json`);
    if (!schema || typeof schema !== 'object') {
      throw new Error('invalid_success_schema');
    }
    const normalizedSchema = {
      type: 'object',
      properties: {},
      ...schema,
    };
    return normalizedSchema;
  }

  async executeActionTest<T = unknown>(dataActionId: string, payload: unknown): Promise<T> {
    const result = await this.post<T>(`/api/v2/integrations/actions/${encodeURIComponent(dataActionId)}/test`, payload);
    return result;
  }
}
