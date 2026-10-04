import type { DeliveryCheck } from '@fleet-dao/adapters';
import { PLAN_DOC } from '@fleet-dao/conventions';
import { errMessage } from '@fleet-dao/shared/util';
import { PortError, type SessionOutput } from '../ports.ts';
import {
  type LeadOutputKind,
  OUTPUT_FILES,
  type Parsed,
  parseLeadBrief,
  parseLeadPlan,
  parseLeadRebut,
  parseLeadReview,
  parseLeadText,
  parseLeadVerdict,
  parsePlan,
  parseRequirementDoc,
  parseReview,
  parseTriage,
  parseVerify,
} from './prompts.ts';
import type { Live } from './session-live.ts';
import type { createTree } from './session-tree.ts';
import { SHA } from './session-util.ts';
import {
  changedFilesSince,
  commitsSince,
  headOf,
  ownSpan,
  readFileAs,
  uncommittedTracked,
} from './user-git.ts';

export function createOutput(parts: Pick<ReturnType<typeof createTree>, 'treeAs'>) {
  const { treeAs } = parts;

  async function deliveryCheck(
    live: Live,
  ): Promise<{ check: DeliveryCheck; head?: string; changed: string[] }> {
    const base = live.baseHead;
    const target = base ?? '（没给起会话前的头）';
    const t = treeAs(live.dir, live.user, `done-${live.runId}`);
    try {
      const head = await headOf(t);
      const dirty = await uncommittedTracked(t);
      if (dirty.length > 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            uncommitted: dirty.length,
            detail: `工作树里有没提交的已跟踪改动（引擎只推提交，这部分会丢）：${dirty.slice(0, 5).join('；')}`,
          },
          head,
          changed: [],
        };
      }
      if (!base || !SHA.test(base)) {
        return {
          check: { state: 'unknown', target, detail: '没给起会话前的头，判不了有没有新提交' },
          head,
          changed: [],
        };
      }
      // 并进来的主线不算这一步交的（user-git.ts 的 ownSpan）：只并了主线、自己没写东西的不算交了
      const span = head === base ? null : await ownSpan(t, base, live.defaultBranch);
      const commits = span ? await commitsSince(t, span, 50) : [];
      if (!span || commits.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: 0,
            detail: `起会话前的头 ${base.slice(0, 7)} 之后没有新提交（并进来的主线不算）`,
          },
          head,
          changed: [],
        };
      }
      const changed = await changedFilesSince(t, span);
      if (changed.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: commits.length,
            hasDiff: false,
            detail: '有新提交，但除了并进来的主线，和起会话前比没有内容差异',
          },
          head,
          changed,
        };
      }
      return {
        check: {
          state: 'delivered',
          target,
          newCommits: commits.length,
          hasDiff: true,
          uncommitted: 0,
          detail: `${commits.length} 个新提交，改了 ${changed.length} 个文件`,
        },
        head,
        changed,
      };
    } catch (error) {
      return { check: { state: 'unknown', target, detail: errMessage(error) }, changed: [] };
    }
  }

  async function readOutput(live: Live): Promise<Parsed<SessionOutput>> {
    const t = treeAs(live.dir, live.user, `out-${live.runId}`);
    const read = async (path: string) => {
      const text = await readFileAs(t, path);
      return text;
    };
    try {
      switch (live.kind) {
        case 'triage': {
          const text = await read(OUTPUT_FILES.triage[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.triage[0]}` };
          const v = parseTriage(text);
          return 'error' in v ? v : { ok: { kind: 'triage', verdict: v.ok } };
        }
        case 'doc': {
          const text = await read(OUTPUT_FILES.doc[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.doc[0]}` };
          // 「对应计划：」那一行要对得上检出副本里的 plan.md（仓里没有就只要写清）
          const plan = await read(PLAN_DOC);
          const v = parseRequirementDoc(text, plan ?? undefined);
          return 'error' in v ? v : { ok: { kind: 'doc', markdown: v.ok } };
        }
        case 'plan': {
          const [md, json] = await Promise.all([read(OUTPUT_FILES.plan[0]), read(OUTPUT_FILES.plan[1])]);
          if (md === null || json === null) {
            return {
              error: `会话结束了，但没写 ${md === null ? OUTPUT_FILES.plan[0] : OUTPUT_FILES.plan[1]}`,
            };
          }
          const v = parsePlan(md, json);
          return 'error' in v
            ? v
            : { ok: { kind: 'plan', markdown: v.ok.markdown, subtasks: v.ok.subtasks } };
        }
        case 'review': {
          const text = await read(OUTPUT_FILES.review[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.review[0]}` };
          const v = parseReview(text, live.reviewHead ?? '');
          return 'error' in v ? v : { ok: { kind: 'review', review: v.ok } };
        }
        case 'verify': {
          const text = await read(OUTPUT_FILES.verify[0]);
          if (text === null) return { error: `会话结束了，但没写结论 ${OUTPUT_FILES.verify[0]}` };
          const v = parseVerify(text, live.verifyCriteria ?? [], live.reviewHead ?? '');
          return 'error' in v ? v : { ok: { kind: 'verify', report: v.ok } };
        }
        case 'delivery':
          return { error: '写码会话不读结论文件' };
        case 'lead-plan':
        case 'lead-verdict':
        case 'lead-rebut':
        case 'lead-brief':
        case 'lead-review':
        case 'lead-text':
          return await readLeadOutput(live, live.kind, read);
      }
    } catch (error) {
      throw new PortError('READ_FAILED', `读会话交回来的结论文件没成：${errMessage(error)}`, {
        retryable: true,
      });
    }
  }

  /**
   * Lead 这一步交回的：结论文件（按这一步定名）加上工作树的样子。写方案、写结果那两步可以在分支上提交，头和这一步改到的
   * 文件从提交里读（不信文件里写的）；其余几步只看不改，头动了就算交错了。有没提交的已跟踪改动都算交错了（引擎只推提交）。
   */
  async function readLeadOutput(
    live: Live,
    kind: LeadOutputKind,
    read: (path: string) => Promise<string | null>,
  ): Promise<Parsed<SessionOutput>> {
    const file = OUTPUT_FILES[kind][0];
    const text = await read(file);
    if (text === null) return { error: `会话结束了，但没写结论 ${file}` };
    const t = treeAs(live.dir, live.user, `lead-${live.runId}`);
    const head = await headOf(t);
    const dirty = await uncommittedTracked(t);
    if (dirty.length > 0) {
      return {
        error: `工作树里有没提交的已跟踪改动（引擎只推提交，这部分会丢）：${dirty.slice(0, 5).join('；')}`,
      };
    }
    const base = live.baseHead;
    if (!base || !SHA.test(base)) return { error: '没给起会话前的头，判不了这一步提交了什么' };
    const commits = kind === 'lead-plan' || kind === 'lead-review';
    if (!commits && head !== base) {
      return {
        error: `这一步只看不改，头却从 ${base.slice(0, 7)} 变成了 ${head.slice(0, 7)}：用 git reset --hard ${base} 退回起这一步之前的头再交（要改的写进结论里）`,
      };
    }
    // 并进来的主线不算这一步改的（user-git.ts 的 ownSpan）
    const changedFiles =
      commits && head !== base ? await changedFilesSince(t, await ownSpan(t, base, live.defaultBranch)) : [];
    switch (kind) {
      case 'lead-plan': {
        const v = parseLeadPlan(text);
        return 'error' in v ? v : { ok: { kind, head, changedFiles, ...v.ok } };
      }
      case 'lead-review': {
        const v = parseLeadReview(text);
        return 'error' in v ? v : { ok: { kind, head, changedFiles, ...v.ok } };
      }
      case 'lead-verdict': {
        const v = parseLeadVerdict(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-rebut': {
        const v = parseLeadRebut(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-brief': {
        const v = parseLeadBrief(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-text': {
        const v = parseLeadText(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
    }
  }

  return { deliveryCheck, readOutput };
}
