#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy/lib/grok.sh（给会话用户装、查 grok 命令行和它的登录态）的判据，每条失败路径都故意造出来：
#   1. 没装：判红、说清没装；装：以那个用户自己的身份、在他家里、环境清干净（PATH 里只有系统目录、SHELL 是 /bin/sh）地跑
#      官方安装脚本，先下成文件再跑、跑完删掉，装出来的都归他、只在 ~/.grok 下面（~/.local/bin 里的 agent 不被盖掉、启动文件
#      不改），装完核得上；第二遍不再跑安装脚本、一处不改
#   2. 不是文件（目录）、不能跑、链接断了：算没装（和引擎起 grok 的判法一样）
#   3. 装着却跑不成（退出非 0、解释器没了）、输出认不出、卡住、不理叫停：判红，不重装、不删
#   4. 装的时候出错（安装脚本失败、下不到、退出 0 却什么都没装、卡住）：只记红、不中断，不算装了
#   5. 没查成（临时目录建不了、查不到这个用户、起不来）：不当成没装、不装
#   6. 登录态：没有记待配、写清怎么登录；是符号链接、目录、属主不对、权限不是 600、空的判红；在就只报属主、权限、大小，
#      全部输出里没有文件内容
#   7. 会话代理（#731）：只带期望里登记的——法国登记的是空，一个代理变量都不带（root 环境里的 http(s)_proxy、
#      FLEET_SESSION_PROXY 都带不进去）；登记成 http://127.0.0.1:7890 就带上它；登记的读不出：不装，装着了也判红、不报绿
# 不出网：官方安装脚本换成假的（照官方的样子把二进制放进 ~/.grok/downloads、~/.grok/bin 下链过去；PATH 上有他写得动的
# ~/.local/bin 就往里链 agent；SHELL 是 bash、zsh、fish 就改启动文件——它是 bash 跑的，SHELL 空着 bash 会自己填上登录 shell），
# 经 file:// 下；$T 下放开关文件让它故意出错。
# 临时用户的编号会被下一个测试的临时用户重用（cursor-agent 的测试卡住那一条也会在 /tmp 留下文件）：查「下下来的安装脚本删了」
# 只看这一次下的那个文件，收尾时把这个用户留在 /tmp 的东西删掉，不留给后面的测试。
# 要 root：得建临时用户、以他的身份跑；要 node（照期望读会话代理）。用法：sudo bash deploy/test/grok.test.sh。
# 退出码：0 通过，1 不通过，2 没跑成。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
# shellcheck source=../lib/session-proxy.sh
source "$HERE/../lib/session-proxy.sh"
# shellcheck source=../lib/grok.sh
source "$HERE/../lib/grok.sh"

if ((EUID != 0)); then
  echo "grok：没跑成：要 root（得建临时用户、以他的身份跑）"
  exit 2
