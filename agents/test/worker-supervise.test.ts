// #1066：2026-10-05 16:56 网关 502，5 个 Claude 工人同时以「API Error: 502」退出、靠人重派（约 22 分钟）。
// Claude 工人现在由外壳 worker-supervise.mjs 看着：网关/网络类错误退出就等一等、用同一个会话续跑。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));

interface Tracker {
  sessionId: string | null;
  feed(chunk: string): void;
  end(): void;
}
interface ChildResult {
  code: number | null;
  tracker: Tracker;
  errTail: string;
}
interface SuperviseLib {
  RESUME_DELAYS_SEC: number[];
  RESUME_PROMPT: string;
  EventTracker: new () => Tracker;
  classifyExit(x: ChildResult): { kind: 'done' | 'network' | 'other'; why: string };
  superviseLoop(o: {
    promptText: string;
    delays?: number[];
    io: {
      runChild(extraArgs: string[], stdinText: string): Promise<ChildResult>;
      sleep(ms: number): Promise<void>;
      say(line: string): void;
      recordResume(r: { resumes: number; sessionId: string | null; why: string }): void;
    };
  }): Promise<number>;
}
const sup = (await import(pathToFileURL(join(SCRIPTS, 'worker-supervise.mjs')).href)) as SuperviseLib;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const evs = (...o: unknown[]) => `${o.map((e) => JSON.stringify(e)).join('\n')}\n`;
const SID = '11111111-2222-3333-4444-555555555555';
const init = { type: 'system', subtype: 'init', session_id: SID };
const apiErr = (text: string) => ({ type: 'result', subtype: 'success', is_error: true, result: text });
const finished = { type: 'result', subtype: 'success', is_error: false, result: '完成：PR #1' };
const GATEWAY = 'API Error: 502 无法连接 reclaude 网关，请检查网络后重试. This is a server-side issue';
const tracked = (text: string) => {
  const t = new sup.EventTracker();
  t.feed(text);
  t.end();
  return t;
};
const exited = (code: number | null, text: string, errTail = ''): ChildResult => ({
  code,
  tracker: tracked(text),
  errTail,
});

