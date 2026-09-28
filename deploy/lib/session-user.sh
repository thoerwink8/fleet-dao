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
session_user_path_meta() { stat -c '%U:%G %a' -- "$1" 2>/dev/null; } # 属主:组 权限

# 会话用户的 ~/.ssh 只许放创始人登录 pilot 用的那几把钥匙（创始人 2026-09-29 拍「留着改检查」）：装 Mirasim 服务端、
# 以后升级和换账号，都要从 Mirasim 桌面端 ssh 连 <会话用户>@法国（docs/ops.md 第五节「会话用户的 Mirasim」第 1 步），
# 删了每次都得 root 重开口子。认钥匙照 pilot 家里那份，不另记一份名单（公开仓里不写钥匙，机器上也少一份要对齐的）。
SESSION_SSH_ALLOW_FILE=/home/pilot/.ssh/authorized_keys

# 一份 authorized_keys 里每把钥匙的指纹，一行一个、排好序；有钥匙却认不全（ssh-keygen 读不了、认出的比写的少）返回 1
ssh_key_fingerprints() { # 文件
  local n out
  if [[ ! -f "$1" || ! -r "$1" ]]; then return 1; fi
  n=$(grep -cvE '^[[:space:]]*(#|$)' -- "$1") || n=0
  if ((n == 0)); then return 0; fi
  out=$(ssh-keygen -lf "$1" 2>/dev/null | awk '{print $2}' | sort -u) || return 1
  if [[ $(grep -c . <<<"$out") -lt $n ]]; then return 1; fi
  printf '%s\n' "$out"
}

# 会话用户家里的 ~/.ssh：不在最好；在的话只许一份 authorized_keys（目录 700、文件 600、都归它自己、都不是链接），
# 里面每把钥匙 pilot 家里都有。认不出、核对不了一律算不对，不当成没事。返回的问题写进 SSH_BAD
check_session_ssh() { # 用户 家目录
  local u=$1 d="$2/.ssh" f extra keys allow stray
  SSH_BAD=""
  if [[ ! -e "$d" && ! -L "$d" ]]; then return 0; fi
  if [[ -L "$d" || ! -d "$d" ]]; then
    SSH_BAD="~/.ssh 不是目录（或是链接）；"
    return 0
  fi
  if [[ ! -r "$d" || ! -x "$d" ]]; then
    SSH_BAD="~/.ssh 读不了，里面放了什么没法核对；"
    return 0
  fi
  f=$d/authorized_keys
  # 用通配不用 find：find 在读不了的当前目录下（runuser 换了身份、cwd 还是 /root）会退出非 0
  extra=$(
    shopt -s nullglob dotglob
    for e in "$d"/*; do [[ "${e##*/}" == authorized_keys ]] || printf '%s ' "${e##*/}"; done
  )
  if [[ -n "$extra" ]]; then SSH_BAD+="~/.ssh 里除了 authorized_keys 还有 ${extra% }（会话用户不该有自己的钥匙和 ssh 配置）；"; fi
  if [[ "$(session_user_path_meta "$d")" != "$u:$u 700" ]]; then
    SSH_BAD+="~/.ssh 是「$(session_user_path_meta "$d")」（要 $u:$u 700）；"
  fi
  if [[ ! -e "$f" && ! -L "$f" ]]; then return 0; fi
  if [[ -L "$f" || ! -f "$f" ]]; then
    SSH_BAD+="~/.ssh/authorized_keys 不是普通文件（或是链接）；"
    return 0
  fi
  if [[ "$(session_user_path_meta "$f")" != "$u:$u 600" ]]; then
    SSH_BAD+="~/.ssh/authorized_keys 是「$(session_user_path_meta "$f")」（要 $u:$u 600）；"
  fi
  if ! keys=$(ssh_key_fingerprints "$f"); then
    SSH_BAD+="~/.ssh/authorized_keys 里的钥匙认不全（ssh-keygen 读不了），没法核对是谁的；"
    return 0
  fi
  if [[ -z "$keys" ]]; then return 0; fi
  if ! allow=$(ssh_key_fingerprints "$SESSION_SSH_ALLOW_FILE") || [[ -z "$allow" ]]; then
    SSH_BAD+="~/.ssh/authorized_keys 有钥匙，可 $SESSION_SSH_ALLOW_FILE 读不了、认不出或是空的，核对不了是不是创始人的；"
    return 0
  fi
  stray=$(comm -23 <(printf '%s\n' "$keys") <(printf '%s\n' "$allow") | grep -c .) || true
  if ((stray > 0)); then
    SSH_BAD+="~/.ssh/authorized_keys 里有 $stray 把钥匙不在 $SESSION_SSH_ALLOW_FILE 里（只许放创始人登录 pilot 用的）；"
  fi
}

# 读回一个会话用户：家目录就是 /home/<用户>、不是符号链接、归它自己、750（别人读得到的话，reclaude 的登录态
# ~/.reclaude 就漏了）；没有 sudo、只在自己的组里、家里没有 GitHub 凭据和 ssh 钥匙；reclaude 登录要创始人在
# 浏览器里点，没登录记「待配」。~/.ssh 只许放创始人登录 pilot 的钥匙（check_session_ssh）。用户不在记红（france.sh 建过它，不在就是状态不对，不当成没事）。
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
  for f in .config/gh .git-credentials .netrc; do
    if [[ -e "$home/$f" ]]; then bad+="家里有 ~/$f；"; fi
  done
  check_session_ssh "$u" "$home"
  bad+=$SSH_BAD
  if [[ -n "$bad" ]]; then
    red "$u：$bad"
  else
    ok "$u：没有 sudo、只在自己的组里、家里没有 GitHub 凭据，~/.ssh 里只有创始人登录 pilot 的钥匙（或没有）"
  fi
  if [[ ! -x "$home/.local/bin/reclaude" ]]; then
    red "$u 没有 reclaude 二进制（~/.local/bin/reclaude）：引擎起不了 Claude 会话；重跑 bash deploy/france.sh 装上"
  elif [[ ! -s "$home/.reclaude/device.json" ]]; then
    pending "$u 的 reclaude 还没登录：要创始人在浏览器里授权，见 docs/ops.md「会话用户登录 reclaude」"
  else
    ok "$u 的 reclaude 已登录"
  fi
}
