// 引擎这两道题（错误分流、停滞预判）交给 packages/jev 问：题面、选项、每日上限、记账、只记不拦都走那边的题库
// （bank.ts 的 ERROR_NEXT、STALL_STATE）。这里只做两件事：把引擎的题换成题库里那道、把判断换回引擎认的回答。
// 每次问都现找后端（和 /healthz 的 judge 项同一个 resolveJevBackend）：改了 jev.json、调度台换了判断路由都不用重启，
// 两边说法也一致。没接、起不来、没判出来一律交回「没判出来」，引擎照默认走，不当成「是」也不当成「否」。
import type { Db } from '@fleet-dao/db';
import {
  createJev,
  ERROR_NEXT,
  type JevSetup,
  jevConfigLocation,
  LOCAL_REASONS,
  REASON_TEXT,
  type ResolveOptions,
  resolveJevBackend,
  STALL_STATE,
  syncQuestionBank,
  type Verdict,
} from '@fleet-dao/jev';
import type { JevAskContext, JevPort, JevQuestion, JevReply } from '../failure/jev.ts';

/** 引擎问的两道题：引擎起来时登记进库（新登记的只记不拦）。 */
export const ENGINE_JEV_QUESTIONS = [ERROR_NEXT, STALL_STATE] as const;

/** 题库的选项 → 引擎的选项。 */
const FAILURE_CHOICES: Readonly<Record<string, string>> = {
  retry: 'retry',
  swap_route: 'swapRoute',
  swap_model: 'swapModel',
};
const STALL_CHOICES: Readonly<Record<string, string>> = {
  waiting: 'waiting',
  looping: 'looping',
  dead: 'dead',
};

/** 题库里有、引擎不让 Jev 选的：能拦不能放，失败分流只许它挑能撤回的动作（挂起要人或帅位定）。 */
const FAILURE_REFUSED: Readonly<Record<string, string>> = {
  park: 'Jev 判挂起：引擎只让它在能撤回的动作里选，挂起照兜底梯走到底才挂',
};

const isLocal = (reason: string) => (LOCAL_REASONS as readonly string[]).includes(reason);

/** 题库的判断 → 引擎的回答。没判出来的带着白话原因，写进分流、停滞结论的原因里。 */
export function replyOf<C extends string>(
  v: Verdict,
  choices: Readonly<Record<string, string>>,
  question: Pick<JevQuestion<C>, 'options'>,
  refused: Readonly<Record<string, string>> = {},
): JevReply<C> {
  if (!v.judged) {
    const reason = `${REASON_TEXT[v.reason]}：${v.detail}`;
    // 本地就拦下、没问出去的（停用、到了每日上限、库出错……）是「没问」；问出去没判出来的是「问了没判出来」。
    return isLocal(v.reason) ? { asked: false, reason } : { asked: true, ok: false, reason };
  }
  const why = refused[v.option];
  if (why) return { asked: true, ok: false, reason: why };
  const choice = choices[v.option];
  if (choice === undefined || !(question.options as readonly string[]).includes(choice)) {
    return { asked: true, ok: false, reason: `题库的选项「${v.option}」引擎认不出` };
  }
  return {
    asked: true,
    ok: true,
    choice: choice as C,
    confidence: v.confidence,
    shadow: !v.enforced,
    modelVersion: v.model,
  };
}

export interface EngineJevDeps {
  db: Db;
  /** 现找后端（生产：resolveJevBackend 读 jev.json、判断阶段排第一的路由、钥匙文件）。 */
  resolve: () => Promise<JevSetup>;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createEngineJevPort(deps: EngineJevDeps): JevPort {
  const log = deps.log ?? ((message, fields) => console.error(message, fields ?? {}));
  return {
    async ask<C extends string>(question: JevQuestion<C>, ctx?: JevAskContext): Promise<JevReply<C>> {
      const setup = await deps.resolve();
      if (setup.state === 'absent') return { asked: false, reason: `本机没接判断题（没有 ${setup.path}）` };
      if (setup.state === 'broken') {
        log('判断题起不来，这一问照默认走', { question: question.questionId, problem: setup.problem });
        return { asked: false, reason: `判断题起不来：${setup.problem}` };
      }
      const jev = createJev({
        db: deps.db,
        backend: setup.backend,
        route: setup.routeId,
        ...(deps.now ? { now: deps.now } : {}),
      });
      const about = ctx?.about?.trim() || '（没给）';
      const askCtx = { subject: ctx?.subject?.trim() || `engine:${question.questionId}` };
      if (question.questionId === 'failure-triage') {
        const v = await jev.ask(ERROR_NEXT, { step: about, message: question.sample }, askCtx);
        return replyOf(v, FAILURE_CHOICES, question, FAILURE_REFUSED);
      }
      if (question.questionId === 'stall-predict') {
        const v = await jev.ask(STALL_STATE, { task: about, recent: question.sample }, askCtx);
        return replyOf(v, STALL_CHOICES, question);
      }
      return { asked: false, reason: `题库里没有 ${String(question.questionId)} 这道题` };
    },
  };
}

/** 起来时登记的结果：level = error 的是配置坏了或登记不进库，要人看（只打日志，不挡引擎接活）。 */
export interface JevRegistration {
  level: 'info' | 'error';
  message: string;
}

/**
 * 引擎起来时读一遍配置、建一遍后端，把两道题登记进库（没有的登记成只记不拦，钉在判断路由的模型上；题面改了的更新，
 * 在真拦的退回只记不拦）。不抛：Jev 只是帮着判，起不来、登记不上都不该挡住引擎接活——原因打进日志，/healthz 的 judge 项报红。
 */
export async function registerEngineJevQuestions(deps: EngineJevDeps): Promise<JevRegistration> {
  const setup = await deps.resolve();
  if (setup.state === 'absent') {
    return { level: 'info', message: `判断题没接：本机没有 ${setup.path}，错误分流、停滞预判照规则走` };
  }
  if (setup.state === 'broken') {
    return { level: 'error', message: `判断题起不来，错误分流、停滞预判先照规则走：${setup.problem}` };
  }
  try {
    const changes = await syncQuestionBank(deps.db, ENGINE_JEV_QUESTIONS, {
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
      : '两道题都登记过了';
    return {
      level: 'info',
      message: `判断题已接（路由 ${setup.routeId}，模型 ${setup.backend.model}）：${what}`,
    };
  } catch (err) {
    const problem =
      err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { level: 'error', message: `判断题登记不进库，错误分流、停滞预判先照规则走：${problem}` };
  }
}

/**
 * 生产装配（real/index.ts）：配置在哪按环境变量定（FLEET_JEV_CONFIG，默认 /etc/fleet-dao/jev.json，和驾驶舱后端的
 * /healthz 读同一份），交回提问端口和起来时的登记。makeBackend 只给测试用（TypeSafe 后端在测试里不出网）。
 */
export function engineJevFromEnv(
  db: Db,
  env: Readonly<Record<string, string | undefined>>,
  options: Pick<ResolveOptions, 'makeBackend'> & Pick<EngineJevDeps, 'log' | 'now'> = {},
): { port: JevPort; register: () => Promise<JevRegistration> } {
  const where = jevConfigLocation(env);
  const deps: EngineJevDeps = {
    db,
    resolve: () =>
      resolveJevBackend(db, {
        ...where,
        ...(options.makeBackend ? { makeBackend: options.makeBackend } : {}),
      }),
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return { port: createEngineJevPort(deps), register: () => registerEngineJevQuestions(deps) };
}
