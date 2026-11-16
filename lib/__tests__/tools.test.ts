import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadConfiguredTools } from '../tools';

async function writeTempConfig(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-config-'));
  const file = path.join(dir, 'tools.json');
  await fs.writeFile(file, contents, 'utf-8');
  return path.relative(process.cwd(), file);
}

describe('loadConfiguredTools', () => {
  it('returns no tools when no path is configured', async () => {
    expect(await loadConfiguredTools(undefined)).toEqual([]);
  });

  it('defaults entries without a type to MCP and keeps explicit types', async () => {
    const configPath = await writeTempConfig(
      JSON.stringify([{ server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp' }, { type: 'web_search' }]),
    );
    expect(await loadConfiguredTools(configPath)).toEqual([
      { type: 'mcp', server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp' },
      { type: 'web_search' },
    ]);
  });

  it('returns no tools for invalid JSON, non-array JSON, or a missing file', async () => {
    expect(await loadConfiguredTools(await writeTempConfig('{ not json'))).toEqual([]);
    expect(await loadConfiguredTools(await writeTempConfig('{"type":"mcp"}'))).toEqual([]);
    expect(await loadConfiguredTools('does-not-exist.json')).toEqual([]);
  });
});
