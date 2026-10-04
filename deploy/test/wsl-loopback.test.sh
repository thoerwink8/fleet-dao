#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016,SC2317,SC2329 # 单引号里是交给 node、bash 的代码；替身 systemctl 由被测代码间接调用，shellcheck 看不出来
# 本机档的 WSL 回环规则（deploy/local/fleet-wsl-loopback.sh，和 deploy/local/install.sh 的第 1 步，#731）：在一次性的网络
# 命名空间里照 WSL 的 VirtioProxy 摆好它自己那几条策略路由——loopback0 换成 dummy 网卡（发过去的包就没了，和绕去 Windows
# 一样到不了本机的监听）、127 号表把 127.0.0.1 指过去、优先级 0 的 local 挪到 2、优先级 1 的 TCP、UDP 都查 127——再真跑：
#   1. 规则不在：127.0.0.1 的 TCP 被绕去 loopback0，内核挑的口上的回环监听自己连不上；check 判红、写清少了哪几条、退出 1
#   2. apply：补上 4 条（TCP、UDP 各两段，空出 7890）；7243、5432、临时端口段两头走 lo，7890 照旧走 loopback0；自己开的口
#      连得上；check 全绿；再 apply 一遍一条不动、一行不打
#   3. 【故意造出的失败】删掉一条：check 判红写清少了哪条；apply 补回来
#   4. 【故意造出的失败】照 #14063 原样手加不分端口的整段：7890 也留在了本机，check 判红写清 Windows 上的代理够不着；apply
#      删掉它、带端口的四条照旧在（钉住「带端口的先删」：先删整段会通配删到带端口的）
#   5. 【故意造出的失败】空出的口改了（7890 → 7897）：旧段判多、新段判少；apply 整组换成新的
#   6. 【故意造出的失败】空出的口写错（不是整数、超出 65534、没排好、空的）：apply、check 都拒，规则一条不动
#   7. 【故意造出的失败】ip 跑不成：check 退出 2（没查成）、不说全绿；apply 判红、退出 1
#   8. install.sh 的第 1 步（替身 systemctl）：装上脚本和两个单元、启用、补规则，读回全绿；第二遍一处不改；装上去的脚本被
#      改过、权限松了、timer 没在跑、开机那个没启用、上一次没跑成、规则被删了，读回各判红；两步的退出码取更坏的那个；
#      参数不对退出 64、什么都不做
#   9. 本机档登记的会话代理（profile.sh 照 deploy/local/desired-config.json 读）：读得出；WSL 回环规则空出的口、三份
#      代理样例都对得上它（改口几处一起改）
# 不碰宿主的路由：全在 unshare --net 起的命名空间里。要 root（建命名空间、改策略路由、以 root:root 放文件）。
# 用法：sudo bash deploy/test/wsl-loopback.test.sh。退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL=$(cd -- "$HERE/../local" && pwd)

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
lacks() { # 说明 文本 不该有的（grep -E）
  if grep -qE -- "$3" <<<"$2"; then
    printf '  ✗ %s：「%s」里不该有「%s」\n' "$1" "$2" "$3"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}
skip() {
  echo "wsl-loopback：没跑成：$*"
  exit 2
}

# 内核里优先级 0、发往 127.0.0.0/8 的规则（去掉「0:」），排好序
ours_now() { ip -4 rule list pref 0 | sed -E 's/^0:[[:space:]]+//; s/[[:space:]]+$//' | grep -E 'to 127\.0\.0\.0/8' | sort; }
route_of() { ip -4 route get 127.0.0.1 ipproto tcp dport "$1" | head -1; } # 口

# 在 127.0.0.1 上起一个监听（内核挑口，和探针、reclaude 的本地代理口一样落在临时端口段），连一次：读到问候打 yes，否则 no
self_connect() {
  local log pid port="" i got=no
  log=$(mktemp)
  "$NODE" -e '
    const srv = require("node:net").createServer((c) => c.end("hi\n"));
    srv.listen(0, "127.0.0.1", () => console.log(srv.address().port));
    setTimeout(() => process.exit(0), 10000);' >"$log" 2>&1 &
  pid=$!
  for ((i = 0; i < 50; i++)); do
    port=$(head -1 "$log" 2>/dev/null) || port=""
    if [[ "$port" =~ ^[0-9]+$ ]]; then break; fi
    sleep 0.1
  done
  if [[ "$port" =~ ^[0-9]+$ ]] &&
    timeout 2 bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1" && IFS= read -r l <&3 && [[ "$l" == hi ]]' _ "$port" 2>/dev/null; then
    got=yes
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -f -- "$log"
  echo "$got"
}

