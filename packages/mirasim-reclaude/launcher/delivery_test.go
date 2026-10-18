package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 按 --replay-user-messages 的真实行为回显：读进一条 user 先回显 isReplay，再出这一回合。
// swallow 模拟「写进了管道却没被读进」：不回显、不输出；bg 模拟主回合结束、后台任务还在跑；
// hold 读进后一直跑着不出 result，模拟长回合。
func fakeReplayClaude(sid string) {
	dec, enc := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var f map[string]any
		if err := dec.Decode(&f); err != nil {
			if err != io.EOF {
				os.Exit(9)
			}
			return
		}
		if f["type"] == "control_request" {
			_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": f["request_id"], "response": map[string]any{}}})
			continue
		}
		if f["type"] != "user" {
			continue
		}
		msg, _ := f["message"].(map[string]any)
		text, isText := msg["content"].(string)
		deferredResult := os.Getenv("MIRASIM_TEST_DEFER_RESULT") == "1"
		if deferredResult && (!isText || strings.TrimSpace(text) == "") {
			// 上一轮的 result 晚于新 user 到达；新 user 仍在 CLI 队列里，尚未回显。
			_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "is_error": false})
			continue
		}
		if msg["content"] == "swallow" {
			continue
		}
		if strings.Contains(text, "consume-no-echo") {
			if p := os.Getenv("MIRASIM_TEST_CONSUMED"); p != "" {
				file, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					os.Exit(21)
				}
				_, _ = file.WriteString("effect\n")
				_ = file.Close()
			}
			_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "is_error": false})
			continue
		}
		_ = enc.Encode(map[string]any{"type": "user", "message": msg, "session_id": sid, "parent_tool_use_id": nil, "isReplay": true, "pid": os.Getpid()})
		if (deferredResult && text == "first") || text == "hold" {
			continue
		}
		if msg["content"] == "bg" {
			_ = enc.Encode(map[string]any{"type": "system", "subtype": "task_started", "task_id": "bg-1", "session_id": sid})
		}
		_ = enc.Encode(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{}}, "session_id": sid})
		_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "is_error": false})
	}
}

func startReplayApp(t *testing.T, f fixture, cache string, extraEnv ...string) *app {
	return startReplayAppAs(t, f, cache, "--session-id", extraEnv...)
}

func startReplayAppAs(t *testing.T, f fixture, cache, sessionFlag string, extraEnv ...string) *app {
	t.Helper()
	a := startReplayAppUninitializedAs(t, f, cache, sessionFlag, extraEnv...)
	// 先完成 SDK 初始化，确保执行体已就绪；300ms 仍只检验消息交付，不把冷启动算成卡住。
	a.send(t, map[string]any{"type": "control_request", "request_id": "fixture-initialize", "request": map[string]any{"subtype": "initialize"}})
	r := a.until(t, "control_response")
	response, _ := r["response"].(map[string]any)
	if response["request_id"] != "fixture-initialize" || response["subtype"] != "success" {
		t.Fatalf("执行体初始化未成功：%v", r)
	}
	return a
}

func startReplayAppUninitializedAs(t *testing.T, f fixture, cache, sessionFlag string, extraEnv ...string) *app {
	t.Helper()
	env := append([]string{"MIRASIM_TEST_ROLE=replay", "XDG_CACHE_HOME=" + cache, "RECLAUDE_MIRASIM_DELIVERY_STALL_MS=300"}, extraEnv...)
	return startAppArgs(t, f, []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages", "--model", "claude-sonnet-5", sessionFlag, f.sid, "--settings", `{}`}, env...)
}

func TestUnconfirmedContentKeepsChildAfterPriorTurnResult(t *testing.T) {
	img := []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "synthetic"}}}
	mixed := []any{map[string]any{"type": "text", "text": "看图"}, img[0]}
	for name, content := range map[string]any{"image": img, "mixed": mixed, "empty": ""} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "local")
			cache := filepath.Join(f.home, "xdg-cache")
			a := startReplayApp(t, f, cache, "MIRASIM_TEST_DEFER_RESULT=1")
			a.user(t, "first")
			first := a.until(t, "user")
			a.send(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
			a.until(t, "result") // 旧回合结束，不代表后来的 user 已确认。
			f.route(t, "cloud")
			a.user(t, "next")
			next := a.until(t, "user")
			if first["pid"] != next["pid"] {
				t.Fatalf("未确认内容仍可能在旧执行体排队，不能切进程：%v -> %v", first["pid"], next["pid"])
			}
			_ = a.in.Close()
			if err := waitEnded(t, a); err != nil {
				t.Fatal(err)
			}
			log := launchLogOf(t, f, cache)
			if !strings.Contains(log, "event=user-identity-unknown path=active retained=true") || strings.Contains(log, "event=switch ") || strings.Count(log, "event=launch ") != 1 || strings.Count(log, "event=user-forward ") != 3 || !strings.Contains(log, "event=user-unacked reason=exit n=1") {
				t.Fatalf("未知身份应保留责任、不重放、不切路由：%s", log)
			}
		})
	}
}

