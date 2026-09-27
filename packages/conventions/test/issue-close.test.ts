// 关单要有结果（#241）：判「这张单有没有结果」的那一份、GitHub 认的关单写法、pnpm issue:close 的每条路。
// 【故意造出的失败】几条：没结果文档拒关；读不到 GitHub、读不到主线就报错不关——拿改动前的代码（没有这个脚本、
// gh issue close 直接关）跑都是红的。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { closingIssues, resultDocIssue, resultDocOf } from '../src/close-rule.ts';
import { CloseRefused, CloseUnchecked, issueClose } from '../src/issue-close.ts';
import type { GhResult } from '../src/issue-new.ts';
import { runChild } from './child.ts';

const DIR = '241-关单要有结果';
const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr });

describe('这张单有没有结果：specs/<号>-<短名>/结果.md', () => {
  it('认得出是哪张单的；别的文件、别的写法都不算', () => {
    expect(resultDocIssue(`specs/${DIR}/结果.md`)).toBe(241);
    for (const p of [
      `specs/${DIR}/需求.md`,
      'specs/0241-x/结果.md',
      'specs/241-/结果.md',
      'specs/241-../结果.md',
      'specs/241-a/b/结果.md',
      'specs/241/结果.md',
      'docs/结果.md',
      `specs/${DIR}/结果.md.bak`,
    ]) {
      expect(resultDocIssue(p), p).toBeUndefined();
    }
  });

  it('只认这张单的号：2410、24 的结果不算 241 的', () => {
    const files = ['specs/2410-y/结果.md', 'specs/24-x/结果.md', `specs/${DIR}/需求.md`];
    expect(resultDocOf(241, files)).toBeUndefined();
    expect(resultDocOf(241, [...files, `specs/${DIR}/结果.md`])).toBe(`specs/${DIR}/结果.md`);
    expect(resultDocOf(24, files)).toBe('specs/24-x/结果.md');
  });
});

describe('GitHub 合并时认的关单写法', () => {
  it('几种写法都认，排好、去重', () => {
    expect(
      closingIssues(
        'Closes #12\nfixed: #3 和 resolves o/r#9；Resolved GH-4，close https://github.com/o/r/issues/7，再 closes #12',
      ),
    ).toEqual([3, 4, 7, 9, 12]);
  });

  it('不是关单词的不算：提到单号、closest、prefix、中文的「关联」', () => {
    expect(closingIssues('属于需求 #12；closest #13；prefix #14；关联 #15；fix the bug in #16')).toEqual([]);
  });

  it('给了仓名：写明是别的仓的不算，同仓的（大小写不同也算）照算', () => {
    expect(closingIssues('fixes a/b#1, fixes O/R#2, fixes #3', 'o/r')).toEqual([2, 3]);
    expect(closingIssues('fixes a/b#1', undefined)).toEqual([1]);
  });
});

interface World {
  issue: Record<string, unknown>;
  subs: unknown;
  specs: unknown;
  dir: unknown;
  /** 按调用的前缀故意坏掉。 */
  broken: { match: (args: string[]) => boolean; result: GhResult }[];
  closeResult: GhResult;
  /** 关了以后回读的样子。 */
  afterClose: Record<string, unknown>;
  calls: string[][];
}

function world(over: Partial<World> = {}): World & { gh: (args: string[]) => Promise<GhResult> } {
  const w: World = {
    issue: { number: 241, state: 'open', state_reason: null, html_url: 'https://github.com/o/r/issues/241' },
    subs: [],
    specs: [
      { name: '24-x', type: 'dir' },
      { name: DIR, type: 'dir' },
      { name: '2410-y', type: 'dir' },
      { name: 'README.md', type: 'file' },
    ],
    dir: [
      { name: '需求.md', type: 'file' },
      { name: '结果.md', type: 'file' },
    ],
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
    if (path === 'repos/{owner}/{repo}')
      return ok({ default_branch: 'main', html_url: 'https://github.com/o/r' });
    if (path === 'repos/{owner}/{repo}/issues/241') return ok(w.issue);
    if (path === 'repos/{owner}/{repo}/issues/241/sub_issues?per_page=100') return ok(w.subs);
    if (path === 'repos/{owner}/{repo}/contents/specs?ref=main') return ok(w.specs);
    if (path === `repos/{owner}/{repo}/contents/specs/${encodeURIComponent(DIR)}?ref=main`) return ok(w.dir);
    return fail(`假 gh 不认得：${args.join(' ')}`);
  };
  return Object.assign(w, { gh });
}

const run = (w: ReturnType<typeof world>, ...argv: string[]) => issueClose(argv.length ? argv : ['241'], w);
const closeCalls = (w: World) => w.calls.filter((a) => a[0] === 'issue' && a[1] === 'close');
const startsWith = (prefix: string) => (args: string[]) => (args[1] ?? '').startsWith(prefix);

