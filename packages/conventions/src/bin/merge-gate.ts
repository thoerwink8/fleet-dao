// 合并闸入口：node packages/conventions/src/bin/merge-gate.ts [--no-write]
// merge-gate.yml 里跑：按事件（GITHUB_EVENT_NAME、GITHUB_EVENT_PATH）认出要算哪些 PR，算完在各自当前头上写 merge-gate 状态。
// 带 --no-write：只算这个 PR、只报不写，退出码 0 能合 / 1 不能合 / 2 没查成（手动看用，要 pull_request 类的事件文件）。
import { ghApi } from '../gh-api.ts';
import { gateGitHub, runMergeGate } from '../merge-gate.ts';
import { annotation } from '../pr-fields.ts';

const env = process.env;

const runUrl =
  env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
const { code, lines } = await runMergeGate({
  eventName: env.GITHUB_EVENT_NAME,
  eventPath: env.GITHUB_EVENT_PATH,
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
