# 0033 Fable 进目录，只有创始人本人能把它配进用途或打开（取代 0017 第 1、3 条）

- 日期：2026-10-08 22:30（北京时间）
- 谁拍的：创始人（原话在下面）
- 状态：已采纳。通用段那句、钉住它的测试、代码里的禁令同一个 PR 改（改标准；创始人在对话里已选定，就是下面这段原话）
- 关联：母单 #1354「模型目录拆三层」第三片 #1358；`agents/shared-rules.md`「我的机器与模型」、`agents/test/rules/fable-scope.rules.test.ts`、`packages/shared/src/bans.ts`、`packages/api/src/founder-only.ts`
- 取代：决定 0017 的第 1 条（机器派的会话永不用 Fable）和第 3 条（VPS 上的会话永不用 Fable）；第 2、4 条照旧

## 原话

```
2026-10-08 22:30（北京时间，回指挥官的问题「Fable 进不进目录？推荐进，但锁死不可派……你点头才改」）

2.进，然后我自己选择要不要在哪个环节配置
```

这是母单 #1354 三条拍板（1.a 2.进 3.全改，并且 ui 要调整得更合适）里的第 2 条。

## 起因

- 以前 Fable 是写死的硬禁令（`packages/shared/src/bans.ts` 的 `no-fable`），目录装载器见到 Fable 就整批拒收，所以渠道里明明有的 Fable 永远进不了目录，目录补不全。
- 母单 #1354 要把目录拆三层：渠道里有的自动入目录、派什么由创始人在页面配、禁令挪到派活那一步。Fable 是否属于「禁令」要先定：他的回答是进目录，配不配、配在哪个环节，由他自己选。

## 决定

1. **Fable 进目录。** 目录装载不再因 Fable 拒收；Fable 的模型和路由能入库，默认关着，不在任何用途里。
2. **只有创始人本人能开。** 把 Fable 的路由或模型打开、或把它加进 / 拖动于任何用途，只认驾驶舱里创始人本人的浏览器登录态。引擎、临时指挥官（groom）、`fleet-api` 命令、机器通行证（包括飞书网关通行证）调接口一律拒绝，并在回应里写明是谁、为什么。判法只有一份：`packages/shared/src/bans.ts` 的 `founderOnlyFor`（认 Fable）和 `founderOnlyDenial`（认谁在动手）；开关、拖动、加进用途的接口都先过 `packages/api/src/founder-only.ts` 的 `guardFounderOnly`，后续新接口（#1356 的加 / 移模型）也要调它。关掉 Fable 谁都能关（往安全的方向改）。
3. **骨架也不能替他开。** 机器写库的路径（`routing.default.json` 装载）里，Fable 的路由写成开着、或把 Fable 配进用途，一行不写、明确报错；骨架里列着关着的 Fable 路由、且不在任何用途里，可以。
4. **选路照开关和用途走。** Fable 路由只有创始人打开过、并在用途里才可选；引擎照常按用途派，选路里不再有「Fable × 一切」这条硬禁令。任务指定路由时，指定到关着的 Fable 路由照旧「用不了」。
5. **机器派的会话和 VPS 上的会话可以用 Fable**，前提是创始人本人在驾驶舱把它配进了用途；AI 不替他配。取代 0017 第 1、3 条。
6. **不变的：** 0017 第 2 条（子代理永不用 Fable，只用 Sonnet 或 Opus，优先 Sonnet）；第 4 条（Fable 在创始人本机的主对话里由他自己选）。本机指挥官起的工人（`worker.mjs`）不经路由和用途，照旧只许 Opus、Sonnet，不在本条范围。GPT × 界面照旧是硬禁令。

## 落地（同一个 PR）

| 件 | 改成什么 |
|---|---|
| `packages/shared/src/bans.ts` | 去掉 `no-fable`；加 `isFable`、`founderOnlyFor`、`founderOnlyDenial` |
| `packages/api/src/founder-only.ts`、`routing-order.ts` | 开关（打开）、拖动接口动手前过门；`RoutingOrderPort` 加 `subjectsOf` 取模型和路由的被判名字 |
| `packages/db/src/routing-apply.ts` | 骨架把 Fable 配进用途或写成开着：拒 |
| `agents/shared-rules.md` 第 39 行、`agents/test/rules/fable-scope.rules.test.ts` | 改成新范围；测试钉住新说法，退回 0017 旧说法查得出来 |
| `docs/design.md`、`docs/goals.md`、`docs/reference/engine.md` | 「不用 Fable」同步成新说法 |
| 0017 文件头 | 标「部分被 0033 取代」 |

## 看过、没动的

`docs/decisions/0002-fusion.md`、`0003-fusion-flow.md`、`0022-retire-local-wsl.md` 是历史记录，不改。`agents/skills/commander/scripts/worker-lib.mjs` 的工人只许 Opus、Sonnet，属于上面第 6 条，不动。`packages/web/src/build/scan.ts` 里的字符串是扫描词表，不是规矩。
