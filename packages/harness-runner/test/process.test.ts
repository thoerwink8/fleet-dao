// 运行层对着旧坑 A1–A5、A7、H1 的测试（specs/3770-harness-rewrite/旧坑验收用例.md）。全用假执行体（fake-cli.mjs）。
// A6（OOM 归属证据，要 cgroup）在法国真机测，见 #3775。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Budget, BudgetTooLongError, deriveDeadline } from '../src/budget.ts';
import { classifyClaudeLine } from '../src/frames.ts';
import { sweepOrphans } from '../src/orphans.ts';
import { type RunSpec, runProcess } from '../src/process.ts';
import { HAS_PROC, runAlive } from '../src/procs.ts';
import { makeRedactor, secretsFromEnv } from '../src/redact.ts';
import { StopReason } from '../src/stop-reason.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const FAST: Budget = { startupMs: 400, totalMs: 5_000, idleMs: 300, killGraceMs: 200 };
let n = 0;

function spec(mode: string, over: Partial<RunSpec> = {}, env: Record<string, string> = {}): RunSpec {
  const budget = over.budget ?? FAST;
  return {
    command: [process.execPath, FAKE],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode, ...env },
    stdin: '派的活',
    runId: `t-${process.pid}-${++n}`,
    budget,
    deadline: deriveDeadline(new Date(), budget),
    redact: makeRedactor([]),
    ...over,
  };
}

describe('正常跑完', () => {
  it('提示词从 stdin 喂进去；会话号交给调用方；最后一步是工具结果之后', async () => {
    const sessions: string[] = [];
    const steps: string[] = [];
    const r = await runProcess(spec('work'), {
      onSession: (s) => sessions.push(s),
      onFrame: (f, line) => {
        steps.push(f.kind);
        if (f.kind === 'assistant') expect(line).toContain('派的活');
      },
    });
    expect(r).toMatchObject({ exitCode: 0, sessionId: 'sess-1', lastStep: '工具结果' });
    expect(r.killed).toBeUndefined();
    expect(sessions).toEqual(['sess-1']);
    expect(steps).toEqual(['init', 'assistant', 'tool_use', 'tool_result', 'result']);
    expect(r.firstProgressMs).toBeGreaterThanOrEqual(0);
  });
});

describe('A1 起来后无进展', () => {
  it('只吐「Syncing config…」：起步时限到就杀，原因写停在哪', async () => {
    const r = await runProcess(spec('stall-after-sync'));
    expect(r.killed?.reason).toBe('no_progress');
    expect(r.killed?.detail).toContain('Syncing config');
    expect(r.firstProgressMs).toBeUndefined();
  });

  it('只有 init 不算起来', async () => {
    const r = await runProcess(spec('init-only'));
    expect(r.killed?.reason).toBe('no_progress');
    expect(r.killed?.detail).toContain('init');
  });

  it('判帧白名单：助手消息、工具调用、工具结果算；system、result、认不出的行不算', () => {
    const sub = (o: unknown) => classifyClaudeLine(typeof o === 'string' ? o : JSON.stringify(o)).substantive;
    expect(sub({ type: 'assistant', message: { content: [{ type: 'text' }] } })).toBe(true);
    expect(sub({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })).toBe(true);
    expect(sub({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(true);
    expect(sub({ type: 'system', subtype: 'init' })).toBe(false);
    expect(sub({ type: 'system', subtype: 'status' })).toBe(false);
    expect(sub({ type: 'result' })).toBe(false);
    expect(sub('Syncing config…')).toBe(false);
  });
});

describe('A2 总时限的原因不被盖掉', () => {
  it('到截止时刻：原因是「总时限 N 用完、停在哪一步」，不是 aborted', async () => {
    const budget: Budget = { startupMs: 2_000, totalMs: 500, killGraceMs: 200 };
    const r = await runProcess(spec('steady', { budget, deadline: deriveDeadline(new Date(), budget) }));
    expect(r.killed?.reason).toBe('deadline');
    expect(r.killed?.detail).toMatch(/^总时限 \d+ 秒用完、停在「助手回话」$/);
  });

  it('外层在截止时刻同时叫停：还是记成时限到', async () => {
    const budget: Budget = { startupMs: 2_000, totalMs: 400, killGraceMs: 200 };
    const deadline = deriveDeadline(new Date(), budget);
    const ac = new AbortController();
    setTimeout(
      () => ac.abort(new StopReason('wall-clock', '外层时限到')),
      deadline.getTime() - Date.now() + 1,
    );
    const r = await runProcess(spec('steady', { budget, deadline, signal: ac.signal }));
    expect(r.killed?.reason).toBe('deadline');
  });

  it('截止前被叫停：记叫停的种类和原因', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new StopReason('user-stop', '人点了停')), 150);
    const r = await runProcess(spec('steady', { signal: ac.signal }));
    expect(r.killed).toMatchObject({ reason: 'aborted', detail: '被叫停（user-stop）：人点了停' });
  });
});

