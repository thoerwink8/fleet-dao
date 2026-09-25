// 判断题后端的接口：旧系统的 Jev 服务（TypeSafe）、经插头起的 Claude 会话都照这一份实现。
// 后端只管把题问出去、把答案原样交回来；答案在不在题面里、把握够不够、要不要拦，由 ask 统一判（jev.ts）。
// 后端不抛：出错一律返回 ok:false + 原因。用哪条路由、哪个模型由调度台的「判断」阶段配（backendForRoute）。
import { redact } from '@fleet-dao/adapters';

export interface BackendQuestion {
  /** 题号（jev_questions.id），答案按它交回。 */
  id: string;
  instructions: string;
  options: { id: string; criteria: string }[];
}

export interface BackendRequest {
  questions: BackendQuestion[];
  /** 证据：给模型看的字段名 → 原文。原样喂，不裁剪。 */
  evidence: { label: string; text: string }[];
  signal?: AbortSignal;
}

/** 一道题的答案。invalid = 回包里有这道题，但形状认不出（原因写在里面）。 */
export type BackendAnswer = { option: string; confidence: number } | { invalid: string };

/** 连不上、超时、被拒……都是「没判」，不是「否」。 */
export type BackendFailure =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate_limited'
  | 'overloaded'
  | 'bad_request'
  | 'quota'
  | 'backend_error'
  | 'bad_answer'
  | 'model_mismatch';

export type BackendResult =
  | {
      ok: true;
      /** 题号 → 答案；回包里没有的题不在这里。 */
      answers: Record<string, BackendAnswer>;
      /** 实际回话的模型（后端报的版本号）。 */
      model: string;
      latencyMs: number;
      /** 这次问的输入 token；后端没报时按字符数保守估（tokensEstimated = true），不记 0。 */
      inputTokens: number;
      tokensEstimated: boolean;
    }
  | {
      ok: false;
      reason: BackendFailure;
      /** 上游原文或状态码，给人查。里面可能夹着上游回显的令牌之类，记库、交回调用方之前由 ask 统一脱敏。 */
      detail: string;
      latencyMs: number;
      /** 后端报了实际模型就带上（例如模型对不上时）。 */
      model?: string;
      /** 出错的回包里上游也报了输入 token 数就带上（例如模型对不上时）；没报的，ask 按事前估算记账。 */
      inputTokens?: number;
    };

export interface JevBackend {
  /** 后端种类：typesafe、claude-code……记进每条判断的样本里。 */
  readonly kind: string;
  /** 钉死的模型版本，不许是 latest 这类别名。 */
  readonly model: string;
  /** 按量计费的后端才有：每百万输入 token 多少美元（输出不计费）。有它就受每日花费上限管；订阅内的后端不给。 */
  readonly usdPerMTok?: number;
  ask(request: BackendRequest): Promise<BackendResult>;
}

/**
 * 上游原文（报错回包、认不出的回复）放进 detail 之前取一段：先整段脱敏再截。
 * 先截再脱敏会把跨过截断处的令牌截成认不出的半截，半截就原样漏进库。
 */
export function upstreamExcerpt(text: string, max: number): string {
  return redact(text, Number.POSITIVE_INFINITY).slice(0, max);
}

/** 按输入 token 折算的美元花费。 */
export function usdOf(inputTokens: number, usdPerMTok: number): number {
  return (inputTokens * usdPerMTok) / 1_000_000;
}

/** 没有 usage 时的保守估算：按一个字一个 token 算（中文大致如此，英文会多估），宁可多记不记少。 */
export function estimateTokens(texts: readonly string[]): number {
  return texts.reduce((sum, t) => sum + t.length, 0);
}

/** 一次请求里会喂给模型的全部文字（证据、题面、选项），事先估花费用。 */
export function requestTexts(request: BackendRequest): string[] {
  return [
    ...request.evidence.flatMap((e) => [e.label, e.text]),
    ...request.questions.flatMap((q) => [
      q.id,
      q.instructions,
      ...q.options.flatMap((o) => [o.id, o.criteria]),
    ]),
  ];
}

const ALIAS = /latest|preview|stable|default/i;

/**
 * 模型必须钉死版本：别名一漂，攒下的准确率就不作数了。
 * TypeSafe 要 jev-<主>.<次>.<补>；Claude 要具体型号（claude-opus-5-5），别名（opus）不行。
 */
export function checkPinnedModel(kind: string, model: string): string | undefined {
  if (!model.trim()) return '没给模型';
  if (ALIAS.test(model)) return `模型 ${model} 是别名，要钉死到具体版本`;
  if (kind === 'typesafe' && !/^jev-\d+\.\d+\.\d+$/.test(model))
    return `TypeSafe 的模型要写成 jev-<主>.<次>.<补>（例如 jev-1.13.0），现在是 ${model}`;
  if (kind === 'claude-code' && !/^claude-[a-z]+(?:-\d+)+$/.test(model))
    return `Claude 的模型要写具体型号（例如 claude-opus-5-5），现在是 ${model}`;
  return undefined;
}

export function assertPinnedModel(kind: string, model: string): void {
  const problem = checkPinnedModel(kind, model);
  if (problem) throw new Error(problem);
}
