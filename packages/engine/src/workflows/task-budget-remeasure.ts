// 体量关口重评（#3249）的工作流侧纯判断：停点身份比对、请求形状、活动回答的裁决。全是纯函数，不碰活动、不取时间。
// 这里是工作流代码，会被重放：别加随机数、Date、Node 自带模块（test/structure.test.ts 会拦）。
//
// 规矩：重评只对「此刻停着的这一次体量停点」的「这一份交付」生效；成功只产出回执，是否放行由 TaskRuntime 在同一同步段里定。
// 未知（读失败、超时、取消）一律拒绝并写明，不当 0 或 ok。

import type {
  DeliveryRead,
  LineBudgetParkIdentity,
  LineBudgetRefusal,
  LineBudgetRemeasureReceipt,
  RemeasureLineBudgetCommand,
} from '../task-contract.ts';

/**
 * 重评的 patched 标记。两处问：体量停点报警多出来的提示（旧历史没有标记，重放时提示不出现、raiseAlert 入参不变）；
 * taskRemeasureLineBudget Update（旧停点换上新代码后，这里仍是新历史才有的分支）。
 */
export const LINE_BUDGET_REMEASURE_PATCH = 'line-budget-remeasure-v1';
/** 一次重评在工作流里最多等多久（活动自己的 5 分钟限时之内）。 */
export const REMEASURE_TIMEOUT_SECONDS = 240;
/** 重放接手时停点还没走回来：最多等主流程追上这么久，再按不在停点拒。 */
export const REMEASURE_CATCH_UP_SECONDS = 30;
/**
 * 这次请求的身份已经回不来时，catchup 提前结束（#3297）。
 * 只在重评 Update 里问。#3249 那一版「只等停点出现」的在途等待，重放时这个标记为假，定时器命令和原来一样。
 */
export const REMEASURE_CATCH_UP_CLOSED_PATCH = 'remeasure-catchup-closed';

const SHA = /^[0-9a-f]{40}$/;

/** 此刻停着的体量停点：身份加上重评要用的树（树路径不对外）。 */
export interface LineBudgetParkState {
  identity: LineBudgetParkIdentity;
  worktreePath: string;
}

/** withinLineBudget 停下时交给 park() 的那一份交付信息（身份里的 runId / 停法代数 / 继续数由运行时补）。 */
export interface LineBudgetParkInput {
  head: string;
  rawAddedLines: number;
  chargeableAddedLines: number;
  budget: number;
  /** 停下时那次测量的固定 base（没有测量时 null）。 */
  base: string | null;
  worktreePath: string;
}

export interface RemeasureRefusal {
  ok: false;
  reason: LineBudgetRefusal;
  detail: string;
}

const safeCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function sameParkIdentity(a: LineBudgetParkIdentity, b: LineBudgetParkIdentity): boolean {
  return (
    a.version === 1 &&
    b.version === 1 &&
    a.runId === b.runId &&
    a.parks === b.parks &&
    a.generation === b.generation &&
    a.continued === b.continued &&
    a.prNumber === b.prNumber &&
    a.head === b.head &&
    a.rawAddedLines === b.rawAddedLines &&
    a.chargeableAddedLines === b.chargeableAddedLines &&
    a.budget === b.budget &&
    a.base === b.base
  );
}

/**
 * 停下时原始新增行实际按的固定 base：readDelivery 报的 addedLinesBase；同一份交付带了可信测量（同头、同原始行）时
 * 两者必须一致。缺、不是完整 sha、两者对不上都回 null——证明不了原测量范围，重评明确拒绝，不猜。
 */
export function parkedMeasurementBase(delivery: DeliveryRead): string | null {
  const base = delivery.addedLinesBase;
  if (typeof base !== 'string' || !SHA.test(base)) return null;
  const m = delivery.lineBudgetMeasurement;
  if (
    m?.version === 1 &&
    m.head === delivery.head &&
    m.rawAddedLines === delivery.addedLines &&
    m.base !== base
  )
    return null;
  return base;
}

