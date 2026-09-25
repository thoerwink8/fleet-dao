// 假的 Mirasim 服务：只在测试里用，按脚本回帧。发起连接上答 getState / prompt / stop，
// 订阅连接上把一份真跑记录里本会话的帧按序推过去（可以掺别的会话的帧）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MirasimFrame, MirasimWire } from '../src/mirasim/wire.ts';
import { FIXTURES } from './helpers.ts';

export interface MirasimRecording {
  sessionKey: string;
  taskId: string;
  prompt: MirasimFrame;
  /** 订阅连接上收到的本会话帧（snapshot / session），按原来的顺序。 */
  stream: MirasimFrame[];
}

export function mirasimRecording(name: string): MirasimRecording {
  const rows = readFileSync(join(FIXTURES, 'mirasim', `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { dir: string; frame: MirasimFrame });
  const accepted = rows.find((r) => r.frame.type === 'accepted')?.frame ?? {};
  const sessionKey = String(accepted.sessionKey);
  return {
    sessionKey,
    taskId: String(accepted.taskId),
    prompt: rows.find((r) => r.dir === 'out' && r.frame.type === 'prompt')?.frame ?? {},
    stream: rows
      .filter(
        (r) =>
          r.dir === 'in' &&
          r.frame.sessionKey === sessionKey &&
          ['snapshot', 'session'].includes(String(r.frame.type)),
      )
      .map((r) => r.frame),
  };
}

export interface FakeMirasimOptions {
  agents?: string[];
  version?: string;
  /** 对 prompt 帧的应答（可以是按序回的几帧）；返回 undefined = 不应答（模拟没等到 accepted）。 */
  reply?: (prompt: MirasimFrame) => MirasimFrame | MirasimFrame[] | undefined;
  /** 第一次 subscribe 之后推的帧。 */
  stream?: MirasimFrame[];
  /** 收到 stop 之后往订阅连接推的帧。 */
  afterStop?: MirasimFrame[];
  /** 建连失败。 */
  refuse?: boolean;
  /** getState 不回。 */
  silent?: boolean;
}

export class FakeMirasim {
  readonly sent: { conn: number; frame: MirasimFrame }[] = [];
  connects = 0;
  readonly options: FakeMirasimOptions;
  #subscriber: FakeWire | undefined;
  #streamed = false;
  #stopped = false;
  constructor(options: FakeMirasimOptions) {
    this.options = options;
  }

  connect = async (): Promise<MirasimWire> => {
    this.connects++;
    if (this.options.refuse) throw new Error('ECONNREFUSED');
    return new FakeWire(this, this.connects);
  };

  framesOf(type: string): MirasimFrame[] {
    return this.sent.filter((s) => s.frame.type === type).map((s) => s.frame);
  }

  handle(wire: FakeWire, frame: MirasimFrame): void {
    this.sent.push({ conn: wire.id, frame });
    switch (frame.type) {
      case 'getState':
        if (!this.options.silent) {
          wire.push({
            type: 'state',
            state: {
              version: this.options.version ?? '0.0.362',
              agentsAvailable: this.options.agents ?? ['kimi', 'pi', 'codex'],
            },
          });
        }
        break;
      case 'prompt': {
        const reply = this.options.reply?.(frame);
        for (const f of Array.isArray(reply) ? reply : reply ? [reply] : []) wire.push(f);
        break;
      }
      case 'subscribe':
        this.#subscriber = wire;
        if (!this.#streamed) {
          this.#streamed = true;
          for (const f of this.options.stream ?? []) wire.push(f);
        }
        // 先停后订阅：订阅回的快照就是停了之后的样子
        if (this.#stopped) for (const f of this.options.afterStop ?? []) wire.push(f);
        break;
      case 'stop':
        this.#stopped = true;
        for (const f of this.options.afterStop ?? []) this.#subscriber?.push(f);
        break;
      default:
        break;
    }
  }
}

class FakeWire implements MirasimWire {
  readonly #inbox: MirasimFrame[] = [];
  readonly #waiters: ((f: MirasimFrame | 'closed') => void)[] = [];
  #closed = false;
  readonly server: FakeMirasim;
  readonly id: number;
  constructor(server: FakeMirasim, id: number) {
    this.server = server;
    this.id = id;
  }

  push(frame: MirasimFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(frame);
    else this.#inbox.push(frame);
  }

  send(frame: MirasimFrame): void {
    if (!this.#closed) this.server.handle(this, frame);
  }

  next(timeoutMs: number): Promise<MirasimFrame | 'timeout' | 'closed'> {
    const queued = this.#inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve('closed');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.#waiters.indexOf(settle);
        if (at >= 0) this.#waiters.splice(at, 1);
        resolve('timeout');
      }, timeoutMs);
      const settle = (f: MirasimFrame | 'closed') => {
        clearTimeout(timer);
        resolve(f);
      };
      this.#waiters.push(settle);
    });
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w('closed');
  }
}

export function accepted(recording: MirasimRecording): (prompt: MirasimFrame) => MirasimFrame {
  return (prompt) => ({
    type: 'accepted',
    clientRef: prompt.clientRef,
    sessionKey: recording.sessionKey,
    taskId: recording.taskId,
  });
}
