// 看门狗提醒的受控修复（#3033）：POST /api/notifications/:id/repair 和列表上的 repair。
// 两条贯通：检测器的出口落进内存库，再走真路由：
//   发现 → 落库 → 列出当前动作 → 选择 → 同一个操作接活 → 执行 / 核验 → 结果写回原卡。
// 1. idle-running：能安全恢复——发「继续」两下信号只记 accepted，任务行动了才核成 verified，卡由检测器自己撤。
// 2. 发版卡住（running）：现有恢复入口不开，只剩「交给修复」；开单失败卡保留，重试开成一张，同一 incident 不开第二张。
// 另外：要人本人拍的发版恢复动作（选项 / 先不动 / 自由输入 / 不答）、409 全家（条件变了、已撤、incident 对不上、动作过期、
// 在途、结果未知）、幂等重放、状态落库。
// 关于「真检测器」：api 不依赖 engine（给 api 加 engine 依赖会让每个 engine 改动都连带测 api，ci-plan 钉着不许），所以这里的
// detector* 是照引擎检测器的出口（键、标题、撤卡口径）写的替身。键的写法在引擎那头各有钉子：发版卡住的
// watchdog:release:train:<提交前 12 位>:running 由引擎 watchdog 测试按字面核；idle-running 的前缀是引擎 idle-running.ts 的
// IDLE_RUNNING_ALERT_PREFIX。改了键的写法，要连 alert-repair.ts 的 IDLE_PREFIX、RELEASE_KEY 和这里的替身一起改。
import { checkIssueBody } from '@fleet-dao/conventions';
import type { AlertRepairRecord } from '@fleet-dao/shared';
import { NotificationsResponse, TASK_SIGNAL_NAMES, WEB_API_PREFIX } from '@fleet-dao/shared';
import { devFixtures, IDS, type MemoryData } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type AlertRepairPort, repairSettingKey } from '../src/alert-repair.ts';
import type { FranceReleasePort } from '../src/france-release.ts';
import { type TaskSignal, WorkflowGoneError, WorkflowUnavailableError } from '../src/ports.ts';
import { harness, T0, write } from './harness.ts';

/** 内存版装配：测试直接读写 store.data（提醒、设置）。 */
type Harness = ReturnType<typeof harness>;
/** 修复接口的回包（成功带 repair，409 带 error）。 */
interface RepairJson {
  replayed?: boolean;
  repair: AlertRepairRecord;
  error: { code: string; message: string };
}
interface OpenedIssue {
  repo: { owner: string; name: string };
  key: string;
  title: string;
  body: string;
  labels: string[];
}

const LIST = `${WEB_API_PREFIX}/notifications?status=all`;
const repairPath = (id: string) => `${WEB_API_PREFIX}/notifications/${id}/repair`;
const iso = (minutesAgo: number) => new Date(T0.getTime() - minutesAgo * 60_000).toISOString();
const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const HEAD = `2005b290${'a'.repeat(32)}`;
const uuid = () => crypto.randomUUID();

function data(masterOn: boolean | null = null): Partial<MemoryData> {
  const d = devFixtures(T0);
  return {
    ...d,
    repos: [...(d.repos ?? []), SELF],
    ...(masterOn === null
      ? {}
      : {
          settings: [
            ...(d.settings ?? []),
            { key: 'engine.master', value: masterOn, version: 1, updatedAt: iso(5), updatedBy: 'u' },
          ],
        }),
  };
}

/** 引擎检测器的提醒出口接到内存库：raise 按键原地改并重开，resolve 写已撤。 */
function alertsAdapter(h: Harness) {
  const list = h.store.data.notifications;
  return {
    async openByPrefix(prefix: string) {
      return list
        .filter((n) => n.dedupeKey?.startsWith(prefix) && n.resolvedAt === undefined)
        .map((n) => ({ dedupeKey: n.dedupeKey ?? '', title: n.title, body: n.body }));
    },
    async raise(input: { dedupeKey: string; title: string; body: string; link: string }) {
      const hit = list.find((n) => n.dedupeKey === input.dedupeKey);
      if (hit) {
        Object.assign(hit, { title: input.title, body: input.body, resolvedAt: undefined });
        return;
      }
      list.push({
        id: uuid(),
        level: 'alert',
        title: input.title,
        body: input.body,
        link: input.link,
        createdAt: T0.toISOString(),
        deliveries: [],
        dedupeKey: input.dedupeKey,
      });
    },
    async resolve(input: { dedupeKey: string; why: string }) {
      const hit = list.find((n) => n.dedupeKey === input.dedupeKey);
      if (!hit) return 'not_found' as const;
      if (hit.resolvedAt !== undefined) return 'already_resolved' as const;
      hit.resolvedAt = T0.toISOString();
      hit.resolvedBy = 'engine:watchdog';
      return 'ok' as const;
    },
  };
}

