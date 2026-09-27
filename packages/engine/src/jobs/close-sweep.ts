// 关单对账（#241）：每天一次（GitHub 对账补漏里北京时间 9:00 起的那一轮），按受管的仓看一遍——做完没关的、子单都关了的
// 母单、关成「完成」却没有结果的。判法在 @fleet-dao/conventions 的 close-sweep.ts（「有没有结果」和 pnpm issue:close、合并闸
// 同一份）；这里读现状（「引擎」机器人，@fleet-dao/github 的 readCloseFacts）、在单上留言一次（按键认，重跑不重复）、
// 每个仓每一种在驾驶舱一条要人拍的提醒，这一种一张都没有了就撤。只留言、只提醒，不挡 PR、不关单：看的是单子开关这类外部
// 状态（design 第五节「发现问题当场修」第 5 条）。
// 读不到、认不出：这个仓记没查成，提醒一条都不撤（没查成不是「都齐了」）；留言、提醒没写成也照实记，不当成写上了。
import {
  CLOSE_KINDS,
  CLOSE_LOOKBACK_DAYS,
  type CloseSweepFacts,
  closeAlert,
  closeAlertKey,
  closeComment,
  closeCommentKey,
  closeSweep,
} from '@fleet-dao/conventions';
import { message, type ReconcileLog } from './reconcile-common.ts';

export interface CloseSweepRepo {
  owner: string;
  name: string;
}

/** 读回来的现状：仓里没有 specs/ 时 specsFiles 是 null（这个仓不按「关单要有结果」查）。 */
export type CloseSweepRead = Omit<CloseSweepFacts, 'specsFiles'> & { specsFiles: readonly string[] | null };

export interface CloseSweepJobDeps {
  /** 受管的仓。读不出原样抛：这一步记成没跑成。 */
  repos(): Promise<CloseSweepRepo[]>;
  /** 仓的现状（@fleet-dao/github 的 readCloseFacts，关掉的单从 since 往后看）。读不到、认不出抛错。 */
  facts(repo: CloseSweepRepo, since: Date): Promise<CloseSweepRead>;
  /** 在单上留一条言（@fleet-dao/github 的 commentIssue）：同一个 key 只留一条。 */
  comment(input: {
    repo: CloseSweepRepo;
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ created: boolean }>;
  /** 驾驶舱提醒（要人拍）：同一个键只一条，再报原地更新、处理过的重新打开。 */
  alert(key: string, title: string, body: string, link: string): Promise<void>;
  /** 撤提醒：本来就没有、已经撤了都不算错。 */
  resolve(key: string, why: string): Promise<void>;
  now: () => Date;
  log: ReconcileLog;
}

export interface CloseSweepResult {
  /** 查成了几个仓（有 specs/ 的）。 */
  scanned: number;
  /** 这一轮新留的言（单子新被提醒到的次数；以前留过、这次认下的不算）。 */
  found: number;
  /** 没查成、没写成的，一条一句：照实写进这一轮的 why，这一轮不记 ok。 */
  unchecked: string[];
}

/** 关单对账在每天北京时间几点那一轮跑。 */
export const CLOSE_SWEEP_BEIJING_HOUR = 9;
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/**
 * 这一轮要不要跑关单对账：北京时间 9:00–9:15 起的那一轮（对账每 15 分钟一轮，一天正好一次）。那一轮没起来（引擎停着、上一轮
 * 还没完被跳过）就等第二天：要提醒的事第二天还在，只是晚一天。
 */
export function closeSweepDue(at: Date): boolean {
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS);
  return bj.getUTCHours() === CLOSE_SWEEP_BEIJING_HOUR && bj.getUTCMinutes() < 15;
}

const KIND_WORDS = { due: '做完没关', mother: '子单都关了的母单', 'no-result': '关了没结果' } as const;

export async function sweepClosing(deps: CloseSweepJobDeps): Promise<CloseSweepResult> {
  const now = deps.now();
  const since = new Date(now.getTime() - CLOSE_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const out: CloseSweepResult = { scanned: 0, found: 0, unchecked: [] };
  for (const repo of await deps.repos()) {
    const slug = `${repo.owner}/${repo.name}`;
    let facts: CloseSweepRead;
    try {
      facts = await deps.facts(repo, since);
    } catch (err) {
      out.unchecked.push(`关单对账 ${slug} 没查成（${message(err)}），提醒一条没动`);
      continue;
    }
    const { specsFiles } = facts;
    if (specsFiles === null) {
      deps.log('info', '关单对账：这个仓没有 specs/，不按「关单要有结果」查', { repo: slug });
      continue;
    }
    out.scanned += 1;
    const sweep = closeSweep({ ...facts, specsFiles }, now, slug);
    out.unchecked.push(...sweep.unchecked.map((u) => `关单对账 ${slug} ${u.text}`));
    for (const f of sweep.findings) {
      try {
        const r = await deps.comment({
          repo,
          issueNumber: f.issue,
          key: closeCommentKey(f),
          body: closeComment(f),
        });
        if (r.created) out.found += 1;
      } catch (err) {
        out.unchecked.push(`关单对账 ${slug}#${f.issue} 留言没留成（${message(err)}）`);
      }
    }
    for (const kind of CLOSE_KINDS) {
      const list = sweep.findings.filter((f) => f.kind === kind);
      const key = closeAlertKey(slug, kind);
      try {
        if (list.length > 0) {
          const a = closeAlert(slug, kind, list);
          await deps.alert(key, a.title, a.body, `https://github.com/${slug}/issues`);
        } else if (!sweep.unchecked.some((u) => u.kind === kind)) {
          // 判不了的那一种不撤：没查成不是「都处理了」
          await deps.resolve(key, `关单对账：${KIND_WORDS[kind]}的单现在一张都没有了`);
        }
      } catch (err) {
        out.unchecked.push(`关单对账 ${slug} 的「${KIND_WORDS[kind]}」提醒没写成（${message(err)}）`);
      }
    }
    deps.log('info', '关单对账查完一个仓', {
      repo: slug,
      due: sweep.findings.filter((f) => f.kind === 'due').length,
      mother: sweep.findings.filter((f) => f.kind === 'mother').length,
      noResult: sweep.findings.filter((f) => f.kind === 'no-result').length,
      unchecked: sweep.unchecked.length,
    });
  }
  return out;
}
