import logger from './logger';
import { getConfig } from './config';

interface OAuthToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: OAuthToken | undefined;
let inflightPromise: Promise<OAuthToken> | undefined;

function getLoginUrl(): string {
  const config = getConfig();
  if (config.GENESYS_LOGIN_URL) return config.GENESYS_LOGIN_URL;
  if (config.GENESYS_REGION) {
    return config.GENESYS_REGION.includes('.')
      ? `https://login.${config.GENESYS_REGION}`
      : `https://login.${config.GENESYS_REGION}.mypurecloud.com`;
  }
  return 'https://login.mypurecloud.com';
}

export async function getGenesysOAuthToken(): Promise<{ accessToken: string }> {
  const config = getConfig();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60000 > now) {
    return { accessToken: cachedToken.accessToken };
  }
  if (inflightPromise) {
    const token = await inflightPromise;
    return { accessToken: token.accessToken };
  }
  if (!config.GENESYS_CLIENT_ID || !config.GENESYS_CLIENT_SECRET) {
    throw new Error('genesys_oauth_not_configured: set GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET');
  }
  const loginUrl = getLoginUrl();
  const clientId = config.GENESYS_CLIENT_ID;
  const clientSecret = config.GENESYS_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.GENESYS_HTTP_TIMEOUT_MS);
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');

  let attempt = 0;
  async function fetchToken(): Promise<OAuthToken> {
    const start = Date.now();
    try {
      const res = await fetch(`${loginUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });
      const durationMs = Date.now() - start;
      if (res.status === 401 || res.status === 403) {
        const text = await res.text();
        logger.error({ msg: 'Genesys OAuth unauthorized', status: res.status, durationMs });
        throw new Error(`genesys_oauth_unauthorized:${res.status}:${text}`);
      }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 1;
        logger.warn({ msg: 'Genesys OAuth rate limited', retryAfter, durationMs });
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        throw new Error('retry');
      }
      if (!res.ok) {
        const text = await res.text();
        logger.warn({ msg: 'Genesys OAuth non-OK', status: res.status, durationMs });
        throw new Error(`oauth_http_error:${res.status}:${text}`);
      }
      const json = await res.json();
      const accessToken = json.access_token as string;
      const expiresIn = Number(json.expires_in || 3600);
      const token: OAuthToken = { accessToken, expiresAt: Date.now() + Math.min(expiresIn, config.GENESYS_TOKEN_CACHE_TTL_SECONDS) * 1000 };
      cachedToken = token;
      logger.debug({ msg: 'Genesys OAuth obtained', durationMs });
      return token;
    } catch (e: any) {
      if (e.name === 'AbortError') {
        logger.error({ msg: 'Genesys OAuth timeout' });
        throw new Error('oauth_timeout');
      }
      attempt += 1;
      if (attempt <= config.GENESYS_HTTP_RETRY_MAX) {
        const backoff = config.GENESYS_HTTP_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
        return fetchToken();
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  inflightPromise = fetchToken();
  try {
    const token = await inflightPromise;
    return { accessToken: token.accessToken };
  } finally {
    inflightPromise = undefined;
  }
}
