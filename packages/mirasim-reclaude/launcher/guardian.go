package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"time"
)

type childSpec struct {
	Target string   `json:"target"`
	Args   []string `json:"args"`
	Env    []string `json:"env"`
}

type controlMessage struct {
	Kind string `json:"kind"`
	Data []byte `json:"data,omitempty"`
}
type controlWriter struct{ pipe io.WriteCloser }

func (w *controlWriter) Write(b []byte) (int, error) {
	n := 0
	for len(b) > 0 {
		take := len(b)
		if take > 64<<10 {
			take = 64 << 10
		}
		if err := json.NewEncoder(w.pipe).Encode(controlMessage{Kind: "data", Data: b[:take]}); err != nil {
			return n, err
		}
		n += take
		b = b[take:]
	}
	return n, nil
}
func (w *controlWriter) endInput() error {
	return json.NewEncoder(w.pipe).Encode(controlMessage{Kind: "stdin_end"})
}
func (w *controlWriter) Close() error { return w.pipe.Close() }

// 只在一次会话里活着；父进程被 SIGKILL 时，控制管道 EOF 仍触发整树收尾。
func guardian() int {
	if err := protectProcess(); err != nil {
		fmt.Fprintln(os.Stderr, "执行体进程保护失败")
		return 127
	}
	r := bufio.NewReaderSize(os.Stdin, 4096)
	b, err := r.ReadBytes('\n')
	if err != nil || len(b) > 8<<20 {
		fmt.Fprintln(os.Stderr, "启动控制帧读取失败")
		return 127
	}
	var spec childSpec
	if json.Unmarshal(b, &spec) != nil || spec.Target == "" {
		fmt.Fprintln(os.Stderr, "启动控制帧格式错误")
		return 127
	}
	c := exec.Command(spec.Target, spec.Args...)
	c.Env = spec.Env
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	configureTarget(c)
	in, err := c.StdinPipe()
	if err != nil {
		return 127
	}
	if err = c.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "reclaude 目标启动失败")
		return 127
	}
	ended := make(chan error, 1)
	go func() { ended <- c.Wait() }()
	parentGone := make(chan struct{})
	go func() {
		decoder := json.NewDecoder(r)
		for {
			var message controlMessage
			if err := decoder.Decode(&message); err != nil {
				break
			}
			switch message.Kind {
			case "data":
				if _, err := in.Write(message.Data); err != nil {
					_ = in.Close()
					close(parentGone)
					return
				}
			case "stdin_end":
				_ = in.Close()
			default:
				_ = in.Close()
				close(parentGone)
				return
			}
		}
		_ = in.Close()
		close(parentGone)
	}()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, terminationSignals()...)
	defer signal.Stop(signals)
	select {
	case err := <-ended:
		terminateTree(c)
		return processExitCode(err)
	case <-parentGone:
	case <-signals:
	}
	_ = in.Close()
	gracefulTree(c)
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
	}
	terminateTree(c)
	return 0
}

func processExitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return 1
}
