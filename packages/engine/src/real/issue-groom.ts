// 单子进门自动打标挂版本（#448）的真装配：受管的仓从库里列（和关单对账同一份），现状、标签时间线、贴标签、挂里程碑、
// 版本交接留言、闲置关单都经「引擎」机器人（@fleet-dao/github 的 groom.ts）；问 Jev 走 issue-kind-jev.ts（现找后端，
// 和 /healthz 的 judge 项同一个 resolveJevBackend）；这一轮的活动摘要写成一条日报级提醒（level=daily，design 第七节，
// 和关单对账的提醒同一个口子、同一个库，不是要人拍的 decision）。
import { DEFAULT_IDLE_POLICY, type IdlePolicy, type JevKindAnswer } from '@fleet-dao/conventions';
import type { Db } from '@fleet-dao/db';
import { upsertAlert } from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { IssueGroomJobDeps, IssueGroomRepo } from '../jobs/issue-groom.ts';

/** 单子打标挂版本要用到的这几下（不要整个 GitHub）。 */
export type GroomGitHub = Pick<
  GitHub,
  | 'readGroomFacts'
  | 'readIssueLabelEvents'
  | 'addIssueLabel'
  | 'setIssueMilestone'
  | 'commentIssue'
  | 'closeIssue'
>;

export interface IssueGroomWiring {
  db: Db;
  gh: GroomGitHub;
  /** 问 Jev「这张 issue 是哪一类」（issue-kind-jev.ts 的 createIssueKindAsker）。 */
  askKind(issue: { number: number; title: string; body: string }): Promise<JevKindAnswer>;
  idlePolicy?: IdlePolicy;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

/** 这一轮的日报键：一个仓一条，原地更新（不是「这些问题还没处理」的清单，是「这一轮做了什么」的快照）。 */
export function issueGroomDigestKey(repo: IssueGroomRepo): string {
  return `issue-groom:${repo.owner}/${repo.name}`;
}

/**
 * 闲置清理的天数（#448，需求「天数是配置」）：不设就用 conventions 的默认值（过时 30 天、再 14 天关）；设了要是正整数，
 * 不是就报错——不拿认不出的值悄悄当默认用（和 realPortsConfigFromEnv 里数字型配置同一个判法）。
 */
export function issueGroomIdlePolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IdlePolicy {
  const days = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 要是正整数（现在是 ${raw}）`);
    return n;
  };
  return {
    staleAfterDays: days('FLEET_ISSUE_GROOM_STALE_DAYS', DEFAULT_IDLE_POLICY.staleAfterDays),
    closeAfterDays: days('FLEET_ISSUE_GROOM_CLOSE_DAYS', DEFAULT_IDLE_POLICY.closeAfterDays),
  };
}

/** 单子打标挂版本这一步的真装配。repos 和关单对账同一份（受管的仓，从库里列）。 */
export function issueGroomJob(
  w: IssueGroomWiring,
  repos: () => Promise<IssueGroomRepo[]>,
): IssueGroomJobDeps {
  const now = w.now ?? (() => new Date());
  const log =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return {
    repos,
    facts: (repo) => w.gh.readGroomFacts({ repo }),
    labelEvents: (repo, issueNumber) => w.gh.readIssueLabelEvents({ repo, issueNumber }),
    askKind: (issue) => w.askKind(issue),
    async addLabel(repo, issueNumber, label) {
      await w.gh.addIssueLabel({ repo, issueNumber, label });
    },
    async setMilestone(repo, issueNumber, milestone) {
      await w.gh.setIssueMilestone({ repo, issueNumber, milestone });
    },
    async comment(repo, issueNumber, key, body) {
      await w.gh.commentIssue({ repo, issueNumber, key, body });
    },
    async closeNotPlanned(repo, issueNumber, comment) {
      await w.gh.closeIssue({ repo, issueNumber, reason: 'not_planned', comment });
    },
    async digest(repo, title, body) {
      await upsertAlert(w.db, {
        dedupeKey: issueGroomDigestKey(repo),
        level: 'daily',
        taskId: null,
        title,
        body,
      });
    },
    ...(w.idlePolicy ? { idlePolicy: w.idlePolicy } : {}),
    now,
    log,
  };
}
