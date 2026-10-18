// 合并闸入口：node packages/conventions/src/bin/merge-gate.ts [--no-write]
// merge-gate.yml 里跑：按事件（GITHUB_EVENT_NAME、GITHUB_EVENT_PATH）认出要算哪些 PR，算完在各自当前头上写 merge-gate 状态。
// 带 --no-write：只算这个 PR、只报不写，退出码 0 能合 / 1 不能合 / 2 没查成（手动看用，要 pull_request 类的事件文件）。

import { appendFileSync, readFileSync } from 'node:fs';
import { policyReader } from '../ci-policy-bridge.ts';
import { ghApi } from '../gh-api.ts';
import type { FeedbackEvent } from '../managed-feedback.ts';
import { readManagedFeedbackForGate, transactFeedback } from '../managed-feedback-github.ts';
import { eventTargets, gateGitHub, runMergeGate } from '../merge-gate.ts';
import { annotation } from '../pr-fields.ts';

const env = process.env;

const runUrl =
  env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
const api = ghApi(env);
const gh = gateGitHub(api);
if (process.argv.includes('--plan')) {
  if (env.FLEET_FEEDBACK_REQUEST) {
    if (!env.GITHUB_EVENT_PATH || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
      throw new Error('事务计划缺可信dispatch事件');
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const request = JSON.parse(env.FLEET_FEEDBACK_REQUEST) as FeedbackEvent;
    if (
      !/^[1-9]\d*$/.test(event.inputs?.pr ?? '') ||
      !Number.isSafeInteger(Number(event.inputs.pr)) ||
      Number(event.inputs.pr) !== request.pr ||
      event.inputs['request-id'] !== request.requestId
    )
      throw new Error('事务计划必须是协议同一规范精确PR和requestId');
  }
  const targets = await eventTargets(env.GITHUB_EVENT_NAME, env.GITHUB_EVENT_PATH, gh);
  if (typeof targets === 'string') throw new Error(targets);
  if (!env.GITHUB_OUTPUT) throw new Error('没有 GITHUB_OUTPUT');
  appendFileSync(env.GITHUB_OUTPUT, `prs=${JSON.stringify([...new Set(targets)])}\n`);
  process.exit(0);
}
const exact = env.FLEET_GATE_PR;
if (env.FLEET_FEEDBACK_REQUEST) {
  if (!exact || !env.GITHUB_EVENT_PATH || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('退回事务缺可信事件');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.full_name !== env.GITHUB_REPOSITORY || event.inputs?.pr !== exact)
    throw new Error('真实dispatch仓或精确PR不匹配');
  if (!Number.isSafeInteger(event.sender?.id) || event.sender?.type !== 'User')
    throw new Error('真实事件发起者身份未核实');
  const receipt = await transactFeedback(
    api,
    Number(exact),
    JSON.parse(env.FLEET_FEEDBACK_REQUEST) as FeedbackEvent,
    event.sender.id,
  );
  console.log(`FLEET_FEEDBACK_RECEIPT ${JSON.stringify(receipt)}`);
  if (receipt.state === 'late') process.exit(1);
}
const { code, lines } = await runMergeGate({
  ...(exact === undefined ? {} : { targetPr: Number(exact) }),
  eventName: env.GITHUB_EVENT_NAME,
  eventPath: env.GITHUB_EVENT_PATH,
  gh,
  readCiPolicy: policyReader(api, gh, env.GITHUB_REPOSITORY ?? ''),
  readFeedback: (pr, head) => readManagedFeedbackForGate(api, pr, head),
  write: !process.argv.includes('--no-write'),
  ...(runUrl ? { targetUrl: runUrl } : {}),
});
const inActions = env.GITHUB_ACTIONS === 'true';
for (const line of lines) {
  if (code === 0) console.log(line);
  else console.error(inActions && !line.startsWith('PR #') ? annotation(line.trim()) : line);
}
process.exitCode = code;
