// 创始人引导记在仓里 docs/directives/（决定 0093）：文件的写读、时间统一 +0800、从 prompt-log 取原话、办没办完看挂的单（#2727）、
// 开 PR 时分支已在就拒绝（锁）。【故意造出的失败】：取不到原话、时间认不出、主人定不下来、分支被占、git 报错、gh 读不到单都明确拒绝或报没查成。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIssueOpen,
  DirectiveRefused,
  DirectiveUnchecked,
  directiveFromComment,
  directivePath,
  formatDirective,
  type Git,
  latestFounderPrompt,
  listPending,
  mergeLogs,
  newId,
  normalizeAt,
  parseDirective,
  proposeFile,
  recordDirective,
  resolveDirective,
} from '../src/directives.ts';
import { gitRunner } from '../src/git-runner.ts';
import type { Gh, GhResult } from '../src/issue-new.ts';
import { runChild } from './child.ts';

const okR = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
/** 旧文件：有状态行 */
const base = {
  id: '20261014163000',
  status: '待处理' as const,
  at: '2026-10-14 16:30 +0800',
  owner: 'dir-a',
  source: 'prompt-log',
  text: '我都同意。\n## 不是标题',
  log: [] as string[],
};
const PATH = 'docs/directives/2026-10/20261014163000.md';
/** 新文件：没有状态行，挂了单 #2727 */
const { status: _legacyStatus, ...noStatus } = base;
const linked = { ...noStatus, id: '20261015100000', issue: 2727 };
const LINKED_PATH = 'docs/directives/2026-10/20261015100000.md';

describe('引导文件', () => {
  it('新文件：没有状态行和经过，有「单：#N」，写出来再读回来一样', () => {
    const text = formatDirective(linked);
    expect(text).toContain('- 单：#2727');
    expect(text).not.toContain('状态');
    expect(text).not.toContain('经过');
    expect(parseDirective(text, LINKED_PATH)).toEqual({ ...linked, path: LINKED_PATH });
  });

  it('旧文件的「状态」「经过」行照读、不报错（待处理、已处理、作废都认）', () => {
    const log = ['2026-10-14 17:00 已处理：PR #9'];
    const d = parseDirective(formatDirective({ ...base, log }), PATH);
    expect(d).toEqual({ ...base, log, path: PATH });
    expect(d.issue).toBeUndefined();
    for (const status of ['已处理', '作废'] as const)
      expect(parseDirective(formatDirective({ ...base, status }), PATH).status).toBe(status);
  });

  it('原话里写了「- 单：#5」不会被当成字段', () => {
    const text = '前\n- 单：#5\n后';
    const d = parseDirective(formatDirective({ ...noStatus, issue: 9, text }), PATH);
    expect(d.issue).toBe(9);
    expect(d.text).toBe(text);
  });

  it('【故意造出失败】认不出的文件报没查成；单号写坏、状态也没有的不当成引导', () => {
    expect(() => parseDirective('# 随便\n', PATH)).toThrow(DirectiveUnchecked);
    expect(() => parseDirective(formatDirective(linked).replace('#2727', '二七二七'), PATH)).toThrow(
      DirectiveUnchecked,
    );
    expect(() => parseDirective(formatDirective(noStatus), PATH)).toThrow(DirectiveUnchecked);
  });

  it('时间一律换成北京 +0800；只有日期、认不出的拒绝', () => {
    expect(normalizeAt('2026-10-14 16:30').text).toBe('2026-10-14 16:30 +0800');
    expect(normalizeAt('2026-10-14 08:30 +0000').text).toBe('2026-10-14 16:30 +0800');
    expect(normalizeAt('2026-10-14T08:30:12.5Z').text).toBe('2026-10-14 16:30 +0800');
    expect(() => normalizeAt('2026-10-14')).toThrow(DirectiveRefused);
    expect(() => normalizeAt('昨天下午')).toThrow(DirectiveRefused);
  });

  it('编号是北京时间到秒，撞了往后挪；路径按月', () => {
    const t = new Date('2026-10-14T08:30:00Z');
    expect(newId(t)).toBe('20261014163000');
    expect(newId(t, new Set(['20261014163000']))).toBe('20261014163001');
    expect(directivePath('1', t)).toBe('docs/directives/2026-10/1.md');
  });

  it('#1055 评论搬进仓：编号沿用评论号，挂单，时间认不出用贴上的时刻', () => {
    const d = directiveFromComment(
      {
        id: 6122256111,
        head: '【创始人引导·待处理】2026-10-12',
        owner: '无主',
        createdAt: '2026-10-12T10:00:00Z',
        text: 'x',
      },
      2727,
    );
    expect(d.issue).toBe(2727);
    expect(d.status).toBeUndefined();
    expect(d.at).toBe('2026-10-12 18:00 +0800');
    expect(d.path).toBe('docs/directives/2026-10/6122256111.md');
    expect(d.source).toBe('#1055 评论 6122256111');
  });
});

