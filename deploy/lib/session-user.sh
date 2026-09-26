#!/usr/bin/env bash
# shellcheck disable=SC2034 # SESSION_USER 是给调用方读的
# 法国的 AI 会话专用用户：建在 france.sh 里，读回的判据在这里（deploy/test/session-user.test.sh 拿故意造错的家目录喂它）。
# 要先 source common.sh（ok / red / pending）。
#
# 只有一个会话用户（创始人 2026-09-26）：reclaude 一个账户最多挂 4 台设备、一个家目录算一台，本机和另一台机器已占掉，
# 法国只占 1 台。引擎的全部会话都跑在它下面，它同一时刻只挂一个组织（平时拼车，用满切独享，见 docs/design.md 第九节）。
# 名字 fleet-agent-carpool 是历史沿用：改名得重新登录 reclaude。原先的 fleet-agent-dedicated 已停用、机器上已删，
# 这里不建、读回也不查它。pilot（创始人的登录用户）不登录 reclaude，它的读回在 lib/login-user.sh，也不查登没登录。
SESSION_USER=fleet-agent-carpool

# 家目录该在哪：/home/<用户>（france.sh 就这么建）。测试换成临时目录
SESSION_USER_HOME_ROOT=/home

# 这几样单拎出来，测试换成假的（不用 root、不用真账号）
session_user_home() { getent passwd "$1" | cut -d: -f6; }
session_user_home_meta() { stat -c '%U:%G %a' -- "$1" 2>/dev/null; } # 属主:组 权限
session_user_sudo_list() { sudo -l -U "$1" 2>&1; }
session_user_groups() { id -nG "$1" 2>&1; }

# 读回一个会话用户：家目录就是 /home/<用户>、不是符号链接、归它自己、750（别人读得到的话，reclaude 的登录态
# ~/.reclaude 就漏了）；没有 sudo、只在自己的组里、家里没有 GitHub 凭据和 ssh 钥匙；reclaude 登录要创始人在
# 浏览器里点，没登录记「待配」。用户不在记红（france.sh 建过它，不在就是状态不对，不当成没事）。
readback_session_user() { # 用户
  local u=$1 home bad="" f meta
  home=$(session_user_home "$u")
  if [[ -z "$home" ]]; then
    red "$u 不在（getent 查不到）：france.sh 该建它，重跑一遍"
    return 0
  fi
  if [[ "$home" != "$SESSION_USER_HOME_ROOT/$u" ]]; then
    red "$u 的家目录是「$home」，不是 $SESSION_USER_HOME_ROOT/$u：france.sh 按后者建、按后者管权限，别处的不认"
    return 0
  fi
  if [[ -L "$home" ]]; then
    red "$u 的家目录 $home 是符号链接：权限和内容都看不准，不认"
    return 0
  fi
  meta=$(session_user_home_meta "$home")
  if [[ "$meta" != "$u:$u 750" ]]; then
    bad+="家目录 $home 是「${meta:-读不到}」（要 $u:$u 750，不然别人读得到 reclaude 的登录态）；"
  fi
  if [[ "$(session_user_sudo_list "$u")" != *"not allowed to run sudo"* ]]; then bad+="有 sudo 条目；"; fi
  if [[ "$(session_user_groups "$u")" != "$u" ]]; then bad+="附加组「$(session_user_groups "$u")」；"; fi
  for f in .config/gh .git-credentials .netrc .ssh; do
    if [[ -e "$home/$f" ]]; then bad+="家里有 ~/$f；"; fi
  done
  if [[ -n "$bad" ]]; then
    red "$u：$bad"
  else
    ok "$u：没有 sudo、只在自己的组里、家里没有 GitHub 凭据和 ssh 钥匙"
  fi
  if [[ ! -x "$home/.local/bin/reclaude" ]]; then
    pending "$u 还没有 reclaude 二进制（~/.local/bin/reclaude）：见 docs/ops.md「会话用户登录 reclaude」"
  elif [[ ! -s "$home/.reclaude/device.json" ]]; then
    pending "$u 的 reclaude 还没登录：要创始人在浏览器里授权，见 docs/ops.md「会话用户登录 reclaude」"
  else
    ok "$u 的 reclaude 已登录"
  fi
}
