// commander 技能带的脚本里，单上的「在做」认领（doing.mjs）。脚本是 .mjs（装进各家技能目录后直接 node 跑，不靠类型剥离），
// 库按网址动态加载（helpers/doing.ts），在临时家目录里跑，不碰真家目录、不出网（gh 换成内存里的假 GitHub）。
// 本机进度页（p.mjs、progress-lib.mjs）和帅位栏写入（board-cli.mjs）#530 删了；法国引擎页和它的页面服务测在 france.test.ts。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DoingIo, doing, fakeGitHub, NOW, runDoing } from './helpers/doing.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commander-'));
  made.push(dir);
  return dir;
}

async function run(
  gh: DoingIo['gh'],
  argv: string[],
  env: Record<string, string | undefined> = { FLEET_MACHINE: '本机' },
  home = tempHome(),
) {
  return runDoing(gh, argv, env, home);
}

describe('「在做」评论的格式', () => {
  it('写出来的认得回来；别的评论不算；机器名只许一段', () => {
    const body = doing.renderClaim('doing', '法国', '写认领\n脚本');
    expect(body.split('\n')[0]).toBe('<!-- fleet:doing machine=法国 -->');
    expect(doing.parseClaim({ id: 1, body })).toMatchObject({
      id: 1,
      state: 'doing',
      machine: '法国',
      text: '写认领 脚本',
    });
    expect(
      doing.parseClaim({ id: 2, body: doing.renderClaim('done', '本机', '合了').replaceAll('\n', '\r\n') }),
    ).toMatchObject({
      state: 'done',
      text: '合了',
    });
    expect(doing.parseClaim({ id: 3, body: '**本机 在做**：手打的，没有标记' })).toBeNull();
    for (const bad of ['', '有 空格', 'a>b', 'x'.repeat(33)])
      expect(doing.machineProblem(bad), bad).not.toBeNull();
    expect(doing.machineProblem('笔记本-2')).toBeNull();
  });
});

describe('doing.mjs claim：动一张单之前先认领', () => {
  it('没人在做：留一条、读回、认领成功', async () => {
    const gh = fakeGitHub();
    gh.add(12, '随便一条评论');
    const r = await run(gh.gh, ['claim', '#12', '写', '认领脚本']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('认领了 #12');
    expect(gh.claims(12)).toMatchObject([{ state: 'doing', machine: '本机', text: '写 认领脚本' }]);
    expect(gh.methods()).toEqual(['GET', 'POST', 'GET']);
  });

  it('别的机器做完了、放下了的不挡', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('done', '法国', '合了'));
    gh.add(12, doing.renderClaim('dropped', '笔记本', '不做了'));
    expect((await run(gh.gh, ['claim', '12'])).code).toBe(0);
  });

  it('撞车：法国比我晚留（编号比我大）——我留着；法国那条是晚的，报进度被拒，再认领时删掉自己那条', async () => {
    const gh = fakeGitHub();
    gh.hooks.afterPost = () => {
      gh.hooks.afterPost = undefined;
      gh.add(12, doing.renderClaim('doing', '法国', '晚到'));
    };
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(0);
    expect(gh.claims(12).map((c) => c.machine)).toEqual(['本机', '法国']);
    const france = await run(gh.gh, ['say', '12', '继续'], { FLEET_MACHINE: '法国' });
    expect(france.code).toBe(3);
    expect(france.out).toContain('本机 先认领的');
    const franceClaim = await run(gh.gh, ['claim', '12'], { FLEET_MACHINE: '法国' });
    expect(franceClaim.code).toBe(3);
    expect(franceClaim.out).toContain('已经删了');
    expect(gh.claims(12).map((c) => c.machine)).toEqual(['本机']);
    expect((await run(gh.gh, ['say', '12', '本机接着做'])).code).toBe(0);
  });

  it('这台机器本来就在做：接着用那条，不重复留', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('doing', '本机', '旧的一句'));
    const r = await run(gh.gh, ['claim', '12', '新的一句']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('本来就是 本机 在做');
    expect(gh.claims(12)).toMatchObject([{ machine: '本机', text: '新的一句' }]);
    expect(gh.methods()).toEqual(['GET', 'PATCH']);
  });

  it('查不成就是查不成：先读失败退出码 2、不留评论；读回失败撤回自己那条、退出码 2', async () => {
    const first = fakeGitHub();
    first.hooks.failListAt = 0;
    const r1 = await run(first.gh, ['claim', '12']);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain('别当成没人在做');
    expect(first.comments).toEqual([]);

    const readBack = fakeGitHub();
    readBack.hooks.failListAt = 1;
    const r2 = await run(readBack.gh, ['claim', '12']);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain('读回没查成');
    expect(readBack.comments).toEqual([]);
  });

  it('留言后 gh 回的内容认不出：退出码 2，叫人去单上看', async () => {
    const gh = fakeGitHub();
    gh.hooks.postReply = '不是 JSON';
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('去单上看一眼');
  });

  it('不知道这台机器叫什么：退出码 2，不猜；machine 命令记下来之后就认得', async () => {
    const gh = fakeGitHub();
    const home = tempHome();
    const r = await run(gh.gh, ['claim', '12'], {}, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain('doing.mjs machine');
    expect(gh.calls).toEqual([]);
    expect((await run(gh.gh, ['machine', '有 空格'], {}, home)).code).toBe(1);
    expect((await run(gh.gh, ['machine', '笔记本'], {}, home)).code).toBe(0);
    expect(readFileSync(join(home, '.fleet-dao', 'machine-name'), 'utf8').trim()).toBe('笔记本');
    expect((await run(gh.gh, ['claim', '12'], {}, home)).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ machine: '笔记本' }]);
  });

  it('用法不对退出码 1', async () => {
    const gh = fakeGitHub();
    for (const argv of [
      ['claim'],
      ['claim', 'abc'],
      ['say', '12'],
      ['fly', '12'],
      ['show'],
      ['say', '12', 'x', '--takeover', 'y'],
      ['claim', '12', '--repo', 'no'],
    ]) {
      expect((await run(gh.gh, argv)).code, argv.join(' ')).toBe(1);
    }
    expect(gh.calls).toEqual([]);
  });

  it('--repo 指定仓；不给就用 gh 从当前目录认的仓', async () => {
    const gh = fakeGitHub();
    await run(gh.gh, ['show', '12', '--repo', 'owner/name']);
    await run(gh.gh, ['show', '12']);
    expect(gh.calls.map((a) => a[2])).toEqual([
      'repos/owner/name/issues/12/comments',
      'repos/{owner}/{repo}/issues/12/comments',
    ]);
  });
});