describe('从 prompt-log 取原话', () => {
  const line = { status: 'found' as const, dir: 'dir-a', sessionIds: ['s1', 's2'] };
  const log = {
    entries: [
      { at: new Date('2026-10-14T08:00:00Z'), sessionId: 's1', prompt: '早一句' },
      { at: new Date('2026-10-14T08:30:00Z'), sessionId: 's2', prompt: '我都同意。' },
      { at: new Date('2026-10-14T08:40:00Z'), sessionId: 'other', prompt: '别的会话的话' },
      {
        at: new Date('2026-10-14T08:50:00Z'),
        sessionId: 's2',
        prompt: '<task-notification>完成</task-notification>',
      },
    ],
  };

  it('不给原话：取本血缘他最近一句、准确时间、主人', () => {
    expect(latestFounderPrompt(log.entries, ['s1', 's2'])?.prompt).toBe('我都同意。');
    expect(resolveDirective({}, line, log, 's2')).toMatchObject({
      text: '我都同意。',
      at: '2026-10-14 16:30 +0800',
      owner: 'dir-a',
      source: 'prompt-log',
    });
  });

  it('给了原话没给时间：和 prompt-log 那句一字不差才借时间', () => {
    expect(resolveDirective({ text: '我都同意。' }, line, log, 's2').at).toBe('2026-10-14 16:30 +0800');
    expect(() => resolveDirective({ text: '别的话' }, line, log, 's2')).toThrow(/缺 --at/);
    expect(resolveDirective({ text: '别的话', at: '2026-10-14 16:31' }, line, log, 's2').source).toBe('手填');
  });

  it('【故意造出失败】prompt-log 读不到、本会话没说过、主人认不出：拒绝并说怎么手填，不留空', () => {
    expect(() => resolveDirective({}, line, { why: '目录不存在' }, 's2')).toThrow(/目录不存在[\s\S]*手填/);
    expect(() => resolveDirective({}, { ...line, sessionIds: ['zz'] }, log, 'zz')).toThrow(DirectiveRefused);
    const none = { status: 'none' as const, why: '不是 Mirasim 起的' };
    expect(() => resolveDirective({ text: 'x', at: '2026-10-14 16:30' }, none, log, null)).toThrow(/--owner/);
    expect(
      resolveDirective({ text: 'x', at: '2026-10-14 16:30', owner: '无主' }, none, log, null).owner,
    ).toBe('无主');
  });
});

