// 线上版本跟不跟得上主线：/healthz 的 deploy_lag 一项，和后端的「跟不上主线」报警。读的时候现算——法国的 current 链接
// （在用哪版），加自动发布（deploy/france/auto-release）每一轮写的状态文件（主线头和最近的提交、CI、最近一次自动发布、
// 规矩同步到哪、装机脚本装到哪）。判法只这一份：健康检查和报警都调 judgeDeployLag。规矩见 docs/ops.md 第九节「自动发布」。
// 改这里之前必须知道：
// - 状态文件的字段跟 deploy/france/auto-release/lib.mjs 走（STATE_SCHEMA）；test/deploy-lag.test.ts 拿那边真跑出来的状态核对。
// - 这一项会随时间自己变红（主线一动就可能落后），发布脚本只把它标待处理、不退回（deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。
// - 公网看得到 /healthz：对外的话不带提交号、路径、内部名；细节只进日志和报警正文。报警只用不带时长的话，
//   免得每 5 分钟改一次卡片（飞书免费版每月 1 万次接口调用，design 15.4）。
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, openAlertsByPrefix, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { z } from 'zod';
import { PublicHealthError } from './health.ts';
import type { Logger } from './ports.ts';

/** 法国上各版所在的目录（deploy/release.sh 的 RELEASES）。 */
export const RELEASES_DIR = '/srv/fleet-dao-releases';
/** 不在法国的正式机器上（开发、测试）：这一项报「未接」，公网看得到。 */
export const DEPLOY_LAG_NOT_HERE = '只在法国的正式机器上查';

/**
 * 各种「多久算不对」。自动发布每 5 分钟一轮，有要发的马上发（发布脚本先排空引擎，宽限 10 分钟和构建一起走）；只有不会排空的旧引擎
 * 才等空闲，最多 60 分钟（lib.mjs 的 IDLE_WAIT_MS）。
 */
