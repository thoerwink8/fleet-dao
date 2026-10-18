// 设置页「仓库」一节的 CI 模式（repos.ci_policy）：每个项目一行读、切换各一个写。
// 写走 Store.setCiPolicy：模式和操作记录同一事务，已经是要的模式就不改、不记。
// 引擎每次走到「等 CI」之前现读这一列，所以这里点一下，在跑的单从下一个检查点起照新模式走，不用重启。

import {
  CI_POLICY_SET,
  type CiPolicy,
  ciPolicyOf,
  RepoCiPolicyResponse,
  UpdateRepoCiPolicyRequest,
  UpdateRepoCiPolicyResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor, AuditRecord, Store } from './ports.ts';
import type { CockpitEnv } from './session.ts';

const MODE_WORD: Record<CiPolicy, string> = { force: '强制', off: '不强制' };

function policyField(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('ciPolicy' in value)) return undefined;
  return (value as { ciPolicy?: unknown }).ciPolicy;
}

function actorLabel(actor: AuditRecord['actor'], names: ReadonlyMap<string, string>): string {
  if (actor.kind !== 'user') return actor.id;
  const name = names.get(actor.id)?.trim();
  return name ? name : actor.id;
}

/** 最近几次切换，新的在前。认不出的条目跳过，不把整页读失败。 */
async function recentSwitches(store: Store, repoId: string, names: ReadonlyMap<string, string>) {
  const page = await store.listAudit({ target: `repo:${repoId}`, limit: 30 });
  const out: { at: string; actor: string; from: CiPolicy; to: CiPolicy }[] = [];
  for (const item of page.items) {
    if (item.action !== CI_POLICY_SET) continue;
    try {
      out.push({
        at: item.at,
        actor: actorLabel(item.actor, names),
        from: ciPolicyOf(policyField(item.before)),
        to: ciPolicyOf(policyField(item.after)),
      });
    } catch {
      // 前后值认不出：这一条不展示，不当成没切过。
    }
    if (out.length === 5) break;
  }
  return out;
}

async function namesOf(store: Store): Promise<Map<string, string>> {
  const users = await store.listUsers();
  return new Map(users.map((u) => [u.id, u.displayName]));
}

export function registerCiPolicyRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const { store } = deps;

  app.get(WebRoutes.repoCiPolicy.path, async (c) => {
    const repos = await store.listRepos();
    const names = await namesOf(store);
    const rows = await Promise.all(
      repos.map(async (r) => {
        const full = await store.findRepoByName(r.owner, r.name);
        if (!full) return null;
        return {
          repoId: full.id,
          owner: full.owner,
          name: full.name,
          mode: full.ciPolicy,
          recent: await recentSwitches(store, full.id, names),
        };
      }),
    );
    return reply(c, RepoCiPolicyResponse, { repos: rows.flatMap((r) => (r ? [r] : [])) });
  });

  app.put(WebRoutes.updateRepoCiPolicy.path, async (c) => {
    const repoId = c.req.param('repoId');
    const body = await readJson(c, UpdateRepoCiPolicyRequest);
    const repo = await store.getRepo(repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
    if (!deps.ciPolicyBridge)
      throw new ApiError(503, 'policy_not_connected', '真实策略桥未装配，未改 CI 模式');
    const { change, sync } = await deps.ciPolicyBridge.set(repo, body.mode, () =>
      store.setCiPolicy(
        { repoId: repo.id, mode: body.mode },
        {
          actor: actorOf(c),
          action: CI_POLICY_SET,
          target: `repo:${repo.id}`,
          reason: body.reason ?? `驾驶舱上把 CI 模式改成${MODE_WORD[body.mode]}`,
          via: c.get('via'),
          ok: true,
        },
      ),
    );
    const names = await namesOf(store);
    return reply(c, UpdateRepoCiPolicyResponse, {
      repoId: repo.id,
      owner: repo.owner,
      name: repo.name,
      mode: change.ciPolicy,
      recent: await recentSwitches(store, repo.id, names),
      changed: change.changed,
      synchronization: sync,
    });
  });
}
