//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 启动器开着索引读的时候，句柄要放开删除共享：Mirasim 删除/替换它时不是共享冲突。
// 只断言 FILE_SHARE_DELETE 本身保证的事（开着也能删）。「开着时被 rename 覆盖」还取决于系统是否用 POSIX 语义
// （旧语义下目标只要有句柄开着就拒绝替换，和共享标志无关），只记日志不断言；读完立刻关句柄，替换窗口只有读的那一瞬。
func TestSharedReadAllowsDeleteWhileOpen(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "index.json")
	if err := os.WriteFile(p, []byte(`{"routes":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := openShared(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		_ = f.Close()
		t.Fatalf("开着共享句柄时删不掉，说明没放开删除共享：%v", err)
	}
	_ = f.Close()

	if err := os.WriteFile(p, []byte(`{"routes":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	g, err := openShared(p)
	if err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "index.json.tmp")
	if err := os.WriteFile(tmp, []byte(`{"routes":{"claude:x":"cloud"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		t.Logf("这台 Windows 不允许覆盖开着的文件（旧 rename 语义）：%v", err)
	}
	_ = g.Close()
	// 句柄关掉以后替换一定成功，读到的是新内容。
	if err := os.WriteFile(tmp, []byte(`{"routes":{"claude:x":"local"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		t.Fatalf("句柄关掉后替换仍失败，读完没有关句柄：%v", err)
	}
	var d struct {
		Routes map[string]string `json:"routes"`
	}
	if err := readJSONFile(p, &d); err != nil || d.Routes["claude:x"] != "local" {
		t.Fatalf("替换后读到的不是新内容：%v %v", d, err)
	}
}
