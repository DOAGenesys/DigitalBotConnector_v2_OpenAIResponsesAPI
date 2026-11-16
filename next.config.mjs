/** @type {import('next').NextConfig} */
const nextConfig = {
  // The tools file is read at runtime from MCP_SERVERS_CONFIG_PATH, which file tracing cannot detect.
  outputFileTracingIncludes: {
    '/api/botconnector/messages': ['./mcp_config.json'],
  },
};

export default nextConfig;
