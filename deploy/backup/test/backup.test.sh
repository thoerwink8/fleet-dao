#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2317,SC2329 # 替身函数由被测代码间接调用，shellcheck 看不出来
# deploy/backup/ 的测试：纯函数逐个测（每条「读不到、认不出」的路径都故意造一次），三个任务的分支用替身跑——
# 不碰库、不连网、不要 root。库、restic、隧道这一段靠在两台机器上真跑（结果写在 PR 里）。
# 用法：bash deploy/backup/test/backup.test.sh。退出码：0 通过，1 有不通过，2 有没跑成的（比如这台没有 node）。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BK=$(cd -- "$HERE/.." && pwd)
ORIG_PATH=$PATH
# shellcheck source=../fleet-backup.sh
source "$BK/fleet-backup.sh"
PATH=$ORIG_PATH # 任务本体把 PATH 定死成服务器上的样子；测试要用跑测试这台的
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
fails=0
passes=0
skipped=0

check() { # 说明 期望 实际
  if [[ "$2" == "$3" ]]; then
    passes=$((passes + 1))
  else
    fails=$((fails + 1))
    printf '不通过：%s\n  期望：%s\n  实际：%s\n' "$1" "$2" "$3"
  fi
}

# 只看退出码是不是 0 / 非 0
rc_of() { "$@" >/dev/null 2>&1 && echo 0 || echo 1; }

# ── 配置 ──

cfg=$T/backup.env
printf '%s\n' '# 注释' '' FLEET_DISK_ALERT_PERCENT=85 'FLEET_DISK_PATHS_FRANCE=/ /var/lib' 'FLEET_DISK_PATHS_HK="/ /srv/x"' >"$cfg"
chmod 644 "$cfg"
me=$(id -u)
(
  bk_read_config "$cfg" "$me" "${BK_CONFIG_KEYS_FRANCE[@]}" && bk_check_france_config &&
    echo "$FLEET_DISK_ALERT_PERCENT|$FLEET_DISK_PATHS_FRANCE|$FLEET_DISK_PATHS_HK"
) >"$T/out" 2>&1
check "配置：读得出三个键（引号去掉）" "85|/ /var/lib|/ /srv/x" "$(cat "$T/out")"
check "配置：文件不在 → 失败" 1 "$(rc_of bk_read_config "$T/nope" "$me" FLEET_DISK_ALERT_PERCENT)"
check "配置：文件不在 → 说读不到" 1 "$(bk_read_config "$T/nope" "$me" X 2>&1 | grep -c 读不到)"
check "配置：属主不对 → 失败" 1 "$(rc_of bk_read_config "$cfg" "$((me + 1))" "${BK_CONFIG_KEYS_FRANCE[@]}")"
printf 'FLEET_DISK_ALERT_PERCENT=85\nWHO=me\n' >"$T/unknown.env"
check "配置：不认识的键 → 失败" 1 "$(rc_of bk_read_config "$T/unknown.env" "$me" "${BK_CONFIG_KEYS_FRANCE[@]}")"
printf 'FLEET_DISK_ALERT_PERCENT 85\n' >"$T/garbled.env"
check "配置：看不懂的行 → 失败" 1 "$(rc_of bk_read_config "$T/garbled.env" "$me" "${BK_CONFIG_KEYS_FRANCE[@]}")"
cp "$cfg" "$T/gw.env"
chmod 664 "$T/gw.env"
if [[ "$(stat -c '%a' "$T/gw.env")" == 664 ]]; then
  check "配置：组能写 → 失败" 1 "$(rc_of bk_read_config "$T/gw.env" "$me" "${BK_CONFIG_KEYS_FRANCE[@]}")"
fi

cfg_case() { # 线 法国路径 香港路径 → 0/1
  (
    FLEET_DISK_ALERT_PERCENT=$1 FLEET_DISK_PATHS_FRANCE=$2 FLEET_DISK_PATHS_HK=$3
    rc_of bk_check_france_config
  )
}
check "配置：85 合格" 0 "$(cfg_case 85 / /)"
check "配置：线 0 → 失败" 1 "$(cfg_case 0 / /)"
check "配置：线 100 → 失败" 1 "$(cfg_case 100 / /)"
check "配置：线不是数 → 失败" 1 "$(cfg_case abc / /)"
check "配置：线没写 → 失败" 1 "$(cfg_case '' / /)"
check "配置：香港路径空着 → 失败（不当成没东西可看）" 1 "$(cfg_case 85 / ' ')"
check "配置：相对路径 → 失败" 1 "$(cfg_case 85 var /)"
check "配置：路径带分号 → 失败（要原样写进 sftp 命令）" 1 "$(cfg_case 85 / '/a;rm')"

