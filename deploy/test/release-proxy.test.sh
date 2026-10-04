#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # REDS、PROXY、PROXY_ENVS 这些是给 source 进来的 release.sh 里的函数读写的
# 本机档发布取代码、装依赖经这一档期望里登记的会话代理（#786）：deploy/release.sh 照 deploy/lib/profile.sh 的
# session_proxy_load 读这一档的期望（本机档是 Clash 的口、法国登记成空＝直连），编译成两样——git 的
# -c http.proxy=…（fetch_code 用 git_net）和要带进 pnpm 环境的几个变量（as_fleet_in）。每条路径都故意造出来：
#   1. 本机档登记了代理：取代码的 git 命令行上带 -c http.proxy=http://127.0.0.1:7890；以 fleet 跑的命令里带上
#      http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY 和 no_proxy/NO_PROXY（只放本机回环）
#   2. 【故意造出的失败】登记了代理，但期望读不出、没登记这一项、登记的认不出：判红、不拿直连顶
#   3. 【故意造出的失败】法国（期望登记成空）：命令行和环境里都不许出现任何代理变量（多了就是法国走了代理）
#   4. 【故意造出的失败】档位文件认不出（不是普通文件、内容认不出）：判红，不猜成法国——猜成本机档拿法国的期望读，
#      就把「直连」当成这一档的登记，取代码照样不通
#   5. 调用者（root）环境里碰巧有 http(s)_proxy、FLEET_SESSION_PROXY：一个都带不进去（#731 同一条规矩）
# git 和 runuser 换成假的（真命令不带 -c http.proxy、也不出网）：git 把收到的参数记下来、照桩要的回，runuser 把要跑的
# 命令原样跑起来、把它的环境记下来。不连网、不需要真的 fleet 用户。用法：bash deploy/test/release-proxy.test.sh。
# 退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# 照期望读代理要 node（和 profile.test.sh、grok.test.sh 同一个找法）。先找、PATH 再被桩改掉
REAL_NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    REAL_NODE=$n
    break
  fi
done
if [[ -z "$REAL_NODE" ]]; then
  echo "release-proxy：没跑成：这台找不到 node（照期望读会话代理要它）"
  exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FLEET_RELEASES_DIR=$TMP/releases
# shellcheck source=../release.sh
source "$HERE/../release.sh"
set +e # release.sh 开了 -e；这里自己判每一步
SESSION_PROXY_NODE=$REAL_NODE

mkdir -p "$RELEASES"
CONFIG_ETC=$TMP/etc
CONFIG_PROFILE=$CONFIG_ETC/profile
RELEASE_ENV=$CONFIG_ETC/release.env
mkdir -p "$CONFIG_ETC"
PROXY_URL=http://127.0.0.1:7890
NO_PROXY_VALUE=localhost,127.0.0.1,::1

