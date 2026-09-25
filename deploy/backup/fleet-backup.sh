#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 备份的定时任务本体（法国，以 fleet 跑，由 units/ 里的定时器经 systemd 拉起）：
#   fleet-backup.sh backup  每晚：三个库各导一份（行数清单和导出用同一个快照），restic 加密后经隧道存进香港，按 7 日 + 4 周删过期的
#   fleet-backup.sh drill   每周：把最近一份从香港取回来，逐个恢复进临时库，核对每张表的行数和各时间列的最新值，删掉临时库
#   fleet-backup.sh watch   每小时：两台机器的磁盘用量；前两个任务多久没跑了
# 每跑一次在 schedule_runs 记一行（四种结局见 packages/db/src/queries/schedule.ts）；没做成的、查出问题的在 notifications
# 发报警，好了自动解除。退出码：没做成 1（systemd 隔一会儿重试），其余 0——「查出问题」不算任务失败（docs/reference/deploy.md P12）。
# 由 deploy/backup/install.sh 装到 /usr/local/lib/fleet-dao/backup/；改这份、再跑一遍装机脚本，别在机器上手改。
set -uo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
BK_HERE=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=lib.sh
source "$BK_HERE/lib.sh"

NIGHTLY=$BK_STATE/nightly # 每晚那个任务的暂存：导出的三个库和清单（$BK_WORK）、连库口令、报错
DRILL=$BK_STATE/drill
WATCH=$BK_STATE/watch

RUN_ID=""
RUN_JOB=""
RUN_UNIT=""
RUN_NAME=""
RUN_DONE=0
CLEANUP=""

# ── 记账：运行记录与报警 ──

# 以 fleet 经本机 socket 连库（peer 认证）。SQL 从标准输入读；值一律用 -v 传、在 SQL 里写 :'名字'，由 psql 加引号。
bk_sql() { # 库 psql 参数…
  local db=$1
  shift
  PGHOST=/var/run/postgresql PGUSER=fleet PGCONNECT_TIMEOUT=10 psql -X -q -tA -F $'\t' -v ON_ERROR_STOP=1 -d "$db" "$@" -f -
}

run_start() { # 任务编号 单元 给人看的名字
  RUN_JOB=$1 RUN_UNIT=$2 RUN_NAME=$3
  local id
  id=$(bk_sql fleet -v job="$RUN_JOB" <<<"insert into schedule_runs (job) values (:'job') returning id;") || id=""
  if [[ ! "$id" =~ ^[0-9]+$ ]]; then
    echo "运行记录记不上开头（库连不上，或任务 $RUN_JOB 没登记：跑一遍 install.sh france）" >&2
    exit 1
  fi
  RUN_ID=$id
}

run_end_sql() { # 结局 扫到 问题 原因
  bk_sql fleet -v id="$RUN_ID" -v outcome="$1" -v scanned="$2" -v found="$3" -v why="$4" <<'SQL'
update schedule_runs
set ended_at = now(), outcome = :'outcome'::schedule_outcome, scanned = nullif(:'scanned', '')::int,
  found = nullif(:'found', '')::int, why = nullif(:'why', '')
where id = :'id'::bigint and ended_at is null;
SQL
}

run_end() { # 结局 扫到 问题 原因（空的记成 null）
  RUN_DONE=1
  if run_end_sql "$@"; then return 0; fi
  # 原因本身写不进去（比如夹了库不认的字节）也得把这一轮收上，不然它永远挂着「还在跑」
  echo "运行记录记不上结局（$1：$4），改记一句短的" >&2
  run_end_sql "$1" "$2" "$3" "原因写不进库，看法国 journalctl -u $RUN_UNIT" && return 0
  echo "运行记录还是记不上结局" >&2
  return 1
}

# 报警：同一件事（前缀相同）还开着就原地改那一条，没有开着的才新开一条——好了再坏是新的一件事，发新卡，不去翻旧卡。
# 正文写不进库（比如夹了库不认的字节）就改记一句短的：报警可以说得粗，但不能悄悄丢掉
alert_raise() { # 前缀 标题 正文
  echo "报警：$2 —— $3" >&2
  if alert_raise_sql "$@"; then return 0; fi
  echo "报警写不进库，改记一句短的" >&2
  alert_raise_sql "$1" "$2" "正文写不进库，看法国 journalctl -u $RUN_UNIT" && return 0
  echo "报警还是写不进库：$2" >&2
  return 1
}

