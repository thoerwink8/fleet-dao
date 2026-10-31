// 起出网关：node packages/harness-egress/src/bin/egress-proxy.ts --port <口> --allowlist <名单文件> [--mode enforce|learn]
// 只听本机回环；每个判定一行 JSON 打到 stdout（进 journal）。名单文件一行一个主机名，# 开头是注释。
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createEgressProxy, type EgressMode } from '../proxy.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    allowlist: { type: 'string' },
    mode: { type: 'string', default: 'enforce' },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || !values.allowlist) {
  console.error('用法：egress-proxy.ts --port <口> --allowlist <名单文件> [--mode enforce|learn]');
  process.exit(2);
}
if (values.mode !== 'enforce' && values.mode !== 'learn') {
  console.error(`--mode 只认 enforce、learn，给的是 ${values.mode}`);
  process.exit(2);
}
const allowlist = readFileSync(values.allowlist, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const server = createEgressProxy({
  allowlist,
  mode: values.mode as EgressMode,
  onDecision: (d) => console.log(JSON.stringify(d)),
});
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ started: true, port, mode: values.mode, rules: allowlist.length }));
});
