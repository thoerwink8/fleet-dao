// systemd-socket-activate 起两个监听套接字（bind + listen 都由它先做好），再把 LISTEN_PID / LISTEN_FDS 传给这个子
// 进程（sd_listen_fds(3) 的约定，和真的 systemd 一样）——packages/api/test/listen.test.ts 拿它验证：这个进程真正
// 调用 startListeners 之前（FLEET_TEST_LISTEN_DELAY_MS 模拟启动慢）连过来的连接不会被拒，一起来就排在队列里；
// 两个端口各自应的内容不一样，顺带验证 fd 和配置是按地址对上号的，不是随便哪个都行。
// 用法：node listen-fixture.ts <a 的端口> <b 的端口>
import { startListeners } from '../../src/listen.ts';

const [aPort, bPort] = process.argv.slice(2).map(Number);
if (!aPort || !bPort) {
  console.error('要两个端口号参数：node listen-fixture.ts <a 的端口> <b 的端口>');
  process.exit(2);
}

const delayMs = Number(process.env.FLEET_TEST_LISTEN_DELAY_MS ?? '0');
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

const servers = await startListeners([
  { name: 'a', at: { host: '127.0.0.1', port: aPort }, fetch: () => new Response('from-a\n') },
  { name: 'b', at: { host: '127.0.0.1', port: bPort }, fetch: () => new Response('from-b\n') },
]);

// 父进程靠这一行判断「真的听上了」，不猜时间。
console.log('ready');

process.once('SIGTERM', () => {
  for (const s of servers) s.close();
  process.exit(0);
});
