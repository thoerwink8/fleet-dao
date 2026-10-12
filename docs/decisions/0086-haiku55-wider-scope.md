# 0086 子代理给 Haiku 5.5 的活放宽：按 Haiku 5.5 的最新能力和我们的自测重新划线，窄改动编码三条缺一不可，带护栏和复查（部分取代 0035）

- 日期：2026-10-12（北京时间）
- 谁拍的：创始人 2026-10-12 在对话里选定方向，也选定了下面的自测结果（原话见下）；划线由指挥官按调研和自测写。改标准。
- 状态：采纳，PR 合并即生效；2026-11-12 复查。
- 关联：#1960（需求单，也是放宽后的失败记录单）；`agents/shared-rules.md`「我的机器与模型」；`agents/skills/commander/SKILL.md`「派活」；`agents/skills/commander/references/子代理选模型.md`「档位表」「本仓的子代理名单」「Haiku 5.5 的划线（决定 0086）」「交代必写」；Haiku 档子代理定义 `agents/subagents/` 下的 `fleet-scout`、`fleet-log-digest`、`fleet-triage`、`fleet-fixer`、`haiku55`（`.claude/agents/` 的同名专属版一起改，`project-subagents.rules.test.ts` 要两份 frontmatter 一致）；钉它的测试 `agents/test/rules/haiku-scope.rules.test.ts`、`agents/test/rules/subagent-model.rules.test.ts`；字数账 `agents/rules-budget.json`。
- 取代：决定 0035 第 2 条的边界清单（加结构化抽取、测试输出分诊、窄改动编码，见下面「划线」）；0035 档位表里读码检索、日志归纳、只读巡查和 `fleet-scout`、`fleet-log-digest` 的 effort（low 或 low–medium 改成 medium）。0035 其余各条（`haiku55` 的派法、级联「核对不过就升、不在同档重试」、交代写全、先砍固定开销、引擎侧由创始人配）不变；0077（评审初筛用 high）不变。

## 原话

```
2026-10-12，创始人在对话里

我其实是想追求性价比和快，一些很简单的东西都交给 Haiku 吧。因为现在 Haiku 5.5 的能力很强，你最好去查一下它的最新能力，而不是去参考原来的 Haiku 4.5
```

```
2026-10-12，创始人在对话里（稍后补的一句）

可以对haiku5.5做测试呀，看一看它的效果怎么样，你也可以做一个判断
```

## 划线

1. **放心给 Haiku**（effort medium 及以上，回报必带证据）：读码检索、归纳日志、分类和准入检查、评审初筛（high）、结构化抽取（已测到 40 条，再多的先拆批）、写任务书草稿、测试输出分诊。
2. **窄改动编码**：三条同时满足才给 Haiku（派 `fleet-fixer`），缺一条就给 Sonnet：
   - 有机器核对（点名的测试、类型检查或 lint 过了才算数）；
   - effort 不低于 medium；
   - 范围写死（点名文件和函数）。
3. **仍升 Sonnet**：长链多文件编码；没有机器核对的活；归因下结论；必须一条不漏又没有脚本逐条核的长规矩清单；low 档的活（要 low 的就不派 Haiku）。
4. **没放的**：文档和讨论的摘要、简单的浏览器和电脑使用类。官方定位里有这两样，但自测没测；要放先测。

## 护栏

- Haiku 回报每条结论带证据（`文件:行` 或命令原始输出行），派活的主会话动手前抽查。自测里 Haiku 漏过一项（下面 read-2 第 1 次），这一步不省。
- Haiku 的 effort 一律 medium 及以上，Agent 工具的 `effort` 也不传 low。
- Haiku 一次派活里连败 2 次（同一个错连着两轮核对不过）、或没跑核对就说完成，当次升 Sonnet，并在 #1960 留一条失败记录：日期、子代理、活、怎么失败的、升到谁。派出去回来核对不过的，照 0035 第 3 条直接升，不换个 Haiku 重派：小模型的失败信号不可靠，同一个错重试一次多半还是错。
- 派 Haiku 的交代另写三句防提前收工：把要求的都做完；只有没有输入走不下去、或要做有风险的动作才停下问；做完并跑过核对再汇报。

## 依据

图例：【官方】Anthropic 自己的页面；【官方转述】没打开官方原页，只在第三方文章里看到；【媒体】新闻报道；【社区】第三方评测、GitHub；【我们自己测的】本仓实测。取数日期都是 2026-10-12。

### 我们自己测的（2026-10-12 自测）

