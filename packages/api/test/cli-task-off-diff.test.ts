// 诊断型 / diff 外验收条的单不再被续上（#3602）：fleet-api task continue、redo 在发信号、另起一代之前先过判据，
// 命中就拒绝、留言并贴「本机做」交回本机；普通单不受影响。夹具是真单 #3414「怎么算做完」的原文（2026-10-22 从 GitHub 读的）。
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { createMemoryStore, devFixtures, IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import type { LocalHoldInput } from '../src/local-hold.ts';
import type { TaskSignal } from '../src/ports.ts';

const T0 = new Date('2026-10-09T00:00:00.000Z');
const NOTE = '人工继续';

const ISSUE_3414_DONE = [
  '- diff与测试输出能核实原场景卡在哪个COMMIT/等待/收尾边界；新增失败诊断只记录合成数据、阶段与必要资源读数，成功静默，缺采样明确unknown。不能把teardown错误直接当根因。',
  '- 原完整256条样本、固定字节峰值、真实事务/崩溃边界和15000ms限制保持，不能加重试、跳过或rerun碰绿；定位到原因时增加能击中原因的回归并修对应实现。',
  '- 若本PR只交付诊断，需求使用Refs关联并明确分片、关不了它与剩余根因欠项，不能Closes或写欠无。',
  '- 相关测试、类型格式卫生及完整CI/check/独立合并闸通过，不改3249的预算和其它执行护栏，不误关3249或把一次绿称作旧故障已修。',
].join('\n');

const body = (done: string) => `## 场景\n\n某个超时。\n\n## 怎么算做完\n\n${done}\n`;
const ORDINARY_DONE = '- 新增 packages/engine/test/foo.test.ts，断言 bar 返回 3。\n- pnpm check 通过。';

function setup(rawRequest: string, state: 'stalled' | 'stopped', holdFails = false) {
  const store = createMemoryStore(devFixtures(T0));
  const task = store.data.tasks.find((row) => row.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 #12');
  Object.assign(task, { rawRequest, state });
  const out: string[] = [];
  const err: string[] = [];
  const sent: { name: string }[] = [];
  const redos: unknown[] = [];
  const holds: LocalHoldInput[] = [];
  const deps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    now: () => T0,
    openStore: async () => ({ store, close: async () => {} }),
    openTaskControl: async () => ({
      workflows: {
        async signal(_workflowId: string, signal: TaskSignal) {
          sent.push({ name: signal.name });
        },
        async runningTaskWorkflow() {
          return 'task:example/canary#12';
        },
      },
      taskRedo: {
        redo: async (input: unknown) => {
          redos.push(input);
          return { ok: true as const, workflowId: 'task:example/canary#12:r2', generation: 2 };
        },
      },
      close: async () => {},
    }),
    openLocalHold: async () => ({
      hold: async (input: LocalHoldInput) => {
        if (holdFails) throw new Error('GitHub 403');
        holds.push(input);
      },
      close: async () => {},
    }),
  };
  return {
    store,
    out,
    err,
    sent,
    redos,
    holds,
    run: (args: string[]) => main(['task', ...args], deps as never),
  };
}

describe('fleet-api task：诊断型验收条的单不再续（#3602）', () => {
  it('#3414 的验收条原文：对它做「继续」被拒，不发信号，留言并交回本机，操作记录写拒绝', async () => {
    const h = setup(body(ISSUE_3414_DONE), 'stalled');
    const code = await h.run(['continue', 'example/canary', '12', '--note', NOTE]);
    expect(code).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.out).toEqual([]);
    expect(h.err.join('\n')).toContain('不续，已交回本机做');
    expect(h.holds).toHaveLength(1);
    expect(h.holds[0]).toMatchObject({ repo: { owner: 'example', name: 'canary' }, issueNumber: 12 });
    expect(h.holds[0]?.comment).toContain('核实原场景卡在哪个COMMIT');
    expect(h.holds[0]?.comment).toContain(LOCAL_LABEL);
    expect(h.store.data.audit.filter((a) => a.action === 'task.continue')).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
  });

  it('#3414 的验收条原文：task.redo 也被拒，不另起一代', async () => {
    const h = setup(body(ISSUE_3414_DONE), 'stopped');
    const code = await h.run(['redo', 'example/canary', '12', '--note', '重做']);
    expect(code).toBe(1);
    expect(h.redos).toEqual([]);
    expect(h.holds).toHaveLength(1);
    expect(h.err.join('\n')).toContain('task.redo');
  });

  it('普通单的「继续」「重做」不受影响，也不碰 GitHub', async () => {
    const a = setup(body(ORDINARY_DONE), 'stalled');
    expect(await a.run(['continue', 'example/canary', '12', '--note', NOTE])).toBe(0);
    expect(a.sent.map((s) => s.name)).toEqual(['taskContinue', 'taskRouteWake']);
    expect(a.holds).toEqual([]);
    const b = setup(body(ORDINARY_DONE), 'stopped');
    expect(await b.run(['redo', 'example/canary', '12', '--note', '重做'])).toBe(0);
    expect(b.redos).toHaveLength(1);
    expect(b.holds).toEqual([]);
  });

  it('【故意造出的失败】交回本机的留言 / 贴标签写不成：照样不续，原因里照实写没贴成', async () => {
    const h = setup(body(ISSUE_3414_DONE), 'stalled', true);
    const code = await h.run(['continue', 'example/canary', '12', '--note', NOTE]);
    expect(code).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.err.join('\n')).toContain('GitHub 403');
    expect(h.err.join('\n')).toContain('请手动贴');
    expect(h.err.join('\n')).not.toContain('已交回本机做');
  });

  it('读不出「怎么算做完」的单（本机领的、正文没有这一节）：判不了就不拦', async () => {
    const h = setup('只有一句标题', 'stalled');
    expect(await h.run(['continue', 'example/canary', '12', '--note', NOTE])).toBe(0);
    expect(h.holds).toEqual([]);
  });
});
