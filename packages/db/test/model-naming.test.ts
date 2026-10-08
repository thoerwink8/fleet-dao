// 渠道名册上的上游串拆成目录模型（#1355）。#1354 正文没有贴那份差集，下面的真实串取自目录注释、
// Mirasim 名册（docs/reference/adapters.md MS-29、MS-30）、`grok models` 列出的四个名字，以及 Cursor 名册夹具。
import { describe, expect, it } from 'vitest';
import { discoveredModelId, nameUpstreamModel } from '../src/model-naming.ts';

const named = (channelId: string, raw: string) => {
  const got = nameUpstreamModel(channelId, raw);
  if ('unclassified' in got && got.unclassified) {
    throw new Error(`${channelId} ${raw} 拆不出`);
  }
  return got;
};

describe('上游串拆名', () => {
  it('Cursor：思考档、fast、上下文括号各自落在变体上，模型 id 把同一家并到一起', () => {
    expect(named('cursor', 'claude-opus-4-8-thinking-high-fast')).toEqual({
      modelId: 'opus-4.8',
      family: 'claude',
      effort: 'high',
      fast: true,
      thinking: true,
      context: null,
    });
    expect(named('cursor', 'claude-opus-5-5-low')).toMatchObject({
      modelId: 'opus-5.5',
      family: 'claude',
      effort: 'low',
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'claude-sonnet-5-thinking-max')).toMatchObject({
      modelId: 'sonnet-5',
      family: 'claude',
      effort: 'max',
      thinking: true,
      fast: false,
    });
    expect(named('cursor', 'cursor-grok-4.5-high-fast')).toEqual({
      modelId: 'grok-4.5',
      family: 'grok',
      effort: 'high',
      fast: true,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'composer-2.5-fast')).toMatchObject({
      modelId: 'composer-2.5',
      family: 'cursor',
      fast: true,
      thinking: false,
      effort: null,
    });
    expect(named('cursor', 'grok-4.7[context=256k,reasoning=high]')).toEqual({
      modelId: 'grok-4.7',
      family: 'grok',
      effort: 'high',
      fast: false,
      thinking: false,
      context: '256k',
    });
    expect(named('cursor', 'claude-opus-4-8-thinking-high')).toMatchObject({
      modelId: 'opus-4.8',
      effort: 'high',
      thinking: true,
      fast: false,
    });
  });

  it('Mirasim：方括号里的上下文留下，kimi 名册名并到目录 id', () => {
    expect(named('mirasim', 'claude-opus-5-5[1m]')).toEqual({
      modelId: 'opus-5.5',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: '1m',
    });
    expect(named('mirasim', 'claude-sonnet-5-5[1m]')).toMatchObject({
      modelId: 'sonnet-5.5',
      context: '1m',
    });
    expect(named('mirasim', 'claude-opus-4-8[1m]')).toMatchObject({ modelId: 'opus-4.8', context: '1m' });
    expect(named('mirasim', 'claude-fable-5[1m]')).toMatchObject({
      modelId: 'fable-5',
      family: 'claude',
      context: '1m',
    });
    expect(named('mirasim', 'gpt-6-sol')).toEqual({
      modelId: 'gpt-6-sol',
      family: 'gpt',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('mirasim', 'kimi-code/k3')).toMatchObject({ modelId: 'kimi-k3', family: 'kimi' });
    expect(named('mirasim', 'deepseek-v4-pro')).toMatchObject({
      modelId: 'deepseek-v4-pro',
      family: 'deepseek',
    });
    expect(named('mirasim', 'glm-5.3-flash')).toMatchObject({ modelId: 'glm-5.3-flash', family: 'glm' });
  });

  it('Grok：渠道编号是 xai；-build 和 -fast 并到同一个 grok 版本，不另开模型', () => {
    expect(named('xai', 'grok-4.7')).toEqual({
      modelId: 'grok-4.7',
      family: 'grok',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('xai', 'grok-4.7-build-fast')).toMatchObject({ modelId: 'grok-4.7', fast: true });
    expect(named('xai', 'grok-4.6')).toMatchObject({ modelId: 'grok-4.6', family: 'grok', fast: false });
    expect(named('xai', 'grok-4.5')).toMatchObject({ modelId: 'grok-4.5', fast: false });
    expect(named('xai', 'grok-4.7-build')).toMatchObject({
      modelId: 'grok-4.7',
      fast: false,
      thinking: false,
    });
  });

  it('拆不出的返回 unclassified，模型 id 用渠道编号加原串', () => {
    expect(nameUpstreamModel('cursor', 'totally-unknown-model')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('mirasim', '???')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('xai', 'grok-mystery-ultra')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('cursor', 'claude-opus-4-8-thinking-ultra')).toEqual({ unclassified: true });
    expect(discoveredModelId('cursor', 'totally-unknown-model')).toBe('cursor:totally-unknown-model');
    expect(discoveredModelId('mirasim', '???')).toBe('mirasim:???');
    expect(discoveredModelId('xai', 'grok-mystery-ultra')).toBe('xai:grok-mystery-ultra');
    expect(discoveredModelId('cursor', 'claude-opus-4-8-thinking-high-fast')).toBe('opus-4.8');
  });
});
