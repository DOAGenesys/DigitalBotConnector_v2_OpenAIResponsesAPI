import fs from 'fs/promises';
import path from 'path';
import type OpenAI from 'openai';
import logger from './logger';

/**
 * Loads the OpenAI tools array from the JSON file at MCP_SERVERS_CONFIG_PATH.
 * Entries without a "type" are treated as remote MCP servers.
 */
export async function loadConfiguredTools(configPath: string | undefined): Promise<OpenAI.Responses.Tool[]> {
  if (!configPath) return [];

  try {
    // Bundled explicitly via outputFileTracingIncludes in next.config.mjs.
    const raw = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), configPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.error('Tools config must be a JSON array; no tools loaded.');
      return [];
    }
    const tools = parsed.map(tool => ({ type: 'mcp', ...tool })) as OpenAI.Responses.Tool[];
    logger.debug({ count: tools.length }, 'Loaded OpenAI tools config');
    return tools;
  } catch (err) {
    // The parse error message can quote file contents, so only the error type is logged.
    logger.error({ errorType: (err as Error).name }, 'Failed to load tools config; no tools loaded.');
    return [];
  }
}
