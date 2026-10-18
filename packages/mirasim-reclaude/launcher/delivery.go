package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 送达回执：Mirasim 给可引导的会话带 --replay-user-messages，Claude Code 真正读进一条 user 时
// 在 stdout 回显同内容、isReplay=true 的 user 帧。写进管道不等于送到（Mirasim 的「已引导」只表示写进了管道），
// 所以启动器给每条转出去的 user 记账，见到回显销账：
//   - 没销账就不算空闲：不重选路、不重启执行体，后续 user 照常交给当前执行体，免得 CLI 队列里的消息随旧进程丢掉；
//   - 空闲时转出去（或运行中转出去、回合结束了还没读进），过了 stallAfter 既没回显也没任何输出，判卡住：
//     给 Mirasim 回一个报错 result，让它当场显示「没送到」，不再无声地挂着；
//   - 执行体退出、被停、被换掉时还没销账的，正文存到本机，同一会话下一条消息发出时补在前面（Mirasim 自己重发了的不重复补）；
//   - 过了 expireAfter 仍没回显（比如这一版 CLI 对某类输入不回显），不再挡路由，只记日志。
// 日志只记条数、毫秒数和长度，不记内容；补发用的正文只存本机缓存目录（0600），补完或过期即删。
//
// 回显怎么对上是哪一条（一次有效回显最多销一条，绝不按子串）：
//  1. 转出的 user 帧带 uuid、回显也带 uuid：只按 uuid 相等对；uuid 不同就是别的消息，哪怕正文一样。
//  2. 否则按正文精确相等：两边都只有 text（字符串或全是 text 块），各自只去掉首尾空白后逐字相等，
//     同正文有多条时销最早那条。回显多了前后缀、少了字、只是包含，都不算。
//  3. 带图片等非 text 块、或正文为空的，没有 uuid 就无法判定是哪一条：仍保留未确认责任，
//     记 event=user-identity-unknown，保护当前执行体直到原有过期边界；不能用空正文销账。有 uuid 的照常按 1 记账。
//
// CLI 是否回显 uuid 由协议决定，这里不假定：转出去的帧没带 uuid 就只走 2。
// 补发只补纯文本正文：带图片的消息补不全，只记日志。

const deliveryStallMessage = "启动器已把这条消息交给 Claude Code，但它一直没有确认读到（没有回显、也没有任何输出），这条很可能没送到。请重新发送；连续出现就重启这个会话的进程（重启后启动器会把没读到的消息自动补上）。"

const redeliveryHeader = "【启动器补发】上个进程结束前，下面这些消息已经发出，但 Claude Code 没读到。按顺序先处理它们，再处理本条消息："

var deliveryExpireAfter = 10 * time.Minute

// 补发存档超过这个时长就不再补：太久以前的话补进新回合只会添乱。
var redeliveryMaxAge = 24 * time.Hour

func deliveryStallAfter() time.Duration {
	if ms, err := strconv.Atoi(os.Getenv("RECLAUDE_MIRASIM_DELIVERY_STALL_MS")); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 60 * time.Second
}

type pendingUser struct {
	uuid     string // 转出的 user 帧自带的 uuid；没有则空
	text     string // 纯文本正文（去首尾空白）；带非 text 块或为空时为空，只能靠 uuid 对
	at       time.Time
	idle     bool // 转出时执行体空闲（没有在跑的回合），或转出后回合已经结束：这时 CLI 应当立刻读进并回显
	quiet    bool // 从 at 起执行体还没有任何输出
	reported bool
	expired  bool
}

type deliveries struct {
	tracking   bool
	stallAfter time.Duration
	pending    []*pendingUser
	carried    []string // 上个执行体（或上个进程）没读进、等下一条消息一起补发的正文
	session    string
}

type redeliveryFile struct {
	Saved time.Time `json:"saved"`
	Texts []string  `json:"texts"`
}

