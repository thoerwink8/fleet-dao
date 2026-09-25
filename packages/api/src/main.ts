// 进程入口：两个监听——驾驶舱接口（生产上是法国机器的隧道地址，香港经它访问）与 fleet 命令接口（只本机回环）。
// 地址、端口、密钥都从本机配置（环境变量）读，见 config.ts。
// - 有 DATABASE_URL：真库（Postgres Store + LISTEN fleet_changes）。生产必须有。
// - 开发环境没有 DATABASE_URL：内存里的样例数据；飞书登录没配时可以用 POST /auth/dev-login 免登（只许本机回环监听）。
// Temporal 客户端、GitHub 事件落库等引擎的 PR 合了再接；在那之前健康检查如实报红，发信号返回 503。
// 飞书确认的草稿去开单（DraftOpener）也等 #43 接：在那之前草稿留在「待开单」、健康检查报红，这里定时补开，接上后自动开出来。
import type { Server } from 'node:http';
import { createDb } from '@fleet-dao/db';
import { serve } from '@hono/node-server';
import { signAgentToken } from './agent-token.ts';
import { buildApps } from './app.ts';
import { createChangeHub, startPgChangeFeed } from './changes.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Deps } from './deps.ts';
import { DEV_RUN_ID, DEV_USER_ID, devFixtures, IDS } from './dev-fixtures.ts';
import { draftBacklogCheck, notWiredDraftOpener } from './draft-opening.ts';
import { createFeishuAuth } from './feishu.ts';
import { notWiredGitHub } from './github.ts';
import { serviceHealthChecks } from './health.ts';
import { jsonLogger } from './log.ts';
import { createMemoryStore } from './memory-store.ts';
import { createPgStore, probeDb, withStatementTimeout } from './pg-store.ts';
import { notConnectedTemporal } from './temporal.ts';

const log = jsonLogger();

function load() {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const config = load();
const now = () => new Date();
const feishu = config.feishu ? createFeishuAuth(config.feishu) : null;

async function assemble(): Promise<{ deps: Deps; close: () => Promise<void> }> {
  if (config.databaseUrl === null) {
    // 只有开发环境会走到这里（生产缺 DATABASE_URL 在 loadConfig 就拒绝启动了）。
    const changes = createChangeHub(log);
    const store = createMemoryStore(devFixtures(now()), {
      onChange: (table, id) => changes.publish({ type: 'change', table, id }),
    });
    const deps: Deps = {
      config,
      store,
      changes,
      log,
      now,
      feishu,
      health: [],
      workflows: {
        async signal(taskId, signal) {
          log.info('（开发）发给工作流的信号', { taskId, signal: signal.name });
        },
      },
      github: {
        async accept(event) {
          log.info('（开发）收到 GitHub 事件', { event: event.event, repo: event.repo, wake: event.wake });
        },
      },
      draftOpener: notWiredDraftOpener(),
    };
    return { deps, close: async () => {} };
  }

  const { db, client, listen, close: closeDb } = createDb({ url: withStatementTimeout(config.databaseUrl) });
  const feed = startPgChangeFeed(
    {
      listen,
      notify: async (channel, payload) => {
        await client.notify(channel, payload);
      },
    },
    log,
  );
  const temporal = notConnectedTemporal();
  const github = notWiredGitHub();
  const store = createPgStore(db, { now });
  const draftOpener = notWiredDraftOpener();
  const deps: Deps = {
    config,
    store,
    changes: feed,
    log,
    now,
    feishu,
    workflows: temporal.control,
    github: github.sink,
    draftOpener,
    health: serviceHealthChecks({
      probeDb: () => probeDb(db),
      feed,
      temporal,
      githubEvents: github.check,
      draftOpener,
      draftBacklog: draftBacklogCheck(store, now),
    }),
  };
  return {
    deps,
    close: async () => {
      await feed.stop();
      await temporal.close();
      await closeDb();
    },
  };
}

const { deps, close } = await assemble();
const { cockpit, agent, draftOpening } = buildApps(deps);
const stopDraftOpening = draftOpening.start();
const servers = [
  serve({ fetch: cockpit.fetch, hostname: config.cockpitListen.host, port: config.cockpitListen.port }),
  serve({ fetch: agent.fetch, hostname: config.agentListen.host, port: config.agentListen.port }),
];

log.info('驾驶舱后端已起', {
  env: config.env,
  store: config.databaseUrl === null ? 'memory' : 'postgres',
  cockpit: `${config.cockpitListen.host}:${config.cockpitListen.port}`,
  agent: `${config.agentListen.host}:${config.agentListen.port}`,
  devLogin: config.devLogin ? DEV_USER_ID : false,
  // 给 packages/cli 联调用的令牌：只在内存样例数据下给，对应样例里正在跑的那次会话；密钥是本次启动临时生成的。
  ...(config.env === 'development' && config.databaseUrl === null
    ? {
        devFleetToken: signAgentToken(config.agentTokenSecret, {
          taskId: IDS.task12,
          subtaskId: IDS.sub12a,
          runId: DEV_RUN_ID,
          ttlSeconds: 8 * 60 * 60,
        }),
      }
    : {}),
});

/** 退出时给在途的短请求多久做完（做完了幂等回执才记得上，插头重试不会重做）。 */
const DRAIN_MS = 3_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('收到退出信号，停止接新请求', { signal });
  stopDraftOpening();
  const drained = Promise.all(
    servers.map((server) => new Promise<void>((resolve) => (server as Server).close(() => resolve()))),
  );
  for (const server of servers) (server as Server).closeIdleConnections?.();
  // SSE 和等回答的长连接不会自己结束：等到点了全部收掉，不然进程退不出去。
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
  for (const server of servers) (server as Server).closeAllConnections?.();
  try {
    await close();
  } catch (err) {
    log.error('退出时关连接出错', { error: String(err) });
  }
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
