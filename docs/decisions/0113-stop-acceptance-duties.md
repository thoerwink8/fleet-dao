# 0113 停写合并后的「验收责任」账，diff 外验收条挡在派单前（部分取代 0093 的 2026-10-18 修订）

- 索引状态：生效
- 日期：2026-10-22（北京时间）
- 谁拍的：创始人 2026-10-22 授权当晚全程自主拍板、做减法优先（原话见下）；指挥官据自身诊断（#3582）拍，本机落地（#3591）。改了决定 0093 的修订段，按改标准走，PR 带创始人原话。
- 状态：采纳，分片落地：第一片（#3591，停写、诊断型验收条挡在派单前）；第二片（#3630，旧行一次性交回原单，删结清、拍板卡、管理入口和 CLI、关单闸，见文末「补充：第二片」）。
- 取代：0093「修订（2026-10-18，#3037）」里的持久验收责任账（转人时写 `acceptance_duties`、引擎收尾和合并收口以这份账为准）。0093 第 5 条本身不变。
- 关联：#3582（诊断报告 `specs/3582-自身诊断/诊断.md`）、#3591、#3037。

## 原话

```
能做减法，能提升性能就去提升性能
```

```
全程你自己拍板
```

## 为什么（诊断报告第二节 A 类、第四节 A，数据取到 2026-10-22 23:30）

- 近 14 天 773 张缺陷单里，头号根因是我们自己加的证据、回执、验收责任记账护栏（A 类）：第二周新开 110 张，第一周 4 张，涨了 6 倍多；代表单 #3579、#3241、#3207、#3114 都在修这层自己的边界，和用户看得到的结果无关。
- 近 7 天打扰创始人的 9 张拍板卡里 8 张是「要你拍：#N 的验收责任」，违反 `docs/goals.md` 第五节第 2 条（只为掏新钱、删了找不回停下问人）。
- 这层代码按文件名粗筛约 2.8 万行（测试约 1.6 万）；`acceptance_duties` 10-18 起写，166 行，35 行没结清。
- 来由是 0093 的 10-18 修订，由 AI 拍、不是创始人原话；创始人 10-13 的引导是「我们现在太冗余了……你全都修复掉」。

## 决定

1. **引擎不再往 `acceptance_duties` 写新行。** 冷验收活动不记库，只留言转人；工作流收尾、合并前调的 `acceptanceDuties` 活动只读旧行，入参里的 record 不落库（老历史、在途重试还会带）。工作流步序没变，在途任务照老步序重放（重放夹具 `task-acceptance-duty-merged`）。
2. **不拿「已合」冒充「已验」，但不另起库里的「待验」状态。** 冷验收判出的「不归我验」只记在这条工作流里：合并前 PR「需求」改 `Refs`（分片）、原验收项进「还欠什么」，收尾不关单，单子开着等本机或指挥官贴证据再关。
3. **diff 外验收条在派单前挡下。** `off-diff-acceptance.ts` 认出「诊断型」验收条：「核实原场景卡在哪」「明确原用例实际等待的是哪一步」「定位某次超时的真实阶段」「在完整 CI 的 N 秒超时」——证据在那一次 CI 运行里，写了「diff 与测试输出能核实」也照拦。拿 #3414、#3450、#3413 的原文校过，近 428 张有「怎么算做完」的单里只多命中这三张和 #3591 自己（它在引述判据）。
4. **旧行不动、只读。** 已有的 35 行没结清的照旧能被读到（引擎收尾、本机租约、关单门、公开读口、park-triage），读到空就是没有待验的，读不成照旧报没查成。park-triage 不会再因新的验收责任出拍板卡（没有新行流进去）；旧行的结清、拍板卡、管理入口和 CLI 下一片收掉。

## 守住的业务规则（`docs/goals.md` 第五节 12 条逐条对过）

- 第 1 条：PR + CI 绿 + 合并闸、合并前冷验收照旧。
- 第 2 条：不再因新的验收责任找创始人。
- 第 10 条：不拿空或 ok 顶——漏网的 diff 外条照旧留单，旧行读不成照旧报没查成。
- 其余 9 条不受影响。栅栏检查（谁写、谁读这张表）没找到 12 条以外的业务规则。

## 怎么验

- 合并后 7 天：decision 卡里验收责任类为 0；A 类每周新开从 110 降到 ≤ 10；冷验收拒绝占比不升。
- `acceptance_duties` 合并后不再有 `created_at` 晚于本 PR 合并时刻的行（`select count(*) from acceptance_duties where created_at > '<合并时刻>'` 应为 0；管理 CLI 的 `management_merge` 除外）。