# ── 小零件 ──

check "用量：25/75 → 25%" 25 "$(bk_usage_pct 25 75)"
check "用量：向上取整" 34 "$(bk_usage_pct 1 2)"
check "用量：全是 0 → 失败" 1 "$(rc_of bk_usage_pct 0 0)"
check "用量：不是数 → 失败" 1 "$(rc_of bk_usage_pct x 1)"

df_ok=$'     Used     Avail Mounted on\n 50212344 152058192 /'
check "df：认出已用、可用、挂载点" "50212344 152058192 /" "$(bk_parse_df <<<"$df_ok")"
check "df：空的 → 失败" 1 "$(rc_of bk_parse_df <<<"")"
check "df：只有表头 → 失败" 1 "$(rc_of bk_parse_df <<<"     Used     Avail Mounted on")"
check "df：数字不是数字 → 失败" 1 "$(rc_of bk_parse_df <<<$'     Used     Avail Mounted on\n x y /')"

# 法国经隧道对香港跑 `sftp -b -` 的真实输出（2026-09-25，OpenSSH 9.6 客户端、8.9 服务端）
sftp_ok=$(<"$HERE/fixtures/sftp-df.txt")
check "sftp df：两个路径都认出来" "$(printf '/\t13915712\t26526588\n/srv/fleet-dao-backup\t13915712\t26526588')" "$(bk_parse_sftp_df <<<"$sftp_ok")"
check "sftp df：空的 → 失败" 1 "$(rc_of bk_parse_sftp_df <<<"")"
check "sftp df：只有报错 → 失败" 1 "$(rc_of bk_parse_sftp_df <<<"Connection closed")"
check "sftp df：少一个路径的数 → 只认出另一个" "/srv/fleet-dao-backup" \
  "$(bk_parse_sftp_df <<<$'sftp> df /\nCouldn\x27t statvfs\nsftp> df /srv/fleet-dao-backup\n    1     2     3     4    50%' | cut -f1)"

check "快照名：合格" 0 "$(rc_of bk_valid_snapshot_name 00000003-0000001B-1)"
check "快照名：空的 → 不认" 1 "$(rc_of bk_valid_snapshot_name "")"
check "快照名：报错文字 → 不认" 1 "$(rc_of bk_valid_snapshot_name "ERROR: x")"
check "Temporal 口令：48 位十六进制" 0 "$(rc_of bk_valid_temporal_password "$(printf 'a%.0s' {1..48})")"
check "Temporal 口令：带冒号 → 不认（要原样写进 pgpass）" 1 "$(rc_of bk_valid_temporal_password "a:b")"
check "公钥：ed25519 带注释" 0 "$(rc_of bk_valid_pubkey "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc+/= fleet-dao-backup")"
check "公钥：rsa → 不认" 1 "$(rc_of bk_valid_pubkey "ssh-rsa AAAAB3Nza")"
check "公钥：带选项的整行 → 不认" 1 "$(rc_of bk_valid_pubkey 'command="sh" ssh-ed25519 AAAA')"
check "authorized_keys 那一行：只许隧道、restrict、只有 sftp" \
  'from="10.99.0.2",restrict,command="internal-sftp -d /srv/fleet-dao-backup/restic" ssh-ed25519 AAAA x' \
  "$(bk_authorized_line "ssh-ed25519 AAAA x")"

