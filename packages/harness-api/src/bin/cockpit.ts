// 起驾驶舱口（#3818）：node packages/harness-api/src/bin/cockpit.ts，配置全从环境变量来（法国上是单元的 EnvironmentFile）。
// 只读：读 fleet2.* 和 public.users；会话令牌的口在 kernel 进程的 127.0.0.1:7345，这里没有。

import type { Db } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createCockpitApi } from '../cockpit.ts';

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) {
    console.error(`没给 ${k}，不起`);
    process.exit(2);
  }
  return v;
};
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const port = Number(env.FLEET2_COCKPIT_PORT ?? 7346);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(`FLEET2_COCKPIT_PORT 不是端口：${env.FLEET2_COCKPIT_PORT}`);
  process.exit(2);
}
// 默认只听回环；法国上由单元环境给隧道地址
const host = env.FLEET2_COCKPIT_HOST ?? '127.0.0.1';

const sql = postgres(need('FLEET2_DATABASE_URL'), { max: 4, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const api = createCockpitApi({
  db,
  sessionSecret: need('FLEET_SESSION_SECRET'),
  ...(env.FLEET2_COCKPIT_COOKIE_NAME ? { cookieName: env.FLEET2_COCKPIT_COOKIE_NAME } : {}),
});
const bound = await api.listen(port, host);
log({ started: true, host, port: bound });

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log({ stopping: signal });
  await api.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
