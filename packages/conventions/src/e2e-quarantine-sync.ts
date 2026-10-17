// 隔离集进出（决定 0093 第 6 条）：开着的「e2e 偶发」单放进 packages/web/e2e/quarantine.json，
// 隔离集里连续 7 天全过的移出。这里只判、只改这份文件的文本；开 PR、关单在引擎定时任务（不调模型）。
// 测试用内存假仓（test/helpers.ts 的 memRepo）核对进、出、同一条不重复开。
import {
  FLAKY_SUMMARY_TITLE,
  issueTitle,
  keyText,
  type Outcomes,
  parseQuarantine,
  type QuarantineEntry,
} from './e2e-flaky.ts';
import type { RepoView } from './repo.ts';

export const QUARANTINE_PATH = 'packages/web/e2e/quarantine.json';
/** 隔离集每天跑一次，连续这么多天结局都是 passed 才移出。偶发（flaky）、真红、没跑到都不算全过。 */
export const QUARANTINE_PASS_DAYS = 7;

/** 北京时间的日历日（UTC+8，没有夏令时）。 */
export function beijingDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 日历日加减。day 不是 YYYY-MM-DD 就抛。 */
export function shiftDay(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`日期认不出：${day}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta);
  return new Date(t).toISOString().slice(0, 10);
}

/** 隔离集每天一份报告。同一天多份时，后写进数组的盖住前面的（调用方按时间从旧到新放）。 */
export interface QuarantineDay {
  day: string;
  outcomes: Outcomes;
}

export interface QuarantineMove {
  kind: 'enter' | 'exit';
  /**
   * false：开着的 PR 已经挂着这张单，不再开一张。移出的这种仍要关单（PR 开成了、关单没做成，下一轮补关）。
   */
  open: boolean;
  issue: number;
  file: string;
  title: string;
  until: string;
  /** 只做这一步之后的整份 quarantine.json。 */
  content: string;
  prTitle: string;
  body: string;
}

/** 正文或标题里有没有这个单号。#12 不认成 #123。 */
export function mentionsIssue(text: string, issue: number): boolean {
  return new RegExp(`#${issue}(?!\\d)`).test(text);
}

/** 「e2e 偶发：file › title」。汇总单、整轮坏了、对不上文件名的都不是一条用例。 */
export function flakyIssueKey(title: string): { file: string; title: string } | null {
  if (title === FLAKY_SUMMARY_TITLE) return null;
  const prefix = issueTitle({ file: '', title: '' }).replace(/ › $/, '');
  if (!title.startsWith(prefix)) return null;
  const rest = title.slice(prefix.length);
  const sep = rest.indexOf(' › ');
  if (sep <= 0) return null;
  const file = rest.slice(0, sep);
  const name = rest.slice(sep + ' › '.length);
  if (!/\.e2e\.ts$/.test(file) || file.includes('..') || name === '') return null;
  return { file, title: name };
}

export function renderQuarantine(entries: readonly QuarantineEntry[]): string {
  return `${JSON.stringify(
    {
      tests: entries.map((e) => ({ file: e.file, title: e.title, issue: e.issue, until: e.until })),
    },
    null,
    2,
  )}\n`;
}

function sameTest(a: { file: string; title: string }, b: { file: string; title: string }): boolean {
  return a.file === b.file && a.title === b.title;
}

function applySteps(
  text: string,
  steps: readonly Pick<QuarantineMove, 'kind' | 'file' | 'title' | 'issue' | 'until'>[],
): string {
  let entries = parseQuarantine(text);
  for (const step of steps) {
    if (step.kind === 'enter') {
      if (entries.some((e) => sameTest(e, step))) continue;
      entries = [...entries, { file: step.file, title: step.title, issue: step.issue, until: step.until }];
    } else {
      entries = entries.filter((e) => !sameTest(e, step));
    }
  }
  return renderQuarantine(entries);
}

/** 把还要开 PR 的几步叠到当前文件上（已经有 PR 的移出不再写进这一份）。 */
export function quarantineAfter(text: string, moves: readonly QuarantineMove[]): string {
  return applySteps(
    text,
    moves.filter((m) => m.open),
  );
}

