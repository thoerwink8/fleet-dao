// 落盘钩子（agents/hooks/prompt-log.mjs）不记机器派的会话的提示（派活到合并提速第一片，#1066，2026-10-05 审计 N5）：
// 工人、反方的第一条提示也走 UserPromptSubmit，原先全机一起落进「创始人最近的话」，真话被挤出最后 5 条。
// 真 spawn 钩子、喂 stdin，看落下来的文件——和 rules/prompt-log.rules.test.ts 同一种做法（那份不动）。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const HOOK = fileURLToPath(new URL('../hooks/prompt-log.mjs', import.meta.url));
const SO_SESSIONS = fileURLToPath(new URL('../skills/discuss/scripts/so-sessions.mjs', import.meta.url));
const un = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url))).href
)) as {
  isMachineOpening(p: unknown): boolean;
  isMachineSession(o?: { env?: Record<string, string | undefined>; cwd?: unknown }): boolean;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prompt-log-machine-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 像 Claude Code 那样喂一条消息进去；env 里没有的 FLEET_WORKER 一律去掉，免得这台机器自己的环境串进来。 */
function feed(input: Record<string, unknown>, env: Record<string, string> = {}) {
  const { FLEET_WORKER: _drop, ...base } = process.env;
  const r = runChild(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...base, FLEET_PROMPT_LOG_DIR: dir, FLEET_UNATTENDED_DIR: join(dir, 'unattended'), ...env },
  });
  return { code: r.status, out: r.stdout ?? '' };
}

function logged(): Record<string, string>[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l));
}

// 每条真起 node 进程喂 stdin，开着别的会话时一次要一两秒，4 次一组超过默认的 5 秒
describe('落盘钩子不记机器派的会话', { timeout: 0 }, () => {
  it('创始人的话照旧落盘（含「hi」这种几个字的；会话目录是主检出或他自己开的非 w- 工作树）', () => {
    feed({ prompt: 'hi', prompt_id: 'p1', session_id: 's1', cwd: 'D:\\frank\\fleet-dao' });
    feed({
      prompt: '你改好了没有？',
      prompt_id: 'p2',
      session_id: 's1',
      cwd: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\939-drop-asks',
    });
    expect(logged().map((e) => e.prompt)).toEqual(['hi', '你改好了没有？']);
  });

  it('【故意造出的情形】FLEET_WORKER=1：不落盘，也不出声、退出码 0', () => {
    const got = feed(
      { prompt: '派活的交代', prompt_id: 'p1', session_id: 's1', cwd: 'D:\\x' },
      { FLEET_WORKER: '1' },
    );
    expect(got).toEqual({ code: 0, out: '' });
    expect(logged()).toEqual([]);
  });

  it('【故意造出的情形】会话目录在 .claude/worktrees/w-<名字> 里：不落盘（Windows 和斜杠两种写法）', () => {
    for (const [i, cwd] of [
      'D:\\frank\\fleet-dao\\.claude\\worktrees\\w-speed-a',
      '/home/u/fleet-dao/.claude/worktrees/w-speed-a/packages/db',
    ].entries()) {
      feed({ prompt: `机器的提示 ${i}`, prompt_id: `p${i}`, session_id: 's', cwd });
    }
    expect(logged()).toEqual([]);
  });

  it('【故意造出的情形】反方的开场提示（不管会话目录在哪）：不落盘', () => {
    feed({ prompt: '你是「反方」：一个全新会话，另一家模型。', prompt_id: 'p2', cwd: 'D:\\x' });
    expect(logged()).toEqual([]);
  });

  it('后台任务通知照旧原样落盘（读的那一步再滤，写入方只管上面几种机器会话）', () => {
    feed({ prompt: '<task-notification>\n<task-id>x</task-id>', prompt_id: 'p1', cwd: 'D:\\x' });
    expect(logged()).toHaveLength(1);
  });
});

describe('机器会话的判断（落盘和开会话共用 unattended.mjs 这一套）', () => {
  it('isMachineSession：FLEET_WORKER 必须正好是 1；目录要整段是 w-<名字>，w- 开头的别的目录不算', () => {
    expect(un.isMachineSession({ env: { FLEET_WORKER: '1' } })).toBe(true);
    expect(un.isMachineSession({ env: { FLEET_WORKER: '0' } })).toBe(false);
    expect(un.isMachineSession({ env: {} })).toBe(false);
    expect(un.isMachineSession({ env: {}, cwd: 'D:\\r\\.claude\\worktrees\\w-a' })).toBe(true);
    expect(un.isMachineSession({ env: {}, cwd: 'D:\\r\\.claude\\worktrees\\so-order' })).toBe(false);
    expect(un.isMachineSession({ env: {}, cwd: 'D:\\r\\worktrees\\w-a' })).toBe(false);
    expect(un.isMachineSession({ env: {}, cwd: undefined })).toBe(false);
  });

  it('反方的开场认得出，普通句子不算', () => {
    expect(un.isMachineOpening('你是「反方」：…')).toBe(true);
    expect(un.isMachineOpening('你是不是漏了反方')).toBe(false);
  });

  it('反方起的 reclaude 会话带 FLEET_WORKER=1（源码核对：真起 reclaude 要网络和账号，测试不碰）', () => {
    const src = readFileSync(SO_SESSIONS, 'utf8');
    const runClaude = src.slice(src.indexOf('function runClaude'), src.indexOf('function runCursor'));
    expect(runClaude).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*FLEET_WORKER:\s*'1'\s*\}/);
  });
});
