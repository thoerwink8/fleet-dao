// 本机 ADE 接口（#3914）。同源 cookie 鉴权，写请求带 JSON。
import { API_BASE } from './api';

export interface AdeWorkspace {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
  forge: string;
}

export interface AdeAgent {
  id: string;
  resume: boolean;
  models: string[];
}

export interface AdeTask {
  id: number;
  workspaceId: string;
  title: string;
  body: string;
  status: string;
}

export interface AdeQueueItem {
  text: string;
  from?: { kind?: string; id?: string | null };
  kind?: string;
}

export interface AdeSession {
  id: string;
  title: string;
  status: string;
  workspaceId: string;
  agent?: string;
  model?: string;
  worktree?: boolean;
  cwd?: string;
  hold?: boolean;
  queue?: AdeQueueItem[];
  updatedAt?: string;
}

export function queueOf(session: AdeSession | undefined): AdeQueueItem[] {
  const raw = session?.queue;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is AdeQueueItem => !!x && typeof x.text === 'string' && x.text.trim() !== '');
}

async function fail(res: Response): Promise<never> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) throw new Error(body.error);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(text || `HTTP ${res.status}`);
    throw err;
  }
  throw new Error(text || `HTTP ${res.status}`);
}

export async function adeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/ade${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export function adeQueueAct(id: string, index: number, op: 'drop' | 'jump'): Promise<{ ok: boolean }> {
  return adeSend(`/sessions/${encodeURIComponent(id)}/queue`, 'POST', { index, op });
}

export async function adeSend<T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/ade${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) return fail(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
