# 0034 子代理按性价比选模型：Haiku 5.5、Sonnet 5.5、Opus 5.5 三档加升级规则；无人值守的监控以脚本为主（部分取代 0017 第 2 条）

- 日期：2026-10-09 00:09（北京时间）
- 谁拍的：创始人授权、指挥官拍板（原话在下面：「你设计一下……并且全程你拍板」）。方案让别家挑过错（deepseek 4 条异议，已吸收，见「挑错之后改了什么」）。
- 现状：部分被 0035 取代（`0035-haiku55-by-checkable-output.md`）：第 1 条 Haiku 那一档的判据改成「产出能被脚本或一条命令核对」；第 3 条「Haiku 一次没证据就升」改成「脚本核对不过就升」；第 4 条派 Haiku 写 `model: "haiku"` 改成 `subagent_type: "haiku55"`（别名 `haiku` 在本机指向 Haiku 4.5）。其余各条照旧。
- 状态：采纳。通用段那句、指挥官技能、巡查脚本、同步工具的文案、钉住规矩的测试同一个 PR 改（改标准；创始人在对话里已授权，就是下面这段原话），#1372
- 关联：`agents/shared-rules.md`「我的机器与模型」「无人值守」、`agents/skills/commander/SKILL.md`「派活」、`agents/skills/commander/references/子代理选模型.md`、`agents/skills/commander/scripts/patrol.mjs`、`agents/config/claude-permissions.json`、`packages/agents-sync/src/permissions.ts`、`agents/test/rules/subagent-model.rules.test.ts`、`agents/test/rules/fable-scope.rules.test.ts`
- 取代：决定 0017 第 2 条里的「子代理只用 Opus 或 Sonnet」（来自创始人 2026-10-04 的口头规矩「Subagent 永远只用 Opus 或者 Sonnet，永远不用 Fiber」）和 2026-10-05「派活我推荐 sonnet5.5>opus5.5」的一刀切用法；同一条里的「子代理永不用 Fable」保留不动。0024、0030 里「起 Sonnet 子代理（`model: "sonnet"`）」改成按本决定选档

## 原话

```
2026-10-09 00:09（北京时间）

全仓库的subagent整体调整，不死板而是改成最具有性价比的调整方案，你设计一下，然后全仓库的agent目录的subagent及文档和test都改调整，并且全程你拍板
```

这是对他 10-04 口头规矩（「Subagent 永远只用 Opus 或者 Sonnet」）的部分取代。依据就是上面这段明确授权：他要的是「不死板、最具性价比」，并把方案的拍板交给指挥官。「永远不用 Fable」那半句他没有松口，照旧。

## 背景

- 原规矩一刀切：子代理只用 Sonnet 或 Opus，优先 Sonnet。
- 2026-10-07 发布了 Claude Haiku 5.5（`claude-haiku-5-5`），官方定位是子代理、检索、摘要、分类用的小模型：每百万 token 输入 $0.10、输出 $0.50（提示超过 100K 整单 5 倍），约为 Sonnet 5.5 的二十分之一；编码基准 Terminal-Bench 39%，Sonnet 5.5 是 71%，复杂多步编码官方不推荐。
- 我们大量子代理的活是读多写少、结果好抽查的（检索、压缩日志、只读巡查、评审初筛），用 Sonnet 是浪费；但一刀切换成「能用 Haiku 就用」，小模型的错答会不声不响地流进指挥官的结论。
- 无人值守时指挥官每轮亲自读一大屏法国巡查输出，费上下文；而采集、比对、判阈值本来就是脚本能做的事。

## 决定

1. **按「错了的代价 × 能不能抽查」分三档，不按活的名字**：
   - Haiku 5.5：错了没代价或一眼看得出、产出带可抽查证据的（读码检索、压缩测试和 CI 输出、只读巡查摘证据、评审初筛）。
   - Sonnet 5.5：要写进仓里、会合进主线的（写代码、改文档、开 PR、调研、写给引擎的单子、给 CI 红灯归因）。默认档。
   - Opus 5.5：改标准、架构方案、评审下结论、两次失败后的疑难。
   - 讨论、挑错照旧走别家模型（`discuss`）。
   表是默认值，不是死规矩：越档要在交代里写一句为什么。档位表放 `agents/skills/commander/references/子代理选模型.md`。
