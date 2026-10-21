# 验收候选索引

`acceptance_duties` 与 shared 的 `acceptanceDutyState` 是唯一状态依据。`acceptance_candidate_groups` 只派生同 task/PR 是否有 open，用于避免每轮读全部历史责任；它不能批准 settle、替代或关单。候选精确关联 task 的仓与同号 PR，保持完整责任上下文、原顺序、合并时间筛选和旧 done 任务。

0101只保留Drizzle生成的schema/index SQL；三个 statement transition trigger由正规custom迁移0102安装。现有Drizzle Postgres迁移器将整批pending迁移放进同一个事务，0101与0102一起提交，对外没有表已就绪而触发器未安装的空窗。insert/update/delete 的旧、新组全集按键序失效；target 换代也使旧源重新核算。批量写只为每个受影响组增加一次 revision。空组保留 clean/hasOpen=false，避免删除重建 revision 的 ABA；task 删除级联清派生组。原 duty 外键的删除限制保持。任意多事务可因各自原 duty 锁顺序发生 PostgreSQL deadlock，这会使整个写事务回滚，不能报告部分成功；刷新不持组锁等待 duty 锁。

迁移不播种控制行。第一个维护者幂等捕获 duty 主键高水位；此时 trigger 已覆盖迁移后的全部新写，包括迟到的低 id 行。历史只按 id 读键，每次最多 2048 行，cursor 持久化；登记组只 `ON CONFLICT DO NOTHING`，不覆盖并发新失效。失败或重启从 cursor 接着做，不能把第一页当索引完成。

每次维护最多 128 个 dirty 组、16384 行完整责任，单组最多 4096 行。先无锁读 revision，再无锁读取原责任和统一判法，最后以 revision、dirty、当前语义版本 CAS 发布；失败保留 dirty。尝试时间决定公平队列，热组 CAS 失败也排到后方。一次调用每组只尝试一次。初始化、dirty 未完成及超预算均明确 `unknown`，两个真实消费者下一轮继续维护；超大的单组须调整明确预算或变更消费合同，不能删责任凑绿。

只读候选在 `repeatable read / read only` 事务中检查控制行 ready、语义版本和 dirty，再读候选及完整责任，检查与结果使用同一快照。最多 4096 候选组、65536 行责任；超限整轮报未读全。reader 无写副作用。

初始化总成本 O(N)，一次付完且可分轮。稳定查询成本随有效组 A 及其完整上下文 ΣH(A) 增长；变化维护随 D 及 ΣH(D) 增长，不随稳定 settled/有效 superseded 历史增长。原两个消费者登记频率合计约 432 次/天，只是源码频率，不是生产实测。`acceptance-candidates-plan.test.ts` 用正式 builder SQL 的 `EXPLAIN ANALYZE BUFFERS` 对照历史 128→4096 组、活组和 dirty 固定及无候选的计划；比较执行行×循环、过滤行和访问块，不禁用 seqscan、不靠索引名字或墙钟。组内责任本来必须完整返回，它的增长成本不隐瞒。

判法升级须同时递增 `ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION`，用正式迁移令所有组重新进入有界初始化。重建只操作可重建的派生数据，但须保留控制行并原子改成新版本、ready=false、cursor=0和新的高水位，随后清空派生组；不能删除控制行让滚动发布中的旧代码补回旧版本。shared acceptance.ts 的规范换行字节摘要测试会挡住未声明的变化。升级失配时旧代码明确 unknown；旧 refresher 的最后 CAS 也核当前版本。此索引不改变终态执行或关单授权。
