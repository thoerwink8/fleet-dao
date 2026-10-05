import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import type { Gh, RunResult } from '../src/pr-arm.ts';
import { GATE_LINE, issueColumnRefs, prColumns } from '../src/pr-columns.ts';
import { composeBody, composeIssueBody, prOpenCli } from '../src/pr-compose.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATE = readFileSync(new URL('../../../.github/pull_request_template.md', import.meta.url), 'utf8');
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });
const files = (...names: string[]) =>
  ok(`${names.map((n) => JSON.stringify([n, 'modified', null, '@@ x'])).join('\n')}\n`);
const CREATED = ok('https://github.com/o/r/pull/42\n');
const ISSUE_7 = ok('[false,null]');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opts {
  /** git log 的回话：默认一条提交说明。 */
  log?: RunResult;
  /** 开 PR 之后各次 gh 的回话。 */
  replies?: RunResult[];
  /** 查单（gh api …/issues/<号>）的回话。 */
  lookups?: RunResult[];
  /** issue-new 那边的 gh 回话（issue create 一次）。 */
  issueReplies?: GhResult[];
}

function world(o: Opts = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-compose-'));
  dirs.push(cwd);
  const calls: string[][] = [];
  const bodies: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const gitCalls: string[][] = [];
  const issueCalls: string[][] = [];
  const issueBodies: string[] = [];
  const replies = [...(o.replies ?? [])];
  const looks = [...(o.lookups ?? [ISSUE_7])];
  const issueReplies = [...(o.issueReplies ?? [])];
  const gh: Gh = (args) => {
    if (args[0] === 'api' && args[1]?.includes('/issues/')) {
      const l = looks.shift();
      if (!l) throw new Error(`用例没给查单的回话：${args.join(' ')}`);
      return l;
    }
    calls.push(args);
    const file = args[args.indexOf('--body-file') + 1];
    if (args[1] === 'create' && file) bodies.push(readFileSync(file, 'utf8'));
    const r = replies.shift();
    if (!r) throw new Error(`用例没给第 ${calls.length} 次 gh 的回话：${args.join(' ')}`);
    return r;
  };
  const git: Gh = (args) => {
    gitCalls.push(args);
    return o.log ?? ok('加个东西\n');
  };
  const issueGh = (args: string[]): Promise<GhResult> => {
    issueCalls.push(args);
    const file = args[args.indexOf('--body-file') + 1];
    if (args[1] === 'create' && file) issueBodies.push(readFileSync(file, 'utf8'));
    const r = issueReplies.shift();
    if (!r) throw new Error(`用例没给 issue-new 那边的 gh 回话：${args.join(' ')}`);
    return Promise.resolve(r);
  };
  const run = (...args: string[]) =>
    prOpenCli(['--title', '加个东西', ...args], {
      gh,
      git,
      issueGh,
      root: ROOT,
      cwd,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return {
    cwd,
    calls,
    bodies,
    out,
    err,
    gitCalls,
    issueCalls,
    issueBodies,
    run,
    text: () => [...out, ...err].join('\n'),
  };
}

const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(' '));

describe('pnpm pr:open 自己生成正文', () => {
  it('--closes：「做了什么」取提交说明、需求栏写 Closes，开 PR 挂自动合并', async () => {
    const w = world({ replies: [CREATED, files('packages/api/src/home.ts'), ok()] });
    expect(await w.run('--closes', '7')).toBe(0);
    expect(w.gitCalls).toEqual([['log', '--no-merges', '--reverse', '--format=%s', 'origin/main..HEAD']]);
    expect(w.bodies).toEqual(['**做了什么**：加个东西\n\n**需求**：\nCloses #7\n']);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(w.text()).toContain('挂上了自动合并');
  });

  it('多条提交列成短列表；--refs 写 Refs；--base 换比较的分支；单号写 #12 也认；--closes 可重复', async () => {
    const w = world({
      log: ok('加字段\n改接口\n补测试\n'),
      replies: [CREATED, files('a.ts'), ok()],
      lookups: [ISSUE_7, ISSUE_7, ISSUE_7],
    });
    expect(await w.run('--refs', '#3', '--closes', '9', '--closes', '7', '--base', 'dev')).toBe(0);
    expect(w.gitCalls[0]?.at(-1)).toBe('origin/dev..HEAD');
    expect(w.bodies[0]).toBe(
      '**做了什么**：\n- 加字段\n- 改接口\n- 补测试\n\n**需求**：\nCloses #9\nCloses #7\nRefs #3\n',
    );
    expect(issueColumnRefs(w.bodies[0] ?? '')).toEqual({ closes: [7, 9], refs: [3] });
  });

  it('提交太多：列前 8 条，其余写「另有 N 条」', async () => {
    const subjects = Array.from({ length: 10 }, (_, i) => `改动 ${i}`);
    const w = world({ log: ok(`${subjects.join('\n')}\n`), replies: [CREATED, files('a.ts'), ok()] });
    expect(await w.run('--closes', '7')).toBe(0);
    expect(w.bodies[0]).toContain('- 改动 7\n- ……另有 2 条，见提交记录\n');
    expect(w.bodies[0]).not.toContain('改动 8');
  });

  it('--new-issue：先开单（类别、里程碑用参数给，正文四节齐全）再 Closes 它，PR 挂上那张单的里程碑', async () => {
    const w = world({
      replies: [CREATED, ok(), files('a.ts'), ok()],
      lookups: [ok('[false,"v4 统一与验收"]')],
      issueReplies: [{ code: 0, stdout: 'https://github.com/o/r/issues/55\n', stderr: '' }],
    });
    expect(
      await w.run('--new-issue', '删掉没人用的残留', '--kind', '杂项', '--milestone', '未排期', '--local'),
    ).toBe(0);
    expect(w.issueCalls).toHaveLength(1);
    const create = w.issueCalls[0] ?? [];
    expect(create.slice(0, 2)).toEqual(['issue', 'create']);
    expect(create[create.indexOf('--title') + 1]).toBe('删掉没人用的残留');
    expect(create).toEqual(expect.arrayContaining(['--label', '杂项', '本机做']));
    for (const h of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
      expect(w.issueBodies[0]).toContain(h);
    expect(w.issueBodies[0]).toContain('无（AI 发现）');
    expect(w.bodies[0]).toBe('**做了什么**：加个东西\n\n**需求**：\nCloses #55\n');
    expect(w.text()).toContain('开了单 #55');
    expect(w.calls[1]).toEqual(['pr', 'edit', '42', '--milestone', 'v4 统一与验收']);
  });

  it('改标准：--founder-quote 加 --at 生成「人闸：改标准」一行和「创始人原话」一段，并挂自动合并', async () => {
    const w = world({ replies: [CREATED, files('agents/shared-rules.md'), ok()] });
    expect(await w.run('--closes', '7', '--founder-quote', '就这么改', '--at', '2026-10-05 18:30')).toBe(0);
    expect(w.bodies[0]).toBe(
      `**做了什么**：加个东西\n\n**需求**：\nCloses #7\n${GATE_LINE}\n\n**创始人原话**：「就这么改」（2026-10-05 18:30）\n`,
    );
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(w.text()).toContain('正文里贴了创始人原话');
  });

  it('改标准 + --no-issue：理由写进需求栏，「人闸：改标准」那一行留着', async () => {
    const w = world({ replies: [CREATED, files('agents/shared-rules.md'), ok()], lookups: [] });
    expect(await w.run('--no-issue', '规矩小改', '--founder-quote', '可以', '--at', '18:30')).toBe(0);
    expect(w.bodies[0]).toBe(
      `**做了什么**：加个东西\n\n**需求**：无：规矩小改\n${GATE_LINE}\n\n**创始人原话**：「可以」（18:30）\n`,
    );
  });

  it('旧用法照旧：给了 --body-file 就原样交给 prOpen，不读 git', async () => {
    const w = world({ replies: [CREATED, files('a.ts'), ok()] });
    writeFileSync(join(w.cwd, 'body.md'), '**做了什么**：手写\n\n**需求**：\nCloses #7\n');
    expect(await w.run('--body-file', 'body.md')).toBe(0);
    expect(w.gitCalls).toEqual([]);
    expect(w.bodies).toEqual(['**做了什么**：手写\n\n**需求**：\nCloses #7\n']);
  });

  it('生成出来的栏和 PR 模板一样（两栏），需求栏读得到 Closes', () => {
    const body = composeBody({ did: ['x'], closes: [12], refs: [] });
    expect([...prColumns(body).keys()]).toEqual([...prColumns(TEMPLATE).keys()]);
    expect(issueColumnRefs(body)).toEqual({ closes: [12], refs: [] });
  });

  it('新单正文带齐 issue-new 要的四节；给了创始人原话就抄进「原话」', () => {
    const body = composeIssueBody('标题', ['改了 A'], '照这么做');
    expect(body).toContain('## 原话\n\n「照这么做」');
    expect(body).toContain('- 改了 A');
  });
});

describe('pnpm pr:open 生成正文：闸门（失败要真失败）', () => {
  it('【故意造出的失败】没单号也没理由：退出码 1，git 和 gh 一次都不跑', async () => {
    const w = world();
    expect(await w.run()).toBe(1);
    expect(w.gitCalls).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.issueCalls).toEqual([]);
    expect(w.text()).toContain('--no-issue');
    expect(w.text()).toContain('--closes');
  });

  it('【故意造出的失败】--closes 的单不存在（404）：退出码 1，不开 PR', async () => {
    const w = world({ lookups: [bad('gh: Not Found (HTTP 404)')] });
    expect(await w.run('--closes', '99')).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('#99 在本仓里不存在');
  });

  it('【故意造出的失败】--new-issue 缺类别或缺里程碑：退出码 1，单和 PR 都不开', async () => {
    for (const extra of [['--milestone', 'v4'], ['--kind', '需求'], []]) {
      const w = world();
      expect(await w.run('--new-issue', '标题', ...extra), extra.join(' ')).toBe(1);
      expect(w.issueCalls).toEqual([]);
      expect(w.calls).toEqual([]);
      expect(w.gitCalls).toEqual([]);
      expect(w.text()).toContain('缺');
    }
  });

  it('【故意造出的失败】--new-issue 的类别不对：issue-new 拒开，PR 也不开', async () => {
    const w = world();
    expect(await w.run('--new-issue', '标题', '--kind', '乱写', '--milestone', '未排期')).toBe(1);
    expect(w.issueCalls).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('没开 PR');
  });

  it('【故意造出的失败】--new-issue 开单报错：退出码 1，不开 PR', async () => {
    const w = world({ issueReplies: [{ code: 1, stdout: '', stderr: 'HTTP 502' }] });
    expect(await w.run('--new-issue', '标题', '--kind', '杂项', '--milestone', '未排期')).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('HTTP 502');
  });

  it('【故意造出的失败】--closes 单号认不出、几种需求写法混用、--kind 没配 --new-issue：退出码 1，什么也不跑', async () => {
    for (const args of [
      ['--closes', 'abc'],
      ['--closes', '7', '--no-issue', '随便'],
      ['--closes', '7', '--new-issue', '标题', '--kind', '杂项', '--milestone', '未排期'],
      ['--closes', '7', '--kind', '需求'],
    ]) {
      const w = world();
      expect(await w.run(...args), args.join(' ')).toBe(1);
      expect(w.calls, args.join(' ')).toEqual([]);
      expect(w.issueCalls, args.join(' ')).toEqual([]);
    }
  });

  it('【故意造出的失败】--founder-quote 缺 --at（或反过来、或是空的）：退出码 1', async () => {
    for (const args of [
      ['--founder-quote', '可以'],
      ['--at', '18:30'],
      ['--founder-quote', ' ', '--at', '18:30'],
    ]) {
      const w = world();
      expect(await w.run('--closes', '7', ...args), args.join(' ')).toBe(1);
      expect(w.calls).toEqual([]);
      expect(w.text()).toContain('--at');
    }
  });

  it('【故意造出的失败】生成用的参数和 --body-file 混用：退出码 1，不跑 gh', async () => {
    const w = world();
    writeFileSync(join(w.cwd, 'body.md'), '**需求**：\nCloses #7\n');
    expect(await w.run('--body-file', 'body.md', '--closes', '7')).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('不能和 --body-file 一起用');
  });

  it('【故意造出的失败】git log 没跑成、或分支上没有提交：退出码 2，没开 PR，不拿空说明冒充', async () => {
    const failed = world({ log: bad("fatal: bad revision 'origin/main..HEAD'", 128) });
    expect(await failed.run('--closes', '7')).toBe(2);
    expect(failed.calls).toEqual([]);
    expect(failed.text()).toContain('bad revision');

    const empty = world({ log: ok('\n') });
    expect(await empty.run('--closes', '7')).toBe(2);
    expect(empty.calls).toEqual([]);
    expect(empty.text()).toContain('没有提交');
  });

  it('【故意造出的失败】缺 --title：退出码 1', async () => {
    const w = world();
    const code = await prOpenCli(['--closes', '7'], {
      gh: () => ok(),
      git: () => ok('x\n'),
      issueGh: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      root: ROOT,
      cwd: w.cwd,
      out: () => {},
      err: (l) => w.err.push(l),
    });
    expect(code).toBe(1);
    expect(w.text()).toContain('--title');
  });
});
