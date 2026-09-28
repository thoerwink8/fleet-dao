#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/mirasim.sh 的会话用户 Mirasim 常驻单元这一层（mirasim_server_installed、check_mirasim_session_unit，
# #424）；和 mirasim.test.sh（认令牌）分开测——那份管「引擎连哪个端口」，这份管「该不该有常驻单元、单元活没活」。
#   0. deploy/france/fleet-mirasim-session.service 渲染出来的样子钉住：User、Group、端口、--host 127.0.0.1、
#      --no-open、--no-im 都要在（改坏了这条先炸，不用真起服务就测得出）
#   1. 服务端本体不在（最常见的起始状态，装机脚本还没装过服务端）：mirasim_server_installed 返回假、
#      check_mirasim_session_unit 记一笔待配，不判红——【故意造出的失败】照 france.sh 挂上 ERR 陷阱再跑一遍，
#      陷阱不许响、返回 0（同一个坑 mirasim.test.sh 已经钉过一次，check_mirasim_session_unit 是新函数，重新钉一遍）
#   2. 服务端本体在、但单元没在跑（本体已装、常驻这层还没起来，或者单元名根本不存在）：判红，带着 journalctl 提示
#   3. 服务端本体在、单元在跑、但 /api/health 连不上：判红
#   4. 服务端本体在、单元在跑、/api/health 回 ok:true：判绿——用 systemd-run 起一个真的 transient 单元、配一个假
#      server.cjs（node 起的最小 http 服务）验证这条真走得通，不是只测「本该红」的那几条
# 要 root（建临时用户、用 systemd-run 起 transient 单元）、要这台机器有 systemd 和 node。
# 用法：sudo bash deploy/test/mirasim-session.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/mirasim.sh
source "$HERE/../lib/mirasim.sh"

if ((EUID != 0)); then
  echo "mirasim-session：没跑成：要 root（得建临时用户、用 systemd-run 起 transient 单元）"
  exit 2
fi
if ! command -v systemctl >/dev/null || ! command -v systemd-run >/dev/null; then
  echo "mirasim-session：没跑成：这台没有 systemd（systemctl / systemd-run）"
  exit 2
fi
if ! command -v node >/dev/null; then
  echo "mirasim-session：没跑成：这台没有 node（假 server.cjs 要用它起）"
  exit 2
