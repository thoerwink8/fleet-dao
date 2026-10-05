// e2e 按触发事件挑视口（全仓审查第 2 路清单 3）：PR 只走 1920，每夜、主线推送、本机两个都走。
import { afterEach, describe, expect, test, vi } from 'vitest';
import { viewportsFor } from '../e2e/support/viewports.ts';

describe('viewportsFor：事件名 → 这一轮走的视口', () => {
  test.each([
    ['pull_request', ['desktop-1920']],
    ['schedule', ['laptop-1366', 'desktop-1920']],
    ['push', ['laptop-1366', 'desktop-1920']],
    ['workflow_dispatch', ['laptop-1366', 'desktop-1920']],
    [undefined, ['laptop-1366', 'desktop-1920']],
    ['', ['laptop-1366', 'desktop-1920']],
  ])('%s → %j', (event, want) => {
    expect(viewportsFor(event)).toEqual(want);
  });

  test('【故意造出的失败】认不出的事件名（比如 pull_request_target、大小写不对）不当成 PR：照旧两个视口，宁可多走一遍', () => {
    expect(viewportsFor('pull_request_target')).toEqual(['laptop-1366', 'desktop-1920']);
    expect(viewportsFor('Pull_Request')).toEqual(['laptop-1366', 'desktop-1920']);
  });
});

describe('playwright.config.ts 真的照它挑项目', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const projectsUnder = async (event: string) => {
    vi.stubEnv('GITHUB_EVENT_NAME', event);
    vi.resetModules();
    const config = (await import('../e2e/playwright.config.ts')).default;
    return (config.projects ?? []).map((p) => [p.name, p.use?.viewport]);
  };

  test('pull_request：只有 desktop-1920', async () => {
    expect(await projectsUnder('pull_request')).toEqual([['desktop-1920', { width: 1920, height: 1080 }]]);
  });

  test('schedule：1366 在前（只读那一遍）、1920 在后', async () => {
    expect(await projectsUnder('schedule')).toEqual([
      ['laptop-1366', { width: 1366, height: 768 }],
      ['desktop-1920', { width: 1920, height: 1080 }],
    ]);
  });
});