func newDeliveries(args []string) *deliveries {
	d := &deliveries{tracking: hasFlag(args, "--replay-user-messages"), stallAfter: deliveryStallAfter(), session: sessionArgument(args)}
	if d.tracking {
		d.carried = loadRedelivery(d.session)
	}
	return d
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

// userContent 取 user 帧的 text 正文：字符串原样，内容块数组只拼 text 块。
// onlyText 为假说明还有图片等非 text 块（或内容读不出来），正文不能代表整条消息。
func userContent(f frame) (text string, onlyText bool) {
	m := f.object("message")
	if m == nil {
		return "", false
	}
	var s string
	if json.Unmarshal(m["content"], &s) == nil {
		return s, true
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(m["content"], &blocks) != nil {
		return "", false
	}
	parts := []string{}
	onlyText = true
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		} else {
			onlyText = false
		}
	}
	return strings.Join(parts, "\n"), onlyText
}

func userText(f frame) string {
	text, _ := userContent(f)
	return text
}

// userIdentity 是一条 user 帧能用来对回执的身份：uuid，和纯文本正文（带非 text 块或为空时为空）。
func userIdentity(f frame) (uuid, text string) {
	uuid = f.text("uuid")
	if t, only := userContent(f); only {
		text = strings.TrimSpace(t)
	}
	return uuid, text
}

// core 去掉 Mirasim 给运行中引导追加的说明尾巴，只留创始人写的那段，用来判「Mirasim 自己已经重发过」。
func core(text string) string {
	if i := strings.Index(text, "[Mid-task message:"); i >= 0 {
		text = text[:i]
	}
	return strings.TrimSpace(text)
}

func redeliveryPath(session string) string {
	dir, err := os.UserCacheDir()
	if err != nil || session == "" || !safeID(session) {
		return ""
	}
	return filepath.Join(dir, "reclaude-mirasim", "unacked", session+".json")
}

func loadRedelivery(session string) []string {
	p := redeliveryPath(session)
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var saved redeliveryFile
	if json.Unmarshal(b, &saved) != nil || time.Since(saved.Saved) > redeliveryMaxAge {
		_ = os.Remove(p)
		logLine("event=user-redelivery-dropped reason=unreadable-or-stale")
		return nil
	}
	if len(saved.Texts) > 0 {
		logLine("event=user-redelivery-loaded n=" + strconv.Itoa(len(saved.Texts)))
	}
	return saved.Texts
}

// persist 每次记账变化就把「还没确认读进」的正文写盘：Mirasim 可能直接强杀进程，等退出时再存来不及。
// 账清空就删文件。
func (d *deliveries) persist() {
	if !d.tracking {
		return
	}
	p := redeliveryPath(d.session)
	if p == "" {
		return
	}
	texts := append([]string{}, d.carried...)
	for _, u := range d.pending {
		if u.text != "" {
			texts = append(texts, u.text)
		}
	}
	if len(texts) == 0 {
		_ = os.Remove(p)
		return
	}
	b, _ := json.Marshal(redeliveryFile{Saved: time.Now(), Texts: texts})
	tmp := p + ".tmp"
	if os.MkdirAll(filepath.Dir(p), 0700) != nil || os.WriteFile(tmp, b, 0600) != nil || os.Rename(tmp, p) != nil {
		logLine("event=user-redelivery-unsaved n=" + strconv.Itoa(len(texts)))
	}
}

// prepare 在转出一条 user 之前，把上次没读进、这条里又没带上的正文补在最前面。
func (d *deliveries) prepare(f frame) frame {
	if len(d.carried) == 0 {
		return f
	}
	text := userText(f)
	missing := []string{}
	for _, c := range d.carried {
		if k := core(c); k != "" && !strings.Contains(text, k) {
			missing = append(missing, c)
		}
	}
	logLine("event=user-redelivered n=" + strconv.Itoa(len(missing)) + " already-resent=" + strconv.Itoa(len(d.carried)-len(missing)))
	// 补进这一条以后，账随这一条走（forwarded 记账并写盘），不再单列。
	d.carried = nil
	if len(missing) == 0 {
		return f
	}
	lines := []string{redeliveryHeader}
	for i, c := range missing {
		lines = append(lines, strconv.Itoa(i+1)+". "+c)
	}
	block := strings.Join(lines, "\n")
	m := f.object("message")
	if m == nil {
		return f
	}
	var s string
	if json.Unmarshal(m["content"], &s) == nil {
		m["content"], _ = json.Marshal(block + "\n\n---\n\n" + s)
	} else {
		var blocks []json.RawMessage
		if json.Unmarshal(m["content"], &blocks) != nil {
			return f
		}
		head, _ := json.Marshal(map[string]string{"type": "text", "text": block})
		m["content"], _ = json.Marshal(append([]json.RawMessage{head}, blocks...))
	}
	out := frame{}
	for k, v := range f {
		out[k] = v
	}
	out["message"], _ = json.Marshal(m)
	return out
}

