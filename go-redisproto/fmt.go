package redisproto

import (
	"bufio"
	"log"
	"strconv"
)

var (
	newLine  = []byte{'\r', '\n'}
	nilBulk  = []byte{'$', '-', '1', '\r', '\n'}
	nilArray = []byte{'*', '-', '1', '\r', '\n'}
)

func intToString(val int64) string {
	return strconv.FormatInt(val, 10)
}
func SendError(w *bufio.Writer, msg string) error {
	resp := "-" + msg + "\r\n"
	_, e := w.Write([]byte(resp))
	if e != nil {
		return e
	}
	return w.Flush()
}

func SendString(w *bufio.Writer, msg string) error {
	resp := "+" + msg + "\r\n"
	_, e := w.Write([]byte(resp))
	if e != nil {
		return e
	}
	return w.Flush()
}

func sendInt(w *bufio.Writer, val int64) error {
	resp := ":" + intToString(val) + "\r\n"
	_, e := w.Write([]byte(resp))
	if e != nil {
		return e
	}
	return nil
}

func SendInt(w *bufio.Writer, val int64) error {
	e := sendInt(w, val)
	if e != nil {
		return e
	}
	return w.Flush()
}
func SendBulk(w *bufio.Writer, val []byte) error {
	if e := sendBulk(w, val); e != nil {
		return e
	}
	return w.Flush()
}
func sendBulk(w *bufio.Writer, val []byte) error {
	if val == nil {
		_, e := w.Write(nilBulk)
		if e != nil {
			return e
		}
		return nil
	}
	pre := "$" + intToString(int64(len(val))) + "\r\n"
	_, e := w.Write([]byte(pre))
	if e != nil {
		return e
	}
	_, e = w.Write(val)
	if e != nil {
		return e
	}
	_, e = w.Write(newLine)
	if e != nil {
		return e
	}
	return nil
}
func SendBulks(w *bufio.Writer, vals [][]byte) error {
	if e := sendBulks(w, vals); e != nil {
		return e
	}
	return w.Flush()
}
func sendBulks(w *bufio.Writer, vals [][]byte) error {
	var e error
	if vals == nil {
		w.Write(nilArray)
		e = w.Flush()
		return e
	}
	pre := "*" + intToString(int64(len(vals))) + "\r\n"
	_, e = w.Write([]byte(pre))
	if e != nil {
		return e
	}
	numArg := len(vals)
	for i := 0; i < numArg; i++ {
		if e = SendBulk(w, vals[i]); e != nil {
			return e
		}
	}
	e = w.Flush()
	return e
}

func SendObjects(w *bufio.Writer, vals []interface{}) error {
	var e error
	if vals == nil {
		w.Write(nilArray)
		e = w.Flush()
		return e
	}
	pre := "*" + intToString(int64(len(vals))) + "\r\n"
	_, e = w.Write([]byte(pre))
	if e != nil {
		return e
	}
	numArg := len(vals)
	for i := 0; i < numArg; i++ {
		v := vals[i]
		switch v := v.(type) {
		case int64:
			if e = sendInt(w, v); e != nil {
				return e
			}
		case []byte:
			if e = sendBulk(w, v); e != nil {
				return e
			}
		default:
			log.Println("unsupport value ", v)
		}
	}
	e = w.Flush()
	return e
}

func SendBulkString(w *bufio.Writer, str string) error {
	return SendBulk(w, []byte(str))
}
func SendBulkStrings(w *bufio.Writer, strs []string) error {
	if strs == nil {
		return SendBulks(w, nil)
	}
	t := make([][]byte, 0, len(strs))
	for i := 0; i < len(strs); i++ {
		t = append(t, []byte(strs[i]))
	}
	return SendBulks(w, t)
}