2. **能用脚本判的不用模型**（`judge-or-code`）。
3. **升级，不在同档重试**：Haiku 一次产出里没有可抽查的证据、或说拿不准，就升到 Sonnet；Sonnet、Opus 同档连着失败两次升一档；到 Opus 还不行回到指挥官。
4. **交代必写**：模型、做什么、范围（只读还是可写哪些路径）、产出格式和长度上限、停下条件、前台等待规矩。Agent 工具的 `model` 只收别名（`haiku`、`sonnet`、`opus`），所以交代里要子代理**汇报首行写自己的模型 id**，对不上 `claude-haiku-5-5`、`claude-sonnet-5-5`、`claude-opus-5-5` 里要的那个就当这次没做、升一档重派；能写完整 id 的地方（工人的 `--model-id`、设置里的默认）一律写完整 id、不写别名。Haiku 的交代另加：输入控制在 100K token 以内、每条结论附证据、拿不准就说拿不准。
5. **Haiku 的结论动手前抽查**：指挥官据它动手之前，自己用一条命令核一遍；对不上就作废、升 Sonnet 重做。
6. **默认值不变**：设置里的子代理默认模型（`CLAUDE_CODE_SUBAGENT_MODEL`）仍是 `claude-sonnet-5-5`，**默认值只许 Opus 或 Sonnet**。Haiku 只在派活时逐个显式选，不当忘了写模型时的兜底——兜底落到 Haiku，写代码的活就悄悄跑在小模型上了。同步工具照旧拒收 Haiku 当默认值，报错文案改指本决定。
7. **子代理、工人永不用 Fable**（0017 第 2 条的这一半保留）。本机工人（`worker.mjs`）是写代码的整段活，只许 Opus、Sonnet，默认改成完整 id `claude-sonnet-5-5`。
8. **并发上限仍是 4**，Haiku 也占名额；无人值守时给监控留 1 个，干活的最多 3 个。
9. **无人值守的监控以脚本为主**：
   - 主体是 `agents/skills/commander/scripts/patrol.mjs`：一次 ssh 只读收齐法国盘面，每项一行带计数和采集时间；基线只由脚本写（`_tmp/patrol-baseline.json`），比出 `DELTA`；不变量（服务不 active、磁盘超 85%、可用内存少于 1G、单卡住或停下超过 30 分钟、定时任务最近一次不 ok、新开的通知、引擎总开关关着、在用版本读不到）由脚本判，最后一行 `VERDICT: OK`、`VERDICT: ALERT <条数>` 或 `VERDICT: BROKEN`。
   - 沉默告警：ssh 连不上、输出是空的、少了哪一块、库查询报错、采集时间和本机差超过 15 分钟，一律 `BROKEN`，不当 `OK`。
   - 模型只在 `ALERT` 且 `DELTA` 不为 0 时才叫：派一个短命的 Haiku 5.5 子代理，输入只有那几行 `DELTA`、`ALERT` 和相关日志片段，只准回证据行和哪几项变了，不归因、不下修复结论；归因和修由指挥官或派 Sonnet 做。`OK` 的周期不叫任何模型。
   - 指挥官亲自巡一次的触发：连续 3 个周期没读到 `VERDICT`；出现 `BROKEN`；据 Haiku 的摘要要动手修之前。
   - 无人值守跨天时每天至少跑一次 `patrol.mjs --selftest`（固定的假输出验 `ALERT`、`BROKEN` 的判法还灵），不是 `SELFTEST: OK` 就当监控失效。
   - 不起一个无限循环盯盘的子代理：上下文会涨、会被截断、会话一断就没了。

## 挑错之后改了什么

设计稿先让别家挑错（GPT 断线、Grok 没核成，deepseek 回了 4 条异议），全收：