check "报错收成一行：去掉回车换行和结尾空白" "a b c" "$(printf 'a\r\nb\nc\n\n' | bk_oneline)"
long=$(printf '备份%.0s' {1..300})
short=$(printf '%s' "$long" | bk_oneline)
check "报错收成一行：最长 400 字再加省略号" 401 "$(LC_ALL=C.UTF-8 bash -c 'printf "%s" "${#1}"' _ "$short")"
check "报错收成一行：截断不切在字中间" 0 "$(rc_of iconv -f UTF-8 -t UTF-8 <<<"$short")"
check "报错收成一行：不成字的字节丢掉" "ab" "$(printf 'a\xffb' | bk_oneline)"
check "拼接：中间放分隔、结尾不放" "a；b" "$(bk_join '；' a b)"
check "任务名：认识的" 每晚备份（法国的库加密传到香港） "$(bk_job_name backup.nightly)"
check "任务名：不认识的原样" x.y "$(bk_job_name x.y)"

# ── 清单 ──

printf 'fleet\tpublic.a\trows\t2\nfleet\tpublic.a\tmax:at\t2026-09-25 01:02:03+00\ntemporal\tpublic.b\trows\t9\n' >"$T/manifest.tsv"
bk_manifest_for fleet <"$T/manifest.tsv" >"$T/want"
check "清单：只挑出一个库、去掉库那一列" "$(printf 'public.a\trows\t2\npublic.a\tmax:at\t2026-09-25 01:02:03+00')" "$(cat "$T/want")"
cp "$T/want" "$T/got"
check "清单：一样 → 0" 0 "$(bk_manifest_diff "$T/want" "$T/got" >/dev/null 2>&1; echo $?)"
printf 'public.a\trows\t3\npublic.a\tmax:at\t2026-09-25 01:02:03+00\n' >"$T/got"
check "清单：行数不一样 → 1" 1 "$(bk_manifest_diff "$T/want" "$T/got" >/dev/null 2>&1; echo $?)"
check "清单：说出哪张表差多少" "表 public.a 的行数：备份时 2，恢复后 3" "$(bk_manifest_diff "$T/want" "$T/got" 2>&1)"
printf 'public.a\trows\t2\n' >"$T/got"
check "清单：恢复后少了一项 → 说出来" "表 public.a 的 at 最新值：备份时 2026-09-25 01:02:03+00，恢复后没有这一项" "$(bk_manifest_diff "$T/want" "$T/got" 2>&1)"
printf 'public.a\trows\t2\npublic.a\tmax:at\t2026-09-25 01:02:03+00\npublic.z\trows\t0\n' >"$T/got"
check "清单：恢复后多一张表 → 说出来" "表 public.z 的行数：恢复后多出来（备份时没有）" "$(bk_manifest_diff "$T/want" "$T/got" 2>&1)"
printf 'public.a\trows\n' >"$T/got"
check "清单：认不出的行 → 1" 1 "$(bk_manifest_diff "$T/want" "$T/got" >/dev/null 2>&1; echo $?)"
: >"$T/empty"
check "清单：备份时的是空的 → 2（没读成，不是对上了）" 2 "$(bk_manifest_diff "$T/empty" "$T/want" >/dev/null 2>&1; echo $?)"
check "清单：恢复后的是空的 → 2" 2 "$(bk_manifest_diff "$T/want" "$T/empty" >/dev/null 2>&1; echo $?)"
check "清单：文件不在 → 2" 2 "$(bk_manifest_diff "$T/nope" "$T/want" >/dev/null 2>&1; echo $?)"

check "结局：扫到、没问题 → ok" ok "$(bk_outcome 3 0 0)"
check "结局：扫到、有问题 → ok（查出问题不算没做成）" ok "$(bk_outcome 3 1 0)"
check "结局：有没查成的 → partial" partial "$(bk_outcome 3 0 1)"
check "结局：全没查成 → failed" failed "$(bk_outcome 0 0 2)"
check "结局：一个都没扫到 → unscanned" unscanned "$(bk_outcome 0 0 0)"

# ── restic 的 JSON（要 node）──

HAVE_NODE=0
if command -v node >/dev/null; then HAVE_NODE=1; fi
if ((HAVE_NODE)); then
  check "restic 总结：取快照编号和文件数" "$(printf 'abc123\t4')" \
    "$(printf '%s\n' '{"message_type":"status"}' '{"message_type":"summary","snapshot_id":"abc123","total_files_processed":4}' | bk_restic_summary)"
  check "restic 总结：没有总结行 → 失败" 1 "$(rc_of bk_restic_summary <<<'{"message_type":"status"}')"
  check "restic 总结：不是 JSON → 失败" 1 "$(rc_of bk_restic_summary <<<'Fatal: boom')"
  check "restic 快照：一份都没有 → none" none "$(bk_restic_latest 2026-09-25T12:00:00+08:00 <<<'[]')"
  check "restic 快照：取最新一份、算出几小时前" "$(printf 'b\t2026-09-25T09:00:00+08:00\t3')" \
    "$(bk_restic_latest 2026-09-25T12:00:00+08:00 <<<'[{"id":"a","time":"2026-09-24T04:10:00+08:00"},{"id":"b","time":"2026-09-25T09:00:00+08:00"}]')"
  check "restic 快照：不是数组 → 失败" 1 "$(rc_of bk_restic_latest 2026-09-25T12:00:00+08:00 <<<'{}')"
  check "restic 快照：缺时间 → 失败" 1 "$(rc_of bk_restic_latest 2026-09-25T12:00:00+08:00 <<<'[{"id":"a"}]')"
  check "restic 快照：读不到 → 失败" 1 "$(rc_of bk_restic_latest 2026-09-25T12:00:00+08:00 </dev/null)"
else
  echo "没跑成：这台没有 node，restic 输出的解析和三个任务的流程没测"
  skipped=1
fi

# ── 单元与登记对得上 ──

for u in "$BK"/units/*.service; do
  n=${u##*/}
  check "$n 以 fleet 跑" fleet "$(awk -F= '$1 == "User" { print $2 }' "$u")"
  check "$n 是 oneshot" oneshot "$(awk -F= '$1 == "Type" { print $2 }' "$u")"
  check "$n 只写自己的目录" "$BK_STATE" "$(awk -F= '$1 == "ReadWritePaths" { print $2 }' "$u")"
  check "$n 跑装好的任务脚本" "$BK_LIB_DIR/fleet-backup.sh" "$(awk -F= '$1 == "ExecStart" { split($2, a, " "); print a[1] }' "$u")"
  [[ -f "${u%.service}.timer" ]] || check "$n 有配套的定时器" "${u%.service}.timer" 没有
