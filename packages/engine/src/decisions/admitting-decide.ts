// 执行资格兼容准入：复用 taskWorkflow 必经的首个 local activity（decide('limits')）做准入，不新增 workflow 命令。
// 成功时原样走内层 decide，limits 的输入、输出和历史命令不变；拒绝/未知用固定 failure 类型表达（见 execution-admission-failure.ts）。
// 未接生产：只有 createEngineWorker 显式传 admission 才装配，默认不启用。
import { AdmissionAlertCodeSchema, type AdmissionAlertObservation } from '@fleet-dao/db';
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { admissionDenied, admissionUnknown } from '../execution-admission-failure.ts';
import {
  ALERT_TOTAL_MS,
  type AlertCallOptions,
  type AlertOutcome,
} from '../real/admission-alert-protocol.ts';
import type { LegacySourceAdmission } from '../real/execution-legacy-admission.ts';
import type { Decide } from './index.ts';

export interface AdmissionAlertRecorder {
  record(input: AdmissionAlertObservation, call: AlertCallOptions): Promise<AlertOutcome>;
}
export interface AdmissionAlertTransferer {
  transferOne(call: AlertCallOptions): Promise<AlertOutcome>;
}
export interface AdmittingDecideDeps {
  decide: Decide;
  /** createLegacyExecutionAdmission 返回的无参入口：来源只取当前 Local Activity Context。 */
  admit: () => Promise<LegacySourceAdmission>;
  /** 未知时的本地承接（spool）；写失败如实标 unrecorded，不当成已报警。 */
  alert: AdmissionAlertRecorder;
  log?: (message: string) => void;
}

/** 码本身说取消、但活动信号并未取消（读取器自己的取消）：仍是未知、要重试，只是不报警。 */
const QUIET_UNKNOWN = new Set(['cancelled', 'start_cancelled']);

async function recordUnknown(
  deps: AdmittingDecideDeps,
  code: string,
  context: Context | undefined,
): Promise<'recorded' | 'unrecorded' | 'not_needed'> {
  if (QUIET_UNKNOWN.has(code)) return 'not_needed';
  const alertCode = AdmissionAlertCodeSchema.safeParse(code);
  const execution = context?.info.workflowExecution;
  if (!alertCode.success || !context || !execution) return 'unrecorded';
  try {
    const outcome = await deps.alert.record(
      {
        identity: {
          version: 1,
          category: 'legacy_admission_unknown',
          namespace: context.info.workflowNamespace ?? context.info.namespace,
          workflowId: execution.workflowId,
          runId: execution.runId,
        },
        firstCode: alertCode.data,
      },
      { signal: context.cancellationSignal, deadlineAt: performance.now() + ALERT_TOTAL_MS },
    );
    if (outcome.kind === 'spooled' || outcome.kind === 'transferred') return 'recorded';
    deps.log?.(`准入未知报警未能记下：${outcome.kind === 'unknown' ? outcome.code : outcome.kind}`);
  } catch {
    deps.log?.('准入未知报警未能记下：宿主异常');
  }
  return 'unrecorded';
}

export function createAdmittingDecide(deps: AdmittingDecideDeps): Decide {
  return async (kind, input) => {
    if (kind !== 'limits') return deps.decide(kind, input);
    let context: Context | undefined;
    try {
      context = Context.current();
    } catch {
      context = undefined;
    }
    // 只管 taskWorkflow 的 Start 之后第一问；其它工作流类型不经此门。无 Context 时仍交给 admit，由它 failclosed。
    if (context && context.info.workflowType !== 'taskWorkflow') return deps.decide(kind, input);
    // 活动真被取消（工作流取消、超时、工人收场）：按 SDK 约定以 CancelledFailure 结束，不当成准入未知去重试或报警。
    // 已持久的责任不因此回滚；放行只发生在 allowed 之后，取消时不会再往下走业务。
    const cancelledNow = () => context?.cancellationSignal.aborted === true;
    let result: LegacySourceAdmission;
    try {
      result = await deps.admit();
    } catch {
      if (cancelledNow()) throw new CancelledFailure('执行资格准入被取消');
      result = { kind: 'unknown', code: 'store_unavailable' };
    }
    if (cancelledNow()) throw new CancelledFailure('执行资格准入被取消');
    if (result.kind === 'allowed') return deps.decide(kind, input);
    if (result.kind === 'denied') throw admissionDenied(result.code);
    // 未知：可重试失败，由工作流 judgeRetrying 按 15s 起翻倍封顶 600s 退避；每次尝试都重新核，不缓存放行。
    throw admissionUnknown(result.code, await recordUnknown(deps, result.code, context));
  };
}

/** 逐条移交 spool 里的未知报警；一个进程只起一次，间隔是下限，不并发。 */
export function startAdmissionAlertTransfer(
  sink: AdmissionAlertTransferer,
  options: { intervalMs: number; log: (message: string) => void },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const tick = async () => {
    try {
      for (let i = 0; i < 16 && !stopped; i += 1) {
        const outcome = await sink.transferOne({
          signal: controller.signal,
          deadlineAt: performance.now() + ALERT_TOTAL_MS,
        });
        if (outcome.kind === 'empty') break;
        if (outcome.kind === 'unknown') {
          options.log(`准入报警移交未完成，保留原件：${outcome.code}`);
          break;
        }
      }
    } catch {
      options.log('准入报警移交异常，保留原件');
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), options.intervalMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => void tick(), options.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    controller.abort();
    clearTimeout(timer);
  };
}