## 回退

表、旧行、迁移都没动。回滚本 PR 即恢复写入：活动重新落库，冷验收重新记库，工作流不用改（步序本来就没变）。

## 取舍（失去的东西）

- 漏网的「不归我验」条不再有持久账：工作流结束后，它们只在单上的转人留言、PR 正文的「还欠什么」和单子开着这件事里。引擎重做同一张单时不会再从库里读回上一代转人的条——要靠派单前就挡下（第 3 条）和单子开着来兜。
- 诊断型判据按词判，会漏写法不同的诊断单；宁可漏、不往错里拦（和原判据同一取向）。

## 补充：第二片（#3630，2026-10-22）

第一片之后这张表已没有新行，但读它的链还在：park-triage 每 10 分钟为旧行出核验会话和「要你拍」卡，看门狗为它报带 PR 后缀的 `watchdog:commander:` 卡，关单闸（`issue:close`、`close-on-merge`、受管外部交付）因旧行开着拒关，私有 ops 还有 `acceptance status|settle|supersede|merge-plan|merge`。这一片把这些都删了，旧行一次性交回原单。（顺手删掉第一片落盘时误留在本文件末尾的几行工具调用残片，条文没改。）

做了什么：

1. **一次性交回**：`fleet-api acceptance-handback-once`（逻辑 `packages/engine/src/jobs/acceptance-handback-once.ts`，装配 `src/bin/acceptance-handback-once.ts`）。读出所有还开着的旧行（`acceptanceDutyState` 判 open，按仓 + 单分组），每条依次：在原单留言（哪个 PR、头、代次、哪条验收项；幂等键 `acceptance-handback:3630:<行 id>`）→ 贴「本机做」→ 把行的 `settled_at/settled_by/settled_evidence` 写成交回（`settled_by = 'handback:#3630'`）。只改状态，不删行；更新带 id + 代次 + 未结清条件，已交回的回 `already`、不重复写。前一步失败不做后一步，下次重跑从失败那步接着做；留言按键幂等，重跑不会重复留言。默认只读列出，`--apply` 才写；有失败退出 1，参数不对退出 2。
2. **park-triage** 不再读 `acceptance_duties`：没有验收候选、核验会话、结清/替代、拍板卡；`parseCommanderAnswer` 不再收 `acceptanceVerdicts`。
3. **看门狗** 只盯停下的任务；以前带 PR 后缀的验收卡下一轮自动撤。
4. **管理入口和 CLI**：删 `packages/api/src/acceptance-cli.ts`、db 的 `acceptance-candidates.ts`（验收候选索引）、`acceptance-merge.ts`（历史归并）、`docs/acceptance-candidates.md`。
5. **关单闸**：删 `packages/conventions/src/acceptance-gate.ts`；`issue:close`、`close-on-merge`、受管外部交付、`work run` 的交付判定都不再因验收责任挡。
6. **保留**：表、旧行、迁移（含维护 `acceptance_candidate_groups` 的触发器）；工作流的 `acceptanceDuties` 活动和 `openAcceptanceDuties`（只读，在途任务重放和本机租约要用）；公开只读读口。

法国怎么跑（留给发版或指挥官，本片不连生产库跑）：本 PR 发版上线后，在法国以 root 跑

```
bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api acceptance-handback-once
```

先看只读列出的条数和单号，再加 `--apply` 跑一次；退出码非 0 就看报错、修好再跑，可重复跑。跑完再跑一次不带 `--apply` 的，应报「没有还开着的验收责任」；原单上各有一条交回留言并贴了「本机做」。

怎么验：park-triage 和看门狗不再出验收类提醒和卡（`packages/engine/test/park-triage.test.ts`、`test/real/park-triage.test.ts`、`test/watchdog-commander.test.ts` 断言了）；关单不再被验收责任挡（conventions 的 `issue-close`、`close-on-merge`、`work-run`、`managed-feedback` 测试）；交回的幂等和失败续跑见 `packages/engine/test/acceptance-handback-once.test.ts`、`packages/db/test/acceptance-handback.test.ts`。

回退：回滚本 PR 即恢复上面那些读口、卡和闸；表没动，交回过的行按 `settled_by = 'handback:#3630'` 认得出，要恢复成开着就把这些行的 `settled_*` 三列一起置空。单上的留言和「本机做」标签不随回滚撤，要撤得手动。
