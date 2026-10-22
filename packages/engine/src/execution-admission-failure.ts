// 执行资格准入的拒绝信号：工作流沙箱和活动两侧共用，只依赖 @temporalio/common，不引 Node 模块。
// 判型只看 ApplicationFailure 的 type + nonRetryable，不看 message 文本；details 只放固定拒绝码。
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';

/** 固定的 failure 类型名；改名等于改协议（旧工作流历史里的失败按此判型）。 */
export const EXECUTION_ADMISSION_DENIED = 'ExecutionAdmissionDenied';
/** 准入读不到真相（History/DB/子进程未知）：可重试，由 judgeRetrying 退避，与拒绝分列。 */
export const EXECUTION_ADMISSION_UNKNOWN = 'ExecutionAdmissionUnknown';

export function admissionDenied(code: string): ApplicationFailure {
  return ApplicationFailure.create({
    message: '执行资格准入被拒绝',
    type: EXECUTION_ADMISSION_DENIED,
    nonRetryable: true,
    details: [code],
  });
}

export function admissionUnknown(
  code: string,
  alert: 'recorded' | 'unrecorded' | 'not_needed',
): ApplicationFailure {
  return ApplicationFailure.create({
    message: '执行资格准入状态未知',
    type: EXECUTION_ADMISSION_UNKNOWN,
    nonRetryable: false,
    details: [code, alert],
  });
}

/** 从活动失败（ActivityFailure.cause）或直接的 ApplicationFailure 取出确证拒绝；其它一律 undefined。 */
export function deniedFailureOf(error: unknown): ApplicationFailure | undefined {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  return cause instanceof ApplicationFailure &&
    cause.type === EXECUTION_ADMISSION_DENIED &&
    cause.nonRetryable === true
    ? cause
    : undefined;
}
