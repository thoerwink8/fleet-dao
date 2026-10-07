// 公开的健康报告（/healthz 公网打得到，健康页原样显示）不带内部名：src 里每一种对外的失败原因各造一次，
// 拿演示版打包扫描的同一份名单扫（packages/web/src/build/scan.ts 的 BUILTIN_TERMS，别另抄）。
// 名单在别的包里：写成静态 import，tsc 会把 web 的源文件算进 api 这个 composite 项目报错，所以在运行时 import。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Db,
  GITHUB_APP_ALERT_PREFIX,
  type PgListen,
  SESSION_ORG_ALERT_PREFIX,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS } from '@fleet-dao/db/testing';
import { FLEET_CHANGES_CHANNEL, IntentRoutes } from '@fleet-dao/shared';
import { DEPLOY_LAG_NOT_HERE, silentLogger } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { CANARY_NOT_HERE, canaryHealthCheck } from '../src/canary-health.ts';
import { startPgChangeFeed } from '../src/changes.ts';
import { probeDb } from '../src/db-probe.ts';
import { deployLagCheck } from '../src/deploy-lag-check.ts';
import { createGatewaySeen, GATEWAY_NO_PASS } from '../src/gateway-seen.ts';
import { githubAppMissing, githubEventsCheck } from '../src/github.ts';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { type HealthReport, runHealthChecks, serviceHealthChecks } from '../src/health.ts';
import { judgeHealthCheck } from '../src/judge-health.ts';
import { createNodeReporter, NODE_REPORT_NOT_WIRED, nodeReportPart } from '../src/node-reporter.ts';
import type { Logger, Store } from '../src/ports.ts';
import { sessionOrgHealthCheck } from '../src/session-org-health.ts';
import {
  createEnginePollerCheck,
  createNamespaceCheck,
  ENGINE_OFF,
  notConnectedTemporal,
} from '../src/temporal.ts';
import { WATCHDOG_NOT_HERE, watchdogHealthCheck } from '../src/watchdog-health.ts';
import { fakePostgres } from './fake-postgres.ts';
import { judgeCatalog, judgeMachine, makeFakeBackend, recordJudgeCall } from './judge-fixture.ts';
import { sampleSnapshot } from './node-snapshot-fixture.ts';

/** 默认位置上没有的判断题配置（「未接」）。 */
const NO_JUDGE = { path: join(tmpdir(), 'fleet-public-text-nowhere', 'jev.json'), explicit: false };

interface Hit {
  file: string;
  term: string;
  context: string;
}
interface Scan {
  BUILTIN_TERMS: readonly string[];
  scanText(file: string, text: string, terms: readonly string[]): Hit[];
  formatHits(hits: readonly Hit[]): string;
}
const SCAN = '../../web/src/build/scan.ts';
const loadScan = async () => (await import(/* @vite-ignore */ SCAN)) as Scan;

/** 名单里公开页本来就要写的两个词：Temporal 是 P0 验收要看的一项；「驾驶舱」是正式版、演示版都用的中性叫法（#54 第 4 条）。 */
const PUBLIC_OK = ['temporal', '驾驶舱'];

/** 和演示版产物同一套比法（不分大小写，短名按整词）扫每一份报告的 JSON 原文：/healthz 回的就是它。 */
function scanReports(scan: Scan, reports: Record<string, HealthReport>): Hit[] {
  const terms = scan.BUILTIN_TERMS.filter((t) => !PUBLIC_OK.includes(t));
  return Object.entries(reports).flatMap(([name, report]) =>
    scan.scanText(name, JSON.stringify(report), terms),
  );
}

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** 不让定时探活插进来：只在这里手动 probe。 */
const manual = { probeEveryMs: 60 * 60_000, resyncSettleMs: 10 };
/** 查库超时（语句超时 57014）。 */
const lockedDb = {
  async transaction() {
    throw new Error('Failed query', {
      cause: Object.assign(new Error('canceling statement'), { code: '57014' }),
    });
  },
} as unknown as Db;

/**
 * 每一种对外的失败原因各造一次，一种一份报告。sites：其中出自 src 里某一处 new PublicHealthError 的有几种
 * （「连不上」是兜底，不算）。
 */
