// 公开的健康报告（/healthz 公网打得到，健康页原样显示）不带内部名：src 里每一种对外的失败原因各造一次，
// 拿演示版打包扫描的同一份名单扫（packages/web/src/build/scan.ts 的 BUILTIN_TERMS，别另抄）。
// 名单在别的包里：写成静态 import，tsc 会把 web 的源文件算进 api 这个 composite 项目报错，所以在运行时 import。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, PgListen } from '@fleet-dao/db';
import { FLEET_CHANGES_CHANNEL } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { startPgChangeFeed } from '../src/changes.ts';
import { draftBacklogCheck, notWiredDraftOpener } from '../src/draft-opening.ts';
import { githubAppMissing, githubEventsCheck } from '../src/github.ts';
import { type HealthReport, runHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';
import { probeDb } from '../src/pg-store.ts';
import type { Logger, Store } from '../src/ports.ts';
import { createEnginePollerCheck, createNamespaceCheck, notConnectedTemporal } from '../src/temporal.ts';
import { fakePostgres } from './fake-postgres.ts';

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
  const stuckStore = { countStuckDeliveries: async () => ({ exhausted: 2, stale: 1 }) } as unknown as Store;
  await run('events-stuck', true, githubEventsCheck({ store: stuckStore, now: () => new Date() }));
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
  // 飞书草稿开单：没接上；最早一张待开单等太久
  await run('draft-opener', true, () => notWiredDraftOpener().check());
  const backlogStore = {
    listDraftsToOpen: async () => [{ id: 'd1', confirmedAt: new Date(0).toISOString() }],
  } as unknown as Store;
  await run(
    'draft-backlog',
    true,
    draftBacklogCheck(backlogStore, () => new Date()),
  );
  return { reports, sites };
}

describe('公开的健康报告', () => {
  it('每一种对外的失败原因：照实报红，原因里没有演示版打包扫描名单上的词；内部细节只进日志', async () => {
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

  it('src 里每一处 new PublicHealthError 上面都造过：多一处这条就红，提醒补进来', async () => {
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
  });
});
