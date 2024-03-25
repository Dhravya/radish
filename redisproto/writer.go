package redisproto

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
)

var (
	star   = []byte{'*'}
	colon  = []byte{':'}
	dollar = []byte{'$'}
	plus   = []byte{'+'}
	subs   = []byte{'-'}
	// newLine  = []byte{'\r', '\n'}
	// nilBulk  = []byte{'$', '-', '1', '\r', '\n'}
	// nilArray = []byte{'*', '-', '1', '\r', '\n'}
)

type Writer struct {
	w io.Writer
}

func NewWriter(sink io.Writer) *Writer {
	return &Writer{
		w: sink,
	}
}

func (w *Writer) Write(data []byte) (int, error) {
	return w.w.Write(data)
}

func (w *Writer) Flush() error {
	if f, ok := w.w.(*bufio.Writer); ok {
		return f.Flush()
	}
	return nil
}

func (w *Writer) WriteInt(val int64) error {
	w.Write(colon)
	w.Write(strconv.AppendInt(nil,val,10))
	_, err := w.Write(newLine)
	return err
}

func (w *Writer) WriteBulk(val []byte) error {
	if val == nil {
		_, err := w.Write(nilBulk)
		return err
	}
	w.Write(dollar)
	w.Write(strconv.AppendUint(nil,uint64(len(val)),10))
	w.Write(newLine)
	w.Write(val)
	_, err := w.Write(newLine)
	return err
}

func (w *Writer) WriteBulkString(s string) error {
	return w.WriteBulk([]byte(s))
}

func (w *Writer) WriteSimpleString(s string) error {
	w.Write(plus)
	w.Write([]byte(s))
	_, err := w.Write(newLine)
	return err
}

func (w *Writer) WriteError(s string) error {
	w.Write(subs)
	w.Write([]byte(s))
	_, err := w.Write(newLine)
	return err
}

func (w *Writer) WriteObjects(objs ...interface{}) error {
	if objs == nil {
		_, err := w.Write(nilArray)
		return err
	}

	w.Write(star)
	w.Write(strconv.AppendUint(nil,uint64(len(objs)),10))
	w.Write(newLine)

	numArg := len(objs)
	for i := 0; i < numArg; i++ {
		v := objs[i]
		if v == nil {
			if err := w.WriteBulk(nil); err != nil {
				return err
			}
			continue
		}
		switch v := v.(type) {
		case []byte:
			if err := w.WriteBulk(v); err != nil {
				return err
			}
		case string:
			if err := w.WriteBulkString(v); err != nil {
				return err
			}
		case int:
			if err := w.WriteInt(int64(v)); err != nil {
				return err
			}
		case int32:
			if err := w.WriteInt(int64(v)); err != nil {
				return err
			}
		case int64:
			if err := w.WriteInt(v); err != nil {
				return err
			}
		default:
			return fmt.Errorf("value not suppport %v", v)
		}
	}
	return nil
}

func (w *Writer) WriteBulks(bulks ...[]byte) error {
	if bulks == nil {
		_, err := w.Write(nilArray)
		return err
	}

	w.Write(star)
	numElement := len(bulks)
	w.Write(strconv.AppendUint(nil,uint64(numElement),10))
	w.Write(newLine)

	for i := 0; i < numElement; i++ {
		if err := w.WriteBulk(bulks[i]); err != nil {
			return err
		}
	}
	return nil
}

// WriteObjectsSlice works like WriteObjects, it useful when args is a slice that can be nil,
// in that case WriteObjects(nil) will understand as response 1 element array (nil element)
// see https://github.com/secmask/go-redisproto/issues/4 for details.
func (w *Writer) WriteObjectsSlice(args []interface{}) error {
	return w.WriteObjects(args...)
}

// WriteBulksSlice ...
func (w *Writer) WriteBulksSlice(args [][]byte) error {
	return w.WriteBulks(args...)
}

func (w *Writer) WriteBulkStrings(bulks []string) error {
	if bulks == nil {
		_, err := w.Write(nilArray)
		return err
	}

	w.Write(star)
	numElement := len(bulks)
	w.Write(strconv.AppendUint(nil,uint64(numElement),10))
	w.Write(newLine)

	for i := 0; i < numElement; i++ {
		if err := w.WriteBulkString(bulks[i]); err != nil {
			return err
		}
	}
	return nil
}
