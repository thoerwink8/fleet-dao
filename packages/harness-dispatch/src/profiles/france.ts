// 装配档案 france（VPS）：Postgres fleet2、systemd 起的内核进程、GitHub App 只读令牌、FLEET2_PUBLISH=1 才开真执行。
// 从原来的 bin/kernel.ts 原样搬来（#3858 只拆档案、不改行为）；配置全从环境变量来（法国上是单元的 EnvironmentFile）。
// 影子模式：接口层只听回环、对外零写；GitHub 只读短期令牌（用 App 凭据按仓现换）只在这个进程里。
// FLEET2_PUBLISH=1 开真执行（#3783）：对冻结的真执行批次认领单、派工，交回后经 outbox 推分支、开 PR，不合并。
import { makeRedactor, secretsFromEnv } from '@fleet-dao/harness-runner';
import type { Db } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import {
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
  WORKER_SHELLS,
  type WorkerShell,
} from '@fleet-dao/harness-workers';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appTokenSource, PUBLISH_PERMISSIONS } from '../github-app.ts';
import { githubReader } from '../github-read.ts';
import { githubWriter } from '../github-write.ts';
import { scopeSandbox } from '../scope-sandbox.ts';
import { acquireTask, currentFencing } from '../task-claim.ts';
import { type Assembly, ConfigError, type Env, log, need, port } from './config.ts';

export function assembleFrance(env: Env): Assembly {
  const command = JSON.parse(need(env, 'FLEET2_WORKER_COMMAND')) as unknown;
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== 'string')) {
    throw new ConfigError('FLEET2_WORKER_COMMAND 要是非空的字符串数组（JSON），例如 ["reclaude"]');
  }
  // FLEET2_SANDBOX=scope：工人以会话用户跑（法国，执行体前缀是 deploy/france/fleet2-worker.sh），目录经 fleet-agent-scope 交接
  const sandboxKind = env.FLEET2_SANDBOX ?? '';
  if (sandboxKind !== '' && sandboxKind !== 'scope') {
    throw new ConfigError(`FLEET2_SANDBOX 只认 scope（或不给）：${sandboxKind}`);
  }
  // FLEET2_SHELL：工人用哪个壳（#3842），claude-code（默认）或 grok；grok 要给 FLEET2_GROK_AUTH（登录态文件的绝对路径）
  const shell = (env.FLEET2_SHELL ?? 'claude-code') as WorkerShell;
  if (!WORKER_SHELLS.includes(shell)) {
    throw new ConfigError(`FLEET2_SHELL 只认 ${WORKER_SHELLS.join('、')}`);
  }
  const grokAuthPath = shell === 'grok' ? need(env, 'FLEET2_GROK_AUTH') : undefined;
  const permissionMode = (env.FLEET2_PERMISSION_MODE ?? 'bypassPermissions') as ClaudePermissionMode;
  if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) {
    throw new ConfigError(`FLEET2_PERMISSION_MODE 只认 ${CLAUDE_PERMISSION_MODES.join('、')}`);
  }

  const sql = postgres(need(env, 'FLEET2_DATABASE_URL'), { max: 4, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as unknown as Db;
  const redact = makeRedactor(secretsFromEnv(env));
  const appFile = need(env, 'FLEET2_GITHUB_APP_FILE');
  const gh = githubReader({ tokenFor: appTokenSource({ file: appFile }) });
  // FLEET2_PUBLISH=1：真执行（#3783，第 7 片）。另起一个令牌源，权限只有 PUBLISH_PERMISSIONS（contents 和 pull_requests 的写），
  // 只给发布那一步；读单、读合并结果仍用上面只读的。不开合并：这个进程里没有任何合并的调用。
  const publishOn = env.FLEET2_PUBLISH === '1';
  if (env.FLEET2_PUBLISH !== undefined && env.FLEET2_PUBLISH !== '1' && env.FLEET2_PUBLISH !== '0') {
    throw new ConfigError('FLEET2_PUBLISH 只认 1 或 0');
  }
  const writeToken = publishOn
    ? appTokenSource({ file: appFile, permissions: PUBLISH_PERMISSIONS })
    : undefined;
  const githubCalls = new Map<string, number>();

  return {
    profile: 'france',
    kernel: {
      db,
      redact,
      apiPort: port(env, 'FLEET2_API_PORT', 7345),
      dispatcher: {
        command: command as string[],
        shell,
        ...(grokAuthPath ? { grokAuthPath } : {}),
        model: need(env, 'FLEET2_MODEL'),
        permissionMode,
        // 工人环境由 buildWorkerEnv 按白名单现场构造，宿主的凭据一个都不抄
        hostEnv: env,
        tmpRoot: need(env, 'FLEET2_WORK_ROOT'),
        ...(sandboxKind === 'scope' ? { sandbox: scopeSandbox() } : {}),
      },
      mirrorRoot: need(env, 'FLEET2_MIRROR_ROOT'),
      workRoot: need(env, 'FLEET2_WORK_ROOT'),
      workerHome: need(env, 'FLEET2_WORKER_HOME'),
      egressPort: port(env, 'FLEET2_EGRESS_PORT', 7344),
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
      ...(writeToken
        ? {
            publish: {
              acquire: (ref, title) => acquireTask(db, ref, title),
              model: need(env, 'FLEET2_MODEL'),
              outbox: {
                github: githubWriter({
                  tokenFor: writeToken,
                  // 旧坑 E1：每次 GitHub 写口的调用记一笔，按粗名字累计，tick 报告里带出来
                  onCall: (what) => githubCalls.set(what, (githubCalls.get(what) ?? 0) + 1),
                }),
                tokenFor: writeToken,
                fencingOf: (ref) => currentFencing(db, ref),
                hostEnv: env,
              },
            },
          }
        : {}),
      onTick: (r) => {
        if (
          r.real &&
          (r.real.requested > 0 || r.real.skipped.length > 0 || (r.real.outbox?.claimed ?? 0) > 0)
        ) {
          log({ real: r.real, githubCalls: Object.fromEntries(githubCalls) });
        }
      },
      tickMs: Number(env.FLEET2_TICK_MS ?? 30_000),
    },
    startedFields: () => ({ shadow: !publishOn, publish: publishOn }),
    close: () => sql.end({ timeout: 5 }),
  };
}
