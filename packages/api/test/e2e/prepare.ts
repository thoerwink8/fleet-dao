// 驾驶舱用户视角 e2e 的「备库」一步（母单 #902）：在一台真 Postgres 上新建一个 fleet_e2e* 库、跑真迁移、灌一份像样的数据、
// 给创始人甲设好账密，把要用的编号以一行 JSON 打到标准输出（最后一行）。起后端和前端、开浏览器是 packages/web/e2e 的事。
//
//   E2E_PG_ADMIN_URL=postgres://postgres:<密码>@127.0.0.1:55432/postgres  node packages/api/test/e2e/prepare.ts
//   环境变量 E2E_DB_NAME 改库名（必须 fleet_e2e 开头：这一步会先删同名的库再建，不许碰别的库）。
//   加 --refresh-ledger：只把切号账本的读数时刻重写成「相对现在」，不动别的。
//
// 改这里之前必须知道：
// - 目录（族、渠道、账号池、模型、路由）、路由两层骨架、额度留量线都走发布时同一条装载链（目录配置样例
//   deploy/catalog.json → routing.default.json → quota-reserve.default.json），页面上看到的池和路由
//   就是线上那一套名字；任务、会话、提醒这些「业务数据」用 store 的 devFixtures 打底，编号对到目录里的真名字上，再补 e2e 要看的几样：
//   各池的额度读数、切号账本（要有几次接口读数，额度页才算得出「约 N 分钟后用满」）、几张不同状态的单、几条不同级别的提醒。
// - 数据全部假的（名字、编号、额度都不对应真实账号）。
// - 连不上、库名不合规、迁移或灌数据失败，一律让进程带非零退出码退出，不静默退回别的库。
import { readFileSync } from 'node:fs';
import {
  applyQuotaReserveSeed,
  createDb,
  type Db,
  finishRun,
  loadCatalog,
  loadQuotaReserveSeed,
  parseCatalog,
  pools,
  QUOTA_RESERVE_DEFAULT_PATH,
  routes,
  runMigrations,
  runRoutingApply,
  saveOrgState,
  startRun,
} from '@fleet-dao/db';
import { createPgStore, DEV_USER_ID, devFixtures, IDS } from '@fleet-dao/store';
import { seedPg } from '@fleet-dao/store/testing';
import { eq, inArray } from 'drizzle-orm';
import { hashPassword } from '../../src/password.ts';

export const E2E_USERNAME = 'founder.a';
export const E2E_PASSWORD = 'e2e-correct-horse-battery';

const CATALOG_EXAMPLE = new URL('../../../../deploy/catalog.json', import.meta.url);

/** 备库产出的编号：web 的 e2e 照它找页面、核对数据。 */
export interface E2eFacts {
  dbUrl: string;
  userId: string;
  username: string;
  password: string;
  tasks: { running: string; done: string; stalled: string; queued: string; failed: string; asking: string };
  issues: { running: number; done: number; stalled: number; queued: number; failed: number; asking: number };
  approvalNotificationId: string;
  alertNotificationId: string;
  pools: { carpool: string; solo: string };
}

const taskIds = {
  asking: 'b0000000-0000-4000-8000-000000000017',
  stalled: 'b0000000-0000-4000-8000-000000000014',
  queued: 'b0000000-0000-4000-8000-000000000015',
  failed: 'b0000000-0000-4000-8000-000000000016',
} as const;

function dbNameOf(env: Record<string, string | undefined>): string {
  const name = env.E2E_DB_NAME?.trim() || 'fleet_e2e';
  if (!/^fleet_e2e[a-z0-9_]*$/.test(name)) {
    throw new Error(
      `E2E_DB_NAME 必须是 fleet_e2e 开头的小写字母数字下划线，现在是「${name}」：这一步会删同名库，不许碰别的库`,
    );
  }
  return name;
}

