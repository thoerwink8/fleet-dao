// @vitest-environment happy-dom
// 额度页「作废预估」（#2737）：每个池一行，该用、实际用了、ρ、清零时预计剩；读不到写「没读到」不写 0。
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { PoolView } from '../api/types';
import { QuotaPressure } from './quota-pressure';

afterEach(cleanup);

const NOW = Date.parse('2026-10-16T08:00:00Z');
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const pool = (id: string, pressure: PoolView['pressure']): PoolView => ({
  id,
  channelId: 'ch',
  channelName: '渠道',
  billing: 'subscription',
  channelEnabled: true,
  maxConcurrency: 1,
  running: 0,
  reserved: 0,
  quotaStatus: 'fresh',
  windows: [],
  ...(pressure ? { pressure } : {}),
});

describe('作废预估', () => {
  test('能算的池一行四个数；会作废三成以上的标出来；提前用完的写提前几小时', () => {
    render(
      <QuotaPressure
        now={NOW}
        pools={[
          pool('cursor', {
            state: 'known',
            label: 'auto_percent',
            resetsAt: at(19),
            expectedUsed: 0.97,
            used: 0.2,
            rho: 26.67,
            leftAtReset: 0.8,
            exhaustedHoursEarly: null,
            rateFrom: 'samples',
          }),
          pool('mirasim', {
            state: 'known',
            label: '30d',
            resetsAt: at(598),
            expectedUsed: 0.169,
            used: 0.676,
            rho: 0.39,
            leftAtReset: 0,
            exhaustedHoursEarly: 540,
            rateFrom: 'average',
          }),
          pool('grok', { state: 'unknown', why: '读数过期，不当现值' }),
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: '作废预估' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual(['池', '窗口', '该用', '实际用了', 'ρ', '清零时预计剩']);
    const rowOf = (id: string) =>
      table.querySelector(`[data-pressure-pool="${id}"]`)?.closest('tr') as HTMLElement;
    const cursor = rowOf('cursor');
    const col = (row: HTMLElement, name: string) =>
      row.querySelector(`[data-pressure-col="${name}"]`)?.textContent;
    expect(col(cursor, 'expected')).toBe('97%');
    expect(col(cursor, 'used')).toBe('20%');
    expect(col(cursor, 'rho')).toBe('26.67');
    expect(col(cursor, 'left')).toBe('80%');
    expect(cursor.querySelector('[data-pressure-col="left"]')?.hasAttribute('data-waste')).toBe(true);
    const mirasim = rowOf('mirasim');
    expect(col(mirasim, 'left')).toBe('剩 0 · 提前 540 小时用完');
    expect(mirasim.querySelector('[data-pressure-col="left"]')?.hasAttribute('data-waste')).toBe(false);
    const grok = rowOf('grok');
    expect(grok.querySelector('[data-pressure="unknown"]')).toBeTruthy();
    expect(grok.textContent).toContain('没读到（读数过期，不当现值）');
    expect(grok.textContent).not.toMatch(/\b0%/);
  });

  test('后端没带这一项（老后端）：整块不画', () => {
    const { container } = render(<QuotaPressure now={NOW} pools={[pool('a', undefined)]} />);
    expect(container.textContent).toBe('');
  });
});
