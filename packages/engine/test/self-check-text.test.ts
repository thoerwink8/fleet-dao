// 自测结果合成的那一段（selfCheckText，喂回会话、交给冷验收）：测试没出结果、只有 tsc 过了时写明「类型检查过了、测试没跑完」，
// 不让人当成测试过了；已知没过的照样列出来；不编完成了几条。

import { describe, expect, it } from 'vitest';
import { SELF_CHECK_DIGEST_MAX, type SelfCheckResult } from '../src/task-contract.ts';
import { selfCheckText } from '../src/workflows/task-support.ts';

const TSC = 'node_modules/.bin/tsc -b --pretty false';

describe('selfCheckText', () => {
  it('测试没跑完、tsc 过了：开头写明类型检查过了、测试没有结果、以完整 CI 为准', () => {
    const result: SelfCheckResult = {
      state: 'green',
      steps: [
        {
          command: 'pnpm test:changed',
          outcome: 'skipped',
          exitCode: null,
          digest: '执行超过 30 分 0 秒，没跑完，交给 CI\n执行 30 分 0 秒（2026-10-16T10:12:37.000Z 起）。',
        },
        { command: TSC, outcome: 'pass', exitCode: 0, digest: '' },
      ],
    };
    const text = selfCheckText(result);
    expect(text.split('\n')[0]).toBe(
      '类型检查过了；测试没有结果（没跑或没跑完），不等于测试过了，以完整 CI 为准。',
    );
    expect(text).toContain('$ pnpm test:changed：没跑或没跑完');
    expect(text).toContain('2026-10-16T10:12:37.000Z');
    expect(text).toContain(`$ ${TSC}：过了`);
    expect(text).not.toMatch(/\d+ passed/);
  });

  it('要全跑之后受影响的包超时前已有失败：照样是没过，开头那句不出现、不盖住失败', () => {
    const result: SelfCheckResult = {
      state: 'red',
      steps: [
        { command: 'pnpm test:changed', outcome: 'skipped', exitCode: 3, digest: '改动要全跑' },
        {
          command: 'pnpm test:changed --affected',
          outcome: 'fail',
          exitCode: null,
          digest: '执行超过 30 分 0 秒，没跑完；超时前已经有没过的\n FAIL a.test.ts > 少了一行',
        },
        { command: TSC, outcome: 'pass', exitCode: 0, digest: '' },
      ],
    };
    const text = selfCheckText(result);
    expect(text).not.toContain('不等于测试过了');
    expect(text).toContain('$ pnpm test:changed --affected：没过（没跑完）');
    expect(text).toContain('FAIL a.test.ts > 少了一行');
  });

  it('测试过了：不加那句；tsc 没过时写类型检查没过', () => {
    const ok = selfCheckText({
      state: 'green',
      steps: [
        { command: 'pnpm test:changed', outcome: 'pass', exitCode: 0, digest: 'Tests  3 passed (3)' },
        { command: TSC, outcome: 'pass', exitCode: 0, digest: '' },
      ],
    });
    expect(ok).not.toContain('不等于测试过了');
    const red = selfCheckText({
      state: 'red',
      steps: [
        { command: 'pnpm test:changed', outcome: 'skipped', exitCode: 2, digest: '没算成' },
        { command: TSC, outcome: 'fail', exitCode: 2, digest: 'error TS2322' },
      ],
    });
    expect(red.split('\n')[0]).toBe(
      '类型检查没过；测试没有结果（没跑或没跑完），不等于测试过了，以完整 CI 为准。',
    );
    expect(red).toContain('没过（退出码 2）');
  });

  it('整段没跑成、很长时：那句还在开头，总长不超过上限', () => {
    expect(selfCheckText({ state: 'skipped', reason: '树里没装依赖', steps: [] })).toBe(
      '没跑成：树里没装依赖',
    );
    const long = selfCheckText({
      state: 'green',
      steps: [
        { command: 'pnpm test:changed', outcome: 'skipped', exitCode: null, digest: 'x'.repeat(5000) },
        { command: TSC, outcome: 'pass', exitCode: 0, digest: '' },
      ],
    });
    expect(long.startsWith('类型检查过了；测试没有结果')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(SELF_CHECK_DIGEST_MAX);
  });
});
