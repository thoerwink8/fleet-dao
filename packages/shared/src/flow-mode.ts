// 全程模式的记账和开关用到的名单与读法（#2823，单 #2807）。这一步只记账：引擎的行为不看这里。
// 两种模式：three = 三步单（对题、写码、验收各一段），full = 模型自己走完全程（推分支、开 PR、等 CI、合并还是引擎做，
// CI 红、冲突、冷验收被拒都回到同一个会话接着修）。
// 设置 engine.flowMode 的值：three / split:<0-100> / full，默认 three。认不出的写法按 three 处理，并说出为什么，不悄悄吞。

/** 一张单实际走哪种流程。 */
export const FLOW_MODES = ['three', 'full'] as const;
export type FlowMode = (typeof FLOW_MODES)[number];

/** 分组怎么来的：label 单上的标签指定；hash 按单号哈希对半；ineligible 不合格退回三段（原因写在 reason）。 */
export const FLOW_SOURCES = ['label', 'hash', 'ineligible'] as const;
export type FlowSource = (typeof FLOW_SOURCES)[number];

/** 冷验收拒绝的分类，只在人工审过之后填：真实缺陷、验收误拒、需求不全、基础设施。 */
export const VERIFY_REJECT_CLASSES = [
  'real_defect',
  'verifier_false_reject',
  'incomplete_spec',
  'infra',
] as const;
export type VerifyRejectClass = (typeof VERIFY_REJECT_CLASSES)[number];

/** 一张单的分组记录（task_flow_assignments 一行）。 */
export interface FlowAssignment {
  taskId: string;
  mode: FlowMode;
  source: FlowSource;
  /** 分层（档位）：对半分组时按它分层，让两组的轻重差不多。 */
  stratum: string;
  /** ISO 字符串。 */
  assignedAt: string;
  /** 不合格退回三段的原因；别的来源是 null。 */
  reason: string | null;
}

/** 写分组记录的入参：分组时刻由写的那一边的钟定。 */
export interface NewFlowAssignment {
  taskId: string;
  mode: FlowMode;
  source: FlowSource;
  stratum: string;
  reason?: string | null | undefined;
}

/** 同一张单已经有分组记录了：只写一次，不覆盖。 */
export class FlowAssignmentExistsError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`单 ${taskId} 已经有分组记录：只写一次，不覆盖`);
    this.name = 'FlowAssignmentExistsError';
    this.taskId = taskId;
  }
}

/** 设置表里开关那一项的键（和 SETTING_SCHEMAS 里同名）。 */
export const FLOW_MODE_SETTING = 'engine.flowMode';

/** 操作记录里改这一项的名字；target 是 setting:engine.flowMode。 */
export const FLOW_MODE_SET = 'engine.flowMode.set';

export type FlowModeSetting = { kind: 'three' } | { kind: 'full' } | { kind: 'split'; percent: number };

export const FLOW_MODE_FORMS = 'three、split:<0-100>、full';

export type FlowModeParse = { ok: true; setting: FlowModeSetting } | { ok: false; problem: string };

/** 开关值的字符串：只认 three、full、split:0 到 split:100（整数、不带前导 0）；多一个字符、大小写不对都不认。 */
export function parseFlowModeSetting(raw: string): FlowModeParse {
  if (raw === 'three') return { ok: true, setting: { kind: 'three' } };
  if (raw === 'full') return { ok: true, setting: { kind: 'full' } };
  const m = /^split:(0|[1-9]\d?|100)$/.exec(raw);
  if (m?.[1] !== undefined) return { ok: true, setting: { kind: 'split', percent: Number(m[1]) } };
  return { ok: false, problem: `认不出「${raw}」：只收 ${FLOW_MODE_FORMS}` };
}

/** 此刻的开关：setting 一定有值（读不到、认不出都按 three）；state 说明是哪种情况，problem 在认不出时写明原因。 */
export type FlowModeReading =
  | { setting: FlowModeSetting; state: 'set' }
  | { setting: { kind: 'three' }; state: 'never_set' }
  | { setting: { kind: 'three' }; state: 'unrecognized'; problem: string };

/** 从设置表里那一行的值读开关。没设过（没这一行或值是 null）按 three；不是字符串、字符串认不出：按 three 并带原因。 */
export function readFlowModeSetting(raw: unknown): FlowModeReading {
  if (raw === undefined || raw === null) return { setting: { kind: 'three' }, state: 'never_set' };
  if (typeof raw !== 'string') {
    return {
      setting: { kind: 'three' },
      state: 'unrecognized',
      problem: `认不出库里的值（${JSON.stringify(raw)}，不是字符串）：只收 ${FLOW_MODE_FORMS}，先按 three 处理`,
    };
  }
  const parsed = parseFlowModeSetting(raw);
  if (parsed.ok) return { setting: parsed.setting, state: 'set' };
  return {
    setting: { kind: 'three' },
    state: 'unrecognized',
    problem: `${parsed.problem}，先按 three 处理`,
  };
}

/** 开关值写回字符串（设置表里存的就是这个字符串）。 */
export function formatFlowModeSetting(setting: FlowModeSetting): string {
  return setting.kind === 'split' ? `split:${setting.percent}` : setting.kind;
}

/** 给人看的一句。 */
export function flowModeLabel(setting: FlowModeSetting): string {
  if (setting.kind === 'three') return 'three：都走三步单';
  if (setting.kind === 'full') return 'full：都走全程';
  return `split:${setting.percent}：约 ${setting.percent}% 的单走全程，其余走三步单`;
}

/** 驾驶舱「全程 / 三步法」两个按钮上按下哪一个。没设过按下三步法。对半分、认不出的都不按下，免得看成已经选了。 */
export function flowModeSwitchChoice(reading: FlowModeReading): 'three' | 'full' | undefined {
  if (reading.state === 'unrecognized') return undefined;
  if (reading.state === 'never_set' || reading.setting.kind === 'three') return 'three';
  if (reading.setting.kind === 'full') return 'full';
  return undefined;
}

/**
 * 驾驶舱上和那两个按钮配套的一句。对半分只指 split:50；别的百分比照原样写，不叫对半分。
 * 认不出时把原因原样给出去，不改成「当前是三步法」。
 */
export function flowModeSwitchText(reading: FlowModeReading): string {
  if (reading.state === 'unrecognized') return reading.problem;
  if (reading.state === 'never_set') return '还没设过，默认三步法';
  if (reading.setting.kind === 'three') return '当前是三步法';
  if (reading.setting.kind === 'full') return '当前是全程';
  if (reading.setting.kind === 'split' && reading.setting.percent === 50) return '当前是对半分';
  return flowModeLabel(reading.setting);
}

/** 开关写成 three 时分组原因的开头。这是默认就走三步法，不是单子不合格退回去的。 */
const SETTING_IS_THREE = `${FLOW_MODE_SETTING} 是 three`;

/**
 * 单子不合格、实际退回三段时给人看的原因（比如没有 Claude 5.5 路由）。
 * 没分组、走全程、按标签或哈希走三段、以及开关本来就是三步法，都回 undefined，页面不猜。
 */
export function flowFallbackReason(
  assignment: Pick<FlowAssignment, 'mode' | 'source' | 'reason'> | null | undefined,
): string | undefined {
  if (!assignment || assignment.mode !== 'three' || assignment.source !== 'ineligible') return undefined;
  const reason = assignment.reason?.trim() ?? '';
  if (reason === '' || reason.startsWith(SETTING_IS_THREE)) return undefined;
  return reason;
}
