// Fusion 一张单怎么走（docs/decisions/0003-fusion-flow.md 第 5、7 条）：给当前状态和刚发生的事，判下一步做什么。
// 纯判断：不碰网络和库。工作流经引擎的 decide 调它，结果进历史；认不出的组合明说「不该出现」，不猜着往下走。

/**
 * 0 创单并讨论 → 1 收单 → 2 规划·拆块 → 3 方案评审 → 4 执行（含 Lead 验收）→ 5 验证 → 6 开 PR·过 CI（绿了 Lead 最终审查）
 * → 7 合并；母单按块循环 4–7，最后做母单级验证。
 */
export type Step =
  | 'discuss'
  | 'intake'
  | 'plan'
  | 'review'
  | 'execute'
  | 'verify'
  | 'pr'
  | 'final-review'
  | 'merge'
  | 'mother-verify'
  | 'done'
  | 'parked';

/** fusion = Lead 带副手（默认）；single = 单模型模式，额度不够时用。 */
export type Mode = 'fusion' | 'single';

/**
 * 副手打回最多 2 次（第 3 次 Lead 自己接手）；验证默认 1 轮、最多 2 轮（流程配置可以收到 1 轮）；开了 PR 之后回去改最多 3 轮
 * （CI 红、Lead 最终审查要改、合并前退回都算一轮）。
 */
export const FLOW_LIMITS = { reworks: 2, verifyRounds: 2, ciRounds: 3 } as const;

export interface FlowState {
  mode: Mode;
  step: Step;
  /** 母单做完所有块后多一次母单级验证；单独的小单没有。 */
  mother: boolean;
  /** 规划拆出几块（规划前是 0）；当前在第几块（从 0 起）。 */
  blocks: number;
  block: number;
  /** 这一块副手被打回几次。 */
  reworks: number;
  /** 这一块 Lead 已经自己接手。 */
  takeover: boolean;
  /** 这一块验证跑过几轮没过。 */
  verifyRounds: number;
  /** 这一块 CI 修过几轮（最终审查要改、合并前退回也算一轮：都是开了 PR 之后回去改）。 */
  ciRounds: number;
  /** 验证最多几轮（流程配置里的 verify.rounds，1–2）；不给按 FLOW_LIMITS.verifyRounds。 */
  verifyLimit?: number;
  /** 小单：跳过方案评审。 */
  small: boolean;
  /** 高风险：单模型模式下第 5 步只对它开。 */
  highRisk: boolean;
  /** 停下等人时，恢复后回到哪一步。 */
  resume?: Step;
  /** 停下等人的原因。 */
  why?: string;
}

export type FlowEvent =
  | { kind: 'discussed' }
  | { kind: 'intaken' }
  | { kind: 'planned'; blocks: number; small: boolean; highRisk: boolean; matchesDiscussion: boolean }
  | { kind: 'reviewed' }
  | { kind: 'accepted' }
  | { kind: 'rejected' }
  | { kind: 'verified'; verdict: 'pass' | 'block' }
  | { kind: 'ci'; state: 'green' | 'red' | 'unknown' }
  /** CI 绿了之后 Lead 的最终审查：过了进合并；要改就回第 6 步修一轮。 */
  | { kind: 'final-reviewed'; verdict: 'pass' | 'fix' }
  /** 合并前退回（合并队列退回要改、人闸没批）：回第 6 步修一轮。 */
  | { kind: 'merge-returned' }
  /**
   * 存档点读到创始人晚到的回答：按推荐先做了的，他改选了别的（#259，ask.ts 的 lateChanges）。交给 Lead 照改：还没开 PR 的
   * 回第 4 步执行，已经开了 PR 的算开了 PR 之后修一轮（和 CI 红同一本账）。prOpen = 这张单的 PR 开出来了。
   */
  | { kind: 'changed'; prOpen: boolean }
  | { kind: 'merged' }
  | { kind: 'mother-verified'; verdict: 'pass' | 'block' }
  | { kind: 'needs-human'; why: string }
  | { kind: 'resumed' };

/** 下一步要外壳去做的事。 */
export type FlowAction =
  | 'discuss'
  | 'intake'
  | 'plan'
  | 'review-plan'
  | 'dispatch'
  | 'lead-takeover'
  | 'verify'
  | 'open-pr'
  | 'fix-ci'
  | 'recheck-ci'
  | 'final-review'
  | 'merge'
  | 'verify-mother'
  | 'close'
  | 'wait-human';

export type FlowDecision = { ok: true; state: FlowState; action: FlowAction } | { ok: false; why: string };

export function startFlow(mode: Mode, mother: boolean, options: { verifyRounds?: number } = {}): FlowState {
  return {
    mode,
    step: 'discuss',
    mother,
    blocks: 0,
    block: 0,
    reworks: 0,
    takeover: false,
    verifyRounds: 0,
    ciRounds: 0,
    small: false,
    highRisk: false,
    ...(options.verifyRounds === undefined ? {} : { verifyLimit: options.verifyRounds }),
  };
}

