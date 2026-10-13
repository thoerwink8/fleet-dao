// 需求开出的单子的进度同步（#2060，母单 #2047 第 B 片；方案第六节「开单之后」）：后端每分钟看一遍已结案·做、单子还没上线也没关掉的需求，
// 从 GitHub（单开没开着）和引擎任务表（任务到哪一步、子任务合了几个、做完的时刻、没人答的追问）读到事实，
// 1. 单子状态变了就写进 recordRequestIssueState（开着 / 已合并 / 已上线 / 关掉；上线或关掉满 3 天由引擎的 request-sweep 归档）；
// 2. 在对话里追加一条系统消息当进度卡（「#12 动手中 · 已合并 3/6 个子任务」），同一张单一模一样的不重复；
// 3. 引擎在任务里提的、还没人答的问题：在单上发一条评论（引擎机器人，幂等，键是追问编号），并在对话里生成一条「引擎提问」消息绑定那条评论。
// 写库后需求的 last_activity_at 会动，数据库触发器（迁移 0066）把变化 NOTIFY 出去，经 SSE 推给页面——这里不自己推。
// 改这里之前必须知道：
// - 读不到 GitHub、读不到任务表：这一张单这一轮明说没读成（对话里追加一条「#12 进度没读到：原因」，同样的话不重复；返回值的 failures 里也有），
//   不拿「没变化」顶；别的单照常做，下一轮再试。
// - 「已上线」要知道当前在用那版切上去的时刻（deployedAt，只在正式环境读得到）；读不到就停在「已合并，等上线」，不猜。
// - 判状态的规矩只有一份：@fleet-dao/shared 的 request-progress.ts。
import {
  appendProgressCard,
  type Db,
  listRequestIssuesToSync,
  readIssueTaskFacts,
  recordEngineAsk,
  recordRequestIssueState,
} from '@fleet-dao/db';
import { deriveIssueProgress, progressCardBody } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Logger } from './ports.ts';
import type { RequestIssuePort } from './request-issue.ts';

/** 后端多久同步一轮。 */
export const REQUEST_PROGRESS_EVERY_MS = 60_000;

export interface RequestProgressDeps {
  db: Db;
  issues: RequestIssuePort;
  /** 当前在用那版切上去的时刻（ISO）；读不到是 null。不给（开发、内存版）= 这台读不到。 */
  deployedAt?: (() => string | null) | undefined;
  now: () => Date;
  log: Logger;
}

export interface RequestProgressFailure {
  seq: number;
  issue: string;
  why: string;
}

export interface RequestProgressResult {
  /** 看了几张单。 */
  checked: number;
  /** 单子状态变了几张。 */
  changed: number;
  /** 追加了几张进度卡。 */
  cards: number;
  /** 新生成了几条引擎提问。 */
  asks: number;
  failures: RequestProgressFailure[];
}

/** 追问发在单上的评论正文（引擎机器人发，评论里有选项和去哪回答）。 */
export function askCommentBody(seq: number, ask: { question: string; options: readonly string[] }): string {
  const options = ask.options.length > 0 ? `\n\n选项：\n${ask.options.map((o) => `- ${o}`).join('\n')}` : '';
  return `引擎在做这张单时有个问题要人答：\n\n${ask.question}${options}\n\n（可以在驾驶舱 需求 ${seq} 的对话里回答，答复会写回这条评论下面。）`;
}

/** 对话里「引擎提问」消息的正文：问题加选项。 */
export function askMessageBody(ask: { question: string; options: readonly string[] }): string {
  return ask.options.length > 0 ? `${ask.question}\n\n选项：${ask.options.join(' / ')}` : ask.question;
}

