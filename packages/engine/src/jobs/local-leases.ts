// 本机领单的租约（决定 0096，shared 的 local-claims.ts）：拉单每一轮、每个开着开关的仓，先收一遍到期的本机租约，再做准入。
// 放在拉单里而不是另起定时任务：退回的单本来就是给拉单接的；总开关关着时拉单不跑，那时退回也没人接，等开了再收不迟。
//
// 一条到期的租约怎么收：
// 单关了、PR 合了，租约没到期也当轮收成做完（early）：本机不用再手动 pnpm work done；合并的 PR 镜像还没到（晚几分钟是常态）就留给下一轮。
//
//   单已经关了 → 有合并的 PR 挂着记做完（本机做完忘了报），没有记 stopped（还是本机的账）；
//   还活着（本机会话心跳里有会话在 local/<单号>- 分支上、不到租约时长前还动过；或这张单有开着的 PR）→ 租约顺延；
//   都没有 → 摘「本机做」、在单上留一句话、行改成 stopped + engine（拉单按「stopped 且没有任何一代」接手，和接手老行同一条路）。
// 先动 GitHub 再改行：改行写不成，下一轮整件事重来（摘标签不在就当摘了，留言按键只留一次）；反过来先改行，标签摘不掉，单就卡在「本机做」上没人接。
// 读不到、写不成记进 unchecked（这一轮记没查成），不当成「没有到期的」。
// 验收责任（#3037）：退回之前看这张单还有没有开着的验收责任。代码已合（或只剩协调验收责任，没有代码要写）就不退回法国重做、
// 不造空 PR：留言列出原验收项，行记做完，单子留着等人验；没合的照旧退回，退回的留言里也列出原验收项。读不到记没查成、不退回。
import { issueOfBranch, LOCAL_LABEL } from '@fleet-dao/conventions';
import { LOCAL_LEASE_MS, type LocalSessionsReport, localSessionState } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { AcceptanceDuty } from '../ports.ts';

/**
 * 本机会话心跳里，还在 local/<单号>- 分支上活着的单号（某仓的）：整份推来的时刻不到租约时长、会话没收场（last ≠ end）、
 * 多久没动不到租约时长。心跳里的时刻读不出就跳过那一个会话（不当成活着）。
 */
export function liveLocalIssues(
  nodes: readonly { receivedAt: string; report: LocalSessionsReport }[],
  repo: string,
  now: Date,
): Set<number> {
  const live = new Set<number>();
  for (const n of nodes) {
    const received = Date.parse(n.receivedAt);
    if (Number.isNaN(received) || now.getTime() - received >= LOCAL_LEASE_MS) continue;
    for (const s of n.report.sessions) {
      if (s.repo?.toLowerCase() !== repo.toLowerCase() || !s.branch || s.last === 'end') continue;
      const ref = issueOfBranch(s.branch);
      if (ref?.executor !== 'local') continue;
      let idleMs: number;
      try {
        idleMs = localSessionState(
          s,
          { reportedAt: n.report.reportedAt, receivedAt: n.receivedAt },
          now,
        ).idleMs;
      } catch {
        continue;
      }
      if (idleMs < LOCAL_LEASE_MS) live.add(ref.issue);
    }
  }
  return live;
}

export interface ExpiredLease {
  taskId: string;
  issueNumber: number;
  leaseUntil: Date;
}

export interface LocalLeaseRepo {
  id: string;
  owner: string;
  name: string;
}

export interface LocalLeaseDeps {
  /** 这个仓里本机在做、租约已过的行。读不到照抛。 */
  expired(repo: LocalLeaseRepo, now: Date): Promise<ExpiredLease[]>;
  /** 这个仓里本机在做、租约还没到期的行：单关了且 PR 合了就提前收。缺省不提前收。读不到照抛。 */
  unexpired?(repo: LocalLeaseRepo, now: Date): Promise<ExpiredLease[]>;
  /** 本机会话心跳里还在 local/<单号>- 分支上活着的单号。读不到照抛：不当成都死了。 */
  liveIssues(repo: LocalLeaseRepo, now: Date): Promise<Set<number>>;
  /** 这张单有没有合并了的 PR 挂着（PR 镜像里「需求」栏挂着它，或分支是这张单的固定前缀）；有回 PR 号。 */
  mergedPr(repo: LocalLeaseRepo, issueNumber: number): Promise<number | null>;
  /** 租约顺延到 until。 */
  extend(taskId: string, until: Date): Promise<void>;
  /** 收掉这条租约（行仍是本机在做、仍过期才改）。 */
  settle(input: {
    taskId: string;
    how: 'returned' | 'done' | 'closed';
    why: string;
    now: Date;
    /** 租约没到期就收（单关了、PR 合了）。 */
    early?: boolean;
  }): Promise<number>;
  /** 摘「本机做」（没贴着不算错）。 */
  unmarkLocal(input: { repo: LocalLeaseRepo; issueNumber: number }): Promise<void>;
  /**
   * 这张单（任务行）还开着的验收责任（#3037，store-ports 的 openAcceptanceDuties）。读不到照抛：这一轮这条租约记没查成、不退回，
   * 不当成没有。缺省不看（老装配）。
   */
  openDuties?(taskId: string): Promise<Pick<AcceptanceDuty, 'prNumber' | 'head' | 'items'>[]>;
}

