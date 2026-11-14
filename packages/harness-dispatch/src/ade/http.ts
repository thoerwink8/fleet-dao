// 本机 ADE 的 HTTP（#3914）。只挂在本机网关上，要本机令牌；写请求必须是 JSON。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { localTokenOk } from '@fleet-dao/harness-api';
import { routeAccounts } from './accounts-http.ts';
import { readJson } from './body.ts';
import { routeFiles } from './files.ts';
import { AdeError, type AdeService } from './service.ts';
import { routeTerminal } from './terminal.ts';

export { readJson } from './body.ts';

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export function createAdeHandler(
  ade: AdeService,
  token: string,
  /** null 表示没连 GitHub。不传则读 FLEET2_GITHUB_TOKEN。 */
  githubToken: string | null = process.env.FLEET2_GITHUB_TOKEN ?? null,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!localTokenOk(req, token)) {
      send(res, 401, { error: '没登录：缺本机令牌' });
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/ade' && !path.startsWith('/api/ade/')) return false;
    try {
      const hit = await route(ade, req, res, path, url.searchParams, githubToken);
      if (!hit) send(res, 404, { error: '没有这个接口' });
    } catch (err) {
      const status = err instanceof AdeError ? err.status : 500;
      const message = err instanceof Error ? err.message : '内部错误';
      if (!res.headersSent) send(res, status, { error: message });
    }
    return true;
  };
}

