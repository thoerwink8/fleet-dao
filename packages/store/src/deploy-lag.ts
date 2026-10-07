// 线上读数跟不跟得上、查没查成：/healthz 的 deploy_lag 一项，和后端的「线上版本跟不上主线」报警。读的时候现算——法国的 current 链接
// （在用哪版），加自动发布单元（deploy/france/auto-release，只读不发）每一轮写的状态文件（主线头和最近的提交、CI、
// 规矩同步到哪、装机脚本装到哪）。判法只这一份：健康检查和报警都调 judgeDeployLag。规矩见 docs/ops.md 第九节「自动发布」。
// 改这里之前必须知道：
// - 发布只走驾驶舱按钮（决定 0032）：落后主线几个提交只是数（驾驶舱「落后主线 N 个提交」，env-view 的 versionFact 数），**不算毛病**——
//   没人去发它，报警只会天天挂着。这里只报读数没查成（单元没报到、主线头读不到、在用的读不到、状态文件认不出）、规矩同步和装机自动档没成、
//   装机脚本的人工档落后（要人跑）。
// - 状态文件的字段跟 deploy/france/auto-release/lib.mjs 走（STATE_SCHEMA）；test/deploy-lag.test.ts 拿那边真跑出来的状态核对。
// - 这一项会随时间自己变红（单元停了），发布脚本只把它标待处理、不退回（deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。
// - 公网看得到 /healthz：对外的话不带提交号、路径、内部名；细节只进日志和报警正文。报警只用不带时长的话，
//   免得每 5 分钟改一次卡片（飞书免费版每月 1 万次接口调用，design 15.4）。
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, openAlertsByPrefix, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { z } from 'zod';
import type { Logger } from './ports.ts';

/** 法国上各版所在的目录（deploy/release.sh 的 RELEASES）。 */
export const RELEASES_DIR = '/srv/fleet-dao-releases';
/** 不在正式环境（FLEET_ENV=production，法国是；开发、测试不是）：这一项报「未接」，公网看得到。 */
export const DEPLOY_LAG_NOT_HERE = '只在正式环境查';

/** 各种「多久算不对」。自动发布单元每 5 分钟读一轮。 */
export const DEPLOY_LAG_LIMITS = {
  /** 自动发布单元这么久没跑一轮：定时器停了、没装、跑崩了。 */
  reportMs: 20 * 60_000,
  /** 主线头这么久没读到（取不到 GitHub）。 */
  mainMs: 20 * 60_000,
  /** 装机脚本的人工档（防火墙、sudoers、建用户那几个文件，要人跑 france.sh）落后主线这么久报；自动档不算，发版时自动装。 */
  systemMs: 24 * 60 * 60_000,
} as const;

const ALERT_PREFIX = 'deploy-lag:';
const SHA = /^[0-9a-f]{40}$/;
const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), '不是时间');
const Sha = z.string().regex(SHA);

/** 自动发布的状态文件（lib.mjs 的 carryOver 那一份）；只取这里要用的几样，多的字段不管。 */
export const DeployLagState = z.object({
  schema: z.literal(1),
  ranAt: Iso,
  main: z
    .object({
      checkedAt: Iso,
      head: Sha,
      headAt: Iso,
      commits: z.array(z.tuple([Sha, Iso])).min(1),
    })
    .nullable(),
  mainError: z.string().nullable(),
  ci: z
    .object({
      sha: Sha,
      verdict: z.enum(['green', 'red', 'pending', 'unknown']),
      detail: z.string(),
      checkedAt: Iso,
    })
    .nullable(),
  rules: z
    .object({
      commit: Sha.optional(),
      at: Iso,
      result: z.enum(['ok', 'failed', 'unchecked']),
      detail: z.string(),
    })
    .nullable(),
  /** 装机的自动档（france.sh --auto-tier，发完版顺带跑）：装到哪个提交、成没成；老版本的自动发布没有这个字段。 */
  tier: z
    .object({
      commit: Sha.optional(),
      at: Iso,
      result: z.enum(['ok', 'failed', 'unchecked']),
      detail: z.string(),
    })
    .nullable()
    .optional(),
  system: z
    .union([
      z.object({ appliedSha: Sha, behind: z.number().int().min(0), oldestAt: Iso.nullable() }),
      z.object({ error: z.string() }),
    ])
    .nullable(),
  last: z.object({ action: z.string(), detail: z.string(), at: Iso }).nullable(),
});
export type DeployLagState = z.infer<typeof DeployLagState>;

export interface DeployLagInput {
  /** 在用的提交号；还没发布过是 null。 */
  current: { sha: string | null } | { error: string };
  /** 在用的那版切上去的时刻（发布历史 .history 里它最近一次切上去）；没有记录、读不出是 null（拿不准，不猜）。 */
  deployedAt?: string | null;
  state: DeployLagState | { error: string };
}