describe('pnpm issue:close：主线上有结果文档才关', () => {
  it('有：关成「完成」，评论里贴结果文档的链接，关完回读确认', async () => {
    const w = world();
    const r = await run(w);
    const url = `https://github.com/o/r/blob/main/specs/${encodeURIComponent(DIR)}/${encodeURIComponent('结果.md')}`;
    expect(r).toEqual({
      outcome: 'closed',
      number: 241,
      issueUrl: 'https://github.com/o/r/issues/241',
      resultDoc: `specs/${DIR}/结果.md`,
      resultUrl: url,
    });
    const [close] = closeCalls(w);
    expect(close?.slice(0, 5)).toEqual(['issue', 'close', '241', '--reason', 'completed']);
    expect(close?.[6]).toContain(`[specs/${DIR}/结果.md](${url})`);
    // 关完又读了一次这张单（回读）
    expect(w.calls.at(-1)).toEqual(['api', 'repos/{owner}/{repo}/issues/241']);
  });

  it('单号写成 #241、前面带 -- 都认', async () => {
    expect((await run(world(), '#241')).outcome).toBe('closed');
    expect((await run(world(), '--', '241')).outcome).toBe('closed');
  });

  it('【故意造出的失败】主线上的需求目录里没有 结果.md：拒关，写清缺什么，一次关单都不发', async () => {
    const w = world({ dir: [{ name: '需求.md', type: 'file' }] });
    const err = await run(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(
      new RegExp(`^主线（main）上的 specs/${DIR}/ 里没有 结果\\.md，#241 没关：写好 结果\\.md`),
    );
    expect(closeCalls(w)).toEqual([]);
  });

  it('【故意造出的失败】主线上连这张单的需求目录都没有（只有 24-、2410- 开头的）：拒关', async () => {
    const w = world({
      specs: [
        { name: '24-x', type: 'dir' },
        { name: '2410-y', type: 'dir' },
      ],
    });
    await expect(run(w)).rejects.toThrow(
      /^主线（main）上没有 #241 的需求目录 specs\/241-<短名>\/，更没有 结果\.md/,
    );
    expect(closeCalls(w)).toEqual([]);
  });

  it('下面还有开着的子单：拒关，列出是哪几张', async () => {
    const w = world({
      subs: [
        { number: 300, state: 'closed' },
        { number: 302, state: 'open' },
        { number: 301, state: 'open' },
      ],
    });
    const err = await run(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefused);
    expect((err as Error).message).toMatch(/^#241 下面还有 2 张子单开着（#301、#302），没关/);
    expect(closeCalls(w)).toEqual([]);
  });

  it('是 PR、参数不对：拒关，不关', async () => {
    const pr = world({ issue: { number: 241, state: 'open', pull_request: {}, html_url: 'u' } });
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

describe('pnpm issue:close：【故意造出的失败】读不到、认不出、没关成都明确报错，不关', () => {
  const cases: [name: string, over: Partial<World>, message: RegExp][] = [
    [
      '读不到 GitHub（读仓就失败）',
      { broken: [{ match: (a) => a[1] === 'repos/{owner}/{repo}', result: fail('HTTP 502', 1) }] },
      /^gh 读仓失败（退出码 1）：HTTP 502，没关。$/,
    ],
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
      '读不到主线（列 specs/ 失败）',
      { broken: [{ match: startsWith('repos/{owner}/{repo}/contents/specs?'), result: fail('HTTP 404') }] },
      /^gh 列主线（main）上的 specs\/失败（退出码 1）：HTTP 404，没关。$/,
    ],
    [
      '读不到主线（列需求目录失败）',
      { broken: [{ match: startsWith('repos/{owner}/{repo}/contents/specs/'), result: fail('HTTP 500') }] },
      new RegExp(`^gh 列主线（main）上的 specs/${DIR}/失败`),
    ],
    [
      '读回来的不是 JSON',
      {
        broken: [
          {
            match: (a) => a[1] === 'repos/{owner}/{repo}',
            result: { code: 0, stdout: '<html>', stderr: '' },
          },
        ],
      },
      /^gh 读仓读回来的不是 JSON/,
    ],
    ['specs/ 列回来不是目录', { specs: { type: 'file' } }, /读回来的不是目录列表/],
    [
      'specs/ 下 1000 项以上：GitHub 只给前 1000 项，没列全',
      { specs: Array.from({ length: 1000 }, (_, i) => ({ name: `${i}-x`, type: 'dir' })) },
      /没列全，没关/,
    ],
    ['目录里有一项认不出', { dir: [{ name: '结果.md' }] }, /有一项认不出（没有 name、type）/],
    ['子单有一张认不出', { subs: [{ number: 5 }] }, /子单：有一张认不出/],
    [
      '单子读回来号不对',
      { issue: { number: 242, state: 'open', html_url: 'u' } },
      /要的是 #241，读回来的是 242，没关/,
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
    expect(r.stderr).toMatch(/gh 读仓失败（退出码 127）：找不到 gh 命令.*没关/);
  });
});
