// 线上读数跟不跟得上、查没查成：/healthz 的 deploy_lag 一项，和后端的「线上版本跟不上主线」报警。读的时候现算——法国的 current 链接
// （在用哪版），加自动发布单元（deploy/france/auto-release，只读不发）每一轮写的状态文件（主线头和最近的提交、CI、
// 规矩同步到哪、装机脚本装到哪）。判法只这一份：健康检查和报警都调 judgeDeployLag。规矩见 docs/ops.md 第九节「自动发布」。
// 改这里之前必须知道：
// - 发布只走驾驶舱按钮（决定 0032）：落后主线几个提交只是数（驾驶舱「落后主线 N 个提交」，env-view 的 versionFact 数），**不算毛病**——
//   没人去发它，报警只会天天挂着。这里只报读数没查成（单元没报到、主线头读不到、在用的读不到、状态文件认不出）、规矩同步和装机自动档没成、
//   装机脚本的人工档落后（要人跑）、root 跑的脚本副本和在用版本不一致（当轮就报）、在用版本的依赖发版后被动过（#2728）、
//   current 已切但 fleet-engine / fleet-api 主进程还在旧目录（不是只改文档或测试，#2359）。
//   驾驶舱「在用版本」、自动发版 journal 的 summary、发版卡「法国在用」和这里同一份 assessRunningRelease
//   （deploy/france/auto-release/running-release.mjs），进程还在旧目录时不把 current 链接标成已经切过去。
// - 状态文件的字段跟 deploy/france/auto-release/lib.mjs 走（STATE_SCHEMA）；test/deploy-lag.test.ts 拿那边真跑出来的状态核对。
// - 这一项会随时间自己变红（单元停了），发布脚本只把它标待处理、不退回（deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。
// - 公网看得到 /healthz：对外的话不带提交号、路径、内部名；细节只进日志和报警正文。报警只用不带时长的话，
//   免得每 5 分钟改一次卡片（飞书免费版每月 1 万次接口调用，design 15.4）。
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, openAlertsByPrefix, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { z } from 'zod';
import type { Logger } from './ports.ts';
import { assessRunningRelease, diffIsDocsOnly, readRunningRelease } from './running-release.mjs';

export { assessRunningRelease, diffIsDocsOnly };

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
  /**
   * 装机的自动档（france.sh --auto-tier，发完版顺带跑）：装到哪个提交、成没成；老版本的自动发布没有这个字段。
   * result=unchecked 是冷启动窗口（服务刚 ActiveEnter、4318 还没 listen），不是失败，不报 tier_failed。
   */
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
  /**
   * /usr/local/lib 下 root 跑的脚本副本和在用那一版的原件比哈希（#2728，lib.mjs 的 installedStep，每轮重算）；老版本没有这个字段。
   * drift 当轮就报（不等 24 小时）：副本不对，修复合进去了在法国也不生效。
   */
  installed: z
    .object({
      commit: Sha,
      checkedAt: Iso,
      result: z.enum(['ok', 'drift', 'unchecked']),
      drift: z.array(z.string()),
      detail: z.string(),
    })
    .nullable()
    .optional(),
  /** 在用那一版依赖的指纹（#2728，lib.mjs 的 depsStep）：repaired 只留日报，不让 deploy_lag 变红；changed、unchecked 这里报。 */
  deps: z
    .object({
      commit: Sha,
      result: z.enum(['ok', 'repaired', 'changed', 'unchecked']),
      detail: z.string(),
    })
    .nullable()
    .optional(),
});
export type DeployLagState = z.infer<typeof DeployLagState>;

/** 一个服务主进程 cwd 解出的发布提交。没在跑是 sha null；读失败带原因。 */
export type ProcRelease = { sha: string | null } | { error: string };

/**
 * 主进程实际所在的发布提交（systemd MainPID 的 /proc/pid/cwd），不是 current 链接。
 * 不给这一项：不查（旧调用、单测里没造进程）。给了就查 fleet-engine，给了 api 也查后端。
 */
