# 0087 子代理只分三个角色：斥候 Explore（Haiku）、工人 general-purpose（Sonnet）、设计 Plan（Opus），每台机器同一份（取代 0036、0079，部分取代 0034、0035、0077）

- 索引状态：生效
- 被取代：0102（第 1、2 条：工人做窄改动编码时可降到 Haiku）
- 日期：2026-10-12（北京时间）
- 谁拍的：创始人。三个角色、能删的删、每台机器沿用（选 A）；事实源、页面不改、同根全改（20:26 的三条回复）。原话在下面。
- 状态：采纳（改标准；创始人在对话里已选定，原话和时间见下）。三份定义、同步工具的目标清单、引擎读定义的目录、钉住它们的测试、通用段、指挥官技能和参考页同一个 PR 改（单 #1958）。
- 关联：`agents/subagents/`（`Explore.md`、`general-purpose.md`、`Plan.md`，唯一的原件）、`packages/agents-sync/src/targets.ts`（`SUBAGENT_TARGET`）、`packages/adapters/src/claude-code/subagents.ts`（`SUBAGENTS_DIR`，转成 `--agents`）、`packages/engine/src/runner/segment-prompt.ts`（`SUBAGENT_HINT`）、`agents/test/rules/project-subagents.rules.test.ts`、`agents/test/rules/subagent-model.rules.test.ts`、`agents/skills/commander/references/子代理选模型.md`、`agents/shared-rules.md`「我的机器与模型」
- 取代：0036 全部（本仓 16 个 `fleet-*` 写进 `.claude/agents/`、派活默认用它们）和 0079 全部（16 个通用版加 `haiku55` 装到每台机器）；0035 里「真 5.5 走 `subagent_type: "haiku55"`」那条派法（改成派 `Explore`）；0034 第 4 条派 Sonnet、Opus 写 `model` 别名的做法（改成写类型、不传 `model`，升档才传）；0077 只调了 `fleet-review-screen` 的 effort，这个子代理没了，整条作废。0034 的「默认值只许 Opus 或 Sonnet」「子代理、工人永不用 Fable」「并发 4」「监控以脚本为主」和 0035 的「按产出能不能被核对选档」「先 Haiku、核对不过再升」「交代写全硬规矩」「结论动手前抽查」照旧。

## 原话

```
2026-10-12（北京时间，选 A 那一段）

Sonnet 是工人、Haiku 是斥候、Opus 是设计
你之前分了太多类了，不需要那么多类。你能删的删，然后把它内嵌到里面，因为 Mirasim 它自己有一套嘛
我希望在开 workflow 的情况下，能够更高效、更快速、更省地执行完任务。每一台机器都要沿用这种方式。所以 fleet-dao 要想个好办法
（选 A）
```

```
2026-10-12 20:26（北京时间）

1a（事实源以法国库为准、仓库只留种子、Mirasim 起会话校验）；2 同意（agents-sync 写到每台机器，这三份不在 Mirasim 智能体页面里改/开关）；3 需要都改（同根的几处全改）
```

```
更早（2026-10-12，交代里没给具体时刻）

一些很简单的东西都交给 Haiku
Haiku 5.5 能力很强，别参考 4.5
路由钉完整型号
```

## 定了什么

1. **只有三个角色，名字用 Claude Code 内置的**：
   - 斥候 `Explore`：`claude-haiku-5-5`，effort medium，只读（`disallowedTools: Edit, Write, NotebookEdit`）。读码检索、谁调谁、日志和测试输出归纳、查资料、验证、跑测试读结果；产出要能一行抽查。
   - 工人 `general-purpose`：`claude-sonnet-5-5`，effort medium，全部工具。写代码、改文件、修 bug、部署、开 PR；界面活也归它（照仓里的界面规范，用 `playwright-cli` 真点页面，PR 带截图；GPT 系照旧不做界面活）。
   - 设计 `Plan`：`claude-opus-5-5`，effort high，只读。计划、架构方案和取舍、方案合成、疑难根因、评审下结论；要落盘的方案由派它的人写。
   - 其余 16 个 `fleet-*` 和 `haiku55` 全删（含从没被派过的 `fleet-fixer`、`fleet-log-digest`、`fleet-review-screen`、`fleet-triage`）。任务细节写进派活的话里，不再另造类型。