describe('A3 会话号对账', () => {
  it('续会话时起来的会话号对不上：判冲突、停掉这一个，不交给调用方登记', async () => {
    const sessions: string[] = [];
    const r = await runProcess(
      spec('silent-after-progress', { expectSessionId: 'sess-old' }, { FAKE_SESSION: 'sess-new' }),
      {
        onSession: (s) => sessions.push(s),
      },
    );
    expect(r.killed?.reason).toBe('session_conflict');
    expect(r.sessionId).toBe('sess-new');
    expect(sessions).toEqual([]);
  });
});

describe('A4 子层继承上层的绝对截止时刻', () => {
  it('子层预算比上层剩下的长：启动前就报错，不默默截短', () => {
    const now = new Date();
    const parent = new Date(now.getTime() + 20 * 60_000);
    expect(() => deriveDeadline(now, { startupMs: 1, totalMs: 35 * 60_000, killGraceMs: 1 }, parent)).toThrow(
      BudgetTooLongError,
    );
    const child = deriveDeadline(now, { startupMs: 1, totalMs: 10 * 60_000, killGraceMs: 1 }, parent);
    expect(child.getTime()).toBeLessThanOrEqual(parent.getTime());
  });
});

describe('停滞', () => {
  it('有过进展后没有工具在跑又没动静：判停滞', async () => {
    const r = await runProcess(spec('silent-after-progress'));
    expect(r.killed?.reason).toBe('idle');
  });

  it('工具在跑（一轮测试跑很久）不算停滞', async () => {
    const r = await runProcess(spec('long-tool', {}, { FAKE_TOOL_MS: '900' }));
    expect(r.killed).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });
});

describe('A5 子进程只走一个起法、按会话收', () => {
  it.skipIf(!HAS_PROC)('执行体退了、脱离进程组的孙子还在：按会话标记收掉，收完不剩', async () => {
    const s = spec('grandchild');
    const r = await runProcess(s);
    expect(r.stragglers).toBeGreaterThanOrEqual(1);
    expect(r.leftovers).toBe(0);
    expect(runAlive(s.runId)).toBe(false);
  });

  it('新内核的包里不许用同步起子进程，起子进程只在运行层这一处', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    for (const pkg of readdirSync(root).filter((d) => d.startsWith('harness-'))) {
      const src = join(root, pkg, 'src');
      let files: string[];
      try {
        files = readdirSync(src, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const f of files.filter((x) => x.endsWith('.ts'))) {
        const text = readFileSync(join(src, f), 'utf8');
        if (/\b(spawnSync|execSync|execFileSync)\b/.test(text)) offenders.push(`${pkg}/${f}：同步起子进程`);
        const where = `${pkg}/${f.replaceAll('\\', '/')}`;
        // 按引入认，不按调用名认：正则的 .exec( 不是起子进程
        if (/from ['"](node:)?child_process['"]/.test(text) && where !== 'harness-runner/process.ts') {
          offenders.push(`${where}：起子进程要走 harness-runner 的 runProcess`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('A7 重启后收上一代的孤儿', () => {
  it('只收确认进程不在的；还在的留给接回；查不了的不收', () => {
    const alive: Record<string, boolean | undefined> = { a: false, b: true, c: undefined };
    expect(sweepOrphans([{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }], (id) => alive[id])).toEqual({
      interrupted: ['a'],
      alive: ['b'],
      unknown: ['c'],
    });
  });

  it.skipIf(!HAS_PROC)('跑完的会话按标记查是不在了', async () => {
    const s = spec('work');
    await runProcess(s);
    expect(runAlive(s.runId)).toBe(false);
  });
});

// 假密钥现拼：源码里不留像密钥的字面量（推送前卫生检查按样子认，假的也拦）。
const fakeValue = (head: string) => `${head}${'a1'.repeat(18)}`;
const SECRET_NAME = ['FEISHU', 'APP', 'SECRET'].join('_');
const KEY_BLOCK = (edge: string) => `-----${edge} OPENSSH PRIVATE KEY-----`;

describe('H1 脱敏', () => {
  it('输出、stderr 里的密钥原值和令牌样子都换成 ***', async () => {
    const token = fakeValue('gh' + 'p_');
    const env = { [SECRET_NAME]: fakeValue('feishu-'), FAKE_TOKEN: token };
    const redact = makeRedactor(secretsFromEnv(env));
    const lines: string[] = [];
    const r = await runProcess(spec('leak-secret', { redact }, env), {
      onFrame: (_f, line) => lines.push(line),
    });
    const all = [...lines, r.stderrTail].join('\n');
    expect(all).not.toContain(token);
    expect(all).toContain('令牌是 ***');
    expect(r.stderrTail).toContain('Bearer ***');
  });

  it('已知密钥原值、私钥块、Bearer 头都打码；短的普通词不误伤', () => {
    const known = fakeValue('v');
    const redact = makeRedactor(secretsFromEnv({ [SECRET_NAME]: known, HOME: '/home/x', PAT: 'short' }));
    expect(redact(`值 ${known} 在这`)).toBe('值 *** 在这');
    expect(redact(`${KEY_BLOCK('BEGIN')}\nAAAA\n${KEY_BLOCK('END')}`)).toBe('***');
    expect(redact(`Authorization: Bearer ${fakeValue('b')}`)).toBe('Authorization: Bearer ***');
    expect(redact('/home/x short')).toBe('/home/x short');
  });
});
