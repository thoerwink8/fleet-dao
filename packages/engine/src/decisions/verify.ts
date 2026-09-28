// 验证之后怎么走：合并、回主会话返工、还是交帅位。三态纪律：没查成 ≠ 没过 ≠ 过了。

import type { Limits } from '../limits.ts';

/** 回主会话的一条返工意见。 */
export interface Feedback {
  /**
   * hygiene = 卫生检查拦下了会话交的内容（密钥、账号编号……），要拿掉；delivery = 交的东西没过引擎的核对
   * （没提交的改动、空交付……）；ask = 会话 fleet blocked 说要人，退回让它带选项和推荐用 fleet ask 重问（#259）；
   * answer = 创始人晚到的回答改选了别的，照他选的改（#259，存档点交给 Lead）。
   */
  kind: 'ci' | 'review' | 'conflict' | 'merge-return' | 'plan' | 'hygiene' | 'delivery' | 'ask' | 'answer';
  summary: string;
  items: string[];
}

/** 把最新主线并进分支、推上去之后的结果。clean 也包括「本来就是最新」。 */
export interface SyncResult {
  state: 'clean' | 'conflict';
  head: string;
  conflictFiles: string[];
}

/**
 * CI 结果，证据绑定 head。unknown = 没查成（没有检查、超时读不到……），不是没过也不是过了；conflict = GitHub 不给
 * 冲突的 PR 起 CI（和 unknown 分开：这个有确定的解法，并主线，不是读不到）；diverged = PR 的头变了、新头不含老头
 * （像是被强推改写了），不是自动并主线能接的，要人看；merged = 查到 PR 已经在外面合并了（GitHub 自己的自动合并，
 * 合并闸绿就合，不是引擎自己合的）：不是没查成，直接当合上了（mergeCommit 带着合并提交）。
 */
export interface CiResult {
  state: 'green' | 'red' | 'unknown' | 'conflict' | 'diverged' | 'merged';
  head: string;
  failedChecks: string[];
  /** 失败摘要（首个失败的测试名、报错首行）；有它才判「同一假设」。 */
  digest?: string;
  detail?: string;
  /** state 是 'merged' 时才有：合并提交。 */
  mergeCommit?: string;
}

export interface Finding {
  /** blocking = 必须改才能合；minor = 小毛病，攒起来批量修，不挡合并。 */
  severity: 'blocking' | 'minor';
  text: string;
  file?: string;
}

export interface ReviewResult {
  verdict: 'pass' | 'changes';
  /** 审的是哪个头；和送审的头对不上就作废。 */
  head: string;
  findings: Finding[];
}

export interface VerifyRounds {
  review: number;
  ciFix: number;
  conflict: number;
}

export interface VerifyInput {
  sync: SyncResult;
  /** 同步有冲突时不跑 CI，传 null。 */
  ci: CiResult | null;
  /** 不需要第二意见时传 null。 */
  review: ReviewResult | null;
  reviewRequired: boolean;
  /** 缺的计数 = 从没返工过。 */
  rounds?: Partial<VerifyRounds> | undefined;
  limits: Pick<Limits, 'reviewRounds' | 'ciFixRounds' | 'conflictRounds'> &
    Partial<Pick<Limits, 'subtaskWallMinutes'>>;
  /** 上一轮返工的指纹；这一轮一模一样就是同一个假设第二次失败（windsurf-dao#1744）。 */
  lastFingerprints?: { ci?: string; review?: string } | undefined;
  /** 子任务开工（或人上次看过）到现在干了多少分钟：等人（暂停、挂起、回答、批准）和排队（空位、额度、合并队列）不算。 */
  elapsedMinutes?: number | undefined;
}

export type VerifyDecision =
  | { action: 'merge'; reason: string; minorFindings: Finding[] }
  | { action: 'rework'; count: keyof VerifyRounds; feedback: Feedback[]; fingerprint: string; reason: string }
  | { action: 'escalate'; reason: string; detail: string };

/** 归一化后取 FNV-1a：小写、去掉提交号与数字、压空白。同一句意见换了行号也认得出来。 */
export function fingerprint(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '')
    .replace(/[0-9]+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i += 1) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function describeFinding(f: Finding): string {
  return f.file ? `${f.file}：${f.text}` : f.text;
}

/** 能合就合；要返工时先看墙钟预算，超了交帅位（windsurf-dao 旧策略写了 4 小时却从没执行过）。 */
export function decideAfterVerify(input: VerifyInput): VerifyDecision {
  const decision = decideOnEvidence(input);
  const budget = input.limits.subtaskWallMinutes;
  if (decision.action === 'rework' && budget !== undefined && (input.elapsedMinutes ?? 0) > budget) {
    return {
      action: 'escalate',
      reason: `子任务已经干了 ${Math.round(input.elapsedMinutes ?? 0)} 分钟，超过预算 ${budget} 分钟`,
      detail: decision.reason,
    };
  }
  return decision;
}

