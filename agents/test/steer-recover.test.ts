// 把 Mirasim 记着、但没送进会话的创始人插话补回落盘记录（agents/hooks/steer-recover.mjs）。
// 真文件（临时目录里摆 Mirasim 的 turns.jsonl 和 prompt-log），不碰真实的 ~/.mirasim。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Out {
  lines: string[];
  recovered: number;
}
const lib = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'hooks', 'steer-recover.mjs')).href
)) as { recoverSteers(o: unknown): Out };
const hook = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'hooks', 'session-start.mjs')).href
)) as { sessionStart(o: unknown): string[] };

const NOW = Date.parse('2026-10-04T12:00:00Z');
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'steer-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function turns(home: string, id: string, rows: unknown[]) {
  const d = join(home, '.mirasim', 'sessions', 'claude', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'turns.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
function promptLog(home: string, rows: unknown[]) {
  const d = join(home, '.fleet-dao', 'prompt-log');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '2026-10-04.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
const logText = (home: string) =>
  readFileSync(join(home, '.fleet-dao', 'prompt-log', '2026-10-04.jsonl'), 'utf8');

describe('补回没送到的插话', () => {
  it('落盘里没有的插话补进去并说出来；已经落过的（含带图片前缀的）不算丢', () => {
    const home = temp();
    const at = NOW - 20 * 60_000;
    turns(home, 's1', [
      {
        taskId: 't',
        steers: [
          { text: '改一个方案，subagent都改成用sonnet5.5', at },
          { text: '你能接收到我这条消息吗', at: at + 1000 },
          { text: '带图的那条', at: at + 2000 },
        ],
      },
    ]);
    promptLog(home, [
      { at: new Date(at + 1000).toISOString(), prompt: '你能接收到我这条消息吗' },
      {
        at: new Date(at + 2000).toISOString(),
        prompt: '[The image above is also on disk at: x.png]\n带图的那条',
      },
    ]);
    const r = lib.recoverSteers({ home, now: NOW });
    expect(r.recovered).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain('subagent都改成用sonnet5.5');
    expect(r.lines[0]).not.toContain('你能接收到');
    expect(logText(home)).toContain('"promptId":"mirasim-steer-');
    expect(logText(home)).toContain('"recovered":"mirasim-steers"');
  });

  it('补过一次，再开会话不重复补、不再出声', () => {
    const home = temp();
    turns(home, 's1', [{ steers: [{ text: '丢了的话', at: NOW - 60_000 }] }]);
    expect(lib.recoverSteers({ home, now: NOW }).recovered).toBe(1);
    const again = lib.recoverSteers({ home, now: NOW });
    expect(again).toEqual({ lines: [], recovered: 0 });
    expect(logText(home).trim().split('\n')).toHaveLength(1);
  });

  it('没有 Mirasim 目录：一声不吭', () => {
    expect(lib.recoverSteers({ home: temp(), now: NOW })).toEqual({ lines: [], recovered: 0 });
  });

  it('太旧的插话和系统消息不补', () => {
    const home = temp();
    turns(home, 's1', [
      {
        steers: [
          { text: '七个小时前的话', at: NOW - 7 * 3_600_000 },
          { text: '<task-notification>后台任务完成</task-notification>', at: NOW - 60_000 },
        ],
      },
    ]);
    expect(lib.recoverSteers({ home, now: NOW })).toEqual({ lines: [], recovered: 0 });
  });

  it('别的程序塞进会话的整段长提示词不当成创始人的话（真跑 Mirasim 记录时逮到的）', () => {
    const home = temp();
    turns(home, 's1', [
      { steers: [{ text: `【你在改 GitHub 仓库】${'审查任务书。'.repeat(400)}`, at: NOW - 60_000 }] },
    ]);
    expect(lib.recoverSteers({ home, now: NOW })).toEqual({ lines: [], recovered: 0 });
  });

  it('【故意造出的失败】落盘记录读不了：说「没查成」，不当成没丢', () => {
    const home = temp();
    turns(home, 's1', [{ steers: [{ text: '丢了的话', at: NOW - 60_000 }] }]);
    // 把 2026-10-04.jsonl 做成目录：readFileSync 报 EISDIR（不是「没有」）
    mkdirSync(join(home, '.fleet-dao', 'prompt-log', '2026-10-04.jsonl'), { recursive: true });
    const r = lib.recoverSteers({ home, now: NOW });
    expect(r.recovered).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain('没送到的插话没查成');
  });

  it('【故意造出的失败】Mirasim 目录读不了：说「没查成」', () => {
    const home = temp();
    const notADir = join(home, 'sessions-file');
    writeFileSync(notADir, 'x'); // 目录位置上是个文件：readdir 报 ENOTDIR（不是「没有」）
    const r = lib.recoverSteers({ home, now: NOW, sessionsDir: notADir });
    expect(r.lines[0]).toContain('没送到的插话没查成');
  });

  it('接进开会话钩子：丢了的话出现在开场的话里', () => {
    const home = temp();
    turns(home, 's1', [{ steers: [{ text: '开会话时该看到的插话', at: NOW - 60_000 }] }]);
    const git = () => ({ status: 1, stdout: '', stderr: 'no git' });
    const lines = hook.sessionStart({
      cwd: temp(),
      home,
      git,
      localGit: git,
      sync: () => ({ status: 0, stdout: '', stderr: '' }),
      now: NOW,
      unattendedDir: temp(),
      afterMerge: () => ({ status: 0, stdout: '{"unreviewed":[],"failed":[],"problems":[]}', stderr: '' }),
    });
    expect(lines.join('\n')).toContain('开会话时该看到的插话');
  });
});
