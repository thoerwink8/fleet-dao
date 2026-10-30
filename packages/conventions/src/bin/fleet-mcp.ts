// pnpm mcp:fleet（= node packages/conventions/src/bin/fleet-mcp.ts）：stdio MCP 服务，4 个工具经法国接口开单、派单、领活、读账本（#3739）。
// 登记方法见 packages/conventions/AGENTS.md「fleet MCP」。stdout 只给 MCP 协议用，日志一律走 stderr。

import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFleetMcpServer, fleetMcpSourceKind } from '../fleet-mcp.ts';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { removeLease, writeLease } from '../work-queue.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

let source: ReturnType<typeof fleetMcpSourceKind>;
try {
  source = fleetMcpSourceKind(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

const server = createFleetMcpServer({
  source,
  endpoint: () => readClaimsEndpoint(),
  fetch,
  claim: async (issue) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await work(['claim', String(issue)], {
      gh: ghRunner(root),
      post: liveClaimsPost(() => readClaimsEndpoint()),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: process.env,
      root,
      leases: { write: (rec) => writeLease(rec), remove: (repo, n) => removeLease(repo, n) },
    });
    return { code, out, err };
  },
});
await server.connect(new StdioServerTransport());
console.error(`fleet MCP 已起（来源 ${source}）`);
