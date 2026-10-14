// 创始人引导记在仓里 docs/directives/（决定 0093）：文件的写读、时间统一 +0800、从 prompt-log 取原话、认领和办完的规矩、
// 开 PR 时分支已在就拒绝（锁）。【故意造出的失败】：取不到原话、时间认不出、主人定不下来、分支被占、git 报错都明确拒绝或报没查成。
import { describe, expect, it } from 'vitest';
import {
  claimDirective,
  DirectiveRefused,
  DirectiveUnchecked,
  directiveFromComment,
  directivePath,
  directiveRefs,
  doneContent,
  formatDirective,
  type Git,
  latestFounderPrompt,
  listPending,
  newId,
  normalizeAt,
  parseDirective,
  proposeFile,
  resolveDirective,
} from '../src/directives.ts';
import type { GhResult } from '../src/issue-new.ts';

const okR = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
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

describe('引导文件', () => {
  it('写出来再读回来一样；经过一节追加', () => {
    const d = parseDirective(formatDirective(base), PATH);
    expect(d).toEqual({ ...base, path: PATH });
    const done = parseDirective(doneContent(d, 'PR #9', new Date('2026-10-14T09:00:00Z')), PATH);
    expect(done.status).toBe('已处理');
    expect(done.log).toEqual(['2026-10-14 17:00 已处理：PR #9']);
    expect(done.text).toBe(base.text);
  });

  it('【故意造出失败】认不出的文件报没查成；已办完的再办拒绝', () => {
    expect(() => parseDirective('# 随便\n', PATH)).toThrow(DirectiveUnchecked);
    const d = parseDirective(formatDirective({ ...base, status: '已处理' }), PATH);
    expect(() => doneContent(d, undefined, new Date())).toThrow(DirectiveRefused);
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

  it('PR 正文里的「引导 <编号>」认得出', () => {
    expect(directiveRefs('做了 X\n引导 20261014163000、引导 #6164241659；引导 20261014163000')).toEqual([
      '20261014163000',
      '6164241659',
    ]);
  });

  it('#1055 评论搬进仓：编号沿用评论号，时间认不出用贴上的时刻', () => {
    const d = directiveFromComment({
      id: 6122256111,
      head: '【创始人引导·待处理】2026-10-12',
      owner: '无主',
      createdAt: '2026-10-12T10:00:00Z',
      text: 'x',
    });
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

/** 假仓：主线上几份引导文件；记下推送、开 PR 的调用 */
function repo(files: Record<string, string>, over: { pushFails?: string } = {}) {
  const calls: string[][] = [];
  const git: Git = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'ls-tree') return okR(Object.keys(files).join('\n'));
    if (cmd === 'grep') {
      const hits = Object.entries(files).filter(([, v]) => v.includes('\n- 状态：待处理\n'));
      return hits.length
        ? okR(hits.map(([k]) => `origin/main:${k}`).join('\n'))
        : { code: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'show') {
      const p = (args[1] ?? '').replace(/^origin\/main:/, '');
      return files[p] !== undefined ? okR(files[p]) : { code: 128, stdout: '', stderr: 'no such path' };
    }
    if (cmd === 'push' && over.pushFails) return { code: 1, stdout: '', stderr: over.pushFails };
    return okR('abc\n');
  };
  const ghCalls: string[][] = [];
  const gh = async (args: string[]) => {
    ghCalls.push(args);
    return okR('https://github.com/o/r/pull/9\n');
  };
  return { git, gh, calls, ghCalls };
}

describe('仓里读写', () => {
  const pending = formatDirective(base);
  const doneFile = formatDirective({ ...base, id: '2', status: '已处理' });

  it('只列待处理的，不分页、不联网', async () => {
    const r = repo({ [PATH]: pending, 'docs/directives/2026-10/2.md': doneFile });
    const got = await listPending(r.git, 'origin/main');
    expect(got.map((d) => d.id)).toEqual([base.id]);
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

  it('认领：别人的要 --force 带理由；主人和判断时看到的不一样就不认（乐观锁）；已是自己的不动', async () => {
    const r = repo({ [PATH]: pending });
    const deps = { git: r.git, gh: r.gh };
    await expect(claimDirective(base.id, 'dir-b', {}, deps)).rejects.toThrow(/已归别的会话/);
    await expect(claimDirective(base.id, 'dir-b', { force: true }, deps)).rejects.toThrow(/--why/);
    await expect(
      claimDirective(base.id, 'dir-b', { force: true, why: 'x', expectOwner: 'dir-z' }, deps),
    ).rejects.toThrow(/别的会话先认了/);
    expect(await claimDirective(base.id, 'dir-a', {}, deps)).toBeNull();
    expect(r.ghCalls).toEqual([]);
    const got = await claimDirective(
      base.id,
      'dir-b',
      { force: true, why: '闲置 20 小时', expectOwner: 'dir-a' },
      deps,
    );
    expect(got?.url).toContain('/pull/9');
  });
});