alert_raise_sql() { # 前缀 标题 正文
  bk_sql fleet -v prefix="$1" -v title="$2" -v body="$3" -v run="$RUN_ID" -v link="$BK_LINK" <<'SQL' >/dev/null
with cur as (
  select id from notifications
  where starts_with(dedupe_key, :'prefix' || ':') and resolved_at is null
  order by created_at desc
  limit 1
), upd as (
  update notifications n set title = :'title', body = :'body', updated_at = now()
  from cur where n.id = cur.id
  returning n.id
)
insert into notifications (level, dedupe_key, title, body, link)
select 'alert'::notification_level, :'prefix' || ':run' || :'run', :'title', :'body', :'link'
where not exists (select 1 from upd);
SQL
}

alert_resolve() { # 前缀
  bk_sql fleet -v prefix="$1" -v by="$BK_RESOLVER" <<'SQL' >/dev/null
update notifications set resolved_at = now(), resolved_by = :'by', updated_at = now()
where starts_with(dedupe_key, :'prefix' || ':') and resolved_at is null;
SQL
}

# 收尾：记结局；ok 解除这个任务「没做成」的报警，别的结局发一条（还开着就原地更新）。没做成返回 1。
finish() { # 结局 扫到 问题 原因
  local outcome=$1 why=$4 title
  run_end "$@" || true
  case $outcome in
  ok) alert_resolve "$RUN_JOB:run" || true ;;
  *)
    case $outcome in
    failed) title="${RUN_NAME}没做成" ;;
    partial) title="${RUN_NAME}有一部分没做成" ;;
    *) title="${RUN_NAME}一个对象都没扫到" ;;
    esac
    alert_raise "$RUN_JOB:run" "$title" "$why。现场：法国 journalctl -u $RUN_UNIT" || true
    ;;
  esac
  echo "结局 $outcome：${why:-（无）}"
  [[ "$outcome" != failed ]]
}

bail() { # 原因
  finish failed "" "" "$1"
  exit 1
}

on_exit() {
  local rc=$?
  if [[ -n "$RUN_ID" ]] && ((RUN_DONE == 0)); then
    finish failed "" "" "跑到一半意外退出（退出码 $rc）" || true
    rc=1
  fi
  if [[ -n "$CLEANUP" ]]; then "$CLEANUP" || true; fi
  exit "$rc"
}

# 同一个任务同时只跑一个：手动跑撞上定时器那一轮时，这边让开（那一轮会记运行记录）
take_lock() { # 名字
  if ! exec 9>"$BK_STATE/$1.lock"; then
    echo "开不了锁文件 $BK_STATE/$1.lock" >&2
    exit 1
  fi
  if ! flock -n 9; then
    echo "上一轮 $1 还在跑，这轮让开" >&2
    exit 0
  fi
}

# ── 小零件 ──

tail_of() { tail -n 5 -- "$1" 2>/dev/null | bk_oneline; }

