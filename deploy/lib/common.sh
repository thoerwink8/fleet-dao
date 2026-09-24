#!/usr/bin/env bash
# shellcheck disable=SC2034 # WROTE、RENDERED、WG_PUBLIC_KEY 之类是给调用方读的
# 装机脚本共用的零件（deploy/france.sh、deploy/hk.sh 都 source 它），只定义函数不做事。
# 规矩：每个动作先查再做；做了就记一笔 changed，第二遍跑应当一笔都没有。
# 判红就 return 1：调用方开着 set -e，ERR 陷阱会给出结论后停下，不带着坏状态往下装。

# ── 结论记账 ──
# 每个动作落三种结论之一：改了（CHANGES）、红（REDS）、待配或没查成（PENDING）。
# 退出码：有红 1；没红但有待配 2；全绿 0。
CHANGES=()
REDS=()
PENDING=()
# 不计入退出码、但结论里要单列的：别家单元的 P02 问题；其中会话或服务身份改得了的，是会话上线前必须清零的
OTHERS=()
MUSTCLEAR=()
# 本机上「会话或服务身份」有哪些：P02 自检用它们判别家的问题会不会被我们自己的进程利用。由各装机脚本设置。
WRITER_IDENTITIES=(fleet)
SESSION_USERS=() # AI 会话专用用户（只有法国有）
WROTE=0 # 最近一次 put_file / ensure_* 有没有动手；调用方据此决定要不要重启服务

step() { printf '\n== %s\n' "$*"; }
# 只说填没填，不把值打出来（地址、公钥进了日志就收不回）
filled() { if [[ -n "$1" ]]; then printf '已填'; else printf '（未填）'; fi; }
ok() { printf '  ✓ %s\n' "$*"; }
changed() {
  CHANGES+=("$*")
  WROTE=1
  printf '  ↻ %s\n' "$*"
}
red() {
  REDS+=("$*")
  printf '  ✗ %s\n' "$*"
}
pending() {
  PENDING+=("$*")
  printf '  … %s\n' "$*"
}