func waitLog(t *testing.T, f fixture, cache, want string) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); !strings.Contains(launchLogOf(t, f, cache), want); {
		if time.Now().After(deadline) {
			t.Fatalf("日志里等不到 %q：%s", want, launchLogOf(t, f, cache))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 强杀前是否消费不能靠回显证明：未回显与已消费但回显丢失均保留 unknown，不自动再执行。
func TestUnknownUserSurvivesKilledProcessWithoutAutomaticReplay(t *testing.T) {
	for _, content := range []string{"swallow", "consume-no-echo"} {
		t.Run(content, func(t *testing.T) {
			f := newFixture(t, "local")
			cache := filepath.Join(f.home, "xdg-cache")
			consumed := filepath.Join(f.home, "consumed")
			a := startReplayApp(t, f, cache, "MIRASIM_TEST_CONSUMED="+consumed)
			a.user(t, "first")
			a.until(t, "user")
			a.until(t, "result")
			a.user(t, content)
			if content == "consume-no-echo" {
				a.until(t, "result")
			}
			waitLog(t, f, cache, "event=user-forward path=turn idle=true len="+strconv.Itoa(len(content)))
			_ = a.cmd.Process.Kill()
			<-a.ended
			b := startReplayAppAs(t, f, cache, "--resume", "MIRASIM_TEST_CONSUMED="+consumed)
			next := "next"
			b.user(t, next)
			warning := b.until(t, "result")
			if warning["is_error"] != true || !strings.Contains(warning["result"].(string), "交付状态未知") || strings.Contains(warning["result"].(string), content) {
				t.Fatalf("恢复应明确提示 unknown，不输出原正文：%v", warning)
			}
			echo := b.until(t, "user")
			got, _ := echo["message"].(map[string]any)["content"].(string)
			if got != next {
				t.Fatalf("不能把 unknown 作为新指令拼入：%q", got)
			}
			b.until(t, "result")
			log := launchLogOf(t, f, cache)
			if !strings.Contains(log, "event=user-recovery-unknown n=1") {
				t.Fatalf("新进程要报告历史 unknown 责任：%s", log)
			}
			if content == "consume-no-echo" {
				b, err := os.ReadFile(consumed)
				if err != nil || string(b) != "effect\n" {
					t.Fatalf("副作用只能有一次：%q %v", b, err)
				}
			}
			_ = b.in.Close()
			if err := waitEnded(t, b); err != nil {
				t.Fatal(err)
			}
			t.Setenv("LOCALAPPDATA", filepath.Join(f.home, "cache"))
			t.Setenv("XDG_CACHE_HOME", cache)
			entries, err := loadRedelivery(f.sid)
			if err != nil || len(entries) != 1 || entries[0].State != deliveryUnknown || userText(entries[0].User) != content {
				t.Fatalf("unknown 责任应跨重启保留：%+v %v", entries, err)
			}
		})
	}
}

// 运行中转出去的引导，回合结束了还没读进：从 result 起按空闲算，60 秒（测试里 300ms）后回报错。
func TestSteerStillUnreadAfterResultReturnsVisibleError(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "hold")
	a.until(t, "user")
	a.user(t, "swallow")
	waitLog(t, f, cache, "path=active idle=false len=7")
	a.user(t, "release")
	if r := a.until(t, "result"); r["is_error"] != false {
		t.Fatalf("release 那一回合应正常结束：%v", r)
	}
	r := a.until(t, "result")
	if r["is_error"] != true || r["result"] != deliveryStallMessage {
		t.Fatalf("回合结束后仍没读进的引导要回报错：%v", r)
	}
}

// 10-16 的现场：主回合已结束、后台还在跑，新消息转给了执行体却没被读进。启动器要当场回报错，不能无声挂着。
func TestUnreadUserWhileIdleWithBackgroundReturnsVisibleError(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "bg")
	a.until(t, "result")
	a.user(t, "swallow")
	r := a.until(t, "result")
	if r["is_error"] != true || r["result"] != deliveryStallMessage || r["session_id"] != f.sid {
		t.Fatalf("没送到的消息必须回报错 result：%v", r)
	}
	log := launchLogOf(t, f, cache)
	for _, want := range []string{"event=user-forward path=active idle=true len=7", "event=user-stalled "} {
		if !strings.Contains(log, want) {
			t.Fatalf("日志缺 %q：%s", want, log)
		}
	}
}

