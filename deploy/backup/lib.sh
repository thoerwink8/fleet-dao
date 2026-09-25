#!/usr/bin/env bash
# shellcheck disable=SC2034 # 常量给 install.sh、fleet-backup.sh 和测试读
# 夜间备份这摊事的常量和纯函数：装机脚本 install.sh、定时任务本体 fleet-backup.sh 都 source 它，只定义、不做事。
# 纯函数不碰库、不碰网络，deploy/backup/test/backup.test.sh 逐个测，含故意造出「读不到」的样本。
# 读不到、看不懂的一律返回非 0 并把原因写到 stderr，不拿空值、0 冒充「查过了没事」。

# ── 落点。改了要把 install.sh 在两台上都重跑一遍 ──
BK_HK_ADDR=10.99.0.1   # 香港在隧道里的地址（deploy/hk.sh 的 WG_ADDR）
BK_FRANCE_ADDR=10.99.0.2 # 法国在隧道里的地址：香港只许备份钥匙从这里来
BK_HK_USER=fleet-backup
BK_HK_HOME=/srv/fleet-dao-backup # 属 root：fleet-backup 改不了自己的 .ssh；也是它的 chroot，登上来只看得见这一层
BK_HK_REPO=$BK_HK_HOME/restic    # restic 仓库（香港上的真实路径），香港只存密文
# 法国连仓库用的路径：相对 sftp 的起始目录写。chroot 生效时起始目录是 chroot 的根，chroot 万一被撤掉、只剩钥匙那一行的
# 限制时起始目录是 $BK_HK_HOME，两种情况都落到同一个 $BK_HK_REPO
BK_REPO_PATH=restic
BK_SSHD_DROPIN=/etc/ssh/sshd_config.d/60-fleet-dao-backup.conf
BK_CONFIG=/etc/fleet-dao/backup.env
BK_CONFIG_UID=0 # 配置和口令文件得归 root：谁能改它们，谁就能决定备份往哪送、报什么（测试里换成跑测试的人）
BK_ETC=/etc/fleet-dao/backup # 法国：口令、钥匙、钉住的香港主机钥匙，都是 root:fleet 640
BK_PASS_FILE=$BK_ETC/restic.pass
BK_KEY=$BK_ETC/hk-ssh.key
BK_KNOWN_HOSTS=$BK_ETC/hk-known-hosts
BK_TEMPORAL_ENV=/etc/fleet-dao/temporal.env
BK_STATE=/var/lib/fleet-dao/backup # fleet 700：restic 缓存、各任务的暂存（nightly/、drill/、watch/）、锁
BK_WORK=$BK_STATE/nightly/dumps    # 快照里存的就是这个目录。路径固定：每晚一样，restic 才按上一份去重，演练也按它取回
BK_LIB_DIR=/usr/local/lib/fleet-dao/backup
BK_RESTIC_VERSION=0.19.1
BK_RESTIC_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c # restic_0.19.1_linux_amd64.bz2
BK_RESTIC_HOME=/opt/fleet-dao/restic
BK_RESTIC=$BK_RESTIC_HOME/bin/restic
BK_RESTIC_HOST=fleet-dao-france # 快照记的主机名：换了机器也按这个名字排保留期
BK_TAG=nightly
BK_KEEP_DAILY=7
BK_KEEP_WEEKLY=4
BK_DATABASES=(fleet temporal temporal_visibility)
BK_DRILL_ROLE=fleet_drill
BK_DRILL_DB=fleet_drill_restore
BK_RESOLVER=fleet-backup # 自动解除报警时 resolved_by 记这个
BK_LINK=/schedules       # 报警点进去看驾驶舱的定时任务页
# 定时任务登记（scheduled_jobs）：编号|名字|给人看的计划|过期分钟。计划要和 units/ 里定时器的 OnCalendar 对得上（测试核对）；
# 过期分钟要大于「周期 + 失败重试 + 一轮耗时」：每晚那个按 26 小时判（docs/reference/deploy.md 备份一行）。
BK_JOBS=(
  "backup.nightly|每晚备份（法国的库加密传到香港）|每天 04:10（北京时间）|1560"
  "backup.drill|恢复演练（最近一份备份恢复进临时库核对）|每周日 05:40（北京时间）|10200"
  "backup.watch|磁盘用量与备份新鲜度（法国、香港）|每小时 17 分|90"
)
BK_CONFIG_KEYS_FRANCE=(FLEET_DISK_ALERT_PERCENT FLEET_DISK_PATHS_FRANCE FLEET_DISK_PATHS_HK)
BK_CONFIG_KEYS_HK=(FLEET_BACKUP_FRANCE_PUBLIC_KEY)