export interface LeaseSweepResult {
  extended: number;
  returned: number;
  closed: number;
  /** 代码已合（或只有协调验收责任）、验收责任还开着：不退回法国重做，记做完、单子留着等人验（#3037）。 */
  awaitingAcceptance: number;
  unchecked: string[];
}

type LeaseDuty = Pick<AcceptanceDuty, 'prNumber' | 'head' | 'items'> & {
  /** 没带来源的旧调用仍按冷验收转人说；管理归并必须带来源，不能说成转给人验。 */
  source?: AcceptanceDuty['source'];
};

/** 一条还开着的责任在留言里怎么起头。管理归并是待独立验收的目标，不是冷验收转人。 */
function leaseDutyHeading(d: LeaseDuty): string {
  if (d.prNumber === 0) return '协调验收责任：';
  const where = `PR #${d.prNumber}（头 ${d.head}）`;
  return d.source === 'management_merge' ? `${where}管理归并待验：` : `${where}转给人验的：`;
}

/** 验收责任还开着、不退回法国时留在单上的话（#3037）：原验收项原样列出来，不丢验收范围。 */
export function leaseAcceptanceComment(
  issueNumber: number,
  merged: number | null,
  duties: readonly LeaseDuty[],
): string {
  return [
    `本机领这张单的租约到期了，可${merged !== null ? `代码已经合了（PR #${merged}）` : '这张单只剩协调验收责任（没有代码要写）'}，验收责任还开着：不退回法国重做，单子留着等人验。`,
    '',
    ...duties.flatMap((d) => [leaseDutyHeading(d), ...d.items.map((i) => `- ${i}`)]),
    '',
    `验完记下最终验收完成以后才关 #${issueNumber}。`,
  ].join('\n');
}