describe('doing.mjs say、done、drop、show', () => {
  it('改自己那条：say 换一句，done、drop 改状态；没认领的先 claim', async () => {
    const gh = fakeGitHub();
    expect((await run(gh.gh, ['say', '12', '先说一句'])).code).toBe(2);
    await run(gh.gh, ['claim', '12', '开工']);
    expect((await run(gh.gh, ['say', '12', 'PR', '#5', '开了'])).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ state: 'doing', text: 'PR #5 开了' }]);
    expect((await run(gh.gh, ['done', '12'])).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ state: 'done', text: 'PR #5 开了' }]);
    const after = await run(gh.gh, ['say', '12', '还想说']);
    expect(after.code).toBe(2);
    expect(after.err).toContain('已经标了做完了');
    await run(gh.gh, ['claim', '13']);
    expect((await run(gh.gh, ['drop', '13', '交给法国'])).code).toBe(0);
    expect(gh.claims(13)).toMatchObject([{ state: 'dropped', text: '交给法国' }]);
  });

  it('show：谁在做、多久没动静；超过时限标「可能断了」；查不成的那张退出码 2', async () => {
    const gh = fakeGitHub();
    gh.add(
      12,
      doing.renderClaim('doing', '法国', '在写'),
      new Date(NOW.getTime() - (doing.STALE_HOURS * 60 + 5) * 60_000),
    );
    gh.add(13, doing.renderClaim('doing', '本机', '刚开始'), new Date(NOW.getTime() - 5 * 60_000));
    const r = await run(gh.gh, ['show', '12', '13', '14']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('#12 法国 在做：在写（最后动静 2 小时 5 分钟前，可能断了；要接手得创始人说）');
    expect(r.out).toContain('#13 本机 在做：刚开始（最后动静 5 分钟前）');
    expect(r.out).toContain('#14 没人在做');
    gh.hooks.failListAt = 3;
    const failed = await run(gh.gh, ['show', '12']);
    expect(failed.code).toBe(2);
    expect(failed.out).toContain('#12 没查成');
  });
});