fi

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
last() { # 数组名：最后一条
  local -n arr=$1
  if ((${#arr[@]})); then printf '%s' "${arr[-1]}"; fi
}
fresh() { CHANGES=() REDS=() PENDING=(); }

echo "== 0. fleet-mirasim-session.service 渲染出来的样子钉住"
render "$HERE/../france/fleet-mirasim-session.service" SESSION_USER=fleet-mirasim-fake MIRASIM_SESSION_PORT=54321
has "User 是渲染进去的会话用户" "$RENDERED" '^User=fleet-mirasim-fake$'
has "Group 跟着同一个用户" "$RENDERED" '^Group=fleet-mirasim-fake$'
has "ExecStart 带上端口、只听回环、不开浏览器、不进 IM" "$RENDERED" \
  'ExecStart=.*--port 54321 --host 127\.0\.0\.1 --no-open --no-im --workdir /home/fleet-mirasim-fake'
has "起不来会重试（on-failure）" "$RENDERED" '^Restart=on-failure$'
has "不进 fleet-agents.slice（平台常驻服务，不占会话额度）" "$RENDERED" 'MemoryHigh=|MemoryMax='

U=fleet-mirasim-session-test-$$
H=/var/tmp/mirasim-session-test-$$
cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  pkill -KILL -u "$U" >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$H"
}
trap cleanup EXIT
UNIT=fleet-mirasim-session-test-$$.service
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "mirasim-session：没跑成：建不了临时用户 $U"
  exit 2
fi

echo "== 1. 服务端本体不在（最常见的起始状态）：待配，不判红"
fresh
check "mirasim_server_installed 判假" "$(mirasim_server_installed "$U" && echo 真 || echo 假)" "假"
check_mirasim_session_unit "$U" "$UNIT" 54321
check "记一笔待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "待配写清没装服务端本体、去哪装" "$(last PENDING)" "还没有 Mirasim 服务端本体.*docs/ops.md 第五节「会话用户的 Mirasim」"

echo "== 1b.【故意造出的失败】挂上 ERR 陷阱再跑一遍：陷阱不许响，照样待配、返回 0"
fresh
trapped=$(
  trap 'echo 陷阱响了' ERR
  set -E
  check_mirasim_session_unit "$U" "$UNIT" 54321 >/dev/null
  echo "返回 $? 待配 ${#PENDING[@]} 红 ${#REDS[@]}"
)
check "挂着 ERR 陷阱：陷阱没响、记一笔待配" "$trapped" "返回 0 待配 1 红 0"

echo "== 2. 服务端本体在、单元没在跑：判红，带 journalctl 提示"
install -d -o "$U" -g "$U" -m 755 "$H/.mirasim-remote/current"
install -o "$U" -g "$U" -m 755 /dev/null "$H/.mirasim-remote/current/server.cjs"
fresh
check "mirasim_server_installed 判真" "$(mirasim_server_installed "$U" && echo 真 || echo 假)" "真"
check_mirasim_session_unit "$U" "$UNIT" 54321
check "判红、不是待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里带 journalctl 提示" "$(last REDS)" "$UNIT 没在跑.*journalctl -u $UNIT"

echo "== 3. 服务端本体在、单元在跑、但 /api/health 连不上（起一个只听着不回应的假单元）"
PORT3=$((20000 + RANDOM % 10000))
systemd-run --unit="$UNIT" --uid="$U" --gid="$U" -p Type=simple --collect --quiet -- \
  node -e 'require("node:net").createServer((c)=>c.on("data",()=>{})).listen(process.argv[1])' "$PORT3" \
  >/dev/null 2>&1
for ((i = 0; i < 50; i++)); do
  [[ "$(systemctl is-active "$UNIT" 2>/dev/null)" == active ]] && break
  sleep 0.1
done
fresh
check_mirasim_session_unit "$U" "$UNIT" "$PORT3"
check "判红、不是待配" "${#REDS[@]} ${#PENDING[@]}" "1 0"
has "红里说 health 连不上" "$(last REDS)" "在跑但 http://127\.0\.0\.1:$PORT3/api/health 连不上或没回"
systemctl stop "$UNIT" >/dev/null 2>&1
systemctl reset-failed "$UNIT" >/dev/null 2>&1

echo "== 4. 服务端本体在、单元在跑、/api/health 回 ok:true：判绿"
PORT4=$((20000 + RANDOM % 10000))
systemd-run --unit="$UNIT" --uid="$U" --gid="$U" -p Type=simple --collect --quiet -- \
  node -e '
    require("node:http").createServer((req,res)=>{
      if (req.url === "/api/health") { res.end(JSON.stringify({ok:true})); }
      else { res.statusCode = 404; res.end(); }
    }).listen(Number(process.argv[1]), "127.0.0.1");' "$PORT4" \
  >/dev/null 2>&1
for ((i = 0; i < 50; i++)); do
  [[ "$(systemctl is-active "$UNIT" 2>/dev/null)" == active ]] && break
  sleep 0.1
done
fresh
OUT4=$(mktemp)
check_mirasim_session_unit "$U" "$UNIT" "$PORT4" >"$OUT4" 2>&1
check "判绿：没有待配、没有红" "${#PENDING[@]} ${#REDS[@]}" "0 0"
has "报了在跑、health 回 ok" "$(cat -- "$OUT4")" "$UNIT 在跑.*api/health 回 ok:true"
rm -f -- "$OUT4"
systemctl stop "$UNIT" >/dev/null 2>&1
systemctl reset-failed "$UNIT" >/dev/null 2>&1

if ((fail)); then
  echo "mirasim-session：不通过"
  exit 1
fi
echo "mirasim-session：通过"
