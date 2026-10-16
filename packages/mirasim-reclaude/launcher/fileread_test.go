package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// replaceAtomically 像 Mirasim 一样用 rename 替换文件。Windows 旧语义下目标正被读着（句柄开着）时替换会失败，
// 隔 10ms 重试，最多 1 秒：测试要的是「替换最终发生」，不是撞上读的那一瞬。
func replaceAtomically(tmp, path string) {
	for i := 0; i < 100; i++ {
		if os.Rename(tmp, path) == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 读到别的进程写一半的索引：解析失败后重读，换成完整文件就能拿到。
// 替换发生在第一次解析失败、下一次重读之前，不跟 goroutine 调度抢重试窗口。
func TestReadJSONFileRetriesHalfWrittenFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "index.json")
	if err := os.WriteFile(p, []byte(`{"routes":{"claude:x":"lo`), 0600); err != nil {
		t.Fatal(err)
	}
	replaced := 0
	beforeJSONRetry = func() {
		replaced++
		if replaced != 1 {
			return
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, []byte(`{"routes":{"claude:x":"local"}}`), 0600); err != nil {
			t.Errorf("写完整文件：%v", err)
			return
		}
		replaceAtomically(tmp, p)
	}
	t.Cleanup(func() { beforeJSONRetry = nil })
	var d struct {
		Routes map[string]string `json:"routes"`
	}
	if err := readJSONFile(p, &d); err != nil || d.Routes["claude:x"] != "local" {
		t.Fatalf("写一半时应重读拿到完整内容：%v %v", d, err)
	}
	if replaced < 1 {
		t.Fatal("第一次应撞上半截并重读")
	}
}

// 一直是坏的：重读 3 次后明确失败（不当成空），不存在则直接报不存在、不重试。
func TestReadJSONFileFailsAfterRetries(t *testing.T) {
	p := filepath.Join(t.TempDir(), "index.json")
	if err := os.WriteFile(p, []byte(`{broken`), 0600); err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	at := time.Now()
	err := readJSONFile(p, &d)
	if err == nil || !isParseFailure(err) {
		t.Fatalf("坏 JSON 应明确失败：%v", err)
	}
	if time.Since(at) < 3*transientRetryDelay {
		t.Fatalf("应重读 3 次再失败，只用了 %v", time.Since(at))
	}
	at = time.Now()
	if err := readJSONFile(filepath.Join(filepath.Dir(p), "missing.json"), &d); !isNotExist(err) || time.Since(at) > transientRetryDelay {
		t.Fatalf("不存在应立即报不存在：%v", err)
	}
}
