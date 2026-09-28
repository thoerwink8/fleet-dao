// 钉住帅位技能规矩的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 脚本怎么改都行，这几条规矩不能被脚本悄悄改掉：全局只一个帅位、接班永远成功（#446 起不是锁，没有续约、没有受保护
// 动作前现查、换了人自己退，不是系统判的）；派工先在库里认领（留作记录，不拦人）；本机的 Sonnet 工人开草稿、帅位验收
// 过了再转正（技能说明里写着）；库里没有的仓照旧靠单上的「在做」：别的机器在做的不碰、撞车时早留的算数、接手要创始人
// 说了才行。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type DoingIo, doing, fakeGitHub, NOW, runDoing, SCRIPTS } from '../helpers/doing.ts';

interface SeatIo {
  ssh: (args: string[], input?: string) => { status: number | null; stdout: string; stderr: string };
  git: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  gh: (args: string[], input?: string) => string;
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}
const seatLib = (await import(pathToFileURL(join(SCRIPTS, 'seat-lib.mjs')).href)) as {
  runSeat(argv: string[], io: SeatIo): Promise<number>;
  runClaim(argv: string[], io: SeatIo): Promise<number>;
};
const boardLib = (await import(pathToFileURL(join(SCRIPTS, 'board-cli.mjs')).href)) as {
  runBoardCli(argv: string[], io: SeatIo): Promise<number>;
};

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

describe('规矩（库里没有的仓）：动一张单之前先在单上认领，别的机器在做的不碰', () => {
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

// —— 只一个帅位（#299，#446 起不是锁）：技能说明里的规矩，和脚本守着的那几条 ——

const SKILL = readFileSync(join(SCRIPTS, '..', 'SKILL.md'), 'utf8');

/** 技能说明里必须写着的规矩：一条一行，缺了哪条就列出哪条。 */
const SEAT_RULES: Record<string, RegExp> = {
  全局只一个帅位: /全局只一个帅位/,
  创始人指定了才接班: /只在创始人指定了才接/,
  接班永远成功不是锁: /接班永远成功[\s\S]{0,30}后说的算/,
  换了人自己退不是系统判的: /自己看[\s\S]{0,10}seat\.mjs show[\s\S]{0,60}该退了/,
  最后活动时间只给人看: /最后活动[\s\S]{0,60}只给人看/,
  认领不拦人只留记录: /认领账?[\s\S]{0,60}(?:只留作记录|留作记录|不拦人)/,
  派工先在库里认领: /claim\.mjs take <单号>/,
  工人每步报进度: /claim\.mjs step <单号> --claim <认领号>/,
  改派不用创始人原话: /改派[\s\S]{0,60}不用创始人原话/,
  Sonnet工人开草稿: /Sonnet 5[\s\S]{0,120}一律开成草稿、不挂自动合并/,
  帅位验收四样: /断点找得对[\s\S]{0,40}必经的那一步[\s\S]{0,40}故意造出失败的测试[\s\S]{0,20}没夹带别的改动/,
  两次没过改派Opus: /两次没过验收，改派 Opus/,
  看到提醒先认领: /看到要修的提醒先认领/,
  修完随PR撤: /修完随 PR 撤[\s\S]{0,40}「修提醒」栏写提醒的键/,
  本机快马: /「本机快马」[\s\S]{0,200}不开单[\s\S]{0,200}CI 绿就合[\s\S]{0,400}做完关老单/,
  进度板不核是不是现任: /进度板[\s\S]{0,120}不核是不是现任|不核是不是现任[\s\S]{0,120}进度板/,
  交接整份换掉不追加: /整份换掉[\s\S]{0,30}不是追加/,
};

function missingSeatRules(text: string): string[] {
  return Object.entries(SEAT_RULES)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：全局只一个帅位；接班永远成功、不是锁；换了人自己退，不是系统判的（#299，#446 起简化）', () => {
  it('技能说明里这几条都在', () => {
    expect(missingSeatRules(SKILL)).toEqual([]);
  });

  it('【故意造出的失败】技能说明删掉「换了人自己退」那一节：查得出缺了哪条', () => {
    const cut = SKILL.replace(/## 换了人自己退[\s\S]*?## 派工/, '## 派工');
    expect(cut).not.toBe(SKILL);
    expect(missingSeatRules(cut)).toEqual(
      expect.arrayContaining(['换了人自己退不是系统判的', '最后活动时间只给人看']),
    );
  });

  it('【故意造出的失败】很久没有任何活动（#446 起没有续约、没有现查这回事了）：seat show 照样看得到自己，进度板照样写得进', async () => {
    const home = mkdtempSync(join(tmpdir(), 'commander-seat-rules-'));
    made.push(home);
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(join(home, '.fleet-dao', 'france-ssh'), 'france\n');
    const replies: { status: number; stdout: string }[] = [
      {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          seat: {
            scope: 'main',
            term: 3,
            holder: { machine: '本机', session: 's1' },
            previous: null,
            acquiredAt: NOW.toISOString(),
            lastActivityAt: NOW.toISOString(),
            handoff: null,
            handoffAt: null,
          },
          now: NOW.toISOString(),
        })}\n`,
      },
      { status: 0, stdout: '帅位（main）：第 3 任 本机/s1，最后活动 6 小时 0 分钟前\n' },
      { status: 0, stdout: `${JSON.stringify({ ok: true })}\n` },
    ];
    let sshCalls = 0;
    let clock = NOW.getTime();
    const io: SeatIo = {
      ssh: () => {
        const r = replies[sshCalls];
        sshCalls += 1;
        if (r === undefined) throw new Error(`用例没给第 ${sshCalls} 次 ssh 的回话`);
        return { status: r.status, stdout: r.stdout, stderr: '' };
      },
      git: (args: string[]) =>
        args[1] === '--get' && args[2] === 'remote.origin.url'
          ? { status: 0, stdout: 'https://github.com/acme/fleet-dao.git\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' },
      gh: () => '',
      env: { FLEET_MACHINE: '本机' },
      home,
      now: () => new Date(clock),
      sleep: async () => {},
      readStdin: async () => '',
      out: () => {},
      err: () => {},
    };
    // 接班
    expect(await seatLib.runSeat(['take', '--session', 's1'], io)).toBe(0);
    // 时间往后跳 6 小时（#446 之前的租期早过了好几倍）：本地缓存不因为放久了失效
    clock += 6 * 60 * 60_000;
    // seat show：法国照样给现状，不会因为「太久没续」被拒
    expect(await seatLib.runSeat(['show'], io)).toBe(0);
    // 写进度板：本地缓存过了很久也照样写得进（board 不核是不是现任）
    expect(await boardLib.runBoardCli(['demo', 'log', '很久之后还能写'], io)).toBe(0);
    expect(sshCalls).toBe(3);
  });
});