const STEP_NAMES: Record<Step, string> = {
  discuss: '0 创单并讨论',
  intake: '1 收单',
  plan: '2 规划',
  review: '3 方案评审',
  execute: '4 执行',
  verify: '5 验证',
  pr: '6 开 PR',
  'final-review': '6 最终审查',
  merge: '7 合并',
  'mother-verify': '母单级验证',
  done: '已关单',
  parked: '等人',
};

/** 到了某一步该让外壳做的事（恢复等人、换块时用）。 */
function actionAt(state: FlowState): FlowAction {
  switch (state.step) {
    case 'discuss':
      return 'discuss';
    case 'intake':
      return 'intake';
    case 'plan':
      return 'plan';
    case 'review':
      return 'review-plan';
    case 'execute':
      return state.takeover ? 'lead-takeover' : 'dispatch';
    case 'verify':
      return 'verify';
    case 'pr':
      return state.ciRounds > 0 ? 'fix-ci' : 'open-pr';
    case 'final-review':
      return 'final-review';
    case 'merge':
      return 'merge';
    case 'mother-verify':
      return 'verify-mother';
    case 'done':
      return 'close';
    case 'parked':
      return 'wait-human';
  }
}

const go = (state: FlowState, patch: Partial<FlowState>, action: FlowAction): FlowDecision => {
  const next: FlowState = { ...state, ...patch };
  if (next.step !== 'parked') {
    delete next.resume;
    delete next.why;
  }
  return { ok: true, state: next, action };
};

const park = (state: FlowState, resume: Step, why: string): FlowDecision =>
  go(state, { step: 'parked', resume, why }, 'wait-human');

/** 换到下一块：每块自己的计数清零。 */
const freshBlock = { reworks: 0, takeover: false, verifyRounds: 0, ciRounds: 0 } as const;

function badState(state: FlowState): string | undefined {
  const counts: [string, number][] = [
    ['blocks', state.blocks],
    ['block', state.block],
    ['reworks', state.reworks],
    ['verifyRounds', state.verifyRounds],
    ['ciRounds', state.ciRounds],
  ];
  for (const [name, n] of counts) {
    if (!Number.isInteger(n) || n < 0) return `状态认不出：${name} = ${String(n)}`;
  }
  if (state.blocks > 0 && state.block >= state.blocks)
    return `状态认不出：第 ${state.block} 块，一共只有 ${state.blocks} 块`;
  if (state.blocks === 0 && state.block !== 0) return `状态认不出：还没拆块，却在第 ${state.block} 块`;
  if (state.step === 'parked' && state.resume === undefined)
    return '状态认不出：在等人，却没记恢复后回哪一步';
  const limit = state.verifyLimit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > FLOW_LIMITS.verifyRounds))
    return `状态认不出：验证最多 ${String(limit)} 轮（要 1–${FLOW_LIMITS.verifyRounds}）`;
  return undefined;
}

/** 规划之后、开 PR 之前的几步：他改选了别的，回第 4 步执行照改（Lead 接手了的这一块还是 Lead 写）。 */
const BEFORE_PR: readonly Step[] = ['review', 'execute', 'verify', 'pr'];
/** 开了 PR 以后的几步：他改选了别的，算开了 PR 之后修一轮。 */
const AFTER_PR: readonly Step[] = ['pr', 'final-review', 'merge'];

/**
 * 存档点读到他改选了别的（#259）：交给 Lead 照改。规划做完之前（方案还没有）、合进去以后（归对账开后续单）没有这一步，
 * 走到这里的都是外壳叫错了（null）。第 6 步开 PR 之前（pr 这一步刚要开 PR）和之后都是 pr：看 PR 开没开出来。
 */
function changedAt(state: FlowState, prOpen: boolean): FlowDecision | null {
  if (prOpen) return AFTER_PR.includes(state.step) ? fixRound(state, '创始人改选了别的，照改') : null;
  if (!BEFORE_PR.includes(state.step)) return null;
  const back: FlowState = { ...state, step: 'execute' };
  return go(state, { step: 'execute' }, actionAt(back));
}

/** 开了 PR 之后回去改一轮（CI 红、最终审查要改、合并前退回）：没用完就修，用完了停下等人。 */
function fixRound(state: FlowState, why: string): FlowDecision {
  if (state.ciRounds < FLOW_LIMITS.ciRounds) {
    return go(state, { step: 'pr', ciRounds: state.ciRounds + 1 }, 'fix-ci');
  }
  return park({ ...state, step: 'pr' }, 'pr', `${why}：开了 PR 之后已经修了 ${state.ciRounds} 轮`);
}