/** 任务行的现状（可变）：测试里改它来模拟引擎有没有动。 */
function idleWorld() {
  return {
    present: true,
    updatedAt: iso(60) as string | null,
    openRuns: 0,
    doing: '换路由续之后睡在等选路里',
  };
}

/** 照 watchIdleRunning 的出口：条件成立（没有开着的会话、任务行 20 分钟没动）就按键报，不成立就把开着的撤掉。 */
async function runIdleDetector(h: Harness, world: ReturnType<typeof idleWorld>) {
  const alerts = alertsAdapter(h);
  const key = `watchdog:idle-running:${IDS.task12}`;
  const stale = world.updatedAt === null || T0.getTime() - Date.parse(world.updatedAt) >= 20 * 60_000;
  if (world.openRuns === 0 && stale) {
    await alerts.raise({
      dedupeKey: key,
      title: '在干活但没有开着的会话：example/canary#12',
      body: `example/canary#12 状态是 running、执行者是引擎，没有 ended_at 为空的会话。\n进度：${world.doing}`,
      link: '/',
    });
    return { found: 1 };
  }
  await alerts.resolve({ dedupeKey: key, why: '这张单不再是「在干活但没有开着的会话」' });
  return { found: 0 };
}

function idlePort(
  world: ReturnType<typeof idleWorld>,
  issues: { calls: OpenedIssue[]; failWith?: Error } = { calls: [] },
): AlertRepairPort {
  return {
    idleTask: async (taskId) =>
      world.present
        ? { taskId, updatedAt: world.updatedAt, doing: world.doing, openRuns: world.openRuns }
        : null,
    openIssue: async (input) => {
      issues.calls.push(input);
      if (issues.failWith) throw issues.failWith;
      return {
        number: 3100,
        url: 'https://github.com/thoerwink8/fleet-dao/issues/3100',
        created: issues.calls.length === 1,
      };
    },
  };
}

async function session(h: Harness) {
  return h.login();
}

async function list(h: Harness, s: { cookie: string }) {
  const res = await h.cockpit.request(LIST, { headers: { cookie: s.cookie } });
  expect(res.status).toBe(200);
  return NotificationsResponse.parse(await res.json());
}

async function post(
  h: Harness,
  s: { cookie: string; csrf: string },
  id: string,
  body: Record<string, unknown>,
) {
  const res = await h.cockpit.request(repairPath(id), write('POST', s, body));
  return { status: res.status, json: (await res.json()) as RepairJson };
}

const repairAudits = async (h: Harness) =>
  (await h.store.listAudit({ limit: 100 })).items.filter((a) => a.action === 'alert.repair');

function openAlert(h: Harness, keyPrefix: string) {
  const n = h.store.data.notifications.find((x) => x.dedupeKey?.startsWith(keyPrefix));
  if (!n) throw new Error(`没有 ${keyPrefix} 的提醒`);
  return n;
}

