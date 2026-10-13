# 0089 规则减法：派完就收这一轮，只钉行为不钉文字，子代理不读主对话的规矩

- 日期：2026-10-13（北京时间 17:54）
- 谁拍的：创始人在对话里选定（原话见下），指挥官合成施工单、分片落地。改标准，引入它的 PR 合并即生效。
- 状态：采纳，分片落地（片 A 常驻文本、片 B 钩子行为、片 C 代理）。
- 取代：0083 第 1 条（人在场还有子代理就别收这一轮、单次前台等待不超过 60 秒）；0027 第 4 条后半句（被测试钉住的句子不拆）；0024、0026、0028、0030、0078 合成下面「派活和回合」一节，以本份为准。
- 关联：`agents/shared-rules.md`、仓根 `AGENTS.md`、`agents/subagents/`、`agents/test/rules/`、`agents/rules-budget.json`、`agents/hooks/pretool.mjs`、`agents/hooks/main-thread.mjs`、`agents/skills/commander/SKILL.md`、`agents/skills-vendor/vendor.lock.json`。

## 原话

```
2026-10-13 17:54，创始人在对话里（#1055 评论 6151781280）

都同意，你后面自己去统一优化吧，处理掉；你可以不断做测试，优化到最佳的情况下。我们现在太冗余了，我也不知道问题出在哪。你全都修复掉，有好用的方式都给用上
```

```
2026-10-13 17:45，创始人在另一会话（d8a9115b）

落后的规则就是要删掉的。我们之前定了很多规则，我后面其实连规则册都想大改掉
```

## 决定

1. 子代理一律后台跑。派完、手上没有下一刀就收这一轮，说清在跑什么、大概多久回；完成通知会叫回会话，不轮询、不 sleep 等。进展靠 Mirasim「后台 · N 个子代理」面板和每个完成通知报一行。0083 当时的顾虑（「不知道进展、断掉了」）由此接住。
2. 删「单次前台等待不超过 60 秒」的文字和钩子（两天拦 18 次，全是误伤）；删「子代理不许前台派」的钩子分支（两天 0 次）。
3. `Plan`、`general-purpose` 两份定义加 `omitClaudeMd: true`（`Explore` 原来就有）：子代理不读主对话的全局说明，底线和人闸四类写进定义正文。三份都限回合数。
4. 只核对「某句话在不在」的规则测试删掉；钩子行为、定义文件、设置、脚本存在性的测试保留；字数账 `agents/rules-budget.json` 保留，这次瘦身把 baseline 设成新字数、log 清空。
5. 第三方技能删 6 个：using-git-worktrees、test-driven-development、verification-before-completion、webapp-testing、receiving-code-review、mcp-builder。
6. 新钩子拦 `cd <目录> && <只读查看命令>`（cat、sed -n、head、tail、grep、rg、ls、type、Get-Content），提示改用 Read、Grep、Glob 或 `git -C`。
7. git、gh、curl 不走 reclaude 的代理，改走本机 mihomo（片 C）。
8. 进程命令行从拦改为自动接脱敏后放行；起子代理前取不到远端从拦改为提示。

## 派活和回合（合成 0024、0026、0028、0030、0078、0083）

- 派活默认用 Agent 子代理，后台跑，无人值守、过夜也一样，不脱离会话（脱离会话的工人整套在片 B 删掉）。
- 他中途的话一到，下一次调工具前先回一句；关系到在跑的子代理，用 `SendMessage` 原话转它。一轮结束不杀后台子代理。
- 人在场：派完就收这一轮（第 1 条）。
- 无人值守：只有这个会话自己跑了 `unattended.mjs on` 才由收尾钩子挂住这一轮；起子代理、后台命令不自动开；off、done、needs-you、满 12 小时、空转到上限、子代理都收口了都放行。
- 引导中继已删；流程钩子只登记在 fleet-dao 仓的项目设置；引擎无头会话设 `FLEET_HEADLESS=1`，流程钩子直接退出（照 0083 第 3–6 条）。
