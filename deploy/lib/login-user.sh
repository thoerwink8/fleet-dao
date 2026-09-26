#!/usr/bin/env bash
# shellcheck disable=SC2034 # LOGIN_USER_* 是给调用方和测试读写的
# 登录用户（法国的 pilot：创始人经 Mirasim 桌面端的 ssh 远程模式登进来干活的那个用户）的装与查。要先 source common.sh。
# france.sh 用它装和读回；deploy/test/login-user.test.sh 拿故意造错的用户喂 check_login_user，看拦不拦得下。
# 它该是的样子：非 root、没有任何 sudo（脚本从不给它写 sudoers）、只在自己的组和 systemd-journal 里（看日志）、
# 家目录 750、~/.local/bin/reclaude 它自己执行得了，而且登录 shell 里找得到——Mirasim 在远端起的服务端
# 按「登录 shell 跑一遍 env」取 PATH（$SHELL -ilc），Ubuntu 默认的 ~/.profile 会把 ~/.local/bin 加进去。
# 家里不放任何凭据：登录用的公钥、reclaude 登录都由创始人自己来。

LOGIN_USER_LOG_GROUP=systemd-journal
LOGIN_USER_SUDO=sudo # 测试时换成别的，造出「sudo -l 的回答认不出」
LOGIN_USER_BAD=()    # check_login_user 的结论，每条：代号<TAB>说明（带怎么补）

# 装：缺什么补什么，已有的不动。reclaude 只在没有时装（之后由这个用户自己 reclaude update）：从给的地址下、
# 核对 sha256，写进它家里的事以它自己的身份做（审计 P01）。不从会话用户家里拷：会话改得了自己那份，拷过来就是
# 一条从 AI 会话摸进创始人账号的路。
setup_login_user() { # 用户 家目录 reclaude下载地址 sha256
  local user=$1 home=$2 url=$3 sum=$4
  ensure_service_user "$user" "$home" login # 人用的账号，普通用户（UID ≥ 1000），不占系统号段
  ensure_dir "$home" "$user:$user" 750
  if ! getent group "$LOGIN_USER_LOG_GROUP" >/dev/null; then
    red "这台没有 $LOGIN_USER_LOG_GROUP 组，$user 看不了日志"
    return 1
  fi
  if [[ " $(id -nG "$user") " != *" $LOGIN_USER_LOG_GROUP "* ]]; then
    usermod -a -G "$LOGIN_USER_LOG_GROUP" "$user"
    changed "把 $user 加进 $LOGIN_USER_LOG_GROUP 组（看日志）"
  fi
  ensure_user_reclaude "$user" "$home" "$url" "$sum"
}

# 给一个用户装 reclaude 二进制（pilot 和会话用户都用）：只在没有时装（之后由这个用户自己 reclaude update）；
# 从给的地址下、核对 sha256，写进它家里的事以它自己的身份做。登录不在这里：要人在浏览器里点。
ensure_user_reclaude() { # 用户 家目录 下载地址 sha256
  local user=$1 home=$2 url=$3 sum=$4 bin tmp
  bin=$home/.local/bin/reclaude
  if runuser -u "$user" -- test -x "$bin"; then
    ok "$user 已有 reclaude（$bin）"
    return 0
  fi
  if [[ -e "$bin" || -L "$bin" ]]; then
    red "$bin 在，但 $user 执行不了：不动它，看清是什么、删掉再跑"
    return 1
  fi
  tmp=$(mktemp -d /var/tmp/fleet-dao-download.XXXXXX)
  if ! curl -fsSL --retry 3 --max-time 300 -o "$tmp/reclaude" "$url"; then
    rm -rf -- "$tmp"
    red "下载失败：$url"
    return 1
  fi
  if ! printf '%s  %s\n' "$sum" "$tmp/reclaude" | sha256sum --quiet --status -c -; then
    rm -rf -- "$tmp"
    red "sha256 对不上，不装：$url"
    return 1
  fi
  # 核对过的文件由 root 从标准输入递进去；建目录、写、改权限、换上都是这个用户自己做，它家里不会多出 root 属主的东西
  # shellcheck disable=SC2016 # 单引号里的东西要在这个用户的 shell 里展开
  if ! as_user "$user" /bin/sh -c 'd=$HOME/.local/bin && mkdir -p "$d" && t=$(mktemp "$d/.reclaude.XXXXXX") || exit 1
    if cat >"$t" && chmod 755 "$t" && mv -f "$t" "$d/reclaude"; then exit 0; fi
    rm -f "$t"
    exit 1' <"$tmp/reclaude"; then
    rm -rf -- "$tmp"
    red "以 $user 身份把 reclaude 写进 $bin 没成（~/.local 归别人了？）"
    return 1
  fi
  rm -rf -- "$tmp"
  changed "给 $user 装 reclaude（sha256 已核对）：$bin"
}

