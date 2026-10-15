#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 香港备份第二份：复制留 14 天、过期才删、最新快照超过 26 小时才报。不碰真仓库、不要 root。
# 用法：bash deploy/backup/test/hk-backup-mirror.test.sh。退出码：0 通过，1 有不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BK=$(cd -- "$HERE/.." && pwd)
ROOT=$(cd -- "$BK/../.." && pwd)
# shellcheck source=../hk-repo-copy.sh
source "$BK/hk-repo-copy.sh"
# shellcheck source=../hk-snapshot-freshness.sh
source "$BK/hk-snapshot-freshness.sh"
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
fails=0
passes=0
ME=$(id -un):$(id -gn)
USER_NAME=$(id -un)
LIMIT=$((26 * 60 * 60)) # 93600

check() { # 说明 期望 实际
  if [[ "$2" == "$3" ]]; then
    passes=$((passes + 1))
  else
    fails=$((fails + 1))
    printf '不通过：%s\n  期望：%s\n  实际：%s\n' "$1" "$2" "$3"
  fi
}

rc_exact() { # 命令… → 退出码（不把非 0 折成 1）
  "$@" >/dev/null 2>&1
  echo $?
}

field() { # 状态文件 检查名 键
  local sec line
  sec=$(HK_STATUS_FILE=$1 hk_status_get "$2" 2>/dev/null) || {
    printf '%s' "GET_FAIL"
    return 0
  }
  while IFS= read -r line; do
    if [[ "$line" == "$3="* ]]; then
      printf '%s' "${line#"$3="}"
      return 0
    fi
  done <<<"$sec"
  printf '%s' "NO_FIELD"
}

# ── 留 14 天的判法 ──

check "留：当天" 0 "$(rc_exact hk_copy_drop 2026-10-15 2026-10-15 14)"
check "留：往前第 13 天（2026-10-02）" 0 "$(rc_exact hk_copy_drop 2026-10-15 2026-10-02 14)"
check "删：正好 14 天（2026-10-01）" 1 "$(rc_exact hk_copy_drop 2026-10-15 2026-10-01 14)"
check "删：更早（2026-09-30）" 1 "$(rc_exact hk_copy_drop 2026-10-15 2026-09-30 14)"
check "留：未来的日期" 0 "$(rc_exact hk_copy_drop 2026-10-15 2026-10-20 14)"
check "认不出：2 月 31 日" 2 "$(rc_exact hk_copy_drop 2026-10-15 2026-02-31 14)"
check "认不出：不是日期" 2 "$(rc_exact hk_copy_drop 2026-10-15 notes 14)"

# ── 26 小时的判法（纯函数）──

check "年龄：25 小时 59 分" "25 小时 59 分" "$(hk_age_text 93540)"
check "年龄：26 小时 1 分" "26 小时 1 分" "$(hk_age_text 93660)"
check "快照：25 小时 59 分不报" 0 "$(rc_exact hk_snapshot_alarm 1000000 $((1000000 - 93540)) "$LIMIT")"
check "快照：正好 26 小时不报" 0 "$(rc_exact hk_snapshot_alarm 1000000 $((1000000 - LIMIT)) "$LIMIT")"
check "快照：26 小时再加 1 秒要报" 1 "$(rc_exact hk_snapshot_alarm 1000000 $((1000000 - LIMIT - 1)) "$LIMIT")"
check "快照：26 小时 1 分要报" 1 "$(rc_exact hk_snapshot_alarm 1000000 $((1000000 - 93660)) "$LIMIT")"
check "快照：时间在现在之后不报" 0 "$(rc_exact hk_snapshot_alarm 100 200 "$LIMIT")"
check "快照：参数不是数" 2 "$(rc_exact hk_snapshot_alarm x 1 "$LIMIT")"

# ── 状态文件：两张单写同一份，谁写谁只换自己那一段 ──

