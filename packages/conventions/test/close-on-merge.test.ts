// 合并时自动收口（close-on-merge.ts，#995 拍 1 的 A）：用假的 gh 跑 closeOnMerge。
// 每一条「不碰」一个故意造出来的例子（误关有意留着的单比漏关更糟）；读不到、认不出的每一条都断言抛 CloseUnchecked，
// 不当成「没有要收口的」。改动前（没有这个文件、合并后没人收口）这些全是红的。
import { describe, expect, it } from 'vitest';
import { closeOnMerge, whyLeave } from '../src/close-on-merge.ts';
import { CloseUnchecked } from '../src/issue-close.ts';
import type { GhResult } from '../src/issue-new.ts';

const REPO_URL = 'https://api.github.com/repos/o/r';
const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr });

const column = (first: string, ...more: string[]) => [`**需求**：${first}`, ...more, ''].join('\n');

interface FakeIssue {
  state: 'open' | 'closed';
  labels: unknown[];
  /** 是 PR 不是单。 */
  pull?: boolean;
}

interface World {
  pull: Record<string, unknown>;
  issues: Record<number, FakeIssue>;
  /** 母单 → 子单（号、状态）。 */
  subs: Record<number, { number: number; state: 'open' | 'closed' }[]>;
  openPulls: unknown[] | GhResult;
  /** 按调用故意坏掉。 */
  broken: { match: (args: string[]) => boolean; result: GhResult }[];
  /** 关单之后回读：true 时关了也回读成还开着（造「没关上」）。 */
  closeDoesNothing: boolean;
  calls: string[][];
}

const mergedPull = (body: string, over: Record<string, unknown> = {}) => ({
  number: 500,
  title: '做了一件事',
  body,
  merged_at: '2026-10-07T00:00:00Z',
  head: { ref: 'feat/x' },
  base: { ref: 'main' },
  ...over,
});

function world(over: Partial<World> = {}) {
  const w: World = {
    pull: mergedPull(column('Refs #30')),
    issues: { 30: { state: 'open', labels: [{ name: '杂项' }] } },
    subs: {},
    openPulls: [],
    broken: [],
    closeDoesNothing: false,
    calls: [],
    ...over,
  };
  const gh = async (args: string[]): Promise<GhResult> => {
    w.calls.push(args);
    const hit = w.broken.find((b) => b.match(args));
    if (hit) return hit.result;
    const [cmd, path] = args;
    if (cmd === 'issue' && path === 'close') {
      const target = w.issues[Number(args[2])];
      if (target && !w.closeDoesNothing) target.state = 'closed';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'api' && path === 'repos/{owner}/{repo}/pulls/500') return ok(w.pull);
    if (cmd === 'api' && path === 'repos/{owner}/{repo}/pulls?state=open&per_page=100') {
      return Array.isArray(w.openPulls) ? ok(w.openPulls) : w.openPulls;
    }
    const sub = /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/sub_issues\?per_page=100$/.exec(path ?? '');
    if (sub?.[1]) return ok(w.subs[Number(sub[1])] ?? []);
    const one = /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(path ?? '');
    if (one?.[1]) {
      const n = Number(one[1]);
      const i = w.issues[n];
      if (!i) return fail('Not Found');
      return ok({
        number: n,
        state: i.state,
        state_reason: i.state === 'closed' ? 'completed' : null,
        html_url: `https://github.com/o/r/issues/${n}`,
        repository_url: REPO_URL,
        labels: i.labels,
        ...(i.pull ? { pull_request: {} } : {}),
      });
    }
    return fail(`假 gh 不认得这条：${args.join(' ')}`);
  };
  return { w, gh };
}

const closedCalls = (w: World) => w.calls.filter((c) => c[0] === 'issue' && c[1] === 'close');

describe('合并时收口：该关的关', () => {
  it('Refs 着的叶子单、没有别的 PR 还挂着它：关了，评论写明是哪张 PR 收口的', async () => {
    const { w, gh } = world();
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes).toEqual([expect.objectContaining({ number: 30, outcome: 'closed' })]);
    expect(w.issues[30]?.state).toBe('closed');
    const [call] = closedCalls(w);
    expect(call?.join(' ')).toContain('PR #500');
    expect(call?.join(' ')).toContain('close-on-merge');
  });

  it('「本机做」的单，Closes 的照关（GitHub 本来也会关）', async () => {
    const { w, gh } = world({
      pull: mergedPull(column('Closes #30')),
      issues: { 30: { state: 'open', labels: [{ name: '本机做' }] } },
    });
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes).toEqual([expect.objectContaining({ number: 30, outcome: 'closed' })]);
    expect(w.issues[30]?.state).toBe('closed');
  });

  it('别的开着的 PR 挂的是另一张单：这张照关；挂着两张单的各判各的', async () => {
    const { w, gh } = world({
      pull: mergedPull(column('Refs #30', 'Refs #31')),
      issues: {
        30: { state: 'open', labels: [] },
        31: { state: 'open', labels: [] },
      },
      openPulls: [{ number: 501, body: column('Refs #31') }],
    });
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes.map((o) => [o.number, o.outcome])).toEqual([
      [30, 'closed'],
      [31, 'kept'],
    ]);
    expect(w.issues[30]?.state).toBe('closed');
    expect(w.issues[31]?.state).toBe('open');
  });
});