fail=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
has() { # 说明 文本 要有的（grep -F）
  if grep -qF -- "$3" <<<"$2"; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：「%s」里没有「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
lacks() { # 说明 文本 不该有的（grep -F）
  if grep -qF -- "$3" <<<"$2"; then
    printf '  ✗ %s：「%s」里有「%s」\n' "$1" "$2" "$3"
    fail=1
  else
    printf '  ✓ %s\n' "$1"
  fi
}
last_red() { if ((${#REDS[@]})); then printf '%s' "${REDS[-1]}"; fi; }

# ── 桩 ──
# 假 git：把参数记下来（$STUB_GIT_CALLS），照调用方要的答一句（取主线回一个提交号、rev-parse 回它、merge-base 说在主线上）。
# 真 git 不带 -c http.proxy，这里正是要看它带没带
STUB=$TMP/bin
mkdir -p "$STUB"
cat >"$STUB/git" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STUB_GIT_CALLS"
case "$*" in
*fetch*) printf '%s\n' "${STUB_GIT_HEAD:-2222222222222222222222222222222222222222}" ;;
*) exit 0 ;;
esac
exit 0
SH
chmod +x "$STUB/git"
# 假 runuser：不换身份，把要跑的命令原样跑起来（bash：脚本里用了 (( )) 这些，/bin/sh 在 Debian、Ubuntu 上是 dash）
cat >"$STUB/runuser" <<'SH'
#!/bin/bash
while (($#)); do
  case $1 in
  -u) shift 2 ;;
  *) break ;;
  esac
done
exec "$@"
SH
chmod +x "$STUB/runuser"
# 假 env：as_fleet_in 里 runuser 后面跟的就是 `env -i HOME=… PATH=… 命令`，那串 KEY=值 正是命令看到的环境。这里只认
# `-i` 那一种（release.sh 里以 fleet 跑命令全是这种），照抄一份记下来；记完交回真的 env 照常把命令跑起来（真跑，
# 退出码、输出都照传）。设在 -i 这一层而不是命令那一层：env -i 给的 PATH 只有系统目录，看不到这个桩
cat >"$STUB/env" <<'SH'
#!/bin/bash
if [[ "${1:-}" == -i ]]; then
  shift
  for kv in "$@"; do
    case $kv in
    *=*) echo "${kv%%=*}=${kv#*=}" >>"$STUB_RUNUSER_ENV" ;;
    *) break ;;
    esac
  done
fi
exec /usr/bin/env "$@"
SH
chmod +x "$STUB/env"
export STUB_GIT_CALLS=$TMP/git-calls
export STUB_RUNUSER_ENV=$TMP/runuser-env
export PATH=$STUB:$PATH

# 期望文件：照一份真的改一项（和 deploy/test/profile.test.sh 同一个写法，值从仓里那份现取、不写死）
desired() { # 写出的文件 登记成什么（DELETE＝删掉这一项） [哪一份底稿]
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    if (process.argv[2] === "DELETE") delete j.files["engine.env"].FLEET_SESSION_PROXY;
    else j.files["engine.env"].FLEET_SESSION_PROXY.value = process.argv[2];
    fs.writeFileSync(process.argv[1], JSON.stringify(j));' "$1" "$2" "${3:-$HERE/../local/desired-config.json}"
}
desired "$TMP/local.json" "$PROXY_URL"
desired "$TMP/france.json" "" "$HERE/../france/desired-config.json"

profile_marker() { # 档位文件里写什么（DELETE＝不放）
  rm -f -- "$CONFIG_PROFILE"
  case $1 in
  DELETE) return 0 ;;
  *) printf '%s\n' "$1" >"$CONFIG_PROFILE" ;;
  esac
  chmod 640 "$CONFIG_PROFILE"
}
# 每一段开头都从头读一次：session_proxy_load 读过就记下（SESSION_PROXY_STATE=ok），不改它不会再读
reload() { # 哪一份期望 [档位文件的写法]
  profile_marker "${2:-local}"
  PROXY_READY=0
  PROXY=()
  PROXY_ENVS=()
  SESSION_PROXY_STATE="" SESSION_PROXY="" SESSION_PROXY_VARS=() SESSION_PROXY_WHY=""
  SESSION_PROXY_DESIRED=$1
}
git_calls() { cat -- "$STUB_GIT_CALLS" 2>/dev/null; }
runuser_env() { cat -- "$STUB_RUNUSER_ENV" 2>/dev/null; }
# 取一次代码（真的 fetch_code，git 是假的）
fetch_once() {
  : >"$STUB_GIT_CALLS"
  mkdir -p "$CACHE" # 裸仓建过（release.sh 自己会 init --bare，这里省掉那两条）
  fetch_code "" >/dev/null 2>&1
}
# 以 fleet 跑一条命令（真的 as_fleet_in，runuser 和 env 是假的：假的 env 把 `env -i` 那串 KEY=值 记下来）
fleet_once() {
  : >"$STUB_RUNUSER_ENV"
  mkdir -p "$TMP/stage"
  as_fleet_in "$TMP/stage" true >/dev/null 2>&1
}
# 记下来的环境里某一个变量是什么（没记到就是空）
env_of() { grep -E "^$1=" "$STUB_RUNUSER_ENV" 2>/dev/null | tail -1 | cut -d= -f2-; }

# root 自己环境里碰巧有的：一个都不该带进 git、pnpm
export https_proxy=http://caller-env.invalid:1 http_proxy=http://caller-env.invalid:1
export FLEET_SESSION_PROXY=http://caller-env.invalid:1

echo "== 1. 本机档登记了代理：取代码的 git 命令行、以 fleet 跑的环境都带上它"
REDS=()
reload "$TMP/local.json"
profile_set >/dev/null 2>&1
check "档位读成本机档" "$PROFILE" local
proxy_load >/dev/null 2>&1
check "读成了（没有红）" "${#REDS[@]}" 0
check "git 带的参数" "${PROXY[*]}" "-c http.proxy=$PROXY_URL"
check "带进环境的是 http(s)_proxy 大小写各一份 + no_proxy 只放本机回环" "${PROXY_ENVS[*]}" \
  "http_proxy=$PROXY_URL https_proxy=$PROXY_URL HTTP_PROXY=$PROXY_URL HTTPS_PROXY=$PROXY_URL no_proxy=$NO_PROXY_VALUE NO_PROXY=$NO_PROXY_VALUE"

fetch_once
has "取主线：git 命令行上有 -c http.proxy=…" "$(git_calls)" "-c http.proxy=$PROXY_URL"
has "取主线：代理挂在 fetch 前面（git -c … -C <裸仓> fetch）" "$(git_calls)" "-c http.proxy=$PROXY_URL -C $CACHE fetch"
lacks "取主线：调用者环境里的代理没进命令行" "$(git_calls)" "caller-env.invalid"