st=$T/status
HK_NOW_EPOCH=1700000000 HK_STATUS_FILE=$st hk_status_write france.reach 1 "法国还在" || true
check "状态：先写 france.reach" 1 "$(field "$st" france.reach ok)"
HK_NOW_EPOCH=1700000000 HK_STATUS_FILE=$st hk_status_write backup.snapshot 0 "最新快照是 26 小时 1 分前，超过 26 小时" || true
check "状态：后写的不冲掉 france.reach" 1 "$(field "$st" france.reach ok)"
check "状态：backup.snapshot 写上了" 0 "$(field "$st" backup.snapshot ok)"
HK_NOW_EPOCH=1700000100 HK_STATUS_FILE=$st hk_status_write backup.snapshot 1 "最新快照是 1 小时 0 分前" || true
check "状态：同一个检查只留一段" 1 "$(grep -c '^check=backup.snapshot$' "$st")"
check "状态：改完自己的，别人的还在" 1 "$(grep -c '^check=france.reach$' "$st")"
check "状态：第一行是 v=1" v=1 "$(head -1 "$st")"

printf '不是 v=1\n' >"$T/bad"
HK_NOW_EPOCH=1700000000 HK_STATUS_FILE=$T/bad hk_status_write backup.copy 1 "已复制到 /x/2026-10-15，旧于 14 天的已删" || true
check "状态：坏文件改写成 v=1" v=1 "$(head -1 "$T/bad")"
check "状态：坏文件被挪走一份" 1 "$(find "$T" -maxdepth 1 -name 'bad.bad-*' | wc -l)"

: >"$T/empty"
HK_NOW_EPOCH=1700000000 HK_STATUS_FILE=$T/empty hk_status_write backup.copy 1 "已复制" || true
check "状态：空文件当成新的写" v=1 "$(head -1 "$T/empty")"

printf '原样\n' >"$T/secret"
ln -s "$T/secret" "$T/linked"
rc=$(HK_STATUS_FILE=$T/linked HK_NOW_EPOCH=1700000000 rc_exact hk_status_write backup.copy 0 "不该写进去")
check "状态：符号链接不写" 1 "$rc"
check "状态：链接指着的文件没被改" 原样 "$(cat "$T/secret")"

# ── 真复制：留 14 天、过期删、失败不删 ──

repo=$T/repo
copies=$T/copies
mkdir -p "$repo/snapshots" "$repo/data" "$repo/locks"
printf 'cfg\n' >"$repo/config"
printf 'snap\n' >"$repo/snapshots/s"
printf 'pack\n' >"$repo/data/aa"
mkdir -p "$copies/2026-10-02" "$copies/2026-10-01" "$copies/2026-09-30" "$copies/notes" "$copies/2026-10-20" "$copies/2026-02-31"
printf 'keep\n' >"$copies/2026-10-02/marker"
printf 'drop\n' >"$copies/2026-10-01/marker"
printf 'drop\n' >"$copies/2026-09-30/marker"
printf 'note\n' >"$copies/notes/marker"
printf 'future\n' >"$copies/2026-10-20/marker"
printf 'bad-date\n' >"$copies/2026-02-31/marker"
printf 'target\n' >"$T/link-target"
ln -s "$T/link-target" "$copies/2026-09-01"

st=$T/copy-status
HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$st HK_REPO_SRC=$repo HK_COPY_DIR=$copies HK_COPY_TODAY=2026-10-15 \
  hk_repo_copy_run
check "复制：退出码 0" 0 "$?"
# 上面的 $? 是 check 的。要单独接住。重跑一次同一天，幂等，再看退出码。
rc=$(HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$st HK_REPO_SRC=$repo HK_COPY_DIR=$copies HK_COPY_TODAY=2026-10-15 \
  rc_exact hk_repo_copy_run)
check "复制：再跑同一天仍是 0" 0 "$rc"
check "复制：当天留下" cfg "$(cat "$copies/2026-10-15/config")"
check "复制：13 天前留着" keep "$(cat "$copies/2026-10-02/marker")"
check "复制：正好 14 天删掉" 0 "$([[ -e $copies/2026-10-01 ]] && echo 1 || echo 0)"
check "复制：更早的删掉" 0 "$([[ -e $copies/2026-09-30 ]] && echo 1 || echo 0)"
check "复制：不是日期的留着" note "$(cat "$copies/notes/marker")"
check "复制：未来的日期留着" future "$(cat "$copies/2026-10-20/marker")"
check "复制：认不出的日期不删" bad-date "$(cat "$copies/2026-02-31/marker")"
check "复制：日期样子的符号链接不删" target "$(cat "$T/link-target")"
check "复制：状态 ok" 1 "$(field "$st" backup.copy ok)"
check "复制：状态写了留 14 天" 1 "$(field "$st" backup.copy summary | grep -c '旧于 14 天')"
check "复制：目录 700" 700 "$(stat -c '%a' "$copies/2026-10-15")"
check "复制：文件 600" 600 "$(stat -c '%a' "$copies/2026-10-15/config")"
check "复制：属主是当前用户" "$USER_NAME" "$(stat -c '%U' "$copies/2026-10-15/data/aa")"
modes=$(find "$copies/2026-10-15" -type f -printf '%m\n' | sort -u | tr '\n' ' ')
check "复制：当天文件都是 600" "600 " "$modes"
dmodes=$(find "$copies/2026-10-15" -type d -printf '%m\n' | sort -u | tr '\n' ' ')
check "复制：当天目录都是 700" "700 " "$dmodes"

