#!/usr/bin/env bash
# shellcheck disable=SC2034 # CURSOR_API_KEY_FILE 是给调用方读的
# 会话用户的 Cursor API 密钥（#212；创始人 2026-09-27 拍：Cursor 改用 API 密钥——浏览器登录在没有桌面的服务器上存不下，
# docs/ops.md 第五节「会话用户的 Cursor 密钥」）。密钥是会话用户自己家里的一个文件：属他、600、只有一行密钥、不带换行。
# 引擎每次起 Cursor 会话、探针，由会话用户自己读它、放进 cursor-agent 的环境（packages/engine/src/real/hosts.ts 的
# CURSOR_KEY_SCRIPT：判据和这里的读回一样，另外核内容）。这里三件事，值一律不打（结论里只有路径、属主、权限、字节数）：
#   放 cursor_key_put：从标准输入收一把，以会话用户自己的身份先核、再落临时名、再换上；收到空的、不像一把密钥的不换
#   查 check_cursor_key：france.sh 的读回，只看在不在、是不是真文件、属主、权限、大小，不读值
#   撤 cursor_key_remove：以会话用户的身份删掉
# 写和删都以会话用户的身份做：root 在他家里动手，他预先放个符号链接就能把 root 引到别处去，家里也会留下 root 的文件。
# deploy/cursor-key.sh（人手跑的入口）、france.sh 和 deploy/test/cursor-key.test.sh 共用；要先 source common.sh
# （ok、changed、red、pending）。

# 放在哪（{user} 换成会话用户）：和 packages/engine/src/real/hosts.ts 的 DEFAULT_CURSOR_API_KEY_FILE 一样（engine 的
# hosts.test.ts 核对，改一边另一边跟着改）
CURSOR_API_KEY_FILE='/home/{user}/.cursor/fleet-api-key'

cursor_key_file() { printf '%s' "${CURSOR_API_KEY_FILE//\{user\}/$1}"; } # 会话用户

# 以会话用户的身份跑的那段（sh -c，参数是放到哪）：标准输入是密钥，末尾带不带一个换行都行（剪贴板、PowerShell 的管道会补
# 一个，Windows 的是 \r\n）；多出来的空行和别的空白一样不收。先收全、核过（非空、只有一行、没有空白和控制字符），才在同一个
# 目录里落临时名、改 600、换上；不然什么都不动，原来那份原样留着。值只在 sh 的变量里：printf 是 sh 自带的，不上任何命令行。
cursor_key_put_script() {
  cat <<'EOF'
f=$1
d=${f%/*}
umask 077
# $(cat) 会把末尾的换行全去掉：垫一个 x 收全，再只去掉末尾一个换行、一个回车（Windows 的 \r\n），多出来的照样拦
k=$(cat && echo x) || { echo "没换：读标准输入出错，原来那份原样留着" >&2; exit 1; }
k=${k%x}
nl=$(printf '\nx')
nl=${nl%x}
cr=$(printf '\r')
k=${k%"$nl"}
k=${k%"$cr"}
case $k in
'' | *[[:space:]]* | *[[:cntrl:]]*)
  echo "没换：收到的是空的，或者里面有空白、换行、控制字符，不像一把密钥（只该是一行）；原来那份原样留着" >&2
  exit 1
  ;;
esac
if [ -d "$f" ] && [ ! -L "$f" ]; then echo "没换：$f 是个目录" >&2; exit 1; fi
mkdir -p -- "$d" || { echo "没换：建不了 $d" >&2; exit 1; }
t=$(mktemp -- "$d/.new.XXXXXX") || { echo "没换：在 $d 里建不了临时文件" >&2; exit 1; }
if printf '%s' "$k" >"$t" && chmod 600 -- "$t" && mv -fT -- "$t" "$f"; then exit 0; fi
rm -f -- "$t"
echo "没换：写不进去，原来那份原样留着" >&2
exit 1
EOF
}

# 以会话用户的身份跑一条命令：环境清干净，PATH 只有系统目录（他家里写得动的一概不在），工作目录是 /
cursor_key_as() { # 用户 命令…
  local u=$1 home
  shift
  home=$(getent passwd "$u" | cut -d: -f6) || home=""
  [[ -n "$home" ]] || return 1
  (cd / && runuser -u "$u" -- env -i HOME="$home" USER="$u" LOGNAME="$u" PATH=/usr/bin:/bin LANG=C.UTF-8 "$@")
}

# 读回（france.sh 的读回、deploy/cursor-key.sh check）：只看在不在、是不是真文件、属主、权限、大小，不读值。
# 还没放记「待配」（要创始人在 Cursor 后台生成一把、照 ops 放进来）；放了却不对判红
check_cursor_key() { # 用户 文件
  local u=$1 f=$2 meta owner mode size bad=""
  local how="照 docs/ops.md 第五节「会话用户的 Cursor 密钥」重放一次"
  if [[ -L "$f" ]]; then
    red "$u 的 Cursor 密钥 $f 是符号链接（引擎只认真文件）：$how"
    return 0
  fi
  if [[ ! -e "$f" ]]; then
    pending "$u 的 Cursor 密钥还没放（$f）：创始人在 Cursor 后台（cursor.com/dashboard/api）生成一把，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」那条命令放进来；放好之前 Cursor 的路由探不通"
    return 0
  fi
  if [[ ! -f "$f" ]]; then
    red "$u 的 Cursor 密钥 $f 不是普通文件：$how"
    return 0
  fi
  if ! meta=$(stat -c '%U %a %s' -- "$f" 2>/dev/null) || [[ -z "$meta" ]]; then
    red "查不了 $u 的 Cursor 密钥 $f 的属主和权限（stat 没跑成）"
    return 0
  fi
  read -r owner mode size <<<"$meta"
  if [[ "$owner" != "$u" ]]; then bad+="属主是 $owner（要 $u）；"; fi
  if [[ "$mode" != 600 ]]; then bad+="权限是 $mode（要 600）；"; fi
  if [[ "$size" == 0 ]]; then bad+="是空的；"; fi
  if [[ -n "$bad" ]]; then
    red "$u 的 Cursor 密钥 $f：${bad%；}（值没读）：$how"
  else
    ok "$u 的 Cursor 密钥放好了：$f 属 $u、600、$size 字节（值没读；Cursor 认不认由路由探针判）"
  fi
}

# 放一把：标准输入是密钥。以会话用户的身份核、写（cursor_key_put_script），换上了再照读回的判据核一遍。
# 没换成返回 1（原因那一句已经打在标准错误上，原来那份原样留着）
cursor_key_put() { # 用户 文件
  local u=$1 f=$2
  if ! cursor_key_as "$u" /bin/sh -c "$(cursor_key_put_script)" cursor-key-put "$f"; then
    red "$u 的 Cursor 密钥没换（原因见上一行；原来那份原样留着）"
    return 1
  fi
  changed "换上了 $u 的 Cursor 密钥 $f（值没打出来）"
  check_cursor_key "$u" "$f"
}

# 撤：以会话用户的身份删掉（先在 Cursor 后台撤掉那一把）。本来就不在也算撤好；删不掉判红
cursor_key_remove() { # 用户 文件
  local u=$1 f=$2
  if [[ ! -e "$f" && ! -L "$f" ]]; then
    ok "$u 的 Cursor 密钥本来就不在（$f）"
    return 0
  fi
  if ! cursor_key_as "$u" /bin/rm -f -- "$f" || [[ -e "$f" || -L "$f" ]]; then
    red "$u 的 Cursor 密钥 $f 没删掉"
    return 1
  fi
  changed "删了 $u 的 Cursor 密钥 $f"
}