export const DEPLOY_LAG_LIMITS = {
  /** 自动发布这么久没跑一轮：定时器停了、没装、跑崩了。 */
  reportMs: 20 * 60_000,
  /** 一轮里的发布跑了这么久还没完。 */
  runningMs: 60 * 60_000,
  /** 主线头这么久没读到（取不到 GitHub）。 */
  mainMs: 20 * 60_000,
  /** 主线头的 CI 红、结论读不到，落后这么久报。 */
  ciMs: 30 * 60_000,
  /** 其余原因（在等 CI、等空闲、人手动按住）落后这么久报：旧引擎等空闲 60 分钟 + CI、构建、一轮的间隔。 */
  behindMs: 90 * 60_000,
  /** 装机脚本（france.sh，要人跑）落后主线这么久报。 */
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
  /**
   * 这一轮要发的版本标记（决定 0011 第 3 条）：版本号最大的那个 `v<N>` tag 且它指向的提交在 origin/main 上。
   * 读不到、认不出、不是主线上的提交时是 null，原因在 markerError——**发的一直是它，不是主线头**。
   */
  marker: z
    .object({ tag: z.string(), commit: Sha, at: Iso, taggedAt: Iso.optional(), checkedAt: Iso })
    .nullable()
    .optional(),
  markerError: z
    .object({ kind: z.string(), why: z.string(), at: Iso })
    .nullable()
    .optional(),
  ci: z
    .object({
      sha: Sha,
      verdict: z.enum(['green', 'red', 'pending', 'unknown']),
      detail: z.string(),
      checkedAt: Iso,
    })
    .nullable(),
  hold: z.object({ since: Iso, sha: Sha, event: z.string(), unmerged: z.boolean() }).nullable(),
  waitingSince: Iso.nullable(),
  attempt: z
    .object({
      sha: Sha,
      startedAt: Iso,
      endedAt: Iso.nullable().optional(),
      result: z.enum(['running', 'ok', 'failed']),
      detail: z.string().optional(),
      log: z.string().optional(),
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
  /** 在用的那版不在状态里的主线最近提交里时，它的完成标记说它在不在主线上；没读、读不到是 null。 */
  currentOnMain: boolean | null;
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
  /** 自动发布那边已经当场报过警的（发布没成、规矩同步没成）：这边不再报一遍。 */
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

/** 这一轮自动发布卡在哪（对外的一句，括号里）。 */
function waitingFor(st: DeployLagState): string {
  switch (st.last?.action) {
    case 'ci-pending':
      return '（在等 CI）';
    case 'wait-idle':
      return '（在等引擎空闲）';
    case 'hold':
      return '（人手动切过版本，等下一个版本标记）';
    case 'release-busy':
    case 'releasing':
      return '（在发）';
    default:
      return '';
  }
}

/** 这几样是「版本标记没查成、这一轮不发」：自动发布当场已经报过警（alreadyAlerted），这里只标出来。 */
const MARKER_STUCK_ACTIONS = new Set(['marker-none', 'marker-unknown', 'marker-not-ancestor']);

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

  // 自动发布还在不在跑：一轮里在发，就按发布本身的时限算；否则 20 分钟没报到就是停了
  const running = st.attempt?.result === 'running' ? ago(st.attempt.startedAt) : null;
  let fresh = true;
  if (running !== null && running > L.runningMs) {
    add({
      code: 'stuck',
      message: `自动发布跑了 ${spoken(running)}还没完`,
      steady: '自动发布跑了太久还没完',
      detail: `在发 ${short(st.attempt?.sha)}，${st.attempt?.startedAt} 开始`,
    });
  } else if (running === null && ago(st.ranAt) > L.reportMs) {
    fresh = false;
    add({
      code: 'stale',
      message: `没查成：自动发布 ${spoken(ago(st.ranAt))}没报到`,
      steady: '自动发布没报到（定时器停了、没装或跑崩了）',
      detail: `上一轮 ${st.ranAt}：systemctl status fleet-auto-release.timer；journalctl -u fleet-auto-release -n 30`,
    });
  }
  if (!st.main) {
    fresh = false;
    add({
      code: 'unchecked',
      message: '没查成：主线头还没读到过',
      steady: '主线头还没读到过',
      detail: st.mainError ?? '',
    });
  } else if (fresh && ago(st.main.checkedAt) > L.mainMs) {
    fresh = false;
    add({
      code: 'unchecked',
      message: `没查成：主线头 ${spoken(ago(st.main.checkedAt))}没读到`,
      steady: '主线头读不到',
      detail: st.mainError ?? `上次读到在 ${st.main.checkedAt}`,
    });
  }

  let current: string | null | undefined;
  if ('error' in input.current) {
    add({
      code: 'unchecked',
      message: '没查成：读不到在用的是哪一版',
      steady: '读不到在用的是哪一版',
      detail: input.current.error,
    });
  } else if (input.current.sha === null) {
    add({ code: 'behind', message: '还没发布过', steady: '还没发布过', detail: '' });
  } else {
    current = input.current.sha;
  }

  // 主线读数是新的才数落后几个：读数旧了上面已经报了「没查成」，拿旧读数数出来的不作数
  if (current && st.main && fresh) {
    lagOf(st, current, input.currentOnMain, t, add);
  }

  // 版本标记没查成（决定 0011 第 3 条）：没标记就不发主线头，所以它卡住 = 线上停在旧版本、等创始人拍下一版。
  // 自动发布当场已经报过一次（alreadyAlerted），这里不再报一遍，只让它进读数。
  if (fresh && st.marker === null && st.markerError && MARKER_STUCK_ACTIONS.has(st.last?.action ?? '')) {
    add({
      code: 'marker',
      message: `没查成：版本标记读不到（${st.markerError.kind === 'not-ancestor' ? '不是主线上的提交' : '没有或认不出'}）`,
      steady: '版本标记读不到（没有标记就不发）',
      detail: `${st.markerError.why}；这一轮 ${st.last?.action ?? '（没记）'}`,
      alreadyAlerted: true,
    });
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
      detail: `装到 ${short(st.system.appliedSha)}；在法国以 root 跑 bash /srv/fleet-dao/deploy/france.sh（碰防火墙、sudoers，不自动跑）`,
    });
  }
  return done();
}