/**
 * 从 start 这一天往回数 need 天（含 start），每一天这条例的结局都是 passed。
 * start 优先今天；今天没有报告才退到昨天。再早、中间断一天、某天不是 passed，都不算连续全过。
 */
export function passedForDays(
  id: string,
  days: readonly QuarantineDay[],
  today: string,
  need = QUARANTINE_PASS_DAYS,
): boolean {
  const byDay = new Map<string, string>();
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) throw new Error(`隔离集报告的日期认不出：${d.day}`);
    const got = d.outcomes.get(id);
    byDay.set(d.day, got ? got.outcome : 'absent');
  }
  const start = byDay.has(today) ? today : byDay.has(shiftDay(today, -1)) ? shiftDay(today, -1) : null;
  if (!start) return false;
  for (let i = 0; i < need; i++) {
    if (byDay.get(shiftDay(start, -i)) !== 'passed') return false;
  }
  return true;
}

function enterBody(file: string, title: string, issue: number, until: string): string {
  return [
    `**做了什么**：把偶发用例 \`${file} › ${title}\` 放进 \`${QUARANTINE_PATH}\`（照跑、照报，不挡发版）。按固定步骤改文件，不调模型。`,
    '',
    `**需求**：Refs #${issue}`,
    '',
    `限期 ${until}。`,
    '',
  ].join('\n');
}

function exitBody(file: string, title: string, issue: number): string {
  return [
    `**做了什么**：\`${file} › ${title}\` 在隔离集里连续 ${QUARANTINE_PASS_DAYS} 天全过，从 \`${QUARANTINE_PATH}\` 移出。按固定步骤改文件，不调模型。`,
    '',
    `**需求**：Refs #${issue}`,
    '',
  ].join('\n');
}

/**
 * 假仓里的隔离集 + 开着的单和 PR + 隔离集每天的结局 → 要开的 PR（或只补关的移出）。
 * 读不到文件、文件格式不对就抛，不把坏文件当成空的。
 */
export function planQuarantineSync(input: {
  repo: RepoView;
  openIssues: readonly { number: number; title: string }[];
  openPulls: readonly { number: number; title: string; body: string }[];
  days: readonly QuarantineDay[];
  today: string;
}): QuarantineMove[] {
  shiftDay(input.today, 0);
  const text = input.repo.read(QUARANTINE_PATH);
  if (text === undefined) throw new Error(`读不到 ${QUARANTINE_PATH}`);
  const entries = parseQuarantine(text);
  const mentioned = (issue: number) =>
    input.openPulls.some((p) => mentionsIssue(`${p.title}\n${p.body}`, issue));
  const moves: QuarantineMove[] = [];

  const issues = [...input.openIssues].sort((a, b) => a.number - b.number);
  for (const issue of issues) {
    if (!Number.isInteger(issue.number) || issue.number <= 0) {
      throw new Error(`单号认不出：${String(issue.number)}`);
    }
    const key = flakyIssueKey(issue.title);
    if (!key) continue;
    if (entries.some((e) => sameTest(e, key) || e.issue === issue.number)) continue;
    if (mentioned(issue.number)) continue;
    const until = shiftDay(input.today, QUARANTINE_PASS_DAYS);
    const step = { kind: 'enter' as const, file: key.file, title: key.title, issue: issue.number, until };
    moves.push({
      ...step,
      open: true,
      content: applySteps(text, [step]),
      prTitle: `隔离集：放进 #${issue.number}`,
      body: enterBody(key.file, key.title, issue.number, until),
    });
  }

  for (const entry of [...entries].sort((a, b) => a.issue - b.issue)) {
    if (!passedForDays(keyText(entry), input.days, input.today)) continue;
    const step = {
      kind: 'exit' as const,
      file: entry.file,
      title: entry.title,
      issue: entry.issue,
      until: entry.until,
    };
    moves.push({
      ...step,
      open: !mentioned(entry.issue),
      content: applySteps(text, [step]),
      prTitle: `隔离集：移出 #${entry.issue}`,
      body: exitBody(entry.file, entry.title, entry.issue),
    });
  }
  return moves;
}
