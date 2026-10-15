# 错误分类短索引

全文在 git 历史。第 5 节那批样本的原文和现行判法在 `packages/engine/test/failure/fixtures/failure-samples.json`。标过「测试」的样本只在旧测试里出现过，不能当真实样本验收。

## 第 5 节

- **S09** 原文：`起会话没查成：没收到 prompt 的应答帧（没查成）`。旧手册判 retry-here。现行是 ST2（`packages/engine/src/failure/rules.ts`）：只挂起，不记进这条路由的失败率。只认以这句开头的整条报错。

## 第 8 节

11. 会话以 failed 结束但没有任何原因：把「缺原因」单独计数，走兜底，不得把它算进某条路由的成功率。
