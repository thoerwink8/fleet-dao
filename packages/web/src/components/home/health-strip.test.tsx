// @vitest-environment happy-dom
// 顶栏状态胶囊（单 #1899）：用 StatusBadge 的 tone 色并带短状态字；窄于 1440 收进一个「状态」菜单。
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HealthStrip, healthItems, healthSummary } from './health-strip.tsx';
import type { HomeHealth } from './types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BAD: HomeHealth = {
  quota: { state: 'tight', detail: '2 个池快清零' },
  routes: { state: 'ok', detail: '12 在线' },
  engine: { state: 'down', detail: '探不到在线的工人' },
};
const OK: HomeHealth = {
  quota: { state: 'ok', detail: '够用' },
  routes: { state: 'ok', detail: '12 在线' },
  engine: { state: 'on' },
};

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

test('每格带短状态字：额度 紧、中转 正常、引擎进程 没连上', () => {
  expect(healthItems(BAD).map((i) => `${i.name} ${i.word}`)).toEqual([
    '额度 紧',
    '中转 正常',
    '引擎进程 没连上',
  ]);
});

test('汇总：最要紧的那格定颜色，全正常写正常', () => {
  expect(healthSummary(healthItems(BAD))).toEqual({ tone: 'fail', label: '状态 2 项要留意' });
  expect(healthSummary(healthItems(OK))).toEqual({ tone: 'done', label: '状态 正常' });
});

test('≥1440：三格摊开，每格是 StatusBadge（tone 色 + 字）', () => {
  viewport(1600);
  render(<HealthStrip health={BAD} />);
  const chips = Array.from(document.querySelectorAll('[data-health-chip]'));
  expect(chips).toHaveLength(3);
  expect(chips.map((c) => c.getAttribute('data-tone'))).toEqual(['wait', 'done', 'fail']);
  expect(chips[0]?.querySelector('[data-variant="outline"]')?.textContent).toBe('额度 紧');
  expect(document.querySelector('[data-health-menu]')).toBeNull();
});

test('窄于 1440：收成一个「状态」按钮，点开才是三格', () => {
  viewport(1366);
  render(<HealthStrip health={BAD} />);
  const menu = document.querySelector('[data-health-menu]') as HTMLElement;
  expect(menu.textContent).toBe('状态 2 项要留意');
  expect(document.querySelectorAll('[data-health-chip]')).toHaveLength(0);
  fireEvent.click(menu);
  expect(document.querySelectorAll('[data-health-chip]')).toHaveLength(3);
  expect(document.body.textContent).toContain('探不到在线的工人');
});

test('手机：同样是带字的状态按钮，不小于 40 高', () => {
  viewport(390);
  render(<HealthStrip health={OK} />);
  const menu = document.querySelector('[data-health-menu]') as HTMLElement;
  expect(menu.textContent).toBe('状态 正常');
  expect(menu.className).toContain('min-h-10');
});