function adminUrlOf(env: Record<string, string | undefined>): string {
  const adminUrl = env.E2E_PG_ADMIN_URL?.trim();
  if (!adminUrl) {
    throw new Error(
      'E2E_PG_ADMIN_URL 没设：要一台真 Postgres 的管理连接串（例如 postgres://postgres:<密码>@127.0.0.1:55432/postgres）。不退回内存库冒充真库',
    );
  }
  return adminUrl;
}

function e2eDbUrl(env: Record<string, string | undefined>): string {
  // 只重写账本这种后续步骤直接给库的连接串（E2E_DB_URL，备库产出的 dbUrl），不用再带管理连接串
  const direct = env.E2E_DB_URL?.trim();
  if (direct) return direct;
  const url = new URL(adminUrlOf(env));
  url.pathname = `/${dbNameOf(env)}`;
  return url.toString();
}

/**
 * 切号账本：拼车在用，最近几次接口读数的已用美元一路往上涨，额度页据此估「约 N 分钟后用满」。
 * 烧速只认离现在 15 分钟内的读数、最新一条不能超过 10 分钟前（shared 的 carpool-burn.ts），所以这份账本是「相对此刻」写的，
 * 跑得久了会变陈旧：额度页的用例开跑前先调 refreshLedger 重写一遍。
 */
async function writeLedger(db: Db, now: Date): Promise<void> {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const read = (minutesAgo: number, usedUsd: number) => ({
    ok: true as const,
    requestedAt: ago(minutesAgo),
    serverDate: ago(minutesAgo),
    ageSeconds: 5,
    quota: { usedUsd, limitUsd: 100 },
  });
  await saveOrgState(
    db,
    'fleet-agent-carpool',
    {
      live: 'carpool',
      liveAt: ago(600),
      onSoloSince: null,
      outage: null,
      channel: { state: 'ok', since: ago(600), why: '拼车通道正常' },
      backPending: null,
      whites: { count: 2 },
      reads: [read(40, 12), read(13, 22), read(8, 28), read(4, 32), read(1.5, 35)],
    },
    now,
  );
}

/** 只重写切号账本里的读数时刻（相对现在），其余数据不动。 */
export async function refreshLedger(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { db, close } = createDb({ url: e2eDbUrl(env), max: 1 });
  try {
    await writeLedger(db, new Date());
  } finally {
    await close();
  }
}

/** 样例数据里的老名字 → 目录样例里的真名字（渠道、池、路由、模型的编号）。 */
function mapCatalogNames<T>(data: T): T {
  const text = JSON.stringify(data)
    .replaceAll('"ch-claude"', '"claude-sub"')
    .replaceAll('"ch-mirasim"', '"mirasim"')
    .replaceAll('"ch-cursor"', '"cursor"')
    .replaceAll('"pool-claude-a"', '"claude-carpool"')
    .replaceAll('"pool-mirasim"', '"mirasim-relay"')
    .replaceAll('"pool-cursor"', '"cursor"')
    .replaceAll('"rt-claude-opus"', '"claude-carpool:opus-5.5:claude-code"')
    .replaceAll('"rt-mirasim-fable"', '"mirasim-relay:opus-5.5:mirasim"')
    .replaceAll('"rt-mirasim-gpt"', '"mirasim-relay:gpt-5.6-luna:mirasim"')
    .replaceAll('"rt-mirasim-kimi"', '"mirasim-relay:kimi-k3:mirasim"')
    .replaceAll('"gpt-5.6"', '"gpt-5.6-luna"');
  return JSON.parse(text) as T;
}

