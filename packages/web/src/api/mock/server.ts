// 假后端：实现 FleetApi，数据放在内存里，带一个模拟器让盘面「活」起来。
// 每个返回都按 shared/web-api.ts 校验后才交出去（和真后端的 reply 一样），报错的 code 和白话也照真后端。
// 页面上的操作会真的改这里的状态并留下操作记录；刷新页面就回到初始盘面。
import {
  AuditResponse,
  AuthConfigResponse,
  BoardResponse,
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  DEMO_MODULES,
  DEMO_STRICT_DEFAULT,
  DemoLinksResponse,
  type DemoScope,
  HARD_BANS,
  type HostId,
  hardBanFor,
  JobsResponse,
  MeResponse,
  NotificationsResponse,
  PoolsResponse,
  type RealtimeTable,
  ReposResponse,
  RoutingResponse,
  type RunOutcome,
  RunStepsResponse,
  SETTING_SCHEMAS,
  type SessionRun,
  type SettingKey,
  SettingsResponse,
  type StageKind,
  StageKindSchema,
  type Step,
  TaskActionRequest,
  TaskDetailResponse,
  TimelineResponse,
  UpdateChannelRequest,
  UpdateDemoDefaultRequest,
  UpdateSettingRequest,
  UpdateSettingResponse,
  UpdateStagePolicyRequest,
  UpdateStagePolicyResponse,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { sha256Hex } from '../../demo/scope';
import { ApiError, type FleetApi } from '../client';
import type { AuditEntry, DemoLink, LiveEvent } from '../types';
import type { MLog, MockState, MSubtask, MTask } from './model';
import { createSeed, fakeAction } from './seed';

export interface MockOptions {
  /** 是否开模拟器；测试里关掉，手动调 tick()。 */
  live?: boolean;
  tickMs?: number;
  /** 每次请求的假延迟（毫秒）。 */
  latencyMs?: number;
  now?: () => number;
  seed?: number;
}

export interface MockApi extends FleetApi {
  /** 推进一拍模拟。 */
  tick(): void;
  stop(): void;
  /** 测试用：直接看内部状态。 */
  state(): MockState;
}

/** 和真后端 views.ts 的 STAGE_WORDS 一个说法。 */
const STAGE_WORDS: Record<StageKind, string> = {
  triage: '分诊',
  spec: '写需求文档',
  plan: '写方案',
  execute: '写码',
  ui: '写界面',
  review: '审查',
  research: '调研',
  judge: '判断',
};
const ACTION_WORDS = { pause: '暂停', resume: '继续', stop: '叫停', reroute: '换路由' } as const;
const STALE_MS = 30 * 60_000;
const TERMINAL = new Set(['done', 'stopped', 'failed']);
const GENERIC_STEPS = ['读相关代码', '改代码', '写测试', '跑测试并开 PR'];

/** 可复现的随机数（mulberry32）。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isRunning(r: SessionRun): boolean {
  return Boolean(r.startedAt) && !r.endedAt;
}

function latestActive(runs: SessionRun[]): SessionRun | undefined {
  let best: SessionRun | undefined;
  for (const r of runs) {
    if (r.endedAt) continue;
    if (!best || (r.startedAt ?? r.queuedAt) > (best.startedAt ?? best.queuedAt)) best = r;
  }
  return best;
}

function page<T extends { id: string }>(
  items: T[],
  at: (x: T) => string,
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor?: string } {
  const sorted = [...items].sort((a, b) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id));
  let start = 0;
  if (cursor) {
    const sep = cursor.lastIndexOf('|');
    const cAt = cursor.slice(0, sep);
    const cId = cursor.slice(sep + 1);
    start = sorted.findIndex((x) => at(x) < cAt || (at(x) === cAt && x.id < cId));
    if (start === -1) start = sorted.length;
  }
  const slice = sorted.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return last && start + limit < sorted.length
    ? { items: slice, nextCursor: `${at(last)}|${last.id}` }
    : { items: slice };
}

export function createMockApi(opts: MockOptions = {}): MockApi {
  const now = opts.now ?? (() => Date.now());
  const rand = rng(opts.seed ?? 20260925);
  const st = createSeed(now());
  const listeners = new Set<(e: LiveEvent) => void>();
  let counter = 0;
  /** 进合并队列的先后。 */
  const queuedAt = new Map<string, number>();
  /** 演示链接：只在内存里，不真发布（假数据模式没有后端的发布目录）。 */
  const demo: {
    links: Omit<DemoLink, 'expired'>[];
    defaultScope: DemoScope;
    defaultPublished: boolean;
  } = { links: [], defaultScope: DEMO_STRICT_DEFAULT, defaultPublished: false };

  const iso = () => new Date(now()).toISOString();
  const nextId = (p: string) => `${p}-${++st.seq}`;
  const wait = () =>
    opts.latencyMs
      ? new Promise<void>((r) => setTimeout(r, (opts.latencyMs ?? 0) * (0.6 + rand() * 0.8)))
      : Promise.resolve();

  /** 只推 shared/realtime.ts 名单里的表：真后端也只推这些，假数据不多给。 */
  function emit(table: RealtimeTable, id: string) {
    for (const l of listeners) l({ type: 'change', table, id });
  }

  const meActor = () => ({ kind: 'user' as const, id: st.me.user.id, name: st.me.user.displayName });
  const engine = { kind: 'engine' as const, id: 'engine', name: '引擎' };

  function audit(e: Omit<AuditEntry, 'id' | 'at' | 'ok'> & { ok?: boolean }) {
    st.audit.unshift({ id: nextId('a'), at: iso(), ok: true, ...e });
    emit('audit_log', st.audit[0]?.id ?? '');
  }
  function log(tv: MTask, entry: Omit<MLog, 'id' | 'at' | 'taskId'>) {
    const l: MLog = { id: nextId('log'), at: iso(), taskId: tv.task.id, ...entry };
    st.logs.push(l);
    if (st.logs.length > 3000) st.logs.splice(0, st.logs.length - 3000);
    emit('progress_events', l.id);
  }

  function findTask(taskId: string): MTask {
    const tv = st.tasks.find((t) => t.task.id === taskId);
    if (!tv) throw new ApiError(404, 'task_not_found', '没有这个任务');
    return tv;
  }
  function allRuns(): SessionRun[] {
    return st.tasks.flatMap((t) => [...t.runs, ...t.subtasks.flatMap((s) => s.runs)]);
  }
  function routeInfo(routeId: string) {
    const route = st.routes.find((r) => r.id === routeId);
    const model = route ? st.models.find((m) => m.id === route.modelId) : undefined;
    const hostId: HostId | undefined = route?.hostId;
    return { route, model, modelName: model?.displayName ?? '未知模型', hostId };
  }
  function poolRunning(poolId: string): number {
    return allRuns().filter((r) => isRunning(r) && routeInfo(r.routeId).route?.poolId === poolId).length;
  }

  /** 和真后端 routeProblem 同一套判据：先硬禁令，再库里的禁令，再看下架。 */
  function routeProblem(routeId: string, stage: StageKind | undefined): string | null {
    const { route, model } = routeInfo(routeId);
    if (!route) return `路由 ${routeId} 不存在`;
    if (!model) return `路由 ${routeId} 用的模型 ${route.modelId} 不在模型目录里`;
    const where = stage ? `「${STAGE_WORDS[stage]}」` : '这里';
    const hard = hardBanFor(model, stage);
    if (hard) return `${model.displayName} 不能用在${where}：${hard.reason}`;
    const ban = st.bans.find((b) => {
      if (b.family === undefined && b.modelId === undefined) return false;
      if (b.family !== undefined && b.family.toLowerCase() !== model.family.toLowerCase()) return false;
      if (b.modelId !== undefined && b.modelId !== model.id) return false;
      if (b.stage !== undefined && b.stage !== stage) return false;
      return true;
    });
    if (ban) return `${model.displayName} 不能用在${where}：${ban.reason}`;
    if (model.retiredAt && model.retiredAt <= iso()) return `${model.displayName} 已下架`;
    return null;
  }

  // ---------- 投影成契约形状 ----------

  function activityOf(run: SessionRun, steps: Step[] | undefined) {
    const info = routeInfo(run.routeId);
    const queued = !run.startedAt;
    const step = steps?.find((s) => s.state === 'in_progress')?.title;
    const doing = queued ? '排队中' : `正在${(step ?? STAGE_WORDS[run.stage]).replace(/^正在/, '')}`;
    return {
      runId: run.id,
      stage: run.stage,
      routeId: run.routeId,
      modelName: info.modelName,
      hostId: info.hostId,
      queued,
      since: run.startedAt ?? run.queuedAt,
      step,
      text: `${info.modelName} ${doing}`,
    };
  }

  function subtaskView(s: MSubtask) {
    const run = latestActive(s.runs);
    // 步骤清单是写码会话报的；第二意见那个会话没报过步骤（和真后端一样，进度跟着当前会话走）。
    const steps = s.steps.length && run && run.stage !== 'review' ? s.steps : undefined;
    return {
      id: s.subtask.id,
      index: s.subtask.index,
      title: s.subtask.title,
      state: s.subtask.state,
      prNumber: s.subtask.prNumber,
      dependsOn: s.subtask.dependsOn,
      touches: s.subtask.touches,
      progress:
        run && steps
          ? { done: steps.filter((x) => x.state === 'done').length, total: steps.length }
          : undefined,
      activity: run ? activityOf(run, steps) : undefined,
    };
  }

  function repoView(repoId: string) {
    const repo = st.repos.find((r) => r.id === repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个仓');
    return { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
  }

  function boardOf(repoId: string) {
    const repo = repoView(repoId);
    const tasks = st.tasks
      .filter((t) => t.task.repoId === repoId)
      .sort((a, b) => a.task.priority - b.task.priority || a.task.createdAt.localeCompare(b.task.createdAt));
    const nowItems = tasks.flatMap((t) => [
      ...t.runs
        .filter((r) => !r.endedAt)
        .map((r) => ({ ...activityOf(r, undefined), taskId: t.task.id, taskTitle: t.task.title })),
      ...t.subtasks.flatMap((s) =>
        s.runs
          .filter((r) => !r.endedAt)
          .map((r) => ({
            ...activityOf(r, s.steps),
            taskId: t.task.id,
            taskTitle: t.task.title,
            subtaskId: s.subtask.id,
          })),
      ),
    ]);
    return BoardResponse.parse({
      repo,
      tasks: tasks.map((t) => {
        const front = latestActive(t.runs);
        return {
          id: t.task.id,
          issueNumber: t.task.issueNumber,
          title: t.task.title,
          state: t.task.state,
          priority: t.task.priority,
          requestedBy: t.task.requestedBy,
          createdAt: t.task.createdAt,
          progress: {
            done: t.subtasks.filter((s) => s.subtask.state === 'merged').length,
            total: t.subtasks.length,
          },
          activity: front ? activityOf(front, undefined) : undefined,
          subtasks: t.subtasks.map(subtaskView),
        };
      }),
      now: nowItems,
      asOf: iso(),
    });
  }

  function runView(r: SessionRun) {
    const info = routeInfo(r.routeId);
    return { ...r, modelName: info.modelName, hostId: info.hostId };
  }

  // ---------- 模拟器的小动作 ----------

  function subStage(sv: MSubtask): StageKind {
    const last = [...sv.runs].reverse().find((r) => r.stage === 'execute' || r.stage === 'ui');
    if (last) return last.stage;
    return sv.subtask.touches.some((p) => p.endsWith('.tsx') || p.includes('components/')) ? 'ui' : 'execute';
  }

  /** 按调度台的顺序选第一条能用的路由：在线、不犯禁令、渠道开着、账号池有空位。 */
  function pickRoute(stage: StageKind, avoid: string[] = []): string | undefined {
    const policy = st.stages.find((p) => p.stage === stage);
    for (const rid of policy?.routeIds ?? []) {
      if (avoid.includes(rid)) continue;
      const { route } = routeInfo(rid);
      if (!route?.alive) continue;
      if (!st.channels.find((c) => c.id === route.channelId)?.enabled) continue;
      if (routeProblem(rid, stage)) continue;
      const pool = st.pools.find((p) => p.id === route.poolId);
      if (pool && poolRunning(pool.id) >= pool.maxConcurrency) continue;
      return rid;
    }
    return undefined;
  }

  function startRun(tv: MTask, sv: MSubtask | undefined, stage: StageKind, routeId: string, why: string) {
    const r: SessionRun = {
      id: nextId('run'),
      taskId: tv.task.id,
      stage,
      routeId,
      whyRoute: why,
      queuedAt: iso(),
      startedAt: iso(),
    };
    if (sv) {
      r.subtaskId = sv.subtask.id;
      sv.runs.push(r);
    } else tv.runs.push(r);
    return r;
  }
  function endRun(r: SessionRun, outcome: RunOutcome) {
    if (r.endedAt) return;
    r.endedAt = iso();
    r.outcome = outcome;
    const minutes = Math.max(1, (Date.parse(r.endedAt) - Date.parse(r.startedAt ?? r.queuedAt)) / 60_000);
    r.inputTokens = Math.round(minutes * (7000 + rand() * 4000));
    r.outputTokens = Math.round(minutes * (500 + rand() * 300));
  }
  function setSubState(tv: MTask, sv: MSubtask, to: MSubtask['subtask']['state']) {
    const from = sv.subtask.state;
    if (from === to) return;
    sv.subtask.state = to;
    log(tv, { source: 'engine', kind: 'state', subtaskId: sv.subtask.id, text: `状态：${from} → ${to}` });
    emit('subtasks', sv.subtask.id);
  }
  function setTaskState(tv: MTask, to: MTask['task']['state']) {
    const from = tv.task.state;
    if (from === to) return;
    tv.task.state = to;
    log(tv, { source: 'engine', kind: 'state', text: `状态：${from} → ${to}` });
    emit('tasks', tv.task.id);
  }

  function startSubtask(tv: MTask, sv: MSubtask) {
    const stage = subStage(sv);
    const rid = pickRoute(stage);
    if (!rid) {
      setSubState(tv, sv, 'waiting_slot');
      return;
    }
    if (!sv.steps.length)
      sv.steps = GENERIC_STEPS.map((title, index) => ({ index, title, state: 'pending' }));
    const first = sv.steps.find((s) => s.state !== 'done');
    if (first) first.state = 'in_progress';
    sv.planUpdatedAt = iso();
    const r = startRun(tv, sv, stage, rid, `${STAGE_WORDS[stage]}阶段按顺序第一条有空位的`);
    setSubState(tv, sv, 'running');
    sv.lastSay = { text: `正在${first?.title ?? '干活'}`, at: iso() };
    log(tv, {
      source: 'session',
      kind: 'plan',
      runId: r.id,
      subtaskId: sv.subtask.id,
      text: planText(sv.steps),
    });
    audit({
      actor: engine,
      action: 'run.start',
      target: `task:${tv.task.id}`,
      after: { stage, routeId: rid },
      via: 'engine',
    });
  }

  function planText(steps: Step[]) {
    const done = steps.filter((s) => s.state === 'done').length;
    const cur = steps.find((s) => s.state === 'in_progress');
    return `步骤清单：完成 ${done}/${steps.length}${cur ? `，正在${cur.title.replace(/^正在/, '')}` : ''}`;
  }

  function openReview(tv: MTask, sv: MSubtask) {
    const exec = [...sv.runs].reverse().find((r) => r.stage === 'execute' || r.stage === 'ui');
    const family = exec ? routeInfo(exec.routeId).model?.family : undefined;
    // 第二意见换厂商：跳过和写码同族的路由。
    const avoid = st.routes
      .filter((r) => st.models.find((m) => m.id === r.modelId)?.family === family)
      .map((r) => r.id);
    const rid = pickRoute('review', avoid) ?? pickRoute('review');
    if (rid) startRun(tv, sv, 'review', rid, `第二意见换厂商：${routeInfo(rid).modelName}`);
  }

  function finishExecute(tv: MTask, sv: MSubtask) {
    const active = sv.runs.filter((r) => !r.endedAt && r.stage !== 'review');
    active.forEach((r, i) => {
      endRun(r, i === 0 ? 'ok' : 'stopped');
    });
    if (!sv.subtask.prNumber) {
      sv.subtask.prNumber = st.nextPr++;
      audit({
        actor: engine,
        action: 'pr.open',
        target: `task:${tv.task.id}`,
        after: { prNumber: sv.subtask.prNumber },
        via: 'engine',
      });
    }
    const winner = active[0];
    if (winner) {
      log(tv, {
        source: 'session',
        kind: 'done',
        runId: winner.id,
        subtaskId: sv.subtask.id,
        text: `交活：测试通过，PR #${sv.subtask.prNumber} 已开`,
      });
    }
    sv.lastSay = { text: `PR #${sv.subtask.prNumber} 已开，等第二意见`, at: iso() };
    setSubState(tv, sv, 'verifying');
    openReview(tv, sv);
  }

  function advanceStep(tv: MTask, sv: MSubtask, run: SessionRun) {
    const i = sv.steps.findIndex((s) => s.state === 'in_progress');
    const cur = sv.steps[i];
    if (!cur) {
      finishExecute(tv, sv);
      return;
    }
    cur.state = 'done';
    const next = sv.steps[i + 1];
    sv.planUpdatedAt = iso();
    if (next) {
      next.state = 'in_progress';
      sv.lastSay = { text: `正在${next.title}`, at: iso() };
      log(tv, {
        source: 'session',
        kind: 'plan',
        runId: run.id,
        subtaskId: sv.subtask.id,
        text: planText(sv.steps),
      });
      log(tv, {
        source: 'session',
        kind: 'say',
        runId: run.id,
        subtaskId: sv.subtask.id,
        text: `正在${next.title}`,
      });
      emit('subtasks', sv.subtask.id);
    } else {
      finishExecute(tv, sv);
    }
  }

  function merge(tv: MTask, sv: MSubtask) {
    queuedAt.delete(sv.subtask.id);
    sv.lastSay = { text: `PR #${sv.subtask.prNumber ?? ''} 已合并`, at: iso() };
    setSubState(tv, sv, 'merged');
    audit({
      actor: engine,
      action: 'pr.merge',
      target: `task:${tv.task.id}`,
      after: { prNumber: sv.subtask.prNumber },
      via: 'engine',
    });
    for (const dep of tv.subtasks) {
      if (dep.subtask.state !== 'waiting_deps') continue;
      const ready = dep.subtask.dependsOn.every(
        (d) => tv.subtasks.find((x) => x.subtask.id === d)?.subtask.state === 'merged',
      );
      if (ready) startSubtask(tv, dep);
    }
  }

  function materializePlan(tv: MTask) {
    const plan = st.plans[tv.task.id];
    setTaskState(tv, 'running');
    if (!plan?.length) return;
    delete st.plans[tv.task.id];
    tv.subtasks = plan.map((p, index) => ({
      subtask: {
        id: `${tv.task.id}-${String.fromCharCode(97 + index)}`,
        taskId: tv.task.id,
        index,
        title: p.title,
        touches: p.touches,
        dependsOn: [],
        state: 'pending',
      },
      steps: p.steps.map((title, i) => ({ index: i, title, state: 'pending' }) satisfies Step),
      runs: [],
      paused: false,
    }));
    for (const sv of tv.subtasks) startSubtask(tv, sv);
  }

  function notify(
    level: 'decision' | 'alert' | 'daily',
    title: string,
    body: string,
    link?: string,
    taskId?: string,
  ) {
    const n = {
      id: nextId('n'),
      level,
      title,
      body,
      createdAt: iso(),
      deliveries: [{ channel: 'feishu', delivered: true, attempts: 1, lastAttemptAt: iso() }],
      ...(link ? { link } : {}),
      ...(taskId ? { taskId } : {}),
    };
    st.notifications.unshift(n);
    emit('notifications', n.id);
  }

  // ---------- 模拟一拍 ----------
  let tickNo = 0;
  function tick() {
    tickNo += 1;
    const t = now();

    for (const tv of st.tasks) {
      const state = tv.task.state;
      if (tv.paused || TERMINAL.has(state)) continue;
      const front = latestActive(tv.runs);

      if (state === 'queued' && rand() < 0.03) {
        const rid = pickRoute('triage');
        if (rid) {
          startRun(tv, undefined, 'triage', rid, '分诊阶段排第一');
          setTaskState(tv, 'triaging');
        }
      } else if (state === 'triaging' && front && rand() < 0.1) {
        endRun(front, 'ok');
        log(tv, {
          source: 'session',
          kind: 'done',
          runId: front.id,
          text: '交活：分诊完成——写码类、说清楚了、不碰人闸',
        });
        startRun(tv, undefined, 'spec', pickRoute('spec') ?? front.routeId, '需求文档阶段排第一');
        setTaskState(tv, 'planning');
      } else if (state === 'planning' && front) {
        if (front.stage === 'spec' && rand() < 0.08) {
          endRun(front, 'ok');
          if (!tv.task.specDir) tv.task.specDir = `specs/${tv.task.issueNumber}`;
          startRun(tv, undefined, 'plan', pickRoute('plan') ?? front.routeId, '方案阶段已钉住，排第一');
          emit('tasks', tv.task.id);
        } else if (front.stage === 'plan' && rand() < 0.05) {
          endRun(front, 'ok');
          log(tv, { source: 'session', kind: 'done', runId: front.id, text: '交活：方案写完，拆成子任务' });
          materializePlan(tv);
        }
      }

      for (const sv of tv.subtasks) {
        if (sv.paused) continue;
        const s = sv.subtask.state;
        if (s === 'running') {
          const run = latestActive(sv.runs);
          if (!run) continue;
          if (rand() < 0.4) {
            log(tv, {
              source: 'session',
              runId: run.id,
              subtaskId: sv.subtask.id,
              ...fakeAction(sv.subtask.touches, counter++),
            });
          }
          if (rand() < 0.07) advanceStep(tv, sv, run);
        } else if (s === 'verifying') {
          const review = sv.runs.find((r) => r.stage === 'review' && !r.endedAt);
          if (review) {
            if (rand() < 0.25) {
              log(tv, {
                source: 'session',
                runId: review.id,
                subtaskId: sv.subtask.id,
                kind: 'tool',
                text: `用工具：Read ${sv.subtask.touches[0] ?? 'README.md'}`,
              });
            }
            if (rand() < 0.08) {
              endRun(review, 'ok');
              log(tv, {
                source: 'session',
                runId: review.id,
                subtaskId: sv.subtask.id,
                kind: 'done',
                text: '交活：第二意见没有必须改的，2 条小毛病攒着批量修',
              });
              queuedAt.set(sv.subtask.id, t);
              sv.lastSay = { text: '排队合并', at: iso() };
              setSubState(tv, sv, 'in_merge_queue');
            }
          } else if (rand() < 0.15) {
            queuedAt.set(sv.subtask.id, t);
            setSubState(tv, sv, 'in_merge_queue');
          }
        } else if (s === 'waiting_slot' && rand() < 0.03) {
          startSubtask(tv, sv);
        } else if (s === 'pending') {
          startSubtask(tv, sv);
        }
      }

      const subs = tv.subtasks;
      if (subs.length && subs.every((x) => x.subtask.state === 'merged')) {
        setTaskState(tv, 'done');
        audit({
          actor: engine,
          action: 'task.close',
          target: `task:${tv.task.id}`,
          reason: '子任务都已合并，结果文档已写',
          via: 'engine',
        });
        notify('daily', `#${tv.task.issueNumber} 已完成`, tv.task.title, `/tasks/${tv.task.id}`, tv.task.id);
      } else if (
        tv.task.state === 'running' &&
        subs.length &&
        subs.every((x) => x.subtask.state === 'in_merge_queue' || x.subtask.state === 'merged')
      ) {
        setTaskState(tv, 'merging');
      }
    }

    // 合并队列：每个仓一次只合一个，先进先合。
    for (const repo of st.repos) {
      const queue = st.tasks
        .filter((x) => x.task.repoId === repo.id && !x.paused)
        .flatMap((x) => x.subtasks.map((s) => ({ tv: x, sv: s })))
        .filter(({ sv }) => sv.subtask.state === 'in_merge_queue')
        .sort((a, b) => (queuedAt.get(a.sv.subtask.id) ?? 0) - (queuedAt.get(b.sv.subtask.id) ?? 0));
      const head = queue[0];
      if (head && rand() < 0.12) merge(head.tv, head.sv);
    }

    // 额度：在跑的账号池慢慢往上走；过了清零时间就清零。
    for (const w of st.quota) {
      const running = poolRunning(w.poolId);
      let changed = false;
      if (w.resetsAt && Date.parse(w.resetsAt) <= t) {
        if (w.utilization !== undefined) w.utilization = 0.02;
        if (w.used !== undefined) w.used = 0;
        const len =
          w.window === '5h' ? 5 * 3_600_000 : w.window.startsWith('7d') ? 7 * 86_400_000 : 30 * 86_400_000;
        w.resetsAt = new Date(Date.parse(w.resetsAt) + len).toISOString();
        changed = true;
      }
      if (running > 0) {
        if (w.utilization !== undefined)
          w.utilization = Math.min(0.995, w.utilization + running * 0.0004 + rand() * 0.0003);
        if (w.used !== undefined) w.used = Math.round((w.used + running * 0.02) * 100) / 100;
        changed = true;
      }
      if (w.reading === 'measured' && tickNo % 8 === 0) {
        w.readAt = new Date(t).toISOString();
        changed = true;
      }
      if (changed) emit('quota_windows', w.poolId);
    }

    // 定时任务：到点就跑。
    for (const j of st.jobs) {
      if (Date.parse(j.nextRunAt) > t) continue;
      const started = new Date(t).toISOString();
      j.nextRunAt = new Date(t + j.expectEveryMinutes * 60_000).toISOString();
      if (j.keepsFailing) {
        j.lastRun = {
          startedAt: started,
          endedAt: started,
          outcome: j.keepsFailing,
          why: j.keepsFailing === 'unscanned' ? 'GitHub 接口限流，这次没查成' : 'ssh 连备份机超时',
        };
      } else {
        j.lastRun = { startedAt: started, endedAt: started, outcome: 'ok', found: 0 };
        j.lastSuccessAt = started;
      }
      // 定时任务的表不在推送名单里（和真后端一样），定时任务页靠定时重拉。
    }
  }

  // ---------- 接口 ----------

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.live) timer = setInterval(tick, opts.tickMs ?? 2600);

  const api: MockApi = {
    source: 'mock',
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state: () => st,

    async authConfig() {
      await wait();
      return AuthConfigResponse.parse({ devLogin: false });
    },
    async devLogin() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async feishuAccess() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async logout() {
      await wait();
    },
    async me() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async repos() {
      await wait();
      return ReposResponse.parse({ repos: st.repos });
    },
    async board(repoId) {
      await wait();
      return boardOf(repoId);
    },
    async task(taskId) {
      await wait();
      const tv = findTask(taskId);
      return TaskDetailResponse.parse({
        task: tv.task,
        repo: repoView(tv.task.repoId),
        subtasks: tv.subtasks.map(subtaskView),
        runs: [...tv.runs, ...tv.subtasks.flatMap((s) => s.runs)].map(runView),
        asks: tv.asks.map((a) => ({
          id: a.id,
          runId: a.runId,
          question: a.question,
          options: a.options,
          askedAt: a.askedAt,
          status: a.answer === undefined ? 'pending' : 'answered',
          answer: a.answer,
          answeredBy: a.answeredBy,
          answeredAt: a.answeredAt,
        })),
      });
    },
    async timeline(taskId, p) {
      await wait();
      findTask(taskId);
      const res = page(
        st.logs.filter((l) => l.taskId === taskId),
        (l) => l.at,
        p?.cursor,
        p?.limit ?? 50,
      );
      return TimelineResponse.parse({
        items: res.items.map(({ taskId: _t, ...rest }) => rest),
        nextCursor: res.nextCursor,
      });
    },
    async runSteps(runId) {
      await wait();
      const owner = st.tasks.flatMap((t) => t.subtasks).find((s) => s.runs.some((r) => r.id === runId));
      const known = owner || st.tasks.some((t) => t.runs.some((r) => r.id === runId));
      if (!known) throw new ApiError(404, 'run_not_found', '没有这个会话');
      // 步骤清单归写码会话；第二意见的会话没报过。
      if (owner?.runs.find((r) => r.id === runId)?.stage === 'review') {
        return RunStepsResponse.parse({ runId, steps: [] });
      }
      return RunStepsResponse.parse({
        runId,
        steps: owner?.steps ?? [],
        updatedAt: owner?.planUpdatedAt,
        lastSay: owner?.lastSay,
      });
    },
    async taskAction(taskId, raw) {
      await wait();
      const body = TaskActionRequest.parse(raw);
      const tv = findTask(taskId);
      if (TERMINAL.has(tv.task.state)) {
        throw new ApiError(
          409,
          'task_finished',
          `任务已经结束（${tv.task.state}），不能再${ACTION_WORDS[body.action]}`,
        );
      }
      const actor = meActor();
      switch (body.action) {
        case 'pause':
          tv.paused = true;
          for (const s of tv.subtasks) s.paused = true;
          log(tv, { source: 'person', kind: 'pause', text: body.reason ? `暂停：${body.reason}` : '暂停' });
          break;
        case 'resume':
          tv.paused = false;
          for (const s of tv.subtasks) s.paused = false;
          log(tv, { source: 'person', kind: 'resume', text: '继续' });
          break;
        case 'stop':
          for (const r of tv.runs) if (!r.endedAt) endRun(r, 'stopped');
          for (const s of tv.subtasks) {
            for (const r of s.runs) if (!r.endedAt) endRun(r, 'stopped');
            if (s.subtask.state !== 'merged') setSubState(tv, s, 'stopped');
          }
          tv.paused = false;
          setTaskState(tv, 'stopped');
          log(tv, { source: 'person', kind: 'stop', text: body.reason ? `叫停：${body.reason}` : '叫停' });
          break;
        case 'reroute': {
          const pool = [...tv.runs, ...tv.subtasks.flatMap((s) => s.runs)].filter(
            (r) => !r.endedAt && (body.subtaskId === undefined || r.subtaskId === body.subtaskId),
          );
          const target = latestActive(pool);
          if (!target) throw new ApiError(409, 'no_active_run', '这个任务现在没有在跑的会话，没法换路由');
          const problem = routeProblem(body.routeId, target.stage);
          if (problem) throw new ApiError(422, 'route_not_allowed', problem);
          if (!routeInfo(body.routeId).route?.alive)
            throw new ApiError(422, 'route_offline', '这条路由现在不在线');
          endRun(target, 'stopped');
          const sv = tv.subtasks.find((s) => s.subtask.id === target.subtaskId);
          const model = routeInfo(body.routeId).modelName;
          const r = startRun(tv, sv, target.stage, body.routeId, `${actor.name}手动换成 ${model}`);
          if (sv && (sv.subtask.state === 'stalled' || sv.subtask.state === 'failed'))
            setSubState(tv, sv, 'running');
          if (tv.task.state === 'stalled' || tv.task.state === 'failed') setTaskState(tv, 'running');
          log(tv, {
            source: 'person',
            kind: 'reroute',
            runId: r.id,
            text: `换路由：${body.reason ?? `换成 ${model}`}`,
          });
          break;
        }
      }
      const { action, ...detail } = body;
      audit({
        actor,
        action: `task.${action}`,
        target: `task:${taskId}`,
        after: detail,
        via: 'cockpit',
        ...('reason' in body && body.reason ? { reason: body.reason } : {}),
      });
      emit('tasks', taskId);
    },
    async answerAsk(askId, answer) {
      await wait();
      const tv = st.tasks.find((t) => t.asks.some((a) => a.id === askId));
      const ask = tv?.asks.find((a) => a.id === askId);
      if (!tv || !ask) throw new ApiError(404, 'ask_not_found', '没有这条追问');
      if (ask.answer !== undefined) throw new ApiError(409, 'already_answered', '这条追问已经有人回答了');
      ask.answer = answer;
      ask.answeredBy = st.me.user.id;
      ask.answeredAt = iso();
      log(tv, { source: 'person', kind: 'answer', text: `回答追问：${answer}` });
      audit({
        actor: meActor(),
        action: 'ask.answer',
        target: `task:${tv.task.id}`,
        after: { askId, answer },
        via: 'cockpit',
      });
      emit('asks', askId);
      if (tv.task.state === 'asking' && tv.asks.every((a) => a.answer !== undefined)) {
        startRun(tv, undefined, 'plan', pickRoute('plan') ?? 'r-ca-opus', '回答之后接着写方案');
        setTaskState(tv, 'planning');
      }
    },
    async routing() {
      await wait();
      const stages = StageKindSchema.options.map(
        (stage) => st.stages.find((p) => p.stage === stage) ?? { stage, routeIds: [], pinned: false },
      );
      return RoutingResponse.parse({
        channels: st.channels,
        pools: st.pools,
        models: st.models,
        routes: st.routes,
        stages,
        hardBans: HARD_BANS.map(({ id, reason }) => ({ id, reason })),
        bans: st.bans,
      });
    },
    async updateStagePolicy(stage, raw) {
      await wait();
      const body = UpdateStagePolicyRequest.parse(raw);
      const problems = body.routeIds
        .map((id) => routeProblem(id, stage))
        .filter((p): p is string => p !== null);
      if (problems.length) throw new ApiError(422, 'route_not_allowed', problems.join('；'), { problems });
      const current = st.stages.find((p) => p.stage === stage) ?? { stage, routeIds: [], pinned: false };
      const same =
        current.pinned === body.expected.pinned &&
        current.routeIds.join('|') === body.expected.routeIds.join('|');
      if (!same) throw new ApiError(409, 'conflict', '这个阶段刚被别人改过，刷新后再改', { current });
      const next = { stage, routeIds: body.routeIds, pinned: body.pinned };
      st.stages = [...st.stages.filter((p) => p.stage !== stage), next];
      audit({
        actor: meActor(),
        action: 'stage_policy.update',
        target: `stage:${stage}`,
        before: body.expected,
        after: { routeIds: body.routeIds, pinned: body.pinned },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      emit('stage_policies', stage);
      return UpdateStagePolicyResponse.parse({ stage: next }).stage;
    },
    async updateChannel(channelId, raw) {
      await wait();
      const body = UpdateChannelRequest.parse(raw);
      const ch = st.channels.find((c) => c.id === channelId);
      if (!ch) throw new ApiError(404, 'channel_not_found', '没有这个渠道');
      ch.enabled = body.enabled;
      audit({
        actor: meActor(),
        action: body.enabled ? 'channel.enable' : 'channel.disable',
        target: `channel:${channelId}`,
        after: { enabled: body.enabled },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      emit('channels', channelId);
    },
    async pools() {
      await wait();
      const t = now();
      return PoolsResponse.parse({
        pools: st.pools.map((p) => {
          const ch = st.channels.find((c) => c.id === p.channelId);
          const windows = st.quota
            .filter((w) => w.poolId === p.id)
            .map(({ poolId: _p, ...w }) => ({ ...w, stale: t - Date.parse(w.readAt) > STALE_MS }));
          return {
            ...p,
            channelName: ch?.name ?? '未知渠道（库里查不到）',
            billing: ch?.billing ?? null,
            channelEnabled: ch?.enabled ?? false,
            running: poolRunning(p.id),
            quotaStatus: windows.length === 0 ? 'unread' : windows.some((w) => w.stale) ? 'stale' : 'fresh',
            windows,
          };
        }),
        staleAfterMinutes: STALE_MS / 60_000,
        asOf: iso(),
      });
    },
    async jobs() {
      await wait();
      const t = now();
      return JobsResponse.parse({
        jobs: st.jobs.map(({ nextRunAt: _n, keepsFailing: _k, ...j }) => {
          let status: 'fresh' | 'overdue' | 'never' = 'never';
          if (j.lastSuccessAt) {
            status = t - Date.parse(j.lastSuccessAt) > j.expectEveryMinutes * 60_000 ? 'overdue' : 'fresh';
          }
          return { ...j, status };
        }),
        asOf: iso(),
      });
    },
    async notifications(query) {
      await wait();
      const status = query?.status ?? 'open';
      const items = st.notifications.filter((n) => status === 'all' || !n.resolvedAt);
      const res = page(items, (n) => n.createdAt, query?.cursor, query?.limit ?? 50);
      return NotificationsResponse.parse(res);
    },
    async resolveNotification(id) {
      await wait();
      const n = st.notifications.find((x) => x.id === id);
      if (!n) throw new ApiError(404, 'notification_not_found', '没有这条通知');
      n.resolvedAt = iso();
      n.resolvedBy = st.me.user.id;
      audit({
        actor: meActor(),
        action: 'notification.resolve',
        target: `notification:${id}`,
        via: 'cockpit',
      });
      emit('notifications', id);
    },
    async audit(query) {
      await wait();
      const items = st.audit.filter((a) => query?.target === undefined || a.target === query.target);
      return AuditResponse.parse(page(items, (a) => a.at, query?.cursor, query?.limit ?? 50));
    },
    async settings() {
      await wait();
      return SettingsResponse.parse({
        settings: Object.keys(SETTING_SCHEMAS).map(
          (key) => st.settings.find((s) => s.key === key) ?? { key, value: null, version: 0 },
        ),
      });
    },
    async updateSetting(key, raw) {
      await wait();
      if (!Object.hasOwn(SETTING_SCHEMAS, key)) throw new ApiError(404, 'setting_not_found', '没有这项设置');
      const body = UpdateSettingRequest.parse(raw);
      const schema: z.ZodType = SETTING_SCHEMAS[key as SettingKey];
      const value = schema.safeParse(body.value);
      if (!value.success)
        throw new ApiError(400, 'invalid_request', '设置的值不符合约定', value.error.issues);
      const current = st.settings.find((s) => s.key === key) ?? { key, value: null, version: 0 };
      if (current.version !== body.version)
        throw new ApiError(409, 'conflict', '这项设置刚被别人改过，刷新后再改');
      const next = {
        key,
        value: value.data,
        version: current.version + 1,
        updatedAt: iso(),
        updatedBy: st.me.user.id,
      };
      st.settings = [...st.settings.filter((s) => s.key !== key), next];
      audit({
        actor: meActor(),
        action: 'setting.update',
        target: `setting:${key}`,
        before: current.value,
        after: value.data,
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      emit('settings', key);
      return UpdateSettingResponse.parse({ setting: next }).setting;
    },
    async demoLinks() {
      await wait();
      return DemoLinksResponse.parse({
        configured: true,
        links: demo.links.map((l) => ({ ...l, expired: Date.parse(l.expiresAt) <= now() })),
        defaultScope: demo.defaultScope,
        defaultPublished: demo.defaultPublished,
      });
    },
    async createDemoLink(raw) {
      await wait();
      const body = CreateDemoLinkRequest.parse(raw);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const id = await sha256Hex(token);
      const link = {
        id,
        modules: DEMO_MODULES.filter((m) => body.modules.includes(m)),
        detail: body.detail,
        expiresAt: new Date(now() + body.expiresInDays * 86_400_000).toISOString(),
        ...(body.note ? { note: body.note } : {}),
        createdAt: iso(),
        createdBy: st.me.user.id,
      };
      audit({
        actor: meActor(),
        action: 'demo.link.create',
        target: `demo-link:${id.slice(0, 12)}`,
        via: 'cockpit',
      });
      demo.links.unshift(link);
      return CreateDemoLinkResponse.parse({ link: { ...link, expired: false }, token });
    },
    async revokeDemoLink(linkId) {
      await wait();
      const i = demo.links.findIndex((l) => l.id === linkId);
      if (i < 0) throw new ApiError(404, 'demo_link_not_found', '没有这条演示链接（可能已经作废了）');
      audit({
        actor: meActor(),
        action: 'demo.link.revoke',
        target: `demo-link:${linkId.slice(0, 12)}`,
        via: 'cockpit',
      });
      demo.links.splice(i, 1);
    },
    async updateDemoDefault(raw) {
      await wait();
      const body = UpdateDemoDefaultRequest.parse(raw);
      const before = demo.defaultScope;
      demo.defaultScope = {
        v: 1,
        modules: DEMO_MODULES.filter((m) => body.modules.includes(m)),
        detail: body.detail,
      };
      demo.defaultPublished = true;
      audit({
        actor: meActor(),
        action: 'demo.default.update',
        target: 'demo:default',
        before,
        after: demo.defaultScope,
        via: 'cockpit',
      });
      return demo.defaultScope;
    },
    subscribe(listener, onStatus) {
      listeners.add(listener);
      onStatus?.('open');
      const t = setTimeout(() => listener({ type: 'ready' }), 0);
      return () => {
        clearTimeout(t);
        listeners.delete(listener);
      };
    },
  };
  return api;
}
