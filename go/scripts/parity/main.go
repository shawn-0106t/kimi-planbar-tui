// Cross-edition self-check diff (SPEC §22.1), the Go-native port of
// ts/test/parity/diff.ts (PLAN-GO §5.2).
//
// Runs the headless self-checks of both editions back to back on this machine
// and compares the text. Only the `fetchedAt` *value* is normalized: the Rust
// build stamps nanoseconds from a 100 ns Windows clock, the Go port derives
// its stamp from milliseconds, so the two can never agree on that field.
// Everything else must be byte-identical.
//
// Usage (from go/):
//
//	go run ./scripts/parity                              # dev tree vs Rust debug build
//	go run ./scripts/parity --go-exe dist/kpt-tui-go.exe # check a compiled build
//
// Exit codes: 2 = missing Rust build, 1 = parity broken, 0 = identical.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if ee, ok := err.(exitError); ok {
			os.Exit(ee.code)
		}
		os.Exit(1)
	}
}

func run(args []string) error {
	repo, err := filepath.Abs(filepath.Join(".."))
	if err != nil {
		return err
	}
	rustExe := envOr("KPT_RUST_EXE", filepath.Join(repo, "rust", "target", "debug", "kimi-planbar-tui.exe"))
	if _, err := os.Stat(rustExe); err != nil {
		return exitError{code: 2, msg: fmt.Sprintf("missing Rust build: %s (run `cargo build` in rust/)", rustExe)}
	}

	goExe := ""
	for i, a := range args {
		if a == "--go-exe" && i+1 < len(args) {
			goExe = args[i+1]
		}
	}

	failures := 0
	for _, flag := range []string{"--test-fetch", "--test-update"} {
		rustOut, err := runExe(nil, rustExe, flag)
		if err != nil {
			return err
		}
		var goOut string
		if goExe != "" {
			goOut, err = runExe(nil, goExe, flag)
		} else {
			goOut, err = runExe([]string{"."}, "go", "run", ".", flag) // cwd stays in go/
		}
		if err != nil {
			return err
		}
		rustN, goN := normalize(rustOut), normalize(goOut)
		lines := diff(rustN, goN)
		if len(lines) == 0 {
			lineCount := len(strings.Split(strings.TrimRight(rustN, "\n"), "\n"))
			fmt.Printf("%s: identical (%d lines)\n", flag, lineCount)
			continue
		}
		failures++
		fmt.Printf("%s: DIFFERS\n%s\n", flag, strings.Join(lines, "\n"))
	}
	if failures > 0 {
		return exitError{code: 1, msg: fmt.Sprintf("parity check failed (%d self-check(s) differ)", failures)}
	}
	if goExe != "" {
		fmt.Println("compiled exe matches the Rust edition")
	} else {
		fmt.Println("go edition matches the Rust edition")
	}
	return nil
}

type exitError struct {
	code int
	msg  string
}

func (e exitError) Error() string { return e.msg }

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var fetchedAtRe = regexp.MustCompile(`"fetchedAt": "[^"]*"`)

func normalize(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return fetchedAtRe.ReplaceAllString(text, `"fetchedAt": "<NOW>"`)
}

func runExe(dir []string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	if len(dir) > 0 {
		cmd.Dir = dir[0]
	}
	var out, errOut strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s exited: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(errOut.String()))
	}
	return out.String(), nil
}

func diff(a, b string) []string {
	left, right := strings.Split(a, "\n"), strings.Split(b, "\n")
	var lines []string
	for i := 0; i < len(left) || i < len(right); i++ {
		var l, r string
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if l == r {
			continue
		}
		lines = append(lines, fmt.Sprintf("line %d:", i+1), "  - rust : "+l, "  + go   : "+r)
	}
	return lines
}
