// 按族挑模型（#555-2 装配侧）的测试：0006 的顺序、跳过写这张单的族、挑不出来回 undefined（不许拿默认模型顶上）、
// 选路回了别的族不替它改名、读库读不到要**抛**（不许当成「这个族没有」——那是拿没查成当没问题）。

import { acceptancePurpose } from '@fleet-dao/shared/flow-purposes';
import { describe, expect, it } from 'vitest';
import { type FamilyPickDeps, familyPickerFrom, pickFamilyModel } from '../src/cold-verify-pick.ts';
import type { PickRouteInput, PickRouteResult } from '../src/ports.ts';

const ORDER = ['gpt', 'grok', 'claude', 'deepseek', 'kimi'] as const;

/** 记下每个族被问过没；只让 `available` 里的族回路由。 */
function picker(available: Record<string, string>, asked: string[] = []): FamilyPickDeps {
  return {
    async pickRouteForFamily(family) {
      asked.push(family);
      const modelId = available[family];
      if (modelId === undefined) return undefined;
      return { routeId: `r-${family}`, poolId: `p-${family}`, modelId, family, hostId: 'claude-code' };
    },
  };
}

describe('pickFamilyModel：按 0006 的顺序、跳过写这张单的族', () => {
  it('avoid=gpt → 第一家问的就是 gpt 之后的 grok', async () => {
    const asked: string[] = [];
    const got = await pickFamilyModel(ORDER, 'gpt', picker({ grok: 'grok-x' }, asked));
    expect(got).toEqual({ modelId: 'grok-x', family: 'grok', channel: 'p-grok' });
    expect(asked).toEqual(['grok']); // 问到就停，不接着问后面的
  });

  it('avoid=kimi 且前面的族都没有 → 跳过 kimi、顺序问到 grok', async () => {
    const asked: string[] = [];
    const got = await pickFamilyModel(ORDER, 'kimi', picker({ grok: 'grok-x' }, asked));
    expect(got?.family).toBe('grok');
    expect(asked).toEqual(['gpt', 'grok']);
  });

  it('顺序里排最前的那一族有得派就一定选它（不看别的族好不好）', async () => {
    const got = await pickFamilyModel(
      ORDER,
      'claude',
      picker({ gpt: 'gpt-x', deepseek: 'ds-x', kimi: 'kimi-x' }),
    );
    expect(got?.family).toBe('gpt');
  });

  it('族的写法带空格、大小写不一样，照样跳过（不许因为写错就同族自审）', async () => {
    const asked: string[] = [];
    const got = await pickFamilyModel(ORDER, '  GPT ', picker({ claude: 'claude-x' }, asked));
    expect(got?.family).toBe('claude');
    expect(asked).not.toContain('gpt');
  });
});

describe('pickFamilyModel：故意造出的失败 → 不许拿默认模型顶上', () => {
  it('所有族都挑不出 → undefined（不是拿顺序里第一个顶）', async () => {
    const asked: string[] = [];
    const got = await pickFamilyModel(ORDER, 'gpt', picker({}, asked));
    expect(got).toBeUndefined();
    expect(asked).toEqual(['grok', 'claude', 'deepseek', 'kimi']); // gpt 跳过了
  });

  it('【故意造出的失败】只剩写这张单的那一族可用 → 照旧 undefined（宁可没讨论成，不许同族自审）', async () => {
    const got = await pickFamilyModel(ORDER, 'gpt', picker({ gpt: 'gpt-x' }));
    expect(got).toBeUndefined();
  });

  it('【故意造出的失败】read 出问题时**抛出去**，不当成「这个族没有」', async () => {
    const deps: FamilyPickDeps = {
      async pickRouteForFamily() {
        throw new Error('db 连不上');
      },
    };
    await expect(pickFamilyModel(ORDER, 'gpt', deps)).rejects.toThrow('db 连不上');
  });

  it('空的族名、只有空格的不问（不是「问了没有」）', async () => {
    const asked: string[] = [];
    const got = await pickFamilyModel(['', '  ', 'claude'], 'gpt', picker({ claude: 'claude-x' }, asked));
    expect(got?.family).toBe('claude');
    expect(asked).toEqual(['claude']);
  });
});

