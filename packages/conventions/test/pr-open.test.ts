import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { allGreen, type Gh, idlePrs, loadPathLists, type RunResult } from '../src/pr-arm.ts';
import { prOpen } from '../src/pr-open.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });
/** gh api --jq 吐的那种文件列表：一行一个 [filename, status, previous, patch]。 */
const files = (...names: (string | [string, string, string])[]) =>
  ok(
    `${names
      .map((n) => JSON.stringify(typeof n === 'string' ? [n, 'modified', null, '@@ x'] : [...n, null]))
      .join('\n')}\n`,
  );
const CREATED = ok('https://github.com/o/r/pull/42\n');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(replies: RunResult[], body = '**做了什么**：x\n') {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-open-'));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'body.md'), body);
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const r = replies.shift();
    if (!r) throw new Error(`用例没给第 ${calls.length} 次 gh 的回话：${args.join(' ')}`);
    return r;
  };
  const run = (...extra: string[]) =>
    prOpen(['--title', '加个东西', '--body-file', 'body.md', ...extra], {
      gh,
      root: ROOT,
      cwd,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { cwd, calls, out, err, run, text: () => [...out, ...err].join('\n') };
}

const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(' '));

describe('pnpm pr:open：开 PR、按路径判挂不挂自动合并', () => {
  it('没碰改标准路径：开 PR、查文件、当场挂自动合并（squash）', () => {
    const w = world([CREATED, files('packages/api/src/home.ts'), ok()]);
    expect(w.run()).toBe(0);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(w.calls[0]).toEqual([
      'pr',
      'create',
      '--title',
      '加个东西',
      '--body-file',
      join(w.cwd, 'body.md'),
    ]);
    expect(w.calls[1]?.[2]).toBe('repos/{owner}/{repo}/pulls/42/files');
    expect(w.calls[2]).toEqual(['pr', 'merge', '42', '--auto', '--squash']);
    expect(w.text()).toContain('挂上了自动合并');
    expect(w.text()).not.toContain('第二意见');
  });

  it('碰了改标准路径：不挂，说「人闸：改标准，等创始人同意」', () => {
    const w = world([CREATED, files('agents/skills/commander/SKILL.md', 'agents/x.mjs')]);
    expect(w.run()).toBe(0);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate']);
    expect(w.text()).toContain('人闸：改标准，等创始人同意');
    expect(w.text()).toContain('agents/skills/commander/SKILL.md');
  });

  it('改名从改标准目录挪出去也算碰了（判法用 standardFiles，新旧名字都看）', () => {
    const w = world([CREATED, files(['agents/old/x.ts', 'renamed', 'agents/test/rules/x.rules.test.ts'])]);
    expect(w.run()).toBe(0);
    expect(w.text()).toContain('人闸：改标准');
    expect(verbs(w.calls)).not.toContain('pr merge');
  });

  it('改标准 + --founder-approved、正文贴了原话：挂', () => {
    const w = world(
      [CREATED, files('agents/shared-rules.md'), ok()],
      '**做了什么**：x\n\n创始人原话（2026-10-05 15:00）：「可以」\n',
    );
    expect(w.run('--founder-approved')).toBe(0);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(w.text()).toContain('正文里贴了创始人原话');
  });

  it('【故意造出的失败】--founder-approved 但正文没有「原话」：退出码 1，一次 gh 都不跑', () => {
    const w = world([]);
    expect(w.run('--founder-approved')).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('原话');
  });

  it('碰先审后合路径：照样挂，另打一行要跑第二意见', () => {
    const w = world([CREATED, files('packages/api/src/auth.ts'), ok()]);
    expect(w.run()).toBe(0);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(w.text()).toContain('second-opinion.mjs --pr 42 --high-risk');
  });

  it('碰先合后审路径：照样挂，提醒合并后补审', () => {
    const w = world([CREATED, files('packages/conventions/src/ci-plan.ts'), ok()]);
    expect(w.run()).toBe(0);
    expect(w.text()).toContain('先合后审');
    expect(w.text()).not.toContain('--high-risk');
  });

  it('草稿、--no-automerge：开 PR 不挂', () => {
    const d = world([CREATED, files('a.ts')]);
    expect(d.run('--draft')).toBe(0);
    expect(d.calls[0]).toContain('--draft');
    expect(verbs(d.calls)).not.toContain('pr merge');
    expect(d.text()).toContain('草稿不挂自动合并');

    const n = world([CREATED, files('a.ts')]);
    expect(n.run('--no-automerge', '--base', 'dev')).toBe(0);
    expect(n.calls[0]?.slice(-2)).toEqual(['--base', 'dev']);
    expect(verbs(n.calls)).not.toContain('pr merge');
  });

  it('【故意造出的失败】缺 --title：退出码 1，不跑 gh', () => {
    const w = world([]);
    expect(
      prOpen(['--body-file', 'x'], { gh: () => ok(), root: ROOT, cwd: w.cwd, out: () => {}, err: () => {} }),
    ).toBe(1);
  });

  it('【故意造出的失败】gh pr create 没成：退出码 2，不往下查', () => {
    const w = world([bad('aborted: you must first push the current branch')]);
    expect(w.run()).toBe(2);
    expect(w.calls).toHaveLength(1);
    expect(w.text()).toContain('you must first push');
  });

  it('【故意造出的失败】gh pr create 的输出认不出 PR 号：退出码 2', () => {
    const w = world([ok('done\n')]);
    expect(w.run()).toBe(2);
    expect(w.calls).toHaveLength(1);
  });

  it('【故意造出的失败】没查成改了哪些文件：退出码 2，不挂（不当成「没碰改标准」）', () => {
    const w = world([CREATED, bad('HTTP 502')]);
    expect(w.run()).toBe(2);
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate']);
    expect(w.text()).toContain('没挂自动合并');
    expect(w.text()).toContain('HTTP 502');
  });

  it('【故意造出的失败】文件列表是空的、或有一行认不出：退出码 2，不挂', () => {
    const empty = world([CREATED, ok('')]);
    expect(empty.run()).toBe(2);
    expect(verbs(empty.calls)).not.toContain('pr merge');

    const junk = world([CREATED, ok('<html>\n')]);
    expect(junk.run()).toBe(2);
    expect(junk.text()).toContain('认不出');
  });

  it('【故意造出的失败】自动合并没挂成：退出码 2，写明 PR 开了、没挂成', () => {
    const w = world([CREATED, files('a.ts'), bad('auto-merge is not allowed for this repository')]);
    expect(w.run()).toBe(2);
    expect(w.text()).toContain('自动合并没挂成');
    expect(w.text()).toContain('#42');
  });

  it('【故意造出的失败】路径清单读不到：退出码 2，不开 PR', () => {
    const w = world([]);
    const empty = mkdtempSync(join(tmpdir(), 'pr-open-root-'));
    dirs.push(empty);
    const code = prOpen(['--title', 't', '--body-file', 'body.md'], {
      gh: () => ok(),
      root: empty,
      cwd: w.cwd,
      out: () => {},
      err: (l) => w.err.push(l),
    });
    expect(code).toBe(2);
    expect(w.text()).toContain('standard-paths.json');
  });
});

