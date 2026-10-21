# 0109 资源页的磁盘占用交给 root 的定时单元用 du 量，取代「不加 root 小工具」

- 索引状态：生效
- 日期：2026-10-21（北京时间）
- 谁拍的：创始人 2026-10-21 授权「全做完」，包括在法国 VPS 以 root 装 systemd 单元；落法由实现这张单的工人定，按决定 0097 自己拍、事后报。单 #3456。
- 状态：采纳。
- 关联：`deploy/france/fleet-footprint.service`、`fleet-footprint.timer`、`deploy/france/footprint/`、`packages/api/src/disk-footprint.ts`、`packages/api/src/vps-apps.ts`、`docs/ops.md`「上线项目」。
- 替代：#1985 起写在 `vps-apps.ts`、`disk-footprint.ts`、`docs/ops.md` 里的「不为了量全加 root 小工具（那要人以 root 重跑 france.sh，是人闸）」。

## 为什么改

2026-10-21 资源页「AI 会话」的磁盘写成「≥ 不到 1M · 不全」：

- 后端以 `fleet` 用户跑，在 node 里逐个文件 `lstat`，所有目录共用一个 3 分钟的时限按顺序量。`/var/lib/fleet-work`（十几棵带 `node_modules` 的工作树）一个目录就把时限吃光，排在后面的 `fleet-sessions`、Temporal、自动发布全被标成「没测完」，页面上是没有信息量的下限。
- 每棵工作树归会话用户、700，`/home/fleet-agent-carpool` 被 `ProtectHome=yes` 挡住，`/var/lib/daihuo`（750，里面有明文密钥）也读不到：`fleet` 本来就读不了，量不全是权限问题，不是量得不够快。

「不加 root 小工具」当初的理由是装 root 单元要人以 root 重跑 `france.sh`。现在这个理由不成立：量磁盘的单元归 `--auto-tier` 的自动档（不碰防火墙、sudoers、建用户、钥匙），发完版自动装；创始人也授权了这次装。

## 定了什么

1. 法国上加一个 root 的 oneshot 单元 `fleet-footprint.service` 加定时器（每 10 分钟，上一轮跑完再等），对登记表里每个目录各自带超时地跑 `du -s -B1 -x`（占的块、硬链接只算一次、不过挂载点），只把数字（路径、字节数、测于、耗时、没读到几处、没测成的原因）原子写进 `/var/lib/fleet-footprint/sizes.json`（root:root 644）。不输出任何文件名和内容，所以后端不需要读这些目录内容的权限。
2. 单元收得紧：只留 `CAP_DAC_READ_SEARCH`、只许写输出目录、不连网、`Nice=19`、IO 空闲、CPU 最多半个核、内存 256M。
3. 目录清单只认 root 拥有的 `/usr/local/lib/fleet-dao/footprint/dirs.json`（`france.sh` 自动档从仓里 `deploy/france/footprint/dirs.json` 拷，测试核对它和 `vps-apps.ts` 一致）；`fleet` 用户没法改，也就没法让 root 去量任意路径。
4. 后端只读这个文件，node 里逐个文件遍历整个删掉（不留开发机退路：没装单元的机器照实写「没读到」）。每个目录各自带测量时间，不再共用时限。这一回没量成的目录给上次量成的大小和测于、写原因；从没量成过写原因；文件旧了（超过两个间隔）每个数标旧；文件不在或认不出整块「没读到」。不再显示「不到 1M」这种下限。
5. 输出目录放 `/var/lib/fleet-footprint`，不放 `/var/lib/fleet-dao` 下：那里归 `fleet`，root 属主的文件会被装机读回（`readback_service_home`）判红。
6. 同一个单元顺带读登记表里带 `.timer` 的 oneshot 应用（跑完 cgroup 就没了，资源页 5 秒一采抓不到）的 `journalctl`，解析 systemd 每回结束打的「Consumed X CPU time, Y memory peak」，汇总成近 24 小时的次数、CPU 秒、单次内存峰值写进同一个文件；资源页写「近 24 小时平均 N 核（跑了 M 次）」和「单次峰值」。

## 没选的

- 后端自己加权限（给 `fleet` 读这些目录的组）：要么开 `fleet` 对明文密钥目录的读权，要么每个目录单配，权限面比一个只写数字的 root 单元大。
- 在 node 里开 worker 并发遍历：仍读不了 700 的树，且更慢于 `du`。
- 把清单放在 `fleet` 能写的文件里：`fleet` 能让 root 去测任意路径。