/** 请求的形状：缺字段、非完整 sha、模式不认都拒（不猜）。回 null＝形状对。 */
export function commandShapeProblem(command: unknown): string | null {
  const c = command as Partial<RemeasureLineBudgetCommand> | null | undefined;
  if (!c || typeof c !== 'object' || c.version !== 1) return '请求版本不对';
  if (c.mode !== 'check' && c.mode !== 'resume') return '模式只认 check、resume';
  const id = c.identity;
  if (!id || typeof id !== 'object' || id.version !== 1) return '缺停点身份';
  if (
    typeof id.runId !== 'string' ||
    !safeCount(id.parks) ||
    !safeCount(id.generation) ||
    !safeCount(id.continued) ||
    !safeCount(id.rawAddedLines) ||
    !safeCount(id.chargeableAddedLines) ||
    !safeCount(id.budget) ||
    typeof id.head !== 'string' ||
    !(id.prNumber === null || safeCount(id.prNumber)) ||
    !(id.base === null || (typeof id.base === 'string' && SHA.test(id.base)))
  )
    return '停点身份字段不全';
  if (typeof c.head !== 'string' || !SHA.test(c.head)) return 'head 要完整 40 位小写 sha';
  if (typeof c.base !== 'string' || !SHA.test(c.base)) return 'base 要完整 40 位小写 sha';
  if (typeof c.by !== 'string' || c.by === '') return '缺操作人';
  if (typeof c.taskId !== 'string' || typeof c.workflowId !== 'string') return '缺任务或工作流身份';
  if (!c.repo || typeof c.repo.owner !== 'string' || typeof c.repo.name !== 'string') return '缺仓身份';
  return null;
}

/**
 * 裁决活动回答。只有「可信完整测量、头基线测量前后不变、树干净、实际计量不超原预算」才回回执。
 * 回执的 identity 是请求里的（已和当前停点比对过）。
 */
export function judgeRemeasure(
  command: RemeasureLineBudgetCommand,
  read: DeliveryRead,
): { ok: true; receipt: LineBudgetRemeasureReceipt } | RemeasureRefusal {
  const identity = command.identity;
  const answer = read.budgetRemeasure;
  if (answer?.version !== 1) {
    return { ok: false, reason: 'unsupported', detail: '执行端没按重评口径回答（旧 worker？），保留原停点' };
  }
  if (answer.status === 'refused') {
    return { ok: false, reason: 'changed', detail: `重评被拒（${answer.reason}）：${answer.detail}` };
  }
  if (answer.status !== 'measured') {
    return { ok: false, reason: 'unsupported', detail: '重评回答的状态认不出' };
  }
  if (answer.head !== command.head || answer.headAfter !== command.head) {
    return { ok: false, reason: 'changed', detail: '测量前后头不是请求的精确 head' };
  }
  if (answer.base !== command.base) {
    return { ok: false, reason: 'changed', detail: '测量基线不是请求的固定 base' };
  }
  if (answer.mergeBaseAfter !== command.base) {
    return {
      ok: false,
      reason: 'changed',
      detail: '测量之后主线基线不再是请求的固定 base（测量期间主线变了，或活动没再核对）',
    };
  }
  if (answer.cleanAfter !== true) {
    return { ok: false, reason: 'changed', detail: '测量之后工作树不干净' };
  }
  const m = answer.measurement;
  if (
    m?.version !== 1 ||
    m.head !== command.head ||
    m.base !== command.base ||
    !safeCount(m.rawAddedLines) ||
    !safeCount(m.verifiedGeneratedLines) ||
    !safeCount(m.chargeableAddedLines) ||
    m.chargeableAddedLines + m.verifiedGeneratedLines !== m.rawAddedLines
  ) {
    return { ok: false, reason: 'unverified', detail: '测量结果的身份或数字对不上，不当作已核实' };
  }
  if (m.rawAddedLines !== identity.rawAddedLines) {
    return {
      ok: false,
      reason: 'changed',
      detail: `原始新增行与停下时不同：${m.rawAddedLines} ≠ ${identity.rawAddedLines}`,
    };
  }
  if (!m.verified) {
    return { ok: false, reason: 'unverified', detail: `没有可信完整测量：${m.reason}` };
  }
  if (identity.budget <= 0 || m.chargeableAddedLines > identity.budget) {
    return {
      ok: false,
      reason: 'over_budget',
      detail: `实际计量 ${m.chargeableAddedLines} 行仍超原预算 ${identity.budget} 行（原始 ${m.rawAddedLines}，已核生成 ${m.verifiedGeneratedLines}）`,
    };
  }
  return {
    ok: true,
    receipt: {
      identity,
      base: m.base,
      head: m.head,
      rawAddedLines: m.rawAddedLines,
      verifiedGeneratedLines: m.verifiedGeneratedLines,
      chargeableAddedLines: m.chargeableAddedLines,
      budget: identity.budget,
      reason: m.reason,
    },
  };
}
