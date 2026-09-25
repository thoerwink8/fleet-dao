#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 夜间备份与恢复演练的装机（以 root 跑；幂等：跑第二遍什么都不变）。独立于 deploy/france.sh、hk.sh，两台各跑一次：
#   bash deploy/backup/install.sh france [--check]   法国：restic、口令与钥匙、任务脚本与定时器、演练用的库角色、登记定时任务、首跑
#   bash deploy/backup/install.sh hk [--check]       香港：只收密文的 fleet-backup 用户、它的目录、那一行 authorized_keys、把它关进 chroot
# 先后：法国先跑（生成备份钥匙、打印公钥）→ 公钥填进香港 /etc/fleet-dao/backup.env、跑香港 → 法国再跑一遍（钉香港的主机钥匙、
# 建仓库、首跑）。--check 只读回，不改任何东西。退出码同 france.sh：0 全绿，1 有红，2 有待配或没查成。
# 换机恢复（仓库里已有快照、这台从没备份成功过）时不开每晚备份、不首跑，见 docs/ops.md 第十一节。
# 只写这些地方——法国：/opt/fleet-dao/restic、/etc/fleet-dao/backup{,.env}、/usr/local/lib/fleet-dao/backup、/var/lib/fleet-dao/backup、
# /etc/systemd/system/fleet-backup*、库角色 fleet_drill、scheduled_jobs 里的三行；香港：用户 fleet-backup、/srv/fleet-dao-backup、
# /etc/fleet-dao/backup.env、/etc/ssh/sshd_config.d/60-fleet-dao-backup.conf（只管这一个用户的 Match 段）。别的一概不碰。
set -Eeuo pipefail
umask 022

BACKUP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$BACKUP_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
source "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib.sh
source "$BACKUP_DIR/lib.sh"
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

UNITS=(fleet-backup.service fleet-backup.timer fleet-backup-drill.service fleet-backup-drill.timer
  fleet-backup-watch.service fleet-backup-watch.timer)
# 定时器、拉起的单元、登记的任务编号：首跑和判活按这个顺序（演练要先有备份）
TIMERS=(fleet-backup.timer:fleet-backup.service:backup.nightly fleet-backup-drill.timer:fleet-backup-drill.service:backup.drill
  fleet-backup-watch.timer:fleet-backup-watch.service:backup.watch)
REPO_READY=0
REPO_SNAPSHOTS=""
PROBE_OUT=""

usage() {
  echo "用法：bash $0 france|hk [--check]" >&2
  exit 64
}

MACHINE=${1:-}
CHECK_ONLY=0
case "${2:-}" in
--check) CHECK_ONLY=1 ;;
"") ;;
*) usage ;;
esac
case $MACHINE in
france | hk) ;;
*) usage ;;
esac

# shellcheck disable=SC1091 # /etc/os-release 是目标机器上的文件
preflight_common() {
  step "前提"
  if ((EUID != 0)); then
    echo "要 root：sudo bash $0 $MACHINE" >&2
    exit 64
  fi
  if [[ "$(. /etc/os-release && echo "$ID")" != ubuntu ]]; then
    red "只在 Ubuntu 上验过"
    return 1
  fi
  if [[ "$(stat -c '%U:%G %a' /etc/fleet-dao 2>/dev/null)" != "root:fleet 750" ]]; then
    red "/etc/fleet-dao 不是 root:fleet 750：先跑 deploy/$MACHINE.sh"
    return 1
  fi
}

# ════════════════ 法国 ════════════════

pg_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -tA "$@"); }
# 以 fleet 经本机 socket 连 fleet 库（peer）；SQL 从标准输入读，值用 -v 传
fleet_sql() { as_user fleet psql -X -q -tA -F $'\t' -v ON_ERROR_STOP=1 -d fleet "$@" -f -; }
# 以 fleet 跑装好的任务脚本（restic 子命令带齐仓库、口令、钥匙这一套参数）
as_fleet_job() { as_user fleet "$BK_LIB_DIR/fleet-backup.sh" "$@"; }

