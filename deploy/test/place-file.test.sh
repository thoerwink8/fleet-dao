#!/usr/bin/env bash
# shellcheck disable=SC2016 # 这里处理的是命令原文：$t、$(mktemp …) 要原样留着交给 sh -c，不能在这里展开
# docs/ops.md 第九节两条「放文件」的命令（飞书网关的通行证、目录配置）：那头收到的是空的、半截的、不像样的，原来那份原样留着，
# 临时名不留下；收到完整的才换上。命令从 docs/ops.md 里原样取出来（文档改了，这里跟着测；认不出就报没跑成），只换两处：
# /etc/fleet-dao 换成临时目录，chown root:fleet 换成 true（这台上没有 fleet 组，属主不是这里要测的）。管道左边换成桩：
# 解密失败就是左边失败、一个字节都不给（age 解不开时就是这样，本机实测过，见 specs/47-目录配置/结果.md）。
# 最后拿修之前的老写法当反例跑一遍：它会把好的那份换成空的，说明这里抓得到。
# 用法：bash deploy/test/place-file.test.sh。退出码：0 通过，1 不通过，2 有没跑成的。
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OPS=$HERE/../../docs/ops.md
EXAMPLE=$HERE/../examples/catalog.example.json
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
D=$TMP/etc # 换掉 /etc/fleet-dao
mkdir -p "$D"
fail=0
skipped=0
check() { # 说明 实际 期望
  if [[ "$2" == "$3" ]]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s：实际「%s」，应为「%s」\n' "$1" "$2" "$3"
    fail=1
  fi
}
if ! command -v node >/dev/null; then
  echo "  … 没跑成：这台没有 node（目录那条命令在那头用 node 核对 JSON）"
  echo "place-file：没跑成"
  exit 2
fi

