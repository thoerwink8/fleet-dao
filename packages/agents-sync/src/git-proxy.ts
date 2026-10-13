// GitHub 的 git 走本机备用代理：~/.fleet-dao/fallback-proxy（每台自己配，不进仓、不是密钥；第一行 http:// 或 socks5:// 的 host:port）
// 在，就把 http.https://github.com/.proxy 设成它；不在就不设、照实报「没配」，不报成一致。
// 为什么（片 B 第 9 条，2026-10-13）：Claude Code 会话进程环境里的 HTTPS_PROXY 是 reclaude 写进用户级 settings env 的
// 56879，改它会被写回；非 Claude Code 的流量穿过它约 90 秒后设备被解绑（docs/reference/adapters.md CC-10）。本机实测：github 走
// 127.0.0.1:7890 ok 1.0s，走 56879 失败 10.5s，直连失败 21.8s。git 的 http.<url>.proxy 比环境变量优先，这一条设上，
// 各会话里的 git 连 GitHub 就不再穿 reclaude；Bash 里的 gh/curl/npm 由开会话钩子往 $CLAUDE_ENV_FILE 写代理变量（agents/hooks/proxy-env.mjs）。
// 读写都指定 --file <ctx.home>/.gitconfig（和 git-excludes.ts 一样：测试、--home 传了别的目录时不摸真机器的全局配置）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Line, line } from './report.ts';
import { type Ctx, code } from './sync.ts';

export const GITHUB_PROXY_KEY = 'http.https://github.com/.proxy';
const KEY = `~/.gitconfig#${GITHUB_PROXY_KEY}`;
const FILE = '~/.fleet-dao/fallback-proxy';

/**
 * 备用代理那一行的读法。和 agents/hooks/git-run.mjs 的 parseFallbackProxy 是同一条规矩（test/git-proxy.test.ts 钉着两边一样）：
 * 钩子装到机器上跑纯 node，这里是 TypeScript，两边不互相 import。
 */
export function parseFallbackProxy(text: string): { proxy?: string; bad?: boolean } {
  const first = String(text).split(/\r?\n/)[0]?.trim() ?? '';
  if (!first) return {};
  return /^(?:http|socks5):\/\/[A-Za-z0-9.-]+:\d{1,5}\/?$/.test(first)
    ? { proxy: first.replace(/\/$/, '') }
    : { bad: true };
}

type Fallback = { kind: 'none' } | { kind: 'ok'; proxy: string } | { kind: 'bad'; why: string };

function readFallback(home: string): Fallback {
  let text: string;
  try {
    text = readFileSync(join(home, '.fleet-dao', 'fallback-proxy'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'bad', why: `读不了（${code(err)}）` };
  }
  const p = parseFallbackProxy(text);
  if (p.proxy) return { kind: 'ok', proxy: p.proxy };
  if (p.bad)
    return { kind: 'bad', why: '第一行认不出（只认 http:// 或 socks5:// 开头的 host:port，不带用户名密码）' };
  return { kind: 'none' };
}

function git(home: string, args: string[]) {
  return spawnSync('git', ['-C', home, 'config', '--file', join(home, '.gitconfig'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

type Current = { kind: 'set'; value: string } | { kind: 'unset' } | { kind: 'unknown'; why: string };

function current(home: string): Current {
  const r = git(home, ['--get', GITHUB_PROXY_KEY]);
  if (r.error) return { kind: 'unknown', why: `git 起不来（${code(r.error)}）` };
  const out = (r.stdout ?? '').trim();
  if (r.status === 0) return { kind: 'set', value: out };
  if (r.status === 1 && out === '') return { kind: 'unset' };
  return {
    kind: 'unknown',
    why: `git config 读不出（退出码 ${r.status}：${(r.stderr ?? '').trim().split('\n')[0]}）`,
  };
}

function noneLine(cur: Current): Line {
  const now = cur.kind === 'set' ? `；现在设着 ${cur.value}（不是本脚本设的，没动）` : '';
  return line('skip', KEY, `没配 ${FILE}：GitHub 的 git 不另设代理${now}`);
}

export function checkGitProxy(ctx: Ctx): Line[] {
  const fb = readFallback(ctx.home);
  const cur = current(ctx.home);
  if (fb.kind === 'none') return [noneLine(cur)];
  if (fb.kind === 'bad') return [line('drift', KEY, `漂移——${FILE} ${fb.why}，GitHub 的 git 代理没法按它设`)];
  if (cur.kind === 'unknown') return [line('unknown', KEY, `没查成——${cur.why}`)];
  if (cur.kind === 'unset') return [line('missing', KEY, `缺失——没设（${FILE} 是 ${fb.proxy}）`)];
  if (cur.value !== fb.proxy)
    return [line('drift', KEY, `漂移——设的是 ${cur.value}，${FILE} 是 ${fb.proxy}`)];
  return [line('ok', KEY, `GitHub 的 git 走 ${fb.proxy}`)];
}

export function applyGitProxy(ctx: Ctx): Line[] {
  const fb = readFallback(ctx.home);
  const cur = current(ctx.home);
  if (fb.kind === 'none') return [noneLine(cur)];
  if (fb.kind === 'bad') return [line('failed', KEY, `没做成——${FILE} ${fb.why}，没设`)];
  if (cur.kind === 'unknown') return [line('unknown', KEY, `没做成——${cur.why}，没动`)];
  if (cur.kind === 'set' && cur.value === fb.proxy) return [line('ok', KEY, `GitHub 的 git 走 ${fb.proxy}`)];
  const r = git(ctx.home, [GITHUB_PROXY_KEY, fb.proxy]);
  if (r.error || r.status !== 0)
    return [
      line(
        'failed',
        KEY,
        `没做成——git config 写不进去（${r.error ? code(r.error) : `退出码 ${r.status}：${(r.stderr ?? '').trim().split('\n')[0]}`}）`,
      ),
    ];
  const was = cur.kind === 'set' ? `原来是 ${cur.value}` : '原来没设';
  return [line('changed', KEY, `设成了 ${fb.proxy}（${was}；来自 ${FILE}）`)];
}
