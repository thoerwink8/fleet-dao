// 假桥接：只在测试里用（mirasim-bridge.test.ts 的「假桥接（连接器逻辑）」那组），照环境变量摆布行为，验
// bridge-connect.ts 怎么认 ready / error / 退出 / 帧来回，不用真的 Mirasim 服务、不用真跑 bridge.ts。
// 真桥接脚本本身的真跑（读令牌、连真 ws）见同一个测试文件里「真桥接（bridge.ts）」那组，经假帮手起真的 bridge.ts。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.FLEET_FAKE_BRIDGE_LOG;
if (log) appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const mode = process.env.FLEET_FAKE_BRIDGE_MODE ?? 'ready';

if (mode === 'exit-before-ready') {
  process.exit(Number(process.env.FLEET_FAKE_BRIDGE_EXIT ?? '3'));
} else if (mode === 'error-before-ready') {
  writeLine({
    __bridge: 'error',
    kind: process.env.FLEET_FAKE_BRIDGE_ERROR_KIND ?? 'token_missing',
    message: process.env.FLEET_FAKE_BRIDGE_ERROR_MESSAGE ?? '假的：读不了令牌',
  });
  process.exit(1);
} else if (mode === 'hang') {
  // 什么都不写：等着被调用方判超时。假帮手（fake-scope-helper.ts）是 fork 出这个假桥接的，不是 exec 成它——
  // 调用方杀的是假帮手那一层，杀不到这里（真帮手是 exec，只有一个进程号，没有这层）；不自己兜底退出的话会一直
  // 挂着。5 秒后自己退，别让测试起的孤儿进程占着。
  setTimeout(() => process.exit(0), 5_000);
} else {
  writeLine({ __bridge: 'ready' });
  const echo = process.env.FLEET_FAKE_BRIDGE_ECHO !== '0';
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim() || !echo) return;
    try {
      writeLine(JSON.parse(line));
    } catch {
      // 不是 JSON 的行不回（和真桥接一样，读不出来的不转发）
    }
  });
  rl.on('close', () => {
    writeLine({ __bridge: 'closed' });
    process.exit(0);
  });
}
