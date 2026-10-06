// 关单要有证据（#241；#654 起证据是「合并了的 PR / 子单都关了 / --note」，不再是 specs/<号>-<短名>/结果.md）：
// pnpm issue:close 的每条路。【故意造出的失败】几条：没证据拒关；读不到 GitHub、读不到时间线、时间线没读全就报错不关——
// 拿改动前的代码（没有这个脚本、gh issue close 直接关）跑都是红的。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CloseRefused, CloseUnchecked, issueClose } from '../src/issue-close.ts';
import type { GhResult } from '../src/issue-new.ts';
import { runChild } from './child.ts';

const REPO_URL = 'https://api.github.com/repos/o/r';
const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr });

/** 时间线上的一条「谁提到了它」：merged = 合并了的 PR，open = 没合并的 PR，issue = 一张单子提到的。 */
function mention(number: number, over: { kind?: 'merged' | 'open' | 'issue'; repo?: string } = {}) {
  const kind = over.kind ?? 'merged';
  return {
    event: 'cross-referenced',
    source: {
      type: 'issue',
      issue: {
        number,
        html_url: `https://github.com/o/r/${kind === 'issue' ? 'issues' : 'pull'}/${number}`,
        repository_url: over.repo ?? REPO_URL,
        ...(kind === 'issue'
          ? {}
          : { pull_request: { merged_at: kind === 'merged' ? '2026-10-02T23:31:56Z' : null } }),
      },
    },
  };
}

interface World {
  issue: Record<string, unknown>;
  /** --superseded-by 指向的那张单长什么样（默认是一张开着的单）。 */
  byIssue: Record<string, unknown> | null;
  subs: unknown;
  /** 时间线，一页一页（每页最多 100 条）。 */
  timeline: unknown[][];
  /** 按调用的前缀故意坏掉。 */
  broken: { match: (args: string[]) => boolean; result: GhResult }[];
  closeResult: GhResult;
  /** 关了以后回读的样子。 */
  afterClose: Record<string, unknown>;
  calls: string[][];
}

function world(over: Partial<World> = {}): World & { gh: (args: string[]) => Promise<GhResult> } {
  const w: World = {
    issue: {
      number: 241,
      state: 'open',
      state_reason: null,
      html_url: 'https://github.com/o/r/issues/241',
      repository_url: REPO_URL,
    },
    byIssue: {
      number: 999,
      state: 'open',
      state_reason: null,
      html_url: 'https://github.com/o/r/issues/999',
      repository_url: REPO_URL,
    },
    subs: [],
    timeline: [[mention(300)]],
    broken: [],
    closeResult: { code: 0, stdout: '', stderr: '' },
    afterClose: { state: 'closed', state_reason: 'completed' },
    calls: [],
    ...over,
  };
  const gh = async (args: string[]): Promise<GhResult> => {
    w.calls.push(args);
    const hit = w.broken.find((b) => b.match(args));
    if (hit) return hit.result;
    const [cmd, path] = args;
    if (cmd === 'issue' && path === 'close') {
      if (w.closeResult.code === 0) w.issue = { ...w.issue, ...w.afterClose };
      return w.closeResult;
    }
    if (path === 'repos/{owner}/{repo}/issues/241') return ok(w.issue);
    if (path === 'repos/{owner}/{repo}/issues/999') {
      if (w.byIssue === null) return fail('Not Found', 1);
      return ok(w.byIssue);
    }
    if (path === 'repos/{owner}/{repo}/issues/241/sub_issues?per_page=100') return ok(w.subs);
    const page = /^repos\/\{owner\}\/\{repo\}\/issues\/241\/timeline\?per_page=100&page=(\d+)$/.exec(
      path ?? '',
    );
    if (page?.[1]) return ok(w.timeline[Number(page[1]) - 1] ?? []);
    return fail(`假 gh 不认得：${args.join(' ')}`);
  };
  return Object.assign(w, { gh });
}

