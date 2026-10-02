// discuss 技能带的脚本（agents/skills/discuss/scripts/）：ask.mjs 一问一答、second-opinion.mjs 反方和审 PR、walkthrough.mjs、tools.mjs。
// 在临时家目录里跑，PATH 里只放假的 cursor-agent（或者什么都不放）：不碰真家目录、不出网、不调模型。
// 重点是这台机器缺东西时（法国上就没有 cursor-agent、Mirasim）要明说缺的是什么，不当成答了、也不当成没事。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Verdict {
  pass: boolean;
  blocking: number;
}
interface SecondOpinionLib {
  parseVerdict(text: string): Verdict | null;
  parseCritique(text: string): { agree: boolean; objections: number } | null;
  judgeSnapshot(view: unknown): { status: string; why: string };
  judgeLedger(rows: unknown[], since: number, mustRelay: boolean): { ok: boolean; why: string };
  prComment(
    round: number,
    head: string,
    model: string,
    v: Verdict,
    text: string,
    postMerge?: boolean,
  ): string;
  stripLocalPaths(text: string, dirs: string[]): string;
  reviewRound(bodies: string[], head: string): { round: number; heads: string[] };
  MAX_REVIEW_ROUNDS: number;
  checkPublishable(repo: string, body: string): Promise<void>;
  cursorAgentEnv(
    platform?: string,
    env?: Record<string, string | undefined>,
  ): Record<string, string | undefined>;
  UNAVAILABLE: RegExp;
  parseReclaudeOutput(raw: string): string;
  discussionProfiles(options: {
    authorFamily?: string;
    excludeFamily?: string;
    agent?: string;
    ui?: boolean;
  }): Array<{
    family: string;
    agent: string;
    model: string | null;
  }>;
}
interface ToolsLib {
  dataDir(home?: string): string;
  findBin(name: string, env?: Record<string, string | undefined>, platform?: string): string | undefined;
  cursorAgentProblem(o?: {
    env?: Record<string, string | undefined>;
    run?: (name: string, args: string[], opts: unknown) => unknown;
  }): string | null;
}
interface WalkLib {
  missingWalkthrough(text: string): string | null;
}
interface AskLib {
  removeDir(dir: string, rm?: (dir: string, opts: unknown) => void): void;
}

const SCRIPTS = fileURLToPath(new URL('../skills/discuss/scripts/', import.meta.url));
const load = async (name: string) => import(pathToFileURL(join(SCRIPTS, name)).href);
const so = (await load('second-opinion.mjs')) as SecondOpinionLib;
const tools = (await load('tools.mjs')) as ToolsLib;
const walk = (await load('walkthrough.mjs')) as WalkLib;
const ask = (await load('ask.mjs')) as AskLib;
const WIN = process.platform === 'win32';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `discuss-${name}-`));
  made.push(dir);
  return dir;
}

const LONG = `【推演】${'从开单走到关单，每个阶段的边界和最坏情况都列了，对照了成熟产品的做法。'.repeat(3)}`;

/**
 * 假的 cursor-agent：status 按 FAKE_LOGGED 说登没登录，不碰 stdin（真实的 status 查询也不喂它东西）。
 * 问答（-p ... 不带位置参数）默认老实读 stdin 里的题面、把里面的核对码原样抄回去、后面接 FAKE_ANSWER——
 * 模拟真收到题面的模型（ask.mjs、second-opinion.mjs 的核对码机制见各自 askOne / runCursor 的注释）。
 * FAKE_RAW=1 时不管 stdin、直接吐 FAKE_ANSWER（'' 就是没输出）——模拟读不到题面那种坏模型，或单纯造
 * 「没有输出」这种边界。FAKE_DUMP_ENV=1 时只把关心的几个环境变量吐成 JSON，查传给它的环境干不干净。
 * FAKE_ASSERT=1 时断言 argv 里没有多余的位置参数（没让它去读文件）、stdin 里确实有题面，吐一份 JSON。
 */
