#!/usr/bin/env bash
# shellcheck disable=SC2034 # AUTO_STATE_NODE 是给调用方和测试改的
# 自动发布跑得怎么样（france.sh 的读回用）。要先 source common.sh（ok、pending、red）。
# deploy/test/auto-release-state.test.sh 拿临时文件喂它，每种情况各造一次。
#
# 跑没跑过、上一轮什么时候、干了什么，读自动发布每一轮写的状态文件（deploy/france/auto-release 写，
# /srv/fleet-dao-releases/.auto/state.json）里的 ranAt 和 last，不看 systemd 的 ExecMainExitTimestamp：
# 服务正在跑的那几分钟里它是空的，读回会误报「自动发布还一轮都没跑过」。三种情况分清：
#   文件不在：还一轮都没跑过（待配）；
#   读不了、不是 JSON、格式版本不对、ranAt 认不出：判红写明原因，不当成没跑过；
#   读到了：写上一轮跑的时间和这一轮干了什么。
# 最近一轮崩了（没写成状态就退出）时状态文件还是更早那一轮的，得看单元自己：check_auto_release_unit。

AUTO_STATE_NODE=/usr/bin/node # 读 json 用的 node（france.sh 的前提里查过）；测试机上可能在别处

# 读状态文件，打一行「<ranAt>（N 分钟前），这轮：<干了什么>」；读不成打一行原因、退出 1。格式版本照 lib.mjs 的 STATE_SCHEMA。
# shellcheck disable=SC2016 # 单引号里是给 node 的 JS，模板字符串不归 shell 展开
AUTO_STATE_JS='
  const [lib, file] = process.argv.slice(1);
  const fail = (why) => {
    console.log(why);
    process.exit(1);
  };
  let text;
  try {
    text = (await import("node:fs")).readFileSync(file, "utf8");
  } catch (e) {
    fail(`读不了：${e?.message ?? e}`);
  }
  let st;
  try {
    st = JSON.parse(text);
  } catch (e) {
    fail(`不是 JSON：${e.message}`);
  }
  let schema;
  try {
    ({ STATE_SCHEMA: schema } = await import((await import("node:url")).pathToFileURL(lib).href));
  } catch (e) {
    fail(`认格式用的 ${lib} 载不进来：${e?.message ?? e}`);
  }
  if (st?.schema !== schema) fail(`格式认不出（schema ${JSON.stringify(st?.schema)}，应为 ${schema}）`);
  const at = typeof st.ranAt === "string" ? Date.parse(st.ranAt) : Number.NaN;
  if (Number.isNaN(at)) fail(`认不出上一轮是什么时候跑的（ranAt 是 ${JSON.stringify(st.ranAt)}）`);
  const last = st.last;
  const did =
    last && typeof last.action === "string"
      ? `${last.action}${last.detail ? `（${last.detail}）` : ""}`
      : "没记这一轮干了什么";
  const ago = Math.max(0, Math.round((Date.now() - at) / 60000));
  console.log(`${st.ranAt}（${ago} 分钟前），这轮：${did}`);
'

check_auto_release_state() { # 状态文件 lib.mjs
  local file=$1 lib=$2 out
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    pending "自动发布还一轮都没跑过（没有 $file；定时器装上 2 分钟后跑第一轮；现在跑：systemctl start fleet-auto-release）"
    return 0
  fi
  if ! out=$("$AUTO_STATE_NODE" --input-type=module -e "$AUTO_STATE_JS" "$lib" "$file" 2>&1); then
    red "自动发布的状态文件 $file 没读成：$(tail -1 <<<"${out:-node 没说原因}")（journalctl -u fleet-auto-release -n 30）"
    return 1
  fi
  ok "自动发布上一轮跑在 $out（全部读数：bash /srv/fleet-dao/deploy/release.sh --check）"
}

# 最近一轮崩了没有：只认 ActiveState=failed。服务正在跑时是 activating（不误报），跑完没崩是 inactive，
# failed 一直留到下一轮起来。崩了的那一轮没写成状态文件，上面读到的是更早那一轮。
check_auto_release_unit() { # ActiveState ExecMainStatus
  if [[ "$1" == failed ]]; then
    red "自动发布最近一轮崩了（退出码 ${2:-读不到}），状态文件里还是更早那一轮：journalctl -u fleet-auto-release -n 30"
    return 1
  fi
  return 0
}
