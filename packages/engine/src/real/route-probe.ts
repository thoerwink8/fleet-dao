// 路由探针的真装配（#129，design 第九节「路由探针」）：路由从库里读（routeProbeTargets）、结论写回库（saveRouteProbe）、
// 结局记进 schedule_runs。
// 探法按执行方式分派给和干活的会话同一个驱动（real/hosts.ts）：以会话用户的身份，经 fleet-agent-scope 在自己的 scope 里
// 起一次极小的无头会话，问一句「只回 OK」——同一个插头、同一份执行体、同一个模型串（路由上写的），所以探通了就说明会话
// 起得来、答得上；判法也是同一套（judgeRun + 失败分流的规则表）。什么命令都不许跑（Claude 用 dontAsk，cursor 不带 --force），
// Claude 还不存会话记录（每 15 分钟一次，不往会话用户家里攒；cursor 没有这个开关）。
// 要人修的整池问题（登录失效、设备被撤销、封号、欠费）和会话同一个做法：写 pool-hold:<池> 那条「要人拍」，选路整池避开；
// 探通了就撤掉它。探的时候顺带读到的额度也记账（和会话一样 complete=false）。

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  judgeRun,
  type LedgerFs,
  type MirasimConnect,
  type RateLimitReading,
  type SessionUser,
  type SwitchSessionOrgResult,
} from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import {
  type Db,
  finishScheduleRun,
  resolveAlertByKey,
  routeProbeTargets,
  savePoolQuota,
  saveRouteProbe,
  sessionOrgFacts,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { type HostId, type OrgKind, probeBackoffNotice } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { classifyFailure } from '../failure/classify.ts';
import type { OrgSwitchRound } from '../jobs/org-switch.ts';
import type { ProbeAttempt, Prober, ProbeTarget, RouteProbeJobDeps } from '../jobs/route-probe.ts';
import { ORG_NAMES } from '../routing/names.ts';
import {
  type HostDriver,
  type HostReport,
  type HostRunners,
  hostDrivers,
  sessionUserOf,
  WIRED_HOSTS,
} from './hosts.ts';
import { loadHeldPools } from './pool-holds.ts';
import type { SessionOrgControl, SessionOrgReader } from './session-org.ts';
import { poolHoldKey } from './store-ports.ts';
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
/** 探针会话只起一个执行体，用不了干活会话那么多内存。 */
export const PROBE_SCOPE_LIMITS = { memoryHigh: '1024M', memoryMax: '1536M', memorySwapMax: '0' } as const;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** reclaude 没有有效登录时 stderr 里的那一句（之后它开始设备授权、一直等，直到起不来被强杀）。 */
const RECLAUDE_NO_LOGIN = /^.*no valid login detected.*$/im;
/**
 * 原文进库、上驾驶舱之前去掉网址的查询串：reclaude 设备授权的链接带着一次性的 state，
 * 别人点开批准就能替这台机器登录，不该落进库里。
 */
const withoutQueries = (text: string) => text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?…');

/** 探针会话的工作目录。 */
export function probeDir(root: string, user: SessionUser): string {
  return `${root}/${PROBE_DIR}/${user}`;
}

export interface ProbeContext {
  machine: string;
  user: SessionUser;
  now: Date;
  /** 这种执行方式登录失效时人该怎么修（规则表里通用的登录失效 AU2 没写修法）。 */
  loginFix: string;
}

/**
 * 探通的回答：去掉首尾空白后整句就是 OK（不分大小写）。只要「含 OK」会把「Not OK」「OK, but…」这类回答也当成探通。
 */
const PROBE_ANSWER = /^ok$/i;

/** 响应原文：回答、插头收下的报错、stderr 里还没被前两段盖住的部分。一段都没有就是没拿到。 */
function responseTextOf(report: HostReport): string | null {
  const parts = [report.answer, report.rawError, report.stderrTail].flatMap((part) => {
    const trimmed = part?.trim();
    return trimmed ? [trimmed] : [];
  });
  const kept = parts.filter(
    (part, i) => !parts.some((other, j) => j !== i && other.length > part.length && other.includes(part)),
  );
  return kept.length > 0 ? kept.join('\n') : null;
}

/** 有报告才算真探过：耗时照插头量的（含 0），请求就是问出去的那一句，响应是原文。 */
function probeCapture(report: HostReport): {
  durationMs: number;
  requestText: string;
  responseText: string | null;
} {
  return {
    durationMs: report.wallMs,
    requestText: PROBE_PROMPT,
    responseText: responseTextOf(report),
  };
}

/**
 * 一次探针会话的报告（各家整理成的同一个形状）→ 结论。答上了、整句只回 OK 才算通；额度用满被拒算通（quota）；其余按
 * 失败分流的同一张规则表认出是什么事（登录失效、设备被撤销……），要人修的整池问题带上 poolHold。
 */
export function probeVerdict(report: HostReport, t: ProbeTarget, ctx: ProbeContext): ProbeAttempt {
  const verdict = judgeRun(report.facts);
  const text = (report.answer ?? '').trim();
  const captured = probeCapture(report);
  if (verdict.outcome === 'ok') {
    if (!PROBE_ANSWER.test(text)) {
      return {
        kind: 'failed',
        detail: `回答认不出（要的是只回 OK）：${text ? clip(withoutQueries(text), 80) : '回答是空的'}`,
        ...captured,
      };
    }
    const secs = Math.max(1, Math.round(report.wallMs / 1000));
    const cost = report.sessionCostUsd;
    return {
      kind: 'answered',
      detail: `答上了：${clip(text, 40)} · 用时 ${secs} 秒${cost === undefined ? '' : ` · 按 API 价折合 $${cost.toFixed(3)}`}`,
      ...captured,
    };
  }
  // 执行体最后说的话；reclaude 没登录的那一句在整段 stderr 里找（它后面还会打几行，可能挤出最后三行）。
  const lastWords = report.facts.lastWords;
  const loginLine = report.stderrTail.match(RECLAUDE_NO_LOGIN)?.[0]?.trim();
  const said = [lastWords, loginLine && !lastWords?.includes(loginLine) ? loginLine : undefined]
    .filter(Boolean)
    .join(' ⏎ ');
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
      ...(report.httpStatus === undefined ? {} : { httpStatus: report.httpStatus }),
      exitCode: report.facts.exitCode ?? null,
      signal: report.facts.signal ?? null,
      ...(report.resetsAt ? { resetsAt: report.resetsAt } : {}),
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
        `额度用满被拒（登录、组织、上游都通，派不派按额度等清零）：${verdict.detail}${report.resetsAt ? ` · ${report.resetsAt} 清零` : ''}${said && !verdict.detail.includes(said) ? `（原文：${clip(said, 200)}）` : ''}`,
      ),
      ...captured,
    };
  }
  const what = !cls || cls.via === 'fallback' ? verdict.detail : `${cls.title}：${verdict.detail}`;
  const words = said && !what.includes(said) ? `（原文：${clip(said, 200)}）` : '';
  // 规则表里登录失效（AU2）没写修法（它管各家的登录）；探的是哪一家、修法就是确定的，由驱动给
  const fix =
    cls?.humanFix ?? (cls?.rule === 'AU2' ? `${ctx.loginFix}；下一轮探针探通就转回在线` : undefined);
  const detail = withoutQueries([`${what}${words}`, fix].filter(Boolean).join('。'));
  const hold = cls?.shared?.scope === 'pool' && cls.shared.until === undefined;
  return {
    kind: 'failed',
    detail,
    ...(hold && cls
      ? { poolHold: { title: cls.title, body: withoutQueries([fix, cls.reason].filter(Boolean).join('。')) } }
      : {}),
    ...captured,
  };
}

