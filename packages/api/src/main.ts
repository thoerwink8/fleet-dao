// 进程入口：一个监听——驾驶舱接口（生产上是法国机器的隧道地址，香港经它访问）。
// 地址、端口、密钥都从本机配置（环境变量）读，见 config.ts。
// - 有 DATABASE_URL：真库（Postgres Store + LISTEN fleet_changes）+ 真 Temporal（懒连接，Temporal 没起来时
//   这一步不报错，健康检查会如实报红）。生产必须有。GitHub 事件原文落库；
//   PR、CI 事件经 @fleet-dao/github 写镜像（机器人凭据在 /etc/fleet-dao/github，读不到时如实失败、健康检查报红）。
// - 开发环境没有 DATABASE_URL：内存里的样例数据；飞书登录没配时可以用 POST /auth/dev-login 免登（只许本机回环监听）；
//   发给工作流的信号只记日志，不接 Temporal。
import {
  claimLocalTask,
  createDb,
  type Db,
  feishuPushFacts,
  finishLocalTask,
  renewLocalTask,
} from '@fleet-dao/db';
import {
  createGitHub,
  listInstallationRepositories,
  type ReleaseFactsReader,
  type RepoRef,
  type SelfCheckItem,
} from '@fleet-dao/github';
import { jevConfigLocation } from '@fleet-dao/jev';
import { intakeChatLimitsFrom } from '@fleet-dao/shared';
import {
  createMemoryStore,
  createPgStore,
  DEPLOY_LAG_NOT_HERE,
  DEV_USER_ID,
  deployFacts,
  devFixtures,
  jsonLogger,
  pgAlertWork,
  pgLedger,
  pgLocker,
  readDeployLagInput,
  startDeployLagWatch,
  startReleaseWaitWatch,
  withStatementTimeout,
} from '@fleet-dao/store';
import { buildApps } from './app.ts';
import { pgCarpoolReconcile } from './carpool-reconcile-view.ts';
import { createChangeHub, startPgChangeFeed } from './changes.ts';
import { pgCliTools } from './cli-versions.ts';
import { ConfigError, engineEnabled, loadConfig } from './config.ts';
import { probeDb } from './db-probe.ts';
import { pgDatabaseSizes } from './db-sizes.ts';
import { runFeishuPushRecheck, runGitHubAppRecheck } from './decision-actions.ts';
import type { DecisionCommenter } from './decision-handoff.ts';
import { deployLagCheck } from './deploy-lag-check.ts';
import type { Deps } from './deps.ts';
import {
  createFootprintMeter,
  type DatabaseSizes,
  measureFootprint,
  realFootprintFs,
} from './disk-footprint.ts';
import { createFeishuAuth } from './feishu.ts';
import { memoryCockpitAlerts, pgCockpitAlerts } from './feishu-alerts.ts';
import { feishuBotFromConfig, startFeishuPush } from './feishu-push.ts';
import { productionPreflightReaders } from './france-preflight.ts';
import { liveFranceReleasePort } from './france-release.ts';
import { githubAppMissing, githubEventsCheck } from './github.ts';
import { githubAppHealthCheck } from './github-app-health.ts';
import { serviceHealthChecks } from './health.ts';
import { engineHealthProbe } from './home-engine.ts';
import { createHostResourceSampler, realHostReader } from './host-resources.ts';
import { judgeHealthCheck } from './judge-health.ts';
import { COCKPIT_KEEP_ALIVE_MS } from './keep-alive.ts';
import { ListenFdError, startListeners } from './listen.ts';
import { pgLocalClaims } from './local-claims.ts';
import { pgManualTracks } from './manual-tracks.ts';
import { pgModelRoster } from './model-roster.ts';
import { nodeReporterFor, nodeReportPart } from './node-reporter.ts';
import { pgOrgSwitch } from './org-switch-view.ts';
import type { GitHubEventSink } from './ports.ts';
import { pgProbeHistory } from './probe-history.ts';
import { liveReleaseCardPort } from './release-card.ts';
import { liveReleaseRequestPort } from './release-request.ts';
import { pgRequestChat } from './request-chat-pg.ts';
import { currentMilestoneOf, type RequestIssuePort } from './request-issue.ts';
import { startRequestProgressWatch } from './request-progress.ts';
import { pgRequests } from './request-store-pg.ts';
import { pgRoutingEfforts } from './routing-efforts.ts';
import { pgRoutingLayers } from './routing-layers.ts';
import { pgRoutingOrder } from './routing-order.ts';
import { pgRunTranscript } from './run-transcript.ts';
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
/** 机器人凭据没读到：发版卡读 GitHub 的每一样都如实抛这个原因（卡上各行写没查成 + 原因）。 */ function credentialsMissingFacts(
  why: string,
): ReleaseFactsReader {
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
  /** 「要你拍」拍完往进度单、任务单留言（#1915）；凭据没读到就没有，答案照存、回包写没接上。 */
  decisionCommenter?: DecisionCommenter;
  /** 重查 GitHub App。凭据没读到就没有，重查报「凭据没读到」。 */
  selfCheck?: (repos: RepoRef[]) => Promise<SelfCheckItem[]>;
  /** 提需求（#2060）开单、写回评论、读单子状态，都用「引擎」机器人；凭据没读到就没有，开单回 503，不假装开了。 */
  requestIssues?: RequestIssuePort;
  /** 导入列表：两个机器人的安装令牌。凭据没读到就没有，列表回「没接上」。 */
  installationRepos?: Deps['installationRepos'];
} {
  try {
    const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db, { log }), log });
    // 引擎等 CI 靠活动自己轮询（waitCi），不收按事件叫醒的信号：PR、CI 事件只写镜像
    return {
      sink: gh.eventSink({ async wake() {} }),
      releaseFacts: gh.releaseFacts,
      decisionCommenter: {
        async comment(input) {
          const got = await gh.commentIssue(input);
          return { url: got.url };
        },
      },
      selfCheck: (repos) => gh.selfCheck(repos),
      installationRepos: {
        list: (role) => listInstallationRepositories(gh.client, role),
      },
      requestIssues: {
        // 不走发件箱，同步调（母单 #2047 方案第六节）；正文过卫生检查、幂等都在 @fleet-dao/github 的 openIssue / commentIssue 里
        async openIssue(input) {
          // 挂当前版本（#2683）：创始人开的进当前版本，不落未排期
          const milestone = await currentMilestoneOf(() => gh.readOpenMilestones({ repo: input.repo }));
          return gh.openIssue({ ...input, milestone });
        },
        async commentIssue(input) {
          return gh.commentIssue(input);
        },
        async readIssueState(input) {
          return gh.readIssueState(input);
        },
      },
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

async function assemble(): Promise<{
  deps: Deps;
  close: () => Promise<void>;
  databaseSizes?: DatabaseSizes;
}> {
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
      alerts: memoryCockpitAlerts(store.data.notifications),
      health: nodeReporter ? [nodeReporter.healthCheck] : [],
      workflows: {
        async signal(workflowId, signal) {
          log.info('（开发）发给工作流的信号', { workflowId, signal: signal.name });
        },
      },
      // 不装 taskRedo：开发环境没有 Temporal，重做回 503，不把信号记一笔当成已经另起。
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
  // 合并后等发版那一段（step_timings 的 wait 行）：工作流合并完就收场，这一段由这边看发布历史补记，指挥官复验「合并到上线」用它
  const stopReleaseWaitWatch = production ? startReleaseWaitWatch({ db, now, log }) : () => {};
  // 看门狗（#203）自己停了它自己报不了：后端每 5 分钟按登记表上它那一行看一次，停了推一条「看门狗停了」，好了自己撤
  const stopWatchdogWatch = production ? startWatchdogWatch({ db, now, log }) : () => {};
  // 提醒推飞书（决定 0090）：每 30 秒把该推的发进团队群，结局记进送达记录；没配记「没配」，看门狗报。只在正式环境推
  const pushBot = feishuBotFromConfig(config);
  const stopFeishuPush = production
    ? startFeishuPush({
        db,
        bot: pushBot.bot,
        notConfiguredWhy: pushBot.why,
        publicUrl: config.publicUrl,
        now,
        log,
      })
    : () => {};
  // 提需求开出的单子的进度（#2060）：每分钟从 GitHub 和引擎任务表读，写进需求、对话里追加进度卡，引擎的提问发到单上。
  // 凭据没读到就不起（那时开单也是 503）；「已上线」要读发布目录，只在正式环境有。
  const stopRequestProgressWatch = github.requestIssues
    ? startRequestProgressWatch({
        db,
        issues: github.requestIssues,
        deployedAt: production ? () => readDeployLagInput().deployedAt ?? null : undefined,
        now,
        log,
      })
    : () => {};
  const deps: Deps = {
    config,
    store,
    changes: feed,
    log,
    now,
    feishu,
    workflows: temporal.control,
    taskRedo: temporal.taskRedo,
    github: github.sink,
    ...(github.installationRepos ? { installationRepos: github.installationRepos } : {}),
    ...(github.decisionCommenter ? { decisionCommenter: github.decisionCommenter } : {}),
    decisionCapabilities: {
      recheckGitHubApp: (repo) => runGitHubAppRecheck(github.selfCheck, repo),
      recheckFeishuPush: async () => {
        const at = now();
        await runFeishuPushRecheck(await feishuPushFacts(db, at), at);
      },
    },
    alerts: pgCockpitAlerts(db),
    // 提醒谁在处理（design 15.3）：认领、PR 镜像、静默都在同一个库；发布记录只在正式环境有
    alertWork: pgAlertWork(db, production ? () => deployFacts(readDeployLagInput()) : () => null),
    // 路由两层每一层现在活着吗（#574）：和引擎选路读同一份（路由两层那两张表 + 探针、额度、禁令现算）
    routingLayers: pgRoutingLayers(db),
    // 动手战绩：和选路读的 modelTierTracks 同一份，路由页按模型和档画出来
    manualTracks: pgManualTracks(db),
    // 探针真历史（#1139）：渠道状态页的近 60 次格子。读库，不看引擎开没开
    probeHistory: pgProbeHistory(db),
    // 命令行工具版本（#1969）：读引擎写下的读数。引擎没跑过时各行写「还没读过」，不拿最新顶。
    cliTools: pgCliTools(db),
    // 渠道模型名册和目录的差（#1302）：读库里额度任务记下的名册，请求里不现连渠道
    modelRoster: pgModelRoster(db),
    // 会话用户切号的现状（#194）：引擎落库的切号账本，额度页顶上一行
    orgSwitch: pgOrgSwitch(db),
    // 拼车额度对账（#194 方案 4.7）：接口说的已用美元 vs 本机会话记到的花费
    carpoolReconcile: pgCarpoolReconcile(db),
    // 每条路由的思考档位（#470）：引擎起会话时现读的就是这一列，改了下一个会话照新的
    routingEfforts: pgRoutingEfforts(db, now),
    // 路由两层的先后和开关（母单 #1089）：驾驶舱「路由」页改的就是选路读的那两张表的 position、enabled
    routingOrder: pgRoutingOrder(db, now),
    // 按单指定模型：引擎给这张单的一段选路时现读的就是这张表，改了下一次选路照新的
    taskRoutePins: pgTaskRoutePins(db, now),
    // 本机领单（决定 0096）：本机会话经通行证写 tasks 那一行（executor = local、带租约），法国拉单按它不接、到期收回
    localClaims: pgLocalClaims({
      claim: (i) => claimLocalTask(db, i),
      renew: (i) => renewLocalTask(db, i),
      finish: (i) => finishLocalTask(db, i),
      workflows: temporal.control,
    }),
    // 任务详情每段的会话内容（#1640）：读引擎按条记下的 run_transcript
    runTranscript: pgRunTranscript(db),
    // 提需求（#2049）：需求、消息、每人的置顶和读到哪；删了满 30 天的由引擎的 request-sweep 硬删
    // 开单、写回评论用「引擎」机器人（github.requestIssues）；单子正文里的链接用 FLEET_PUBLIC_URL（config.publicUrl，缺了启动就拒）
    requests: pgRequests(db, now, {
      issues: github.requestIssues,
      cockpitUrl: config.publicUrl.origin,
      limits: intakeChatLimitsFrom(process.env),
    }),
    // 提需求的指挥官会话（#2061）：排一轮进 request_chats，法国引擎每两秒接手；限额（每人 3 条、每条 40 轮）可用环境变量调
    requestChat: pgRequestChat(db, now, { limits: intakeChatLimitsFrom(process.env) }),
    // 环境页（#820 片 1）的版本那一项：正式环境读发布目录现算；别处不给，页面写「没查成」
    ...(production ? { deployLag: () => readDeployLagInput() } : {}),
    // /france 页发版一键（#618）：读 release-train 进度。只在正式环境装。
    // 开发、内存版不装，接口回「没接上」，免得本机的数被看成法国的。
    ...(production ? { franceRelease: liveFranceReleasePort() } : {}),
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
      // 引擎切号（#157）写的提醒：只有这台库上跑着的引擎会写，没开引擎的环境一直是好的
      sessionOrg: sessionOrgHealthCheck(db),
      // 引擎每小时对账自检两个机器人的权限、缺了写的提醒：同样只有这台库上跑着的引擎会写
      githubApp: githubAppHealthCheck(db),
      // 看门狗（#203）：引擎每 5 分钟跑一轮、记在登记表上；只在正式环境接
      watchdog: production
        ? { check: watchdogHealthCheck(db, now) }
        : { check: async () => {}, notWired: WATCHDOG_NOT_HERE },
      // 往正式环境的看板推快照：没配推送地址报「未接」
      nodeReport: nodeReportPart(nodeReporter),
    }),
  };
  // 发版预检：进程内读七项事实。发版卡或发布请求没装上时这里给出的函数回 undefined，接口写没接上。
  if (production) deps.francePreflight = () => productionPreflightReaders(deps);
  return {
    deps,
    // 库的大小（#1985）：资源页按目录的磁盘占用那一回里查，10 分钟一次
    databaseSizes: pgDatabaseSizes((text) => client.unsafe(text)),
    close: async () => {
      stopDeployLagWatch();
      stopReleaseWaitWatch();
      stopWatchdogWatch();
      stopFeishuPush();
      stopRequestProgressWatch();
      await feed.stop();
      await temporal.close();
      await closeDb();
    },
  };
}

