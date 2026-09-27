// 关单对账（#241）：每天看一遍仓的现状，挑出三种要提醒的——
// - due：开着、下面没有子单、主线上有它的 结果.md、也没有开着的 PR 还引用它（「需求」栏、标题里的 (#号)、关单词）：
//   看着做完了没关；
// - mother：开着的母单，子单都关了：照母单的目标看能不能关；
// - no-result：最近关成「完成」、主线上却没有它的 结果.md（直接 gh issue close 关的、Closes 合并时关的都算；关成
//   「不做了」「重复」的不算）。
// 纯判断，不碰网络、不读钟（now 由调用方给）：引擎的 jobs/close-sweep.ts 每天经「引擎」机器人读现状、调这里，按结果在单上
// 留言一次、进驾驶舱提醒。「这张单有没有结果」和 pnpm issue:close、合并闸是同一份判断（close-rule.ts 的 resultDocOf）。
// 判不了的（子单一页没读全、关单时刻认不出）照实交回 unchecked，由调用方记没查成，不当成没有。
import { closingIssues, RESULT_FILE, resultDocOf } from './close-rule.ts';
import { linkedIssue } from './pr-labels.ts';

/** 关掉的单往回看几天。 */
export const CLOSE_LOOKBACK_DAYS = 30;

export type CloseKind = 'due' | 'mother' | 'no-result';
export const CLOSE_KINDS: readonly CloseKind[] = ['due', 'mother', 'no-result'];

export interface CloseSweepFacts {
  /** 主线上 specs/ 下的文件（仓内路径）。 */
  specsFiles: readonly string[];
  openIssues: readonly {
    number: number;
    title: string;
    /** total 是 GitHub 报的子单总数，open、closed 是读到的那些。 */
    subIssues: { total: number; open: readonly number[]; closed: readonly number[] };
  }[];
  closedIssues: readonly { number: number; title: string; stateReason: string | null; closedAt: string }[];
  openPulls: readonly { number: number; title: string; body: string }[];
}

export type CloseFinding =
  | { kind: 'due'; issue: number; title: string; result: string }
  | { kind: 'mother'; issue: number; title: string; subs: number[]; result: string | undefined }
  | { kind: 'no-result'; issue: number; title: string; closedAt: string };

export interface CloseSweep {
  findings: CloseFinding[];
  /** 判不了的，一条一句；kind 是它会落在哪一种提醒里（那一种的提醒这一轮不撤）。 */
  unchecked: { kind: CloseKind; text: string }[];
}

/** repo（owner/仓）给了，正文里写明别的仓的关单词不算引用这个仓的单。 */
export function closeSweep(facts: CloseSweepFacts, now: Date, repo?: string): CloseSweep {
  const findings: CloseFinding[] = [];
  const unchecked: CloseSweep['unchecked'] = [];
  const cited = new Set<number>();
  for (const pr of facts.openPulls) {
    const linked = linkedIssue(pr.body, pr.title);
    if (linked !== undefined) cited.add(linked);
    for (const n of closingIssues(pr.body, repo)) cited.add(n);
  }
  for (const issue of [...facts.openIssues].sort((a, b) => a.number - b.number)) {
    const result = resultDocOf(issue.number, facts.specsFiles);
    const subs = issue.subIssues;
    if (subs.total > 0) {
      if (subs.open.length + subs.closed.length < subs.total) {
        unchecked.push({
          kind: 'mother',
          text: `#${issue.number} 有 ${subs.total} 张子单，只读到 ${subs.open.length + subs.closed.length} 张，判不了是不是都关了`,
        });
      } else if (subs.open.length === 0) {
        findings.push({
          kind: 'mother',
          issue: issue.number,
          title: issue.title,
          subs: [...subs.closed].sort((a, b) => a - b),
          result,
        });
      }
      continue;
    }
    if (result && !cited.has(issue.number)) {
      findings.push({ kind: 'due', issue: issue.number, title: issue.title, result });
    }
  }
  const since = now.getTime() - CLOSE_LOOKBACK_DAYS * 24 * 60 * 60_000;
  for (const issue of [...facts.closedIssues].sort((a, b) => a.number - b.number)) {
    if (issue.stateReason !== 'completed') continue;
    const at = Date.parse(issue.closedAt);
    if (Number.isNaN(at)) {
      unchecked.push({ kind: 'no-result', text: `#${issue.number} 的关单时刻认不出（${issue.closedAt}）` });
      continue;
    }
    if (at < since || resultDocOf(issue.number, facts.specsFiles)) continue;
    findings.push({ kind: 'no-result', issue: issue.number, title: issue.title, closedAt: issue.closedAt });
  }
  return { findings, unchecked };
}

