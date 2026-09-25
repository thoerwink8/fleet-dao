// 合并闸入口：node packages/conventions/src/bin/merge-gate.ts [--no-write]
// merge-gate.yml 里跑：按事件（GITHUB_EVENT_NAME、GITHUB_EVENT_PATH）认出要算哪些 PR，算完在各自当前头上写 merge-gate 状态。
// pr.yml 里带 --no-write 跑：只算这个 PR、只报不写，退出码 0 能合 / 1 不能合 / 2 没查成（主线必过检查换成 merge-gate 之前的过渡）。
// 高风险清单读跑这段代码的那一份检出（merge-gate.yml 检出的是主线，PR 改不了自己的门槛）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghApi } from '../gh-api.ts';
import { gateGitHub, runMergeGate } from '../merge-gate.ts';
import { RISK_PATHS_FILE } from '../merge-gates.ts';
import { annotation } from '../pr-fields.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let riskListText: string | undefined;
try {
  riskListText = readFileSync(`${root}/${RISK_PATHS_FILE}`, 'utf8');
} catch {
  riskListText = undefined;
}
const env = process.env;
const runUrl =
  env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
const { code, lines } = await runMergeGate({
  eventName: env.GITHUB_EVENT_NAME,
  eventPath: env.GITHUB_EVENT_PATH,
  riskListText,
  gh: gateGitHub(ghApi(env)),
  write: !process.argv.includes('--no-write'),
  ...(runUrl ? { targetUrl: runUrl } : {}),
});
const inActions = env.GITHUB_ACTIONS === 'true';
for (const line of lines) {
  // 必填栏只提醒：黄色警告，不算红
  if (line.trim().startsWith('提醒：')) console.log(inActions ? annotation(line.trim(), 'warning') : line);
  else if (code === 0) console.log(line);
  else console.error(inActions && !line.startsWith('PR #') ? annotation(line.trim()) : line);
}
process.exitCode = code;