- 怎么测：14 道本仓真题，五类（读码检索 3、CI 日志归纳 3、分类和准入检查 3、窄改动编码 3、结构化抽取 2：15 条、40 条），都出自本仓历史，判分全用脚本，不用模型判。Haiku 5.5 medium 每题 2 次（28 次），Sonnet 5.5 medium 每题 1 次（14 次）。每次派活都核了回报首行的模型 id（28 次 `claude-haiku-5-5`、14 次 `claude-sonnet-5-5`）。
- 结果：Haiku 27/28 过，Sonnet 14/14 过。Haiku 唯一没过的是读码 read-2 第 1 次，三项里漏了一项（冷却常量），第 2 次补上了；没有编造的 `文件:行`。
  - 读码检索：Haiku 5/6，Sonnet 3/3。
  - CI 日志归纳（只回证据行、不归因；三份日志 52KB、64KB、119KB，最后一份有两处互不相干的失败）：Haiku 6/6，证据行都能在日志里原样找到，归因句 0 条；Sonnet 3/3。
  - 分类和准入检查（含删断言、疑似密钥，最大 20 格）：Haiku 6/6，格格全对，假阳性 0；Sonnet 3/3。
  - 结构化抽取（15 条、40 条，每条 3 个字段，含替代关系的陷阱）：Haiku 4/4，全对、不缺条；Sonnet 2/2。
  - 窄改动编码（3 道，测试先写好）：Haiku 6/6 测试绿、没动测试文件；Sonnet 3/3。
- 局限（解读时要带上）：
  - 题偏容易，分不出两个模型的差别。
  - 编码只有 3 道且偏小（单函数、测试现成）。
  - 没测长链多文件编码。
  - 没测 low 档（官方说 low 加长提示会提前收工，所以 low 仍不给 Haiku）。
  - 没测 40 条以上的抽取。
  - 每题只有 1~2 次样本，只看大趋势，算不出置信区间。
