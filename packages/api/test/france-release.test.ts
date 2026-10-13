// /api/france/release-state 和 /api/france/preflight（#618 发版一键）：
// - release-state：读 state 文件 + 暂停标记，三态各画各的；读不到一律 unreadable 写明原因。
// - preflight：进程内读七项事实（france-preflight.test.ts 逐项覆盖）。这里只钉接口：接上了就回退出码和一行一项，没接上回没接上。
// 故意造出的失败都写明原因，不拿「没在走」「能发」顶。

import { FrancePreflightResponseSchema, FranceReleaseStateSchema, WEB_API_PREFIX } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';

const procCalls = vi.hoisted(() => ({ execFile: 0, spawn: 0 }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      procCalls.execFile += 1;
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
    spawn: (...args: unknown[]) => {
      procCalls.spawn += 1;
      return (actual.spawn as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { PREFLIGHT_LABEL, PREFLIGHT_NOT_WIRED, type PreflightReaders } from '../src/france-preflight.ts';
import type { FranceReleasePort } from '../src/france-release.ts';
import { type Harness, harness } from './harness.ts';

const STATE_PATH = `${WEB_API_PREFIX}/france/release-state`;
const PREFLIGHT_PATH = `${WEB_API_PREFIX}/france/preflight`;

/** 状态文件的替身：默认两个文件都不在（没在走）。 */
function port(over: Partial<FranceReleasePort> = {}): FranceReleasePort {
  return {
    async readStateFiles() {
      return { stateJson: null, marker: false };
    },
    ...over,
  };
}

function passing(): PreflightReaders {
  return {
    mainline: async () => ({ short: 'abcdef123456', title: '刷新耗时表', ci: 'green', ciDetail: '' }),
    deployed: async () => ({ short: 'bbbbbbbbbbbb', title: '上一版' }),
    gap: async () => ({ kind: 'ahead', count: 3 }),
    other: async () => ({ kind: 'clear', detail: '没有别的发布在走' }),
    receiver: async () => ({ installed: true }),
    master: async () => ({ on: true, detail: '开着' }),
    sessions: async () => ({ count: 0, engineDown: false }),
  };
}

function stateJson(phase: number, value: string, kind: 'sha' | 'tag' = 'sha'): string {
  return JSON.stringify({ schema: 1, phase, status: 'running', target: { kind, value } });
}

async function readState(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request(STATE_PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return FranceReleaseStateSchema.parse(await res.json());
}

async function postPreflight(h: Harness) {
  const { cookie, csrf } = await h.login();
  const res = await h.cockpit.request(PREFLIGHT_PATH, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  return { status: res.status, body: FrancePreflightResponseSchema.parse(await res.json()) };
}

describe('/api/france/release-state', () => {
  it('两个文件都不在：idle（没在走）', async () => {
    const body = await readState(harness({ franceRelease: port() }));
    expect(body.state).toBe('idle');
  });

  it('state + 暂停标记在：running + phase 翻人话、target 截 12 位、marker=true', async () => {
    const body = await readState(
      harness({
        franceRelease: port({
          readStateFiles: async () => ({
            stateJson: stateJson(4, 'abcdef1234567890'),
            marker: true,
          }),
        }),
      }),
    );
    expect(body.state).toBe('running');
    if (body.state !== 'running') throw new Error('该是在走的');
    expect(body.phase).toContain('发版');
    expect(body.target).toBe('提交 abcdef123456');
    expect(body.marker).toBe(true);
  });

  it('state 在、按版本发：target 给 tag 原文', async () => {
    const body = await readState(
      harness({
        franceRelease: port({
          readStateFiles: async () => ({ stateJson: stateJson(5, 'v12', 'tag'), marker: false }),
        }),
      }),
    );
    expect(body.state).toBe('running');
    if (body.state !== 'running') throw new Error('该是在走的');
    expect(body.target).toBe('v12');
  });

  it('孤儿暂停标记：state 不在、marker 在 → paused（发版前先 abort 收掉它）', async () => {
    const body = await readState(
      harness({
        franceRelease: port({ readStateFiles: async () => ({ stateJson: null, marker: true }) }),
      }),
    );
    expect(body.state).toBe('paused');
  });

  it('进度记录是做完了（done）、撤销了（aborted）：不算在走，没暂停标记就是 idle，有标记还是 paused', async () => {
    for (const status of ['done', 'aborted']) {
      const json = JSON.stringify({
        schema: 1,
        phase: 8,
        status,
        target: { kind: 'sha', value: 'abcdef1234567890' },
      });
      const idle = await readState(
        harness({
          franceRelease: port({ readStateFiles: async () => ({ stateJson: json, marker: false }) }),
        }),
      );
      expect(idle.state, status).toBe('idle');
      const paused = await readState(
        harness({ franceRelease: port({ readStateFiles: async () => ({ stateJson: json, marker: true }) }) }),
      );
      expect(paused.state, status).toBe('paused');
    }
  });

  it('进度记录是卡住（blocked）、没成（failed）：还没了结，running 带 status 和原因', async () => {
    for (const status of ['blocked', 'failed']) {
      const json = JSON.stringify({
        schema: 1,
        phase: 3,
        status,
        why: '法国还有 2 个会话在跑',
        target: { kind: 'sha', value: 'abcdef1234567890' },
      });
      const body = await readState(
        harness({ franceRelease: port({ readStateFiles: async () => ({ stateJson: json, marker: true }) }) }),
      );
      expect(body).toMatchObject({ state: 'running', status, why: '法国还有 2 个会话在跑', marker: true });
    }
  });

  it('进度记录没写 status、或 status 认不出：unreadable，不猜这一趟是在走还是做完了', async () => {
    for (const json of [
      JSON.stringify({ schema: 1, phase: 3, target: { kind: 'sha', value: 'abc' } }),
      JSON.stringify({ schema: 1, phase: 3, status: 'weird', target: { kind: 'sha', value: 'abc' } }),
      'null',
    ]) {
      const body = await readState(
        harness({
          franceRelease: port({ readStateFiles: async () => ({ stateJson: json, marker: false }) }),
        }),
      );
      expect(body.state, json).toBe('unreadable');
    }
  });

  it('state 文件不是 JSON：unreadable，写明认不出，不拿「没在走」顶', async () => {
    const body = await readState(
      harness({
        franceRelease: port({
          readStateFiles: async () => ({ stateJson: '{not json', marker: false }),
        }),
      }),
    );
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是读不到的');
    expect(body.why).toContain('JSON');
  });

  it('读文件抛错：unreadable，写明没读成 + 原因', async () => {
    const body = await readState(
      harness({
        franceRelease: port({
          readStateFiles: async () => {
            throw new Error('EACCES: 读不了（测试故意造的）');
          },
        }),
      }),
    );
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是读不到的');
    expect(body.why).toContain('EACCES');
  });

  it('这台后端没接上 franceRelease：unreadable（开发、内存版）', async () => {
    const body = await readState(harness({}));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是读不到的');
    expect(body.why).toContain('没接上');
  });
});

describe('/api/france/preflight', () => {
  it('七项都读到且能发：code=0、一项一行、不起子进程', async () => {
    const before = { ...procCalls };
    const { status, body } = await postPreflight(harness({ francePreflight: () => passing() }));
    expect(status).toBe(200);
    expect(body.state).toBe('done');
    if (body.state !== 'done') throw new Error('该是 done');
    expect(body.command).toBe(PREFLIGHT_LABEL);
    expect(body.code).toBe(0);
    expect(body.stdout).toContain('主线头和 CI：通过');
    expect(body.stdout).toContain('法国在跑的会话数：通过 0 个');
    expect(body.stderr).toBe('');
    expect(body.timedOut).toBe(false);
    expect(body.signal).toBeNull();
    expect(procCalls.execFile).toBe(before.execFile);
    expect(procCalls.spawn).toBe(before.spawn);
  });

  it('一项读不到：code=2，那一行写读不到和原因，别的行还在', async () => {
    const readers = passing();
    readers.mainline = async () => {
      throw new Error('EACCES: 读不了主线');
    };
    const { body } = await postPreflight(harness({ francePreflight: () => readers }));
    expect(body.state).toBe('done');
    if (body.state !== 'done') throw new Error('该是 done');
    expect(body.code).toBe(2);
    expect(body.stdout).toContain('主线头和 CI：读不到 EACCES: 读不了主线');
    expect(body.stdout).toContain('发版接活单元：通过 装了');
  });

  it('这台后端没接上发版预检：unreadable，写明到法国那台才有这颗按钮', async () => {
    const { body } = await postPreflight(harness({}));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是 unreadable');
    expect(body.why).toBe(PREFLIGHT_NOT_WIRED);
  });
});
