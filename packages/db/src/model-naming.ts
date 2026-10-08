// 渠道名册上的上游串拆成目录模型（#1355）。每家一张规则表，拆不出的不猜。
// 变体（档位、thinking、fast、上下文）写在路由上；同一个模型的各档并到一个模型 id。
import { isSessionEffort, type SessionEffort } from '@fleet-dao/shared';

export interface ClassifiedUpstream {
  modelId: string;
  family: string;
  effort: SessionEffort | null;
  /** 拆出来了就写死真或假；拆不出的整条走 unclassified，不在这里用空表示「不知道」。 */
  fast: boolean;
  thinking: boolean;
  context: string | null;
}

export type NamedUpstream = { unclassified: true } | ClassifiedUpstream;

interface Flags {
  effort: SessionEffort | null;
  fast: boolean;
  thinking: boolean;
  context: string | null;
  effortSet: boolean;
  fastSet: boolean;
  thinkingSet: boolean;
  contextSet: boolean;
}

type SuffixKind = 'effort' | 'fast' | 'thinking' | 'build';

interface BaseRule {
  family: string;
  pattern: RegExp;
  modelId: (match: RegExpMatchArray) => string;
}

interface ChannelRule {
  suffixes: readonly SuffixKind[];
  bases: readonly BaseRule[];
  /** Cursor 的 grok 串带 cursor- 前缀，目录里的模型 id 不带。 */
  dropCursorGrokPrefix: boolean;
}

const CONTEXT_TOKEN = /^(\d+(?:\.\d+)?)([km])$/i;
const EFFORT_TAIL = /-(xhigh|max|high|medium|low)$/;

function blankFlags(): Flags {
  return {
    effort: null,
    fast: false,
    thinking: false,
    context: null,
    effortSet: false,
    fastSet: false,
    thinkingSet: false,
    contextSet: false,
  };
}

function contextToken(raw: string): string | null {
  const match = CONTEXT_TOKEN.exec(raw.trim());
  const digits = match?.[1];
  const unit = match?.[2];
  if (!digits || !unit) return null;
  return `${digits}${unit.toLowerCase()}`;
}

function setEffort(flags: Flags, value: string): boolean {
  if (!isSessionEffort(value)) return false;
  if (flags.effortSet && flags.effort !== value) return false;
  flags.effort = value;
  flags.effortSet = true;
  return true;
}

function setFast(flags: Flags, value: boolean): boolean {
  if (flags.fastSet && flags.fast !== value) return false;
  flags.fast = value;
  flags.fastSet = true;
  return true;
}

function setThinking(flags: Flags, value: boolean): boolean {
  if (flags.thinkingSet && flags.thinking !== value) return false;
  flags.thinking = value;
  flags.thinkingSet = true;
  return true;
}

function setContext(flags: Flags, value: string): boolean {
  const context = contextToken(value);
  if (!context) return false;
  if (flags.contextSet && flags.context !== context) return false;
  flags.context = context;
  flags.contextSet = true;
  return true;
}

/** 整串末尾的 [1m] 或 [k=v,…] 拆开。有方括号但形状不对就拆不出。 */
function takeBracket(raw: string): { body: string; bracket: string | null } | null {
  if (!raw.includes('[')) return { body: raw, bracket: null };
  const match = /^([^[\]]+)\[([^[\]]+)\]$/.exec(raw);
  const body = match?.[1];
  const bracket = match?.[2];
  if (!body || !bracket) return null;
  return { body, bracket };
}

