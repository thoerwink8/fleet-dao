// 进程入口：两个监听——驾驶舱接口（生产上是法国机器的隧道地址，香港经它访问）与 fleet 命令接口（只本机回环）。
// 地址、端口、密钥都从本机配置（环境变量）读，见 config.ts。
// - 有 DATABASE_URL：真库（Postgres Store + LISTEN fleet_changes）+ 真 Temporal（懒连接，Temporal 没起来时
//   这一步不报错，健康检查会如实报红）。生产必须有。GitHub 事件原文落库；
//   PR、CI 事件经 @fleet-dao/github 写镜像（机器人凭据在 /etc/fleet-dao/github，读不到时如实失败、健康检查报红）。
// - 开发环境没有 DATABASE_URL：内存里的样例数据；飞书登录没配时可以用 POST /auth/dev-login 免登（只许本机回环监听）；
//   发给工作流的信号只记日志，不接 Temporal。
import { createDb, type Db } from '@fleet-dao/db';
import { createGitHub, type ReleaseFactsReader } from '@fleet-dao/github';
import { jevConfigLocation } from '@fleet-dao/jev';
import {
  createMemoryStore,
  createPgStore,
  DEPLOY_LAG_NOT_HERE,
  DEV_RUN_ID,
  DEV_USER_ID,
  deployFacts,
  devFixtures,
  IDS,
  jsonLogger,
  pgAlertWork,
  pgLedger,
  pgLocker,
  readDeployLagInput,
  startDeployLagWatch,
  withStatementTimeout,
} from '@fleet-dao/store';
import { signAgentToken } from './agent-token.ts';
import { buildApps } from './app.ts';
import { CANARY_NOT_HERE, canaryHealthCheck } from './canary-health.ts';
import { pgCarpoolReconcile } from './carpool-reconcile-view.ts';
import { createChangeHub, startPgChangeFeed } from './changes.ts';
import { ConfigError, engineEnabled, loadConfig } from './config.ts';
import { probeDb } from './db-probe.ts';
import { deployLagCheck } from './deploy-lag-check.ts';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { createFeishuAuth } from './feishu.ts';
import { liveFranceReleasePort } from './france-release.ts';
import { createGatewaySeen, feishuGatewayPart } from './gateway-seen.ts';
import { githubAppMissing, githubEventsCheck } from './github.ts';
import { githubAppHealthCheck } from './github-app-health.ts';
import { serviceHealthChecks } from './health.ts';
import { engineHealthProbe } from './home-engine.ts';
import { createMemoryIntentStore } from './intent-store.ts';
import { createPgIntentStore } from './intent-store-pg.ts';
import { judgeHealthCheck } from './judge-health.ts';
import { COCKPIT_KEEP_ALIVE_MS } from './keep-alive.ts';
import { ListenFdError, startListeners } from './listen.ts';
import { nodeReporterFor, nodeReportPart } from './node-reporter.ts';
import { pgOrgSwitch } from './org-switch-view.ts';
import type { GitHubEventSink } from './ports.ts';
import { liveReleaseCardPort } from './release-card.ts';
import { liveReleaseRequestPort } from './release-request.ts';
import { pgRoutingEfforts } from './routing-efforts.ts';
import { pgRoutingLayers } from './routing-layers.ts';
import { pgRoutingOrder } from './routing-order.ts';
import { sessionOrgHealthCheck } from './session-org-health.ts';
import { closeConnectionWhenStopping, gracefulShutdown } from './shutdown.ts';
import { readEnvSnapshot, readHomeSnapshot } from './snapshots.ts';
import { pgTaskRoutePins } from './task-route-pins.ts';
import { connectTemporal, ENGINE_OFF } from './temporal.ts';
import { startWatchdogWatch, WATCHDOG_NOT_HERE, watchdogHealthCheck } from './watchdog-health.ts';

const log = jsonLogger();