# 查（只读）：返回 0 干净、1 有问题，问题放进 LOGIN_USER_BAD。读不到、认不出也算问题，不当成「查了没事」
check_login_user() { # 用户
  local user=$1 home shell uid groups=() g extra="" in_log=0 out bin have rc probe
  LOGIN_USER_BAD=()
  if ! getent passwd "$user" >/dev/null; then
    LOGIN_USER_BAD+=("no-user	没有这个用户：跑 bash deploy/france.sh 建")
    return 1
  fi
  uid=$(getent passwd "$user" | cut -d: -f3)
  home=$(getent passwd "$user" | cut -d: -f6)
  shell=$(getent passwd "$user" | cut -d: -f7)
  # 人用的账号必须是普通用户（UID ≥ 1000）：落在系统号段就会跟删掉的旧服务用户共号，journal 里旧记录串到它名下。
  # 迁号：先确认这个用户没有进程在跑（创始人可能正登着 reclaude），再 usermod -u <新号> 并把家目录属主改过来
  if [[ "$uid" =~ ^[0-9]+$ ]] && ((uid < 1000)); then
    LOGIN_USER_BAD+=("system-uid	UID $uid 在系统号段（< 1000），会和删掉的旧服务用户串号：等它没有进程在跑时 usermod -u <≥1000> $user，家目录属主一并改过来")
  fi
  # 组：只许它自己的组和看日志的组。多出来的组可能就是提权或读密钥的门（sudo、docker、fleet……）
  read -r -a groups <<<"$(id -nG "$user")"
  for g in "${groups[@]}"; do
    if [[ "$g" == "$LOGIN_USER_LOG_GROUP" ]]; then
      in_log=1
    elif [[ "$g" != "$user" ]]; then
      extra+=" $g"
    fi
  done
  if ((in_log == 0)); then
    LOGIN_USER_BAD+=("no-log-group	不在 $LOGIN_USER_LOG_GROUP 组，看不了日志：跑 bash deploy/france.sh 补")
  fi
  if [[ -n "$extra" ]]; then
    LOGIN_USER_BAD+=("extra-groups	多了组「${extra# }」：gpasswd -d $user <组> 去掉（装机脚本不替人删组）")
  fi
  # sudo：按 sudo 自己的结论判（sudoers 文件、组、别名都算在里面）。两种话都认不出就是没查成，一样算问题
  out=$(LC_ALL=C "$LOGIN_USER_SUDO" -n -l -U "$user" 2>&1) || true
  if [[ "$out" == *"may run the following commands"* ]]; then
    LOGIN_USER_BAD+=("sudo	有 sudo 条目（sudo -l -U $user 看是哪条）：删掉它，装机脚本从不给它写")
  elif [[ "$out" != *"is not allowed to run sudo"* ]]; then
    LOGIN_USER_BAD+=("sudo-unreadable	sudo -l -U $user 的回答认不出，有没有 sudo 没查成：「$(head -1 <<<"$out")」")
  fi
  have=$(stat -c '%U:%G %a' -- "$home" 2>/dev/null) || have="不存在"
  if [[ "$have" != "$user:$user 750" ]]; then
    LOGIN_USER_BAD+=("home	家目录 $home 是「$have」，应为 $user:$user 750：跑 bash deploy/france.sh 改回")
  fi
  bin=$home/.local/bin/reclaude
  if ! runuser -u "$user" -- test -x "$bin" 2>/dev/null; then
    if [[ -e "$bin" || -L "$bin" ]]; then
      LOGIN_USER_BAD+=("reclaude-noexec	~/.local/bin/reclaude 在，但它执行不了：看清是什么、删掉，再跑 bash deploy/france.sh")
    else
      LOGIN_USER_BAD+=("no-reclaude	没有 ~/.local/bin/reclaude：跑 bash deploy/france.sh 补")
    fi
    return 1
  fi
  # 照 Mirasim 远端服务端取 PATH 的办法问一遍登录 shell（环境照 sshd 给的那样干净）。
  # 输出落进 root 建的临时文件，不走 $(...) 的管道：管道要等写端全关，而 pilot 的 .profile/.bashrc 起个后台进程
  # 就一直占着写端，timeout 杀了前台也堵着不返回（AI 会话跑在 pilot 下、改得了这两个文件；审查官在法国实测：
  # 走管道 5 秒后台睡眠要等满 5.01 秒，落文件 0.02 秒）。setsid：不带控制终端——带着终端（sudo 的伪终端）交互 shell
  # 抢终端会被挂起，连 timeout 一起停住（CI 与法国实咬）。-k：挂起的进程收不到 TERM，到点再补 KILL。
  rc=0
  probe=$(mktemp "${TMPDIR:-/var/tmp}/fleet-dao-pilot-probe.XXXXXX")
  (cd -- "$home" && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" SHELL="$shell" \
    PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 setsid -w timeout -k 5 10 "$shell" -ilc 'command -v reclaude' \
    </dev/null >"$probe" 2>&1) || rc=$?
  # 交互 shell 起来时往 stderr 打的「no job control」在命令输出之前，所以取最后一行。
  # 退出码也要是 0：登录脚本前台卡住时 timeout 到点会给整组发信号，把卡住的那个命令杀掉，交互 bash 自己不理 TERM、
  # 接着把登录脚本跑完、照样打出路径——光看输出会判成干净（CI 实咬），可 timeout 自己返回 124。
  # 被 timeout 杀过就是卡住了：Mirasim 自己那一问也会卡在这里，算红。
  out=$(<"$probe")
  rm -f -- "$probe"
  if ((rc != 0)) || [[ "${out##*$'\n'}" != "$bin" ]]; then
    LOGIN_USER_BAD+=("reclaude-not-on-path	登录 shell（$shell -ilc）没正常找到 $bin（退出码 $rc，124＝登录脚本卡住被 timeout 杀了；输出末几行「$(tail -4 <<<"$out" | tr '\n' '|')」）：Mirasim 远端按登录 shell 取 PATH，~/.profile 里要把 ~/.local/bin 加进 PATH（Ubuntu 默认的就有），登录脚本也不能前台卡住")
  fi
  if ((${#LOGIN_USER_BAD[@]})); then return 1; fi
  return 0
}