# 缺哪个打印哪个，返回 1
need_readable() { # 文件…
  local f missing=()
  for f in "$@"; do [[ -r "$f" && -s "$f" ]] || missing+=("$f"); done
  if ((${#missing[@]})); then
    echo "读不到 ${missing[*]}（跑一遍 install.sh france）"
    return 1
  fi
}

human() { numfmt --to=iec --from-unit=1024 "$1" 2>/dev/null || echo "${1}K"; }

ssh_opts() { read -r -a SSH_OPTS <<<"$(bk_ssh_opts)"; }

restic_() {
  "$BK_RESTIC" --repo "sftp:$BK_HK_USER@$BK_HK_ADDR:$BK_REPO_PATH" --password-file "$BK_PASS_FILE" \
    --cache-dir "$BK_STATE/cache" --retry-lock 30m \
    -o sftp.command="ssh $(bk_ssh_opts) $BK_HK_USER@$BK_HK_ADDR -s sftp" "$@"
}

# 断网、被杀的那一轮会在香港仓库里留下锁，restic 不会自己清；留下独占锁的话，之后每次都干等 30 分钟再失败，
# systemd 重试也白搭。开跑前先清掉失效的锁：unlock 不带 --remove-all 只清失效的（没在刷新的、本机上进程已经没了的），
# 还在跑的那一边每 5 分钟刷新一次，清不到它。清不成不算没做成：真连不上，下面那一步会说清楚
unlock_stale() { # 放报错的暂存目录
  if ! restic_ unlock >/dev/null 2>"$1/unlock.err"; then
    echo "清失效的锁没成（接着跑）：$(tail_of "$1/unlock.err")"
  fi
}

# 连哪个库用什么身份：fleet 走本机 socket 的 peer（fleet 就是库属主）；Temporal 的两个库用 temporal 角色经 127.0.0.1 + 口令
db_env() { # 库 pgpass 文件
  case $1 in
  fleet) printf '%s\n' PGHOST=/var/run/postgresql PGUSER=fleet PGCONNECT_TIMEOUT=10 ;;
  temporal | temporal_visibility) printf '%s\n' PGHOST=127.0.0.1 PGPORT=5432 PGUSER=temporal "PGPASSFILE=$2" PGCONNECT_TIMEOUT=10 ;;
  *) return 1 ;;
  esac
}

# ── backup ──

