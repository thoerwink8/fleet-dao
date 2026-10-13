// 主页「本机会话」的写法（#1991）：在跑、刚停、超过阈值没动、没上报四态；
// 故意造出的失败：推不来了（stale / never）写「没上报」和原因，不画成 0 个会话；法国没配钥匙写「没接上」。
import { describe, expect, it } from 'vitest';
import type { LocalSessions } from '../../api/types';
import { localBrief, localView } from './local-sessions-view';

const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const MIN = 60_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();

const session = (id: string, state: 'running' | 'stopped' | 'idle', idleMs: number) => ({
  id,
  repo: 'thoerwink8/fleet-dao',
  branch: 'main',
  worktree: null,
  subagent: false,
  startedAt: iso(60 * MIN),
  lastSeenAt: iso(idleMs),
  last: state === 'stopped' ? ('stop' as const) : ('tool' as const),
  lastTool: 'Bash',
  state,
  idleMs,
});

function data(freshness: 'fresh' | 'stale' | 'never'): LocalSessions {
  return {
    asOf: iso(0),
    nodes: [
      freshness === 'never'
        ? { id: 'founder-pc', freshness, sessions: [], problems: [] }
        : {
            id: 'founder-pc',
            freshness,
            machine: '创始人的电脑',
            receivedAt: iso(freshness === 'fresh' ? MIN : 9 * MIN),
            reportedAt: iso(freshness === 'fresh' ? MIN : 9 * MIN),
            sessions: [
              session('b', 'stopped', 4 * MIN),
              session('a', 'running', MIN),
              session('c', 'idle', 40 * MIN),
            ],
            problems: [],
          },
    ],
  };
}

describe('本机会话', () => {
  it('在上报：三态各有字和色，在跑的排前；按钮写「本机 1 在跑」', () => {
    const v = localView(data('fresh'), NOW);
    if (v.kind !== 'ok') throw new Error(v.kind);
    expect(v.nodes[0]?.lines.map((l) => [l.key, l.label, l.tone])).toEqual([
      ['a', '在跑', 'run'],
      ['c', '超过 15 分钟没动', 'stall'],
      ['b', '刚停', 'done'],
    ]);
    expect(v.nodes[0]?.lines[1]?.when).toBe('40 分钟没动');
    expect(localBrief(v)).toEqual({ text: '本机 1 在跑', tone: 'run' });
  });

  it('【故意造出的失败】超过 5 分钟没推来：没上报写上次收到在多久前，会话照列但写「上次看到」，不冒充在跑', () => {
    const v = localView(data('stale'), NOW);
    if (v.kind !== 'ok') throw new Error(v.kind);
    expect(v.nodes[0]?.why).toMatch(/^没上报：上次收到是 9 分钟前/);
    expect(v.nodes[0]?.lines.every((l) => l.label === '上次看到' && l.tone === 'stop')).toBe(true);
    expect(v.running).toBe(0);
    expect(localBrief(v)).toEqual({ text: '本机没上报', tone: 'stall' });
  });

  it('【故意造出的失败】配了钥匙从没推过：没上报，不画成 0 个会话', () => {
    const v = localView(data('never'), NOW);
    if (v.kind !== 'ok') throw new Error(v.kind);
    expect(v.nodes[0]?.why).toMatch(/一次都没收到/);
    expect(localBrief(v).text).toBe('本机没上报');
  });

  it('【故意造出的失败】法国没配钥匙：没接上，写原因', () => {
    const v = localView({ asOf: iso(0), notWired: '法国没配 FLEET_NODE_KEYS', nodes: [] }, NOW);
    expect(v).toEqual({ kind: 'notWired', why: '法国没配 FLEET_NODE_KEYS' });
    expect(localBrief(v).text).toBe('本机没接上');
  });
});
