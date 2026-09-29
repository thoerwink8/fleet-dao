#!/bin/bash
# upgrade-baseline.sh：升级前后的「基线」（只读，root 跑；输出到标准输出，升级前存一份、升级后存一份，用 diff 对比）。
#   ssh root@<法国> bash -s < upgrade-baseline.sh > baseline-before.txt   （升级前）
#   ssh root@<法国> bash -s < upgrade-baseline.sh > baseline-after.txt    （升级后）
#   diff baseline-before.txt baseline-after.txt
# 看的是「在线迁移后最容易变的东西」：网卡名和 MAC、网络配置（netplan、cloud-init）、磁盘 UUID 和挂载、machine-id、
# ssh 主机指纹、内核和 cgroup、时间同步、swap、WireGuard 状态。不打印任何私钥、口令、令牌。
set +e
export LC_ALL=C.UTF-8
sec() { printf '\n===== %s =====\n' "$*"; }

sec "网卡（名字、MAC、状态、地址）"
ip -d -br link 2>/dev/null
ip -br addr 2>/dev/null
ip route 2>/dev/null
ip -6 route 2>/dev/null | head -8
sec "netplan（配置文件原文；VPS 上没有 wifi 口令之类的秘密）"
for f in /etc/netplan/*.yaml; do [[ -r "$f" ]] && { echo "--- $f"; cat "$f"; }; done
sec "cloud-init 里管网络的部分"
ls -1 /etc/cloud/cloud.cfg.d/ 2>/dev/null
grep -rHn -E 'network|config: disabled' /etc/cloud/cloud.cfg.d/ 2>/dev/null | head -20
sec "磁盘、UUID、挂载"
lsblk -o NAME,SIZE,TYPE,FSTYPE,UUID,MOUNTPOINT 2>/dev/null
blkid 2>/dev/null | sed -E 's/ PARTUUID="[^"]*"//' | sort
echo "--- fstab"; grep -v '^\s*#' /etc/fstab 2>/dev/null | grep -v '^\s*$'
echo "--- findmnt"; findmnt -rno TARGET,SOURCE,FSTYPE,OPTIONS -t ext4,xfs,btrfs,vfat 2>/dev/null
sec "machine-id 和主机名"
cat /etc/machine-id 2>/dev/null; hostname; hostnamectl 2>/dev/null | grep -E 'Static hostname|Machine ID|Operating System|Kernel|Virtualization|Chassis'
sec "ssh 主机指纹（公钥的指纹，不是私钥）"
for f in /etc/ssh/ssh_host_*_key.pub; do [[ -r "$f" ]] && ssh-keygen -lf "$f"; done
sec "内核、cgroup、时间、swap"
uname -a
stat -fc 'cgroup 类型: %T' /sys/fs/cgroup 2>/dev/null
echo "控制器: $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
timedatectl 2>/dev/null | grep -E 'Time zone|System clock synchronized|NTP service'
swapon --show 2>/dev/null; free -m | head -2
nproc; grep -E 'MemTotal' /proc/meminfo
sec "WireGuard（公开信息；私钥隐藏）"
wg show 2>/dev/null | sed -E 's/^(\s*private key:).*/\1 (hidden)/'
sec "服务状态"
systemctl --failed --no-legend --plain 2>/dev/null
systemctl is-active postgresql fleet-firewall wg-quick@wg-fleet 2>/dev/null | tr '\n' ' '; echo
echo "--- 防火墙规则条数"; nft list ruleset 2>/dev/null | grep -c 'rule\|accept\|drop\|reject'
sec "备份状态"
for u in fleet-backup fleet-backup-drill; do printf '%s 结果: %s\n' "$u" "$(systemctl show "$u.service" -p Result --value 2>/dev/null)"; done
echo; echo "===== 基线结束 $(date -u +'%F %T') UTC ====="
