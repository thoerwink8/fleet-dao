// Mirasim 模型串 → 执行体（#1357）。名册帧上的执行体优先；没有就按上游串前缀。
// 认不出的标「执行体未知」，不落到 claude 或任何默认执行体。
import { describe, expect, it } from 'vitest';
import { resolveMirasimExecutor } from '../src/mirasim-executor.ts';

describe('Mirasim 执行体', () => {
  it('名册给了执行体就用它，盖过前缀（glm 没有前缀，zcode 只能源自名册）', () => {
    expect(resolveMirasimExecutor({ rosterExecutor: 'zcode', upstreamModel: 'glm-5.3-flash' })).toEqual({
      ok: true,
      agent: 'zcode',
    });
    expect(resolveMirasimExecutor({ rosterExecutor: 'pi', upstreamModel: 'kimi-k3' })).toEqual({
      ok: true,
      agent: 'pi',
    });
  });

  it('没有名册字段时按前缀：claude-、gpt-、grok-、kimi-、deepseek-', () => {
    expect(resolveMirasimExecutor({ upstreamModel: 'claude-sonnet-5-5' })).toEqual({
      ok: true,
      agent: 'claude',
    });
    expect(resolveMirasimExecutor({ upstreamModel: '  gpt-6-sol' })).toEqual({ ok: true, agent: 'codex' });
    expect(resolveMirasimExecutor({ upstreamModel: 'grok-4.7' })).toEqual({ ok: true, agent: 'grok' });
    expect(resolveMirasimExecutor({ upstreamModel: 'kimi-k3' })).toEqual({ ok: true, agent: 'kimi' });
    expect(resolveMirasimExecutor({ upstreamModel: 'deepseek-v4-pro' })).toEqual({ ok: true, agent: 'dsh' });
  });

  it('空的名册字段、或记下的就是「执行体未知」，退回前缀', () => {
    expect(resolveMirasimExecutor({ rosterExecutor: '  ', upstreamModel: 'grok-4' })).toEqual({
      ok: true,
      agent: 'grok',
    });
    expect(
      resolveMirasimExecutor({ rosterExecutor: '执行体未知', upstreamModel: 'claude-opus-5-5' }),
    ).toEqual({
      ok: true,
      agent: 'claude',
    });
  });

  it('【故意造出的失败】未知前缀不得落到 claude', () => {
    const resolved = resolveMirasimExecutor({ upstreamModel: 'glm-6' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('不该认得出');
    expect(resolved).not.toHaveProperty('agent');
    expect(resolved.reason).toContain('执行体未知');
    expect(resolved.reason).toContain('Mirasim 认不出这个模型该起哪个执行体：glm-6');
    const empty = resolveMirasimExecutor({ rosterExecutor: '执行体未知', upstreamModel: '   ' });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('空串不该落到 claude');
    expect(empty).not.toHaveProperty('agent');
  });
});