export interface ProberDeps {
  trees: Pick<WorkTrees, 'root' | 'ownerOf' | 'adopt'>;
  machine: string;
  now: () => Date;
  /** 探的时候读到的额度读数（真实现记进 quota_windows）。 */
  onRateLimit?: (target: ProbeTarget, reading: RateLimitReading) => void;
  /** 以下测试用。 */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  helper?: string;
  sudo?: readonly string[];
  limits?: Partial<typeof PROBE_LIMITS>;
}

/**
 * 一种执行方式的探法：以会话用户起一次极小的无头会话，模型照路由上写的，问一句 OK。不抛：会话用户没定、工作目录交不出去、
 * 起不来、超时、认不出，都写成没探通的原因。
 */
export function sessionProber(driver: HostDriver, deps: ProberDeps): Prober {
  return async (t) => {
    const who = sessionUserOf(driver, t.runAsUser);
    if ('missing' in who) {
      return { kind: 'failed', detail: `账号池 ${t.poolId} ${who.missing}，起不了会话` };
    }
    const { user } = who;
    const dir = probeDir(deps.trees.root, user);
    try {
      if ((await deps.trees.ownerOf(dir)) !== user) await deps.trees.adopt(dir, user);
    } catch (err) {
      return { kind: 'failed', detail: `探针的工作目录 ${dir} 没交给 ${user}：${errMessage(err)}` };
    }
    const runId = `probe-${randomUUID()}`;
    let report: HostReport;
    try {
      report = await driver.run(
        {
          runId,
          user,
          cwd: dir,
          prompt: PROBE_PROMPT,
          // 探针不用 fleet 命令：不给后端地址、不签通行证
          env: { base: deps.baseEnv ?? process.env, fleetApi: '', fleetToken: '' },
          limits: { ...PROBE_LIMITS, ...deps.limits },
          testCommands: [],
          cgroup: {
            id: runId,
            user,
            limits: { ...PROBE_SCOPE_LIMITS },
            ...(deps.helper ? { helper: deps.helper } : {}),
            ...(deps.sudo ? { sudo: deps.sudo } : {}),
          },
          model: t.upstreamModel ?? t.modelId,
          ...(t.executor ? { executor: t.executor } : {}),
          session: { mode: 'new', id: driver.newSessionId(runId).id },
          purpose: 'probe',
        },
        deps.onRateLimit ? { onRateLimit: (reading) => deps.onRateLimit?.(t, reading) } : {},
      );
    } catch (err) {
      return { kind: 'failed', detail: `起会话之前就被拦下了：${errMessage(err)}` };
    }
    return probeVerdict(report, t, {
      machine: deps.machine,
      user,
      now: deps.now(),
      loginFix: driver.loginFix(deps.machine, user),
    });
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
    const notice = probeBackoffNotice(a.detail);
    await upsertAlert(db, {
      dedupeKey,
      level: 'decision',
      taskId: null,
      title: `账号池 ${t.poolId} 整池暂停：${a.poolHold.title}`,
      body: `路由探针探 ${t.routeId} 时发现的。${a.poolHold.body}${notice ? `。${notice}` : ''}`,
    });
    return;
  }
  await resolveAlertByKey(db, { dedupeKey, by: 'engine' });
}