const { deps, close, databaseSizes } = await assemble();
// 这台机器此刻的内存、CPU（#1973）：两种装配都读本机 /proc 和 cgroup；不是 Linux、没有会话资源池的照实写没读到。
// 整机磁盘、每个上线项目的 CPU 内存随这一回读（#1985）；按目录的磁盘占用由测量器 10 分钟最多测一回、在后台测，这一回只带结果
const hostReader = realHostReader();
const footprint = createFootprintMeter({
  measure: () =>
    measureFootprint({ apps: hostReader.apps ?? [], fs: realFootprintFs(), databases: databaseSizes, now }),
  now,
  log,
});
const hostResources = createHostResourceSampler({ read: hostReader, now, log, footprint });
deps.hostResources = hostResources;
snapshotDeps = deps;
nodeReporter?.start();
const { cockpit, relay } = buildApps(deps);
// 有页面开着（SSE 连着）才按间隔读、推；没人看时主页接口来要再现读
const stopHostResources = hostResources.start(() => relay.connections() > 0);

let stopping = false;
const isStopping = () => stopping;

/**
 * systemd 传了监听套接字（生产装的 fleet-api.socket 单元，见 listen.ts 开头的注释）就用它；没传就照旧自己 bind（本机开发、
 * 测试）。地址、fd 对不上号是明确的配置错误，不当成别的故障悄悄兜底，退出让 systemd 按 Restart=always 重试、也让人看得到原因。
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
  devLogin: config.devLogin ? DEV_USER_ID : false,
  // 往哪个看板推快照（只写对方的域名，不写通行证）
  nodeReport: config.nodeReport ? config.nodeReport.url.origin : false,
});

/** 退出时给在途的普通请求多久做完（做完了幂等回执才记得上，插头重试不会重做）；到点了收掉剩下的。SSE 一开始就收，不等它。 */
const DRAIN_MS = 10_000;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('收到退出信号，停止接新请求', { signal });
  nodeReporter?.stop();
  stopHostResources();
  await gracefulShutdown({
    servers,
    drainMs: DRAIN_MS,
    endStreams: () => relay.endAll(),
    close,
    onCloseError: (err) => log.error('退出时关连接出错', { error: String(err) }),
  });
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
