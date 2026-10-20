import type { CommanderStalledTask } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  COMMANDER_AFTER_MINUTES,
  COMMANDER_ALERT_PREFIX,
  watchCommander,
} from '../src/jobs/watchdog-commander.ts';

const NOW = new Date('2026-10-20T02:00:00.000Z');
const task = (over: Partial<CommanderStalledTask> = {}): CommanderStalledTask => ({
  taskId: 'task-1',
  owner: 'acme',
  name: 'fleet-dao',
  issueNumber: 3295,
  title: '停下的单',
  workflowId: 'wf-1',
  parkSeq: 2,
  stalledAt: new Date(NOW.getTime() - (COMMANDER_AFTER_MINUTES + 1) * 60_000),
  commanderSeen: false,
  ...over,
});

function rig(rows: CommanderStalledTask[]) {
  const open = new Map<
    string,
    { title: string; body: string; resolvedAt: Date | null; resolvedBy: string | null }
  >();
  const deps = {
    tasks: async () => rows,
    alerts: {
      openByPrefix: async (prefix: string) =>
        [...open.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([dedupeKey, value]) => ({ dedupeKey, title: value.title, body: value.body })),
      byKey: async (key: string) => {
        const value = open.get(key);
        return value ? { ...value } : null;
      },
      raise: async (input: { dedupeKey: string; title: string; body: string }) => {
        open.set(input.dedupeKey, { ...input, resolvedAt: null, resolvedBy: null });
      },
      resolve: async ({ dedupeKey }: { dedupeKey: string; why: string }) => {
        const value = open.get(dedupeKey);
        if (value) {
          value.resolvedAt = NOW;
          value.resolvedBy = 'engine:watchdog';
        }
        return 'ok' as const;
      },
    },
    log: () => {},
  };
  return { deps, open };
}

describe('看门狗盯法国指挥官', () => {
  it('停下超过 30 分钟且没认领：报 watchdog:commander:<任务>', async () => {
    const r = rig([task()]);
    const result = await watchCommander(r.deps, NOW);
    expect(result).toMatchObject({ scanned: 1, found: 1, problems: [] });
    expect([...r.open.keys()]).toEqual([`${COMMANDER_ALERT_PREFIX}task-1`]);
  });

  it('指挥官已经看过：自动撤看门狗提醒，不再报', async () => {
    const r = rig([task()]);
    await watchCommander(r.deps, NOW);
    const seen = rig([task({ commanderSeen: true })]);
    seen.open.set(`${COMMANDER_ALERT_PREFIX}task-1`, {
      title: '停下的任务没人看：acme/fleet-dao#3295',
      body: '旧卡',
      resolvedAt: null,
      resolvedBy: null,
    });
    const result = await watchCommander(seen.deps, NOW);
    expect(result.found).toBe(0);
    expect(seen.open.get(`${COMMANDER_ALERT_PREFIX}task-1`)).toMatchObject({
      resolvedBy: 'engine:watchdog',
    });
  });

  it('未满 30 分钟不报', async () => {
    const r = rig([task({ stalledAt: new Date(NOW.getTime() - (COMMANDER_AFTER_MINUTES - 1) * 60_000) })]);
    expect(await watchCommander(r.deps, NOW)).toMatchObject({ found: 0 });
    expect(r.open.size).toBe(0);
  });
});
