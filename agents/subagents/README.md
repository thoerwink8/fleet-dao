# 子代理规范

本机派子代理（Agent 工具、workflow 的 `agent()`）怎么选角色、选档、写 `model`、怎么收货，只看这一份；别处（通用段、指挥官技能、docs）只指到这里，不再各写一遍。来历在决定 0087（三个角色）和 0102（划线和护栏）。

只有三个角色，名字就是 Claude Code 内置的 `Explore`、`general-purpose`、`Plan`，定义就是本目录下同名的三份（同名压住内置的，原件只有这一份，随同步装到每台机器、引擎也从这里转成 `--agents`）。不用 `fork`（它总跟主会话同一个模型，主会话可能在 Fable 上）；子代理和工人不用 Fable。

## 三个角色

| 角色 | 型号（定义里钉的完整 id） | effort | 档 | 做什么 |
|---|---|---|---|---|
| `Explore` 斥候 | `claude-haiku-5-5` | medium | Haiku | 只读：读码检索、谁调谁、日志和 CI 输出归纳、按写明的规则分类、结构化抽取、查资料、跑测试读结果 |
| `general-purpose` 工人 | `claude-sonnet-5-5` | medium | Sonnet | 可写：写代码、改文件、修 bug、开 PR；界面活也归它 |
| `Plan` 设计 | `claude-opus-5-5` | high | Opus | 只读：计划、架构方案和取舍、疑难根因、评审下结论 |

不传 `model` 就用定义里钉的档。

## 各档做什么

- **放心给 Haiku（派 `Explore`）**：读码检索和谁调谁，日志和 CI 输出归纳，按写明的规则分类和准入，结构化抽取；产出一条命令能抽查。
- **改代码降到 Haiku**：给 `general-purpose` 传 `model: "haiku"`，下面三条缺一不可，少一条就照常给 Sonnet：
  1. 窄：改动在一个模块里、落在交代点名的几个文件上，不跨包，不动别的模块要用的接口。
  2. 机器核对：派之前就定好判对错的测试或命令（有失败测试要转绿、或交代里给全的用例），写进交代，要它贴原始输出。
  3. 规矩写全：用到的每条规则、边界和例子都写进交代，不靠它猜。
- **仍给 Sonnet（工人默认）**：
  1. 跨包、跨模块的改动；
  2. 没有机器核对的、规格要它自己定的；
  3. 要反复试、跨几处日志才定位得了的排障；
  4. 界面活，和改规矩、改标准。
- **只有真难的才传 Opus**：写码的活工人同档（Sonnet）连败两次，同一个 `general-purpose` 传 `model: "opus"`；只读的难题（方案、疑难根因、评审）直接派 `Plan`，不用传。斥候做不下来的活改派工人，不给斥候传 `model` 升档。

## 派工时 model 怎么写

- 定义文件（本目录三份）的 `model` 写完整 id（`claude-haiku-5-5` 这样），不写别名。
- 派工时默认不传 `model`；要降档或升档才传，Agent 工具只收小写别名，所以写 `"haiku"`、`"sonnet"`、`"opus"`，只此一种写法；`inherit`、`fork` 不用。别名和角色不要混着升档（不写「斥候传 `"sonnet"`」「工人传 `"opus"`」这类按角色换档的写法）：升档就是上面「只有真难的才传 Opus」那一条，降档就是上面三条。
- 别名落到哪个型号：本机（reclaude 起的会话）实测 `haiku` 起来的是 `claude-haiku-5-5`，`sonnet` 是 `claude-sonnet-5-5`，`opus` 按同一张表落到 `claude-opus-5-5`（这一个没单测）；经 Mirasim 网关起的会话里别名可能落到旧型号（`packages/agents-sync/src/targets.ts` 的 `SUBAGENT_TARGET` 注释）。所以不信别名，信汇报：交代里要子代理汇报首行写自己的完整模型 id，对不上的当没做，换 Sonnet 重派。
- 环境变量 `CLAUDE_CODE_SUBAGENT_MODEL` 只兜没写类型的子代理（见 `docs/agents-permissions.md`「子代理默认模型」），压不住这三份定义，不当派工的写法用。

## 护栏

1. 一次没过就换 Sonnet：Haiku 核对不过、没跑核对就说完成，直接升 Sonnet，不在 Haiku 上重试，并在 #1960 留一条评论：日期、角色、活、怎么失败的、升到谁。
2. 返工率超过 20%（样本不少于 5 次）或一次错进了 PR，就收回放宽：窄改动编码改回全给 Sonnet，只读的照旧给斥候。返工率 = 核对不过、没跑核对就说完成、被升档的次数 ÷ 派给 Haiku 的窄改动次数；Haiku 改动合并后才发现弄坏别处也算错进。
3. 2026-11-12 复查：按 #1960 的评论算上面两条，没触发就保持，触发了就收回。

配套的做法：Haiku 档 effort 不低于 medium（定义里钉 medium，派活不传更低的）；汇报首行写完整模型 id；收货前自己重跑一遍核对命令，不只看它贴的输出。

## 三份定义各是哪一档

- `Explore.md`：Haiku，`claude-haiku-5-5`，effort medium，只读。
- `general-purpose.md`：Sonnet，`claude-sonnet-5-5`，effort medium，可写；窄改动时派工传 `"haiku"` 降档。
- `Plan.md`：Opus，`claude-opus-5-5`，effort high，只读。

加减角色、改型号是改标准；`agents/test/rules/subagent-readme.rules.test.ts` 钉着本文和三份定义对得上、护栏三条齐全、别处没有第二份。
