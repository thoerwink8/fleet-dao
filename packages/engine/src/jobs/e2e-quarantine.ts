// 隔离集进出（决定 0093 第 6 条）：看到开着的「e2e 偶发」单，按固定步骤开一个改 quarantine.json 的 PR（不调模型），
// 说明里带单号；隔离集里连续 7 天全过的，开 PR 移出并关单。判法在 conventions 的 e2e-quarantine-sync，这里只排一轮怎么跑。
// 改这里之前必须知道：
// - 不拉单、不起会话，不标 needsMaster：总开关每次发版都会关，标了隔离集就几乎移不进去。
// - 同一时间只开着一张隔离集 PR（分支 e2e-quarantine/sync）。已经开着就不再开第二张，免得两张一起改同一个文件对不上；
//   新的单等这张合了，下一轮再放。同一张单已经挂在开着的 PR 上，也不再开。
// - 移出的 PR 已经开着、关单没做成：下一轮只补关，不再开 PR。
// - 隔离集每天的报告读不到：不移出（没查成不当成全过）。没有要移出的时候，放进照样开。

import {
  beijingDate,
  mentionsIssue,
  planQuarantineSync,
  QUARANTINE_PATH,
  type QuarantineDay,
  type QuarantineMove,
  quarantineAfter,
  type RepoView,
} from '@fleet-dao/conventions';
import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

/** 一天一次，排在隔离集每天 04:47（北京时间）那次跑完之后。 */
export const E2E_QUARANTINE_EVERY_MINUTES = 24 * 60;
/** 每天 05:20（北京时间，UTC+8）= 21:20 UTC。 */
export const E2E_QUARANTINE_OFFSET_MINUTES = 21 * 60 + 20;

export const E2E_QUARANTINE_JOB = {
  id: 'e2e-quarantine',
  name: '隔离集进出',
  schedule: '每天 05:20（北京时间）',
  expectEveryMinutes: E2E_QUARANTINE_EVERY_MINUTES * 2,
} as const;

/** 进出共用这一支。有开着的 PR 时不删、不再开。 */
export const QUARANTINE_BRANCH = 'e2e-quarantine/sync';

export interface QuarantinePull {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  head: string;
}

/** 真实现在 real/e2e-quarantine.ts。测试不连 GitHub：进出的核对在 conventions 的假仓测试。 */
export interface E2eQuarantineGitHub {
  readQuarantine(): Promise<{ commit: string; text: string; base: string }>;
  /** 开着的、标题以「e2e 偶发」开头的单（不含 PR）。翻不完要抛。 */
  openIssues(): Promise<{ number: number; title: string }[]>;
  /** 开着的 PR。翻不完要抛，免得漏看已经挂上的单又开一张。 */
  openPulls(): Promise<QuarantinePull[]>;
  /** 隔离集每天的报告，一天一份（同一天取最后一次）。读不到要抛。 */
  quarantineDays(): Promise<QuarantineDay[]>;
  openPr(input: {
    title: string;
    body: string;
    content: string;
    baseCommit: string;
    /** 默认分支名，PR 合进去的那一支。 */
    base: string;
  }): Promise<{ number: number; url: string; nodeId: string }>;
  armAutoMerge(pull: { number: number; nodeId: string }): Promise<void>;
  closeIssue(issue: number, comment: string): Promise<void>;
}

