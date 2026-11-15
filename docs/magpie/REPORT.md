# 梳理回报

单号 **#4035**。

来源：local-session `DESKTOP-GET3DBC-2026-11-15T20:53:43.707Z`（单键 `b459e75e5600625a29edb03f4d14dbe8682fc21493a8cfec6e800ea6e97b7c7f`）。

创始人 2026-11-15 在 #4035 的评论里写了两句：fleet-setup 的梳理已经开了 PR，还没合，地址是 <https://github.com/thoerwink8/fleet-setup/pull/1>；这张单只用来记这件事，验收看那个 PR 里的 `docs/magpie/` 和 `install/magpie-verify`。

2026-11-16 本会话用未登录的 GitHub 接口请求 `thoerwink8/fleet-setup`，返回 404。那个 PR 的正文、里面的 `docs/magpie/` 和回报都读不到，也写不进去。单号 #4035 记在本文件。本文件随 fleet-dao 这次提交，不是 fleet-setup 那个 PR 里的回报。

本分支里能读到的页面：

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | magpie 是什么，两台机器怎么摆，同步约定 |
| [INVENTORY.md](INVENTORY.md) | 供应商、路由组、轮流、资源库、设置、文件名、用量 |
| [DECISIONS.md](DECISIONS.md) | 已经在用的取舍 |
| [INSTALL.md](INSTALL.md) | 从零装到和现有机器一致 |
| [OPERATIONS.md](OPERATIONS.md) | 用量、改权重、暂停、同步冲突、已踩的坑 |

核对和准备目录的脚本在仓库的 `install/magpie-verify`、`install/magpie-bootstrap`，对照 `templates/magpie-expected.json`。

2026-11-16 法国程序版本是 `0.1.4263`。在跑的配置目录属主是用户 `magpie`，权限 `750`。本会话没有读到组成员、workbuddy 与 raccoon 的账号个数和封顶、资源库正在下发的名单、在跑的 `settings.json`、近 30 天用量合计，也没有改那份配置。公开单 #4033 写过的组 id 记在 [INVENTORY.md](INVENTORY.md)，标了出处。
