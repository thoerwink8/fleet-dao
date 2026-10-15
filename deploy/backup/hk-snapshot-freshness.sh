#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港自己看备份仓库里最新一份快照的修改时间。超过 26 小时就往状态文件写 backup.snapshot（ok=0）。
# 装到 /usr/local/lib/fleet-dao/backup/hk-snapshot-freshness.sh，由 fleet-backup-freshness.timer 每小时 25 分拉起。
# 不连法国、不读仓库口令。快照文件是密文，修改时间约等于写进去的时刻。没有快照、读不到，都算要报，不当成没事。
# 正好 26 小时不报，再晚一秒才报。钥匙能 touch 改这个时间，假装还在备份；防删靠每天的 root 副本。
# 测试 source 本文件只要函数。非 root 要 HK_BACKUP_TEST=1。还能改的：HK_REPO_SRC、HK_STATUS_FILE、HK_NOW_EPOCH。

_hk_fresh_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=hk-status.sh
source "$_hk_fresh_here/hk-status.sh"

# 26 小时。和法国看门狗里 backup.nightly 的过期分钟 1560 是同一档。
HK_SNAPSHOT_LIMIT_SEC=$((26 * 60 * 60))

hk_fresh_error=""

# 0 不报，1 要报（now 严格大于 snap+limit），2 参数不是非负整数。未来的时间不报。
hk_snapshot_alarm() { # now snap limit（秒）
  local now=$1 snap=$2 limit=$3
  [[ "$now" =~ ^[0-9]+$ && "$snap" =~ ^[0-9]+$ && "$limit" =~ ^[0-9]+$ ]] || return 2
  if ((now > snap + limit)); then return 1; fi
  return 0
}

hk_age_text() { # 秒 → 「N 小时 M 分」
  local s=$1
  printf '%d 小时 %d 分' $((s / 3600)) $(((s % 3600) / 60))
}

# 打印最新一份普通文件的修改时间（整秒）。没有、读不到：原因在 hk_fresh_error，返回 1。
# 起始点本身是符号链接就不读：find 对这种起始点会跟着走。
hk_latest_snapshot_epoch() { # 仓库
  local repo=$1
  local snap=$repo/snapshots listing="" rc=0 line sec latest=""
  hk_fresh_error=""
  if [[ -L "$repo" ]]; then
    hk_fresh_error="仓库路径是符号链接，不跟着读（$repo）"
    return 1
  fi
  if [[ ! -d "$repo" ]]; then
    hk_fresh_error="仓库不在（$repo）"
    return 1
  fi
  if [[ -L "$snap" ]]; then
    hk_fresh_error="snapshots 是符号链接，不跟着读（$snap）"
    return 1
  fi
  if [[ ! -d "$snap" ]]; then
    hk_fresh_error="没有快照目录（$snap）"
    return 1
  fi
  listing=$(find -P "$snap" -xdev -type f -printf '%T@\n') || rc=$?
  if ((rc != 0)); then
    hk_fresh_error="快照目录读不成（$snap）"
    return 1
  fi
  while IFS= read -r line; do
    [[ "$line" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue
    sec=${line%%.*}
    if [[ -z "$latest" || "$sec" -gt "$latest" ]]; then latest=$sec; fi
  done <<<"$listing"
  if [[ -z "$latest" ]]; then
    hk_fresh_error="没有快照（snapshots 里没有普通文件）"
    return 1
  fi
  printf '%s' "$latest"
}

hk_freshness_run() {
  local repo=${HK_REPO_SRC:-/srv/fleet-dao-backup/restic}
  local limit=${HK_SNAPSHOT_LIMIT_SEC}
  local now snap rc=0 msg age
  if [[ "${HK_BACKUP_TEST:-}" != 1 && "$EUID" -ne 0 ]]; then
    echo "要 root" >&2
    hk_status_write backup.snapshot 0 "没以 root 跑" || echo "状态没写成" >&2
    return 1
  fi
  if [[ -n "${HK_NOW_EPOCH:-}" ]]; then
    if [[ ! "$HK_NOW_EPOCH" =~ ^[0-9]+$ ]]; then
      echo "现在的时刻认不出（$HK_NOW_EPOCH）" >&2
      hk_status_write backup.snapshot 0 "现在的时刻认不出" || echo "状态没写成" >&2
      return 1
    fi
    now=$HK_NOW_EPOCH
  else
    now=$(date +%s) || {
      echo "现在的时刻读不出来" >&2
      hk_status_write backup.snapshot 0 "现在的时刻读不出来" || echo "状态没写成" >&2
      return 1
    }
  fi
  snap=$(hk_latest_snapshot_epoch "$repo") || rc=$?
  if ((rc != 0)); then
    msg=${hk_fresh_error:-快照读不到}
    echo "$msg" >&2
    hk_status_write backup.snapshot 0 "$msg" || echo "状态没写成" >&2
    return 1
  fi
  rc=0
  hk_snapshot_alarm "$now" "$snap" "$limit" || rc=$?
  if ((rc == 2)); then
    echo "时刻认不出" >&2
    hk_status_write backup.snapshot 0 "时刻认不出" || echo "状态没写成" >&2
    return 1
  fi
  if ((now >= snap)); then
    age=$(hk_age_text $((now - snap)))
  else
    age=$(hk_age_text $((snap - now)))
  fi
  if ((rc == 1)); then
    msg="最新快照是 ${age}前，超过 26 小时"
    echo "$msg" >&2
    hk_status_write backup.snapshot 0 "$msg" || echo "状态没写成" >&2
    return 1
  fi
  if ((now < snap)); then
    msg="最新快照的时间在现在之后（${age}）"
  else
    msg="最新快照是 ${age}前"
  fi
  hk_status_write backup.snapshot 1 "$msg"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  hk_freshness_run
  exit $?
fi