/** 同步一轮。读不了库（要同步哪些单都查不出）直接抛，由调用方记没跑成。 */
export async function syncRequestProgress(deps: RequestProgressDeps): Promise<RequestProgressResult> {
  const { db, issues } = deps;
  const todo = await listRequestIssuesToSync(db);
  const out: RequestProgressResult = { checked: 0, changed: 0, cards: 0, asks: 0, failures: [] };
  for (const item of todo) {
    out.checked += 1;
    const slug = `${item.owner}/${item.name}`;
    const label = `${slug}#${item.number}`;
    const repo = { owner: item.owner, name: item.name };
    const fail = async (why: string) => {
      out.failures.push({ seq: item.seq, issue: label, why });
      // 对话里也明说（同一句不重复追加）：页面上的进度卡别停在旧样子上让人以为没变
      try {
        const got = await appendProgressCard(db, {
          seq: item.seq,
          issueNumber: item.number,
          body: `#${item.number} 进度没读到：${why}`,
          at: deps.now(),
        });
        if (got === 'appended') out.cards += 1;
      } catch (err) {
        deps.log.warn('进度没读到，连对话里的说明也没写成', {
          seq: item.seq,
          issue: label,
          error: errMessage(err),
        });
      }
    };

    let github: Awaited<ReturnType<RequestIssuePort['readIssueState']>>;
    try {
      github = await issues.readIssueState({ repo, issueNumber: item.number });
    } catch (err) {
      await fail(`读不到 GitHub 上 ${label} 的状态：${errMessage(err)}`);
      continue;
    }
    let facts: Awaited<ReturnType<typeof readIssueTaskFacts>>;
    try {
      facts = await readIssueTaskFacts(db, { repoId: item.repoId, issueNumber: item.number });
    } catch (err) {
      await fail(`读不到引擎任务表里 ${label} 的任务：${errMessage(err)}`);
      continue;
    }

    let deployedAt: string | null | undefined;
    try {
      deployedAt = deps.deployedAt?.();
    } catch (err) {
      deps.log.warn('读不到当前在用那版的上线时刻：已合并的停在「等上线」', { error: errMessage(err) });
    }

    const progress = deriveIssueProgress({
      github,
      task: facts
        ? {
            state: facts.state,
            subtasks: facts.subtasks,
            updatedAt: (facts.doneAt ?? deps.now()).toISOString(),
            why: facts.why,
          }
        : null,
      deployedAt,
    });
    const at = deps.now();
    try {
      if (progress.state !== item.state) {
        await recordRequestIssueState(db, {
          seq: item.seq,
          repo: slug,
          number: item.number,
          state: progress.state,
          at,
        });
        out.changed += 1;
      }
      const card = await appendProgressCard(db, {
        seq: item.seq,
        issueNumber: item.number,
        body: progressCardBody(item.number, progress),
        at,
      });
      if (card === 'appended') out.cards += 1;
    } catch (err) {
      out.failures.push({ seq: item.seq, issue: label, why: `进度写不进库：${errMessage(err)}` });
      continue;
    }

    // 引擎在任务里提的、还没人答的问题：发到单上，对话里生成一条绑着评论的「引擎提问」
    for (const ask of facts?.openAsks ?? []) {
      try {
        const posted = await issues.commentIssue({
          repo,
          issueNumber: item.number,
          key: `request-ask:${ask.id}`,
          body: askCommentBody(item.seq, ask),
        });
        const made = await recordEngineAsk(db, {
          seq: item.seq,
          commentUrl: posted.url,
          body: askMessageBody(ask),
          at: ask.askedAt,
        });
        if (made === 'created') out.asks += 1;
      } catch (err) {
        out.failures.push({ seq: item.seq, issue: label, why: `引擎的提问没能发到单上：${errMessage(err)}` });
      }
    }
  }
  return out;
}

/** 每分钟同步一轮；一轮没跑完不开下一轮。每轮的失败进日志，读不了库也只记一笔（下一轮再来）。返回停掉它的函数。 */
export function startRequestProgressWatch(deps: RequestProgressDeps & { everyMs?: number }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncRequestProgress(deps);
      for (const f of r.failures) deps.log.warn('需求进度同步：这张单没读成', { ...f });
    } catch (err) {
      deps.log.warn('需求进度同步：这一轮没做成', { error: errMessage(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? REQUEST_PROGRESS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