function decideOnEvidence(input: VerifyInput): VerifyDecision {
  const rounds = {
    review: input.rounds?.review ?? 0,
    ciFix: input.rounds?.ciFix ?? 0,
    conflict: input.rounds?.conflict ?? 0,
  };
  const last = input.lastFingerprints ?? {};
  const { limits } = input;

  if (input.sync.state === 'conflict') {
    if (rounds.conflict >= limits.conflictRounds) {
      return {
        action: 'escalate',
        reason: `同步主线的冲突已经回修 ${rounds.conflict} 轮`,
        detail: input.sync.conflictFiles.join('\n'),
      };
    }
    return {
      action: 'rework',
      count: 'conflict',
      fingerprint: `conflict:${fingerprint(input.sync.conflictFiles.join(','))}`,
      feedback: [
        {
          kind: 'conflict',
          summary: '最新主线并进来有冲突，请在分支上解决',
          items: input.sync.conflictFiles,
        },
      ],
      reason: '同步主线有冲突，回主会话解决',
    };
  }

  const ci = input.ci;
  if (!ci || ci.state === 'unknown' || ci.state === 'conflict' || ci.state === 'diverged') {
    // 这条路径（子任务的经典流程）在等 CI 之前已经先 syncMainline 过一轮（见 subtask.ts），这里还读到 conflict
    // 或 diverged 是没接自动重试的少数情形：老实报没查成，交给人，不在这里生出一套并主线的机制（那一套在
    // Fusion 流程里，见 packages/core/src/flow.ts 的 sync-mainline）。
    const why =
      ci?.state === 'conflict'
        ? '和主线冲突'
        : ci?.state === 'diverged'
          ? 'PR 的头变了'
          : '不是没过，也不是过了';
    return { action: 'escalate', reason: `CI 没查成（${why}）`, detail: ci?.detail ?? '' };
  }
  if (ci.head !== input.sync.head) {
    return {
      action: 'escalate',
      reason: 'CI 结果和送检的头对不上',
      detail: `送检 ${input.sync.head}，CI ${ci.head}`,
    };
  }

  const feedback: Feedback[] = [];
  let count: keyof VerifyRounds | null = null;
  let print = '';
  if (ci.state === 'red') {
    const checks = [...ci.failedChecks].sort().join('、') || '（没列出检查名）';
    if (ci.digest) {
      print = `ci:${fingerprint(`${checks}|${ci.digest}`)}`;
      if (last.ci === print) {
        return { action: 'escalate', reason: `CI 连续两轮红在同一处（${checks}）`, detail: ci.digest };
      }
    } else {
      print = `ci:${fingerprint(checks)}#${rounds.ciFix}`;
    }
    if (rounds.ciFix >= limits.ciFixRounds) {
      return {
        action: 'escalate',
        reason: `CI 已经回修 ${rounds.ciFix} 轮还是红`,
        detail: ci.detail ?? checks,
      };
    }
    count = 'ciFix';
    feedback.push({
      kind: 'ci',
      summary: `CI 没过：${checks}`,
      items: [...ci.failedChecks, ...(ci.digest ? [ci.digest] : [])],
    });
  }

  const review = input.review;
  if (input.reviewRequired && !review) {
    return { action: 'escalate', reason: '要第二意见但没拿到结果', detail: '' };
  }
  if (review && review.head !== input.sync.head) {
    return {
      action: 'escalate',
      reason: '第二意见审的不是送检的头',
      detail: `送检 ${input.sync.head}，审的 ${review.head}`,
    };
  }
  const blocking =
    review?.verdict === 'changes' ? review.findings.filter((f) => f.severity === 'blocking') : [];
  const first = blocking[0];
  if (first) {
    if (count === null) {
      const reviewPrint = `review:${fingerprint(first.text)}`;
      if (last.review === reviewPrint) {
        return {
          action: 'escalate',
          reason: '第二意见连续两轮提同一条必须改',
          detail: describeFinding(first),
        };
      }
      if (rounds.review >= limits.reviewRounds) {
        return {
          action: 'escalate',
          reason: `第二意见已经打回 ${rounds.review} 轮`,
          detail: blocking.map(describeFinding).join('\n'),
        };
      }
      count = 'review';
      print = reviewPrint;
    }
    feedback.push({
      kind: 'review',
      summary: `第二意见有 ${blocking.length} 条必须改`,
      items: blocking.map(describeFinding),
    });
  }

  if (count !== null) {
    return {
      action: 'rework',
      count,
      feedback,
      fingerprint: print,
      reason: count === 'ciFix' ? 'CI 没过，回主会话修' : '第二意见要改，回主会话修',
    };
  }
  const minorFindings = review?.findings.filter((f) => f.severity === 'minor') ?? [];
  return {
    action: 'merge',
    reason: input.reviewRequired ? 'CI 绿、第二意见通过' : 'CI 绿（这类改动不要第二意见）',
    minorFindings,
  };
}