/** 退回法国时留在单上的话。还开着的验收责任（#3037）原样列在后面：退回不丢验收范围，法国收尾照它留着单。 */
export function leaseExpiredComment(
  issueNumber: number,
  leaseUntil: Date,
  duties: readonly Pick<AcceptanceDuty, 'prNumber' | 'head' | 'items'>[] = [],
): string {
  return [
    `本机领这张单的租约在 ${leaseUntil.toISOString()} 到期：${LOCAL_LEASE_MS / 3_600_000} 小时里本机没有会话在 \`local/${issueNumber}-\` 分支上动过、没有开着的 PR 挂着它、也没有续租，当作本机会话已经断了。`,
    '',
    `已摘掉「${LOCAL_LABEL}」，退回法国队列：交代齐的话引擎下一轮会接。要本机接着做，先 \`pnpm work claim ${issueNumber}\` 重新领（引擎已经接了就领不到）。`,
    ...(duties.length > 0
      ? [
          '',
          '还开着的验收责任跟着单子走（引擎收尾照它留着单，不关）：',
          ...duties.flatMap((d) =>
            d.items.map((i) => `- ${d.prNumber > 0 ? `PR #${d.prNumber}：` : ''}${i}`),
          ),
        ]
      : []),
  ].join('\n');
}

export async function sweepLocalLeases(
  deps: LocalLeaseDeps,
  repo: LocalLeaseRepo,
  ctx: {
    /** 这一轮读到的开着的单（号 → 标签）：在里面的才算开着。 */
    open: ReadonlyMap<number, readonly string[]>;
    /** 开着的 PR 挂着哪些单（单号 → PR 号）。读不到照抛。 */
    prClaims: () => Promise<Map<number, number>>;
    comment: (input: { issueNumber: number; key: string; body: string }) => Promise<{ created: boolean }>;
    now: Date;
    log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  },
): Promise<LeaseSweepResult> {
  const slug = `${repo.owner}/${repo.name}`;
  const out: LeaseSweepResult = { extended: 0, returned: 0, closed: 0, awaitingAcceptance: 0, unchecked: [] };
  if (deps.unexpired) {
    try {
      for (const lease of await deps.unexpired(repo, ctx.now)) {
        if (ctx.open.has(lease.issueNumber)) continue;
        const merged = await deps.mergedPr(repo, lease.issueNumber);
        if (merged === null) continue;
        const why = `单已关、PR #${merged} 已合：本机租约没到期也收，记做完`;
        if ((await deps.settle({ taskId: lease.taskId, how: 'done', why, now: ctx.now, early: true })) > 0) {
          out.closed += 1;
        }
      }
    } catch (err) {
      out.unchecked.push(`${slug}：本机没到期的租约提前收没做成（${errMessage(err)}）`);
    }
  }
  let expired: ExpiredLease[];
  try {
    expired = await deps.expired(repo, ctx.now);
  } catch (err) {
    out.unchecked.push(`${slug}：本机到期的租约没读成（${errMessage(err)}）`);
    return out;
  }
  if (expired.length === 0) return out;
  let live: Set<number> | null = null;
  try {
    live = await deps.liveIssues(repo, ctx.now);
  } catch (err) {
    // 心跳读不到：不拿它判死活，这一轮只按 PR 判；到期又没 PR 的这一轮先不退回
    out.unchecked.push(`${slug}：本机会话心跳没读成，到期的租约这一轮只顺延不退回（${errMessage(err)}）`);
  }
  for (const lease of expired) {
    const ref = `${slug}#${lease.issueNumber}`;
    try {
      const labels = ctx.open.get(lease.issueNumber);
      if (labels === undefined) {
        const merged = await deps.mergedPr(repo, lease.issueNumber);
        const how = merged !== null ? 'done' : 'closed';
        const why =
          merged !== null
            ? `本机租约到期时单已关、PR #${merged} 已合：记做完`
            : '本机租约到期时单已关、没有合并的 PR：记停下';
        if ((await deps.settle({ taskId: lease.taskId, how, why, now: ctx.now })) > 0) out.closed += 1;
        continue;
      }
      const pr = (await ctx.prClaims()).get(lease.issueNumber);
      if (live === null || live.has(lease.issueNumber) || pr !== undefined) {
        await deps.extend(lease.taskId, new Date(ctx.now.getTime() + LOCAL_LEASE_MS));
        out.extended += 1;
        continue;
      }
      // 验收责任还开着（#3037）：代码已合、或只剩协调验收责任，退回法国只会重做一遍或开空 PR；记做完，单子留着等人验
      const duties = deps.openDuties ? await deps.openDuties(lease.taskId) : [];
      if (duties.length > 0) {
        const merged = await deps.mergedPr(repo, lease.issueNumber);
        if (merged !== null || duties.every((d) => d.prNumber === 0)) {
          await ctx.comment({
            issueNumber: lease.issueNumber,
            key: `local-lease-acceptance:${lease.leaseUntil.toISOString()}`,
            body: leaseAcceptanceComment(lease.issueNumber, merged, duties),
          });
          const why = `本机租约 ${lease.leaseUntil.toISOString()} 到期：${merged !== null ? `PR #${merged} 已合` : '只剩协调验收责任'}，验收责任 ${duties.length} 条还开着，不退回法国，单子留着等人验`;
          if ((await deps.settle({ taskId: lease.taskId, how: 'done', why, now: ctx.now })) > 0) {
            out.awaitingAcceptance += 1;
          }
          continue;
        }
      }
      if (labels.includes(LOCAL_LABEL)) await deps.unmarkLocal({ repo, issueNumber: lease.issueNumber });
      await ctx.comment({
        issueNumber: lease.issueNumber,
        key: `local-lease-expired:${lease.leaseUntil.toISOString()}`,
        body: leaseExpiredComment(lease.issueNumber, lease.leaseUntil, duties),
      });
      const why = `本机租约 ${lease.leaseUntil.toISOString()} 到期，没有心跳、没有开着的 PR：退回法国队列`;
      if ((await deps.settle({ taskId: lease.taskId, how: 'returned', why, now: ctx.now })) > 0) {
        out.returned += 1;
        ctx.log('info', `拉单：${ref} 本机租约到期，已摘「${LOCAL_LABEL}」、退回法国队列`, {
          leaseUntil: lease.leaseUntil.toISOString(),
        });
      }
    } catch (err) {
      out.unchecked.push(`${ref}：本机租约没收成（${errMessage(err)}）`);
    }
  }
  return out;
}
