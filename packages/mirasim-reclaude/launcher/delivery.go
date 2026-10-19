package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
//     给 Mirasim 回一个报错 result，让它当场显示交付未知，不再无声地挂着；
//   - 入队时持久化 queued，stdin 写前先持久化 unknown；只有 queued 证明未尝试发送，重启可恢复原帧；
//   - 无回显不证明未消费：unknown 与旧版正文缓存只提示人工核对，不自动重放、不偷偷拼入下一条消息；
//   - 过了 expireAfter 仍没回显（比如这一版 CLI 对某类输入不回显），不再挡路由，只记日志。
// 日志只记条数、毫秒数和长度，不记内容；完整责任只存本机缓存（0600），回执销账失败明确报错，不按时间删 unknown。
//
// 回显怎么对上是哪一条（一次有效回显最多销一条，绝不按子串）：
//  1. 转出的 user 帧带 uuid、回显也带 uuid：只按 uuid 相等对；uuid 不同就是别的消息，哪怕正文一样。
//  2. 否则按正文精确相等：两边都只有 text（字符串或全是 text 块），各自只去掉首尾空白后逐字相等，
//     同正文有多条时销最早那条。回显多了前后缀、少了字、只是包含，都不算。
//  3. 带图片等非 text 块、或正文为空的，没有 uuid 就无法判定是哪一条：仍保留未确认责任，
//     记 event=user-identity-unknown，保护当前执行体直到原有过期边界；不能用空正文销账。有 uuid 的照常按 1 记账。
//
// CLI 是否回显 uuid 由协议决定，这里不假定：转出去的帧没带 uuid 就只走 2。
// 缓存保留完整 user 帧，包括不能靠正文关联的图片；消息 ID 与原始 uuid 分别保留。

const deliveryStallMessage = "启动器已尝试把这条消息交给 Claude Code，但尚未收到回显或后续输出，交付状态未知，不能据此判断是否已执行。消息责任已保存在本机；请先核对原会话记录，再决定是否重新发送。重启不会自动重放状态未知的消息。"

var deliveryExpireAfter = 10 * time.Minute

func deliveryStallAfter() time.Duration {
	if ms, err := strconv.Atoi(os.Getenv("RECLAUDE_MIRASIM_DELIVERY_STALL_MS")); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 60 * time.Second
}

type pendingUser struct {
	id       string // 本机责任条目，独立于 CLI 是否提供 uuid
	uuid     string // 转出的 user 帧自带的 uuid；没有则空
	text     string // 纯文本正文（去首尾空白）；带非 text 块或为空时为空，只能靠 uuid 对
	at       time.Time
	idle     bool // 转出时执行体空闲（没有在跑的回合），或转出后回合已经结束：这时 CLI 应当立刻读进并回显
	quiet    bool // 从 at 起执行体还没有任何输出
	reported bool
	expired  bool
}

type deliveries struct {
	tracking         bool
	stallAfter       time.Duration
	pending          []*pendingUser
	session          string
	entries          []deliveryEntry
	recoveredUnknown []string
}

const deliveryQueued = "queued"
const deliveryUnknown = "unknown"

type deliveryEntry struct {
	ID    string `json:"id"`
	State string `json:"state"`
	User  frame  `json:"user"`
}

type queuedUser struct {
	f  frame
	id string
}

type unknownDeliveryReplay struct{ session, id string }

func (e *unknownDeliveryReplay) Error() string {
	return fmt.Sprintf("会话 %q 的条目 %s 交付状态未知，同 UUID 的消息未再次发送。请先核对原会话；确定要重发时使用新的用户动作和新 UUID。", e.session, e.id)
}

type redeliveryFile struct {
	Version int             `json:"version"`
	Saved   time.Time       `json:"saved"`
	Entries []deliveryEntry `json:"entries"`
	Texts   []string        `json:"texts,omitempty"` // 旧版没有发送状态，只能迁移为 unknown
}