describe('familyPickerFrom：接到真选路上（避开别的族、不替选路改名）', () => {
  function fakePort(pick: (input: PickRouteInput) => PickRouteResult) {
    const calls: PickRouteInput[] = [];
    return {
      calls,
      pickRoute: async (input: PickRouteInput) => {
        calls.push(input);
        return pick(input);
      },
    };
  }

  it('问 claude 时，把别的族全避开（gpt/deepseek/grok/kimi 都在 avoidFamilies 里）', async () => {
    const port = fakePort(() => ({
      ok: true,
      route: { routeId: 'r', poolId: 'p', modelId: 'claude-x', family: 'claude', hostId: 'claude-code' },
      why: '这一族有得派',
    }));
    const deps = familyPickerFrom(port.pickRoute, ORDER)('task-1');
    const got = await deps.pickRouteForFamily('claude');
    expect(got?.modelId).toBe('claude-x');
    expect(port.calls[0]?.avoidFamilies?.sort()).toEqual(['deepseek', 'gpt', 'grok', 'kimi']);
    // 【故意造出的失败】冷验收实际拿去选路的用途，不是页面上叫「验收」的那一格就红
    expect(port.calls[0]?.stage).toBe(acceptancePurpose());
  });

  it('界面活（uiWork）：每一族的选路请求都带 uiWork: true；非界面活的请求里没有这个字段', async () => {
    const answer = (): PickRouteResult => ({
      ok: true,
      route: { routeId: 'r', poolId: 'p', modelId: 'grok-x', family: 'grok', hostId: 'grok' },
      why: '这一族有得派',
    });
    const ui = fakePort(answer);
    const uiDeps = familyPickerFrom(ui.pickRoute, ORDER, 'review', undefined, true)('task-1');
    await uiDeps.pickRouteForFamily('gpt');
    await uiDeps.pickRouteForFamily('grok');
    expect(ui.calls.map((c) => c.uiWork)).toEqual([true, true]);
    const plain = fakePort(answer);
    await familyPickerFrom(plain.pickRoute, ORDER)('task-1').pickRouteForFamily('grok');
    expect(plain.calls[0]).not.toHaveProperty('uiWork');
  });

  it('【故意造出的失败】选路因硬禁令回「没有路由」（GPT 遇上界面活）→ 这一族没有，pickFamilyModel 往下问下一家', async () => {
    const port = fakePort((input) =>
      input.uiWork && !(input.avoidFamilies ?? []).includes('gpt')
        ? { ok: false, waitFor: 'none', detail: '犯禁令：GPT 不做 UI 类活' }
        : {
            ok: true,
            route: { routeId: 'r', poolId: 'p', modelId: 'grok-x', family: 'grok', hostId: 'grok' },
            why: '有得派',
          },
    );
    const deps = familyPickerFrom(port.pickRoute, ORDER, 'review', undefined, true)('task-1');
    const got = await pickFamilyModel(ORDER, 'claude', deps);
    expect(got?.family).toBe('grok');
    expect(port.calls.map((c) => (c.avoidFamilies ?? []).includes('gpt'))).toEqual([false, true]);
  });

  it('【故意造出的失败】选路回了别的族（渠道自己挑模型的）→ 当成没挑到，不替它改名', async () => {
    const port = fakePort(() => ({
      ok: true,
      route: { routeId: 'r', poolId: 'p', modelId: 'auto-x', family: 'gemini', hostId: 'claude-code' },
      why: '渠道自己挑的模型',
    }));
    const deps = familyPickerFrom(port.pickRoute, ORDER)('task-1');
    expect(await deps.pickRouteForFamily('claude')).toBeUndefined();
  });

  it('选路说派不出（等空位/等额度）→ 这一族这一刻没有，回 undefined', async () => {
    const port = fakePort(() => ({ ok: false, waitFor: 'slot', detail: '池满了' }));
    const deps = familyPickerFrom(port.pickRoute, ORDER)('task-1');
    expect(await deps.pickRouteForFamily('claude')).toBeUndefined();
  });

  it('派不出的原因告诉调用方（等空位、等额度的和一条路由都没有的要分得开）；派得出的、别的族的不报', async () => {
    const seen: { family: string; waitFor: string; detail: string }[] = [];
    let answer: PickRouteResult = { ok: false, waitFor: 'slot', detail: '池满了', retryAfterSeconds: 30 };
    const port = fakePort(() => answer);
    const deps = familyPickerFrom(port.pickRoute, ORDER, 'review', (family, why) => {
      seen.push({ family, waitFor: why.waitFor, detail: why.detail });
    })('task-1');
    await deps.pickRouteForFamily('Claude ');
    answer = { ok: false, waitFor: 'none', detail: '没有路由' };
    await deps.pickRouteForFamily('gpt');
    answer = {
      ok: true,
      route: { routeId: 'r', poolId: 'p', modelId: 'auto-x', family: 'gemini', hostId: 'claude-code' },
      why: '渠道自己挑的',
    };
    await deps.pickRouteForFamily('kimi'); // 选路回了别的族：当成没挑到，但这不是「选路说派不出」，不报
    expect(seen).toEqual([
      { family: 'claude', waitFor: 'slot', detail: '池满了' },
      { family: 'gpt', waitFor: 'none', detail: '没有路由' },
    ]);
  });
});
