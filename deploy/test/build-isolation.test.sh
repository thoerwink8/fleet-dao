#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 发布构建的沙箱（#79）。
# 抓住的错：沙箱命令不在、起不来、读回确认 /etc/fleet-dao 仍然可见时，发布仍往下走、或退回用 as_fleet_in
#   以 fleet 直接构建（那样第三方代码读得到密钥）；沙箱没挡住时，构建读得到 /etc/fleet-dao 下的诱饵、
#   或连得上本机库的 unix socket；只遮三个目录、仍看主机 /proc 时，同 UID 经 /proc/<pid>/root 绕路读密钥。
# 前几段不需要 root（systemd-run 换成桩）。独占创建和「不覆盖已有文件」在临时目录里演练，也不需要 root。
# 真沙箱那几段要 root；不是 root 就记没跑成、退出 2。
# 诱饵不用固定文件名：在目录里独占创建一个临时文件，退出只删本次这一个（设备号和 inode 都对上才删）。
# 已有同名文件、已有符号链接都不写。这台没有 fleet 账号时，家目录放在本次临时目录里，退出只删账号、不碰 /home/fleet。
# 用法：sudo bash deploy/test/build-isolation.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d) || exit 1
# 只删 mktemp 交出来的这一份。空路径、根、家目录、密钥目录、本机库目录都不碰；符号链接不跟。
rm_tmp() {
  case "$TMP" in
  "" | / | /tmp | /var/tmp | /etc | /etc/* | /home | /home/* | /var/run | /var/run/* | /run | /run/*) return 0 ;;
  esac
  if [[ -d "$TMP" && ! -L "$TMP" ]]; then rm -rf -- "$TMP"; fi
}
trap rm_tmp EXIT
NOBIN=$TMP/nobin
mkdir -p "$NOBIN" "$TMP/bin" "$TMP/releases"
chmod 755 "$TMP" "$TMP/bin" "$NOBIN"
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e
BARE_CALLS=$TMP/bare
LATER=$TMP/later
SRUN=$TMP/srun
OUT=$TMP/out
SHA=$(printf 'a%.0s' {1..40})
CANARY=fleet-build-isolation-canary-9f3a
BAIT=""
BAIT_ID=""
SOCK=""
SOCK_ID=""
SOCK_REAL=""
SOCK_DIR_ID=""
SOCK_LINK_ID=""
ETC_ID=""
SERVER_PID=""
CREATED_FLEET=0
EXCL_PATH=""
EXCL_ID=""
NODE_BIN=""
HOLDER_PID=""
fail=0
skipped=0

cleanup() {
  set +e
  if [[ -n "$HOLDER_PID" ]]; then
    kill "$HOLDER_PID" 2>/dev/null || true
    wait "$HOLDER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  remove_if_inode "$SOCK" "$SOCK_ID" socket
  if [[ -n "$SOCK_LINK_ID" && -L /var/run/postgresql ]]; then
    local now="" target=""
    now=$(stat -c '%d:%i' -- /var/run/postgresql 2>/dev/null || true)
    target=$(readlink -- /var/run/postgresql 2>/dev/null || true)
    if [[ "$now" == "$SOCK_LINK_ID" && "$target" == "$SOCK_REAL" ]]; then
      rm -f -- /var/run/postgresql
    fi
  fi
  remove_if_inode "$SOCK_REAL" "$SOCK_DIR_ID" dir
  remove_if_inode "$BAIT" "$BAIT_ID" file
  remove_if_inode /etc/fleet-dao "$ETC_ID" dir
  cleanup_fleet_user
  rm_tmp
  true
}

check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
# 输出里不许出现诱饵正文。失败时把正文换成占位再打印，避免把读到的内容再抄一遍
lacks_canary() { # 说明 文本
  if [[ "$2" == *"$CANARY"* ]]; then
    printf '  ✗ %s\n' "$1"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}
show() { # 文本：诱饵正文换成占位，截一段
  local t=${1//$CANARY/【内容已隐去】}
  printf '%.500s' "$t"
}

# 只删本次创建的那一个：符号链接不跟、inode 对不上不删。目录用 rmdir，不空就留着
remove_if_inode() { # 路径 设备:inode 种类 file|socket|dir
  local path=$1 id=$2 kind=$3 dir="" base="" ino="" now="" found=""
  if [[ -z "$path" || -z "$id" ]]; then return 0; fi
  if [[ ! -e "$path" && ! -L "$path" ]]; then return 0; fi
  if [[ -L "$path" ]]; then return 0; fi
  now=$(stat -c '%d:%i' -- "$path" 2>/dev/null || true)
  if [[ "$now" != "$id" ]]; then return 0; fi
  if [[ "$kind" == dir ]]; then
    rmdir -- "$path" 2>/dev/null || true
    return 0
  fi
  dir=$(dirname -- "$path")
  base=$(basename -- "$path")
  ino=${id#*:}
  found=$(find "$dir" -xdev -mindepth 1 -maxdepth 1 -inum "$ino" -name "$base" -print -quit 2>/dev/null || true)
  if [[ "$found" != "$path" ]]; then return 0; fi
  case "$kind" in
  file)
    if [[ -f "$path" && ! -L "$path" ]]; then rm -f -- "$path"; fi
    ;;
  socket)
    if [[ -S "$path" && ! -L "$path" ]]; then rm -f -- "$path"; fi
    ;;
  esac
}

# 写入已独占创建的普通文件。符号链接直接失败，不跟着写到链接目标。属组留空则不改属主
write_nofollow() { # 路径 设备:inode 正文 [属组 gid]
  "$NODE_BIN" "$TMP/write-nofollow.mjs" "$1" "$2" "$3" "${4:-}"
}

# 在目录里独占建一个临时文件并写入。成功时 EXCL_PATH、EXCL_ID 是本次这一个。失败不留下半截文件
exclusive_file() { # 目录 正文 [属组 gid]
  local dir=$1 body=$2 gid=${3:-} path="" id="" now=""
  EXCL_PATH=""
  EXCL_ID=""
  path=$(mktemp "$dir/fleet-build-isolation.XXXXXX") || return 1
  id=$(stat -c '%d:%i' -- "$path" 2>/dev/null || true)
  if [[ -z "$id" || -L "$path" ]]; then
    if [[ -n "$id" ]]; then remove_if_inode "$path" "$id" file; else rm -f -- "$path"; fi
    return 1
  fi
  if ! write_nofollow "$path" "$id" "$body" "$gid"; then
    remove_if_inode "$path" "$id" file
    return 1
  fi
  now=$(stat -c '%d:%i' -- "$path" 2>/dev/null || true)
  if [[ "$now" != "$id" || -L "$path" || ! -f "$path" ]]; then
    remove_if_inode "$path" "$id" file
    return 1
  fi
  EXCL_PATH=$path
  EXCL_ID=$id
}

# 缺账号时的家目录。只许落在本次临时目录里，计算偏了就拒绝往下建
new_fleet_home() { printf '%s\n' "$TMP/fleet-home"; }

prepare_fleet_user() {
  local home=""
  if id fleet >/dev/null 2>&1; then return 0; fi
  home=$(new_fleet_home)
  if [[ "$home" == /home/fleet || "$home" == /home/fleet/* || "$home" != "$TMP/"* ]]; then
    echo "  … 没跑成：临时家目录算到了不该碰的地方，停下，避免清掉已有数据"
    return 1
  fi
  if [[ -e "$home" || -L "$home" ]]; then
    echo "  … 没跑成：临时家目录已经被占了"
    return 1
  fi
  if ! mkdir -- "$home"; then
    echo "  … 没跑成：建不了临时家目录"
    return 1
  fi
  chmod 755 -- "$home" || return 1
  if ! useradd --system --user-group --no-create-home --home-dir "$home" --shell /usr/sbin/nologin fleet; then
    echo "  … 没跑成：建不了用户 fleet"
    rmdir -- "$home" 2>/dev/null || true
    return 1
  fi
  CREATED_FLEET=1
  chown --no-dereference fleet:fleet -- "$home" || true
}

# 只有本次 useradd 出来的账号才删。不带会把家目录一起删掉的选项；家目录在临时目录里，随临时目录收掉
cleanup_fleet_user() {
  local line="" members=""
  if ((CREATED_FLEET == 0)); then return 0; fi
  pkill -KILL -u fleet >/dev/null 2>&1 || true
  userdel fleet >/dev/null 2>&1 || true
  if id fleet >/dev/null 2>&1; then return 0; fi
  if ! line=$(getent group fleet 2>/dev/null); then return 0; fi
  members=${line##*:}
  if [[ -z "$members" ]]; then groupdel fleet >/dev/null 2>&1 || true; fi
}

trap cleanup EXIT

cat >"$TMP/write-nofollow.mjs" <<'JS'
import fs from "node:fs";
const [path, ident, body, gid] = process.argv.slice(2);
const before = fs.lstatSync(path);
if (before.isSymbolicLink()) process.exit(3);
if (`${before.dev}:${before.ino}` !== ident || !before.isFile()) process.exit(2);
let fd = -1;
try {
  fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  const st = fs.fstatSync(fd);
  if (`${st.dev}:${st.ino}` !== ident || !st.isFile()) process.exit(2);
  const text = body.endsWith("\n") ? body : `${body}\n`;
  fs.ftruncateSync(fd, 0);
  fs.writeFileSync(fd, text);
  if (gid) {
    fs.fchownSync(fd, 0, Number(gid));
    fs.fchmodSync(fd, 0o640);
  }
} finally {
  if (fd >= 0) fs.closeSync(fd);
}
JS

find_node() {
  local n=""
  for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
    if [[ -n "$n" && -x "$n" ]]; then NODE_BIN=$n; return 0; fi
  done
  return 1
}

# 桩：发布后半段一旦被叫到就记一笔。构建没走完不该碰这些
fetch_code() { SHA=$1; ON_MAIN=1; }
drain_request() { :; }
hk_reachable() { echo hk >>"$LATER"; }
schema_allows() { echo schema >>"$LATER"; }
drain_engine() { echo drain >>"$LATER"; }
migrate() { echo migrate >>"$LATER"; }
load_catalog() { echo catalog >>"$LATER"; }
load_routing() { echo routing >>"$LATER"; }
api_report_before() { echo api >>"$LATER"; printf ok; }
apply_config() { echo config >>"$LATER"; }
activate() { echo activate >>"$LATER"; }
health_gate() { echo health >>"$LATER"; }
prune() { echo prune >>"$LATER"; }
# 退回裸 as_fleet_in 时这里会留下一行。返回 0：退回了的话发布还会假装建成，靠「发布必须失败」抓住
as_fleet_in() {
  printf '%s\n' "$*" >>"$BARE_CALLS"
  return 0
}
systemd-run() {
  printf '%s\n' "$*" >>"$SRUN"
  case ${STUB_MODE:-} in
  visible)
    printf visible
    return 0
    ;;
  down)
    echo "unit failed to start" >&2
    return 1
    ;;
  *)
    echo "stub systemd-run 没有模式" >&2
    return 1
    ;;
  esac
}

# 在 set -e 里走一遍发布。模式 missing：PATH 里没有 systemd-run
run_release() {
  : >"$BARE_CALLS"
  : >"$LATER"
  : >"$SRUN"
  (
    set -e
    if [[ "$1" == missing ]]; then
      unset -f systemd-run
      PATH=$NOBIN
      hash -r
    fi
    do_release "$SHA"
  )
  REL_RC=$?
}
lines() { wc -l <"$1" | tr -d ' '; }
later_n() { if [[ -f "$LATER" ]]; then lines "$LATER"; else echo 0; fi; }
bare_n() { if [[ -f "$BARE_CALLS" ]]; then lines "$BARE_CALLS"; else echo 0; fi; }
srun_text() { cat -- "$SRUN" 2>/dev/null || true; }

echo "== 沙箱命令不在：发布失败，不切版本，不调用 as_fleet_in"
BUILD_SANDBOX_STATE=""
run_release missing >"$OUT" 2>&1
out=$(cat -- "$OUT")
check "退出码不是 0" "$([[ "$REL_RC" != 0 ]] && echo fail || echo ok)" fail
check "红里写没有 systemd-run" "$(grep -c '没有 systemd-run' <<<"$out" | tr -d ' ')" 1
check "红里写不退回用 fleet 直接构建" "$(grep -c '不退回' <<<"$out" | tr -d ' ')" 1
check "没有调用 as_fleet_in" "$(bare_n)" 0
check "没有切版本、也没走到迁移" "$(later_n)" 0
check "current 没指到这一版" "$(current_sha)" ""

echo "== 没有 unshare：发布失败，不调用 as_fleet_in"
: >"$BARE_CALLS"
: >"$LATER"
: >"$SRUN"
cat >"$TMP/bin/systemd-run" <<'EOF'
#!/bin/bash
echo "stub systemd-run should not run when unshare is missing" >&2
exit 1
EOF
chmod 755 "$TMP/bin/systemd-run"
BUILD_SANDBOX_STATE=""
(
  set -e
  unset -f systemd-run
  PATH=$TMP/bin
  hash -r
  do_release "$SHA"
) >"$OUT" 2>&1
REL_RC=$?
out=$(cat -- "$OUT")
check "退出码不是 0" "$([[ "$REL_RC" != 0 ]] && echo fail || echo ok)" fail
check "红里写没有 unshare" "$(grep -c '没有 unshare' <<<"$out" | tr -d ' ')" 1
check "红里写不退回" "$(grep -c '不退回' <<<"$out" | tr -d ' ')" 1
check "没有调用 as_fleet_in" "$(bare_n)" 0
check "没有切版本" "$(later_n)" 0
rm -f -- "$TMP/bin/systemd-run"

echo "== 沙箱起不来：发布失败，不调用 as_fleet_in"
STUB_MODE=down
BUILD_SANDBOX_STATE=""
run_release down >"$OUT" 2>&1
out=$(cat -- "$OUT")
check "退出码不是 0" "$([[ "$REL_RC" != 0 ]] && echo fail || echo ok)" fail
check "红里写沙箱起不来" "$(grep -c '沙箱起不来' <<<"$out" | tr -d ' ')" 1
check "红里写不退回" "$(grep -c '不退回' <<<"$out" | tr -d ' ')" 1
check "没有调用 as_fleet_in" "$(bare_n)" 0
check "没有切版本" "$(later_n)" 0
check "探针之后没有跑 pnpm 或 tar" "$(grep -cE 'pnpm|tar -x' <<<"$(srun_text)" || true)" 0
srun=$(srun_text)
check "沙箱不带 PrivateUsers" "$([[ "$srun" == *'PrivateUsers'* ]] && echo bad || echo ok)" ok
check "沙箱不带 --uid" "$([[ "$srun" == *'--uid'* ]] && echo bad || echo ok)" ok
check "沙箱里用 setpriv 降成 fleet" "$([[ "$srun" == *'setpriv --reuid=fleet --regid=fleet --init-groups --no-new-privs'* ]] && echo ok || echo bad)" ok
check "沙箱带 NoNewPrivileges 和 InaccessiblePaths" "$([[ "$srun" == *'NoNewPrivileges=true'* && "$srun" == *'InaccessiblePaths=-/etc/fleet-dao'* ]] && echo ok || echo bad)" ok
check "沙箱经 unshare 自建 PID 命名空间" "$([[ "$srun" == *'unshare'* && "$srun" == *'--pid'* && "$srun" == *'--mount-proc'* ]] && echo ok || echo bad)" ok

echo "== 读回确认 /etc/fleet-dao 仍然可见：发布失败，不调用 as_fleet_in"
STUB_MODE=visible
BUILD_SANDBOX_STATE=""
run_release visible >"$OUT" 2>&1
out=$(cat -- "$OUT")
check "退出码不是 0" "$([[ "$REL_RC" != 0 ]] && echo fail || echo ok)" fail
check "红里写仍然可见" "$(grep -c '仍然可见' <<<"$out" | tr -d ' ')" 1
check "红里写不退回" "$(grep -c '不退回' <<<"$out" | tr -d ' ')" 1
check "没有调用 as_fleet_in" "$(bare_n)" 0
check "没有切版本" "$(later_n)" 0
check "探针之后没有跑 pnpm 或 tar" "$(grep -cE 'pnpm|tar -x' <<<"$(srun_text)" || true)" 0

echo "== 独占创建：已有文件和符号链接都不动，清理只删本次这一个；家目录不放 /home/fleet"
home=$(new_fleet_home)
check "缺账号时家目录在本次临时目录里" "$([[ "$home" == "$TMP/fleet-home" ]] && echo ok || echo bad)" ok
check "缺账号时家目录不是 /home/fleet" "$([[ "$home" == /home/fleet || "$home" == /home/fleet/* ]] && echo bad || echo ok)" ok
useradd_line=$(declare -f prepare_fleet_user | grep -F useradd || true)
useradd_stripped=${useradd_line//--no-create-home/}
clean_src=$(declare -f cleanup_fleet_user)
check "useradd 不把家目录指到 /home/fleet" "$([[ "$useradd_line" == *'/home/fleet'* ]] && echo bad || echo ok)" ok
check "useradd 不带会照着已有家目录创建的选项" "$([[ "$useradd_stripped" == *'--create-home'* ]] && echo bad || echo ok)" ok
check "清理账号不会把家目录一起删掉" "$([[ "$clean_src" == *'--remove'* || "$clean_src" == *'userdel -r'* || "$clean_src" == *'userdel -rf'* ]] && echo bad || echo ok)" ok
check "清理函数里不出现 /home/fleet" "$([[ "$clean_src" == *'/home/fleet'* ]] && echo bad || echo ok)" ok

if ! find_node; then
  echo "  … 没跑成：找不到 node，独占写入演练和连 socket 都试不了"
  skipped=1
else
  REH=$TMP/rehearsal
  mkdir -p "$REH/dir"
  printf '%s\n' 'KEEP-FILE' >"$REH/dir/fleet-build-isolation-bait"
  printf '%s\n' 'KEEP-TARGET' >"$REH/secret"
  ln -s -- "$REH/secret" "$REH/dir/already-link"
  keep_file=$REH/keep-file
  keep_target=$REH/keep-target
  cp -- "$REH/dir/fleet-build-isolation-bait" "$keep_file"
  cp -- "$REH/secret" "$keep_target"
  if ! exclusive_file "$REH/dir" 'REH-BODY'; then
    printf '  ✗ 在临时目录里独占建文件失败\n'
    fail=1
  else
    check "新建的是另一个临时文件" "$([[ "$EXCL_PATH" != "$REH/dir/fleet-build-isolation-bait" && "$EXCL_PATH" == "$REH/dir"/fleet-build-isolation.* ]] && echo ok || echo bad)" ok
    check "已有同名文件还在" "$(cmp -s "$REH/dir/fleet-build-isolation-bait" "$keep_file" && echo ok || echo bad)" ok
    check "已有符号链接的目标没被写" "$([[ -L "$REH/dir/already-link" ]] && cmp -s "$REH/secret" "$keep_target" && echo ok || echo bad)" ok
    printf '%s\n' 'REH-BODY' >"$REH/expect-body"
    check "独占文件里是本次写的正文" "$(cmp -s "$EXCL_PATH" "$REH/expect-body" && echo ok || echo bad)" ok
    created=$EXCL_PATH
    created_id=$EXCL_ID
    remove_if_inode "$created" "$created_id" file
    check "清理删掉了本次这一个" "$([[ -e "$created" || -L "$created" ]] && echo still || echo gone)" gone
    check "清理后已有文件还在" "$(cmp -s "$REH/dir/fleet-build-isolation-bait" "$keep_file" && echo ok || echo bad)" ok
    # 原文件先挪走（inode 还占着，不会马上被复用），原路径再放一个新文件。按旧 inode 清理不得删掉新的
    swap=$(mktemp "$REH/dir/fleet-build-isolation.XXXXXX")
    swap_id=$(stat -c '%d:%i' -- "$swap")
    mv -- "$swap" "$swap.moved"
    printf '%s\n' 'THEIRS' >"$swap"
    remove_if_inode "$swap" "$swap_id" file
    printf '%s\n' 'THEIRS' >"$REH/expect-theirs"
    check "inode 对不上就不删后来的文件" "$(cmp -s "$swap" "$REH/expect-theirs" && echo ok || echo bad)" ok
    check "旧 inode 那个文件还在挪走的位置" "$([[ -f "$swap.moved" ]] && echo ok || echo bad)" ok
    rm -f -- "$swap" "$swap.moved"
    # 同名换成符号链接再写：必须失败，链接目标保持原样
    held=$(mktemp "$REH/dir/fleet-build-isolation.XXXXXX")
    held_id=$(stat -c '%d:%i' -- "$held")
    rm -f -- "$held"
    ln -s -- "$REH/secret" "$held"
    if write_nofollow "$held" "$held_id" 'PWNED'; then
      printf '  ✗ 往符号链接上写竟然成功了\n'
      fail=1
    else
      printf '  ✓ 往符号链接上写被拒绝\n'
    fi
    check "拒绝之后链接目标没变" "$(cmp -s "$REH/secret" "$keep_target" && echo ok || echo bad)" ok
    if [[ -L "$held" && "$(readlink -- "$held")" == "$REH/secret" ]]; then rm -f -- "$held"; fi
  fi
fi

echo "== 真沙箱：构建环境里读诱饵失败并报出路径；连本机库 socket 被拒"
if ((EUID != 0)) || [[ ! -d /run/systemd/system ]] || ! command -v runuser >/dev/null; then
  echo "  … 没跑成：要 root 和 systemd（sudo bash deploy/test/build-isolation.test.sh）"
  skipped=1
elif ((skipped == 0)); then
  unset -f systemd-run
  hash -r
  if ! prepare_fleet_user; then skipped=1; fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  if [[ -L /etc/fleet-dao ]]; then
    echo "  … 没跑成：/etc/fleet-dao 是符号链接，不往链接目标里放诱饵"
    skipped=1
  elif [[ ! -d /etc/fleet-dao ]]; then
    if mkdir --mode=750 -- /etc/fleet-dao; then
      ETC_ID=$(stat -c '%d:%i' -- /etc/fleet-dao)
      chown --no-dereference root:fleet -- /etc/fleet-dao || skipped=1
    else
      echo "  … 没跑成：建不了 /etc/fleet-dao"
      skipped=1
    fi
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  gid=$(id -g fleet 2>/dev/null || true)
  if [[ -z "$gid" ]]; then
    echo "  … 没跑成：读不到 fleet 的属组"
    skipped=1
  elif ! exclusive_file /etc/fleet-dao "$CANARY" "$gid"; then
    echo "  … 没跑成：在 /etc/fleet-dao 里独占建不了诱饵"
    skipped=1
  else
    BAIT=$EXCL_PATH
    BAIT_ID=$EXCL_ID
    printf '%s\n' "$CANARY" >"$TMP/bait.expected"
    got=$TMP/bait.got
    if ! runuser -u fleet -- cat -- "$BAIT" >"$got"; then
      echo "  … 没跑成：沙箱外 fleet 读不到诱饵，没法证明是沙箱挡住的"
      skipped=1
    elif ! cmp -s "$got" "$TMP/bait.expected"; then
      echo "  … 没跑成：沙箱外读到的不是这次写的诱饵"
      skipped=1
    fi
    rm -f -- "$got"
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  if [[ ! "$BAIT" =~ ^/etc/fleet-dao/fleet-build-isolation\.[A-Za-z0-9]+$ ]]; then
    echo "  … 没跑成：诱饵路径不是这次独占创建的临时文件"
    skipped=1
  else
    "$NODE_BIN" - "$TMP/bin/pnpm" "$BAIT" <<'JS'
const fs = require("node:fs");
const [out, target] = process.argv.slice(2);
const src = `#!/bin/bash
target=${JSON.stringify(target)}
if content=$(cat -- "$target" 2>&1); then
  printf '%s\\n' "$content"
  exit 0
fi
printf '%s\\n' "$content" >&2
exit 1
`;
fs.writeFileSync(out, src);
JS
    chmod 755 "$TMP/bin/pnpm"
    CACHE=$RELEASES/.repo.git
    git init -q "$CACHE"
    echo x >"$CACHE/README"
    git -C "$CACHE" add README
    git -C "$CACHE" -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false commit -q -m test
    SHA=$(git -C "$CACHE" rev-parse HEAD)
    FLEET_BUILD_PATH_PREFIX=$TMP/bin
    BUILD_SANDBOX_STATE=""
    STUB_MODE=""
    run_release live >"$OUT" 2>&1
    out=$(cat -- "$OUT")
    FLEET_BUILD_PATH_PREFIX=""
    check "读诱饵时构建失败" "$([[ "$REL_RC" != 0 ]] && echo fail || echo ok)" fail
    if [[ "$out" == *"$BAIT"* ]]; then
      printf '  ✓ 构建输出里有诱饵路径\n'
    else
      printf '  ✗ 构建输出里没有诱饵路径：%s\n' "$(show "$out")"
      fail=1
    fi
    lacks_canary "构建输出里没有诱饵内容" "$out"
    check "读诱饵时没有调用 as_fleet_in" "$(bare_n)" 0
    check "读诱饵时没有切版本" "$(later_n)" 0

    SOCK_REAL=$(readlink -f /var/run/postgresql 2>/dev/null || true)
    if [[ -z "$SOCK_REAL" ]]; then SOCK_REAL=/run/postgresql; fi
    if [[ -L "$SOCK_REAL" ]]; then
      echo "  … 没跑成：本机库 socket 目录解析完仍是符号链接"
      skipped=1
    elif [[ ! -d "$SOCK_REAL" ]]; then
      if mkdir --mode=755 -- "$SOCK_REAL"; then
        SOCK_DIR_ID=$(stat -c '%d:%i' -- "$SOCK_REAL")
      else
        echo "  … 没跑成：建不了本机库 socket 目录"
        skipped=1
      fi
    fi
    if ((skipped == 0)) && [[ ! -e /var/run/postgresql && ! -L /var/run/postgresql ]]; then
      if ln -s -- "$SOCK_REAL" /var/run/postgresql; then
        SOCK_LINK_ID=$(stat -c '%d:%i' -- /var/run/postgresql)
      else
        echo "  … 没跑成：建不了 /var/run/postgresql 链接"
        skipped=1
      fi
    fi
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  sock_hold=$(mktemp "$SOCK_REAL/.fleet-build-isolation.XXXXXX") || sock_hold=""
  if [[ -z "$sock_hold" ]]; then
    echo "  … 没跑成：在本机库目录里独占建不了 socket 用的名字"
    skipped=1
  else
    sock_hold_id=$(stat -c '%d:%i' -- "$sock_hold")
    remove_if_inode "$sock_hold" "$sock_hold_id" file
    SOCK=$sock_hold
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  cat >"$TMP/sock-server.mjs" <<'JS'
import net from "node:net";
import fs from "node:fs";
const p = process.argv[2];
try {
  fs.lstatSync(p);
  console.error("socket path already exists");
  process.exit(1);
} catch (e) {
  if (e.code !== "ENOENT") {
    console.error(e.message);
    process.exit(1);
  }
}
process.umask(0);
net.createServer((c) => { c.end("OPEN-MARKER"); }).listen(p);
JS
  cat >"$TMP/sock-client.mjs" <<'JS'
import net from "node:net";
const p = process.argv[2];
const s = net.createConnection(p);
const timer = setTimeout(() => { console.log("REJECTED timeout " + p); process.exit(1); }, 2000);
s.on("error", (e) => { clearTimeout(timer); console.log("REJECTED " + e.code + " " + p); process.exit(1); });
s.on("data", (d) => { clearTimeout(timer); process.stdout.write("OPEN " + d.toString()); process.exit(0); });
JS
  chmod 755 "$TMP/sock-server.mjs" "$TMP/sock-client.mjs"
  "$NODE_BIN" "$TMP/sock-server.mjs" "$SOCK" &
  SERVER_PID=$!
  ok_sock=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [[ -S "$SOCK" ]]; then ok_sock=1; break; fi
    sleep 0.1
  done
  if ((ok_sock == 0)); then
    echo "  … 没跑成：本机库目录里没建起测试用的 socket"
    skipped=1
  else
    SOCK_ID=$(stat -c '%d:%i' -- "$SOCK")
    outside=$(runuser -u fleet -- "$NODE_BIN" "$TMP/sock-client.mjs" "/var/run/postgresql/${SOCK##*/}" 2>&1) || true
    if [[ "$outside" != OPEN\ OPEN-MARKER* && "$outside" != *OPEN-MARKER* ]]; then
      echo "  … 没跑成：沙箱外连测试 socket 也不通（${outside//OPEN-MARKER/标记}），没法证明是沙箱挡住的"
      skipped=1
    else
      STAGE=$TMP/stage
      install -d -o fleet -g fleet -m 750 "$STAGE"
      BUILD_SANDBOX_STATE=""
      try_sock() { # 路径
        local rc=0 text
        text=$(as_build_in "$STAGE" "$NODE_BIN" "$TMP/sock-client.mjs" "$1" 2>&1) || rc=$?
        check "沙箱里连 $1 失败" "$([[ "$rc" != 0 ]] && echo fail || echo ok)" fail
        if [[ "$text" == *'REJECTED '* ]]; then
          printf '  ✓ 沙箱里连 %s 被拒\n' "$1"
        else
          printf '  ✗ 沙箱里连 %s 没有被拒：%s\n' "$1" "${text//OPEN-MARKER/标记}"
          fail=1
        fi
        if [[ "$text" == *OPEN-MARKER* ]]; then
          printf '  ✗ 沙箱里连 %s 拿到了通的标记\n' "$1"
          fail=1
        else
          printf '  ✓ 沙箱里连 %s 没有拿到通的标记\n' "$1"
        fi
      }
      try_sock "/var/run/postgresql/${SOCK##*/}"
      if [[ "/var/run/postgresql/${SOCK##*/}" != "$SOCK" ]]; then
        try_sock "$SOCK"
      fi
      check "连 socket 时没有调用 as_fleet_in" "$(bare_n)" 0
    fi
  fi
