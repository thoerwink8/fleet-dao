#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 本机档（#451，deploy/lib/profile.sh）：FLEET_PROFILE 认不认得出、不带这个变量时默认是不是 france（加本机档之前
# 一个字节都不变的前提）、认不出的档名报不报清楚、is_local_profile 只看 PROFILE 这个全局变量、skip_local 是不是
# 不算红也不算绿（只进 PENDING）；这台记的档位（#323，profile_marker_check）对不上、不是普通文件都不过，france.sh 前提里核、
# 装的时候记、读回报；会话代理（#731，session_proxy_load）只认这一档期望里登记的、读不出不当成直连。不要 root，只碰临时目录
# （会话代理那几条要 node，找不到记没跑成）。
# 用法：bash deploy/test/profile.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
unset FLEET_PROFILE
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/profile.sh
source "$HERE/../lib/profile.sh"
fail=0
skipped=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

out=$(resolve_profile)
if [[ "$out" == france ]]; then pass "不带 FLEET_PROFILE：默认 france"; else flunk "不带 FLEET_PROFILE 读到「$out」，应为 france"; fi

out=$(FLEET_PROFILE=local resolve_profile)
if [[ "$out" == local ]]; then pass "FLEET_PROFILE=local：读到 local"; else flunk "FLEET_PROFILE=local 读到「$out」"; fi

out=$(FLEET_PROFILE=france resolve_profile)
if [[ "$out" == france ]]; then pass "FLEET_PROFILE=france：读到 france（显式给和不给一样）"; else flunk "FLEET_PROFILE=france 读到「$out」"; fi

err=$(FLEET_PROFILE=bogus resolve_profile 2>&1 1>/dev/null)
rc=$?
if ((rc != 0)) && [[ "$err" == *"认不出的 FLEET_PROFILE"*bogus* ]]; then
  pass "认不出的档名：非 0 退出、报清楚是哪个值（退出码 $rc）"
else
  flunk "认不出的档名应该非 0 退出、报清楚：退出码 $rc，stderr「$err」"
fi

# is_local_profile 只看 PROFILE 这个全局变量（france.sh 里 main 之前、resolve_profile 的结果存的那个），不是
# 再去读一次 FLEET_PROFILE：这样 skip_local 判过一次之后，函数体里能反复用它，不用每次都重新解析
PROFILE=france
if is_local_profile; then flunk "PROFILE=france 不该判成本机档"; else pass "PROFILE=france：is_local_profile 是假的"; fi
PROFILE=local
if is_local_profile; then pass "PROFILE=local：is_local_profile 是真的"; else flunk "PROFILE=local 应该判成本机档"; fi
unset PROFILE
if is_local_profile; then flunk "PROFILE 没设时不该判成本机档（默认当 france，和法国的行为对齐）"; else pass "PROFILE 没设：当 france，不是本机档"; fi

# profile_desired_file：readback_config 拿它决定传不传 --desired（#451）。法国（不设、或显式 france）要拿空
# 字符串——空串意味着 config.mjs 不收 --desired，自己按「在用的那一版」找，法国的判法一个字节都不变；本机档要
# 拿 deploy/local/desired-config.json（不然本机档登记过的差别，比如 FLEET_MACHINE_NAME，会被拿法国那份比
# 出来，当成「手改了、改回去」误判成红）
unset PROFILE
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ -z "$out" ]]; then
  pass "profile_desired_file：PROFILE 没设（当 france）不给 --desired 的路径"
else
  flunk "profile_desired_file 在 france 应该是空字符串，读到「$out」"
fi
PROFILE=france
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ -z "$out" ]]; then
  pass "profile_desired_file：PROFILE=france 不给 --desired 的路径"
else
  flunk "profile_desired_file 在 france 应该是空字符串，读到「$out」"
fi
PROFILE=local
out=$(profile_desired_file /srv/fleet-dao/deploy)
if [[ "$out" == /srv/fleet-dao/deploy/local/desired-config.json ]]; then
  pass "profile_desired_file：PROFILE=local 给 deploy/local/desired-config.json"
else
  flunk "profile_desired_file 在本机档应为 /srv/fleet-dao/deploy/local/desired-config.json，读到「$out」"
fi
unset PROFILE

# skip_local：不算红也不算绿，只记进 PENDING（common.sh 的退出码：有红 1，没红但有待配 2，全绿 0），文字带
# 「本机档跳过：」前缀，方便和真正「待配」的项在输出里分清楚
out=$(skip_local "没有香港") # 只看打印：$() 起子壳，看不到它对 PENDING 数组的改动
if [[ "$out" == "  … 本机档跳过：没有香港" ]]; then
  pass "skip_local：输出格式和 pending 一样（… 开头）"
else
  flunk "skip_local 输出「$out」，应为「  … 本机档跳过：没有香港」"
