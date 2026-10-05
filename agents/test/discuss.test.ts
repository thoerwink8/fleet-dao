// discuss 技能带的脚本（agents/skills/discuss/scripts/）：ask.mjs 一问一答、second-opinion.mjs 反方和审 PR、walkthrough.mjs、tools.mjs。
// 在临时家目录里跑，PATH 里只放假的 cursor-agent（或者什么都不放）：不碰真家目录、不出网、不调模型。
// 重点是这台机器缺东西时（法国上就没有 cursor-agent、Mirasim）要明说缺的是什么，不当成答了、也不当成没事。
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Verdict {
  pass: boolean;
  blocking: number;
}
interface Item {
  text: string;
  reality: string;
  category: string;
  unlabeled: boolean;
}
interface Judged {
  pass: boolean;
  round: number;
  blocking: Item[];
  deferred: Item[];
  constructed: Item[];
  minor: string[];
  claimed: Verdict | null;
}
type Parsed =
  | { ok: true; mustFix: unknown[]; minor: string[]; claimed: Verdict; body: string }
  | { ok: false; why: string };
type GhRun = (args: string[]) => string;
type GitRun = (args: string[]) => string;
interface PrFile {
  path: string;
  previous?: string;
}
interface Rule {
  path: string;
  afterMerge: boolean;
}
interface PendingPr {
  number: number;
  title: string;
  mergedAt: string | null;
  head: string;
  mergeCommit: string;
  files: string[];
  state: string | null;
  description: string;
}
interface Pending {
  days: number;
  afterMergePaths: string[];
  since: string | null;
  note?: string;
  done: PendingPr[];
  failed: PendingPr[];
  unreviewed: PendingPr[];
  problems: string[];
}
interface Session {
  text: string;
  sessionKey: string;
  model: string | null;
  ledgerNote: string;
  usage: string;
}
interface ReviewDeps {
  gh: GhRun;
  session: (o: unknown) => Promise<Session>;
  runs: string;
}
interface SecondOpinionLib {
  parseVerdict(text: string): Verdict | null;
  parseCritique(text: string): { agree: boolean; objections: number } | null;
  judgeSnapshot(view: unknown): { status: string; why: string };
  judgeLedger(rows: unknown[], since: number, mustRelay: boolean): { ok: boolean; why: string };
  prComment(o: { judged: Judged; head: string; model: string; body: string; afterMerge?: boolean }): string;
  parseReview(text: string): Parsed;
  judgeReview(parsed: Parsed, round: number): Judged;
  stripLocalPaths(text: string, dirs: string[]): string;
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
  RISK_PATHS_FILE: string;
  /** 主检出的根：审查树按它建，不往工作树里套（2026-10-05，嵌套检出拦了全机推送）。 */
  mainCheckout(repo: string): string;
  riskRules(text: string): Rule[] | string;
  afterMergeHits(files: PrFile[], rules: Rule[]): string[];
  parseNameStatusLog(stdout: string): Array<{ sha: string; date: string; files: PrFile[] }>;
  prsOfCommitsQuery(shas: string[]): string;
  classifyAfterMerge(
    candidates: Array<{ sha: string; hits: string[] }>,
    repoData: unknown,
  ): Pick<Pending, 'done' | 'failed' | 'unreviewed' | 'problems'>;
  pendingAfterMerge(o: {
    git: GitRun;
    gh: GhRun;
    fetchMain?: (() => void) | null;
    now?: number;
    days?: number;
  }): Pending;
  formatPending(p: Pending): string;
  takeLock(
    name: string,
    why: string,
    o?: { dir?: string; pid?: number; alive?: (pid: number) => boolean },
  ): () => void;
  takeSlot(
    o: { slot?: number; slotGiven?: boolean },
    deps?: { dir?: string; pid?: number; alive?: (pid: number) => boolean },
  ): { slot: number; release: () => void };
  args(argv: string[]): { timeoutMin: number; stallMin: number; budgetSec?: number };
  discussionBudgetSec(o: { timeoutMin: number; budgetSec?: number }): number;
  reviewPr(o: {
    o: { authorFamily: string; timeoutMin: number; ui: boolean; noPost?: boolean };
    repo: string;
    pr: number;
    log: (s: string) => void;
    deps: ReviewDeps;
  }): Promise<number>;
}
interface FakeProfile {
  family: string;
  agent: string;
  model: string | null;
  route: 'cloud' | 'local' | null;
}
interface SessionView {
  phase: string | null;
  text: string;
  toolCalls: number;
  error: string | null;
  incomplete: boolean;
  model: string | null;
  interactions: unknown[];
  updatedAt: unknown;
}
interface PollIo {
  readView(url: string, sessionKey: string): Promise<SessionView | null>;
  stop(url: string, sessionKey: string): Promise<void>;
  relayUsage(url: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
interface ProfilesLib {
  FAMILY_ORDER: string[];
  PROFILES: Record<string, FakeProfile>;
  withFallback(
    chain: FakeProfile[],
    log: (s: string) => void,
    run: (p: FakeProfile, remainingMs: number | undefined) => Promise<{ text: string }>,
    opts?: { budgetMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<{ text: string; profile: FakeProfile }>;
}
interface SessionsLib {
  pollSession(o: {
    profile: FakeProfile;
    url: string;
    sessionKey: string;
    since: number;
    timeoutMin: number;
    pollMs: number;
    log: (s: string) => void;
    before: number | null;
    secs: () => string;
    stallMin?: number;
    io: PollIo;
  }): Promise<{ text: string; sessionKey: string }>;
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
const profilesLib = (await load('so-profiles.mjs')) as ProfilesLib;
const sessionsLib = (await load('so-sessions.mjs')) as SessionsLib;
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

  it('【故意造出的失败】从工作树里调用：审查树仍建在主检出下，不往工作树里套', () => {
    // 起因（2026-10-05）：指挥官一边派工一边审 PR，脚本从某棵工作树里跑，审查树就建成了
    // `…/820-env-page/.claude/worktrees/second-opinion` 的嵌套检出——它带着自己那份 biome.json，
    // biome 整仓扫一遍报「nested root configuration」，把这台机器上所有会话的推送全拦了；
    // 清扫规则又按名字跳过 `second-opinion*`，谁也收不走。这条钉住「认主检出、不认当前检出」。
    const main = temp('main');
    const git = (...args: string[]) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', main);
    // CI 的 runner 上没有全局 git 身份，不带这两行 commit 会以「empty ident name」失败
    git('-C', main, 'config', 'user.email', 'a@b.c');
    git('-C', main, 'config', 'user.name', 't');
    git('-C', main, 'commit', '-q', '--allow-empty', '-m', '底');
    const sub = join(main, '.claude', 'worktrees', 'w');
    git('-C', main, 'worktree', 'add', '-q', '--detach', sub, 'HEAD');

    const at = so.mainCheckout(sub);
    // 比 basename、不比整串：这台机器上 `C:\Users\ADMINI~1` 和 `C:\Users\Administrator` 是同一处的长短两种写法，
    // 临时目录给的是短名、git 报的是长名，比整串会红在一个和被测逻辑无关的地方（realpathSync 也不归一这两种）。
    expect(basename(at)).toBe(basename(main));
    expect(at.replace(/\\/g, '/')).not.toContain('/worktrees/'); // 不往工作树里套
    expect(statSync(join(at, '.git')).isDirectory()).toBe(true); // 主检出的 .git 是目录；工作树里那份是个文件
  });

  it('不给 --repo、当前目录又不是 git 检出：没查成，不猜是哪个仓', () => {
    const r = run('second-opinion.mjs', ['--pr', '5', '--high-risk'], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('认不出要审的是哪个仓');
  });

  // 会话是一次性的（#654 F2 之外的另一件，创始人 2026-10-03 要求）：列会话、清旧会话是本机命令，
  // 这台没装 Mirasim 时照实报「没装」、退出 2，不打印空表冒充「一个会话也没有」。
  it('--sessions：这台没装 Mirasim 时退出 2，写明没装（不打印空表）', () => {
    const r = run('second-opinion.mjs', ['--sessions'], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 Mirasim');
    expect(r.out).not.toContain('一个会话也没有');
  });

  it('--stop-stale：这台没装 Mirasim 时退出 2，不报「清掉 0 个」', () => {
    const r = run('second-opinion.mjs', ['--stop-stale'], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 Mirasim');
    expect(r.out).not.toContain('清掉');
  });

  it('--keep-session 认得出（不是不认识的参数）', () => {
    // 不带 Mirasim 时不至于报「不认识的参数 --keep-session」；它只影响跑完删不删会话
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'keep', '--author-family', 'gpt', '--keep-session'],
      { home: temp('home') },
    );
    expect(r.err).not.toContain('不认识的参数');
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

  it('贴 PR 的正文去掉过程话、带着头、第一行是脚本的结论；本机目录换成仓内相对路径', () => {
    const parsed = so.parseReview(
      '我先读规矩……\n## 必须改\n- 【现实】【其他】`a.ts:1` 问题\n结论：必须改 1 条',
    );
    if (!parsed.ok) throw new Error(parsed.why);
    const c = so.prComment({
      judged: so.judgeReview(parsed, 1),
      head: 'abcdef1234',
      model: 'm',
      body: parsed.body,
    });
    expect(c).not.toContain('我先读规矩');
    expect(c).toContain('## 必须改');
    expect(c).toMatch(/^\*\*第二意见 第 1 轮\*\*（m；审的头 abcdef1）：必须改 1 条\n/);
    expect(c).toContain('脚本判定');
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
  it('族顺序：gpt（gpt-6-luna）第一，grok 第二，其余排后面兜底（创始人 2026-10-05：第二意见太慢了，优先 gpt6luna，不行就 grok）', () => {
    expect(profilesLib.FAMILY_ORDER).toEqual(['gpt', 'grok', 'claude', 'deepseek', 'kimi']);
    expect(so.discussionProfiles({ authorFamily: 'kimi' }).map((p) => p.family)).toEqual([
      'gpt',
      'grok',
      'claude',
      'deepseek',
    ]);
    expect(so.discussionProfiles({ authorFamily: 'kimi' })[0]?.model).toBe('gpt-6-luna');
  });

  it('作者是 GPT 时跳过 GPT，grok 顶上第一，再是 Claude、DeepSeek、Kimi', () => {
    expect(so.discussionProfiles({ authorFamily: 'gpt' }).map((p) => p.family)).toEqual([
      'grok',
      'claude',
      'deepseek',
      'kimi',
    ]);
  });

  it('作者是非 GPT 时默认 GPT 首选、Grok 第二', () => {
    expect(so.discussionProfiles({ authorFamily: 'claude' }).map((p) => p.family)).toEqual([
      'gpt',
      'grok',
      'deepseek',
      'kimi',
    ]);
  });

  it('作者族可以是多个，所有同族都跳过', () => {
    expect(so.discussionProfiles({ authorFamily: 'gpt,deepseek' }).map((p) => p.family)).toEqual([
      'grok',
      'claude',
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

describe('不出声就换下一家（创始人 2026-10-05：第二意见太慢了，优先 gpt6luna，不行就 grok）', () => {
  const MIN = 60_000;
  const NOW = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  // 假钟：sleep 一下钟就走一下，测试不真等 4 分钟
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  const view = (o: Partial<SessionView> = {}): SessionView => ({
    phase: 'streaming',
    text: '',
    toolCalls: 0,
    error: null,
    incomplete: false,
    model: null,
    interactions: [],
    updatedAt: 1,
    ...o,
  });
  // 账本只对走中继的算数；假会话不落账本，两家都按本地路由算
  const local = (family: string): FakeProfile => ({
    ...(profilesLib.PROFILES[family === 'gpt' ? 'code' : family] as FakeProfile),
    route: 'local',
  });

  it('默认值：整轮总上限 15 分钟、不出声 4 分钟换下一家；--text 不再单独压成 0.5 分钟，和 --pr 同一套规则', () => {
    const a = so.args([]);
    expect(a.timeoutMin).toBe(15);
    expect(a.stallMin).toBe(4);
    expect(so.args(['--stall-min', '2']).stallMin).toBe(2);
    expect(so.args(['--timeout-min', '20']).timeoutMin).toBe(20);
    // --text 的整轮预算：没给 --budget-sec 就是 timeoutMin 那一套（15 分钟），给了照给的
    expect(so.discussionBudgetSec(a)).toBe(15 * 60);
    expect(so.discussionBudgetSec(so.args(['--timeout-min', '20']))).toBe(20 * 60);
    expect(so.discussionBudgetSec(so.args(['--budget-sec', '30']))).toBe(30);
  });

  it('gpt 起了会话一直不出声：4 分钟（假钟）后停掉它、日志写明换 grok，grok 接着出结论', async () => {
    const c = clock();
    const logs: string[] = [];
    const stopped: string[] = [];
    let grokStartedAt = -1;
    let grokPolls = 0;
    const io: PollIo = {
      ...c,
      readView: async (_url, key) => {
        if (key.startsWith('codex:')) return view({ model: 'gpt-6-luna' }); // 一直是同一帧：没有任何新输出
        if (grokStartedAt < 0) grokStartedAt = c.now();
        grokPolls++;
        return grokPolls < 3
          ? view({ text: 'x'.repeat(grokPolls * 40), updatedAt: grokPolls })
          : view({ phase: 'done', text: '结论：通过', updatedAt: grokPolls });
      },
      stop: async (_url, key) => void stopped.push(key),
      relayUsage: async () => null,
    };
    const chain = profilesLib.FAMILY_ORDER.slice(0, 2).map(local);
    const r = await profilesLib.withFallback(
      chain,
      (s) => logs.push(s),
      (p) =>
        sessionsLib.pollSession({
          profile: p,
          url: 'ws://fake',
          sessionKey: `${p.agent}:fake-${p.family}`,
          since: c.now(),
          timeoutMin: 15,
          pollMs: 10_000,
          log: (s) => logs.push(s),
          before: null,
          secs: () => NOW(c.now()),
          stallMin: 4,
          io,
        }),
    );
    expect(r.profile.family).toBe('grok');
    expect(r.text).toBe('结论：通过');
    expect(stopped).toEqual(['codex:fake-gpt']);
    expect(logs.join('\n')).toContain('gpt 4 分钟没出声，换 grok');
    // 是在 4 分钟之后、不是 10 分钟之后换的
    expect(grokStartedAt).toBeGreaterThan(4 * MIN);
    expect(grokStartedAt).toBeLessThan(5 * MIN);
  });

  describe('启动没成的 incomplete（#1056：codex 中继撞上状态库补数据，16 秒就收尾、还没开始审）', () => {
    const BACKFILL =
      'state db backfill is running at C:\\Users\\Administrator\\.mirasim\\agent-homes\\codex-relay; waiting up to 30s before retrying startup initialization';
    // 第 N 次起的 codex 会话（会话号尾巴 -N）按 gptAnswers[N-1] 回；grok 一律出结论
    const setup = (gptAnswers: SessionView[]) => {
      const c = clock();
      const logs: string[] = [];
      const started: string[] = [];
      const waits: number[] = [];
      let gptSessions = 0;
      const io: PollIo = {
        ...c,
        readView: async (_url, key) => {
          if (key.startsWith('codex:')) return gptAnswers[Number(key.split('-').at(-1)) - 1] ?? view();
          return view({ phase: 'done', text: '结论：通过 grok', updatedAt: 9 });
        },
        stop: async () => {},
        relayUsage: async () => null,
      };
      const run = (p: FakeProfile) => {
        const key = p.agent === 'codex' ? `codex:fake-${++gptSessions}` : `${p.agent}:fake-grok`;
        started.push(p.family);
        return sessionsLib.pollSession({
          profile: p,
          url: 'ws://fake',
          sessionKey: key,
          since: c.now(),
          timeoutMin: 15,
          pollMs: 10_000,
          log: (s) => logs.push(s),
          before: null,
          secs: () => NOW(c.now()),
          stallMin: 4,
          io,
        });
      };
      const chain = profilesLib.FAMILY_ORDER.slice(0, 2).map(local);
      const go = () =>
        profilesLib.withFallback(chain, (s) => logs.push(s), run, {
          sleep: async (ms) => {
            waits.push(ms);
            await c.sleep(ms);
          },
        });
      return { go, logs, started, waits };
    };
    const startFailed = (error: string): SessionView =>
      view({ phase: 'done', incomplete: true, error, updatedAt: 2 });

    it('第一次回「状态库补数据」的 incomplete、第二次出结论：等 30 秒在同一家重试，结论来自 gpt，没换 grok', async () => {
      const t = setup([startFailed(BACKFILL), view({ phase: 'done', text: '结论：通过 gpt', updatedAt: 3 })]);
      const r = await t.go();
      expect(r.profile.family).toBe('gpt');
      expect(r.text).toBe('结论：通过 gpt');
      expect(t.started).toEqual(['gpt', 'gpt']);
      expect(t.waits).toEqual([30_000]);
      const text = t.logs.join('\n');
      expect(text).toContain('30 秒后在同一家重试（第 1/2 次）');
      expect(text).not.toContain('换下一家');
    });

    it('一直是这种 incomplete：同一家共试 3 次（重试 2 次）、等两个 30 秒，然后才换 grok', async () => {
      const t = setup([startFailed(BACKFILL), startFailed(BACKFILL), startFailed(BACKFILL)]);
      const r = await t.go();
      expect(r.profile.family).toBe('grok');
      expect(t.started).toEqual(['gpt', 'gpt', 'gpt', 'grok']);
      expect(t.waits).toEqual([30_000, 30_000]);
      expect(t.logs.join('\n')).toContain('（第 2/2 次）');
      expect(t.logs.join('\n')).toContain('没查成');
    });

    it('认不出的 incomplete（模型满载）照旧算没查成：不重试、直接换 grok', async () => {
      const t = setup([startFailed('Selected model is at capacity. Please try a different model.')]);
      const r = await t.go();
      expect(r.profile.family).toBe('grok');
      expect(t.started).toEqual(['gpt', 'grok']);
      expect(t.waits).toEqual([]);
    });
  });

  it('一直有新输出就不算没出声：慢但在写的会话不会被换掉', async () => {
    const c = clock();
    let n = 0;
    const io: PollIo = {
      ...c,
      readView: async () => {
        n++;
        // 每 10 秒多一点字，共 30 轮（5 分钟），比 4 分钟还长
        return n < 30
          ? view({ text: 'x'.repeat(n), updatedAt: n })
          : view({ phase: 'done', text: '结论：通过', updatedAt: n });
      },
      stop: async () => {
        throw new Error('不该停');
      },
      relayUsage: async () => null,
    };
    const r = await sessionsLib.pollSession({
      profile: local('grok'),
      url: 'ws://fake',
      sessionKey: 'grok:fake',
      since: 0,
      timeoutMin: 15,
      pollMs: 10_000,
      log: () => {},
      before: null,
      secs: () => NOW(c.now()),
      stallMin: 4,
      io,
    });
    expect(r.text).toBe('结论：通过');
    expect(c.now()).toBeGreaterThan(4 * MIN);
  });

  it('每家都不出声：逐家 4 分钟换下去，最后一家后面写没有下一家，整轮仍照实报没查成', async () => {
    const c = clock();
    const logs: string[] = [];
    const io: PollIo = {
      ...c,
      readView: async () => view(),
      stop: async () => {},
      relayUsage: async () => null,
    };
    const chain = profilesLib.FAMILY_ORDER.slice(0, 2).map(local);
    await expect(
      profilesLib.withFallback(
        chain,
        (s) => logs.push(s),
        (p) =>
          sessionsLib.pollSession({
            profile: p,
            url: 'ws://fake',
            sessionKey: `${p.agent}:fake-${p.family}`,
            since: c.now(),
            timeoutMin: 15,
            pollMs: 10_000,
            log: () => {},
            before: null,
            secs: () => NOW(c.now()),
            stallMin: 4,
            io,
          }),
      ),
    ).rejects.toThrow('候选的几家全没成');
    const text = logs.join('\n');
    expect(text).toContain('gpt 4 分钟没出声，换 grok');
    expect(text).toContain('grok 4 分钟没出声，后面没有下一家了');
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

// ---------- 审 PR 走整条路（挡不挡的细则钉在 rules/second-opinion-verdict.rules.test.ts；这里看它真落到状态和评论上） ----------

const g = (cwd: string, ...a: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

/** 假的卫生检查（贴评论前要过它）：只认 LEAKED-TOKEN 这个字串 */
const FAKE_SCAN = [
  'export function scanFiles(paths, read) {',
  "  const text = read(paths[0]).toString('utf8');",
  "  const findings = text.includes('LEAKED-TOKEN') ? [{ rule: 'token' }] : [];",
  '  return { binary: [], scanned: paths, findings };',
  '}',
  'export function formatFinding(f) { return f.rule; }',
  '',
].join('\n');

/** 一个带 origin 的检出：origin 是本地裸仓，main 一个提交，refs/pull/5/head 再多一个提交（PR #5 的头） */
function prWorld(): { repo: string; head: string } {
  const root = temp('pr');
  const origin = join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  g(root, 'clone', '-q', origin, seed);
  mkdirSync(join(seed, 'packages', 'hygiene', 'src'), { recursive: true });
  writeFileSync(join(seed, 'packages', 'hygiene', 'src', 'scan.ts'), FAKE_SCAN);
  writeFileSync(join(seed, 'a.ts'), 'export const a = 1;\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', 'base');
  g(seed, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(seed, 'a.ts'), 'export const a = 2;\n');
  g(seed, 'commit', '-q', '-am', 'change');
  g(seed, 'push', '-q', 'origin', 'HEAD:refs/pull/5/head');
  const head = g(seed, 'rev-parse', 'HEAD');
  const repo = join(root, 'repo');
  g(root, 'clone', '-q', origin, repo);
  return { repo, head };
}

/** 进程内的假 gh：审 PR 要的那几条各回一份固定答案；写出去的（评论、状态）记在 posted，评论正文记在 comment */
function fakeGh(o: { pr: object; comments?: string[] | 'broken'; statuses?: object[] | 'broken' }) {
  const posted: string[][] = [];
  const got = { comment: '' };
  const gh: GhRun = (a) => {
    const line = a.join(' ');
    if (a[0] === 'pr' && a[1] === 'view') return JSON.stringify(o.pr);
    if (a[0] === 'api' && a[1] === '--paginate') {
      if (o.comments === 'broken')
        throw Object.assign(new Error('gh: HTTP 500'), { stderr: 'gh: HTTP 500\n' });
      return (o.comments ?? []).map((c) => JSON.stringify(c)).join('\n');
    }
    if (a[0] === 'api' && a[1] === '-X') {
      posted.push(a);
      const at = a.find((x) => x.startsWith('body=@'));
      if (at) got.comment = readFileSync(at.slice('body=@'.length), 'utf8');
      return line.includes('/comments') ? 'https://example.invalid/c/1' : '{}';
    }
    if (a[0] === 'api') {
      if (o.statuses === 'broken')
        throw Object.assign(new Error('gh: HTTP 502'), { stderr: 'gh: HTTP 502\n' });
      return JSON.stringify(o.statuses ?? []);
    }
    throw new Error(`假 gh 不认识：${line}`);
  };
  return { gh, posted, got };
}

describe('审 PR 走整条路（假 gh、假会话、真 git）：状态按脚本的判定写，不按审的人的结论', {
  timeout: 120_000,
}, () => {
  const prInfo = (head: string, state = 'OPEN') => ({
    headRefOid: head,
    baseRefName: 'main',
    title: 't',
    body: '',
    files: [{ path: 'a.ts' }],
    state,
    mergeCommit: state === 'MERGED' ? { oid: 'ad8f8d1aa063670173a310ddecc58d0d21f62090' } : null,
  });
  const session =
    (text: string): ReviewDeps['session'] =>
    async () => ({ text, sessionKey: 'fake:1', model: 'fake-model', ledgerNote: '假会话', usage: '0 秒' });
  const o = { authorFamily: 'gpt', timeoutMin: 1, ui: false };
  const statusPost = (posted: string[][]) => posted.find((a) => a.some((x) => x.includes('/statuses/')));
  const descOf = (a: string[] | undefined) =>
    a?.find((x) => x.startsWith('description='))?.slice('description='.length);
  const review = (mustFix: string, conclusion: string) =>
    `## 必须改\n- ${mustFix}\n## 小毛病\n无\n结论：${conclusion}`;

  it('【故意造出的失败】审的人结论写「通过」却列了【现实】必须改：退出 1，头上写 failure、评论第一行是脚本的结论', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head) });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: {
        gh: f.gh,
        session: session(review('【现实】【其他】`a.ts:1` 读不到就回空', '通过')),
        runs: temp('runs'),
      },
    });
    expect(code).toBe(1);
    const st = statusPost(f.posted);
    expect(st).toContain('state=failure');
    expect(st).toContain(`repos/{owner}/{repo}/statuses/${w.head}`);
    expect(descOf(st)).toBe('第二意见第 1 轮：必须改 1 条（【现实】【其他】1）');
    expect(f.got.comment).toMatch(
      /^\*\*第二意见 第 1 轮\*\*（fake-model；审的头 [0-9a-f]{7}）：必须改 1 条\n/,
    );
    expect(f.got.comment).toContain('审的人结论写「通过」');
    expect(f.got.comment).toContain('这个 PR 之前审完过 0 轮，这是第 1 轮');
  });

  it('【故意造出的失败】结果格式认不出（没有「必须改」段）：退出 2，不写状态、不贴评论', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head) });
    const logs: string[] = [];
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: (s) => logs.push(s),
      deps: { gh: f.gh, session: session('看起来没问题\n结论：通过'), runs: temp('runs') },
    });
    expect(code).toBe(2);
    expect(f.posted).toEqual([]);
    expect(logs.join('\n')).toContain('没查成：审的结果没有「## 必须改」这一段');
  });

  it('整轮总上限：第一家用掉了整轮预算，不再起下一家，照实报没查成（不是每家各给一份 45 分钟）', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head) });
    const asked: number[] = [];
    const slow: ReviewDeps['session'] = async (opts) => {
      asked.push((opts as { timeoutMin: number }).timeoutMin);
      await new Promise((r) => setTimeout(r, 300));
      throw new (await import(pathToFileURL(join(SCRIPTS, 'so-common.mjs')).href)).NotChecked('假的：没答完');
    };
    await expect(
      so.reviewPr({
        o: { ...o, timeoutMin: 0.004 }, // 0.24 秒
        repo: w.repo,
        pr: 5,
        log: () => {},
        deps: { gh: f.gh, session: slow, runs: temp('runs') },
      }),
    ).rejects.toThrow('总预算已用完');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeLessThanOrEqual(0.004);
  });

  it('第 3 轮（PR 上已经贴过两轮结论，头换没换都算）：【现实】【其他】转合并后、写 success，评论里列出来', async () => {
    const w = prWorld();
    const prior = '**第二意见 第 1 轮**（m；审的头 abcdef1）：必须改 1 条\n\n## 必须改\n…';
    const f = fakeGh({
      pr: prInfo(w.head),
      comments: [prior, '别的评论', prior.replace('abcdef1', 'bbbbbbb')],
    });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: {
        gh: f.gh,
        session: session(review('【现实】【其他】`a.ts:1` 问题', '必须改 1 条')),
        runs: temp('runs'),
      },
    });
    expect(code).toBe(0);
    const st = statusPost(f.posted);
    expect(st).toContain('state=success');
    expect(descOf(st)).toBe('第二意见通过（第 3 轮；1 条转合并后处理）');
    expect(f.got.comment).toMatch(/^\*\*第二意见 第 3 轮\*\*/);
    expect(f.got.comment).toContain('转合并后处理 1 条');
  });

  it('【故意造出的失败】读不到 PR 上的评论：按第 1 轮算（第 3 轮的宽松不生效），评论里写明轮数没数成', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head), comments: 'broken' });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: {
        gh: f.gh,
        session: session(review('【现实】【其他】`a.ts:1` 问题', '必须改 1 条')),
        runs: temp('runs'),
      },
    });
    expect(code).toBe(1);
    expect(descOf(statusPost(f.posted))).toBe('第二意见第 1 轮：必须改 1 条（【现实】【其他】1）');
    expect(f.got.comment).toContain('轮数没数成（读不到 PR 上已有的评论：gh: HTTP 500），按第 1 轮算');
  });

  it('已经合并的 PR 也能审（合并后补审）：没过时退出 1，状态、评论、输出都说开修复 PR 或 revert 合并提交', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head, 'MERGED') });
    const said: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      said.push(a.map(String).join(' '));
    });
    let code: number;
    try {
      code = await so.reviewPr({
        o,
        repo: w.repo,
        pr: 5,
        log: () => {},
        deps: {
          gh: f.gh,
          session: session(review('【现实】【碰安全】`a.ts:1` 令牌打进日志', '必须改 1 条')),
          runs: temp('runs'),
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(descOf(statusPost(f.posted))).toBe(
      '合并后补审没过第 1 轮：必须改 1 条，开修复 PR 或 revert（【现实】【碰安全】1）',
    );
    expect(f.got.comment).toMatch(/^\*\*合并后补审 第 1 轮\*\*/);
    expect(f.got.comment).toContain('git revert ad8f8d1');
    expect(said.join('\n')).toContain(
      '合并后补审没过：开修复 PR，或 git revert ad8f8d1；修复合了跑 --after-merge-resolve 5',
    );
  });

  it('关掉了没合并的 PR 不审；通过的写 success', async () => {
    const w = prWorld();
    const closed = fakeGh({ pr: prInfo(w.head, 'CLOSED') });
    await expect(
      so.reviewPr({
        o,
        repo: w.repo,
        pr: 5,
        log: () => {},
        deps: { gh: closed.gh, session: session(''), runs: temp('runs') },
      }),
    ).rejects.toThrow('关掉了、没合并');
    const f = fakeGh({ pr: prInfo(w.head) });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: {
        gh: f.gh,
        session: session('## 必须改\n无\n## 小毛病\n- `a.ts:1` 名字拼错\n结论：通过'),
        runs: temp('runs'),
      },
    });
    expect(code).toBe(0);
    expect(descOf(statusPost(f.posted))).toBe('第二意见通过（第 1 轮）');
  });

  // #1003：同一个头 ec120f6 隔 42 秒审了两轮，结论一样，白占一轮，还把轮数推到放宽门槛的第 3 轮。
  // 同一个头只审一次：头上已有本脚本贴的结论就复用那次的结论和退出码，不起会话、不贴评论、不加轮数。
  const noSession: ReviewDeps['session'] = async () => {
    throw new Error('同一个头不该再起审');
  };
  const postedOn = (head: string, verdict: string, round = 1) =>
    `**第二意见 第 ${round} 轮**（m；审的头 ${head.slice(0, 7)}）：${verdict}\n\n## 必须改\n…`;

  it('【故意造出的失败】同一个头已经贴过「必须改」：不起会话、不贴评论，照那次退出 1（重跑撞不出随机的通过）', async () => {
    const w = prWorld();
    const f = fakeGh({
      pr: prInfo(w.head),
      comments: [postedOn(w.head, '必须改 1 条')],
      statuses: [
        { context: 'second-opinion', state: 'failure', description: '第二意见第 1 轮：必须改 1 条' },
      ],
    });
    const logs: string[] = [];
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: (s) => logs.push(s),
      deps: { gh: f.gh, session: noSession, runs: temp('runs') },
    });
    expect(code).toBe(1);
    expect(f.posted).toEqual([]);
    expect(logs.join('\n')).toContain(`头 ${w.head.slice(0, 7)} 上已经有本脚本贴的结论`);
  });

  it('同一个头贴过「通过」但状态没写上：不再审，照那次的结论补写 success、退出 0，不另贴评论', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head), comments: [postedOn(w.head, '通过', 2)] });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: { gh: f.gh, session: noSession, runs: temp('runs') },
    });
    expect(code).toBe(0);
    expect(f.posted.filter((a) => a.some((x) => x.includes('/comments')))).toEqual([]);
    const st = statusPost(f.posted);
    expect(st).toContain('state=success');
    expect(st).toContain(`repos/{owner}/{repo}/statuses/${w.head}`);
    expect(descOf(st)).toMatch(/^第二意见通过（第 2 轮；/);
  });

  it('【故意造出的失败】复用时读不到头上的提交状态：退出 2，不当通过', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head), comments: [postedOn(w.head, '通过')], statuses: 'broken' });
    const logs: string[] = [];
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: (s) => logs.push(s),
      deps: { gh: f.gh, session: noSession, runs: temp('runs') },
    });
    expect(code).toBe(2);
    expect(f.posted).toEqual([]);
    expect(logs.join('\n')).toContain('gh: HTTP 502');
  });

  it('头变了才加轮：别的头上贴过一轮，这个新头照常审、是第 2 轮', async () => {
    const w = prWorld();
    const f = fakeGh({ pr: prInfo(w.head), comments: [postedOn('abcdef1', '必须改 1 条')] });
    const code = await so.reviewPr({
      o,
      repo: w.repo,
      pr: 5,
      log: () => {},
      deps: {
        gh: f.gh,
        session: session('## 必须改\n无\n## 小毛病\n无\n结论：通过'),
        runs: temp('runs'),
      },
    });
    expect(code).toBe(0);
    expect(f.got.comment).toMatch(/^\*\*第二意见 第 2 轮\*\*/);
    expect(descOf(statusPost(f.posted))).toBe('第二意见通过（第 2 轮）');
  });
});

