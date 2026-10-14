//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 启动器开着索引读的时候，Mirasim 照样能用 rename 原子替换它（要 FILE_SHARE_DELETE）。
func TestSharedReadDoesNotBlockMirasimRename(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "index.json")
	if err := os.WriteFile(p, []byte(`{"routes":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := openShared(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tmp := filepath.Join(dir, "index.json.tmp")
	if err := os.WriteFile(tmp, []byte(`{"routes":{"claude:x":"cloud"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		t.Fatalf("启动器读着索引时 Mirasim 的原子替换失败：%v", err)
	}
	// 对照：Go 自带的 os.Open 不放开删除共享，会挡住替换（证明上面的测试确实测到了共享标志）。
	g, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := os.WriteFile(tmp, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err == nil {
		t.Log("对照不成立：这台 Windows 的 os.Open 已不挡 rename（POSIX 语义）")
	}
}