async function publicFailures(log: Logger) {
  const reports: Record<string, HealthReport> = {};
  let sites = 0;
  const run = async (name: string, site: boolean, check: () => Promise<void>, timeoutMs?: number) => {
    reports[name] = await runHealthChecks([{ name: 'item', check }], log, timeoutMs);
    if (site) sites++;
  };
  await run('db-timeout', true, () => probeDb(lockedDb, 2_000));
  await run('stuck', true, () => new Promise(() => {}), 20);
  await run('unreachable', false, async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
  });

  // 实时推送：库连不上；LISTEN 那条连接悄悄断了；探活频道接上了、fleet_changes 那条还没接上；已经停了
  const down = fakePostgres();
  down.stopDb();
  const noDb = startPgChangeFeed(down, log, manual);
  await settle();
  await run('feed-no-db', true, () => noDb.probe(30));
  await noDb.stop();

  const quiet = fakePostgres();
  const noPing = startPgChangeFeed(quiet, log, manual);
  await settle();
  quiet.dropListenConnection();
  await run('feed-no-ping', true, () => noPing.probe(30));
  await noPing.stop();

  const half = fakePostgres();
  const listen: PgListen = (channel, onNotify, onListen) =>
    channel === FLEET_CHANGES_CHANNEL
      ? new Promise<never>(() => {})
      : half.listen(channel, onNotify, onListen);
  const notYet = startPgChangeFeed({ listen, notify: half.notify }, log, manual);
  await settle();
  await run('feed-not-yet', true, () => notYet.probe(50));
  await notYet.stop();

  const stopped = startPgChangeFeed(fakePostgres(), log, manual);
  await settle();
  await stopped.stop();
  await run('feed-stopped', true, () => stopped.probe(30));

  await run('workflow-client', true, () => notConnectedTemporal().check());
  // GitHub 事件：机器人凭据没读到；有投递重放到顶还出错、处理中卡住
  await run('events-no-credentials', true, githubAppMissing('ENOENT /etc/fleet-dao/github/app.json').check);
  const intake = {
    listRepos: async () => [{ id: 'r1', owner: 'o', name: 'n', defaultBranch: 'main' }],
    listUsers: async () => [{ id: 'u1', displayName: '甲', role: 'founder', active: true, githubId: 1 }],
  };
  const stuckStore = {
    ...intake,
    countStuckDeliveries: async () => ({ exhausted: 2, stale: 1 }),
  } as unknown as Store;
  await run('events-stuck', true, githubEventsCheck({ store: stuckStore, now: () => new Date() }));
  // GitHub 事件：一个受管的仓都没有；白名单里没有带 GitHub 账号的人
  const noRepos = { ...stuckStore, listRepos: async () => [] } as unknown as Store;
  await run('events-no-repos', true, githubEventsCheck({ store: noRepos, now: () => new Date() }));
  const noMembers = { ...stuckStore, listUsers: async () => [] } as unknown as Store;
  await run('events-no-members', true, githubEventsCheck({ store: noMembers, now: () => new Date() }));
  // 引擎工人不在、命名空间查不到：队列名、命名空间名只进日志
  await run(
    'engine-offline',
    true,
    createEnginePollerCheck({ listPollers: async () => [] }, () => new Date()),
  );
  await run(
    'namespace',
    true,
    createNamespaceCheck(
      {
        describeNamespace: async () => {
          throw Object.assign(new Error('not found'), { code: 5 });
        },
      },
      'fleet-dao',
    ),
  );
  // 判断题：配置起不来（FLEET_JEV_CONFIG 明写的文件不在）；最近一次真调用没成（上游回的原文带着钥匙不对这类话，只进日志）
  await run(
    'judge-config',
    true,
    judgeHealthCheck({ db: {} as Db, location: { ...NO_JUDGE, explicit: true } }).check,
  );
  const judgeDb = await createTestDb();
  const judged = judgeMachine();
  try {
    await judgeCatalog(judgeDb.db);
    await recordJudgeCall(judgeDb.db, {
      ok: false,
      reason: 'auth',
      detail: 'HTTP 401 TypeSafe key rejected for fleet-dao',
      latencyMs: 4,
    });
    await run(
      'judge-failing',
      true,
      judgeHealthCheck({ db: judgeDb.db, location: judged.location, makeBackend: makeFakeBackend }).check,
    );
    // 切号的提醒开着：标题（带拼车、独享、会话用户名）只进日志
    await upsertAlert(judgeDb.db, {
      dedupeKey: `${SESSION_ORG_ALERT_PREFIX}switch`,
      level: 'alert',
      taskId: null,
      title: '会话用户切号没成：拼车 → 独享',
      body: 'fleet-agent-carpool 以会话用户跑 reclaude org list 没跑成',
    });
    await run('session-org', true, sessionOrgHealthCheck(judgeDb.db));
    // 机器人权限的提醒开着：标题（带仓名、缺哪样权限）只进日志
    await upsertAlert(judgeDb.db, {
      dedupeKey: `${GITHUB_APP_ALERT_PREFIX}engine:acme/fleet-dao`,
      level: 'alert',
      taskId: null,
      title: '「引擎」机器人在 acme/fleet-dao 上的权限不对：缺 statuses:write',
      body: '去 GitHub 的 App 设置里改，再到装它的地方点接受新权限',
    });
    await run('github-app', true, githubAppHealthCheck(judgeDb.db));
    // 全流程巡检：只有一处 new PublicHealthError（说法有几种），这里造一种；每一种说法都在 canary-health.test.ts 用同一份名单扫
    await run('canary', true, async () => {
      await canaryHealthCheck(judgeDb.db, async () => ({ on: true }))();
    });
    // 看门狗：只有一处 new PublicHealthError（说法有几种），这里造一种（还没登记）；每一种说法都在 watchdog-health.test.ts 用同一份名单扫
    await run('watchdog', true, async () => {
      await watchdogHealthCheck(judgeDb.db)();
    });
  } finally {
    judged.cleanup();
    await judgeDb.close();
  }
  // 线上版本跟不上主线：只有一处 new PublicHealthError，这里造一种；每一种对外的说法都在 deploy-lag.test.ts 用同一份名单扫
  await run(
    'deploy-lag',
    true,
    deployLagCheck(
      () => ({
        current: { sha: null },
        state: { error: '/srv/fleet-dao-releases/.auto 读不到' },
      }),
      () => new Date(),
    ),
  );
  // 飞书网关：意图卡轮询太久没来。只有一处 new PublicHealthError，这里造一种；每一种说法都在 gateway-seen.test.ts 用同一份名单扫
  let clock = Date.now();
  const seen = createGatewaySeen(() => new Date(clock));
  seen.saw(IntentRoutes.cards);
  clock += 10 * 60_000;
  await run('feishu-gateway', true, async () => {
    await seen.check();
  });
  // 推快照（node-reporter.ts 三处）：第一轮还没推完、连着没推成、循环卡住了。对方地址、回体只进日志
  let nodeClock = Date.now();
  const nodeReporter = (fetchImpl: typeof fetch) =>
    createNodeReporter({
      target: { url: new URL('https://fleet-dao.internal.example/api/nodes/report'), token: 'x'.repeat(40) },
      snapshot: async () => sampleSnapshot(),
      codeSha: () => undefined,
      log,
      now: () => new Date(nodeClock),
      fetch: fetchImpl,
    });
  const fresh = nodeReporter(async () => new Response(null, { status: 204 }));
  await run('node-report-not-yet', true, async () => {
    await fresh.healthCheck.check();
  });
  const refused = nodeReporter(async () => new Response('fleet-dao node key rejected', { status: 401 }));
  await refused.pushOnce();
  await run('node-report-failing', true, async () => {
    await refused.healthCheck.check();
  });
  await fresh.pushOnce();
  nodeClock += 60 * 60_000;
  await run('node-report-stalled', true, async () => {
    await fresh.healthCheck.check();
  });
  return { reports, sites };
}