describe('锁按 PR 号：同一 PR 只跑一轮，不同 PR 并行', () => {
  it('两个不同 PR 的锁互不影响；同一 PR 第二个被拒；放了锁、拿锁的进程死了就能再拿', () => {
    const dir = temp('locks');
    const alive = (pid: number) => pid === 100 || pid === 200;
    const release = so.takeLock('pr5', 'PR #5 另一轮第二意见在跑', { dir, pid: 100, alive });
    expect(() => so.takeLock('pr6', 'PR #6 另一轮第二意见在跑', { dir, pid: 200, alive })).not.toThrow();
    expect(() => so.takeLock('pr5', 'PR #5 另一轮第二意见在跑', { dir, pid: 300, alive })).toThrow(
      'PR #5 另一轮第二意见在跑（进程 100），等它跑完',
    );
    release();
    expect(() => so.takeLock('pr5', 'PR #5 另一轮第二意见在跑', { dir, pid: 300, alive })).not.toThrow();
    // 陈旧锁：拿着的进程已经不在了，直接盖掉
    writeFileSync(join(dir, '.lock-pr7'), '99999');
    expect(() => so.takeLock('pr7', 'x', { dir, pid: 300, alive })).not.toThrow();
    expect(readFileSync(join(dir, '.lock-pr7'), 'utf8')).toBe('300');
  });

  it('审查树的位子：没指定就挑第一个空的；四棵都占着照实报；指定的被占就报那一个', () => {
    const dir = temp('slots');
    const alive = () => true;
    expect(so.takeSlot({}, { dir, pid: 1, alive }).slot).toBe(1);
    expect(so.takeSlot({}, { dir, pid: 2, alive }).slot).toBe(2);
    expect(() => so.takeSlot({ slot: 1, slotGiven: true }, { dir, pid: 3, alive })).toThrow(
      '审查树 1 另一轮在用（进程 1），等它跑完',
    );
    so.takeSlot({}, { dir, pid: 3, alive });
    so.takeSlot({}, { dir, pid: 4, alive });
    expect(() => so.takeSlot({}, { dir, pid: 5, alive })).toThrow('四棵审查树都有人在用');
    expect(() => so.takeSlot({ slot: 9, slotGiven: true }, { dir, pid: 5, alive })).toThrow(
      '--slot 只能是 1–4',
    );
  });
});

