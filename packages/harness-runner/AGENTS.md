# packages/harness-runner：新内核的运行层

决定 0124 的新内核（母单 #3770，第 3 片 #3775）里起执行体进程的那一层。从旧 `adapters/src/{process,procs,lines,stop-reason}.ts` 复制改写，不依赖旧包。对着 `specs/3770-harness-rewrite/旧坑验收用例.md` 的 A1–A5、A7、H1 写，测试名带编号。

## 不变量

- 新内核所有子进程只经 `runProcess` 起（A5）：`harness-*` 包里别处出现起子进程、任何地方出现同步起子进程，`test/process.test.ts` 当场红。真正起进程的只有 `ProcessHost` 的实现（`host-local.ts`、`host-jobrun.ts`、`host-hostd.ts`，测试里的白名单 `SPAWN_FILES` 就这三个）。
- `ProcessHost`（`host.ts`，决定 0125 第 8 条）：起、接回（`attach`）、叫停（`stop`）、按行读（`readLines`）、收尸（`reap`）五件事。`local` 是进程组加会话标记（POSIX）或 taskkill（Windows 没有 jobrun 时）；`jobrun` 走 `crates/jobrun`（Windows Job Object：挂起建进程、放进 KILL_ON_JOB_CLOSE 的 Job、恢复）。`runProcess` 不给 `host` 时 `defaultHost()` 挑：Windows 且找得到 jobrun（环境变量 `FLEET_JOBRUN`，或仓里 `target/{release,debug}/jobrun.exe`）用 jobrun，否则 local。新实现（hostd）加进 `test/host-conformance.test.ts` 的 `HOSTS` 跑同一套。
- `hostd`（`host-hostd.ts`，#3871，`crates/hostd`）：宿主帮手，本机与 SSH 远端同一个程序，远端不要 node。执行体由 hostd 的看守进程（Unix 是 `hostd supervise`、自成会话；Windows 是 `hostd jobrun run`，同 jobrun 的 Job Object）起，脱离会话；输出由系统直接写进 hostd 状态目录里的文件，按行号读，所以内核、连接、hostd 都没了它照跑。内核重启后用 `HostdProcessHost.resume(runId, 已收下的行数)` 接回，不漏不重（内核先把一行落库、再让游标前进：`onLine` 带行号给它用）。帧协议只认 `harness-contract/src/hostd-frames.ts`（握手版本不对拒用）；终端 PTY 的帧（`pty.*`）占了位，hostd 回 `unsupported`（#3857）。`HostProcess.pid` 在 hostd 里是异步到的，`runProcess` 经可选的 `onSpawned` 补报 `onSpawn`。SSH 远端换 `launch` 为 `ssh -T <别名> fleet2-hostd --stdio`（#3856）。`sshHostdLaunch` / `remoteHostd` 是这一条命令的唯一写法（#3928），不另起看守。可执行文件：环境变量 `FLEET_HOSTD`，或 `target/{release,debug}/hostd[.exe]`。
- Windows 上 `reapSession` 回实数：Job 还在就数一下、整个收掉；Job 没了就读 jobrun 留下的报告，按（进程号，创建时刻）一对一核对，对不上的（进程号被别的进程复用）不碰；没有 jobrun、没有报告就是查不了，`leftovers` 回 `undefined`。叫停按 Job 成员关系，不按进程号。
- 起步看实质事件，不看第一行（A1）：只有助手回话、工具调用、工具结果算（`frames.ts`）；换壳时传自己的 `classify`。一行都还没有时先不停（进程可能还没排上），再等一段同样的起步时限，仍然没有才是无进展；这段里第一行若是会话号对不上，原因算冲突，不收成无进展。
- 时限只有一份：`budget.ts` 的预算表加上层传下来的绝对截止时刻（`deriveDeadline`）；子层预算比上层剩下的长，启动前报错，不默默截短（A4）。到点的原因写「总时限 N 用完、停在哪一步」，外层同时叫停也不改成被叫停（A2）。
- 第一个叫停的原因作数，后来的不盖掉。例外：还没有实质事件时，会话号对不上盖过「无进展」。
- init 里的会话号先交给调用方登记；续会话时对不上判 `session_conflict`、停掉这一个（A3）。
- 收尸按会话标记 `FLEET_RUN_ID` 加根进程的组和子孙；每个 PID 记起始时刻，发信号前核对，PID 被复用了不碰（A5）。生产标记就是 runId，重启后找得到孤儿。Vitest 里标记是「进程号:runId」，并行测试的同名 runId（各库事件号都从 1 起）不会互相收掉。没有 `/proc` 又没有 jobrun 时剩几个进程照实回 `undefined`，不当成收干净了。
- 重启后收孤儿只收确认进程不在的，查不了的报「没查成」（A7，`orphans.ts`）。
- 从这一层出去的文字（每一行输出、stderr、错误信息、叫停原因）都过 `makeRedactor`（H1）；已知密钥从环境变量名认（`secretsFromEnv`）。

## 测试

- `npx vitest run packages/harness-runner`：假执行体 `test/fake-cli.mjs` 按 `FAKE_MODE` 吐 stream-json；测试里不起真的执行体。
- `test/host-conformance.test.ts`：每个 `ProcessHost` 实现跑同一套；`test/jobrun-win32.test.ts`：Windows 专属（叫停后 2 秒内整棵树的进程号都不在、`reapSession` 回实数、进程号复用不误杀），要先 `cargo build -p jobrun`；CI 的 `windows` 台（不挡合并）跑它和 `cargo fmt/clippy/test`。Windows 上本机跑 cargo 要 MSVC 的 `link.exe` 排在 Git 的 `link.exe` 前面。
- `test/host-hostd.test.ts`：版本拒用，以及强杀内核（一个单独的进程，`test/hostd-kernel.ts`）后按 runId 加行号接回、行号 1..N 各一次；要先 `cargo build -p hostd`。CI 的 `linux` 台和 `windows` 台（都不挡合并）都跑它和 `cargo fmt/clippy/test`。
- 要 `/proc` 的几条（孙子进程收尸、按标记查在不在）只在 Linux 跑（CI）；A6（OOM 归属、cgroup 内存峰值）和会话用户、scope 放法国真机，见 #3775。