describe('Claude 工人外壳：网关掉线自动续跑', () => {
  it('认出：result 事件是 5xx / 连接类错误 → network；会话号从事件里取', () => {
    const r = exited(1, evs(init, apiErr(GATEWAY)));
    expect(r.tracker.sessionId).toBe(SID);
    const c = sup.classifyExit(r);
    expect(c.kind).toBe('network');
    expect(c.why).toContain('502');
    for (const text of [
      'API Error: 503 Service Unavailable',
      'API Error: 529 overloaded',
      'fetch failed: ECONNRESET',
    ]) {
      expect(sup.classifyExit(exited(1, evs(init, apiErr(text)))).kind, text).toBe('network');
    }
    // 没有 result 事件（进程被打断）、退出码非 0、标准错误里有连接类特征
    expect(sup.classifyExit(exited(1, evs(init), 'Error: read ECONNRESET')).kind).toBe('network');
  });

  it('【故意造出的失败】认不出的错误照旧算真退出：4xx、别的报错、正常做完、没有 result 也没有特征', () => {
    for (const text of [
      'API Error: 401 invalid api key',
      'API Error: 429 rate limit',
      'Error: max turns reached',
    ]) {
      expect(sup.classifyExit(exited(1, evs(init, apiErr(text)))).kind, text).toBe('other');
    }
    expect(sup.classifyExit(exited(0, evs(init, finished))).kind).toBe('done');
    expect(sup.classifyExit(exited(1, evs(init), '随便一句')).kind).toBe('other');
    expect(sup.classifyExit(exited(0, evs(init), 'ECONNRESET')).kind).toBe('other');
  });

  it('第一次 502 退出、第二次做完：等 60 秒、用同一个会话号 --resume 续、记下续了 1 次，退出码是做完的 0', async () => {
    const calls: { extra: string[]; stdin: string }[] = [];
    const sleeps: number[] = [];
    const said: string[] = [];
    const recorded: { resumes: number; sessionId: string | null; why: string }[] = [];
    const code = await sup.superviseLoop({
      promptText: '原来的活',
      io: {
        runChild: async (extra, stdin) => {
          calls.push({ extra, stdin });
          return calls.length === 1 ? exited(1, evs(init, apiErr(GATEWAY))) : exited(0, evs(init, finished));
        },
        sleep: async (ms) => void sleeps.push(ms),
        say: (l) => said.push(l),
        recordResume: (r) => recorded.push(r),
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      { extra: [], stdin: '原来的活' },
      { extra: ['--resume', SID], stdin: sup.RESUME_PROMPT },
    ]);
    expect(sleeps).toEqual([60_000]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ resumes: 1, sessionId: SID });
    expect(said.join('\n')).toContain(`60 秒后第 1/5 次用会话 ${SID} 接着跑`);
  });

  it('一直 502：最多续 5 次，间隔 60、120、240、480、600 秒拉长，然后照实带着失败的退出码退出', async () => {
    expect(sup.RESUME_DELAYS_SEC).toEqual([60, 120, 240, 480, 600]);
    let runs = 0;
    const sleeps: number[] = [];
    const said: string[] = [];
    const code = await sup.superviseLoop({
      promptText: 'x',
      io: {
        runChild: async () => {
          runs += 1;
          return exited(1, evs(init, apiErr(GATEWAY)));
        },
        sleep: async (ms) => void sleeps.push(ms),
        say: (l) => said.push(l),
        recordResume: () => {},
      },
    });
    expect(code).toBe(1);
    expect(runs).toBe(6);
    expect(sleeps).toEqual([60_000, 120_000, 240_000, 480_000, 600_000]);
    expect(said.at(-1)).toContain('已经续跑 5 次还是不行，不再续了');
  });

  it('【故意造出的失败】认不出的错误：不续、不等，退出码原样交出去', async () => {
    let runs = 0;
    const code = await sup.superviseLoop({
      promptText: 'x',
      io: {
        runChild: async () => {
          runs += 1;
          return exited(3, evs(init, apiErr('API Error: 401 invalid api key')));
        },
        sleep: async () => {
          throw new Error('不该等');
        },
        say: () => {},
        recordResume: () => {
          throw new Error('不该记');
        },
      },
    });
    expect(code).toBe(3);
    expect(runs).toBe(1);
  });

  it('会话还没起来（一个会话号都没有）就连不上：用原来的提示词从头再起，不带 --resume', async () => {
    const calls: { extra: string[]; stdin: string }[] = [];
    const code = await sup.superviseLoop({
      promptText: '原来的活',
      delays: [1],
      io: {
        runChild: async (extra, stdin) => {
          calls.push({ extra, stdin });
          return calls.length === 1
            ? exited(1, '', 'Error: connect ECONNREFUSED 127.0.0.1:8080')
            : exited(0, evs(finished));
        },
        sleep: async () => {},
        say: () => {},
        recordResume: () => {},
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      { extra: [], stdin: '原来的活' },
      { extra: [], stdin: '原来的活' },
    ]);
  });

  it('真起子进程走一遍：假 reclaude 第一次吐 502、第二次（带 --resume）做完；meta.json 里记了续 1 次，日志里有外壳那句话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-supervise-'));
    dirs.push(dir);
    const fake = join(dir, 'fake-reclaude.mjs');
    writeFileSync(
      fake,
      [
        "const resumed = process.argv.includes('--resume');",
        "let stdin = '';",
        "process.stdin.on('data', (d) => (stdin += d));",
        "process.stdin.on('end', () => {",
        `  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${SID}' }));`,
        '  if (!resumed) {',
        "    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 502 无法连接 reclaude 网关' }));",
        '    process.exit(1);',
        '  }',
        "  console.log(JSON.stringify({ type: 'result', is_error: false, result: '完成：PR #1（续跑收到：' + stdin.slice(0, 4) + '）' }));",
        '});',
      ].join('\n'),
    );
    const metaFile = join(dir, 'meta.json');
    writeFileSync(metaFile, JSON.stringify({ name: 'e2e', model: 'claude' }));
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, '原来的活');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'worker-supervise.mjs'),
        '--meta',
        metaFile,
        '--prompt',
        promptFile,
        '--delays-sec',
        '0,0',
        '--',
        process.execPath,
        fake,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      '【外壳】网关/网络错误（API Error: 502 无法连接 reclaude 网关），0 秒后第 1/2 次',
    );
    expect(r.stdout).toContain('完成：PR #1（续跑收到：外壳提示）');
    expect(JSON.parse(readFileSync(metaFile, 'utf8'))).toMatchObject({
      name: 'e2e',
      resumes: 1,
      sessionId: SID,
    });
  });

  it('【故意造出的失败】reclaude 起不来（命令不存在）：退出码 1，日志写明起不来，不拿 254 冒充、也不当成网关错误去续跑', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-supervise-missing-'));
    dirs.push(dir);
    const metaFile = join(dir, 'meta.json');
    writeFileSync(metaFile, JSON.stringify({ name: 'missing', model: 'claude' }));
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, '原来的活');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'worker-supervise.mjs'),
        '--meta',
        metaFile,
        '--prompt',
        promptFile,
        '--',
        'this-command-does-not-exist-xyz',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    expect(r.status, text).toBe(1);
    expect(text).toContain('起不来');
    expect(text).toContain('this-command-does-not-exist-xyz');
    expect(text).not.toContain('秒后第');
    expect(JSON.parse(readFileSync(metaFile, 'utf8')).resumes).toBeUndefined();
  });
});
