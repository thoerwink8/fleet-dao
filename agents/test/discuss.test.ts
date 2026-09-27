// discuss 技能带的脚本（agents/skills/discuss/scripts/）：ask.mjs 一问一答、second-opinion.mjs 反方和审 PR、walkthrough.mjs、tools.mjs。
// 在临时家目录里跑，PATH 里只放假的 cursor-agent（或者什么都不放）：不碰真家目录、不出网、不调模型。
// 重点是这台机器缺东西时（法国上就没有 cursor-agent、Mirasim）要明说缺的是什么，不当成答了、也不当成没事。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
  checkPublishable(repo: string, body: string, loadOpts?: unknown): Promise<void>;
  UNAVAILABLE: RegExp;
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

const SCRIPTS = fileURLToPath(new URL('../skills/discuss/scripts/', import.meta.url));
const load = async (name: string) => import(pathToFileURL(join(SCRIPTS, name)).href);
const so = (await load('second-opinion.mjs')) as SecondOpinionLib;
const tools = (await load('tools.mjs')) as ToolsLib;
const walk = (await load('walkthrough.mjs')) as WalkLib;
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

/** 假的 cursor-agent：status 按 FAKE_LOGGED 说登没登录；问答按 FAKE_ANSWER 回（'' 就是没输出） */
function fakeCursor(): string {
  const bin = temp('bin');
  const script = join(bin, 'fake-cursor.mjs');
  writeFileSync(
    script,
    [
      "if (process.argv.includes('status')) {",
      "  process.stdout.write(JSON.stringify({ status: 'x', isAuthenticated: process.env.FAKE_LOGGED === '1' }));",
      '} else {',
      "  process.stdout.write(process.env.FAKE_ANSWER ?? '');",
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

  it('装了登了：答案照登，记录落在家目录，不落进技能目录（同步会把技能目录整个换掉）', () => {
    const home = temp('home');
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home,
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ANSWER: '假答案：同意' },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('## gpt');
    expect(r.out).toContain('假答案：同意');
    const runs = join(tools.dataDir(home), 'runs');
    expect(readdirSync(runs).some((f) => f.startsWith('ask-'))).toBe(true);
    expect(existsSync(join(SCRIPTS, 'runs'))).toBe(false);
  });

  it('答了个空：记成没答上，一家都没答上退出码 2', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      path: fakeCursor(),
      env: { FAKE_LOGGED: '1', FAKE_ANSWER: '' },
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：退出码 0 但没有输出');
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

  it('这台没装 Mirasim、也没装 cursor-agent：几家都换过，退出码 2，逐家写明缺的是什么', () => {
    const home = temp('home');
    const r = run('second-opinion.mjs', ['--text', topic(LONG), '--name', 'no-tools'], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain('这台机器没装 Mirasim');
    expect(r.err).toContain('这台机器没装 cursor-agent');
    expect(r.err).toContain('候选的几家全没成');
    const runs = join(tools.dataDir(home), 'runs');
    expect(readdirSync(runs).some((f) => f.startsWith('critique-no-tools-'))).toBe(true);
  });

  it('Mirasim 装了没开：写明没开', () => {
    const home = temp('home');
    mkdirSync(join(home, '.mirasim', 'run'), { recursive: true });
    const r = run('second-opinion.mjs', ['--text', topic(LONG), '--name', 'mira-off'], { home });
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

  it('贴之前过卫生检查：名单读不到不贴、扫出名单上的值不贴、干净的放行（卫生检查换成假的）', async () => {
    const repo = temp('repo');
    const src = join(repo, 'packages', 'hygiene', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'values.ts'),
      "export function loadSensitiveValues(o) { return o && o.fail ? { ok: false, reason: '名单读不到' } : { ok: true, values: ['SECRETVAL-9f3a'] }; }\n",
    );
    writeFileSync(
      join(src, 'scan.ts'),
      [
        'export function scanFiles(paths, read, _x, values) {',
        "  const text = read(paths[0]).toString('utf8');",
        "  return { binary: [], scanned: paths, findings: values.filter((v) => text.includes(v)).map(() => ({ rule: 'known-value' })) };",
        '}',
        'export function formatFinding(f) { return f.rule; }',
        '',
      ].join('\n'),
    );
    await expect(so.checkPublishable(repo, '干净的正文', { fail: true })).rejects.toThrow('卫生检查没法做');
    await expect(so.checkPublishable(repo, '里面有 SECRETVAL-9f3a 这个值', {})).rejects.toThrow(
      '卫生检查拦下了',
    );
    await expect(so.checkPublishable(repo, '干净的正文', {})).resolves.toBeUndefined();
  });
});
