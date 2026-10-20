// 指挥官会话交的裁决，引擎执行之前的白名单（#3294 第 2 片）。纯函数：只看停法、停下的标题、空转判断和裁决本身，不读库、不读时钟。
// 会话只交「继续 / 重做 / 拆单 / 停掉 / 留给人」加理由，引擎按下表核过才动手；表外的一律不执行，退成「只写诊断建议」。
//
//   停法                    继续      重做      拆单      停掉      留给人
//   轮数用尽                ✓         ✓         ✗         ✗         ✓     （已经继续满三次交指挥官的：继续没用，工作流会再停一次，只许重做）
//   体量超预算              ✗         ✗         ✓         ✓*        ✓     （*只在成果已由别的提交合进主线时：裁决带 mergedIn）
//   额度超预算·没空转        ✓+放宽    ✓         ✓         ✗         ✓     （看 decisions/spin.ts：判的是空转，不是钱）
//   额度超预算·空转          ✗         ✓         ✓         ✓         ✓     （不许原样继续）
//   额度超预算·没法判        ✗         ✗         ✗         ✗         ✓     （回合没读到：不拿「没读到」当「没有空转」）
//   认不出按临时的办 / 自动合并没挂上   ✓    ✓         ✗         ✗         ✓
//   改标准、没权限等人闸、别的   ✗         ✗         ✗         ✗         ✓     （只写诊断建议，不动）
//
// 「留给人」永远放行：它不动任务，只把诊断写进提醒。
// 体量停点的停掉（#3407）：#3207 停在体量超预算，成果已由 #3324、#3358 分片合进主线，指挥官只能拆单（把已合的活再开一遍）
// 或留给人，提醒挂着没人接。停掉只放弃这一代（PR、单子不动），比拆单少开子单；裁决必须写明主线上带着这份成果的提交号，
// 引擎核不了内容，提交号写进操作记录和提醒给人对照。

import type { ParkKind } from '../task-contract.ts';
import type { SpinJudgement } from './spin.ts';

export const COMMANDER_ACTIONS = ['continue', 'redo', 'split', 'stop', 'leave'] as const;
export type CommanderAction = (typeof COMMANDER_ACTIONS)[number];

export const COMMANDER_ACTION_WORDS: Readonly<Record<CommanderAction, string>> = {
  continue: '继续',
  redo: '重做',
  split: '拆单',
  stop: '停掉并报原因',
  leave: '留给人',
};

/** 拆成几张子单：至少 2、最多 5。 */
export const SPLIT_MIN = 2;
export const SPLIT_MAX = 5;

export const PARK_KIND_WORDS: Readonly<Record<ParkKind, string>> = {
  transient: '认不出、按临时的办',
  unarmed: '自动合并没挂上',
  rounds: '轮数用尽',
  quota: '额度超预算',
  size: '体量超预算',
  standard: '改标准等人闸',
  other: '别的（没权限等人闸）',
};

/** 引擎认得的一次停下。handoff＝已继续满三次、交指挥官的那一停。 */
export interface ParkFacts {
  kind: ParkKind;
  handoff: boolean;
}

/** 这一次停下，每个动作放不放行：放行 true，不放行写原因。 */
export type ActionTable = Record<CommanderAction, true | string>;

/**
 * 按停法列出放行的动作。spin 只有额度停法用得上：null＝回合没读到，没法判（只许留给人）。
 */
export function allowedActions(park: ParkFacts, spin: SpinJudgement | null): ActionTable {
  const base: ActionTable = {
    continue: '这种停法不许继续',
    redo: '这种停法不许重做',
    split: '这种停法不许拆单',
    stop: '只有额度超预算判成空转、或体量超预算而成果已在主线时才许停掉',
    leave: true,
  };
  switch (park.kind) {
    case 'rounds':
      return {
        ...base,
        continue: park.handoff ? '已经继续满三次仍没过，再继续工作流会原样再停一次，没有用' : true,
        redo: true,
      };
    case 'size':
      return { ...base, split: true, stop: true };
    case 'quota': {
      if (spin === null) {
        const why = '这张单的回合没读到，判不了空转，不放行任何动手的动作';
        return { ...base, continue: why, redo: why, split: why, stop: why };
      }
      if (spin.spinning) {
        return {
          ...base,
          continue: `判成空转，不许原样继续：${spin.summary}`,
          redo: true,
          split: true,
          stop: true,
        };
      }
      return { ...base, continue: true, redo: true, split: true };
    }
    case 'transient':
    case 'unarmed':
      return { ...base, continue: true, redo: true };
    default:
      return base;
  }
}

/** 会话交的一条裁决（会话原话，还没核）。 */
export interface RawVerdict {
  action: string;
  /** 拆单时会话给了几张子单（具体内容由执行那一边再核）。 */
  subtaskCount?: number | undefined;
  /** 体量停点判停掉时，主线上已经带着这份成果的提交号。 */
  mergedIn?: string | undefined;
}

/** 主线提交号的样子：7~40 位小写十六进制。 */
export const MERGED_IN_SHA = /^[0-9a-f]{7,40}$/;

export type VerdictCheck =
  | {
      ok: true;
      action: CommanderAction;
      /** 继续时是不是把额度预算放宽一档（额度超预算、没空转才放宽）。 */
      widenBudget: boolean;
    }
  | { ok: false; why: string };

/** 核一条裁决。不在表里的动作名、表里没放行的、拆单数不对，都回 ok:false 和原因。 */
export function checkVerdict(park: ParkFacts, spin: SpinJudgement | null, verdict: RawVerdict): VerdictCheck {
  const action = COMMANDER_ACTIONS.find((a) => a === verdict.action);
  if (action === undefined) {
    return {
      ok: false,
      why: `裁决「${verdict.action}」不在白名单里（只收 ${COMMANDER_ACTIONS.join('、')}）`,
    };
  }
  const allowed = allowedActions(park, spin)[action];
  if (allowed !== true) {
    return {
      ok: false,
      why: `停法「${PARK_KIND_WORDS[park.kind]}」不放行「${COMMANDER_ACTION_WORDS[action]}」：${allowed}`,
    };
  }
  if (action === 'split') {
    const n = verdict.subtaskCount ?? 0;
    if (n < SPLIT_MIN || n > SPLIT_MAX)
      return { ok: false, why: `拆单要给 ${SPLIT_MIN}~${SPLIT_MAX} 张子单，会话给了 ${n} 张` };
  }
  if (action === 'stop' && park.kind === 'size' && !MERGED_IN_SHA.test(verdict.mergedIn ?? '')) {
    return {
      ok: false,
      why: '体量超预算只在成果已由别的提交合进主线时才许停掉，裁决要带 mergedIn（主线上的提交号，7~40 位十六进制）',
    };
  }
  return { ok: true, action, widenBudget: action === 'continue' && park.kind === 'quota' };
}
