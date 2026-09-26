#!/usr/bin/env bash
# shellcheck disable=SC2034 # APP_CONFIG_*、APP_ENV_* 是给调用方和测试读写的
# 应用的本机配置（/etc/fleet-dao 下）里装机脚本还要管的几件事，和上线前后要读回的几样。要先 source common.sh。
# france.sh 用它装和读回；deploy/test/app-config.test.sh 拿临时文件喂它，验第二遍零改动、值不进输出、每种读不到都判红。
#   1. 读键和 systemd 同一种读法（env_parse）：engine.env、api.env 和几个随机密钥文件是单元的 EnvironmentFile，
#      服务里生效的值按 systemd 的读法算。装机脚本补键、填值、读回都照这一种读法，读回说的才是服务里生效的那个值。
#   2. 样例后来加的键：机器上的文件里一次都没出现过（生效的赋值、注释掉的赋值、光写了键，都算出现过）才照样例补上。
#      只补缺，已有的一概不动：这些文件之后归人改。要人定的键（APP_CONFIG_MUST_SET）不补，缺了读回判红。
#   3. api.env 的 FLEET_GITHUB_WEBHOOK_SECRET：要和 GitHub 上「引擎」App 设置里的 Webhook secret 一致（App 级 webhook
#      挂在引擎机器人上），值就在 /etc/fleet-dao/github/ 引擎那份 json 的 webhook_secret 里。api.env 里为空才填；
#      json 里没有、或者值的样子写不进环境文件，就记待配，不瞎填（瞎填的值和 App 的对不上，webhook 签名全部验不过）。
#   4. 读回：卫生检查的已知敏感值名单 sensitive-values.txt（手放）、引擎的 engine.env、上线后要退役的垫片。
# 读不到（不在、读不了）、认不出（引号到文件末尾都没配上）一律判红、返回 1、文件不动，不当成「没有这个键」往下改。
# check_* 是读回用的：判红返回 1（红已经记进 REDS，france.sh 的读回照样往下查），待配、通过返回 0。
# 值一律不打印、不上命令行（/proc 里别的用户看得到命令行）：只在 bash 变量里过手，经 put_file 写文件。

APP_CONFIG_OWNER=root:fleet   # 测试时换成 root:root（测试机上没有 fleet 组）
APP_CONFIG_NODE=/usr/bin/node # 读 json 用的 node（france.sh 的前提里查过）；测试机上可能在别处
APP_CONFIG_WHY=""             # 最近一次读不到、认不出、取不到值的原因
# 要人定的键：样例里有也不补（补上就等于替人选了），缺了读回判红。FLEET_ENGINE_PORTS 决定引擎碰不碰真仓、真会话
APP_CONFIG_MUST_SET=(FLEET_ENGINE_PORTS)

# env_parse 的结果：生效的赋值按出现顺序（同一个键写几次就几条）；出现过但不生效的键名（注释掉的赋值、光写了键）
APP_ENV_KEYS=()
APP_ENV_VALUES=()
APP_ENV_MENTIONED=()
# env_get 的结果：生效的值（最后一次赋值）、赋了几次
APP_ENV_VALUE=""
APP_ENV_COUNT=0

