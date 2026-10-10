# 0077 评审初筛 fleet-review-screen 的 effort 从 medium 调到 high，别的子代理档和 effort 不变（补充 0036）

- 日期：2026-10-10（北京时间）
- 谁拍的：创始人要求探查每个子代理的能力并按最佳实践定场景（原话在下面）；按探查数据调哪一处由指挥官定。
- 状态：采纳。定义和参考页同一个 PR 改（改标准；创始人在对话里已选定）。
- 关联：`.claude/agents/fleet-review-screen.md`、`agents/skills/commander/references/子代理选模型.md`「档位表」和「本仓的子代理名单」、`specs/1641-子代理分档/能力探查.md`（指挥官另开 PR 写）、单 #1641
- 取代：无。0034 的三档判据、0035 的级联、0036 的 16 个子代理名单和模型都不变。

## 原话

```
2026-10-10 10:33（北京时间）

本机实现的subagent，我希望.agent规划n种各个opus sonnet haiku 5.5作为subagent的场景，按照网上的最佳实践走，探查每个的能力；然后vps和本机也要实装上 这些我提到的你梳理一下，在这个会话内，本机全做完
```

## 背景

#1641 要给 16 个子代理探查能力，按数据定档。指挥官 2026-10-10 在本机用 `packages/agent-eval` 照各定义的 effort 实测，结论写进能力探查那份文档。方案第四节第 4 条：换档之前先试 effort。

## 决定

1. 16 个子代理的档（模型）都不变。
2. 只改 `fleet-review-screen` 的 effort：medium 改成 high。定义的 frontmatter 和参考页两张表同步改。

## 依据

- Haiku 5.5 在 medium 下，「越范围」那道题（review-screen/scope-creep）5 遍过 3（误报超过上限 1 个）；另一道 5 遍全过。合计 10 遍过 8。
- 同样两道题在 high 下 6 遍全过。
- 成本：high 每遍输出 token 均 2505，medium 均 1807～2860；用时差不多（20 秒对 15～21 秒）。仍是 Haiku 的价，不用升到 Sonnet 档。

## 影响

- 本仓派 `fleet-review-screen` 的会话从下一次起按 high 跑；重开会话才载入新定义。
- 其余 15 个子代理不动。往后再调档或 effort，照样按探查数据、先试 effort 再换档，记新决定。
