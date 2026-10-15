#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港 root 每天把备份仓库复制一份到备份用户碰不到的目录，留 14 天。
# 装到 /usr/local/lib/fleet-dao/backup/hk-repo-copy.sh，由 fleet-backup-copy.timer 每天 09:10（北京时间）拉起。
# 不读仓库口令、不连法国。复制没做成不删已经留下的那些天。
# 不变的文件和上一份 root 副本共用 inode（省这台 2G 机器的盘）；不和仓库里的文件共用——备份钥匙改得了仓库的 inode。
# locks/ 里还有普通文件就这一轮不复制：备份或演练可能还在写。正常时法国 04:10 会先清掉失效的锁。
# 测试 source 本文件只要函数。非 root 要 HK_BACKUP_TEST=1。还能改的：HK_REPO_SRC、HK_COPY_DIR、HK_COPY_TODAY、
# HK_COPY_CHOWN、HK_COPY_KEEP_DAYS、HK_STATUS_FILE、HK_NOW_EPOCH。这些名字故意不叫 FLEET_*。

_hk_copy_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=hk-status.sh
source "$_hk_copy_here/hk-status.sh"

hk_copy_error=""
hk_copy_incoming=""
hk_copy_dest=""
hk_copy_today=""
hk_copy_keep=""

hk_copy_fail() { # 原因（打到 stderr，hk_copy_error 留给调用方写状态）
  hk_copy_error=$1
  echo "$1" >&2
  return 1
}

# 绝对路径，中间没有空段、. 和 ..。不解析符号链接。
hk_path_literal() {
  local p=$1
  [[ "$p" == /* ]] || return 1
  [[ "$p" != "/" ]] || return 1
  [[ "$p" != *//* ]] || return 1
  [[ "$p" != */ ]] || return 1
  [[ "$p" != *"/." && "$p" != *"/./"* && "$p" != "/." ]] || return 1
  [[ "$p" != *"/.." && "$p" != *"/../"* && "$p" != "/.." ]] || return 1
}

# 日期认得出才打印当天 00:00:00 UTC 的秒。GNU date 会把 2 月 31 日滚到三月的，滚完对不上原字符串就拒。
hk_copy_day_epoch() { # YYYY-MM-DD
  local d=$1 got
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  got=$(date -u -d "$d 00:00:00" +%Y-%m-%d 2>/dev/null) || return 1
  [[ "$got" == "$d" ]] || return 1
  date -u -d "$d 00:00:00" +%s
}

# 0 留，1 删，2 认不出（调用方不许删）。留 keep 个日历日，含今天：差 ≥ keep 就删。未来的日期留着。
hk_copy_drop() { # today name keep
  local today=$1 name=$2 keep=$3 te ne diff
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || return 2
  te=$(hk_copy_day_epoch "$today") || return 2
  ne=$(hk_copy_day_epoch "$name") || return 2
  diff=$(((te - ne) / 86400))
  if ((diff >= keep)); then return 1; fi
  return 0
}