# 和 systemd 同一种读法读一个环境文件：照搬 systemd 255 的 src/basic/env-file.c（parse_env_file_internal）。
#   行首空白跳过；# 或 ; 开头的行是注释；没有 = 的行不算；= 前面是键，去掉尾部空白；值去掉开头的空白；
#   不带引号的值去掉尾部空白，反斜杠留下后一个字符（行尾的反斜杠接下一行）；'…' 里原样；"…" 里 \" \\ \` \$ 去掉反斜杠，
#   别的反斜杠照留；引号可以跨行，引号前后的几段拼成一个值；同一个键写几次，生效的是最后一次；键名不合法的整条不算。
# 读不到回 1（APP_CONFIG_WHY 写明）；引号到文件末尾都没配上、最后一行以反斜杠结尾也回 1：前者 systemd 会把后面整个
# 文件都算进这个值，后者往文件末尾补的内容会被接进这个值，都不是人要的样子。
env_parse() { # 文件
  local file=$1 content c state=PRE_KEY key="" value="" comment="" i len kws=-1 vws=-1
  local ws=$' \t\n\r' nl=$'\n\r' commented='^[#;[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*='
  # 按字节走：只认 ASCII 的分隔符，值里的中文原样搬；多字节的语言环境下取第 i 个字符要从头数，也慢
  local LC_ALL=C
  APP_ENV_KEYS=()
  APP_ENV_VALUES=()
  APP_ENV_MENTIONED=()
  APP_CONFIG_WHY=""
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    APP_CONFIG_WHY="没有 $file"
    return 1
  fi
  if [[ ! -f "$file" || ! -r "$file" ]] || ! { content=$(<"$file"); } 2>/dev/null; then
    APP_CONFIG_WHY="读不了 $file"
    return 1
  fi
  len=${#content}
  for ((i = 0; i < len; i++)); do
    c=${content:i:1}
    case $state in
    PRE_KEY)
      if [[ $c == '#' || $c == ';' ]]; then
        state=COMMENT comment=""
      elif [[ $ws != *"$c"* ]]; then
        state=KEY key=$c kws=-1
      fi
      ;;
    KEY)
      if [[ $nl == *"$c"* ]]; then
        _env_bare "$key" "$kws"
        state=PRE_KEY
      elif [[ $c == '=' ]]; then
        state=PRE_VALUE value="" vws=-1
      else
        # kws：键里从哪一格起是尾部空白（-1 = 没有）；中间的空白照留，那样的键名不合法，整条不算
        if [[ $ws != *"$c"* ]]; then
          kws=-1
        elif ((kws < 0)); then
          kws=${#key}
        fi
        key+=$c
      fi
      ;;
    PRE_VALUE)
      if [[ $nl == *"$c"* ]]; then
        _env_push "$key" "$kws" "$value"
        state=PRE_KEY
      elif [[ $c == "'" ]]; then
        state=SINGLE_QUOTE
      elif [[ $c == '"' ]]; then
        state=DOUBLE_QUOTE
      elif [[ $c == "\\" ]]; then
        state=VALUE_ESCAPE
      elif [[ $ws != *"$c"* ]]; then
        state=VALUE value+=$c
      fi
      ;;
    VALUE)
      if [[ $nl == *"$c"* ]]; then
        ((vws < 0)) || value=${value:0:vws}
        _env_push "$key" "$kws" "$value"
        state=PRE_KEY
      elif [[ $c == "\\" ]]; then
        state=VALUE_ESCAPE vws=-1
      else
        if [[ $ws != *"$c"* ]]; then
          vws=-1
        elif ((vws < 0)); then
          vws=${#value}
        fi
        value+=$c
      fi
      ;;
    VALUE_ESCAPE)
      state=VALUE
      [[ $nl == *"$c"* ]] || value+=$c
      ;;
    SINGLE_QUOTE)
      if [[ $c == "'" ]]; then state=PRE_VALUE; else value+=$c; fi
      ;;
    DOUBLE_QUOTE)
      if [[ $c == '"' ]]; then
        state=PRE_VALUE
      elif [[ $c == "\\" ]]; then
        state=DOUBLE_QUOTE_ESCAPE
      else
        value+=$c
      fi
      ;;
    DOUBLE_QUOTE_ESCAPE)
      state=DOUBLE_QUOTE
      if [[ $c == '"' || $c == "\\" || $c == '`' || $c == '$' ]]; then
        value+=$c
      elif [[ $c != $'\n' ]]; then
        value+="\\$c"
      fi
      ;;
    COMMENT)
      # systemd 254 起注释行末尾的反斜杠不再接下一行：注释一律到行尾为止
      if [[ $nl == *"$c"* ]]; then
        if [[ $comment =~ $commented ]]; then APP_ENV_MENTIONED+=("${BASH_REMATCH[1]}"); fi
        state=PRE_KEY
      else
        comment+=$c
      fi
      ;;
    esac
  done
  ((kws < 0)) || key=${key:0:kws}
  case $state in
  KEY) _env_bare "$key" -1 ;;
  PRE_VALUE) _env_push "$key" -1 "$value" ;;
  VALUE)
    ((vws < 0)) || value=${value:0:vws}
    _env_push "$key" -1 "$value"
    ;;
  VALUE_ESCAPE)
    APP_CONFIG_WHY="$file 的最后一行（$key）以反斜杠结尾、要接下一行：往文件末尾补的内容会被接进它的值，认不出该怎么改"
    return 1
    ;;
  SINGLE_QUOTE | DOUBLE_QUOTE | DOUBLE_QUOTE_ESCAPE)
    APP_CONFIG_WHY="$file 里 $key 的引号到文件末尾都没配上（systemd 会把后面整个文件都算进它的值），认不出"
    return 1
    ;;
  COMMENT)
    if [[ $comment =~ $commented ]]; then APP_ENV_MENTIONED+=("${BASH_REMATCH[1]}"); fi
    ;;
  esac
  return 0
}