fi

echo "== 真沙箱：经 /proc/<pid>/root 绕路读诱饵失败（同 UID 主机进程）"
# 对照组：读的进程用 setpriv 成 fleet 后自己起占位再读（yama.ptrace_scope=1 只放行祖先）。
# 不用 runuser：它的 $! 是 root 的 PAM 父进程，fleet 去读会被拒。沙箱用例的占位用
# setpriv 直接 exec，$! 就是 fleet 的 sleep；读之前打一行 stat 属主，应是 fleet。
if ((EUID == 0)) && ((skipped == 0)) && [[ -n "$BAIT" && -n "$BAIT_ID" ]]; then
  STAGE=$TMP/stage-proc
  install -d -o fleet -g fleet -m 750 "$STAGE"
  # 读进程用 setpriv 成 fleet 后自己起占位再读（yama 只放行祖先）。已是 fleet 就直接 sleep：
  # 再套一层 setpriv --init-groups 没有 CAP_SETGID 会失败；$! 仍是本 shell 的 fleet 子进程，
  # 不是 runuser 那种留下收 PAM 的 root 父进程。
  # shellcheck disable=SC2016 # 单引号里是给 setpriv 内 bash 跑的脚本，$holder、$bait 要在里面展开
  outside=$(setpriv --reuid=fleet --regid=fleet --init-groups -- bash -c '
set -uo pipefail
bait=$1
sleep 3600 &
holder=$!
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -d /proc/$holder ]]; then ok=1; break; fi
  sleep 0.1
