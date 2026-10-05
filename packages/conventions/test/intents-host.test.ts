// 登法国的 ssh 名字有两份防注入的判法：这里的 readSshTarget（pnpm intents）和 commander 技能的 france-lib.mjs
// 的 readTarget（法国引擎页，过渡页，退役时连这条一起删）。技能和包之间不能互引，只好两份；这条对拍钉住两份结论一样：
// 同一批名字（含被 ssh 当成选项的、带空白和 shell 字符的）喂两边，收不收得一致，收下的名字也一样。
// 改 france-lib.mjs 的 PR 也跑这条：ci-plan.ts 的 PATH_RULES 里登记着。
import { describe, expect, it } from 'vitest';
import { IntentsError, readSshTarget } from '../src/intents.ts';

type Verdict = { ok: true; host: string } | { ok: false };
type Io = { env: Record<string, string | undefined>; home: string; readText: (file: string) => string };
type FranceLib = {
  readTarget(io: Io): { ok: true; host: string } | { ok: false; kind: string; why: string };
};

const france = (await import(
  new URL('../../../agents/skills/commander/scripts/france-lib.mjs', import.meta.url).href
)) as FranceLib;

const HOSTS = [
  'fr',
  'france-vps',
  'fleet@fr.example',
  '_alias',
  '1.2.3.4',
  'a'.repeat(201),
  'a'.repeat(202),
  '-oProxyCommand=touch /tmp/x',
  '-fr',
  '.fr',
  '@fr',
  'fr;rm -rf ~',
  'fr && id',
  'fr|id',
  'fr`id`',
  '$(id)',
  'fr id',
  'fr\tid',
  'fr id',
  'fr:22',
  'fr/x',
  '法国',
  'fr\\x',
  "fr'x",
  'fr"x',
];

const viaEnv = (host: string): Io => ({ env: { FLEET_FRANCE_SSH: host }, home: '/h', readText: () => '' });
const viaFile = (host: string): Io => ({
  env: {},
  home: '/h',
  readText: () => `# 注释\n${host}\n`,
});

function ours(io: Io): Verdict {
  try {
    return { ok: true, host: readSshTarget(io) };
  } catch (e) {
    if (e instanceof IntentsError) return { ok: false };
    throw e;
  }
}

function theirs(io: Io): Verdict {
  const r = france.readTarget(io);
  return r.ok ? { ok: true, host: r.host } : { ok: false };
}

/** 两份判法逐个对拍，回对不上的那些（空数组 = 一致）。 */
function mismatches(a: (io: Io) => Verdict, b: (io: Io) => Verdict): string[] {
  const out: string[] = [];
  for (const host of HOSTS) {
    for (const io of [viaEnv(host), viaFile(host)]) {
      if (JSON.stringify(a(io)) !== JSON.stringify(b(io))) out.push(JSON.stringify(host));
    }
  }
  return out;
}

describe('登法国的 ssh 名字：intents.ts 和 france-lib.mjs 两份判法对拍', () => {
  it('同一批名字（环境变量、france-ssh 文件两条路）两边结论一样', () => {
    expect(mismatches(ours, theirs)).toEqual([]);
  });

  it('像 ssh 选项的、带 shell 字符和空白的两边都拒，正常的两边都收', () => {
    for (const bad of ['-oProxyCommand=touch /tmp/x', 'fr;rm -rf ~', '$(id)', 'fr id']) {
      expect(ours(viaEnv(bad)).ok, bad).toBe(false);
      expect(theirs(viaEnv(bad)).ok, bad).toBe(false);
    }
    expect(ours(viaEnv('fleet@fr.example'))).toEqual({ ok: true, host: 'fleet@fr.example' });
    expect(theirs(viaEnv('fleet@fr.example'))).toEqual({ ok: true, host: 'fleet@fr.example' });
  });

  it('【故意造出的失败】一边放宽（收下以横线开头的）：对拍报出对不上的名字', () => {
    const loose = (io: Io): Verdict => {
      const host = (io.env.FLEET_FRANCE_SSH ?? '').trim();
      return host.startsWith('-') ? { ok: true, host } : ours(io);
    };
    expect(mismatches(ours, loose)).toContain(JSON.stringify('-fr'));
  });
});
