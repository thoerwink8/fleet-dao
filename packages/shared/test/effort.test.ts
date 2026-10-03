// 思考档位的叫法和「一条路由能配哪几档」（#470）：驾驶舱、骨架装载、引擎起会话都照这一份判，这里钉住判法。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_EFFORT,
  effortRank,
  GROK_EFFORTS,
  isSessionEffort,
  modelBracketEffort,
  routeEffortChoices,
  routeEffortProblem,
  SESSION_EFFORTS,
} from '../src/effort.ts';

describe('叫法', () => {
  it('从低到高五档，没配用 high', () => {
    expect([...SESSION_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(DEFAULT_SESSION_EFFORT).toBe('high');
    expect(effortRank('low')).toBeLessThan(effortRank('medium'));
    expect(effortRank('xhigh')).toBeLessThan(effortRank('max'));
  });

  it('【故意造出的失败】认不出的写法不算（大小写、空串、别的类型）', () => {
    expect(isSessionEffort('high')).toBe(true);
    for (const v of ['HIGH', '', 'turbo', null, undefined, 3]) expect(isSessionEffort(v)).toBe(false);
  });
});

describe('一条路由能配哪几档', () => {
  it('有单独参数的照这家认的档：Claude Code、Mirasim 五档全认，Grok 没有 max', () => {
    expect(routeEffortChoices('claude-code', 'claude-opus-5-5')).toEqual({
      kind: 'choices',
      values: SESSION_EFFORTS,
    });
    expect(routeEffortChoices('mirasim', 'kimi-k3')).toEqual({ kind: 'choices', values: SESSION_EFFORTS });
    expect(routeEffortChoices('grok', 'grok-4.7')).toEqual({ kind: 'choices', values: GROK_EFFORTS });
  });

  it('cursor 没有单独参数：方括号模型串能配（补进方括号），上游目录里的整串配不了', () => {
    expect(routeEffortChoices('cursor-agent', 'composer-2.5[fast=true]')).toEqual({
      kind: 'choices',
      values: SESSION_EFFORTS,
    });
    expect(routeEffortChoices('cursor-agent', 'gpt-5.6-luna-high', 'Cursor Agent')).toEqual({
      kind: 'fixed',
      why: 'Cursor Agent 没有单独的档位参数，模型串 gpt-5.6-luna-high 不带方括号（是上游目录里的整串，档位已经在名字里）',
    });
  });

  it('模型串方括号里已经写了档位：配不了别的，只认同一档', () => {
    const model = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]';
    expect(routeEffortChoices('cursor-agent', model)).toEqual({
      kind: 'fixed',
      why: `模型串 ${model} 的方括号里已经写了档位 high`,
      embedded: 'high',
    });
    expect(routeEffortProblem('cursor-agent', model, 'high')).toBeNull();
    expect(routeEffortProblem('cursor-agent', model, 'low')).toContain('思考档位写了两处');
  });

  it('不收档位的执行方式（没接上的 Codex、判断题的接口外壳）配不了', () => {
    expect(routeEffortChoices('codex', 'gpt-5.6-luna', 'Codex')).toEqual({
      kind: 'fixed',
      why: 'Codex引擎还没接上，起不了会话',
    });
    expect(routeEffortChoices('api-shell', 'jev-1.13.0')).toMatchObject({ kind: 'fixed' });
  });

  it('【故意造出的失败】判不过的每一种都回一句原因，不回空', () => {
    expect(routeEffortProblem('claude-code', 'claude-opus-5-5', 'max')).toBeNull();
    expect(routeEffortProblem('claude-code', 'claude-opus-5-5', 'turbo')).toBe(
      '思考档位（effort）不认识："turbo"（只有 low / medium / high / xhigh / max）',
    );
    expect(routeEffortProblem('grok', 'grok-4.7', 'max', 'Grok 命令行')).toBe(
      'Grok 命令行 不支持思考档位（effort）max（只认 low / medium / high / xhigh）',
    );
    expect(routeEffortProblem('cursor-agent', 'auto', 'high', 'Cursor Agent')).toContain(
      'Cursor Agent 不支持单独传思考档位（effort）"high"',
    );
    expect(routeEffortProblem('codex', 'gpt-5.6-luna', 'high')).toContain('不支持单独传思考档位');
  });

  it('【故意造出的失败】方括号里写了两处还对不上：配不了，原因照实说', () => {
    const model = 'm[effort=low,reasoning_effort=high]';
    expect(() => modelBracketEffort(model)).toThrow('写了两处还对不上');
    expect(routeEffortChoices('cursor-agent', model)).toEqual({
      kind: 'fixed',
      why: `模型串里的思考档位写了两处还对不上：${JSON.stringify(model)}`,
    });
  });
});
