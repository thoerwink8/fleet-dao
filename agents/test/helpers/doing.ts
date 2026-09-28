// 认领脚本（doing-lib.mjs）测试共用的东西：假 GitHub、在内存里跑一条命令。钉住规矩的测试（rules/）和普通测试都用它。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPTS = fileURLToPath(new URL('../../skills/commander/scripts/', import.meta.url));
export const NOW = new Date('2026-09-27T03:00:00Z');

export interface Claim {
  id: number;
  state: string;
  machine: string;
  text: string;
}
export interface DoingIo {
  gh: (args: string[], input?: string) => string;
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (text: string) => void;
  err: (text: string) => void;
}
export interface DoingLib {
  STALE_HOURS: number;
  renderClaim(state: string, machine: string, text: string): string;
  parseClaim(comment: { id: number; body: string; html_url?: string; updated_at?: string }): Claim | null;
  machineProblem(name: string): string | null;
  runDoing(argv: string[], io: DoingIo): Promise<number>;
}

export const doing = (await import(pathToFileURL(join(SCRIPTS, 'doing-lib.mjs')).href)) as DoingLib;

interface FakeComment {
  id: number;
  issue: number;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

/** 内存里的假 GitHub：只认 doing-lib 用到的四种 gh api 调用。 */
export function fakeGitHub() {
  let next = 5000;
  let clock = NOW.getTime() - 60_000;
  const comments: FakeComment[] = [];
  const calls: string[][] = [];
  const hooks: {
    beforePost?: (() => void) | undefined;
    afterPost?: (() => void) | undefined;
    failListAt?: number;
    postReply?: string;
  } = {};
  let lists = 0;
  /** 假时钟：每写一次往前走一秒（真 GitHub 的时间也是递增的）。 */
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const add = (issue: number, body: string, at?: Date): FakeComment => {
    const time = at ? at.toISOString() : tick();
    const id = next++;
    const c = {
      id,
      issue,
      body,
      created_at: time,
      updated_at: time,
      html_url: `https://github.com/o/r/issues/${issue}#c${id}`,
    };
    comments.push(c);
    return c;
  };
  const gh = (args: string[], input?: string): string => {
    calls.push(args);
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const onIssue = /\/issues\/(\d+)\/comments$/.exec(path);
    if (onIssue && method === 'GET') {
      if (hooks.failListAt === lists++) throw new Error('gh 退出码 1：HTTP 502');
      return comments
        .filter((c) => c.issue === Number(onIssue[1]))
        .map(
          (c) =>
            `${JSON.stringify({ body: c.body, created_at: c.created_at, html_url: c.html_url, id: c.id, updated_at: c.updated_at })}\n`,
        )
        .join('');
    }
    if (onIssue && method === 'POST') {
      hooks.beforePost?.();
      const c = add(Number(onIssue[1]), JSON.parse(input ?? '{}').body);
      hooks.afterPost?.();
      return hooks.postReply ?? JSON.stringify(c);
    }
    const one = /\/issues\/comments\/(\d+)$/.exec(path);
    const c = comments.find((x) => x.id === Number(one?.[1]));
    if (one && c && method === 'PATCH') {
      c.body = JSON.parse(input ?? '{}').body;
      c.updated_at = tick();
      return JSON.stringify(c);
    }
    if (one && c && method === 'DELETE') {
      comments.splice(comments.indexOf(c), 1);
      return '';
    }
    throw new Error(`假 GitHub 不认得：${args.join(' ')}`);
  };
  const claims = (issue: number) =>
    comments
      .filter((c) => c.issue === issue)
      .map((c) => doing.parseClaim(c))
      .filter((c): c is Claim => c !== null);
  return {
    gh,
    comments,
    calls,
    hooks,
    add,
    claims,
    methods: () => calls.map((a) => (a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET')),
  };
}

export async function runDoing(
  gh: DoingIo['gh'],
  argv: string[],
  env: Record<string, string | undefined> = { FLEET_MACHINE: '本机' },
  home: string,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await doing.runDoing(argv, {
    gh,
    env,
    home,
    now: () => NOW,
    sleep: async () => {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