describe('合并时收口：有意留着的不碰（每条一个故意造出来的例子）', () => {
  const untouched = async (over: Partial<World>, why: string | RegExp) => {
    const { w, gh } = world(over);
    const r = await closeOnMerge(500, { gh });
    expect(closedCalls(w)).toEqual([]);
    expect(r.outcomes).toEqual([expect.objectContaining({ number: 30, outcome: 'kept' })]);
    const kept = r.outcomes[0];
    expect(kept && 'why' in kept ? kept.why : '').toMatch(why);
    return { w, r };
  };

  it('Refs 那一行写明「分片、关不了它」：不碰，连单都不去读', async () => {
    const { w } = await untouched({ pull: mergedPull(column('Refs #30（分片，关不了它）')) }, '分片');
    expect(w.calls.some((c) => c[1]?.endsWith('/issues/30'))).toBe(false);
  });

  it('贴了「母单」标签：不碰', async () => {
    await untouched({ issues: { 30: { state: 'open', labels: [{ name: '母单' }] } } }, '母单');
  });

  it('「本机做」标签的单、这里只是 Refs：不碰', async () => {
    await untouched({ issues: { 30: { state: 'open', labels: [{ name: '本机做' }] } } }, '本机做');
  });

  it('还有别的开着的 PR 的「需求」栏挂着它（接力分片）：不碰', async () => {
    await untouched({ openPulls: [{ number: 501, body: column('Refs #30') }] }, '别的开着的 PR');
  });

  it('下面还有开着的子单：不碰（issue-close 拒关）', async () => {
    await untouched({ subs: { 30: [{ number: 31, state: 'open' }] } }, '子单');
  });

  it('已经关了：不碰，不再关一次', async () => {
    await untouched({ issues: { 30: { state: 'closed', labels: [] } } }, '已经关了');
  });

  it('这个号是 PR 不是单：不碰', async () => {
    await untouched({ issues: { 30: { state: 'open', labels: [], pull: true } } }, '是 PR');
  });
});

describe('合并时收口：整张 PR 不碰', () => {
  it('没合并：不碰，不读单', async () => {
    const { w, gh } = world({ pull: mergedPull(column('Refs #30'), { merged_at: null }) });
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes).toEqual([]);
    expect(r.note).toContain('没合并');
    expect(closedCalls(w)).toEqual([]);
  });

  it('引擎任务流程的 PR（fleet/<单号>-t<8 位>）：它的单引擎自己关，不碰', async () => {
    const { w, gh } = world({
      pull: mergedPull(column('Refs #30'), { head: { ref: 'fleet/30-t0123abcd' } }),
    });
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes).toEqual([]);
    expect(r.note).toContain('引擎');
    expect(closedCalls(w)).toEqual([]);
  });

  it('「需求」栏没挂单：不碰', async () => {
    const { w, gh } = world({ pull: mergedPull('**需求**：无\n') });
    const r = await closeOnMerge(500, { gh });
    expect(r.outcomes).toEqual([]);
    expect(r.note).toContain('没挂单');
    expect(closedCalls(w)).toEqual([]);
  });
});

describe('合并时收口：【故意造出的失败】读不到、认不出一律抛 CloseUnchecked，不当成没有要收口的', () => {
  const unchecked = async (over: Partial<World>, text: string | RegExp) => {
    const { w, gh } = world(over);
    const err = await closeOnMerge(500, { gh }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CloseUnchecked);
    expect((err as Error).message).toMatch(text);
    return w;
  };

  it('读不到 PR', async () => {
    await unchecked(
      { broken: [{ match: (a) => a[1] === 'repos/{owner}/{repo}/pulls/500', result: fail('HTTP 502') }] },
      /读 PR #500失败/,
    );
  });

  it('PR 读回来认不出（没有 head）', async () => {
    await unchecked({ pull: mergedPull(column('Refs #30'), { head: null }) }, /PR #500 的 head/);
  });

  it('读不到开着的 PR：不知道别的 PR 还挂着没有，不关', async () => {
    const w = await unchecked({ openPulls: fail('HTTP 500') }, /读开着的 PR失败/);
    expect(closedCalls(w)).toEqual([]);
  });

  it('开着的 PR 一页读满（100 张）：没读全，不关', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: 600 + i, body: '' }));
    const w = await unchecked({ openPulls: full }, /没读全/);
    expect(closedCalls(w)).toEqual([]);
  });

  it('开着的一张 PR 认不出（没有 number）', async () => {
    await unchecked({ openPulls: [{ body: '' }] }, /认不出/);
  });

  it('读不到那张单', async () => {
    await unchecked({ issues: {} }, /读 #30失败/);
  });

  it('单上有一个标签认不出（没有 name）：不猜，不关', async () => {
    const w = await unchecked({ issues: { 30: { state: 'open', labels: [{}] } } }, /标签认不出/);
    expect(closedCalls(w)).toEqual([]);
  });

  it('读不到子单：不关（issue-close 的读法同样抛）', async () => {
    const w = await unchecked(
      {
        broken: [
          {
            match: (a) => a[1]?.endsWith('/issues/30/sub_issues?per_page=100') ?? false,
            result: fail('HTTP 500'),
          },
        ],
      },
      /子单/,
    );
    expect(closedCalls(w)).toEqual([]);
  });

  it('关完回读还是开着：不当成关了', async () => {
    await unchecked({ closeDoesNothing: true }, /关完回读/);
  });
});

describe('whyLeave：合并收口和每日对账共用的「有意留着」判断', () => {
  const refs = { number: 1, kind: 'refs' as const, slice: false };
  it('三种有意留着各一个，普通 Refs 没有', () => {
    expect(whyLeave({ ...refs, slice: true }, [])).toContain('分片');
    expect(whyLeave(refs, ['母单'])).toContain('母单');
    expect(whyLeave(refs, ['本机做'])).toContain('本机做');
    expect(whyLeave({ ...refs, kind: 'closes' }, ['本机做'])).toBeUndefined();
    expect(whyLeave(refs, ['需求'])).toBeUndefined();
  });
});