function fakeCursor(): string {
  const bin = temp('bin');
  const script = join(bin, 'fake-cursor.mjs');
  writeFileSync(
    script,
    [
      "if (process.argv.includes('status')) {",
      "  process.stdout.write(JSON.stringify({ status: 'x', isAuthenticated: process.env.FAKE_LOGGED === '1' }));",
      '} else {',
      "  let stdinData = '';",
      "  process.stdin.on('data', (d) => {",
      '    stdinData += d;',
      '  });',
      "  process.stdin.on('end', () => {",
      "    if (process.env.FAKE_DUMP_ENV === '1') {",
      "      const keys = ['SHELL', 'MSYSTEM', 'MSYSTEM_PREFIX', 'MSYSTEM_CHOST', 'TERM'];",
      '      process.stdout.write(',
      '        JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))),',
      '      );',
      "    } else if (process.env.FAKE_ASSERT === '1') {",
      '      // 认识的这几个 flag、以及 --workspace/--model 后面各跟的那一个值；除此之外不该再有别的位置参数',
      '      // （老版本那句「读 xxx.md，照里面的要求作答」就是这种多余的位置参数）。',
      "      const known = new Set(['-p', '--output-format', 'text', '--trust', '--mode', 'ask', '--workspace', '--model']);",
      '      const rest = process.argv.slice(2);',
      '      const extraArgs = rest.filter(',
      "        (a, i) => !known.has(a) && rest[i - 1] !== '--workspace' && rest[i - 1] !== '--model',",
      '      );',
      '      process.stdout.write(',
      "        JSON.stringify({ extraArgs, stdinHasTopic: stdinData.includes('【推演】') }),",
      '      );',
      "    } else if (process.env.FAKE_RAW === '1') {",
      "      process.stdout.write(process.env.FAKE_ANSWER ?? '');",
      '    } else {',
      "      const nonce = (/^核对码：(\\S+)/m.exec(stdinData) ?? [])[1] ?? '';",
      "      process.stdout.write(nonce + '\\n' + (process.env.FAKE_ANSWER ?? ''));",
      '    }',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  if (WIN) writeFileSync(join(bin, 'cursor-agent.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    writeFileSync(join(bin, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, 'cursor-agent'), 0o755);
  }
  return bin;
}

/** 假的 reclaude：只验证讨论脚本使用无头 JSON 参数并能读出正文，不连接真实 Claude。 */
function fakeReclaude(): string {
  const bin = temp('reclaude-bin');
  const script = join(bin, 'fake-reclaude.mjs');
  writeFileSync(
    script,
    [
      "if (!process.argv.includes('-p') || !process.argv.includes('--output-format') || !process.argv.includes('json') || !process.argv.includes('--effort') || !process.argv.includes('medium') || !process.argv.includes('--max-turns') || !process.argv.includes('1')) process.exit(9);",
      'if (process.env.FAKE_RECLAUDE_SLEEP_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_RECLAUDE_SLEEP_MS)));',
      "process.stdout.write(JSON.stringify({ result: '## 框架对不对\\n一致\\n## 漏掉的\\n无\\n## 选项怎么改\\n无\\n结论：同意' }));",
      '',
    ].join('\n'),
  );
  if (WIN) writeFileSync(join(bin, 'reclaude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    writeFileSync(join(bin, 'reclaude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, 'reclaude'), 0o755);
  }
  return bin;
}

/** 跑一个脚本：家目录换成临时的，PATH 只有给的那个目录（不给就是空目录） */
function run(
  script: string,
  args: string[],
  o: { home: string; path?: string; env?: Record<string, string> },
) {
  const env: Record<string, string> = {
    HOME: o.home,
    USERPROFILE: o.home,
    PATH: o.path ?? temp('empty'),
    ...o.env,
  };
  for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined && env[k] === undefined) env[k] = v;
  }
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    env,
    cwd: temp('cwd'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

function topic(text: string): string {
  const file = join(temp('topic'), '题面.md');
  writeFileSync(file, text);
  return file;
}

/** 给子进程一个自己的临时目录（TMPDIR，Windows 上是 TEMP、TMP）：跑完看它留没留东西。 */
function ownTmp(): { dir: string; env: Record<string, string> } {
  const dir = temp('tmp');
  return { dir, env: { TMPDIR: dir, TEMP: dir, TMP: dir } };
}

const SLOW = { timeout: 60_000 };

describe('挑错题面要带【推演】', () => {
  it('缺【推演】、太短拦下，带够了放行', () => {
    expect(walk.missingWalkthrough('【规则】只有方案')).not.toBeNull();
    expect(walk.missingWalkthrough('【推演】太短')).not.toBeNull();
    expect(walk.missingWalkthrough(`${LONG}\n【参考】Shape Up`)).toBeNull();
  });
});

describe('ask.mjs：参数不对、题面不对，一家都不问', SLOW, () => {
  it('不给 --round、挑错轮缺【推演】、模型认不出：退出码 2，说清缺什么；【推演】先拦', () => {
    const home = temp('home');
    const good = topic(LONG);
    const bare = topic('【规则】只有方案，没有推演');
    let r = run('ask.mjs', ['--text', good], { home });
    expect(r.code).toBe(2);
    expect(r.all).toContain('--round');
    r = run('ask.mjs', ['--text', bare, '--round', '1', '--models', 'nosuch'], { home });
    expect(r.code).toBe(2);
    expect(r.all).toContain('【推演】');
    r = run('ask.mjs', ['--text', bare, '--round', '0', '--models', 'nosuch'], { home });
    expect(r.all).toContain('不认识的模型');
    r = run('ask.mjs', ['--text', good, '--round', '2', '--models', 'nosuch'], { home });
    expect(r.all).toContain('不认识的模型');
  });
});

describe('ask.mjs：这台机器缺 cursor-agent', SLOW, () => {
  it('没装：退出码 2，明说这台机器没装 cursor-agent，不去问', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 cursor-agent');
  });

  it('装了没登录：退出码 2，明说没登录', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '0', FAKE_ANSWER: '不该问到我' },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('cursor-agent 没登录');
    expect(r.all).not.toContain('不该问到我');
  });

  it('装了登了：答案照登，记录落在家目录，不落进技能目录（同步会把技能目录整个换掉）；放题面的临时目录问完就删', () => {
    const home = temp('home');
    const tmp = ownTmp();
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home,
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ANSWER: '假答案：同意', ...tmp.env },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('## gpt');
    expect(r.out).toContain('假答案：同意');
    const runs = join(tools.dataDir(home), 'runs');
    expect(readdirSync(runs).some((f) => f.startsWith('ask-'))).toBe(true);
    expect(existsSync(join(SCRIPTS, 'runs'))).toBe(false);
    expect(readdirSync(tmp.dir)).toEqual([]);
  });

  it('【故意造出的失败】问完了、记录却写不下（--out 落在一个文件下面）：退出码 2 说没问成，临时目录照样删掉', () => {
    const tmp = ownTmp();
    const blocker = join(temp('out'), 'not-a-dir');
    writeFileSync(blocker, 'x');
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--out', join(blocker, 'runs')], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ANSWER: '假答案：同意', ...tmp.env },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('没问成');
    expect(readdirSync(tmp.dir)).toEqual([]);
  });

  it('【故意造出的失败】临时目录删不掉：照实说没删掉、是哪个目录，不当成删好了；删得掉就不出声', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    try {
      const dir = temp('ask-left');
      ask.removeDir(dir, () => {
        throw new Error('EBUSY: resource busy or locked');
      });
      expect(existsSync(dir)).toBe(true);
      expect(errors).toEqual([`临时目录没删掉：${dir}：EBUSY: resource busy or locked`]);
      ask.removeDir(dir);
      expect(existsSync(dir)).toBe(false);
      expect(errors).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('答了个空：记成没答上，一家都没答上退出码 2', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_RAW: '1', FAKE_ANSWER: '' },
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：退出码 0 但没有输出');
  });
});

