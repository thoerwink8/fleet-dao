// 引擎这头怎么用桥接（bridge.ts）连会话用户自己的 Mirasim：经 fleet-agent-scope 起一个短命的桥接进程（以那个会话用户的
// 身份，独立 scope），帧经它的 stdin/stdout 按行 JSON 转；不再由引擎自己的进程直连回环口（法国防火墙只放行会话用户和
// root 连那个口，2026-09-28 实测断链，#345 后续）。每次 MirasimConnect 被调用（run.ts 的控制连接、订阅连接、补发 stop
// 都各自调）都起一个新的桥接进程，和直连那份 mirasimConnector 每次 connect() 都开一条新 ws 是同一个调用节奏。
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LineSplitter } from '../lines.ts';
import { type CgroupScope, type SessionUser, scopeLaunch, scopePrefix, stopScope } from '../procs.ts';
import type { MirasimConnect, MirasimFrame, MirasimWire } from './wire.ts';

export interface BridgeMirasimEndpoint {
  user: SessionUser;
  /** discoverMirasimEndpoint 现找的端口（real/index.ts）；桥接自己以会话用户的身份读令牌，不经引擎这边传值。 */
  port: number;
  tokenFile: string;
}

export interface BridgeConnectorOptions {
  /** node 加桥接脚本的绝对路径，例如 ['/usr/bin/node', '/srv/fleet-dao/packages/adapters/src/mirasim/bridge.ts']。 */
  bridgeCommand: readonly string[];
  /**
   * 起进程、等它连上 Mirasim 总共给多久（含桥接自己 90 秒的重试预算，bridge.ts 的 CONNECT_BUDGET_MS）：默认比那个预算
   * 多留 10 秒给 sudo、node 启动本身的开销，和直连那份 mirasimConnector 的 90 秒预算对齐、留出余量。
   */
  connectTimeoutMs?: number;
  /** 帮手脚本，默认 procs.ts 的 SCOPE_HELPER。 */
  helper?: string;
  /** 调帮手的前缀，默认 ['/usr/bin/sudo', '-n']；测试给 [] 直接起假帮手。 */
  sudo?: readonly string[];
  /** 每次连都要不同的 scope 编号（同一时刻不许重复）；测试用，默认现生成一个。 */
  scopeId?: () => string;
  /** 测试换成假的 spawn。 */
  spawn?: typeof nodeSpawn;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 100_000;
/** stderr 只留末尾这么多字节，桥接起不来时报的原因不至于把整段日志吞进去。 */
const STDERR_TAIL = 2_000;

interface BridgeControlFrame {
  __bridge: 'ready' | 'closed' | 'error';
  kind?: string;
  message?: string;
}

function asBridgeControl(value: unknown): BridgeControlFrame | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.__bridge !== 'ready' && rec.__bridge !== 'closed' && rec.__bridge !== 'error') return undefined;
  return rec as unknown as BridgeControlFrame;
}

/**
 * 经桥接连一次：起进程、等它报 ready 或者报错 / 退出 / 超时。连上了给一个 MirasimWire（send 写 stdin、next 读 stdout、
 * close 关 stdin 再经帮手收掉整个 scope）；连不上按几类分别报（桥接起不来、桥接没起来就退出、连 Mirasim 本身的失败——
 * 令牌不在、服务连不上——由 bridge.ts 的 __bridge:error 帧带话上来）。
 */
