// systemd socket activation（deploy/france/fleet-api.socket、#364）：src/listen.ts 的解析、按地址对号，
// 都用假数据测；真 fd 的集成测试（systemd-socket-activate）证明「重启时连接排队、不拒连」，见文件末尾。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ListenFdError, matchListenTargets, startListeners } from '../src/listen.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'listen-fixture.ts');

describe('matchListenTargets：几个已经听上的地址按 host:port 和配置对号', () => {
  const targets = [
    { name: 'cockpit', at: { host: '10.99.0.2', port: 8787 } },
    { name: 'agent', at: { host: '127.0.0.1', port: 8788 } },
  ];

  it('先听上谁不管，按地址对号：返回每个地址对应 targets 的下标', () => {
    expect(
      matchListenTargets(
        [
          { host: '127.0.0.1', port: 8788 },
          { host: '10.99.0.2', port: 8787 },
        ],
        targets,
      ),
    ).toEqual([1, 0]);
  });

  it('地址不是配置里认识的：报错写清是哪个地址、配置认识哪几个', () => {
    expect(() =>
      matchListenTargets(
        [
          { host: '10.99.0.2', port: 8787 },
          { host: '0.0.0.0', port: 9999 },
        ],
        targets,
      ),
    ).toThrow(/0\.0\.0\.0:9999.*cockpit 10\.99\.0\.2:8787.*agent 127\.0\.0\.1:8788/);
  });

  it('同一个地址来了不止一个：报错写清是哪个地址、哪项配置只要一个', () => {
    expect(() =>
      matchListenTargets(
        [
          { host: '10.99.0.2', port: 8787 },
          { host: '10.99.0.2', port: 8787 },
        ],
        targets,
      ),
    ).toThrow(/10\.99\.0\.2:8787（配置里的 cockpit 只要一个）/);
  });

  it('缺一个：报错写清缺了哪个（名字和地址）', () => {
    expect(() => matchListenTargets([{ host: '10.99.0.2', port: 8787 }], targets)).toThrow(
      /没传监听套接字给：agent 127\.0\.0\.1:8788/,
    );
  });
});

describe('startListeners：LISTEN_PID / LISTEN_FDS 读不出，明确拒绝、不悄悄自己 bind', () => {
  const targets = [{ name: 'x', at: { host: '127.0.0.1', port: 1 }, fetch: () => new Response('x') }];

  it('【故意造出的失败】LISTEN_PID 不是本进程：不是传给我们的，拒绝', async () => {
    await expect(
      startListeners(targets, { LISTEN_PID: String(process.pid + 1), LISTEN_FDS: '1' }),
    ).rejects.toThrow(ListenFdError);
    await expect(
      startListeners(targets, { LISTEN_PID: String(process.pid + 1), LISTEN_FDS: '1' }),
    ).rejects.toThrow(/LISTEN_PID=\d+ 不是本进程/);
  });

  it('【故意造出的失败】LISTEN_FDS 不是正整数（认不出、是 0）：拒绝', async () => {
    await expect(
      startListeners(targets, { LISTEN_PID: String(process.pid), LISTEN_FDS: 'abc' }),
    ).rejects.toThrow(/LISTEN_FDS「abc」不是正整数/);
    await expect(
      startListeners(targets, { LISTEN_PID: String(process.pid), LISTEN_FDS: '0' }),
    ).rejects.toThrow(/不是正整数/);
  });

  it('【故意造出的失败】fd 个数和配置要的目标个数对不上：拒绝，写清要几个', async () => {
    await expect(
      startListeners(targets, { LISTEN_PID: String(process.pid), LISTEN_FDS: '2' }),
    ).rejects.toThrow(/传了 2 个监听套接字，配置要 1 个（x）/);
  });

  it('没有 LISTEN_PID：不是 socket activation，照旧自己 bind（本机开发、测试）', async () => {
    const servers = await startListeners(
      [{ name: 'x', at: { host: '127.0.0.1', port: 0 }, fetch: () => new Response('ok') }],
      {},
    );
    try {
      expect(servers).toHaveLength(1);
      const server = servers[0];
      if (!server) throw new Error('没听起来');
      if (!server.listening) await once(server, 'listening');
      expect(server.listening).toBe(true);
    } finally {
      for (const s of servers) s.close();
    }
  });
});