done
if ((ok == 0)); then
  printf "%s\n" "NOHOLDER"
  exit 2
fi
printf "HOLDER_USER=%s\n" "$(stat -c "%U" /proc/$holder)"
bypass="/proc/${holder}/root${bait}"
if ! content=$(cat -- "$bypass" 2>&1); then
  printf "%s\n" "READFAIL ${content}"
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  exit 3
fi
printf "%s" "$content"
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
exit 0
' bash "$BAIT" 2>&1) || true
  holder_user=""
  if [[ "$outside" == HOLDER_USER=* ]]; then
    holder_user=${outside#HOLDER_USER=}
    holder_user=${holder_user%%$'\n'*}
  fi
  printf '  … 对照组占位进程属主：%s\n' "${holder_user:-（未打出）}"
  # 正文在 HOLDER_USER= 行之后；剥掉首行再比诱饵
  outside_body=${outside#*$'\n'}
  if [[ "$outside" == *NOHOLDER* ]]; then
    echo "  … 没跑成：对照组起不了主机上的 fleet 占位进程"
    skipped=1
  elif [[ "$holder_user" != fleet ]]; then
    echo "  … 没跑成：对照组占位进程不是 fleet（${holder_user:-空}），setpriv 起出来的不是 fleet 身份"
    skipped=1
  elif [[ "$outside_body" != "$CANARY" && "$outside_body" != "$CANARY"$'\n' ]]; then
    echo "  … 没跑成：沙箱外经 /proc/<pid>/root 也读不到诱饵（${outside//$CANARY/【内容已隐去】}），没法证明是沙箱挡住的"
    skipped=1
  else
    printf '  ✓ 沙箱外同 UID 经 /proc/<pid>/root 能读到诱饵（基线）\n'
    # 沙箱用例：主机上另起一个 fleet 占位（setpriv 直接 exec，$! 就是它），沙箱里去读应被拒
    setpriv --reuid=fleet --regid=fleet --init-groups -- sleep 3600 &
    HOLDER_PID=$!
    holder_ok=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [[ -d /proc/$HOLDER_PID ]]; then holder_ok=1; break; fi
      sleep 0.1
    done
    sandbox_user=$(stat -c '%U' /proc/$HOLDER_PID 2>/dev/null || true)
    printf '  … 沙箱用例占位进程属主：%s\n' "${sandbox_user:-（未打出）}"
    if ((holder_ok == 0)) || [[ "$sandbox_user" != fleet ]]; then
      echo "  … 没跑成：沙箱用例起不了主机上的 fleet 占位进程（属主 ${sandbox_user:-空}）"
      skipped=1
    else
      bypass_path="/proc/${HOLDER_PID}/root${BAIT}"
      : >"$BARE_CALLS"
      BUILD_SANDBOX_STATE=""
      rc=0
      text=$(as_build_in "$STAGE" bash -c "cat -- \"$bypass_path\"" 2>&1) || rc=$?
      check "沙箱里经 /proc/<pid>/root 读诱饵失败" "$([[ "$rc" != 0 ]] && echo fail || echo ok)" fail
      if [[ "$text" == *"$bypass_path"* || "$text" == *"$BAIT"* || "$text" == *"/proc/${HOLDER_PID}/root"* ]]; then
        printf '  ✓ 构建输出里有绕路路径\n'
      else
        printf '  ✗ 构建输出里没有绕路路径：%s\n' "$(show "$text")"
        fail=1
      fi
      lacks_canary "绕路输出里没有诱饵内容" "$text"
      # 扫一遍沙箱 /proc：任一 root/etc/fleet-dao 可读都算没隔开
      # shellcheck disable=SC2016 # 单引号里是给沙箱内 bash 跑的脚本，$root、/proc/[0-9]*/root 这些要在里面展开
      scan=$(as_build_in "$STAGE" bash -c '
for root in /proc/[0-9]*/root; do
  [[ -e "$root" ]] || continue
  if [[ -d "$root/etc/fleet-dao" && -r "$root/etc/fleet-dao" && -x "$root/etc/fleet-dao" ]]; then
    printf "%s\n" "LEAK $root/etc/fleet-dao"
    exit 0
  fi
done
printf "%s\n" "NOLEAK"
exit 1
' 2>&1)
      # NOLEAK 含 LEAK 子串，不能写 != *LEAK*；泄漏行是「LEAK 路径」，用带空格的前缀区分
      check "沙箱里扫 /proc/*/root 看不到密钥目录" "$([[ "$scan" == *NOLEAK* && "$scan" != *"LEAK "* ]] && echo ok || echo bad)" ok
      check "绕路时没有调用 as_fleet_in" "$(bare_n)" 0
    fi
  fi
  if [[ -n "$HOLDER_PID" ]]; then
    kill "$HOLDER_PID" 2>/dev/null || true
    wait "$HOLDER_PID" 2>/dev/null || true
    HOLDER_PID=""
  fi
elif ((EUID != 0)); then
  echo "  … 没跑成：要 root 和 systemd（sudo bash deploy/test/build-isolation.test.sh）"
  skipped=1
fi

if ((fail)); then
  echo "build-isolation：不通过"
  exit 1
fi
if ((skipped)); then
  echo "build-isolation：没跑成"
  exit 2
fi
echo "build-isolation：通过"