// 断链修复（本机 2026-09-28 两次实测）：第一版让 askOne 起 cursor-agent 读工作目录里的题面文件，指望
// cursorAgentEnv() 摘掉 Git Bash 留下的环境变量就够。实测不够：只要父进程链里有 Git Bash，Cursor 的钩子照样把
// 读文件的工具调用拦掉（见 scripts/ask.mjs askOne 头上的论证），模型读不到题面时回一句「无法读取 xxx」——但
// 退出码 0、有输出，原来的判断（退出码 0 且有输出就算答了）会把这句「读不到」当成结论。改法是压根不用文件：不给
// 位置参数，题面从 stdin 喂给它；再加一层防蒙混——题面最前面塞一行随机核对码，要求原样抄进答案，输出里找不到
// 核对码就一律判没答上，不管缘由是什么（钩子拦的、权限、压根没读 stdin）。
describe('askOne：题面从 stdin 喂给 cursor-agent，核对码没读回来不当成答上', SLOW, () => {
  it('假 cursor-agent 不管 stdin、直接回一句没有核对码的话（退出码 0）：判没答上，ask.mjs 退出码 2', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_RAW: '1', FAKE_ANSWER: '无法读取题面。' },
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('没读到题面（答案里没有题面里的核对码）');
    expect(r.out).toContain('无法读取题面');
  });

  it('假 cursor-agent 老实读了 stdin、原样带回核对码：判答上，记下的答案里没有核对码那一行', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ANSWER: '这才是真正的答案' },
    });
    expect(r.code).toBe(0);
    const body = /## gpt[^\n]*\n\n([\s\S]*)/.exec(r.out)?.[1]?.trim();
    expect(body).toBe('这才是真正的答案');
  });

  // 故意造出失败：askOne 的 spawn 要是又给带上了「读 xxx.md」那种位置参数、或者忘了把题面喂进 stdin，
  // 这条就会看到 extraArgs 非空、或 stdinHasTopic 是 false，断言失败。
  it('起 cursor-agent 时不带位置参数（不再叫它去读文件），题面真的从 stdin 送过去', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ASSERT: '1' },
    });
    const dumped = JSON.parse(/\{[\s\S]*\}/.exec(r.out)?.[0] ?? '{}');
    expect(dumped).toEqual({ extraArgs: [], stdinHasTopic: true });
  });

  // 故意造出失败：不给 ask.mjs 里 askOne 的 spawn 带 env: cursorAgentEnv()，这条就会看到 SHELL/MSYSTEM 原样传下去，
  // 断言失败。只测 win32：cursorAgentEnv 在别的平台是恒等函数，摘不掉什么，纯函数那组测试已经覆盖了。
  it.skipIf(!WIN)('win32：起 cursor-agent 时环境里没有 Git Bash 留下的 SHELL/MSYSTEM 等', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: {
        FAKE_LOGGED: '1',
        FAKE_DUMP_ENV: '1',
        SHELL: '/bin/bash.exe',
        MSYSTEM: 'MINGW64',
        MSYSTEM_PREFIX: '/mingw64',
        MSYSTEM_CHOST: 'x86_64-w64-mingw32',
        TERM: 'xterm-256color',
      },
    });
    const dumped = JSON.parse(/\{[\s\S]*\}/.exec(r.out)?.[0] ?? '{}');
    expect(dumped).toEqual({
      SHELL: null,
      MSYSTEM: null,
      MSYSTEM_PREFIX: null,
      MSYSTEM_CHOST: null,
      TERM: null,
    });
  });
});

