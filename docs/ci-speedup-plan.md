# CI 提速：做到上线（创始人 2026-10-03「按照这个方式，实现；可以多开subagent；专攻这个需求，直到上线」）

> 这张文件给下一个接手的 AI 看：现在做到哪、下一步是什么、哪些还没验证。规矩在仓根 `AGENTS.md`。

## 目标与验收

创始人原话（2026-10-03，傍晚，两条合一）：CI 太慢不能接受，要「越来越好」，专攻到上线。

验收标准（自己定的，可证伪）：
1. **只改代码的 PR**：开出到合并，墙钟 ≤ 60 秒（现在是 100 秒上下）。
2. **碰到 deploy/agents 的 PR**：≤ 90 秒（现在最多 236 秒）。
3. **同一 PR 重推**：命中缓存的那一轮 ≤ 40 秒。
4. **一个 PR 占的并发任务数** ≤ 8（现在约 14；GitHub 免费档并发上限 20）。
5. **主线那一轮**不再每次都全跑，但自动发布仍有依据（发布闸门不能断）。
6. 全程不新增收费服务（创始人钱闸）。

## 八条做法（创始人拍的 A–E 的展开）

| # | 做法 | 状态 |
|---|---|---|
| A | 推送前预检：按改动跑 CI 上那几样确定的检查（biome/tsc），红了当场修 | **已写、本机测过、已提交（本地 commit，未推）** |
| B | 合并 CI 小任务（biome/tsc/docs/hygiene 四台并成一个 `lint`） | **已写、已并入本分支（未推）**：一个 PR 约 14→11 个任务；各步 continue-on-error + 汇总步核对（保住 #566 的「biome 红不吃掉 tsc」）；汇总脚本被测试真跑。**没在真 GitHub 上跑过**：`lint` 里 working-directory / pnpm/action-setup / setup-node 缓存路径几处，第一次 PR 要盯它起不起得来；`lint` 约 90 秒贴着最慢测试台 87 秒，若成瓶颈把 docs 挪回独立 job |
| C | 主线只留最新一轮（连续合几个取消前面的） | **暂不做**：D 的区间口径下每轮主线已经只跑增量，取消前一轮的收益小；而取消会让自动发布闸门（认「这个提交自己那次绿」）断，要先改闸门认「被绿区间覆盖」才能开。区间口径跑出真实数字后再决定 |
| D | 主线跑「上次绿…现在」的累计改动 | **前半已写、本机测过、已提交（4f6f21e1，未推）**：`main-base.ts` 查基准、`ci-plan.ts --main-base`、ci.yml `changes` 加一步；基准读不到/区间为空 → 全跑 + ::warning::；每轮仍各自出结论，所以自动发布闸门不用动 |
| E | PR 的测试分片结果缓存 | **已写、已并入本分支（未推）**：`ci-cache.ts`，键盖源码闭包+夹具+环境身份，命中后逐文件哈希复核，清单坏/不 complete 一律真跑；只在 pull_request 上动、主线不碰。**真 CI 上要验三件**：同 PR 重推是否真显示「测试缓存命中」；key 步骤有没有被悄悄关成 enabled=false（runner 路径符号链接）；`actions/cache` restore/save 在 `contents: read` 下能否工作 |
| F | deploy 里 login-user 那 94 秒压到 30 秒以内 | **已写、已提交（f85aa1c3，未推）**：超时值可注入（login-user、cli-tools 两个样本都压到 2+1 秒）；真实秒数本机测不了（要 root），等 CI 的 ⏱ 行，分台名单到时再重排 |
| G | engine/db 继续分片、大文件继续拆 | 待做（在 E 之后看还差多少） |
| H | 每 job 约 25 秒固定开销（checkout + setup-node + pnpm install） | 待做（在 B 之后逐项量） |

## 关键事实（都查过，别再重查）

- 一个 PR 约开 **14 个 job**；免费档并发上限 **20**，所以同时只能容纳 1–2 个 PR（来源：GitHub 官方 limits 文档）。
- 顺利的代码 PR：db 一台 87 秒、engine 三台里最慢 75 秒、rest 三台 57–83 秒；每台固定开销约 25 秒。
- 慢的不是机器，是「红了 → 改 → 重推 → 再跑一遍」这个来回（A 和 E 就是冲它去的）。
- **主线的 CI 结论是自动发布的闸门**：`deploy/france/auto-release/lib.mjs` 的 `ciVerdict` 读 `head_sha === <标记提交>` 的那次 push run，`success` 才发；`cancelled` 判红。所以「主线只留最新」不能只加 `cancel-in-progress: true`，否则被取消的提交永远没有结论、版本标记正好指向它时整版发不出去。
- **正确的口径**：每次主线运行的区间是 `[上次真绿的头, 这次的头]`，被取消的轮次不算基准，改动被后一轮的区间吃掉；自动发布改判「这个提交被某个绿区间覆盖过」。方案细节（含 bisect 定位、fail loud 三条路径）见本文件末尾「D 的细节」。
- GitHub 的缓存**按 ref 分作用域**：PR 跑出来的缓存只有这个 PR 自己的重跑读得到。所以 E 只在 PR 的 test job 上做，**主线那条绝不做**（主线要发布背书，一个测试都不许跳）。

## 还没验证的

- A 只在**本机**跑过（`packages/conventions/test/prepare-push.test.ts` 7 条）。真实推送时钩子里的表现（`.githooks/pre-push` 调用顺序、退出码传导）没在真推里验过——本机现在连不上 GitHub，推不了。
- B、E、F 都在工人手里，结果没回来。
- C/D 一行没写。
- 全部做完之前，「PR ≤ 60 秒」这条验收没有一次真实 CI 数据支撑。

## D 的细节（方案，待实现）

1. `packages/conventions/src/bin/ci-plan.ts`：`event === 'push'` 时也走 diff——base 不取 `origin/<目标分支>`，而是**上一次主线绿的那次 ci.yml run 的 head_sha**（从 GitHub API 现读，不新存状态）。base 读不到 → 退回全跑 + 明确报警，不当绿。
2. `.github/workflows/ci.yml`：`changes` job 增加一步查这个 SHA；`concurrency.cancel-in-progress` 改成 `true`（push 也取消）。**注意 `packages/conventions/test/ci-plan.test.ts` 有两条钉子测试钉着这两处，必须一起改。**
3. `deploy/france/auto-release/lib.mjs` 的 `ciVerdict`：加第二个判据——自己那次是 `cancelled`/没有时，找一次 `success` 且区间覆盖这个提交的运行；覆盖者找不到 → 维持现状（不发、报警）。要在 CI 侧把 base 写到这个 tip 提交的 commit status 里（现有 merge-gate 已经在写 commit status，机制现成，需要 `statuses: write` 权限）。
4. 红了定位：先重跑一次同区间（偶发），还红再二分。主线 squash-only，一个提交就是一个 PR，`gh api .../commits/<sha>/pulls` 直接拿到 PR 号。
5. 仍然必须全量：所有 `PATH_RULES` 里 `full` 的那几条（根配置、锁文件、`.github/workflows/`、`packages/shared/`、夹具、`deploy/`、认不出的路径）——区间口径下要对**整段区间的每个文件**跑一遍。

## 上线的含义

这里的「上线」＝合进主线、真实 CI 跑出验收数字。不涉及对外发布（那要创始人按版本拍）。
