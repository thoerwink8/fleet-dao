#!/bin/bash
# france-snapshot.sh：法国现状快照（只读，root 跑；连上以后 `ssh root@<法国> bash -s < france-snapshot.sh > snapshot.txt`）。
# 只读的意思：不改任何文件、不起会话、不重启任何服务；唯一「动」的是临时起一个 1 秒的 bwrap 试探（第 4 节），
# 和读一次香港备份仓库的快照列表（加 --with-restic 才做）。不打印任何口令、令牌、私钥（不 cat 任何 .env、.key、.pass）。
# 每一项都可能没有：命令缺了、读不到都写「（没有/读不到）」，不当成 0、不中断。
set +e
export LC_ALL=C.UTF-8
WITH_RESTIC=0
[[ "${1:-}" == "--with-restic" ]] && WITH_RESTIC=1

sec() { printf '\n===== %s =====\n' "$*"; }
run() { # 命令…：跑，读不到就明说
  local out rc
  out=$("$@" 2>&1); rc=$?
  if ((rc != 0)) && [[ -z "$out" ]]; then printf '（%s：没有/读不到，退出码 %s）\n' "$1" "$rc"; else printf '%s\n' "$out"; fi
}
t() { timeout "${T:-15}" "$@"; } # 防止某条卡住

sec "0 身份和时间"
date -u +'UTC %F %T'; hostname
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null
uname -srm
run systemd --version | head -1
uptime
run timedatectl show -p Timezone -p NTPSynchronized -p TimeUSec

sec "1 CPU 和内存"
nproc
lscpu 2>/dev/null | grep -E 'Model name|^CPU\(s\)|Thread|Core|Socket|Hypervisor|Virtualization type|MHz' || echo "（lscpu 没有）"
free -m
run swapon --show
for f in cpu memory io; do printf 'PSI %s: ' "$f"; cat "/proc/pressure/$f" 2>/dev/null | tr '\n' ' '; echo; done
# %steal：共享 vCPU 被宿主抢走的比例（Contabo 是共享的）。10 秒内的 /proc/stat 差值
read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 _ < /proc/stat; sleep 10; read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
tot=$(( (u2+n2+s2+i2+w2+q2+sq2+st2) - (u1+n1+s1+i1+w1+q1+sq1+st1) ))
if ((tot > 0)); then echo "10 秒内：user+nice $(( (u2+n2-u1-n1)*100/tot ))%  system $(( (s2-s1)*100/tot ))%  iowait $(( (w2-w1)*100/tot ))%  steal $(( (st2-st1)*100/tot ))%  idle $(( (i2-i1)*100/tot ))%"; else echo "（/proc/stat 读不出差值）"; fi

sec "2 磁盘和文件系统（配额、SSD/NVMe）"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA,MODEL 2>/dev/null || echo "（lsblk 没有）"
df -hT -x tmpfs -x devtmpfs -x squashfs 2>/dev/null
df -i / /var/lib 2>/dev/null
for d in /var/lib/fleet-work /var/lib/fleet-dao /var/lib/fleet-sessions /var/lib/postgresql /srv/fleet-dao-releases; do
  if [[ -d "$d" ]]; then printf '%s  文件系统: ' "$d"; findmnt -no FSTYPE,OPTIONS -T "$d" 2>/dev/null | tr '\n' ' '; T=30 t du -sh "$d" 2>/dev/null | cut -f1; else echo "$d  （不存在）"; fi
done
echo "--- 大目录（前 8）"
T=40 t du -xh --max-depth=1 /var/lib /var/log /srv /opt 2>/dev/null | sort -rh | head -8

sec "3 内核、cgroup、Linux 安全模块"
stat -fc 'cgroup 文件系统类型: %T' /sys/fs/cgroup 2>/dev/null
echo "cgroup 控制器: $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
echo "LSM: $(cat /sys/kernel/security/lsm 2>/dev/null || echo 读不到)"
run aa-status 2>/dev/null | head -4
for k in kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone user.max_user_namespaces fs.protected_hardlinks kernel.yama.ptrace_scope net.ipv4.ip_local_port_range; do
  printf '%s = %s\n' "$k" "$(sysctl -n "$k" 2>/dev/null || echo 没有这个项)"
done