describe('second-opinion.mjs：缺东西照实报', SLOW, () => {
  it('反方题面缺【推演】：退出码 2，不去问', () => {
    const r = run(
      'second-opinion.mjs',
      ['--text', topic('【规则】只有方案，没有推演'), '--name', 'walk-test'],
      {
        home: temp('home'),
      },
    );
    expect(r.code).toBe(2);
    expect(r.all).toContain('【推演】');
  });

  it('固定候选都不可用：几家都换过，退出码 2，逐家写明缺的是什么', () => {
    const home = temp('home');
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'no-tools', '--author-family', 'gpt'],
      { home },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 Mirasim');
    expect(r.err).toContain('这台机器没装 reclaude');
    expect(r.err).toContain('候选的几家全没成');
    const runs = join(tools.dataDir(home), 'runs');
    expect(readdirSync(runs).some((f) => f.startsWith('critique-no-tools-'))).toBe(true);
  });

  it('Mirasim 装了没开：写明没开', () => {
    const home = temp('home');
    mkdirSync(join(home, '.mirasim', 'run'), { recursive: true });
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'mira-off', '--author-family', 'gpt'],
      { home },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('本机 Mirasim 没开');
  });

  it('PR 审查不带 --high-risk：退出码 3（不是 0），说清只审先审后合的两种', () => {
    const r = run('second-opinion.mjs', ['--pr', '5'], { home: temp('home') });
    expect(r.code).toBe(3);
    expect(r.err).toContain('--high-risk');
  });

  it('审 PR 但这台没装 gh：没查成，写明缺 gh', () => {
    const r = run('second-opinion.mjs', ['--pr', '5', '--high-risk', '--repo', temp('repo')], {
      home: temp('home'),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 gh');
  });

  it('不给 --repo、当前目录又不是 git 检出：没查成，不猜是哪个仓', () => {
    const r = run('second-opinion.mjs', ['--pr', '5', '--high-risk'], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('认不出要审的是哪个仓');
  });
});

// 断链修复（本机 2026-09-28 实测）：cursor-agent 在 Windows 上靠父进程环境里 Git Bash 留下的
// SHELL/MSYSTEM/TERM 猜「现在是不是 bash」，猜完拿这几个变量去跑钩子的 stdin 转发脚本——那脚本是 PowerShell
// 语法，猜成 bash 就整个交给 bash 的 eval，直接语法错、钩子判失败＝把这次工具调用拦掉（agents/hooks/pretool.mjs
// 挂着同一条注释）。second-opinion.mjs 起 cursor-agent 的会话大多是从 Git Bash 起的，spawn 默认整份带过去，
// 摘掉这几个变量让它猜成本机原生的壳，钩子才跑得动；摘的是环境变量，不碰钩子本身的判断，密钥路径照样拦。
describe('cursorAgentEnv：起 cursor-agent 时把 Git Bash 留的几个变量摘掉，别的原样', () => {
  const dirty = { SHELL: '/bin/bash.exe', MSYSTEM: 'MINGW64', TERM: 'xterm-256color', PATH: '/x' };

  it('win32：SHELL、MSYSTEM、MSYSTEM_PREFIX、MSYSTEM_CHOST、TERM 都摘掉，别的（PATH）留着', () => {
    const got = so.cursorAgentEnv('win32', dirty);
    expect(got).toEqual({ PATH: '/x' });
  });

  // 故意造出失败：这几个变量摘漏一个，猜壳又会猜错、钩子又会崩——不能只摘一半
  it('win32：摘的是这五个，一个都不能漏', () => {
    const got = so.cursorAgentEnv('win32', {
      ...dirty,
      MSYSTEM_PREFIX: '/mingw64',
      MSYSTEM_CHOST: 'x86_64-w64-mingw32',
    });
    expect(Object.keys(got)).toEqual(['PATH']);
  });

  it('linux：原样返回，不摘（本来就不是这个 bug）', () => {
    expect(so.cursorAgentEnv('linux', dirty)).toEqual(dirty);
  });
});

describe('tools.mjs：cursor-agent 能不能用，逐样说清', () => {
  const bin = (): Record<string, string> => ({ PATH: fakeCursor(), PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  it('没装、查登录超时、输出认不出、没登录、登了：各是一句', () => {
    expect(tools.cursorAgentProblem({ env: { PATH: temp('empty') } })).toContain('没装 cursor-agent');
    const timeout = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(tools.cursorAgentProblem({ env: bin(), run: () => ({ error: timeout }) })).toContain('30 秒没回');
    const garbled = tools.cursorAgentProblem({
      env: bin(),
      run: () => ({ status: 0, stdout: '✓ Logged in as someone', stderr: '' }),
    });
    expect(garbled).toContain('输出认不出');
    expect(garbled).not.toContain('someone');
    expect(
      tools.cursorAgentProblem({
        env: bin(),
        run: () => ({ status: 0, stdout: '{"isAuthenticated":false}' }),
      }),
    ).toContain('没登录');
    expect(
      tools.cursorAgentProblem({
        env: bin(),
        run: () => ({ status: 0, stdout: '{"isAuthenticated":true}' }),
      }),
    ).toBeNull();
  });
});

describe('second-opinion.mjs 的纯判断（原来 --selftest 的那几条）', () => {
  it('结论行：认得出的两种，认不出回 null', () => {
    expect(so.parseVerdict('## 必须改\n无\n结论：通过')).toEqual({ pass: true, blocking: 0 });
    expect(so.parseVerdict('…\n**结论：必须改 2 条**\n')).toEqual({ pass: false, blocking: 2 });
    expect(so.parseVerdict('结论：必须改 0 条')).toBeNull();
    expect(so.parseVerdict('结论：通过\n另外一句')).toBeNull();
    expect(so.parseVerdict('')).toBeNull();
    expect(so.parseCritique('## 漏掉的\n无\n结论：同意')).toEqual({ agree: true, objections: 0 });
    expect(so.parseCritique('**结论：有异议 3 条**')).toEqual({ agree: false, objections: 3 });
    expect(so.parseCritique('结论：有异议 0 条')).toBeNull();
    expect(so.parseCritique('结论：通过')).toBeNull();
  });

  it('快照：done 带死因、带 incomplete 不算完工；没有 phase 认不出', () => {
    expect(so.judgeSnapshot({ phase: 'done', error: 'turn stalled' }).status).toBe('failed');
    expect(so.judgeSnapshot({ phase: 'done', incomplete: true }).status).toBe('failed');
    expect(so.judgeSnapshot({ phase: 'streaming' }).status).toBe('running');
    expect(so.judgeSnapshot({}).status).toBe('unknown');
    expect(so.judgeSnapshot({ phase: 'done', error: null }).status).toBe('done');
  });

  it('账本：起针后要有成功调用；有一次没走中继就不算', () => {
    const t0 = Date.parse('2026-09-25T10:00:00Z');
    const row = (ts: string, status: number, viaRelay: boolean, upstreamHost = 'relay') => ({
      ts,
      status,
      viaRelay,
      upstreamHost,
    });
    expect(so.judgeLedger([row('2026-09-25T10:00:05Z', 200, true)], t0, true).ok).toBe(true);
    expect(so.judgeLedger([row('2026-09-25T09:00:00Z', 200, true)], t0, true).ok).toBe(false);
    expect(so.judgeLedger([row('2026-09-25T10:00:05Z', 200, false, 'api.example')], t0, true).ok).toBe(false);
    expect(so.judgeLedger([row('2026-09-25T10:00:05Z', 429, true)], t0, true).ok).toBe(false);
    expect(so.judgeLedger([], t0, true).ok).toBe(false);
  });

  it('贴 PR 的正文去掉过程话、带着头；本机目录换成仓内相对路径', () => {
    const c = so.prComment(
      1,
      'abcdef1234',
      'm',
      { pass: false, blocking: 1 },
      '我先读规矩……\n## 必须改\n- `a.ts:1` 问题\n结论：必须改 1 条',
    );
    expect(c).not.toContain('我先读规矩');
    expect(c).toContain('## 必须改');
    expect(c).toContain('abcdef1');
    expect(so.stripLocalPaths('见 /home/u/w/tree/src/a.ts:3', ['/home/u/w/tree'])).toBe('见 src/a.ts:3');
  });

  it('模型满载算连不上、换下一家；认不出结论不换人', () => {
    expect(so.UNAVAILABLE.test('快照报 done 但带着 incomplete：Selected model is at capacity.')).toBe(true);
    expect(so.UNAVAILABLE.test('结论认不出')).toBe(false);
  });

  it('贴之前过卫生检查：扫出真密钥不贴、干净的放行（卫生检查换成假的；账号、组织编号、邮箱、IP 这类标识不算泄漏，不拦，创始人 2026-09-28 傍晚拍）', async () => {
    const repo = temp('repo');
    const src = join(repo, 'packages', 'hygiene', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'scan.ts'),
      [
        'export function scanFiles(paths, read) {',
        "  const text = read(paths[0]).toString('utf8');",
        "  const findings = text.includes('LEAKED-TOKEN') ? [{ rule: 'token' }] : [];",
        '  return { binary: [], scanned: paths, findings };',
        '}',
        'export function formatFinding(f) { return f.rule; }',
        '',
      ].join('\n'),
    );
    await expect(so.checkPublishable(repo, '里面有 LEAKED-TOKEN 这个值')).rejects.toThrow('卫生检查拦下了');
    await expect(so.checkPublishable(repo, '干净的正文')).resolves.toBeUndefined();
  });
});

describe('讨论/第二意见：按作者模型族排除同族', () => {
  it('作者是 GPT 时跳过 GPT，按固定顺序给出 Claude、DeepSeek、Grok、Kimi', () => {
    expect(so.discussionProfiles({ authorFamily: 'gpt' }).map((p) => p.family)).toEqual([
      'claude',
      'deepseek',
      'grok',
      'kimi',
    ]);
  });

  it('作者是非 GPT 时默认 GPT 首选', () => {
    expect(so.discussionProfiles({ authorFamily: 'claude' }).map((p) => p.family)).toEqual([
      'gpt',
      'deepseek',
      'grok',
      'kimi',
    ]);
  });

  it('作者族可以是多个，所有同族都跳过', () => {
    expect(so.discussionProfiles({ authorFamily: 'gpt,deepseek' }).map((p) => p.family)).toEqual([
      'claude',
      'grok',
      'kimi',
    ]);
  });

  it('缺作者族或含未知族时明确失败，不猜环境变量', () => {
    expect(() => so.discussionProfiles({})).toThrow('要 --author-family');
    expect(() => so.discussionProfiles({ authorFamily: 'mystery' })).toThrow('不认识的作者模型族');
  });

  it('显式指定同作者族的执行体时拒绝，不能靠手点绕过同族排除', () => {
    expect(() => so.discussionProfiles({ authorFamily: 'gpt', agent: 'code' })).toThrow('同一模型族');
  });
});

describe('讨论/第二意见：作者为 GPT 时候选全不可用', SLOW, () => {
  it('候选端点都没装或没开时退出码 2，并列出全没成，不伪造 DeepSeek 已可用', () => {
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'all-unavailable', '--author-family', 'gpt'],
      {
        home: temp('home'),
      },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('候选的几家全没成');
    expect(r.err).toContain('reclaude');
    expect(r.err).toContain('dsh');
  });
});

describe('Claude 讨论端点：只经 reclaude 的无头 JSON', SLOW, () => {
  it('作者是 GPT 时 Claude 先被选中，reclaude 参数和 JSON 正文都能核对', () => {
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'fake-claude', '--author-family', 'gpt'],
      {
        home: temp('home'),
        path: fakeReclaude(),
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('critique-fake-claude-');
    expect(r.err).toContain('reclaude 起了');
  });

  it('reclaude JSON 形状认不出时明确失败', () => {
    expect(() => so.parseReclaudeOutput('{"unexpected":true}')).toThrow('reclaude JSON 输出格式认不出');
    expect(so.parseReclaudeOutput('{"result":"结论：同意"}')).toBe('结论：同意');
  });

  it('单家超时后不把预算带给下一家，整轮到时退出码 2', () => {
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'budget', '--author-family', 'gpt', '--budget-sec', '0.05'],
      { home: temp('home'), path: fakeReclaude(), env: { FAKE_RECLAUDE_SLEEP_MS: '100' } },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('讨论总预算已用完');
  });
});