# 导一个库：先开只读事务导出快照，在这个快照里数清单，pg_dump 再用同一个快照导——清单和导出的是同一刻的库。
# 清单追加到 输出目录/manifest.tsv；报错写 stdout（调用方收进运行记录）。
dump_db() { # 库 输出目录 暂存目录 pgpass
  local db=$1 out=$2 tmp=$3 snap="" line n=0 ended=0 rc=0 to from pid
  local -a envs
  mapfile -t envs < <(db_env "$db" "$4")
  if ((${#envs[@]} == 0)); then
    echo "不认识的库 $db"
    return 1
  fi
  coproc HOLD { exec env "${envs[@]}" psql -X -q -tA -F $'\t' -v ON_ERROR_STOP=1 -d "$db" 2>"$tmp/hold.err"; }
  pid=$HOLD_PID to=${HOLD[1]} from=${HOLD[0]}
  printf '%s\n' "begin isolation level repeatable read, read only;" "set local timezone = 'UTC';" \
    "set local datestyle = 'ISO, YMD';" "select pg_export_snapshot();" >&"$to"
  read -r -t 60 -u "$from" snap || true
  if ! bk_valid_snapshot_name "$snap"; then
    echo "开不出快照（读到「$snap」）：$(tail_of "$tmp/hold.err")"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    return 1
  fi
  # 结束标记用 select 打：psql 每打完一个查询结果就 flush，\echo 不一定，走管道时会卡在缓冲里
  printf '%s\n' "$BK_MANIFEST_SQL" "select '__manifest_end__';" >&"$to"
  while read -r -t 3600 -u "$from" line; do
    if [[ "$line" == __manifest_end__ ]]; then
      ended=1
      break
    fi
    printf '%s\t%s\n' "$db" "$line" >>"$out/manifest.tsv"
    n=$((n + 1))
  done
  if ((ended == 0 || n == 0)); then
    echo "清单没数完（数到 $n 行）：$(tail_of "$tmp/hold.err")"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    return 1
  fi
  env "${envs[@]}" pg_dump --snapshot="$snap" -Fc -Z 0 -f "$out/$db.dump" -d "$db" 2>"$tmp/dump.err" || rc=$?
  printf '%s\n' 'commit;' '\q' >&"$to"
  wait "$pid" || true
  if ((rc)); then
    echo "pg_dump 退出码 $rc：$(tail_of "$tmp/dump.err")"
    return 1
  fi
  echo "导出 $db：清单 $n 行"
}

cleanup_nightly() { rm -rf -- "$NIGHTLY"; }

cmd_backup() {
  take_lock nightly
  run_start backup.nightly fleet-backup.service 每晚备份
  CLEANUP=cleanup_nightly
  local miss out snap files db want=$((${#BK_DATABASES[@]} + 1))
  miss=$(need_readable "$BK_PASS_FILE" "$BK_KEY" "$BK_KNOWN_HOSTS" "$BK_TEMPORAL_ENV" "$BK_RESTIC") || bail "$miss"
  rm -rf -- "$NIGHTLY"
  mkdir -p -- "$BK_WORK" || bail "建不了暂存目录 $BK_WORK"
  unlock_stale "$NIGHTLY"
  bk_read_config "$BK_TEMPORAL_ENV" "$BK_CONFIG_UID" FLEET_TEMPORAL_DB_PASSWORD 2>"$NIGHTLY/err" || bail "$(tail_of "$NIGHTLY/err")"
  bk_valid_temporal_password "${FLEET_TEMPORAL_DB_PASSWORD:-}" || bail "$BK_TEMPORAL_ENV 里的口令不是装机脚本生成的样子"
  printf '127.0.0.1:5432:*:temporal:%s\n' "$FLEET_TEMPORAL_DB_PASSWORD" >"$NIGHTLY/pgpass"
  for db in "${BK_DATABASES[@]}"; do
    out=$(dump_db "$db" "$BK_WORK" "$NIGHTLY" "$NIGHTLY/pgpass") || bail "库 $db 没导出来：$out"
    echo "$out"
  done
  rm -f -- "$NIGHTLY/pgpass"
  out=$(restic_ backup --quiet --json --host "$BK_RESTIC_HOST" --tag "$BK_TAG" "$BK_WORK" 2>"$NIGHTLY/err") ||
    bail "传到香港没成：$(tail_of "$NIGHTLY/err")"
  IFS=$'\t' read -r snap files < <(bk_restic_summary <<<"$out") || bail "restic 说传完了，输出里却认不出快照编号"
  if [[ "$files" != "$want" ]]; then
    bail "快照 ${snap:0:8} 里有 $files 个文件，应有 $want 个（${#BK_DATABASES[@]} 个库的导出 + 清单）"
  fi
  echo "存进香港：快照 ${snap:0:8}"
  if ! restic_ forget --quiet --host "$BK_RESTIC_HOST" --tag "$BK_TAG" \
    --keep-daily "$BK_KEEP_DAILY" --keep-weekly "$BK_KEEP_WEEKLY" --prune >/dev/null 2>"$NIGHTLY/err"; then
    finish partial "${#BK_DATABASES[@]}" 0 "已存进香港（快照 ${snap:0:8}），过期的没删成：$(tail_of "$NIGHTLY/err")"
    return
  fi
  finish ok "${#BK_DATABASES[@]}" 0 "快照 ${snap:0:8}：${BK_DATABASES[*]} 都存进香港了，过期的已按 $BK_KEEP_DAILY 日 + $BK_KEEP_WEEKLY 周删掉"
}

# ── drill ──

drop_drill_db() {
  bk_sql postgres -v db="$BK_DRILL_DB" -v role="$BK_DRILL_ROLE" <<'SQL' >/dev/null
set role :"role";
drop database if exists :"db";
SQL
}

create_drill_db() {
  bk_sql postgres -v db="$BK_DRILL_DB" -v role="$BK_DRILL_ROLE" <<'SQL' >/dev/null
set role :"role";
create database :"db";
SQL
}

# 恢复进临时库：不带属主和授权（临时库里的东西都归演练角色），出一个错就停
restore_db() { # 导出文件
  create_drill_db || return 1
  PGHOST=/var/run/postgresql PGUSER=fleet PGCONNECT_TIMEOUT=10 pg_restore --exit-on-error --no-owner --no-privileges \
    --no-tablespaces --role="$BK_DRILL_ROLE" -d "$BK_DRILL_DB" "$1"
}

count_drill_db() {
  printf '%s\n' "set role \"$BK_DRILL_ROLE\";" "set timezone = 'UTC';" "set datestyle = 'ISO, YMD';" "$BK_MANIFEST_SQL" |
    bk_sql "$BK_DRILL_DB"
}

# 演练在本机恢复一份：临时库和取回的文件合起来约是线上库的两倍，再留 1G；不够就不练，免得把线上库所在的盘写满
space_ok() {
  local size need avail p
  size=$(bk_sql postgres -v dbs="${BK_DATABASES[*]}" <<<"select coalesce(sum(pg_database_size(datname)), 0)::bigint from pg_database where datname = any(string_to_array(:'dbs', ' '));") || size=""
  if [[ ! "$size" =~ ^[0-9]+$ ]] || ((size == 0)); then
    echo "读不到线上库有多大（「$size」）"
    return 1
  fi
  need=$((size * 2 + 1073741824))
  for p in /var/lib/postgresql "$BK_STATE"; do
    avail=$(df -B1 --output=avail -- "$p" 2>/dev/null) || avail=""
    avail=${avail##*$'\n'}
    avail=${avail//[[:space:]]/}
    if [[ ! "$avail" =~ ^[0-9]+$ ]]; then
      echo "读不到 $p 的剩余空间"
      return 1
    fi
    if ((avail < need)); then
      echo "$p 只剩 $((avail >> 20))M，演练要 $((need >> 20))M（线上库两倍 + 1G）"
      return 1
    fi
  done
}

cleanup_drill() {
  drop_drill_db >/dev/null 2>&1 || true
  rm -rf -- "$DRILL"
}

cmd_drill() {
  take_lock drill
  run_start backup.drill fleet-backup-drill.service 恢复演练
  CLEANUP=cleanup_drill
  local miss out latest snap when age db rc diff outcome summary verified=0 mismatched=0
  local -a problems=() details=()
  miss=$(need_readable "$BK_PASS_FILE" "$BK_KEY" "$BK_KNOWN_HOSTS" "$BK_RESTIC") || bail "$miss"
  rm -rf -- "$DRILL"
  mkdir -p -- "$DRILL/files" || bail "建不了暂存目录 $DRILL"
  drop_drill_db 2>"$DRILL/err" || bail "上次演练留下的临时库 $BK_DRILL_DB 删不掉：$(tail_of "$DRILL/err")"
  unlock_stale "$DRILL"
  out=$(restic_ snapshots --json --host "$BK_RESTIC_HOST" --tag "$BK_TAG" 2>"$DRILL/err") ||
    bail "列不出香港的备份：$(tail_of "$DRILL/err")"
  latest=$(bk_restic_latest "$(date -Is)" <<<"$out") || bail "香港的备份清单认不出"
  if [[ "$latest" == none ]]; then
    finish unscanned 0 "" "香港仓库里还没有备份，没东西可练"
    return
  fi
  IFS=$'\t' read -r snap when age <<<"$latest"
  out=$(space_ok) || bail "$out"
  restic_ restore "$snap:$BK_WORK" --target "$DRILL/files" >/dev/null 2>"$DRILL/err" ||
    bail "从香港取回快照 ${snap:0:8} 没成：$(tail_of "$DRILL/err")"
  if [[ ! -s "$DRILL/files/manifest.tsv" ]]; then bail "快照 ${snap:0:8} 里没有清单 manifest.tsv"; fi
  for db in "${BK_DATABASES[@]}"; do
    if [[ ! -s "$DRILL/files/$db.dump" ]]; then
      problems+=("快照里没有 $db 的导出")
      continue
    fi
    bk_manifest_for "$db" <"$DRILL/files/manifest.tsv" >"$DRILL/$db.want"
    if ! restore_db "$DRILL/files/$db.dump" >/dev/null 2>"$DRILL/err"; then
      problems+=("$db 恢复不进临时库：$(tail_of "$DRILL/err")")
      drop_drill_db 2>/dev/null
      continue
    fi
    if ! count_drill_db >"$DRILL/$db.got" 2>"$DRILL/err"; then
      problems+=("$db 恢复后数不了清单：$(tail_of "$DRILL/err")")
      drop_drill_db 2>/dev/null
      continue
    fi
    if ! drop_drill_db 2>"$DRILL/err"; then
      bail "临时库 $BK_DRILL_DB 删不掉：$(tail_of "$DRILL/err")"
    fi
    rc=0
    diff=$(bk_manifest_diff "$DRILL/$db.want" "$DRILL/$db.got" 2>&1) || rc=$?
    case $rc in
    0)
      verified=$((verified + 1))
      echo "核对 $db：$(wc -l <"$DRILL/$db.want") 项全对上"
      ;;
    1)
      verified=$((verified + 1))
      mismatched=$((mismatched + 1))
      details+=("$db：$(head -n 5 <<<"$diff" | paste -sd ';' -)")
      ;;
    *) problems+=("$db 的清单比不了：$diff") ;;
    esac
  done
  if ! restic_ check >/dev/null 2>"$DRILL/err"; then problems+=("香港仓库自检没过：$(tail_of "$DRILL/err")"); fi
  summary="快照 ${snap:0:8}（$when，$age 小时前）：${#BK_DATABASES[@]} 个库恢复并核对了 $verified 个，对不上 $mismatched 个"
  if ((mismatched)); then
    alert_raise backup.drill:mismatch "恢复演练：恢复出来的和备份时对不上" "$summary。$(bk_join '。' "${details[@]}")" || true
  elif ((verified == ${#BK_DATABASES[@]})); then
    alert_resolve backup.drill:mismatch || true
  fi
  outcome=$(bk_outcome "$verified" "$mismatched" "${#problems[@]}")
  if ((${#problems[@]})); then summary+="；没做成的：$(bk_join '；' "${problems[@]}")"; fi
  finish "$outcome" "$verified" "$mismatched" "$summary"
}

# ── watch ──

cleanup_watch() { rm -rf -- "$WATCH"; }

WATCH_SCANNED=0
WATCH_FOUND=0
WATCH_MISSING=()

# 一块盘：到线就报警，回到线下自动解除
check_disk() { # 机器名 机器键 路径 已用KB 可用KB
  local pct key="backup.disk:$2:$3"
  if ! pct=$(bk_usage_pct "$4" "$5" 2>&1); then
    WATCH_MISSING+=("$1 $3：$pct")
    return
  fi
  WATCH_SCANNED=$((WATCH_SCANNED + 1))
  echo "$1 $3：用了 $pct%（已用 $(human "$4")，还剩 $(human "$5")）"
  if ((pct >= FLEET_DISK_ALERT_PERCENT)); then
    WATCH_FOUND=$((WATCH_FOUND + 1))
    alert_raise "$key" "$1磁盘 $3 用了 $pct%（报警线 $FLEET_DISK_ALERT_PERCENT%）" \
      "已用 $(human "$4")，还剩 $(human "$5")。线在 $BK_CONFIG 的 FLEET_DISK_ALERT_PERCENT" || true
  else
    alert_resolve "$key" || true
  fi
}

watch_france() { # 路径…
  local p line used avail target seen=" "
  for p in "$@"; do
    if ! line=$(df -k --output=used,avail,target -- "$p" 2>"$WATCH/err" | bk_parse_df 2>>"$WATCH/err"); then
      WATCH_MISSING+=("法国 $p：$(tail_of "$WATCH/err")")
      continue
    fi
    read -r used avail target <<<"$line"
    if [[ "$seen" == *" $target "* ]]; then continue; fi # 同一块盘只算一次
    seen+="$target "
    check_disk 法国 france "$target" "$used" "$avail"
  done
}

watch_hk() { # 路径…
  local p cmds="" out parsed line used avail seen=" "
  (($#)) || return 0
  for p in "$@"; do cmds+="df $p"$'\n'; done
  ssh_opts
  if ! out=$(sftp -b - "${SSH_OPTS[@]}" "$BK_HK_USER@$BK_HK_ADDR" <<<"$cmds" 2>"$WATCH/err"); then
    for p in "$@"; do WATCH_MISSING+=("香港 $p：连不上（$(tail_of "$WATCH/err")）"); done
    return
  fi
  parsed=$(bk_parse_sftp_df <<<"$out" 2>/dev/null) || parsed=""
  for p in "$@"; do
    line=$(awk -F '\t' -v p="$p" '$1 == p { print $2 " " $3; exit }' <<<"$parsed")
    if [[ -z "$line" ]]; then
      WATCH_MISSING+=("香港 $p：sftp 的 df 输出里认不出这一项")
      continue
    fi
    read -r used avail <<<"$line"
    if [[ "$seen" == *" $used:$avail "* ]]; then continue; fi # 读数一模一样 = 同一块盘
    seen+="$used:$avail "
    check_disk 香港 hk "$p" "$used" "$avail"
  done
}

# 前两个任务多久没「开跑」了：超过登记的过期分钟就报警。跑了但没做成的由它们自己报，这里只抓「定时器根本没在响」（P08）。
watch_fresh() {
  local rows id line expect age name
  if ! rows=$(bk_sql fleet 2>"$WATCH/err" <<'SQL'
select j.id, j.expect_every_minutes,
  coalesce(floor(extract(epoch from now() - max(r.started_at)))::bigint::text, 'never')
from scheduled_jobs j left join schedule_runs r on r.job = j.id
where j.id in ('backup.nightly', 'backup.drill')
group by j.id, j.expect_every_minutes;
SQL
  ); then
    WATCH_MISSING+=("备份新鲜度：$(tail_of "$WATCH/err")")
    return
  fi
  for id in backup.nightly backup.drill; do
    line=$(awk -F '\t' -v id="$id" '$1 == id' <<<"$rows")
    if [[ -z "$line" ]]; then
      WATCH_MISSING+=("$id 没登记（跑一遍 install.sh france）")
      continue
    fi
    IFS=$'\t' read -r _ expect age <<<"$line"
    if [[ ! "$expect" =~ ^[0-9]+$ || ! "$age" =~ ^([0-9]+|never)$ ]]; then
      WATCH_MISSING+=("$id 的读数认不出（「$line」）")
      continue
    fi
    WATCH_SCANNED=$((WATCH_SCANNED + 1))
    if [[ "$age" == never ]] || ((age > expect * 60)); then
      WATCH_FOUND=$((WATCH_FOUND + 1))
      if [[ "$age" == never ]]; then age="从没跑过"; else age="上次开跑在 $((age / 3600)) 小时前"; fi
      name=$(bk_job_name "$id")
      alert_raise "backup.stale:$id" "${name%%（*}超过 $((expect / 60)) 小时没开跑" \
        "$age。定时器可能没在排班：法国 systemctl list-timers 'fleet-backup*'" || true
    else
      alert_resolve "backup.stale:$id" || true
      echo "$id：$((age / 60)) 分钟前开跑过"
    fi
  done
}

cmd_watch() {
  take_lock watch
  run_start backup.watch fleet-backup-watch.service 磁盘与备份巡检
  CLEANUP=cleanup_watch
  local outcome why
  local -a fr hk
  rm -rf -- "$WATCH"
  mkdir -p -- "$WATCH" || bail "建不了暂存目录 $WATCH"
  if ! bk_read_config "$BK_CONFIG" "$BK_CONFIG_UID" "${BK_CONFIG_KEYS_FRANCE[@]}" 2>"$WATCH/err" || ! bk_check_france_config 2>"$WATCH/err"; then
    bail "配置读不成：$(tail_of "$WATCH/err")"
  fi
  read -r -a fr <<<"${FLEET_DISK_PATHS_FRANCE:-}"
  read -r -a hk <<<"${FLEET_DISK_PATHS_HK:-}"
  watch_france "${fr[@]}"
  watch_hk "${hk[@]}"
  watch_fresh
  outcome=$(bk_outcome "$WATCH_SCANNED" "$WATCH_FOUND" "${#WATCH_MISSING[@]}")
  why="看了 $WATCH_SCANNED 项，超线或过期 $WATCH_FOUND 项"
  if ((${#WATCH_MISSING[@]})); then why+="；没查成：$(bk_join '；' "${WATCH_MISSING[@]}")"; fi
  if [[ "$outcome" == unscanned ]]; then why="配置里一条要看的都没有（$BK_CONFIG）"; fi
  finish "$outcome" "$WATCH_SCANNED" "$WATCH_FOUND" "$why"
}

main() {
  case "${1:-}" in
  backup) cmd_backup ;;
  drill) cmd_drill ;;
  watch) cmd_watch ;;
  # 手动看仓库、真出事时往外取：带上仓库地址、口令文件、钥匙这一套参数跑 restic，不记运行记录。
  # 例：sudo -u fleet /usr/local/lib/fleet-dao/backup/fleet-backup.sh restic snapshots
  restic)
    shift
    restic_ "$@"
    ;;
  *)
    echo "用法：$0 backup|drill|watch|restic <restic 的参数…>" >&2
    exit 64
    ;;
  esac
}

# 测试 source 本文件只要函数，不跑
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap on_exit EXIT
  trap 'exit 143' TERM INT
  # 往已经退出的 psql 里写东西时拿到错误返回，而不是整个脚本被 SIGPIPE 带走（那样连「没做成」都记不上）
  trap '' PIPE
  main "$@"
fi