/** 单上那条留言的键：同一张单、同一种只留一次。 */
export function closeCommentKey(f: CloseFinding): string {
  return `close-sweep:${f.kind}`;
}

/** 单上那条留言（只留一次）。除了母单列的子单号，不写别的 #号：写了就会在那张单上多一条「被提到」。 */
export function closeComment(f: CloseFinding): string {
  const tail = '（关单对账，每天看一遍；这条只留一次。）';
  switch (f.kind) {
    case 'due':
      return [
        `看着做完了：主线上已经有这张单的结果 \`${f.result}\`，也没有开着的 PR 还引用它。`,
        `确认做完了就关：\`pnpm issue:close ${f.issue}\`（查过主线上有结果才关）；还有没做完的，写进结果的「还欠什么」、另开单挂上。${tail}`,
      ].join('\n\n');
    case 'mother': {
      const subs = f.subs.map((n) => `#${n}`).join('、');
      const next = f.result
        ? `主线上已有结果 \`${f.result}\`：照这张单的「怎么算做完」看一遍，做到了就 \`pnpm issue:close ${f.issue}\`。`
        : `照这张单的「怎么算做完」看一遍：做到了就写好 \`specs/${f.issue}-<短名>/${RESULT_FILE}\`、随 PR 合进主线，再 \`pnpm issue:close ${f.issue}\`；没做到的开子单挂上来。`;
      return [`子单都关了（${subs}）。`, `${next}${tail}`].join('\n\n');
    }
    case 'no-result':
      return [
        `这张单关成了「完成」，主线上却没有它的结果 \`specs/${f.issue}-<短名>/${RESULT_FILE}\`。`,
        `补一份（做成什么样、怎么验的、还欠什么），随 PR 合进主线。以后关单用 \`pnpm issue:close <单号>\`，它查过主线上有结果才关。${tail}`,
      ].join('\n\n');
  }
}

/** 驾驶舱提醒的键：一个仓、一种一条。 */
export function closeAlertKey(repo: string, kind: CloseKind): string {
  return `close-sweep:${repo}:${kind}`;
}

/** 一条提醒里最多列几张单。 */
export const CLOSE_ALERT_LINES = 30;

/** 一个仓、一种的驾驶舱提醒（这一种一张都没有时不报，由调用方撤）。 */
export function closeAlert(
  repo: string,
  kind: CloseKind,
  list: readonly CloseFinding[],
): { title: string; body: string } {
  const n = list.length;
  const title =
    kind === 'due'
      ? `${repo}：${n} 张单看着做完了没关`
      : kind === 'mother'
        ? `${repo}：${n} 张母单的子单都关了`
        : `${repo}：${n} 张单关成了完成却没有结果`;
  const head =
    kind === 'due'
      ? '主线上有它们的结果，也没有开着的 PR 还引用它们：确认做完了就 pnpm issue:close <单号>。'
      : kind === 'mother'
        ? '子单都关了：照母单的「怎么算做完」看一遍，做到了写好结果再 pnpm issue:close <单号>，没做到的开子单。'
        : `最近 ${CLOSE_LOOKBACK_DAYS} 天关成「完成」的单，主线上没有 specs/<单号>-<短名>/${RESULT_FILE}：补一份，随 PR 合进主线。`;
  const lines = list.slice(0, CLOSE_ALERT_LINES).map((f) => {
    const what =
      f.kind === 'due'
        ? f.result
        : f.kind === 'mother'
          ? `子单 ${f.subs.length} 张都关了${f.result ? `，结果 ${f.result}` : '，还没有结果'}`
          : `关于 ${f.closedAt.slice(0, 10)}`;
    return `- #${f.issue} ${oneLine(f.title)}：${what}`;
  });
  if (n > CLOSE_ALERT_LINES) lines.push(`- ……另有 ${n - CLOSE_ALERT_LINES} 张`);
  return {
    title,
    body: [
      head,
      '',
      ...lines,
      '',
      '每张单上也各留了一条言（只留一次）；这一种都处理完了，这条提醒自己撤。',
    ].join('\n'),
  };
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}
