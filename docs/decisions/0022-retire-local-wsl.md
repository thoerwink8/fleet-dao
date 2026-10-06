# 0022 撤掉本机 WSL 演练台（创始人 2026-10-06 北京时间 10:21 拍）

- 日期：2026-10-06（北京时间；创始人回话 10:21）
- 谁拍的：创始人。起因是本机内存吃紧，查出 WSL 虚拟机常驻占 2.9G 内存和一个 reclaude 设备位；法国的「发版先暂停、等收尾、部署、恢复」脚本（release-train，#1095）已合进主线，不再需要先在本机演练。
- 状态：已采纳
- 关联：#1107（撤本机档机制）；0018 第 2、3 条（设备清单、「WSL 只是临时测试环境」）；#450/#451（当初建本机环境）；#452（演练 2026-10-05 02:47 已通，任务完成）。

## 原话

```
话说内存吃紧是不是因为wsl搞的；如果要占用那么大空间，我认为不需要了；如果法国vps可以实现暂停功能，部署后再继续，是不是相当于只有法国vps也可以了？再加上本机帅位；如果可以的话，我需要你先把本机wsl机制清理
```

## 决定

1. **撤掉本机 WSL 演练台（fleet-local）**：往后只剩「法国 VPS 跑引擎 + 本机当指挥官」两台，新版本不再先在本机全流程走通，改用法国的 release-train（发版先暂停、等收尾、部署、恢复）。
2. **仓里删「本机档」整套机制**：`deploy/local/`、`FLEET_PROFILE` 与档位文件、自动发布里本机档「跟主线」那一路、期望文件逐项互比（`diff-local`）、对应测试。会话代理（`FLEET_SESSION_PROXY`）这个通用机制留着，只读法国那份期望。
3. **留着的通用机制**：`agents/hooks/pretool.mjs` 的 wsl 命令剥层、驾驶舱多环境切换器与 `node_reports`（#820，通用）、法国 `FLEET_NODE_KEYS` 这一项本身。
4. **「VPS 和 WSL 上的会话永不用 Fable」改成「VPS 上的会话永不用 Fable」**（`agents/shared-rules.md`、`docs/goals.md`、`docs/design.md`）：WSL 已不存在。这是改标准，创始人在上面这句里选定了。
5. 机器侧（指挥官已做）：`wsl --export` 备份到 `D:\wsl\backup\fleet-local-20261006.tar`，`wsl --unregister fleet-local`，删 `%UserProfile%\.wslconfig`。

## 落地

| 决定 | 落地 | 状态 |
|---|---|---|
| 1、5 机器侧注销 | 备份 `D:\wsl\backup\fleet-local-20261006.tar`；注销 WSL；删 `.wslconfig` | 已做 |
| 2 仓里删本机档 | #1107；要重建看这个提交之前的 git 历史 | 办中 |
| 3 法国看板「本机」那行 | 会一直失联；下次在法国发版后用 SQL 删（语句见 `docs/ops.md` 第十三节） | 待办 |
| 4 Fable 范围的说法 | `agents/shared-rules.md` 等，`agents/test/rules/fable-scope.rules.test.ts` 跟着改 | 办中 |