describe('idle-running：检测器 → 落库 → 当前动作 → 点 → 受理 → 核验 → 卡自己撤', () => {
  it('发「继续」只记 accepted；任务行动了才核成 verified；同一幂等身份重放不再发信号', async () => {
    const world = idleWorld();
    const h = harness({ data: data() });
    h.deps.alertRepair = idlePort(world);
    const found = await runIdleDetector(h, world);
    expect(found.found).toBe(1);
    const alert = openAlert(h, 'watchdog:idle-running:');
    expect(alert.dedupeKey).toBe(`watchdog:idle-running:${IDS.task12}`);

    const s = await session(h);
    const before = (await list(h, s)).items.find((n) => n.id === alert.id);
    const repair = before?.repair;
    expect(repair).toBeDefined();
    // 动作绑定明确的任务、仓、当前工作流；不是从正文猜的
    const recover = repair?.actions.find((a) => a.kind === 'task-recover');
    expect(recover?.target).toMatchObject({
      taskId: IDS.task12,
      issueNumber: 12,
      repo: { owner: 'example', name: 'canary' },
      workflowId: 'task:example/canary#12',
    });
    expect(recover?.choice).toBeUndefined();
    // 全局归属明确：交给修复开在 fleet-dao，不跟任务走
    expect(repair?.actions.find((a) => a.kind === 'hand-to-repair')?.target.repo).toEqual({
      owner: 'thoerwink8',
      name: 'fleet-dao',
    });
    expect(before?.level).toBe('alert');
    expect(before?.options).toBeUndefined();

    const requestId = uuid();
    const sent = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId,
    });
    expect(sent.status).toBe(200);
    expect(sent.json.replayed).toBe(false);
    expect(sent.json.repair).toMatchObject({ state: 'accepted', kind: 'task-recover', requestId });
    expect(sent.json.repair.check).toMatchObject({ ok: false });
    // 真发了两下：先继续、再路由叫醒，发给当前工作流
    expect(h.signals.map((x) => [x.workflowId, x.signal.name])).toEqual([
      ['task:example/canary#12', TASK_SIGNAL_NAMES.continue],
      ['task:example/canary#12', TASK_SIGNAL_NAMES.routeWake],
    ]);
    // 受理不撤卡；列表上这张卡写着「已受理、未修好」，同一个动作不再给按钮
    const mid = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(mid?.resolvedAt).toBeUndefined();
    expect(mid?.repair?.last).toMatchObject({ state: 'accepted', check: { ok: false } });
    expect(mid?.repair?.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);

    // 同一幂等身份重放：回原结果，信号不再发
    const replay = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId,
    });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(h.signals).toHaveLength(2);
    // 新身份重复点同一个动作：已受理等核验，409，不重复发
    const again = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId: uuid(),
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('repair_pending_verify');
    expect(h.signals).toHaveLength(2);

    // 状态落在设置表，每次写都有操作记录
    const saved = h.store.data.settings.find((x) => x.key === repairSettingKey(alert.id));
    expect(saved?.value).toMatchObject({ state: 'accepted', actionId: recover?.id });
    expect((await repairAudits(h)).length).toBeGreaterThanOrEqual(2);

    // 引擎有了反应（任务行更新了）：原条件不再成立，核成 verified；检测器下一轮自己撤卡
    world.updatedAt = iso(1);
    const after = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(after?.repair?.last).toMatchObject({ state: 'verified', check: { ok: true } });
    await runIdleDetector(h, world);
    const done = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(done?.resolvedAt).toBeDefined();
    expect(done?.repair?.actions).toEqual([]);
    expect(done?.repair?.last?.state).toBe('verified');
  });

  it('【故意造出的失败】条件变了、已撤、incident 对不上、动作不是服务端给的：全是 409，一个信号都不发', async () => {
    const world = idleWorld();
    const h = harness({ data: data() });
    h.deps.alertRepair = idlePort(world);
    await runIdleDetector(h, world);
    const alert = openAlert(h, 'watchdog:idle-running:');
    const s = await session(h);
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const recover = view?.actions.find((a) => a.kind === 'task-recover');
    const body = { actionId: recover?.id, incident: view?.incident, requestId: uuid() };

    const forged = await post(h, s, alert.id, { ...body, actionId: 'task-recover:forged' });
    expect([forged.status, forged.json.error.code]).toEqual([409, 'action_expired']);
    const wrongIncident = await post(h, s, alert.id, { ...body, incident: 'deadbeef0000' });
    expect([wrongIncident.status, wrongIncident.json.error.code]).toEqual([409, 'incident_mismatch']);

    // 点之前任务行动了（证据变了）：旧动作编号过期
    world.updatedAt = iso(2);
    const stale = await post(h, s, alert.id, body);
    expect([stale.status, stale.json.error.code]).toEqual([409, 'action_expired']);
    // 条件整个变了（任务有会话了）：列表里不再给任务继续，说明原因
    world.openRuns = 1;
    const changed = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(changed?.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);
    expect(changed?.problems.join('；')).toContain('条件已变');

    // 提醒已撤
    world.openRuns = 0;
    alert.resolvedAt = T0.toISOString();
    const resolved = await post(h, s, alert.id, body);
    expect([resolved.status, resolved.json.error.code]).toEqual([409, 'alert_resolved']);
    // 不存在的提醒 404
    expect((await post(h, s, uuid(), body)).status).toBe(404);
    expect(h.signals).toEqual([]);
    expect(h.store.data.settings.some((x) => x.key.startsWith('alert.repair:'))).toBe(false);
  });

  it('信号回执未知：记 unknown，不自动重试，也不核成修好；确定没发出去（工作流已结束）记 failed，可以重来', async () => {
    const world = idleWorld();
    let mode: 'unknown' | 'gone' | 'ok' = 'unknown';
    const sent: TaskSignal[] = [];
    const h = harness({
      data: data(),
      workflows: {
        async signal(_id, signal) {
          if (mode === 'unknown') throw new WorkflowUnavailableError('Temporal 超时');
          if (mode === 'gone') throw new WorkflowGoneError('task:example/canary#12');
          sent.push(signal);
        },
      },
    });
    h.deps.alertRepair = idlePort(world);
    await runIdleDetector(h, world);
    const alert = openAlert(h, 'watchdog:idle-running:');
    const s = await session(h);
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const recover = view?.actions.find((a) => a.kind === 'task-recover');
    const click = () =>
      post(h, s, alert.id, { actionId: recover?.id, incident: view?.incident, requestId: uuid() });

    const unknown = await click();
    expect(unknown.json.repair).toMatchObject({ state: 'unknown' });
    // 结果未知：同一个动作再点是 409，不盲重试
    const blocked = await click();
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('unknown');

    // 另一张提醒上，确定没发出去：failed，卡保留，能重来
    const h2 = harness({
      data: data(),
      workflows: {
        async signal() {
          if (mode === 'gone') throw new WorkflowGoneError('task:example/canary#12');
          sent.push({ name: TASK_SIGNAL_NAMES.continue, by: 'x' });
        },
      },
    });
    mode = 'gone';
    h2.deps.alertRepair = idlePort(world);
    await runIdleDetector(h2, world);
    const alert2 = openAlert(h2, 'watchdog:idle-running:');
    const s2 = await session(h2);
    const view2 = (await list(h2, s2)).items.find((n) => n.id === alert2.id)?.repair;
    const act2 = view2?.actions.find((a) => a.kind === 'task-recover');
    const failed = await post(h2, s2, alert2.id, {
      actionId: act2?.id,
      incident: view2?.incident,
      requestId: uuid(),
    });
    expect(failed.json.repair).toMatchObject({ state: 'failed' });
    expect(failed.json.repair.text).toContain('没发出去');
    expect((await list(h2, s2)).items.find((n) => n.id === alert2.id)?.resolvedAt).toBeUndefined();
    mode = 'ok';
    const retried = await post(h2, s2, alert2.id, {
      actionId: act2?.id,
      incident: view2?.incident,
      requestId: uuid(),
    });
    expect(retried.json.repair.state).toBe('accepted');
    expect(sent.length).toBeGreaterThan(0);
  });
});

