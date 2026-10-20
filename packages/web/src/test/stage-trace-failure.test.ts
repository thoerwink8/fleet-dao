// @vitest-environment happy-dom
// 阶段记录（stage-trace.ts，#3372）装上、还原、输出出错时：不能变成测试失败，已建的定时器要清掉，要留下可读的失败说明、不能当成观测成功。
// 单独一个文件，因为这里要 mock testing-library 的 configure 让它按需抛错。
import * as rtl from '@testing-library/react';
import { afterAll, aroundEach, describe, expect, test, vi } from 'vitest';
import { installStageTrace } from './stage-trace';

const fail = { configure: 0 };
vi.mock('@testing-library/react', async (importOriginal) => {
  const real = await importOriginal<typeof import('@testing-library/react')>();
  return {
    ...real,
    configure: (cfg: Parameters<typeof real.configure>[0]) => {
      if (fail.configure > 0) {
        fail.configure -= 1;
        throw new Error('configure 坏了');
      }
      return real.configure(cfg);
    },
  };
});

const timeouts = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;

describe('装上失败：已建的定时器清掉，测试照常跑，留一行说明', () => {
  const lines: string[] = [];
  let baseline = 0;
  const original = rtl.getConfig().asyncWrapper;
  // 先于 installStageTrace 注册，所以包在它外面：记下基线，并让 installStageTrace 里第一次 configure 抛错。
  aroundEach(async (use) => {
    baseline = timeouts();
    fail.configure = 1;
    await use();
  });
  installStageTrace({ watchAtMs: 60_000, reportOverMs: 1e9, emit: (l) => lines.push(l) });

  test('configure 抛错 → 没有残留的计时器、没有观测成功的输出，测试本身不受影响', () => {
    expect(timeouts()).toBeLessThanOrEqual(baseline);
    expect(lines.some((l) => l.includes('没装上') && l.includes('configure 坏了'))).toBe(true);
    expect(lines.some((l) => l.includes('快超时') || l.includes('偏慢'))).toBe(false);
    expect(rtl.getConfig().asyncWrapper).toBe(original);
  });

  afterAll(() => {
    fail.configure = 0;
  });
});

describe('还原失败：不外冒、计时器已停，下一次装上不会把自己的 wrapper 当原值', () => {
  const lines: string[] = [];
  const original = rtl.getConfig().asyncWrapper;
  let baseline = 0;
  aroundEach(async (use) => {
    baseline = timeouts();
    await use();
  });
  installStageTrace({ watchAtMs: 60_000, reportOverMs: 0, emit: (l) => lines.push(l) });

  test('第一个：装上成功，收尾时 configure 抛错', () => {
    expect(rtl.getConfig().asyncWrapper).not.toBe(original);
    fail.configure = 1; // 下一次 configure（收尾时的还原）抛错
  });

  test('第二个：上一个的还原失败说明可读，计时器没留；这个自己能正常装上、收尾', () => {
    expect(lines.some((l) => l.startsWith('[阶段记录·还原失败]') && l.includes('configure 坏了'))).toBe(true);
    // 这个测试自己的探针和 watchdog 各占一个；多出来就是上一个漏清了。
    expect(timeouts()).toBeLessThanOrEqual(baseline + 2);
    // 上一个没还原成功：全局里还是 wrapper，这次装上不能把它当 base（会自己调自己）。
    expect(rtl.getConfig().asyncWrapper).not.toBe(original);
  });

  afterAll(() => {
    // 文件收尾时把全局还原回去（第二个测试的 aroundEach 收尾已经还原）。
    expect(rtl.getConfig().asyncWrapper).toBe(original);
    expect(lines.filter((l) => l.startsWith('[阶段记录·还原失败]'))).toHaveLength(1);
  });
});