func TestEchoedUsersAreAckedWithoutStallError(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "bg")
	a.until(t, "result")
	a.user(t, "after-background")
	echo := a.until(t, "user")
	if echo["isReplay"] != true {
		t.Fatalf("回显必须原样交给 Mirasim：%v", echo)
	}
	if r := a.until(t, "result"); r["is_error"] != false {
		t.Fatalf("回执到了不该报错：%v", r)
	}
	select {
	case x, ok := <-a.frames:
		if ok {
			t.Fatalf("已销账的消息又出了帧：%v", x)
		}
	case <-time.After(700 * time.Millisecond):
	}
	if log := launchLogOf(t, f, cache); strings.Count(log, "event=user-ack ") != 2 || strings.Contains(log, "event=user-stalled") {
		t.Fatalf("两条都应销账、不判卡住：%s", log)
	}
}

// 没确认读进的消息还在旧执行体里时，换路由不能重启它，下一条照常交给同一个执行体。
func TestUnackedUserKeepsCurrentChildAcrossRouteChange(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "first")
	first := a.until(t, "user")
	a.until(t, "result")
	a.user(t, "swallow")
	for deadline := time.Now().Add(3 * time.Second); !strings.Contains(launchLogOf(t, f, cache), "path=turn idle=true len=7"); {
		if time.Now().After(deadline) {
			t.Fatal("swallow 没有转给执行体")
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.route(t, "cloud")
	a.user(t, "next")
	next := a.until(t, "user")
	if next["pid"] != first["pid"] {
		t.Fatalf("有未销账的消息时不能换执行体：%v vs %v", next, first)
	}
	_ = a.in.Close()
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	log := launchLogOf(t, f, cache)
	if strings.Count(log, "event=launch ") != 1 || strings.Contains(log, "event=switch ") || !strings.Contains(log, "event=user-unacked reason=exit n=1") {
		t.Fatalf("未销账时不能重选路重启，退出时要记下没送到的条数：%s", log)
	}
}

// 以下是回显与待确认消息的关联规则（见 delivery.go 文件头），直接测 deliveries，不起启动器。
func userFrame(t *testing.T, uuid string, content any) frame {
	t.Helper()
	m := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	if uuid != "" {
		m["uuid"] = uuid
	}
	b, _ := json.Marshal(m)
	f, err := parseFrame(b)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func echoFrame(t *testing.T, uuid string, content any) frame {
	f := userFrame(t, uuid, content)
	f["isReplay"] = json.RawMessage("true")
	return f
}

func trackedDeliveries(t *testing.T, frames ...frame) *deliveries {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir())
	d := &deliveries{tracking: true, stallAfter: time.Minute, session: "delivery-test-session"}
	for _, f := range frames {
		q, _, err := d.enqueue(f)
		if err != nil {
			t.Fatal(err)
		}
		if err := d.send(q, io.Discard, "active", true); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func pendingTexts(d *deliveries) []string {
	out := []string{}
	for _, p := range d.pending {
		out = append(out, p.text)
	}
	return out
}

func TestOnlySecondEchoAcksOnlySecondMessage(t *testing.T) {
	short, long := "继续", "继续原任务，先不要改配置"
	for name, order := range map[string][]string{"短在前": {short, long}, "长在前": {long, short}} {
		t.Run(name, func(t *testing.T) {
			d := trackedDeliveries(t, userFrame(t, "", order[0]), userFrame(t, "", order[1]))
			d.observe(echoFrame(t, "", order[1]))
			if got := pendingTexts(d); len(got) != 1 || got[0] != order[0] {
				t.Fatalf("只收到第二条的精确回显，只能销第二条，第一条仍 pending：%v", got)
			}
			if d.unacked() != 1 || !d.blocking() {
				t.Fatalf("第一条没确认，执行体不能算空闲：unacked=%d", d.unacked())
			}
		})
	}
}

func TestEchoMustEqualNotContainPendingMessage(t *testing.T) {
	for name, echo := range map[string]any{
		"回显包含待确认正文":  "继续原任务，先不要改配置",
		"前缀包装":       "[引导] 继续",
		"后缀包装":       "继续 （已读）",
		"完全不匹配":      "另一件事",
		"空回显":        "",
		"只有图片":       []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}},
		"文本加图片的混合内容": []any{map[string]any{"type": "text", "text": "继续"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}},
		"文本块拼接后只是子串": []any{map[string]any{"type": "text", "text": "继续"}, map[string]any{"type": "text", "text": "原任务"}},
	} {
		t.Run(name, func(t *testing.T) {
			d := trackedDeliveries(t, userFrame(t, "", "继续"))
			d.observe(echoFrame(t, "", echo))
			if len(d.pending) != 1 {
				t.Fatalf("不精确相等的回显不能销账：%v", pendingTexts(d))
			}
		})
	}
	// 唯一允许的包装规则：首尾空白不算。
	d := trackedDeliveries(t, userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", " 继续\n"))
	if len(d.pending) != 0 {
		t.Fatal("只差首尾空白的回显应当销账")
	}
}

func TestOneEchoAcksAtMostOneOfDuplicateMessages(t *testing.T) {
	d := trackedDeliveries(t, userFrame(t, "", "继续"), userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 1 {
		t.Fatalf("同正文两条，一次回显只能销一条：%d", len(d.pending))
	}
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 0 {
		t.Fatal("第二次回显销第二条")
	}
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 0 {
		t.Fatal("多余的回显不能凭空销别的")
	}
}

func TestUUIDIdentityBeatsTextAndNeverCrossAcks(t *testing.T) {
	// 回显带 uuid：销的是 uuid 相同那条，不是更早的同正文无 uuid 消息。
	d := trackedDeliveries(t, userFrame(t, "", "继续"), userFrame(t, "u2", "继续"))
	d.observe(echoFrame(t, "u2", "继续"))
	if len(d.pending) != 1 || d.pending[0].uuid != "" {
		t.Fatalf("应只销 uuid=u2 那条：%+v", d.pending)
	}
	// 双方 uuid 不同，正文一样也不是同一条。
	d = trackedDeliveries(t, userFrame(t, "u1", "继续"))
	d.observe(echoFrame(t, "other", "继续"))
	if len(d.pending) != 1 {
		t.Fatal("uuid 不同不能靠正文顶替")
	}
	// 带 uuid 的图片消息：正文不可用，只能靠 uuid 销账。
	img := []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	d = trackedDeliveries(t, userFrame(t, "img1", img), userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", img))
	if len(d.pending) != 2 {
		t.Fatal("没有 uuid 的纯图片回显不能销任何一条")
	}
	d.observe(echoFrame(t, "img1", img))
	if got := pendingTexts(d); len(got) != 1 || got[0] != "继续" {
		t.Fatalf("按 uuid 只销图片那条：%v", got)
	}
}

func TestMessagesWithoutIdentityRemainPendingWithoutFalseAck(t *testing.T) {
	img := []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	mixed := []any{map[string]any{"type": "text", "text": "看图"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	d := trackedDeliveries(t, userFrame(t, "", ""), userFrame(t, "", "  \n"), userFrame(t, "", img))
	if len(d.pending) != 3 || !d.blocking() {
		t.Fatalf("空正文、纯图片且无 uuid 仍保留责任：%v", pendingTexts(d))
	}
	d.observe(echoFrame(t, "", ""))
	d.observe(echoFrame(t, "", img))
	if len(d.pending) != 3 || !d.blocking() {
		t.Fatal("无法关联的回显不能凭空销账")
	}
	// 混合内容无 uuid：保留责任，其回显不能当成纯文本“看图”去销别的消息。
	d = trackedDeliveries(t, userFrame(t, "", mixed), userFrame(t, "", "看图"))
	if len(d.pending) != 2 {
		t.Fatalf("混合内容和纯文本都保留责任：%v", pendingTexts(d))
	}
	d.observe(echoFrame(t, "", mixed))
	if len(d.pending) != 2 {
		t.Fatal("混合内容的回显不能销纯文本“看图”")
	}
	d.observe(echoFrame(t, "", "看图"))
	if len(d.pending) != 1 || !d.blocking() {
		t.Fatal("纯文本回显只能销纯文本，混合内容仍未确认")
	}
}

func TestUnknownIdentityKeepsExistingStallAndExpiry(t *testing.T) {
	d := trackedDeliveries(t, userFrame(t, "", ""))
	at := d.pending[0].at
	if got := d.due(at.Add(d.stallAfter)); len(got) != 1 || !d.blocking() {
		t.Fatal("空闲转出的未知消息仍应明确报错，报错不等于已确认")
	}
	if got := d.due(at.Add(d.stallAfter)); len(got) != 0 {
		t.Fatal("同一条消息只报错一次")
	}
	d.due(at.Add(deliveryExpireAfter))
	if d.blocking() || len(d.pending) != 1 || !d.pending[0].expired {
		t.Fatal("沿用原有过期释放，不假装销账成功")
	}
}

func TestNonReplayAndSubagentFramesNeverAck(t *testing.T) {
	d := trackedDeliveries(t, userFrame(t, "", "继续"))
	d.observe(userFrame(t, "", "继续"))
	sub := echoFrame(t, "", "继续")
	sub.set("parent_tool_use_id", "toolu_1")
	d.observe(sub)
	if len(d.pending) != 1 {
		t.Fatal("非 isReplay 或子代理帧不能销账")
	}
}