/** 发版进度记录的替身。phase 是下标（3 等收尾、4 发版、7 恢复）。 */
function train(
  status: string,
  phase: number,
  opts: { marker?: boolean; beforeMaster?: boolean | null; startedAt?: string } = {},
): FranceReleasePort {
  return {
    readStateFiles: async () => ({
      stateJson: JSON.stringify({
        schema: 1,
        status,
        phase,
        why: null,
        target: { kind: 'sha', value: HEAD },
        updatedAt: iso(90),
        startedAt: opts.startedAt ?? iso(120),
        ...(opts.beforeMaster === undefined ? {} : { before: { master: opts.beforeMaster } }),
      }),
      marker: opts.marker ?? false,
    }),
  };
}

function requestPort() {
  const written: string[] = [];
  return {
    written,
    port: {
      receiverInstalled: async () => ({ ok: true as const }),
      pendingRequest: async () => false,
      readLast: async () => null,
      writeRequest: async (text: string) => {
        written.push(text);
      },
    },
  };
}

describe('发版卡住（看门狗检测器的出口）：没有直接恢复入口时只能交给修复，失败保留、成功只开一张', () => {
  it('进度停在 running 超 70 分钟报的卡：恢复入口不开 → 只剩交给修复；开单失败卡保留，重试开成，再点不开第二张', async () => {
    const req = requestPort();
    const h = harness({ data: data(), releaseRequest: req.port, franceRelease: train('running', 4) });
    const issues: { calls: OpenedIssue[]; failWith?: Error } = {
      calls: [],
      failWith: new Error('GitHub 502'),
    };
    h.deps.alertRepair = idlePort(idleWorld(), issues);
    // 照 judgeReleaseAttention 的出口：键 watchdog:release:train:<提交前 12 位>:running
    const verdict = {
      key: `watchdog:release:train:${HEAD.slice(0, 12)}:running`,
      title: `发版卡住：${HEAD.slice(0, 12)} 这一趟超过 70 分钟没收尾，自动发版停着`,
      body: '正在发这一趟的进度停在「running」，超过 70 分钟没收尾',
    };
    await alertsAdapter(h).raise({
      dedupeKey: verdict.key,
      title: verdict.title,
      body: verdict.body,
      link: '/france',
    });
    const alert = openAlert(h, 'watchdog:release:');
    const s = await session(h);
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(view?.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);
    expect(view?.problems.join('；')).toContain('入口此刻都没开');
    const hand = view?.actions[0];

    // 开单失败：记 failed，卡保留，没有假单号
    const failed = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(failed.json.repair).toMatchObject({ state: 'failed' });
    expect(failed.json.repair.issue).toBeUndefined();
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.resolvedAt).toBeUndefined();

    // 重试：开成，返回真实单号并关联原卡
    delete issues.failWith;
    const ok = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(ok.json.repair).toMatchObject({
      state: 'handed',
      issue: { repo: { owner: 'thoerwink8', name: 'fleet-dao' }, number: 3100, created: expect.any(Boolean) },
    });
    const opened = issues.calls.at(-1);
    if (!opened) throw new Error('没开过单');
    expect(opened.repo).toEqual({ owner: 'thoerwink8', name: 'fleet-dao' });
    expect(opened.key).toBe(`alert-repair:${view?.incident}`);
    expect(opened.labels).toContain('缺陷');
    // 合规四节单
    expect(checkIssueBody(opened.body).ok).toBe(true);
    for (const sec of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
      expect(opened.body).toContain(sec);
    expect(opened.body).toContain(verdict.key);

    // 同一 incident 再点（新身份）：不再开单，回原来那张
    const callsBefore = issues.calls.length;
    const dup = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(dup.status).toBe(200);
    expect(dup.json.repair.issue?.number).toBe(3100);
    expect(issues.calls).toHaveLength(callsBefore);
    // 列表上这张卡带着单号，卡仍开着（单修好、看门狗撤才算完）
    const card = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(card?.repair?.last).toMatchObject({ state: 'handed', issue: { number: 3100 } });
    expect(card?.resolvedAt).toBeUndefined();
    expect(req.written).toEqual([]);
  });

  it('没接上开单（开发环境）：不出现「交给修复」，原因写在 problems，不假装能修', async () => {
    const h = harness({ data: data() });
    h.deps.alertRepair = { idleTask: async () => null };
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: '某个定时任务停了',
      body: 'x',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: 'watchdog:job:backup:no-success',
    });
    const s = await session(h);
    const item = (await list(h, s)).items.find((n) => n.dedupeKey === 'watchdog:job:backup:no-success');
    expect(item?.repair?.actions).toEqual([]);
    expect(item?.repair?.problems.join('；')).toContain('立刻重跑');
    expect(item?.repair?.problems.join('；')).toContain('开单没接上');
    // 别的级别 / 非看门狗的提醒没有 repair
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: '别的提醒',
      body: '',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: 'quota-read:pool-a',
    });
    const other = (await list(h, s)).items.find((n) => n.dedupeKey === 'quota-read:pool-a');
    expect(other?.repair).toBeUndefined();
  });
});

