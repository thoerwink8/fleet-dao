#!/usr/bin/env bash
# shellcheck disable=SC2034 # SESSION_PROXY_* 是给调用方和测试读写的
# 会话出网经的代理（#731）：期望里登记的 engine.env → FLEET_SESSION_PROXY——登记成空＝直连（法国就是这样），登记成
# http://主机:端口 就经它出网。引擎照 engine.env 给 grok、cursor-agent 的会话带上；装机这边以会话用户跑它们的
# 官方安装脚本时也带上（lib/grok.sh、lib/cursor-agent.sh）。只认期望，不认调用者环境里的同名变量：root 的环境里碰巧有，
# 法国照样直连。读的是 deploy/france/desired-config.json，和对账同一种读法
# （config.mjs render engine.env）。第一次用时读一次、记下来：session_proxy_load 要在当前 shell 里叫，在 $(...) 里叫记不住。
# 认的样子、规范成的写法都和 packages/adapters/src/env.ts 的 parseSessionProxy 一样（同一项登记两边读，改一边另一边跟着改）：
# http、主机只有字母数字点横线、写明端口 1–65535，末尾多一个 / 也认；不收账号密码、路径。认出来的规范成 http://小写主机:端口
SESSION_PROXY_RE='^http://([A-Za-z0-9.-]+):([0-9]{1,5})/?$'
SESSION_NO_PROXY=localhost,127.0.0.1,::1 # 和 env.ts 的 SESSION_NO_PROXY 一样
# deploy 目录：挑期望、找 config.mjs
SESSION_PROXY_DEPLOY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# 读期望的 node（france.sh 的前提里查过）。装机、发布的会话里它在 /usr/bin；CI 的 runner 装的是 actions/setup-node
# 从缓存里取的那份（/opt/hostedtoolcache），/usr/bin/node 不存在，deploy/test 的那几个测试也是照这几个地方找的——
# 这里跟着照抄一遍，因为这一项还会被 sourcing 进 PATH 已经被收窄的脚本（fleet-agent-scope.sh 开头把 PATH 设成
# /usr/sbin:/usr/bin:/sbin:/bin，command -v node 在那样的 PATH 下什么也找不到）。写死一个路径就有一边读不出期望，
# 那样会一声不响地退回直连（#786）。调用方（测试）要给别的，source 之后再覆盖 SESSION_PROXY_NODE
SESSION_PROXY_NODE=""
for _n in "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node /opt/hostedtoolcache/node/*/x64/bin/node; do
  if [[ -x "$_n" ]]; then
    SESSION_PROXY_NODE=$_n
    break
  fi
done
unset _n
SESSION_PROXY_DESIRED=""         # 只有测试会给：不给就用仓里法国那一份
SESSION_PROXY_STATE=""           # 空：还没读；ok：读到了；bad：没读成（原因在 SESSION_PROXY_WHY）
SESSION_PROXY=""                 # 读到的代理（规范写法），空＝直连
SESSION_PROXY_VARS=()            # 要带进会话用户环境的（KEY=值），直连时是空的
SESSION_PROXY_WHY=""

# 读登记的会话代理，记进 SESSION_PROXY、SESSION_PROXY_VARS（http(s)_proxy 大小写各一份、no_proxy 只放本机回环）：
# 0 读到了（登记成空＝直连也是读到了）；1 期望读不出、没登记这一项、登记的认不出——不当成直连。原因进 SESSION_PROXY_WHY，
# 不带登记的值（带了账号密码的会进日志）
session_proxy_load() {
  local desired out line value port
  case $SESSION_PROXY_STATE in
  ok) return 0 ;;
  bad) return 1 ;;
  esac
  desired=${SESSION_PROXY_DESIRED:-$SESSION_PROXY_DEPLOY/france/desired-config.json}
  SESSION_PROXY_STATE=bad SESSION_PROXY="" SESSION_PROXY_VARS=()
  if ! out=$("$SESSION_PROXY_NODE" "$SESSION_PROXY_DEPLOY/france/auto-release/config.mjs" render engine.env \
    --desired "$desired" 2>&1); then
    SESSION_PROXY_WHY="照期望 $desired 出不了 engine.env（${out##*$'\n'}）"
    return 1
  fi
  if ! line=$(grep -E '^FLEET_SESSION_PROXY=' <<<"$out"); then
    SESSION_PROXY_WHY="期望 $desired 的 engine.env 里没登记 FLEET_SESSION_PROXY"
    return 1
  fi
  value=${line#FLEET_SESSION_PROXY=}
  if [[ -n "$value" ]]; then
    port=0
    if [[ "$value" =~ $SESSION_PROXY_RE ]]; then port=$((10#${BASH_REMATCH[2]})); fi
    if ((port < 1 || port > 65535)); then
      SESSION_PROXY_WHY="期望 $desired 登记的 FLEET_SESSION_PROXY 不是 http://主机:端口（不带账号密码、路径；值不打出来）"
      return 1
    fi
    value="http://${BASH_REMATCH[1],,}:$port"
    SESSION_PROXY_VARS=("http_proxy=$value" "https_proxy=$value" "HTTP_PROXY=$value" "HTTPS_PROXY=$value"
      "no_proxy=$SESSION_NO_PROXY" "NO_PROXY=$SESSION_NO_PROXY")
  fi
  SESSION_PROXY=$value SESSION_PROXY_STATE=ok SESSION_PROXY_WHY=""
}
