// 已经按 MD3 挂上的在途单（#2742）：重放不能跳过已经记下的挂起。看门狗认出那一句，发继续，醒来后按点名重派。

import { describe, expect, it } from 'vitest';
import {
  isLegacyModelMismatchStall,
  LEGACY_MODEL_MISMATCH_STALL,
  NO_ROUTE_MODEL_MISMATCH_STALL,
} from '../src/failure/model-mismatch-stall.ts';
import {
  continueLegacyModelMismatchStalls,
  type ModelMismatchStallRow,
} from '../src/jobs/model-mismatch-stall.ts';

function row(over: Partial<ModelMismatchStallRow> = {}): ModelMismatchStallRow {
  return {
    taskId: 'task-2742',
    owner: 'thoerwink8',
    name: 'fleet-dao',
    issueNumber: 2742,
    doing: `停下等人：${LEGACY_MODEL_MISMATCH_STALL}`,
    lastProblem: LEGACY_MODEL_MISMATCH_STALL,
    workflowId: 'task:thoerwink8/fleet-dao#2742',
    ...over,
  };
}

describe('isLegacyModelMismatchStall', () => {
  it('旧标题和前面加了「停下等人」的进度都认；没有路由的新挂起不认', () => {
    expect(isLegacyModelMismatchStall(LEGACY_MODEL_MISMATCH_STALL)).toBe(true);
    expect(isLegacyModelMismatchStall(`停下等人：${LEGACY_MODEL_MISMATCH_STALL}`)).toBe(true);
    expect(isLegacyModelMismatchStall(NO_ROUTE_MODEL_MISMATCH_STALL)).toBe(false);
    expect(isLegacyModelMismatchStall('停下等人：没有可用的路由')).toBe(false);
    expect(isLegacyModelMismatchStall(null)).toBe(false);
  });
});

describe('continueLegacyModelMismatchStalls', () => {
  it('旧标题有工作流编号就发继续；没有路由的新挂起、别的挂起不发', async () => {
    const released: string[] = [];
    const result = await continueLegacyModelMismatchStalls({
      tasks: async () => [
        row(),
        row({
          taskId: 'task-other',
          issueNumber: 9,
          doing: '停下等人：没有可用的路由',
          lastProblem: '没有可用的路由',
          workflowId: 'task:thoerwink8/fleet-dao#9',
        }),
        row({
          taskId: 'task-none',
          issueNumber: 10,
          doing: `停下等人：${NO_ROUTE_MODEL_MISMATCH_STALL}`,
          lastProblem: NO_ROUTE_MODEL_MISMATCH_STALL,
          workflowId: 'task:thoerwink8/fleet-dao#10',
        }),
      ],
      release: async (workflowId) => {
        released.push(workflowId);
        return 'sent';
      },
      log() {},
    });
    expect(released).toEqual(['task:thoerwink8/fleet-dao#2742']);
    expect(result).toMatchObject({ scanned: 1, continued: 1, problems: [] });
  });

  it('没有工作流编号不猜第一代，记没叫醒', async () => {
    const released: string[] = [];
    const result = await continueLegacyModelMismatchStalls({
      tasks: async () => [row({ workflowId: null })],
      release: async (workflowId) => {
        released.push(workflowId);
        return 'sent';
      },
      log() {},
    });
    expect(released).toEqual([]);
    expect(result.continued).toBe(0);
    expect(result.problems[0]).toContain('没记下工作流编号');
  });

  it('工作流已经不在这句挂起上（skipped）不再发第二次；工作流没了不算没做成', async () => {
    const released: string[] = [];
    const result = await continueLegacyModelMismatchStalls({
      tasks: async () => [
        row({ workflowId: 'task:thoerwink8/fleet-dao#2742' }),
        row({ taskId: 'gone', issueNumber: 3, workflowId: 'task:thoerwink8/fleet-dao#3' }),
      ],
      release: async (workflowId) => {
        released.push(workflowId);
        return workflowId.endsWith('#3') ? 'gone' : 'skipped';
      },
      log() {},
    });
    expect(released).toEqual(['task:thoerwink8/fleet-dao#2742', 'task:thoerwink8/fleet-dao#3']);
    expect(result).toMatchObject({ scanned: 2, continued: 0, problems: [] });
  });
});
