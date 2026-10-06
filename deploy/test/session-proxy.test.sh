#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# 会话出网经的代理（#731，deploy/lib/session-proxy.sh 的 session_proxy_load）：只认期望（deploy/france/desired-config.json）里
# 登记的 FLEET_SESSION_PROXY——法国登记成空＝直连，登记成 http://主机:端口 就读出它，调用者环境里的同名变量不认；
# 期望读不出、没登记、登记的认不出都不当成直连，原因里不带登记的值。不要 root，只碰临时目录
# （要 node，找不到记没跑成）。
# 用法：bash deploy/test/session-proxy.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/session-proxy.sh
source "$HERE/../lib/session-proxy.sh"
fail=0
skipped=0
pass() { echo "  ✓ $*"; }
flunk() {
  echo "  ✗ $*"
  fail=1
}

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
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
desired_proxy() { # 写出的期望文件 登记成什么（DELETE＝删掉这一项）：其余照 deploy/france/desired-config.json
  "$NODE" -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (process.argv[3] === "DELETE") delete j.files["engine.env"].FLEET_SESSION_PROXY;
    else j.files["engine.env"].FLEET_SESSION_PROXY.value = process.argv[3];
    fs.writeFileSync(process.argv[2], JSON.stringify(j));' "$HERE/../france/desired-config.json" "$1" "$2"
}
if [[ -z "$NODE" ]]; then
  echo "  … 没跑成：这台找不到 node，会话代理（session_proxy_load）没测"
  skipped=1
else
  SESSION_PROXY_NODE=$NODE
  P=http://127.0.0.1:7890
  N=localhost,127.0.0.1,::1
  # 调用者（root）的环境里碰巧有：照样只认期望里登记的
  export FLEET_SESSION_PROXY=http://caller-env.invalid:1 https_proxy=http://caller-env.invalid:1
  proxy_case "【故意造出的失败】调用者环境里有 FLEET_SESSION_PROXY：照 deploy/france/desired-config.json 读出空＝直连，不认环境里的" 0 "" ""
  desired_proxy "$T/d.json" "$P"
  SESSION_PROXY_DESIRED=$T/d.json
  proxy_case "登记成 $P 时读出它，http(s)_proxy 大小写各一份、no_proxy 只放本机回环" \
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
  unset FLEET_SESSION_PROXY https_proxy
  SESSION_PROXY_STATE=""
fi

if ((fail)); then
  echo "会话代理（deploy/lib/session-proxy.sh）：不通过"
  exit 1
fi
if ((skipped)); then
  echo "会话代理（deploy/lib/session-proxy.sh）：其余通过，有没跑成的（见上）"
  exit 2
fi
echo "会话代理（deploy/lib/session-proxy.sh）：通过"
