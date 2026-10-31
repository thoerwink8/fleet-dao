// 假 fleet-agent-scope（scope-sandbox.test.ts 用）：node fake-scope-helper.mjs <日志文件> <模式> <帮手名> <动作> 参数…
// 每次调用往日志追加一行 JSON（动作和参数），按模式回执。真帮手的边界在 deploy/test/agent-scope*.sh 里测。
import { appendFileSync } from 'node:fs';

const [log, mode, , action, ...args] = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify([action, ...args])}\n`);
const out = (o) => process.stdout.write(JSON.stringify({ version: 1, ...o }));
const id = (dir, over = {}) => ({ lex: dir, real: dir, dev: '64769', ino: '1234', uid: '1001', ...over });

if (action === 'capabilities') {
  out(
    mode === 'old-helper'
      ? { state: 'ok', features: ['tree-usage'] }
      : { state: 'ok', features: ['tree-usage', 'identity-remove', 'locked-adopt', 'temporary-files'] },
  );
} else if (action === 'adopt') {
  if (mode === 'adopt-fails') {
    process.stderr.write('path outside managed root');
    process.exit(1);
  }
  out({
    state: 'adopted',
    identity: id(args[0], mode === 'wrong-identity' ? { lex: '/elsewhere', real: '/elsewhere' } : {}),
  });
} else if (action === 'remove') {
  out({
    state: 'removed',
    transaction: 'a'.repeat(64),
    identity: id(args[0], mode === 'remove-other' ? { ino: '9' } : {}),
  });
} else if (action === 'stop') {
  if (mode === 'stop-fails') {
    process.stderr.write('systemctl stop failed');
    process.exit(1);
  }
  process.stdout.write(`已收掉 fleet-agent-${args[0]}.scope\n`);
} else {
  process.exit(64);
}
