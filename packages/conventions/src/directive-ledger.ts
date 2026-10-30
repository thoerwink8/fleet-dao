// 创始人引导记进驾驶舱库（决定 0123，#3764）：pnpm progress directive 经 POST /api/nodes/notes 写一条 kind=directive 的账本行，
// 不写 docs/directives/、不开分支、不开 PR。原话在 text（只进私有库），意思、类别、主人、他说话的时刻、挂的单是单独字段；
// 仓里只留按周汇总的意思（directive-digest.ts，不带原话）。
// 这里只依赖 gh（查挂的单开着没有、顺手开单）和账本写口，不依赖 git：测试断言一次 git、一次 gh pr create 都没调。
// 写不成账本就是没记成（抛 DirectiveUnchecked，退出码 2），不退回写文件；要是已经顺手开了单，错误里写明单号，重跑带 --issue。
import {
  checkIssueOpen,
  DirectiveRefused,
  DirectiveUnchecked,
  directiveIssueDraft,
  openIssueNumbers,
} from './directives.ts';
import type { Gh } from './issue-new.ts';
import {
  type LedgerNoteBody,
  type LedgerNotePost,
  liveLedgerNotePost,
  noteIdempotencyKey,
  postLedgerNote,
} from './ledger-note.ts';
import { type InboxDeps, type LedgerDirective, type LedgerHandoff, ledgerSync } from './ledger-read.ts';
import type { DirectiveKind } from './progress.ts';

export interface DirectiveToRecord {
  /** 原话（对外仓这里已经是意思，见 private-quotes.ts） */
  text: string;
  /** 他说话的时刻，北京时间 YYYY-MM-DD HH:mm +0800 */
  at: string;
  atDate: Date;
  owner: string;
  source: string;
}

export interface DirectiveLedgerDeps {
  gh: Gh;
  /** 本仓 owner/name；认不出就是没法写账本，调用方先报 */
  repo: string;
  /** 没给 --issue 时开一张单，返回单号（入口用 issueNew 实现；测试给假的） */
  newIssue?: (draft: { title: string; body: string }) => Promise<number>;
  post?: LedgerNotePost;
  /** 本机会话号；拿不到时机器名 */
  ref?: string;
}

/**
 * 账本里没办完的引导（`progress read --pending` 的一部分）：增量读账本（复用 ledger-read.ts 的状态文件），再看挂的单开着没有。
 * 同一趟读也带出收件箱里没认领的 decision.handoff。账本读不到抛 ProgressUnchecked，读不到开着的单抛 DirectiveUnchecked，都不当成「没有」。
 */
export async function ledgerPending(
  repo: string,
  deps: { inbox: InboxDeps; gh: Gh },
): Promise<{ handoffs: LedgerHandoff[]; directives: LedgerDirective[] }> {
  const synced = await ledgerSync(repo, deps.inbox);
  if (synced.directives.length === 0) return { handoffs: synced.handoffs, directives: [] };
  const open = await openIssueNumbers(deps.gh);
  return { handoffs: synced.handoffs, directives: synced.directives.filter((d) => open.has(d.issue)) };
}

/**
 * 记一条创始人引导进账本。返回账本行编号、挂的单、是不是新记的（同一句同一分钟重跑是重放，created:false）。
 * meaning 必给（单在公开仓，标题和正文只用意思）；挂单：给了 issue 就先查它开着，没给就开一张。
 */
export async function recordDirectiveToLedger(
  r: DirectiveToRecord,
  meta: { meaning: string; category: DirectiveKind },
  deps: DirectiveLedgerDeps,
  issue?: number,
): Promise<{ id: number; issue: number; created: boolean }> {
  const meaning = meta.meaning.trim();
  if (!meaning)
    throw new DirectiveRefused(
      '记引导必须给 --meaning "不带原话的意思"（单和周汇总在公开仓，只用意思，原话只进驾驶舱库，决定 0123）。没记。',
    );
  let n = issue;
  let opened = false;
  if (n !== undefined) await checkIssueOpen(deps.gh, n);
  else {
    if (!deps.newIssue) throw new DirectiveRefused('没给 --issue，也没法开单：没记。');
    n = await deps.newIssue(directiveIssueDraft({ meaning, at: r.at, source: r.source }));
    opened = true;
  }
  const body: LedgerNoteBody = {
    kind: 'directive',
    repo: deps.repo,
    issue: n,
    text: r.text,
    meaning,
    category: meta.category,
    owner: r.owner,
    spokenAt: r.at,
    source: { kind: 'local-session', ref: deps.ref || 'unknown' },
    idempotencyKey: noteIdempotencyKey('directive', r.text, r.atDate),
  };
  const res = await postLedgerNote(deps.post ?? liveLedgerNotePost(), body);
  if (!res.ok)
    throw new DirectiveUnchecked(
      `往法国账本记引导没成（${res.why}）。${opened ? `已顺手开了单 #${n}，重跑时带 --issue ${n}，别再开一张。` : ''}引导没记。`,
    );
  return { id: res.id, issue: n, created: res.created };
}