const run = (w: ReturnType<typeof world>, ...argv: string[]) => issueClose(argv.length ? argv : ['241'], w);
const closeCalls = (w: World) => w.calls.filter((a) => a[0] === 'issue' && a[1] === 'close');
const timelineCalls = (w: World) => w.calls.filter((a) => (a[1] ?? '').includes('/timeline?'));
const startsWith = (prefix: string) => (args: string[]) => (args[1] ?? '').startsWith(prefix);
const NO_TIMELINE = {
  match: startsWith('repos/{owner}/{repo}/issues/241/timeline'),
  result: fail('不该读时间线'),
};

describe('pnpm issue:close：有证据才关（合并了的 PR / 子单都关了 / --note）', () => {
  it('合并了的 PR 提到它：关成「完成」，评论里贴 PR 链接，关完回读确认', async () => {
    const w = world({ timeline: [[mention(301), mention(300)]] });
    const r = await run(w);
    expect(r).toEqual({
      outcome: 'closed',
      number: 241,
      issueUrl: 'https://github.com/o/r/issues/241',
      evidence: '合并了的 PR #300、#301',
    });
    const [close] = closeCalls(w);
    expect(close?.slice(0, 5)).toEqual(['issue', 'close', '241', '--reason', 'completed']);
    expect(close?.[6]).toContain(
      '[#300](https://github.com/o/r/pull/300)、[#301](https://github.com/o/r/pull/301)',
    );
    // 关完又读了一次这张单（回读）
    expect(w.calls.at(-1)).toEqual(['api', 'repos/{owner}/{repo}/issues/241']);
  });

  it('单号写成 #241、前面带 -- 都认', async () => {
    expect((await run(world(), '#241')).outcome).toBe('closed');
    expect((await run(world(), '--', '241')).outcome).toBe('closed');
  });

  it('【故意造出的失败】时间线上只有没合并的 PR、别的仓的 PR、单子提到的：都不算证据，拒关，一次关单都不发', async () => {
    const w = world({
      timeline: [
        [
          mention(300, { kind: 'open' }),
          mention(301, { repo: 'https://api.github.com/repos/x/y' }),
          mention(302, { kind: 'issue' }),
          { event: 'labeled' },
        ],
      ],
    });
    const err = await run(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/^#241 没有合并了的 PR 提到它、下面也没有子单，没关/);
    expect((err as Error).message).toContain('--note');
    expect(closeCalls(w)).toEqual([]);
  });

  it('下面的子单都关了（母单）：没有 PR 提到它也行，评论里写是哪几张子单', async () => {
    const w = world({
      timeline: [[]],
      subs: [
        { number: 301, state: 'closed' },
        { number: 300, state: 'closed' },
      ],
    });
    const r = await run(w);
    expect(r).toMatchObject({ outcome: 'closed', evidence: '子单 #300、#301 都关了' });
    expect(closeCalls(w)[0]?.[6]).toContain('子单 #300、#301 都关了');
  });

  it('--note：没有 PR 的收尾（配置、手工操作）——不去读时间线，评论里写那一句', async () => {
    const w = world({ broken: [NO_TIMELINE] });
    const r = await run(w, '241', '--note', '香港 nginx 已改好并 reload');
    expect(r).toMatchObject({ outcome: 'closed', evidence: '--note：香港 nginx 已改好并 reload' });
    expect(closeCalls(w)[0]?.[6]).toContain('做完了：香港 nginx 已改好并 reload');
    expect(timelineCalls(w)).toEqual([]);
  });

  it('--note=… 的写法也认；写了两次、没写值、只有空格都拒关', async () => {
    expect((await run(world(), '241', '--note=手工清好了')).outcome).toBe('closed');
    for (const argv of [
      ['241', '--note'],
      ['241', '--note', '  '],
      ['241', '--note', 'a', '--note', 'b'],
    ]) {
      const w = world();
      await expect(issueClose(argv, w)).rejects.toBeInstanceOf(CloseRefused);
      expect(w.calls).toEqual([]);
    }
  });

  it('时间线分页：第一页满 100 条、合并了的 PR 在第二页：读到第二页才认', async () => {
    const full = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    const w = world({ timeline: [full, [mention(300)]] });
    const r = await run(w);
    expect(r).toMatchObject({ outcome: 'closed', evidence: '合并了的 PR #300' });
    expect(timelineCalls(w).map((a) => a[1])).toEqual([
      'repos/{owner}/{repo}/issues/241/timeline?per_page=100&page=1',
      'repos/{owner}/{repo}/issues/241/timeline?per_page=100&page=2',
    ]);
  });

  it('【故意造出的失败】时间线 10 页读完还有下一页：算没读全，报错不关（不当成「没有」），提示用 --note', async () => {
    const full = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    const w = world({ timeline: Array.from({ length: 10 }, () => full) });
    const err = await run(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseUnchecked);
    expect((err as Error).message).toMatch(/时间线超过 1000 条，没读全，没关.*--note/);
    expect(closeCalls(w)).toEqual([]);
  });

  it('下面还有开着的子单：拒关，列出是哪几张（带 --note 也一样）', async () => {
    const w = world({
      subs: [
        { number: 300, state: 'closed' },
        { number: 302, state: 'open' },
        { number: 301, state: 'open' },
      ],
    });
    for (const argv of [['241'], ['241', '--note', '做完了']]) {
      const err = await issueClose(argv, w).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloseRefused);
      expect((err as Error).message).toMatch(/^#241 下面还有 2 张子单开着（#301、#302），没关/);
    }
    expect(closeCalls(w)).toEqual([]);
  });

  it('是 PR、参数不对：拒关，不关', async () => {
    const pr = world({
      issue: { number: 241, state: 'open', pull_request: {}, html_url: 'u', repository_url: REPO_URL },
    });
    await expect(run(pr)).rejects.toThrow(new CloseRefused('#241 是 PR，不是单，没关。'));
    for (const argv of [[], ['abc'], ['241', '242'], ['0']]) {
      const w = world();
      await expect(issueClose(argv, w)).rejects.toBeInstanceOf(CloseRefused);
      expect(w.calls).toEqual([]);
    }
  });

  it('本来就关着：不动，照实说关成了什么', async () => {
    const w = world({
      issue: {
        number: 241,
        state: 'closed',
        state_reason: 'not_planned',
        html_url: 'https://github.com/o/r/issues/241',
        repository_url: REPO_URL,
      },
    });
    expect(await run(w)).toEqual({
      outcome: 'already',
      number: 241,
      issueUrl: 'https://github.com/o/r/issues/241',
      stateReason: 'not_planned',
    });
    expect(closeCalls(w)).toEqual([]);
  });
});

describe('pnpm issue:close --superseded-by / --reason：关掉被取代的、不做完的', () => {
  it('--superseded-by <号>：不要证据（不读时间线），关成 not_planned，评论写「被 #<号> 取代」', async () => {
    const w = world({
      timeline: [[]],
      broken: [NO_TIMELINE],
      afterClose: { state: 'closed', state_reason: 'not_planned' },
    });
    const r = await issueClose(['241', '--superseded-by', '999'], w);
    expect(r).toEqual({ outcome: 'closed', number: 241, issueUrl: 'https://github.com/o/r/issues/241' });
    const [close] = closeCalls(w);
    // gh 命令行要带空格的 not planned，不是 not_planned（真 gh 对后者报 invalid argument）
    expect(close?.slice(0, 5)).toEqual(['issue', 'close', '241', '--reason', 'not planned']);
    expect(close?.[6]).toContain('被 #999 取代');
    expect(timelineCalls(w)).toEqual([]);
  });

  it('--superseded-by 隐含 not_planned；同时给 --reason completed 会拒关', async () => {
    const w = world();
    const err = await issueClose(['241', '--superseded-by', '999', '--reason', 'completed'], w).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/隐含关成 not_planned/);
    expect(closeCalls(w)).toEqual([]);
  });

  it('--superseded-by 不能给这张单自己；给的号得是单，不能是 PR', async () => {
    const w1 = world();
    await expect(issueClose(['241', '--superseded-by', '241'], w1)).rejects.toThrow(/不能给这张单自己/);
    expect(closeCalls(w1)).toEqual([]);

    const w2 = world({
      byIssue: { number: 999, state: 'open', pull_request: {}, html_url: 'u', repository_url: REPO_URL },
    });
    await expect(issueClose(['241', '--superseded-by', '999'], w2)).rejects.toThrow(/是 PR，不是单/);
    expect(closeCalls(w2)).toEqual([]);
  });

  it('【故意造出的失败】没证据也不传 --superseded-by：照走 completed，被拒关（显式写 --reason completed 一样）', async () => {
    for (const argv of [['241'], ['241', '--reason', 'completed']]) {
      const w = world({ timeline: [[]] });
      const err = await issueClose(argv, w).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloseRefused);
      expect((err as Error).message).toMatch(/没有合并了的 PR 提到它/);
      expect(closeCalls(w)).toEqual([]);
    }
  });

  it('--reason duplicate：不查证据，关成 duplicate，评论里说清；带 --note 就把那句话写进评论', async () => {
    const w = world({
      timeline: [[]],
      broken: [NO_TIMELINE],
      afterClose: { state: 'closed', state_reason: 'duplicate' },
    });
    const r = await issueClose(['241', '--reason', 'duplicate', '--note', '和 #200 是同一件事'], w);
    expect(r.outcome).toBe('closed');
    const [close] = closeCalls(w);
    expect(close?.slice(0, 5)).toEqual(['issue', 'close', '241', '--reason', 'duplicate']);
    expect(close?.[6]).toContain('duplicate');
    expect(close?.[6]).toContain('和 #200 是同一件事');
    expect(timelineCalls(w)).toEqual([]);
  });

  it('--reason not_planned（不带 superseded-by）：不查证据，关成 not_planned', async () => {
    const w = world({
      timeline: [[]],
      broken: [NO_TIMELINE],
      afterClose: { state: 'closed', state_reason: 'not_planned' },
    });
    const r = await issueClose(['241', '--reason', 'not_planned'], w);
    expect(r.outcome).toBe('closed');
    const [close] = closeCalls(w);
    expect(close?.slice(0, 5)).toEqual(['issue', 'close', '241', '--reason', 'not planned']);
  });

  it('--reason 的值不在三种里：拒关，写清只认哪三种', async () => {
    const w = world();
    const err = await issueClose(['241', '--reason', 'wontfix'], w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/--reason 只认 completed \/ not_planned \/ duplicate/);
    expect(w.calls).toEqual([]);
  });

  it('--superseded-by 给的不是单号：拒关', async () => {
    const w = world();
    const err = await issueClose(['241', '--superseded-by', 'abc'], w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/--superseded-by 要给存在的单号/);
    expect(w.calls).toEqual([]);
  });

  it('【故意造出的失败】--superseded-by 指向的单读不到：报错不关（不拿 404 当不存在就行）', async () => {
    const w = world({ byIssue: null });
    const err = await issueClose(['241', '--superseded-by', '999'], w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseUnchecked);
    expect((err as Error).message).toMatch(/读取代它的 #999失败/);
    expect(closeCalls(w)).toEqual([]);
  });

  it('子单还开着这条照走：superseded-by 不豁免子单', async () => {
    const w = world({ subs: [{ number: 302, state: 'open' }] });
    const err = await issueClose(['241', '--superseded-by', '999'], w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/还有 1 张子单开着/);
    expect(closeCalls(w)).toEqual([]);
  });
});