func newDeliveries(args []string) (*deliveries, error) {
	d := &deliveries{tracking: hasFlag(args, "--replay-user-messages"), stallAfter: deliveryStallAfter(), session: sessionArgument(args)}
	if d.tracking && d.session != "" {
		var err error
		d.entries, err = loadRedelivery(d.session)
		if err != nil {
			return nil, err
		}
		for _, entry := range d.entries {
			if entry.State == deliveryUnknown {
				d.recoveredUnknown = append(d.recoveredUnknown, entry.ID)
			}
		}
	}
	return d, nil
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

func redeliveryPath(session string) string {
	dir, err := os.UserCacheDir()
	if err != nil || session == "" || !safeID(session) {
		return ""
	}
	return filepath.Join(dir, "reclaude-mirasim", "unacked", session+".json")
}

func deliveryError(session, operation string, causes ...error) error {
	reason := ""
	if len(causes) > 0 && causes[0] != nil {
		cause := causes[0]
		var pathErr *os.PathError
		var linkErr *os.LinkError
		if errors.As(cause, &pathErr) {
			cause = pathErr.Err
		}
		if errors.As(cause, &linkErr) {
			cause = linkErr.Err
		}
		reason = "：" + cause.Error()
	}
	return fmt.Errorf("消息责任账 %s 失败（会话 %q）%s；未继续发送或迁移，请检查本机缓存 reclaude-mirasim/unacked，保留原件后恢复", operation, session, reason)
}

func loadRedelivery(session string) ([]deliveryEntry, error) {
	p := redeliveryPath(session)
	if p == "" {
		return nil, deliveryError(session, "定位")
	}
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, deliveryError(session, "读取", err)
	}
	var saved redeliveryFile
	if json.Unmarshal(b, &saved) != nil {
		return nil, deliveryError(session, "解析")
	}
	if saved.Version == 0 && saved.Texts != nil && len(saved.Entries) == 0 {
		for i, text := range saved.Texts {
			u := frame{}
			u.set("type", "user")
			u["message"], _ = json.Marshal(map[string]any{"role": "user", "content": text})
			id := fmt.Sprintf("legacy-%x", sha256.Sum256([]byte(strconv.Itoa(i)+"\x00"+text)))
			saved.Entries = append(saved.Entries, deliveryEntry{ID: id, State: deliveryUnknown, User: u})
		}
	} else if saved.Version != 1 {
		return nil, deliveryError(session, "版本校验")
	}
	if saved.Version == 1 {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(b, &fields)
		if _, ok := fields["entries"]; !ok || saved.Saved.IsZero() {
			return nil, deliveryError(session, "结构校验")
		}
	}
	seen := map[string]bool{}
	for _, entry := range saved.Entries {
		if entry.ID == "" || seen[entry.ID] || (entry.State != deliveryQueued && entry.State != deliveryUnknown) || entry.User.text("type") != "user" || entry.User.object("message") == nil {
			return nil, deliveryError(session, "条目校验")
		}
		seen[entry.ID] = true
	}
	return saved.Entries, nil
}