# 把命令的报错收成一行、最多 400 个字符，好写进运行记录和报警：去掉回车、丢掉不成字的字节（库只收合法的 UTF-8），
# 截的时候按字符截，不会切在一个汉字中间
bk_oneline() {
  local LC_ALL=C.UTF-8 s
  s=$(tr -d '\r' | tr '\n' ' ' | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)
  s=${s%"${s##*[![:space:]]}"}
  if ((${#s} > 400)); then s=…${s: -400}; fi
  printf '%s' "$s"
}

bk_join() { # 分隔 条目…
  local sep=$1 out=""
  shift
  while (($#)); do
    out+=${out:+$sep}$1
    shift
  done
  printf '%s' "$out"
}

bk_job_name() { # 任务编号 → 给人看的名字（不认识的原样打印）
  local j
  for j in "${BK_JOBS[@]}"; do
    if [[ "${j%%|*}" == "$1" ]]; then
      j=${j#*|}
      echo "${j%%|*}"
      return 0
    fi
  done
  echo "$1"
}

# 法国连香港用的 ssh：只用备份那把钥匙、只认钉住的主机钥匙、不读任何 ssh 配置、不交互
bk_ssh_opts() {
  printf -- '-F none -i %s -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=4' \
    "$BK_KEY" "$BK_KNOWN_HOSTS"
}

# 香港 authorized_keys 里那一行：只许从隧道来、什么都不给（终端、转发都没有），登上来只有 sftp。
# 正常时 sshd 的 Match 段（bk_sshd_dropin）还会把它关进 chroot；这一行是 Match 段万一没了时的底线
bk_authorized_line() { # 法国的公钥（整行）
  printf 'from="%s",restrict,command="internal-sftp -d %s" %s' "$BK_FRANCE_ADDR" "$BK_HK_HOME" "$1"
}

# 香港 sshd 的 drop-in：备份用户关进自己的家目录（chroot），只给 sftp，什么转发都不许。
# Match 段只管这一个用户（在 OpenSSH 8.9 上实测：include 进来的 Match 只到文件末尾，root 的有效配置一项不变）
bk_sshd_dropin() {
  printf '%s\n' "# deploy/backup/install.sh 写的，别手改。只管 fleet-dao 的备份用户：关进 $BK_HK_HOME，只给 sftp。" \
    "Match User $BK_HK_USER" \
    "    ChrootDirectory $BK_HK_HOME" \
    "    ForceCommand internal-sftp -d /" \
    "    AllowTcpForwarding no" \
    "    AllowAgentForwarding no" \
    "    AllowStreamLocalForwarding no" \
    "    X11Forwarding no" \
    "    PermitTTY no" \
    "    PermitTunnel no"
}

bk_valid_pubkey() { [[ "$1" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]]; }

# 仓库口令：装机脚本生成的是 64 位十六进制；换机时从密码管理器抄回来的也该是这个样子。空的、带空白的一律不认
bk_valid_restic_password() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

# 换机恢复的步骤写在哪（按标题指，不按节号：节号随前面加节漂过一次；测试核对这个标题在 docs/ops.md 里）
BK_RECOVERY_DOC='docs/ops.md「换机恢复」'

# 一个定时任务在本机跑成过没有，三态：yes 跑成过；no 登记了、从没跑成过；unknown 读不出来（没这一行、读数认不出、
# 运行记录整个读不到——读不到时调用方喂空输入）。unknown 不许当成 yes：那样会把换机恢复当成平常重跑，放开每晚备份。
# 输入是装机脚本 job_health 的输出：每行「任务<TAB>过期分钟<TAB>上次跑成距今秒数或 never<TAB>…」
bk_success_state() { # 任务编号（运行记录从标准输入读）
  local line age
  line=$(awk -F '\t' -v id="$1" '$1 == id { print; exit }')
  IFS=$'\t' read -r _ _ age _ <<<"$line"
  if [[ "$age" == never ]]; then
    echo no
  elif [[ "$age" =~ ^[0-9]+$ ]]; then
    echo yes
  else
    echo unknown
  fi
}

# 每晚备份能不能开（装机脚本开定时器、首跑都问它）。能开什么都不打印、返回 0；不能开打印原因、返回 1。
# 仓库里已经有快照、这台却从没备份成功过的，当成换机恢复：这时首跑会把新机的空库备上去，保留规则还会把当天出事前那一份
# 当成「同一天的旧份」删掉。先恢复库——恢复出来的库里带着旧机的运行记录——再开。
# 跑成过没有读不出来（unknown）也不开：拿不准是不是换机恢复，就按换机恢复挡着，等读得出来再说
bk_backup_hold() { # 仓库连得上(1/0) 仓库里几份快照（读不出为空） 这台跑成过没有（yes/no/unknown）
  local ready=$1 snaps=$2 state=$3
  if [[ "$ready" != 1 ]]; then
    echo "仓库还连不上"
    return 1
  fi
  if [[ ! "$snaps" =~ ^[0-9]+$ ]]; then
    echo "仓库里有几份快照没读出来，拿不准是不是换机恢复"
    return 1
  fi
  case $state in
  yes) ;;
  no)
    if ((snaps > 0)); then
      echo "香港仓库里已有 $snaps 份快照，这台却从没备份成功过——当成换机恢复：先按 $BK_RECOVERY_DOC 把库恢复回来（现在首跑会把空库备上去，还会删掉当天出事前那一份），再跑一遍本脚本"
      return 1
    fi
    ;;
  *)
    echo "这台备份成功过没有，读不出来（运行记录读不到，或 backup.nightly 没登记）——拿不准是不是换机恢复，先不开；查明白再跑一遍本脚本"
    return 1
    ;;
  esac
}

# 判一个定时任务健不健康（装机脚本 --check 用，和驾驶舱 scheduleHealth 一个先后：先看最近一次的结局，再看新鲜度）。
# 打印「ok<TAB>说明」或「red<TAB>说明」。查出问题（found > 0）也是红：演练对不上、盘到线，都不许在读回里显示成通过。
bk_judge_job() { # 任务 过期分钟 上次跑成距今秒数或never 最近结局或none 扫到 问题 原因
  local job=$1 expect=$2 age=$3 outcome=$4 scanned=$5 found=$6 why=$7
  if [[ ! "$expect" =~ ^[0-9]+$ || ! "$age" =~ ^([0-9]+|never)$ ]]; then
    printf 'red\t%s 的读数认不出（过期分钟「%s」，距今「%s」）\n' "$job" "$expect" "$age"
  elif [[ "$outcome" == failed ]]; then
    printf 'red\t%s 最近一次没做成：%s\n' "$job" "$why"
  elif [[ "$outcome" == unscanned ]]; then
    printf 'red\t%s 最近一次一个对象都没扫到：%s\n' "$job" "$why"
  elif [[ "$age" == never ]]; then
    printf 'red\t%s 从没跑成过\n' "$job"
  elif ((age > expect * 60)); then
    printf 'red\t%s 上次跑成在 %d 小时前，超过 %d 小时\n' "$job" "$((age / 3600))" "$((expect / 60))"
  elif [[ "$found" =~ ^[0-9]+$ ]] && ((found > 0)); then
    printf 'red\t%s 最近一次查出 %s 个问题（看报警）：%s\n' "$job" "$found" "$why"
  elif [[ "$outcome" == partial ]]; then
    printf 'red\t%s 最近一次有一部分没查成：%s\n' "$job" "$why"
  else
    printf 'ok\t%s 上次跑成在 %d 分钟前（限 %d 小时）：%s，扫到 %s，查出问题 %s%s\n' "$job" "$((age / 60))" "$((expect / 60))" \
      "$outcome" "$scanned" "$found" "${why:+。$why}"
  fi
}

# 本机配置是 KEY=VALUE 文本，只当数据读、不 source。只认列出来的键；文件要属给定 uid、组和其他人不可写
# （谁能改它，谁就能决定备份往哪报、报什么）。读成功才把值放进同名变量。
bk_read_config() { # 文件 属主uid 允许的键…
  local file=$1 uid=$2 line key val n=0 mode
  shift 2
  local allowed=" $* "
  if [[ ! -r "$file" ]]; then
    echo "读不到 $file" >&2
    return 1
  fi
  mode=$(stat -c '%a' -- "$file") || return 1
  if [[ "$(stat -c '%u' -- "$file")" != "$uid" ]] || ((8#$mode & 8#022)); then
    echo "$file 属主不对或别人能写（$(stat -c '%U:%G %a' -- "$file")），不读它" >&2
    return 1
  fi
  local -A vals=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "$file 第 $n 行看不懂（应为 KEY=VALUE）" >&2
      return 1
    fi
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    if [[ "$allowed" != *" $key "* ]]; then
      echo "$file 第 $n 行的键 $key 不认识（认识的：$*）" >&2
      return 1
    fi
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; fi
    vals[$key]=$val
  done <"$file"
  for key in "${!vals[@]}"; do printf -v "$key" '%s' "${vals[$key]}"; done
}

# 法国的配置：阈值是 1–99 的整数；路径是绝对路径（只许常见字符：要原样写进 sftp 的批处理命令）
bk_check_france_config() {
  local p
  local -a paths
  if [[ ! "${FLEET_DISK_ALERT_PERCENT:-}" =~ ^[1-9][0-9]?$ ]]; then
    echo "FLEET_DISK_ALERT_PERCENT 应为 1–99 的整数，读到「${FLEET_DISK_ALERT_PERCENT:-}」" >&2
    return 1
  fi
  # 两台都要看：哪台空着就是配置没写全，不当成「那台没什么可看的」
  if [[ -z "${FLEET_DISK_PATHS_FRANCE// /}" || -z "${FLEET_DISK_PATHS_HK// /}" ]]; then
    echo "FLEET_DISK_PATHS_FRANCE、FLEET_DISK_PATHS_HK 都要写（两台都要看磁盘）" >&2
    return 1
  fi
  read -r -a paths <<<"$FLEET_DISK_PATHS_FRANCE $FLEET_DISK_PATHS_HK"
  for p in "${paths[@]}"; do
    if [[ ! "$p" =~ ^/[A-Za-z0-9._/-]*$ ]]; then
      echo "磁盘路径「$p」不是只含常见字符的绝对路径" >&2
      return 1
    fi
  done
}

# Temporal 连库的口令：deploy/france.sh 生成的 48 位十六进制；别的样子不认（要原样写进 pgpass）
bk_valid_temporal_password() { [[ "$1" =~ ^[0-9a-f]{48}$ ]]; }

# pg_export_snapshot() 的返回值，例如 00000003-0000001B-1
bk_valid_snapshot_name() { [[ "$1" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]]; }

# 用量百分比，和 df 的 Use% 一样按 已用 /（已用 + 可用）向上取整
bk_usage_pct() { # 已用 可用
  local used=$1 avail=$2
  if [[ ! "$used" =~ ^[0-9]+$ || ! "$avail" =~ ^[0-9]+$ ]] || ((used + avail == 0)); then
    echo "用量读数不对（已用「$used」可用「$avail」）" >&2
    return 1
  fi
  echo $(((used * 100 + used + avail - 1) / (used + avail)))
}

# 读 `df -k --output=used,avail,target -- 路径` 的输出，打印「已用 可用 挂载点」（KB）
bk_parse_df() {
  local header line used avail target
  IFS= read -r header || true
  IFS= read -r line || true
  if [[ "$header" != *Used*Avail* ]]; then
    echo "df 的输出认不出（表头「$header」）" >&2
    return 1
  fi
  read -r used avail target <<<"$line"
  if [[ ! "$used" =~ ^[0-9]+$ || ! "$avail" =~ ^[0-9]+$ || "$target" != /* ]]; then
    echo "df 的输出认不出（「$line」）" >&2
    return 1
  fi
  printf '%s %s %s\n' "$used" "$avail" "$target"
}

# 读 `sftp -b -` 跑一串 `df 路径` 的输出（OpenSSH 的格式：回显「sftp> df 路径」，一行表头，一行
# 「总量 已用 可用 (root) 百分比%」，单位 KB），每个认出来的路径打印「路径<TAB>已用<TAB>可用」。
# 一个都没认出来返回 1；认出几个由调用方和要查的路径逐个对，缺的算没查成。
bk_parse_sftp_df() {
  local line path="" n=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^sftp\>\ df\ (/.*)$ ]]; then
      path=${BASH_REMATCH[1]}
    elif [[ -n "$path" && "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([0-9]+)%[[:space:]]*$ ]]; then
      printf '%s\t%s\t%s\n' "$path" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
      path=""
      n=$((n + 1))
    fi
  done
  if ((n == 0)); then
    echo "sftp 的 df 输出里一个路径都没认出来" >&2
    return 1
  fi
}

# 清单：每行「库<TAB>表<TAB>指标<TAB>值」，指标是 rows 或 max:列名。从标准输入读，只挑出某个库的，去掉库那一列。
bk_manifest_for() { # 库
  awk -F '\t' -v db="$1" 'NF == 4 && $1 == db { print $2 "\t" $3 "\t" $4 }'
}

# 比两份清单（每行「表<TAB>指标<TAB>值」）：一样返回 0；不一样返回 1，逐条打印差在哪；
# 任何一份是空的返回 2——一张表都没数到只能是没读成，不是「对上了」。
bk_manifest_diff() { # 备份时的清单文件 恢复后的清单文件
  local want=$1 got=$2
  if [[ ! -s "$want" ]]; then
    echo "备份时的清单是空的或读不到：$want" >&2
    return 2
  fi
  if [[ ! -s "$got" ]]; then
    echo "恢复后的清单是空的或读不到：$got" >&2
    return 2
  fi
  awk -F '\t' '
    function show(v) { return v == "-" ? "空" : v }
    function what(t, m) { return m == "rows" ? "表 " t " 的行数" : "表 " t " 的 " substr(m, 5) " 最新值" }
    FNR == 1 { file++ }
    NF != 3 { bad = 1; next }
    { k = $1 "\t" $2; if (file == 1) w[k] = $3; else g[k] = $3 }
    END {
      if (bad) { print "清单里有认不出的行"; n++ }
      for (k in w) {
        split(k, p, "\t")
        if (!(k in g)) { print what(p[1], p[2]) "：备份时 " show(w[k]) "，恢复后没有这一项"; n++ }
        else if (w[k] != g[k]) { print what(p[1], p[2]) "：备份时 " show(w[k]) "，恢复后 " show(g[k]); n++ }
      }
      for (k in g) if (!(k in w)) { split(k, p, "\t"); print what(p[1], p[2]) "：恢复后多出来（备份时没有）"; n++ }
      exit (n > 0 ? 1 : 0)
    }' "$want" "$got" | sort
  return "${PIPESTATUS[0]}"
}

# 一轮巡检的结局（四种写法见 packages/db 的 schedule.ts）：扫到几项、其中查出问题几项、没查成几项。
bk_outcome() { # 扫到 问题 没查成
  local scanned=$1 missing=$3
  if ((scanned == 0 && missing == 0)); then
    echo unscanned
  elif ((scanned == 0)); then
    echo failed
  elif ((missing > 0)); then
    echo partial
  else
    echo ok
  fi
}

# `restic backup --json` 的输出里取总结行：打印「快照编号<TAB>处理了几个文件」；没有总结行返回 1
bk_restic_summary() {
  # shellcheck disable=SC2016 # 单引号里是 JS 的模板字符串，本来就不该由 shell 展开
  node -e '
    let s;
    for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
      try { const o = JSON.parse(l); if (o && o.message_type === "summary") s = o; } catch {}
    }
    if (!s || typeof s.snapshot_id !== "string" || !Number.isInteger(s.total_files_processed)) process.exit(1);
    console.log(`${s.snapshot_id}\t${s.total_files_processed}`);'
}

# `restic snapshots --json` 的输出里取最新一份：打印「快照编号<TAB>时间<TAB>距现在几小时」；一份都没有打印 none；认不出返回 1
bk_restic_latest() { # 现在（ISO 时间）
  # shellcheck disable=SC2016 # 同上：JS 的模板字符串
  node -e '
    const now = Date.parse(process.argv[1]);
    let a;
    try { a = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(1); }
    if (!Array.isArray(a) || Number.isNaN(now)) process.exit(1);
    if (a.length === 0) { console.log("none"); process.exit(0); }
    const t = (s) => Date.parse(s && s.time);
    if (a.some((s) => typeof s.id !== "string" || Number.isNaN(t(s)))) process.exit(1);
    a.sort((x, y) => t(y) - t(x));
    console.log(`${a[0].id}\t${a[0].time}\t${Math.floor((now - t(a[0])) / 3600000)}`);' "$1"
}

# 数清单：库里每张表的行数，和每个时间列（timestamptz、timestamp、date）的最新值。一张表只扫一遍。
# 备份时在导出的同一个快照里跑，演练时在恢复出来的临时库里跑，两边都先把时区、日期格式定死，文本才比得上。
# 扩展自带的表不算（恢复时由扩展自己建）。每行打印「表<TAB>指标<TAB>值」，没有值打印 -。
BK_MANIFEST_SQL=$(
  cat <<'SQL'
select format(
    'select %L, x.m, x.v from (select count(*)::text as r%s from %I.%I) s cross join lateral (values (%L, s.r)%s) x(m, v)',
    t.name,
    coalesce(string_agg(format(', max(%I)::text as %I', a.attname, 'c' || a.attnum), '' order by a.attnum) filter (where a.attnum is not null), ''),
    t.nspname, t.relname, 'rows',
    coalesce(string_agg(format(', (%L, coalesce(s.%I, %L))', 'max:' || a.attname, 'c' || a.attnum, '-'), '' order by a.attnum) filter (where a.attnum is not null), ''))
from (
  select c.oid, n.nspname, c.relname, n.nspname || '.' || c.relname as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
) t
left join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype)
group by t.oid, t.nspname, t.relname, t.name
order by t.name
\gexec
SQL
)
