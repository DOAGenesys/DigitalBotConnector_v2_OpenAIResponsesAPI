import { getConfig } from './config';

type Window = { timestamps: number[] };
const perKeyWindows = new Map<string, Window>();

export function allowActionForKey(key: string): boolean {
  const config = getConfig();
  const limit = config.GENESYS_ACTIONS_PER_MINUTE;
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  const win = perKeyWindows.get(key) || { timestamps: [] };
  win.timestamps = win.timestamps.filter(t => t >= windowStart);
  if (win.timestamps.length >= limit) {
    perKeyWindows.set(key, win);
    return false;
  }
  win.timestamps.push(now);
  perKeyWindows.set(key, win);
  return true;
}