done
cal_of() { awk -F= '$1 == "OnCalendar" { print $2 }' "$BK/units/$1"; }
for t in "$BK"/units/*.timer; do
  n=${t##*/}
  check "$n 带时区" 1 "$(cal_of "$n" | grep -c ' Asia/Shanghai$')"
  check "$n 错过了开机补跑" true "$(awk -F= '$1 == "Persistent" { print $2 }' "$t")"
done
check "每晚备份的时刻" "*-*-* 04:10:00 Asia/Shanghai" "$(cal_of fleet-backup.timer)"
check "登记的是每天 04:10" 1 "$(grep -c '^backup.nightly|[^|]*|每天 04:10（北京时间）|' < <(printf '%s\n' "${BK_JOBS[@]}"))"
check "恢复演练的时刻" "Sun *-*-* 05:40:00 Asia/Shanghai" "$(cal_of fleet-backup-drill.timer)"
check "登记的是每周日 05:40" 1 "$(grep -c '^backup.drill|[^|]*|每周日 05:40（北京时间）|' < <(printf '%s\n' "${BK_JOBS[@]}"))"
check "巡检的时刻" "*-*-* *:17:00 Asia/Shanghai" "$(cal_of fleet-backup-watch.timer)"
check "登记的是每小时 17 分" 1 "$(grep -c '^backup.watch|[^|]*|每小时 17 分|' < <(printf '%s\n' "${BK_JOBS[@]}"))"
if command -v systemd-analyze >/dev/null && systemd-analyze calendar '*-*-* 04:10:00 Asia/Shanghai' >/dev/null 2>&1; then
  for t in "$BK"/units/*.timer; do
    check "${t##*/} 的 OnCalendar systemd 认得" 0 "$(rc_of systemd-analyze calendar "$(cal_of "${t##*/}")")"
  done
else
  echo "没跑成：这台没有能用的 systemd-analyze，OnCalendar 写法没让 systemd 认一遍"
  skipped=1
fi

# ── 三个任务的分支（替身：不碰库、不连网）──

reset_env() {
  rm -rf -- "$T/s"
  mkdir -p "$T/s/etc" "$T/s/state"
  : >"$T/log"
  BK_STATE=$T/s/state NIGHTLY=$T/s/state/nightly DRILL=$T/s/state/drill WATCH=$T/s/state/watch
  BK_WORK=$NIGHTLY/dumps
  BK_PASS_FILE=$T/s/etc/restic.pass BK_KEY=$T/s/etc/key BK_KNOWN_HOSTS=$T/s/etc/known BK_RESTIC=$T/s/etc/restic
  BK_TEMPORAL_ENV=$T/s/etc/temporal.env BK_CONFIG=$T/s/etc/backup.env BK_CONFIG_UID=$me
  local f
  for f in "$BK_PASS_FILE" "$BK_KEY" "$BK_KNOWN_HOSTS" "$BK_RESTIC"; do echo x >"$f"; done
  printf 'FLEET_TEMPORAL_DB_PASSWORD=%s\n' "$(printf 'a%.0s' {1..48})" >"$BK_TEMPORAL_ENV"
  printf '%s\n' FLEET_DISK_ALERT_PERCENT=85 'FLEET_DISK_PATHS_FRANCE=/ /var' 'FLEET_DISK_PATHS_HK=/ /srv/fleet-dao-backup' >"$BK_CONFIG"
  chmod 644 "$BK_TEMPORAL_ENV" "$BK_CONFIG"
  RUN_ID="" RUN_DONE=0 CLEANUP=""
}

# 运行记录、报警、锁换成往 $T/log 里记一行；退出时照正式那样收尾（清暂存）
stub_books() {
  trap on_exit EXIT
  take_lock() { :; }
  run_start() { RUN_ID=7 RUN_JOB=$1 RUN_UNIT=$2 RUN_NAME=$3; }
  run_end_sql() { printf 'end %s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >>"$T/log"; }
  alert_raise() { printf 'raise %s|%s|%s\n' "$1" "$2" "$3" >>"$T/log"; }
  alert_resolve() { printf 'resolve %s\n' "$1" >>"$T/log"; }
}

ended() { grep '^end ' "$T/log" | cut -c5-; }
raised() { grep '^raise ' "$T/log" | cut -c7- | cut -d'|' -f1 | sort | paste -sd ' ' -; }
resolved() { grep '^resolve ' "$T/log" | cut -c9- | sort | paste -sd ' ' -; }

# 每晚备份的替身：导出照写文件和清单；restic 按 RS_* 决定成败
stub_backup() { # backup 退出码 forget 退出码 快照里几个文件 哪个库导不出
  RS_BACKUP=$1 RS_FORGET=$2 RS_FILES=$3 RS_BADDB=${4:-}
  dump_db() {
    if [[ "$1" == "$RS_BADDB" ]]; then
      echo "pg_dump 退出码 1：connection refused"
      return 1
    fi
    printf 'dump %s\n' "$1" >"$2/$1.dump"
    printf '%s\tpublic.t\trows\t1\n' "$1" >>"$2/manifest.tsv"
  }
  restic_() {
    case $1 in
    backup)
      if ((RS_BACKUP)); then
        echo "Fatal: backup boom" >&2
        return 1
      fi
      printf '{"message_type":"summary","snapshot_id":"abcdef1234567890","total_files_processed":%s}\n' "$RS_FILES"
      ;;
    forget)
      if ((RS_FORGET)); then
        echo "Fatal: forget boom" >&2
        return 1
      fi
      ;;
    esac
  }
}

if ((HAVE_NODE)); then
  reset_env
  (
    stub_books
    stub_backup 0 0 4
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：都成了 → 退出 0" 0 "$RC"
  check "备份：都成了 → 记 ok、扫到 3 个库" "ok|3|0" "$(ended | cut -d'|' -f1-3)"
  check "备份：都成了 → 解除没做成的报警" backup.nightly:run "$(resolved)"
  check "备份：都成了 → 不留导出的文件" 0 "$(find "$T/s/state" -name '*.dump' | wc -l)"

  reset_env
  (
    stub_books
    stub_backup 1 0 4
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：传不上去 → 退出 1（systemd 隔一会儿重试）" 1 "$RC"
  check "备份：传不上去 → 记没做成和原因" "failed|||传到香港没成：Fatal: backup boom" "$(ended)"
  check "备份：传不上去 → 报警" backup.nightly:run "$(raised)"
  check "备份：传不上去 → 也不留导出的文件" 0 "$(find "$T/s/state" -name '*.dump' | wc -l)"

  reset_env
  (
    stub_books
    stub_backup 0 1 4
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：过期的没删成 → 退出 0（备份已经存上了）" 0 "$RC"
  check "备份：过期的没删成 → 记 partial" "partial|3|0" "$(ended | cut -d'|' -f1-3)"
  check "备份：过期的没删成 → 报警" backup.nightly:run "$(raised)"

  reset_env
  (
    stub_books
    stub_backup 0 0 3
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：快照里少了文件 → 没做成" "1 failed" "$RC $(ended | cut -d'|' -f1)"

  reset_env
  (
    stub_books
    stub_backup 0 0 4 temporal
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：一个库导不出 → 没做成，说是哪个库" "1 failed|||库 temporal 没导出来：pg_dump 退出码 1：connection refused" "$RC $(ended)"

  reset_env
  rm -f -- "$BK_TEMPORAL_ENV"
  (
    stub_books
    stub_backup 0 0 4
    cmd_backup
  ) >"$T/out" 2>&1
  RC=$?
  check "备份：库口令读不到 → 没做成" "1 failed" "$RC $(ended | cut -d'|' -f1)"
  check "备份：库口令读不到 → 说读不到哪个" 1 "$(ended | grep -c "读不到 $BK_TEMPORAL_ENV")"

  # 恢复演练的替身：香港有哪些快照、取回成不成；取回时照清单写出三个库的导出
  stub_drill() { # 快照列表 JSON；取回退出码；自检退出码
    RS_SNAPS=$1 RS_RESTORE=$2 RS_CHECK=${3:-0}
    restic_() {
      case $1 in
      snapshots) printf '%s\n' "$RS_SNAPS" ;;
      restore)
        if ((RS_RESTORE)); then
          echo "Fatal: restore boom" >&2
          return 1
        fi
        local d
        mkdir -p "$4"
        for d in "${BK_DATABASES[@]}"; do
          printf 'dump %s\n' "$d" >"$4/$d.dump"
          printf '%s\tpublic.t\trows\t1\n' "$d" >>"$4/manifest.tsv"
        done
        ;;
      check) return "$RS_CHECK" ;;
      esac
    }
    space_ok() { :; }
    drop_drill_db() { :; }
    restore_db() { [[ "$1" != *"/${BAD_RESTORE:-none}.dump" ]]; }
    # 数恢复出来的库：MISMATCH 点名的库行数对不上
    count_drill_db() {
      if [[ "$db" == "${MISMATCH:-none}" ]]; then printf 'public.t\trows\t999\n'; else printf 'public.t\trows\t1\n'; fi
    }
  }
  one_snap='[{"id":"0123456789abcdef","time":"2026-09-25T04:10:03+08:00"}]'

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 0
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：三个库都对上 → 记 ok、扫到 3、问题 0" "0 ok|3|0" "$RC $(ended | cut -d'|' -f1-3)"
  check "演练：都对上 → 解除两种报警" "backup.drill:mismatch backup.drill:run" "$(resolved)"
  check "演练：跑完不留取回的文件" 0 "$(find "$T/s/state" -name '*.dump' | wc -l)"

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 0
    MISMATCH=temporal
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：一个库对不上 → 查出问题，任务照样算跑成" "0 ok|3|1" "$RC $(ended | cut -d'|' -f1-3)"
  check "演练：对不上 → 发「对不上」的报警" backup.drill:mismatch "$(raised)"
  check "演练：报警说出哪张表" 1 "$(grep -c '表 public.t 的行数：备份时 1，恢复后 999' "$T/log")"

  reset_env
  (
    stub_books
    stub_drill '[]' 0
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：香港一份备份都没有 → unscanned，报警" "0 unscanned|0| backup.drill:run" "$RC $(ended | cut -d'|' -f1-3) $(raised)"

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 1
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：取不回来 → 没做成" "1 failed" "$RC $(ended | cut -d'|' -f1)"

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 0
    BAD_RESTORE=fleet
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：一个库恢复不进去 → partial，扫到 2" "0 partial|2|0" "$RC $(ended | cut -d'|' -f1-3)"
  check "演练：恢复不进去 → 报警" backup.drill:run "$(raised)"

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 0 1
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：仓库自检没过 → partial" "0 partial|3|0" "$RC $(ended | cut -d'|' -f1-3)"

  reset_env
  (
    stub_books
    stub_drill "$one_snap" 0
    space_ok() { echo "/var/lib/postgresql 只剩 10M，演练要 2000M"; return 1; }
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：盘不够 → 不练，没做成并说原因" "1 failed|||/var/lib/postgresql 只剩 10M，演练要 2000M" "$RC $(ended)"

  reset_env
  (
    stub_books
    stub_drill 'Fatal: garbage' 0
    cmd_drill
  ) >"$T/out" 2>&1
  RC=$?
  check "演练：快照清单认不出 → 没做成（不当成没有备份）" "1 failed" "$RC $(ended | cut -d'|' -f1)"
fi

# 巡检的替身：df、sftp、登记表按 DF_*、SFTP_*、AGE_* 决定
stub_watch() {
  df() { printf '     Used     Avail Mounted on\n%s %s /\n' "${DF_USED:-25}" "${DF_AVAIL:-75}"; }
  sftp() {
    cat >/dev/null
    if ((${SFTP_FAIL:-0})); then
      echo "fleet-backup@10.99.0.1: Permission denied (publickey)." >&2
      return 255
    fi
    cat "$HERE/fixtures/sftp-df.txt"
  }
  bk_sql() { printf 'backup.drill\t10200\t%s\nbackup.nightly\t1560\t%s\n' "${AGE_DRILL:-3600}" "${AGE_NIGHTLY:-3600}"; }
}

reset_env
(
  stub_books
  stub_watch
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：都正常 → ok，法国一块盘（两个路径同一块）+ 香港一块 + 两个任务" "0 ok|4|0" "$RC $(ended | cut -d'|' -f1-3)"
check "巡检：都正常 → 解除所有相关报警" "backup.watch:run disk:france:/ disk:hk:/ stale:backup.drill stale:backup.nightly" "$(resolved)"

reset_env
(
  stub_books
  stub_watch
  DF_USED=90 DF_AVAIL=10
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：法国盘到线 → 查出 1 个问题、任务照样 ok" "0 ok|4|1" "$RC $(ended | cut -d'|' -f1-3)"
check "巡检：到线 → 报法国那块盘" disk:france:/ "$(raised)"

reset_env
(
  stub_books
  stub_watch
  SFTP_FAIL=1
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：香港连不上 → partial，香港两个路径都算没查成" "0 partial|3|0" "$RC $(ended | cut -d'|' -f1-3)"
check "巡检：香港连不上 → 原因里说连不上" 2 "$(ended | grep -o '连不上' | wc -l)"
check "巡检：香港连不上 → 报这一轮没做全，不去解除香港那块盘的报警" "backup.watch:run" "$(raised)"
check "巡检：香港连不上 → 香港的盘不当成正常" "" "$(resolved | grep -o 'disk:hk:[^ ]*')"

reset_env
(
  stub_books
  stub_watch
  AGE_NIGHTLY=never AGE_DRILL=700000
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：每晚备份从没跑过、演练过期 → 两个问题" "0 ok|4|2" "$RC $(ended | cut -d'|' -f1-3)"
check "巡检：两个都报" "stale:backup.drill stale:backup.nightly" "$(raised)"

reset_env
(
  stub_books
  stub_watch
  bk_sql() { echo "psql: connection refused" >&2; return 2; }
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：登记表读不到 → partial（不当成没过期）" "0 partial|2|0" "$RC $(ended | cut -d'|' -f1-3)"

reset_env
rm -f -- "$BK_CONFIG"
(
  stub_books
  stub_watch
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：配置读不到 → 没做成" "1 failed" "$RC $(ended | cut -d'|' -f1)"

reset_env
(
  stub_books
  stub_watch
  df() { echo "df: /var: No such file or directory" >&2; return 1; }
  sftp() {
    cat >/dev/null
    return 255
  }
  bk_sql() { return 2; }
  cmd_watch
) >"$T/out" 2>&1
RC=$?
check "巡检：什么都没查成 → 没做成" "1 failed" "$RC $(ended | cut -d'|' -f1)"

printf '备份的测试：通过 %d 条，不通过 %d 条\n' "$passes" "$fails"
if ((fails)); then exit 1; fi
if ((skipped)); then exit 2; fi