export interface DeployLagProblem {
  code: string;
  /** 对外的一句（公网 /healthz、健康页）：不带提交号、路径、内部名。 */
  message: string;
  /** 报警标题用：同一件事一直是这一句（不带时长），卡片才不会每轮都改。 */
  steady: string;
  /** 只进日志和 release.sh --check。 */
  detail: string;
  /** 自动发布单元那边已经当场报过警的（规矩同步没成、装机自动档没成）：这边不再报一遍。 */
  alreadyAlerted: boolean;
}

export interface DeployLagVerdict {
  ok: boolean;
  problems: DeployLagProblem[];
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '（没有）');

/** 对外说时长：「45 分钟」「2 小时 10 分钟」「3 天 4 小时」。 */
export function spoken(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
  return h % 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${Math.floor(h / 24)} 天`;
}

/** 判一次。now 由调用方给（测试好造）；input 由 readDeployLagInput 读，测试直接造。 */
export function judgeDeployLag(input: DeployLagInput, now: Date): DeployLagVerdict {
  const L = DEPLOY_LAG_LIMITS;
  const t = now.getTime();
  const ago = (iso: string) => t - Date.parse(iso);
  const problems: DeployLagProblem[] = [];
  const add = (p: Omit<DeployLagProblem, 'alreadyAlerted'> & { alreadyAlerted?: boolean }) =>
    problems.push({ alreadyAlerted: false, ...p });
  const done = (): DeployLagVerdict => ({ ok: problems.length === 0, problems });

  if ('error' in input.state) {
    add({
      code: 'unchecked',
      message: '没查成：读不到自动发布的记录',
      steady: '读不到自动发布的记录',
      detail: input.state.error,
    });
    return done();
  }
  const st = input.state;

  // 自动发布单元还在不在跑：20 分钟没报到就是停了（停了的时候主线头自然也旧，不再多报一条）
  const stale = ago(st.ranAt) > L.reportMs;
  if (stale) {
    add({
      code: 'stale',
      message: `没查成：自动发布 ${spoken(ago(st.ranAt))}没报到`,
      steady: '自动发布没报到（定时器停了、没装或跑崩了）',
      detail: `上一轮 ${st.ranAt}：systemctl status fleet-auto-release.timer；journalctl -u fleet-auto-release -n 30`,
    });
  }
  if (!st.main) {
    add({
      code: 'unchecked',
      message: '没查成：主线头还没读到过',
      steady: '主线头还没读到过',
      detail: st.mainError ?? '',
    });
  } else if (!stale && ago(st.main.checkedAt) > L.mainMs) {
    add({
      code: 'unchecked',
      message: `没查成：主线头 ${spoken(ago(st.main.checkedAt))}没读到`,
      steady: '主线头读不到',
      detail: st.mainError ?? `上次读到在 ${st.main.checkedAt}`,
    });
  }

  if ('error' in input.current) {
    add({
      code: 'unchecked',
      message: '没查成：读不到在用的是哪一版',
      steady: '读不到在用的是哪一版',
      detail: input.current.error,
    });
  } else if (input.current.sha === null) {
    add({ code: 'not_released', message: '还没发布过', steady: '还没发布过', detail: '' });
  }

  if (st.rules?.result === 'failed') {
    add({
      code: 'rules_failed',
      message: '规矩同步没成',
      steady: '规矩同步没成',
      detail: `同步到 ${short(st.rules.commit)} 没成：${st.rules.detail}`,
      alreadyAlerted: true,
    });
  } else if (st.rules?.result === 'unchecked') {
    add({
      code: 'rules',
      message: '没查成：规矩同步到哪没读到',
      steady: '规矩同步到哪没读到',
      detail: st.rules.detail,
    });
  }

  // 自动档没装成：自动发布单元当场报过警（alreadyAlerted）、30 分钟后自己再试，这里只让它进读数
  if (st.tier?.result === 'failed') {
    add({
      code: 'tier_failed',
      message: '装机的自动档没装成',
      steady: '装机的自动档没装成',
      detail: `装到 ${short(st.tier.commit)} 没成：${st.tier.detail}`,
      alreadyAlerted: true,
    });
  }

  if (st.system && 'error' in st.system) {
    add({
      code: 'system',
      message: '没查成：装机脚本装到哪没读到',
      steady: '装机脚本装到哪没读到',
      detail: st.system.error,
    });
  } else if (
    st.system &&
    st.system.behind > 0 &&
    st.system.oldestAt &&
    ago(st.system.oldestAt) > L.systemMs
  ) {
    add({
      code: 'system',
      message: `装机脚本落后主线 ${st.system.behind} 个相关提交、${spoken(ago(st.system.oldestAt))}，要人重跑`,
      steady: '装机脚本落后主线，要人重跑',
      detail: `装到 ${short(st.system.appliedSha)}；防火墙、sudoers、建用户那几个文件（deploy/france/auto-release/lib.mjs 的 HUMAN_TIER_PATHS）之后改过：在法国以 root 跑 bash /srv/fleet-dao/deploy/france.sh（不自动跑；其余装机步骤发版时自动装）`,
    });
  }
  return done();
}

/** 读法国上的现状：current 链接、状态文件、发布历史里在用那版切上去的时刻。读不到的照实带上原因。 */
export function readDeployLagInput(dir: string = RELEASES_DIR): DeployLagInput {
  let current: DeployLagInput['current'];
  try {
    const target = readlinkSync(join(dir, 'current'));
    current = SHA.test(target)
      ? { sha: target }
      : { error: `current 指着认不出的「${target.slice(0, 60)}」` };
  } catch (err) {
    current = errno(err) === 'ENOENT' ? { sha: null } : { error: `读不了 current：${String(err)}` };
  }
  let state: DeployLagInput['state'];
  try {
    const parsed = DeployLagState.safeParse(
      JSON.parse(readFileSync(join(dir, '.auto', 'state.json'), 'utf8')),
    );
    state = parsed.success
      ? parsed.data
      : {
          error: `状态文件认不出（${parsed.error.issues[0]?.path.join('.') ?? ''}：${parsed.error.issues[0]?.message ?? ''}）`,
        };
  } catch (err) {
    state = {
      error:
        errno(err) === 'ENOENT'
          ? '还没有状态文件：自动发布没装，或一轮都还没跑过（france.sh 装）'
          : `状态文件读不出来：${String(err)}`,
    };
  }
  let deployedAt: string | null = null;
  if ('sha' in current && current.sha) {
    try {
      deployedAt = deployedAtFromHistory(readFileSync(join(dir, '.history'), 'utf8'), current.sha);
    } catch {
      deployedAt = null;
    }
  }
  return { current, deployedAt, state };
}

/** 发布历史（release.sh 的 .history：每行 `时间 提交号 事件 [unmerged]`）里这个提交最近一次切上去的时间；没有记录回 null，时间认不出抛。 */
export function deployedAtFromHistory(history: string, sha: string): string | null {
  let at: string | null = null;
  for (const raw of history.split(/\r?\n/)) {
    const [time, got, event] = raw.trim().split(/\s+/);
    if (got !== sha || !time) continue;
    // 切上去的三种事件；unhealthy、recovered 不是切版本
    if (event === 'release' || event === 'rollback' || event === 'auto-rollback') at = time;
  }
  if (at !== null && Number.isNaN(Date.parse(at)))
    throw new Error(`发布历史里「${at.slice(0, 40)}」不是时间`);
  return at;
}

function errno(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * 「跟不上主线」报警：每 5 分钟判一次，有不对的（自动发布那边当场报过的除外）就开一条（开着就只在说法变了时改），好了解除。
 * 定时器停了、没装这种事自动发布自己报不了，只能这边看出来。库写不进去只记日志，下一轮再来。返回停止的函数。
 */
export function startDeployLagWatch(deps: {
  db: Db;
  read: () => DeployLagInput;
  now: () => Date;
  log: Logger;
  everyMs?: number;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await watchOnce(deps);
    } catch (err) {
      deps.log.warn('线上版本跟不跟得上主线：这一轮报警没做成', { error: String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? 5 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 判一次、开或改或解除那一条报警（测试直接调）。 */
export async function watchOnce(deps: {
  db: Db;
  read: () => DeployLagInput;
  now: () => Date;
}): Promise<void> {
  const v = judgeDeployLag(deps.read(), deps.now());
  const mine = v.problems.filter((p) => !p.alreadyAlerted);
  const open = await openAlertsByPrefix(deps.db, ALERT_PREFIX);
  if (mine.length === 0) {
    for (const a of open) await resolveAlertByKey(deps.db, { dedupeKey: a.dedupeKey, by: 'deploy-lag' });
    return;
  }
  const first = mine[0];
  if (!first) return;
  const title = `线上版本跟不上主线：${first.steady}`;
  const body = [
    ...mine.map((p) => `- ${p.steady}`),
    '细节：法国以 root 跑 bash /srv/fleet-dao/deploy/release.sh --check（「自动发布」一节和健康检查里的 deploy_lag），' +
      '或 journalctl -u fleet-auto-release -n 30',
  ].join('\n');
  const cur = open[0];
  if (cur && cur.title === title && cur.body === body) return;
  await upsertAlert(deps.db, {
    dedupeKey: cur?.dedupeKey ?? `${ALERT_PREFIX}${deps.now().toISOString()}`,
    level: 'alert',
    taskId: null,
    title,
    body,
  });
}