sec "4 笼子要用的东西在不在（bwrap 只做 1 秒的无害试探）"
for c in bwrap socat setpriv nft systemd-run restic node pnpm git; do printf '%-12s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo 没装)"; done
if command -v bwrap >/dev/null 2>&1; then
  bwrap --version 2>&1 | head -1
  # root 起的 bwrap：不需要用户命名空间
  if T=10 t bwrap --ro-bind / / --unshare-pid --unshare-ipc --unshare-uts --unshare-net --proc /proc --dev /dev true 2>/tmp/bwrap-root.err; then echo "root 起 bwrap（挂载+PID+IPC+UTS+网络命名空间）：能用"; else echo "root 起 bwrap：不能用 → $(head -c 200 /tmp/bwrap-root.err)"; fi
  rm -f /tmp/bwrap-root.err
  # 会话用户自己起 bwrap（要用户命名空间）：Ubuntu 24.04 默认会被 AppArmor 拦
  if id fleet-agent-carpool >/dev/null 2>&1; then
    if T=10 t runuser -u fleet-agent-carpool -- bwrap --ro-bind / / --unshare-user --unshare-pid true 2>/tmp/bwrap-user.err; then echo "会话用户自己起 bwrap（用户命名空间）：能用"; else echo "会话用户自己起 bwrap：不能用 → $(head -c 200 /tmp/bwrap-user.err)"; fi
    rm -f /tmp/bwrap-user.err
  fi
fi

sec "5 fleet 服务和定时器"
systemctl list-units 'fleet-*' --all --no-legend --plain 2>/dev/null | awk '{printf "%-44s %-8s %-8s\n", $1, $3, $4}'
systemctl list-timers 'fleet-*' --no-legend --plain 2>/dev/null | awk '{print $NF, "下次:", $1, $2}' | head -12
for u in postgresql wg-quick@wg-fleet ssh; do printf '%-24s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done
echo "--- 发布版本"; readlink /srv/fleet-dao-releases/current 2>/dev/null || echo "（没有 current）"
echo "--- 引擎开关（只读这两项，不打印别的）"; grep -E '^(FLEET_SERVICES|FLEET_ENGINE)=' /etc/fleet-dao/release.env 2>/dev/null || echo "（没读到）"

sec "6 会话池现在的用量"
run systemctl show fleet-agents.slice -p MemoryCurrent -p MemoryMax -p MemoryHigh -p TasksCurrent -p CPUUsageNSec
[[ -x /usr/local/sbin/fleet-agent-scope ]] && { echo "在册会话："; /usr/local/sbin/fleet-agent-scope list 2>&1 | head -20; } || echo "（没有 fleet-agent-scope）"
T=20 t systemd-cgtop -b -n 1 -d 1 2>/dev/null | head -15

sec "7 网络（不打印任何私钥）"
ip -br a 2>/dev/null
ip route 2>/dev/null | head -8
run wg show 2>/dev/null | sed -E 's/^(\s*private key:).*/\1 (hidden)/' | head -20
echo "--- 防火墙表（前 40 行）"; nft list ruleset 2>/dev/null | head -40

sec "8 备份"
systemctl list-timers 'fleet-backup*' --no-legend --plain 2>/dev/null | awk '{print $NF, "下次:", $1, $2}'
for u in fleet-backup fleet-backup-drill fleet-backup-watch; do
  printf '%-24s 最近一次: %s  结果: %s\n' "$u" "$(systemctl show "$u.service" -p ExecMainExitTimestamp --value 2>/dev/null)" "$(systemctl show "$u.service" -p Result --value 2>/dev/null)"
done
if ((WITH_RESTIC)); then
  echo "--- 香港仓库的快照（只读）"
  # shellcheck disable=SC1091
  if source /usr/local/lib/fleet-dao/backup/lib.sh 2>/dev/null && [[ -x "$BK_RESTIC" ]]; then
    "$BK_RESTIC" --repo "sftp:$BK_HK_USER@$BK_HK_ADDR:$BK_REPO_PATH" --password-file "$BK_PASS_FILE" --cache-dir /tmp/restic-snap-cache --no-lock \
      -o sftp.command="ssh $(bk_ssh_opts) $BK_HK_USER@$BK_HK_ADDR -s sftp" snapshots --latest 3 --compact 2>&1 | tail -12
    rm -rf /tmp/restic-snap-cache
  else echo "（读不到备份的库文件或 restic，没查）"; fi
else echo "（没加 --with-restic，不去读香港的仓库）"; fi

sec "9 用户和目录属主"
getent passwd fleet fleet-agent-carpool 2>/dev/null | cut -d: -f1,3,6,7
ls -ld /var/lib/fleet-work /var/lib/fleet-sessions /etc/fleet-dao 2>/dev/null

echo; echo "===== 快照结束 $(date -u +'%F %T') UTC ====="