# ops 里以 prefix 开头那一行（要恰好一行），取出那头要跑的命令：prefix 之后、行尾那个单引号之前
REMOTE=""
remote_of() { # 行的开头（到那头命令的左单引号为止）
  local prefix=$1 n line rest
  n=$(grep -cF -- "$prefix" "$OPS")
  if [[ "$n" != 1 ]]; then
    echo "  … 没跑成：docs/ops.md 里以「$prefix」开头的行有 $n 行，应为 1 行"
    return 1
  fi
  line=$(grep -F -- "$prefix" "$OPS")
  rest=${line#*"$prefix"}
  REMOTE=${rest%\'}
  if [[ "$rest" != *\' || "$REMOTE" == *\'* || "$REMOTE" != *'/etc/fleet-dao/'* || "$REMOTE" != *'chown root:fleet "$t"'* ]]; then
    echo "  … 没跑成：认不出「$prefix」那一行那头的命令（要以单引号收尾，里面有 /etc/fleet-dao/ 和 chown root:fleet \"\$t\"）"
    return 1
  fi
  REMOTE=${REMOTE//\/etc\/fleet-dao\//$D/}
  REMOTE=${REMOTE//'chown root:fleet "$t"'/true}
}

GOOD=$TMP/good
RC=0
# 放一次：左边的桩喂给那头的命令；RC 是那头的退出码
place() { # 那头的命令 左边的桩（函数名） 放到哪（文件名）
  local remote=$1 feed=$2 name=$3
  cp -- "$GOOD.$name" "$D/$name"
  "$feed" 2>/dev/null | sh -c "$remote" 2>"$TMP/err"
  RC=${PIPESTATUS[1]}
}
kept() { # 说明 文件名：失败了、没换、没留下临时名
  check "$1：那头失败" "$RC" 1
  check "$1：说了没换" "$(grep -c '没换' "$TMP/err")" 1
  check "$1：原来那份原样留着" "$(cmp -s -- "$D/$2" "$GOOD.$2" && echo 原样 || echo 被换了)" 原样
  check "$1：临时名没留下" "$(find "$D" -name '.new.*' | wc -l | tr -d ' ')" 0
}
modes_work() { # 这台 chmod 管不管用（Windows 上的 Git Bash 不管用）
  : >"$TMP/probe"
  chmod 640 "$TMP/probe"
  [[ "$(stat -c %a -- "$TMP/probe")" == 640 ]]
}
replaced() { # 说明 文件名 应当换成的内容所在的文件
  check "$1：那头成功" "$RC" 0
  check "$1：换成了收到的那份" "$(cmp -s -- "$D/$2" "$3" && echo 一样 || echo 不一样)" 一样
  check "$1：临时名没留下" "$(find "$D" -name '.new.*' | wc -l | tr -d ' ')" 0
  if modes_work; then check "$1：换上的是 640" "$(stat -c %a -- "$D/$2")" 640; fi
}

# 桩：通行证的值、目录的内容都在运行时拼（整段写在源码里，卫生检查会当成真的）
TOKEN=$(printf 'a%.0s' {1..64})
printf '# 通行证\nFLEET_FEISHU_GATEWAY_TOKEN=%s\n' "$(printf 'b%.0s' {1..64})" >"$GOOD.gateway-token.env"
printf '{"good":true}\n' >"$GOOD.catalog.json"
printf '# 通行证\nFLEET_FEISHU_GATEWAY_TOKEN=%s\n' "$TOKEN" >"$TMP/token-full"
decrypt_failed() { # age 解不开：只往 stderr 报错，标准输出一个字节都没有
  echo "age: error: no identity matched any of the recipients" >&2
  return 1
}
nothing() { :; }
half_catalog() { head -c 200 -- "$EXAMPLE"; } # 传到一半断了：非空，但不是完整的 JSON
not_json() { echo 'not json at all'; }
error_page() { echo '<html>502 Bad Gateway</html>'; }
full_catalog() { cat -- "$EXAMPLE"; }
half_token() { printf 'FLEET_FEISHU_GATEWAY_TOKEN=%s' "${TOKEN:0:20}"; }
full_token() { cat -- "$TMP/token-full"; }

echo "== 目录配置：age -d … | ssh <法国> '…'"
if remote_of "age -d -i ~/.fleet-dao/vault-key.txt france/etc/fleet-dao/catalog.json.age | ssh <法国> '"; then
  CATALOG_CMD=$REMOTE
  place "$CATALOG_CMD" decrypt_failed catalog.json
  kept "解密失败（那头收到空的）" catalog.json
  place "$CATALOG_CMD" half_catalog catalog.json
  kept "传到一半断了（半截的 JSON）" catalog.json
  place "$CATALOG_CMD" not_json catalog.json
  kept "收到的不是 JSON" catalog.json
  place "$CATALOG_CMD" full_catalog catalog.json
  replaced "收到完整的目录" catalog.json "$EXAMPLE"
else
  skipped=1
fi

echo "== 飞书网关的通行证：ssh <法国> 'cat …' | ssh <香港> '…'"
if remote_of "ssh <法国> 'cat /etc/fleet-dao/gateway-token.env' | ssh <香港> '"; then
  TOKEN_CMD=$REMOTE
  place "$TOKEN_CMD" nothing gateway-token.env
  kept "法国那头没读成（香港收到空的）" gateway-token.env
  place "$TOKEN_CMD" half_token gateway-token.env
  kept "传到一半断了（通行证只有一截）" gateway-token.env
  place "$TOKEN_CMD" error_page gateway-token.env
  kept "收到的是报错页" gateway-token.env
  place "$TOKEN_CMD" full_token gateway-token.env
  replaced "收到完整的通行证" gateway-token.env "$TMP/token-full"
else
  skipped=1
fi

echo "== 反例：修之前的老写法（先落临时名就换，不看收到的是什么）"
OLD='f=/etc/fleet-dao/catalog.json; t=$(mktemp /etc/fleet-dao/.new.XXXXXX); cat > "$t" && chown root:fleet "$t" && chmod 640 "$t" && mv "$t" "$f"'
OLD=${OLD//\/etc\/fleet-dao\//$D/}
OLD=${OLD//'chown root:fleet "$t"'/true}
place "$OLD" decrypt_failed catalog.json
check "老写法遇上解密失败：好的那份被换成了空的（这里抓得到）" "$RC:$(wc -c <"$D/catalog.json" | tr -d ' ')" "0:0"

if ((fail)); then
  echo "place-file：不通过"
  exit 1
fi
if ((skipped)); then
  echo "place-file：没跑成（见上面的「没跑成」）"
  exit 2
fi
echo "place-file：通过"
