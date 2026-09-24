// 进程入口：两个监听——驾驶舱接口（生产上是 WireGuard 地址）与 fleet 命令接口（只本机）。
// 生产装配（数据库包的 Store 与 LISTEN、Temporal 客户端、GitHub 事件落库）还没接上，现在只能以开发模式起：
//   FLEET_ENV=development FLEET_DEV_LOGIN=1 node packages/api/src/main.ts
// 开发模式用内存里的样例数据，飞书登录没配时用 POST /auth/dev-login 免登。
import { serve } from '@hono/node-server';
import { signAgentToken } from './agent-token.ts';
import { buildApps } from './app.ts';
import { createChangeHub } from './changes.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Deps } from './deps.ts';
import { DEV_RUN_ID, DEV_USER_ID, devFixtures } from './dev-fixtures.ts';
import { createFeishuAuth } from './feishu.ts';
import { jsonLogger } from './log.ts';
import { createMemoryStore } from './memory-store.ts';

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
if (config.env !== 'development') {
  log.error('生产装配还没接上（等数据库包与 Temporal 客户端），现在只能用 FLEET_ENV=development 起');
  process.exit(1);
}

const changes = createChangeHub(log);
const store = createMemoryStore(devFixtures(new Date()), {
  onChange: (table, id) => changes.publish({ type: 'change', table, id }),
});
const deps: Deps = {
  config,
  store,
  changes,
  log,
  now: () => new Date(),
  feishu: config.feishu ? createFeishuAuth(config.feishu) : null,
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
};

const { cockpit, agent } = buildApps(deps);
serve({ fetch: cockpit.fetch, hostname: config.cockpitListen.host, port: config.cockpitListen.port });
serve({ fetch: agent.fetch, hostname: config.agentListen.host, port: config.agentListen.port });
log.info('驾驶舱后端已起（开发模式，内存样例数据）', {
  cockpit: `http://${config.cockpitListen.host}:${config.cockpitListen.port}`,
  agent: `http://${config.agentListen.host}:${config.agentListen.port}`,
  devLogin: config.devLogin ? DEV_USER_ID : false,
  // 给 packages/cli 联调用的令牌：对应样例数据里正在跑的那次会话，密钥是本次启动临时生成的。
  devFleetToken: signAgentToken(config.agentTokenSecret, {
    taskId: 'task-12',
    subtaskId: 'sub-12a',
    runId: DEV_RUN_ID,
    ttlSeconds: 8 * 60 * 60,
  }),
});
