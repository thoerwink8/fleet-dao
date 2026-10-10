#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 发布构建的沙箱（#79）。
# 抓住的错：沙箱命令不在、起不来、读回确认 /etc/fleet-dao 仍然可见时，发布仍往下走、或退回用 as_fleet_in
#   以 fleet 直接构建（那样第三方代码读得到密钥）；沙箱没挡住时，构建读得到 /etc/fleet-dao 下的诱饵、
#   或连得上本机库的 unix socket。
# 前三段不需要 root（systemd-run 换成桩）。后两段用真的 systemd-run，要 root；不是 root 就记没跑成、退出 2。
# 用法：sudo bash deploy/test/build-isolation.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
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
BAIT=/etc/fleet-dao/fleet-build-isolation-bait
SOCK=""
SOCK_REAL=""
SERVER_PID=""
CREATED_FLEET=0
CREATED_ETC=0
CREATED_BAIT=0
CREATED_SOCK_DIR=0
CREATED_SOCK_LINK=0
STUB_MODE=""
fail=0
skipped=0

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$SOCK" == *fleet-build-isolation* ]]; then rm -f -- "$SOCK" || true; fi
  if ((CREATED_SOCK_LINK)); then rm -f /var/run/postgresql || true; fi
  if ((CREATED_SOCK_DIR)) && [[ -n "$SOCK_REAL" ]]; then rmdir -- "$SOCK_REAL" 2>/dev/null || true; fi
  if ((CREATED_BAIT)); then rm -f -- "$BAIT" || true; fi
  if ((CREATED_ETC)); then rmdir /etc/fleet-dao 2>/dev/null || true; fi
  if ((CREATED_FLEET)); then userdel --remove fleet >/dev/null 2>&1 || true; fi
  rm -rf -- "$TMP"
  true
}
trap cleanup EXIT

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

echo "== 真沙箱：构建环境里读诱饵失败并报出路径；连本机库 socket 被拒"
if ((EUID != 0)) || [[ ! -d /run/systemd/system ]] || ! command -v runuser >/dev/null; then
  echo "  … 没跑成：要 root 和 systemd（sudo bash deploy/test/build-isolation.test.sh）"
  skipped=1
else
  unset -f systemd-run
  hash -r
  if ! id fleet >/dev/null 2>&1; then
    if useradd --system --user-group --create-home --home-dir /home/fleet --shell /usr/sbin/nologin fleet; then
      CREATED_FLEET=1
    else
      echo "  … 没跑成：建不了用户 fleet"
      skipped=1
    fi
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  if [[ ! -d /etc/fleet-dao ]]; then
    install -d -o root -g fleet -m 750 /etc/fleet-dao
    CREATED_ETC=1
  fi
  printf '%s\n' "$CANARY" >"$BAIT"
  chown root:fleet -- "$BAIT"
  chmod 640 -- "$BAIT"
  CREATED_BAIT=1
  if ! runuser -u fleet -- cat -- "$BAIT" >/dev/null; then
    echo "  … 没跑成：沙箱外 fleet 读不到诱饵，没法证明是沙箱挡住的"
    skipped=1
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  cat >"$TMP/bin/pnpm" <<'SH'
#!/bin/bash
target=/etc/fleet-dao/fleet-build-isolation-bait
if content=$(cat -- "$target" 2>&1); then
  printf '%s\n' "$content"
  exit 0
fi
printf '%s\n' "$content" >&2
exit 1
SH
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
  if [[ "$out" == *"/etc/fleet-dao/fleet-build-isolation-bait"* ]]; then
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
  if [[ ! -d "$SOCK_REAL" ]]; then
    install -d -m 755 "$SOCK_REAL"
    CREATED_SOCK_DIR=1
  fi
  if [[ ! -e /var/run/postgresql ]]; then
    ln -s "$SOCK_REAL" /var/run/postgresql
    CREATED_SOCK_LINK=1
  fi
  # sudo 会换掉 PATH，CI 里 setup-node 装的 node 不在 /usr/bin。用绝对路径，沙箱里的 fleet 也执行得到
  NODE_BIN=""
  for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
    if [[ -n "$n" && -x "$n" ]]; then NODE_BIN=$n; break; fi
  done
  if [[ -z "$NODE_BIN" ]]; then
    echo "  … 没跑成：找不到 node，没法试连本机库 socket"
    skipped=1
  fi
fi
if ((EUID == 0)) && ((skipped == 0)); then
  SOCK=$SOCK_REAL/.fleet-build-isolation-$$.sock
  cat >"$TMP/sock-server.mjs" <<'JS'
import net from "node:net";
import fs from "node:fs";
const p = process.argv[2];
try { fs.unlinkSync(p); } catch { /* 没有旧的 */ }
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

if ((fail)); then
  echo "build-isolation：不通过"
  exit 1
fi
if ((skipped)); then
  echo "build-isolation：没跑成"
  exit 2
fi
echo "build-isolation：通过"