/** 假仓：主线上几份引导文件；记下推送、开 PR 的调用；gh 还答「开着的单」「单的状态」 */
function repo(
  files: Record<string, string>,
  over: { pushFails?: string; openIssues?: number[]; ghFails?: string } = {},
) {
  const calls: string[][] = [];
  const git: Git = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'ls-tree') return okR(Object.keys(files).join('\n'));
    if (cmd === 'grep') {
      const pattern = args[args.indexOf('-e') + 1] ?? '';
      const hits: string[] = [];
      for (const [k, v] of Object.entries(files))
        v.split('\n').forEach((line, i) => {
          if (new RegExp(pattern).test(line)) hits.push(`origin/main:${k}:${i + 1}:${line}`);
        });
      return hits.length ? okR(hits.join('\n')) : { code: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'show') {
      const p = (args[1] ?? '').replace(/^origin\/main:/, '');
      return files[p] !== undefined ? okR(files[p]) : { code: 128, stdout: '', stderr: 'no such path' };
    }
    if (cmd === 'push' && over.pushFails) return { code: 1, stdout: '', stderr: over.pushFails };
    return okR('abc\n');
  };
  const ghCalls: string[][] = [];
  const gh: Gh = async (args) => {
    ghCalls.push(args);
    if (args[0] === 'issue') {
      if (over.ghFails) return { code: 1, stdout: '', stderr: over.ghFails };
      const open = over.openIssues ?? [];
      if (args[1] === 'list') return okR(JSON.stringify(open.map((number) => ({ number }))));
      if (args[1] === 'view') return okR(open.includes(Number(args[2])) ? 'OPEN\n' : 'CLOSED\n');
    }
    return okR('https://github.com/o/r/pull/9\n');
  };
  return { git, gh, calls, ghCalls };
}

describe('仓里读写', () => {
  const legacyPending = formatDirective(base);
  const legacyDone = formatDirective({ ...base, id: '2', status: '已处理' });
  const linkedFile = formatDirective(linked);
  const closedFile = formatDirective({ ...linked, id: '3', issue: 9 });

  it('办没办完看挂的单：单开着的列，关了的不列；旧文件按状态行', async () => {
    const r = repo(
      {
        [PATH]: legacyPending,
        'docs/directives/2026-10/2.md': legacyDone,
        [LINKED_PATH]: linkedFile,
        'docs/directives/2026-10/3.md': closedFile,
      },
      { openIssues: [2727] },
    );
    const got = await listPending(r.git, r.gh, 'origin/main');
    expect(got.map((d) => d.id).sort()).toEqual([base.id, linked.id].sort());
    expect(got.find((d) => d.id === linked.id)?.issue).toBe(2727);
  });

  it('挂的单关了就算办完；单重新开了又是没办完', async () => {
    const files = { [LINKED_PATH]: linkedFile };
    const closed = repo(files, { openIssues: [] });
    expect(await listPending(closed.git, closed.gh, 'origin/main')).toEqual([]);
    const reopened = repo(files, { openIssues: [2727] });
    expect((await listPending(reopened.git, reopened.gh, 'origin/main')).map((d) => d.id)).toEqual([
      linked.id,
    ]);
  });

  it('没有挂单的文件就不联网（旧文件的老路）', async () => {
    const r = repo({ [PATH]: legacyPending });
    await listPending(r.git, r.gh, 'origin/main');
    expect(r.ghCalls).toEqual([]);
  });

  it('文件里状态写了待处理、却又挂了单：以单为准', async () => {
    const both = formatDirective({ ...base, id: '5', issue: 2727 });
    const r = repo({ 'docs/directives/2026-10/5.md': both }, { openIssues: [] });
    expect(await listPending(r.git, r.gh, 'origin/main')).toEqual([]);
  });

  it('【故意造出失败】gh 读不到开着的单：报没查成，不当成都办完了', async () => {
    const r = repo({ [LINKED_PATH]: linkedFile }, { ghFails: 'HTTP 502' });
    await expect(listPending(r.git, r.gh, 'origin/main')).rejects.toThrow(/gh 读开着的单报错.*502/);
  });

  it('【故意造出失败】读回来的不是列表、开着的单满了一页：报没查成', async () => {
    const r = repo({ [LINKED_PATH]: linkedFile });
    await expect(listPending(r.git, async () => okR('{}'), 'origin/main')).rejects.toThrow(
      DirectiveUnchecked,
    );
    const full = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 })));
    await expect(listPending(r.git, async () => okR(full), 'origin/main')).rejects.toThrow(/没读全/);
  });

  it('开 PR：推到 directive/<编号>（分支已在就推不上）、开 PR、挂自动合并', async () => {
    const r = repo({});
    const url = await proposeFile(
      { git: r.git, gh: r.gh },
      { id: '7', path: 'docs/directives/2026-10/7.md', content: 'x', title: 't', did: 'd' },
    );
    expect(url).toBe('https://github.com/o/r/pull/9');
    const push = r.calls.find((a) => a[0] === 'push');
    expect(push).toContain('--force-with-lease=refs/heads/directive/7:');
    expect(r.ghCalls.map((a) => a.slice(0, 2).join(' '))).toEqual(['pr create', 'pr merge']);
  });

  it('【故意造出失败】分支被别的会话占着：拒绝，不开 PR', async () => {
    const r = repo({}, { pushFails: '! [rejected] (stale info)' });
    await expect(
      proposeFile({ git: r.git, gh: r.gh }, { id: '7', path: 'p', content: 'x', title: 't', did: 'd' }),
    ).rejects.toThrow(/别的会话正在改/);
    expect(r.ghCalls).toEqual([]);
  });
});