fi
# sudo 会换掉 PATH，CI 里 setup-node 装的那个不在上面，去它的缓存目录找
SESSION_PROXY_NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/hostedtoolcache/node/*/x64/bin/node /usr/bin/node /usr/local/bin/node; do
  if [[ -x "$n" ]]; then
    SESSION_PROXY_NODE=$n
    break
  fi
done
if [[ -z "$SESSION_PROXY_NODE" ]]; then
  echo "grok：没跑成：这台找不到 node（照期望读会话代理要它）"
  exit 2
fi

U=fleet-grok-test-$$
T=$(mktemp -d /var/tmp/grok-test.XXXXXX)
cleanup() {
  pkill -KILL -u "$U" >/dev/null 2>&1
  find /tmp -maxdepth 1 -user "$U" -exec rm -rf -- {} + >/dev/null 2>&1
  userdel "$U" >/dev/null 2>&1
  rm -rf -- "$T"
}
trap cleanup EXIT
chmod 755 "$T"
H=$T/home
if ! useradd --system --user-group --home-dir "$H" --create-home --shell /bin/bash "$U" >/dev/null 2>&1; then
  echo "grok：没跑成：建不了临时用户 $U"
  exit 2
fi
B=$H/.grok/bin/grok
A=$H/.grok/auth.json
VER=1.0.41
as_u() { runuser -u "$U" -- "$@"; }
# root 这边的环境变量：安装脚本和 --version 都不该看得到
export GROK_TEST_LEAK=1
export SHELL=/bin/bash

# 他家里已经有 cursor-agent 的安装脚本链的 ~/.local/bin/agent：装 grok 不许把它盖掉
as_u mkdir -p "$H/.local/bin"
as_u ln -s /nonexistent/cursor-agent "$H/.local/bin/agent"

# 假的官方安装脚本：一行记下以谁、在哪、带没带进 root 的变量、SHELL、自己是从哪跑的、PATH；照官方的样子装。
# 开关：install-fail 像下载失败那样退出 1；install-noop 什么都不装、照样退出 0；install-hang 卡住
install -o "$U" -g "$U" -m 644 /dev/null "$T/install.log"
cat >"$T/install.sh" <<EOF
#!/usr/bin/env bash
echo "\$(id -un) \$HOME \$PWD \${GROK_TEST_LEAK-unset} \${SHELL-unset} \$0 \$PATH" >>"$T/install.log"
echo "\${http_proxy-unset} \${https_proxy-unset} \${HTTP_PROXY-unset} \${HTTPS_PROXY-unset} \${no_proxy-unset} \${NO_PROXY-unset}" >>"$T/proxy.log"
if [ -e "$T/install-fail" ]; then
  printf '\033[0;31mError: binary download failed from https://x.ai/cli/grok-$VER-linux-x86_64\033[0m\n' >&2
  exit 1
fi
if [ -e "$T/install-hang" ]; then sleep 60; fi
if [ -e "$T/install-noop" ]; then exit 0; fi
d=\$HOME/.grok/downloads
b=\$HOME/.grok/bin
mkdir -p "\$d" "\$b"
printf '#!/bin/sh\n[ "\$1" = --version ] && echo "grok %s (4220f3b224a6)"\n' "$VER" >"\$d/grok-linux-x86_64.tmp.\$\$"
chmod 755 "\$d/grok-linux-x86_64.tmp.\$\$"
mv -f "\$d/grok-linux-x86_64.tmp.\$\$" "\$d/grok-linux-x86_64"
ln -sf ../downloads/grok-linux-x86_64 "\$b/grok"
ln -sf ../downloads/grok-linux-x86_64 "\$b/agent"
# 和官方的一样：PATH 上有他写得动的 ~/.local/bin 就往里链；SHELL 是 bash、zsh、fish 就改它的启动文件
case ":\$PATH:" in *":\$HOME/.local/bin:"*) ln -sf "\$b/agent" "\$HOME/.local/bin/agent" ;; esac
case "\$(basename "\${SHELL:-}")" in bash | zsh | fish) printf '\n# >>> grok installer >>>\n' >>"\$HOME/.bashrc" ;; esac
EOF
chmod 644 "$T/install.sh"
install -o "$U" -g "$U" -m 644 /dev/null "$T/proxy.log"
URL=file://$T/install.sh
runs() { wc -l <"$T/install.log"; }
# root 自己环境里的代理（root 的登录 shell 里碰巧有）、碰巧有的 FLEET_SESSION_PROXY：安装脚本只该看到期望里
# 登记的，这几个一个都看不到
export https_proxy=http://root-only.invalid:1 HTTPS_PROXY=http://root-only.invalid:1
export FLEET_SESSION_PROXY=http://root-only.invalid:1
# 放一个假 grok 在他家里（以他的身份），正文是 sh；第二个参数给 644 就是不能跑
put_grok() { # 正文 [权限]
  as_u mkdir -p "${B%/*}"
  rm -f -- "$B"
  printf '#!/bin/sh\n%s\n' "$1" >"$T/grok.tmp"
  install -o "$U" -g "$U" -m "${2:-755}" "$T/grok.tmp" "$B"
}

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

echo "== 1. 没装：判红、说清没装"
grok_version "$U" "$B"
check "读不成（返回 1）" "$?" 1
check "认成没装" "$GROK_ABSENT" 1
has "原因写没装、在哪看的" "$GROK_BAD" "没装 grok 命令行（$B 不在"
REDS=()
check_grok "$U" "$B" >/dev/null
check "读回记一笔红" "${#REDS[@]}" 1
has "读回说引擎起不了、怎么补" "$(last_red)" '引擎起不了 Grok 会话：重跑 bash deploy/france.sh'

echo "== 1. 装：以他自己的身份、在他家里、环境清干净地跑官方安装脚本；只装在 ~/.grok 下面；装完核得上；第二遍不动"
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "记一笔改动" "${#CHANGES[@]}" 1
check "没有红" "${#REDS[@]}" 0
has "改动写清装了哪一版、装在哪、还要登录" "${CHANGES[0]-}" "装 grok $VER（官方安装脚本 $URL，以他自己的身份装在 $B）；还要创始人以他的身份登录一次"
check "安装脚本跑了一次" "$(runs)" 1
read -r who home pwd leak shell self path <"$T/install.log"
check "以他的身份、家目录和当前目录都是他家" "$who $home $pwd" "$U $H $H"
check "root 这边的环境变量带不进去" "$leak" unset
check "SHELL 是 /bin/sh（安装脚本就不改他的启动文件；root 这边的 /bin/bash 带不进去）" "$shell" /bin/sh
check "PATH 只有系统目录（没有他写得动的 ~/.local/bin）" "$path" /usr/local/bin:/usr/bin:/bin
check "法国（期望登记的会话代理是空）：一个代理变量都不带，root 环境里的代理、FLEET_SESSION_PROXY 都带不进去" \
  "$(tail -1 "$T/proxy.log")" "unset unset unset unset unset unset"
has "安装脚本先下成文件再跑（不是 curl | bash）" "$self" '^/tmp/'
check "下下来的安装脚本跑完删了" "$(if [[ -e "$self" ]]; then echo "还在：$self"; fi)" ""
check "他家 .local/bin 里 cursor-agent 链的 agent 没被盖掉" "$(readlink "$H/.local/bin/agent")" /nonexistent/cursor-agent
check "启动文件没被改" "$(cat -- "$H/.bashrc" 2>/dev/null | grep -c 'grok installer')" 0
grok_version "$U" "$B"
check "装完读得到版本" "$GROK_HAVE" "$VER"
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "第二遍一处没改" "${#CHANGES[@]}" 0
check "第二遍没有红" "${#REDS[@]}" 0
check "第二遍没再跑安装脚本" "$(runs)" 1
REDS=()
check_grok "$U" "$B" >/dev/null
check "读回没有红" "${#REDS[@]}" 0

echo "== 2. 不是文件、不能跑、链接断了：算没装（和引擎起 grok 的判法一样）"
rm -f -- "$B"
as_u mkdir -p "$B"
grok_version "$U" "$B"
check "是个目录：算没装" "$?:$GROK_ABSENT" 1:1
rmdir -- "$B"
put_grok "echo grok $VER" 644
grok_version "$U" "$B"
check "不能跑：算没装" "$?:$GROK_ABSENT" 1:1
rm -f -- "$B"
as_u ln -s ../downloads/nope "$B"
grok_version "$U" "$B"
check "链接断了（下的二进制没了）：算没装" "$?:$GROK_ABSENT" 1:1
rm -f -- "$B"
as_u ln -s ../downloads/grok-linux-x86_64 "$B"
grok_version "$U" "$B"
check "链回去：读得到" "$GROK_HAVE" "$VER"

echo "== 3. 装着却跑不成、输出认不出、卡住：判红，不重装、不删"
expect_bad() { # 说明 正文 原因里要有的（grep -E）
  put_grok "$2"
  grok_version "$U" "$B"
  check "$1：读不成" "$?" 1
  check "$1：不认成没装" "$GROK_ABSENT" 0
  has "$1：原因" "$GROK_BAD" "$3"
}
expect_bad "退出非 0" 'echo "boom: 坏了" >&2; exit 3' "$B --version 退出 3：boom: 坏了"
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "跑不成：不重装（没再跑安装脚本）" "$(runs)" 1
check "跑不成：一处没改" "${#CHANGES[@]}" 0
has "跑不成：记红，说不重装、不删" "$(last_red)" '退出 3：boom: 坏了；不重装、不删'
check "跑不成：文件还在" "$(test -e "$B" && echo 在)" 在
REDS=()
check_grok "$U" "$B" >/dev/null
has "跑不成：读回记红" "$(last_red)" "$B --version 退出 3"
rm -f -- "$B"
printf '#!/nonexistent/sh\necho grok %s\n' "$VER" >"$T/grok.tmp"
install -o "$U" -g "$U" -m 755 "$T/grok.tmp" "$B"
grok_version "$U" "$B"
check "解释器没了（起不来也退出 127）：不认成没装" "$GROK_ABSENT" 0
has "解释器没了：原因是跑 --version 没成" "$GROK_BAD" "$B --version 退出 (126|127)"
expect_bad "输出认不出" 'echo "Grok Build v1"' '--version 的输出认不出（该是一行「grok 版本号 \(提交\)」）：「Grok Build v1」'
expect_bad "多打了一行" "echo 'grok $VER (4220f3b224a6)'; echo 'update available'" "输出认不出.*：「grok $VER \\(4220f3b224a6\\) ⏎ update available」"
expect_bad "什么都不打" 'exit 0' '输出认不出.*：「」'
GROK_TIMEOUT=1
t0=$SECONDS
expect_bad "卡住" 'sleep 60' "$B --version 卡住，被 timeout 叫停（退出码 124"
check "卡住：几秒就返回" "$((SECONDS - t0 <= 5))" 1
t0=$SECONDS
expect_bad "不理叫停" "trap '' TERM; sleep 60" '退出码 137'
check "不理叫停：再过 5 秒被强杀就返回" "$((SECONDS - t0 <= 10))" 1
pkill -KILL -u "$U" >/dev/null 2>&1
GROK_TIMEOUT=20
rm -f -- "$B"
as_u ln -s ../downloads/grok-linux-x86_64 "$B"
grok_version "$U" "$B"
check "换回好的：读得到" "$GROK_HAVE" "$VER"

echo "== 4. 装的时候出错：只记红、不中断，不算装了"
rm -rf -- "$H/.grok"
expect_install_red() { # 说明 地址 红里要有的（grep -E）
  local before
  before=$(runs)
  CHANGES=() REDS=()
  ensure_grok "$U" "$B" "$2" >/dev/null
  check "$1：返回 0（不中断装机）" "$?" 0
  check "$1：一处没改" "${#CHANGES[@]}" 0
  check "$1：记一笔红" "${#REDS[@]}" 1
  has "$1：红里写清" "$(last_red)" "$3"
  RUNS_DELTA=$(($(runs) - before))
}
touch "$T/install-fail"
expect_install_red "安装脚本失败" "$URL" "没装上（官方安装脚本 $URL 退出 1）：Error: binary download failed"
has "安装脚本失败：终端控制符去掉了" "$(last_red)" '^[^'$'\033'']*$'
rm -f "$T/install-fail"
expect_install_red "下不到安装脚本" "file://$T/nope.sh" '没装上.*退出 1）：.*下不到安装脚本'
check "下不到：没跑安装脚本" "$RUNS_DELTA" 0
touch "$T/install-noop"
expect_install_red "退出 0 却什么都没装" "$URL" "跑完官方安装脚本（$URL），grok 还是用不了：没装 grok 命令行"
rm -f "$T/install-noop"
touch "$T/install-hang"
GROK_INSTALL_TIMEOUT=2
t0=$SECONDS
expect_install_red "安装卡住" "$URL" '装 grok 卡住，被 timeout 叫停（退出码 124'
check "安装卡住：几秒就返回" "$((SECONDS - t0 <= 6))" 1
pkill -KILL -u "$U" >/dev/null 2>&1
rm -f "$T/install-hang"
GROK_INSTALL_TIMEOUT=900
check "上面几次都没留下能跑的" "$(grok_version "$U" "$B"; echo "$GROK_ABSENT")" 1
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "好了再装：装上" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
check "他家里没有不归他的文件" "$(find "$H" ! -user "$U" -printf '%p\n' | head -3)" ""

echo "== 5. 没查成：不当成没装、不装"
before=$(runs)
TMPDIR=$T/没有这个目录 grok_version "$U" "$B"
check "临时目录建不了：读不成" "$?" 1
check "临时目录建不了：不认成没装" "$GROK_ABSENT" 0
has "临时目录建不了：原因说没查成" "$GROK_BAD" '建不了放 grok --version 输出的临时目录.*没查成'
grok_version "fleet-no-such-$$" "$B"
check "查不到这个用户：不认成没装" "$?:$GROK_ABSENT" 1:0
has "查不到这个用户：原因" "$GROK_BAD" "getent 查不到 fleet-no-such-$$ 的家目录"
# nobody 的家目录（/nonexistent）不在：进不去、起不来，标准错误里有话
grok_version nobody /nonexistent/.grok/bin/grok
check "起不来：不认成没装" "$?:$GROK_ABSENT" 1:0
has "起不来：原因说退出几、带着报错" "$GROK_BAD" '/nonexistent/.grok/bin/grok --version 退出 1：.+'
CHANGES=() REDS=()
ensure_grok nobody /nonexistent/.grok/bin/grok "$URL" >/dev/null
check "起不来：不装、记红" "$(($(runs) - before)) ${#CHANGES[@]} ${#REDS[@]}" "0 0 1"

echo "== 6. 登录态：只看在不在、是不是真文件、属主、权限、大小，不读内容"
TOKEN="fake-grok-token-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
out=""
login() { # 跑一遍读回：结论进 LAST（待配或红或好），输出攒进 out（不走 $(...)：REDS、PENDING 要记在这个 shell 里）
  REDS=() PENDING=()
  check_grok_login "$U" "$A" "$B" >"$T/login.out"
  LAST=$(cat -- "$T/login.out")
  out+="$LAST"$'\n'
}
rm -f -- "$A"
login
check "没有：记待配，不判红" "${#PENDING[@]} ${#REDS[@]}" "1 0"
has "没有：写清怎么登录" "$LAST" "还没登录 grok（没有 $A）：创始人跑 sudo -iu $U $B login --device-code"
as_u ln -s /etc/hostname "$A"
login
has "是符号链接：判红" "${REDS[0]-}" '是符号链接.*删掉它，以 .* 的身份重新登录一次'
rm -f -- "$A"
as_u mkdir "$A"
login
has "是个目录：判红" "${REDS[0]-}" '不是普通文件'
rmdir -- "$A"
printf '%s' "$TOKEN" >"$T/auth.tmp"
install -o root -g root -m 600 "$T/auth.tmp" "$A"
login
has "属主不对：判红，写清是谁、该是谁" "${REDS[0]-}" "属主是 root（要 $U）"
install -o "$U" -g "$U" -m 644 "$T/auth.tmp" "$A"
login
has "权限太松：判红" "${REDS[0]-}" '权限是 644（要 600）（内容没读）：改回属'
install -o "$U" -g "$U" -m 600 /dev/null "$A"
login
has "空的：判红，写清删掉重登" "${REDS[0]-}" '是空的（内容没读）：.*空的就删掉它'
install -o "$U" -g "$U" -m 600 "$T/auth.tmp" "$A"
login
check "放好了：不判红、不待配" "${#PENDING[@]} ${#REDS[@]}" "0 0"
has "放好了：只报属主、权限、大小" "$LAST" "登录态在：$A 属 $U、600、${#TOKEN} 字节（内容没读"
check "全部输出里没有文件内容" "$(grep -c -- "$TOKEN" <<<"$out")" 0

echo "== 7. 会话代理（#731：只认期望里登记的；法国登记成空＝直连，登记了就带上）"
rm -rf -- "$H/.grok"
before=$(runs)
SESSION_PROXY_DESIRED=$T/没有这份.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "【故意造出的失败】登记的会话代理读不出：不装、记红（不拿直连顶）" "$(($(runs) - before)) ${#CHANGES[@]} ${#REDS[@]}" "0 0 1"
has "读不出：红里写清是会话代理没读成" "$(last_red)" '这一档登记的会话代理没读成（照期望 .*没有这份\.json 出不了 engine\.env'
# 照 deploy/france/desired-config.json 改写出一份，把会话代理登记成 http://127.0.0.1:7890（值从仓里那份现取、不写死别的）
"$SESSION_PROXY_NODE" -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  j.files["engine.env"].FLEET_SESSION_PROXY.value = "http://127.0.0.1:7890";
  fs.writeFileSync(process.argv[2], JSON.stringify(j));' "$HERE/../france/desired-config.json" "$T/proxied.json"
SESSION_PROXY_DESIRED=$T/proxied.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "登记了代理：装上" "${#CHANGES[@]} ${#REDS[@]}" "1 0"
# 【故意造出的失败】的另一面：登记了代理、安装脚本的环境里却没有，这里就红
check "登记了代理：安装脚本的环境里带上它（大小写各一份、no_proxy 只放本机回环），root 环境里的没带进去" \
  "$(tail -1 "$T/proxy.log")" \
  "http://127.0.0.1:7890 http://127.0.0.1:7890 http://127.0.0.1:7890 http://127.0.0.1:7890 localhost,127.0.0.1,::1 localhost,127.0.0.1,::1"
read -r who home pwd leak shell self path < <(tail -1 "$T/install.log")
check "别的照旧清干净：root 的变量、SHELL、PATH" "$leak $shell $path" "unset /bin/sh /usr/local/bin:/usr/bin:/bin"
SESSION_PROXY_DESIRED=$T/没有这份.json SESSION_PROXY_STATE=""
CHANGES=() REDS=()
ensure_grok "$U" "$B" "$URL" >/dev/null
check "【故意造出的失败】装着了、登记的会话代理读不出：照样判红，不拿没经代理查的报绿" "${#CHANGES[@]} ${#REDS[@]}" "0 1"
SESSION_PROXY_DESIRED="" SESSION_PROXY_STATE=""

if ((fail)); then
  echo "grok：不通过"
  exit 1
fi
echo "grok：通过"
