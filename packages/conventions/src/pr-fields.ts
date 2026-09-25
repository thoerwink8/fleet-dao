// PR 必填栏：恰好一个类别标签、挂一个里程碑；正文「对应计划」写明 plan.md 的哪一条，「specs」写需求目录或「不适用」。
// 每缺一样给一句话：缺什么、怎么补。CI 的 pr-fields（.github/workflows/pr.yml）跑它；design 第七节「标签和里程碑不靠人记得贴」。
import { readFileSync } from 'node:fs';
import { isKindLabel, KIND_LABELS, milestonePhase } from './labels.ts';
import { parseMd, stripComments } from './markdown.ts';
import { findItem, itemExample, type PlanPhase, parsePlanRefs, phaseRange, planPhases } from './plan.ts';
import { fsRepo } from './repo.ts';

export const PLAN_COLUMN = '对应计划';
export const SPECS_COLUMN = 'specs';

export interface PrFacts {
  labels: readonly string[];
  /** 里程碑的名字；没挂是 null。 */
  milestone: string | null;
  body: string;
}

export interface RepoFacts {
  /** plan.md 的各阶段。 */
  phases: Map<number, PlanPhase>;
  /** 仓内相对路径在不在（这个 PR 检出来的样子）。 */
  exists(rel: string): boolean;
}

/**
 * 正文里的各栏：行首「**标题**：」起，到下一栏为止；标题不分大小写。
 * HTML 注释（模板里的提示）先去掉：只留着模板提示没填，这一栏就是空的。
 */
export function prColumns(body: string): Map<string, string> {
  const cols = new Map<string, string>();
  let current: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current !== undefined && !cols.has(current)) cols.set(current, buf.join('\n').trim());
  };
  for (const line of stripComments(body.replace(/\r\n?/g, '\n')).split('\n')) {
    const m = /^\s*\*\*([^*\n]+?)\*\*\s*[：:]\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined) {
      flush();
      current = m[1].trim().toLowerCase();
      buf = [m[2] ?? ''];
    } else if (current !== undefined) {
      buf.push(line);
    }
  }
  flush();
  return cols;
}

export function checkPrFields(pr: PrFacts, repo: RepoFacts): string[] {
  const problems: string[] = [];
  const range = phaseRange(repo.phases);

  const kinds = pr.labels.filter(isKindLabel);
  if (kinds.length === 0) {
    problems.push(
      `没贴类别标签：在 PR 右边的 Labels 里从${KIND_LABELS.map((k) => `「${k}」`).join('')}里挑一个贴上。`,
    );
  } else if (kinds.length > 1) {
    problems.push(`类别标签贴了 ${kinds.length} 个（${kinds.join('、')}）：只留一个。`);
  }

  let milestone: number | undefined;
  if (pr.milestone === null || !pr.milestone.trim()) {
    problems.push(`没挂里程碑：在 PR 右边的 Milestone 里挑这块活属于的阶段（${range}）。`);
  } else {
    milestone = milestonePhase(pr.milestone);
    if (milestone === undefined) {
      problems.push(`里程碑「${pr.milestone}」认不出是哪个阶段：换成 plan.md 的阶段（${range}）之一。`);
    } else if (!repo.phases.has(milestone)) {
      problems.push(`里程碑「${pr.milestone}」的 P${milestone} 在 plan.md 里没有：换成 ${range} 之一。`);
      milestone = undefined;
    }
  }

  const cols = prColumns(pr.body);
  problems.push(...checkPlan(cols.get(PLAN_COLUMN), milestone, repo, range));
  problems.push(...checkSpecs(cols.get(SPECS_COLUMN), repo));
  return problems;
}

function checkPlan(
  value: string | undefined,
  milestone: number | undefined,
  repo: RepoFacts,
  range: string,
): string[] {
  if (value === undefined) {
    return [
      '正文没有「对应计划」一栏：照 PR 模板加一行 **对应计划**：P1「工作流」（plan.md 的阶段加那一条的原话开头）。',
    ];
  }
  if (!value) return ['「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。'];
  const refs = parsePlanRefs(value);
  if (refs.length === 0) {
    return [
      `「对应计划」写的「${oneLine(value)}」认不出是 plan.md 哪一条：写成 P1「工作流」这样，阶段加那一条的原话开头。`,
    ];
  }
  const problems: string[] = [];
  for (const ref of refs) {
    const phase = repo.phases.get(ref.phase);
    const example = `P${ref.phase}「${itemExample(phase)}」`;
    if (!phase) {
      problems.push(
        `「对应计划」的 ${ref.raw} 在 plan.md 里没有 P${ref.phase} 这个阶段：阶段只有 ${range}。`,
      );
    } else if (ref.item === undefined) {
      problems.push(`「对应计划」的 P${ref.phase} 没写是哪一条：后面加上那一条的原话开头，比如 ${example}。`);
    } else if (!ref.item.trim()) {
      problems.push(
        `「对应计划」的 ${ref.raw} 引号里是空的：写上 P${ref.phase} 里那一条的原话开头，比如 ${example}。`,
      );
    } else if (findItem(phase, ref.item) === undefined) {
      problems.push(
        `「对应计划」的 ${ref.raw} 在 plan.md 的 P${ref.phase} 一节里找不到：照抄那一条的原话（开头几个字就行）。`,
      );
    }
  }
  if (milestone !== undefined && !refs.some((r) => r.phase === milestone)) {
    problems.push(
      `里程碑是 P${milestone}，「对应计划」里却没有 P${milestone} 的条目：改里程碑，或在「对应计划」里写上 P${milestone} 的哪一条。`,
    );
  }
  return problems;
}

