# 准入未知报警的独立暂存与移交

本能力属于 #3337 的独立前置，入口是 `createAdmissionAlertSink` 的 `record` 和 `transferOne`。尚未装配生产准入、worker、定时任务、飞书推送或终态释放；不改变首个 local 命令或旧工作流历史。调用来源和整体准入期限由未来装配另行核验。

## 责任与回执

全局事件由 `version/category/namespace/workflowId/runId` 定义，首个错误码不属于全局身份。SQLite 保存规范 JSON、身份 SHA-256 key 与完整记录 SHA-256；同身份重试保留已存首码。记录已从本地移交后，允许以新首码重建本地记录，但 PG 仍归并原通知，保留通知所有字段和 delivery。

`spooled` 只表示 SQLite 事务已确认提交、连接和子进程已收尾；`transferred` 只表示 PG 接手该责任，不能证明渠道送达。`empty` 表示已校验的库没有 pending；所有读取、权限、容量、退出或回执不确定均为带封闭错误码的 `unknown`。成功帧不能替代真实退出。

record 和 transfer 各一个子进程槽，总计最多两个，无队列。单操作总期限最多十秒，最后一秒用于 SIGKILL 和退出/管道收尾；不能确认收尾时返回 `cleanup_pending` 并继续占槽。调用方只能缩短期限；未来接线不得在已经用尽的整体准入预算后重新赠送十秒。

transfer 在 SQLite 读事务结束后才连接 PG。专用 PG 事务以 `INSERT ... ON CONFLICT DO NOTHING` 和另一次读回核身份；冲突后读空最多四轮，再失败保留本地责任。只有真实 PG COMMIT 和连接关闭成功后，才在同一 transfer 子进程中按 key+recordHash CAS 删除并提交本地事务。没有调用方可提供的 ACK/删除入口。PG 已提交但 ACK 丢失、本地删除失败或删除前崩溃，只会留下可幂等重放的 pending。

## 文件字节硬界

| 对象 | 上限与核验 |
|---|---|
| pending | 256 条，单 DTO 最多 4096 UTF-8 字节，总 payload 最多 1 MiB；BEGIN IMMEDIATE 内核对再插入 |
| 主库 | 4096 字节/页 × 1024 页 = 4,194,304 字节 |
| rollback journal | 1024 × (4096 + 4 字节页号 + 4 字节校验) + 2 × 65536 = 4,333,568 字节 |
| 两文件合计 | 8,527,872 字节，不是设备或文件系统配额 |

这是受管 DB/journal 的文件长度界，不包含目录项、文件系统元数据、设备保留空间。`st_blocks × 512` 只作观测。真实文件系统 ENOSPC 可以早于这些界，仍须拒绝新责任并保留旧责任；不以空库重建来恢复容量。

每次打开前核现存文件长度、权限与身份；SQLite 读库可能先恢复 hot journal，故恢复前也核 journal 的固定字节界、原页数、页号、页/扇区尺寸和分段边界。过大、损坏、孤立 journal、零字节旧库均保留原件并返回 unknown。这里只做有限格式/上限预检，恢复、锁与事务仍全部由 SQLite 完成。没有自写 WAL、恢复器、VFS、TTL 清理或无限 tombstone。

运行期界依赖固定 SQL 和核回的 `page_size=4096`、`max_page_count=1024`、`journal_mode=DELETE`、`synchronous=EXTRA`、`busy_timeout=0`、`temp_store=MEMORY`、`cache_spill=OFF`、`auto_vacuum=NONE`。没有 ATTACH、扩展、触发器、任意 SQL 或显式 SAVEPOINT。max_page_count 不能缩小已超额库，必须核实际返回值及 page_count，不能只执行 PRAGMA 就算设置成功。

