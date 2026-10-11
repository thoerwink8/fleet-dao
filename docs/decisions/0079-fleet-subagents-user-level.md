# 0079 16 个 fleet-* 子代理随 agents:sync 装到每台机器的用户级，原件只在 .claude/agents/（部分取代 0036）

- 日期：2026-10-11（北京时间）
- 谁拍的：创始人要每台有 fleet-dao 的机器都有最佳子代理（原话在下面）；原件放哪、怎么装由改标准的会话定。法国 VPS 装不装用户级，待创始人拍（见「影响」最后一条）。
- 状态：待创始人同意。同步工具的目标清单、钉住它的测试、参考页和技能说明同一个 PR 改（改标准）。
- 关联：`packages/agents-sync/src/targets.ts`（`SUBAGENT_TARGET`）、`packages/agents-sync/src/sync.ts`（`readSubagents`）、`agents/test/rules/project-subagents.rules.test.ts`、`agents/test/rules/subagent-model.rules.test.ts`、`agents/skills/commander/references/子代理选模型.md`「本仓的子代理名单」、`agents/skills/commander/SKILL.md`「派活」、`docs/ops.md` 第五节
- 取代：部分取代 0036 第 2 条（「`haiku55` 留给没有这批定义的仓和机器」：同步后每台机器都有这批定义）和第 7 条（#1393 只装 `haiku55`：现在一起装 17 份）。0036 别的条、0077 的 effort 不变。#1641 方案第六节（只在本仓生效）不改原文，以本决定为准。

## 原话

```
2026-10-11（北京时间，交代里没给具体时刻）

我希望未来每台有fleet-dao的机器，包括vps，都能具备最佳subagent方式
```

```
2026-10-10 10:33（北京时间）

本机实现的subagent，我希望.agent规划n种各个opus sonnet haiku 5.5作为subagent的场景，按照网上的最佳实践走，探查每个的能力；然后vps和本机也要实装上
```

## 背景

16 个 `fleet-*` 定义在仓里 `.claude/agents/`（0036），Claude Code 只在 fleet-dao 的目录里载入它们。别的仓、别的目录里派不到，只剩 `haiku55`（#1393，`agents/subagents/haiku55.md` 经 `pnpm agents:sync` 装到 `~/.claude/agents/`）。

## 决定

1. **`pnpm agents:sync` 把 16 个 `fleet-*` 和 `haiku55` 一起装到 `~/.claude/agents/`。** `SUBAGENT_TARGET.files` 改成仓内路径，按文件名装；开会话钩子照样跑它。
2. **`fleet-*` 的原件只在 `.claude/agents/`，不另放副本。** 理由：
   - 引擎（`packages/adapters/src/claude-code/subagents.ts` 把它们经 `--agents` 传给会话）、`packages/agent-eval`、`agents/test/skills.test.ts` 都读这里，挪走要改三处，留着最省。
   - 两处各放一份会漂移，一份就没得漂。
   - 在 fleet-dao 里项目级和用户级同名、内容相同，项目级优先，行为不变。
3. **`haiku55` 原件仍在 `agents/subagents/`。** 放进 `.claude/agents/` 会被引擎一起经 `--agents` 传出去。
4. **测试钉住**：`project-subagents.rules.test.ts` 按文本核 `SUBAGENT_TARGET.files` 恰好是这 17 份、`agents/subagents/` 下没有 `fleet-*` 副本、参考页写着同步也装到用户级；各配故意造出的失败（漏一份、多一份、改名、去掉 `files`、删掉那句）。

## 影响

- 别的仓、别的目录里能按名字派 `fleet-*`。定义正文按 fleet-dao 的规矩写，在别的仓派时交代里补上那个仓的规矩。
- 带 `isolation: worktree` 的那几个要在 git 检出里才派得出去。
- 从 `SUBAGENT_TARGET` 去掉的，清单里记着才撤（先备份），机器上手写的定义不碰。
- **法国 VPS 待创始人拍。** 法国的自动发布从完整检出跑 `agents-sync --apply --user`，合进主线后法国会话用户家目录也会有这 16 份（现在只有 `haiku55.md`）。那里所有仓的会话、包括走非 Claude 中转路由的，都会看到 Claude 档子代理；不让派的规矩只写在 fleet-dao 任务工作树里，有烧额度的风险。创始人定了装或不装，再改这一条（不装就给法国那一路加跳过）。
