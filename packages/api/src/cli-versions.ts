// 法国页「命令行工具」（GET /api/france/cli-tools）：读库里最近一次读数，落后现算。
// 没接上、库读失败：整段没查成和原因，不拿空列表冒充「都是最新」。
import { type Db, listCliToolReadings } from '@fleet-dao/db';
import { buildCliToolsResponse, type CliToolsResponse, CliToolsResponseSchema } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { reply } from './http.ts';
import type { CockpitEnv } from './session.ts';

export interface CliToolsPort {
  list(): ReturnType<typeof listCliToolReadings>;
}

export function pgCliTools(db: Db): CliToolsPort {
  return { list: () => listCliToolReadings(db) };
}

export async function readCliTools(port: CliToolsPort | undefined, now: Date): Promise<CliToolsResponse> {
  const asOf = now.toISOString();
  if (!port) return { state: 'unreadable', why: '这台后端没接上命令行工具版本的读取', asOf };
  try {
    const rows = await port.list();
    return buildCliToolsResponse(rows, now);
  } catch (err) {
    return { state: 'unreadable', why: errMessage(err), asOf };
  }
}

export function registerCliToolsRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  app.get('/france/cli-tools', async (c) =>
    reply(c, CliToolsResponseSchema, await readCliTools(deps.cliTools, deps.now())),
  );
}