/**
 * PR、CI 事件写镜像：@fleet-dao/github 的事件去处，要两个机器人的凭据（只在这里、启动时读一次）。读不到时后端照样起，
 * PR、CI 事件如实失败，健康检查的 github_events 报红（credentialsMissing）；补上凭据要重启后端。
 */
/** 机器人凭据没读到：发版卡读 GitHub 的每一样都如实抛这个原因（卡上各行写没查成 + 原因）。 */
function credentialsMissingFacts(why: string): ReleaseFactsReader {
  const fail = async (): Promise<never> => {
    throw new Error(`GitHub 机器人的凭据没读到（${why}）`);
  };
  return {
    mainlineHead: fail,
    commit: fail,
    mainCi: fail,
    compare: fail,
    lastMergedPull: fail,
    issueTitle: fail,
  };
}

function githubMirror(db: Db): {
  sink: GitHubEventSink;
  credentialsMissing?: () => Promise<void>;
  releaseFacts: ReleaseFactsReader;
} {
  try {
    const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db, { log }), log });
    // 引擎等 CI 靠活动自己轮询（waitCi），不收按事件叫醒的信号：PR、CI 事件只写镜像
    return {
      sink: gh.eventSink({ async wake() {} }),
      releaseFacts: gh.releaseFacts,
    };
  } catch (err) {
    log.error('GitHub 机器人的凭据没读到：PR、CI 事件写不进镜像', { error: String(err) });
    const missing = githubAppMissing(String(err));
    return {
      sink: missing.sink,
      credentialsMissing: missing.check,
      releaseFacts: credentialsMissingFacts(String(err)),
    };
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

/**
 * 往正式环境的看板推快照（看板多机）：配了 FLEET_NODE_REPORT_URL / _TOKEN 才建；拼快照要装好的 deps，所以先建、
 * 装配完再 start（下面 assemble 之后）。在用的提交号只在正式环境读得到（发布目录），别处不给。
 */
let snapshotDeps: Deps | undefined;
let reporterProbe: ReturnType<typeof engineHealthProbe> | undefined;
const nodeReporter = nodeReporterFor(config.nodeReport, {
  snapshot: async () => {
    if (!snapshotDeps) throw new Error('后端还没装配好');
    const deps = snapshotDeps;
    // 自己建一个引擎探针（带 15 秒缓存），不和驾驶舱的共用：一分钟才拼一次
    reporterProbe ??= engineHealthProbe({ health: deps.health, engineOff: config.engineOff, log, now });
    const sd = { ...deps, engineProbe: reporterProbe };
    const [home, env] = await Promise.all([readHomeSnapshot(sd), readEnvSnapshot(sd)]);
    return { home, env };
  },
  codeSha: () => {
    if (config.env !== 'production') return undefined;
    const current = readDeployLagInput().current;
    return 'sha' in current && current.sha !== null ? current.sha : undefined;
  },
  log,
  now,
});

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
      intents: createMemoryIntentStore({ now }),
      health: nodeReporter ? [nodeReporter.healthCheck] : [],
      workflows: {
        async signal(workflowId, signal) {
          log.info('（开发）发给工作流的信号', { workflowId, signal: signal.name });
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
  const temporal = connectTemporal({
    address: config.temporalAddress,
    namespace: config.temporalNamespace,
    taskQueue: config.fleetTaskQueue,
  });
  const github = githubMirror(db);
  const store = createPgStore(db, { now });
  // 正式环境（FLEET_ENV=production）：法国是；下面几项都接着、都判。
  // 线上版本跟不跟得上主线：正式环境才有发布目录和自动发布；读的时候现算，报警每 5 分钟判一次
  const production = config.env === 'production';
  const deployLag = production
    ? { check: deployLagCheck(() => readDeployLagInput(), now) }
    : { check: async () => {}, notWired: DEPLOY_LAG_NOT_HERE };
  const stopDeployLagWatch = production
    ? startDeployLagWatch({ db, read: () => readDeployLagInput(), now, log })
    : () => {};
  // 看门狗（#203）自己停了它自己报不了：后端每 5 分钟按登记表上它那一行看一次，停了推一条「看门狗停了」，好了自己撤
  const stopWatchdogWatch = production ? startWatchdogWatch({ db, now, log }) : () => {};
  // 飞书网关还来不来：飞书接口的门口记，/healthz 读的时候现算；没配通行证网关一律进不来，报「未接」
  const gatewaySeen = createGatewaySeen(now);
  const deps: Deps = {
    config,
    store,
    changes: feed,
    log,
    now,
    feishu,
    workflows: temporal.control,
    github: github.sink,
    gatewaySeen,
    // 飞书群聊理成的意图（#553 第 4 条）：网关收原话、取意图卡；指挥官经 fleet-api intent 读写同一张表
    intents: createPgIntentStore(db, { now }),
    // 提醒谁在处理（design 15.3）：认领、PR 镜像、静默都在同一个库；发布记录只在正式环境有
    alertWork: pgAlertWork(db, production ? () => deployFacts(readDeployLagInput()) : () => null),
    // 路由两层每一层现在活着吗（#574）：和引擎选路读同一份（路由两层那两张表 + 探针、额度、禁令现算）
    routingLayers: pgRoutingLayers(db),
    // 会话用户切号的现状（#194）：引擎落库的切号账本，额度页顶上一行
    orgSwitch: pgOrgSwitch(db),
    // 拼车额度对账（#194 方案 4.7）：接口说的已用美元 vs 本机会话记到的花费
    carpoolReconcile: pgCarpoolReconcile(db),
    // 每条路由的思考档位（#470）：引擎起会话时现读的就是这一列，改了下一个会话照新的
    routingEfforts: pgRoutingEfforts(db, now),
    // 路由两层的先后和开关（母单 #1089）：驾驶舱「路由」页改的就是选路读的那两张表的 position、enabled
    routingOrder: pgRoutingOrder(db, now),
    // 按单指定模型（驾驶舱改版 2026-10-07）：引擎给这张单的一段选路时现读的就是这张表，改了下一次选路照新的
    taskRoutePins: pgTaskRoutePins(db, now),
    // 环境页（#820 片 1）的版本那一项：正式环境读发布目录现算；别处不给，页面写「没查成」
    ...(production ? { deployLag: () => readDeployLagInput() } : {}),
    // /france 页发版一键（#618）：读 ~/.fleet-dao/release-train.*、起 pnpm release:onekey preflight。
    // 只在正式环境装：开发、内存版起这条命令会在开发者本机的仓里发，会害人以为发的是这台，所以不装、接口回「没接上」。
    ...(production ? { franceRelease: liveFranceReleasePort(log) } : {}),
    // /france 页「发版」卡（#1231）：主线头、CI、PR 现读 GitHub（同一份机器人凭据），法国在用的提交读发布目录；只在正式环境装
    ...(production ? { releaseCard: liveReleaseCardPort(github.releaseFacts) } : {}),
    // /france 页「发布到法国」按钮（#1232）：写请求文件，法国上 root 的单元接活（人工档）；后端自己不起带 root 的进程
    ...(production ? { releaseRequest: liveReleaseRequestPort() } : {}),
    health: serviceHealthChecks({
      probeDb: () => probeDb(db),
      feed,
      temporal,
      // 这台机器按 release.env 的 FLEET_SERVICES 没开引擎：engine 项报「未接」，不报红
      ...(engineEnabled(process.env) ? {} : { engineNotWired: ENGINE_OFF }),
      githubEvents: githubEventsCheck({ store, now, credentialsMissing: github.credentialsMissing }),
      // 和引擎读同一份位置（FLEET_JEV_CONFIG，默认 /etc/fleet-dao/jev.json）：引擎问得了、这里才报绿
      judge: judgeHealthCheck({ db, location: jevConfigLocation(process.env) }),
      deployLag,
      feishuGateway: feishuGatewayPart(config, gatewaySeen),
      // 引擎切号（#157）写的提醒：只有这台库上跑着的引擎会写，没开引擎的环境一直是好的
      sessionOrg: sessionOrgHealthCheck(db),
      // 引擎每小时对账自检两个机器人的权限、缺了写的提醒：同样只有这台库上跑着的引擎会写
      githubApp: githubAppHealthCheck(db),
      // 全流程巡检（#223）：引擎每 6 小时在巡检仓跑一轮、结论写进库；只在正式环境接。
      // 总开关关着时巡检整个不跑（#1086）：健康项认得、报跳过不红（#1141），这里给它总开关的现读
      canary: production
        ? { check: canaryHealthCheck(db, () => readEngineMaster(store), now) }
        : { check: async () => {}, notWired: CANARY_NOT_HERE },
      // 看门狗（#203）：引擎每 5 分钟跑一轮、记在登记表上；只在正式环境接
      watchdog: production
        ? { check: watchdogHealthCheck(db, now) }
        : { check: async () => {}, notWired: WATCHDOG_NOT_HERE },
      // 往正式环境的看板推快照：没配推送地址报「未接」
      nodeReport: nodeReportPart(nodeReporter),
    }),
  };
  return {
    deps,
    close: async () => {
      stopDeployLagWatch();
      stopWatchdogWatch();
      await feed.stop();
      await temporal.close();
      await closeDb();
    },
  };
}

const { deps, close } = await assemble();
snapshotDeps = deps;
nodeReporter?.start();
// 给停机时的意图卡长轮询用（intent-routes.ts）：main.ts 收到 SIGTERM 才会 abort，读不是装配的时候。
const shutdownController = new AbortController();
deps.shutdownSignal = shutdownController.signal;
const { cockpit, agent } = buildApps(deps);

let stopping = false;
const isStopping = () => stopping;

/**
 * systemd 传了监听套接字（要 deploy 侧装 fleet-api.socket 单元，见 listen.ts 开头的注释——这个 PR 里还没接，留了
 * 后续单）就用它们；没传就照旧自己 bind（本机开发、测试，或还没装 socket 单元的生产，目前一直是这一支）。地址、
 * fd 对不上号是明确的配置错误，不当成别的故障悄悄兜底，退出让 systemd 按 Restart=always 重试、也让人看得到原因。
 */
async function listen() {
  try {
    return await startListeners([
      {
        name: '驾驶舱接口',
        at: config.cockpitListen,
        fetch: closeConnectionWhenStopping(cockpit.fetch, isStopping),
        keepAliveMs: COCKPIT_KEEP_ALIVE_MS,
      },
      {
        name: 'fleet 命令接口',
        at: config.agentListen,
        fetch: closeConnectionWhenStopping(agent.fetch, isStopping),
      },
    ]);
  } catch (err) {
    if (err instanceof ListenFdError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
const servers = await listen();

log.info('驾驶舱后端已起', {
  env: config.env,
  store: config.databaseUrl === null ? 'memory' : 'postgres',
  cockpit: `${config.cockpitListen.host}:${config.cockpitListen.port}`,
  agent: `${config.agentListen.host}:${config.agentListen.port}`,
  devLogin: config.devLogin ? DEV_USER_ID : false,
  // 往哪个看板推快照（只写对方的域名，不写通行证）
  nodeReport: config.nodeReport ? config.nodeReport.url.origin : false,
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

/** 退出时给在途的普通请求多久做完（做完了幂等回执才记得上，插头重试不会重做）；到点了收掉剩下的（SSE 这类）。 */
const DRAIN_MS = 10_000;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('收到退出信号，停止接新请求', { signal });
  nodeReporter?.stop();
  await gracefulShutdown({
    servers,
    // 意图卡的长轮询（intent-routes.ts）拿这个信号跟请求自己的 signal 合并着等：马上醒，直接回手上已有的
    // 结果，不再查库——库要过一会儿（drainMs 之后）才真的关，这一步早一点发，长轮询就不会撞上正在关的库（#364）。
    notifyLongPollers: () => shutdownController.abort(),
    drainMs: DRAIN_MS,
    close,
    onCloseError: (err) => log.error('退出时关连接出错', { error: String(err) }),
  });
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
