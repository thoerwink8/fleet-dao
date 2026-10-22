// 驾驶舱「继续」「重做」遇到诊断型 / diff 外验收条的单（#3602）：409，不发信号、不另起一代，留言并交回本机。
// 夹具是真单 #3414「怎么算做完」的原文。
import { describe, expect, it } from 'vitest';
import type { LocalHoldInput } from '../src/local-hold.ts';
import { errorCode, harness, IDS, write } from './harness.ts';

const ISSUE_3414_DONE = [
  '- diff与测试输出能核实原场景卡在哪个COMMIT/等待/收尾边界；新增失败诊断只记录合成数据、阶段与必要资源读数，成功静默，缺采样明确unknown。不能把teardown错误直接当根因。',
  '- 原完整256条样本、固定字节峰值、真实事务/崩溃边界和15000ms限制保持，不能加重试、跳过或rerun碰绿；定位到原因时增加能击中原因的回归并修对应实现。',
].join('\n');
const DIAGNOSTIC_BODY = `## 场景\n\n超时。\n\n## 怎么算做完\n\n${ISSUE_3414_DONE}\n`;
const ORDINARY_BODY =
  '## 场景\n\n超时。\n\n## 怎么算做完\n\n- 新增 packages/engine/test/foo.test.ts，断言 bar 返回 3。\n';

function taskOf(h: ReturnType<typeof harness>) {
  const task = h.store.data.tasks.find((row) => row.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 #12');
  return task;
}

describe('驾驶舱：诊断型验收条的单不再续（#3602）', () => {
  it('继续：409 off_diff_hold，不发信号，留言并交回本机', async () => {
    const holds: LocalHoldInput[] = [];
    const h = harness({ localHold: async (input) => void holds.push(input) });
    const s = await h.login();
    const task = taskOf(h);
    task.rawRequest = DIAGNOSTIC_BODY;
    task.state = 'stalled';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('off_diff_hold');
    expect(h.signals).toEqual([]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ issueNumber: 12, repo: { owner: 'example', name: 'canary' } });
  });

  it('重做：409 off_diff_hold，不调重做入口，追加一条没做成', async () => {
    const holds: LocalHoldInput[] = [];
    let called = 0;
    const h = harness({
      localHold: async (input) => void holds.push(input),
      taskRedo: {
        redo: async () => {
          called += 1;
          return { ok: true, workflowId: 'task:example/canary#12:r2', generation: 2 };
        },
      },
    });
    const s = await h.login();
    const task = taskOf(h);
    task.rawRequest = DIAGNOSTIC_BODY;
    task.state = 'stopped';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('off_diff_hold');
    expect(called).toBe(0);
    expect(holds).toHaveLength(1);
    expect(h.store.data.audit.filter((a) => a.action === 'task.redo').map((a) => a.ok)).toEqual([
      true,
      false,
    ]);
  });

  it('普通单的继续不受影响', async () => {
    const holds: LocalHoldInput[] = [];
    const h = harness({ localHold: async (input) => void holds.push(input) });
    const s = await h.login();
    const task = taskOf(h);
    task.rawRequest = ORDINARY_BODY;
    task.state = 'stalled';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(200);
    expect(h.signals.length).toBeGreaterThan(0);
    expect(holds).toEqual([]);
  });

  it('没接 GitHub（开发环境）：照样拦，原因里写明没贴标签', async () => {
    const h = harness();
    const s = await h.login();
    const task = taskOf(h);
    task.rawRequest = DIAGNOSTIC_BODY;
    task.state = 'stalled';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('没贴「本机做」');
    expect(h.signals).toEqual([]);
  });
});
