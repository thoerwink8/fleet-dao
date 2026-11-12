// 四道递进式可信度验收漏斗（Funnel of Trust）+ 自我迭代飞轮 + 本地波次合流（取代繁琐的逐子任务开 GitHub PR）。
// 漏斗顺序：
//   Gate 1: YSK (devin/swe-2) 实时旁路盯梢（0 越界、0 删断言、0 吞异常）
//   Gate 2: Rust 确定性机械核验（writeScope 校验 + biome + tsc + 增量测试 passed >= baseline + 前端双屏真截图零报错）
//   Gate 3: 异族独立冷验收（Cross-Family Cold Verify：Claude 写的派 GPT/Grok 审，DeepSeek 写的派 Claude/GPT 审）
//   Gate 4: Wilson 95% 置信下界自适应放行（达标格自动本地合流并出最终单 PR；未达标格进驾驶舱「待我」一键批阅）
import type { ModelFamily } from './matrix.ts';
import type { YskAlert } from './ysk-watcher.ts';

export interface MechanicalCheckReceipt {
  writeScopeClean: boolean;
  outOfScopeFiles: string[];
  biomeExitCode: number;
  tscExitCode: number;
  testExitCode: number;
  passedTestsCount: number;
  baselineTestsCount: number;
  /** 碰前端 UI 时的 1440px 与 390px 双屏截图回执。 */
  uiScreenshots?: {
    desktop1440Path: string;
    mobile390Path: string;
    consoleErrors: number;
    horizontalOverflowPx: number;
  };
}

export interface ColdVerifyReceipt {
  verifierModelId: string;
  verifierFamily: ModelFamily;
  workerFamily: ModelFamily;
  verdict: 'pass' | 'reject' | 'human-needed';
  blockingReasons: string[];
}

export interface CellTrackRecord {
  cellKey: string; // 例如 "worker-code::deepseek-v4-pro::api"
  maturedCount: number;
  successCount: number;
  recentRetractions: number;
  gatePolicy: 'manual' | 'by-record' | 'auto';
  gateOpenedByHuman: boolean;
}

/** 计算 Wilson 95% 置信区间下界（样本小的时候绝不盲目自信）。 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const phat = successes / total;
  const z2 = z * z;
  const num = phat + z2 / (2 * total) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  const den = 1 + z2 / total;
  return Number(Math.max(0, num / den).toFixed(4));
}

export interface FunnelEvaluation {
  overallVerdict: 'auto-merge-wave' | 'queue-for-human' | 'rework-same-tier' | 'escalate-stronger-model';
  failedGate: 'none' | 'gate1-ysk' | 'gate2-mechanical' | 'gate3-cold-verify' | 'gate4-human-policy';
  wilsonLower: number;
  canProposeOpenGate: boolean;
  reasons: string[];
}

/**
 * 综合四道漏斗给出最终裁决：
 * - 若连续第 2 次在 Gate 1/2/3 失败，直接回 'escalate-stronger-model'（自动换强一档模型重做，不死磕）。
 */
