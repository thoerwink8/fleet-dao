// 会话用户此刻挂的 reclaude 组织（design 第九节「一个会话用户，同一时刻只挂一个组织」）。选路（store-ports 的 pickRoute，
// 每小时对账也借它判）、路由探针、切号（real/org-switch.ts）都经这里的同一个读法（real/index.ts 只装一个），按同一个起点判：
// 谁读到的都一个口径（#335）。
// 读法（specs/157-拼车自动切换/需求.md）：以会话用户的身份（经 fleet-agent-scope，exec.ts：引擎进不去它的家）跑它家里的
// reclaude org list——带 * 的是现在挂的，类型那一列 team 是拼车、personal 是独享。解析和判法跟额度读取器、切号帮手同一个
// （adapters 的 parseOrgList、currentOrgOf），只留类型：组织编号、名字、邮箱一概不往外带，编号不进仓、也不用配文件。
// 读不到（没跑成、登录失效、封号）、认不出（一个组织都没有、没有带 * 的行、带 * 的不止一行、类型认不出）：一律明确失败
// （ok: false，带白话原因，原因里不带编号、邮箱：它会进库、上驾驶舱），调用方按「会话用户挂的组织认不出」处理——带组织类型的
// 池一律不派、不探，不拿拼车顶。
// 起点（#335）：认下来的那个组织。读成的和它不一样、中间又没有引擎切过号（engineSwitched），不悄悄照新的来：回 pending
// （「这会儿定不下来」：选路过一会儿再选、探针这一轮不探 Claude 池、切号这一轮不判），报一次 drift（带前后两次读数，真装配推
// session-org:drift 提醒、记操作记录）；读数回到起点就照常（settled back），连着 SESSION_ORG_SETTLE_MS 都是新的才认它当起点
// （settled accepted）。引擎自己切的号不算：切完读成的第一次就是新起点。09-27 21:54 那次就是帅位在法国手动切过去又切回来，
// 选路在中间读到独享、照它挡掉了拼车，任务挂起等人。
// 读成了的留很短一会儿（SESSION_ORG_TTL_MS），同时来的几次共用一次读。reclaude 更新后首跑会先「Syncing config…」上百秒：一次
// 读最多等 SESSION_ORG_TIMEOUT_MS；选路只等 waitMs，没读完回 pending（选路按「过一会儿再选」处理），读在后台接着跑完、留下结果。

import { randomUUID } from 'node:crypto';
import { redact, type SessionUser, sessionProxyEnv } from '@fleet-dao/adapters';
import { currentOrgOf, parseOrgList } from '@fleet-dao/adapters/quota';
import type { OrgKind } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type LiveOrgReading, ORG_NAMES } from '../routing/index.ts';
import type { UserCommandResult, UserExec } from './exec.ts';

/** 读成了的留多久：选路的几次调用、探针一轮里的几条路由共用一次读。读失败的不留，下一次照读。 */
export const SESSION_ORG_TTL_MS = 30_000;
/** 一次读最多等多久：平时 0.3 秒；reclaude 更新后首跑先同步配置，上百秒（和路由探针起会话给的一样长，real/route-probe.ts）。 */
export const SESSION_ORG_TIMEOUT_MS = 150_000;
/**
 * 读成的和起点不一样、又没有引擎切过号：连着这么久读到的都是新的才认它。人手动切了留着，引擎最多晚这么久照新的来；切过去又
 * 切回来不到这么久（09-27 21:53–21:55 那种），就一直当没定下来，回到起点照常，活不派到临时挂上的那个组织。
 */
export const SESSION_ORG_SETTLE_MS = 120_000;

const LIST = 'reclaude org list';
/** 起在重读之前（切号、切号前的现读把它作废了）的那次读回来时，给等它的人的原因。 */
export const STALE_READ_WHY = `这次 ${LIST} 起在引擎重读（切号前后）之前，读数不算、也不留，过一会儿再读`;