# 路径上已有的每一段都不能是符号链接。最后一段可以还不在。
hk_copy_walk() { # 路径
  local p=$1 cur="" rest=$1 seg missing=0
  rest=${rest#/}
  while [[ -n "$rest" ]]; do
    seg=${rest%%/*}
    if [[ "$rest" == */* ]]; then rest=${rest#*/}; else rest=""; fi
    cur+="/$seg"
    if ((missing)); then continue; fi
    if [[ -L "$cur" ]]; then
      hk_copy_fail "路径上有符号链接（$cur），不跟着走"
      return 1
    fi
    if [[ ! -e "$cur" ]]; then
      missing=1
      continue
    fi
    if [[ -n "$rest" && ! -d "$cur" ]]; then
      hk_copy_fail "路径上有不是目录的一段（$cur）"
      return 1
    fi
  done
  if [[ -L "$p" ]]; then
    hk_copy_fail "路径是符号链接（$p），不跟着走"
    return 1
  fi
  if [[ -e "$p" && ! -d "$p" ]]; then
    hk_copy_fail "路径不是目录（$p）"
    return 1
  fi
}

hk_copy_nested() { # 甲 乙：甲就是乙，或甲在乙里面
  local a=${1%/} b=${2%/}
  [[ "$a" == "$b" || "$a" == "$b"/* ]]
}

hk_copy_specials() { # 目录：有符号链接、管道、套接字、设备就打印一条
  find -P "$1" -xdev \( -type l -o -type p -o -type s -o -type b -o -type c \) -print -quit
}

# locks/ 里的普通文件。空目录、没有这个目录，都算没锁。读不成返回 1。
hk_copy_lock_file() { # 仓库
  local locks=$1/locks list rc=0
  [[ -e "$locks" || -L "$locks" ]] || return 0
  if [[ -L "$locks" || ! -d "$locks" ]]; then
    echo "locks 不是目录（$locks）" >&2
    return 1
  fi
  list=$(find -P "$locks" -xdev -mindepth 1 -maxdepth 1 -type f -print -quit) || rc=$?
  if ((rc != 0)); then return 1; fi
  printf '%s' "$list"
}

# 上一份用来做硬链接种子的日期目录。不算今天，不算符号链接，认不出的名字跳过。
hk_copy_prev() { # dest today
  local dest=$1 today=$2 best="" name p
  for p in "$dest"/*; do
    [[ -e "$p" || -L "$p" ]] || continue
    [[ -L "$p" ]] && continue
    [[ -d "$p" ]] || continue
    name=${p##*/}
    hk_copy_day_epoch "$name" >/dev/null 2>&1 || continue
    [[ "$name" == "$today" ]] && continue
    if [[ -z "$best" || "$name" > "$best" ]]; then best=$name; fi
  done
  printf '%s' "$best"
}

# 已经是目标权限和属主的不再 chmod、chown：硬链接着的上一份不该被带过去改掉。
hk_copy_tighten() { # 目录 用户 组
  local dir=$1 user=$2 group=$3 p mode own list rc=0
  list=$(find -P "$dir" -xdev \( -type d -o -type f \) -print) || rc=$?
  if ((rc != 0)); then return 1; fi
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    mode=$(stat -c '%a' -- "$p") || return 1
    own=$(stat -c '%U:%G' -- "$p") || return 1
    if [[ -d "$p" ]]; then
      [[ "$mode" == 700 ]] || chmod 700 -- "$p" || return 1
    else
      [[ "$mode" == 600 ]] || chmod 600 -- "$p" || return 1
    fi
    if [[ "$own" != "$user:$group" ]]; then
      chown "$user:$group" -- "$p" || return 1
    fi
  done <<<"$list"
}

hk_copy_sweep_tmp() { # 副本根：只删自己上次没跑完留下的临时目录
  local dest=$1 p name
  for p in "$dest"/.*; do
    [[ -e "$p" || -L "$p" ]] || continue
    name=${p##*/}
    [[ "$name" == . || "$name" == .. ]] && continue
    [[ "$name" == .incoming-* || "$name" == .replaced-* ]] || continue
    # 不加结尾斜线：符号链接只删链接本身，不跟着删它指的地方
    rm -rf --one-file-system -- "$p" || return 1
  done
}

hk_copy_prune() { # dest today keep。只删一层、名字是日期的真目录。
  local dest=$1 today=$2 keep=$3 p name rc
  for p in "$dest"/*; do
    [[ -e "$p" || -L "$p" ]] || continue
    [[ -L "$p" ]] && continue
    [[ -d "$p" ]] || continue
    name=${p##*/}
    rc=0
    hk_copy_drop "$today" "$name" "$keep" || rc=$?
    if ((rc == 1)); then
      rm -rf --one-file-system -- "$p" || {
        hk_copy_fail "新副本已经落在 $dest/$today，旧的没删成（$name）"
        return 1
      }
    fi
  done
}

hk_copy_discard() { # 原因。新的一份还没换上时，把写了一半的临时目录丢掉，已有的那些天不动。
  if [[ -n "$hk_copy_incoming" && "$hk_copy_incoming" == "$hk_copy_dest"/.incoming-* ]]; then
    rm -rf --one-file-system -- "$hk_copy_incoming" 2>/dev/null || true
  fi
  hk_copy_incoming=""
  hk_copy_fail "$1"
}

# 复制本身。成功时 hk_copy_dest、hk_copy_today、hk_copy_keep 有值。失败时 hk_copy_error 有原因，旧的日期目录还在。
hk_repo_copy_build() {
  local src dest today keep own user group prev incoming today_dir replaced specials lock rc
  hk_copy_error=""
  hk_copy_incoming=""
  hk_copy_dest=""
  hk_copy_today=""
  hk_copy_keep=""
  if [[ "${HK_BACKUP_TEST:-}" != 1 && "$EUID" -ne 0 ]]; then
    hk_copy_fail "没以 root 跑"
    return 1
  fi
  src=${HK_REPO_SRC:-/srv/fleet-dao-backup/restic}
  dest=${HK_COPY_DIR:-/var/backups/fleet-dao/restic-copies}
  keep=${HK_COPY_KEEP_DAYS:-14}
  own=${HK_COPY_CHOWN:-root:root}
  if [[ ! "$keep" =~ ^[1-9][0-9]*$ ]]; then
    hk_copy_fail "保留天数认不出（$keep）"
    return 1
  fi
  if [[ "$own" != *:* || "$own" == *: || "$own" == :* || "$own" == *:*:* ]]; then
    hk_copy_fail "属主要写成用户:组（$own）"
    return 1
  fi
  user=${own%%:*}
  group=${own#*:}
  if [[ -n "${HK_COPY_TODAY:-}" ]]; then
    today=$HK_COPY_TODAY
  elif [[ -n "${HK_NOW_EPOCH:-}" ]]; then
    today=$(TZ=Asia/Shanghai date -d "@$HK_NOW_EPOCH" +%Y-%m-%d) || {
      hk_copy_fail "现在的时刻认不出（$HK_NOW_EPOCH）"
      return 1
    }
  else
    today=$(TZ=Asia/Shanghai date +%Y-%m-%d) || {
      hk_copy_fail "今天的日期读不出来"
      return 1
    }
  fi
  if ! hk_copy_day_epoch "$today" >/dev/null; then
    hk_copy_fail "今天的日期认不出（$today）"
    return 1
  fi
  hk_copy_dest=$dest
  hk_copy_today=$today
  hk_copy_keep=$keep
  if ! hk_path_literal "$src"; then
    hk_copy_fail "仓库路径不合法（$src）"
    return 1
  fi
  if ! hk_path_literal "$dest"; then
    hk_copy_fail "副本路径不合法（$dest）"
    return 1
  fi
  if [[ ! -e "$src" && ! -L "$src" ]]; then
    hk_copy_fail "仓库不在（$src）"
    return 1
  fi
  if [[ -L "$src" || ! -d "$src" ]]; then
    hk_copy_fail "仓库不是目录，或是符号链接，不跟着读（$src）"
    return 1
  fi
  hk_copy_walk "$src" || return 1
  hk_copy_walk "$dest" || return 1
  if hk_copy_nested "$src" "$dest" || hk_copy_nested "$dest" "$src"; then
    hk_copy_fail "仓库和副本目录不能互相套着（$src 和 $dest）"
    return 1
  fi
  if [[ -L "$src/config" || ! -f "$src/config" ]]; then
    hk_copy_fail "仓库里没有 config，不像一份 restic 仓库（$src）"
    return 1
  fi
  rc=0
  specials=$(hk_copy_specials "$src") || rc=$?
  if ((rc != 0)); then
    hk_copy_fail "仓库读不成（$src）"
    return 1
  fi
  if [[ -n "$specials" ]]; then
    hk_copy_fail "仓库里有符号链接或特殊文件（$specials），这一份不复制"
    return 1
  fi
  rc=0
  lock=$(hk_copy_lock_file "$src") || rc=$?
  if ((rc != 0)); then
    hk_copy_fail "仓库的锁读不成（$src/locks）"
    return 1
  fi
  if [[ -n "$lock" ]]; then
    hk_copy_fail "仓库正锁着（$lock），这一轮不复制，旧的留着"
    return 1
  fi
  # -m 和 -p 一起用只作用在最深那一层；下面的 chmod 才把这一层收成 700。
  mkdir -p -- "$dest" || {
    hk_copy_fail "副本目录建不成（$dest）"
    return 1
  }
  if [[ -L "$dest" || ! -d "$dest" ]]; then
    hk_copy_fail "副本目录不是目录（$dest）"
    return 1
  fi
  chmod 700 -- "$dest" || {
    hk_copy_fail "副本目录收不了权限（$dest）"
    return 1
  }
  if [[ "$(stat -c '%U:%G' -- "$dest")" != "$user:$group" ]]; then
    chown "$user:$group" -- "$dest" || {
      hk_copy_fail "副本目录改不了属主（$dest）"
      return 1
    }
  fi
  today_dir=$dest/$today
  if [[ -L "$today_dir" ]]; then
    hk_copy_fail "当天的目录是符号链接，不换（$today_dir）"
    return 1
  fi
  if [[ -e "$today_dir" && ! -d "$today_dir" ]]; then
    hk_copy_fail "当天的路径不是目录（$today_dir）"
    return 1
  fi
  if ! hk_copy_sweep_tmp "$dest"; then
    hk_copy_fail "上次没复制完的临时目录清不掉（$dest）"
    return 1
  fi
  incoming=$dest/.incoming-$today
  hk_copy_incoming=$incoming
  mkdir -m 700 -- "$incoming" || {
    hk_copy_discard "临时目录建不成（$incoming）"
    return 1
  }
  prev=$(hk_copy_prev "$dest" "$today")
  if [[ -n "$prev" ]]; then
    # 硬链接只链上一份 root 副本。链不上（跨盘）就整份复制，不退回去链仓库。
    if ! cp -a --link -- "$dest/$prev/." "$incoming/"; then
      find -P "$incoming" -mindepth 1 -xdev -delete || {
        hk_copy_discard "硬链接没接上，临时目录也清不掉（$incoming）"
        return 1
      }
      echo "上一份接不上硬链接，改成整份复制" >&2
    fi
  fi
  # 不用 -a：-p 会把仓库的权限写到和上一份共用的 inode 上，-o 会把属主改成备份用户。
  # 不用 --inplace：那会改到共用的 inode。-l 让符号链接原样过来，下面再拒，不跟着读。
  if ! rsync -rlt --delete --no-owner --no-group --no-specials --no-devices -x -- "$src/" "$incoming/"; then
    hk_copy_discard "rsync 没做成（$src → $incoming）"
    return 1
  fi
  rc=0
  specials=$(hk_copy_specials "$incoming") || rc=$?
  if ((rc != 0)) || [[ -n "$specials" ]]; then
    hk_copy_discard "复制结果里有符号链接或特殊文件（${specials:-读不成}），这一份作废"
    return 1
  fi
  if ! hk_copy_tighten "$incoming" "$user" "$group"; then
    hk_copy_discard "副本的权限没收好（$incoming）"
    return 1
  fi
  replaced=""
  if [[ -d "$today_dir" ]]; then
    replaced=$dest/.replaced-$today-$$
    if ! mv -f -- "$today_dir" "$replaced"; then
      hk_copy_discard "挪开当天的旧副本没成（$today_dir）"
      return 1
    fi
  fi
  if ! mv -f -- "$incoming" "$today_dir"; then
    if [[ -n "$replaced" ]]; then mv -f -- "$replaced" "$today_dir" || echo "回滚当天的旧副本也没成（$replaced）" >&2; fi
    hk_copy_incoming=""
    hk_copy_fail "换上新副本没成（$today_dir）"
    return 1
  fi
  hk_copy_incoming=""
  if [[ -n "$replaced" ]] && ! rm -rf --one-file-system -- "$replaced"; then
    hk_copy_fail "新副本已经落在 $today_dir，被换下的当天旧副本没删掉（$replaced）"
    return 1
  fi
  hk_copy_prune "$dest" "$today" "$keep" || return 1
}

hk_repo_copy_run() {
  local umask_old rc=0 msg
  umask_old=$(umask)
  umask 077
  if hk_repo_copy_build; then
    msg="已复制到 $hk_copy_dest/$hk_copy_today，旧于 $hk_copy_keep 天的已删"
    if ! hk_status_write backup.copy 1 "$msg"; then
      echo "副本已经落在 $hk_copy_dest/$hk_copy_today，状态没写成" >&2
      rc=1
    fi
  else
    msg=${hk_copy_error:-复制没做成}
    if ! hk_status_write backup.copy 0 "$msg"; then
      echo "状态没写成" >&2
    fi
    rc=1
  fi
  umask "$umask_old"
  return "$rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  hk_repo_copy_run
  exit $?
fi
