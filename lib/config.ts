interface Config {
  PORT: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  GENESYS_CONNECTION_SECRET: string;
  DEFAULT_OPENAI_MODEL: string;
  DEFAULT_OPENAI_TEMPERATURE: number;
  MCP_SERVERS_CONFIG_PATH?: string;
  SESSION_STORE_TYPE: 'memory' | 'redis';
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
}

let config: Config;

export function getConfig(): Config {
  if (!config) {
    config = {
      PORT: parseInt(process.env.PORT || '3000', 10),
      LOG_LEVEL: (process.env.LOG_LEVEL || 'info') as Config['LOG_LEVEL'],
      GENESYS_CONNECTION_SECRET: process.env.GENESYS_CONNECTION_SECRET || '',
      DEFAULT_OPENAI_MODEL: process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o',
      DEFAULT_OPENAI_TEMPERATURE: parseFloat(process.env.DEFAULT_OPENAI_TEMPERATURE || '0.7'),
      MCP_SERVERS_CONFIG_PATH: process.env.MCP_SERVERS_CONFIG_PATH,
      SESSION_STORE_TYPE: (process.env.SESSION_STORE_TYPE || 'memory') as Config['SESSION_STORE_TYPE'],
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
  }
  return config;
}
