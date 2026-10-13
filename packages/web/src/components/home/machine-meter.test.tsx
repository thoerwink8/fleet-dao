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
  cpu: { state: 'ok', percent: 20, busyCores: 0.8, cores: 4 },
  sessions: { state: 'ok', byRun: {} },
  ...over,
});

const amounts = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-meter-amount]')).map((e) => e.textContent);
const percents = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-meter-percent]')).map((e) => e.textContent);

const cells = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-meter]')).map((e) => [
    e.dataset.meter,
    e.dataset.tone,
    e.textContent,
  ]);

test('读成了：两格写具体数值再写百分比，平时是 done', () => {
  render(<MachineMeter resources={ok()} remote={false} />);
  expect(cells()).toEqual([
    ['memory', 'done', '内存5.9G / 11.7G50%'],
    ['cpu', 'done', 'CPU0.8 核 / 4 核20%'],
  ]);
  expect(amounts()).toEqual(['5.9G / 11.7G', '0.8 核 / 4 核']);
  expect(percents()).toEqual(['50%', '20%']);
  // 读屏一句话里也带数值
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('aria-label')).toBe(
    '机器资源：内存 5.9G / 11.7G 50%，CPU 0.8 核 / 4 核 20%',
  );
});

test('老快照没有忙的核数：CPU 数值写没读到，百分比照写，不出现 0 核', () => {
  render(<MachineMeter resources={ok({ cpu: { state: 'ok', percent: 20, cores: 4 } })} remote />);
  expect(amounts()).toEqual(['5.9G / 11.7G', '没读到']);
  expect(percents()).toEqual(['50%', '20%']);
  expect(document.body.textContent).not.toContain('0 核');
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
