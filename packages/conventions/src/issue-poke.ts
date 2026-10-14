// 开单顺手戳法国接单（决定 0096 A6）：开给法国的单开完，经 ssh 调一次现成的 fleet-api dispatch-issue，
// 让引擎立刻接，不等 5 分钟一轮的拉单。只是加速：戳不成（没配 ssh、连不上、准入没过）不影响开单，拉单照旧兜底；
// 但每种没戳成都要照实说，不能静默当成已经派了。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PokeDeps {
  /** 读 ~/.fleet-dao/france-ssh 的内容；读不到抛错。 */
  readHost: () => string;
  /** 经 ssh 跑一条远端命令；返回退出码和输出，起不来也返回非 0，不抛。 */
  ssh: (host: string, remote: string) => Promise<{ code: number; out: string }>;
}

const SINGLE = /^[\w.-]+\/[\w.-]+$/;

/** 从单的网址认出 owner/仓名 和单号；认不出回 undefined。 */
export function parseIssueUrl(url: string): { repo: string; number: number } | undefined {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.trim());
  if (!m?.[1] || !m[2] || !SINGLE.test(m[1])) return undefined;
  return { repo: m[1], number: Number(m[2]) };
}

export async function pokeFrance(url: string, deps: PokeDeps = realDeps()): Promise<string> {
  const head = '没戳法国接单（单已开，5 分钟一轮的拉单照旧会接）：';
  const issue = parseIssueUrl(url);
  if (!issue) return `${head}认不出单的网址「${url}」。`;
  let host: string;
  try {
    host = deps.readHost().split(/\r?\n/)[0]?.trim() ?? '';
  } catch (e) {
    return `${head}读不到 ~/.fleet-dao/france-ssh（${e instanceof Error ? e.message : String(e)}）。`;
  }
  if (!host || /\s/.test(host)) return `${head}~/.fleet-dao/france-ssh 第一行不是一个 ssh 主机名。`;
  const remote = `bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch-issue ${issue.repo} ${issue.number}`;
  const r = await deps.ssh(host, remote);
  const said = r.out.trim().replace(/\s+/g, ' ').slice(0, 300);
  if (r.code === 0) return `已戳法国接单（dispatch-issue #${issue.number}）：${said || '派了'}`;
  return `${head}退出码 ${r.code}，${said || '没有输出'}。`;
}

function realDeps(): PokeDeps {
  return {
    readHost: () => readFileSync(join(homedir(), '.fleet-dao', 'france-ssh'), 'utf8'),
    ssh: (host, remote) =>
      new Promise((done) => {
        execFile(
          'ssh',
          ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, remote],
          { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = `${stdout}${stderr}`;
            if (!err) return done({ code: 0, out });
            done({ code: typeof err.code === 'number' ? err.code : 1, out: out || err.message });
          },
        );
      }),
  };
}
