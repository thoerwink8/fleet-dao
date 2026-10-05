// 合并闸入口：node packages/conventions/src/bin/merge-gate.ts [--no-write]
// merge-gate.yml 里跑：按事件（GITHUB_EVENT_NAME、GITHUB_EVENT_PATH）认出要算哪些 PR，算完在各自当前头上写 merge-gate 状态。
// 带 --no-write：只算这个 PR、只报不写，退出码 0 能合 / 1 不能合 / 2 没查成（手动看用，要 pull_request 类的事件文件）。
// 高风险清单读跑这段代码的那一份检出（merge-gate.yml 检出的是主线，PR 改不了自己的门槛）。
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghApi } from '../gh-api.ts';
import { gateGitHub, runMergeGate, workflowParseNeeded } from '../merge-gate.ts';
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

// --needs-yaml：不算也不写，只回答「这次要算的 PR 里有没有改已有 ci.yml 的」（要不要装 YAML 依赖），把 needed=true|false 写进
// $GITHUB_OUTPUT。只有查实没有才写 false；任何没判成都写 true。这一步自己崩了、没写出来，工作流按「不是 false 就装」处理。
if (process.argv.includes('--needs-yaml')) {
  const r = await workflowParseNeeded({
    eventName: env.GITHUB_EVENT_NAME,
    eventPath: env.GITHUB_EVENT_PATH,
    riskListText,
    gh: gateGitHub(ghApi(env)),
  });
  console.log(`needed=${r.needed}（${r.why}）`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `needed=${r.needed}\n`);
  process.exit(0);
}

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
  if (code === 0) console.log(line);
  else console.error(inActions && !line.startsWith('PR #') ? annotation(line.trim()) : line);
}
process.exitCode = code;
