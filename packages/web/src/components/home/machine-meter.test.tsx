// @vitest-environment happy-dom
// 机器资源两格（#1973）：读成了写百分比；紧画黄（stall）不画红；cgroup、/proc 读不到写「没读到」不写 0；后端没给写明没有。
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { MachineMeter } from './machine-meter.tsx';
import type { HomeResources } from './types.ts';

afterEach(cleanup);

const ok = (over: Partial<HomeResources> = {}): HomeResources => ({
  at: new Date().toISOString(),
  everyMs: 5_000,
  memory: { state: 'ok', totalMb: 12_000, availableMb: 6_000 },
  cpu: { state: 'ok', percent: 20, cores: 4 },
  sessions: { state: 'ok', byRun: {} },
  ...over,
});

const cells = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-meter]')).map((e) => [
    e.dataset.meter,
    e.dataset.tone,
    e.textContent,
  ]);

test('读成了：两格写百分比，平时是 done', () => {
  render(<MachineMeter resources={ok()} remote={false} />);
  expect(cells()).toEqual([
    ['memory', 'done', '内存50%'],
    ['cpu', 'done', 'CPU20%'],
  ]);
});

test('紧：画黄（stall），不画红（fail）', () => {
  render(
    <MachineMeter
      resources={ok({
        memory: { state: 'ok', totalMb: 10_000, availableMb: 500 },
        cpu: { state: 'ok', percent: 97, cores: 4 },
      })}
      remote={false}
    />,
  );
  expect(cells().map((c) => c[1])).toEqual(['stall', 'stall']);
  expect(document.querySelector('[data-tone="fail"]')).toBeNull();
});

test('cgroup、/proc 读不到：写「没读到」，原因在点开的面板里，任何地方都不出现 0%', () => {
  render(
    <MachineMeter
      resources={ok({
        memory: { state: 'unread', why: '读不到 /proc/meminfo（这台不是 Linux）' },
        cpu: { state: 'unread', why: '/proc/stat 第一行认不出' },
      })}
      remote={false}
    />,
  );
  expect(cells()).toEqual([
    ['memory', 'stop', '内存没读到'],
    ['cpu', 'stop', 'CPU没读到'],
  ]);
  fireEvent.click(document.querySelector('[data-machine-meter]') as HTMLElement);
  expect(document.body.textContent).toContain('读不到 /proc/meminfo（这台不是 Linux）');
  expect(document.body.textContent).toContain('/proc/stat 第一行认不出');
  expect(document.body.textContent).not.toContain('0%');
});

test('那台没推过资源读数：写明没有，不画 0', () => {
  render(<MachineMeter resources={undefined} remote machine="本机 WSL" />);
  expect(cells().map((c) => c[2])).toEqual(['内存没读到', 'CPU没读到']);
  fireEvent.click(document.querySelector('[data-machine-meter]') as HTMLElement);
  expect(document.querySelector('[data-machine-missing]')?.textContent).toBe(
    '那台没推过资源读数（那台的版本还没有这一项）',
  );
  expect(document.body.textContent).toContain('本机 WSL');
});
