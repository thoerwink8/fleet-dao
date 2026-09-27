#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2317,SC2329 # rm、mkdir 这些替身由被测的函数间接调用，shellcheck 看不出来
# deploy/lib/node-cache.sh（node 默认的编译缓存目录先由 root 建好）的判据，每条失败路径都故意造出来：
#   1. 拿真 node 看为什么要这样：目录归别的用户时，他能把 root 的 node 建的子目录换成自己的，root 的 node 照用；
#      目录归 root、755 时，别的用户的 node 用不了编译缓存（建不了子目录），root 的照用、子目录归 root、别人换不掉
#   2. 装：不在就建、写开机配置；第二遍一处不改；归别人、权限松、里面有别人的东西、是符号链接、是文件都判红，装的时候
#      整个删了重建（符号链接指向的东西不动）；开机配置被改、没了：读回判红，装的时候改回来
#   3. 删不掉、建不成、systemd-tmpfiles 跑不成：判红、返回 1；读不到属主、查不了里面归谁：判红，不当成没事
# 不碰真的 /tmp/node-compile-cache：目录和配置都放在临时目录里。
# 要 root：得建临时用户、以他的身份跑、改属主。用法：sudo bash deploy/test/node-cache.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/node-cache.sh
source "$HERE/../lib/node-cache.sh"

if ((EUID != 0)); then
  echo "node-cache：没跑成：要 root（得建临时用户、以他的身份跑、改属主）"
  exit 2
fi
if ! command -v systemd-tmpfiles >/dev/null; then
  echo "node-cache：没跑成：这台没有 systemd-tmpfiles"
  exit 2
fi
# 要有编译缓存的 node（22.1 起有 module.enableCompileCache）。sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]] && "$n" -e 'process.exit(typeof require("node:module").enableCompileCache === "function" ? 0 : 1)' 2>/dev/null; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then
  echo "node-cache：没跑成：这台找不到有编译缓存的 node（要 22.1 或更高）"
  exit 2
fi