function lagOf(
  st: DeployLagState,
  current: string,
  onMain: boolean | null,
  t: number,
  add: (p: Omit<DeployLagProblem, 'alreadyAlerted'> & { alreadyAlerted?: boolean }) => void,
): void {
  const L = DEPLOY_LAG_LIMITS;
  const main = st.main;
  if (!main) return;
  const idx = main.commits.findIndex(([sha]) => sha === current);
  if (idx === 0) return;
  if (idx < 0) {
    if (onMain === false) {
      const since = st.hold?.since;
      if (since && t - Date.parse(since) <= L.behindMs) return;
      add({
        code: 'unmerged',
        message: `在用的是没合进主线的提交${since ? `，已 ${spoken(t - Date.parse(since))}` : ''}`,
        steady: '在用的是没合进主线的提交',
        detail: `在用 ${short(current)}（合并前在真机上验的？）：PR 合进来后自动发布会换上主线的版本`,
      });
    } else if (onMain === true) {
      add({
        code: 'far',
        message: `落后主线超过 ${main.commits.length} 个提交`,
        steady: '落后主线太多',
        detail: `在用 ${short(current)}，主线头 ${short(main.head)}`,
      });
    } else {
      add({
        code: 'unchecked',
        message: '没查成：认不出在用的版本在主线上的哪儿',
        steady: '认不出在用的版本在主线上的哪儿',
        detail: `在用 ${short(current)}，它的完成标记读不到`,
      });
    }
    return;
  }
  const behind = idx;
  const oldest = main.commits[idx - 1]?.[1] ?? main.headAt;
  // 人手动按住的，从按住那一刻起算（给人留出修的时间）
  const from = Math.max(Date.parse(oldest), st.hold ? Date.parse(st.hold.since) : 0);
  const lag = t - from;
  const lagText = `落后主线 ${behind} 个提交`;
  const attempt = st.attempt;
  const last = st.last?.action;
  // 最近一次自动发布没成、那个提交比在用的新：主线头的 CI 没跑完时，自动发布发的是往回找到的全绿提交，不一定是主线头
  const failedAt = attempt?.result === 'failed' ? main.commits.findIndex(([sha]) => sha === attempt.sha) : -1;
  if (attempt && failedAt >= 0 && failedAt < idx) {
    add({
      code: 'failed',
      message: `${lagText}：最近一次自动发布没成`,
      steady: '最近一次自动发布没成',
      detail: `发 ${short(attempt.sha)} 没成：${attempt.detail ?? ''}；日志 ${attempt.log || '（没拿到）'}`,
      alreadyAlerted: true,
    });
  } else if (last === 'checkout-blocked') {
    add({
      code: 'checkout',
      message: `${lagText}：部署脚本的检出跟不上主线`,
      steady: '部署脚本的检出跟不上主线',
      detail: st.last?.detail ?? '',
    });
  } else if ((last === 'ci-red' || last === 'ci-unknown') && lag > L.ciMs) {
    const red = last === 'ci-red';
    add({
      code: 'ci',
      message: `${lagText}、${spoken(lag)}：主线最新提交的 CI ${red ? '没通过' : '结论读不到'}`,
      steady: `主线最新提交的 CI ${red ? '没通过' : '结论读不到'}`,
      detail: st.last?.detail ?? '',
    });
  } else if (lag > L.behindMs) {
    add({
      code: 'behind',
      message: `${lagText}、${spoken(lag)}${waitingFor(st)}`,
      steady: `落后主线太久${waitingFor(st)}`,
      detail: `在用 ${short(current)}，主线头 ${short(main.head)}；这一轮：${last ?? '（没记）'} ${st.last?.detail ?? ''}`,
    });
  }
}

/** 读法国上的现状：current 链接、状态文件，在用的不在主线最近的提交里时再读它的完成标记。读不到的照实带上原因。 */
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
  let currentOnMain: boolean | null = null;
  const sha = 'sha' in current ? current.sha : null;
  if (sha && !('error' in state) && state.main && !state.main.commits.some(([s]) => s === sha)) {
    try {
      const m = /^on_main=([01])$/m.exec(readFileSync(join(dir, sha, '.fleet-release'), 'utf8'));
      currentOnMain = m ? m[1] === '1' : null;
    } catch {
      currentOnMain = null;
    }
  }
  return { current, currentOnMain, state };
}

function errno(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** /healthz 的 deploy_lag 一项：不对就抛（对外一句中性的话，细节只进日志）。 */
export function deployLagCheck(read: () => DeployLagInput, now: () => Date): () => Promise<void> {
  return async () => {
    const v = judgeDeployLag(read(), now());
    const first = v.problems[0];
    if (!first) return;
    throw new PublicHealthError(
      first.code,
      v.problems.map((p) => p.message).join('；'),
      v.problems
        .map((p) => p.detail)
        .filter(Boolean)
        .join('；'),
    );
  };
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
