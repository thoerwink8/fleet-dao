// 「这张单要干什么」：单子 + 需求文档 → 动手那一段的交代（specs/632-三段总调度/方案.md §五 的 readTaskBrief，切片 S2-1）。
//
// 判都在纯函数里（buildTaskBrief：三栏齐不齐、「怎么算做完」逐条、「已知的模块」、分档）；读 GitHub 的两下（读单子、
// 读主线上的需求文档）经 TaskBriefPorts 交进来，所以不接引擎、不接真 GitHub 就能测。缺什么**一次全报**（problems），
// 不拿空冒充齐：读不到单子、读不到需求文档（「文件不在」和「读失败」是两回事）都明确失败，不降级成「按标题猜着做」。
//
// 需求原文＝需求文档的全文（单子指着一份文档时，issue 上只留了概述）或单子正文自己（没指文档、正文写全了需求的单，#295）。
// 不拼装、不挑栏：「不许碰」「依据」这类栏里常有约束，挑了就丢。引擎写进正文的进度段不是需求，先去掉。
// 分档按「已知的模块」一次定死（decideTierFromModules）：写在反引号里的才认作路径，认不出的一项就不猜、走主力档。

import { type MdDoc, parseMd, requiredSectionProblems, sectionText } from '@fleet-dao/conventions';
import {
  cleanBody,
  criteriaOf,
  hasSpecPointer,
  REQUIREMENT_FILE,
  specDirOf,
  specShortName,
} from '@fleet-dao/core';
import { humanPart, type RepoRef } from '@fleet-dao/github';
import { type ManualBrief, ManualBriefSchema } from './brief.ts';
import { decideTierFromModules, type ModuleRef, type TierDecision } from './tier.ts';

export interface TaskIssue {
  number: number;
  title: string;
  /** 正文原样（可能带引擎写的进度段，buildTaskBrief 会去掉）。 */
  body: string;
  state: 'open' | 'closed';
}

/** 缺哪一栏、哪里不对、怎么补。field 是栏目名（场景、原话、已知的模块、涉及面、怎么算做完），或「单子」「需求文档」。 */
export interface BriefProblem {
  field: string;
  why: string;
}

/** 动手那一段要的交代（还没带分支和起点——那是建工作树时才有的，见 manualBriefOf）。 */
export interface TaskBrief {
  issueNumber: number;
  title: string;
  /** 需求原文：需求文档全文，或单子正文（去掉了注释和进度段）。 */
  request: string;
  /** 「怎么算做完」逐条原文。 */
  acceptance: string[];
  /** 「已知的模块」每一项的原文（「暂无」不算一项）。 */
  touches: string[];
  /** 需求文档目录：已经在主线上的那份，或正文自己写全了需求时将要建的（specs/<号>-<照标题取的短名>）。 */
  specDir: string;
  /** 主线上已经有这份需求文档（true）；false＝需求在单子正文里，文档要随 PR 进主线。 */
  specDocOnMain: boolean;
  tier: TierDecision;
}

export type TaskBriefResult = { ok: true; brief: TaskBrief } | { ok: false; problems: BriefProblem[] };

export interface BuildInput {
  issue: TaskIssue;
  /** 单子指着的需求文档（主线上读到的全文）；没有＝单子正文自己写全了需求。 */
  specDoc?: { dir: string; markdown: string } | undefined;
}

/** 单子里「已知的模块」写这些就是没写（「暂无」「（暂无）」「暂无（建单时没聊到）」）：不当成一项，也不当成「认不出」。 */
const NO_MODULES =
  /^(?:[（(]\s*(?:暂无|无|没有|未知|待定|不知道)[^（()）]*[）)]|(?:暂无|无|没有|未知|待定|不知道)\s*(?:[（(].*[）)])?)\s*[。.]?$/;

/** 一级列表项（缩进最多 3 格）：- * + 或「1.」「1)」。 */
const ITEM_START = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;

/**
 * 「已知的模块」一节拆成一项一项：列表里一个条目（连同续行）算一项；没写成列表的，一段话算一项。
 * 「暂无」这类占位不算项。
 */
