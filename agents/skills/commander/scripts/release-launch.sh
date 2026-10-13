#!/usr/bin/env bash
# 发版车第 4 步在法国上跑的「起发布或看发布」入口（#1995）。release-train-lib.mjs 把本文件整段 ssh 到法国，
# 用 `bash -c <本文件> fleet-release-launch <提交号> <令牌> <release-boot.sh 的 base64>` 跑。
# 为什么：发布要几分钟，本机到法国的 ssh 会被重置；以前一条前台 ssh 撑完整个发布，ssh 一断本机就报「没成」，
# 法国上发布其实跑完了。现在发布由 systemd 的临时服务 fleet-train-release-<提交前12位> 跑，ssh 断了它照跑；
# 本机每个轮询周期把同一条命令再发一遍，本命令幂等：只回现状，该起才起。
# 回话（标准输出，一行一项，「---」后面是日志末尾几行）：
#   state=started   刚起了服务（令牌写下了）
#   state=attached  这个提交的服务已经在跑（上一趟起的、或本趟上一次起的）：接着看，不起第二个
#   state=finished  服务跑完了且日志里有退出码（令牌对得上本趟，或没有服务在跑）
#   state=lost      本趟起过服务，服务没了、日志里也没有退出码：不重起，交给人看日志
#   state=busy      服务不是我们起的、但发布锁（.lock）被别的发布占着：不起，本机接着等
#   state=refused   参数认不出（退出码 64）
#   exit=<退出码|none>   日志里最后一行 fleet-dao-release-exit=<n>
#   log=<日志路径>
# 退出码本命令自己恒为 0（读到现状就是 0），发布自己的退出码在 exit= 里。起不了服务：退出码 1。
# FLEET_RELEASES_DIR 可换（测试）。不改 release.sh 的任何约定：发布锁、排空、迁移、读回都由它自己做。
set -uo pipefail
umask 022

sha=${1:-}
token=${2:-}
b64=${3:-}
if [[ ! $sha =~ ^[0-9a-f]{7,40}$ || ! $token =~ ^[A-Za-z0-9]{1,40}$ || -z $b64 ]]; then
  echo "state=refused"
  exit 64
fi

releases=${FLEET_RELEASES_DIR:-/srv/fleet-dao-releases}
dir=$releases/.train-launch
short=${sha:0:12}
unit=fleet-train-release-$short
log=$dir/$short.log
tokfile=$dir/$short.token
bootfile=$dir/$short.boot.sh

install -d -m 755 -- "$releases"
install -d -m 750 -- "$dir"

exit_of() { # 日志里最后一行退出码；没有就空
  [[ -f $log ]] || return 0
  grep -a '^fleet-dao-release-exit=' -- "$log" | tail -n 1 | sed 's/^fleet-dao-release-exit=//'
}

report() { # 状态
  local rc
  rc=$(exit_of)
  echo "state=$1"
  echo "exit=${rc:-none}"
  echo "log=$log"
  echo "---"
  if [[ -f $log ]]; then tail -n 8 -- "$log" | tr -d '\r'; fi
}

unit_active() {
  [[ "$(systemctl is-active "$unit" 2>/dev/null)" =~ ^(active|activating|deactivating|reloading)$ ]]
}

if unit_active; then
  report attached
  exit 0
fi

mine=""
if [[ -f $tokfile ]]; then mine=$(head -n 1 -- "$tokfile"); fi
if [[ $mine == "$token" ]]; then
  # 本趟起过服务，现在没有在跑的：有退出码就是跑完了，没有就是没了（不重起，重起会盖掉现场）
  if [[ -n "$(exit_of)" ]]; then report finished; else report lost; fi
  exit 0
fi

# 要起新的了：别的发布（人手、驾驶舱按钮那一路）占着锁就不起，免得 release.sh 报锁冲突
if ! (
  exec 9>>"$releases/.lock"
  flock -n 9
); then
  report busy
  exit 0
fi

printf '%s' "$b64" | base64 -d >"$bootfile" || {
  echo "state=refused"
  echo "解不开送过来的 release-boot.sh" >&2
  exit 64
}
chmod 700 -- "$bootfile"
: >"$log"
printf '%s\n' "$token" >"$tokfile"
if ! systemd-run --quiet --unit="$unit" --collect --setenv=HOME=/root \
  -p StandardOutput="append:$log" -p StandardError="append:$log" \
  /bin/bash -c 'bash "$@"; echo "fleet-dao-release-exit=$?"' _ "$bootfile" "$sha"; then
  rm -f -- "$tokfile"
  echo "起不了发布用的临时服务（systemd-run）：$unit" >&2
  exit 1
fi
report started
exit 0