# 替身 systemctl：状态记在 $T/state 下的文件里（is-enabled、is-active、上一次的 Result），install.sh 的第 1 步和 common.sh
# 的 ensure_unit_running 只用到这几样
systemctl() {
  local cmd=$1 unit
  shift
  case $cmd in
  daemon-reload) echo reload >>"$T/state/calls" ;;
  is-enabled) cat -- "$T/state/enabled-$1" 2>/dev/null || echo disabled ;;
  is-active) cat -- "$T/state/active-$1" 2>/dev/null || echo inactive ;;
  enable)
    for unit in "$@"; do [[ "$unit" == --* ]] || echo enabled >"$T/state/enabled-$unit"; done
    ;;
  start | restart) echo active >"$T/state/active-$1" ;;
  show) cat -- "$T/state/result" 2>/dev/null || echo success ;;
  *) return 1 ;;
  esac
}

inner() {
  local out rc want_tcp
  ip link set lo up || skip "起不了新命名空间里的回环"
  # 照 WSL 的 VirtioProxy 摆：loopback0（这里是 dummy）、127 号表、优先级 0 的 local 换成「从 loopback0 进来的才查 local」、
  # 优先级 1 的 TCP、UDP 查 127、优先级 2 才是 local
  ip link add loopback0 type dummy || skip "建不了 dummy 网卡"
  ip addr add 169.254.73.153/30 dev loopback0 || skip "loopback0 加不上地址"
  ip link set loopback0 up || skip "loopback0 起不来"
  ip route add 127.0.0.1 via 169.254.73.152 dev loopback0 table 127 onlink || skip "127 号表加不上路由"
  ip rule del pref 0 lookup local || skip "删不掉默认的 local 规则"
  if ! {
    ip rule add pref 0 iif loopback0 ipproto tcp lookup local &&
      ip rule add pref 0 iif loopback0 ipproto udp lookup local &&
      ip rule add pref 1 ipproto tcp lookup 127 &&
      ip rule add pref 1 ipproto udp lookup 127 &&
      ip rule add pref 2 lookup local
  }; then
    skip "摆不出 WSL 那几条策略路由"
  fi

  # shellcheck source=../local/fleet-wsl-loopback.sh
  source "$LOCAL/fleet-wsl-loopback.sh"
  WSL_LOOPBACK_PROBE_PORTS=(7243 5432)
  local lo hi
  read -r lo hi </proc/sys/net/ipv4/ip_local_port_range || skip "读不了 ip_local_port_range"

  echo "1. 规则不在：127.0.0.1 被绕去 loopback0"
  has "7243 走 loopback0" "$(route_of 7243)" 'dev loopback0'
  check "内核挑的口上的回环监听自己连不上" "$(self_connect)" no
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 1" "$rc" 1
  has "check 写清少了 4 条" "$out" '^red 少了 4 条把回环留在本机的规则'
  has "check 写清 7243 没留在本机" "$out" '^red 127\.0\.0\.1:7243（TCP）没留在本机的 lo 上'
  lacks "check 不说 7890 有问题（它本来就该去 Windows）" "$out" '127\.0\.0\.1:7890'

  echo "2. apply：补上 4 条，空出 7890"
  rc=0
  out=$(wsl_loopback_apply) || rc=$?
  check "apply 退出 0" "$rc" 0
  check "apply 打了 4 行「加上」" "$(grep -c '^changed 加上回环规则' <<<"$out")" 4
  want_tcp=$'from all to 127.0.0.0/8 ipproto tcp dport 1-7889 lookup local\nfrom all to 127.0.0.0/8 ipproto tcp dport 7891-65534 lookup local\nfrom all to 127.0.0.0/8 ipproto udp dport 1-7889 lookup local\nfrom all to 127.0.0.0/8 ipproto udp dport 7891-65534 lookup local'
  check "内核里正好是这 4 条" "$(ours_now)" "$(sort <<<"$want_tcp")"
  for p in 7243 5432 "$lo" "$hi" 7889 7891 65534; do
    has "127.0.0.1:$p 走 lo" "$(route_of "$p")" '^local 127\.0\.0\.1 dev lo '
  done
  has "127.0.0.1:7890 照旧走 loopback0（Windows 上的代理）" "$(route_of 7890)" 'dev loopback0'
  has "UDP 也留在本机" "$(ip -4 route get 127.0.0.1 ipproto udp dport 53 | head -1)" '^local 127\.0\.0\.1 dev lo '
  check "内核挑的口上的回环监听自己连得上了" "$(self_connect)" yes
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 0" "$rc" 0
  check "check 两行都是 ok" "$(grep -c '^ok ' <<<"$out")" 2
  has "check 写清 7890 走 loopback0" "$out" '7890 走「127\.0\.0\.1 via 169\.254\.73\.152 dev loopback0'
  rc=0
  out=$(wsl_loopback_apply) || rc=$?
  check "第二遍 apply 退出 0" "$rc" 0
  check "第二遍 apply 一行不打（一条不动）" "$out" ""
  check "第二遍之后还是这 4 条" "$(ours_now)" "$(sort <<<"$want_tcp")"

  echo "3. 【故意造出的失败】删掉一条"
  ip rule del pref 0 to 127.0.0.0/8 ipproto tcp dport 7891-65534 lookup local
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 1" "$rc" 1
  has "check 写清少了哪条" "$out" '^red 少了 1 条.*ipproto tcp dport 7891-65534'
  has "check 写清临时端口段那头没留在本机" "$out" "^red 127\\.0\\.0\\.1:$hi（TCP）没留在本机"
  out=$(wsl_loopback_apply)
  has "apply 补回那一条" "$out" '^changed 加上回环规则「from all to 127\.0\.0\.0/8 ipproto tcp dport 7891-65534 lookup local」'
  check "apply 只报补的那一条（删了重加的不算改动）" "$(grep -c '^changed' <<<"$out")" 1
  check "补完又是这 4 条" "$(ours_now)" "$(sort <<<"$want_tcp")"

  echo "4. 【故意造出的失败】照 #14063 原样手加不分端口的整段"
  ip rule add pref 0 to 127.0.0.0/8 lookup local
  has "7890 也留在了本机" "$(route_of 7890)" '^local 127\.0\.0\.1 dev lo '
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 1" "$rc" 1
  has "check 写清多了那条" "$out" '^red 多了 1 条回环规则（from all to 127\.0\.0\.0/8 lookup local）'
  has "check 写清 Windows 上的代理够不着" "$out" '^red 127\.0\.0\.1:7890（TCP）留在了本机.*Windows 上的代理够不着'
  out=$(wsl_loopback_apply)
  has "apply 删掉整段" "$out" '^changed 删掉回环规则「from all to 127\.0\.0\.0/8 lookup local」'
  check "删完正好是带端口的 4 条（没被通配删掉）" "$(ours_now)" "$(sort <<<"$want_tcp")"
  has "7890 又走 loopback0" "$(route_of 7890)" 'dev loopback0'

  echo "5. 【故意造出的失败】空出的口改了（7890 → 7897）"
  WSL_LOOPBACK_WINDOWS_PORTS=(7897)
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 1" "$rc" 1
  has "旧段判多" "$out" '^red 多了 4 条'
  has "新段判少" "$out" '^red 少了 4 条.*dport 1-7896'
  has "7897 留在了本机判红" "$out" '^red 127\.0\.0\.1:7897（TCP）留在了本机'
  out=$(wsl_loopback_apply)
  check "apply 删 4 加 4" "$(grep -c '^changed 删掉' <<<"$out") $(grep -c '^changed 加上' <<<"$out")" "4 4"
  has "7897 走 loopback0" "$(route_of 7897)" 'dev loopback0'
  has "7890 留在本机" "$(route_of 7890)" '^local 127\.0\.0\.1 dev lo '
  rc=0
  wsl_loopback_check >/dev/null || rc=$?
  check "换完 check 退出 0" "$rc" 0
  WSL_LOOPBACK_WINDOWS_PORTS=(7890)
  wsl_loopback_apply >/dev/null
  check "换回 7890" "$(ours_now)" "$(sort <<<"$want_tcp")"

  echo "6. 【故意造出的失败】空出的口写错"
  local bad before
  before=$(ours_now)
  for bad in "abc" "0" "65535" "7890 1080" "7890 7890" ""; do
    read -ra WSL_LOOPBACK_WINDOWS_PORTS <<<"$bad"
    rc=0
    out=$(wsl_loopback_apply) || rc=$?
    check "apply 拒「$bad」：退出 1" "$rc" 1
    has "apply 写清口写错了（「$bad」）" "$out" '^red 空出的口写错了'
    rc=0
    out=$(wsl_loopback_check) || rc=$?
    check "check 拒「$bad」：退出 1" "$rc" 1
  done
  check "规则一条没动" "$(ours_now)" "$before"
  WSL_LOOPBACK_WINDOWS_PORTS=(7890)
  check "两个口：中间一段、两头各一段" "$(wsl_loopback_ranges 1 7890 65534 | tr '\n' ' ')" "2-7889 7891-65533 "
  check "挨着的口：单个口写成一个数" "$(wsl_loopback_ranges 2 4 | tr '\n' ' ')" "1 3 5-65534 "

  echo "7. 【故意造出的失败】ip 跑不成"
  WSL_LOOPBACK_IP=/bin/false
  rc=0
  out=$(wsl_loopback_check) || rc=$?
  check "check 退出 2（没查成）" "$rc" 2
  has "check 写清没查成" "$out" '^pending 列不出优先级 0 的规则'
  lacks "check 不说 ok" "$out" '^ok '
  rc=0
  out=$(wsl_loopback_apply) || rc=$?
  check "apply 退出 1" "$rc" 1
  has "apply 判红" "$out" '^red 列不出优先级 0 的规则'
  WSL_LOOPBACK_IP=ip
  check "规则还是那 4 条" "$(ours_now)" "$(sort <<<"$want_tcp")"

  echo "8. install.sh 的第 1 步（替身 systemctl）"
  ip rule del pref 0 to 127.0.0.0/8 ipproto udp dport 1-7889 lookup local
  # shellcheck source=../local/install.sh
  source "$LOCAL/install.sh"
  T=$(mktemp -d)
  mkdir -p "$T/sbin" "$T/units" "$T/state"
  WSL_LOOPBACK_BIN=$T/sbin/fleet-wsl-loopback
  WSL_LOOPBACK_UNIT_DIR=$T/units
  CHANGES=() REDS=() PENDING=()
  out=$(setup_wsl_loopback 2>&1; printf 'REDS=%s\n' "${#REDS[@]}")
  has "装上脚本" "$out" "写 $T/sbin/fleet-wsl-loopback"
  has "装上开机那个单元" "$out" "写 $T/units/fleet-wsl-loopback.service"
  has "装上每分钟那个" "$out" "写 $T/units/fleet-wsl-loopback.timer"
  has "启用开机那个" "$out" '启用 fleet-wsl-loopback.service'
  has "起每分钟那个" "$out" '启动 fleet-wsl-loopback.timer'
  has "现在就补上少的那一条" "$out" '加上回环规则「from all to 127\.0\.0\.0/8 ipproto udp dport 1-7889 lookup local」'
  has "装的时候没有红" "$out" '^REDS=0$'
  # 上面在子 shell 里跑的：这里照样再跑一遍，账记在这个 shell 里
  CHANGES=() REDS=() PENDING=()
  setup_wsl_loopback >/dev/null 2>&1
  check "第二遍一处不改" "${#CHANGES[@]}" 0
  check "装上去的脚本是 root:root 755" "$(stat -c '%U:%G %a' -- "$WSL_LOOPBACK_BIN")" "root:root 755"
  check "单元是 root:root 644" "$(stat -c '%U:%G %a' -- "$T/units/fleet-wsl-loopback.timer")" "root:root 644"
  REDS=() PENDING=()
  out=$(readback_wsl_loopback 2>&1; printf 'REDS=%s PENDING=%s\n' "${#REDS[@]}" "${#PENDING[@]}")
  has "读回全绿" "$out" '^REDS=0 PENDING=0$'
  has "读回说清装的和挂的" "$out" '就是仓里这份；开机补（service 启用）、每分钟补（timer 在跑）都挂着'
  has "读回带上规则和实际走哪" "$out" '127\.0\.0\.1 的 7243 5432 和临时端口段两头'

  readback_reds() { # 打出这一轮读回判的红，一行一条
    REDS=() PENDING=()
    readback_wsl_loopback >/dev/null 2>&1
    printf '%s\n' "${REDS[@]}"
  }
  echo "# 改坏装上去的脚本" >>"$WSL_LOOPBACK_BIN"
  has "【故意造出的失败】装上去的脚本被改过：判红" "$(readback_reds)" "fleet-wsl-loopback 和仓里的 .* 不一样"
  setup_wsl_loopback >/dev/null 2>&1
  chmod 775 "$WSL_LOOPBACK_BIN"
  has "【故意造出的失败】装上去的脚本组可写：判红" "$(readback_reds)" '不是 root:root 755'
  chmod 755 "$WSL_LOOPBACK_BIN"
  echo inactive >"$T/state/active-fleet-wsl-loopback.timer"
  has "【故意造出的失败】timer 没在跑：判红" "$(readback_reds)" 'fleet-wsl-loopback\.timer 没在跑'
  echo active >"$T/state/active-fleet-wsl-loopback.timer"
  echo disabled >"$T/state/enabled-fleet-wsl-loopback.service"
  has "【故意造出的失败】开机那个没启用：判红" "$(readback_reds)" 'fleet-wsl-loopback\.service 没启用'
  echo enabled >"$T/state/enabled-fleet-wsl-loopback.service"
  echo exit-code >"$T/state/result"
  has "【故意造出的失败】上一次没跑成：判红" "$(readback_reds)" '上一次没跑成（exit-code）'
  echo success >"$T/state/result"
  ip rule del pref 0 to 127.0.0.0/8 ipproto tcp dport 1-7889 lookup local
  has "【故意造出的失败】规则被删了：读回判红" "$(readback_reds)" '少了 1 条把回环留在本机的规则'
  check "读回不动规则（只读）" "$(ours_now | grep -c 'tcp dport 1-7889')" 0
  CHANGES=() REDS=() PENDING=()
  setup_wsl_loopback >/dev/null 2>&1
  check "再装一遍补回来" "$(readback_reds)" ""
  rm -rf -- "$T"

  echo "   两步的退出码"
  check "都绿" "$(combine_rc 0 0)" 0
  check "第 1 步待配" "$(combine_rc 2 0)" 2
  check "france.sh 红、第 1 步待配" "$(combine_rc 2 1)" 1
  check "第 1 步红、france.sh 绿" "$(combine_rc 1 0)" 1
  check "france.sh 认不出的退出码照原样" "$(combine_rc 0 64)" 64
  check "第 1 步红压过 france.sh 认不出的" "$(combine_rc 1 64)" 1

  echo "9. 本机档登记的会话代理（profile.sh 照 deploy/local/desired-config.json 读，装 grok、cursor-agent 时带上，#731）"
  # shellcheck source=../lib/profile.sh
  source "$HERE/../lib/profile.sh"
  local port f
  PROFILE=local SESSION_PROXY_STATE=""
  # SESSION_PROXY_NODE 在 source 之后设：profile.sh 里那一项（按 PATH 找 node）会把它覆盖掉
  SESSION_PROXY_NODE=$NODE
  session_proxy_load
  check "读得出登记的代理" "$?:$SESSION_PROXY" "0:http://127.0.0.1:7890"
  port=${SESSION_PROXY##*:}
  # 改口要几处一起改：WSL 回环规则空出的口、三份代理样例都得跟着登记的这个（读不出、没登记的判法在 profile.test.sh）
  check "WSL 回环规则空出的口里有登记的代理口（不然发往它的被留在本机，Clash 够不着）" \
    "$(printf '%s\n' "${WSL_LOOPBACK_WINDOWS_PORTS[@]}" | grep -cx -- "$port")" 1
  for f in environment.example zz-local-proxy.sh.example 95local-proxy.example; do
    has "deploy/local/$f 写的是登记的代理" "$(cat -- "$LOCAL/$f")" "${SESSION_PROXY//./\\.}"
  done
}

if [[ "${1:-}" == --inner ]]; then
  NODE=${2:-}
  inner
  exit "$fail"
fi

if ((EUID != 0)); then skip "要 root（建网络命名空间、改策略路由、以 root:root 放文件）"; fi
for n in ip unshare timeout; do
  command -v "$n" >/dev/null || skip "这台没有 $n"
done
# sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    NODE=$n
    break
  fi
done
if [[ -z "$NODE" ]]; then skip "这台找不到 node（起回环监听用）"; fi

echo "== install.sh 参数不对：退出 64、什么都不做"
rc=0
out=$(bash "$LOCAL/install.sh" --bogus 2>&1) || rc=$?
check "退出 64" "$rc" 64
has "说用法" "$out" '用法：bash .*install\.sh \[--check\]'
lacks "没往下跑" "$out" 'WSL 的回环'

echo "== 在一次性的网络命名空间里照 WSL 的样子摆好再跑"
unshare --net -- bash "$HERE/wsl-loopback.test.sh" --inner "$NODE"
rc=$?
case $rc in
0) ;;
2) exit 2 ;;
*) fail=1 ;;
esac
if ((fail)); then
  echo "wsl-loopback：不通过"
  exit 1
fi
echo "wsl-loopback：通过"