export async function prepare(env: Record<string, string | undefined> = process.env): Promise<E2eFacts> {
  const adminUrl = adminUrlOf(env);
  const name = dbNameOf(env);
  const admin = createDb({ url: adminUrl, max: 1 });
  try {
    await admin.client.unsafe(`drop database if exists ${name} with (force)`);
    await admin.client.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }
  const url = e2eDbUrl(env);
  const { db, close } = createDb({ url, max: 4 });
  try {
    await runMigrations(db);
    const now = new Date();
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

    // 目录、路由两层骨架、额度留量线：和发布一样的装载链，只补缺。
    await loadCatalog(db, parseCatalog(readFileSync(CATALOG_EXAMPLE, 'utf8'), '目录配置样例'), {
      source: 'e2e:deploy/catalog.json',
    });
    await runRoutingApply(db);
    await applyQuotaReserveSeed(db, await loadQuotaReserveSeed(QUOTA_RESERVE_DEFAULT_PATH));

    // 探针：几条路由探通在线（库里约束：在线必须探通），其余留着「探针还没看过」。
    const alive = [
      'claude-carpool:opus-5.5:claude-code',
      'claude-solo:opus-5.5:claude-code',
      'mirasim-relay:deepseek-flash:mirasim',
      'cursor:cursor-auto:cursor-agent',
      'grok:grok-4.7:grok',
    ];
    await db
      .update(routes)
      .set({
        alive: true,
        probeState: 'ok',
        probedAt: new Date(ago(4)),
        probeDetail: '答上了：OK · 用时 8 秒',
      })
      .where(inArray(routes.id, alive));
    // 渠道状态页（#1087）的「检测中断」：Claude 订阅两条在用的路是半小时前探的（15 分钟一轮 + 3 分钟都过了），其余渠道是 4 分钟前探的。
    // 半小时还没到 45 分钟的「探测过期」线，路由页下面的活 / 不知道不受影响。
    await db
      .update(routes)
      .set({ probedAt: new Date(ago(30)) })
      .where(inArray(routes.id, ['claude-carpool:opus-5.5:claude-code', 'claude-solo:opus-5.5:claude-code']));

    // 业务数据：devFixtures 里的任务、会话、提醒、PR 等，渠道、池、路由编号对到目录里的真名字；它自带的目录那几类不要。
    const base = mapCatalogNames(devFixtures(now));
    const carpool = 'claude-carpool';
    const solo = 'claude-solo';
    const data = {
      ...base,
      channels: [],
      pools: [],
      models: [],
      routes: [],
      bans: [],
      settings: base.settings ?? [],
      quotaWindows: [
        {
          poolId: carpool,
          label: '5h_usd',
          window: '5h' as const,
          used: 38,
          limit: 100,
          unit: 'usd' as const,
          resetsAt: ago(-150),
          reading: 'measured' as const,
          source: 'reclaude-carpool',
          readAt: ago(3),
        },
        {
          poolId: solo,
          label: '5h',
          window: '5h' as const,
          utilization: 0.55,
          unit: 'percent' as const,
          resetsAt: ago(-95),
          reading: 'measured' as const,
          source: 'claude-usage',
          readAt: ago(3),
        },
        {
          poolId: solo,
          label: '7d',
          window: '7d' as const,
          utilization: 0.31,
          unit: 'percent' as const,
          upstreamStatus: 'allowed' as const,
          statusRaw: 'allowed',
          reading: 'measured' as const,
          source: 'claude-usage',
          readAt: ago(3),
        },
        {
          // 两小时前读成过、之后一直没读成：额度页要标「过期」，不当现值。
          poolId: 'cursor',
          label: 'month_usd',
          window: 'month_usd' as const,
          used: 12.5,
          limit: 20,
          unit: 'usd' as const,
          reading: 'estimated' as const,
          source: 'estimate',
          readAt: ago(120),
        },
        {
          poolId: 'mirasim-relay',
          label: '5h',
          window: '5h' as const,
          utilization: 0.93,
          unit: 'percent' as const,
          resetsAt: ago(-40),
          reading: 'measured' as const,
          source: 'mirasim-relay',
          readAt: ago(6),
        },
      ],
      tasks: [
        ...(base.tasks ?? []),
        {
          id: taskIds.asking,
          repoId: IDS.repo,
          issueNumber: 17,
          title: '通知邮件改用新模板',
          rawRequest: '通知邮件换成新模板',
          requestedBy: IDS.founderA,
          state: 'asking' as const,
          priority: 2,
          acceptance: [],
          createdAt: ago(45),
        },
        {
          id: taskIds.stalled,
          repoId: IDS.repo,
          issueNumber: 14,
          title: '导出报表加 CSV',
          rawRequest: '报表页要能导出 CSV',
          requestedBy: IDS.founderA,
          state: 'stalled' as const,
          priority: 2,
          acceptance: ['导出的列和页面一致'],
          createdAt: ago(300),
        },
        {
          id: taskIds.queued,
          repoId: IDS.repo,
          issueNumber: 15,
          title: '设置页加深色模式开关',
          rawRequest: '设置页要有深色模式开关',
          requestedBy: IDS.founderB,
          state: 'queued' as const,
          priority: 3,
          acceptance: [],
          createdAt: ago(20),
        },
        {
          id: taskIds.failed,
          repoId: IDS.repo,
          issueNumber: 16,
          title: '升级依赖到最新',
          rawRequest: '把依赖都升到最新',
          requestedBy: IDS.founderA,
          state: 'failed' as const,
          priority: 3,
          acceptance: [],
          createdAt: ago(900),
        },
      ],
      segmentRuns: [
        ...(base.segmentRuns ?? []),
        {
          id: 'd1000000-0000-4000-8000-000000014001',
          segment: 'scope' as const,
          taskId: taskIds.stalled,
          issueNumber: 14,
          model: 'opus-5.5',
          channel: 'claude-sub',
          startedAt: ago(290),
          endedAt: ago(284),
          outcome: 'done' as const,
          inputTokens: 12_000,
          outputTokens: 1_900,
          cacheReadTokens: 150_000,
          cacheWriteTokens: 7_000,
          costUsd: 0.31,
        },
        {
          id: 'd1000000-0000-4000-8000-000000014002',
          segment: 'manual' as const,
          taskId: taskIds.stalled,
          issueNumber: 14,
          model: 'kimi-k3',
          channel: 'mirasim',
          tier: 'fast' as const,
          startedAt: ago(282),
          endedAt: ago(252),
          outcome: 'timeout' as const,
          failureReason: '30 分钟没交活，按超时收了',
          inputTokens: 55_000,
          outputTokens: 4_100,
        },
      ],
      pullRequests: [
        ...(base.pullRequests ?? []),
        {
          repoId: IDS.repo,
          number: 38,
          state: 'merged' as const,
          headRef: 'fleet/16-deps',
          headSha: 'd'.repeat(40),
          checks: 'failure' as const,
          updatedAt: ago(850),
          openedAt: ago(880),
          issueRefs: [16],
        },
      ],
      notifications: [
        ...(base.notifications ?? []),
        {
          id: 'f0000000-0000-4000-8000-000000000203',
          level: 'alert' as const,
          title: '额度读数 35 分钟没更新',
          body: 'Cursor 订阅的额度读数过期了',
          link: '/quota',
          createdAt: ago(35),
          dedupeKey: 'quota-stale:cursor',
          deliveries: [],
        },
        {
          id: 'f0000000-0000-4000-8000-000000000205',
          level: 'decision' as const,
          title: '等你回答：新模板的落款用谁的名字？',
          body: '#17 在等你选落款',
          link: `/tasks/${taskIds.asking}`,
          taskId: taskIds.asking,
          createdAt: ago(15),
          dedupeKey: `asking:${taskIds.asking}`,
          deliveries: [],
        },
        {
          id: 'f0000000-0000-4000-8000-000000000204',
          level: 'daily' as const,
          title: '#13 已合并',
          body: 'README 加一行当前时间，PR #39 已合并',
          link: `/tasks/${IDS.task13}`,
          taskId: IDS.task13,
          createdAt: ago(500),
          dedupeKey: 'merged:task13',
          deliveries: [],
        },
      ],
    };
    await seedPg(db, data);

    // 主页三段流水线图（#914）读的是三段流水（runs 表）：用引擎自己的写法 startRun / finishRun 写，而不是直接塞行。
    // #12：对题收了、动手正在跑（落在「动手」、有人在做）；#17：对题、动手都收了、验收还没起（落在「验收」、还没验）。
    const flowRun = async (
      taskId: string,
      issueNumber: number,
      segment: 'scope' | 'manual' | 'verify',
      model: string,
      startedMinutesAgo: number,
      endedMinutesAgo?: number,
    ) => {
      const { id } = await startRun(
        db,
        {
          segment,
          taskId,
          issueNumber,
          model,
          channel: model === 'opus-5.5' ? 'claude-sub' : 'mirasim',
          ...(segment === 'manual' ? { tier: 'fast' as const } : {}),
          startedAt: new Date(ago(startedMinutesAgo)),
        },
        now,
      );
      if (endedMinutesAgo !== undefined) {
        await finishRun(
          db,
          {
            runId: id,
            outcome: 'done',
            endedAt: new Date(ago(endedMinutesAgo)),
            inputTokens: 20_000,
            outputTokens: 3_000,
            costUsd: 0.5,
          },
          now,
        );
      }
    };
    await flowRun(IDS.task12, 12, 'scope', 'opus-5.5', 50, 44);
    await flowRun(IDS.task12, 12, 'manual', 'opus-5.5', 12);
    await flowRun(taskIds.asking, 17, 'scope', 'opus-5.5', 40, 35);
    await flowRun(taskIds.asking, 17, 'manual', 'kimi-k3', 34, 20);
    await writeLedger(db, now);
    // 各池最近一次读成额度的时刻（读成才算「查成过」，主页的额度条和对账看它）：和上面各池读数的时刻一致。
    for (const [poolId, minutes] of [
      [carpool, 3],
      [solo, 3],
      ['mirasim-relay', 6],
      ['cursor', 120],
    ] as const) {
      await db
        .update(pools)
        .set({ lastReadOkAt: new Date(ago(minutes)) })
        .where(eq(pools.id, poolId));
    }

    // 账密：创始人甲。
    const store = createPgStore(db, { now: () => new Date() });
    const set = await store.setPasswordCredentials(
      {
        userId: DEV_USER_ID,
        username: E2E_USERNAME,
        passwordHash: await hashPassword(E2E_PASSWORD, { N: 2 ** 10, r: 8, p: 1 }),
        at: now,
      },
      {
        actor: { kind: 'engine', id: 'ops:e2e-prepare' },
        action: 'credentials.set',
        target: `user:${DEV_USER_ID}`,
        via: 'engine',
        ok: true,
      },
    );
    if (set !== 'ok') throw new Error(`给创始人甲设账密没成：${String(set)}`);

    return {
      dbUrl: url,
      userId: DEV_USER_ID,
      username: E2E_USERNAME,
      password: E2E_PASSWORD,
      tasks: {
        running: IDS.task12,
        done: IDS.task13,
        stalled: taskIds.stalled,
        queued: taskIds.queued,
        failed: taskIds.failed,
        asking: taskIds.asking,
      },
      issues: { running: 12, done: 13, stalled: 14, queued: 15, failed: 16, asking: 17 },
      approvalNotificationId: IDS.notification2,
      alertNotificationId: IDS.notification1,
      pools: { carpool, solo },
    };
  } finally {
    await close();
  }
}

if (import.meta.main) {
  try {
    if (process.argv.includes('--refresh-ledger')) {
      await refreshLedger();
    } else {
      const facts = await prepare();
      process.stdout.write(`${JSON.stringify(facts)}\n`);
    }
  } catch (err) {
    process.stderr.write(`备库失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  }
}
