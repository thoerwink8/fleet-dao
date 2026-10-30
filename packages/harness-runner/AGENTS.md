# packages/harness-runner：新内核的运行层

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里起执行体进程的那一层。从旧 `adapters/src/{process,procs,lines,stop-reason}.ts` 复制改写，不依赖旧包。对着 `specs/3770-harness-rewrite/旧坑验收用例.md` 的 A1–A5、A7、H1 写，测试名带编号。

## 不变量

- 新内核所有子进程只经 `runProcess` 起（A5）：`harness-*` 包里别处出现起子进程、任何地方出现同步起子进程，`test/process.test.ts` 当场红。
- 起步看实质事件，不看第一行（A1）：只有助手回话、工具调用、工具结果算（`frames.ts`）；换壳时传自己的 `classify`。
- 时限只有一份：`budget.ts` 的预算表加上层传下来的绝对截止时刻（`deriveDeadline`）；子层预算比上层剩下的长，启动前报错，不默默截短（A4）。到点的原因写「总时限 N 用完、停在哪一步」，外层同时叫停也不改成被叫停（A2）。
- 第一个叫停的原因作数，后来的不盖掉。
- init 里的会话号先交给调用方登记；续会话时对不上判 `session_conflict`、停掉这一个（A3）。
- 收尸按会话标记 `FLEET_RUN_ID` 加根进程的组和子孙；每个 PID 记起始时刻，发信号前核对，PID 被复用了不碰（A5）。没有 `/proc`（Windows 本机）时剩几个进程照实回 `undefined`，不当成收干净了。
- 重启后收孤儿只收确认进程不在的，查不了的报「没查成」（A7，`orphans.ts`）。
- 从这一层出去的文字（每一行输出、stderr、错误信息、叫停原因）都过 `makeRedactor`（H1）；已知密钥从环境变量名认（`secretsFromEnv`）。

## 测试

- `npx vitest run packages/harness-runner`：假执行体 `test/fake-cli.mjs` 按 `FAKE_MODE` 吐 stream-json；测试里不起真的执行体。
- 要 `/proc` 的几条（孙子进程收尸、按标记查在不在）只在 Linux 跑（CI）；A6（OOM 归属、cgroup 内存峰值）和会话用户、scope 放法国真机，见 #3775。
