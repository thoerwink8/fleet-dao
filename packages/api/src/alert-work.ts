// 提醒是一件活（design 15.3「谁在处理」）的外壳：从库里读一批提醒的跟进单、挂钩的 PR、静默，从法国的发布记录读在用的
// 版本，拼成 @fleet-dao/core 的 AlertWorkFacts，交给 core 的 alertHandling 现算「在处理、修到哪」。驾驶舱提醒列表都经这里读，
// 判法只 core 那一份；`fleet-api alert show` 只读跟进单、PR、静默，不再显示这份「谁在处理」（#445）。
// 改这里之前必须知道：
// - 读不到就抛（连不上库、语句出错），调用方写明「没查成」，不当成「没人在修」。
// - 发布记录只在法国上有（readDeployLagInput 读 current 链接和自动发布的状态文件）；别处给 null，core 写明「这里查不了发布」。
// - 认领账（issue_claims）2026-10-03 起整张删掉（#556，创始人回「选 1」）：这里不再读它，也没有 toIssueClaim 了。
import {
  type AlertHandling,
  type AlertLevel,
  type AlertSilence,
  type AlertWorkFacts,
  alertHandling,
  alertStageText,
  type DeployFacts,
  type FixPr,
  type WorkIssue,
} from '@fleet-dao/core';
import {
  type AlertRow,
  type AlertSilenceRow,
  type AlertWorkRaw,
  type AuditWho,
  createSilence,
  type Db,
  expireSilence,
  findAlert,
  linkAlertWork,
  listSilences,
  readAlertWork,
  readDbNow,
} from '@fleet-dao/db';
import type { AlertHandlingSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { DeployLagInput } from './deploy-lag.ts';

const iso = (d: Date) => d.toISOString();
const isoOpt = (d: Date | null) => (d ? d.toISOString() : null);

export function toAlertSilence(r: AlertSilenceRow): AlertSilence {
  return {
    id: r.id,
    matchKind: r.matchKind,
    match: r.match,
    comment: r.comment,
    createdBy: r.createdBy,
    createdAt: iso(r.createdAt),
    endsAt: iso(r.endsAt),
    expiredAt: isoOpt(r.expiredAt),
    expiredBy: r.expiredBy,
  };
}

/** 库里读出来的一批行拼成每条提醒的事实（跟进单：另挂的优先，没有就是任务的那张；PR 两种挂法：正文写了它、正文挂了跟进单）。 */
export function toAlertWorkFacts(raw: AlertWorkRaw): AlertWorkFacts[] {
  const tasks = new Map(raw.tasks.map((t) => [t.id, t]));
  return raw.alerts.map((a) => {
    const linked = raw.work.find((w) => w.notificationId === a.id);
    const task = a.taskId ? tasks.get(a.taskId) : undefined;
    const work: WorkIssue | null = linked
      ? {
          repoId: linked.repoId,
          repo: `${linked.owner}/${linked.name}`,
          issueNumber: linked.issueNumber,
          source: linked.source,
          linkedBy: linked.linkedBy,
          linkedAt: iso(linked.linkedAt),
        }
      : task
        ? {
            repoId: task.repoId,
            repo: `${task.owner}/${task.name}`,
            issueNumber: task.issueNumber,
            source: 'task',
            linkedBy: null,
            linkedAt: null,
          }
        : null;
    const prs: FixPr[] = [];
    for (const p of raw.prs) {
      const via: ('alert' | 'issue')[] = [];
      if (p.alertRefs.includes(a.dedupeKey) || p.alertRefs.includes(a.id)) via.push('alert');
      if (work && p.repoId === work.repoId && p.issueRefs.includes(work.issueNumber)) via.push('issue');
      if (via.length === 0) continue;
      prs.push({
        repo: `${p.owner}/${p.name}`,
        number: p.number,
        state: p.state,
        openedAt: isoOpt(p.openedAt),
        mergedAt: isoOpt(p.mergedAt),
        mergeSha: p.mergeSha,
        updatedAt: iso(p.updatedAt),
        via,
      });
    }
    return {
      alert: {
        id: a.id,
        dedupeKey: a.dedupeKey,
        level: a.level as AlertLevel,
        taskId: a.taskId,
        title: a.title,
        body: a.body,
        link: a.link,
        createdAt: iso(a.createdAt),
        updatedAt: iso(a.updatedAt),
        resolvedAt: isoOpt(a.resolvedAt),
        resolvedBy: a.resolvedBy,
      },
      work,
      prs,
      silences: raw.silences.map(toAlertSilence),
    };
  });
}

/**
 * 法国的发布记录 → core 的 DeployFacts：在用的版本（current 链接）、主线最近的提交（自动发布的状态文件，新的在前）、
 * 状态文件这一轮的时刻；最近一次发布就是在用的这版而且成了，它结束的时刻就是切上去的时刻。读不到的照实带原因。
 */
export function deployFacts(input: DeployLagInput): DeployFacts {
  if ('error' in input.current) return { ok: false, why: input.current.error };
  if (input.current.sha === null) return { ok: false, why: '法国上还没发布过（没有 current 链接）' };
  if ('error' in input.state) return { ok: false, why: input.state.error };
  const { main, attempt, ranAt } = input.state;
  if (!main)
    return {
      ok: false,
      why: `自动发布这一轮没读到主线${input.state.mainError ? `：${input.state.mainError}` : ''}`,
    };
  const sha = input.current.sha;
  const deployedAt =
    attempt && attempt.sha === sha && attempt.result === 'ok' && attempt.endedAt ? attempt.endedAt : null;
  return { ok: true, currentSha: sha, commits: main.commits, checkedAt: ranAt, deployedAt };
}

/** 驾驶舱、fleet-api alert（只借来读静默）、每小时对账（谁在处理，判 24 小时要不要再推）读提醒处理状态的那一个口子（原来提醒派单也读，#445 删掉了）。 */
export interface AlertWorkPort {
  /** 这一批提醒（编号）的事实，按库的 now 读。读不到抛。 */
  read(ids: readonly string[]): Promise<{ now: string; facts: AlertWorkFacts[] }>;
  /** 此刻的发布记录；这台机器上没有（开发、测试）是 null。 */
  deploy(): Promise<DeployFacts | null>;
  /** 库的 now()（静默的到期按它算，不拿各机器的钟）。 */
  now(): Promise<string>;
  /** 按编号或键找一条提醒（处理没处理都给）；没有是 null。 */
  find(ref: string): Promise<AlertRow | null>;
  link(input: Parameters<typeof linkAlertWork>[1]): ReturnType<typeof linkAlertWork>;
  createSilence(input: Parameters<typeof createSilence>[1]): Promise<AlertSilence>;
  expireSilence(
    input: Parameters<typeof expireSilence>[1],
  ): Promise<{ result: 'expired' | 'ended'; silence: AlertSilence } | { result: 'not_found' }>;
  listSilences(input: { all: boolean }): Promise<{ now: string; silences: AlertSilence[] }>;
}

export function pgAlertWork(db: Db, deploy: () => DeployFacts | null): AlertWorkPort {
  return {
    async read(ids) {
      const raw = await readAlertWork(db, ids);
      return { now: iso(raw.now), facts: toAlertWorkFacts(raw) };
    },
    deploy: async () => deploy(),
    now: async () => iso(await readDbNow(db)),
    find: (ref) => findAlert(db, ref),
    link: (input) => linkAlertWork(db, input),
    async createSilence(input) {
      return toAlertSilence(await createSilence(db, input));
    },
    async expireSilence(input) {
      const r = await expireSilence(db, input);
      return r.result === 'not_found' ? r : { result: r.result, silence: toAlertSilence(r.row) };
    },
    async listSilences(input) {
      const r = await listSilences(db, input);
      return { now: iso(r.now), silences: r.silences.map(toAlertSilence) };
    },
  };
}

/** 引擎、帅位写操作记录时的「谁」：本机的记成 ai、<机器名>/<会话号>（和认领一样）。 */
export const seatAuditWho = (machine: string, session: string): AuditWho => ({
  actorKind: 'ai',
  actorId: `${machine}/${session}`,
  via: 'engine',
});

/**
 * core 里的仓是 owner/name（上面 toAlertWorkFacts 拿库里两列拼的，两段都不含 /）：拆回两段给驾驶舱。
 * 不发网址：链接由驾驶舱按品牌拼（正式版给 GitHub 外链，演示版不给，演示产物里出现 github.com 打包就拒）。
 */
const repoRef = (repo: string) => {
  const cut = repo.indexOf('/');
  return { owner: repo.slice(0, cut), name: repo.slice(cut + 1) };
};

/** 给驾驶舱的样子（@fleet-dao/shared 的 AlertHandlingSchema）。 */
export function handlingView(h: AlertHandling): z.input<typeof AlertHandlingSchema> {
  return {
    stage: h.stage,
    stageText: alertStageText(h.stage),
    since: h.since,
    ...(h.who ? { who: h.who } : {}),
    ...(h.work ? { work: { repo: repoRef(h.work.repo), issueNumber: h.work.issueNumber } } : {}),
    ...(h.pr ? { pr: { repo: repoRef(h.pr.repo), number: h.pr.number, state: h.pr.state } } : {}),
    ...(h.silence
      ? { silence: { by: h.silence.createdBy, comment: h.silence.comment, endsAt: h.silence.endsAt } }
      : {}),
    ...(h.deploy
      ? { deploy: { state: h.deploy.state, ...(h.deploy.state === 'unknown' ? { why: h.deploy.why } : {}) } }
      : {}),
    line: h.line,
    problems: h.problems,
  };
}

/**
 * 一批提醒的处理状态（按编号）。读不到回 { ok: false, why }（调用方照实写「没查成」），不回空当成都没人在修。
 * 分批读（一次最多 500 条）。
 */
export async function handlingOf(
  port: AlertWorkPort,
  ids: readonly string[],
): Promise<{ ok: true; now: string; byId: Map<string, AlertHandling> } | { ok: false; why: string }> {
  try {
    const byId = new Map<string, AlertHandling>();
    let now = new Date().toISOString();
    const deploy = await port.deploy();
    for (let i = 0; i < ids.length; i += 500) {
      const r = await port.read(ids.slice(i, i + 500));
      now = r.now;
      for (const f of r.facts) byId.set(f.alert.id, alertHandling(f, deploy, r.now));
    }
    return { ok: true, now, byId };
  } catch (err) {
    return { ok: false, why: `谁在处理没查成：${err instanceof Error ? err.message : String(err)}` };
  }
}