// ---------- 合并后补审：哪些 PR 待补审（主线清单 + git log + GitHub 的 PR 和状态） ----------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const CI_PLAN = 'packages/conventions/src/ci-plan.ts';
const BIN_CI_PLAN = 'packages/conventions/src/bin/ci-plan.ts';
/** 假清单：两条标了先合后审（其中一条比目录规则更具体），两条没标 */
const LIST = JSON.stringify({
  paths: [
    { path: CI_PLAN, kind: '碰安全', why: 'x', review: 'after-merge' },
    { path: 'packages/conventions/src/bin/', kind: '碰安全', why: 'x' },
    { path: BIN_CI_PLAN, kind: '碰安全', why: 'x', review: 'after-merge' },
    { path: 'packages/conventions/src/merge-gate.ts', kind: '碰安全', why: 'x' },
  ],
});
/** git log -z --name-status 的原样输出：A 改了 ci-plan.ts，B 只改 README，C 把 old.ts 改名成 bin/ci-plan.ts */
const NAME_STATUS = [
  `\u0001${SHA_A} 2026-10-03T14:20:44Z\0\nM\0${CI_PLAN}\0M\0docs/a.md\0`,
  `\u0001${SHA_B} 2026-10-02T10:00:00+08:00\0\nM\0README.md\0`,
  `\u0001${SHA_C} 2026-10-01T10:00:00Z\0\nR100\0old.ts\0${BIN_CI_PLAN}\0`,
].join('');

