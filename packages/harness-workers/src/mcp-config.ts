// 工人挂内核托管的 Streamable HTTP MCP（本机 2026-10-31 实测 reclaude -p 配 --mcp-config 能调到、--resume 续得上）。
// 令牌只进 0600 的配置文件，不进命令行：命令行谁都能列出来（旧坑 H1，飞书密钥两次泄漏都是列进程带出来的）。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** harness-api 认令牌的请求头。 */
export const SESSION_TOKEN_HEADER = 'X-Fleet-Session-Token';
export const MCP_SERVER_NAME = 'fleet';

export interface McpEndpoint {
  url: string;
  token: string;
}

export function mcpConfigJson(endpoint: McpEndpoint): string {
  const u = new URL(endpoint.url);
  if (u.search) throw new Error('MCP 地址里不许带查询参数：令牌只走请求头');
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: endpoint.url,
        headers: { [SESSION_TOKEN_HEADER]: endpoint.token },
      },
    },
  });
}

/** 写进工人自己的临时目录，只有工人用户读得到；回文件路径给 --mcp-config。 */
export async function writeMcpConfig(dir: string, endpoint: McpEndpoint): Promise<string> {
  const path = join(dir, 'mcp.json');
  await writeFile(path, mcpConfigJson(endpoint), { mode: 0o600, flag: 'wx' });
  return path;
}