describe('记：要挂单', () => {
  const rec = {
    text: '以后都这样办',
    at: '2026-10-16 16:29 +0800',
    atDate: new Date('2026-10-16T08:29:00Z'),
    owner: 'dir-a',
    source: 'prompt-log',
  };
  it('给了 --issue：查它开着，不开新单', async () => {
    const r = repo({}, { openIssues: [2727] });
    let opened = 0;
    const made = await recordDirective(
      rec,
      {
        git: r.git,
        gh: r.gh,
        newIssue: async () => {
          opened += 1;
          return 1;
        },
      },
      2727,
    );
    expect(opened).toBe(0);
    expect(made).toMatchObject({ issue: 2727, id: '20261016162900' });
    expect(r.ghCalls.some((a) => a.slice(0, 3).join(' ') === 'issue view 2727')).toBe(true);
  });

  it('文件里写「单：#N」、没有状态行', async () => {
    const r = repo({}, { openIssues: [2727] });
    const seen: string[] = [];
    const git: Git = async (args, opts) => {
      if (args[0] === 'hash-object' && opts?.input !== undefined) seen.push(opts.input);
      return r.git(args, opts);
    };
    await recordDirective(rec, { git, gh: r.gh }, 2727);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('- 单：#2727');
    expect(seen[0]).not.toContain('状态');
  });

  it('没给 --issue：顺手开一张单（标题取原话前几个字，正文带原话和四节），单号写进文件', async () => {
    const r = repo({});
    const drafts: Array<{ title: string; body: string }> = [];
    const seen: string[] = [];
    const git: Git = async (args, opts) => {
      if (args[0] === 'hash-object' && opts?.input !== undefined) seen.push(opts.input);
      return r.git(args, opts);
    };
    const made = await recordDirective(rec, {
      git,
      gh: r.gh,
      newIssue: async (d) => {
        drafts.push(d);
        return 4242;
      },
    });
    expect(made.issue).toBe(4242);
    expect(seen[0]).toContain('- 单：#4242');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe('创始人引导：以后都这样办');
    expect(drafts[0]?.body).toContain('以后都这样办');
    for (const h of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
      expect(drafts[0]?.body).toContain(h);
  });

  it('【故意造出失败】挂的单已关、gh 读不到、没法开单：都不记（没推分支）', async () => {
    const closed = repo({}, { openIssues: [] });
    await expect(recordDirective(rec, { git: closed.git, gh: closed.gh }, 2727)).rejects.toThrow(
      DirectiveRefused,
    );
    const down = repo({}, { ghFails: 'HTTP 502' });
    await expect(recordDirective(rec, { git: down.git, gh: down.gh }, 2727)).rejects.toThrow(
      DirectiveUnchecked,
    );
    const none = repo({});
    await expect(recordDirective(rec, { git: none.git, gh: none.gh })).rejects.toThrow(/没法开单/);
    for (const r of [closed, down, none]) expect(r.calls.find((a) => a[0] === 'push')).toBeUndefined();
  });

  it('checkIssueOpen：开着的过，关了的拒绝', async () => {
    const r = repo({}, { openIssues: [1] });
    await checkIssueOpen(r.gh, 1);
    await expect(checkIssueOpen(r.gh, 2)).rejects.toThrow(/不是开着的/);
  });
});

describe('两份账合起来取原话', () => {
  it('会话开在仓外、prompt-log 没有：用 Mirasim 会话记录里他最近一句，来源照实写', () => {
    const line = { status: 'found' as const, dir: 'd', sessionIds: ['s'] };
    const m = [
      {
        at: new Date('2026-10-14T16:39:00Z'),
        sessionId: 's',
        prompt: '工人名额自主调整',
        source: 'Mirasim 会话记录',
      },
    ];
    const r = resolveDirective({}, line, mergeLogs({ why: '没有今天的记录' }, m), 's');
    expect(r).toMatchObject({
      text: '工人名额自主调整',
      at: '2026-10-15 00:39 +0800',
      source: 'Mirasim 会话记录',
    });
    expect(mergeLogs({ why: 'x' }, [])).toEqual({ why: 'x' });
  });
});

describe('真 git 在临时仓里读待处理（#2726：没匹配时 git 退出码 1、stderr 空）', () => {
  /** 没挂单的路径不该联网：碰了就报错 */
  const noGh: Gh = async () => {
    throw new Error('不该调 gh');
  };
  const openGh =
    (open: number[]): Gh =>
    async () =>
      okR(JSON.stringify(open.map((number) => ({ number }))));
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** 临时仓，files 提交后把 origin/main 指到这个提交 */
  function realRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'directives-real-'));
    dirs.push(dir);
    const g = (...a: string[]) =>
      runChild('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    g('init', '-q');
    writeFileSync(join(dir, 'x.txt'), 'x');
    for (const [p, v] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), v);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'c');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return dir;
  }

  it('没有待处理的：返回 []，不报错（目录里只有已处理的旧文件）', async () => {
    const dir = realRepo({
      'docs/directives/2026-10/2.md': formatDirective({ ...base, id: '2', status: '已处理' }),
    });
    expect(await listPending(gitRunner(dir), noGh, 'origin/main')).toEqual([]);
  });

  it('没有待处理的：docs/directives 目录都还没有也是 []', async () => {
    expect(await listPending(gitRunner(realRepo({})), noGh, 'origin/main')).toEqual([]);
  });

  it('有待处理的旧文件照列', async () => {
    const dir = realRepo({ [PATH]: formatDirective(base) });
    expect((await listPending(gitRunner(dir), noGh, 'origin/main')).map((d) => d.id)).toEqual([base.id]);
  });

  it('挂了单的新文件：单开着列、关了不列（git 真跑 grep 找「单」行）', async () => {
    const dir = realRepo({
      [LINKED_PATH]: formatDirective(linked),
      [PATH]: formatDirective({ ...base, status: '已处理' }),
    });
    const open = await listPending(gitRunner(dir), openGh([2727]), 'origin/main');
    expect(open.map((d) => d.id)).toEqual([linked.id]);
    expect(await listPending(gitRunner(dir), openGh([]), 'origin/main')).toEqual([]);
  });

  it('【故意造出失败】挂了单、gh 读不到：报没查成', async () => {
    const dir = realRepo({ [LINKED_PATH]: formatDirective(linked) });
    const down: Gh = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
    await expect(listPending(gitRunner(dir), down, 'origin/main')).rejects.toThrow(DirectiveUnchecked);
  });

  it('【故意造出失败】git 真报错（引用不存在）仍报没查成，不当成空', async () => {
    const dir = realRepo({});
    await expect(listPending(gitRunner(dir), noGh, 'origin/nope')).rejects.toThrow(DirectiveUnchecked);
  });

  it('【故意造出失败】git 起不来（目录不存在）：stderr 带原因，退出码非 0', async () => {
    const r = await gitRunner(join(tmpdir(), 'no-such-dir-2726'))(['status']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toBe('');
  });
});