export function nextFlow(state: FlowState, event: FlowEvent): FlowDecision {
  const bad = badState(state);
  if (bad) return { ok: false, why: bad };
  const unexpected = (): FlowDecision => ({
    ok: false,
    why: `「${STEP_NAMES[state.step]}」这一步不该收到「${event.kind}」`,
  });

  if (state.step === 'done') return { ok: false, why: '这张单已经关了，不该再有事件' };

  if (event.kind === 'needs-human') {
    if (state.step === 'parked') return { ok: false, why: '已经在等人了，不该再叫一次' };
    if (!event.why.trim()) return { ok: false, why: '停下等人要写明原因' };
    return park(state, state.step, event.why.trim());
  }

  if (state.step === 'parked') {
    if (event.kind !== 'resumed') return unexpected();
    const back: FlowState = { ...state, step: state.resume as Step };
    return go(state, { step: back.step }, actionAt(back));
  }
  if (event.kind === 'resumed') return unexpected();

  if (event.kind === 'changed') return changedAt(state, event.prOpen) ?? unexpected();

  switch (state.step) {
    case 'discuss':
      return event.kind === 'discussed' ? go(state, { step: 'intake' }, 'intake') : unexpected();

    case 'intake':
      return event.kind === 'intaken' ? go(state, { step: 'plan' }, 'plan') : unexpected();

    case 'plan': {
      if (event.kind !== 'planned') return unexpected();
      if (!Number.isInteger(event.blocks) || event.blocks < 1) {
        return { ok: false, why: `规划没拆出能做的块（blocks = ${String(event.blocks)}）` };
      }
      const skipReview = state.mode === 'single' || event.small || event.matchesDiscussion;
      return go(
        state,
        {
          step: skipReview ? 'execute' : 'review',
          blocks: event.blocks,
          block: 0,
          small: event.small,
          highRisk: event.highRisk,
          ...freshBlock,
        },
        skipReview ? 'dispatch' : 'review-plan',
      );
    }

    case 'review':
      return event.kind === 'reviewed' ? go(state, { step: 'execute' }, 'dispatch') : unexpected();

    case 'execute': {
      if (event.kind === 'accepted') {
        const needVerify = state.mode === 'fusion' || state.highRisk;
        return needVerify ? go(state, { step: 'verify' }, 'verify') : go(state, { step: 'pr' }, 'open-pr');
      }
      if (event.kind !== 'rejected') return unexpected();
      if (state.mode === 'single') return { ok: false, why: '单模型模式没有副手，不该有「打回」' };
      if (state.takeover) return { ok: false, why: 'Lead 已经自己接手这一块，不该再有「打回」' };
      if (state.reworks < FLOW_LIMITS.reworks) {
        return go(state, { reworks: state.reworks + 1 }, 'dispatch');
      }
      return go(state, { takeover: true }, 'lead-takeover');
    }

    case 'verify': {
      if (event.kind !== 'verified') return unexpected();
      if (event.verdict === 'pass') return go(state, { step: 'pr' }, 'open-pr');
      const rounds = state.verifyRounds + 1;
      if (rounds < (state.verifyLimit ?? FLOW_LIMITS.verifyRounds)) {
        const back = { ...state, step: 'execute' as const };
        return go(state, { step: 'execute', verifyRounds: rounds }, actionAt(back));
      }
      return park({ ...state, verifyRounds: rounds }, 'execute', `验证 ${rounds} 轮都没过`);
    }

    case 'pr': {
      if (event.kind !== 'ci') return unexpected();
      // 绿了 Lead 最终审查、把结果.md 提交进这个 PR（两种模式都要：需求、方案、结果随 PR 进仓，引擎不直写主线）
      if (event.state === 'green') return go(state, { step: 'final-review' }, 'final-review');
      if (event.state === 'unknown') return go(state, {}, 'recheck-ci');
      if (state.ciRounds < FLOW_LIMITS.ciRounds) return go(state, { ciRounds: state.ciRounds + 1 }, 'fix-ci');
      return park(state, 'pr', `CI 修了 ${state.ciRounds} 轮还是红的`);
    }

    case 'final-review': {
      if (event.kind !== 'final-reviewed') return unexpected();
      if (event.verdict === 'pass') return go(state, { step: 'merge' }, 'merge');
      return fixRound(state, 'Lead 最终审查要改');
    }

    case 'merge': {
      if (event.kind === 'merge-returned') return fixRound(state, '合并前退回要改');
      if (event.kind !== 'merged') return unexpected();
      if (state.block + 1 < state.blocks) {
        return go(state, { step: 'execute', block: state.block + 1, ...freshBlock }, 'dispatch');
      }
      return state.mother
        ? go(state, { step: 'mother-verify' }, 'verify-mother')
        : go(state, { step: 'done' }, 'close');
    }

    case 'mother-verify': {
      if (event.kind !== 'mother-verified') return unexpected();
      if (event.verdict === 'pass') return go(state, { step: 'done' }, 'close');
      return park(state, 'plan', '母单级验证没过：按目标还没做到，要重新规划或按熔断收尾');
    }
  }
}