// 保存成功才提交内存状态；空账也写盘，避免删除失败留下已确认的旧责任。
// Sync 覆盖进程强杀前的数据写入，不承诺所有平台断电时目录 rename 的持久性。
func saveRedelivery(session string, entries []deliveryEntry) error {
	p := redeliveryPath(session)
	if p == "" {
		return deliveryError(session, "定位")
	}
	b, err := json.Marshal(redeliveryFile{Version: 1, Saved: time.Now(), Entries: entries})
	if err != nil {
		return deliveryError(session, "编码", err)
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return deliveryError(session, "建目录", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".delivery-*")
	if err != nil {
		return deliveryError(session, "建临时文件", err)
	}
	defer os.Remove(tmp.Name())
	err = tmp.Chmod(0600)
	if err == nil {
		_, err = tmp.Write(b)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return deliveryError(session, "写入", err)
	}
	if err = os.Rename(tmp.Name(), p); err != nil {
		return deliveryError(session, "替换", err)
	}
	return nil
}

func (d *deliveries) commit(entries []deliveryEntry) error {
	if d.tracking {
		if err := saveRedelivery(d.session, entries); err != nil {
			return err
		}
	}
	d.entries = entries
	return nil
}

func (d *deliveries) persist() error { return d.commit(d.entries) }

func (d *deliveries) queued() []queuedUser {
	out := []queuedUser{}
	for _, entry := range d.entries {
		if entry.State == deliveryQueued {
			out = append(out, queuedUser{f: entry.User, id: entry.ID})
		}
	}
	return out
}

// 只有有可靠 uuid 的同一排队消息可以去重；相同正文的两条无 uuid 消息仍是两条。
func (d *deliveries) enqueue(f frame) (queuedUser, bool, error) {
	if !d.tracking {
		return queuedUser{f: f}, true, nil
	}
	if d.session == "" {
		return queuedUser{}, false, fmt.Errorf("消息责任账缺少原生会话 ID：user 发送前需要 --session-id/--resume 或执行体 system 会话标识；本条未发送")
	}
	for _, entry := range d.entries {
		if f.text("uuid") != "" && entry.User.text("uuid") == f.text("uuid") {
			a, _ := json.Marshal(entry.User)
			b, _ := json.Marshal(f)
			if string(a) != string(b) {
				return queuedUser{}, false, deliveryError(d.session, "重复身份校验")
			}
			if entry.State == deliveryUnknown {
				return queuedUser{}, false, &unknownDeliveryReplay{session: d.session, id: entry.ID}
			}
			return queuedUser{f: entry.User, id: entry.ID}, false, nil
		}
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return queuedUser{}, false, deliveryError(d.session, "生成身份")
	}
	entry := deliveryEntry{ID: fmt.Sprintf("%x", id), State: deliveryQueued, User: f}
	if err := d.commit(append(append([]deliveryEntry{}, d.entries...), entry)); err != nil {
		return queuedUser{}, false, err
	}
	return queuedUser{f: f, id: entry.ID}, true, nil
}

// 已明确拒绝的 queued 不得在下次进程中自动恢复；先持久销账，再向宿主回拒绝。
func (d *deliveries) reject(q queuedUser) error {
	if !d.tracking {
		return nil
	}
	entries := []deliveryEntry{}
	found := false
	for _, entry := range d.entries {
		if entry.ID == q.id && entry.State == deliveryQueued {
			found = true
			continue
		}
		entries = append(entries, entry)
	}
	if !found {
		return deliveryError(d.session, "拒绝责任校验")
	}
	return d.commit(entries)
}

// stdin 的任何写入前先持久化 unknown：写失败可能只写了一部分，不能退回 queued。
func (d *deliveries) send(q queuedUser, w io.Writer, path string, idle bool) error {
	f := q.f
	if !d.tracking {
		return writeFrame(w, f)
	}
	entries := append([]deliveryEntry{}, d.entries...)
	found := false
	for i := range entries {
		if entries[i].ID == q.id && entries[i].State == deliveryQueued {
			entries[i].State = deliveryUnknown
			found = true
			break
		}
	}
	if !found {
		return deliveryError(d.session, "发送责任校验")
	}
	if err := d.commit(entries); err != nil {
		return err
	}
	uuid, text := userIdentity(f)
	if uuid == "" && text == "" {
		logLine("event=user-identity-unknown path=" + path + " retained=true")
	}
	d.pending = append(d.pending, &pendingUser{id: q.id, uuid: uuid, text: text, at: time.Now(), idle: idle, quiet: true})
	if err := writeFrame(w, f); err != nil {
		return err
	}
	logLine("event=user-forward path=" + path + " idle=" + strconv.FormatBool(idle) + " len=" + strconv.Itoa(len(userText(f))) + " unacked=" + strconv.Itoa(d.unacked()))
	return nil
}

func (d *deliveries) recoveryNotice() frame {
	if len(d.recoveredUnknown) == 0 {
		return nil
	}
	f := stallResult(d.session)
	f.set("result", fmt.Sprintf("原生会话 %q 有 %d 条历史消息的交付状态未知（条目 %s），未自动重放。请在本机缓存 %s 核对 user 与原会话记录，确认未执行后才通过 Mirasim 重新发送；处理后保留备份并归档这些条目。新消息不包含历史指令。", d.session, len(d.recoveredUnknown), strings.Join(d.recoveredUnknown, ","), redeliveryPath(d.session)))
	logLine("event=user-recovery-unknown n=" + strconv.Itoa(len(d.recoveredUnknown)))
	d.recoveredUnknown = nil
	return f
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
func (d *deliveries) observe(f frame) error {
	if len(d.pending) == 0 || f.text("parent_tool_use_id") != "" {
		return nil
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
		return nil
	}
	if f.text("type") != "user" || string(f["isReplay"]) != "true" {
		return nil
	}
	uuid, text := userIdentity(f)
	if i := d.match(uuid, text); i >= 0 {
		p := d.pending[i]
		entries := []deliveryEntry{}
		for _, entry := range d.entries {
			if entry.ID != p.id {
				entries = append(entries, entry)
			}
		}
		if err := d.commit(entries); err != nil {
			return err
		}
		logLine("event=user-ack ms=" + elapsedMs(p.at) + " reported=" + strconv.FormatBool(p.reported) + " expired=" + strconv.FormatBool(p.expired))
		d.pending = append(d.pending[:i], d.pending[i+1:]...)
		return nil
	}
	logLine("event=user-ack-unmatched len=" + strconv.Itoa(len(text)) + " unacked=" + strconv.Itoa(d.unacked()))
	return nil
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

// lost 在执行体退出、被停或换掉时收账：未确认责任保留 unknown，不自动重发。
// session 是当前原生会话 ID（Mirasim 下次 --resume 用的就是它），账跟着它存。
func (d *deliveries) lost(reason, session string) error {
	if n := d.unacked(); n > 0 {
		logLine("event=user-unacked reason=" + reason + " n=" + strconv.Itoa(n))
	}
	if err := d.rekey(session); err != nil {
		return err
	}
	if err := d.persist(); err != nil {
		return err
	}
	d.pending = nil
	return nil
}

// rekey 原生会话 ID 变了（新建会话、分叉）就把账挪到新 ID 下。
func (d *deliveries) rekey(session string) error {
	if session == "" || session == d.session {
		return nil
	}
	if !safeID(session) {
		return deliveryError(session, "会话身份校验")
	}
	if d.tracking {
		// 不能覆盖另一个会话已存在的责任；新账完整写成前绝不删旧账。
		if _, err := os.Lstat(redeliveryPath(session)); err == nil || !os.IsNotExist(err) {
			return deliveryError(session, "迁移目标校验")
		}
		if err := saveRedelivery(session, d.entries); err != nil {
			return err
		}
		if p := redeliveryPath(d.session); p != "" {
			if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
				return deliveryError(d.session, "迁移旧账清理", err)
			}
		}
	}
	d.session = session
	return nil
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
