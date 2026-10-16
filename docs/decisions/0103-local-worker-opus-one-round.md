# 0103 本机工人默认 Opus、照一轮做完来交代，不按难易降档（部分取代 0102、0087）

- 索引状态：生效
- 日期：2026-10-16
- 谁拍的：创始人 2026-10-16 19:09 在对话里选 A（原话见下）；落地细节由交互会话按决定 0097 自己拍、事后报。单 #2793。
- 状态：采纳。工人定义、通用段、指挥官技能「派活」、钉住它们的规则测试同一个 PR 改（改标准）。
- 取代：0102「划线」第 2 条（窄改动编码三条都满足时工人传 `model: "haiku"`）和「护栏」里只管 Haiku 工人的几条；0087 第 1 条里「工人 `general-purpose`：`claude-sonnet-5-5`，effort medium」和第 2 条「工人同档连败两次传 `model: "opus"` 升档」。0102 第 1 条（只读的活派斥候 `Explore`，Haiku 5.5）、2026-11-12 复查只读那几类，和 0087 其余各条（三个角色、型号写完整 id、定义只有一份）不变。
- 关联：0087、0094、0096、0102；#1960、#2761（`pnpm work run`）；`agents/subagents/general-purpose.md`、`agents/shared-rules.md`、`agents/skills/commander/SKILL.md`「派活」、`agents/test/rules/haiku-scope.rules.test.ts`、`agents/test/rules/project-subagents.rules.test.ts`。

## 原话

```
2026-10-16 19:09，创始人在对话里

我选a，本机我一般想要claude主力一轮解决
```

A 的意思：法国引擎是主力，本机只做急活和改标准的活，由指挥官手动派；本机的活用 Claude 最强档、照一轮做完来交代。

## 定了什么

1. 工人 `general-purpose` 的定义改成 `model: claude-opus-5-5`、`effort: high`，描述写「工人（Opus 5.5，可写）」。派的时候不传 `model`，不按难易降档到 Sonnet 或 Haiku。
2. 本机的活照一轮做完来交代：交代一次写全范围、验收、跑哪些测试、PR 规矩，让工人一轮做到合并，不拆成「先让小模型试、不行再升」。
3. `pnpm work run <单号>` 起的无头工人也走 `general-purpose`（`--agent general-purpose`，`packages/conventions/src/work-run.ts`），跟着变成 Opus。引擎起 Claude 会话时也从 `agents/subagents/` 转成 `--agents`，那些会话里派的 `general-purpose` 子代理同样是 Opus；用的是已有的订阅，不是新开销。
4. 斥候 `Explore` 照旧 Haiku 5.5（只读：检索、日志和 CI 归纳、按写明的规则分类和抽取，0102 第 1 条），设计 `Plan` 照旧 Opus。
5. 兜底的 `CLAUDE_CODE_SUBAGENT_MODEL`（没写类型、自定义又没写模型的子代理用）不动，仍是 Sonnet；三个角色的定义都钉了完整型号，它压不住（0087 第 7 条）。
6. 钉住：`agents/test/rules/haiku-scope.rules.test.ts` 改成钉工人定义是 `claude-opus-5-5`、effort high，斥候照旧 Haiku、effort 不低于 medium，并钉技能、通用段、工人定义里不再有「窄改动编码给工人传 `model: "haiku"`」「降到 Haiku」「工人默认 Sonnet」这些被收回的说法（决定 0089 第 4 条「只核对某句话在不在的测试删掉」的例外：被收回的旧句子留一句就会有人照它派）。`project-subagents.rules.test.ts` 的角色表跟着改成 Opus、high。

## 为什么

- 创始人原话：本机要 Claude 主力一轮解决。
- 2026-10-16 本机用 Opus 工人开的 20 多个 PR，几乎都是第一轮 CI 就绿、一次合并；法国同期一张单要跑 6–13 段会话（#2793 场景一节）。本机的活本来就少、也是最急、最敏感的那部分，一轮做成比省下的那点钱值。
- 0102 的自测（9 题 Haiku、Sonnet 同为满分）说明窄改动 Haiku 做得了，但本机墙钟 Haiku 慢一倍，省下的只有钱；本机的活按上面的分工就不再图这个钱。
