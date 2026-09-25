// 每道题的状态怎么变：只记不拦（shadow）→ 真拦（enforce），以及掉回去。纯函数，读数由 store.ts 从库里取。
// 规则（设计文档第十一节）：攒满 minSamples 条「有把握、有真值」的判定、准确率不低于线，且最近一次巡检考题及格，才转真拦；
// 真拦之后，考题不及格、生产判定准确率掉到线下、或者答了题面外的选项 / 回话模型不对，自动退回只记不拦。
// 答了题面外的选项 / 回话模型不对：提问当场就退回（jev.ts）；这里按这批样本覆盖的时间再兜一次底，考试洗不掉。
// 人停的（off）只有人能开，这里从不动它。
import type { JevPolicy } from './policy.ts';

export type JevMode = 'shadow' | 'enforce' | 'off';

/** 生产里最近 minSamples 条「有把握、有真值（人改判或结局回填）」的判定。考题的真值不算在这里。 */
export interface ProductionWindow {
  samples: number;
  correct: number;
  /** 这批判定里最早那一条的时刻：漂移从这里算起。一条都没有就不给（漂移按一直以来算）。 */
  from?: Date;
}

/** 一次巡检考试里这道题的答卷。 */
export interface ExamTally {
  runId: string;
  at: Date;
  /** 问了几道。 */
  asked: number;
  /** 答在题面选项里的（不论把握）。 */
  answered: number;
  /** 其中把握够的。 */
  sure: number;
  /** 把握够、而且答对的。把握不够的考题算没答对：考题都是标准答案清楚的题。 */
  correct: number;
  /** 答了题面以外的选项。 */
  badOption: number;
}

export type ExamState = 'pass' | 'fail' | 'void';

export interface ExamOutcome {
  state: ExamState;
  /** correct / answered；没答出一道就是 null。 */
  accuracy: number | null;
  why: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function examOutcome(t: ExamTally, policy: JevPolicy): ExamOutcome {
  const accuracy = t.answered > 0 ? t.correct / t.answered : null;
  const needed = Math.max(policy.examMinAnswered, Math.ceil(t.asked * policy.examAnsweredShare - 1e-9));
  if (t.badOption > 0) {
    return { state: 'fail', accuracy, why: `考试里 ${t.badOption} 道答了题面以外的选项` };
  }
  if (t.answered < needed) {
    return {
      state: 'void',
      accuracy,
      why: `只答出 ${t.answered}/${t.asked} 道，不够 ${needed} 道，这次没考成`,
    };
  }
  const acc = accuracy ?? 0;
  if (acc < policy.accuracyLine) {
    return {
      state: 'fail',
      accuracy,
      why: `考题准确率 ${pct(acc)}（${t.correct}/${t.answered}），低于线 ${pct(policy.accuracyLine)}`,
    };
  }
  return { state: 'pass', accuracy, why: `考题准确率 ${pct(acc)}（${t.correct}/${t.answered}）` };
}

export interface ModeInput {
  mode: JevMode;
  production: ProductionWindow;
  /** 最近一次巡检考试；一次都没考过就不给。 */
  exam?: ExamOutcome | undefined;
  /** 攒这批生产判定期间（ProductionWindow.from 起，考试里的也算）答了题面外的选项、或回话模型不对的次数。 */
  drift: number;
}

export interface ModeDecision {
  mode: JevMode;
  changed: boolean;
  why: string;
}

export function decideMode(input: ModeInput, policy: JevPolicy): ModeDecision {
  const stay = (why: string): ModeDecision => ({ mode: input.mode, changed: false, why });
  const to = (mode: JevMode, why: string): ModeDecision => ({ mode, changed: mode !== input.mode, why });
  const { production: p, exam } = input;
  const prodAccuracy = p.samples > 0 ? p.correct / p.samples : null;
  const enough = p.samples >= policy.minSamples;

  if (input.mode === 'off') return stay('人停的，只有人能开');

  if (input.mode === 'enforce') {
    if (input.drift > 0)
      return to('shadow', `答了题面外的选项或回话模型不对（${input.drift} 次），退回只记不拦`);
    if (exam?.state === 'fail') return to('shadow', `${exam.why}，退回只记不拦`);
    if (enough && prodAccuracy !== null && prodAccuracy < policy.accuracyLine) {
      return to(
        'shadow',
        `最近 ${p.samples} 条有真值的判定准确率 ${pct(prodAccuracy)}，低于线 ${pct(policy.accuracyLine)}，退回只记不拦`,
      );
    }
    return stay('真拦中，考题和生产判定都没掉线');
  }

  if (!enough) return stay(`有把握、有真值的判定 ${p.samples}/${policy.minSamples} 条，还没攒够`);
  if (prodAccuracy === null || prodAccuracy < policy.accuracyLine) {
    return stay(`最近 ${p.samples} 条准确率 ${pct(prodAccuracy ?? 0)}，没到线 ${pct(policy.accuracyLine)}`);
  }
  if (!exam) return stay('还没考过巡检考题');
  if (exam.state !== 'pass') return stay(`最近一次考试：${exam.why}`);
  if (input.drift > 0) {
    return stay(`攒这批样本期间答过题面外的选项或回话模型不对（${input.drift} 次），要在那之后重新攒够`);
  }
  return to(
    'enforce',
    `最近 ${p.samples} 条准确率 ${pct(prodAccuracy)} 不低于线 ${pct(policy.accuracyLine)}，${exam.why}，转真拦`,
  );
}

/** 只记不拦挂了很久还没攒够样本：日报报「影子停滞」，别让它在登记页上永远挂着。 */
export function shadowStalled(
  input: { mode: JevMode; samples: number; firstAskedAt?: Date | undefined; now: Date },
  policy: JevPolicy,
): boolean {
  if (input.mode !== 'shadow' || input.samples >= policy.minSamples || !input.firstAskedAt) return false;
  return input.now.getTime() - input.firstAskedAt.getTime() >= policy.shadowStallDays * 24 * 3_600_000;
}
