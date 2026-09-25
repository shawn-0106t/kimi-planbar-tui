// Golden fixture helpers, ported from ts/test/goldens.ts. The goldens are
// Rust-oracle artifacts (ts/test/parity/make-oracle.ts); Go consumes them
// verbatim with the same normalization (CRLF tolerance) as the TS harness.
package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Relative to the package dir, which is where `go test` runs. Forward
// slashes are accepted by the Windows file APIs too.
const goldensDir = "../../testdata/golden"

func goldenText(name string) string {
	path := filepath.Join(goldensDir, name+".txt")
	b, err := os.ReadFile(path)
	if err != nil {
		panic("missing golden " + name + " (copy from ts/test/golden)")
	}
	// The goldens are byte fixtures, so a checkout that rewrites line
	// endings (core.autocrlf) must not be allowed to fail a comparison.
	return strings.ReplaceAll(string(b), "\r\n", "\n")
}

var goldenPairRe = regexp.MustCompile(`\[\s*"([^"]+)",\s*(-?[^\]\n]+?)\s*\]`)

// goldenPairs extracts pairs of [label, rawNumberText] from a pretty-printed
// Rust array of 2-tuples, with the number kept as text so ryu's formatting
// can be compared verbatim.
func goldenPairs(name string) [][2]string {
	var out [][2]string
	for _, m := range goldenPairRe.FindAllStringSubmatch(goldenText(name), -1) {
		out = append(out, [2]string{m[1], strings.TrimSpace(m[2])})
	}
	return out
}

// goldenRows reads pipe-separated golden rows: `field1|field2|...`, where the
// last field may contain pipes.
func goldenRows(name string) [][]string {
	var out [][]string
	for _, line := range strings.Split(goldenText(name), "\n") {
		if line == "" {
			continue
		}
		out = append(out, strings.Split(line, "|"))
	}
	return out
}
