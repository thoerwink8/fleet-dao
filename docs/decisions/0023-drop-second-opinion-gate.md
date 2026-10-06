# 0023 去掉「先审后合」这道合并闸：所有 PR 只看 CI（创始人 2026-10-06 14:25 拍）

- 日期：2026-10-06（北京时间；创始人回话 14:25）
- 谁拍的：创始人。AI 摆了三个选项（A 只留删数据一类、B 全去掉、C 不动），他选 B。
- 状态：已采纳、已落地（#1114）
- 现状（2026-10-06 回写）：生效。
- 关联：#1114（本次落地）、#1113（起因）；`docs/design.md` 第五节「所有 PR 只看 CI」「合并闸」
- 替代：0016（第二意见有终点：ci.yml 结构比对、CI 判法先合后审）整套；0002 第 4 条、design 第五节原来的「先审后合只剩两种」。0010 的引擎 PR 冷验收（cold-verify）**不动**。

## 原话

对「先审后合还要不要保留（A 只留删数据一类 / B 全去掉 / C 不动）」的回答（2026-10-06 14:25）：

```
B：全去掉，连删数据也只靠 CI，风险是迁移误删表。
```

更早（2026-10-06 14:00 前后）他问过：

```
我记得很早的时候就要去掉第二意见这个环节？法国vps流程应该也没有第二流程了把？
```

## 决定

1. **整层去掉「先审后合 / 第二意见合并闸 / 合并后补审」**：合并闸 `merge-gate` 判红只剩引擎任务 PR（分支 `fleet/<单号>-t<8 位>`）当前头上没有通过的 `cold-verify`；草稿、冲突 GitHub 自己拦；CI 各项由主线规则集要求必过。任何路径的 PR（迁移、`ci.yml`、鉴权、卫生检查、法国防火墙、sudoers、香港 nginx）都不再要第二意见状态。
2. **删，不改成空壳、不留开关**：`packages/conventions/high-risk-paths.json`、`workflow-structure.ts`（`ci.yml` 结构比对，只为这道闸而生）、合并闸里读改动文件和比对的那几个口子、`pr:open` 的第二意见提醒、`second-opinion.mjs` 的 PR 审查那一半（`so-pr.mjs`、`so-after-merge.mjs` 等）、开会话钩子里「合并后待补审」的提醒、`agents/test/rules/second-opinion-verdict.rules.test.ts`、引擎里碰先审后合路径就停下等第二意见的一步，全部删掉。
3. **留着的**：引擎 PR 的冷验收 `cold-verify` 和它在合并闸里的那一条（0010，不是第二意见）；`discuss` 技能里「重大方案拍板前让别家挑错」那一半（`ask.mjs` 等讨论用的）；改标准这套（`packages/conventions/standard-paths.json`，人闸第四类，和先审后合是两回事）；引擎里会话式的 `review` 阶段（UI 里叫「第二意见」，不是合并闸）。

## 依据

- #1113 只改了法国期望配置里一个巡检仓名字，却被合并闸挡住等第二意见；一次审查要几分钟到几十分钟，还会因为会话结束被杀掉重来。
- 这道闸挡下来的真问题少、耗时多（`docs/ci-speedup-plan.md` 里量过一轮 30–510 秒）；CI 的整套测试和部署测试大多拦得住，上线后发布脚本健康检查不过会自动退回上一版（也能 `release.sh --rollback`）。

## 风险（写明白）

- **迁移误删表只靠 CI 兜**：迁移里的 DROP、DELETE、UPDATE、ALTER COLUMN、RENAME 不再有人（或别家模型）审一眼；CI 的测试跑的是测试库，拦不住「迁移本身合法、但删了生产上还在用的表」。回退靠数据库备份，不靠审查。
- 碰密钥鉴权、CI 工作流、卫生检查本身的改动同样不再先审；这类改坏了，CI 自己可能也被改坏（原来 `ci.yml` 有结构比对挡着）。仍然守着的：CI 检查一律取主线上那份代码来跑，PR 改不了自己的检查（`pull_request_target`）；改标准路径要创始人同意。

## 怎么回头

git 历史里决定 0016 那套：`second-opinion.mjs`、`so-*.mjs`、`high-risk-paths.json`、`workflow-structure.ts`、合并闸里改到先审后合路径要 `second-opinion` 状态那一条。恢复要走改标准的 PR（动了 `agents/` 和合并闸），先问创始人。

## 落地

| 决定 | 落地 | 状态 |
|---|---|---|
| 1 合并闸只剩 cold-verify | #1114：`merge-gate.ts`、`merge-gates.ts`、`bin/merge-gate.ts`、`merge-gate.yml`（不再装 YAML 依赖）；`merge-gate-inputs.test.ts` 钉「读写口子只剩 pr、statuses、openPrs、writeStatus」；`merge-gate.test.ts` 钉「改到迁移（含 DROP）、`ci.yml` 的 PR 不再要第二意见」 | 已落地 |
| 2 删清单、结构比对、审查脚本 | #1114：见上；`pr-open.ts` 去掉提醒；`session-start.mjs` 去掉补审提醒；引擎 `checkGuarded` 只剩改标准 | 已落地 |
| 3 留着的 | 没动 | — |
