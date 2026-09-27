// 单子里问创始人（#259；docs/decisions/0003-fusion-flow.md 第 5 条第 2 步）：他多半不在场，问他不许卡住活。
// 提问一律带选项和推荐。这张单范围内的岔路按推荐先做、不等；超出这张单范围的另开一张单等他拍，这张单绕开它接着做；
// 碰人闸四类（对外发布、花钱、删数据、改标准）的也先按推荐做，只挡那一步（合并前等他批）。只有他本人才有的东西
// （账号、权限、登录）不算提问，是「这一块等他」（fleet blocked --needs access）。
// 他晚到的回答：选的就是推荐的只记一笔；选了别的，单子还没合就在下一个存档点交给主导改，已经合了就开后续单。
// 这里只判，不碰库和网络：后端收提问、引擎走存档点、对账开后续单、卡片写什么都照这里。

import { ASK_MAX_OPTIONS, type TaskState } from '@fleet-dao/shared';

/** 人闸四类：碰到的只挡那一步（合并前等人批）。 */
export const ASK_HOLDS = ['release', 'spend', 'delete', 'standard'] as const;
export type AskHold = (typeof ASK_HOLDS)[number];

export const ASK_HOLD_NAMES: Readonly<Record<AskHold, string>> = {
  release: '对外发布',
  spend: '花钱',
  delete: '删数据',
  standard: '改标准',
};

/** task = 这张单范围内的岔路；outside = 超出这张单的范围（另开单）；hold = 碰人闸四类。 */
export type AskScope = 'task' | 'outside' | 'hold';

/** 一次最多几个选项：和命令行本地挡的是同一个数（shared 的 agent-api.ts）。 */
export { ASK_MAX_OPTIONS };

/** 会话里怎么问（退回时原样告诉它）。 */
export const ASK_USAGE = 'fleet ask "<问题>" -o <甲> -o <乙> --recommend <甲>';

export interface AskInput {
  question: string;
  options?: readonly string[] | undefined;
  /** 推荐哪个：照抄其中一个选项。 */
  recommend?: string | undefined;
  /** 超出这张单的范围：另开一张单等他拍。 */
  outside?: boolean | undefined;
  /** 碰了人闸四类的哪一类。 */
  hold?: string | undefined;
}

export interface ScopedAsk {
  question: string;
  /** 推荐的排第一个（卡片上第一个按钮是主按钮）。 */
  options: string[];
  recommended: string;
  scope: AskScope;
  hold?: AskHold;
}

export type AskCheck = { ok: true; ask: ScopedAsk } | { ok: false; why: string };

const BLOCKED_HINT =
  '只有创始人本人才有的东西（账号、权限、登录）不是提问，用 fleet blocked "<缺什么>" --needs access';

/** 提问合不合格：至少两个选项、推荐的照抄其中一个；超出范围和人闸二选一。不合格的退回会话补齐，写明怎么补。 */
export function checkAsk(input: AskInput): AskCheck {
  const question = input.question.trim();
  if (!question) return { ok: false, why: '问题是空的' };
  const options: string[] = [];
  for (const raw of input.options ?? []) {
    const o = raw.trim();
    if (o && !options.includes(o)) options.push(o);
  }
  if (options.length < 2) {
    return {
      ok: false,
      why: `提问要带至少两个选项和推荐（${ASK_USAGE}）：引擎按推荐先做、不停下等，创始人之后改了会在下一个存档点告诉你。${BLOCKED_HINT}`,
    };
  }
  if (options.length > ASK_MAX_OPTIONS) {
    return {
      ok: false,
      why: `选项最多 ${ASK_MAX_OPTIONS} 个（现在 ${options.length} 个）：挑出最像样的几个`,
    };
  }
  const recommended = input.recommend?.trim() ?? '';
  if (!recommended) {
    return { ok: false, why: `没写推荐哪个（--recommend，照抄其中一个选项）：${ASK_USAGE}` };
  }
  if (!options.includes(recommended)) {
    return { ok: false, why: `推荐的「${recommended}」不在选项里：--recommend 要照抄其中一个选项` };
  }
  const hold = input.hold?.trim();
  if (input.outside && hold) {
    return {
      ok: false,
      why: '超出这张单范围的另开一张单（那张单自己管人闸）：--outside 和 --hold 只能选一个',
    };
  }
  if (hold !== undefined && hold !== '' && !(ASK_HOLDS as readonly string[]).includes(hold)) {
    return { ok: false, why: `人闸认不出：${hold}（只有 ${ASK_HOLDS.join('、')} 四类）` };
  }
  const ordered = [recommended, ...options.filter((o) => o !== recommended)];
  if (input.outside) return { ok: true, ask: { question, options: ordered, recommended, scope: 'outside' } };
  if (hold) {
    return {
      ok: true,
      ask: { question, options: ordered, recommended, scope: 'hold', hold: hold as AskHold },
    };
  }
  return { ok: true, ask: { question, options: ordered, recommended, scope: 'task' } };
}

/**
 * 他晚到的回答怎么算（只管按推荐先做了的：task、hold 两种）。
 * confirmed = 选的就是推荐的，只记一笔；applied = 选了别的，已经交给主导照改了；change = 选了别的、单子还没合，
 * 下一个存档点交给主导改；follow-up = 选了别的、这张单已经合了（没来得及改），开后续单；recorded = 选了别的、
 * 这张单没做成就停了（叫停、失败），只记下，重开时照他选的做。
 */
export type LateAnswer = 'confirmed' | 'applied' | 'change' | 'follow-up' | 'recorded';

export function lateAnswer(input: {
  recommended: string;
  answer: string;
  /** 主导已经照改了（存档点交出去了）。 */
  applied: boolean;
  taskState: TaskState;
}): LateAnswer {
  if (input.answer.trim() === input.recommended.trim()) return 'confirmed';
  if (input.applied) return 'applied';
  if (input.taskState === 'done') return 'follow-up';
  if (input.taskState === 'stopped' || input.taskState === 'failed') return 'recorded';
  return 'change';
}

/** 一条提问在库里的样子（判晚到的回答、记数要看的几样）。 */
export interface AskFacts {
  scope?: AskScope | undefined;
  recommended?: string | undefined;
  answer?: string | undefined;
  applied?: boolean | undefined;
}

export interface AskTally {
  /** 这张单范围内按推荐先做的（task）、碰人闸先按推荐做的（hold）。 */
  assumed: number;
  /** 其中他回了、选的就是推荐的。 */
  confirmed: number;
  /** 其中他回了、改选了别的（事后被改）。 */
  changed: number;
  /** 超出范围、另开单的。 */
  outside: number;
  /** 还是老样子（没带推荐）的提问：没法算进前面几样。 */
  legacy: number;
}

/** 按推荐先走、事后被改的次数（给检验制度用，#257）。 */
export function tallyAsks(asks: readonly AskFacts[]): AskTally {
  const t: AskTally = { assumed: 0, confirmed: 0, changed: 0, outside: 0, legacy: 0 };
  for (const a of asks) {
    if (a.scope === 'outside') t.outside += 1;
    else if ((a.scope === 'task' || a.scope === 'hold') && a.recommended !== undefined) {
      t.assumed += 1;
      if (a.answer === undefined) continue;
      if (a.answer.trim() === a.recommended.trim()) t.confirmed += 1;
      else t.changed += 1;
    } else t.legacy += 1;
  }
  return t;
}