export interface E2eQuarantineJobDeps {
  github: E2eQuarantineGitHub;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

function unread(why: string): string {
  return why.includes('没查成') ? why : `没查成：${why}`;
}

function repoOf(text: string): RepoView {
  return {
    read: (rel) => (rel === QUARANTINE_PATH ? text : undefined),
    exists: (rel) => rel === QUARANTINE_PATH || rel === '' || QUARANTINE_PATH.startsWith(`${rel}/`),
    isDir: (rel) => rel !== QUARANTINE_PATH && (rel === '' || QUARANTINE_PATH.startsWith(`${rel}/`)),
    list: () => undefined,
  };
}

function entryCount(text: string): number {
  const data = JSON.parse(text) as { tests?: unknown };
  return Array.isArray(data.tests) ? data.tests.length : 0;
}

function prText(moves: readonly QuarantineMove[]): { title: string; body: string } {
  const opening = moves.filter((m) => m.open);
  const one = opening[0];
  if (opening.length === 1 && one) return { title: one.prTitle, body: one.body };
  const lines = opening.map((m) =>
    m.kind === 'enter'
      ? `Refs #${m.issue}（放进 \`${m.file} › ${m.title}\`，限期 ${m.until}）`
      : `Refs #${m.issue}（移出 \`${m.file} › ${m.title}\`：连续 7 天全过）`,
  );
  const inn = opening.filter((m) => m.kind === 'enter').map((m) => `#${m.issue}`);
  const out = opening.filter((m) => m.kind === 'exit').map((m) => `#${m.issue}`);
  const parts = [
    ...(inn.length > 0 ? [`放进 ${inn.join('、')}`] : []),
    ...(out.length > 0 ? [`移出 ${out.join('、')}`] : []),
  ];
  return {
    title: `隔离集：${parts.join('，')}`,
    body: [
      `**做了什么**：按固定步骤改 \`${QUARANTINE_PATH}\`（不调模型）。达阈值的偶发用例放进隔离集；连续 7 天全过的移出。`,
      '',
      '**需求**：',
      ...lines,
      '',
    ].join('\n'),
  };
}

function inflightOf(pulls: readonly QuarantinePull[]): QuarantinePull | undefined {
  return pulls.find((p) => p.head === QUARANTINE_BRANCH || p.title.startsWith('隔离集：'));
}

/** 跑一轮。记开始就失败原样抛。没查成记 failed 再抛。移出的报告没读到、放进仍开成了：记 partial，不抛。 */
export async function runE2eQuarantineJob(deps: E2eQuarantineJobDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(E2E_QUARANTINE_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: unread(errMessage(err)) };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '隔离集进出这一轮没跑成', { runId, why: result.why });
    throw new Error(result.why);
  }
  deps.log('info', '隔离集进出这一轮', {
    runId,
    outcome: result.outcome,
    why: 'why' in result ? result.why : undefined,
  });
  return result;
}

async function round(deps: E2eQuarantineJobDeps): Promise<ScheduleResult> {
  const head = await deps.github.readQuarantine();
  const today = beijingDate(deps.now());
  const issues = await deps.github.openIssues();
  const pulls = await deps.github.openPulls();
  let days: QuarantineDay[] = [];
  let daysWhy: string | undefined;
  let held = 0;
  try {
    held = entryCount(head.text);
  } catch {
    held = 0;
  }
  if (held > 0) {
    try {
      days = await deps.github.quarantineDays();
    } catch (err) {
      daysWhy = unread(errMessage(err));
      deps.log('warn', '隔离集每天的报告没读到，这一轮不移出', { error: daysWhy });
    }
  }
  const moves = planQuarantineSync({
    repo: repoOf(head.text),
    openIssues: issues,
    openPulls: pulls,
    // 报告没读到就当没有连续全过，不移出。
    days: daysWhy ? [] : days,
    today,
  });
  const opening = daysWhy ? moves.filter((m) => m.kind === 'enter' && m.open) : moves.filter((m) => m.open);
  const scanned = Math.max(1, issues.length + held);
  const waiting = inflightOf(pulls);
  if (waiting) {
    await deps.github.armAutoMerge({ number: waiting.number, nodeId: waiting.nodeId });
  }
  let opened: { number: number; url: string; nodeId: string } | undefined;
  if (opening.length > 0 && !waiting) {
    const text = prText(opening);
    opened = await deps.github.openPr({
      title: text.title,
      body: text.body,
      content: quarantineAfter(head.text, opening),
      baseCommit: head.commit,
      base: head.base,
    });
    await deps.github.armAutoMerge({ number: opened.number, nodeId: opened.nodeId });
    deps.log('info', `隔离集 PR #${opened.number}`, { url: opened.url });
  }
  let closed = 0;
  for (const move of moves) {
    if (move.kind !== 'exit') continue;
    if (move.open && !opened) continue;
    const cited =
      opened?.number ?? pulls.find((p) => mentionsIssue(`${p.title}\n${p.body}`, move.issue))?.number;
    const where = cited ? `PR #${cited} 把它移出` : '把它移出';
    await deps.github.closeIssue(move.issue, `隔离集里连续 7 天全过，${where} \`${QUARANTINE_PATH}\`。`);
    closed += 1;
  }
  const found = (opened ? 1 : 0) + closed;
  if (daysWhy && !opened) {
    if (opening.length === 0) return { outcome: 'failed', why: daysWhy, scanned };
    return {
      outcome: 'partial',
      why: `${daysWhy}。已有开着的隔离集 PR #${waiting?.number ?? '?'}，放进等它合了再开`,
      scanned,
      found,
    };
  }
  if (daysWhy) {
    return { outcome: 'partial', why: `${daysWhy}。放进的 PR 已开，移出等报告读到再做`, scanned, found };
  }
  if (opening.length > 0 && waiting) {
    return {
      outcome: 'ok',
      scanned,
      found,
      why: `已有开着的隔离集 PR #${waiting.number}，新的等它合了再开`,
    };
  }
  return { outcome: 'ok', scanned, found };
}
