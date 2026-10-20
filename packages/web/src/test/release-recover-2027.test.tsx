// @vitest-environment happy-dom
// 发版卡卡住、失败后的三个按钮（#2027）：重试、恢复引擎开关、撤掉暂停。
// 每个按钮：后端说能点才出现；点了先弹确认框写明后果；确认键后端慢时转圈（aria-busy）、连点只发一次，成功才关；失败留在框里写原因。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard } from '../api/types';
import France from '../routes/france';
import { renderApp } from './harness';
import { boundLine, clipBytes, installStageTrace } from './stage-trace';

// 完整 CI 里这个文件有两项 5000ms 超时（#3396），只报「Test timed out」。
// 每次 findBy / waitFor 的进出交给 stage-trace；本文件再给各阶段（渲染、矩阵各分支、弹框、同步查询、转圈、deferred、关框）打标记。
// 只在失败（抛错）或离 5000ms 上限还剩一截仍没收尾时输出一行；标记只含固定阶段名，不含页面内容和凭据。不改超时、不改断言。
installStageTrace();

const PHASE_CAP = 32;
const PHASE_LABEL_MAX_BYTES = 48;
const PHASE_WATCH_MS = 4000;

function startPhases(
  test: string,
  emit: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  watchMs: number = PHASE_WATCH_MS,
) {
  const t0 = performance.now();
  const marks: { label: string; ms: number }[] = [];
  let dropped = 0;
  let dumped = false;
  const dump = (why: string) => {
    if (dumped) return;
    dumped = true;
    try {
      const last = marks[marks.length - 1];
      const body = marks.map((m) => `${m.label}@${m.ms}ms`).join(' → ');
      const more = dropped > 0 ? `，另有 ${dropped} 个标记未展开` : '';
      emit(
        boundLine(
          `[阶段标记·${why}] test=${clipBytes(test, 160)} 停在：${last ? last.label : '（还没开始）'}；已过 ${Math.round(performance.now() - t0)}ms；${body}${more}`,
        ),
      );
    } catch {
      /* 输出口出错不影响测试 */
    }
  };
  const timer = setTimeout(() => dump('快超时'), watchMs);
  return {
    marks,
    dropped: () => dropped,
    dump,
    mark(label: string) {
      if (marks.length >= PHASE_CAP) {
        dropped += 1;
        return;
      }
      marks.push({ label: clipBytes(label, PHASE_LABEL_MAX_BYTES), ms: Math.round(performance.now() - t0) });
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

/** 包一个测试体：抛错时输出标记再原样抛；不论如何收尾都停定时器。 */
function traced(name: string, body: (mark: (label: string) => void) => Promise<void>): () => Promise<void> {
  return async () => {
    const ph = startPhases(name);
    try {
      await body(ph.mark);
    } catch (e) {
      ph.dump('失败');
      throw e;
    } finally {
      ph.stop();
    }
  };
}

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

function deferred() {
  let resolve: (v: unknown) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';
type Action = ReleaseCard['action'];
type Recover = NonNullable<Action['recover']>;

function envOk(): EnvResponse {
  const fact = <T,>(value: T) => ({ ok: true as const, value });
  return {
    name: { name: '法国' },
    asOf: ASOF,
    facts: {
      engine: fact({ state: 'on' }),
      version: fact({ current: LIVE, behind: 3, detail: '在用', problems: [] }),
      sessions: fact({ total: 0, byStage: {} }),
      pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
      health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
      schedule: fact({ status: 'fresh', lastSuccessAt: ASOF, outcome: 'ok' }),
    },
  };
}

const NONE: Recover = { retry: null, restore: null, abort: null };
const STUCK: Recover = {
  retry: { sha: HEAD, phase: '第 3 步「等收尾」' },
  restore: null,
  abort: {
    outcome: 'reopen',
    text: '还没动手发版：引擎总开关会开回暂停前的样子（开着），清掉暂停标记，这一趟记为撤销。',
  },
};
const RESTORE: Recover = { retry: null, restore: { target: '提交 2005b2909c4f' }, abort: null };
const PAUSED: Recover = {
  retry: null,
  restore: null,
  abort: { outcome: 'clear_marker', text: '只清掉留下来的暂停标记，引擎总开关不动。' },
};

function card(recover: Recover | undefined, last: Action['last']): ReleaseCard {
  return {
    mainline: {
      state: 'ok',
      commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新耗时表 (#1230)', at: ASOF },
      ci: { state: 'green' },
    },
    deployed: {
      state: 'ok',
      sha: LIVE,
      short: LIVE.slice(0, 12),
      title: '探针历史 (#1225)',
      titleWhy: null,
      deployedAt: ASOF,
      deployedAtWhy: null,
    },
    gap: { state: 'ahead', count: 1, prs: [{ number: 1230, title: '刷新耗时表' }], nonPr: 0 },
    lastDone: { state: 'unreadable', why: '测试里不读' },
    action: { state: 'ready', reasons: [], installed: true, last, ...(recover ? { recover } : {}) },
    asOf: ASOF,
  };
}

const BLOCKED: Action['last'] = {
  state: 'blocked',
  target: '提交 2005b2909c4f',
  at: ASOF,
  why: '等了 30 分钟，法国还有 2 个会话在跑',
  phase: '第 3 步「等收尾」',
};
const FAILED: Action['last'] = {
  state: 'failed',
  target: '提交 2005b2909c4f',
  at: ASOF,
  why: '恢复没成：发版已经发出去了',
  phase: '第 7 步「恢复」',
};
const NOLAST: Action['last'] = { state: 'none', target: null, at: null, why: null, phase: null };

function api(c: ReleaseCard, recover: MockApi['franceReleaseRecover']) {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
    franceReleaseCard: () => Promise.resolve(c),
    franceReleaseRecover: recover,
  } as unknown as FleetApi;
}

describe('三个按钮什么时候出现', () => {
  test(
    '后端说能点才出现：卡住给「重试」「撤掉暂停」，没成给「恢复引擎开关」，只剩标记给「撤掉暂停」；没有就一个都不画',
    traced('matrix', async (mark) => {
      const cases: [Recover | undefined, Action['last'], string[]][] = [
        [STUCK, BLOCKED, ['重试', '撤掉暂停']],
        [RESTORE, FAILED, ['恢复引擎开关']],
        [PAUSED, NOLAST, ['撤掉暂停']],
        [NONE, NOLAST, []],
        [undefined, NOLAST, []],
      ];
      let i = 0;
      for (const [recover, last, names] of cases) {
        i += 1;
        mark(`矩阵${i}/${cases.length}·渲染`);
        const { unmount } = renderApp(<France />, {
          api: api(card(recover, last), () => Promise.reject(new Error('不该点'))),
          route: '/france',
        });
        mark(`矩阵${i}·等发布按钮`);
        await screen.findByRole('button', { name: '发布到法国' });
        mark(`矩阵${i}·读恢复按钮`);
        const box = document.querySelector('[data-release-recover]');
        const got = [...(box?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
        expect(got, JSON.stringify(recover)).toEqual(names);
        unmount();
        mark(`矩阵${i}·卸载`);
      }
    }),
  );
});

for (const [kind, recover, last, opener, confirmName, needle] of [
  ['retry', STUCK, BLOCKED, '重试', '确认重试', '从这一步接着等会话收尾，往后照走，不从头暂停一遍'],
  ['restore', RESTORE, FAILED, '恢复引擎开关', '确认恢复', '按发版前记下的状态把它开回'],
  ['abort', STUCK, BLOCKED, '撤掉暂停', '确认撤掉', '引擎总开关会开回暂停前的样子'],
  ['abort', PAUSED, NOLAST, '撤掉暂停', '确认撤掉', '引擎总开关不动'],
] as const) {
  describe(`「${opener}」（${kind}）`, () => {
    test(
      '点了先弹确认框写明后果；确认后发请求只带种类；后端慢时连点只发一次、确认键转圈（aria-busy）、框关不掉；成功才关并弹成功',
      traced(`${kind}-slow`, async (mark) => {
        const d = deferred();
        const calls: string[] = [];
        const a = api(card(recover, last), (k) => {
          calls.push(k);
          return d.promise.then(() => ({ requested: true as const, kind: k, at: ASOF }));
        });
        mark('渲染');
        renderApp(<France />, { api: a, route: '/france' });
        mark('等打开按钮');
        const open = await screen.findByRole('button', { name: opener });
        fireEvent.click(open);
        mark('等确认框');
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog.querySelector('[data-recover-body]')?.textContent).toContain(needle);
        expect(dialog.textContent).toContain('记一条操作记录');
        expect(calls).toEqual([]);

        mark('同步取确认键');
        const ok = within(dialog).getByRole('button', { name: confirmName });
        fireEvent.click(ok);
        fireEvent.click(ok);
        mark('等转圈');
        await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
        fireEvent.click(ok);
        expect(calls).toEqual([kind]);
        mark('转圈中点先不');
        fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
        expect(screen.queryByRole('alertdialog')).not.toBeNull();

        mark('解决 deferred');
        await act(async () => d.resolve(undefined));
        mark('等关框');
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(toast.success).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([kind]);
        mark('完成');
      }),
    );

    test(
      '【故意造出的失败】后端回 409：框留在原处写原因、弹失败提示，确认键恢复能再点（不当成成功）',
      traced(`${kind}-409`, async (mark) => {
        const a = api(card(recover, last), () =>
          Promise.reject(new Error('现在没有可点的按钮：刷新页面再看')),
        );
        mark('渲染');
        renderApp(<France />, { api: a, route: '/france' });
        mark('等打开按钮');
        fireEvent.click(await screen.findByRole('button', { name: opener }));
        mark('等确认框');
        const dialog = await screen.findByRole('alertdialog');
        mark('同步取确认键');
        const ok = within(dialog).getByRole('button', { name: confirmName });
        fireEvent.click(ok);
        mark('等失败原因');
        await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('刷新页面再看'));
        expect(screen.queryByRole('alertdialog')).not.toBeNull();
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.success).not.toHaveBeenCalled();
        expect(ok.getAttribute('aria-busy')).not.toBe('true');
        mark('完成');
      }),
    );
  });
}

describe('假后端（dev:mock）：三个按钮点得动', () => {
  test('mockRelease 写 stuck：点「重试」后进入在走（时间线接着第 3 步），按钮消失', async () => {
    localStorage.setItem('mockRelease', 'stuck');
    try {
      const a = createMockApi({ live: false });
      const first = await a.franceReleaseCard();
      expect(first.action.last.state).toBe('blocked');
      expect(first.action.recover?.retry).not.toBeNull();
      await a.franceReleaseRecover('retry');
      const after = await a.franceReleaseCard();
      expect(after.action.last.state).toBe('running');
      expect(after.action.last.timeline?.phase).toBe(3);
      expect(after.action.recover).toEqual({ retry: null, restore: null, abort: null });
      await expect(a.franceReleaseRecover('retry')).rejects.toThrow();
    } finally {
      localStorage.removeItem('mockRelease');
    }
  });
});

describe('阶段标记的诊断合同（#3396）', () => {
  test('标记数有上限、超了只计数；整行有字节上限；标记名被截；失败后再快超时也只输出一次', () => {
    const lines: string[] = [];
    const ph = startPhases('t'.repeat(500), (l) => lines.push(l), 10_000);
    try {
      for (let i = 0; i < PHASE_CAP + 5; i++) ph.mark(`阶段${i}${'长'.repeat(100)}`);
      expect(ph.marks).toHaveLength(PHASE_CAP);
      expect(ph.dropped()).toBe(5);
      ph.dump('失败');
      ph.dump('快超时');
    } finally {
      ph.stop();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[阶段标记·失败]');
    expect(lines[0]).toContain('另有 5 个标记未展开');
    expect(Buffer.byteLength(lines[0] ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    for (const m of ph.marks)
      expect(Buffer.byteLength(m.label, 'utf8')).toBeLessThanOrEqual(PHASE_LABEL_MAX_BYTES);
  });

  test('正常收尾（stop）后不输出；输出口抛错不外冒', async () => {
    const lines: string[] = [];
    const ok = startPhases('ok', (l) => lines.push(l), 20);
    ok.mark('a');
    ok.stop();
    const bad = startPhases(
      'bad',
      () => {
        throw new Error('口坏了');
      },
      5,
    );
    await new Promise((r) => setTimeout(r, 60));
    bad.stop();
    expect(lines).toEqual([]);
    expect(() => bad.dump('失败')).not.toThrow();
  });

  test('没收尾的在快超时时输出一次，写明停在哪一步', async () => {
    const lines: string[] = [];
    const ph = startPhases('slow', (l) => lines.push(l), 10);
    ph.mark('等确认框');
    await new Promise((r) => setTimeout(r, 60));
    ph.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[阶段标记·快超时]');
    expect(lines[0]).toContain('停在：等确认框');
  });

  test('traced 把断言错误原样抛回去，诊断行只有阶段名', async () => {
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof write;
    const leaked = '不该进诊断的句子甲乙丙';
    const err = new Error(`刷新失败 ${leaked}`);
    try {
      await expect(
        traced('secret-case', async (mark) => {
          mark('等确认框');
          throw err;
        })(),
      ).rejects.toBe(err);
      await traced('ok-case', async (mark) => {
        mark('完成');
      })();
    } finally {
      process.stderr.write = write;
    }
    const phase = lines.filter((l) => l.includes('[阶段标记·'));
    expect(phase).toHaveLength(1);
    expect(phase[0]).toContain('[阶段标记·失败]');
    expect(phase[0]).toContain('停在：等确认框');
    expect(phase[0]).toContain('test=secret-case');
    expect(phase[0]).not.toContain(leaked);
    expect(phase[0]).not.toContain('刷新失败');
  });
});
