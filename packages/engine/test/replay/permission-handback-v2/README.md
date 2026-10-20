# 原权限停点的固定历史

这两份 `.history` 保留录制时 SDK `History.toJSON` 的原始 JSON 字节，禁止重录覆盖。专用扩展名使格式化器不会重写原始证据。`push-handback-replay.test.ts` 先核固定 SHA-256，再用 SDK 在内存中转换为 ProtoJSON 重放；转换不改夹具。

| 夹具 | 场景 | 原 run | 事件数 |
| --- | --- | --- | --- |
| `old-h0-permission-park.history` | 旧版 `27ce1e663289f0120758340e4fa44c2162730d39` 的 H0 首次权限停点，还没有候选或 handback Update | `01a156aa-8e72-7d0b-a56a-26a24659adb0` | 159 |
| `accepted-pending-round.history` | 同旧版起跑的另一 run，经候选在原停点接纳 H1，正在等待原 `recordRound`，尚未交给替换 worker | `01a156af-c39a-7be7-bbec-cb89d90a94bb` | 181 |

录制在隔离真 Temporal 服务上完成，数据是合成任务。第一场曾完整验证：最终预检失败保原 H0/hold；明确拒绝后新观察操作接纳 H1；收场期间正文改 H2，下一次编码收到 H2。第二场完整验证替换 worker 后同请求回原回执、预检两次且统计只调一次。重放仅证明这两条固定历史与当前代码兼容，不能代替服务端继续执行、真实取消或现场交还验收。

追加录制的同批另一用例在旧 worker 还没有到停点、尚无候选和 Update 时命中已登记的 `#3258`（`TMPRL1100`，`self-check-own-timeout` 标记不匹配）；该批结果为一过一红。两份有效历史没有因此改写或重新录制。原失败日志与整批结果保留在本次本机证据中，不能将该批声称为全绿。
