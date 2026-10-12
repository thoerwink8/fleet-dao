// @vitest-environment happy-dom
// 引擎总开关卡（#1903，评审 v8 第 20 条）：同一件事不写两遍、正文里不出现 ISO 时间（2026-10-11T10:45:29.086Z），
// 只留一行本地化的「谁什么时候改的」。
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { Setting } from '../api/types';
import { localizeIsoTimes } from '../lib/format';
import France from '../routes/france';
import { renderApp } from './harness';

afterEach(cleanup);

const ISO_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const ROW: Setting = {
  key: 'engine.master',
  value: false,
  version: 4,
  updatedAt: '2026-10-11T10:45:29.086Z',
  updatedBy: 'user:frank',
};

function apiWith(row: Setting): MockApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    settings: async () => {
      const base = await inner.settings();
      return { settings: [...base.settings.filter((s) => s.key !== 'engine.master'), row] };
    },
    nodes: async () => ({ ...(await inner.nodes()), nodes: [] }),
  } as unknown as MockApi;
}

describe('总开关卡不露 ISO 时间、不把同一件事写两遍', () => {
  for (const [name, row] of [
    ['关着', ROW],
    ['开着', { ...ROW, value: true }],
  ] as const) {
    test(`${name}：正文没有 ISO 时间；时间只出现在「谁什么时候改的」那一行`, async () => {
      renderApp(<France />, { api: apiWith(row) as unknown as FleetApi, route: '/france' });
      const card = await screen.findByTestId('engine-master');
      await waitFor(() => expect(card.querySelector('[data-testid="engine-master-who"]')).not.toBeNull());
      expect(card.textContent).not.toMatch(ISO_TEXT);
      const who = card.querySelector('[data-testid="engine-master-who"]')?.textContent ?? '';
      expect(who).toContain('frank');
      const note = card.querySelector('[data-testid="engine-master-note"]')?.textContent ?? '';
      // 状态句里不再带「谁、几点」：那一行已经写了
      expect(note).not.toContain('frank');
      expect(note.length).toBeGreaterThan(0);
    });
  }
});

describe('localizeIsoTimes', () => {
  test('句子里的 ISO 时间换成本地写法，别的字不动；认不出的时刻原样留着', () => {
    const out = localizeIsoTimes('关着，2026-10-11T10:45:29.086Z 由 frank 关上：不派活');
    expect(out).not.toMatch(ISO_TEXT);
    expect(out).toContain('由 frank 关上：不派活');
    expect(localizeIsoTimes('没有时间的一句')).toBe('没有时间的一句');
    expect(localizeIsoTimes('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z');
  });
});