# env_parse 用：收一条生效的赋值。键去掉尾部空白（第二个参数是尾部空白的起点，-1 = 没有）；键名不合法的整条不算
# （systemd 起服务前也会把它丢掉）
_env_push() { # 键 尾部空白的起点 值
  local key=$1
  (($2 < 0)) || key=${key:0:$2}
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 0
  APP_ENV_KEYS+=("$key")
  APP_ENV_VALUES+=("$3")
}

# env_parse 用：光写了键、没写 = 的行。systemd 不算它，补键时算出现过（人写了点什么，不在后面再补一行）
_env_bare() { # 键 尾部空白的起点
  local key=$1
  (($2 < 0)) || key=${key:0:$2}
  if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then APP_ENV_MENTIONED+=("$key"); fi
  return 0
}

# 取一个键（先 env_parse）：APP_ENV_VALUE 是服务里生效的值（最后一次赋值），APP_ENV_COUNT 是赋了几次。
# 返回 0 有；1 一次都没赋值；2 读不到或认不出（原因在 APP_CONFIG_WHY）。三种调用方都要分开处理
env_get() { # 文件 键
  local i
  APP_ENV_VALUE=""
  APP_ENV_COUNT=0
  env_parse "$1" || return 2
  for i in "${!APP_ENV_KEYS[@]}"; do
    [[ "${APP_ENV_KEYS[i]}" == "$2" ]] || continue
    APP_ENV_VALUE=${APP_ENV_VALUES[i]}
    APP_ENV_COUNT=$((APP_ENV_COUNT + 1))
  done
  ((APP_ENV_COUNT > 0)) || return 1
}

# 只要生效的值（打印到标准输出，只给调用方收进变量）。返回码同 env_get
env_value() { # 文件 键
  local rc=0
  env_get "$1" "$2" || rc=$?
  if ((rc != 0)); then return "$rc"; fi
  printf '%s' "$APP_ENV_VALUE"
}

# 上一次 env_parse 的文件里这个键出现过没有：生效的赋值、注释掉的赋值、光写了键，都算
env_mentioned() { # 键
  local k
  for k in "${APP_ENV_KEYS[@]}" "${APP_ENV_MENTIONED[@]}"; do
    if [[ "$k" == "$1" ]]; then return 0; fi
  done
  return 1
}

app_config_must_set() { # 键
  local k
  for k in "${APP_CONFIG_MUST_SET[@]}"; do
    if [[ "$k" == "$1" ]]; then return 0; fi
  done
  return 1
}

# 第一次照样例建环境文件时用的内容：要人定的键（APP_CONFIG_MUST_SET）那一行改成注释，不替人选——样例里的
# FLEET_ENGINE_PORTS=real 原样抄过去，就等于没人确认就让引擎碰真仓、真会话。注释掉以后补键不会补回来（算出现过），
# 读回判红，等人放开。样例读不到回 1（APP_CONFIG_WHY 写明），调用方不建文件
example_for_new_file() { # 样例
  local example=$1 content line k out="" re
  APP_CONFIG_WHY=""
  if [[ ! -f "$example" ]] || ! { content=$(<"$example"); } 2>/dev/null; then
    APP_CONFIG_WHY="读不了样例 $example"
    return 1
  fi
  while IFS= read -r line; do
    for k in "${APP_CONFIG_MUST_SET[@]}"; do
      re="^[[:space:]]*${k}[[:space:]]*="
      if [[ "$line" =~ $re ]]; then
        line="# $line    # 要人定，装机脚本不替人选：放开这一行再发布"
        break
      fi
    done
    out+="$line"$'\n'
  done <<<"$content"
  printf '%s' "${out%$'\n'}"
}