2. **派法**：Agent 工具写 `subagent_type`（`"Explore"`、`"general-purpose"`、`"Plan"`），不传 `model`，用定义里的钉。难的活升档才传 `model`：斥候的活做不下来改派工人；工人同档连败两次，同一个 `general-purpose` 传 `model: "opus"`。Workflow 里 `agent()` 的 `agentType` 填这三个名字，不传 `model` 就用定义里的钉，升档才传。
3. **型号一律写完整 id**：Mirasim 网关模式下别名 `haiku`、`sonnet`、`opus` 可能解析成 4.5、4.6、4.7（`claude.exe` 2.1.296 的别名表）。汇报首行写自己的模型 id，对不上就停、升一档重派。
4. **原件只有一份**：`agents/subagents/` 下这三份。`agents-sync` 把它们装到每台机器的 `~/.claude/agents/`（本机，法国的 `fleet-agent-carpool`、`pilot` 两个用户）；引擎从发布目录的同一个目录转成 `--agents` 传给 claude-code 会话（它带 `--setting-sources project`，不读用户级）。仓里的 `.claude/agents/` 删了：同名项目级会压住用户级，留着就是两份漂移。
5. **这三份归仓里管**：机器上同名的（Mirasim 设置页「覆盖…」写的、手写的）内容不同，同步先整份备份再换成仓里的、报出来。要改只改仓里，不在 Mirasim 智能体页面里编辑或开关它们（页面「开关」是把文件改名成 `.md.disabled`，下一次同步会装回一份）。
6. **上一版装的 17 份怎么撤**：从 `SUBAGENT_TARGET` 里去掉了，清单 `~/.fleet-dao/agents-sync.json` 记着是同步装的才撤（先备份）。2026-10-12 读法国两个用户的清单，17 份都记着。
7. **环境变量**：`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`、`CLAUDE_CODE_EFFORT_LEVEL` 不得设置——前者压过定义里的 `model`，后者压过定义里的 `effort`，三个角色的钉就失效了；`claude-permissions.json` 的 `env` 里写了它们，钉住规矩的测试会红。`CLAUDE_CODE_SUBAGENT_MODEL`（Sonnet）留着：它排在定义之后，压不住这三份（本机实测，见下），只兜住没写类型的 `agent()` 和自定义又没写模型的子代理，不让它们跟着主会话落到 Fable。
8. **只有 Claude Code 读这些定义文件**：Codex、Cursor、Grok、Devin 不读，三个角色对它们靠通用段里的文字规矩。

## 本机实测（2026-10-12，Claude Code 2.1.296）

把 `agents/subagents/` 用引擎的读法（`loadSubagents` + `renderAgentsJson`）转成 `--agents` 的 JSON，在仓外的空目录里让主会话派一次、子代理只回自己的模型 id。每个角色测两条路：

| 角色 | 主会话 | 引擎那样（`--agents`、`--setting-sources project`、无 `CLAUDE_CODE_SUBAGENT_MODEL`） | Mirasim 环境原样（用户级有 `model: sonnet` 的同名文件、有 `CLAUDE_CODE_SUBAGENT_MODEL`）加 `--agents` | 只放同名文件、不带 `--agents` |
|---|---|---|---|---|
| `Explore` | Sonnet 5.5 | `claude-haiku-5-5` | `claude-haiku-5-5` | `claude-haiku-5-5` |
| `general-purpose` | Haiku 5.5 | `claude-sonnet-5-5` | —（没单测） | `claude-sonnet-5-5` |
| `Plan` | Haiku 5.5 | `claude-opus-5-5` | `claude-opus-5-5` | `claude-opus-5-5` |

升档传别名：`general-purpose` 传 `model: "opus"` 用到 `claude-opus-5-5[1m]`（Mirasim 注入了 `ANTHROPIC_DEFAULT_OPUS_MODEL`）；`Explore` 传 `model: "sonnet"` 用到 `claude-sonnet-5-5`。账单里的 `modelUsage` 和子代理自报的 id 一致。

## 没验证的

- 法国 Claude Code 是 2.1.282：程序里搜不到 `claude-haiku-5-5`、`claude-sonnet-5-5` 两个字符串（`claude-opus-5-5`、`claude-haiku-4-5` 在）。完整 id 能不能直接透传给接口、`effort` 字段认不认，没在法国跑模型调用验证。
- 法国非 Claude 路由（deepseek 这类）的会话：引擎在任务工作树的 `settings.local.json` 里按定义的名字挡掉全部子代理，所以三个角色在那种会话里一律派不出；用户级装了三份后，法国 Mirasim 直接起、不经引擎的会话派它们会调 Claude（0079 已告知的同类风险）。