preflight_france() {
  preflight_common
  if [[ "$(uname -m)" != x86_64 ]]; then
    red "restic 装的是 linux_amd64，这台是 $(uname -m)"
    return 1
  fi
  local c lacking=""
  for c in psql pg_dump pg_restore node ssh sftp ssh-keygen ssh-keyscan flock numfmt curl openssl iconv; do
    command -v "$c" >/dev/null || lacking+=" $c"
  done
  if [[ -n "$lacking" ]]; then
    red "缺命令：$lacking（先跑 deploy/france.sh）"
    return 1
  fi
  local tables
  tables=$(printf '%s\n' "select string_agg(table_name, ' ' order by table_name) from information_schema.tables
    where table_schema = 'public' and table_name in ('scheduled_jobs', 'schedule_runs', 'notifications');" | fleet_sql 2>&1) || tables=""
  if [[ "$tables" != "notifications schedule_runs scheduled_jobs" ]]; then
    red "fleet 库里没有 scheduled_jobs、schedule_runs、notifications（读到「${tables:0:120}」）：先发布一次，把迁移跑上"
    return 1
  fi
  ok "Ubuntu，x86_64，要用的命令都在，fleet 库里有运行记录和报警的表"
}

setup_restic() {
  step "restic $BK_RESTIC_VERSION（钉版本、核对 sha256）"
  local dir=$BK_RESTIC_HOME/$BK_RESTIC_VERSION tmp
  local url=https://github.com/restic/restic/releases/download/v$BK_RESTIC_VERSION/restic_${BK_RESTIC_VERSION}_linux_amd64.bz2
  if [[ -f "$dir/.sha256" ]] && (cd "$dir" && sha256sum --quiet --status -c .sha256); then
    ok "已装 $dir/restic"
  else
    ensure_pkgs bzip2
    tmp=$(mktemp -d /var/tmp/fleet-dao-download.XXXXXX)
    if ! curl -fsSL --retry 3 --max-time 600 -o "$tmp/restic.bz2" "$url"; then
      rm -rf -- "$tmp"
      red "下载失败：$url"
      return 1
    fi
    if ! printf '%s  %s\n' "$BK_RESTIC_SHA256" "$tmp/restic.bz2" | sha256sum --quiet --status -c -; then
      rm -rf -- "$tmp"
      red "sha256 对不上，不装：$url"
      return 1
    fi
    bunzip2 -- "$tmp/restic.bz2"
    install -d -o root -g root -m 755 "$BK_RESTIC_HOME" "$dir"
    install -o root -g root -m 755 "$tmp/restic" "$dir/restic"
    (cd "$dir" && sha256sum restic >.sha256)
    rm -rf -- "$tmp"
    changed "装 restic $BK_RESTIC_VERSION（sha256 已核对）到 $dir"
  fi
  ensure_dir "$BK_RESTIC_HOME/bin" root:root 755
  ensure_symlink "$BK_RESTIC" "../$BK_RESTIC_VERSION/restic"
}

setup_dirs_france() {
  step "目录"
  ensure_dir "$BK_ETC" root:fleet 750
  ensure_dir "$BK_STATE" fleet:fleet 700
  ensure_dir "$BK_STATE/cache" fleet:fleet 700
  ensure_dir /usr/local/lib/fleet-dao root:root 755
  ensure_dir "$BK_LIB_DIR" root:root 755
}

setup_secrets() {
  step "口令与钥匙（$BK_ETC，root:fleet 640：只有 root 和引擎用户 fleet 读得到）"
  # restic 仓库口令：首次生成，之后再也不动——换了它，香港已有的备份就解不开了。
  # 先生成进变量再核对样子：写进文件的若是空行，restic init 会拿空口令建库
  local pass
  if [[ ! -s "$BK_PASS_FILE" ]]; then
    pass=$(openssl rand -hex 32)
    if ! bk_valid_restic_password "$pass"; then
      red "生成的仓库口令不是 64 位十六进制（openssl 出了什么事？），不写"
      return 1
    fi
    put_file "$BK_PASS_FILE" root:fleet 640 "$pass"
  else
    fix_meta "$BK_PASS_FILE" root:fleet 640
  fi
  pass=$(head -n 1 -- "$BK_PASS_FILE")
  if ! bk_valid_restic_password "$pass"; then
    red "$BK_PASS_FILE 的第一行不是 64 位十六进制（空的？换机时是不是没把密码管理器里那串整行抄回来？）"
    return 1
  fi
  pass=""
  echo "  仓库口令在 $BK_PASS_FILE：抄一份进创始人的密码管理器——法国这台没了，香港的密文只有它解得开（这里不打印口令）"
  # 连香港的钥匙。fleet 读它靠组权限：ssh 只在钥匙文件归自己时才嫌 640 太松，归 root 的不嫌
  if [[ ! -s "$BK_KEY" ]]; then
    rm -f -- "$BK_KEY" "$BK_KEY.pub"
    ssh-keygen -q -t ed25519 -N '' -C fleet-dao-backup -f "$BK_KEY" >/dev/null
    rm -f -- "$BK_KEY.pub" # 公钥随时能从私钥导出，不另存
    changed "生成备份钥匙 $BK_KEY"
  fi
  fix_meta "$BK_KEY" root:fleet 640
  # 以 fleet 导出公钥：顺带验证引擎用户真读得到这把钥匙（root 自己导反而不行——钥匙归 root 又是 640，ssh 嫌太松）
  local pub
  if pub=$(as_user fleet ssh-keygen -y -f "$BK_KEY" 2>&1) && bk_valid_pubkey "$pub"; then
    echo "  备份钥匙的公钥（整行填进香港 $BK_CONFIG 的 FLEET_BACKUP_FRANCE_PUBLIC_KEY）：$pub"
  else
    red "fleet 读不了备份钥匙 $BK_KEY：${pub:0:200}"
    return 1
  fi
  # 香港 sshd 的主机钥匙：经隧道取（隧道两头靠 WireGuard 钥匙互认，那头只可能是香港），钉住之后只认这一把
  local line re
  if [[ -s "$BK_KNOWN_HOSTS" ]]; then
    fix_meta "$BK_KNOWN_HOSTS" root:fleet 640
    return 0
  fi
  if ! ping -c 1 -W 2 -q "$BK_HK_ADDR" >/dev/null 2>&1; then
    pending "隧道还没通，香港 sshd 的主机钥匙等隧道通了再取（再跑一遍本脚本）"
    return 0
  fi
  line=$(ssh-keyscan -T 5 -t ed25519 "$BK_HK_ADDR" 2>/dev/null) || line=""
  re="^${BK_HK_ADDR//./\\.} ssh-ed25519 [A-Za-z0-9+/]+=*$"
  if [[ ! "$line" =~ $re ]]; then
    red "经隧道取不到香港 sshd 的主机钥匙（读到「${line:0:80}」）"
    return 1
  fi
  put_file "$BK_KNOWN_HOSTS" root:fleet 640 "$line"
}

check_config_france() {
  local out
  if out=$( (bk_read_config "$BK_CONFIG" 0 "${BK_CONFIG_KEYS_FRANCE[@]}" && bk_check_france_config &&
    echo "报警线 $FLEET_DISK_ALERT_PERCENT%，法国看 $FLEET_DISK_PATHS_FRANCE，香港看 $FLEET_DISK_PATHS_HK") 2>&1); then
    ok "配置 $BK_CONFIG：$out"
  else
    red "配置 $BK_CONFIG 不对：$out"
  fi
}

setup_config_france() {
  step "本机配置 $BK_CONFIG"
  if [[ -e "$BK_CONFIG" ]]; then
    fix_meta "$BK_CONFIG" root:fleet 640
  else
    put_file "$BK_CONFIG" root:fleet 640 "$(<"$BACKUP_DIR/backup-france.env.example")"
  fi
  check_config_france
}

setup_scripts() {
  step "任务脚本（$BK_LIB_DIR，归 root：fleet 跑得了、改不了）"
  put_file "$BK_LIB_DIR/lib.sh" root:root 644 "$(<"$BACKUP_DIR/lib.sh")"
  put_file "$BK_LIB_DIR/fleet-backup.sh" root:root 755 "$(<"$BACKUP_DIR/fleet-backup.sh")"
}

setup_db() {
  step "库：演练用的角色、定时任务登记"
  local got job id name schedule expect
  # 演练把备份恢复进临时库：临时库和里面的东西都归 fleet_drill（不能登录、只能建库）；fleet 能切成它，但平时不带它的权限。
  # 恢复不用超级用户：备份里带的函数、触发器在临时库里只有 fleet_drill 的权限
  if [[ "$(pg_admin -c "select 1 from pg_roles where rolname = '$BK_DRILL_ROLE'")" != 1 ]]; then
    pg_admin -c "create role $BK_DRILL_ROLE nologin createdb"
    changed "建库角色 $BK_DRILL_ROLE（不能登录、只能建库；演练的临时库归它）"
  fi
  if [[ "$(pg_admin -c "select m.inherit_option, m.set_option from pg_auth_members m
      where m.roleid = '$BK_DRILL_ROLE'::regrole and m.member = 'fleet'::regrole")" != "f|t" ]]; then
    pg_admin -c "grant $BK_DRILL_ROLE to fleet with inherit false, set true"
    changed "让 fleet 能切成 $BK_DRILL_ROLE（不继承它的权限）"
  fi
  # 登记在装机时做：一次都没跑过的任务也要在驾驶舱和判活里看得见
  for job in "${BK_JOBS[@]}"; do
    IFS='|' read -r id name schedule expect <<<"$job"
    got=$(fleet_sql -v id="$id" -v name="$name" -v schedule="$schedule" -v expect="$expect" <<'SQL'
insert into scheduled_jobs (id, name, schedule, expect_every_minutes)
values (:'id', :'name', :'schedule', :'expect'::int)
on conflict (id) do update
  set name = excluded.name, schedule = excluded.schedule, expect_every_minutes = excluded.expect_every_minutes
  where (scheduled_jobs.name, scheduled_jobs.schedule, scheduled_jobs.expect_every_minutes)
    is distinct from (excluded.name, excluded.schedule, excluded.expect_every_minutes)
returning 1;
SQL
    )
    if [[ "$got" == 1 ]]; then changed "登记定时任务 $id（$schedule，超过 $expect 分钟没跑成算过期）"; fi
  done
}

setup_units() {
  step "定时器（时区写在 OnCalendar 里，不靠机器时区）"
  local u reload=0 t timer job
  for u in "${UNITS[@]}"; do
    put_file "/etc/systemd/system/$u" root:root 644 "$(<"$BACKUP_DIR/units/$u")"
    reload=$((reload || WROTE))
  done
  if ((reload)); then systemctl daemon-reload; fi
  for t in "${TIMERS[@]}"; do
    timer=${t%%:*}
    job=${t##*:}
    # 每晚备份的定时器只在确定不会把空库备上去时才开；已经开着的不去关它（隧道一时不通时重跑装机脚本不该停掉备份）
    if [[ "$job" == backup.nightly && "$(systemctl is-enabled "$timer" 2>/dev/null)" != enabled ]] && ! backup_allowed; then
      pending "$timer 先不开：$BACKUP_HOLD"
      continue
    fi
    if [[ "$(systemctl is-enabled "$timer" 2>/dev/null)" != enabled ]]; then
      systemctl enable --quiet "$timer"
      changed "启用 $timer"
    fi
    if [[ "$(systemctl is-active "$timer" 2>/dev/null)" != active ]]; then
      systemctl start "$timer"
      changed "启动 $timer"
    fi
  done
}

# 仓库在不在、口令和钥匙对不对：以 fleet 跑一次 restic cat config（和定时任务同一套参数）
probe_repo() {
  local out rc=0
  out=$(as_fleet_job restic cat config 2>&1 >/dev/null) || rc=$?
  PROBE_OUT=$(tail -n 3 <<<"$out" | bk_oneline)
  return "$rc"
}

# 仓库里有几份快照（连不上、认不出都返回非 0，不拿 0 冒充）
count_snapshots() {
  local out n
  out=$(as_fleet_job restic snapshots --json --host "$BK_RESTIC_HOST" --tag "$BK_TAG" 2>/dev/null) || return 1
  n=$(node -e 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!Array.isArray(a)) process.exit(1); console.log(a.length)' \
    <<<"$out" 2>/dev/null) || return 1
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  echo "$n"
}

# 连一次仓库：REPO_READY（连得上、口令对）、REPO_SNAPSHOTS（几份快照，读不出为空）。init 为 1 时仓库不在就建一个
detect_repo() { # init
  local rc=0
  REPO_READY=0 REPO_SNAPSHOTS=""
  if [[ ! -s "$BK_KNOWN_HOSTS" ]]; then
    PROBE_OUT="还没钉住香港 sshd 的主机钥匙（隧道通了再跑一遍本脚本）"
    return 0
  fi
  probe_repo || rc=$?
  if ((rc == 10 && $1)); then
    rc=0
    as_fleet_job restic init >/dev/null 2>&1 || rc=$?
    if ((rc)); then
      red "在香港建仓库没成（restic 退出码 $rc）"
      return 0
    fi
    changed "在香港建了 restic 仓库（口令在 $BK_PASS_FILE）"
    rc=0
    probe_repo || rc=$?
  fi
  if ((rc == 0)); then
    REPO_READY=1
    REPO_SNAPSHOTS=$(count_snapshots) || REPO_SNAPSHOTS=""
  elif [[ "$PROBE_OUT" == *"Permission denied"* ]]; then
    PROBE_OUT="香港还没认这把备份钥匙：把上面打印的公钥填进香港 $BK_CONFIG，在香港跑 install.sh hk"
  else
    PROBE_OUT="连香港的仓库没成（restic 退出码 $rc）：$PROBE_OUT"
  fi
}

setup_repo() {
  step "香港的 restic 仓库（$BK_HK_USER@$BK_HK_ADDR，香港上是 $BK_HK_REPO，只存密文）"
  detect_repo 1
  if ((REPO_READY)); then
    ok "仓库在，口令对得上，里面 ${REPO_SNAPSHOTS:-（数没读出来）} 份快照"
  else
    pending "$PROBE_OUT"
  fi
}

# 每晚备份能不能开（开定时器、首跑都问它），判法见 lib.sh 的 bk_backup_hold；不能开时原因放进 BACKUP_HOLD
BACKUP_HOLD=""
backup_allowed() {
  local never=0
  if never_succeeded backup.nightly; then never=1; fi
  if BACKUP_HOLD=$(bk_backup_hold "$REPO_READY" "$REPO_SNAPSHOTS" "$never"); then return 0; fi
  if ((REPO_READY == 0)); then BACKUP_HOLD+="（${PROBE_OUT:-没查成}）"; fi
  return 1
}

# 最近一次跑的结局、上次跑成（ok 或 partial）距今几秒：任务编号<TAB>过期分钟<TAB>秒数或 never<TAB>结局<TAB>扫到<TAB>问题<TAB>原因
job_health() {
  fleet_sql -v ids="$(printf '%s ' "${TIMERS[@]##*:}")" <<'SQL'
select j.id, j.expect_every_minutes,
  coalesce((select floor(extract(epoch from now() - max(r.ended_at)))::bigint::text from schedule_runs r
    where r.job = j.id and r.outcome in ('ok', 'partial')), 'never'),
  coalesce(l.outcome::text, 'none'), coalesce(l.scanned::text, '-'), coalesce(l.found::text, '-'),
  replace(coalesce(l.why, ''), E'\n', ' ')
from scheduled_jobs j
left join lateral (select * from schedule_runs r where r.job = j.id and r.outcome is not null
  order by r.ended_at desc, r.id desc limit 1) l on true
where j.id = any(string_to_array(trim(:'ids'), ' '))
order by j.id;
SQL
}

never_succeeded() { # 任务编号
  local rows
  rows=$(job_health 2>/dev/null) || return 1
  awk -F '\t' -v id="$1" '$1 == id && $3 == "never" { found = 1 } END { exit !found }' <<<"$rows"
}

first_runs() {
  step "首跑：从没跑成过的，经 systemd 真跑一次（判活看的是上次跑成的时刻，不是下次什么时候响）"
  local t service job
  for t in "${TIMERS[@]}"; do
    IFS=: read -r _ service job <<<"$t"
    if ! never_succeeded "$job"; then
      ok "$job 跑成过，不再首跑"
      continue
    fi
    if [[ "$job" == backup.nightly ]] && ! backup_allowed; then
      pending "$job 不首跑：$BACKUP_HOLD"
      continue
    fi
    if ((REPO_READY == 0)) && [[ "$job" == backup.drill ]]; then
      pending "$job 还没跑成过：仓库好了再跑一遍本脚本"
      continue
    fi
    if systemctl start "$service"; then
      changed "首跑 $service"
    else
      red "首跑 $service 没做成：journalctl -u $service -n 50"
    fi
  done
}

readback_france() {
  step "读回"
  local f have t timer service job rows line expect age outcome scanned found why user verdict pass
  detect_repo 0 # 首跑之后快照数变了，重新连一次
  if [[ "$(readlink -f "$BK_RESTIC" 2>/dev/null)" == "$BK_RESTIC_HOME/$BK_RESTIC_VERSION/restic" ]] &&
    (cd "$BK_RESTIC_HOME/$BK_RESTIC_VERSION" && sha256sum --quiet --status -c .sha256) 2>/dev/null; then
    ok "restic：$("$BK_RESTIC" version 2>/dev/null | head -n 1)"
  else
    red "restic 不在或被改过：$BK_RESTIC"
  fi
  for f in "$BK_PASS_FILE" "$BK_KEY" "$BK_KNOWN_HOSTS" "$BK_CONFIG"; do
    have=$(stat -c '%U:%G %a' -- "$f" 2>/dev/null) || have="没有"
    if [[ "$have" == "root:fleet 640" ]]; then ok "$f root:fleet 640"; else pending "$f 是「$have」，应为 root:fleet 640"; fi
  done
  pass=$(head -n 1 -- "$BK_PASS_FILE" 2>/dev/null) || pass=""
  if bk_valid_restic_password "$pass"; then
    ok "仓库口令是 64 位十六进制（不打印）"
  else
    red "$BK_PASS_FILE 的第一行不是 64 位十六进制（空的？）"
  fi
  pass=""
  check_config_france
  for f in lib.sh fleet-backup.sh; do
    if cmp -s -- "$BACKUP_DIR/$f" "$BK_LIB_DIR/$f" && [[ "$(stat -c '%U' -- "$BK_LIB_DIR/$f")" == root ]]; then
      ok "$BK_LIB_DIR/$f 和仓里一致、归 root"
    else
      red "$BK_LIB_DIR/$f 和仓里的不一样或不归 root：再跑一遍本脚本（不带 --check）"
    fi
  done
  if [[ "$(stat -c '%U:%G %a' "$BK_STATE" 2>/dev/null)" == "fleet:fleet 700" && -z "$(find "$BK_STATE" -user root -print -quit 2>/dev/null)" ]]; then
    ok "$BK_STATE 是 fleet:fleet 700，里面没有 root 的文件"
  else
    red "$BK_STATE 属主或权限不对，或里面有 root 的文件（fleet 会写不进去，审计 P01）"
  fi
  if [[ "$(pg_admin -c "select rolcanlogin, rolcreatedb, rolsuper, rolcreaterole from pg_roles where rolname = '$BK_DRILL_ROLE'" 2>/dev/null)" == "f|t|f|f" ]]; then
    ok "库角色 $BK_DRILL_ROLE：不能登录、只能建库、不是超级用户"
  else
    red "库角色 $BK_DRILL_ROLE 不在或权限不对"
  fi
  if ((REPO_READY)); then
    ok "香港的仓库连得上、口令对得上：${REPO_SNAPSHOTS:-（数没读出来）} 份快照"
    readback_chroot
  else
    pending "香港的仓库还连不上：$PROBE_OUT"
  fi
  local held=0
  if ! backup_allowed; then held=1; fi
  for t in "${TIMERS[@]}"; do
    IFS=: read -r timer service job <<<"$t"
    user=$(unit_prop "$service" User)
    if [[ "$user" != fleet ]]; then red "$service 的有效 User 是「$user」，应为 fleet"; fi
    if [[ "$(systemctl is-enabled "$timer" 2>/dev/null)" == enabled && "$(systemctl is-active "$timer" 2>/dev/null)" == active ]]; then
      ok "$timer 启用且在排班（$service 以 fleet 跑）"
    elif [[ "$job" == backup.nightly ]] && ((held)); then
      pending "$timer 没开：$BACKUP_HOLD"
    else
      red "$timer 没启用或没在排班"
    fi
  done
  # 判活：看上次跑成的时刻，超过登记的过期分钟就红；最近一次没做成、没扫到、查出问题也红（判法见 lib.sh 的 bk_judge_job）
  if ! rows=$(job_health 2>&1); then
    pending "运行记录读不出来：${rows:0:200}"
    return 0
  fi
  for t in "${TIMERS[@]}"; do
    job=${t##*:}
    line=$(awk -F '\t' -v id="$job" '$1 == id' <<<"$rows")
    if [[ -z "$line" ]]; then
      red "$job 没登记"
      continue
    fi
    IFS=$'\t' read -r _ expect age outcome scanned found why <<<"$line"
    verdict=$(bk_judge_job "$job" "$expect" "$age" "$outcome" "$scanned" "$found" "$why")
    if [[ "$job" == backup.nightly && "$age" == never ]] && ((held)); then
      pending "$job 还没跑过：$BACKUP_HOLD"
    elif [[ "${verdict%%$'\t'*}" == ok ]]; then
      ok "${verdict#*$'\t'}"
    else
      red "${verdict#*$'\t'}"
    fi
  done
}

# 香港那边的备份用户真关在 chroot 里：登上来列根目录，应当只看得见备份目录，看不见 /etc
readback_chroot() {
  local out
  local -a opts
  read -r -a opts <<<"$(bk_ssh_opts)"
  if ! out=$(printf 'ls -1 /\n' | as_user fleet sftp -b - "${opts[@]}" "$BK_HK_USER@$BK_HK_ADDR" 2>&1); then
    pending "列不出香港备份用户看得见的根目录：$(tail -n 2 <<<"$out" | bk_oneline)"
  elif grep -qE '^/?etc$' <<<"$out"; then
    red "香港的备份用户看得见整台机器的文件（chroot 没生效）：在香港跑 install.sh hk"
  elif grep -qE "^/?$BK_REPO_PATH\$" <<<"$out"; then
    ok "香港的备份用户关在 chroot 里：根目录下只看得见备份目录"
  else
    pending "香港备份用户的根目录列出来认不出：$(bk_oneline <<<"$out")"
  fi
}

main_france() {
  preflight_france
  if ((CHECK_ONLY == 0)); then
    setup_restic
    setup_dirs_france
    setup_secrets
    setup_config_france
    setup_scripts
    setup_db
    setup_repo
    setup_units
    first_runs
  fi
  readback_france
  finish
}

# ════════════════ 香港 ════════════════

HK_KEYS_FILE=$BK_HK_HOME/.ssh/authorized_keys
FLEET_BACKUP_FRANCE_PUBLIC_KEY=""

preflight_hk() {
  preflight_common
  local keys
  if [[ ! -x /usr/sbin/nologin ]]; then
    red "没有 /usr/sbin/nologin"
    return 1
  fi
  keys=$(sshd -T 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; print }') || keys=""
  if [[ " $keys " != *" .ssh/authorized_keys "* ]]; then
    red "这台 sshd 不读 .ssh/authorized_keys（AuthorizedKeysFile 是「${keys# }」）：备份钥匙登记了也不生效"
    return 1
  fi
  ok "Ubuntu，sshd 读 .ssh/authorized_keys"
}

setup_hk_user() {
  step "只收密文的用户 $BK_HK_USER（只能 sftp，没有终端、不能转发、只许从隧道来）"
  local entry home shell pw
  if ! getent group "$BK_HK_USER" >/dev/null; then
    groupadd --system "$BK_HK_USER"
    changed "建组 $BK_HK_USER"
  fi
  if ! getent passwd "$BK_HK_USER" >/dev/null; then
    useradd --system --gid "$BK_HK_USER" --home-dir "$BK_HK_HOME" --no-create-home --shell /usr/sbin/nologin \
      --comment "fleet-dao backup (sftp only)" "$BK_HK_USER"
    changed "建系统用户 $BK_HK_USER（家目录 $BK_HK_HOME，shell nologin）"
  fi
  entry=$(getent passwd "$BK_HK_USER")
  IFS=: read -r _ _ _ _ _ home shell <<<"$entry"
  if [[ "$home" != "$BK_HK_HOME" || "$shell" != /usr/sbin/nologin ]]; then
    red "用户 $BK_HK_USER 已存在但不是装机脚本建的样子（家目录 $home，shell $shell）——停下等人看，不改别人的账号"
    return 1
  fi
  # 口令一栏写 *：没有能用的口令，但也不算「锁住」——sshd 不走 PAM 时会拒绝锁住的账号，连钥匙登录都不给
  pw=$(getent shadow "$BK_HK_USER" | cut -d: -f2)
  if [[ "$pw" != "*" ]]; then
    usermod -p '*' "$BK_HK_USER"
    changed "$BK_HK_USER 的口令一栏改成 *（没有口令可用）"
  fi
  ensure_dir "$BK_HK_HOME" root:root 755
  ensure_dir "$BK_HK_HOME/.ssh" root:root 755
  ensure_dir "$BK_HK_REPO" "$BK_HK_USER:$BK_HK_USER" 700
}

load_config_hk() {
  if [[ -e "$BK_CONFIG" ]]; then
    fix_meta "$BK_CONFIG" root:fleet 640
  elif ((CHECK_ONLY == 0)); then
    put_file "$BK_CONFIG" root:fleet 640 "$(<"$BACKUP_DIR/backup-hk.env.example")"
  fi
  load_env "$BK_CONFIG" "${BK_CONFIG_KEYS_HK[@]}"
}

setup_hk_key() {
  step "登记法国的备份钥匙（$HK_KEYS_FILE，归 root：fleet-backup 自己改不了）"
  load_config_hk
  if [[ -z "$FLEET_BACKUP_FRANCE_PUBLIC_KEY" ]]; then
    pending "还没有法国备份钥匙的公钥（$BK_CONFIG 的 FLEET_BACKUP_FRANCE_PUBLIC_KEY，法国跑 install.sh france 时会打印）"
    return 0
  fi
  if ! bk_valid_pubkey "$FLEET_BACKUP_FRANCE_PUBLIC_KEY"; then
    red "$BK_CONFIG 的 FLEET_BACKUP_FRANCE_PUBLIC_KEY 不像 ed25519 公钥（应为法国打印的那一整行）"
    return 1
  fi
  put_file "$HK_KEYS_FILE" root:root 644 "# deploy/backup/install.sh 写的，别手改。法国的备份钥匙：只许从隧道地址来，不给终端、不许转发，登上来只有 sftp。
$(bk_authorized_line "$FLEET_BACKUP_FRANCE_PUBLIC_KEY")"
}

# 把备份用户关进 chroot：法国被打穿的话，拿着这把钥匙也只看得见备份目录，看不见香港别的文件。
# 先 sshd -t 验整份配置，不过就把这份撤掉、不重载——sshd 配错了，连 root 都登不上来
setup_hk_sshd() {
  step "sshd：备份用户关进 $BK_HK_HOME（$BK_SSHD_DROPIN）"
  local err
  put_file "$BK_SSHD_DROPIN" root:root 644 "$(bk_sshd_dropin)"
  if ((WROTE == 0)); then return 0; fi
  if ! err=$(sshd -t 2>&1); then
    rm -f -- "$BK_SSHD_DROPIN"
    red "加上 $BK_SSHD_DROPIN 之后 sshd -t 不过，已撤掉、没重载：${err:0:300}"
    return 1
  fi
  systemctl reload ssh.service
  changed "重载 sshd（已登录的连接不受影响）"
}

readback_hk() {
  step "读回"
  local cfg pub akf allow chroot force n size have pct
  if [[ "$(getent passwd "$BK_HK_USER" | cut -d: -f6,7)" == "$BK_HK_HOME:/usr/sbin/nologin" ]]; then
    ok "用户 $BK_HK_USER：家目录 $BK_HK_HOME，shell nologin"
  else
    red "用户 $BK_HK_USER 不在或样子不对"
  fi
  for have in "$BK_HK_HOME:root:root 755" "$BK_HK_HOME/.ssh:root:root 755" "$BK_HK_REPO:$BK_HK_USER:$BK_HK_USER 700"; do
    if [[ "$(stat -c '%U:%G %a' -- "${have%%:*}" 2>/dev/null)" == "${have#*:}" ]]; then
      ok "${have%%:*} 是 ${have#*:}"
    else
      red "${have%%:*} 不是 ${have#*:}"
    fi
  done
  if [[ -z "$FLEET_BACKUP_FRANCE_PUBLIC_KEY" ]]; then
    pending "法国的备份钥匙还没登记（$BK_CONFIG）"
  elif [[ "$(stat -c '%U:%G %a' -- "$HK_KEYS_FILE" 2>/dev/null)" == "root:root 644" ]] &&
    grep -qxF -- "$(bk_authorized_line "$FLEET_BACKUP_FRANCE_PUBLIC_KEY")" "$HK_KEYS_FILE"; then
    ok "$HK_KEYS_FILE 归 root，只有那一行限死的钥匙"
  else
    red "$HK_KEYS_FILE 不对（属主、权限或那一行）"
  fi
  # 按备份用户从隧道来的样子读 sshd 的有效配置
  if cfg=$(sshd -T -C "user=$BK_HK_USER,host=fleet-france,addr=$BK_FRANCE_ADDR" 2>&1); then
    pub=$(awk '$1 == "pubkeyauthentication" { print $2 }' <<<"$cfg")
    akf=$(awk '$1 == "authorizedkeysfile" { $1 = ""; print }' <<<"$cfg")
    allow=$(awk '$1 == "allowusers" || $1 == "allowgroups" { print }' <<<"$cfg")
    chroot=$(awk '$1 == "chrootdirectory" { print $2 }' <<<"$cfg")
    force=$(awk '$1 == "forcecommand" { $1 = ""; print }' <<<"$cfg")
    if [[ "$pub" == yes && " $akf " == *" .ssh/authorized_keys "* && -z "$allow" ]]; then
      ok "sshd 对 $BK_HK_USER：认钥匙、读 .ssh/authorized_keys、没有 AllowUsers 挡着"
    else
      red "sshd 对 $BK_HK_USER 的有效配置不对：pubkeyauthentication=$pub，authorizedkeysfile=${akf# }${allow:+，$allow}"
    fi
    if [[ "$chroot" == "$BK_HK_HOME" && "${force# }" == "internal-sftp -d /" ]]; then
      ok "sshd 把 $BK_HK_USER 关在 $BK_HK_HOME 里、只给 sftp"
    else
      red "sshd 没把 $BK_HK_USER 关进 chroot（chrootdirectory=$chroot，forcecommand=${force# }）"
    fi
  else
    red "sshd -T 读不出对 $BK_HK_USER 生效的配置：${cfg:0:200}"
  fi
  # Match 段只该管备份用户：root 的有效配置里不许出现 chroot、强制命令
  if cfg=$(sshd -T -C "user=root,host=admin,addr=127.0.0.1" 2>&1) &&
    [[ "$(awk '$1 == "chrootdirectory" || $1 == "forcecommand" { print $2 }' <<<"$cfg" | sort -u)" == none ]]; then
    ok "root 的 sshd 有效配置没被这段 Match 碰到"
  else
    red "root 的 sshd 有效配置里出现了 chroot 或强制命令：马上看 $BK_SSHD_DROPIN"
  fi
  if [[ "$(cat -- "$BK_SSHD_DROPIN" 2>/dev/null)" != "$(bk_sshd_dropin)" ]]; then
    red "$BK_SSHD_DROPIN 不在或和仓里的不一样"
  fi
  if [[ -n "$(find "$BK_HK_REPO" ! -user "$BK_HK_USER" -print -quit 2>/dev/null)" ]]; then
    red "$BK_HK_REPO 里有不归 $BK_HK_USER 的文件（法国会写不进去，审计 P01）"
  fi
  if [[ -f "$BK_HK_REPO/config" ]]; then
    n=$(find "$BK_HK_REPO/snapshots" -type f 2>/dev/null | wc -l)
    size=$(du -sh -- "$BK_HK_REPO" 2>/dev/null | cut -f1)
    ok "仓库里 $n 份快照（密文，香港解不开），占 ${size:-没读出来}"
  else
    pending "仓库还没建：法国跑一遍 install.sh france"
  fi
  pct=$(df -P -- "$BK_HK_HOME" 2>/dev/null | awk 'NR == 2 { print $5 }') || pct=""
  ok "备份所在的盘用了 ${pct:-没读出来}（报警线在法国的 $BK_CONFIG，法国每小时来看）"
}

main_hk() {
  preflight_hk
  if ((CHECK_ONLY == 0)); then
    setup_hk_user
    setup_hk_key
    setup_hk_sshd
  else
    load_env "$BK_CONFIG" "${BK_CONFIG_KEYS_HK[@]}"
  fi
  readback_hk
  finish
}

if [[ "$MACHINE" == france ]]; then main_france; else main_hk; fi