// ── 真 fd 的集成测试：systemd-socket-activate 先把两个端口 bind + listen 好，再把 LISTEN_PID / LISTEN_FDS 传给
// listen-fixture.ts（和真的 systemd 传给 fleet-api.socket 一样）。CI 是 ubuntu，装了 systemd 就有这个工具；
// Windows 本机没有 systemd，这一段就跳过——不是「没测」，是这个特性本来就是 Linux/生产专属的，本机测不了。

function hasSystemdSocketActivate(): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync('systemd-socket-activate', ['--help'], { stdio: 'ignore' }).error === undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const info = srv.address();
      if (info === null || typeof info === 'string') {
        reject(new Error('拿不到临时端口：net.Server.address() 认不出'));
        return;
      }
      srv.close(() => resolve(info.port));
    });
  });
}

function waitForStdout(child: ChildProcess, want: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(
        new Error(`等了 ${timeoutMs} 毫秒还没看到子进程打「${want}」，已收到：${buf || '（没有输出）'}`),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(want)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      if (!buf.includes(want)) {
        clearTimeout(timer);
        reject(new Error(`子进程在打「${want}」之前就退出了（退出码 ${code}）`));
      }
    });
  });
}

/**
 * 连到一个端口，连不上就再试（`systemd-socket-activate` 是另起的进程，spawn() 一回来它自己还没跑到 bind/listen
 * 那一步，这段时间里 connect 会 ECONNREFUSED——不是「端口没被排队」，是这个外部进程自己启动慢；CI 的机器比本机慢，
 * 只试一次会偶发假红）。超时了才是真的「不该失败还失败了」。
 */
function connectRetrying(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = connect(port, host);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`连 ${host}:${port} 试到超时（${timeoutMs}ms）还是被拒`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function httpGetBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!hasSystemdSocketActivate())(
  '真 fd 集成测试（systemd-socket-activate）：重启期间连接排队、不被拒',
  () => {
    it('端口已经被 systemd-socket-activate 绑好监听：进程启动慢也不耽误连接排队；听上以后两个 fd 按地址对号对了', async () => {
      const [aPort, bPort] = await Promise.all([freePort(), freePort()]);
      const child = spawn(
        'systemd-socket-activate',
        [
          '--listen',
          `127.0.0.1:${aPort}`,
          '--listen',
          `127.0.0.1:${bPort}`,
          '--',
          process.execPath,
          FIXTURE,
          String(aPort),
          String(bPort),
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          // 让子进程（listen-fixture.ts）的 startListeners 晚一点才调用：这段时间里端口是由 systemd-socket-activate
          // 绑着、听着的，不是由我们的进程——这正是「重启时不丢请求」要验的事。
          env: { ...process.env, FLEET_TEST_LISTEN_DELAY_MS: '800' },
        },
      );
      try {
        // 连的是 systemd-socket-activate 自己绑的端口（子进程的 startListeners 还没跑到，见上面 delay 那行的注释）：
        // 连得上就证明「排队等着接」这件事本身成立，不用等子进程真起来。
        await connectRetrying(aPort, '127.0.0.1', 5_000);

        // fixture 真的调用了 startListeners、两个 fd 都听上了才会打这一行；等它，不瞎猜时间。
        await waitForStdout(child, 'ready', 10_000);

        const [a, b] = await Promise.all([httpGetBody(aPort), httpGetBody(bPort)]);
        expect(a).toBe('from-a\n');
        expect(b).toBe('from-b\n');
      } finally {
        child.kill('SIGKILL');
      }
    }, 20_000);
  },
);
