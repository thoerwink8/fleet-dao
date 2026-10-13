// /api/france/release-state（#618 发版一键）：读 state 文件 + 暂停标记，三态各画各的；读不到一律 unreadable 写明原因。
// 发版预检在 france-preflight.test.ts（#2021：后端进程内读事实，不起子进程）。
// 故意造出的失败都写明原因，不拿「没在走」顶：读文件抛错、JSON 认不出。
// 也测引擎会话数的读法（drain.json 认得出 / 认不出 / 进程已不在）。
import { FranceReleaseStateSchema, WEB_API_PREFIX } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { type FranceReleasePort, parseEngineDrain } from '../src/france-release.ts';
import { type Harness, harness } from './harness.ts';

const STATE_PATH = `${WEB_API_PREFIX}/france/release-state`;

/** 状态文件的替身：默认两个文件都不在（没在走）。 */
function port(over: Partial<FranceReleasePort> = {}): FranceReleasePort {
  return {
    async readStateFiles() {
      return { stateJson: null, marker: false };
    },
    async readEngineSessions() {
      return { ok: true, running: 0, names: [], engineDown: false };
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

describe('parseEngineDrain（引擎手上的会话，读 drain.json）', () => {
  const alive = () => true;
  const file = (o: object) => JSON.stringify({ schema: 2, pid: 4242, sessions: [], ...o });

  it('读到了：数会话、带环节和编号前 8 位', () => {
    const r = parseEngineDrain(
      file({
        sessions: [
          { runId: 'abcdef1234567890', stage: 'worker' },
          { runId: '1234567890ab', stage: '' },
        ],
      }),
      alive,
    );
    expect(r).toEqual({
      ok: true,
      running: 2,
      names: ['worker(abcdef12)', '会话(12345678)'],
      engineDown: false,
    });
  });

  it('引擎进程已经不在：0 个、标引擎没在跑', () => {
    expect(parseEngineDrain(file({}), () => false)).toEqual({
      ok: true,
      running: 0,
      names: [],
      engineDown: true,
    });
  });

  it('读不到：不是 JSON、schema 不对、没写进程号，都回 ok:false + 原因，不当成 0 个', () => {
    for (const text of [
      '{oops',
      JSON.stringify({ schema: 1, pid: 1 }),
      'null',
      JSON.stringify({ schema: 2 }),
    ]) {
      const r = parseEngineDrain(text, alive);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.why).toContain('drain.json');
    }
  });
});