describe('要人本人拍的发版恢复动作：选项 / 推荐 / 自由输入；拒绝、没选、自由输入都不执行', () => {
  const failedKey = `watchdog:release:train:${HEAD.slice(0, 12)}:failed`;
  function seed(h: Harness) {
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: `发版没成：${HEAD.slice(0, 12)} 恢复那一步没成`,
      body: '恢复引擎开关没成',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: failedKey,
    });
    return openAlert(h, failedKey);
  }

  it('带 choice（两项以上、恰好一项推荐、允许自己写）；没选 409；先不动 / 自己写只记 declined；选执行才写请求文件，核验读引擎总开关', async () => {
    const req = requestPort();
    const h = harness({
      data: data(false),
      releaseRequest: req.port,
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    h.deps.alertRepair = idlePort(idleWorld());
    const alert = seed(h);
    const s = await session(h);
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const restore = view?.actions.find((a) => a.kind === 'release-restore');
    expect(restore?.target.sha).toBe(HEAD);
    expect(restore?.choice?.allowText).toBe(true);
    expect(restore?.choice?.options.map((o) => o.id)).toEqual(['do', 'hold']);
    expect(restore?.choice?.options.filter((o) => o.recommended)).toHaveLength(1);
    const base = { actionId: restore?.id, incident: view?.incident };

    const none = await post(h, s, alert.id, { ...base, requestId: uuid() });
    expect([none.status, none.json.error.code]).toEqual([409, 'choice_required']);
    const bad = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'nuke' });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'unknown_option']);
    const hold = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'hold' });
    expect(hold.json.repair).toMatchObject({ state: 'declined', optionId: 'hold' });
    const text = await post(h, s, alert.id, { ...base, requestId: uuid(), text: '我先看看再说' });
    expect(text.json.repair).toMatchObject({ state: 'declined' });
    expect(req.written).toEqual([]);

    const go = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'do' });
    expect(go.json.repair).toMatchObject({ state: 'accepted', kind: 'release-restore', optionId: 'do' });
    expect(go.json.repair.check).toMatchObject({ ok: false });
    expect(req.written).toHaveLength(1);
    expect(JSON.parse(req.written[0] ?? '{}')).toMatchObject({ v: 1, kind: 'restore' });
    expect((await h.store.listAudit({ limit: 100 })).items.map((a) => a.action)).toContain('release.restore');
    // 请求只是写出去了：卡不撤、不记修好；引擎总开关开回来才核成 verified
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('accepted');
    const master = h.store.data.settings.find((x) => x.key === 'engine.master');
    if (master) master.value = true;
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'verified',
      check: { ok: true },
    });
  });

  it('【故意造出的失败】请求文件写不出去：记 failed 不记成功；上一份请求没被接走时不给动作；读不到进度记录不给动作', async () => {
    const req = requestPort();
    req.port.writeRequest = async () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
    };
    const h = harness({
      data: data(false),
      releaseRequest: req.port,
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    h.deps.alertRepair = idlePort(idleWorld());
    const alert = seed(h);
    const s = await session(h);
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const restore = view?.actions.find((a) => a.kind === 'release-restore');
    const res = await post(h, s, alert.id, {
      actionId: restore?.id,
      incident: view?.incident,
      requestId: uuid(),
      optionId: 'do',
    });
    expect(res.json.repair).toMatchObject({ state: 'failed' });
    expect(res.json.repair.text).toContain('没写出去');
    const failedAudit = (await h.store.listAudit({ limit: 100 })).items.filter(
      (a) => a.action === 'release.restore' && !a.ok,
    );
    expect(failedAudit).toHaveLength(1);

    const pending = harness({
      data: data(false),
      releaseRequest: { ...requestPort().port, pendingRequest: async () => true },
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    pending.deps.alertRepair = idlePort(idleWorld());
    const a2 = seed(pending);
    const p = (await list(pending, await session(pending))).items.find((n) => n.id === a2.id)?.repair;
    expect(p?.actions.some((a) => a.kind === 'release-restore')).toBe(false);
    expect(p?.problems.join('；')).toContain('还没被法国接走');

    const unreadable = harness({
      data: data(false),
      releaseRequest: requestPort().port,
      franceRelease: {
        readStateFiles: async () => {
          throw new Error('读不了');
        },
      },
    });
    unreadable.deps.alertRepair = idlePort(idleWorld());
    const a3 = seed(unreadable);
    const u = (await list(unreadable, await session(unreadable))).items.find((n) => n.id === a3.id)?.repair;
    expect(u?.actions.some((a) => a.kind.startsWith('release-'))).toBe(false);
  });
});
