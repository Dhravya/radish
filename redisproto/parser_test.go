package redisproto

import (
	"strings"
	"testing"
)

func TestParser_BulkString(t *testing.T) {
	// Correct RESP
	a := strings.NewReader("*3\r\n$3\r\nset\r\n$3\r\nkey\r\n$5\r\nvalue\r\n")
	parser := NewParser(a)
	cmd, _ := parser.ReadCommand()
	expect := []string{"set", "key", "value"}

	for i := 0; i < len(expect); i++ {
		el := string(cmd.Get(i))
		if el != expect[i] {
			t.Errorf("Expected: %s, Got: %s", expect[i], el)
		}
	}
}

func TestParser_BulkString2(t *testing.T) {
	// Bulk string size lower than the value
	a := strings.NewReader("*5\r\n$2\r\nset\r\n$3\r\nkey\r\n$5\r\nvalue\r\n")
	parser := NewParser(a)
	_, err := parser.ReadCommand()
	if err.Error() != "invalid bulk size" {
		t.Error("Expected InvalidBulkSize error")
	}
}

func TestParser_BulkString3(t *testing.T) {
	// Bulk string size higer than the value
	a := strings.NewReader("*5\r\n$4\r\nset\r\n$3\r\nkey\r\n$5\r\nvalue\r\n")
	parser := NewParser(a)
	_, err := parser.ReadCommand()
	if err.Error() != "invalid bulk size" {
		t.Error("Expected InvalidBulkSize error")
	}
}
