import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** 默认正文的需求栏挂了 #7（#1052：不挂单不开 PR）；查单那次 gh 回「不是 PR、没挂里程碑」。 */
const BODY = '**做了什么**：x\n\n**需求**：\nCloses #7\n';
const ISSUE_7 = ok('[false,null]');

/**
 * replies 是开 PR 之后各次 gh 的回话；查单（gh api …/issues/<号>）的回话在 lookups 里，默认一次 ISSUE_7，
 * 查单的调用记在 lookups（不进 calls），免得每个用例都带上它。bodies 是每次 gh pr create 那一刻 --body-file 里的字。
 */
function world(replies: RunResult[], body = BODY, lookups: RunResult[] = [ISSUE_7]) {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-open-'));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'body.md'), body);
  const calls: string[][] = [];
  const asked: string[][] = [];
  const bodies: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const looks = [...lookups];
  const gh: Gh = (args) => {
    if (args[0] === 'api' && args[1]?.includes('/issues/')) {
      asked.push(args);
      const l = looks.shift();
      if (!l) throw new Error(`用例没给第 ${asked.length} 次查单的回话：${args.join(' ')}`);
      return l;
    }
    calls.push(args);
    const file = args[args.indexOf('--body-file') + 1];
    if (args[1] === 'create' && file) bodies.push(readFileSync(file, 'utf8'));
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
  return { cwd, calls, asked, bodies, out, err, run, text: () => [...out, ...err].join('\n') };
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
      `${BODY}\n创始人原话（2026-10-05 15:00）：「可以」\n`,
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

describe('pnpm pr:open：需求栏必挂单（#1052）、顺手挂里程碑', () => {
  it('【故意造出的失败】需求栏读不到 Closes/Refs、也没带 --no-issue：退出码 1，一次 gh 都不跑（查单也不查）', () => {
    for (const body of [
      '**做了什么**：x\n',
      '**做了什么**：x\n\n**需求**：无\n',
      '**做了什么**：x\n\n**需求**：#7\n', // 只写号不算：不会关单，也认不出是关还是只挂
      '**做了什么**：x\n\n**需求**：<!-- Closes #7 -->\n', // 模板提示、注释里的不算
      '**做了什么**：x\n\n**需求**：Closes other/repo#7\n', // 别的仓的不算
      '**做了什么**：x\n\nCloses #7\n', // 写在需求栏外面不算
    ]) {
      const w = world([], body);
      expect(w.run(), body).toBe(1);
      expect(w.calls, body).toEqual([]);
      expect(w.asked, body).toEqual([]);
      expect(w.text(), body).toContain('--no-issue');
      expect(w.text(), body).toContain('Closes #号');
    }
  });

  it('【故意造出的失败】需求栏写的单不存在（404）：退出码 1，不开 PR', () => {
    const w = world([], BODY, [bad('gh: Not Found (HTTP 404)')]);
    expect(w.run()).toBe(1);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]?.[1]).toBe('repos/{owner}/{repo}/issues/7');
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('#7 在本仓里不存在');
  });

  it('【故意造出的失败】需求栏写的号是个 PR、不是单：退出码 1，不开 PR', () => {
    const w = world([], BODY, [ok('[true,null]')]);
    expect(w.run()).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('是个 PR');
  });

  it('【故意造出的失败】查单没查成（网络）或回的认不出：退出码 2，不开 PR，不当成「不存在」', () => {
    const net = world([], BODY, [bad('error connecting to api.github.com')]);
    expect(net.run()).toBe(2);
    expect(net.calls).toEqual([]);
    expect(net.text()).toContain('没查成 #7');
    expect(net.text()).toContain('api.github.com');

    const junk = world([], BODY, [ok('<html>')]);
    expect(junk.run()).toBe(2);
    expect(junk.calls).toEqual([]);
    expect(junk.text()).toContain('认不出');
  });

  it('只写 Refs（母单分片）也认；Closes 的排前面，里程碑跟着它走', () => {
    const w = world([CREATED, ok(), files('a.ts'), ok()], '**需求**：Refs #3\nCloses #9\n', [
      ok('[false,"v4 统一与验收"]'),
      ok('[false,"v3"]'),
    ]);
    expect(w.run()).toBe(0);
    expect(w.asked.map((a) => a[1])).toEqual([
      'repos/{owner}/{repo}/issues/9',
      'repos/{owner}/{repo}/issues/3',
    ]);
    expect(w.calls[1]).toEqual(['pr', 'edit', '42', '--milestone', 'v4 统一与验收']);

    const only = world([CREATED, files('a.ts'), ok()], '**需求**：Refs #1016\n');
    expect(only.run()).toBe(0);
    expect(only.asked[0]?.[1]).toBe('repos/{owner}/{repo}/issues/1016');
  });

  it('单挂了里程碑：PR 开出来就挂上同一个（在查文件、挂自动合并之前）；没挂的不挂、打一行说', () => {
    const w = world([CREATED, ok(), files('a.ts'), ok()], BODY, [ok('[false,"v4 统一与验收"]')]);
    expect(w.run()).toBe(0);
    expect(verbs(w.calls)).toEqual(['pr create', 'pr edit', 'api --paginate', 'pr merge']);
    expect(w.calls[1]).toEqual(['pr', 'edit', '42', '--milestone', 'v4 统一与验收']);
    expect(w.text()).toContain('PR 挂上了里程碑「v4 统一与验收」');

    const none = world([CREATED, files('a.ts'), ok()]);
    expect(none.run()).toBe(0);
    expect(verbs(none.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
    expect(none.text()).toContain('#7 没挂里程碑，PR 也就没挂');
  });

  it('【故意造出的失败】挂里程碑没成：打一行说没挂成，不算失败（照样挂自动合并、退出码 0）', () => {
    const w = world([CREATED, bad('milestone not found'), files('a.ts'), ok()], BODY, [
      ok('[false,"v4 统一与验收"]'),
    ]);
    expect(w.run()).toBe(0);
    expect(w.text()).toContain('没挂上里程碑「v4 统一与验收」');
    expect(w.text()).toContain('milestone not found');
    expect(verbs(w.calls)).toContain('pr merge');
  });

  it('--no-issue "<理由>"：不查单，理由原样写进需求栏（换掉模板提示、别的栏不动），临时正文用完就删', () => {
    const w = world(
      [CREATED, files('a.ts'), ok()],
      '**做了什么**：x\n\n**还欠什么**：无\n\n**需求**：<!-- 单号 -->\n',
      [],
    );
    expect(w.run('--no-issue', '改个错别字，没有对应的单')).toBe(0);
    expect(w.asked).toEqual([]);
    expect(w.bodies).toEqual([
      '**做了什么**：x\n\n**还欠什么**：无\n\n**需求**：无：改个错别字，没有对应的单\n',
    ]);
    const sent = w.calls[0]?.[w.calls[0].indexOf('--body-file') + 1] ?? '';
    expect(sent).not.toBe(join(w.cwd, 'body.md'));
    expect(() => readFileSync(sent)).toThrow(); // 用完删了
    expect(readFileSync(join(w.cwd, 'body.md'), 'utf8')).toContain('<!-- 单号 -->'); // 原文件不动
    expect(verbs(w.calls)).toEqual(['pr create', 'api --paginate', 'pr merge']);
  });

  it('【故意造出的失败】--no-issue 理由是空的：退出码 1，不跑 gh', () => {
    for (const reason of ['', '   ']) {
      const w = world([], '**需求**：无\n');
      expect(w.run('--no-issue', reason), JSON.stringify(reason)).toBe(1);
      expect(w.calls).toEqual([]);
      expect(w.text()).toContain('为什么不挂单');
    }
  });

  it('【故意造出的失败】--no-issue 但需求栏已经挂了单：退出码 1，两样说法打架不猜', () => {
    const w = world([]);
    expect(w.run('--no-issue', '随便')).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.text()).toContain('#7');
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
