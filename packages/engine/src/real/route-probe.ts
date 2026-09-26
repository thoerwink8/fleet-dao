// 路由探针的真装配（#129，design 第九节「路由探针」）：路由从库里读（routeProbeTargets）、结论写回库（saveRouteProbe）、
// 结局记进 schedule_runs。
// Claude Code 的探法：以这条路由所在账号池的会话用户，经 fleet-agent-scope 在自己的 scope 里起一次 reclaude -p，问一句
// 「只回 OK」——和干活的会话同一个插头（runClaudeCode）、同一份 reclaude、同一个模型串，所以探通了就说明会话起得来、
// 答得上。不存会话记录（每 15 分钟一次，不往会话用户家里攒），权限一律拒（dontAsk：它什么工具都用不了）。
// 要人修的整池问题（登录失效、设备被撤销、封号、欠费）和会话同一个做法：写 pool-hold:<池> 那条「要人拍」，选路整池避开；
// 探通了就撤掉它。探的时候顺带读到的额度也记账（和会话一样 complete=false）。
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  claudeRunFacts,
  judgeClaudeRun,
  type RateLimitReading,
  runClaudeCode,
  SESSION_USERS,
  type SessionUser,
} from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import {
  type Db,
  finishScheduleRun,
  resolveAlertByKey,
  routeProbeTargets,
  savePoolQuota,
  saveRouteProbe,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { classifyFailure } from '../failure/classify.ts';
import type { ProbeAttempt, Prober, ProbeTarget, RouteProbeJobDeps } from '../jobs/route-probe.ts';
import { poolHoldKey, SESSION_USER_ORG } from './store-ports.ts';
import type { WorkTrees } from './worktrees.ts';

/** 问的那一句：最短的输出，用不着任何工具。 */
export const PROBE_PROMPT = '这是路由探针的连通性测试。只回复两个大写字母 OK，不要调用任何工具，也不要解释。';
/** 探针会话的工作目录：<工作树的根>/_route-probe/<会话用户>（GitHub 的用户名不以 _ 开头，撞不上仓的目录）。 */
export const PROBE_DIR = '_route-probe';
/**
 * 一次探多久：reclaude 更新后首跑会卡在「Syncing config…」上百秒，起来之后一问一答十几秒。
 * 没通隔 20 秒再探一次，两次加起来也在定时任务一轮的 10 分钟里。
 */
export const PROBE_LIMITS = { startupMs: 150_000, wallClockMs: 200_000, idleMs: 90_000 } as const;
/** 探针会话只起一个 claude，用不了干活会话那么多内存。 */
export const PROBE_SCOPE_LIMITS = { memoryHigh: '1024M', memoryMax: '1536M', memorySwapMax: '0' } as const;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** reclaude 没有有效登录时 stderr 里的那一句（之后它开始设备授权、一直等，直到起不来被强杀）。 */
const RECLAUDE_NO_LOGIN = /^.*no valid login detected.*$/im;
/**
 * 原文进库、上驾驶舱之前去掉网址的查询串：reclaude 设备授权的链接带着一次性的 state，
 * 别人点开批准就能替这台机器登录，不该落进库里。
 */
const withoutQueries = (text: string) => text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?…');

function asSessionUser(user: string | null): SessionUser | undefined {
  return (SESSION_USERS as readonly string[]).includes(user ?? '') ? (user as SessionUser) : undefined;
}

/** 探针会话的工作目录。 */
export function probeDir(root: string, user: SessionUser): string {
  return `${root}/${PROBE_DIR}/${user}`;
}

export interface ProbeContext {
  machine: string;
  user: SessionUser;
  now: Date;
}

/**
 * 一次探针会话的报告 → 结论。答上了、答的是 OK 才算通；额度用满被拒算通（quota）；其余按失败分流的同一张规则表
 * 认出是什么事（登录失效、设备被撤销……），要人修的整池问题带上 poolHold。
 */
export function probeVerdict(report: ClaudeCodeRunReport, t: ProbeTarget, ctx: ProbeContext): ProbeAttempt {
  const verdict = judgeClaudeRun(report);
  const result = report.stream.result;
  const text = (result?.text ?? '').trim();
  if (verdict.outcome === 'ok') {
    if (!/\bok\b/i.test(text)) {
      return {
        kind: 'failed',
        detail: `回答认不出（要的是 OK）：${text ? clip(withoutQueries(text), 80) : '回答是空的'}`,
      };
    }
    const secs = Math.max(1, Math.round(report.wallMs / 1000));
    const cost = result?.sessionCostUsd;
    return {
      kind: 'answered',
      detail: `答上了：${clip(text, 40)} · 用时 ${secs} 秒${cost === undefined ? '' : ` · 按 API 价折合 $${cost.toFixed(3)}`}`,
    };
  }
  const facts = claudeRunFacts(report);
  // 执行体最后说的话；reclaude 没登录的那一句在整段 stderr 里找（它后面还会打几行，可能挤出最后三行）。
  const loginLine = report.stderrTail.match(RECLAUDE_NO_LOGIN)?.[0]?.trim();
  const said = [facts.lastWords, loginLine && !facts.lastWords?.includes(loginLine) ? loginLine : undefined]
    .filter(Boolean)
    .join(' ⏎ ');
  const exhausted = [...report.stream.rateLimits].reverse().find((x) => x.exhausted);
  const resetsAt =
    exhausted?.resetsAt ?? exhausted?.windows.find((w) => w.name === exhausted.rateLimitType)?.resetsAt;
  let cls: ReturnType<typeof classifyFailure> | undefined;
  try {
    cls = classifyFailure({
      source: 'probe',
      poolId: t.poolId,
      routeId: t.routeId,
      modelId: t.modelId,
      hostId: t.hostId,
      code: verdict.reason,
      message: [verdict.detail, said].filter(Boolean).join(' · '),
      ...(result?.apiErrorStatus === undefined ? {} : { httpStatus: result.apiErrorStatus }),
      exitCode: report.exitCode,
      signal: report.signal,
      ...(resetsAt ? { resetsAt } : {}),
      machine: ctx.machine,
      runAsUser: ctx.user,
      now: ctx.now.toISOString(),
    });
  } catch {
    cls = undefined;
  }
  if (verdict.reason === 'quota_exhausted' || cls?.rule === 'QT1') {
    return {
      kind: 'quota',
      detail: withoutQueries(
        `额度用满被拒（登录、组织、上游都通，派不派按额度等清零）：${verdict.detail}${resetsAt ? ` · ${resetsAt} 清零` : ''}`,
      ),
    };
  }
  const what = !cls || cls.via === 'fallback' ? verdict.detail : `${cls.title}：${verdict.detail}`;
  const words = said && !what.includes(said) ? `（原文：${clip(said, 200)}）` : '';
  // 规则表里登录失效（AU2）没写修法（它也管别家的登录）；这里探的是经 reclaude 起的 Claude Code，修法是确定的
  const fix =
    cls?.humanFix ??
    (cls?.rule === 'AU2'
      ? `在${ctx.machine}上以 ${ctx.user} 重跑 reclaude login（docs/ops.md 第五节），在浏览器里批准；下一轮探针探通就转回在线`
      : undefined);
  const detail = withoutQueries([`${what}${words}`, fix].filter(Boolean).join('。'));
  const hold = cls?.shared?.scope === 'pool' && cls.shared.until === undefined;
  return {
    kind: 'failed',
    detail,
    ...(hold && cls
      ? { poolHold: { title: cls.title, body: withoutQueries([fix, cls.reason].filter(Boolean).join('。')) } }
      : {}),
  };
}

export interface ClaudeProberDeps {
  trees: Pick<WorkTrees, 'root' | 'ownerOf' | 'adopt'>;
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在会话用户自己家里，和干活的会话同一份。 */
  claudeCommand(user: SessionUser): string[];
  machine: string;
  now: () => Date;
  /** 探的时候读到的额度读数（真实现记进 quota_windows）。 */
  onRateLimit?: (target: ProbeTarget, reading: RateLimitReading) => void;
  /** 以下测试用。 */
  run?: (spec: ClaudeCodeRunSpec, options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunReport>;
  helper?: string;
  sudo?: readonly string[];
  baseEnv?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<typeof PROBE_LIMITS>;
}

/** Claude Code（经 reclaude）的探法。不抛：起不来、超时、认不出都写成没探通的原因。 */
export function claudeCodeProber(deps: ClaudeProberDeps): Prober {
  const run = deps.run ?? runClaudeCode;
  return async (t) => {
    const user = asSessionUser(t.runAsUser);
    if (!user) {
      return {
        kind: 'failed',
        detail: `账号池 ${t.poolId} 没定会话用户（pools.run_as_user 是 ${t.runAsUser ?? '空的'}），起不了会话`,
      };
    }
    const dir = probeDir(deps.trees.root, user);
    try {
      if ((await deps.trees.ownerOf(dir)) !== user) await deps.trees.adopt(dir, user);
    } catch (err) {
      return { kind: 'failed', detail: `探针的工作目录 ${dir} 没交给 ${user}：${message(err)}` };
    }
    const runId = `probe-${randomUUID()}`;
    let report: ClaudeCodeRunReport;
    try {
      report = await run(
        {
          runId,
          cwd: dir,
          prompt: PROBE_PROMPT,
          // 探针不用 fleet 命令：不给后端地址、不签通行证
          env: { base: deps.baseEnv ?? process.env, fleetApi: '', fleetToken: '' },
          limits: { ...PROBE_LIMITS, ...deps.limits },
          cgroup: {
            id: runId,
            user,
            limits: { ...PROBE_SCOPE_LIMITS },
            ...(deps.helper ? { helper: deps.helper } : {}),
            ...(deps.sudo ? { sudo: deps.sudo } : {}),
          },
          model: t.upstreamModel ?? t.modelId,
          session: { mode: 'new', id: randomUUID() },
          permissionMode: 'dontAsk',
          persistSession: false,
        },
        {
          command: deps.claudeCommand(user),
          ...(deps.onRateLimit ? { onRateLimit: (reading) => deps.onRateLimit?.(t, reading) } : {}),
        },
      );
    } catch (err) {
      return { kind: 'failed', detail: `起会话之前就被拦下了：${message(err)}` };
    }
    return probeVerdict(report, t, { machine: deps.machine, user, now: deps.now() });
  };
}

/**
 * 要人修的整池问题：写 pool-hold:<池> 那条「要人拍」（和会话同一条，选路整池避开）；探通了（含额度用满被拒）撤掉它。
 * 别的没探通（网络、超时、认不出）不动它：那不说明人修没修好。
 */
export async function poolHoldAfterProbe(db: Db, t: ProbeTarget, a: ProbeAttempt): Promise<void> {
  const dedupeKey = poolHoldKey(t.poolId);
  if (a.kind === 'failed') {
    if (!a.poolHold) return;
    await upsertAlert(db, {
      dedupeKey,
      level: 'decision',
      taskId: null,
      title: `账号池 ${t.poolId} 整池暂停：${a.poolHold.title}`,
      body: `路由探针探 ${t.routeId} 时发现的。${a.poolHold.body}`,
    });
    return;
  }
  await resolveAlertByKey(db, { dedupeKey, by: 'engine' });
}

export interface RouteProbeWiring {
  db: Db;
  trees: WorkTrees;
  claudeCommand(user: SessionUser): string[];
  machine: string;
  now?: () => Date;
  log?: RouteProbeJobDeps['log'];
  /** 以下测试用。 */
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  run?: ClaudeProberDeps['run'];
  helper?: string;
  sudo?: readonly string[];
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** 给 EngineJobs.routeProbe 用的工厂。 */
export function routeProbeJob(w: RouteProbeWiring): () => RouteProbeJobDeps {
  const now = w.now ?? (() => new Date());
  const log: RouteProbeJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const claude = claudeCodeProber({
    trees: w.trees,
    claudeCommand: w.claudeCommand,
    machine: w.machine,
    now,
    onRateLimit: (t, reading) => {
      const windows = readingsFromRateLimit(reading, { poolId: t.poolId });
      if (!windows?.length) return;
      // 顺带读到的只是几个窗口：complete=false，不标别的窗口过期、不算一次读成（和会话一样）。
      void savePoolQuota(w.db, {
        poolId: t.poolId,
        readAt: reading.observedAt,
        complete: false,
        windows,
      }).catch((err: unknown) =>
        log('warn', '路由探针读到的额度没记上', { poolId: t.poolId, error: message(err) }),
      );
    },
    ...(w.run ? { run: w.run } : {}),
    ...(w.helper ? { helper: w.helper } : {}),
    ...(w.sudo ? { sudo: w.sudo } : {}),
    ...(w.baseEnv ? { baseEnv: w.baseEnv } : {}),
  });
  return () => ({
    targets: () => routeProbeTargets(w.db),
    probers: { 'claude-code': claude },
    liveOrg: SESSION_USER_ORG,
    save: (x) => saveRouteProbe(w.db, x),
    afterProbe: (t, a) => poolHoldAfterProbe(w.db, t, a),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    sleep: w.sleep ?? ((ms) => sleep(ms).then(() => undefined)),
    log,
    ...(w.retryDelayMs === undefined ? {} : { retryDelayMs: w.retryDelayMs }),
  });
}
