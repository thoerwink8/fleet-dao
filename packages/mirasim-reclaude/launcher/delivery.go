package main

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"
)

// 送达回执：Mirasim 给可引导的会话带 --replay-user-messages，Claude Code 真正读进一条 user 时
// 在 stdout 回显同内容、isReplay=true 的 user 帧。写进管道不等于送到（Mirasim 的「已引导」只表示写进了管道），
// 所以启动器给每条转出去的 user 记账，见到回显销账：
//   - 没销账就不算空闲：不重选路、不重启执行体，后续 user 照常交给当前执行体，免得 CLI 队列里的消息随旧进程丢掉；
//   - 空闲时转出去、过了 stallAfter 既没回显也没任何输出，判卡住：给 Mirasim 回一个报错 result，
//     让它当场显示「没送到、请重发」，不再无声地挂着；
//   - 过了 expireAfter 仍没回显（比如这一版 CLI 对某类输入不回显），不再挡路由，只记日志。
// 日志只记条数、毫秒数和长度，不记内容。

const deliveryStallMessage = "启动器已把这条消息交给 Claude Code，但它一直没有确认读到（没有回显、也没有任何输出），这条很可能没送到。请重新发送；连续出现就重启这个会话的进程。"

var deliveryExpireAfter = 10 * time.Minute

func deliveryStallAfter() time.Duration {
	if ms, err := strconv.Atoi(os.Getenv("RECLAUDE_MIRASIM_DELIVERY_STALL_MS")); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 60 * time.Second
}

type pendingUser struct {
	text     string
	at       time.Time
	idle     bool // 转出时执行体空闲（没有在跑的回合）：这时 CLI 应当立刻读进并回显
	quiet    bool // 转出后执行体还没有任何输出
	reported bool
	expired  bool
}

type deliveries struct {
	tracking   bool
	stallAfter time.Duration
	pending    []*pendingUser
}

func newDeliveries(args []string) *deliveries {
	return &deliveries{tracking: hasFlag(args, "--replay-user-messages"), stallAfter: deliveryStallAfter()}
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if a == name {
			return true
		}
	}
	return false
}

// userText 取 user 帧的正文：字符串原样，内容块数组只拼 text 块。图片等不参与比对。
func userText(f frame) string {
	m := f.object("message")
	if m == nil {
		return ""
	}
	var s string
	if json.Unmarshal(m["content"], &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(m["content"], &blocks) != nil {
		return ""
	}
	parts := []string{}
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func (d *deliveries) forwarded(f frame, path string, idle bool) {
	logLine("event=user-forward path=" + path + " idle=" + strconv.FormatBool(idle) + " len=" + strconv.Itoa(len(userText(f))) + " unacked=" + strconv.Itoa(d.unacked()))
	if d.tracking {
		d.pending = append(d.pending, &pendingUser{text: strings.TrimSpace(userText(f)), at: time.Now(), idle: idle, quiet: true})
	}
}

func (d *deliveries) unacked() int {
	n := 0
	for _, p := range d.pending {
		if !p.expired {
			n++
		}
	}
	return n
}

// blocking：还有没销账、没过期的 user，执行体不算空闲。
func (d *deliveries) blocking() bool { return d.unacked() > 0 }

// observe 看执行体的每一帧主线输出：任何输出都说明它没卡死；isReplay 的 user 按正文销账。
func (d *deliveries) observe(f frame) {
	if len(d.pending) == 0 || f.text("parent_tool_use_id") != "" {
		return
	}
	for _, p := range d.pending {
		p.quiet = false
	}
	if f.text("type") != "user" || string(f["isReplay"]) != "true" {
		return
	}
	echo := strings.TrimSpace(userText(f))
	for i, p := range d.pending {
		if p.text == echo || (p.text != "" && strings.Contains(echo, p.text)) {
			logLine("event=user-ack ms=" + elapsedMs(p.at) + " reported=" + strconv.FormatBool(p.reported) + " expired=" + strconv.FormatBool(p.expired))
			d.pending = append(d.pending[:i], d.pending[i+1:]...)
			return
		}
	}
	logLine("event=user-ack-unmatched len=" + strconv.Itoa(len(echo)) + " unacked=" + strconv.Itoa(d.unacked()))
}

// due 返回该判卡住、要回报错的条目，并把超时的条目标成过期。
func (d *deliveries) due(now time.Time) []*pendingUser {
	out := []*pendingUser{}
	for _, p := range d.pending {
		age := now.Sub(p.at)
		if p.idle && p.quiet && !p.reported && age >= d.stallAfter {
			p.reported = true
			logLine("event=user-stalled ms=" + strconv.FormatInt(age.Milliseconds(), 10) + " len=" + strconv.Itoa(len(p.text)))
			out = append(out, p)
		}
		if !p.expired && age >= deliveryExpireAfter {
			p.expired = true
			logLine("event=user-unacked-expired ms=" + strconv.FormatInt(age.Milliseconds(), 10) + " len=" + strconv.Itoa(len(p.text)))
		}
	}
	return out
}

// next 是下一次要检查的时刻；没有待查的返回零值。
func (d *deliveries) next() time.Time {
	var at time.Time
	earlier := func(t time.Time) {
		if at.IsZero() || t.Before(at) {
			at = t
		}
	}
	for _, p := range d.pending {
		if p.idle && p.quiet && !p.reported {
			earlier(p.at.Add(d.stallAfter))
		}
		if !p.expired {
			earlier(p.at.Add(deliveryExpireAfter))
		}
	}
	return at
}

// lost 在执行体退出、被停或换掉时记下还有几条没确认送到。
func (d *deliveries) lost(reason string) {
	if n := d.unacked(); n > 0 {
		logLine("event=user-unacked reason=" + reason + " n=" + strconv.Itoa(n))
	}
	d.pending = nil
}

func stallResult(session string) frame {
	f := frame{}
	f.set("type", "result")
	f.set("subtype", "error_during_execution")
	f.set("session_id", session)
	f.set("result", deliveryStallMessage)
	f["is_error"] = json.RawMessage("true")
	return f
}
