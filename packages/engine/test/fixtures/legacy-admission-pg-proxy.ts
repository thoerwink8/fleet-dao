// 仅随机隔离库：先拦外层COMMIT发送，再放真实COMMIT但丢ACK；不伪造数据库回执。
import assert from 'node:assert/strict';
import net from 'node:net';

export async function commitAckProxy(databaseUrl: string, listenHost = '127.0.0.1') {
  const target = new URL(databaseUrl);
  assert.match(target.pathname, /^\/fleet_test_[a-f0-9]{32}$/);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  const sockets = new Set<net.Socket>();
  let seenCommit = false,
    released = false,
    dropBackend = false,
    droppedBytes = 0,
    commitExecuted = false;
  let upstream: net.Socket | undefined;
  const queued: Buffer[] = [];
  const server = net.createServer((front) => {
    sockets.add(front);
    const back = net.connect({ host: target.hostname, port: Number(target.port || 5432) });
    upstream = back;
    sockets.add(back);
    for (const socket of [front, back]) {
      socket.on('error', () => {
        front.destroy();
        back.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        front.destroy();
        back.destroy();
      });
    }
    back.on('data', (bytes) => {
      if (dropBackend) droppedBytes += bytes.length;
      else front.write(bytes);
    });
    let pending = Buffer.alloc(0),
      startup = true,
      lastSql = '';
    front.on('data', (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      assert(pending.length <= 1024 * 1024, 'synthetic proxy frontend cap');
      while (pending.length >= (startup ? 4 : 5)) {
        const size = startup ? pending.readUInt32BE(0) : pending.readUInt32BE(1) + 1;
        if (pending.length < size) return;
        const frame = Buffer.from(pending.subarray(0, size));
        pending = pending.subarray(size);
        if (startup) {
          startup = false;
          back.write(frame);
          continue;
        }
        const type = String.fromCharCode(frame[0] ?? 0);
        if (type === 'Q') lastSql = frame.subarray(5, -1).toString();
        if (type === 'P') {
          const endName = frame.indexOf(0, 5),
            endSql = frame.indexOf(0, endName + 1);
          lastSql = frame.subarray(endName + 1, endSql).toString();
        }
        const commit = /^\s*commit\s*;?\s*$/i.test(lastSql);
        if (commit && ['Q', 'P'].includes(type)) seenCommit = true;
        if (seenCommit && !released) queued.push(frame);
        else {
          if (commit && ['Q', 'E'].includes(type)) commitExecuted = true;
          back.write(frame);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, listenHost, resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = new URL(databaseUrl);
  url.hostname = listenHost;
  url.port = String(address.port);
  url.searchParams.set('sslmode', 'disable');
  return {
    url: url.href,
    status: () => ({ seenCommit, commitExecuted, droppedBytes }),
    releaseCommit() {
      assert(seenCommit && !released && upstream);
      released = true;
      dropBackend = true;
      // 所有已排的Commit帧都原样进入真PG；之后仅截掉真PG回给child的ACK。
      commitExecuted = true;
      for (const frame of queued.splice(0)) upstream.write(frame);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
