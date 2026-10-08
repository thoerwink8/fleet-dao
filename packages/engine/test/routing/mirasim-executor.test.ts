// Mirasim 认不出执行体时选路不派（#1357）。未知前缀不得落到 claude。
import { resolveMirasimExecutor } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { chooseRoute } from '../../src/routing/index.ts';
import { input, route } from './helpers.ts';

describe('Mirasim 执行体未知不派', () => {
  it('前缀认得出、或名册记下了执行体，就派这条', () => {
    const byPrefix = chooseRoute(
      input([route('ds', { hostId: 'mirasim', modelId: 'deepseek-flash', upstreamModel: 'deepseek-flash' })]),
    );
    expect(byPrefix.kind).toBe('dispatch');
    if (byPrefix.kind === 'dispatch') expect(byPrefix.hostId).toBe('mirasim');

    const byField = chooseRoute(
      input([
        route('glm', {
          hostId: 'mirasim',
          modelId: 'glm-5.3-flash',
          upstreamModel: 'glm-5.3-flash',
          executor: 'zcode',
        }),
      ]),
    );
    expect(byField.kind).toBe('dispatch');
  });

  it('【故意造出的失败】未知前缀不得落到 claude', () => {
    const resolved = resolveMirasimExecutor({ upstreamModel: 'glm-9-unknown' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('不该认得出，更不该是 claude');
    expect(resolved).not.toHaveProperty('agent');
    expect(resolved.reason).toContain('执行体未知');

    const chosen = chooseRoute(
      input([
        route('glm', {
          hostId: 'mirasim',
          modelId: 'glm-9-unknown',
          upstreamModel: 'glm-9-unknown',
        }),
      ]),
    );
    expect(chosen.kind).toBe('none');
    if (chosen.kind !== 'none') throw new Error('未知前缀不该派出去');
    expect(chosen.reason).toContain('执行体未知');
    expect(chosen.reason).toContain('Mirasim 认不出这个模型该起哪个执行体：glm-9-unknown');
    expect(chosen.verdicts[0]?.blocks.map((b) => b.code)).toContain('executor-unknown');
  });
});