# 样例里有、文件里一次都没出现过的键，照样例（连同样例给的值）补在文件末尾，前面加一行说明是哪几个。要人定的键不补。
# 第二遍零改动。文件、样例读不到或认不出：判红、返回 1、文件不动（不当成「一个键都没有」把样例整份补进去）
add_missing_keys() { # 文件 样例
  local file=$1 example=$2 line key content ex n=0 added=() lines=()
  if ! env_parse "$file"; then
    red "补不了样例后来加的键：$APP_CONFIG_WHY（文件不动）"
    return 1
  fi
  if ! { content=$(<"$file"); } 2>/dev/null; then
    red "补不了样例后来加的键：读不了 $file（文件不动）"
    return 1
  fi
  if [[ ! -f "$example" || ! -r "$example" ]] || ! { ex=$(<"$example"); } 2>/dev/null; then
    red "补不了样例后来加的键：读不了样例 $example（$file 不动）"
    return 1
  fi
  while IFS= read -r line; do
    n=$((n + 1))
    if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
      red "样例 $example 第 $n 行认不出（样例里只写注释和 KEY=值）：$file 不动"
      return 1
    fi
    key=${BASH_REMATCH[1]}
    if app_config_must_set "$key" || env_mentioned "$key"; then continue; fi
    lines+=("$line")
    added+=("$key")
  done <<<"$ex"
  if ((${#added[@]} == 0)); then return 0; fi
  content+=$'\n'"# deploy/france.sh 照新版样例补的（样例后来加的键，值是样例给的，要改就在这里改）：${added[*]}"
  for line in "${lines[@]}"; do content+=$'\n'"$line"; done
  put_file "$file" "$APP_CONFIG_OWNER" 640 "$content"
  changed "$file 照新版样例补上 ${#added[@]} 个键：${added[*]}（值不打印）"
}

# 从 GitHub App 的 json 取 webhook_secret（打印到标准输出，只给调用方收进变量）。取不到、样子不对回 1，原因在 APP_CONFIG_WHY。
# 只拒绝写进环境文件会变样的字符：空白、控制字符（行尾的空白被去掉、换行断成两行）、引号、反斜杠（systemd 当引号和转义处理）、
# $ 和反引号（防着被当成展开）、非 ASCII；+ / = 这类照原样读回，照收（GitHub 的 webhook secret 允许任意字符）
app_webhook_secret() { # json
  local out rc=0
  APP_CONFIG_WHY=""
  if [[ ! -f "$1" ]]; then
    APP_CONFIG_WHY="没有 $1"
    return 1
  fi
  out=$("$APP_CONFIG_NODE" -e '
    let j;
    try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
    const s = j && typeof j === "object" ? j.webhook_secret : undefined;
    if (typeof s !== "string" || s === "") process.exit(4);
    if (s.length < 16 || s.length > 200 || !/^[!#%&(-\[\]-_a-~]+$/.test(s)) process.exit(5);
    process.stdout.write(s);' "$1" 2>/dev/null) || rc=$?
  case $rc in
  0)
    printf '%s' "$out"
    return 0
    ;;
  3) APP_CONFIG_WHY="$1 不是 JSON" ;;
  4) APP_CONFIG_WHY="$1 里没有 webhook_secret" ;;
  5) APP_CONFIG_WHY="$1 里的 webhook_secret 样子不对（要 16 到 200 个可见的 ASCII 字符，不能有空白、引号、反斜杠、$、反引号），写进环境文件会变样" ;;
  *) APP_CONFIG_WHY="读不了 $1（退出码 $rc）" ;;
  esac
  return 1
}

# api.env 里 FLEET_GITHUB_WEBHOOK_SECRET 生效的值为空（或一次都没出现过）才按引擎 App 的 json 填；已有值的不动（人改过的算数）。
# api.env 读不到、认不出、这个键写了几行：判红、返回 1、文件不动（不新建一份只有密钥的 api.env，也不猜该改哪一行）。
# 被注释掉了：记待配，不替人放开
fill_webhook_secret() { # api.env 引擎App的json
  local file=$1 json=$2 key=FLEET_GITHUB_WEBHOOK_SECRET secret line content out="" rc=0 hits=0 want re
  env_get "$file" "$key" || rc=$?
  if ((rc == 2)); then
    red "填不了 webhook 密钥：$APP_CONFIG_WHY（不新建、不改）"
    return 1
  fi
  if ((APP_ENV_COUNT > 1)); then
    red "$file 里 $key 写了 $APP_ENV_COUNT 行（服务里生效的是最后一行）：先删成一行再跑，装机脚本不猜该留哪一行"
    return 1
  fi
  if [[ -n "$APP_ENV_VALUE" ]]; then return 0; fi
  if ((rc == 1)) && env_mentioned "$key"; then
    pending "$file 里的 $key 被注释掉了：装机脚本不替人放开（后端缺它起不来）"
    return 0
  fi
  if ! secret=$(app_webhook_secret "$json"); then
    pending "$file 的 $key 是空的，也没法照「引擎」App 填：$APP_CONFIG_WHY。到 GitHub 上「引擎」App 的设置页看 Webhook secret，填进 $json 的 webhook_secret（或直接填进 $file），再跑一遍"
    return 0
  fi
  if ! { content=$(<"$file"); } 2>/dev/null; then
    red "填不了 webhook 密钥：读不了 $file（不改）"
    return 1
  fi
  # 要换的是那一行生效的空赋值（有就恰好一行）；没有就补在末尾
  want=$((rc == 0 ? 1 : 0))
  re="^[[:space:]]*${key}[[:space:]]*="
  while IFS= read -r line; do
    if [[ "$line" =~ $re ]]; then
      hits=$((hits + 1))
      out+="$key=$secret"$'\n'
    else
      out+="$line"$'\n'
    fi
  done <<<"$content"
  if ((hits != want)); then
    red "$file 里 $key 那一行认不出（按行找到 $hits 行，按 systemd 的读法是 $want 行）：不改，删成一行 $key= 再跑"
    return 1
  fi
  if ((hits == 0)); then out+="$key=$secret"$'\n'; fi
  put_file "$file" "$APP_CONFIG_OWNER" 640 "${out%$'\n'}"
  changed "$file 的 $key 照「引擎」App 的 webhook_secret 填上了（值不打印）"
}

# 读回：两边一致才算好。只比，不打印
check_webhook_secret() { # api.env 引擎App的json
  local file=$1 json=$2 key=FLEET_GITHUB_WEBHOOK_SECRET cur secret rc=0
  env_get "$file" "$key" || rc=$?
  if ((rc == 2)); then
    red "核对不了 webhook 密钥：$APP_CONFIG_WHY"
    return 1
  fi
  if ((APP_ENV_COUNT > 1)); then
    red "$file 里 $key 写了 $APP_ENV_COUNT 行：服务里生效的是最后一行，先删成一行（值不打印）"
    return 1
  fi
  cur=$APP_ENV_VALUE
  if ! secret=$(app_webhook_secret "$json"); then
    if [[ -n "$cur" ]]; then
      pending "$file 里填了 $key，但核对不了是不是和「引擎」App 的一致：$APP_CONFIG_WHY"
    else
      pending "$file 的 $key 是空的：$APP_CONFIG_WHY（后端缺它起不来）"
    fi
    return 0
  fi
  if [[ -z "$cur" ]]; then
    red "$file 的 $key 是空的（后端缺它起不来）：跑一遍 france.sh 会照「引擎」App 填上"
    return 1
  fi
  if [[ "$cur" != "$secret" ]]; then
    red "$file 的 $key 和「引擎」App（$json）的 webhook_secret 不一致：GitHub 发来的事件签名会全部验不过。以 App 设置页为准改其中一边"
    return 1
  fi
  ok "api.env 的 $key 和「引擎」App 的 webhook_secret 一致（值不打印）"
}

# 读回：服务读的环境文件（单元的 EnvironmentFile，服务以 fleet 跑）要 root:fleet 640。组读不到，root 读回照样通过、
# 服务却起不来；别人读得到就漏了密钥。不在、是符号链接、读不了属主权限，一律判红。只看属主权限，不读内容
check_app_file_meta() { # 文件…
  local f meta bad=0
  for f in "$@"; do
    if [[ -L "$f" || ! -f "$f" ]]; then
      red "$f 不在或不是普通文件：服务读不到它就起不来"
      bad=1
      continue
    fi
    if ! meta=$(stat -c '%U:%G %a' -- "$f" 2>/dev/null); then
      red "读不了 $f 的属主权限"
      bad=1
      continue
    fi
    if [[ "$meta" != "$APP_CONFIG_OWNER 640" ]]; then
      red "$f 是「$meta」，要 $APP_CONFIG_OWNER 640：组读不到服务起不来，别人读得到就漏了密钥（跑一遍 france.sh 改回来）"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "应用的 $# 个环境文件都是 $APP_CONFIG_OWNER 640"; fi
  ((bad == 0))
}

# 读回：同一个键写了几行判红，对整份文件的每一个生效的键（不只几个挑出来的）：服务里生效的是最后一行，人改了前一行
# 以为改好了，其实没生效。按 systemd 的读法（env_parse）数；读不到、认不出也判红。只报键名，不打印值
check_env_duplicates() { # 文件…
  local f k bad=0 dups
  local -A seen
  for f in "$@"; do
    if ! env_parse "$f"; then
      red "查不了 $f 里有没有写了几行的键：$APP_CONFIG_WHY"
      bad=1
      continue
    fi
    seen=()
    dups=""
    for k in "${APP_ENV_KEYS[@]}"; do
      seen[$k]=$((${seen[$k]:-0} + 1))
      if ((${seen[$k]} == 2)); then dups+=" $k"; fi
    done
    if [[ -n "$dups" ]]; then
      red "$f 里这些键写了不止一行（服务里生效的是最后一行）：${dups# }。删成一行"
      bad=1
    fi
  done
  if ((bad == 0)); then ok "$# 份环境文件里没有写了几行的键"; fi
  ((bad == 0))
}

# 读回：卫生检查的已知敏感值名单（真实的组织编号、账号，一行一个，手放）。引擎推分支、写需求文档、开 PR 之前都读它，
# 缺了、空的一律不推不写（packages/hygiene）：没有、空的记待配；属主权限不对、读不了判红（里面是真值）。只看，不打印内容
check_sensitive_values() { # 名单文件
  local file=$1 meta line has=0
  if [[ ! -e "$file" ]]; then
    pending "没有 $file（已知敏感值名单，手放，root:fleet 640）：引擎推分支、写需求文档、开 PR 之前都读它，缺了一律不推不写"
    return 0
  fi
  meta=$(stat -c '%U:%G %a' -- "$file" 2>/dev/null) || meta="读不了"
  if [[ "$meta" != "$APP_CONFIG_OWNER 640" ]]; then
    red "$file 的属主权限是「$meta」，要 $APP_CONFIG_OWNER 640（里面是真实的组织编号、账号）"
    return 1
  fi
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    red "$file 读不了"
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ -n "$line" && "$line" != \#* ]]; then
      has=1
      break
    fi
  done <"$file"
  if ((has == 0)); then
    pending "$file 里一个值都没有（只有空行、注释）：卫生检查按「名单没读到」处理，一律不推不写"
    return 0
  fi
  ok "已知敏感值名单 $file 在、$APP_CONFIG_OWNER 640、有值（内容不打印）"
}

# 读回引擎的 engine.env（fleet-engine.service 的 EnvironmentFile），按 systemd 的读法：
#   FLEET_ENGINE_PORTS 要人定（real / fake；缺了引擎起不来，装机脚本不补）；
#   下面三个键要钉在约定的值上，补键只补缺、不改已有的，所以旧值（比如 FLEET_WORK_DIR=/tmp）只有读回拦得住：
#   FLEET_SENSITIVE_VALUES_FILE 要钉在读回核的那份名单上：不钉的话引擎按 packages/hygiene 的顺序先找 fleet 家里的
#   ~/.fleet-dao/sensitive-values.txt，那里有一份就悄悄换成那份；
#   FLEET_WORK_DIR 要是 fleet-agent-scope 认的工作树的根（它只认这一个，引擎算到别处建树、交树都会被拒）；
#   FLEET_ENGINE_STATE_DIR 要是 france.sh 建好、属 fleet 的那个目录。
# 文件读不到、认不出，和键没写、写了几行、值不认识，各报各的
check_engine_env() { # engine.env 名单文件 工作树的根 引擎状态目录
  local file=$1 list=$2 work=$3 state=$4 rc=0 bad=0
  env_get "$file" FLEET_ENGINE_PORTS || rc=$?
  if ((rc == 2)); then
    red "核对不了引擎的配置：$APP_CONFIG_WHY"
    return 1
  fi
  if ((rc == 1)); then
    red "$file 里没有生效的 FLEET_ENGINE_PORTS（没写，或被注释掉了）：引擎起不来。这一项装机脚本不替人定，写 real（真仓、真会话）或 fake（假实现）"
    bad=1
  elif ((APP_ENV_COUNT > 1)); then
    red "$file 里 FLEET_ENGINE_PORTS 写了 $APP_ENV_COUNT 行（服务里生效的是最后一行「$APP_ENV_VALUE」）：删成一行"
    bad=1
  else
    case $APP_ENV_VALUE in
    real) ok "engine.env：引擎用真端口（FLEET_ENGINE_PORTS=real）" ;;
    fake) pending "engine.env 的 FLEET_ENGINE_PORTS=fake：引擎用的是假实现（不碰真仓、真会话），接真活前改成 real、再发布一次" ;;
    *)
      red "engine.env 的 FLEET_ENGINE_PORTS 是「$APP_ENV_VALUE」：只认 real 或 fake，引擎起不来"
      bad=1
      ;;
    esac
  fi
  pin_engine_key "$file" FLEET_SENSITIVE_VALUES_FILE "$list" "卫生检查的名单" || bad=1
  pin_engine_key "$file" FLEET_WORK_DIR "$work" "AI 会话的工作树的根（fleet-agent-scope 只认这一个）" || bad=1
  pin_engine_key "$file" FLEET_ENGINE_STATE_DIR "$state" "引擎状态目录" || bad=1
  ((bad == 0))
}