export function evaluateTrustFunnel(input: {
  attempt: number;
  ysk: YskAlert;
  mechanical: MechanicalCheckReceipt;
  coldVerify: ColdVerifyReceipt;
  track: CellTrackRecord;
}): FunnelEvaluation {
  const escalateIfRepeated = (): FunnelEvaluation['overallVerdict'] =>
    input.attempt >= 2 ? 'escalate-stronger-model' : 'rework-same-tier';

  const wilson = wilsonLowerBound(input.track.successCount, input.track.maturedCount);

  // Gate 1: YSK 旁路盯梢
  if (input.ysk.triggered && input.ysk.severity === 'critical') {
    return {
      overallVerdict: escalateIfRepeated(),
      failedGate: 'gate1-ysk',
      wilsonLower: wilson,
      canProposeOpenGate: false,
      reasons: [`Gate 1 (YSK 旁路盯梢拦截): ${input.ysk.message}`],
    };
  }

  // Gate 2: 确定性机械核验
  const mechProblems: string[] = [];
  if (!input.mechanical.writeScopeClean) {
    mechProblems.push(`越界修改了未授权路径: ${input.mechanical.outOfScopeFiles.join(', ')}`);
  }
  if (input.mechanical.biomeExitCode !== 0) mechProblems.push('biome 格式/静态检查未通过');
  if (input.mechanical.tscExitCode !== 0) mechProblems.push('tsc 类型检查未通过');
  if (input.mechanical.testExitCode !== 0) mechProblems.push('增量单元测试未通过');
  if (input.mechanical.passedTestsCount < input.mechanical.baselineTestsCount) {
    mechProblems.push(
      `通过的测试数 (${input.mechanical.passedTestsCount}) 少于基线 (${input.mechanical.baselineTestsCount})，禁止删测试凑绿`,
    );
  }
  if (input.mechanical.uiScreenshots) {
    if (input.mechanical.uiScreenshots.consoleErrors > 0) {
      mechProblems.push(`前端渲染出现 ${input.mechanical.uiScreenshots.consoleErrors} 条 console.error`);
    }
    if (input.mechanical.uiScreenshots.horizontalOverflowPx > 0) {
      mechProblems.push(`窄屏出现 ${input.mechanical.uiScreenshots.horizontalOverflowPx}px 横向溢出滚动`);
    }
  }
  if (mechProblems.length > 0) {
    return {
      overallVerdict: escalateIfRepeated(),
      failedGate: 'gate2-mechanical',
      wilsonLower: wilson,
      canProposeOpenGate: false,
      reasons: mechProblems.map((p) => `Gate 2 (机械核验): ${p}`),
    };
  }

  // Gate 3: 异族独立冷验收（强制要求不同模型族）
  if (input.coldVerify.verifierFamily === input.coldVerify.workerFamily) {
    return {
      overallVerdict: 'queue-for-human',
      failedGate: 'gate3-cold-verify',
      wilsonLower: wilson,
      canProposeOpenGate: false,
      reasons: [
        `Gate 3 (异族约束): 验收模型与写码模型同属 ${input.coldVerify.workerFamily} 族，必须换异族模型盲审`,
      ],
    };
  }
  if (input.coldVerify.verdict === 'reject') {
    return {
      overallVerdict: escalateIfRepeated(),
      failedGate: 'gate3-cold-verify',
      wilsonLower: wilson,
      canProposeOpenGate: false,
      reasons: input.coldVerify.blockingReasons.map((r) => `Gate 3 (异族冷验收退回): ${r}`),
    };
  }

  // Gate 4: 战绩与人工验收策略（决定 0125：成熟样本 >= 20、Wilson 下界 >= 0.90、近期 0 撤回才可开闸）
  const qualifiesForAuto =
    input.track.maturedCount >= 20 && wilson >= 0.9 && input.track.recentRetractions === 0;
  const canProposeOpenGate = qualifiesForAuto && !input.track.gateOpenedByHuman;

  if (
    input.track.gatePolicy === 'auto' ||
    (input.track.gatePolicy === 'by-record' && qualifiesForAuto && input.track.gateOpenedByHuman)
  ) {
    return {
      overallVerdict: 'auto-merge-wave',
      failedGate: 'none',
      wilsonLower: wilson,
      canProposeOpenGate,
      reasons: [
        `四道漏斗全绿（Wilson 下界 ${Math.round(wilson * 100)}% >= 90%，成熟单 ${input.track.maturedCount} 件 0 撤回），自动合入当前波次`,
      ],
    };
  }

  return {
    overallVerdict: 'queue-for-human',
    failedGate: 'gate4-human-policy',
    wilsonLower: wilson,
    canProposeOpenGate,
    reasons: [
      `前 3 道机器与异族核验全绿；当前格策略为 ${input.track.gatePolicy}（Wilson 下界 ${Math.round(wilson * 100)}%），已生成全证据包递交「待我验收」队列`,
    ],
  };
}