func (d *deliveries) forwarded(f frame, path string, idle bool) {
	logLine("event=user-forward path=" + path + " idle=" + strconv.FormatBool(idle) + " len=" + strconv.Itoa(len(userText(f))) + " unacked=" + strconv.Itoa(d.unacked()))
	if !d.tracking {
		return
	}
	uuid, text := userIdentity(f)
	if uuid == "" && text == "" {
		logLine("event=user-identity-unknown path=" + path + " retained=true")
	}
	d.pending = append(d.pending, &pendingUser{uuid: uuid, text: text, at: time.Now(), idle: idle, quiet: true})
	d.persist()
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

// match 返回回显对上的那一条 pending 的下标，对不上返回 -1。先按 uuid，再按正文精确相等，都取最早的一条。
func (d *deliveries) match(uuid, text string) int {
	if uuid != "" {
		for i, p := range d.pending {
			if p.uuid == uuid {
				return i
			}
		}
	}
	if text == "" {
		return -1
	}
	for i, p := range d.pending {
		// 双方都有 uuid 又不相等，是两条不同的消息，不能因为正文一样就顶替。
		if p.text == text && (p.uuid == "" || uuid == "") {
			return i
		}
	}
	return -1
}

// observe 看执行体的每一帧主线输出：任何输出都说明它没卡死；isReplay 的 user 按身份销账，规则见文件头；
// 主回合 result 之后还没读进的引导，CLI 应当接着就开下一回合读它，从这一刻起按空闲算卡住。
func (d *deliveries) observe(f frame) {
	if len(d.pending) == 0 || f.text("parent_tool_use_id") != "" {
		return
	}
	for _, p := range d.pending {
		p.quiet = false
	}
	if f.text("type") == "result" {
		now := time.Now()
		for _, p := range d.pending {
			if !p.idle && !p.reported && !p.expired {
				p.idle, p.quiet, p.at = true, true, now
			}
		}
		return
	}
	if f.text("type") != "user" || string(f["isReplay"]) != "true" {
		return
	}
	uuid, text := userIdentity(f)
	if i := d.match(uuid, text); i >= 0 {
		p := d.pending[i]
		logLine("event=user-ack ms=" + elapsedMs(p.at) + " reported=" + strconv.FormatBool(p.reported) + " expired=" + strconv.FormatBool(p.expired))
		d.pending = append(d.pending[:i], d.pending[i+1:]...)
		d.persist()
		return
	}
	logLine("event=user-ack-unmatched len=" + strconv.Itoa(len(text)) + " unacked=" + strconv.Itoa(d.unacked()))
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

// lost 在执行体退出、被停或换掉时收账：没确认读进的正文留给下一条消息补发（本进程里接着用，进程没了靠盘上那份）。
// session 是当前原生会话 ID（Mirasim 下次 --resume 用的就是它），账跟着它存。
func (d *deliveries) lost(reason, session string) {
	if n := d.unacked(); n > 0 {
		logLine("event=user-unacked reason=" + reason + " n=" + strconv.Itoa(n))
	}
	for _, p := range d.pending {
		if p.text != "" {
			d.carried = append(d.carried, p.text)
		}
	}
	d.pending = nil
	d.rekey(session)
	d.persist()
}

// rekey 原生会话 ID 变了（新建会话、分叉）就把账挪到新 ID 下。
func (d *deliveries) rekey(session string) {
	if session == "" || session == d.session || !safeID(session) {
		return
	}
	if p := redeliveryPath(d.session); p != "" {
		_ = os.Remove(p)
	}
	d.session = session
	d.persist()
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
