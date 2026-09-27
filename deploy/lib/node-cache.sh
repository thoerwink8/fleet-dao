#!/usr/bin/env bash
# shellcheck disable=SC2034 # NODE_CACHE_BAD 是给调用方读的
# node 默认的编译缓存目录 /tmp/node-compile-cache 由 root 先建好、别人写不进（france.sh 装和读回；deploy/test/node-cache.test.sh 测）。
# 为什么：pnpm、tsc、Claude Code 这些命令行一起来就 module.enableCompileCache()，缓存默认放在
# <os.tmpdir()>/node-compile-cache/<node 版本>-<架构>-<V8 标记>-<uid>/。node 建子目录用的是 mkdir -p，已经在就照用，
# 不查归谁（node 22 的 compile_cache.cc）。/tmp 谁都能写：会话用户（AI）赶在别人前面建出这个目录，替 fleet、pilot、root
# 的 uid 预先建好子目录、放进编译缓存，对方的 node 就照读——等于以对方的身份跑它放的代码。目录归 root、755 之后，
# 非 root 的 node 建不了自己的子目录，编译缓存就不用了（只慢一点，不报错）；root 自己建的子目录别人也动不了。
# 开机时 /tmp 清空，由 systemd-tmpfiles 照 /etc/tmpfiles.d 下的配置在任何会话之前先建好；装机时也当场查，不对就删了重建。
# 要先 source common.sh（ok、changed、red、put_file）。

NODE_CACHE_BAD="" # node_cache_ok 查出的问题

# 开机时建这个目录的 systemd-tmpfiles 配置
node_cache_conf() { # 目录
  printf '%s\n' \
    '# fleet-dao（deploy/france.sh 写的，别在机器上手改）：node 默认的编译缓存目录由 root 先建好、别人写不进，' \
    '# 免得别的用户替 fleet、pilot、root 预先放编译缓存（为什么见仓里 deploy/lib/node-cache.sh 开头）' \
    "d $1 0755 root root -"
}

# 这个目录现在对不对：是目录、不是链接，root:root 755，里面的东西都归 root。对返回 0；不对、查不成返回 1，原因进 NODE_CACHE_BAD
node_cache_ok() { # 目录
  local dir=$1 meta others
  NODE_CACHE_BAD=""
  if [[ -L "$dir" ]]; then
    NODE_CACHE_BAD="$dir 是符号链接"
    return 1
  fi
  if [[ ! -e "$dir" ]]; then
    NODE_CACHE_BAD="$dir 不在（谁先建它，谁就能替别人放编译缓存）"
    return 1
  fi
  if [[ ! -d "$dir" ]]; then
    NODE_CACHE_BAD="$dir 不是目录"
    return 1
  fi
  if ! meta=$(stat -c '%U:%G %a' -- "$dir" 2>&1); then
    NODE_CACHE_BAD="读不到 $dir 的属主和权限：$meta"
    return 1
  fi
  if [[ "$meta" != "root:root 755" ]]; then
    NODE_CACHE_BAD="$dir 是「$meta」，要 root:root 755"
    return 1
  fi
  if ! others=$(find "$dir" -mindepth 1 ! -user root -printf '%p（%u）\n' 2>&1); then
    NODE_CACHE_BAD="查 $dir 里面归谁没查成：$(tail -1 <<<"$others")"
    return 1
  fi
  if [[ -n "$others" ]]; then
    NODE_CACHE_BAD="$dir 里有不归 root 的：$(head -3 <<<"$others" | tr '\n' ' ')"
    return 1
  fi
}

# 装：写开机建目录的配置；目录现在不对就整个删掉（rm -rf 不跟符号链接）、以 root 重建，再让 systemd-tmpfiles 照配置核一遍
# （配置写坏了这里就报）。没弄成记红、返回 1（照装机的规矩停下：这一步不对，会话就能冒充别的用户跑代码）
ensure_node_cache() { # 目录 配置文件
  local dir=$1 conf=$2 was out what
  put_file "$conf" root:root 644 "$(node_cache_conf "$dir")"
  if node_cache_ok "$dir"; then
    ok "$dir 归 root、755，里面没有别人的东西（node 的编译缓存别人放不进来）"
  else
    was=$NODE_CACHE_BAD
    what="建 $dir"
    if [[ -e "$dir" || -L "$dir" ]]; then
      what="删掉重建 $dir（原来${was#"$dir"}）"
      if ! out=$(rm -rf -- "$dir" 2>&1); then
        red "$was；想删掉重建，删不掉：$(tail -1 <<<"$out")"
        return 1
      fi
    fi
    if ! out=$(mkdir -m 755 -- "$dir" 2>&1); then
      red "$was；建不成（刚删就被人抢先建了？）：$(tail -1 <<<"$out")"
      return 1
    fi
    if ! node_cache_ok "$dir"; then
      red "$was；建完还是不对：$NODE_CACHE_BAD"
      return 1
    fi
    changed "$what，归 root、755"
  fi
  if ! out=$(systemd-tmpfiles --create -- "$conf" 2>&1); then
    red "systemd-tmpfiles 照 $conf 建目录没成（开机时就不会先建好）：$(tail -2 <<<"$out" | tr '\n' ' ')"
    return 1
  fi
  if ! node_cache_ok "$dir"; then
    red "systemd-tmpfiles 照 $conf 跑完，$NODE_CACHE_BAD"
    return 1
  fi
}

# 读回：开机建目录的配置在、内容对；目录现在归 root、755、里面没有别人的东西
check_node_cache() { # 目录 配置文件
  local dir=$1 conf=$2
  if [[ ! -f "$conf" || -L "$conf" ]] || ! cmp -s -- "$conf" <(node_cache_conf "$dir"); then
    red "$conf 不在或内容不对：开机后 $dir 不会先由 root 建好，重跑 france.sh"
  fi
  if node_cache_ok "$dir"; then
    ok "$dir 归 root、755，里面没有别人的东西（node 的编译缓存别人放不进来）"
  else
    red "$NODE_CACHE_BAD：会话能替 fleet、pilot、root 预先放 node 的编译缓存，重跑 france.sh 重建"
  fi
}
