// ask 交回给调用方的东西。调用方只看 act：真拦时是选项挂的效果，其余（只记不拦、把握不够、没判出来）一律 none，
// 也就是「当它不存在、照默认走」。act 的类型只可能是 Effect 里收紧的那几种，表达不出放行。
import type { Effect } from './effects.ts';
import type { EffectOf, OptionOf, QuestionDef } from './questions.ts';

/**
 * 没判出来的原因。前六个是本地就拦下、没问出去的（不占每日次数）。
 * 最后的 unrecorded 只出现在库里：发出去了、判断却没记进库时补记花费的那一行（调用方拿到的是 store_error）。
 */
export const NOT_JUDGED_REASONS = [
  'off',
  'daily_cap',
  'missing_evidence',
  'bad_evidence',
  'bad_setting',
  'store_error',
  'unsure',
  'timeout',
  'network',
  'auth',
  'rate_limited',
  'overloaded',
  'bad_request',
  'quota',
  'backend_error',
  'bad_answer',
  'bad_option',
  'no_answer',
  'model_mismatch',
  'unrecorded',
] as const;
export type NotJudgedReason = (typeof NOT_JUDGED_REASONS)[number];

/** 本地拦下、没问出去的原因：不占每日次数。 */
export const LOCAL_REASONS = [
  'off',
  'daily_cap',
  'missing_evidence',
  'bad_evidence',
  'bad_setting',
  'store_error',
] as const satisfies readonly NotJudgedReason[];

/** 说明模型在漂（答了题面外的选项、回话的不是钉死的模型）：真拦的题要退回只记不拦。 */
export const DRIFT_REASONS = ['bad_option', 'model_mismatch'] as const satisfies readonly NotJudgedReason[];

export const REASON_TEXT: Record<NotJudgedReason, string> = {
  off: '这道题停用了',
  daily_cap: '到了每日上限（次数或花费），这次没问',
  missing_evidence: '必填的证据没给',
  bad_evidence: '给了这道题不认识的证据字段',
  bad_setting: '驾驶舱设置里的判断题参数认不出',
  store_error: '读写库出错',
  unsure: '把握度低于把握线',
  timeout: '超时',
  network: '连不上',
  auth: '密钥或登录不对',
  rate_limited: '被限流',
  overloaded: '上游过载或出错',
  bad_request: '请求被拒（多半是太长或题目格式不对）',
  quota: '账号池额度用满',
  backend_error: '后端起不来或报错',
  bad_answer: '回包认不出',
  bad_option: '答了题面以外的选项',
  no_answer: '回包里没有这道题的答案',
  model_mismatch: '回话的模型不是钉死的那个',
  unrecorded: '发给后端了，但判断没记进库，这一行只补记花费',
};

/** 判出来了：答在题面里，而且把握度不低于把握线。 */
export interface Judged<O extends string = string, E extends Effect = Effect> {
  readonly judged: true;
  readonly questionId: string;
  readonly option: O;
  readonly confidence: number;
  /** 这个选项真拦时最多能引起什么（只记不拦时也给出来，方便记日志、给驾驶舱看）。 */
  readonly effect: E;
  /** 这次真拦：题目在真拦，回话的模型就是这道题钉死的那个。 */
  readonly enforced: boolean;
  /** 调用方照这个走。 */
  readonly act: E | 'none';
  readonly model: string;
  readonly latencyMs: number;
  /** jev_answers 里的那一行。 */
  readonly answerId: number;
}

/** 没判出来：走默认，不当成「否」。把握不够时也带着它答的选项和把握度，只是不作数。 */
export interface NotJudged {
  readonly judged: false;
  readonly questionId: string;
  readonly reason: NotJudgedReason;
  readonly detail: string;
  readonly act: 'none';
  readonly option?: string;
  readonly confidence?: number;
  /** 记进库的那一行；库本身出错（store_error）时没有。 */
  readonly answerId?: number;
}

export type Verdict<Q extends QuestionDef = QuestionDef> = Judged<OptionOf<Q>, EffectOf<Q>> | NotJudged;