# 失败：仓库里有符号链接。过期的那份还在，当天不换。
badrepo=$T/badrepo
mkdir -p "$badrepo/snapshots" "$copies-fail/2026-10-01"
printf 'cfg\n' >"$badrepo/config"
ln -s "$repo/config" "$badrepo/snapshots/link"
printf 'old\n' >"$copies-fail/2026-10-01/marker"
st=$T/fail-status
rc=$(HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$st HK_REPO_SRC=$badrepo HK_COPY_DIR=$copies-fail HK_COPY_TODAY=2026-10-15 \
  rc_exact hk_repo_copy_run)
check "复制：仓库里有符号链接就失败" 1 "$rc"
check "复制：失败时过期的仍留着" old "$(cat "$copies-fail/2026-10-01/marker")"
check "复制：失败时不留下当天" 0 "$([[ -e $copies-fail/2026-10-15 ]] && echo 1 || echo 0)"
check "复制：失败写 ok=0" 0 "$(field "$st" backup.copy ok)"

# 失败：仓库不在。旧的不动。
rc=$(HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$T/miss-status HK_REPO_SRC=$T/no-such-repo HK_COPY_DIR=$copies-fail HK_COPY_TODAY=2026-10-15 \
  rc_exact hk_repo_copy_run)
check "复制：仓库不在就失败" 1 "$rc"
check "复制：仓库不在时旧的还在" old "$(cat "$copies-fail/2026-10-01/marker")"

# 失败：locks/ 里有普通文件。空的 locks 上面那次已经复制成功。
locked=$T/locked
mkdir -p "$locked/snapshots" "$locked/locks"
printf 'cfg\n' >"$locked/config"
printf 'snap\n' >"$locked/snapshots/s"
printf 'lock\n' >"$locked/locks/held"
rc=$(HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$T/lock-status HK_REPO_SRC=$locked HK_COPY_DIR=$copies-fail HK_COPY_TODAY=2026-10-15 \
  rc_exact hk_repo_copy_run)
check "复制：仓库锁着就失败" 1 "$rc"
check "复制：锁着时过期的仍留着" old "$(cat "$copies-fail/2026-10-01/marker")"
check "复制：锁着时不留下当天" 0 "$([[ -e $copies-fail/2026-10-15 ]] && echo 1 || echo 0)"
check "复制：锁着写 ok=0" 0 "$(field "$T/lock-status" backup.copy ok)"

# 不变的文件和上一份同一个 inode；内容变了才是新的 inode，旧的那天还是原内容。
repo2=$T/repo2
copies2=$T/copies2
mkdir -p "$repo2/snapshots" "$repo2/data"
printf 'cfg\n' >"$repo2/config"
printf 'A\n' >"$repo2/data/aa"
printf 'B\n' >"$repo2/data/bb"
printf 's\n' >"$repo2/snapshots/s"
HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$T/c2 HK_REPO_SRC=$repo2 HK_COPY_DIR=$copies2 HK_COPY_TODAY=2026-10-14 \
  hk_repo_copy_run
HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$T/c2 HK_REPO_SRC=$repo2 HK_COPY_DIR=$copies2 HK_COPY_TODAY=2026-10-15 \
  hk_repo_copy_run
ino14=$(stat -c '%i' "$copies2/2026-10-14/data/aa")
ino15=$(stat -c '%i' "$copies2/2026-10-15/data/aa")
check "复制：没变的文件和上一份是同一个 inode" "$ino14" "$ino15"
check "复制：上一份的权限没被带成别的" 600 "$(stat -c '%a' "$copies2/2026-10-14/data/aa")"
printf 'A2\n' >"$repo2/data/aa"
rm -f "$repo2/data/bb"
HK_BACKUP_TEST=1 HK_COPY_CHOWN="$ME" HK_STATUS_FILE=$T/c2 HK_REPO_SRC=$repo2 HK_COPY_DIR=$copies2 HK_COPY_TODAY=2026-10-16 \
  hk_repo_copy_run
