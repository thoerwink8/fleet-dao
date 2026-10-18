package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func recoveryDeliveries(t *testing.T) *deliveries {
	t.Helper()
	// os.UserCacheDir 在 Windows 读 LOCALAPPDATA、Linux 读 XDG_CACHE_HOME、macOS 读 HOME/Library/Caches：三处都隔离，
	// 否则 macOS 上各子测试共用本机真实缓存，上一个留下的目录会挡住下一个。
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	d, err := newDeliveries([]string{"--replay-user-messages", "--session-id", "recovery-session"})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func queuedForTest(t *testing.T, d *deliveries, id, text string) queuedUser {
	t.Helper()
	q, _, err := d.enqueue(userFrame(t, id, text))
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func TestRekeyFailurePreservesDurableSourceAndIdentity(t *testing.T) {
	d := recoveryDeliveries(t)
	q := queuedForTest(t, d, "original-uuid", "synthetic instruction")
	if err := d.send(q, io.Discard, "turn", true); err != nil {
		t.Fatal(err)
	}
	old := redeliveryPath(d.session)
	before, err := os.ReadFile(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(redeliveryPath("blocked-session"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := d.rekey("blocked-session"); err == nil {
		t.Fatal("迁移失败必须返回错误")
	}
	after, err := os.ReadFile(old)
	if err != nil || !bytes.Equal(before, after) || d.session != "recovery-session" || len(d.pending) != 1 || d.pending[0].uuid != "original-uuid" {
		t.Fatalf("失败不能删旧责任、改归属或丢身份：session=%s pending=%+v err=%v", d.session, d.pending, err)
	}
	if err := d.rekey("new-session"); err != nil {
		t.Fatal(err)
	}
	entries, err := loadRedelivery("new-session")
	if err != nil || len(entries) != 1 || entries[0].ID != q.id || entries[0].User.text("uuid") != "original-uuid" || entries[0].State != deliveryUnknown {
		t.Fatalf("迁移必须保留身份和 unknown：%+v %v", entries, err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("新账成功后才应移除旧账：%v", err)
	}
}

func TestEachPersistenceFailureRejectsTransition(t *testing.T) {
	for _, operation := range []string{"enqueue", "send", "ack", "lost", "persist", "reject"} {
		t.Run(operation, func(t *testing.T) {
			d := recoveryDeliveries(t)
			q := queuedForTest(t, d, "original-uuid", "synthetic-private-body")
			if operation == "ack" || operation == "lost" {
				if err := d.send(q, io.Discard, "turn", true); err != nil {
					t.Fatal(err)
				}
			}
			entryBefore, _ := json.Marshal(d.entries)
			pendingBefore := len(d.pending)
			p := redeliveryPath(d.session)
			if err := os.Rename(p, p+".backup"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(p, 0700); err != nil {
				t.Fatal(err)
			}
			var err error
			var written bytes.Buffer
			switch operation {
			case "enqueue":
				_, _, err = d.enqueue(userFrame(t, "next-uuid", "next"))
			case "send":
				err = d.send(q, &written, "turn", true)
			case "ack":
				err = d.observe(echoFrame(t, "original-uuid", "synthetic-private-body"))
			case "lost":
				err = d.lost("exit", d.session)
			case "persist":
				err = d.persist()
			case "reject":
				err = d.reject(q)
			}
			entryAfter, _ := json.Marshal(d.entries)
			if err == nil || !strings.Contains(err.Error(), "消息责任账") || strings.Contains(err.Error(), "synthetic-private-body") || !bytes.Equal(entryBefore, entryAfter) || len(d.pending) != pendingBefore || written.Len() != 0 {
				t.Fatalf("持久失败必须可见且不提交内存/发送：err=%v before=%s after=%s pending=%d bytes=%d", err, entryBefore, entryAfter, len(d.pending), written.Len())
			}
		})
	}
}

func TestUnknownUUIDCannotBeReexecutedByHostResend(t *testing.T) {
	d := recoveryDeliveries(t)
	q := queuedForTest(t, d, "same-original-uuid", "synthetic")
	if err := d.send(q, io.Discard, "turn", true); err != nil {
		t.Fatal(err)
	}
	for _, restart := range []bool{false, true} {
		if restart {
			var err error
			d, err = newDeliveries([]string{"--replay-user-messages", "--resume", d.session})
			if err != nil {
				t.Fatal(err)
			}
		}
		_, _, err := d.enqueue(q.f)
		var unknown *unknownDeliveryReplay
		if !errors.As(err, &unknown) || len(d.entries) != 1 || d.entries[0].ID != q.id || len(d.queued()) != 0 {
			t.Fatalf("同 UUID 的 unknown 不可自动当新条目重放：%+v %v", d, err)
		}
	}
}

func TestSupervisorHostResendOfUnknownDoesNotRepeatSideEffect(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	consumed := filepath.Join(f.home, "consumed")
	a := startReplayApp(t, f, cache, "MIRASIM_TEST_CONSUMED="+consumed)
	input := map[string]any{"type": "user", "uuid": "original-uuid", "message": map[string]any{"role": "user", "content": "consume-no-echo"}}
	a.send(t, input)
	// 初始化已就绪，首个 result 必须确认合成副作用执行成功。
	if r := a.until(t, "result"); r["is_error"] != false {
		t.Fatalf("就绪后首次执行不应先返回交付错误：%v", r)
	}
	a.send(t, input)
	refusal := a.until(t, "result")
	if refusal["is_error"] != true || !strings.Contains(refusal["result"].(string), "同 UUID") {
		t.Fatalf("应明确拒绝 unknown 重送：%v", refusal)
	}
	a.user(t, "next")
	echo := a.until(t, "user")
	if echo["message"].(map[string]any)["content"] != "next" {
		t.Fatalf("后续新消息仍需正常透传：%v", echo)
	}
	a.until(t, "result")
	b, err := os.ReadFile(consumed)
	if err != nil || string(b) != "effect\n" {
		t.Fatalf("相同 UUID 重送导致副作用重复：%q %v", b, err)
	}
}

func TestRejectedQueuedUserIsNotRecoveredOnNextProcess(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	env := []string{"ANTHROPIC_BASE_URL=", "ANTHROPIC_AUTH_TOKEN="}
	a := startReplayApp(t, f, cache, env...)
	a.user(t, "first")
	a.until(t, "user")
	a.until(t, "result")
	f.route(t, "cloud")
	a.user(t, "refused-queued")
	r := a.until(t, "result")
	if r["is_error"] != true || r["result"] != platformSwitchRefusal {
		t.Fatalf("应明确拒绝当前无法使用的平台路由：%v", r)
	}
	_ = a.in.Close()
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	f.route(t, "local")
	b := startReplayAppAs(t, f, cache, "--resume", env...)
	b.user(t, "next")
	echo := b.until(t, "user")
	if echo["message"].(map[string]any)["content"] != "next" {
		t.Fatalf("明确拒绝过的 queued 不可悄悄恢复：%v", echo)
	}
	b.until(t, "result")
}

func TestTrackingWithoutSessionRejectsUserUntilNativeIdentityExists(t *testing.T) {
	_ = recoveryDeliveries(t)
	d, err := newDeliveries([]string{"--replay-user-messages"})
	if err != nil {
		t.Fatal("无 user 的控制/用量探测不应在 constructor 被拒绝", err)
	}
	if _, _, err := d.enqueue(userFrame(t, "u", "synthetic")); err == nil || !strings.Contains(err.Error(), "缺少原生会话 ID") {
		t.Fatalf("无会话不能假存成功：%v", err)
	}
	if err := d.rekey("native-created-before-user"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.enqueue(userFrame(t, "u", "synthetic")); err != nil {
		t.Fatal("控制初始化已提供原生 ID 后可以正常记账", err)
	}
}

type partialDeliveryWriter struct{ noError bool }

func (w partialDeliveryWriter) Write(b []byte) (int, error) {
	if w.noError {
		return len(b) / 2, nil
	}
	return len(b) / 2, errors.New("synthetic partial write")
}

func TestWriteAttemptAndPartialWriteRemainUnknownAfterRestart(t *testing.T) {
	for _, noError := range []bool{false, true} {
		t.Run(map[bool]string{false: "error", true: "short-without-error"}[noError], func(t *testing.T) {
			d := recoveryDeliveries(t)
			q := queuedForTest(t, d, "uuid-1", "synthetic")
			if err := d.send(q, partialDeliveryWriter{noError: noError}, "turn", true); err == nil {
				t.Fatal("部分写入也必须失败")
			}
			restarted, err := newDeliveries([]string{"--replay-user-messages", "--resume", d.session})
			if err != nil || len(restarted.queued()) != 0 || len(restarted.entries) != 1 || restarted.entries[0].State != deliveryUnknown || restarted.entries[0].ID != q.id {
				t.Fatalf("部分写入不能回退成 queued 并自动重发：%+v %v", restarted, err)
			}
		})
	}
}

func TestOldTextCacheIsUnknownAndNeverExpiresSilently(t *testing.T) {
	d := recoveryDeliveries(t)
	p := redeliveryPath(d.session)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	old, _ := json.Marshal(redeliveryFile{Saved: time.Now().Add(-72 * time.Hour), Texts: []string{"synthetic-legacy-command"}})
	if err := os.WriteFile(p, old, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		restarted, err := newDeliveries([]string{"--replay-user-messages", "--resume", d.session})
		if err != nil || len(restarted.queued()) != 0 || len(restarted.entries) != 1 || restarted.entries[0].State != deliveryUnknown {
			t.Fatalf("旧缓存只能是 unknown：%+v %v", restarted, err)
		}
		notice := restarted.recoveryNotice()
		if notice == nil || strings.Contains(notice.text("result"), "synthetic-legacy-command") {
			t.Fatal("告警只能含定位信息，不能泄露正文")
		}
		if err := restarted.persist(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnreadableLedgerIsFailureAndPreservesOriginal(t *testing.T) {
	for _, body := range []string{"broken-json", `{}`, `{"version":1}`, `{"version":2,"entries":[]}`, `{"version":1,"entries":[{"id":"entry","state":"acked","user":{"type":"user"}}]}`} {
		t.Run(body, func(t *testing.T) {
			d := recoveryDeliveries(t)
			p := redeliveryPath(d.session)
			if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := newDeliveries([]string{"--replay-user-messages", "--resume", d.session}); err == nil {
				t.Fatal("读坏账不能当空账继续")
			}
			got, err := os.ReadFile(p)
			if err != nil || string(got) != body {
				t.Fatal("坏账不得自动删掉")
			}
		})
	}
}

func TestQueuedOriginalFrameRecoversOnceAndDeduplicatesUUID(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	t.Setenv("LOCALAPPDATA", filepath.Join(f.home, "cache"))
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("HOME", f.home) // macOS 的缓存在 HOME/Library/Caches，和子进程用同一个 HOME
	d, err := newDeliveries([]string{"--replay-user-messages", "--session-id", f.sid})
	if err != nil {
		t.Fatal(err)
	}
	q := queuedForTest(t, d, "queued-user-uuid", "queued-original")
	// 强杀发生在 queued 已落盘、stdin 尚未尝试写入的边界；下次同 UUID 原帧不再排第二次。
	a := startReplayAppAs(t, f, cache, "--resume")
	var input map[string]any
	b, _ := json.Marshal(q.f)
	if err := json.Unmarshal(b, &input); err != nil {
		t.Fatal(err)
	}
	a.send(t, input)
	echo := a.until(t, "user")
	if got := echo["message"].(map[string]any)["content"]; got != "queued-original" {
		t.Fatalf("queued 必须恢复原帧：%v", echo)
	}
	a.until(t, "result")
	a.user(t, "next")
	echo = a.until(t, "user")
	if got := echo["message"].(map[string]any)["content"]; got != "next" {
		t.Fatalf("queued 同 UUID 不应发两次：%v", echo)
	}
	a.until(t, "result")
	_ = a.in.Close()
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	entries, err := loadRedelivery(f.sid)
	if err != nil || len(entries) != 0 {
		t.Fatalf("两个回执后应清账：%+v %v", entries, err)
	}
}

func TestSupervisorPersistenceFailureIsVisibleBeforeChildInvocation(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	// 父目录是一份普通文件，constructor 的 ReadFile 必须明确拒绝，不启动假执行体。
	// 三个平台的缓存目录都堵上：Linux XDG_CACHE_HOME、Windows LOCALAPPDATA、macOS HOME/Library/Caches。
	for _, dir := range []string{cache, filepath.Join(f.home, "cache"), filepath.Join(f.home, "Library", "Caches")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "reclaude-mirasim"), []byte("blocked"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	invoked := filepath.Join(f.home, "invoked")
	a := startReplayAppUninitializedAs(t, f, cache, "--session-id", "MIRASIM_TEST_INVOKED="+invoked)
	// Windows 对中间目录是文件的 ReadFile 可报不存在；真正保存时仍必须在启动子进程前拒绝。
	_, _ = a.in.Write([]byte("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"synthetic\"}}\n"))
	if err := waitEnded(t, a); err == nil {
		t.Fatal("不能把无法定位/保存责任当成功退出")
	}
	stderr, err := os.ReadFile(filepath.Join(f.home, "stderr"))
	if err != nil || !strings.Contains(string(stderr), "消息责任账") {
		t.Fatalf("宿主必须读到保存失败：%s %v", stderr, err)
	}
	if _, err := os.Stat(invoked); !os.IsNotExist(err) {
		t.Fatal("保存前失败不能启动执行体")
	}
}
