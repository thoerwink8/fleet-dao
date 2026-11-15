# fleet-setup 梳理回报

单号 **#4035**。

来源：local-session `DESKTOP-GET3DBC-2026-11-15T20:53:43.707Z`（单键 `b459e75e5600625a29edb03f4d14dbe8682fc21493a8cfec6e800ea6e97b7c7f`）。

创始人在 #4035 上写了：同一套梳理在私有仓 fleet-setup 的 PR <https://github.com/thoerwink8/fleet-setup/pull/1>，这张单只用来记这件事。该仓对未登录的接口是 404，本会话打不开那个 PR，也看不出那边的正文有没有写上 #4035。能随这次提交读到的回报是本文件，单号记在这里。

本分支里的页面：

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | magpie 是什么，两台机器怎么摆，同步约定 |
| [INVENTORY.md](INVENTORY.md) | 供应商、路由组、轮流、资源库、设置、文件名、用量 |
| [DECISIONS.md](DECISIONS.md) | 已经在用的取舍 |
| [INSTALL.md](INSTALL.md) | 从零装到和现有机器一致 |
| [OPERATIONS.md](OPERATIONS.md) | 用量、改权重、暂停、同步冲突、已踩的坑 |

核对和准备目录的脚本在仓库的 `install/magpie-verify`、`install/magpie-bootstrap`，对照 `templates/magpie-expected.json`。

2026-11-16 在法国这台核对程序版本 `0.1.4263`。在跑的配置目录属主是用户 `magpie`，权限 `750`，本会话列不出成员名单和用量，也没有改那份配置。
