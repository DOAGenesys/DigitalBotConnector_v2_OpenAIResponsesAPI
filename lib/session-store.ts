import { createClient } from 'redis';
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
      clearTimeout(this.timeouts.get(key));
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
  private client: ReturnType<typeof createClient>;

  constructor() {
    if (!config.REDIS_URL) {
      throw new Error('REDIS_URL not set');
    }
    this.client = createClient({ url: config.REDIS_URL });
    this.client.on('error', err => logger.error('Redis Client Error', err));
    this.client.connect();
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value || undefined;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.set(key, value, { EX: ttl });
    } else {
      await this.client.set(key, value);
    }
  }
}

let store: SessionStore;

export function getSessionStore(): SessionStore {
  if (!store) {
    if (config.SESSION_STORE_TYPE === 'redis') {
      store = new RedisStore();
    } else {
      store = new MemoryStore();
    }
  }
  return store;
}
