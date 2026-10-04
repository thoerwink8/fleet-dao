// changes job 在主线推送时先跑这个，查「上一次主线真绿的头」，把它交给 ci-plan.ts 的 --main-base（判法在 ../main-baseline.ts）：
//   node packages/conventions/src/bin/main-base.ts <工作流文件名> <分支>
// 标准输出只有一行：40 位提交号；查不到就什么都不打、退出码 0——调用方（ci-plan）见空基准照旧全跑。
// 查不成（接口 4xx/5xx、没令牌）同样退到全跑，但在 Actions 里打一条 ::warning:: 让人看得见，绝不当「上次绿就是这次」。
import { ghApi } from '../gh-api.ts';
import { lastGreenMainSha } from '../main-baseline.ts';

const [workflowFile, branch] = process.argv.slice(2);
if (!workflowFile || !branch || !/^[\w.-]+$/.test(workflowFile) || !/^[\w./-]+$/.test(branch)) {
  console.error('用法：main-base.ts <工作流文件名> <分支>');
  process.exit(2);
}

try {
  const sha = await lastGreenMainSha(ghApi(process.env), workflowFile, branch);
  if (sha === null) {
    console.error(`::warning::主线没找到上一次绿的 ${workflowFile} 运行，这一轮退回全跑`);
  } else {
    console.log(sha);
  }
} catch (e) {
  console.error(
    `::warning::读主线上一次绿的基准没成（${e instanceof Error ? e.message : String(e)}），这一轮退回全跑`,
  );
}
