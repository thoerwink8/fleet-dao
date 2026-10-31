// 影子自检三样的真实探测（harness-workers 的 ShadowProbes，#3775）。查不了一律 unknown，不当成没事。
// 影子工人和引擎会话同一个会话用户（法国只占 reclaude 一台设备），所以「工人拿不到推送凭据」不能只看环境变量：
// 会话用户家目录里的凭据文件工人一样读得到，这里逐个看。
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Redactor } from '@fleet-dao/harness-runner';
import type { ProbeResult, ShadowProbes } from '@fleet-dao/harness-workers';
import { type CommandResult, type CommandSpec, runCommand } from './command.ts';

/** 家目录下能拿来推送的凭据文件（相对路径）；`.ssh` 下的私钥另外列。 */
export const CREDENTIAL_FILES: readonly string[] = ['.git-credentials', '.config/gh/hosts.yml', '.netrc'];

export interface ShadowProbeDeps {
  /** 工人进程的 HOME（和会话用户同一个）。 */
  home: string;
  /** 出网关听的本机口（docs/ops.md 端口表，7344）。 */
  egressPort: number;
  /** 载入 nft 表 inet fleet2_shadow 的单元。 */
  firewallUnit?: string;
  /** outbox 里装了真实处理器的种类；影子里必须是空的。 */
  realHandlers: () => readonly string[];
  redact: Redactor;
  timeoutMs?: number;
  run?: (spec: CommandSpec) => Promise<CommandResult>;
  /** 连得上回 true、被拒回 false、别的（超时、出错）抛。 */
  portOpen?: (port: number, timeoutMs: number) => Promise<boolean>;
}

export function realShadowProbes(deps: ShadowProbeDeps): ShadowProbes {
  const run = deps.run ?? runCommand;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const portOpen = deps.portOpen ?? tcpOpen;
  const unit = deps.firewallUnit ?? 'fleet2-shadow-firewall.service';
  const cmd = (command: string[]) =>
    run({
      command,
      cwd: deps.home,
      timeoutMs,
      redact: deps.redact,
      hostEnv: { ...process.env, HOME: deps.home },
    });

  return {
    async noWriteAccess(): Promise<ProbeResult> {
      const files = [...CREDENTIAL_FILES.map((f) => join(deps.home, f)), ...(await sshKeys(deps.home))];
      for (const f of files) if (await readable(f)) return 'fail';
      // 全局 git 配置里挂着凭据助手，工人的 git push 一样会去拿
      const helper = await cmd(['git', 'config', '--global', '--get-all', 'credential.helper']);
      if (!helper.ran) return 'unknown';
      if (helper.exitCode === 0 && helper.stdout.trim()) return 'fail';
      return helper.exitCode === 0 || helper.exitCode === 1 ? 'pass' : 'unknown';
    },
    async realHandlersAbsent(): Promise<ProbeResult> {
      return deps.realHandlers().length === 0 ? 'pass' : 'fail';
    },
    async egressRulesPresent(): Promise<ProbeResult> {
      const active = await cmd(['systemctl', 'is-active', unit]);
      if (!active.ran) return 'unknown';
      if (active.stdout.trim() !== 'active') return 'fail';
      // 规则在、出网关没人听：重定向过去的连接全断，影子工人连模型服务都连不上
      return (await portOpen(deps.egressPort, timeoutMs)) ? 'pass' : 'fail';
    },
  };
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return false;
    throw err;
  }
}

async function sshKeys(home: string): Promise<string[]> {
  try {
    const names = await readdir(join(home, '.ssh'));
    return names.filter((n) => /^id_[a-z0-9]+$/.test(n)).map((n) => join(home, '.ssh', n));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

function tcpOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`连 127.0.0.1:${port} 超过 ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ECONNREFUSED') resolve(false);
      else reject(err);
    });
  });
}
