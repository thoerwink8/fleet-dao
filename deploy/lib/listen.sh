# shellcheck shell=bash
# 「某个端口只听回环」的判定（france.sh 读回库的监听时用，deploy/test/listen.test.sh 钉住）。
# 要紧的是**只听回环**：每个监听地址都得是 127.0.0.1 或 [::1]，至少有一个。机器没开 IPv6 的（WSL 里的 Ubuntu 没有 ::1 上的监听）
# 只听 127.0.0.1 一个，照样是只听本机，不能因为少了 ::1 判红；多出任何别的地址（0.0.0.0、网卡地址、别的端口）才是错；
# 一个监听都没读到不算「只听本机」（读不到不当成没事）。
#   listens_loopback_only_on <端口> <ss 读出的监听地址，空格隔开>   退出码 0 = 是，1 = 不是
listens_loopback_only_on() {
  local port=$1 listen=$2
  [[ -n "${listen// /}" ]] || return 1
  # shellcheck disable=SC2143 # 不用 ! grep -q：管道里 grep -q 提前退出会让上游吃 SIGPIPE，在 pipefail 下把「有多余地址」翻成「没有」
  [[ -z "$(tr ' ' '\n' <<<"$listen" | grep -v -F -x -e '' -e "127.0.0.1:$port" -e "[::1]:$port")" ]]
}