ino16=$(stat -c '%i' "$copies2/2026-10-16/data/aa")
check "复制：变了的文件是新 inode" 1 "$([[ $ino16 != "$ino14" ]] && echo 1 || echo 0)"
check "复制：旧的那天内容不变" A "$(cat "$copies2/2026-10-14/data/aa")"
check "复制：中间那天内容不变" A "$(cat "$copies2/2026-10-15/data/aa")"
check "复制：新的那天是新内容" A2 "$(cat "$copies2/2026-10-16/data/aa")"
check "复制：源里删掉的，新的一天没有" 0 "$([[ -e $copies2/2026-10-16/data/bb ]] && echo 1 || echo 0)"
check "复制：源里删掉的，旧的一天还在" B "$(cat "$copies2/2026-10-14/data/bb")"

# 非 root、又没开测试开关：不复制
if ((EUID != 0)); then
  rc=$(
    unset HK_BACKUP_TEST
    HK_STATUS_FILE=$T/root-status HK_REPO_SRC=$repo HK_COPY_DIR=$T/root-copies HK_COPY_TODAY=2026-10-15 \
      rc_exact hk_repo_copy_run
  )
  check "复制：没以 root 跑就失败" 1 "$rc"
  check "复制：没以 root 跑不建副本" 0 "$([[ -e $T/root-copies ]] && echo 1 || echo 0)"
  check "复制：没以 root 跑写进状态" "没以 root 跑" "$(field "$T/root-status" backup.copy summary)"
fi

# ── 新鲜度：按文件修改时间，25 小时 59 分不报，26 小时 1 分报 ──

NOW=1700000000
frepo=$T/frepo
mkdir -p "$frepo/snapshots"
printf 'cfg\n' >"$frepo/config"
printf 's\n' >"$frepo/snapshots/a"
fresh() { # 距现在的秒数（正数＝过去）
  local age=$1 st=$T/fresh-status
  rm -f "$st"
  touch -d "@$((NOW - age))" "$frepo/snapshots/a"
  HK_BACKUP_TEST=1 HK_STATUS_FILE=$st HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW hk_freshness_run
  echo $?
}
rc=$(fresh 93540)
check "新鲜度：25 小时 59 分不报" 0 "$rc"
check "新鲜度：25 小时 59 分 ok=1" 1 "$(field "$T/fresh-status" backup.snapshot ok)"
check "新鲜度：25 小时 59 分的说明里不写超过" 0 "$(field "$T/fresh-status" backup.snapshot summary | grep -c '超过 26 小时')"

rc=$(fresh "$LIMIT")
check "新鲜度：正好 26 小时不报" 0 "$rc"
check "新鲜度：正好 26 小时 ok=1" 1 "$(field "$T/fresh-status" backup.snapshot ok)"

rc=$(fresh $((LIMIT + 1)))
check "新鲜度：26 小时再加 1 秒要报" 1 "$rc"
check "新鲜度：26 小时再加 1 秒 ok=0" 0 "$(field "$T/fresh-status" backup.snapshot ok)"
check "新鲜度：说明里写超过 26 小时" 1 "$(field "$T/fresh-status" backup.snapshot summary | grep -c '超过 26 小时')"

rc=$(fresh 93660)
check "新鲜度：26 小时 1 分要报" 1 "$rc"
check "新鲜度：26 小时 1 分 ok=0" 0 "$(field "$T/fresh-status" backup.snapshot ok)"

# 多份里认最新的那份：旧的超了，新的还在 25 小时里
printf 'old\n' >"$frepo/snapshots/old"
touch -d "@$((NOW - 93660))" "$frepo/snapshots/old"
touch -d "@$((NOW - 93540))" "$frepo/snapshots/a"
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/fresh-status HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW rc_exact hk_freshness_run)
check "新鲜度：多份里认最新的，不报" 0 "$rc"

rm -f "$frepo/snapshots/a" "$frepo/snapshots/old"
ln -s "$frepo/config" "$frepo/snapshots/only-link"
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/fresh-status HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW rc_exact hk_freshness_run)
check "新鲜度：只剩符号链接不算有快照" 1 "$rc"
check "新鲜度：没有普通文件 ok=0" 0 "$(field "$T/fresh-status" backup.snapshot ok)"

