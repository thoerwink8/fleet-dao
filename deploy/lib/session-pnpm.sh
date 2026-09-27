#!/usr/bin/env bash
# shellcheck disable=SC2034 # SESSION_PATH*、SESSION_PNPM_* 是给调用方读的
# AI 会话用的 pnpm（#164 法国复测查出的断链）。会话交活要原样跑过仓的测试命令（fleet-dao 是 `pnpm test:changed`；
# 交活核对只认命令开头就是它，packages/adapters 的 invokesTestCommand，绕成 `corepack pnpm …` 不算），可引擎给会话的
# PATH 里原来没有 pnpm：只有 fleet 家里有一份 corepack 垫片，会话读不到。这里装仓根 package.json 的 packageManager
# 钉的那一版：从 npm 下 pnpm-<版本>.tgz、核 france.sh 顶部钉的 sha512（npm 的 dist.integrity 写法），解到 <目录>/<版本>，
# 入口是一个小脚本（法国 /usr/local/bin/pnpm）。都归 root：会话改不动，也不在会话第一次用时现下。
# 不用 corepack 给会话装：它按调用者的家目录缓存、第一次用时才下，缓存落在会话自己家里、会话写得动。
# france.sh 和 deploy/test/session-pnpm.test.sh 共用；要先 source common.sh（ok、changed、red、put_file、ensure_dir）。

SESSION_PNPM_NODE=/usr/bin/node # 入口用哪个 node（和 france.sh 别处一样用系统的）；测试换成这台的
SESSION_PNPM_TIMEOUT=30         # 跑一次 pnpm --version 最多等几秒，不理叫停的再过 5 秒强杀；测试里调小
SESSION_PROC=/proc              # 读引擎进程的环境和启动命令；测试换成造好的目录

SESSION_PATH=""      # engine_session_path 读到的会话 PATH
SESSION_PATH_WHY=""  # 没读成的原因
SESSION_PNPM_AT=""   # session_pnpm_probe：按那条 PATH 找到的 pnpm 是哪个文件
SESSION_PNPM_HAVE="" # 它报的版本
SESSION_PNPM_WHY=""  # 没查成的原因

# 包里 package.json 的名字、版本、pnpm 命令的入口（相对包根），一行一个。读不了、认不出返回 1
session_pnpm_fields() { # package.json
  "$SESSION_PNPM_NODE" -e '
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const bin = typeof p.bin === "string" ? p.bin : p.bin && p.bin.pnpm;
    if (typeof p.name !== "string" || typeof p.version !== "string" || typeof bin !== "string") process.exit(1);
    process.stdout.write([p.name, p.version, bin.replace(/^[.][/]/, "")].join("\n") + "\n");' "$1" 2>/dev/null
}

# 装着的这一版还是装的时候的样子：记下的校验和就是钉的这一个，每个文件和装完时记的一样（.sha256）。是返回 0
session_pnpm_intact() { # 目录 sha512
  [[ -d "$1" && ! -L "$1" && -f "$1/.sha256" && -f "$1/.integrity" && -f "$1/.entry" ]] || return 1
  [[ "$(<"$1/.integrity")" == "$2" ]] || return 1
  (cd -- "$1" && sha256sum --quiet --status -c .sha256) 2>/dev/null
}

# 入口脚本的正文
session_pnpm_wrapper() { # 版本 目录 入口（相对包根）
  printf '%s\n' '#!/bin/sh' \
    "# deploy/france.sh 装的：AI 会话用的 pnpm $1（仓根 package.json 的 packageManager 钉的那一版），包在 $2，归 root、" \
    '# 会话改不动（deploy/lib/session-pnpm.sh）。别在机器上手改：改仓里的，再跑 france.sh。' \
    '# 关掉 node 的编译缓存：pnpm 启动时会打开它，默认放在大家共用的 /tmp/node-compile-cache 下，谁先建这个目录谁占着，' \
    '# 别的身份（root、fleet）那一格他也能先造好、往里放东西，下一个以那个身份跑 pnpm 的就会读进来。' \
    'NODE_DISABLE_COMPILE_CACHE=1' \
    'export NODE_DISABLE_COMPILE_CACHE' \
    "exec \"$SESSION_PNPM_NODE\" \"$2/$3\" \"\$@\""
}