export function moduleItems(section: string): string[] {
  const items: string[][] = [];
  let current: string[] | undefined;
  let gap = false;
  for (const line of section.split('\n')) {
    if (!line.trim()) {
      gap = true;
      continue;
    }
    if (ITEM_START.test(line)) {
      current = [line.replace(ITEM_START, '').trim()];
      items.push(current);
    } else if (current && (!gap || /^\s/.test(line))) {
      current.push(line.trim());
    } else {
      current = [line.trim()];
      items.push(current);
    }
    gap = false;
  }
  return items
    .map((lines) => lines.join(' ').replace(/\s+/g, ' ').trim())
    .filter((x) => x && !NO_MODULES.test(x));
}

const PATH_CHARS = /^[\p{L}\p{N}_.@~\-*/]+$/u;

/**
 * 反引号里的一段字是不是仓里的路径，是的话规整成 ModuleRef。认路径的规矩（宁可认不出，不往错里认）：
 * 带 / 的算路径；不带 / 的只有「像文件名」（扩展名以字母开头，或 .gitignore 这类点开头的）才算；
 * 带 * 的取通配前面那段目录；带空格、网址、绝对路径、.. 、=、: 的都不是。
 */
export function asModuleRef(raw: string): ModuleRef | undefined {
  const t0 = raw
    .trim()
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/^\.\//, '');
  if (!t0 || /\s/.test(t0) || t0.includes('://') || t0.startsWith('/') || t0.includes('..')) return undefined;
  if (!PATH_CHARS.test(t0)) return undefined;
  if (t0.includes('*')) {
    const segs = t0.split('/');
    const at = segs.findIndex((s) => s.includes('*'));
    const prefix = segs.slice(0, at).join('/');
    return prefix ? { path: prefix, kind: 'dir' } : undefined;
  }
  const slash = t0.endsWith('/');
  const path = t0.replace(/\/+$/, '');
  if (!path) return undefined;
  const last = path.split('/').pop() ?? '';
  const fileLike = /^.+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last) || /^\.[\w-]+$/.test(last);
  if (!slash && !path.includes('/') && !fileLike) return undefined;
  return { path, kind: !slash && fileLike ? 'file' : 'dir' };
}

/** 每一项里写在反引号里的路径；一项里一个路径都认不出，整项记进 unrecognized（不猜它指哪）。 */
export function moduleRefsOf(items: readonly string[]): { refs: ModuleRef[]; unrecognized: string[] } {
  const refs: ModuleRef[] = [];
  const unrecognized: string[] = [];
  for (const item of items) {
    const found = [...item.matchAll(/`([^`\n]+)`/g)]
      .map((m) => asModuleRef(m[1] ?? ''))
      .filter((r): r is ModuleRef => r !== undefined);
    if (found.length === 0) unrecognized.push(item);
    else refs.push(...found);
  }
  return { refs, unrecognized };
}

/** 问题列表说成一句人话（单子上留言、工作流报错都用它）。 */
export function describeBriefProblems(problems: readonly BriefProblem[]): string {
  return problems.map((p) => `【${p.field}】${p.why}`).join('\n');
}

/** 交代不全：工作流里当「不重试」的错（重试一百遍单子也不会自己补齐），err.problems 是逐项原因。 */
export class BriefIncompleteError extends Error {
  readonly code = 'BRIEF_INCOMPLETE';
  readonly problems: readonly BriefProblem[];
  constructor(issueNumber: number, problems: readonly BriefProblem[]) {
    super(`#${issueNumber} 的交代不全，不派：\n${describeBriefProblems(problems)}`);
    this.name = 'BriefIncompleteError';
    this.problems = problems;
  }
}

/** 拿到交代；不全就抛 BriefIncompleteError（不拿空交代往下走）。 */
export function briefOrThrow(issueNumber: number, result: TaskBriefResult): TaskBrief {
  if (!result.ok) throw new BriefIncompleteError(issueNumber, result.problems);
  return result.brief;
}

