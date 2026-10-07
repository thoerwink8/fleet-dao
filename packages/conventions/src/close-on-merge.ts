// PR 合并那一步自动收口（#995 拍 1 的 A，决定 0020 第 1 条）：.github/workflows/close-on-merge.yml 在 PR 合并后跑
// node packages/conventions/src/bin/close-on-merge.ts --pr <号>，这里读这张 PR「需求」栏挂的单，该关的用 issueClose 的逻辑关。
// 为什么要有它：关单只有「PR 写 Closes（合并时 GitHub 自己关）」和「人手 pnpm issue:close」两条，都要人主动做；
// 没写 Closes、只写 Refs 的活做完了没人关（#593、#76、#323 就是这么一直挂着的）。
// 条件收紧到「这张单明摆着是做完了的一张叶子单」，误关有意留着的单比漏关更糟（漏关有 github-audit 每天的「有合并 PR 提到、却还开着」兜底）：
// - 这张 PR 已经合进主线；引擎任务流程的 PR（分支 fleet/<单号>-t<8 位>）不碰：引擎的单它自己关；
// - 只看「需求」栏里同仓的 Closes / Refs；Refs 那一行写了「分片、关不了它」的是有意只挂不关，不碰；
// - 单还开着、是单不是 PR；贴了「母单」标签的不碰（母单由指挥官收口）；下面有子单还开着的不碰（issueClose 也拒）；
// - 「本机做」标签的单只认 Closes 的（GitHub 自己会关），Refs 不碰：它是指挥官留给本机的，没人明说做完不替它关；
// - 还有别的开着的 PR 的「需求」栏挂着同一张单：活还在做，不碰（接力分片常这么排）。
// 读不到、认不出一律抛 CloseUnchecked（退出码 2，不当成没事）；关的那一步由 issueClose 做并回读核对。
// 改这里之前必须知道：
// - 「无在跑工作流」在 GitHub 这一侧读不到引擎的状态，用上面两条（引擎的 PR 不碰、别的开着的 PR 还挂着它不碰）近似。
// - 测试在 test/close-on-merge.test.ts，每条「不碰」一个故意造出来的例子。

import { isFlowBranch } from './flow-branch.ts';
import { CloseRefused, CloseUnchecked, issueClose } from './issue-close.ts';
import type { Gh, GhResult } from './issue-new.ts';
import { LOCAL_LABEL, MOTHER_LABEL } from './labels.ts';
import { type IssueColumnLink, issueColumnLinks } from './pr-columns.ts';

export type MergeCloseOutcome =
  | { number: number; outcome: 'closed'; evidence: string }
  /** 没关：why 写清为什么（这是正常路径，不是错）。 */
  | { number: number; outcome: 'kept'; why: string };

export interface CloseOnMergeResult {
  pr: number;
  /** PR 没合并、是引擎的 PR、需求栏没挂单：整张 PR 不碰，说明在 note。 */
  note?: string;
  outcomes: MergeCloseOutcome[];
}

const OPEN_PRS_PAGE = 100;

/**
 * 这张单「有意留着」的几种写法，合并收口（这里）和每日对账（github-audit.ts）认同一套：有就返回为什么不碰，没有返回 undefined。
 * 单是不是开着、是不是 PR、别的 PR 还挂着没有，各用各的读法判，不在这里。
 */
export function whyLeave(link: IssueColumnLink, labels: readonly string[]): string | undefined {
  if (link.kind === 'refs' && link.slice) return 'Refs 那一行写明是分片、关不了它：有意只挂不关';
  if (labels.includes(MOTHER_LABEL)) return `贴了「${MOTHER_LABEL}」标签：母单由指挥官收口`;
  if (link.kind === 'refs' && labels.includes(LOCAL_LABEL)) {
    return `贴了「${LOCAL_LABEL}」标签、这里只是 Refs：没人明说做完，不替它关`;
  }
  return undefined;
}

export async function closeOnMerge(pr: number, deps: { gh: Gh }): Promise<CloseOnMergeResult> {
  const { gh } = deps;
  const pull = obj(
    await readJson(gh, ['api', `repos/{owner}/{repo}/pulls/${pr}`], `读 PR #${pr}`),
    `PR #${pr}`,
  );
  const head = obj(pull.head, `PR #${pr} 的 head`);
  const base = obj(pull.base, `PR #${pr} 的 base`);
  if (typeof head.ref !== 'string' || typeof base.ref !== 'string' || typeof pull.title !== 'string') {
    throw new CloseUnchecked(`gh 读 PR #${pr}：读回来的 head.ref、base.ref、title 认不出，没收口。`);
  }
  if (pull.body !== null && typeof pull.body !== 'string') {
    throw new CloseUnchecked(`gh 读 PR #${pr}：读回来的 body 认不出，没收口。`);
  }
  if (typeof pull.merged_at !== 'string' || !pull.merged_at) {
    return { pr, note: `PR #${pr} 没合并，不收口。`, outcomes: [] };
  }
  if (isFlowBranch(head.ref)) {
    return {
      pr,
      note: `PR #${pr} 是引擎任务流程的 PR（${head.ref}）：它的单引擎自己关，不碰。`,
      outcomes: [],
    };
  }
  const links = issueColumnLinks(pull.body ?? '');
  if (links.length === 0) return { pr, note: `PR #${pr} 的「需求」栏没挂单，没有要收口的。`, outcomes: [] };

  // 别的开着的 PR 还挂着哪些单（读一次；翻不完当没读全，抛）
  const stillWorked = await issuesOfOpenPulls(gh, pr);

  const outcomes: MergeCloseOutcome[] = [];
  for (const link of links) {
    outcomes.push(await settle(gh, { pr, title: pull.title, link, stillWorked }));
  }
  return { pr, outcomes };
}