export interface RunningRelease {
  engine: ProcRelease;
  /** 不给就不查后端。生产读 fleet-api。 */
  api?: ProcRelease;
  /**
   * 进程所在提交 → 相对 current 的路径（git diff --name-only --no-renames）。
   * 每一条都落在文档/测试白名单（和 deploy/release.sh 的 runtime_unchanged 同一份，#2359）才允许留在旧目录。
   * 没有这个键：对不上就报，不当成只改了文档。空数组是两边树一样，允许沿用。
   */
  diffs?: Readonly<Record<string, readonly string[]>>;
}

export interface DeployLagReadIo {
  readProc?: (unit: 'fleet-engine.service' | 'fleet-api.service') => ProcRelease;
  /** 返回 { error } 表示没比成，这一对提交不当成只改文档。 */
  diffNames?: (oldSha: string, newSha: string) => readonly string[] | { error: string };
}

export interface DeployLagInput {
  /** 在用的提交号；还没发布过是 null。 */
  current: { sha: string | null } | { error: string };
  /** 在用的那版切上去的时刻（发布历史 .history 里它最近一次切上去）；没有记录、读不出是 null（拿不准，不猜）。 */
  deployedAt?: string | null;
  state: DeployLagState | { error: string };
  /** 主进程 cwd。不给就不比（旧调用）。readDeployLagInput 会填。 */
  running?: RunningRelease;
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

  // 自动档没装成（result=failed）：自动发布单元当场报过警（alreadyAlerted）、真失败隔 30 分钟再试，这里只让它进读数。
  // result=unchecked 是冷启动窗口（4318 还没 listen，本轮不落 failed）：不报 tier_failed，否则发版重启后 healthz 会红到窗口结束甚至半小时。
  if (st.tier?.result === 'failed') {
    add({
      code: 'tier_failed',
      message: '装机的自动档没装成',
      steady: '装机的自动档没装成',
      detail: `装到 ${short(st.tier.commit)} 没成：${st.tier.detail}`,
      alreadyAlerted: true,
    });
  }

  // 脚本副本和在用版本不一致：当轮就报（#2728；以前接活脚本归人工档，副本落后主线一天多、修复没生效，要等装机脚本落后 24 小时才报）。
  // 只认这一轮对的就是在用的那一版（刚切了版本、自动发布还没跑到的那一轮不算）。
  const installed = st.installed;
  const currentSha = 'sha' in input.current ? input.current.sha : null;
  if (installed && installed.commit === currentSha && installed.result === 'drift') {
    add({
      code: 'installed_drift',
      message: '装着的发版脚本和在用版本不一致',
      steady: '装着的发版脚本和在用版本不一致',
      detail: `${installed.detail}：装机自动档（france.sh --auto-tier）没换上，看 journalctl -u fleet-auto-release -n 30`,
    });
  } else if (installed && installed.commit === currentSha && installed.result === 'unchecked') {
    add({
      code: 'installed',
      message: '没查成：装着的发版脚本对不对得上在用版本',
      steady: '装着的发版脚本对没对上没查成',
      detail: installed.detail,
    });
  }
  if (st.deps && st.deps.commit === currentSha && st.deps.result === 'changed') {
    add({
      code: 'deps_changed',
      message: '在用版本的依赖发版后被动过',
      steady: '在用版本的依赖发版后被动过',
      detail: st.deps.detail,
      alreadyAlerted: true,
    });
  } else if (st.deps && st.deps.commit === currentSha && st.deps.result === 'unchecked') {
    add({
      code: 'deps',
      message: '没查成：在用版本的依赖指纹',
      steady: '在用版本的依赖指纹没查成',
      detail: st.deps.detail,
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
  const runningView = assessRunningRelease(input);
  if (runningView.problem) add(runningView.problem);
  return done();
}

/** 读法国上的现状：current 链接、状态文件、发布历史里在用那版切上去的时刻、主进程 cwd。读不到的照实带上原因。 */
export function readDeployLagInput(dir: string = RELEASES_DIR, io?: DeployLagReadIo): DeployLagInput {
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
  return { current, deployedAt, state, running: readRunningRelease(dir, current, io) };
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
