# 0017 Fable 只在创始人本机主对话里由他自己选（机器派的会话、子代理、VPS 和 WSL 永不用）

- 日期：2026-10-04 约 08:50（北京时间）
- 谁拍的：创始人（原话在下面）
- 状态：已采纳。通用段那句、钉住它的测试、指挥官技能说明里派子代理那条随同一个 PR 改（改标准；创始人在对话里已选定，就是下面这段原话）
- 关联：`AGENTS.md` 通用段「我的机器与模型」、`agents/test/rules/fable-scope.rules.test.ts`、`agents/skills/commander/SKILL.md`「派活」、`packages/shared/src/bans.ts`（引擎选路的硬禁令）、#669
- 替代：#669（2026-10-03）那句「Fable 不用（创始人 2026-10-03 拍，永久，不挂版本号）」的**适用范围**——原来字面上管一切会话，现在只管机器派的会话、子代理、VPS 和 WSL；「永久、不挂版本号」照旧。#669 没有单独的决定记录，旧说法在通用段（本 PR 改掉）和 `docs/PROGRESS.md` 引导一节那条（本 PR 补标「已被 0017 收窄」）

## 原话

```
2026-10-04 约 08:50（语音输入，「fiber」就是 Fable；逐条回晨报「要我拍的」时的第 8 条）

我是这么想的，我觉得第 8 点是指机器派单永远不用。因为我们的本机帅位如果都是 AI 自动去派单，用 fiber 太昂贵了。这个主会话开 fiber 是我自定义的，所以是经过我同意的。所以我的意思是：1. Subagent 永远只用 Opus 或者 Sonnet，永远不用 Fiber。2. Fiber 只有在主对话有，还是本机 GPU 算力的时候才用。3. 如果是在 VPS 或者 WSL 的环境下，也永远不用 Fiber。且还有个历史背景：当时 Fable 5.1 现在的水平可能没有 Opus 5.5 强，但是现在 Claude 灰测了 Fable 5.5，可能已经路由到了 Fable 5.1 上，所以我想试一下。
```

被收窄的那句（2026-10-03，#669）：创始人「目前阶段我不希望用 fable」，并同意把撤回理由改成永久。

## 起因

- #669 那句字面上管一切会话，连创始人自己开的主对话也算在内。
- 10-04 凌晨指挥官的主会话跑在 Fable 上，是创始人自己选的。照字面这算违规：`docs/PROGRESS.md`「流程漏洞」表记了一行，主会话改成只派工、不自己写代码，子代理一律 opus，并问他要不要重启换 Opus。
- 他 08:50 回了上面那段：「永久不用」本意是机器派单（AI 自动派单用 Fable 太贵）；主对话开 Fable 是他自己定的、经过他同意。想试 Fable 的原因：Claude 在灰测 Fable 5.5（可能路由到了 5.1 上），而 5.1 可能不如 Opus 5.5。

## 决定

1. **机器派的会话永不用 Fable**：引擎派的（法国引擎按路由派的写码、审查这些）、本机指挥官起的工人（`worker.mjs`）、按路由起的其他会话（路由探活、「讨论」阶段各家、判断题这类）。引擎选路的硬禁令（`packages/shared/src/bans.ts` 的 `no-fable`）照留，行为不变。
2. **子代理永不用 Fable，只用 Opus 或 Sonnet**（workflow 里起的也算）。派的时候写明模型（`model: "opus"` 或 `"sonnet"`）：不写就跟主会话同一个模型，而主会话可能是 Fable。用 `fork` 起的子代理总跟主会话同一个模型、写了 `model` 也不管用，所以主会话在 Fable 上时别用 `fork`。
3. **VPS 和 WSL 上的会话永不用 Fable**，主对话也不行。
4. **Fable 只在创始人本机的主对话里、由他自己选**。AI 不替他选；他选了，主会话照常干活，不算违规，不用再问要不要重启。
5. 「永久、不挂版本号」照旧：1–3 不随 Fable 出到几版而变。

## 落地（同一个 PR）

| 件 | 改成什么 |
|---|---|
| 通用段「我的机器与模型」 | 「机器派的会话（引擎、工人、路由）、子代理、VPS 和 WSL 上的会话永不用 Fable，子代理只用 Opus 或 Sonnet；Fable 只在我本机的主对话里由我自己选（创始人 2026-10-03 拍永久，2026-10-04 收窄）」，在通用段字数预算（4400 字）以内 |
| 钉住它的测试 | 新加 `agents/test/rules/fable-scope.rules.test.ts`：通用段这句的几样（「永不用」只认同一小句里写在前面的）、指挥官技能里派子代理只用 Opus 或 Sonnet 并写明模型；【故意造出的失败】退回 #669 那句、拿掉路由 / 子代理 / VPS 和 WSL / 只用 Opus 或 Sonnet / 由我自己选里的任一样、「永不用」改成「少用」、指挥官技能不写模型，都查得出来 |
| 指挥官技能「派活」 | 加一条：派 Claude 子代理只用 Opus 或 Sonnet，写明 `model: "opus"`（或 `"sonnet"`）；主会话在 Fable 上时别用 `fork` |
| `packages/shared/src/bans.ts` | 行为不变，注释改成指向本决定（选路派的都是机器派的会话，所以照禁） |
| `docs/design.md` 第三节第 8 条、`docs/goals.md` 两处 | 「不用 Fable」改成新范围 |
| `docs/PROGRESS.md` | 「主会话跑在 Fable 上」那行标已被 10-04 收窄解决；引导一节 10-03 那条补标被收窄、10-04 凌晨那条「子代理一律 opus 5.5（会话指令）」补一句「只用 Opus 或 Sonnet」这一半已进标准、10-04 这条标已处理 |

## 看过、没改的（不冲突）

讲选路、派工、讨论阶段的「不用 Fable」「Fable × 一切」：`docs/design.md` 第三节第 9 条（派工模型）、第九节的禁令表和「讨论」阶段配置、`docs/reference/engine.md` 的换路由校验、`packages/shared/src/domain.ts`、`packages/db/src/seed.ts`、`packages/db/routing.default.json`、`packages/web/src/build/demo-renames.ts`（禁令理由原话的演示版改写）。它们管的都是引擎按路由派的会话，属于上面第 1 条，照旧。`docs/decisions/0002-fusion.md`、`0003-fusion-flow.md` 是历史记录，不改。

## 后续

- 2026-10-04（#785）：第 2 条钉进设置——各机器 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_SUBAGENT_MODEL` 设成 `claude-opus-5-5`，由同步工具从 `agents/config/claude-permissions.json` 写过去，源文件不是 Opus 或 Sonnet 就拒收，`agents/test/rules/subagent-model.rules.test.ts` 钉住。它只兜住调用和子代理定义都没写模型的（`general-purpose` 这类），Plan、`fork` 照旧跟主会话、`claude-code-guide` 定义里是 Haiku，所以第 2 条「派的时候写明模型」照旧；详见 `docs/agents-permissions.md`「子代理默认模型」。
