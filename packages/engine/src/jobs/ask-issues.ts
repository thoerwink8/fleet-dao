// 对账开单（#259 问创始人不挡路；design 第五节「没人拍板」）：每轮 GitHub 对账（github-reconcile.ts，每 15 分钟）顺带看库里
// 这几种提问——超出单子范围的另开一张等创始人拍（未排期）；按推荐先做了、他改选了别的、原单已经合了（没来得及在存档点照改）
// 的开后续单，挂原单的同一个版本（挂在当前版本上的独立单由接活自动派）。开不开、放哪、写什么都由 core 的 ask.ts 判，
// 这里读库、现读原单、开单、回写单号（asks.follow_up_issue）。超出范围的那张开了以后，他在卡片上回答了，回答写到那张单的
// 评论里（一条提问一条，按提问编号幂等）。
// 开单、写评论没成：单号不回写（下一轮再开，按提问编号幂等，开不出两张），这一轮记成没查全、写明哪一条没成，报一条提醒；
// 不当成开了。
import {
  type AskIssueOriginal,
  askIssueKind,
  askIssuePlacement,
  askIssueText,
  outsideAnswerComment,
  type TaskAsk,
} from '@fleet-dao/core';
import type { TaskState } from '@fleet-dao/shared';
import { clip, message, type ReconcileLog } from './reconcile-common.ts';

export interface AskIssueCandidate {
  ask: TaskAsk;
  taskId: string;
  taskState: TaskState;
  taskTitle: string;
  /** 原单（问出这一句的那张单）。 */
  issueNumber: number;
  repo: { owner: string; name: string };
}

export interface AskIssueJobDeps {
  /** 库里要看的提问（@fleet-dao/db 的 askIssueCandidates，粗筛）。读不出原样抛：这一部分记成没跑成。 */
  candidates(): Promise<AskIssueCandidate[]>;
  /** 原单此刻贴的类别、挂的版本，仓里还开着的版本（「引擎」机器人现读）。读不到抛错，不拿「没挂版本」顶。 */
  original(repo: { owner: string; name: string }, issueNumber: number): Promise<AskIssueOriginal>;
  /** 开一张单（@fleet-dao/github 的 openIssue）：同一个 key 只开一张。 */
  openIssue(input: {
    repo: { owner: string; name: string };
    key: string;
    title: string;
    body: string;
    labels: string[];
    milestone: number | null;
  }): Promise<{ number: number; url: string; created: boolean }>;
  /** 回写另开的单号（@fleet-dao/db 的 setAskFollowUpIssue）：只在还空着时写。 */
  setFollowUp(askId: string, issueNumber: number): Promise<'ok' | 'same' | 'conflict' | 'not_found'>;
  /** 在一张单上留一条评论（@fleet-dao/github 的 commentIssue）：同一个 key 只留一条。 */
  comment(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ created: boolean }>;
  /**
   * 超出范围的那条，回答写到另开的单上了（这一轮写的，或以前写过、按键认下）：记成转交完（@fleet-dao/db 的
   * markAsksApplied，记 applied_at），之后不再看它。
   */
  relayed(c: AskIssueCandidate): Promise<void>;
  /** 提醒：同一个键只一条，再报原地更新（@fleet-dao/db 的 upsertAlert）。 */
  alert(key: string, taskId: string, title: string, body: string): Promise<void>;
  /** 事情好了撤掉提醒（resolveAlertByKey）；本来就没有、已经撤了都不算错。 */
  resolve(key: string): Promise<void>;
  log: ReconcileLog;
}

export interface AskIssuesResult {
  /** 看了几条提问。 */
  scanned: number;
  /** 开出的单、写上的回答（这一轮真写了的；以前写过、这次只认下的不算）。 */
  found: number;
  /** 这一轮开出、认下的单：提问编号 → 单号（日志、测试用）。 */
  opened: { askId: string; kind: 'outside' | 'follow-up'; issueNumber: number; created: boolean }[];
  /** 没开成、没写成的，一条一句：照实写进这一轮的 why，这一轮不记 ok。 */
  unchecked: string[];
}

/** 提醒的键：一条提问一条（开单、写回答各一条）。 */
export const askIssueAlertKey = (askId: string) => `ask-issue:${askId}`;
export const askAnswerAlertKey = (askId: string) => `ask-answer:${askId}`;

