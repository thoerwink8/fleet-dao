// 影子自检三样的真实探测（harness-workers 的 ShadowProbes，#3775）。查不了一律 unknown，不当成没事。
// 影子工人和引擎会话同一个会话用户（法国只占 reclaude 一台设备），所以「工人拿不到推送凭据」不能只看环境变量：
// 会话用户家目录里的凭据文件工人一样读得到。法国上内核以 fleet 跑、会话用户的家是 750，fleet 进不去（#3776 现场），
// 所以这一项以工人的身份跑一段短脚本来看（WorkerSandbox.runAsWorker）；没有 sandbox（本机、测试）工人和内核同一个用户，
// 同一段脚本直接跑。判法只有这一段脚本，不分两套。
import { connect } from 'node:net';
import type { Redactor } from '@fleet-dao/harness-runner';
import type { ProbeResult, ShadowProbes, WorkerSandbox } from '@fleet-dao/harness-workers';
import { type CommandResult, type CommandSpec, runCommand } from './command.ts';

/** 家目录下能拿来推送的凭据文件（相对路径）；`.ssh` 下的私钥另外列。 */
export const CREDENTIAL_FILES: readonly string[] = ['.git-credentials', '.config/gh/hosts.yml', '.netrc'];

/** 脚本的退出码：0 干净，10 有凭据，别的（含 sh、git 起不来）都是没查成。 */
const EXIT_CLEAN = 0;
const EXIT_CREDENTIAL = 10;
const EXIT_UNKNOWN = 11;

/**
 * 不打印文件内容，只用退出码答；路径都相对 HOME。写成一行：它要上 sudo 命令行，帮手那一层不许带控制字符（含换行）。
 * 倒数第二段：全局 git 配置里挂着凭据助手，工人的 git push 一样会去拿。
 */
export const NO_WRITE_SCRIPT = [
  `for f in ${CREDENTIAL_FILES.map((f) => `"$HOME/${f}"`).join(' ')}; do if [ -r "$f" ]; then exit ${EXIT_CREDENTIAL}; fi; done;`,
  `for f in "$HOME"/.ssh/id_*; do n=\${f##*/id_}; case $n in "" | *[!a-z0-9]*) continue ;; esac; if [ -r "$f" ]; then exit ${EXIT_CREDENTIAL}; fi; done;`,
  'h=$(git config --global --get-all credential.helper); rc=$?;',
  `if [ "$rc" -eq 0 ]; then case $h in *[![:space:]]*) exit ${EXIT_CREDENTIAL} ;; esac; fi;`,
  `if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then exit ${EXIT_CLEAN}; fi;`,
  `exit ${EXIT_UNKNOWN}`,
].join(' ');

export interface ShadowProbeDeps {
  /** 工人进程的 HOME（和会话用户同一个）。只有没 sandbox 时内核自己用它跑脚本；有 sandbox 以会话用户自己的 HOME 为准。 */
  home: string;
  /** 法国上给：只读探测以工人身份跑。 */
  sandbox?: WorkerSandbox;
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

  return {
    async noWriteAccess(): Promise<ProbeResult> {
      const script = ['/bin/sh', '-c', NO_WRITE_SCRIPT];
      const r = deps.sandbox
        ? await deps.sandbox.runAsWorker(script, timeoutMs)
        : await run({
            command: script,
            cwd: '/',
            timeoutMs,
            redact: deps.redact,
            hostEnv: { ...process.env, HOME: deps.home },
          });
      if (!r.ran) return 'unknown';
      if (r.exitCode === EXIT_CLEAN) return 'pass';
      return r.exitCode === EXIT_CREDENTIAL ? 'fail' : 'unknown';
    },
    async realHandlersAbsent(): Promise<ProbeResult> {
      return deps.realHandlers().length === 0 ? 'pass' : 'fail';
    },
    async egressRulesPresent(): Promise<ProbeResult> {
      // 不看会话用户的家，cwd 不能用它：内核用户进不去，spawn 就失败
      const active = await run({
        command: ['systemctl', 'is-active', unit],
        cwd: '/',
        timeoutMs,
        redact: deps.redact,
      });
      if (!active.ran) return 'unknown';
      if (active.stdout.trim() !== 'active') return 'fail';
      // 规则在、出网关没人听：重定向过去的连接全断，影子工人连模型服务都连不上
      return (await portOpen(deps.egressPort, timeoutMs)) ? 'pass' : 'fail';
    },
  };
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
