#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # SRC、RELEASE_ENV 这些是给 source 进来的 fleet-demo-scopes.sh 里的函数读的
# 演示版的可见范围推到香港（deploy/france/fleet-demo-scopes.sh）：认得的推、认不出的不推并退出 1、作废就是少一个文件、
# 路径跟着 release.env、推的时候目录又变了会再推一轮、香港连不上退出 2。rsync 换成桩（把「推」落到临时目录里的假香港），
# 认文件那一段用的是脚本里的真代码。后端写出来的文件长什么样，packages/api/test/demo.test.ts 按同一个样子核对。
# 用法：bash deploy/test/demo-scopes.test.sh。退出码：0 通过，1 不通过。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_HK_RSYNC_LOCK=$TMP/hk-rsync.lock
# shellcheck source=../france/fleet-demo-scopes.sh
source "$HERE/../france/fleet-demo-scopes.sh"
set +e # 脚本开了 -e；这里自己判每一步
MY_HK_RSYNC=$(declare -f hk_rsync) # 末尾和 common.sh 那份比
SRC=$TMP/src/scopes
RELEASE_ENV=$TMP/release.env
HK=$TMP/hk
mkdir -p "$SRC" "$HK"

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}

# ── 桩：rsync 把暂存目录的 scopes/ 整个换到假香港 <路径>scopes/（同 --delete 的效果），并记下参数 ──
RSYNC_FAIL=0
# 下一次推的时候顺手跑一下（造「推的过程中目录又变了」）。rsync 在脚本的子 shell 里跑，只跑一次靠标记文件记
RSYNC_HOOK=""
rsync() {
  printf '%s\n' "$*" >>"$TMP/rsync.log"
  if ((RSYNC_FAIL)); then
    echo "ssh: connect to host 10.99.0.1 port 22: Connection timed out" >&2
    return 255
  fi
  local src=${*: -2:1} dest=${*: -1} path
  path=${dest#root@10.99.0.1:}
  rm -rf -- "$HK${path}scopes"
  mkdir -p -- "$HK${path}scopes"
  cp -- "$src"scopes/* "$HK${path}scopes/" 2>/dev/null
  if [[ -n "$RSYNC_HOOK" && ! -e "$TMP/hook.done" ]]; then
    : >"$TMP/hook.done"
    eval "$RSYNC_HOOK"
  fi
  return 0
}
run() { # 跑一次 main：退出码进 RC，输出进 OUT
  : >"$TMP/rsync.log"
  OUT=$( (
    set -Eeuo pipefail
    main
  ) 2>&1)
  RC=$?
}
published() { find "$HK/${1:-demo}/scopes" -type f -printf '%f\n' 2>/dev/null | sort | tr '\n' ' '; }

ID1=$(printf 'a%.0s' {1..64})
ID2=$(printf 'b%.0s' {1..64})
ID3=$(printf 'c%.0s' {1..64})
ALL='"board","task","dispatch","channels","quota","schedules","notifications","audit","settings"'
# 后端写的样子：JSON.stringify({ v, modules, detail, expiresAt? }) 加一个换行
printf '{"v":1,"modules":[%s],"detail":"process","expiresAt":"2026-10-02T08:00:00.000Z"}\n' "$ALL" >"$SRC/$ID1.json"
printf '{"v":1,"modules":["board"],"detail":"status","expiresAt":"2026-10-02T08:00:00Z"}\n' >"$SRC/$ID2.json"
printf '{"v":1,"modules":[],"detail":"titles"}\n' >"$SRC/default.json"

echo "== 认得的全推上去，内容原样；只推演示版目录下的 scopes/"
run
check "退出码 0" "$RC" 0
check "香港上是这三份" "$(published)" "$ID1.json $ID2.json default.json "
check "内容一字不差" "$(cat "$HK/demo/scopes/$ID1.json")" "$(cat "$SRC/$ID1.json")"
args=$(cat "$TMP/rsync.log")
check "推到 /demo/（没写 FLEET_DEMO_PATH 就是它）" "${args##* }" "root@10.99.0.1:/demo/"
check "带 --delete（作废靠它）" "$([[ "$args" == *" --delete "* ]] && echo 有)" 有
check "只碰 scopes/ 下的 .json" "$([[ "$args" == *"--include=/scopes/ --include=/scopes/*.json --exclude=*"* ]] && echo 是)" 是
check "用的是发布脚本那一套 ssh" "$([[ "$args" == *"-e $(hk_ssh) --"* ]] && echo 是)" 是

echo "== 认不出的不推，照实退出 1；认得的照推"
DIR_ID=$(printf 'd%.0s' {1..64})
LINK_ID=$(printf 'e%.0s' {1..64})
BIG_ID=$(printf 'f%.0s' {1..64})
MOD_ID=$(printf '1%.0s' {1..64})
printf 'x' >"$SRC/notes.json"
printf '{"v":2,"modules":["board"],"detail":"status"}\n' >"$SRC/$ID3.json"
mkdir -p "$SRC/$DIR_ID.json"
ln -s /etc/passwd "$SRC/$LINK_ID.json" 2>/dev/null
head -c 5000 /dev/zero | tr '\0' 'x' >"$SRC/$BIG_ID.json"
printf '{"v":1,"modules":["board","secrets"],"detail":"status"}\n' >"$SRC/$MOD_ID.json"
run
check "退出码 1" "$RC" 1
check "香港上还是那三份" "$(published)" "$ID1.json $ID2.json default.json "
check "说了哪几个没推" "$(grep -c '认不出、没推' <<<"$OUT")" 1
check "名字不对的点了名" "$(grep -c 'notes.json（名字不对）' <<<"$OUT")" 1
check "内容不对的点了名" "$(grep -c "$ID3.json（内容不是可见范围）" <<<"$OUT")" 1
check "超长的点了名" "$(grep -c '超过 4096 字节' <<<"$OUT")" 1
check "模块不认识的点了名" "$(grep -c "$MOD_ID.json（内容不是可见范围）" <<<"$OUT")" 1
if [[ "$(uname -s)" == Linux ]]; then
  check "目录、符号链接不跟过去" "$(grep -o '（不是普通文件）' <<<"$OUT" | wc -l)" 2
fi
check "本机文件的内容一个字都没推上去" "$(grep -rl 'root:' "$HK" 2>/dev/null | wc -l)" 0
rm -rf -- "${SRC:?}/notes.json" "$SRC/$ID3.json" "$SRC/$DIR_ID.json" "$SRC/$LINK_ID.json" "$SRC/$BIG_ID.json" "$SRC/$MOD_ID.json"

echo "== 作废一条（撤掉文件）：香港跟着少一个"
rm -f -- "$SRC/$ID2.json"
run
check "退出码 0" "$RC" 0
check "香港上只剩两份" "$(published)" "$ID1.json default.json "

echo "== 推的时候目录又变了：再推一轮，新发的那条也推上去"
RSYNC_HOOK="printf '{\"v\":1,\"modules\":[\"quota\"],\"detail\":\"titles\",\"expiresAt\":\"2026-10-03T00:00:00.000Z\"}\n' >\"$SRC/$ID2.json\""
run
RSYNC_HOOK=""
check "退出码 0" "$RC" 0
check "推了两轮" "$(grep -c . "$TMP/rsync.log")" 2
check "新发的那条推上去了" "$(published)" "$ID1.json $ID2.json default.json "

echo "== 路径跟着 release.env 的 FLEET_DEMO_PATH；写错了不推、退出 2"
printf 'FLEET_SERVICES=\nFLEET_DEMO_PATH=/show/\n' >"$RELEASE_ENV"
run
check "退出码 0" "$RC" 0
check "推到 /show/" "$(tail -1 "$TMP/rsync.log" | awk '{ print $NF }')" "root@10.99.0.1:/show/"
check "/show/scopes/ 下有三份" "$(published show)" "$ID1.json $ID2.json default.json "
for bad in /a/b/ /demo "/../" "/Demo/"; do
  printf 'FLEET_DEMO_PATH=%s\n' "$bad" >"$RELEASE_ENV"
  run
  check "FLEET_DEMO_PATH=$bad：退出码 2" "$RC" 2
  check "FLEET_DEMO_PATH=$bad：一次都没推" "$(grep -c . "$TMP/rsync.log")" 0
done
rm -f -- "$RELEASE_ENV"

echo "== 香港连不上：退出 2，说清楚"
RSYNC_FAIL=1
run
check "退出码 2" "$RC" 2
check "说了没推成" "$(grep -c '没成' <<<"$OUT")" 1
RSYNC_FAIL=0

echo "== 范围目录空了（全作废）、或者还不在：香港上一份不留"
rm -f -- "$SRC"/*.json
run
check "空目录：退出码 0" "$RC" 0
check "空目录：香港上没有了" "$(published)" ""
rm -rf -- "$SRC"
run
check "目录不在：退出码 0" "$RC" 0
check "目录不在：香港上也没有" "$(published)" ""

echo "== 推之前和发布脚本排同一个队：锁被占着（发布正在往香港发）就等，等到点还轮不到就退出 2、一次都不推"
exec 8>>"$HK_RSYNC_LOCK"
flock 8
HK_RSYNC_WAIT=1
mkdir -p "$SRC"
printf '{"v":1,"modules":["board"],"detail":"status"}\n' >"$SRC/default.json"
run
check "锁被占着：退出码 2" "$RC" 2
check "说了是在等锁" "$(grep -c '还没轮到往香港推文件' <<<"$OUT")" 1
check "一次都没推" "$(grep -c . "$TMP/rsync.log")" 0
HK_RSYNC_WAIT=120
exec 8>&-
run
check "锁放开了：推成" "$RC $(published)" "0 default.json "

echo "== 和发布脚本用同一套 ssh 参数、排同一个队（本文件装到 /usr/local/sbin 单独跑，不引 common.sh）"
default_lock() { # 脚本：不设 FLEET_HK_RSYNC_LOCK 时它用哪把锁
  (
    unset FLEET_HK_RSYNC_LOCK
    # shellcheck source=/dev/null
    source "$1"
    printf '%s' "$HK_RSYNC_LOCK"
  )
}
lock=$(default_lock "$HERE/../france/fleet-demo-scopes.sh")
check "两边默认是同一把锁" "$lock" "$(default_lock "$HERE/../lib/common.sh")"
check "单元开了 ProtectSystem=strict，锁所在的目录要放开写" \
  "$(grep -cx "ReadWritePaths=${lock%/*}" "$HERE/../france/fleet-demo-scopes.service")" 1
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
check "两边的 ssh 参数一样" "$(hk_ssh)" "$(web_upload_ssh "$UPLOAD_KEY" "$HK_KNOWN_HOSTS")"
check "两边排队的写法一样（hk_rsync）" "$(declare -f hk_rsync)" "$MY_HK_RSYNC"

if ((fail)); then
  echo "demo-scopes：不通过"
  exit 1
fi
echo "demo-scopes：通过"