const short = (id: string) => id.slice(0, 8);

export async function openAskIssues(deps: AskIssueJobDeps): Promise<AskIssuesResult> {
  const result: AskIssuesResult = { scanned: 0, found: 0, opened: [], unchecked: [] };
  const candidates = await deps.candidates();
  result.scanned = candidates.length;

  const failed = async (key: string, c: AskIssueCandidate, what: string, err: unknown) => {
    const why = message(err);
    const line = `#${c.issueNumber} 的提问 ${short(c.ask.id)} ${what}没成：${clip(why, 300)}`;
    result.unchecked.push(line);
    deps.log('warn', `对账开单：${what}没成`, { askId: c.ask.id, issueNumber: c.issueNumber, why });
    try {
      await deps.alert(
        key,
        c.taskId,
        `#${c.issueNumber} 的提问${what}没成`,
        `${line}。下一轮对账（15 分钟后）再试，按提问编号幂等、开不出两张；一直这样要人看（卫生检查拦下、机器人没权限……）。`,
      );
    } catch (alertErr) {
      result.unchecked.push(
        `#${c.issueNumber} 的提问 ${short(c.ask.id)} ${what}没成，提醒也没报上：${message(alertErr)}`,
      );
    }
  };

  /** 超出范围的那张单上记他的回答。 */
  const writeAnswer = async (c: AskIssueCandidate, issueNumber: number) => {
    if (c.ask.answer === undefined) return;
    const key = askAnswerAlertKey(c.ask.id);
    try {
      const r = await deps.comment({
        repo: c.repo,
        issueNumber,
        key: `ask-answer:${c.ask.id}`,
        body: outsideAnswerComment(c.ask, c.issueNumber),
      });
      if (r.created) result.found += 1;
      await deps.relayed(c);
    } catch (err) {
      await failed(key, c, `把回答写到 #${issueNumber} 上`, err);
      return;
    }
    try {
      await deps.resolve(key);
    } catch (err) {
      deps.log('warn', '回答写上了，以前没写成的那条提醒没撤掉', { askId: c.ask.id, why: message(err) });
    }
  };

  for (const c of candidates) {
    const kind = askIssueKind(c.ask, c.taskState);
    if (kind === null) {
      // 超出范围的、开过单的：他回答了就把回答写上去（写过的按键认下，不重写）
      if (c.ask.scope === 'outside' && c.ask.followUpIssue !== undefined) {
        await writeAnswer(c, c.ask.followUpIssue);
      }
      continue;
    }
    const key = askIssueAlertKey(c.ask.id);
    const what = kind === 'outside' ? '另开单' : '开后续单';
    let issueNumber: number;
    let created: boolean;
    try {
      const original = await deps.original(c.repo, c.issueNumber);
      const placement = askIssuePlacement(kind, original);
      const text = askIssueText({
        kind,
        ask: c.ask,
        original: { issueNumber: c.issueNumber, title: c.taskTitle },
        placement,
      });
      const opened = await deps.openIssue({
        repo: c.repo,
        key: `ask:${c.ask.id}`,
        title: text.title,
        body: text.body,
        labels: placement.labels,
        milestone: placement.milestone?.number ?? null,
      });
      issueNumber = opened.number;
      created = opened.created;
      const wrote = await deps.setFollowUp(c.ask.id, issueNumber);
      if (wrote === 'conflict' || wrote === 'not_found') {
        throw new Error(
          wrote === 'conflict'
            ? `单开了（#${issueNumber}），可库里这条提问已经记着别的单号：没改它，要人核对`
            : `单开了（#${issueNumber}），可库里找不到这条提问了：单号没处回写`,
        );
      }
    } catch (err) {
      await failed(key, c, what, err);
      continue;
    }
    result.opened.push({ askId: c.ask.id, kind, issueNumber, created });
    if (created) result.found += 1;
    deps.log('info', `对账开单：${what}`, { askId: c.ask.id, from: c.issueNumber, issueNumber, created });
    try {
      await deps.resolve(key);
    } catch (err) {
      deps.log('warn', '开单成了，以前没开成的那条提醒没撤掉', { askId: c.ask.id, why: message(err) });
    }
    if (kind === 'outside') await writeAnswer(c, issueNumber);
  }
  return result;
}