const LISTS = loadPathLists(ROOT);
const GREEN = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', state: 'SUCCESS' },
];
const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  isDraft: false,
  autoMergeRequest: null,
  statusCheckRollup: GREEN,
  ...over,
});

describe('idlePrs：我开的、全绿、没挂自动合并、没碰改标准的（开会话钩子兜底）', () => {
  it('只留下全绿、不是草稿、没挂、没碰改标准的', () => {
    const replies = [
      ok(
        JSON.stringify([
          pr(1),
          pr(2, { isDraft: true }),
          pr(3, { autoMergeRequest: { mergeMethod: 'SQUASH' } }),
          pr(4, { statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }] }),
          pr(5),
        ]),
      ),
      files('packages/api/src/home.ts'),
      files('agents/shared-rules.md'),
    ];
    const calls: string[][] = [];
    const got = idlePrs((a) => {
      calls.push(a);
      return replies.shift() ?? bad('多调了');
    }, LISTS);
    expect(got).toEqual([{ number: 1, title: 'PR 1' }]);
    expect(calls[0]).toEqual(expect.arrayContaining(['--author', '@me', '--state', 'open']));
    expect(calls.map((c) => c[2])).toEqual([
      '--author',
      'repos/{owner}/{repo}/pulls/1/files',
      'repos/{owner}/{repo}/pulls/5/files',
    ]);
  });

  it('【故意造出的失败】gh pr list 没跑成：抛错，不冒充「没有」', () => {
    expect(() => idlePrs(() => bad('error connecting to api.github.com'), LISTS)).toThrow(/api\.github\.com/);
  });

  it('【故意造出的失败】gh pr list 输出认不出、候选的文件没查成：都抛错', () => {
    expect(() => idlePrs(() => ok('not json'), LISTS)).toThrow(/认不出/);
    expect(() => idlePrs(() => ok('{"a":1}'), LISTS)).toThrow(/不是列表/);
    const replies = [ok(JSON.stringify([pr(7)])), bad('HTTP 404')];
    expect(() => idlePrs(() => replies.shift() ?? bad('x'), LISTS)).toThrow(/PR #7/);
  });

  it('allGreen：空的、有失败、有认不出的都不算绿', () => {
    expect(allGreen(GREEN)).toBe(true);
    expect(allGreen([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe(true);
    expect(allGreen([])).toBe(false);
    expect(allGreen(null)).toBe(false);
    expect(allGreen([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe(false);
    expect(allGreen([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe(false);
    expect(allGreen([{ __typename: 'Other' }])).toBe(false);
  });
});
