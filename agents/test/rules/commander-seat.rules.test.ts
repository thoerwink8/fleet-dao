// 钉住帅位技能规矩的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 脚本怎么改都行，这几条规矩不能被脚本悄悄改掉：全局只一个帅位，受保护动作前现查、换了人就退役（#299）；派工先在库里认领，
// 本机的 Sonnet 工人开草稿、帅位验收过了再转正（技能说明里写着）；库里没有的仓照旧靠单上的「在做」：别的机器在做的不碰、
// 撞车时早留的算数、接手要创始人说了才行。
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

// —— 只一个帅位（#299、#349）：技能说明里的规矩，和脚本守着的那两条 ——

const SKILL = readFileSync(join(SCRIPTS, '..', 'SKILL.md'), 'utf8');

/** 技能说明里必须写着的规矩：一条一行，缺了哪条就列出哪条。 */
const SEAT_RULES: Record<string, RegExp> = {
  全局只一个帅位: /全局只一个帅位/,
  创始人指定了才接班: /只在创始人指定了才接/,
  续约: /seat\.mjs renew/,
  受保护动作前现查: /\*\*受保护动作\*\*：[^\n]*每做一个之前先 `node \$S\/seat\.mjs check`/,
  换了人就退役: /不是帅位了，这个动作不做[\s\S]{0,40}退役/,
  派工先在库里认领: /claim\.mjs take <单号>/,
  工人每步报进度: /claim\.mjs step <单号> --claim <认领号>/,
  强制改派要创始人原话: /还活着的[\s\S]{0,40}要带创始人原话/,
  Sonnet工人开草稿: /Sonnet 5[\s\S]{0,120}一律开成草稿、不挂自动合并/,
  帅位验收四样: /断点找得对[\s\S]{0,40}必经的那一步[\s\S]{0,40}故意造出失败的测试[\s\S]{0,20}没夹带别的改动/,
  两次没过改派Opus: /两次没过验收，改派 Opus/,
  看到提醒先认领: /看到要修的提醒先认领[\s\S]{0,120}alert claim/,
  修完随PR撤: /修完随 PR 撤[\s\S]{0,40}「修提醒」栏写提醒的键/,
};

function missingSeatRules(text: string): string[] {
  return Object.entries(SEAT_RULES)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

describe('规矩：全局只一个帅位，受保护动作前现查、换了人就退役（#299）', () => {
  it('技能说明里这几条都在', () => {
    expect(missingSeatRules(SKILL)).toEqual([]);
  });

  it('【故意造出的失败】技能说明删掉「受保护动作前现查」「换了人就退役」：查得出缺了哪条', () => {
    const cut = SKILL.replace(/## 受保护动作前现查，换了人就退役[\s\S]*?## 派工/, '## 派工');
    expect(cut).not.toBe(SKILL);
    expect(missingSeatRules(cut)).toEqual(expect.arrayContaining(['受保护动作前现查', '换了人就退役']));
  });

  it('【故意造出的失败】现查发现换了人：记成已退役，之后认领新单不再去法国、直接拒（退出码 3）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'commander-seat-rules-'));
    made.push(home);
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(join(home, '.fleet-dao', 'france-ssh'), 'france\n');
    const replies: unknown[] = [
      {
        ok: true,
        seat: { scope: 'main', term: 3, holder: { machine: '本机', session: 's1' }, previous: null },
        leaseMinutes: 45,
        expiresAt: new Date(NOW.getTime() + 45 * 60_000).toISOString(),
        now: NOW.toISOString(),
      },
      { ok: false, reason: 'replaced', why: '帅位已经是 笔记本/s2（第 4 任）', now: NOW.toISOString() },
    ];
    const codes = [0, 3];
    let sshCalls = 0;
    const err: string[] = [];
    const io = {
      ssh: () => {
        const json = replies[sshCalls];
        const status = codes[sshCalls] ?? 0;
        sshCalls += 1;
        if (json === undefined) throw new Error('退役后不该再去法国');
        return { status, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
      },
      git: (args: string[]) =>
        args[1] === '--get' && args[2] === 'remote.origin.url'
          ? { status: 0, stdout: 'https://github.com/acme/fleet-dao.git\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' },
      gh: () => '',
      env: { FLEET_MACHINE: '本机' },
      home,
      now: () => NOW,
      sleep: async () => {},
      readStdin: async () => '',
      out: () => {},
      err: (t: string) => err.push(t),
    };
    expect(await seatLib.runSeat(['take', '--session', 's1'], io)).toBe(0);
    expect(await seatLib.runSeat(['check'], io)).toBe(3);
    expect(sshCalls).toBe(2);
    expect(await seatLib.runClaim(['take', '41', '--label', 'w1'], io)).toBe(3);
    expect(err.at(-1)).toContain('你已经不是帅位');
    expect(sshCalls).toBe(2);
  });
});
