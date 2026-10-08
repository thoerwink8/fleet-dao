// 上游串拆名（#1355）。串取自 #1354 正文前那份差集，名单在 fixtures/roster-diff-2026-10-08.json：
// 2026-10-08 法国会话用户按引擎同一条读法读到的名册，减去当时 deploy/catalog.json 里该渠道已写的上游串。
// Cursor 230 条，对上正文「Cursor 一家差两百多个串」。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoveredModelId, nameUpstreamModel } from '../src/model-naming.ts';

const rosterDiff = JSON.parse(
  readFileSync(new URL('./fixtures/roster-diff-2026-10-08.json', import.meta.url), 'utf8'),
) as {
  cursorMissing: string[];
  mirasimMissing: string[];
  grokRoster: string[];
  grokMissing: string[];
  grokComparedAlias: string;
};

const named = (channelId: string, raw: string) => {
  const got = nameUpstreamModel(channelId, raw);
  if ('unclassified' in got && got.unclassified) {
    throw new Error(`${channelId} ${raw} 拆不出`);
  }
  return got;
};

describe('上游串拆名', () => {
  it('三家用的串都在 #1354 正文前那份差集里', () => {
    expect(rosterDiff.cursorMissing.length).toBe(230);
    for (const raw of [
      'claude-opus-4-8-thinking-high-fast',
      'claude-opus-5-5-low',
      'claude-sonnet-5-thinking-max',
      'cursor-grok-4.5-high-fast',
      'composer-2.5-fast',
      'grok-4.7-xhigh',
      'claude-haiku-5-5-low',
      'claude-4.6-sonnet-medium',
      'gpt-5.5-extra-high',
    ]) {
      expect(rosterDiff.cursorMissing).toContain(raw);
    }
    for (const raw of [
      'claude-opus-5-5[1m]',
      'claude-sonnet-5-5[1m]',
      'claude-opus-4-8[1m]',
      'claude-opus-5[1m]',
      'claude-fable-5-1[1m]',
      'claude-haiku-4-5',
      'kimi-code/k3',
      'gemini-3.1-pro-preview',
    ]) {
      expect(rosterDiff.mirasimMissing).toContain(raw);
    }
    expect(rosterDiff.grokRoster).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
    expect(rosterDiff.grokMissing).toEqual(['grok-4.5']);
    expect(rosterDiff.grokComparedAlias).toBe('grok-4.7-build');
  });

  it('Cursor：思考档、fast、上下文各自落在变体上，模型 id 把同一家并到一起', () => {
    expect(named('cursor', 'claude-opus-4-8-thinking-high-fast')).toEqual({
      modelId: 'opus-4.8',
      family: 'claude',
      effort: 'high',
      fast: true,
      thinking: true,
      context: null,
    });
    expect(named('cursor', 'claude-opus-5-5-low')).toEqual({
      modelId: 'opus-5.5',
      family: 'claude',
      effort: 'low',
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'claude-sonnet-5-thinking-max')).toEqual({
      modelId: 'sonnet-5',
      family: 'claude',
      effort: 'max',
      fast: false,
      thinking: true,
      context: null,
    });
    expect(named('cursor', 'cursor-grok-4.5-high-fast')).toEqual({
      modelId: 'grok-4.5',
      family: 'grok',
      effort: 'high',
      fast: true,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'composer-2.5-fast')).toEqual({
      modelId: 'composer-2.5',
      family: 'cursor',
      effort: null,
      fast: true,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'grok-4.7-xhigh')).toEqual({
      modelId: 'grok-4.7',
      family: 'grok',
      effort: 'xhigh',
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('cursor', 'claude-haiku-5-5-low')).toEqual({
      modelId: 'haiku-5.5',
      family: 'claude',
      effort: 'low',
      fast: false,
      thinking: false,
      context: null,
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
    expect(named('mirasim', 'claude-sonnet-5-5[1m]')).toEqual({
      modelId: 'sonnet-5.5',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: '1m',
    });
    expect(named('mirasim', 'claude-opus-4-8[1m]')).toEqual({
      modelId: 'opus-4.8',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: '1m',
    });
    expect(named('mirasim', 'claude-opus-5[1m]')).toEqual({
      modelId: 'opus-5',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: '1m',
    });
    expect(named('mirasim', 'claude-fable-5-1[1m]')).toEqual({
      modelId: 'fable-5.1',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: '1m',
    });
    expect(named('mirasim', 'claude-haiku-4-5')).toEqual({
      modelId: 'haiku-4.5',
      family: 'claude',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('mirasim', 'kimi-code/k3')).toEqual({
      modelId: 'kimi-k3',
      family: 'kimi',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
  });

  it('Mirasim：Grok 和 Gemini 也拆得出（grok-4.7 不是未归类，preview 并到同一个模型）', () => {
    for (const version of ['4.5', '4.6', '4.7']) {
      expect(named('mirasim', `grok-${version}`)).toEqual({
        modelId: `grok-${version}`,
        family: 'grok',
        effort: null,
        fast: false,
        thinking: false,
        context: null,
      });
    }
    expect(named('mirasim', 'gemini-3.1-pro-preview')).toEqual({
      modelId: 'gemini-3.1-pro',
      family: 'gemini',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
  });

  it('【故意造出的失败】名册里差集的每个 Mirasim 串都拆得出：有一个拆不出这里就红，点名是哪个', () => {
    const unsplit = rosterDiff.mirasimMissing.filter(
      (raw) => 'unclassified' in nameUpstreamModel('mirasim', raw),
    );
    expect(unsplit).toEqual([]);
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
    expect(named('xai', 'grok-4.7-build-fast')).toEqual({
      modelId: 'grok-4.7',
      family: 'grok',
      effort: null,
      fast: true,
      thinking: false,
      context: null,
    });
    expect(named('xai', 'grok-4.6')).toEqual({
      modelId: 'grok-4.6',
      family: 'grok',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('xai', 'grok-4.5')).toEqual({
      modelId: 'grok-4.5',
      family: 'grok',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
    expect(named('xai', 'grok-4.7-build')).toEqual({
      modelId: 'grok-4.7',
      family: 'grok',
      effort: null,
      fast: false,
      thinking: false,
      context: null,
    });
  });

  it('拆不出的返回 unclassified，模型 id 用渠道编号加原串', () => {
    expect(nameUpstreamModel('cursor', 'claude-4.6-sonnet-medium')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('cursor', 'gpt-5.5-extra-high')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('mirasim', 'qwen-3.7-coder')).toEqual({ unclassified: true });
    expect(nameUpstreamModel('mirasim', 'claude-opus-5-5[2x]')).toEqual({ unclassified: true });
    expect(discoveredModelId('cursor', 'claude-4.6-sonnet-medium')).toBe('cursor:claude-4.6-sonnet-medium');
    expect(discoveredModelId('cursor', 'gpt-5.5-extra-high')).toBe('cursor:gpt-5.5-extra-high');
    expect(discoveredModelId('mirasim', 'qwen-3.7-coder')).toBe('mirasim:qwen-3.7-coder');
    expect(discoveredModelId('cursor', 'claude-opus-4-8-thinking-high-fast')).toBe('opus-4.8');
  });
});
