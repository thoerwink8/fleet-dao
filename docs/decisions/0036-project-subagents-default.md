# 0036 本仓的子代理写进仓里 .claude/agents/，派活默认用它们（补充 0034、0035）

- 日期：2026-10-09（北京时间）
- 谁拍的：创始人。原话在下面；睡前「全程你拍板，无人值守，按照最佳方式处理」，名单和每个定义的细节由指挥官定。
- 状态：采纳。技能说明、参考页、钉住名单的测试、标准路径清单同一个 PR 改（改标准；创始人在对话里已授权）。
- 关联：`.claude/agents/fleet-*.md`、`agents/skills/commander/SKILL.md`「派活」、`agents/skills/commander/references/子代理选模型.md`「本仓的子代理名单」、`agents/test/rules/project-subagents.rules.test.ts`、`packages/conventions/standard-paths.json`
- 取代：无。0034 的三档判据、0035 的 Haiku 5.5 派法和级联不变；本决定只把它们落成仓里的定义，并规定本仓默认用这批定义。

## 原话

```
2026-10-09 21:29～21:44（北京时间）

都按照你推荐，不要小修，要改彻底；先查50多张单，mirasim现在有额度了；我需要你尽可能排查现有open的单子，然后安排怎么改；haiku5.5已经支持了；我希望你把opus sonnet hailku 所有场景调研，什么情况下用什么；然后帮我创建N个subagent设计一下

subagent 全写到项目里，以后默认用新写的 subagent；然后看看有什么需要调整的，全程你无人值守；今天的目标就是全解决，并且监督 vps 引擎流程

我要睡觉了，全程你拍板，无人值守，按照最佳方式处理
```

## 决定

1. **16 个子代理写进仓里 `.claude/agents/fleet-*.md`**：Haiku 5.5 六个（`fleet-scout`、`fleet-log-digest`、`fleet-triage`、`fleet-review-screen`、`fleet-fixer`、`fleet-brief-drafter`）、Sonnet 5.5 六个（`fleet-builder`、`fleet-ui-builder`、`fleet-ci-triager`、`fleet-ui-verifier`、`fleet-researcher`、`fleet-groomer`）、Opus 5.5 四个（`fleet-standard-editor`、`fleet-architect`、`fleet-debugger`、`fleet-reviewer`）。什么活派谁、拿什么核对，见参考页「本仓的子代理名单」。
2. **本仓派活默认选 `fleet-*`**，`subagent_type` 写名字、不传 `model`。`general-purpose`、`Explore`、`Plan`、`haiku55` 只在没有合适的 `fleet-*` 时才用；`haiku55` 留给没有这批定义的仓和机器。
3. **定义里写死四样**：完整模型 id（Claude Code 的同族别名会被主会话的模型顶替，`haiku` 在本机还指向 4.5）；`tools` 白名单（不写就继承全部工具，包括不该给的）；带 `Edit` 的一律 `isolation: worktree`；汇报首行写自己的模型 id（派完核对实际 id 靠它）。Haiku 档另限 `maxTurns`，纯读的加 `omitClaudeMd`，砍固定开销（决定 0035 第 5 条）。
4. **只有 `fleet-standard-editor` 动标准路径。** 其余带写权限的定义里都写了「碰 `agents/**` 就停下回报」。
5. **`.claude/agents/` 进标准路径清单。** 理由：这里的模型和权限写错了，每个在本仓干活的会话都会照着派错（Haiku 去写要下结论的活、写权限的代理没进工作树）；加减子代理要同意。
6. **第一批要重开会话才载入**（Claude Code 对「新建的 `agents` 目录」的限制）；会话里没出现 `fleet-*` 就是没载入，别拿别名顶，照参考页档位表选 `model` 派。
7. **#1393（把 `haiku55` 定义纳入 `agents:sync`）不受影响，仍有用**：别的仓和别的机器没有这批定义时靠它。