fi
CHANGES=()
REDS=()
PENDING=()
skip_local "没有香港" >/dev/null # 不起子壳直接调，才看得到它对这几个数组的改动
if ((${#PENDING[@]} == 1)) && [[ "${PENDING[0]}" == "本机档跳过：没有香港" ]]; then
  pass "skip_local：记进 PENDING，不进 REDS 或 CHANGES"
else
  flunk "skip_local 没正确记进 PENDING：${PENDING[*]-（空）}"
fi
if ((${#REDS[@]} == 0 && ${#CHANGES[@]} == 0)); then
  pass "skip_local：不算红也不算绿"
else
  flunk "skip_local 不该动 REDS 或 CHANGES（REDS=${#REDS[@]} CHANGES=${#CHANGES[@]}）"
fi

# 这台记的档位（#323）：发布、自动发布照它挑哪一份期望写配置、对账，所以 france.sh 跑之前先核——没记、记的就是这一档才往下装；
# 记的是别的档、不是普通文件，都不过（不替人改它）
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
marker_case() { # 说明 期望（过 / 不过） 这次的档位 [PROFILE_WHY 里要有的字]
  local rc=0
  profile_marker_check "$T/profile" "$3" || rc=$?
  if [[ "$2" == 过 && $rc == 0 ]] || [[ "$2" == 不过 && $rc != 0 && "$PROFILE_WHY" == *"${4:-}"* ]]; then
    pass "$1：$2"
  else
    flunk "$1：该$2，返回 $rc，原因「$PROFILE_WHY」"
  fi
}
marker_case "还没记" 过 france
printf 'france\n' >"$T/profile"
marker_case "记的就是法国档" 过 france
marker_case "记的是法国档、这次跑的是本机档（入口用错了）" 不过 local "记的是「france」档"
printf 'local\n' >"$T/profile"
marker_case "记的是本机档、这次跑的是法国档" 不过 france "这次跑的是「france」档"
marker_case "记的就是本机档" 过 local
rm -f -- "$T/profile"
mkdir "$T/profile"
marker_case "档位文件是个目录" 不过 france "不是普通文件"
rmdir -- "$T/profile"
if ln -s "$T/elsewhere" "$T/profile" 2>/dev/null && [[ -L "$T/profile" ]]; then
  marker_case "档位文件是符号链接（断链也算）" 不过 france "不是普通文件"
else
  echo "  … 没跑成：这台建不了符号链接，「是符号链接」没测"
  skipped=1
fi
rm -f -- "$T/profile"
# france.sh 里：前提先核（对不上就停），装的时候记上，读回报出来
france=$(<"$HERE/../france.sh")
preflight_body=$(sed -n '/^preflight() {/,/^}/p' <<<"$france")
identity_body=$(sed -n '/^setup_identity() {/,/^}/p' <<<"$france")
# shellcheck disable=SC2016 # 找的就是字面上的变量名
if [[ "$preflight_body" == *'profile_marker_check "$PROFILE_FILE" "$PROFILE"'* &&
  "$identity_body" == *'put_file "$PROFILE_FILE" root:fleet 640 "$PROFILE"'* && "$france" == *$'\n  readback_profile_marker\n'* ]]; then
  pass "france.sh：前提核档位、装的时候记上、读回报出来"
else
  flunk "france.sh 该在前提里核档位（profile_marker_check）、setup_identity 里记上、读回里报 readback_profile_marker"
fi

# 会话出网经的代理（#731，session_proxy_load）：只认这一档期望里登记的 FLEET_SESSION_PROXY——本机档读出 Clash 的口，
# 法国读出空（直连），调用者环境里的同名变量不认；期望读不出、没登记、登记的认不出都不当成直连，原因里不带登记的值
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    NODE=$n
    break
  fi
done
proxy_case() { # 说明 期望的返回码 期望的 SESSION_PROXY 期望带的变量（空格隔开） [SESSION_PROXY_WHY 里要有的字]
  local rc=0
  SESSION_PROXY_STATE=""
  session_proxy_load || rc=$?
  if [[ $rc == "$2" && "$SESSION_PROXY" == "$3" && "${SESSION_PROXY_VARS[*]}" == "$4" &&
    "$SESSION_PROXY_WHY" == *"${5:-}"* ]]; then
    pass "$1"
  else
    flunk "$1：返回 $rc、代理「$SESSION_PROXY」、变量「${SESSION_PROXY_VARS[*]}」、原因「$SESSION_PROXY_WHY」，应为返回 $2、「$3」、「$4」"
  fi
}
desired_proxy() { # 写出的期望文件 登记成什么（DELETE＝删掉这一项）：其余照本机档那份
  "$NODE" -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (process.argv[3] === "DELETE") delete j.files["engine.env"].FLEET_SESSION_PROXY;
    else j.files["engine.env"].FLEET_SESSION_PROXY.value = process.argv[3];
    fs.writeFileSync(process.argv[2], JSON.stringify(j));' "$HERE/../local/desired-config.json" "$1" "$2"
}
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台找不到 node，会话代理（session_proxy_load）没测"
  skipped=1
else
  SESSION_PROXY_NODE=$NODE
  P=http://127.0.0.1:7890
  N=localhost,127.0.0.1,::1
  # 调用者（root）的环境里碰巧有：法国照样直连，本机档照样用登记的
  export FLEET_SESSION_PROXY=http://caller-env.invalid:1 https_proxy=http://caller-env.invalid:1
  unset PROFILE
  proxy_case "【故意造出的失败】法国（不设档位）、调用者环境里有 FLEET_SESSION_PROXY：照 deploy/france/desired-config.json 读出空＝直连，不认环境里的" 0 "" ""
  PROFILE=local
  proxy_case "本机档：照 deploy/local/desired-config.json 读出 Clash 的口，http(s)_proxy 大小写各一份、no_proxy 只放本机回环" \
    0 "$P" "http_proxy=$P https_proxy=$P HTTP_PROXY=$P HTTPS_PROXY=$P no_proxy=$N NO_PROXY=$N"
  SESSION_PROXY_NODE=$T/没有这个-node
  if session_proxy_load && [[ "$SESSION_PROXY" == "$P" ]]; then
    pass "读过一次就记下：再叫不重读（node 换成不在的也照旧）"
  else
    flunk "读过一次之后再叫该用记下的，返回非 0 或代理变成了「$SESSION_PROXY」"
  fi
  proxy_case "【故意造出的失败】node 跑不起来：没读成，不当成直连" 1 "" "" "出不了 engine.env"
  SESSION_PROXY_NODE=$NODE
  SESSION_PROXY_DESIRED=$T/没有这份.json
  proxy_case "【故意造出的失败】期望读不到：没读成" 1 "" "" "出不了 engine.env"
  desired_proxy "$T/d.json" DELETE
  SESSION_PROXY_DESIRED=$T/d.json
  proxy_case "【故意造出的失败】期望里没登记这一项：没读成" 1 "" "" "没登记 FLEET_SESSION_PROXY"
  # 和 packages/adapters/test/env.test.ts 认不出的那一串对得上（同一项登记，引擎和装机脚本两边读）
  for bad in http://user:fakesecret@127.0.0.1:7890 http://user@127.0.0.1:7890 https://127.0.0.1:7890 socks5://127.0.0.1:7890 \
    http://127.0.0.1 http://127.0.0.1:7890/pac http://127.0.0.1:65536 http://127.0.0.1:0 'http://[::1]:7890' \
    http://proxy_1:7890 127.0.0.1:7890; do
    desired_proxy "$T/d.json" "$bad"
    proxy_case "【故意造出的失败】登记成「${bad/fakesecret/***}」：认不出，没读成" 1 "" "" "不是 http://主机:端口"
    if [[ "$SESSION_PROXY_WHY" == *fakesecret* ]]; then flunk "认不出的原因里带了登记的值（账号密码会进日志）：「$SESSION_PROXY_WHY」"; fi
  done
  # 规范成的写法也和 env.ts 的 parseSessionProxy 一样：引擎给会话的、装机脚本给安装脚本的是同一个值
  desired_proxy "$T/d.json" http://Proxy.Local:07890/
  Q=http://proxy.local:7890
  proxy_case "登记成「http://Proxy.Local:07890/」：认，规范成 $Q（主机小写、端口去掉前头的 0、去掉末尾的 /）" \
    0 "$Q" "http_proxy=$Q https_proxy=$Q HTTP_PROXY=$Q HTTPS_PROXY=$Q no_proxy=$N NO_PROXY=$N"
  desired_proxy "$T/d.json" ""
  proxy_case "登记成空：读到了，直连" 0 "" ""
  SESSION_PROXY_STATE=bad
  SESSION_PROXY_NODE=$NODE SESSION_PROXY_DESIRED=""
  if session_proxy_load; then flunk "没读成的也记下：再叫照旧返回 1，不重读成别的"; else pass "没读成的也记下：再叫照旧返回 1，不重读成别的"; fi
  unset FLEET_SESSION_PROXY https_proxy PROFILE
  SESSION_PROXY_STATE=""
fi

if ((fail)); then
  echo "本机档（deploy/lib/profile.sh）：不通过"
  exit 1
fi
if ((skipped)); then
  echo "本机档（deploy/lib/profile.sh）：其余通过，有没跑成的（见上）"
  exit 2
fi
echo "本机档（deploy/lib/profile.sh）：通过"
