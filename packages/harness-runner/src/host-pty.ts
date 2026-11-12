// 终端走 hostd 的 pty.* 帧（#3927）。先 watch 再 request，避免开出来的第一截输出被丢掉。
// onData 里不能再 request：帧回调跑在读循环上，同步再写会和正在等的回复卡死。
// 关掉页面再开不会接回；连接一断，hostd 杀掉这个 pty。未做接回。
import { HostdError, type HostdProcessHost } from './host-hostd.ts';

export interface PtyEvents {
  runId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** `text` 是标准 base64 的原始字节，不是解码后的字符串。 */
  onData: (base64: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class HostdPty {
  readonly #host: HostdProcessHost;

  constructor(host: HostdProcessHost) {
    this.#host = host;
  }

  async open(opts: PtyEvents): Promise<void> {
    const conn = await this.#host.connect();
    conn.watch(opts.runId, {
      out: (stream, _line, text) => {
        if (stream === 'pty') opts.onData(text);
      },
      exit: (code, signal) => opts.onExit(code, signal),
      lost: () => opts.onExit(null, 'lost'),
    });
    try {
      const reply = await conn.request({
        type: 'pty.open',
        runId: opts.runId,
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
      });
      if (reply.type !== 'ok') throw new HostdError('bad_reply', `pty.open 得到 ${reply.type}`);
    } catch (err) {
      conn.unwatch(opts.runId);
      throw err;
    }
  }

  async input(runId: string, data: string): Promise<void> {
    const reply = await (await this.#host.connect()).request({ type: 'pty.input', runId, data });
    if (reply.type !== 'ok') throw new HostdError('bad_reply', `pty.input 得到 ${reply.type}`);
  }

  async resize(runId: string, cols: number, rows: number): Promise<void> {
    const reply = await (await this.#host.connect()).request({ type: 'pty.resize', runId, cols, rows });
    if (reply.type !== 'ok') throw new HostdError('bad_reply', `pty.resize 得到 ${reply.type}`);
  }

  async close(runId: string): Promise<void> {
    const conn = await this.#host.connect();
    try {
      const reply = await conn.request({ type: 'pty.close', runId });
      if (reply.type !== 'ok') throw new HostdError('bad_reply', `pty.close 得到 ${reply.type}`);
    } catch (err) {
      conn.unwatch(runId);
      if (err instanceof HostdError && err.code === 'run_not_found') return;
      throw err;
    }
  }
}