# engine.env 里一个要钉在约定值上的键：等于约定值通过；没写、被注释掉记待配（没写时 france.sh 照样例补）；
# 写了几行、值不对判红、返回 1。文件读不到、认不出也判红（调用方前面已经读过一次，这里照样不装没事）
pin_engine_key() { # engine.env 键 约定值 是什么
  local file=$1 key=$2 want=$3 what=$4 rc=0
  env_get "$file" "$key" || rc=$?
  if ((rc == 2)); then
    red "核对不了引擎的配置：$APP_CONFIG_WHY"
    return 1
  fi
  if ((rc == 1)); then
    if env_mentioned "$key"; then
      pending "$file 里的 $key 被注释掉了（$what 要是 $want）：放开那一行"
    else
      pending "$file 没写 $key（$what 要是 $want）：跑一遍 france.sh 会照样例补上"
    fi
    return 0
  fi
  if ((APP_ENV_COUNT > 1)); then
    red "$file 里 $key 写了 $APP_ENV_COUNT 行（服务里生效的是最后一行）：删成一行"
    return 1
  fi
  if [[ "$APP_ENV_VALUE" != "$want" ]]; then
    red "$file 的 $key 是「$APP_ENV_VALUE」，约定是 $want（$what）：引擎用的和机器上建好的不是同一处，改成 $want 再发布"
    return 1
  fi
  ok "engine.env：$what钉在 $want"
}

# 读回：上线后要退役的垫片还在不在。在就记待配（等引擎接真活以后删），不在就通过
check_retired() { # 路径 是什么
  if [[ -e "$1" || -L "$1" ]]; then
    pending "$2还在（$1）：引擎接真活以后删掉"
  else
    ok "$2已经退役（没有 $1）"
  fi
}