fleet_once
check "以 fleet 跑的命令：环境里有 https_proxy" "$(env_of https_proxy)" "$PROXY_URL"
check "以 fleet 跑的命令：环境里有 HTTPS_PROXY" "$(env_of HTTPS_PROXY)" "$PROXY_URL"
check "以 fleet 跑的命令：环境里有 http_proxy" "$(env_of http_proxy)" "$PROXY_URL"
check "以 fleet 跑的命令：no_proxy 只放本机回环" "$(env_of no_proxy)" "$NO_PROXY_VALUE"
check "以 fleet 跑的命令：HOME 照旧" "$(env_of HOME)" "/home/fleet"
check "以 fleet 跑的命令：FLEET_SESSION_PROXY（调用者环境里的）没带进去" "$(env_of FLEET_SESSION_PROXY)" ""
lacks "以 fleet 跑的命令：调用者环境里的代理没带进去" "$(runuser_env)" "caller-env.invalid"

echo "== 2. 【故意造出的失败】登记了代理却读不出：判红，不拿直连顶"
desired "$TMP/no-item.json" DELETE
desired "$TMP/bad-value.json" 'http://user:fakesecret@127.0.0.1:7890'
for bad in "没登记这一项:$TMP/no-item.json" "登记的认不出:$TMP/bad-value.json" "期望读不到:$TMP/没有这份.json"; do
  what=${bad%%:*}
  REDS=()
  reload "${bad#*:}"
  if proxy_load >/dev/null 2>&1; then
    printf '  ✗ %s：该判红、返回非 0，却读成了\n' "$what"
    fail=1
  else
    printf '  ✓ %s：判红、返回非 0（不拿直连顶）\n' "$what"
  fi
  check "$what：记了一笔红" "${#REDS[@]}" 1
  has "$what：红里说清是这一档的期望没读成、不拿直连顶" "$(last_red)" "不拿直连顶"
  check "$what：git 那里一个参数都不带（不是空代理，是没读成）" "${PROXY[*]}" ""
  check "$what：环境里一个代理变量都不带" "${PROXY_ENVS[*]}" ""
  lacks "$what：红里不带登记的值（带了账号密码的会进日志）" "$(last_red)" "fakesecret"
done

echo "== 3. 【故意造出的失败】法国（期望登记成空）：命令行和环境里都不许出现代理"
REDS=()
reload "$TMP/france.json" france
if proxy_load >/dev/null 2>&1; then
  printf '  ✓ 照期望读出空＝直连，读成了（不是没读成）\n'
else
  printf '  ✗ 法国登记成空该读成直连，却判了红\n'
  fail=1
fi
check "法国：没有红" "${#REDS[@]}" 0
check "法国：git 不带 -c http.proxy" "${PROXY[*]}" ""
check "法国：环境里一个代理变量都不带" "${PROXY_ENVS[*]}" ""
fetch_once
lacks "法国取代码的 git 命令行上没有代理" "$(git_calls)" "http.proxy"
fleet_once
check "法国（本机 root 环境里有代理）：以 fleet 跑的命令里一个代理变量都没有" \
  "$(grep -cE '^(https?|HTTPS?)_proxy=|^(NO_|no_)proxy=' "$STUB_RUNUSER_ENV" 2>/dev/null || true)" 0
lacks "法国：调用者环境里的代理没带进去" "$(runuser_env)" "caller-env.invalid"
check "法国：HOME 照旧（不是把整个环境丢了）" "$(env_of HOME)" "/home/fleet"

echo "== 4. 【故意造出的失败】档位文件认不出：判红，不猜成法国"
for bad in "写成别的档:paris" "空文件:"; do
  what=${bad%%:*}
  REDS=()
  profile_marker "${bad#*:}"
  PROXY_READY=0
  SESSION_PROXY_STATE="" SESSION_PROXY_WHY=""
  SESSION_PROXY_DESIRED=$TMP/local.json
  if profile_set >/dev/null 2>&1; then
    printf '  ✗ %s：该判红、返回非 0，却当成了法国\n' "$what"
    fail=1
  else
    printf '  ✓ %s：判红、返回非 0\n' "$what"
  fi
  check "$what：记了一笔红" "${#REDS[@]}" 1
done
REDS=()
rm -f -- "$CONFIG_PROFILE"
ln -s "$TMP" "$CONFIG_PROFILE"
PROXY_READY=0
SESSION_PROXY_STATE="" SESSION_PROXY_WHY=""
if profile_set >/dev/null 2>&1; then
  printf '  ✗ 不是普通文件（符号链接）：该判红，却当成了法国\n'
  fail=1
else
  printf '  ✓ 不是普通文件（符号链接）：判红、返回非 0\n'
fi
check "不是普通文件：记了一笔红" "${#REDS[@]}" 1
rm -f -- "$CONFIG_PROFILE"

echo "== 5. 只读一次：再叫不重读（期望换成没有的也照旧）"
REDS=()
reload "$TMP/local.json"
proxy_load >/dev/null 2>&1
SESSION_PROXY_DESIRED=$TMP/没有这份.json
if proxy_load >/dev/null 2>&1 && [[ "${PROXY[*]}" == "-c http.proxy=$PROXY_URL" ]]; then
  printf '  ✓ 第二遍用的是记下的，没重读期望\n'
else
  printf '  ✗ 第二遍重读了期望：代理变成了「%s」\n' "${PROXY[*]}"
  fail=1
fi

if ((fail)); then
  echo "release-proxy：不通过"
  exit 1
fi
echo "release-proxy：通过"
