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
