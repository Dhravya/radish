package tests

import (
	"bufio"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func isServerUp(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func sendRESPCommand(conn net.Conn, reader *bufio.Reader, args ...string) (string, error) {
	var cmd strings.Builder
	cmd.WriteString(fmt.Sprintf("*%d\r\n", len(args)))
	for _, arg := range args {
		cmd.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(arg), arg))
	}
	_, err := conn.Write([]byte(cmd.String()))
	if err != nil {
		return "", err
	}

	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")

	if strings.HasPrefix(line, "+") || strings.HasPrefix(line, ":") || strings.HasPrefix(line, "-") {
		return line, nil
	}
	if strings.HasPrefix(line, "$") {
		length, err := strconv.Atoi(line[1:])
		if err != nil {
			return "", err
		}
		if length == -1 {
			return "$-1", nil
		}
		buf := make([]byte, length+2)
		var total int
		for total < length+2 {
			n, err := reader.Read(buf[total:])
			if err != nil {
				return "", err
			}
			total += n
		}
		return string(buf[:length]), nil
	}
	return line, nil
}

func TestTTLExpirationProtocol(t *testing.T) {
	addr := "localhost:6379"
	var cmd *exec.Cmd

	if !isServerUp(addr) {
		cmd = exec.Command("../bin/radish")
		if err := cmd.Start(); err != nil {
			t.Fatalf("Failed to start radish server: %v", err)
		}
		defer func() {
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}()
		time.Sleep(500 * time.Millisecond)
	}

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("Failed to connect to radish server: %v", err)
	}
	defer conn.Close()

	reader := bufio.NewReader(conn)

	// FLUSHALL
	_, _ = sendRESPCommand(conn, reader, "FLUSHALL")

	// 1. SET key
	res, err := sendRESPCommand(conn, reader, "SET", "expkey", "hello")
	if err != nil || res != "+OK" {
		t.Fatalf("Expected +OK, got %s, err: %v", res, err)
	}

	// 2. TTL on key without expiration
	res, err = sendRESPCommand(conn, reader, "TTL", "expkey")
	if err != nil || res != ":-1" {
		t.Fatalf("Expected :-1 for key without expiration, got %s, err: %v", res, err)
	}

	// 3. EXPIRE on existing key returns 1
	res, err = sendRESPCommand(conn, reader, "EXPIRE", "expkey", "2")
	if err != nil || res != ":1" {
		t.Fatalf("Expected :1 for EXPIRE on existing key, got %s, err: %v", res, err)
	}

	// 4. EXPIRE on non-existent key returns 0
	res, err = sendRESPCommand(conn, reader, "EXPIRE", "nokey", "2")
	if err != nil || res != ":0" {
		t.Fatalf("Expected :0 for EXPIRE on non-existent key, got %s, err: %v", res, err)
	}

	// 5. TTL counts down
	res, err = sendRESPCommand(conn, reader, "TTL", "expkey")
	if err != nil || (!strings.HasPrefix(res, ":1") && !strings.HasPrefix(res, ":2")) {
		t.Fatalf("Expected :1 or :2 for TTL countdown, got %s, err: %v", res, err)
	}

	// 6. TTL on non-existent key returns -2
	res, err = sendRESPCommand(conn, reader, "TTL", "nokey")
	if err != nil || res != ":-2" {
		t.Fatalf("Expected :-2 for TTL on non-existent key, got %s, err: %v", res, err)
	}

	// 7. Wait for TTL to expire
	time.Sleep(2200 * time.Millisecond)

	// 8. TTL returns -2 after expiration
	res, err = sendRESPCommand(conn, reader, "TTL", "expkey")
	if err != nil || res != ":-2" {
		t.Fatalf("Expected :-2 for expired key TTL, got %s, err: %v", res, err)
	}

	// 9. GET returns nil after TTL expires
	res, err = sendRESPCommand(conn, reader, "GET", "expkey")
	if err != nil || res != "$-1" {
		t.Fatalf("Expected $-1 (nil) for expired key GET, got %s, err: %v", res, err)
	}
}