function fakeGit(o: { list?: string; intro?: string; log?: string; count?: string }) {
  const calls: string[][] = [];
  const git: GitRun = (a) => {
    calls.push(a);
    if (a[0] === 'show') {
      if (o.list === undefined)
        throw Object.assign(new Error('git show'), {
          stderr: "fatal: path 'packages/conventions/high-risk-paths.json' does not exist in 'origin/main'\n",
        });
      return o.list;
    }
    if (a.includes('-S')) return o.intro ?? '';
    if (a.includes('--name-status')) return o.log ?? '';
    if (a[0] === 'rev-list') return o.count ?? '0';
    throw new Error(`假 git 不认识 ${a.join(' ')}`);
  };
  return { git, calls };
}

/** 假的 gh api graphql：按查询里 cN 对应的提交号回给定的 PR 列表（null = GitHub 上没这个提交） */
function fakeGraphql(bySha: Record<string, object[] | null>) {
  const calls: string[][] = [];
  const gh: GhRun = (a) => {
    calls.push(a);
    const q = a.find((x) => x.startsWith('query='))?.slice('query='.length) ?? '';
    const repository: Record<string, unknown> = {};
    for (const m of q.matchAll(/(c\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
      const nodes = bySha[m[2] ?? ''];
      repository[m[1] ?? ''] = nodes === null ? null : { associatedPullRequests: { nodes: nodes ?? [] } };
    }
    return JSON.stringify({ data: { repository } });
  };
  return { gh, calls };
}

const prNode = (
  number: number,
  mergeCommit: string,
  state: string | null,
  head = String(number).padStart(40, '0'),
) => ({
  number,
  title: `t${number}`,
  state: 'MERGED',
  mergedAt: '2026-10-03T10:00:00Z',
  headRefOid: head,
  baseRefName: 'main',
  mergeCommit: { oid: mergeCommit },
  commits: {
    nodes: [
      {
        commit: {
          oid: head,
          status: state === null ? null : { context: { state, description: `${state} desc` } },
        },
      },
    ],
  },
});
const INTRO = `${'d'.repeat(40)} 2026-09-30T16:00:00Z`;
const NOW = Date.parse('2026-10-04T00:00:00Z');

describe('合并后补审：待补审的怎么算', () => {
  it('清单：标了 review: after-merge 的认得出；不是 JSON、没有 paths、缺 path、review 写错都读不出', () => {
    const rules = so.riskRules(LIST);
    expect(rules).toEqual([
      { path: CI_PLAN, afterMerge: true },
      { path: 'packages/conventions/src/bin/', afterMerge: false },
      { path: BIN_CI_PLAN, afterMerge: true },
      { path: 'packages/conventions/src/merge-gate.ts', afterMerge: false },
    ]);
    expect(so.riskRules('{')).toMatch(/不是合法的 JSON/);
    expect(so.riskRules('{"paths":[]}')).toMatch(/没有 paths 列表/);
    expect(so.riskRules('{"paths":[{"kind":"碰安全"}]}')).toMatch(/第 1 条认不出/);
    expect(so.riskRules('{"paths":[{"path":"a.ts","review":"later"}]}')).toMatch(/review「later」认不出/);
  });

  it('改到的文件按最具体的那条规则算；改名的旧名字也算', () => {
    const rules = so.riskRules(LIST);
    if (typeof rules === 'string') throw new Error(rules);
    expect(so.afterMergeHits([{ path: CI_PLAN }, { path: 'README.md' }], rules)).toEqual([CI_PLAN]);
    expect(so.afterMergeHits([{ path: 'packages/conventions/src/merge-gate.ts' }], rules)).toEqual([]);
    // 目录规则没标、里面更具体的那条标了：按具体的
    expect(
      so.afterMergeHits([{ path: BIN_CI_PLAN }, { path: 'packages/conventions/src/bin/ci-box.ts' }], rules),
    ).toEqual([BIN_CI_PLAN]);
    expect(so.afterMergeHits([{ path: 'x.ts', previous: CI_PLAN }], rules)).toEqual([CI_PLAN]);
  });

  it('git log 的输出：每个提交改了哪些文件（改名带旧名字）；【故意造出的失败】认不出就抛，不当成没改', () => {
    const commits = so.parseNameStatusLog(NAME_STATUS);
    expect(commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B, SHA_C]);
    expect(commits[0]?.files).toEqual([{ path: CI_PLAN }, { path: 'docs/a.md' }]);
    expect(commits[2]?.files).toEqual([{ path: BIN_CI_PLAN, previous: 'old.ts' }]);
    expect(so.parseNameStatusLog('')).toEqual([]);
    expect(() => so.parseNameStatusLog('\u0001not-a-sha\0\nM\0a\0')).toThrow(/认不出/);
    expect(() => so.parseNameStatusLog(`\u0001${SHA_A} 2026-10-03T14:20:44Z\0\nZ\0a\0`)).toThrow(/认不出/);
    expect(() => so.parseNameStatusLog(`\u0001${SHA_A} 2026-10-03T14:20:44Z\0\nR100\0a\0`)).toThrow(
      /少了文件名/,
    );
  });

  it('对到 PR 上按头上的 second-opinion 分：通过、没过、还没审；对不上 PR 的、GitHub 上没有的记进 problems', () => {
    const r = so.classifyAfterMerge(
      [
        { sha: SHA_A, hits: [CI_PLAN] },
        { sha: SHA_B, hits: [BIN_CI_PLAN] },
        { sha: SHA_C, hits: [CI_PLAN] },
        { sha: 'e'.repeat(40), hits: [CI_PLAN] },
        { sha: 'f'.repeat(40), hits: [CI_PLAN] },
      ],
      {
        c0: { associatedPullRequests: { nodes: [prNode(10, SHA_A, 'SUCCESS')] } },
        c1: { associatedPullRequests: { nodes: [prNode(11, SHA_B, 'FAILURE')] } },
        c2: { associatedPullRequests: { nodes: [prNode(12, SHA_C, null)] } },
        c3: null,
        c4: { associatedPullRequests: { nodes: [] } },
      },
    );
    expect(r.done.map((p) => p.number)).toEqual([10]);
    expect(r.failed.map((p) => [p.number, p.description])).toEqual([[11, 'FAILURE desc']]);
    expect(r.unreviewed.map((p) => p.number)).toEqual([12]);
    expect(r.problems).toEqual([
      'eeeeeee（改到 packages/conventions/src/ci-plan.ts）：GitHub 上找不到这个提交',
      'fffffff（改到 packages/conventions/src/ci-plan.ts）：找不到合它进主线的 PR（直接推到主线的？没法按 PR 补审）',
    ]);
  });

  it('【故意造出的失败】GitHub 回的样子认不出（状态名不认识、头对不上）：抛，不当成没审', () => {
    const one = (nodes: object[]) =>
      so.classifyAfterMerge([{ sha: SHA_A, hits: [CI_PLAN] }], { c0: { associatedPullRequests: { nodes } } });
    expect(() => one([prNode(10, SHA_A, 'WEIRD')])).toThrow(/认不出/);
    const mismatch = prNode(10, SHA_A, 'SUCCESS');
    mismatch.headRefOid = '1'.repeat(40);
    expect(() => one([mismatch])).toThrow(/读不到它的头/);
    expect(() => so.classifyAfterMerge([{ sha: SHA_A, hits: [CI_PLAN] }], null)).toThrow(/认不出/);
  });

  it('整条路：主线清单 → 先合后审从哪天起 → git log → GitHub：分出通过的和还没补审的', () => {
    const git = fakeGit({ list: LIST, intro: INTRO, log: NAME_STATUS, count: '3' });
    const gh = fakeGraphql({ [SHA_A]: [prNode(10, SHA_A, 'SUCCESS')], [SHA_C]: [prNode(12, SHA_C, null)] });
    const p = so.pendingAfterMerge({ git: git.git, gh: gh.gh, now: NOW });
    expect(p.afterMergePaths).toEqual([CI_PLAN, BIN_CI_PLAN]);
    // 从标记进主线那天起算（比 14 天前晚）
    expect(p.since).toBe('2026-09-30T16:00:00.000Z');
    expect(p.done.map((x) => x.number)).toEqual([10]);
    expect(p.unreviewed.map((x) => [x.number, x.files])).toEqual([[12, [BIN_CI_PLAN]]]);
    expect(p.failed).toEqual([]);
    expect(p.problems).toEqual([]);
    // 只问了碰到先合后审路径的那两个提交，B 没问
    const q = gh.calls[0]?.find((x) => x.startsWith('query=')) ?? '';
    expect(q).toContain(SHA_A);
    expect(q).toContain(SHA_C);
    expect(q).not.toContain(SHA_B);
    expect(gh.calls[0]).toContain('owner={owner}');
    // 14 天前比标记进主线那天晚：按 14 天
    const later = so.pendingAfterMerge({
      git: fakeGit({ list: LIST, intro: INTRO, log: '', count: '0' }).git,
      gh: gh.gh,
      now: Date.parse('2026-10-20T00:00:00Z'),
    });
    expect(later.since).toBe('2026-10-06T00:00:00.000Z');
    expect(later.unreviewed).toEqual([]);
  });

  it('主线上的清单还没有先合后审的条目：待补审就是空的（不是没查成），GitHub 一次都不问', () => {
    const gh = fakeGraphql({});
    const plain = JSON.stringify({
      paths: (JSON.parse(LIST) as { paths: Array<Record<string, unknown>> }).paths.map(({ review, ...p }) => {
        void review;
        return p;
      }),
    });
    const p = so.pendingAfterMerge({ git: fakeGit({ list: plain }).git, gh: gh.gh, now: NOW });
    expect(p.note).toContain('还没有标 review: after-merge 的条目');
    expect(p.unreviewed).toEqual([]);
    expect(gh.calls).toEqual([]);
    expect(so.formatPending(p)).toBe('没有合并后待补审的：主线上的清单还没有标 review: after-merge 的条目。');
  });

  it('【故意造出的失败】读不到主线清单、清单不是 JSON、查不出哪天起、git log 对不上、GitHub 问不成、取不到主线：都抛没查成', () => {
    const gh = fakeGraphql({});
    const run = (git: ReturnType<typeof fakeGit>, extra: object = {}) =>
      so.pendingAfterMerge({ git: git.git, gh: gh.gh, now: NOW, ...extra });
    expect(() => run(fakeGit({}))).toThrow(
      /读不到主线上的 packages\/conventions\/high-risk-paths\.json（fatal: path/,
    );
    expect(() => run(fakeGit({ list: '{' }))).toThrow(/不是合法的 JSON/);
    expect(() => run(fakeGit({ list: LIST, intro: '' }))).toThrow(/查不出先合后审是哪天起的/);
    expect(() => run(fakeGit({ list: LIST, intro: INTRO, log: NAME_STATUS, count: '2' }))).toThrow(
      /输出认不出/,
    );
    const brokenGh: GhRun = () => {
      throw Object.assign(new Error('gh'), { stderr: 'error connecting to api.github.com\n' });
    };
    expect(() =>
      so.pendingAfterMerge({
        git: fakeGit({ list: LIST, intro: INTRO, log: NAME_STATUS, count: '3' }).git,
        gh: brokenGh,
        now: NOW,
      }),
    ).toThrow(/问 GitHub 这几个提交是哪个 PR 合的没成（error connecting to api\.github\.com）/);
    expect(() =>
      run(fakeGit({ list: LIST }), {
        fetchMain: () => {
          throw new Error('Could not resolve host');
        },
      }),
    ).toThrow(/取主线没成（Could not resolve host）/);
  });

  it('给人看的那几行：还没补审的带命令，没过的带 resolve 和 revert，都补过了说没有待补审的', () => {
    const base: Pending = {
      days: 14,
      afterMergePaths: [CI_PLAN],
      since: '2026-09-30T16:00:00.000Z',
      done: [],
      failed: [],
      unreviewed: [],
      problems: [],
    };
    const item = (number: number, extra: Partial<PendingPr> = {}): PendingPr => ({
      number,
      title: `t${number}`,
      mergedAt: '2026-10-03T10:00:00Z',
      head: '1'.repeat(40),
      mergeCommit: 'ad8f8d1aa063670173a310ddecc58d0d21f62090',
      files: [CI_PLAN],
      state: null,
      description: '',
      ...extra,
    });
    const text = so.formatPending({
      ...base,
      done: [item(10, { state: 'success' })],
      unreviewed: [item(12)],
      failed: [item(11, { state: 'failure', description: '合并后补审没过第 1 轮：必须改 1 条' })],
    });
    expect(text).toContain('共 3 个，补审通过 1 个');
    expect(text).toContain(
      '还没补审 1 个（跑 --after-merge-sweep --author-family <写它的模型族>）：\n- #12 t12（合并于 2026-10-03，改到 packages/conventions/src/ci-plan.ts）',
    );
    expect(text).toContain('--after-merge-resolve 11 --by <修复 PR 号>，或 git revert ad8f8d1');
    expect(so.formatPending({ ...base, done: [item(10, { state: 'success' })] })).toContain('没有待补审的。');
  });
});

describe('合并后补审：命令行', SLOW, () => {
  const gitDir = () => {
    const bin = tools.findBin('git', process.env);
    if (!bin) throw new Error('这台机器 PATH 上没有 git');
    return dirname(bin);
  };

  it('--after-merge-pending：这台没装 git 报没装；主线上读不到清单退出 2、说读不到，不当成「没有」', () => {
    let r = run('second-opinion.mjs', ['--after-merge-pending', '--repo', temp('repo')], {
      home: temp('home'),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 git');
    const repo = temp('repo');
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    r = run('second-opinion.mjs', ['--after-merge-pending', '--no-fetch', '--repo', repo], {
      home: temp('home'),
      path: gitDir(),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain(`读不到主线上的 ${so.RISK_PATHS_FILE}`);
    expect(r.out).not.toContain('没有合并后待补审的');
  });

  it('--after-merge-resolve 少了 --by、--by 是它自己：退出 2 说清要什么；--round 不再算数', () => {
    const repo = temp('repo');
    let r = run('second-opinion.mjs', ['--after-merge-resolve', '5', '--repo', repo], { home: temp('home') });
    expect(r.code).toBe(2);
    expect(r.err).toContain('要 --after-merge-resolve <原 PR 号> --by');
    r = run('second-opinion.mjs', ['--after-merge-resolve', '5', '--by', '5', '--repo', repo], {
      home: temp('home'),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--by 不能是它自己');
    r = run('second-opinion.mjs', ['--pr', '5', '--high-risk', '--round', '3', '--repo', repo], {
      home: temp('home'),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--round 不再起作用');
  });
});
