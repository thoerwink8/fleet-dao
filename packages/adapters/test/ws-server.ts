// 测试用的极简 ws 服务端（RFC 6455 握手 + 文本帧），只给 Mirasim 连接的测试用：Node 自带 ws 客户端，不带服务端。
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

export interface WsConn {
  url: string;
  send(frame: unknown): void;
  close(): void;
  onMessage(handler: (frame: Record<string, unknown>) => void): void;
}

export async function startWsServer(
  onConnection: (conn: WsConn) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const handlers: ((frame: Record<string, unknown>) => void)[] = [];
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = (buf[0] as number) & 0x0f;
        const masked = ((buf[1] as number) & 0x80) !== 0;
        let len = (buf[1] as number) & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        off += masked ? 4 : 0;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask)
          for (let i = 0; i < payload.length; i++)
            payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
        buf = buf.subarray(off + len);
        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode === 1)
          for (const h of handlers) h(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
      }
    });
    const send = (frame: unknown) => {
      const data = Buffer.from(JSON.stringify(frame), 'utf8');
      const head =
        data.length < 126
          ? Buffer.from([0x81, data.length])
          : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
      socket.write(Buffer.concat([head, data]));
    };
    onConnection({
      url: req.url ?? '',
      send,
      close: () => {
        socket.write(Buffer.from([0x88, 0]));
        socket.end();
      },
      onMessage: (h) => handlers.push(h),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
