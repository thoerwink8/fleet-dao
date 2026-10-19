// work-watch.mjs（单 #2761）：pnpm work run 派出的工人只在终态叫醒派它的会话。
// 故意造出的失败：中间在重试（网关断了在续）不叫；看护进程没了要叫；别的会话派的不叫；同一件只叫一次；子代理、机器派的会话不盯。
// 文件形状和 packages/conventions/src/work-run.ts 同一份（state.json 的 dispatcher、beatAt，result.json 的 state、summary、why、attempts）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completedRuns } from '../hooks/continuation-results.mjs';
import { BEAT_STALE_MS, watchRuns } from '../hooks/work-watch.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-16T10:00:00.000Z');

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'work-watch-'));
  dirs.push(home);
  const root = join(home, 'runs');
  const run = (name: string, files: Record<string, unknown>) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, v] of Object.entries(files))
      writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
    return dir;
  };
  return { home, root, run };
}

const state = (o: Record<string, unknown> = {}) => ({
  issue: 42,
  repo: 'acme/app',
  state: 'running',
  dispatcher: 'sess-main',
  attempts: 1,
  beatAt: new Date(T0).toISOString(),
  ...o,
});

/** 跑一次盯账：时钟随 sleep 往前走；每拍之前可以改文件 */
async function watch(
  root: string,
  input: Record<string, unknown>,
  o: { onTick?: (n: number) => void; env?: Record<string, string> } = {},
) {
  let t = T0;
  let ticks = 0;
  const said: string[] = [];
  const code = await watchRuns(input, {
    home: '/nowhere',
    env: {
      FLEET_WORK_RUNS_DIR: root,
      FLEET_WORK_WATCH_TICK_MS: '10000',
      FLEET_WORK_WATCH_MAX_MS: '60000',
      ...o.env,
    },
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
      ticks += 1;
      o.onTick?.(ticks);
    },
    parentAlive: () => true,
    err: (s) => said.push(s),
  });
  return { code, said: said.join('\n'), ticks };
}

const main = { session_id: 'sess-main', cwd: '/repo' };