export function bridgeMirasimConnector(
  endpoint: BridgeMirasimEndpoint,
  options: BridgeConnectorOptions,
): MirasimConnect {
  if (!options.bridgeCommand[0]?.startsWith('/')) {
    throw new Error(`桥接命令要写绝对路径：${JSON.stringify(options.bridgeCommand)}`);
  }
  return () =>
    new Promise<MirasimWire>((resolve, reject) => {
      const scope: CgroupScope = {
        id: (options.scopeId ?? (() => `mirasim-${randomUUID()}`))(),
        user: endpoint.user,
        ...(options.helper ? { helper: options.helper } : {}),
        ...(options.sudo ? { sudo: options.sudo } : {}),
      };
      let argv: string[];
      let env: Record<string, string>;
      try {
        const prefix = scopePrefix(scope, '/');
        // 和别处调帮手同一份最小环境（procs.ts 的 scopeExec）：PATH 找得到 sudo、帮手脚本，LANG 给帮手脚本本身
        // （bash）用，别的一概不传——桥接不需要任何 FLEET_* 配置，只靠命令行上的端口、令牌文件路径。
        env = scopeLaunch({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }).sudoEnv;
        argv = [...prefix, ...options.bridgeCommand, String(endpoint.port), endpoint.tokenFile];
      } catch (err) {
        reject(new Error(`桥接起不来：${(err as Error).message}`));
        return;
      }
      const [bin, ...args] = argv;
      const spawnFn = options.spawn ?? nodeSpawn;
      let child: ChildProcess;
      try {
        child = spawnFn(bin as string, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch (err) {
        reject(new Error(`桥接起不来：${(err as Error).message}`));
        return;
      }
      // stdio 三个都要了 'pipe'：三条流一定在，TS 认不出这个（走的是变量持有的 spawn 签名，不是字面量调用那个重载）
      const stdin = child.stdin as NodeJS.WritableStream;
      const stdout = child.stdout as NodeJS.ReadableStream;
      const stderr = child.stderr as NodeJS.ReadableStream;

      const splitter = new LineSplitter();
      let stderrTail = '';
      let settled = false;
      let closedForever = false;
      const queue: (MirasimFrame | 'closed')[] = [];
      const waiters: ((value: MirasimFrame | 'closed') => void)[] = [];

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经没了
        }
        // 光杀这一层（sudo/帮手那个进程）不够：会话用户身份的桥接在它自己的 scope 里，帮手一断不代表 cgroup
        // 跟着清空（生产会撞见，假帮手的测试不会）。经帮手把整个 scope 收掉，和 close() 同一条双保险。
        void stopScope(scope).catch(() => {});
        reject(
          new Error(
            `桥接连 Mirasim 超时（${Math.round((options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000)} 秒）`,
          ),
        );
      }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      const wire: MirasimWire = {
        send(frame) {
          if (closedForever) return;
          try {
            stdin.write(`${JSON.stringify(frame)}\n`);
          } catch {
            // 桥接已经没了，next() 那头的 closed 会跟着到
          }
        },
        next(timeoutMs) {
          const queued = queue.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          if (closedForever) return Promise.resolve('closed');
          return new Promise((done) => {
            const timer = setTimeout(() => {
              const at = waiters.indexOf(settleWait);
              if (at >= 0) waiters.splice(at, 1);
              done('timeout');
            }, timeoutMs);
            const settleWait = (value: MirasimFrame | 'closed') => {
              clearTimeout(timer);
              done(value);
            };
            waiters.push(settleWait);
          });
        },
        close() {
          closedForever = true;
          try {
            stdin.end();
          } catch {
            // 已经关了
          }
          // 双保险：桥接自己没听 stdin 关（卡住、忙着重试连接）时，经帮手把整个 scope 收掉（systemd 先 TERM、
          // 15 秒后 KILL，和别的会话收尸同一条路，procs.ts 的 stopScope）。
          void stopScope(scope).catch(() => {});
        },
      };

      const pushClosed = () => {
        if (closedForever) return;
        closedForever = true;
        for (const w of waiters.splice(0)) w('closed');
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const control = asBridgeControl(parsed);
        if (control) {
          if (control.__bridge === 'ready') {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutTimer);
              resolve(wire);
            }
            return;
          }
          if (control.__bridge === 'error') {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutTimer);
              reject(new Error(`桥接：${control.message ?? control.kind ?? '没给原因'}`));
            } else {
              pushClosed();
            }
            return;
          }
          // 'closed'
          pushClosed();
          return;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const frame = parsed as MirasimFrame;
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
          else queue.push(frame);
        }
      };

      stdout.on('data', (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });
      stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          reject(new Error(`桥接进程起不来：${err.message}`));
        } else pushClosed();
      });
      child.on('close', (code) => {
        for (const line of splitter.end()) handleLine(line);
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          const tail = stderrTail.trim().slice(-300);
          reject(new Error(`桥接没起来：退出码 ${code}${tail ? `（${tail}）` : ''}`));
          return;
        }
        pushClosed();
      });
    });
}
