package main

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExpireAndTTL(t *testing.T) {
	kv := NewKeyValueStore()
	defer kv.StopActiveExpiration()

	// 1. Test key without expiration
	res := kv.executeCommand([]string{"SET", "key1", "val1"})
	if res != "OK" {
		t.Fatalf("SET failed: %s", res)
	}

	ttlRes := kv.executeCommand([]string{"TTL", "key1"})
	if ttlRes != "(integer) -1" {
		t.Fatalf("Expected TTL -1 for key without expiration, got %s", ttlRes)
	}

	// 2. Test setting EXPIRE
	expRes := kv.executeCommand([]string{"EXPIRE", "key1", "2"})
	if expRes != "(integer) 1" {
		t.Fatalf("Expected EXPIRE to return (integer) 1, got %s", expRes)
	}

	// 3. Test TTL returns remaining seconds
	ttlRes = kv.executeCommand([]string{"TTL", "key1"})
	if !strings.HasPrefix(ttlRes, "(integer) ") {
		t.Fatalf("Expected (integer) prefix for TTL, got %s", ttlRes)
	}
	ttlValStr := strings.TrimPrefix(ttlRes, "(integer) ")
	ttlVal, err := strconv.Atoi(ttlValStr)
	if err != nil {
		t.Fatalf("Failed to parse TTL value: %v", err)
	}
	if ttlVal < 1 || ttlVal > 2 {
		t.Fatalf("Expected TTL between 1 and 2, got %d", ttlVal)
	}

	// 4. Wait for key to expire
	time.Sleep(2100 * time.Millisecond)

	// 5. Test TTL returns -2 after expiration
	ttlExpired := kv.executeCommand([]string{"TTL", "key1"})
	if ttlExpired != "(integer) -2" {
		t.Fatalf("Expected TTL (integer) -2 after expiration, got %s", ttlExpired)
	}

	// 6. Test GET returns (nil) after expiration (passive deletion)
	getRes := kv.executeCommand([]string{"GET", "key1"})
	if getRes != "(nil)" {
		t.Fatalf("Expected GET to return (nil) after expiration, got %s", getRes)
	}
}

func TestExpireNonExistent(t *testing.T) {
	kv := NewKeyValueStore()
	defer kv.StopActiveExpiration()

	expRes := kv.executeCommand([]string{"EXPIRE", "nonexistent", "10"})
	if expRes != "(integer) 0" {
		t.Fatalf("Expected EXPIRE on non-existent key to return (integer) 0, got %s", expRes)
	}

	ttlRes := kv.executeCommand([]string{"TTL", "nonexistent"})
	if ttlRes != "(integer) -2" {
		t.Fatalf("Expected TTL on non-existent key to return (integer) -2, got %s", ttlRes)
	}
}

func TestExpireZeroOrNegative(t *testing.T) {
	kv := NewKeyValueStore()
	defer kv.StopActiveExpiration()

	kv.executeCommand([]string{"SET", "temp", "val"})
	expRes := kv.executeCommand([]string{"EXPIRE", "temp", "0"})
	if expRes != "(integer) 1" {
		t.Fatalf("Expected EXPIRE with 0 seconds to return (integer) 1, got %s", expRes)
	}

	getRes := kv.executeCommand([]string{"GET", "temp"})
	if getRes != "(nil)" {
		t.Fatalf("Expected GET to return (nil) after immediate expiration, got %s", getRes)
	}

	ttlRes := kv.executeCommand([]string{"TTL", "temp"})
	if ttlRes != "(integer) -2" {
		t.Fatalf("Expected TTL to return (integer) -2 after immediate expiration, got %s", ttlRes)
	}
}

func TestActiveEviction(t *testing.T) {
	kv := NewKeyValueStore()
	defer kv.StopActiveExpiration()

	kv.executeCommand([]string{"SET", "evictme", "hello"})
	expRes := kv.executeCommand([]string{"EXPIRE", "evictme", "1"})
	if expRes != "(integer) 1" {
		t.Fatalf("Expected EXPIRE to return (integer) 1, got %s", expRes)
	}

	// Wait for background goroutine to run (runs every 100ms)
	time.Sleep(1300 * time.Millisecond)

	// Check directly on the map without calling GET (testing active background eviction)
	kv.mu.RLock()
	_, exists := kv.Strings["evictme"]
	kv.mu.RUnlock()

	if exists {
		t.Fatalf("Expected key 'evictme' to be actively evicted from kv.Strings, but it still exists")
	}
}

func TestConcurrentAccess(t *testing.T) {
	kv := NewKeyValueStore()
	defer kv.StopActiveExpiration()

	var wg sync.WaitGroup
	workers := 20
	iterations := 100

	for i := 0; i < workers; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("concurrent_key_%d", j%10)
				val := fmt.Sprintf("worker_%d_iter_%d", workerID, j)

				kv.executeCommand([]string{"SET", key, val})
				kv.executeCommand([]string{"EXPIRE", key, "2"})
				kv.executeCommand([]string{"GET", key})
				kv.executeCommand([]string{"TTL", key})
				if j%5 == 0 {
					kv.executeCommand([]string{"DEL", key})
				}
			}
		}()
	}

	wg.Wait()
}
