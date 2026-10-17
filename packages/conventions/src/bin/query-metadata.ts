// 只执行可信主线代码；事件 title/body 是 JSON 数据，不拼 shell，不读取 PR 的代码。
import { readFileSync } from 'node:fs';
import { runMain } from '../exit.ts';
import { liveGitHub, resolveRepo } from '../github-api.ts';
import { reconcileQueryMetadata } from '../query-metadata.ts';

runMain(async () => {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('没有 GITHUB_EVENT_PATH，没查成');
  const event = JSON.parse(readFileSync(path, 'utf8'));
  const item = event.issue ?? event.pull_request;
  if (!Number.isSafeInteger(item?.number) || item.number <= 0) throw new Error('事件没有有效单号');
  const resolved = resolveRepo(process.env, process.cwd());
  if (!resolved.repo) throw new Error(resolved.error ?? '认不出目标仓');
  if (event.repository?.full_name?.toLowerCase() !== resolved.repo.toLowerCase())
    throw new Error('事件仓与目标仓不一致，未写元数据');
  const gh = liveGitHub(resolved.repo, process.env);
  const result = await reconcileQueryMetadata(gh, item.number);
  if (result.problems.length > 0) {
    console.error(
      `#${item.number}：${result.problems.join('；')}。请补标签或独立声明行「域: engine」「性质: bug」，再编辑正文重试；未猜分类。`,
    );
    process.exitCode = 1;
  } else console.log(`#${item.number} 查询轴已回读齐全${result.changed ? '（已补齐）' : ''}`);
});