describe('pnpm issue:close：【故意造出的失败】读不到、认不出、没关成都明确报错，不关', () => {
  const cases: [name: string, over: Partial<World>, message: RegExp][] = [
    [
      '读不到这张单',
      { broken: [{ match: (a) => a[1] === 'repos/{owner}/{repo}/issues/241', result: fail('timeout') }] },
      /^gh 读 #241失败/,
    ],
    [
      '读不到子单',
      {
        broken: [
          { match: startsWith('repos/{owner}/{repo}/issues/241/sub_issues'), result: fail('HTTP 500') },
        ],
      },
      /^gh 读 #241 的子单失败/,
    ],
    [
      '读不到时间线',
      {
        broken: [{ match: startsWith('repos/{owner}/{repo}/issues/241/timeline'), result: fail('HTTP 502') }],
      },
      /^gh 读 #241 的时间线失败（退出码 1）：HTTP 502，没关。$/,
    ],
    [
      '时间线读回来不是列表',
      {
        broken: [
          {
            match: startsWith('repos/{owner}/{repo}/issues/241/timeline'),
            result: { code: 0, stdout: '{}', stderr: '' },
          },
        ],
      },
      /时间线：读回来的不是列表/,
    ],
    [
      '时间线里有一条交叉引用认不出',
      { timeline: [[{ event: 'cross-referenced', source: {} }]] },
      /时间线：有一条交叉引用认不出/,
    ],
    [
      '读回来的不是 JSON',
      {
        broken: [
          {
            match: (a) => a[1] === 'repos/{owner}/{repo}/issues/241',
            result: { code: 0, stdout: '<html>', stderr: '' },
          },
        ],
      },
      /^gh 读 #241读回来的不是 JSON/,
    ],
    ['子单有一张认不出', { subs: [{ number: 5 }] }, /子单：有一张认不出/],
    ['子单读回来不是列表', { subs: { total: 0 } }, /子单：读回来的不是列表/],
    [
      '单子读回来号不对',
      { issue: { number: 242, state: 'open', html_url: 'u', repository_url: REPO_URL } },
      /要的是 #241，读回来的是 242，没关/,
    ],
    [
      '单子读回来没有 repository_url（没法判是不是同一个仓提到的）',
      { issue: { number: 241, state: 'open', html_url: 'u' } },
      /repository_url 认不出，没关/,
    ],
    [
      '关单报错',
      { closeResult: fail('HTTP 403', 1) },
      /^gh 关单报错（退出码 1）：HTTP 403。单可能关了也可能没关/,
    ],
    [
      '关完回读不是「关了、完成」',
      { afterClose: { state: 'open' } },
      /^关完回读 #241：state=open、state_reason=（空），不是「关了、完成」/,
    ],
  ];

  it.each(cases)('%s', async (_name, over, message) => {
    const w = world(over);
    const err = await run(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseUnchecked);
    expect((err as Error).message).toMatch(message);
    // 关单那一步之前坏的，一次关单都没发
    if (!/关单报错|关完回读/.test(_name)) expect(closeCalls(w)).toEqual([]);
  });
});

// 同步用例，不设 vitest 的超时（为什么见 child.ts 开头）。
describe('入口的退出码', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/issue-close.ts', import.meta.url));
  const emptyPath = mkdtempSync(join(tmpdir(), 'fleet-issue-close-nogh-'));

  it('参数不对：拒关，退出码 1', () => {
    const r = runChild(process.execPath, [bin]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('用法：pnpm issue:close <单号>');
  });

  it('【故意造出的失败】gh 起不来（读不到 GitHub）：没关，退出码 2，不是 0', () => {
    const r = runChild(process.execPath, [bin, '241'], {
      env: { ...process.env, PATH: emptyPath, Path: emptyPath },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/gh 读 #241失败（退出码 127）：找不到 gh 命令.*没关/);
  });
});
