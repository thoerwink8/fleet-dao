// 假 hostd：握手时报一个我们不认的协议版本（版本拒用用例）。
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const f = JSON.parse(line);
  if (f.type === 'hello') {
    process.stdout.write(
      `${JSON.stringify({ type: 'welcome', id: f.id, protocol: 99, hostd: '9.9.9', os: 'x', arch: 'y', capabilities: [] })}\n`,
    );
  }
});
