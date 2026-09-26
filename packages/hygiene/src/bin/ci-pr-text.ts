// CI 里扫 PR 标题和正文的入口：node <代码来源>/packages/hygiene/src/bin/ci-pr-text.ts
// 标题、正文从环境变量 PR_TITLE / PR_BODY 读：工作流那边用 env: 传值（GitHub 在拼这一步的 shell 脚本之前就替换好
// 环境变量了），绝不能把 ${{ github.event.pull_request.title/body }} 直接拼进 run 脚本文本——标题、正文是 PR 作者
// 能自由写的内容，直接拼进脚本文本等于把它们当命令跑（脚本注入）。判定在 ../ci-text.ts。
import { ciTextCheck } from '../ci-text.ts';
import { loadSensitiveValues } from '../values.ts';

const { code, lines } = ciTextCheck({
  title: process.env.PR_TITLE ?? '',
  body: process.env.PR_BODY ?? '',
  values: loadSensitiveValues(),
});
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