依据 SQLite 3.51.3 的 [pager 实现](https://github.com/sqlite/sqlite/blob/version-3.51.3/src/pager.c)：`pInJournal` 使每个原页像在受管事务中至多写一次；禁 spill 消除其额外 journal header，普通提交走不追加新 header 的同步路径。最大扇区 64 KiB，预算保守留两扇区余量。hot 恢复的 nRec=0 为零页，nRec=0xffffffff 才按剩余长度推算；首段原页数会用于截断，故必须在打开前限制。

隐式 statement journal 并未被忽略：[btree 实现](https://github.com/sqlite/sqlite/blob/version-3.51.3/src/btree.c) 把 `sqlite3TempInMemory` 传给 pager 的 subjInMemory，[global 定义](https://github.com/sqlite/sqlite/blob/version-3.51.3/src/global.c) 明确 temp_store=MEMORY 时 statement journal 留在内存。因此它不新增磁盘临时文件；不依赖“没有显式 SAVEPOINT 就没有 statement journal”的错误假设。文件峰值测试观测提交前后及近 DTO 上界的全容量记录；观测用于核实现，不能替代上述运行期界论证。

`recordAdmissionAlert` 每次新开连接。已提交行的规范解码如果每次整表重做，256 条近上界记录会按行数二次放大，和 256 次真实 EXTRA 提交叠在一起会越过该测试原来的 15 秒。写锁内若暂存目录、主库 dev/ino、字节长度和文件头变更计数（偏移 24）与本进程上次提交后在锁内记下的一致，就跳过逐行解码；权限、schema、`quick_check` 和容量 SQL 仍每次做。同一连接的 `data_version` 在刷新快照时变了，说明别的连接已提交，快照作废。对不上、读不到或中途失败都整表重核。这不减少真实 COMMIT，也不放宽 EXTRA 或固定字节界。

剩下的是提交本身。strace 实测 DELETE/EXTRA 下每次 COMMIT 恰好 5 次 fsync，全由 SQLite 发出：journal 内容、新 journal 的目录项、journal 头、主库、删 journal 后的目录。256 条就是约 1285 次 fsync，COMMIT 墙钟基本等于 fsync 等待（一次实测 fsync 合计 31.0 秒，COMMIT 墙钟 32.6 秒），本进程 CPU 只占约十分之一。所以多个会话共用同一块盘时，单靠提交就可能超过 15 秒。不能为此改 journal 模式、降同步级别、合并提交或放宽限时。测试失败时打印 `SPOOL_COMMIT_DIAG`，里面拆开 COMMIT 内外耗时、COMMIT 墙钟与 CPU、单次最慢提交和 1 分钟负载，用来区分是解码回退还是等盘。

文件头只经打开 SQLite 前固定主库身份时留下的那个 fd 读，这个 fd 等 SQLite 关库后才关。Linux 上关掉同一文件的任何 fd，会释放本进程在该文件上的全部 POSIX 锁；事务里另开另关主库会放掉 SQLite 的 RESERVED/EXCLUSIVE 锁，别的进程就能拿到写锁，把活 journal 当 hot journal 回滚删除，本进程的 COMMIT 随后报 `SQLITE_IOERR_DELETE_NOENT`。

## 私有路径与耐久边界

仅 Linux 非 root 服务 UID 可用。逐级 no-follow 打开目录并保持 FD/dev/ino/uid/mode；祖先仅 root/当前可信 UID 可写，叶目录当前 UID、0700，两个文件当前 UID、0600、单硬链接。SQLite 用字符串路径，并不因持 FD 而自动获得 dirfd 锚定；安全依据是祖先写权限边界及操作前后的身份复核。

威胁模型排除恶意 root 和同一可信 UID。新叶同步父目录，新库同步文件和叶目录，DELETE/EXTRA 由 SQLite 保证事务同步和删除 journal 后的目录同步。同一进程里，同一叶路径在同一父 inode 上的父目录同步成功一次后不再重复；父 inode 换了，或上次同步没成功，下次仍同步。这不减少每次写入自己的 EXTRA 提交。强杀测试验证进程崩溃；不把它称为真实断电测试。断电耐久仍要求内核、文件系统和存储实际兑现 fsync。永久介质损坏、未来通知保留期/删除策略及生产装配均需独立验收。