mkdir -p "$frepo/snapshots"
printf 's\n' >"$frepo/snapshots/a"
rm -f "$frepo/snapshots/only-link"
touch -d "@$((NOW + 3600))" "$frepo/snapshots/a"
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/fresh-status HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW rc_exact hk_freshness_run)
check "新鲜度：时间在现在之后不报" 0 "$rc"
check "新鲜度：未来的说明不写超过" 0 "$(field "$T/fresh-status" backup.snapshot summary | grep -c '超过 26 小时')"
check "新鲜度：未来的说明点出在现在之后" 1 "$(field "$T/fresh-status" backup.snapshot summary | grep -c '在现在之后')"

rmdir "$frepo/snapshots" 2>/dev/null || rm -rf "$frepo/snapshots"
mkdir -p "$frepo/snapshots"
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/fresh-status HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW rc_exact hk_freshness_run)
check "新鲜度：一份快照都没有要报" 1 "$rc"

ln -s "$frepo" "$T/repo-link"
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/fresh-status HK_REPO_SRC=$T/repo-link HK_NOW_EPOCH=$NOW rc_exact hk_freshness_run)
check "新鲜度：仓库路径是符号链接不跟着读" 1 "$rc"

# 先有别的检查，新鲜度只换自己的段
HK_NOW_EPOCH=$NOW HK_STATUS_FILE=$T/mix hk_status_write france.reach 1 "法国还在"
printf 's\n' >"$frepo/snapshots/a"
touch -d "@$((NOW - 93660))" "$frepo/snapshots/a"
HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/mix HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW hk_freshness_run || true
check "新鲜度：不冲掉 france.reach" 1 "$(field "$T/mix" france.reach ok)"
check "新鲜度：自己的段是要报" 0 "$(field "$T/mix" backup.snapshot ok)"

# 入口：当脚本跑，而不是只 source 函数。26 小时 1 分应退出 1。
rc=$(HK_BACKUP_TEST=1 HK_STATUS_FILE=$T/entry HK_REPO_SRC=$frepo HK_NOW_EPOCH=$NOW bash "$BK/hk-snapshot-freshness.sh" >/dev/null 2>&1
  echo $?)
check "新鲜度：脚本入口 26 小时 1 分退出 1" 1 "$rc"

# ── 装机接线：hk.sh 装、单元以 root 跑 ──

check "单元：复制以 root 跑" 1 "$(grep -c '^User=root$' "$ROOT/deploy/hk/fleet-backup-copy.service")"
check "单元：检查以 root 跑" 1 "$(grep -c '^User=root$' "$ROOT/deploy/hk/fleet-backup-freshness.service")"
check "定时：每天 09:10" 1 "$(grep -c 'OnCalendar=\*-\*-\* 09:10:00 Asia/Shanghai' "$ROOT/deploy/hk/fleet-backup-copy.timer")"
check "定时：每小时 25 分" 1 "$(grep -c 'OnCalendar=\*-\*-\* \*:25:00 Asia/Shanghai' "$ROOT/deploy/hk/fleet-backup-freshness.timer")"
check "hk.sh：副本目录" 1 "$(grep -c 'ensure_dir /var/backups/fleet-dao/restic-copies root:root 700' "$ROOT/deploy/hk.sh")"
check "hk.sh：状态目录" 1 "$(grep -c 'ensure_dir /var/lib/fleet-hk root:root 755' "$ROOT/deploy/hk.sh")"
check "hk.sh：脚本目录" 1 "$(grep -c 'ensure_dir /usr/local/lib/fleet-dao/backup root:root 755' "$ROOT/deploy/hk.sh")"
check "hk.sh：启用定时器" 1 "$(grep -c 'systemctl enable --quiet' "$ROOT/deploy/hk.sh")"
check "hk.sh：装了复制定时器" 2 "$(grep -c 'fleet-backup-copy.timer' "$ROOT/deploy/hk.sh")"
check "hk.sh：装了检查定时器" 2 "$(grep -c 'fleet-backup-freshness.timer' "$ROOT/deploy/hk.sh")"

printf '香港第二份备份的测试：通过 %d 条，不通过 %d 条\n' "$passes" "$fails"
if ((fails)); then exit 1; fi
