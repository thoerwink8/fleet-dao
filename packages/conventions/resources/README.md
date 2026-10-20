# 一次性本机回环资源

用于共享本机网络出错时，验证只依赖本地服务的完整文件。它是显式测试资源，不是共享环境已修复，也不替代原 CI、选测器或 PG 资源。

## 安装与准备

只从官方已合主线的固定提交取 `isolated-loopback.py`，核 SHA-256 后，用系统文件安装工具复制到版本化 root-owned 目录；文件和所有父目录均不得是链接或对组/其他用户可写。不要以 root 执行候选工作树、包脚本或解释器。开发验收可以独立安装已审阅固定 SHA 的临时副本，不能覆盖共享 helper；正式安装只使用合并后的可信提交。

调用 root helper 的 Python 必须带 `-I`，禁用宿主 Python 路径和用户 site。helper 只创建本次 mount/PID/network namespace、启用私有 lo，随后清补充组和 capability、降普通 UID/GID，再执行候选 Node。所有 mount propagation 为 private，既不创建宿主 veth/路由，也不启动或重启 WSL。Linux 自身的生存期上限沿既有运输为 15 分钟；父端 keepalive 失联 10 秒、EOF 或取消都会停止本次进程，关闭失败明确报红。

在共享网络阶段先准备独立物理 Linux 依赖，冻结锁并保留供应链校验，禁止安装脚本；本入口不会安装依赖或下载。CLI 应与 `deploy/france.sh` 固定版本一致，先用 `pnpm test:temporal --cli <绝对路径>` 检查。当前旧 SDK 路径要求 time-skipping 缓存已存在且 SHA 与资源配置一致，basename 必须是 `temporal-test-server-sdk-typescript-<SDK版本>`，其目录必须等于资源启动器的 TMPDIR；缺失直接拒跑，不能在断网后等隐式下载。

## 本机 JSON

配置不进仓。示意中的占位值要替换为真实绝对路径与核验身份，不能直接使用：

```json
{
  "schema": 1,
  "runner": {
    "command": "C:/Windows/System32/wsl.exe",
    "args": ["--distribution", "<既有发行版>", "--user", "root", "--exec", "/usr/bin/python3", "-I", "/usr/local/lib/fleet-dao/test-resources/<已审版本>/isolated-loopback.py", "--uid", "<普通UID>", "--tmpdir", "/home/<用户>/tmp", "--", "/home/<用户>/tools/node"],
    "dependencyRoot": "/home/<用户>/prepared-dependencies"
  },
  "uid": 1000,
  "helperSha256": "<已审helper SHA-256>",
  "sourceDigest": "<snapshotSource/sourceDigest 对完整工作树的 SHA-256>",
  "offlineFiles": ["packages/engine/test/<已审完整文件>.test.ts"],
  "tools": {
    "nodeVersion": "v22.23.2",
    "sdkVersion": "1.24.0",
    "cli": {"path": "/home/<用户>/tools/temporal", "version": "1.9.1", "sha256": "<官方已核验制品SHA-256>"},
    "testServer": {"path": "/home/<用户>/tmp/temporal-test-server-sdk-typescript-1.24.0", "sha256": "<已核验server SHA-256>"}
  }
}
```

`sourceDigest` 绑定完整工作树，改动后需重新确认离线能力，不能自动更新配置冒充审阅。`offlineFiles` 只是经审阅的具体文件清单，不能凭“没有 PG 标记”猜所有文件离线。原用例尝试外网会因资源无外网失败，不返回空/0/ok。检测到数据库环境请求时拒跑，不能清变量后重试凑绿。原依赖/工作区链接仍由 `linux-test-worker.mjs` 校验并链接到本次快照。

## 执行与证据

执行 `pnpm test:isolated --resource <配置绝对路径> -- <完整文件...>`。位置参数必须是完整测试文件；如果 Vitest 的子串规则还会拉入其他文件，必须先明确列全并审阅，否则拒跑。完整测试仍按原阈值执行，不允许 all、glob、testNamePattern、跳过断言或任意 shell。

资源先核普通用户、不同 PID/net namespace、无 capability、no-new-privs 和固定 Node/SDK/工具 SHA；IPv4、IPv6 port=0 各一次 connect **及 accept**。随后按 SDK 默认阈值起 time-skipping/local 各一份，读公开 gRPC health 并 teardown，再执行原完整测试文件。真实失败不重试换端口或延长阈值。

报告沿 `local-vitest-*` 唯一目录保留源码 SHA、原 Linux/Vitest JSON、资源关闭回执和日志，不保存环境或源码快照正文。成功要求真实用例全通过、文件集无多漏、无跳过、退出码一致且无服务孤儿。断言失败保留 exit 1；准备、身份、取消或关闭不确定保留 exit 2。PID namespace 最终退出会销毁其余成员；helper 也核实普通退出没有遗留成员，不能把“强制清完了”冒充正常 teardown。

标准机制依据：[Linux network_namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)、[util-linux unshare](https://man7.org/linux/man-pages/man1/unshare.1.html)。共享 namespace 与原 CI 超时原因仍应独立保留证据，不能用隔离路径转绿覆盖旧失败。