finish() {
  printf '\n== 结论\n'
  if ((${#CHANGES[@]})); then
    printf '本次改动 %d 处：\n' "${#CHANGES[@]}"
    printf '  - %s\n' "${CHANGES[@]}"
  else
    echo '本次改动 0 处'
  fi
  if ((${#PENDING[@]})); then
    printf '待配 / 没查成 %d 项：\n' "${#PENDING[@]}"
    printf '  - %s\n' "${PENDING[@]}"
  fi
  if ((${#OTHERS[@]})); then
    printf '别家单元以 root 执行别人能改的文件 %d 处（不归 fleet-dao 管，不计入退出码，交人处置）\n' "${#OTHERS[@]}"
  fi
  if ((${#MUSTCLEAR[@]})); then
    printf '会话上线前必须清零 %d 项（别家单元，但 fleet 或会话用户改得了、又被 root 执行；不计入退出码）：\n' "${#MUSTCLEAR[@]}"
    printf '  - %s\n' "${MUSTCLEAR[@]}"
  fi
  if ((${#REDS[@]})); then
    printf '红 %d 项：\n' "${#REDS[@]}"
    printf '  - %s\n' "${REDS[@]}"
    exit 1
  fi
  if ((${#PENDING[@]})); then exit 2; fi
  echo '全绿'
  exit 0
}

# 装机停下（判红后 return 1，或命令意外失败）：记一笔、照样给出结论再退，别一个字不说就没了。
# 挂法：set -E 加 trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR。
on_error() {
  local rc=$? line=$1 cmd=$2
  # set -E 让命令替换里的失败也会进这里；那种失败由外层拿到的返回值说话，这里不管
  if [[ "$BASHPID" != "$$" ]]; then return 0; fi
  trap - ERR
  if [[ "$cmd" == return* ]]; then
    red "装机停在「${FUNCNAME[1]:-主流程}」这一步，原因见上一条红"
  else
    red "装机停在「${FUNCNAME[1]:-主流程}」：命令「$cmd」返回 $rc（第 $line 行）"
  fi
  finish
}

# ── 幂等零件 ──

# 属主、权限不对就改。权限写成 stat %a 的样子（750、640），不带前导 0。
fix_meta() { # 路径 属主:组 权限
  local path=$1 own=$2 mode=$3 have
  have=$(stat -c '%U:%G %a' -- "$path")
  if [[ "$have" == "$own $mode" ]]; then return 0; fi
  chown "$own" -- "$path"
  chmod "$mode" -- "$path"
  changed "改属主和权限 $path：$have → $own $mode"
}

# 内容、属主、权限都对就不动；要改就先写临时文件再原子换上，写到一半断了也不会留半个文件。
put_file() { # 目标 属主:组 权限 内容
  local dest=$1 own=$2 mode=$3 content=$4 tmp
  WROTE=0
  if [[ -f "$dest" && ! -L "$dest" ]] && cmp -s -- "$dest" <(printf '%s\n' "$content"); then
    fix_meta "$dest" "$own" "$mode"
    return 0
  fi
  tmp=$(mktemp "${dest%/*}/.fleet-dao-new.XXXXXX")
  printf '%s\n' "$content" >"$tmp"
  chown "$own" -- "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -- "$tmp" "$dest"
  changed "写 $dest"
}

ensure_dir() { # 路径 属主:组 权限
  local path=$1 own=$2 mode=$3
  WROTE=0
  if [[ -d "$path" && ! -L "$path" ]]; then
    fix_meta "$path" "$own" "$mode"
    return 0
  fi
  if [[ -e "$path" || -L "$path" ]]; then
    red "$path 已存在但不是目录，不动它"
    return 1
  fi
  install -d -o "${own%%:*}" -g "${own##*:}" -m "$mode" -- "$path"
  changed "建目录 $path（$own $mode）"
}

# 早先的版本装过、现在不要了的东西：在就删掉（只删装机脚本自己放的东西，路径逐个写死）
remove_legacy() { # 路径 说明
  WROTE=0
  if [[ -e "$1" || -L "$1" ]]; then
    rm -f -- "$1"
    changed "撤掉$2：$1"
  fi
}

ensure_symlink() { # 链接 指向
  local link=$1 target=$2
  WROTE=0
  if [[ -L "$link" && "$(readlink -- "$link")" == "$target" ]]; then return 0; fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    red "$link 已存在且不是符号链接，不替换"
    return 1
  fi
  ln -sfn -- "$target" "$link"
  changed "链接 $link → $target"
}

# 系统用户：没有就建；有但不是本脚本建的样子（家目录、组对不上）就判红，不去改别人的账号。
ensure_service_user() { # 用户名 家目录
  local name=$1 home=$2 entry uid gid have_home shell
  WROTE=0
  if ! getent group "$name" >/dev/null; then
    groupadd --system "$name"
    changed "建组 $name"
  fi
  if ! getent passwd "$name" >/dev/null; then
    useradd --system --gid "$name" --home-dir "$home" --create-home --shell /bin/bash --comment "fleet-dao" "$name"
    changed "建系统用户 $name（家目录 $home）"
  fi
  entry=$(getent passwd "$name")
  IFS=: read -r _ _ uid gid _ have_home shell <<<"$entry"
  if [[ "$have_home" != "$home" || "$gid" != "$(getent group "$name" | cut -d: -f3)" ]]; then
    red "用户 $name 已存在但不是装机脚本建的样子（uid $uid，家目录 $have_home，shell $shell）——停下等人看，不改别人的账号"
    return 1
  fi
  ok "用户 $name（uid $uid，家目录 $home）"
}

# 以服务用户身份跑命令：环境清空、HOME 和当前目录都换成它自己的家。runuser 两样都不换：
# 命令行工具会去读调用者家里的配置（审计 P03），当前目录还停在 /root 的话，它连自己在哪都读不到（corepack 实咬）。
as_user() { # 用户 命令…
  local user=$1 home
  shift
  home=$(getent passwd "$user" | cut -d: -f6)
  (cd -- "$home" && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" \
    PATH="$home/.local/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 "$@")
}

# ── 装包 ──
# 先模拟：要顺带升级机器上已经装着的包就停——那些库旧系统可能正在用。
# 装的时候关掉 needrestart：它会在装完后自动重启「用了旧库」的服务，那就动到旧系统了。
APT_UPDATED=0
apt_get() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l \
    apt-get -y -q --no-install-recommends -o DPkg::Lock::Timeout=600 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

ensure_pkgs() { # 包…
  local missing=() p sim upgrades
  WROTE=0
  for p in "$@"; do
    if [[ "$(dpkg-query -W -f '${Status}' "$p" 2>/dev/null)" != "install ok installed" ]]; then missing+=("$p"); fi
  done
  if ((${#missing[@]} == 0)); then
    ok "包已装：$*"
    return 0
  fi
  if ((APT_UPDATED == 0)); then
    if ! apt_get update >/dev/null; then
      red "apt-get update 失败"
      return 1
    fi
    APT_UPDATED=1
  fi
  if ! sim=$(apt_get -s install "${missing[@]}"); then
    red "apt 模拟安装失败：${missing[*]}"
    return 1
  fi
  upgrades=$(awk '/^Inst / && $3 ~ /^\[/ { print $2 }' <<<"$sim" | tr '\n' ' ')
  if [[ -n "$upgrades" ]]; then
    red "装 ${missing[*]} 要顺带升级已装的包（$upgrades）——可能碰到旧系统在用的库，停下等人看"
    return 1
  fi
  if ! apt_get install "${missing[@]}" >/dev/null; then
    red "apt 安装失败：${missing[*]}"
    return 1
  fi
  changed "装包 ${missing[*]}（连带新装：$(awk '/^Inst / { print $2 }' <<<"$sim" | tr '\n' ' ')）"
}

# ── 本机配置 ──
# 本机配置是 KEY=VALUE 文本，只当数据读、不 source：里面的东西不会被当成命令执行。
# 只认调用方列出的键；文件要属 root 且组和其他人不可写（谁能改它，谁就能决定装机脚本做什么）。
load_env() { # 文件 允许的键…
  local file=$1 line key val n=0 mode
  shift
  local allowed=" $* "
  if [[ ! -f "$file" ]]; then return 0; fi
  mode=$(stat -c '%a' -- "$file")
  if [[ "$(stat -c '%u' -- "$file")" != 0 ]] || ((8#$mode & 8#022)); then
    red "$file 不属 root 或别人能写（$(stat -c '%U:%G %a' -- "$file")），不读它"
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      red "$file 第 $n 行看不懂（应为 KEY=VALUE）"
      return 1
    fi
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    if [[ "$allowed" != *" $key "* ]]; then
      red "$file 第 $n 行的键 $key 不认识（认识的：$*）"
      return 1
    fi
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then val=${BASH_REMATCH[1]}; fi
    printf -v "$key" '%s' "$val"
  done <"$file"
}

# 模板渲染：把 @@KEY@@ 换成值，结果放进 RENDERED。纯文本替换、不经 sed，值里带 / & 之类也不会走样。
RENDERED=""
render() { # 模板 KEY=VALUE…
  local tpl=$1 kv key val
  shift
  RENDERED=$(<"$tpl")
  for kv in "$@"; do
    key=${kv%%=*}
    val=${kv#*=}
    RENDERED=${RENDERED//"@@${key}@@"/"$val"}
  done
  if [[ "$RENDERED" =~ @@[A-Z_]+@@ ]]; then
    red "模板 $tpl 里还有没替换的占位 ${BASH_REMATCH[0]}"
    return 1
  fi
}

# ── WireGuard ──

# 私钥在本机生成、不出机器；公钥放进 WG_PUBLIC_KEY，由调用方打印给另一台填。
WG_PUBLIC_KEY=""
ensure_wg_key() { # 接口名
  local key=/etc/wireguard/$1.key
  WROTE=0
  if [[ ! -s "$key" ]]; then
    (umask 077 && wg genkey >"$key.new")
    mv -f -- "$key.new" "$key"
    changed "生成 WireGuard 私钥 $key"
  fi
  fix_meta "$key" root:root 600
  WG_PUBLIC_KEY=$(wg pubkey <"$key")
}

valid_wg_key() { [[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]]; }

# ── 单元与端口 ──

unit_prop() { systemctl show -p "$2" --value "$1" 2>/dev/null; }

# 单元：没启用就启用，没在跑就起；配置变了（第二个参数为 1）就重启。起不来判红。
ensure_unit_running() { # 单元 要不要重启(0/1)
  local unit=$1 restart=$2
  if [[ "$(systemctl is-enabled "$unit" 2>/dev/null)" != enabled ]]; then
    systemctl enable --quiet "$unit"
    changed "启用 $unit"
  fi
  if [[ "$(systemctl is-active "$unit" 2>/dev/null)" != active ]]; then
    if ! systemctl start "$unit"; then
      red "$unit 起不来：journalctl -u $unit -n 50 看现场"
      return 1
    fi
    changed "启动 $unit"
  elif ((restart)); then
    if ! systemctl restart "$unit"; then
      red "$unit 重启失败：journalctl -u $unit -n 50 看现场"
      return 1
    fi
    changed "重启 $unit（配置变了）"
  fi
  if ! wait_active "$unit" 30; then
    red "$unit 没进入 active：journalctl -u $unit -n 50 看现场"
    return 1
  fi
}

# 等单元进入 active：按次数有界地等，读不到不当成功（审计 P09）
wait_active() { # 单元 次数
  local unit=$1 tries=$2 i state=""
  for ((i = 0; i < tries; i++)); do
    state=$(systemctl is-active "$unit" 2>/dev/null) || true
    if [[ "$state" == active ]]; then return 0; fi
    sleep 1
  done
  return 1
}

# 法国往香港传驾驶舱静态文件用的 ssh（france.sh 的读回和 release.sh 同一套）：只用那一把钥匙、只认钉住的主机钥匙、
# 不交互。香港那头把这把钥匙限死成 rrsync -wo /srv/fleet-dao-web，只许从隧道地址来（hk.sh）。
web_upload_ssh() { # 私钥 known_hosts
  printf 'ssh -i %s -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s -o ConnectTimeout=10' "$1" "$2"
}

# 谁在监听这个端口：打印进程号（空格分隔；没人听就空）。协议 tcp 或 udp。
port_pids() { # 协议 端口
  local flag=-ltnp
  if [[ "$1" == udp ]]; then flag=-lunp; fi
  ss -H "$flag" "sport = :$2" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | tr '\n' ' ' || true
}

# 这个端口有没有任何套接字在听（内核里的 WireGuard 套接字没有进程号，也要算上）
port_in_use() { # 协议 端口
  local flag=-ltn
  if [[ "$1" == udp ]]; then flag=-lun; fi
  [[ -n "$(ss -H "$flag" "sport = :$2" 2>/dev/null)" ]]
}

# ── 两台共用的读回与自检（要先 source snapshot.sh 与 root-exec-check.sh）──

# /etc/fleet-dao 放密钥：只有 root 和 fleet 读得到；旧系统的 orca 用户读不到。
readback_secrets_dir() {
  local members
  if [[ "$(stat -c '%U:%G %a' /etc/fleet-dao 2>/dev/null)" == "root:fleet 750" ]]; then
    ok "/etc/fleet-dao 是 root:fleet 750"
  else
    red "/etc/fleet-dao 属主或权限不对：$(stat -c '%U:%G %a' /etc/fleet-dao 2>&1)"
  fi
  members=$(getent group fleet | cut -d: -f4)
  if [[ -n "$members" ]]; then
    red "组 fleet 有附加成员（$members），他们也读得到 /etc/fleet-dao"
  else
    ok "组 fleet 没有附加成员"
  fi
  local u
  for u in orca "${SESSION_USERS[@]}"; do
    id "$u" >/dev/null 2>&1 || continue
    if runuser -u "$u" -- ls /etc/fleet-dao >/dev/null 2>&1; then
      red "$u 读得到 /etc/fleet-dao"
    else
      ok "$u 读不到 /etc/fleet-dao"
    fi
  done
  # 里面每个文件（手放进来的密钥也算）：属 root，组只许读，其他人什么都不许
  local f bad=0 n=0 mode
  while IFS= read -r -d '' f; do
    n=$((n + 1))
    mode=$(stat -c '%a' -- "$f")
    if [[ "$(stat -c '%u' -- "$f")" != 0 ]] || ((8#$mode & 8#027)); then
      red "$f 是 $(stat -c '%U:%G %a' -- "$f")，应属 root、组只读、其他人无权限（640 或 600）"
      bad=1
    fi
  done < <(find /etc/fleet-dao -type f -print0 2>/dev/null)
  if ((bad == 0)); then ok "/etc/fleet-dao 里 $n 个文件都属 root、组只读、其他人无权限"; fi
}

# 自检（审计 P02）：以 root 执行的文件要全链属 root、组和其他人不可写。
# 只有 fleet-dao 自己的单元违规才算装机红；别家单元单独列出、不计入退出码；
# 别家的问题里，fleet 或会话用户自己就改得了的（我们的进程被打穿就能借它拿 root），单列成「会话上线前必须清零」。
self_check_root_exec() {
  step "自检：以 root 执行的文件（审计 P02）"
  local rc=0 line unit path why node u who shown ours=0
  root_exec_check || rc=$?
  if ((rc == 2)); then
    pending "没查成：拿不到 systemctl show 的输出"
    return 0
  fi
  for line in "${REC_VIOLATIONS[@]}"; do
    IFS=$'\t' read -r unit path why node <<<"$line"
    shown="$unit | $path | $why"
    if [[ "$unit" =~ $SNAPSHOT_OURS_UNITS_RE ]]; then
      red "fleet-dao 自己的单元：$shown"
      ours=1
      continue
    fi
    who=""
    for u in "${WRITER_IDENTITIES[@]}"; do
      if [[ -n "$node" ]] && id "$u" >/dev/null 2>&1 && runuser -u "$u" -- test -w "$node" 2>/dev/null; then who+=" $u"; fi
    done
    if [[ -n "$who" ]]; then
      MUSTCLEAR+=("$shown（${who# } 就能改）")
      printf '  ! 会话上线前必须清零：%s（%s 就能改）\n' "$shown" "${who# }"
    else
      OTHERS+=("$shown")
      printf '  · 别家单元（不计入退出码）：%s\n' "$shown"
    fi
  done
  if ((ours == 0)); then ok "fleet-dao 自己的单元：以 root 执行的文件都全链属 root、组和其他人不可写"; fi
}

# 装机前后，不归 fleet-dao 管的单元状态、监听端口、防火墙应当一模一样。
# 按单元逐个比：原有单元变了或没了、多出监听端口、防火墙变了 → 红；装包新带进来、之前没有的单元只列出来备查。
compare_others() { # 装机前的快照
  local before=$1 after report kind line added=()
  step "旧系统有没有被碰"
  after=$(snapshot_others)
  report=$(awk -F '\n' '
    FNR == 1 { file++ }
    /^## / { sec = substr($0, 4); next }
    {
      split($0, w, " "); key = (sec == "listening") ? $0 : sec " " w[1]
      if (file == 1) b[key] = $0; else a[key] = $0
    }
    END {
      for (k in b) {
        if (!(k in a)) print "red\t没了：" b[k]
        else if (a[k] != b[k]) print "red\t变了：" b[k] " → " a[k]
      }
      for (k in a) if (!(k in b)) print ((k ~ /^units /) ? "new\t" : "red\t多了：") a[k]
    }' <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sort)
  while IFS=$'\t' read -r kind line; do
    if [[ "$kind" == red ]]; then red "旧系统有变化（别的服务自己重启也会出现在这里，逐条看）：$line"; fi
    if [[ "$kind" == new ]]; then added+=("${line%% *}"); fi
  done <<<"$report"
  if ((${#added[@]})); then ok "装包新带进来的单元（之前没有，不是旧系统的）：${added[*]}"; fi
  if [[ $'\n'"$report" != *$'\nred\t'* ]]; then ok "装机前后，旧系统的单元状态、监听端口、防火墙都没变"; fi
}
