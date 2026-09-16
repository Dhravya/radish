package redisproto

import (
	"bytes"
	"testing"
)

func TestWriter_Write(t *testing.T) {
	buff := bytes.NewBuffer(nil)
	w := NewWriter(buff)
	w.WriteBulkString("hello")
	if buff.String() != "$5\r\nhello\r\n" {
		t.Errorf("Unexpected WriteBulkString")
	}
}

func TestWriter_WriteSlice(t *testing.T) {
	buff := bytes.NewBuffer(nil)
	w := NewWriter(buff)
	w.WriteObjectsSlice(nil)
	if buff.String() != "*-1\r\n" {
		t.Errorf("Unexpected WriteObjectsSlice")
	}
}

func TestWriter_WriteSlice2(t *testing.T) {
	buff := bytes.NewBuffer(nil)
	w := NewWriter(buff)
	w.WriteObjectsSlice([]interface{}{1})
	if buff.String() != "*1\r\n:1\r\n" {
		t.Errorf("Unexpected WriteObjectsSlice, got %s", buff.String())
	}
}

func TestWriter_WriteResponse(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"(integer) 1", ":1\r\n"},
		{"(integer) 0", ":0\r\n"},
		{"(integer) -1", ":-1\r\n"},
		{"(integer) -2", ":-2\r\n"},
		{"(integer) 42", ":42\r\n"},
		{"(nil)", "$-1\r\n"},
		{"OK", "+OK\r\n"},
		{"PONG", "+PONG\r\n"},
		{"QUEUED", "+QUEUED\r\n"},
		{"ERR some error", "-ERR some error\r\n"},
		{"ERROR: invalid", "-ERROR: invalid\r\n"},
		{"(empty set)", "*0\r\n"},
		{"hello", "$5\r\nhello\r\n"},
	}

	for _, tc := range tests {
		buff := bytes.NewBuffer(nil)
		w := NewWriter(buff)
		if err := w.WriteResponse(tc.input); err != nil {
			t.Fatalf("WriteResponse(%q) returned error: %v", tc.input, err)
		}
		if buff.String() != tc.expected {
			t.Errorf("WriteResponse(%q) = %q, want %q", tc.input, buff.String(), tc.expected)
		}
	}
}