async function route(
  ade: AdeService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  githubToken: string | null,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (await routeAccounts(ade, req, res, path)) return true;
  const files = await routeFiles(ade, method, path, query);
  if (files) {
    send(res, files.status, files.body);
    return true;
  }
  if (path === '/api/ade/ssh-hosts' && method === 'GET') {
    send(res, 200, { hosts: await ade.listSshHosts() });
    return true;
  }
  if (path === '/api/ade/ssh-hosts' && method === 'POST') {
    send(res, 201, { hosts: await ade.addSshHost(await readJson(req)) });
    return true;
  }
  if (path === '/api/ade/gitlab-hosts' && method === 'GET') {
    send(res, 200, { hosts: await ade.gitlabHosts() });
    return true;
  }
  if (path === '/api/ade/gitlab-hosts' && method === 'POST') {
    const body = await readJson(req);
    send(res, 201, { hosts: await ade.addGitlabHost(str(body.host)) });
    return true;
  }
  const gitlabHost = /^\/api\/ade\/gitlab-hosts\/([^/]+)$/.exec(path);
  if (gitlabHost && method === 'DELETE') {
    send(res, 200, { hosts: await ade.removeGitlabHost(decodeURIComponent(gitlabHost[1] ?? '')) });
    return true;
  }
  if (path === '/api/ade/gitlab-token' && method === 'POST') {
    const body = await readJson(req);
    send(res, 200, await ade.saveGitlabToken(str(body.host), str(body.token)));
    return true;
  }
  if (path === '/api/ade/workspaces' && method === 'GET') {
    send(res, 200, { workspaces: await ade.listWorkspaces() });
    return true;
  }
  if (path === '/api/ade/workspaces' && method === 'POST') {
    const body = await readJson(req);
    const row = await ade.addWorkspace(str(body.name), str(body.path));
    send(res, 201, { workspace: row });
    return true;
  }
  const wsDel = /^\/api\/ade\/workspaces\/([^/]+)$/.exec(path);
  if (wsDel && method === 'DELETE') {
    await ade.removeWorkspace(decodeURIComponent(wsDel[1] ?? ''));
    send(res, 204, {});
    return true;
  }
  if (path === '/api/ade/agents' && method === 'GET') {
    send(res, 200, { agents: await ade.listAgents() });
    return true;
  }
  if (path === '/api/ade/tasks' && method === 'GET') {
    send(res, 200, { tasks: await ade.listTasks() });
    return true;
  }
  if (path === '/api/ade/tasks' && method === 'POST') {
    const body = await readJson(req);
    const row = await ade.addTask(str(body.workspaceId), str(body.title), str(body.body));
    send(res, 201, { task: row });
    return true;
  }
  if (path === '/api/ade/tasks/import-github' && method === 'POST') {
    await readJson(req);
    if (!githubToken) throw new AdeError('没连 GitHub', 400);
    throw new AdeError('导入还没做', 501);
  }
  if (path === '/api/ade/schedules' && method === 'GET') {
    send(res, 200, { schedules: await ade.listSchedules() });
    return true;
  }
  if (path === '/api/ade/schedules' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body.runAt !== 'string') throw new AdeError('要到点时间', 400);
    const row = await ade.createSchedule({
      workspaceId: str(body.workspaceId),
      agent: str(body.agent),
      model: str(body.model),
      text: str(body.text),
      runAt: body.runAt,
    });
    send(res, 201, { schedule: row });
    return true;
  }
  const schedPause = /^\/api\/ade\/schedules\/([^/]+)\/pause$/.exec(path);
  if (schedPause && method === 'POST') {
    await readJson(req);
    const row = await ade.pauseSchedule(decodeURIComponent(schedPause[1] ?? ''));
    send(res, 200, { schedule: row });
    return true;
  }
  const schedDel = /^\/api\/ade\/schedules\/([^/]+)$/.exec(path);
  if (schedDel && method === 'DELETE') {
    await ade.deleteSchedule(decodeURIComponent(schedDel[1] ?? ''));
    send(res, 204, {});
    return true;
  }
  if (path === '/api/ade/sessions' && method === 'GET') {
    const archived = query.get('archived');
    if (archived !== null && archived !== '0' && archived !== '1') {
      throw new AdeError('archived 只能是 0 或 1', 400);
    }
    const knownRaw = query.get('known');
    let knownIds: string[] | undefined;
    if (knownRaw !== null) {
      const ids = knownRaw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
      if (ids.length > 200) throw new AdeError('known 最多 200 个', 400);
      if (ids.some((id) => id.length > 80)) throw new AdeError('known 里的会话号太长', 400);
      knownIds = await ade.knownSessionIds(ids);
    }
    send(res, 200, {
      sessions: await ade.listSessions({ q: query.get('q') ?? '', archived: archived === '1' }),
      ...(knownIds !== undefined ? { knownIds } : {}),
    });
    return true;
  }
  if (path === '/api/ade/sessions' && method === 'POST') {
    const body = await readJson(req);
    const row = await ade.createSession({
      workspaceId: str(body.workspaceId),
      agent: str(body.agent),
      model: str(body.model),
      worktree: body.worktree === true,
      taskId: numOrNull(body.taskId),
      parentId: str(body.parentId) || null,
      text: str(body.text),
      host: str(body.host) || null,
    });
    send(res, 201, { session: row });
    return true;
  }
  if (await routeTerminal(ade, req, res, path)) return true;
  const session =
    /^\/api\/ade\/sessions\/([^/]+)(?:\/(messages|stop|changes|deliver|queue|git|approval))?$/.exec(path);
  if (!session) return false;
  const id = decodeURIComponent(session[1] ?? '');
  const action = session[2];
  if (!action && method === 'GET') {
    send(res, 200, { session: await ade.getSession(id) });
    return true;
  }
  if (!action && method === 'PATCH') {
    const body = await readJson(req);
    const patch: { title?: string; pinned?: boolean; archived?: boolean } = {};
    if ('title' in body) patch.title = str(body.title);
    if ('pinned' in body) {
      if (typeof body.pinned !== 'boolean') throw new AdeError('pinned 要是 true 或 false', 400);
      patch.pinned = body.pinned;
    }
    if ('archived' in body) {
      if (typeof body.archived !== 'boolean') throw new AdeError('archived 要是 true 或 false', 400);
      patch.archived = body.archived;
    }
    send(res, 200, { session: await ade.updateSession(id, patch) });
    return true;
  }
  if (action === 'messages' && method === 'POST') {
    const body = await readJson(req);
    const fromRaw = body.from;
    const from =
      fromRaw && typeof fromRaw === 'object' && !Array.isArray(fromRaw)
        ? {
            kind:
              (fromRaw as { kind?: unknown }).kind === 'session' ? ('session' as const) : ('user' as const),
            id: str((fromRaw as { id?: unknown }).id) || null,
          }
        : { kind: 'user' as const, id: null };
    const mode = body.mode === 'queue' || body.mode === 'jump' ? body.mode : 'send';
    const kind = body.kind === 'report' ? 'report' : 'chat';
    await ade.postMessage(id, {
      text: str(body.text),
      from,
      mode,
      kind,
      expectReply: body.expectReply !== false,
      hops: typeof body.hops === 'number' && body.hops >= 0 ? Math.floor(body.hops) : 0,
    });
    send(res, 202, { ok: true });
    return true;
  }
  if (action === 'queue' && method === 'POST') {
    const body = await readJson(req);
    const index = body.index;
    const op = body.op === 'drop' || body.op === 'jump' ? body.op : null;
    if (op === null || typeof index !== 'number') throw new AdeError('要 index 和 op', 400);
    await ade.editQueue(id, index, op);
    send(res, 202, { ok: true });
    return true;
  }
  if (action === 'stop' && method === 'POST') {
    await readJson(req);
    await ade.stop(id);
    send(res, 202, { ok: true });
    return true;
  }
  if (action === 'approval' && method === 'POST') {
    const body = await readJson(req);
    const decision = body.decision === 'allow' || body.decision === 'deny' ? body.decision : null;
    const approvalId = str(body.approvalId);
    if (!decision || !approvalId) throw new AdeError('要 approvalId 和 decision', 400);
    await ade.decide(id, approvalId, decision);
    send(res, 202, { ok: true });
    return true;
  }
  if (action === 'changes' && method === 'GET') {
    send(res, 200, await ade.changes(id));
    return true;
  }
  if (action === 'deliver' && method === 'POST') {
    await readJson(req);
    send(res, 200, await ade.deliver(id));
    return true;
  }
  if (action === 'git' && method === 'POST') {
    send(res, 200, await ade.gitOp(id, await readJson(req)));
    return true;
  }
  return false;
}