/** 纯函数：单子（加它指着的需求文档）→ 交代，或一次说全缺什么。 */
export function buildTaskBrief(input: BuildInput): TaskBriefResult {
  const { issue, specDoc } = input;
  const problems: BriefProblem[] = [];
  if (issue.state !== 'open') {
    problems.push({
      field: '单子',
      why: `#${issue.number} 已经关了：不派关掉的单（要重做请重开，或另开一张）`,
    });
  }
  const where = specDoc ? '需求文档' : '单子正文';
  const text = cleanBody(specDoc ? specDoc.markdown : humanPart(issue.body));
  if (!text) {
    problems.push({ field: specDoc ? '需求文档' : '单子', why: `${where}是空的：没有可做的需求` });
    return { ok: false, problems };
  }
  const doc: MdDoc = parseMd(specDoc ? `${specDoc.dir}/${REQUIREMENT_FILE}` : `#${issue.number}`, text);
  for (const p of requiredSectionProblems(doc)) problems.push({ field: p.label, why: p.why });
  const criteria = criteriaOf(text);
  if ('error' in criteria) {
    problems.push({
      field: '怎么算做完',
      why: `${criteria.error.replace(/^需求文档里/, `${where}里`)}：写成能检查的样子（测试名、脚本、真机上看到什么）`,
    });
  }
  if ('error' in criteria || problems.length > 0) return { ok: false, problems };

  const touches = moduleItems(sectionText(doc, '已知的模块') ?? '');
  const { refs, unrecognized } = moduleRefsOf(touches);
  return {
    ok: true,
    brief: {
      issueNumber: issue.number,
      title: issue.title.replace(/\s+/g, ' ').trim() || `#${issue.number}`,
      request: text,
      acceptance: criteria.ok,
      touches,
      specDir: specDoc ? specDoc.dir : `specs/${issue.number}-${specShortName(issue.title)}`,
      specDocOnMain: specDoc !== undefined,
      tier: decideTierFromModules(refs, unrecognized),
    },
  };
}

export interface TaskBriefPorts {
  /** 现读这张单。读不到抛错（不回空）。 */
  readIssue(input: { repo: RepoRef; issueNumber: number }): Promise<TaskIssue>;
  /** 读主线上的需求文档。文件不在回 null；读失败（网络、权限）抛错，不回 null。 */
  readSpecDoc(input: { repo: RepoRef; path: string }): Promise<{ content: string } | null>;
}

/** 现读单子和它指着的需求文档，拼出交代。单子读不到、文档读失败：抛错；文档不在、栏缺了：回 problems。 */
export async function readTaskBrief(
  ports: TaskBriefPorts,
  input: { repo: RepoRef; issueNumber: number },
): Promise<TaskBriefResult> {
  const { repo, issueNumber } = input;
  const issue = await ports.readIssue({ repo, issueNumber });
  if (issue.number !== issueNumber) {
    throw new Error(`读 #${issueNumber} 读回来的是 #${issue.number}：端口读错了单`);
  }
  if (!hasSpecPointer(issue.body)) return buildTaskBrief({ issue });
  const dir = specDirOf(issue.body, issueNumber);
  if ('error' in dir) return { ok: false, problems: [{ field: '需求文档', why: dir.error }] };
  const path = `${dir.ok}/${REQUIREMENT_FILE}`;
  const doc = await ports.readSpecDoc({ repo, path });
  if (doc === null) {
    return {
      ok: false,
      problems: [
        {
          field: '需求文档',
          why: `单子指着 ${path}，可主线上没有这个文件（还在没合的 PR 里？先合进主线再派）`,
        },
      ],
    };
  }
  return buildTaskBrief({ issue, specDoc: { dir: dir.ok, markdown: doc.content } });
}

/** 交代加上建工作树时才有的分支和起点，成为动手那一段的 brief（过一遍 zod，形状不对当场红）。 */
export function manualBriefOf(brief: TaskBrief, git: { branch: string; baseSha: string }): ManualBrief {
  return ManualBriefSchema.parse({
    kind: 'manual',
    title: brief.title,
    request: brief.request,
    acceptance: brief.acceptance,
    touches: brief.touches,
    // 文档还没进主线（需求在单子正文里）时不给：提示词里写「对照这份」，对不上就是误导
    ...(brief.specDocOnMain ? { specDir: brief.specDir } : {}),
    branch: git.branch,
    baseSha: git.baseSha,
  });
}
