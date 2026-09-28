// issue 归类这道题（#448）问 Jev：题面、把握线、每日上限、记账都走 packages/jev 的题库（bank.ts 的 ISSUE_KIND），
// 和错误分流、停滞预判（jev-port.ts）并排的一份，不共用那边的 JevPort/JevReply（那套是给「选一条能撤回的动作」设计的
// choice/effect 抽象，这里只是「选需求/缺陷/杂项之一」，直接吃 Verdict 更直接）。
// 每次问都现找后端（和 /healthz 的 judge 项同一个 resolveJevBackend）：改了 jev.json、调度台换了判断路由都不用重启。
// 没接、起不来、没判出来一律交回「没判出来」，不当成「是」也不当成「否」（issue-groom.ts 的 categoryPlan 再判该不该贴）。
import type { JevKindAnswer, KindLabel } from '@fleet-dao/conventions';
import type { Db } from '@fleet-dao/db';
import {
  createJev,
  ISSUE_KIND,
  type JevSetup,
  jevConfigLocation,
  REASON_TEXT,
  type ResolveOptions,
  resolveJevBackend,
  syncQuestionBank,
  type Verdict,
} from '@fleet-dao/jev';

/** 题库的选项 id → 类别标签：和 packages/jev 的 bank.ts、packages/conventions 的 KIND_LABELS 是同一条规矩，改名三边一起改。 */
const OPTION_TO_KIND: Readonly<Record<string, KindLabel>> = { feature: '需求', bug: '缺陷', chore: '杂项' };

/** Verdict → issue-groom.ts 认的两种「没判出来」：unsure（问出去答了、把握不够）是 low_confidence；其余一律 unreachable（没问成）。 */
export function issueKindAnswerOf(v: Verdict): JevKindAnswer {
  if (v.judged) {
    const kind = OPTION_TO_KIND[v.option];
    if (!kind) return { judged: false, reason: 'unreachable', detail: `题库的选项「${v.option}」认不出` };
    return { judged: true, kind, confidence: v.confidence };
  }
  const detail = `${REASON_TEXT[v.reason]}：${v.detail}`;
  return v.reason === 'unsure'
    ? { judged: false, reason: 'low_confidence', detail }
    : { judged: false, reason: 'unreachable', detail };
}

export interface IssueKindJevDeps {
  db: Db;
  /** 现找后端（生产：resolveJevBackend 读 jev.json、判断阶段排第一的路由、钥匙文件）。 */
  resolve: () => Promise<JevSetup>;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 问一次「这张 issue 是哪一类」。不抛：任何出错都变成一个没判出来的答案。 */
export function createIssueKindAsker(
  deps: IssueKindJevDeps,
): (issue: { number: number; title: string; body: string }) => Promise<JevKindAnswer> {
  const log = deps.log ?? ((message, fields) => console.error(message, fields ?? {}));
  return async (issue) => {
    const setup = await deps.resolve();
    if (setup.state === 'absent') {
      return { judged: false, reason: 'unreachable', detail: `本机没接判断题（没有 ${setup.path}）` };
    }
    if (setup.state === 'broken') {
      log('判断题起不来，issue 归类这一问照默认走（不贴、进日报）', {
        issue: issue.number,
        problem: setup.problem,
      });
      return { judged: false, reason: 'unreachable', detail: `判断题起不来：${setup.problem}` };
    }
    const jev = createJev({
      db: deps.db,
      backend: setup.backend,
      route: setup.routeId,
      ...(deps.now ? { now: deps.now } : {}),
    });
    const evidence = `标题：${issue.title}\n\n正文：${issue.body}`;
    const v = await jev.ask(
      ISSUE_KIND,
      { issue: evidence },
      { subject: `issue-groom:${issue.number}`, ref: { issue: issue.number } },
    );
    return issueKindAnswerOf(v);
  };
}

export interface IssueKindRegistration {
  level: 'info' | 'error';
  message: string;
}

/** 起来时把这道题登记进库（没有的登记成只记不拦；题面改了的更新，在真拦的退回只记不拦）。不抛：起不来不该挡引擎接活。 */
export async function registerIssueKindQuestion(deps: IssueKindJevDeps): Promise<IssueKindRegistration> {
  const setup = await deps.resolve();
  if (setup.state === 'absent') {
    return { level: 'info', message: `issue 归类没接：本机没有 ${setup.path}，这个功能只贴人手动贴的类别` };
  }
  if (setup.state === 'broken') {
    return { level: 'error', message: `issue 归类的判断题起不来，先不问：${setup.problem}` };
  }
  try {
    const changes = await syncQuestionBank(deps.db, [ISSUE_KIND], {
      model: setup.backend.model,
      actor: 'engine',
    });
    const what = changes.length
      ? changes
          .map(
            (c) =>
              `${c.id} ${c.change === 'added' ? '新登记（只记不拦）' : '题面更新'}${c.demoted ? '，退回只记不拦' : ''}`,
          )
          .join('；')
      : '题已经登记过了';
    return {
      level: 'info',
      message: `issue 归类已接（路由 ${setup.routeId}，模型 ${setup.backend.model}）：${what}`,
    };
  } catch (err) {
    const problem =
      err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { level: 'error', message: `issue 归类登记不进库，先不问：${problem}` };
  }
}

/** 生产装配（real/index.ts）：和 jev-port.ts 的 engineJevFromEnv 同一套找法（同一份 FLEET_JEV_CONFIG）。 */
export function issueKindJevFromEnv(
  db: Db,
  env: Readonly<Record<string, string | undefined>>,
  options: Pick<ResolveOptions, 'makeBackend'> & Pick<IssueKindJevDeps, 'log' | 'now'> = {},
): {
  askKind: (issue: { number: number; title: string; body: string }) => Promise<JevKindAnswer>;
  register: () => Promise<IssueKindRegistration>;
} {
  const where = jevConfigLocation(env);
  const deps: IssueKindJevDeps = {
    db,
    resolve: () =>
      resolveJevBackend(db, {
        ...where,
        ...(options.makeBackend ? { makeBackend: options.makeBackend } : {}),
      }),
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return { askKind: createIssueKindAsker(deps), register: () => registerIssueKindQuestion(deps) };
}
