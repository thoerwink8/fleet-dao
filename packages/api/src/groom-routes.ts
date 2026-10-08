// 设置页「仓库」一节的「让指挥官整理」按钮（母单 #1335 第 3 片，#1338；第四片的页面用）：两个口。
// GET  /repos/:repoId/dispatch/groom：今日剩余次数、最近几次结果、有没有一次在排队或在做。
// POST /repos/:repoId/dispatch/groom：叫一次临时指挥官整理待办。
// 点一下 = 记一条操作记录 groom.request（target groom）；法国引擎每几秒看一眼，接手、起会话、执行清单（engine/src/jobs/groom.ts）。
// 和命令行 fleet-api groom、引擎拉单一轮自己叫是同一个入口、同一把锁，判能不能叫的是同一个函数（shared 的 judgeGroomRequest）。
// 改这里之前必须知道：
// - 拒的情况都明说，不记成点过：引擎总开关关着 409 engine_off、引擎没开 / 没连上 409 engine_off / 503、已经有一次在排队或在做 409 groom_busy、
//   这个仓 24 小时内用完 3 次 429 groom_daily_cap。
// - 读不到操作记录 → 503 写明没读成；认不出的记录数进 unreadable，不拿空列表冒充「没点过」。
// - 一次整理走到哪不另存，读的时候从操作记录现算（shared 的 foldGroomRequests，引擎找没人接的也用它）。
// - 操作记录走 Store（真库、内存版同一份），不另开库连接。

import { randomUUID } from 'node:crypto';
import {
  describeEngineMaster,
  foldGroomRequests,
  GROOM_ACTION,
  GROOM_LIST_WINDOW_MS,
  GROOM_TARGET,
  type GroomAuditRow,
  GroomNowRequest,
  GroomNowResponse,
  GroomStatusResponse,
  groomQuota,
  judgeGroomRequest,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

type EngineState = { state: 'on' | 'off' | 'down' | 'unknown'; detail?: string | undefined };

/** 最多翻几页（每页 200 条）：一天整理不过几次，翻满了明说没读全。 */
const MAX_PAGES = 5;

/** target=groom 的操作记录，最近 GROOM_LIST_WINDOW_MS 之内的。读不到原样抛。 */
async function recentRows(deps: Deps, now: Date): Promise<GroomAuditRow[]> {
  const since = now.getTime() - GROOM_LIST_WINDOW_MS;
  const rows: GroomAuditRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await deps.store.listAudit({
      target: GROOM_TARGET,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of got.items) {
      const at = new Date(item.at);
      if (at.getTime() < since) return rows;
      rows.push({
        at,
        action: item.action,
        actorId: item.actor.id,
        after: item.after,
        ok: item.ok,
        error: item.error ?? null,
      });
    }
    cursor = got.nextCursor;
    if (!cursor) return rows;
  }
  throw new Error(`整理待办的操作记录超过 ${MAX_PAGES} 页没翻完，不拿一部分冒充全部`);
}

function refuseWhenEngineAway(engine: EngineState): void {
  if (engine.state === 'on') return;
  const detail = engine.detail ? `（${engine.detail}）` : '';
  if (engine.state === 'off') {
    throw new ApiError(409, 'engine_off', `整理不了：这台机器的引擎按配置没开${detail}，没人接这次整理`);
  }
  if (engine.state === 'down') {
    throw new ApiError(503, 'engine_down', `整理不了：引擎没连上${detail}，点了也没人接，等引擎起来再点`);
  }
  throw new ApiError(503, 'engine_unknown', `整理不了：没查成引擎在不在${detail}，不敢说点了会有人接`);
}

export function registerGroomRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
  engineProbe: () => Promise<EngineState>,
): void {
  const { store } = deps;

  const repoOf = async (repoId: string) => {
    const repo = await store.getRepo(repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
    return repo;
  };
  const readRequests = async (now: Date) => {
    try {
      const folded = foldGroomRequests(await recentRows(deps, now), now);
      if (folded.unreadable > 0)
        deps.log.warn('整理待办：有操作记录认不出', { unreadable: folded.unreadable });
      return folded;
    } catch (err) {
      deps.log.error('整理待办：操作记录没读成', { error: errMessage(err) });
      throw new ApiError(503, 'groom_unreadable', `整理待办的记录没读成：${errMessage(err)}`);
    }
  };

  app.get(WebRoutes.groomStatus.path, async (c) => {
    const repo = await repoOf(c.req.param('repoId'));
    const slug = `${repo.owner}/${repo.name}`;
    const now = deps.now();
    const { requests, unreadable } = await readRequests(now);
    return reply(c, GroomStatusResponse, {
      asOf: now.toISOString(),
      repoId: repo.id,
      repo: slug,
      quota: groomQuota(requests, slug, now),
      busy: requests.some((r) => r.state === 'queued' || r.state === 'running'),
      recent: requests.filter((r) => r.repo.toLowerCase() === slug.toLowerCase()).slice(0, 5),
      unreadable,
    });
  });

  app.post(WebRoutes.groomNow.path, async (c) => {
    const repo = await repoOf(c.req.param('repoId'));
    const body = await readJson(c, GroomNowRequest);
    const slug = `${repo.owner}/${repo.name}`;
    refuseWhenEngineAway(await engineProbe());
    let master: Awaited<ReturnType<typeof readEngineMaster>>;
    try {
      master = await readEngineMaster(store);
    } catch (err) {
      throw new ApiError(503, 'engine_master_unreadable', `没查成引擎总开关：${errMessage(err)}`);
    }
    const now = deps.now();
    const { requests } = await readRequests(now);
    const verdict = judgeGroomRequest({
      repo: slug,
      source: 'http',
      now,
      requests,
      engine: master.on ? { on: true } : { on: false, why: describeEngineMaster(master) },
    });
    if (!verdict.ok) {
      const status = verdict.reason === 'daily_cap' ? 429 : 409;
      const code =
        verdict.reason === 'engine_off'
          ? 'engine_off'
          : verdict.reason === 'busy'
            ? 'groom_busy'
            : verdict.reason === 'daily_cap'
              ? 'groom_daily_cap'
              : 'groom_too_soon';
      throw new ApiError(status, code, verdict.why);
    }
    const requestId = randomUUID();
    await store.appendAudit({
      actor: actorOf(c),
      action: GROOM_ACTION.request,
      target: GROOM_TARGET,
      after: { requestId, repo: slug, source: 'http' },
      reason: body.reason ?? '驾驶舱上点了「让指挥官整理」',
      via: c.get('via'),
      ok: true,
    });
    return reply(c, GroomNowResponse, {
      request: {
        requestId,
        repo: slug,
        source: 'http',
        requestedAt: now.toISOString(),
        by: c.get('user').id,
        state: 'queued',
      },
      remainingAfter: verdict.remainingAfter,
    });
  });
}
