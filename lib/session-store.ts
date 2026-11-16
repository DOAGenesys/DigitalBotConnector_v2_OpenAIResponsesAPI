import { Redis } from '@upstash/redis';
import { getConfig } from './config';
import logger from './logger';

const config = getConfig();

export const SESSION_VARIABLE_NAMES = [
  'openai_model',
  'openai_reasoning_effort',
  'openai_temperature',
  'openai_verbosity',
  'data_action_ids',
  'data_action_descriptions',
  'system_prompt',
] as const;

export type SessionVariables = Partial<Record<(typeof SESSION_VARIABLE_NAMES)[number], string>>;

interface SessionData {
  previousResponseId?: string;
  sessionVariables?: SessionVariables;
  dataActionSchemas?: { [key: string]: { input: any; success: any } };
}

/** Values sent by Genesys in this turn win; otherwise the values stored for the session apply. */
export function mergeSessionVariables(
  stored: SessionVariables | undefined,
  parameters: Record<string, string> | undefined,
): SessionVariables {
  const merged: SessionVariables = {};
  for (const name of SESSION_VARIABLE_NAMES) {
    const value = parameters?.[name] || stored?.[name];
    if (value) merged[name] = value;
  }
  return merged;
}

interface SessionStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  getSessionData(key: string): Promise<SessionData | undefined>;
  setSessionData(key: string, data: SessionData, ttl?: number): Promise<void>;
}

class MemoryStore implements SessionStore {
  private store = new Map<string, string>();
  private sessionDataStore = new Map<string, SessionData>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    this.store.set(key, value);
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key)!);
    }
    if (ttl) {
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.sessionDataStore.delete(key);
        this.timeouts.delete(key);
      }, ttl * 1000);
      this.timeouts.set(key, timeout);
    }
  }

  async getSessionData(key: string): Promise<SessionData | undefined> {
    return this.sessionDataStore.get(key);
  }

  async setSessionData(key: string, data: SessionData, ttl?: number): Promise<void> {
    this.sessionDataStore.set(key, data);
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key)!);
    }
    if (ttl) {
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.sessionDataStore.delete(key);
        this.timeouts.delete(key);
      }, ttl * 1000);
      this.timeouts.set(key, timeout);
    }
  }
}

class RedisStore implements SessionStore {
  private client: Redis;

  constructor() {
    // The client's default (5 retries with exponential backoff) adds about 4 seconds per call when
    // Redis is unreachable, which pushes replies past the Genesys Bot Response Timeout.
    this.client = new Redis({
      url: config.KV_REST_API_URL!,
      token: config.KV_REST_API_TOKEN!,
      retry: { retries: 1, backoff: () => 200 },
      signal: () => AbortSignal.timeout(3000),
    });
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const value = await this.client.get(key);
      return (value as string) || undefined;
    } catch (error) {
      logger.error({ msg: 'Redis GET failed', key, error: (error as Error).message });
      return undefined;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      if (ttl) {
        await this.client.set(key, value, { ex: ttl });
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      logger.error({ msg: 'Redis SET failed', key, ttl, error: (error as Error).message });
    }
  }

  async getSessionData(key: string): Promise<SessionData | undefined> {
    try {
      const sessionKey = `session_data:${key}`;
      const value = await this.client.get<SessionData>(sessionKey);
      if (!value) {
        return undefined;
      }
      return value;
    } catch (error) {
      logger.error({ 
        msg: 'Redis GET session data failed', 
        key, 
        error: (error as Error).message,
        errorType: (error as Error).constructor.name
      });
      return undefined;
    }
  }

  async setSessionData(key: string, data: SessionData, ttl?: number): Promise<void> {
    try {
      const sessionKey = `session_data:${key}`;
      if (ttl) {
        await this.client.set(sessionKey, data, { ex: ttl });
      } else {
        await this.client.set(sessionKey, data);
      }
    } catch (error) {
      logger.error({ msg: 'Redis SET session data failed', key, ttl, error: (error as Error).message });
    }
  }
}

let store: SessionStore;

export type { SessionData };
export function getSessionStore(): SessionStore {
  if (!store) {
    if (config.SESSION_STORE_TYPE === 'redis') {
      if (config.KV_REST_API_URL && config.KV_REST_API_TOKEN) {
        logger.info('Using Redis for session store.');
        store = new RedisStore();
      } else {
        logger.warn(
          'SESSION_STORE_TYPE is "redis" but KV_REST_API_URL or KV_REST_API_TOKEN are not set. Falling back to in-memory store.'
        );
        store = new MemoryStore();
      }
    } else {
      logger.info('Using in-memory store for sessions.');
      store = new MemoryStore();
    }
  }
  return store;
}