/** reclaude 的报错原文进库之前：凭据、邮箱、IP 抹掉（redact），三位以上的数字也抹掉——组织编号就是这样的数。 */
function scrub(text: string): string {
  return redact(text, 200).replace(/\d{3,}/g, '<数>');
}

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「09-27 21:54:03」：前后两次读数常在同一分钟里，带上秒。 */
export function readingStamp(at: Date): string {
  const s = new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 19)}`;
}

/** 一次读成的：哪个组织、几点读完、谁读的（选路、路由探针、切号、每小时对账）。 */
export interface OrgSighting {
  org: OrgKind;
  at: Date;
  by: string;
}

/**
 * 起点的变动（真装配里推提醒、记操作记录：real/org-switch.ts 的 orgDriftReporter）。
 * drift：读成的和起点不一样、引擎没切过号——from 是最近一次读到起点那个组织的，to 是第一次读到新组织的（前后两次读数）。
 * settled：定下来了——back 读数回到了起点；accepted 连着 SESSION_ORG_SETTLE_MS 都是新的，认它当起点；engine 引擎切了号，
 * 以切完读成的为准。last 是定下来的那一次读（引擎切号那种没有）。
 */
export type SessionOrgEvent =
  | { kind: 'drift'; from: OrgSighting; to: OrgSighting }
  | {
      kind: 'settled';
      how: 'back' | 'accepted' | 'engine';
      from: OrgSighting;
      to: OrgSighting;
      last: OrgSighting | null;
    };

export interface SessionOrgDeps {
  exec: UserExec;
  user: SessionUser;
  /** 起 reclaude 的命令（绝对路径）：和会话、探针同一份，装在会话用户自己家里（real/index.ts 的 claudeCommand）。 */
  reclaude: string[];
  /**
   * 出网经的代理（FLEET_SESSION_PROXY，规范成 http://主机:端口；本机档经 Windows 上的 Clash，法国直连不给）：org list 要连
   * reclaude 的服务端，WSL 里直连时通时不通（context deadline exceeded，读不到组织、Claude 池整轮不探，#786 同一个根）。
   * 给了就写成 /usr/bin/env 的参数；认不出的代理在这里就抛（parseSessionProxy），不悄悄改成直连。
   */
  proxy?: string | undefined;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
  settleMs?: number;
  /** 起点的变动交给谁（真装配推 session-org:drift、记操作记录）。抛了只记错误日志，读数照样按判出来的给。 */
  onEvent?: (event: SessionOrgEvent) => Promise<void> | void;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 读一次（不留、不按起点判）。没读成一律 ok: false（带原因），不抛。 */
export async function readSessionOrg(deps: SessionOrgDeps): Promise<LiveOrgReading> {
  const what = `以会话用户 ${deps.user} 跑 ${LIST}`;
  const timeoutMs = deps.timeoutMs ?? SESSION_ORG_TIMEOUT_MS;
  let r: UserCommandResult;
  try {
    // 代理认不出（parseSessionProxy 抛）就当没跑成：不悄悄改成直连（直连正是读不到的原因）
    const viaProxy = deps.proxy
      ? ['/usr/bin/env', ...Object.entries(sessionProxyEnv(deps.proxy)).map(([k, v]) => `${k}=${v}`)]
      : [];
    r = await deps.exec({
      user: deps.user,
      cwd: '/',
      argv: [...viaProxy, ...deps.reclaude, 'org', 'list'],
      timeoutMs,
      scopeId: `session-org-${randomUUID().slice(0, 8)}`,
    });
  } catch (err) {
    return { ok: false, why: `${what}没跑成：${scrub(errMessage(err))}` };
  }
  if (r.spawnError) return { ok: false, why: `${what}：没起来（${scrub(r.spawnError)}）` };
  if (r.timedOut) return { ok: false, why: `${what}：${Math.round(timeoutMs / 1000)} 秒没回，超时被停` };
  if (r.aborted) return { ok: false, why: `${what}：被叫停` };
  const stdout = r.stdout.toString('utf8');
  if (r.code !== 0) {
    const text = `${r.stderr}\n${stdout}`;
    if (/not logged in|no valid login|device_revoked|unauthori[sz]ed|\b401\b|login required/i.test(text)) {
      return {
        ok: false,
        why: `${what}：reclaude 报登录失效，要在法国上以会话用户重跑 reclaude login（docs/ops.md 第五节）`,
      };
    }
    if (/account_banned|暂不可用|\b403\b/i.test(text)) {
      return { ok: false, why: `${what}：reclaude 报账号不可用（上游封号或组织失效）` };
    }
    const tail = scrub(r.stderr);
    return { ok: false, why: `${what}：退出码 ${r.code ?? '空'}${tail ? `（${tail}）` : ''}` };
  }
  const current = currentOrgOf(parseOrgList(stdout));
  if (!current.ok) return { ok: false, why: `${what}：${current.why}` };
  return { ok: true, org: current.kind };
}

/**
 * 读会话用户此刻挂的组织，按起点判过。waitMs：最多等这么久，没读完回 pending（读在后台接着跑完、留下结果，下一次就用上）；
 * 不给就等到读完（最多 SESSION_ORG_TIMEOUT_MS）。by：谁在读（写进前后两次读数里）。
 */
export type SessionOrgReader = (options?: { waitMs?: number; by?: string }) => Promise<LiveOrgReading>;

/**
 * 读法加三样只给切号（real/org-switch.ts）用的：hold 让之后的读都回 pending（选路过一会儿再选，切号那几秒不派新会话），
 * 交回解除的函数，解除时连留着的读数一起丢掉；forget 丢掉留着的读数，下一次现读（起点不动）；engineSwitched 引擎刚经帮手切过号
 * （成没成都算），切完读成的第一次就是新起点，不算没记录的变动。切号前起的读晚于这些才回来，读数不算、也不留。
 */
export type SessionOrgControl = SessionOrgReader & {
  hold(why: string): () => void;
  forget(): void;
  engineSwitched(): Promise<void>;
};

function driftWhy(d: { from: OrgSighting; to: OrgSighting }, last: OrgSighting, settleMs: number): string {
  const from = ORG_NAMES[d.from.org];
  const to = ORG_NAMES[d.to.org];
  const again =
    last.at.getTime() > d.to.at.getTime() ? `，${readingStamp(last.at)} ${last.by}再读还是${to}` : '';
  return (
    `会话用户挂的组织和上一次读的不一样，引擎没切过号：${readingStamp(d.from.at)} ${d.from.by}读到${from}，` +
    `${readingStamp(d.to.at)} ${d.to.by}读到${to}${again}（北京时间）。等读数定下来再照它：连着 ` +
    `${Math.round(settleMs / 60_000)} 分钟都是${to}才认，回到${from}就照常`
  );
}

/**
 * 选路、探针、切号、每小时对账共用的读法：读成了的留 ttlMs（默认 30 秒），读失败的不留；同时来的几次共用一次读。
 * 每次读成都按起点判一次（上面文件头）。不抛。
 */
export function sessionOrgReader(deps: SessionOrgDeps): SessionOrgControl {
  const clock = deps.now ?? (() => new Date());
  const ttl = deps.ttlMs ?? SESSION_ORG_TTL_MS;
  const settleMs = deps.settleMs ?? SESSION_ORG_SETTLE_MS;
  const log = deps.log ?? ((level, text, fields) => console[level](text, fields ?? {}));
  let kept: { at: number; value: LiveOrgReading } | null = null;
  let reading: Promise<LiveOrgReading> | null = null;
  let held: string | null = null;
  let holder: object | null = null;
  // forget 一次加一：起读时记下来，回来时对不上（这中间重读过、切过号）就不按它判、不留
  let generation = 0;
  // 起点：认下来的那个组织（最近一次读到它的那一次）；null = 还没读成过，或引擎刚切过号（下一次读成的就是起点）
  let baseline: OrgSighting | null = null;
  // 读成的和起点不一样、还没定下来：从哪次（最近一次读到起点的）变到哪次（第一次读到新组织的）
  let drift: { from: OrgSighting; to: OrgSighting } | null = null;

  const report = async (events: readonly SessionOrgEvent[]) => {
    for (const event of events) {
      try {
        await deps.onEvent?.(event);
      } catch (err) {
        log('error', '会话用户挂的组织：起点变动没记下（提醒、操作记录没写进库），读数照样按判出来的给', {
          event: event.kind,
          error: errMessage(err),
        });
      }
    }
  };

  /** 这一代读成的一次读数按起点判：改起点、记变动。一次读只判一次。 */
  const judge = (raw: LiveOrgReading, by: string, events: SessionOrgEvent[]): LiveOrgReading => {
    if (!raw.ok) return raw;
    const seen: OrgSighting = { org: raw.org, at: clock(), by };
    if (baseline === null) {
      baseline = seen;
      return raw;
    }
    if (seen.org === baseline.org) {
      if (drift) events.push({ kind: 'settled', how: 'back', from: drift.from, to: drift.to, last: seen });
      baseline = seen;
      drift = null;
      return raw;
    }
    if (!drift) {
      drift = { from: baseline, to: seen };
      events.push({ kind: 'drift', from: baseline, to: seen });
    }
    if (seen.at.getTime() - drift.to.at.getTime() >= settleMs) {
      events.push({ kind: 'settled', how: 'accepted', from: drift.from, to: drift.to, last: seen });
      baseline = seen;
      drift = null;
      return raw;
    }
    return { ok: false, pending: true, why: driftWhy(drift, seen, settleMs) };
  };

  const start = (by: string): Promise<LiveOrgReading> => {
    if (!reading) {
      const gen = generation;
      const current: Promise<LiveOrgReading> = readSessionOrg(deps)
        .catch(
          (err: unknown): LiveOrgReading => ({
            ok: false,
            why: `读会话用户挂的组织出错：${errMessage(err)}`,
          }),
        )
        .then(async (raw): Promise<LiveOrgReading> => {
          if (reading === current) reading = null;
          // 起在重读之前：读数不算（可能是切号前的组织），也不留、不当起点；读失败的原样给（本来就不算数）
          if (gen !== generation) return raw.ok ? { ok: false, pending: true, why: STALE_READ_WHY } : raw;
          const events: SessionOrgEvent[] = [];
          const value = judge(raw, by, events);
          kept = raw.ok ? { at: clock().getTime(), value } : null;
          await report(events);
          return value;
        });
      reading = current;
    }
    return reading;
  };
  const forget = () => {
    generation += 1;
    kept = null;
    reading = null;
  };
  const read: SessionOrgReader = async (options = {}) => {
    if (held !== null) return { ok: false, pending: true, why: held };
    const now = clock().getTime();
    if (kept && now >= kept.at && now - kept.at < ttl) return kept.value;
    const pending = start(options.by?.trim() || '引擎');
    const waitMs = options.waitMs;
    if (waitMs === undefined) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<LiveOrgReading>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            pending: true,
            why: `以会话用户跑 ${LIST} 过了 ${Math.round(waitMs / 1000)} 秒还没回（reclaude 更新后首跑先同步配置，要上百秒），读在后台接着跑，读完下一次就用上`,
          }),
        waitMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([pending, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.assign(read, {
    hold(why: string) {
      const token = {};
      holder = token;
      held = why;
      return () => {
        // 只解自己上的那一道（解过了、后来又有人上了，都不动）
        if (holder !== token) return;
        holder = null;
        held = null;
        forget();
      };
    },
    forget,
    async engineSwitched() {
      const was = drift;
      baseline = null;
      drift = null;
      forget();
      if (was) await report([{ kind: 'settled', how: 'engine', from: was.from, to: was.to, last: null }]);
    },
  });
}
