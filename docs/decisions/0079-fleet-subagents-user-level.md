# 0079 16 个 fleet-* 子代理的通用版随 agents:sync 装到每台机器的用户级，法国也装（部分取代 0036）

- 日期：2026-10-11（北京时间）
- 谁拍的：创始人。要每台有 fleet-dao 的机器都有最佳子代理；法国 VPS 装（已告知风险）；装的是通用版（原话在下面）。通用版怎么写、放哪、怎么钉由改标准的会话定。
- 现状：已被 0087 替代（`0087-three-subagent-roles.md`，创始人 2026-10-12「你能删的删」「每一台机器都要沿用这种方式」）：16 个 `fleet-*` 和 `haiku55` 从同步名单里撤掉，每台机器只装 `Explore`、`general-purpose`、`Plan` 三份；「每台有 fleet-dao 的机器、法国也装」这一半照旧。下面是当时的原文。
- 状态：采纳（改标准；创始人在对话里已选定，原话和时间见下）。同步工具的目标清单、16 份通用版、钉住它们的测试、参考页和技能说明同一个 PR 改（#1886，单 #1885）。
- 关联：`agents/subagents/`（16 份 `fleet-*.md` 通用版和 `haiku55.md`）、`.claude/agents/`（本仓专属版）、`packages/agents-sync/src/targets.ts`（`SUBAGENT_TARGET`）、`packages/agents-sync/src/sync.ts`（`readSubagents`）、`agents/test/rules/project-subagents.rules.test.ts`、`agents/skills/commander/references/子代理选模型.md`「本仓的子代理名单」、`agents/skills/commander/SKILL.md`「派活」、`docs/ops.md` 第五节
- 取代：部分取代 0036 第 2 条后半句（「`haiku55` 留给没有这批定义的仓和机器」：同步后每台机器都有这批定义的通用版）和第 7 条（#1393 只装 `haiku55`：现在一起装 17 份）。0036 别的条、0077 的 effort 不变；本仓仍默认用 `.claude/agents/` 的专属版。#1641 方案第六节（只在本仓生效）不改原文，以本决定为准。

## 原话

```
2026-10-11 20:44（北京时间）

子代理 PR #1886：改成通用版，VPS 照装
```

```
2026-10-11 18:38（北京时间，对话里答「法国 VPS 装不装用户级」，已告知烧额度风险）

1. 装
```

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

#1886 起初把 `.claude/agents/` 的原件原样装到用户级。原件里写满了 fleet-dao 专属的规矩（`pnpm pr:open`、`pnpm issue:new`、`fleet` 命令、codegraph、`_tmp/`、`docs/`、`specs/`、仓根 `AGENTS.md`、决定编号），别的仓的会话派到它们，会照着去跑别的仓没有的命令、往不存在的目录写。创始人 20:44 要求改成通用版。

## 决定

1. **两份：本仓专属版和通用版。**
   - 专属版在 `.claude/agents/fleet-*.md`，原样不动：引擎（`packages/adapters/src/claude-code/subagents.ts` 经 `--agents` 传给会话）、`packages/agent-eval`、`agents/test/skills.test.ts` 照旧读它。在 fleet-dao 里项目级优先于用户级，本仓的会话用的仍是它。
   - 通用版在 `agents/subagents/fleet-*.md`，和 `haiku55.md` 同目录、同名。frontmatter 的 name、description、model 和专属版一致（description 里原有的仓专属词改成通用说法，两边一起改）；`tools` 去掉 `mcp__codegraph__*`，其余字段逐行一致。正文只留岗位职责、产出格式和做事的通用纪律（证据、范围、不编、停下回报的条件）；仓里的命令、路径、开 PR 的方法一律写成「照交代和这个仓的约定，交代没写就停下问」。
2. **`pnpm agents:sync` 只装 `agents/subagents/` 下的 17 份到 `~/.claude/agents/`。** `SUBAGENT_TARGET.files` 是文件名，原件都在 `agents/subagents/`；专属版不往家里装。名单里同一个文件名列了两遍、写成带目录的路径、源里缺一份，整段不动、报出来（少装一份会让清单把已装的当成撤了）。
3. **法国 VPS 也装。** 法国的自动发布从完整检出跑 `agents-sync --apply --user`，合进主线后法国会话用户家里的 `~/.claude/agents/` 会有这 17 份（之前只有 `haiku55.md`）。风险已告知创始人：那里所有仓的会话、包括走非 Claude 中转路由的，都会看到 Claude 档子代理；不让派的规矩只写在 fleet-dao 任务工作树里，有烧额度的风险。创始人 18:38 答「1. 装」，20:44 又说「VPS 照装」。
4. **测试钉住**（`agents/test/rules/project-subagents.rules.test.ts`）：
   - `.claude/agents/fleet-*.md` 每份都有同名通用版，name、description、model 逐份一致，`tools` 只少 `mcp__codegraph__*`，其余 frontmatter 逐行一致；通用版也过同一套定义检查。
   - 通用版全文不含仓专属词（词表 `REPO_ONLY` 只写在测试里一处：pnpm、本仓脚本名、`fleet` 命令、codegraph、`_tmp`、`docs/`、`specs/`、`AGENTS.md`、`.claude/`、决定编号、`agents/` 和 `packages/` 下的路径、check-brief、standard-paths、shared-rules、lint-design、指挥官、驾驶舱、fleet-dao），`tools` 不含 `mcp__codegraph__`。
   - `SUBAGENT_TARGET.files` 恰好是 `agents/subagents/` 下这 17 份；参考页写着同步装的是通用版。
   - 每条都配故意造出的失败（缺一份、description 或 model 改了、别的字段改了、tools 多去少去、逐个写进每个仓专属词、tools 带回 codegraph、名单多一份少一份、参考页删掉那句）。

## 影响

- 别的仓、别的目录里能按名字派 `fleet-*`，拿到的是通用版：交代里要写清那个仓的规矩（怎么开 PR、跑哪些测试、临时文件放哪），没写它会停下问。
- 改专属版的 frontmatter（模型、工具、effort、回合数），同名通用版要一起改，测试逐份核；只改专属版正文里本仓的规矩，通用版不用动。
- 带 `isolation: worktree` 的那几个要在 git 检出里才派得出去。
- 从 `SUBAGENT_TARGET` 去掉的，清单里记着才撤（先备份），机器上手写的定义不碰。#1886 早先那版（原样装专属版）没合进主线，同步只跟主线走，没有机器经同步装过它；万一有手装的同名文件，同步按内容不同先备份再换成通用版。