function checkSpecs(value: string | undefined, repo: RepoFacts): string[] {
  if (value === undefined) {
    return ['正文没有「specs」一栏：照 PR 模板加一行 **specs**：specs/<号>-<短名>/，杂活写「不适用」。'];
  }
  const v = value.replace(/`/g, '').trim();
  if (!v) return ['「specs」一栏是空的：写需求文档的目录（specs/<号>-<短名>/），杂活写「不适用」。'];
  if (v.startsWith('不适用')) return [];
  // 链接也认（[specs/12-x/](https://…/specs/12-x)）：只取不在网址中间的那个
  const paths = [...v.matchAll(/(?<![\w./%-])specs\/[^\s、，,；;()（）[\]「」]+/g)].map((m) =>
    decode(m[0]).replace(/[。.]+$/, ''),
  );
  if (paths.length === 0) {
    return [
      `「specs」写的「${oneLine(v)}」不是 specs/ 下的需求目录：写成 specs/<号>-<短名>/，杂活写「不适用」。`,
    ];
  }
  return paths
    .filter((p) => p.split('/').includes('..') || !repo.exists(p.replace(/\/+$/, '')))
    .map((p) => `「specs」写的 ${p} 在这个 PR 里没有：先把需求.md 放进去，或者改成已有的目录。`);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

// —— CI 入口用：读 GitHub 发来的 pull_request 事件 ——

export interface PrEvent extends PrFacts {
  number: number;
}

/** 从事件里取 PR；认不出返回一句为什么。 */
export function prFromEvent(event: unknown): PrEvent | string {
  const pr = isObject(event) ? event.pull_request : undefined;
  if (!isObject(pr)) return '事件里没有 pull_request（这条检查只接 pull_request 事件）';
  const { number, labels, milestone, body } = pr;
  if (typeof number !== 'number') return '事件里的 pull_request 没有 number';
  if (!Array.isArray(labels) || !labels.every((l) => isObject(l) && typeof l.name === 'string')) {
    return 'pull_request.labels 认不出（应当是带 name 的列表）';
  }
  if (milestone !== null && !(isObject(milestone) && typeof milestone.title === 'string')) {
    return 'pull_request.milestone 认不出（应当是 null 或带 title 的对象）';
  }
  if (body !== null && body !== undefined && typeof body !== 'string') return 'pull_request.body 认不出';
  return {
    number,
    labels: labels.map((l) => String((l as { name: string }).name)),
    milestone: milestone === null ? null : String((milestone as { title: string }).title),
    body: typeof body === 'string' ? body : '',
  };
}

export interface RunResult {
  /** 0 = 都齐了；1 = 缺了；2 = 没查成（读不到事件或 plan.md），不能当成过了。 */
  code: 0 | 1 | 2;
  lines: string[];
}

export function runPrFields(opts: { eventPath: string | undefined; root: string }): RunResult {
  if (!opts.eventPath) {
    return {
      code: 2,
      lines: ['没查成：没有 GITHUB_EVENT_PATH（这条检查在 GitHub Actions 的 pull_request 事件里跑）。'],
    };
  }
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(opts.eventPath, 'utf8'));
  } catch (e) {
    return {
      code: 2,
      lines: [`没查成：事件文件 ${opts.eventPath} 读不出来（${e instanceof Error ? e.message : e}）。`],
    };
  }
  const pr = prFromEvent(event);
  if (typeof pr === 'string') return { code: 2, lines: [`没查成：${pr}。`] };
  const repo = fsRepo(opts.root);
  const planText = repo.read('docs/plan.md');
  if (planText === undefined) return { code: 2, lines: ['没查成：docs/plan.md 读不到。'] };
  const phases = planPhases(parseMd('docs/plan.md', planText));
  if (phases.size === 0)
    return { code: 2, lines: ['没查成：docs/plan.md 里一个阶段（### P0 …）也没认出来。'] };
  const problems = checkPrFields(pr, { phases, exists: repo.exists });
  if (problems.length === 0) {
    return { code: 0, lines: [`PR #${pr.number}：类别标签、里程碑、对应计划、specs 都齐了。`] };
  }
  return { code: 1, lines: problems };
}

/** GitHub Actions 的报错注解（在 PR 的检查页上直接显示）；% 和换行要转义。 */
export function annotation(message: string): string {
  return `::error::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
