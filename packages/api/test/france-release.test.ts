// /api/france/release-state 和 /api/france/preflight（#618 发版一键）：
// - release-state：复用 readFranceReleaseState 的逻辑——读 state 文件 + 暂停标记，三态各画各的；读不到一律 unreadable 写明原因。
// - preflight：起子进程跑 pnpm release:onekey preflight（命令后端写死、不收参数）。
// 故意造出的失败都写明原因，不拿「没在走」「预检过了」顶：读文件抛错、JSON 认不出、起进程没起成。
import { FrancePreflightResponseSchema, FranceReleaseStateSchema, WEB_API_PREFIX } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { FranceReleasePort } from '../src/france-release.ts';
import { type Harness, harness } from './harness.ts';

const STATE_PATH = `${WEB_API_PREFIX}/france/release-state`;
const PREFLIGHT_PATH = `${WEB_API_PREFIX}/france/preflight`;

/** 状态文件的替身：默认两个文件都不在（没在走）。 */
function port(over: Partial<FranceReleasePort> = {}): FranceReleasePort & { ran: { pnpmCalls: number } } {
  const ran = { pnpmCalls: 0 };
  return {
    ran,
    async readStateFiles() {
      return { stateJson: null, marker: false };
    },
    async runPreflight() {
      ran.pnpmCalls += 1;
      return {
        code: 0,
        signal: null,
        stdout: '—— 预检摘要 ——\n主线 CI：绿\n预检过了',
        stderr: '',
        timedOut: false,
      };
    },
    ...over,
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
  it('预检过了：code=0、命令原样照写、stdout 和 stderr 分块给页面', async () => {
    const p = port();
    const { status, body } = await postPreflight(harness({ franceRelease: p }));
    expect(status).toBe(200);
    expect(p.ran.pnpmCalls).toBe(1);
    expect(body.state).toBe('done');
    if (body.state !== 'done') throw new Error('该是 done');
    expect(body.command).toBe('pnpm release:onekey preflight');
    expect(body.code).toBe(0);
    expect(body.stdout).toContain('预检过了');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.timedOut).toBe(false);
  });

  it('预检没过：code=2、stderr 留下「没成」那行；起进程没起来这条不走到这里', async () => {
    const p = port({
      runPreflight: async () => ({
        code: 2,
        signal: null,
        stdout: '—— 预检摘要 ——',
        stderr: '第 0 步「预检」没成：主线 CI 红',
        timedOut: false,
      }),
    });
    const { body } = await postPreflight(harness({ franceRelease: p }));
    expect(body.state).toBe('done');
    if (body.state !== 'done') throw new Error('该是 done');
    expect(body.code).toBe(2);
    expect(body.stderr).toContain('主线 CI 红');
  });

  it('起进程都没起来（pnpm 不在 PATH）：unreadable + 原因，不拿 code 0 顶', async () => {
    const p = port({
      runPreflight: async () => {
        throw new Error('spawn pnpm ENOENT');
      },
    });
    const { body } = await postPreflight(harness({ franceRelease: p }));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是 unreadable');
    expect(body.why).toContain('ENOENT');
  });

  it('这台后端没接上 franceRelease：unreadable，写明到法国那台才有这颗按钮', async () => {
    const { body } = await postPreflight(harness({}));
    expect(body.state).toBe('unreadable');
    if (body.state !== 'unreadable') throw new Error('该是 unreadable');
    expect(body.why).toContain('没接上');
  });

  it('超时被杀（timedOut=true）：原样透出，让页面写「60 秒到点了被杀」', async () => {
    const p = port({
      runPreflight: async () => ({
        code: null,
        signal: 'SIGTERM',
        stdout: '—— 预检摘要 ——\n主线 CI：绿\n法国在跑的会话：',
        stderr: '',
        timedOut: true,
      }),
    });
    const { body } = await postPreflight(harness({ franceRelease: p }));
    expect(body.state).toBe('done');
    if (body.state !== 'done') throw new Error('该是 done');
    expect(body.timedOut).toBe(true);
    expect(body.signal).toBe('SIGTERM');
  });
});
