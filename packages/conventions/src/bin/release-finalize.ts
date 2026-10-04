// release.yml 收尾那一步的入口：node packages/conventions/src/bin/release-finalize.ts（编排在 ../release-finalize.ts）。
// 读环境变量：VERSION（v<N>）、EVENT_NAME（pull_request / workflow_dispatch）、PR_MERGE_COMMIT_SHA 和 RELEASE_MERGED_AT
// （pull_request 事件里带着；手动补跑时空着，按 head=release/v<N> 查）、GITHUB_REPOSITORY、GITHUB_TOKEN（contents、issues 要能写）、
// FLEET_FEISHU（飞书 webhook，没配就不推、不算红）、GITHUB_SERVER_URL。
// 每一步打一行日志；七步的状态表写进 $GITHUB_STEP_SUMMARY（本机跑时只打出来）。
// 退出码：0 走完了（做了或跳过）；1 有一步红了（打 ::error::，后面的步骤都没走）。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { finalizeRelease, postFeishu, renderFinalizeReport } from '../release-finalize.ts';

const env = process.env;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = repoName(env, root);
if (!repo) {
  console.error(
    annotation('认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）：收尾一步都没走。'),
  );
  process.exit(1);
}

const version = (env.VERSION ?? '').trim();
const webhook = env.FLEET_FEISHU?.trim();
const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');

const r = await finalizeRelease({
  version,
  trigger:
    env.EVENT_NAME === 'pull_request'
      ? {
          kind: 'pull_request',
          mergeSha: env.PR_MERGE_COMMIT_SHA ?? '',
          mergedAt: env.RELEASE_MERGED_AT ?? '',
        }
      : { kind: 'dispatch' },
  github: liveGitHub(repo, env),
  feishu: webhook ? { send: (text) => postFeishu(webhook, text) } : undefined,
  changelogUrl: `${server}/${repo}/blob/${version}/CHANGELOG.md`,
  log: (line) => console.log(line),
});

const report = renderFinalizeReport(version, r);
console.log(`\n${report}`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, report);
const failed = r.steps.find((s) => s.status === 'failed');
if (failed) {
  console.error(annotation(`${failed.title}红了：${failed.note}`));
  process.exitCode = 1;
}