describe('work-watch：只在终态叫醒派它的会话', () => {
  it('这个会话没派过工人：当场退 0，不等', async () => {
    const { root, run } = setup();
    run('acme__app__7', { 'state.json': state({ dispatcher: 'someone-else' }) });
    const r = await watch(root, main);
    expect(r).toEqual({ code: 0, said: '', ticks: 0 });
  });

  it('已经做完：当场退 2，贴最后一条回复和结果文件，写 reported；第二个盯着的不再叫', async () => {
    const { root, run } = setup();
    const dir = run('acme__app__42', {
      'state.json': state({ state: 'done', attempts: 2 }),
      'result.json': { issue: 42, state: 'done', summary: 'PR #9 合了', attempts: 2, why: null },
    });
    const r = await watch(root, main);
    expect(r.code).toBe(2);
    expect(r.said).toContain('#42 工人做完了（第 2 次）：PR #9 合了');
    expect(r.said).toContain(join(dir, 'result.json'));
    expect(existsSync(join(dir, 'reported'))).toBe(true);
    expect((await watch(root, main)).code).toBe(0);
  });

  it('【故意造出的失败】在跑、在重试（网关断了在续）都不叫；到第 3 拍写出 result.json（failed）才叫，带原因', async () => {
    const { root, run } = setup();
    const dir = run('acme__app__42', { 'state.json': state() });
    const r = await watch(root, main, {
      onTick: (n) => {
        const beatAt = new Date(T0 + n * 10_000).toISOString();
        if (n === 1)
          writeFileSync(
            join(dir, 'state.json'),
            JSON.stringify(state({ state: 'retrying', beatAt, lastError: '网关或网络断了' })),
          );
        if (n === 2)
          writeFileSync(
            join(dir, 'state.json'),
            JSON.stringify(state({ state: 'running', attempts: 2, beatAt })),
          );
        if (n === 3) {
          writeFileSync(
            join(dir, 'result.json'),
            JSON.stringify({ issue: 42, state: 'failed', why: '登录坏了', attempts: 2 }),
          );
        }
      },
    });
    expect(r.code).toBe(2);
    expect(r.ticks).toBe(3);
    expect(r.said).toContain('#42 工人没做成（第 2 次）：登录坏了');
  });

  it('【故意造出的失败】看护进程没了（beatAt 超过 3 分钟没动、没有结果）：叫，告诉怎么续', async () => {
    const { root, run } = setup();
    run('acme__app__42', { 'state.json': state({ beatAt: new Date(T0 - BEAT_STALE_MS - 1).toISOString() }) });
    const r = await watch(root, main);
    expect(r.code).toBe(2);
    expect(r.said).toContain('#42 工人的看护进程没了');
    expect(r.said).toContain('pnpm work run 42');
  });

  it('一直在跑：等到上限退 0，不叫', async () => {
    const { root, run } = setup();
    const dir = run('acme__app__42', { 'state.json': state() });
    const r = await watch(root, main, {
      onTick: (n) =>
        writeFileSync(
          join(dir, 'state.json'),
          JSON.stringify(state({ beatAt: new Date(T0 + n * 10_000).toISOString() })),
        ),
    });
    expect(r.code).toBe(0);
    expect(r.said).toBe('');
    expect(existsSync(join(dir, 'reported'))).toBe(false);
  });

  it('别的会话派的到终态：不叫这个会话', async () => {
    const { root, run } = setup();
    run('acme__app__42', {
      'state.json': state({ dispatcher: 'other', state: 'done' }),
      'result.json': { issue: 42, state: 'done', summary: 'x', attempts: 1 },
    });
    expect((await watch(root, main)).code).toBe(0);
  });

  it('已 park 的审查等待叫一次：不是做完，也不叫人去写码', async () => {
    const { root, run } = setup();
    const dir = run('acme__app__42', {
      'spec.json': { dispatcher: 'sess-main', issue: 42 },
      'state.json': state({
        state: 'waiting',
        supervisorPid: null,
        beatAt: new Date(T0 - BEAT_STALE_MS - 1).toISOString(),
        lastError: '审查未结',
        hold: { kind: 'review', why: '审查未结' },
      }),
    });
    const r = await watch(root, main);
    expect(r.code).toBe(2);
    expect(r.ticks).toBe(0);
    expect(r.said).toContain('不是做完');
    expect(r.said).toContain('pnpm work rework');
    expect(r.said).not.toContain('到终态');
    expect(r.said).not.toContain('接着同一个会话续');
    expect(r.said).not.toContain('做完了');
    expect(existsSync(join(dir, 'reported'))).toBe(true);
    expect((await watch(root, main)).code).toBe(0);
  });

  it('复核还在心跳里：不叫；心跳早 20 分钟只通知接着复核', async () => {
    const { root, run } = setup();
    const fresh = run('acme__app__42', {
      'state.json': state({
        state: 'waiting',
        supervisorPid: 12345,
        beatAt: new Date(T0).toISOString(),
        hold: { kind: 'blocked', why: '正在复核' },
      }),
    });
    const quiet = await watch(root, main);
    expect(quiet).toEqual({ code: 0, said: '', ticks: 0 });
    expect(existsSync(join(fresh, 'reported'))).toBe(false);
    const stale = run('acme__app__7', {
      'state.json': state({
        issue: 7,
        state: 'waiting',
        supervisorPid: 12345,
        beatAt: new Date(T0 - 20 * 60_000).toISOString(),
        hold: { kind: 'blocked', why: '交付核验没读成' },
      }),
    });
    const lost = await watch(root, main);
    expect(lost.code).toBe(2);
    expect(lost.said).toContain('#7');
    expect(lost.said).toContain('只复核');
    expect(lost.said).not.toContain('接着同一个会话续');
    expect(existsSync(join(stale, 'reported'))).toBe(true);
    expect((await watch(root, main)).code).toBe(0);
  });

  it('Codex completedRuns：已 park 的等待进续轮且不是做完；活动复核不进，心跳丢失只说复核', () => {
    const { root, run } = setup();
    const now = Date.now();
    run('acme__app__42', {
      'spec.json': { dispatcher: 'sess-main', issue: 42 },
      'state.json': state({
        state: 'waiting',
        supervisorPid: null,
        beatAt: new Date(now - BEAT_STALE_MS - 1).toISOString(),
        hold: { kind: 'review', why: '审查未结' },
      }),
    });
    const parked = completedRuns('sess-main', { FLEET_WORK_RUNS_DIR: root });
    expect(parked).toHaveLength(1);
    expect(parked[0]?.text).toContain('不是做完');
    expect(parked[0]?.text).toContain('pnpm work rework');
    expect(parked[0]?.text).not.toContain('做完了');
    expect(completedRuns('sess-main', { FLEET_WORK_RUNS_DIR: root })[0]?.key).toBe(parked[0]?.key);
    run('acme__app__7', {
      'spec.json': { dispatcher: 'sess-main', issue: 7 },
      'state.json': state({
        issue: 7,
        state: 'waiting',
        supervisorPid: 12345,
        beatAt: new Date(now).toISOString(),
        hold: { kind: 'review', why: '正在复核' },
      }),
    });
    expect(
      completedRuns('sess-main', { FLEET_WORK_RUNS_DIR: root })
        .map((r) => r.text)
        .join('\n'),
    ).not.toContain('#7');
    run('acme__app__8', {
      'spec.json': { dispatcher: 'sess-main', issue: 8 },
      'state.json': state({
        issue: 8,
        state: 'waiting',
        supervisorPid: 12345,
        beatAt: new Date(now - 20 * 60_000).toISOString(),
        hold: { kind: 'blocked', why: '交付核验没读成' },
      }),
    });
    const text = completedRuns('sess-main', { FLEET_WORK_RUNS_DIR: root })
      .map((r) => r.text)
      .join('\n');
    expect(text).toContain('#8');
    expect(text).toContain('只复核');
    expect(text).not.toContain('接着同一个会话续');
  });

  it('已由其他真实PR交付而停止：叫一次，写明不再派工；再盯不重复叫', async () => {
    const { root, run } = setup();
    const dir = run('acme__app__42', {
      'state.json': state({ state: 'stopped' }),
      'result.json': {
        issue: 42,
        state: 'stopped',
        why: '需求已由同仓其他真实PR #3194 交付',
        attempts: 7,
        summary: '按审查停下',
      },
    });
    const r = await watch(root, main);
    expect(r.code).toBe(2);
    expect(r.said).toContain('不再派工');
    expect(r.said).toContain('PR #3194');
    expect(r.said).not.toContain('接着');
    expect(existsSync(join(dir, 'reported'))).toBe(true);
    expect((await watch(root, main)).code).toBe(0);
  });

  it('子代理收尾、机器派的会话（工人自己）、引擎无头：不盯', async () => {
    const { root, run } = setup();
    run('acme__app__42', {
      'state.json': state({ state: 'done' }),
      'result.json': { issue: 42, state: 'done', summary: 'x', attempts: 1 },
    });
    expect((await watch(root, { ...main, agent_id: 'a1' })).code).toBe(0);
    expect((await watch(root, main, { env: { FLEET_WORKER: '1' } })).code).toBe(0);
    expect((await watch(root, main, { env: { FLEET_HEADLESS: '1' } })).code).toBe(0);
  });
});
