// 进程入口：两个监听——驾驶舱接口（生产上是法国机器的隧道地址，香港经它访问）与 fleet 命令接口（只本机回环）。
// 地址、端口、密钥都从本机配置（环境变量）读，见 config.ts。
// - 有 DATABASE_URL：真库（Postgres Store + LISTEN fleet_changes）。生产必须有。GitHub 事件原文落库、issue 变成任务；
//   PR、CI 事件经 @fleet-dao/github 写镜像（机器人凭据在 /etc/fleet-dao/github，读不到时如实失败、健康检查报红）。
// - 开发环境没有 DATABASE_URL：内存里的样例数据；飞书登录没配时可以用 POST /auth/dev-login 免登（只许本机回环监听）。
// Temporal 客户端（发信号、拉起需求工作流）没接上：健康检查如实报红，发信号返回 503，拉起工作流的投递记成出错。
import type { Server } from 'node:http';
import { createDb, type Db } from '@fleet-dao/db';
import { createGitHub, pgLedger, pgLocker } from '@fleet-dao/github';
import { serve } from '@hono/node-server';
import { signAgentToken } from './agent-token.ts';
import { buildApps } from './app.ts';
import { createChangeHub, startPgChangeFeed } from './changes.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createDirDemoPublisher, sweepExpiredDemoLinks } from './demo.ts';
import type { Deps } from './deps.ts';
import { DEV_RUN_ID, DEV_USER_ID, devFixtures, IDS } from './dev-fixtures.ts';
import { createFeishuAuth } from './feishu.ts';
import { githubAppMissing, githubEventsCheck } from './github.ts';
import { serviceHealthChecks } from './health.ts';
import { jsonLogger } from './log.ts';
import { createMemoryStore } from './memory-store.ts';
import { createPgStore, probeDb, withStatementTimeout } from './pg-store.ts';
import { type GitHubEventSink, type RequirementWorkflows, WorkflowUnavailableError } from './ports.ts';
import { notConnectedTemporal } from './temporal.ts';

const log = jsonLogger();

/** 拉起需求工作流要经 Temporal 客户端；没接上时如实失败（这条投递记成出错，接上后由对账重放）。 */
const requirementsNotConnected: RequirementWorkflows = {
  async start() {
    throw new WorkflowUnavailableError('拉起需求工作流的 Temporal 客户端没接上');
  },
};

/**
 * PR、CI 事件写镜像：@fleet-dao/github 的事件去处，要两个机器人的凭据（只在这里、启动时读一次）。读不到时后端照样起
 * （issue 照收），PR、CI 事件如实失败，健康检查的 github_events 报红（credentialsMissing）；补上凭据要重启后端。
 */
function githubMirror(db: Db): { sink: GitHubEventSink; credentialsMissing?: () => Promise<void> } {
  try {
    const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db, { log }), log });
    // 引擎等 CI 靠活动自己轮询（waitCi），不收按事件叫醒的信号：PR、CI 事件只写镜像
    return { sink: gh.eventSink({ async wake() {} }) };
  } catch (err) {
    log.error('GitHub 机器人的凭据没读到：PR、CI 事件写不进镜像（issue 照收）', { error: String(err) });
    const missing = githubAppMissing(String(err));
    return { sink: missing.sink, credentialsMissing: missing.check };
  }
}

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
const demo = config.demoDir ? createDirDemoPublisher(config.demoDir) : null;

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
      demo,
      health: [],
      workflows: {
        async signal(taskId, signal) {
          log.info('（开发）发给工作流的信号', { taskId, signal: signal.name });
        },
      },
      requirements: {
        async start(input) {
          log.info('（开发）拉起需求工作流', { taskId: input.taskId, issueNumber: input.issueNumber });
          return 'started';
        },
      },
      github: {
        async accept(event) {
          log.info('（开发）收到 GitHub 事件', { event: event.event, repo: event.repo, wake: event.wake });
        },
      },
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
  const github = githubMirror(db);
  const store = createPgStore(db, { now });
  const deps: Deps = {
    config,
    store,
    changes: feed,
    log,
    now,
    feishu,
    demo,
    workflows: temporal.control,
    requirements: requirementsNotConnected,
    github: github.sink,
    health: serviceHealthChecks({
      probeDb: () => probeDb(db),
      feed,
      temporal,
      githubEvents: githubEventsCheck({ store, now, credentialsMissing: github.credentialsMissing }),
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
const { cockpit, agent } = buildApps(deps);
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

// 演示链接到期就撤掉公开的范围文件：没人打开驾驶舱时也要撤（列表接口也会顺手撤）。撤不成照实记错误，下个钟头再来。
if (demo) {
  const sweep = () =>
    sweepExpiredDemoLinks(demo, now()).catch((err: unknown) =>
      log.error('撤过期的演示链接没成', { error: String(err) }),
    );
  void sweep();
  setInterval(() => void sweep(), 60 * 60_000).unref();
}

/** 退出时给在途的短请求多久做完（做完了幂等回执才记得上，插头重试不会重做）。 */
const DRAIN_MS = 3_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('收到退出信号，停止接新请求', { signal });
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
