// @vitest-environment happy-dom
// 机器资源三格（#1973、#1985）：读成了写具体数值再写百分比；紧画黄（stall）不画红；cgroup、/proc、statfs 读不到写「没读到」不写 0；
// 后端没给写明没有；整张是到资源页的链接（选了远程环境带 ?node=）。
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { MachineMeter } from './machine-meter.tsx';
import type { HomeResources } from './types.ts';

afterEach(cleanup);

const GIB = 1024 ** 3;

const ok = (over: Partial<HomeResources> = {}): HomeResources => ({
  at: new Date().toISOString(),
  everyMs: 5_000,
  memory: { state: 'ok', totalMb: 12_000, availableMb: 6_000 },
  cpu: { state: 'ok', percent: 20, busyCores: 0.8, cores: 4 },
  sessions: { state: 'ok', byRun: {} },
  disk: { state: 'ok', path: '/', totalBytes: 200 * GIB, usedBytes: 60 * GIB, availableBytes: 130 * GIB },
  ...over,
});

function show(ui: ReactElement, url = '/') {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

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
const titleOf = (id: string) => document.querySelector(`[data-meter="${id}"]`)?.getAttribute('title');

test('读成了：三格写具体数值再写百分比，平时是 done', () => {
  show(<MachineMeter resources={ok()} remote={false} />);
  expect(cells()).toEqual([
    ['memory', 'done', '内存5.9G / 11.7G50%'],
    ['cpu', 'done', 'CPU0.8 核 / 4 核20%'],
    ['disk', 'done', '磁盘60.0G / 200.0G30%'],
  ]);
  expect(amounts()).toEqual(['5.9G / 11.7G', '0.8 核 / 4 核', '60.0G / 200.0G']);
  expect(percents()).toEqual(['50%', '20%', '30%']);
  // 剩余写在悬停里
  expect(titleOf('disk')).toContain('剩余 130.0G');
  // 读屏一句话里也带数值
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('aria-label')).toBe(
    '这台机器的资源：内存 5.9G / 11.7G 50%，CPU 0.8 核 / 4 核 20%，磁盘 60.0G / 200.0G 30%。点开看每个上线项目各占多少',
  );
});

test('整张是到资源页的链接；选了远程环境带着 ?node=', () => {
  show(<MachineMeter resources={ok()} remote={false} />);
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('href')).toBe('/resources');
  cleanup();
  show(<MachineMeter resources={ok()} remote machine="本机 WSL" />, '/?node=wsl');
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('href')).toBe('/resources?node=wsl');
});

test('老快照没有忙的核数：CPU 数值写没读到，百分比照写，不出现 0 核', () => {
  show(<MachineMeter resources={ok({ cpu: { state: 'ok', percent: 20, cores: 4 } })} remote />);
  expect(amounts()).toEqual(['5.9G / 11.7G', '没读到', '60.0G / 200.0G']);
  expect(percents()).toEqual(['50%', '20%', '30%']);
  expect(document.body.textContent).not.toContain('0 核');
});

test('紧：画黄（stall），不画红（fail）；磁盘 ≥ 90% 也是紧', () => {
  show(
    <MachineMeter
      resources={ok({
        memory: { state: 'ok', totalMb: 10_000, availableMb: 500 },
        cpu: { state: 'ok', percent: 97, cores: 4 },
        disk: { state: 'ok', path: '/', totalBytes: 100 * GIB, usedBytes: 93 * GIB, availableBytes: 2 * GIB },
      })}
      remote={false}
    />,
  );
  expect(cells().map((c) => c[1])).toEqual(['stall', 'stall', 'stall']);
  expect(document.querySelector('[data-tone="fail"]')).toBeNull();
});

test('cgroup、/proc、statfs 读不到：写「没读到」，原因在悬停里，任何地方都不出现 0%', () => {
  show(
    <MachineMeter
      resources={ok({
        memory: { state: 'unread', why: '读不到 /proc/meminfo（这台不是 Linux）' },
        cpu: { state: 'unread', why: '/proc/stat 第一行认不出' },
        disk: { state: 'unread', why: '/ 的 statfs 没读成：EACCES' },
      })}
      remote={false}
    />,
  );
  expect(cells()).toEqual([
    ['memory', 'stop', '内存没读到'],
    ['cpu', 'stop', 'CPU没读到'],
    ['disk', 'stop', '磁盘没读到'],
  ]);
  expect(titleOf('memory')).toContain('读不到 /proc/meminfo（这台不是 Linux）');
  expect(titleOf('cpu')).toContain('/proc/stat 第一行认不出');
  expect(titleOf('disk')).toContain('/ 的 statfs 没读成：EACCES');
  expect(document.body.textContent).not.toContain('0%');
});

test('老后端没给磁盘：磁盘格写没读到、悬停说后端没给，不画 0', () => {
  const r = ok();
  delete r.disk;
  show(<MachineMeter resources={r} remote={false} />);
  expect(cells()[2]).toEqual(['disk', 'stop', '磁盘没读到']);
  expect(titleOf('disk')).toContain('后端没给磁盘读数');
});

test('那台没推过资源读数：写明没有，不画 0', () => {
  show(<MachineMeter resources={undefined} remote machine="本机 WSL" />);
  expect(cells().map((c) => c[2])).toEqual(['内存没读到', 'CPU没读到', '磁盘没读到']);
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('title')).toBe(
    '那台没推过资源读数（那台的版本还没有这一项）',
  );
  expect(document.querySelector('[data-machine-meter]')?.getAttribute('aria-label')).toContain('本机 WSL');
  expect(document.body.textContent).not.toContain('0%');
});