# 装：<目录>/<版本> 和装的时候一样就不动；否则下 <下载地址>、核 sha512、解开、核包名和版本，整个目录换上（旧的收掉）。
# 再写入口。这一次动了手，就照 <跑法…> 以别的身份跑一次入口核版本（跑法同 session_pnpm_probe）。
# 外部代码装上机器就进了信任面：下载、校验、解包、核对哪一步不对都判红、返回 1，不装半个。
ensure_session_pnpm() { # 版本 sha512 下载地址 装到哪（目录） 入口 核对的跑法…
  local ver=$1 integrity=$2 url=$3 root=$4 bin=$5 dir tmp digest entry wrote=0
  local -a f=()
  shift 5
  dir=$root/$ver
  if [[ ! "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    red "要装的 pnpm 版本认不出：「$ver」"
    return 1
  fi
  if [[ ! "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]]; then
    red "pnpm $ver 的校验和不是 npm integrity 的写法（sha512-…）：「$integrity」"
    return 1
  fi
  ensure_dir "$root" root:root 755
  if ! session_pnpm_intact "$dir" "$integrity"; then
    tmp=$(mktemp -d "$root/.fleet-dao-new.XXXXXX")
    if ! curl -fsSL --retry 3 --max-time 300 -o "$tmp/pkg.tgz" "$url"; then
      rm -rf -- "$tmp"
      red "下载失败：$url"
      return 1
    fi
    if ! digest=$(openssl dgst -sha512 -binary <"$tmp/pkg.tgz" | base64 -w0) || [[ "sha512-$digest" != "$integrity" ]]; then
      rm -rf -- "$tmp"
      red "sha512 对不上，不装：$url"
      return 1
    fi
    if ! tar -xzf "$tmp/pkg.tgz" -C "$tmp" --no-same-owner --no-same-permissions package 2>/dev/null ||
      ! mapfile -t f < <(session_pnpm_fields "$tmp/package/package.json") || ((${#f[@]} != 3)); then
      rm -rf -- "$tmp"
      red "解不开 $url，或包里的 package.json 认不出（要有 name、version、bin.pnpm）"
      return 1
    fi
    entry=${f[2]}
    if [[ "${f[0]}" != pnpm || "${f[1]}" != "$ver" ]]; then
      rm -rf -- "$tmp"
      red "$url 里的包是「${f[0]}@${f[1]}」，要的是 pnpm@$ver，不装"
      return 1
    fi
    if [[ ! "$entry" =~ ^[A-Za-z0-9._/-]+$ || "/$entry/" == */../* || ! -f "$tmp/package/$entry" ]]; then
      rm -rf -- "$tmp"
      red "pnpm $ver 包里的入口认不出或不在：「$entry」"
      return 1
    fi
    printf '%s\n' "$integrity" >"$tmp/package/.integrity"
    printf '%s\n' "$entry" >"$tmp/package/.entry"
    chown -R root:root -- "$tmp/package"
    chmod -R u=rwX,go=rX -- "$tmp/package"
    if ! (cd -- "$tmp/package" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >"$tmp/sha256"); then
      rm -rf -- "$tmp"
      red "给 pnpm $ver 的文件记校验和没成"
      return 1
    fi
    mv -- "$tmp/sha256" "$tmp/package/.sha256"
    chmod 644 -- "$tmp/package/.sha256"
    # 先把旧的挪开、再换上新的：两次改名之间入口指的目录不在的空当只有一瞬
    if [[ -e "$dir" || -L "$dir" ]]; then mv -- "$dir" "$tmp/old"; fi
    mv -- "$tmp/package" "$dir"
    rm -rf -- "$tmp"
    changed "装 pnpm $ver（sha512 已核对）到 $dir"
    wrote=1
  fi
  put_file "$bin" root:root 755 "$(session_pnpm_wrapper "$ver" "$dir" "$(<"$dir/.entry")")"
  # shellcheck disable=SC2153 # WROTE 是 common.sh 的 put_file 设的（动了手为 1）
  if ((WROTE)); then wrote=1; fi
  if ((wrote == 0)); then
    ok "pnpm $ver 已装（$dir，入口 $bin）"
    return 0
  fi
  if ! session_pnpm_probe "$bin" "$@"; then
    red "装完 $bin 跑不起来：$SESSION_PNPM_WHY"
    return 1
  fi
  if [[ "$SESSION_PNPM_HAVE" != "$ver" ]]; then
    red "装完 $bin 报的版本是 $SESSION_PNPM_HAVE，应为 $ver"
    return 1
  fi
}

# 引擎给会话的 PATH（packages/engine 起会话时拼的，docs/ops.md 第五节）：
#   fleet 命令的目录（engine.env 的 FLEET_CLI_BIN；没写就是引擎这一版代码里的 packages/cli/bin，worker.ts 的
#   DEFAULT_CLI_BIN_DIR，按 worker.ts 自己的真实位置算）+ 引擎进程自己的 PATH（fleet-engine.service 没设，就是 systemd 给
#   服务的默认 PATH）。两段中间用 : 接，空的那段不要（packages/adapters 的 buildSessionEnv 的 pathPrepend）。
# 起会话时它改名 FLEET_SESSION_PATH 交给 fleet-agent-scope，帮手脚本再在最后接上会话用户家里的 ~/.local/bin。
# 从在跑的引擎进程里读（只取 PATH、FLEET_CLI_BIN 两项，别的不碰、不打印），读到的就是引擎真在用的，不是照着代码推的。
# 读成了返回 0、放进 SESSION_PATH；主进程号不对、进程没了、启动命令认不出返回 1，原因进 SESSION_PATH_WHY。
engine_session_path() { # 引擎主进程号
  local pid=$1 e path="" cli="" arg main="" code
  local -a envs=() argv=()
  SESSION_PATH=""
  SESSION_PATH_WHY=""
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    SESSION_PATH_WHY="引擎没在跑（fleet-engine 的主进程号读到「${pid:-空}」），读不到它给会话的 PATH"
    return 1
  fi
  if ! mapfile -d '' -t envs 2>/dev/null <"$SESSION_PROC/$pid/environ"; then
    SESSION_PATH_WHY="读不到引擎进程（$pid）的环境"
    return 1
  fi
  for e in "${envs[@]}"; do
    case $e in
    PATH=*) path=${e#PATH=} ;;
    FLEET_CLI_BIN=*) cli=${e#FLEET_CLI_BIN=} ;;
    esac
  done
  envs=()
  # 引擎读 FLEET_CLI_BIN 时去掉了两头的空白（configFromEnv），这里一样
  cli="${cli#"${cli%%[![:space:]]*}"}"
  cli="${cli%"${cli##*[![:space:]]}"}"
  if [[ -z "$cli" ]]; then
    if ! mapfile -d '' -t argv 2>/dev/null <"$SESSION_PROC/$pid/cmdline"; then
      SESSION_PATH_WHY="读不到引擎进程（$pid）的启动命令"
      return 1
    fi
    for arg in "${argv[@]:1}"; do
      if [[ "$arg" == /*/packages/engine/src/main.ts ]]; then
        main=$arg
        break
      fi
    done
    if [[ -z "$main" ]]; then
      SESSION_PATH_WHY="认不出引擎的启动命令（里面没有 …/packages/engine/src/main.ts）：「$(printf '%s ' "${argv[@]}" | cut -c1-160)」"
      return 1
    fi
    # node 按入口的真实路径算模块的位置（发布目录的 current 是链接）
    if ! code=$(readlink -e -- "$main") || [[ "$code" != /*/packages/engine/src/main.ts ]]; then
      SESSION_PATH_WHY="引擎的入口 $main 解不出真实路径（读到「${code:-空}」）"
      return 1
    fi
    cli=${code%/packages/engine/src/main.ts}/packages/cli/bin
  fi
  SESSION_PATH=$cli${path:+:$path}
}

# 以某个身份跑一次 pnpm --version，看找到的是哪个文件、报的哪一版。<pnpm> 写 pnpm 就按那个身份的 PATH 找，写绝对路径
# 就跑它；<跑法…> 是起这条命令的前缀（france.sh 的读回照引擎起会话那条路走，装完的核对以会话用户直接跑）。
# 读成了返回 0：SESSION_PNPM_AT、SESSION_PNPM_HAVE；找不到、跑不起来、卡住、输出认不出返回 1，原因进 SESSION_PNPM_WHY。
# 防卡照 cli-tools.sh 问 ddgs 的做法：输出落进 root 建的临时文件（不走管道：留个后台进程占着写端，管道就一直等）、
# setsid 不带控制终端、到 SESSION_PNPM_TIMEOUT 秒叫停，不理的再过 5 秒强杀。
session_pnpm_probe() { # pnpm 的写法 跑法…
  local pnpm=$1 out err rc=0 tail
  local -a got=()
  shift
  SESSION_PNPM_AT=""
  SESSION_PNPM_HAVE=""
  SESSION_PNPM_WHY=""
  if ! out=$(mktemp "${TMPDIR:-/var/tmp}/fleet-dao-pnpm-probe.XXXXXX" 2>/dev/null); then
    SESSION_PNPM_WHY="建不了放输出的临时文件（${TMPDIR:-/var/tmp}），没查成"
    return 1
  fi
  if ! err=$(mktemp "${TMPDIR:-/var/tmp}/fleet-dao-pnpm-probe.XXXXXX" 2>/dev/null); then
    rm -f -- "$out"
    SESSION_PNPM_WHY="建不了放输出的临时文件（${TMPDIR:-/var/tmp}），没查成"
    return 1
  fi
  # shellcheck disable=SC2016 # 单引号里的由那个身份的 sh 展开
  "$@" /usr/bin/setsid -w /usr/bin/timeout -k 5 "$SESSION_PNPM_TIMEOUT" /bin/sh -c \
    'p=$(command -v "$1") || exit 127; printf "%s\n" "$p"; exec "$p" --version' sh "$pnpm" \
    </dev/null >"$out" 2>"$err" || rc=$?
  mapfile -t got <"$out" || got=()
  tail=$(tail -3 -- "$err" | tr '\n' ' ') || tail=""
  tail=${tail% }
  rm -f -- "$out" "$err"
  if ((rc == 124 || rc == 137)); then
    SESSION_PNPM_WHY="pnpm --version 卡住，被 timeout 叫停（退出码 $rc：124＝到 $SESSION_PNPM_TIMEOUT 秒叫停，137＝不理叫停、再过 5 秒被强杀）"
    return 1
  fi
  if ((rc == 127 && ${#got[@]} == 0)); then
    SESSION_PNPM_WHY="PATH 上找不到 pnpm${tail:+（$tail）}"
    return 1
  fi
  if ((rc != 0)); then
    SESSION_PNPM_WHY="${got[0]:+找到 ${got[0]}，}跑 pnpm --version 退出 $rc${tail:+：$tail}"
    return 1
  fi
  if ((${#got[@]} != 2)) || [[ "${got[0]}" != /* || ! "${got[1]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SESSION_PNPM_WHY="pnpm --version 的输出认不出：「$(printf '%s / ' "${got[@]}" | cut -c1-160)」"
    return 1
  fi
  SESSION_PNPM_AT=${got[0]}
  SESSION_PNPM_HAVE=${got[1]}
}

# 读回：照 <跑法…> 起的那个身份按它的 PATH 找得到 pnpm、找到的就是装机装的那个入口、版本是钉的那一版。<说明> 写是哪条 PATH
check_session_pnpm() { # 版本 入口 说明 跑法…
  local want=$1 bin=$2 what=$3
  shift 3
  if ! session_pnpm_probe pnpm "$@"; then
    red "$what上跑不了 pnpm：$SESSION_PNPM_WHY（会话交活要原样跑 pnpm test:changed）"
  elif [[ "$SESSION_PNPM_AT" != "$bin" ]]; then
    red "$what上先找到的 pnpm 是 $SESSION_PNPM_AT，不是装机装的 $bin（归 root、会话改不动的那一份）"
  elif [[ "$SESSION_PNPM_HAVE" != "$want" ]]; then
    red "$what上的 pnpm 是 $SESSION_PNPM_HAVE，应为 $want（仓根 package.json 的 packageManager）"
  else
    ok "$what上找得到 pnpm：$bin，$want（和仓根 package.json 的 packageManager 一样）"
  fi
}
