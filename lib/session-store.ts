import { Redis } from '@upstash/redis';
import { getConfig } from './config';
import logger from './logger';

const config = getConfig();

interface SessionStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttl?: number): Promise<void>;
}

class MemoryStore implements SessionStore {
  private store = new Map<string, string>();
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
        this.timeouts.delete(key);
      }, ttl * 1000);
      this.timeouts.set(key, timeout);
    }
  }
}

class RedisStore implements SessionStore {
  private client: Redis;

  constructor() {
    this.client = new Redis({ url: config.KV_REST_API_URL!, token: config.KV_REST_API_TOKEN! });
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return (value as string) || undefined;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.set(key, value, { ex: ttl });
    } else {
      await this.client.set(key, value);
    }
  }
}

let store: SessionStore;

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