describe('第二意见第几轮按 PR 上审过的头数，不信 --round', () => {
  const posted = (head: string, round = 1) =>
    so.prComment(
      round,
      head,
      'gpt-6-luna',
      { pass: false, blocking: 1 },
      '## 必须改\n- x\n结论：必须改 1 条',
    );
  it('没审过是第 1 轮；同一个头重审还是那一轮；换了头算下一轮', () => {
    expect(so.reviewRound([], 'aaaaaaa1234')).toEqual({ round: 1, heads: [] });
    const one = [posted('aaaaaaa1234'), '别的评论'];
    expect(so.reviewRound(one, 'aaaaaaa9999').round).toBe(1);
    expect(so.reviewRound(one, 'bbbbbbb0000')).toEqual({ round: 2, heads: ['aaaaaaa'] });
  });
  it('【故意造出的失败】#597 那样每次都写「第 1 轮」：照审过的头数算，第 3 个头超过上限', () => {
    const bodies = ['aaaaaaa', 'bbbbbbb'].map((h) => posted(h, 1));
    const r = so.reviewRound(bodies, 'ccccccc0000');
    expect(r.round).toBe(3);
    expect(r.round).toBeGreaterThan(so.MAX_REVIEW_ROUNDS);
  });
  it('合并后补审的评论不算进先审后合的轮数', () => {
    const after = so.prComment(1, 'aaaaaaa', 'm', { pass: true, blocking: 0 }, '结论：通过', true);
    expect(so.reviewRound([after], 'bbbbbbb').round).toBe(1);
  });
});