U=fleet-ncc-test-$$
T=$(mktemp -d /var/tmp/node-cache-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "node-cache：没跑成：建不了临时用户 $U"
  exit 2
fi
mkdir -m 1777 "$T/tmp" # 像 /tmp：谁都能写、粘滞
mkdir "$T/tmpfiles.d"
D=$T/tmp/node-compile-cache
C=$T/tmpfiles.d/fleet-dao-node-compile-cache.conf
as_u() { runuser -u "$U" -- "$@"; }

# 以某个身份让 node 在这个目录下开编译缓存，打出结果（ENABLED、FAILED……）
NCC='const m = require("node:module");
const r = m.enableCompileCache(process.argv[1]);
const s = m.constants.compileCacheStatus;
console.log(Object.keys(s).find((k) => s[k] === r.status) ?? String(r.status));'
ncc() { # root 或 user
  if [[ $1 == root ]]; then
    env -i PATH=/usr/bin:/bin HOME=/root "$NODE" -e "$NCC" "$D"
  else
    as_u env -i PATH=/usr/bin:/bin HOME="$H" "$NODE" -e "$NCC" "$D"
  fi
}
owner_of() { stat -c '%U' -- "$1"; }

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

echo "== 1. 真 node：目录归别人时，root 的 node 用的子目录能被他换掉"
as_u mkdir -m 755 "$D"
check "root 的 node 照样开了编译缓存" "$(ncc root)" ENABLED
sub=$(find "$D" -mindepth 1 -maxdepth 1 -printf '%f\n')
check "建了一个 root 的子目录" "$(owner_of "$D/$sub")" root
as_u mv "$D/$sub" "$D/$sub.old"
as_u mkdir "$D/$sub"
check "对照：目录归他，他把 root 的子目录换成了自己的" "$(owner_of "$D/$sub")" "$U"
check "对照：root 的 node 下次照用他换上的子目录" "$(ncc root)" ENABLED
rm -rf -- "$D"

echo "== 1. 真 node：目录归 root、755 时"
mkdir -m 755 "$D"
check "别的用户的 node 用不了编译缓存" "$(ncc user)" FAILED
check "他什么都没建出来" "$(find "$D" -mindepth 1 | wc -l)" 0
check "root 的 node 照用" "$(ncc root)" ENABLED
sub=$(find "$D" -mindepth 1 -maxdepth 1 -printf '%f\n')
check "root 的子目录归 root" "$(owner_of "$D/$sub")" root
as_u mv "$D/$sub" "$D/$sub.old" 2>/dev/null
check "别的用户换不掉 root 的子目录" "$(owner_of "$D/$sub")" root
node_cache_ok "$D"
check "root 自己的子目录不算问题" "$?" 0
rm -rf -- "$D"

echo "== 2. 装：不在就建、写开机配置；第二遍一处不改"
CHANGES=() REDS=()
ensure_node_cache "$D" "$C" >/dev/null
check "返回 0" "$?" 0
check "没有红" "${#REDS[@]}" 0
check "记两笔改动（配置、目录）" "${#CHANGES[@]}" 2
has "改动写清建了目录" "${CHANGES[1]-}" "^建 $D，归 root、755$"
check "目录归 root、755" "$(stat -c '%U:%G %a' -- "$D")" "root:root 755"
check "开机配置照写" "$(cat -- "$C" | tail -1)" "d $D 0755 root root -"
check "开机配置归 root、644" "$(stat -c '%U:%G %a' -- "$C")" "root:root 644"
CHANGES=() REDS=()
ensure_node_cache "$D" "$C" >/dev/null
check "第二遍一处没改" "${#CHANGES[@]}" 0
check "第二遍没有红" "${#REDS[@]}" 0
REDS=()
check_node_cache "$D" "$C" >/dev/null
check "读回没有红" "${#REDS[@]}" 0

echo "== 2. 不对的样子：读回判红，装的时候删了重建"
expect_fixed() { # 说明 读回的红里要有的（grep -E）
  REDS=()
  check_node_cache "$D" "$C" >/dev/null
  check "$1：读回记一笔红" "${#REDS[@]}" 1
  has "$1：红里写清" "$(last_red)" "$2"
  CHANGES=() REDS=()
  ensure_node_cache "$D" "$C" >/dev/null
  check "$1：装的时候返回 0" "$?" 0
  check "$1：没有红" "${#REDS[@]}" 0
  has "$1：记删掉重建" "${CHANGES[*]-}" "删掉重建 $D"
  check "$1：重建后归 root、755、里面是空的" "$(stat -c '%U:%G %a' -- "$D") $(find "$D" -mindepth 1 | wc -l)" "root:root 755 0"
}
rm -rf -- "$D"
as_u mkdir -m 777 "$D"
as_u mkdir "$D/v22-x64-planted-0"
as_u touch "$D/v22-x64-planted-0/planted.cache"
expect_fixed "目录是会话建的、里面预先放了东西" "是「$U:$U 777」，要 root:root 755"
chmod 777 "$D"
expect_fixed "归 root 但谁都能写" '是「root:root 777」'
mkdir "$D/sub"
chown "$U" "$D/sub"
expect_fixed "归 root、755，里面有别人的东西" "里有不归 root 的：$D/sub（$U）"
rm -rf -- "$D"
mkdir "$T/target"
touch "$T/target/keep"
ln -s "$T/target" "$D"
expect_fixed "是符号链接" '是符号链接'
check "符号链接指向的东西不动" "$(test -e "$T/target/keep" && echo 在)" 在
rm -rf -- "$D"
touch "$D"
expect_fixed "是个文件" '不是目录'
rm -rf -- "$D"
REDS=()
check_node_cache "$D" "$C" >/dev/null
has "不在：读回判红" "$(last_red)" "不在（谁先建它，谁就能替别人放编译缓存）"
ensure_node_cache "$D" "$C" >/dev/null
echo '# 手改过' >"$C"
REDS=()
check_node_cache "$D" "$C" >/dev/null
has "开机配置被改：读回判红" "$(last_red)" "$C 不在或内容不对"
CHANGES=()
ensure_node_cache "$D" "$C" >/dev/null
check "开机配置被改：装的时候改回来" "${CHANGES[*]-}" "写 $C"
rm -f -- "$C"
REDS=()
check_node_cache "$D" "$C" >/dev/null
has "开机配置没了：读回判红" "$(last_red)" "$C 不在或内容不对"
ensure_node_cache "$D" "$C" >/dev/null

echo "== 3. 删不掉、建不成、systemd-tmpfiles 跑不成、查不成：判红"
chmod 777 "$D"
rm() { echo "rm: 故意删不掉" >&2; return 1; }
REDS=()
ensure_node_cache "$D" "$C" >/dev/null
check "删不掉：返回 1" "$?" 1
has "删不掉：红里写清" "$(last_red)" '想删掉重建，删不掉：rm: 故意删不掉'
unset -f rm
rm -rf -- "$D"
mkdir() { echo "mkdir: 故意建不成" >&2; return 1; }
REDS=()
ensure_node_cache "$D" "$C" >/dev/null
check "建不成：返回 1" "$?" 1
has "建不成：红里写清" "$(last_red)" '建不成（刚删就被人抢先建了？）：mkdir: 故意建不成'
unset -f mkdir
ensure_node_cache "$D" "$C" >/dev/null
systemd-tmpfiles() { echo "故意跑不成" >&2; return 1; }
REDS=()
ensure_node_cache "$D" "$C" >/dev/null
check "systemd-tmpfiles 跑不成：返回 1" "$?" 1
has "systemd-tmpfiles 跑不成：红里写清" "$(last_red)" "systemd-tmpfiles 照 $C 建目录没成.*故意跑不成"
unset -f systemd-tmpfiles
stat() { echo "stat: 故意读不到" >&2; return 1; }
node_cache_ok "$D"
check "读不到属主：不当成没事" "$?" 1
has "读不到属主：原因" "$NODE_CACHE_BAD" "读不到 $D 的属主和权限：stat: 故意读不到"
unset -f stat
find() { echo "find: 故意查不了" >&2; return 1; }
node_cache_ok "$D"
check "查不了里面归谁：不当成没事" "$?" 1
has "查不了里面归谁：原因" "$NODE_CACHE_BAD" "查 $D 里面归谁没查成：find: 故意查不了"
unset -f find
node_cache_ok "$D"
check "替身都撤了：目录照样是对的" "$?" 0

if ((fail)); then
  echo "node-cache：不通过"
  exit 1
fi
echo "node-cache：通过"
