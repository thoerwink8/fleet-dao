// 起新内核进程（#3811）：node packages/harness-dispatch/src/bin/kernel.ts，配置全从环境变量来（法国上是单元的 EnvironmentFile）。
// 影子模式：接口层只听回环、对外零写；GitHub 只读令牌只在这个进程里。每行一条 JSON 打到 stdout（进 journal），
// 影子静默打 {"alert":"shadow-silent",…}。收到 SIGTERM 先不领新活、等跑着的工人收尾再退。
import { makeRedactor, secretsFromEnv } from '@fleet-dao/harness-runner';
import type { Db } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode, scopeSandbox } from '@fleet-dao/harness-workers';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { githubReader } from '../github-read.ts';
import { createKernel } from '../kernel.ts';

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) {
    console.error(`没给 ${k}，不起`);
    process.exit(2);
  }
  return v;
};
const port = (k: string, def: number): number => {
  const n = Number(env[k] ?? def);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
    console.error(`${k} 不是端口：${env[k]}`);
    process.exit(2);
  }
  return n;
};
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const command = JSON.parse(need('FLEET2_WORKER_COMMAND')) as unknown;
if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== 'string')) {
  console.error('FLEET2_WORKER_COMMAND 要是非空的字符串数组（JSON），例如 ["reclaude"]');
  process.exit(2);
}
// FLEET2_SANDBOX=scope：工人以会话用户跑（法国，执行体前缀是 deploy/france/fleet2-worker.sh），目录经 fleet-agent-scope 交接
const sandboxKind = env.FLEET2_SANDBOX ?? '';
if (sandboxKind !== '' && sandboxKind !== 'scope') {
  console.error(`FLEET2_SANDBOX 只认 scope（或不给）：${sandboxKind}`);
  process.exit(2);
}
const permissionMode = (env.FLEET2_PERMISSION_MODE ?? 'bypassPermissions') as ClaudePermissionMode;
if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) {
  console.error(`FLEET2_PERMISSION_MODE 只认 ${CLAUDE_PERMISSION_MODES.join('、')}`);
  process.exit(2);
}

const sql = postgres(need('FLEET2_DATABASE_URL'), { max: 4, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const redact = makeRedactor(secretsFromEnv(env));
const gh = githubReader({ token: need('FLEET2_GITHUB_READ_TOKEN') });

const kernel = createKernel({
  db,
  redact,
  apiPort: port('FLEET2_API_PORT', 7345),
  dispatcher: {
    command: command as string[],
    model: need('FLEET2_MODEL'),
    permissionMode,
    // 工人环境由 buildWorkerEnv 按白名单现场构造，宿主的凭据一个都不抄
    hostEnv: env,
    tmpRoot: need('FLEET2_WORK_ROOT'),
    ...(sandboxKind === 'scope' ? { sandbox: scopeSandbox() } : {}),
  },
  mirrorRoot: need('FLEET2_MIRROR_ROOT'),
  workRoot: need('FLEET2_WORK_ROOT'),
  workerHome: need('FLEET2_WORKER_HOME'),
  egressPort: port('FLEET2_EGRESS_PORT', 7344),
  taskFor: gh.taskFor,
  readMerged: gh.readMerged,
  onSilence: (batchId, s) =>
    log({
      alert: 'shadow-silent',
      batchId,
      pending: s.pending,
      lastAt: s.lastAt.toISOString(),
      silentMs: s.silentMs,
    }),
  onError: (step, err) =>
    log({ error: step, message: redact(err instanceof Error ? err.message : String(err)) }),
  tickMs: Number(env.FLEET2_TICK_MS ?? 30_000),
});

const apiPort = await kernel.start();
log({ started: true, apiPort, shadow: true });

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log({ stopping: signal });
  await kernel.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