- 「监控每个周期派模型」和原则 2「能脚本判的不用模型」自相矛盾 → 监控的主体改成脚本，模型只在有异常、有变化时被叫。
- Haiku 漏报没有兜底 → 脚本侧的不变量和沉默告警直接判，另加每天一次已知坏样本的自检。
- 基线不能由模型写，一次错答会被固化成「正常」→ 基线只由脚本写，`BROKEN` 的那次不写。
- 「归纳 CI 红灯原因」越界：压缩日志和给原因是两回事 → Haiku 只回证据行，归因交 Sonnet。
- Haiku 的失败信号本身不可靠，同一个错重试两次是浪费 → Haiku 一次没证据就升。
- 监控占并发名额、忙时被饿死 → 无人值守时给监控留 1 个名额。
- 「部分取代」不能含糊 → 上面「取代」一行和「原话」一节写明取代的是 10-04 哪句口头规矩、依据是 10-09 哪句授权。

## 影响面（同一个 PR）

| 件 | 改成什么 |
|---|---|
| `agents/shared-rules.md`「我的机器与模型」 | 「子代理、工人永不用 Fable；子代理按性价比分 Haiku 5.5、Sonnet 5.5、Opus 5.5 三档，核对实际 id，不符、没证据或连败就升一档」，通用段仍在 2000 字以内 |
| `agents/shared-rules.md`「无人值守」 | 去掉写死的 `model: "sonnet"`（档位看上一条），同一行顺手并掉和后半句重复的「有进展记进度、汇报」；「一件事过了 20 分钟还没有能推的东西，就当场拆小」原样保留 |
| `agents/skills/commander/SKILL.md` | 「子代理的模型」改成三档并指向参考页；新增「无人值守的监控」；并发上限加「给监控留 1 个」；工具清单加 `patrol.mjs` |
| `agents/skills/commander/references/子代理选模型.md`（新） | 原则、档位表、升级规则、交代必写、Haiku 抽查、无人值守的监控 |
| `agents/skills/commander/scripts/patrol.mjs`、`patrol-lib.mjs`（新） | 只读巡查：不变量、基线、`DELTA`、沉默告警、`--selftest`；复用 `france-lib.mjs` 的 ssh 名字读法和 ssh 参数 |
| `agents/skills/commander/scripts/worker-lib.mjs` | Claude 工人默认改成 `claude-sonnet-5-5`；拒 Haiku 的话指向本决定 |
| `agents/hooks/unattended.mjs` | 提示语：写代码的子代理 `model: "sonnet"`、留 1 个名额给监控、盯法国跑 `patrol.mjs` |
| `agents/config/claude-permissions.json`、`packages/agents-sync/src/permissions.ts`、`cli.ts` | 默认值仍是 Sonnet 5.5、仍只许 Opus 或 Sonnet；说明和拒收文案改指本决定 |
| `docs/agents-permissions.md` | 「子代理默认模型」一节改指本决定 |
| `docs/decisions/0017` 文件头、`0024`、`0030`、`README.md` | 0017 标第 2 条「只用 Opus 或 Sonnet」部分被本决定取代；0024、0030 的「Sonnet 子代理」改指本决定 |
| `AGENTS.md` 本仓段 | 派活那句加「模型按性价比分三档（决定 0034）」 |
| 测试 | `agents/test/rules/subagent-model.rules.test.ts`、`fable-scope.rules.test.ts` 钉新说法（删掉「永不用 Fable」会红，默认值改成 Haiku 会红）；新增 `agents/test/patrol.test.ts`（空输出必须判 `BROKEN`）；`worker.test.ts`、`checkjs-scripts.test.ts`、`packages/agents-sync/test/permissions.test.ts` 同步 |

## 没做的

- 没给 Haiku 建一个固定完整 id 的自定义子代理定义（`~/.claude/agents/` 里写 `model: claude-haiku-5-5`）：要动同步工具的目标清单，另开单再说。现在靠「汇报首行写模型 id、对不上就升档」兜住别名指错版本。
- 引擎按路由派的会话不在本决定里：它们走驾驶舱的用途与顺序；Fable 在引擎侧只许创始人本人配（决定 0033）。