function applyBracket(flags: Flags, bracket: string): boolean {
  const bare = contextToken(bracket);
  if (bare) return setContext(flags, bare);
  const parts = bracket.split(',');
  if (parts.length === 0) return false;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return false;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) return false;
    if (key === 'context') {
      if (!setContext(flags, value)) return false;
    } else if (key === 'fast') {
      if (value !== 'true' && value !== 'false') return false;
      if (!setFast(flags, value === 'true')) return false;
    } else if (key === 'thinking') {
      if (value !== 'true' && value !== 'false') return false;
      if (!setThinking(flags, value === 'true')) return false;
    } else if (key === 'reasoning' || key === 'reasoning_effort' || key === 'effort') {
      if (!setEffort(flags, value)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function stripSuffixes(body: string, allowed: readonly SuffixKind[], flags: Flags): string | null {
  let rest = body;
  let sawBuild = false;
  const allow = new Set(allowed);
  for (;;) {
    const effort = allow.has('effort') ? EFFORT_TAIL.exec(rest) : null;
    if (effort?.[1]) {
      if (!setEffort(flags, effort[1])) return null;
      rest = rest.slice(0, -effort[0].length);
      continue;
    }
    if (allow.has('fast') && rest.endsWith('-fast')) {
      if (!setFast(flags, true)) return null;
      rest = rest.slice(0, -'-fast'.length);
      continue;
    }
    if (allow.has('thinking') && rest.endsWith('-thinking')) {
      if (!setThinking(flags, true)) return null;
      rest = rest.slice(0, -'-thinking'.length);
      continue;
    }
    if (allow.has('build') && rest.endsWith('-build')) {
      if (sawBuild) return null;
      sawBuild = true;
      rest = rest.slice(0, -'-build'.length);
      continue;
    }
    return rest;
  }
}

const claudeBase: BaseRule = {
  family: 'claude',
  pattern: /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)$/,
  modelId: (match) => `${match[1]}-${(match[2] ?? '').replaceAll('-', '.')}`,
};

const gptBase: BaseRule = {
  family: 'gpt',
  pattern: /^gpt-\d+(?:\.\d+)*(?:-(?:codex|sol|terra|luna|astra))?$/,
  modelId: (match) => match[0],
};

const grokBase: BaseRule = {
  family: 'grok',
  pattern: /^grok-(\d+(?:\.\d+)*)$/,
  modelId: (match) => `grok-${match[1] ?? ''}`,
};

const geminiBase: BaseRule = {
  family: 'gemini',
  // -preview 是同一个模型的预览构建，并到同一个模型 id；上游原串留在路由上。
  pattern: /^gemini-\d+(?:\.\d+)*-(?:flash|pro)(?:-preview)?$/,
  modelId: (match) => match[0].replace(/-preview$/, ''),
};

const composerBase: BaseRule = {
  family: 'cursor',
  pattern: /^composer-\d+(?:\.\d+)*$/,
  modelId: (match) => match[0],
};

const kimiCodeBase: BaseRule = {
  family: 'kimi',
  pattern: /^kimi-code\/k3$/,
  modelId: () => 'kimi-k3',
};

const kimiBase: BaseRule = {
  family: 'kimi',
  pattern: /^kimi-[\w.]+$/,
  modelId: (match) => match[0],
};

const glmBase: BaseRule = {
  family: 'glm',
  pattern: /^glm-\d+(?:\.\d+)*(?:-flash)?$/,
  modelId: (match) => match[0],
};

const museBase: BaseRule = {
  family: 'muse',
  pattern: /^muse-spark-\d+(?:\.\d+)*$/,
  modelId: (match) => match[0],
};

const deepseekBase: BaseRule = {
  family: 'deepseek',
  pattern: /^deepseek(?:-[\w.]+)+$/,
  modelId: (match) => match[0],
};

/** Cursor 名册：连字符档位，也有 [context=、reasoning=、fast=] 这种括号。 */
const CURSOR_RULES: ChannelRule = {
  suffixes: ['effort', 'fast', 'thinking'],
  bases: [
    claudeBase,
    grokBase,
    gptBase,
    geminiBase,
    composerBase,
    kimiCodeBase,
    kimiBase,
    glmBase,
    museBase,
    deepseekBase,
  ],
  dropCursorGrokPrefix: true,
};

/** Mirasim 名册：模型 id 后面常跟 [1m]。中转的有 Claude、GPT、Grok、Gemini、Kimi、GLM、DeepSeek。 */
const MIRASIM_RULES: ChannelRule = {
  suffixes: ['effort', 'fast', 'thinking'],
  bases: [claudeBase, gptBase, grokBase, geminiBase, kimiCodeBase, kimiBase, glmBase, deepseekBase],
  dropCursorGrokPrefix: false,
};

/** Grok 命令行：grok-<版本>，-build 和 -fast 是同一版本的变体。 */
const GROK_RULES: ChannelRule = {
  suffixes: ['fast', 'build'],
  bases: [grokBase],
  dropCursorGrokPrefix: false,
};

/** Claude 订阅目前读不到名单；真读到了只认 Claude 自家的串。 */
const CLAUDE_RULES: ChannelRule = {
  suffixes: ['effort', 'fast', 'thinking'],
  bases: [claudeBase],
  dropCursorGrokPrefix: false,
};

const RULES_BY_CHANNEL: Record<string, ChannelRule> = {
  cursor: CURSOR_RULES,
  mirasim: MIRASIM_RULES,
  xai: GROK_RULES,
  'claude-sub': CLAUDE_RULES,
};

function matchBase(body: string, bases: readonly BaseRule[]): { modelId: string; family: string } | null {
  for (const rule of bases) {
    const match = rule.pattern.exec(body);
    if (!match) continue;
    const modelId = rule.modelId(match);
    if (!modelId || modelId.endsWith('-')) return null;
    return { modelId, family: rule.family };
  }
  return null;
}

function nameWith(rule: ChannelRule, raw: string): ClassifiedUpstream | null {
  const split = takeBracket(raw);
  if (!split) return null;
  const flags = blankFlags();
  if (split.bracket !== null && !applyBracket(flags, split.bracket)) return null;
  const stripped = stripSuffixes(split.body, rule.suffixes, flags);
  if (stripped === null) return null;
  const body =
    rule.dropCursorGrokPrefix && stripped.startsWith('cursor-grok-')
      ? stripped.slice('cursor-'.length)
      : stripped;
  const base = matchBase(body, rule.bases);
  if (!base) return null;
  return {
    modelId: base.modelId,
    family: base.family,
    effort: flags.effort,
    fast: flags.fast,
    thinking: flags.thinking,
    context: flags.context,
  };
}

export function nameUpstreamModel(channelId: string, raw: string): NamedUpstream {
  const rule = RULES_BY_CHANNEL[channelId];
  if (!rule) return { unclassified: true };
  return nameWith(rule, raw) ?? { unclassified: true };
}

/** 拆不出时模型 id 是「渠道:原串」，原串不改写。 */
export function discoveredModelId(channelId: string, raw: string): string {
  const named = nameUpstreamModel(channelId, raw);
  if ('unclassified' in named) return `${channelId}:${raw}`;
  return named.modelId;
}