async function settle(
  gh: Gh,
  a: { pr: number; title: string; link: IssueColumnLink; stillWorked: ReadonlySet<number> },
): Promise<MergeCloseOutcome> {
  const { link, pr } = a;
  const n = link.number;
  const kept = (why: string): MergeCloseOutcome => ({ number: n, outcome: 'kept', why });

  if (link.kind === 'refs' && link.slice) return kept(whyLeave(link, []) ?? '');
  const issue = obj(await readJson(gh, ['api', `repos/{owner}/{repo}/issues/${n}`], `读 #${n}`), `#${n}`);
  if (
    issue.number !== n ||
    (issue.state !== 'open' && issue.state !== 'closed') ||
    !Array.isArray(issue.labels)
  ) {
    throw new CloseUnchecked(`gh 读 #${n}：读回来的 number、state、labels 认不出，没收口。`);
  }
  if (issue.pull_request !== undefined && issue.pull_request !== null) return kept('这个号是 PR，不是单');
  if (issue.state === 'closed') return kept('已经关了');
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : obj(l, `#${n} 的标签`).name));
  if (labels.some((l) => typeof l !== 'string')) {
    throw new CloseUnchecked(`gh 读 #${n}：有一个标签认不出（没有 name），没收口。`);
  }
  const why = whyLeave(link, labels as string[]);
  if (why) return kept(why);
  if (a.stillWorked.has(n)) return kept('还有别的开着的 PR 的「需求」栏挂着它：活还在做');

  try {
    const r = await issueClose(
      [
        String(n),
        '--note',
        `PR #${pr}「${a.title}」合并了，它的「需求」栏挂着这张单（${link.kind === 'closes' ? 'Closes' : 'Refs'}）、没有别的 PR 还挂着它：合并时自动收口（close-on-merge，决定 0020 第 1 条）。` +
          '收错了就重开它，并在 PR 的「需求」栏那一行写明「分片、关不了它」。',
      ],
      { gh },
    );
    if (r.outcome === 'already') return kept('已经关了');
    return { number: n, outcome: 'closed', evidence: r.evidence ?? '' };
  } catch (e) {
    // 条件不够（子单还开着等）是「不碰」，读不到、关不上才是没收口成
    if (e instanceof CloseRefused) return kept(e.message);
    throw e;
  }
}

/** 开着的 PR（除了这一张）「需求」栏挂的单号。一页读满就抛：没读全不能说「没有」。 */
async function issuesOfOpenPulls(gh: Gh, self: number): Promise<Set<number>> {
  const rows = await readJson(
    gh,
    ['api', `repos/{owner}/{repo}/pulls?state=open&per_page=${OPEN_PRS_PAGE}`],
    '读开着的 PR',
  );
  if (!Array.isArray(rows)) throw new CloseUnchecked('gh 读开着的 PR：读回来的不是列表，没收口。');
  if (rows.length >= OPEN_PRS_PAGE) {
    throw new CloseUnchecked(`开着的 PR 有 ${OPEN_PRS_PAGE} 张以上，这里只读一页，没读全，没收口。`);
  }
  const out = new Set<number>();
  for (const row of rows) {
    const r = obj(row, '一张开着的 PR');
    if (typeof r.number !== 'number' || (r.body !== null && typeof r.body !== 'string')) {
      throw new CloseUnchecked('gh 读开着的 PR：有一张认不出（没有 number、body），没收口。');
    }
    if (r.number === self) continue;
    for (const l of issueColumnLinks(r.body ?? '')) out.add(l.number);
  }
  return out;
}

async function readJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new CloseUnchecked(`gh ${what}失败（退出码 ${r.code}）：${detail(r)}，没收口。`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new CloseUnchecked(
      `gh ${what}读回来的不是 JSON（${e instanceof Error ? e.message : String(e)}），没收口。`,
    );
  }
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new CloseUnchecked(`gh 读回来的${what}认不出（不是一个对象），没收口。`);
  }
  return v as Record<string, unknown>;
}

function detail(r: GhResult): string {
  return (r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ');
}