- 复现：题、标准答案和判分脚本在本机 `D:\frank\fleet-dao\_tmp\haiku-eval\`（不进仓：题里有标准答案）。运行计划是那里的 `run-plan.md`。只读的四类重判：`node _tmp/haiku-eval/grade-all.mjs`（2026-10-12 重判，读码、CI、准入、抽取 33 次结果和上面一致）。编码题判分看工作树，每次运行前后用 `node _tmp/haiku-eval/_lib/reset-code.mjs <题>` 还原，要重测才能重判。判分脚本自己的自检是 `node _tmp/haiku-eval/selfcheck.mjs`。
- 更早的：决定 0035 的实测（2026-10-09，样本更小）；#1641 能力探查（2026-10-10，`specs/1641-子代理分档/能力探查.md`），三档几乎全过，探查自己写「这批题分不出档」；评审初筛 medium 10 遍过 8、high 6/6（决定 0077）。

### 官方和别家的

- 【官方】发布页 https://www.anthropic.com/claude-haiku-5-5 （2026-10-07 发布，2026-10-12 读到原页并核对了下面的数）：
  - 定位：「high-volume, cost-sensitive tasks」，摘要、compaction、数据库查询、分类；「pairs well with Opus 5.5 and Sonnet 5.5 as a subagent on coding work」；也适合实时客服和浏览器使用。「Sonnet 5.5 and Opus 5.5 remain better choices for complex agentic coding tasks like those measured by Terminal-Bench 4.0」，Haiku 5.5「best suited to more narrowly scoped tasks」。
  - 首个能调 effort 的 Haiku（「first Haiku-class model to come with an adjustable effort setting」）。
  - 价格（每百万 token，提示 100K 以内 / 超过 100K）：输入 $0.10 / $0.50，输出 $0.50 / $2.50；Sonnet 5.5 输入 $2、输出 $10。
  - 基准（Haiku 5.5 对 Sonnet 5.5）：OSWorld 2.1 离线子集 72.4% 对 83.9%；FrontierCode 1.1 Main 46.4% 对 52.1%；Terminal-Bench 4.0 39.2% 对 70.6%。
- 【官方，调研经 context7 取到，我没再核】Opus 5.5 输入 $4、输出 $20：官方 Haiku 4.5 概览页的对比表（https://platform.claude.com/docs/en/models/haiku-4-5/overview ）。
- 【官方，只见搜索摘要】默认 effort 是 medium，档位 low、medium、high、xhigh、max：官方 Haiku 5.5 概览页打不开（HTTP 400）；发布页的图表标着 Low、Med、High、Xhigh、Max。
- 【官方】Claude Code 更新日志 https://code.claude.com/docs/en/changelog ：2.1.292 给 Agent 工具加了 `effort` 参数；2.1.293 起 Anthropic API 上的默认 Haiku 是 5.5。本机是 2.1.292，别名 `haiku` 仍指 4.5，所以照旧用 `haiku55`。
- 【媒体】VentureBeat https://venturebeat.com/technology/anthropic-launches-claude-haiku-5-5-with-90-api-price-reduction-matching-gpt-6-luna ：Terminal-Bench 39.2% 是 max effort 的成绩，medium 约 20%。官方页上没写是哪一档。
- 【官方转述】aihubmix 整理的官方提示指南 https://aihubmix.com/blog/claude-haiku-5-5-effort-levels-medium-is-the-default-low-is-often-enough （官方原页打不开）：长编码提示下 low 有时没做完就把活交还用户，升到 medium 提前收工约减半；low、medium 下编码有时没跑任何核对就说改完；子代理活、窄改动编码从 medium 起。
- 【社区】melodic-software/claude-code-plugins#6955 https://github.com/melodic-software/claude-code-plugins/issues/6955 ：检索角色，同为 low effort，Haiku 5.5 116/132 对、Sonnet 124/132，高成本错误 16 对 5，没过它自己定的线。一人一次，没交脚本，不可复现。我们在 medium 下测 40 条抽取全对，和它不矛盾：档位不同、题也不同。
- 【社区】SpyrosPsarras/epaflix#1739 https://github.com/SpyrosPsarras/epaflix/issues/1739 ：子代理起手的固定提示 163K、超过 100K，Haiku 5.5 一直压缩上下文、不往前走。100K 线和精简配置要守。

为什么这样划：官方定位写了分类、编码子代理；自测里读码、日志、准入、抽取到 40 条、窄改动编码都过了，和 Sonnet 只差读码漏的那一项。所以这几类放，靠抽查兜住漏项。窄改动编码官方也承认 low、medium 会不核对就说改完，所以要机器核对兜底、范围写死。长链编码 Terminal-Bench 只有 Sonnet 的一半多，自测也没测；low 档官方明说会提前收工，自测也没测。这两类不放。

## 怎么算放宽过头、复查

- 复查日 2026-11-12：指挥官读 #1960 的失败记录，算 Haiku 活的返工率和被升档次数，写进本文件「复查」一节，问创始人延还是调。
- 怎么算放宽过头（命中哪条，那一类退回 Sonnet）：
  - 放宽后新给 Haiku 的几类（抽取、分诊、窄改动编码）里，返工的（核对不过、没跑核对就说完成、抽查对不上）超过两成；
  - 同一类被升 Sonnet 3 次以上；
  - 有一次 Haiku 的错结论没被抽查拦住、流进了合并的 PR。
- 都没命中，复查时跟创始人说可以再放哪一类（先测再放）。
- Claude Code 升到 2.1.293 以后，别名 `haiku` 指 5.5：到时重测，再定 `haiku55` 子代理的去留。

## 影响面（同一个 PR）

| 件 | 改成什么 |
|---|---|
| `agents/shared-rules.md`「我的机器与模型」 | 子代理那句补「Haiku 的 effort 至少 medium，没跑核对就报完也算不过」，+38 字，记进 `agents/rules-budget.json` |
| `agents/skills/commander/SKILL.md`「派活」 | 子代理的模型那条加三类；新增「Haiku 5.5 的划线」一条：放心给的、窄改动编码三条、仍升 Sonnet、护栏、复查日 |
| `agents/skills/commander/references/子代理选模型.md` | 档位表加结构化抽取、窄改动编码，Haiku 各行 effort 都到 medium 以上；名单表 `fleet-scout`、`fleet-log-digest` 改 medium，四个 Haiku 档写清可接的活；新增「Haiku 5.5 的划线（决定 0086）」一节；交代必写加防提前收工三句 |
| `agents/subagents/` 的 `fleet-scout`、`fleet-log-digest`、`fleet-triage`、`fleet-fixer`（`.claude/agents/` 同名专属版一起改） | scout、log-digest 的 effort 改 medium；log-digest 加测试输出分诊；triage 加结构化抽取（40 条以内，再多先拆批）；fixer 改成窄改动编码、三条写进 description |
| `agents/subagents/haiku55.md` | 加 `effort: medium`，description 加抽取和分诊，正文加防提前收工 |
| 测试 | 新增 `agents/test/rules/haiku-scope.rules.test.ts`；`subagent-model.rules.test.ts` 档位表那一行的写法跟着改 |
| `docs/decisions/0035`、`README.md` | 0035 头部标「部分被 0086 取代」；索引加本条 |

## 没做的

- 没新增子代理：结构化抽取并进 `fleet-triage`，测试输出分诊并进 `fleet-log-digest`，名单不动。
- 法国引擎的动手会话也会派 `.claude/agents/` 里的 `fleet-scout`（引擎提示词点名），它的 effort 一起从 low 变成 medium。引擎按路由派的会话不在本决定里（同 0035 第 7 条）。

## 复查

（2026-11-12 填）
