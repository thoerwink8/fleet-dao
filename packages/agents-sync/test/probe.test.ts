// 各家读没读到规矩（src/probe.ts，#3111）：按回答内容判（抄对了才算），没装、起不来、超时、退出码不是 0、没核过写法都不当成过；
// 抄的三样真在原件里；Grok 的无人值守环境变量和引擎适配器一致。造的 CLI 输出，不真起各家。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECT,
  HEADLESS,
  judgeAnswer,
  judgeRun,
  type ProbeLine,
  probeAll,
  probeExitCode,
  type Runner,
  type RunResult,
} from '../src/probe.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const GOOD = `RULES：${EXPECT.rules}\nAGENTS：${EXPECT.agentsMd}\nCHECK：${EXPECT.check}\n`;

describe('判回答：按内容，抄对了才算', () => {
  it('三样都抄对：过；全角半角冒号、加粗的键都认', () => {
    expect(judgeAnswer(GOOD)).toEqual([]);
    expect(
      judgeAnswer(
        `**RULES**: ${EXPECT.rules}。\n**AGENTS**: # ${EXPECT.agentsMd}\nCHECK: \`${EXPECT.check}\``,
      ),
    ).toEqual([]);
  });

  it('缺仓根 AGENTS.md、缺验证命令、整段没读到：分别报出来', () => {
    expect(judgeAnswer(`RULES：${EXPECT.rules}\nAGENTS：没有\nCHECK：${EXPECT.check}`)).toEqual([
      '仓根 AGENTS.md',
    ]);
    expect(judgeAnswer(`RULES：${EXPECT.rules}\nAGENTS：${EXPECT.agentsMd}\nCHECK：npm test`)).toEqual([
      `验证命令 ${EXPECT.check}`,
    ]);
    expect(judgeAnswer('我读到了所有规矩，一切正常')).toHaveLength(3);
  });

  it('自报「读到了」不算：键后面没抄出内容就是没读到', () => {
    expect(judgeAnswer('RULES：有\nAGENTS：已加载\nCHECK：有')).toHaveLength(3);
  });
});

describe('一家的结果', () => {
  it('【故意造出的失败】超时、起不来、退出码不是 0（没额度这类）：没查成，不当成过', () => {
    expect(judgeRun('codex', { exitCode: null, stdout: GOOD, stderr: '', timedOut: true }).status).toBe(
      'unchecked',
    );
    expect(
      judgeRun('codex', { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })
        .text,
    ).toMatch(/起不来/);
    const quota = judgeRun('claude', {
      exitCode: 1,
      stdout: '',
      stderr: 'usage limit reached',
      timedOut: false,
    });
    expect(quota).toMatchObject({ status: 'unchecked' });
    expect(quota.text).toContain('usage limit reached');
    const bad = judgeRun('codex', {
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR: 401 Unauthorized: Incorrect API key provided: sk-nsmRN******************JMLr.',
      timedOut: false,
    });
    expect(bad.text).toContain('401 Unauthorized');
    expect(bad.text).not.toMatch(/nsmRN|JMLr/);
  });

  it('答得出来：过或缺什么', () => {
    expect(judgeRun('claude', ok(GOOD)).status).toBe('pass');
    expect(judgeRun('grok', ok('RULES：没有\nAGENTS：没有\nCHECK：没有')).status).toBe('missing');
  });
});

describe('每家问一次', () => {
  // PATH 和家目录都不存在：哪家都找不到
  const detect = () => ({
    env: { PATH: '/fake/bin' },
    platform: 'linux' as const,
    home: '/nonexistent-home',
  });

  it('没装的写没装、没查；没核过无头写法的写没查成；退出码：缺 1、只有没查成 2、全过 0', async () => {
    const calls: string[] = [];
    const run: Runner = async (command, args) => {
      calls.push(`${command} ${args[0]}`);
      return ok(GOOD);
    };
    const lines = await probeAll({ detect: detect(), cwd: ROOT, run, env: {}, only: ['gemini', 'codex'] });
    expect(lines.map((l) => [l.id, l.status])).toEqual([
      ['codex', 'not-installed'],
      ['gemini', 'not-installed'],
    ]);
    expect(calls).toEqual([]);
    const mk = (status: ProbeLine['status']): ProbeLine => ({ id: 'codex', name: 'Codex', status, text: '' });
    expect(probeExitCode([mk('pass'), mk('not-installed')])).toBe(0);
    expect(probeExitCode([mk('pass'), mk('unchecked')])).toBe(2);
    expect(probeExitCode([mk('unchecked'), mk('missing')])).toBe(1);
  });

  it('装了：核过写法的照写法起（Codex 用 codex exec）；没核过写法的（Gemini）记没查成、不起', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'probe-bin-'));
    try {
      for (const name of ['codex', 'gemini']) {
        writeFileSync(join(bin, name), '#!/bin/sh\n');
        chmodSync(join(bin, name), 0o755);
      }
      const calls: string[][] = [];
      const run: Runner = async (command, args) => {
        calls.push([command, ...args.slice(0, 1)]);
        return ok(GOOD);
      };
      const lines = await probeAll({
        detect: { env: { PATH: bin }, platform: 'linux', home: '/nonexistent-home' },
        cwd: ROOT,
        run,
        env: {},
        only: ['codex', 'gemini'],
      });
      expect(lines.map((l) => [l.id, l.status])).toEqual([
        ['codex', 'pass'],
        ['gemini', 'unchecked'],
      ]);
      expect(lines[1]?.text).toMatch(/没核过/);
      expect(calls).toEqual([[join(bin, 'codex'), 'exec']]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('只给核过的几家写无头写法，其余是 null（记没查成，不瞎猜参数）', () => {
    expect(
      Object.entries(HEADLESS)
        .filter(([, v]) => v)
        .map(([k]) => k),
    ).toEqual(['claude', 'codex', 'grok', 'dsh']);
  });
});

describe('和原件、引擎对得上', () => {
  it('抄的三样真在原件里：通用段第 1 条开头、仓根 AGENTS.md 标题、验证命令', () => {
    const rules = readFileSync(`${ROOT}agents/shared-rules.md`, 'utf8');
    expect(rules).toMatch(new RegExp(`## 只有两件事停下来问我\\n1\\. ${EXPECT.rules}`));
    expect(readFileSync(`${ROOT}AGENTS.md`, 'utf8').split('\n')[0]).toBe(`# ${EXPECT.agentsMd}`);
    expect(JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).scripts.check).toBeTruthy();
  });

  it('Grok 的无人值守环境变量和 adapters 的 GROK_UNATTENDED_ENV 一致（不信任目录就不加载 AGENTS.md）', () => {
    // 不跨包 import（agents-sync 不引 adapters），读它的源文本比对
    const src = readFileSync(`${ROOT}packages/adapters/src/grok/run.ts`, 'utf8');
    const block = /GROK_UNATTENDED_ENV[^=]*=\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    const want = Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(want).length).toBeGreaterThan(0);
    expect(HEADLESS.grok?.('x').env).toEqual(want);
  });
});