/**
 * 全部路由，被人拍了整池暂停（开关 engine.poolHolds）的池打上 heldBySwitch，探针不探它们。开关认不出的池（整份或那一项）也按暂停办，
 * 原因写「设置认不出」。库读不了照抛（这一轮记没跑成）。
 */
export async function probeTargetsWithHolds(db: Db, now: Date): Promise<ProbeTarget[]> {
  const [targets, held] = await Promise.all([routeProbeTargets(db), loadHeldPools(db, now)]);
  const reasons = new Map(held.facts.holds.map((h) => [h.poolId, h.reason]));
  return targets.map((t) =>
    held.switched.has(t.poolId)
      ? { ...t, heldBySwitch: reasons.get(t.poolId) ?? '暂停设置认不出，按暂停办' }
      : t,
  );
}

export interface RouteProbeWiring {
  db: Db;
  trees: WorkTrees;
  /** 起执行体的命令（绝对路径），和干活的会话同一份：reclaude、cursor-agent、grok 都装在会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  cursorCommand(user: SessionUser): string[];
  grokCommand(user: SessionUser): string[];
  /** 会话用户自己的 Mirasim 服务：连接工厂、账本目录、读账本用的文件访问（real/index.ts 的 mirasimDepsFor 生产装配）。 */
  mirasimConnect(user: SessionUser): MirasimConnect;
  mirasimLedgerDir(user: SessionUser): string;
  mirasimLedgerFs(user: SessionUser): LedgerFs;
  /**
   * 会话用户此刻挂的组织（real/session-org.ts）：和选路、切号共用一个，Claude 订阅池只探挂着的那个；这会儿定不下来就这一轮
   * 不探 Claude 池。
   */
  sessionOrg: SessionOrgReader;
  /** 会话用户切号（real/org-switch.ts，#157）：每一轮探之前判、该切就切。不给就不切。 */
  orgSwitch?: OrgSwitchRound;
  /**
   * 补发最小请求时，会话用户没挂着那个组织就经现有的切号切过去、发完切回。
   * 不给：组织对不上就不发（现有探法扣的是此刻挂着的组织，读数也会写进被探的那个池）。
   */
  kickOrg?: {
    control: SessionOrgControl;
    switchTo(to: OrgKind): Promise<SwitchSessionOrgResult>;
  };
  machine: string;
  /** 会话出网经的代理（FLEET_SESSION_PROXY）：和干活的会话同一份，cursor-agent、grok 的探针带上（hosts.ts）。不给就直连。 */
  sessionProxy?: string;
  now?: () => Date;
  log?: RouteProbeJobDeps['log'];
  /** 以下测试用。 */
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  run?: HostRunners;
  helper?: string;
  sudo?: readonly string[];
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** 读到窗口已重置的组织（quota-read 写进库的，和切号同一个 sessionOrgFacts）。一个组织一行。 */
async function resetOrgKinds(db: Db, now: Date): Promise<OrgKind[]> {
  const facts = await sessionOrgFacts(db, { now });
  const orgs: OrgKind[] = [];
  for (const pool of facts.pools) {
    if (pool.windows.some((window) => window.state === 'reset') && !orgs.includes(pool.orgKind)) {
      orgs.push(pool.orgKind);
    }
  }
  return orgs;
}

/**
 * 让补发的那一次扣到这个组织上。已经挂着就直接发。没挂着、又没有在跑的 Claude 会话：切过去、发、切回。
 * 读不到组织、有会话在跑、切不成：不发。有会话在跑时不切——切号会把这个家目录下的 Claude 会话全断。
 */
async function placeWindowKick(
  w: Pick<RouteProbeWiring, 'db' | 'sessionOrg' | 'kickOrg'> & {
    now: () => Date;
    log: RouteProbeJobDeps['log'];
  },
  org: OrgKind,
  send: () => Promise<void>,
): Promise<boolean> {
  w.kickOrg?.control.forget();
  const live = await w.sessionOrg({ by: '路由探针起窗' });
  if (!live.ok) {
    w.log('warn', '路由探针：窗口已重置，会话用户挂的组织读不到，不补发', { org, why: live.why });
    return false;
  }
  const facts = await sessionOrgFacts(w.db, { now: w.now() });
  if (facts.busy > 0) {
    w.log('info', '路由探针：窗口已重置，有会话在跑，不补发', { org, busy: facts.busy });
    return false;
  }
  if (live.org === org) {
    await send();
    return true;
  }
  const kick = w.kickOrg;
  if (!kick) {
    w.log('info', '路由探针：窗口已重置，会话用户没挂着这个组织，不补发', { org, live: live.org });
    return false;
  }
  const from = live.org;
  const release = kick.control.hold(
    `路由探针补发：把会话用户切到${ORG_NAMES[org]}组织发一次最小请求，发完切回`,
  );
  try {
    const there = await kick.switchTo(org);
    await kick.control.engineSwitched();
    if (!there.ok) {
      w.log('warn', '路由探针：窗口已重置，切到这个组织没成，不补发', { org, detail: there.detail });
      return false;
    }
    try {
      await send();
      return true;
    } finally {
      const back = await kick.switchTo(from);
      await kick.control.engineSwitched();
      if (!back.ok) {
        w.log('error', '路由探针：补发之后没切回原来的组织', { org, back: from, detail: back.detail });
      }
    }
  } finally {
    release();
  }
}

/** 给 EngineJobs.routeProbe 用的工厂。 */
export function routeProbeJob(w: RouteProbeWiring): () => RouteProbeJobDeps {
  const now = w.now ?? (() => new Date());
  const log: RouteProbeJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const drivers = hostDrivers({
    claudeCommand: w.claudeCommand,
    cursorCommand: w.cursorCommand,
    grokCommand: w.grokCommand,
    mirasimConnect: w.mirasimConnect,
    mirasimLedgerDir: w.mirasimLedgerDir,
    mirasimLedgerFs: w.mirasimLedgerFs,
    sessionProxy: w.sessionProxy,
    ...(w.run ? { run: w.run } : {}),
  });
  const deps: ProberDeps = {
    trees: w.trees,
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
        log('warn', '路由探针读到的额度没记上', { poolId: t.poolId, error: errMessage(err) }),
      );
    },
    ...(w.helper ? { helper: w.helper } : {}),
    ...(w.sudo ? { sudo: w.sudo } : {}),
    ...(w.baseEnv ? { baseEnv: w.baseEnv } : {}),
  };
  // 接上的执行方式各一个探法（和干活的会话同一个驱动）；没接上的由 planProbe 记 not_wired。
  const probers: Partial<Record<HostId, Prober>> = Object.fromEntries(
    WIRED_HOSTS.map((host) => [host, sessionProber(drivers[host], deps)]),
  );
  return () => ({
    targets: () => probeTargetsWithHolds(w.db, now()),
    probers,
    // 和选路、切号同一个读法、同一个起点：谁读到的写进前后两次读数里
    sessionOrg: () => w.sessionOrg({ by: '路由探针' }),
    ...(w.orgSwitch ? { orgSwitch: w.orgSwitch } : {}),
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
    resetOrgs: () => resetOrgKinds(w.db, now()),
    aroundKick: (org, send) => placeWindowKick({ ...w, now, log }, org, send),
  });
}
