// 钉住帅位技能规矩的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 脚本怎么改都行，这几条规矩不能被脚本悄悄改掉：别的机器在做的不碰；撞车时早留的算数；接手要创始人说了才行。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DoingIo, doing, fakeGitHub, runDoing } from '../helpers/doing.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(
  gh: DoingIo['gh'],
  argv: string[],
  env: Record<string, string | undefined> = { FLEET_MACHINE: '本机' },
) {
  const home = mkdtempSync(join(tmpdir(), 'commander-seat-rules-'));
  made.push(home);
  return runDoing(gh, argv, env, home);
}

describe('规矩：动一张单之前先认领，别的机器在做的不碰', () => {
  it('别的机器在做：退出码 3，不留评论', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('doing', '法国', '在写'));
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('法国 在做');
    expect(gh.methods()).toEqual(['GET']);
  });

  it('撞车：我留言的同时法国先留了（编号比我小）——我撤回自己那条，退出码 3', async () => {
    const gh = fakeGitHub();
    gh.hooks.beforePost = () => {
      gh.hooks.beforePost = undefined;
      gh.add(12, doing.renderClaim('doing', '法国', '也在抢'));
    };
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('撞了：法国 先留的');
    expect(gh.claims(12)).toMatchObject([{ machine: '法国', state: 'doing' }]);
    expect(gh.methods()).toEqual(['GET', 'POST', 'GET', 'DELETE']);
  });

  it('创始人说了才接手：--takeover 把别的机器那条改成放下（记上原话），再认领', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('doing', '法国', '做到一半'));
    const r = await run(gh.gh, ['claim', '12', '--takeover', '法国断了，本机接着做']);
    expect(r.code).toBe(0);
    expect(gh.claims(12)).toMatchObject([
      {
        machine: '法国',
        state: 'dropped',
        text: expect.stringContaining('创始人让 本机 接手（原话：法国断了，本机接着做）'),
      },
      { machine: '本机', state: 'doing' },
    ]);
    // 法国回来还想接着报进度：告诉它这张已经不归它
    const back = await run(gh.gh, ['say', '12', '我回来了'], { FLEET_MACHINE: '法国' });
    expect(back.code).toBe(3);
    expect(back.out).toContain('不归你');
  });
});
