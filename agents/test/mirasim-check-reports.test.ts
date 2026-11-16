// check-reports.mjs：收轮没回报的会话要报出来，回报过的、还在跑的、太久以前的不报。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Row {
  id: string;
  state: string;
  why: string;
}
interface Mod {
  scanUnreported(root: string, opt?: { now?: number; hours?: number }): Row[];
}
const mod = (await import(
  new URL('../skills/mirasim-sessions/scripts/check-reports.mjs', import.meta.url).href
)) as Mod;

const NOW = Date.parse('2026-11-16T10:00:00Z');

function session(root: string, id: string, rec: Record<string, unknown>, turns?: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  if (turns !== undefined) writeFileSync(join(dir, 'turns.jsonl'), turns);
}

describe('check-reports.mjs', () => {
  const root = mkdtempSync(join(tmpdir(), 'chk-'));
  session(
    root,
    'aaaaaaaa-1',
    { runState: 'completed', updatedAt: '2026-11-16T09:00:00Z' },
    '{"text":"ok 已发给 claude:x"}\n',
  );
  session(
    root,
    'bbbbbbbb-2',
    { runState: 'completed', updatedAt: '2026-11-16T09:00:00Z' },
    '{"text":"这一轮被系统停了：重复调用"}\n',
  );
  session(root, 'cccccccc-3', {
    runState: 'incomplete',
    updatedAt: '2026-11-16T09:30:00Z',
    runDetail: '422 模型只有平台提供',
  });
  session(root, 'dddddddd-4', { runState: 'running', updatedAt: '2026-11-16T09:59:00Z' }, '');
  session(root, 'eeeeeeee-5', { runState: 'completed', updatedAt: '2026-11-15T01:00:00Z' }, '');

  it('只报收轮且没发出回报的会话', () => {
    const rows = mod.scanUnreported(root, { now: NOW, hours: 12 });
    expect(rows.map((r) => r.id).sort()).toEqual(['bbbbbbbb', 'cccccccc']);
  });

  it('原因优先用 runDetail，没有就取最后一段输出', () => {
    const rows = mod.scanUnreported(root, { now: NOW, hours: 12 });
    expect(rows.find((r) => r.id === 'cccccccc')?.why).toContain('422');
    expect(rows.find((r) => r.id === 'bbbbbbbb')?.why).toContain('被系统停了');
  });

  it('目录不存在：不报错、不报警', () => {
    expect(mod.scanUnreported(join(root, 'nope'), { now: NOW })).toEqual([]);
  });
});