describe('公开的健康报告', () => {
  it(
    '每一种对外的失败原因：照实报红，原因里没有演示版打包扫描名单上的词；内部细节只进日志',
    async () => {
      const scan = await loadScan();
      // 名单读到了：空名单什么都扫不出来，不能当成干净
      expect(scan.BUILTIN_TERMS.length).toBeGreaterThan(0);
      const logs: string[] = [];
      const keep = (message: string, fields?: Record<string, unknown>) => {
        logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
      };
      const { reports, sites } = await publicFailures({ info: keep, warn: keep, error: keep });
      // 每一种都真造出来了（外加兜底的「连不上」）：一份都没有，下面就什么都扫不出来
      expect(Object.keys(reports)).toHaveLength(sites + 1);
      for (const [name, report] of Object.entries(reports)) {
        expect(report.ok, name).toBe(false);
        expect(report.checks.item, name).toMatchObject({
          ok: false,
          code: expect.stringMatching(/\S/),
          message: expect.stringMatching(/\S/),
        });
      }
      const hits = scanReports(scan, reports);
      expect(hits, scan.formatHits(hits)).toEqual([]);
      // 频道名、原始错误（带地址）没丢：只进了日志，报告里没有
      expect(logs.some((l) => l.includes('LISTEN fleet_changes'))).toBe(true);
      expect(logs.some((l) => l.includes('10.0.0.9:5432'))).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('10.0.0.9');
      // 判断题上游的原文（带上游和仓的名字）只进日志
      expect(logs.some((l) => l.includes('TypeSafe key rejected'))).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('key rejected');
      // 切号提醒的标题只进日志
      expect(logs.some((l) => l.includes('会话用户切号没成'))).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('切号没成');
      // 推快照对方的地址、回体只进日志
      expect(logs.some((l) => l.includes('node key rejected'))).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('internal.example');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('「未接」的话、好的时候带的说明也公网看得到：同一份名单扫，带单号可以', async () => {
    const scan = await loadScan();
    const services = (feishuGateway: Parameters<typeof serviceHealthChecks>[0]['feishuGateway']) =>
      runHealthChecks(
        serviceHealthChecks({
          probeDb: async () => {},
          feed: { probe: async () => {} },
          temporal: { check: async () => {}, checkEngine: async () => {} },
          engineNotWired: ENGINE_OFF,
          githubEvents: async () => {},
          judge: judgeHealthCheck({ db: {} as Db, location: NO_JUDGE }),
          deployLag: { check: async () => {}, notWired: DEPLOY_LAG_NOT_HERE },
          feishuGateway,
          sessionOrg: async () => {},
          githubApp: async () => {},
          canary: { check: async () => {}, notWired: CANARY_NOT_HERE },
          watchdog: { check: async () => {}, notWired: WATCHDOG_NOT_HERE },
          nodeReport: nodeReportPart(null),
        }),
        silentLogger,
      );
    const at = new Date();
    const seen = createGatewaySeen(() => at);
    seen.saw(IntentRoutes.cards);
    const pending = {
      services: await services({ check: async () => {}, notWired: GATEWAY_NO_PASS }),
      noted: await services(seen),
    };
    expect(pending.services.checks.engine).toEqual({ ok: true, status: 'not_wired', message: ENGINE_OFF });
    expect(pending.services.checks.node_report).toEqual({
      ok: true,
      status: 'not_wired',
      message: NODE_REPORT_NOT_WIRED,
    });
    // 项名叫 judge 不叫 jev：jev 在公开页的禁用词名单上
    expect(pending.services.checks.judge).toMatchObject({ ok: true, status: 'not_wired' });
    expect(pending.services.checks.feishu_gateway).toEqual({
      ok: true,
      status: 'not_wired',
      message: GATEWAY_NO_PASS,
    });
    expect(pending.noted.checks.feishu_gateway).toEqual({
      ok: true,
      message: '意图卡轮询 0 秒前来过',
    });
    const hits = scanReports(scan, pending);
    expect(hits, scan.formatHits(hits)).toEqual([]);
  });

  it('这道查法查得出：改之前的原因（带 LISTEN fleet_changes）会红', async () => {
    const scan = await loadScan();
    const old: HealthReport = {
      ok: false,
      checks: {
        realtime: {
          ok: false,
          code: 'not_listening',
          message: '实时推送还没接上数据库（LISTEN fleet_changes）',
        },
      },
    };
    expect(scanReports(scan, { old }).map((h) => h.term)).toContain('fleet');
  });

  it(
    'src 里每一处 new PublicHealthError 上面都造过：多一处这条就红，提醒补进来',
    async () => {
      const packages = fileURLToPath(new URL('../../', import.meta.url));
      let files = 0;
      let found = 0;
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.tsx?$/.test(name)) {
            files++;
            found += readFileSync(p, 'utf8').match(/new PublicHealthError\(/g)?.length ?? 0;
          }
        }
      };
      for (const pkg of readdirSync(packages)) {
        const src = join(packages, pkg, 'src');
        if (existsSync(src)) walk(src);
      }
      // 读不到源文件不能当成「一处都没有」
      expect(files).toBeGreaterThan(0);
      const { sites } = await publicFailures(silentLogger);
      expect(found, `src 里有 ${found} 处 new PublicHealthError，上面只造了 ${sites} 种`).toBe(sites);
    },
    TEST_DB_TIMEOUT_MS,
  );
});
