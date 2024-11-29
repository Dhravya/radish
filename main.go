package main

import (
	"bufio"
	"encoding/gob"
	"flag"
	"fmt"
	"net"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dhravya/radish/redisproto"
)

type DataType int

const (
	StringType DataType = iota
	ListType
	HashType
	SetType
	SortedSetType
)

type sortedSetMember struct {
	Member string
	score  float64
}

type KeyValueStore struct {
	Strings     map[string]string
	Lists       map[string][]string
	Hashes      map[string]map[string]string
	Sets        map[string]map[string]struct{}
	SortedSets map[string][]sortedSetMember
	Expirations map[string]time.Time
	mu          sync.RWMutex
	CurrentTx   *Transaction
	totalCommandsProcessed int
	connectedClients map[string]net.Conn
}

var pubsub = NewPubSub()
var persistence *Persistence
var serverStartTime = time.Now()


func init() {
	gob.Register(map[string]string{})
	gob.Register(map[string][]string{})
	gob.Register(map[string]map[string]string{})
	gob.Register(map[string]map[string]struct{}{})
	gob.Register(map[string][]sortedSetMember{})
	gob.Register(map[string]time.Time{})
	gob.Register(sortedSetMember{})
}

func NewKeyValueStore() *KeyValueStore {
	return &KeyValueStore{
		Strings:    make(map[string]string),
		Lists:      make(map[string][]string),
		Hashes:     make(map[string]map[string]string),
		Sets:       make(map[string]map[string]struct{}),
		SortedSets: make(map[string][]sortedSetMember),
		Expirations: make(map[string]time.Time),
		totalCommandsProcessed: 0,
		connectedClients: make(map[string]net.Conn),
	}
}

func (kv *KeyValueStore) CommandHandler(command *redisproto.Command) string {

	parts := make([]string, command.ArgCount())
	for i := 0; i < command.ArgCount(); i++ {
		parts[i] = string(command.Get(i))
	}

	parts[0] = strings.ToUpper(parts[0])

	if parts[0] == "EXEC" {
		return kv.CurrentTx.ExecCommand()
	} else if parts[0] == "DISCARD" {
		return kv.CurrentTx.DiscardCommand()
	}

	// Otherwise, add the command to the transaction queue
	if kv.CurrentTx != nil {
		kv.CurrentTx.Commands = append(kv.CurrentTx.Commands, command)
		return "QUEUED"
	} else {
		return kv.executeCommand(parts)
	}
}

func (kv *KeyValueStore) executeCommand(parts []string) string {

	kv.totalCommandsProcessed++

	fmt.Println("Command:", parts[0])
	switch parts[0] {
	
	case "INFO":
		kv.mu.Lock()
		defer kv.mu.Unlock()
	
		// Calculate server uptime
		uptimeSeconds := int(time.Since(serverStartTime).Seconds())

		// Assuming you have variables tracking these metrics
		totalCommandsProcessed := kv.totalCommandsProcessed
		memoryUsage := runtime.MemStats{}
		runtime.ReadMemStats(&memoryUsage)
		connectedClients := len(kv.connectedClients) // Example of how you might track connected clients
	
		// Building the INFO response
		var infoBuilder strings.Builder
		infoBuilder.WriteString("# Server\r\n")
		infoBuilder.WriteString(fmt.Sprintf("uptime_in_seconds:%d\r\n", uptimeSeconds))
		infoBuilder.WriteString(fmt.Sprintf("total_commands_processed:%d\r\n", totalCommandsProcessed))
		infoBuilder.WriteString(fmt.Sprintf("used_memory:%d\r\n", memoryUsage.Alloc)) // Using Alloc as an example of memory usage
		infoBuilder.WriteString(fmt.Sprintf("connected_clients:%d\r\n", connectedClients))
	
		return infoBuilder.String()
	case "LPUSH":
		if len(parts) < 3 {
			return "ERROR: LPUSH requires at least 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		values := parts[2:]
		
		if _, exists := kv.Lists[key]; !exists {
			kv.Lists[key] = make([]string, 0)
		}
		for i := len(values) - 1; i >= 0; i-- {
			kv.Lists[key] = append([]string{values[i]}, kv.Lists[key]...)
		}
		return fmt.Sprintf("(integer) %d", len(kv.Lists[key]))	
	case "LPOP":
		if len(parts) != 2 {
			return "ERROR: LPOP requires 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if list, exists := kv.Lists[key]; exists && len(list) > 0 {
			// Pop the first element
			value := list[0]
			kv.Lists[key] = list[1:]
			return value
		}
		return "(nil)"
	case "RPUSH":
		if len(parts) < 3 {
			return "ERR RPUSH requires at least 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		values := parts[2:]

		if _, exists := kv.Lists[key]; !exists {
			kv.Lists[key] = make([]string, 0)
		}

		kv.Lists[key] = append(kv.Lists[key], values...)
		return fmt.Sprintf("(integer) %d", len(kv.Lists[key]))
	case "RPOP":
		if len(parts) != 2 {
			return "ERR RPOP requires 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if list, exists := kv.Lists[key]; exists && len(list) > 0 {
			value := list[len(list)-1]
			kv.Lists[key] = list[:len(list)-1]
			return value
		}
		return "(nil)"
	case "LRANGE":
		if len(parts) < 4 {
			return "ERROR: LRANGE requires at least 3 arguments"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		start, err := strconv.Atoi(parts[2])
		if err != nil {
			return "ERROR: LRANGE start index must be an integer"
		}
		end, err := strconv.Atoi(parts[3])
		if err != nil {
			return "ERROR: LRANGE end index must be an integer"
		}
	
		if _, exists := kv.Lists[key]; !exists {
			return "ERROR: no such key"
		}
	
		if start < 0 {
			start = len(kv.Lists[key]) + start
		}
		if end < 0 {
			end = len(kv.Lists[key]) + end
		}
		if start > end || start >= len(kv.Lists[key]) {
			return ""
		}
		if end >= len(kv.Lists[key]) {
			end = len(kv.Lists[key]) - 1
		}
	
		return fmt.Sprintf("%v", strings.Join(kv.Lists[key][start : end+1], " "))
	case "LLEN":
		if len(parts) != 2 {
			return "ERR LLEN requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		if list, exists := kv.Lists[key]; exists {
			return fmt.Sprintf("(integer) %d", len(list))
		}
		return "(integer) 0"
	case "HSET":
		if len(parts) != 4 {
			return "ERROR: HSET requires 3 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if _, exists := kv.Hashes[parts[1]]; !exists {
			kv.Hashes[parts[1]] = make(map[string]string)
		}
		kv.Hashes[parts[1]][parts[2]] = parts[3]
		return "OK"
	case "HGET":
		if len(parts) != 3 {
			return "ERROR: HGET requires 2 arguments"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		if hashSet, exists := kv.Hashes[parts[1]]; exists {
			if value, exists := hashSet[parts[2]]; exists {
				return value
			}
			return "(nil)"
		}
		return "(nil)"
	case "HMSET":
		if len(parts) < 4 || len(parts)%2 != 0 {
			return "ERR HMSET requires an even number of arguments >= 4"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if _, exists := kv.Hashes[key]; !exists {
			kv.Hashes[key] = make(map[string]string)
		}
		for i := 2; i < len(parts); i += 2 {
			kv.Hashes[key][parts[i]] = parts[i+1]
		}
		return "OK"
	case "HMGET":
		if len(parts) < 3 {
			return "ERR HMGET requires at least 2 arguments"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		if hash, exists := kv.Hashes[key]; exists {
			result := make([]string, 0)
			for i := 2; i < len(parts); i++ {
				if value, ok := hash[parts[i]]; ok {
					result = append(result, value)
				} else {
					result = append(result, "(nil)")
				}
			}
			return strings.Join(result, " ")
		}
		return "ERR no such key"
	case "HGETALL":
		if len(parts) != 2 {
			return "ERR HGETALL requires 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if hash, exists := kv.Hashes[key]; exists {
			result := make([]string, 0, len(hash)*2)
			for field, value := range hash {
				result = append(result, field, value)
			}
			return strings.Join(result, " ")
		}
		return "(empty hash)"
	case "HDEL":
		if len(parts) < 2 {
			return "ERR HDEL requires at least 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if hash, exists := kv.Hashes[key]; exists {
			count := 0
			for i := 2; i < len(parts); i++ {
				if _, ok := hash[parts[i]]; ok {
					delete(hash, parts[i])
					count++
				}
			}
			return fmt.Sprintf("(integer) %d", count)
		}
		return "(integer) 0"
	case "SET":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if len(parts) != 3 {
			return "ERROR: SET requires 2 arguments"
		}
		key, value := parts[1], parts[2]
		kv.Strings[key] = value
		return "OK"	
	case "GET":
		if len(parts) != 2 {
			return "ERROR: GET requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		if value, exists := kv.Strings[key]; exists {
			return value
		}
		return "(nil)"
	case "APPEND":
		if len(parts) != 3 {
			return "ERROR: APPEND requires 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key, valueToAppend := parts[1], parts[2]
		if value, exists := kv.Strings[key]; exists {
			kv.Strings[key] = value + valueToAppend
		} else {
			kv.Strings[key] = valueToAppend
		}
		return "OK"	
	case "DEL":
		if len(parts) < 2 {
			return "ERROR: DEL requires at least 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		count := 0
		for _, key := range parts[1:] {
			if _, exists := kv.Strings[key]; exists {
				delete(kv.Strings, key)
				count++
			}
			// Also, attempt to delete from other data structures
			if _, exists := kv.Lists[key]; exists {
				delete(kv.Lists, key)
				count++
			}
			if _, exists := kv.Hashes[key]; exists {
				delete(kv.Hashes, key)
				count++
			}
		}
		return fmt.Sprintf("(integer) %d", count)
	case "EXISTS":
		if len(parts) != 2 {
			return "ERROR: EXISTS requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		_, existsInStrings := kv.Strings[key]
		_, existsInLists := kv.Lists[key]
		_, existsInHashes := kv.Hashes[key]
		exists := existsInStrings || existsInLists || existsInHashes
		if exists {
			return "(integer) 1"
		}
		return "(integer) 0"
	case "KEYS":
		if len(parts) != 2 {
			return "ERROR: KEYS requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		pattern := parts[1]
		matchedKeys := ""
		for key := range kv.Strings {
			if strings.Contains(key, pattern) {
				matchedKeys += key + " "
			}
		}
		// Optionally, search in other data structures
		return strings.TrimSpace(matchedKeys)	
	case "EXPIRE":
		if len(parts) != 3 {
			return "ERROR: EXPIRE requires 2 arguments"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		seconds, err := strconv.Atoi(parts[2])
		if err != nil {
			return "ERROR: Invalid TTL value"
		}
		expirationTime := time.Now().Add(time.Duration(seconds) * time.Second)
		kv.Expirations[key] = expirationTime
		return "OK"
	case "TTL":
		if len(parts) != 2 {
			return "ERROR: TTL requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		if expiration, exists := kv.Expirations[key]; exists {
			if time.Now().Before(expiration) {
				ttl := time.Until(expiration).Seconds()
				return fmt.Sprintf("(integer) %d", int(ttl))
			}
			// Key expired, clean up
			delete(kv.Expirations, key)
			delete(kv.Strings, key) // Also consider cleaning up from other data structures
			return "(integer) -2" // Indicate the key does not exist (expired)
		}
		return "(integer) -1"
	case "SADD":
		if len(parts) < 3 {
			return "ERR SADD requires at least 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if _, exists := kv.Sets[key]; !exists {
			kv.Sets[key] = make(map[string]struct{})
		}
		count := 0
		for i := 2; i < len(parts); i++ {
			if _, ok := kv.Sets[key][parts[i]]; !ok {
				kv.Sets[key][parts[i]] = struct{}{}
				count++
			}
		}
		return fmt.Sprintf("(integer) %d", count)
	case "SMEMBERS":
		if len(parts) != 2 {
			return "ERR SMEMBERS requires 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if set, exists := kv.Sets[key]; exists {
			members := make([]string, 0, len(set))
			for member := range set {
				members = append(members, member)
			}
			sort.Strings(members)  // Sort the slice
			return strings.Join(members, " ")
		}
		return "(empty set)"
	case "SISMEMBER":
		if len(parts) != 3 {
			return "ERR SISMEMBER requires 2 arguments"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		key := parts[1]
		member := parts[2]
		if set, exists := kv.Sets[key]; exists {
			if _, ok := set[member]; ok {
				return "(integer) 1"
			}
		}
		return "(integer) 0"
	case "SREM":
		if len(parts) < 3 {
			return "ERR SREM requires at least 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if set, exists := kv.Sets[key]; exists {
			count := 0
			for i := 2; i < len(parts); i++ {
				if _, ok := set[parts[i]]; ok {
					delete(set, parts[i])
					count++
				}
			}
			return fmt.Sprintf("(integer) %d", count)
		}
		return "(integer) 0"
	case "ZADD":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		if len(parts[2:])%2 != 0 {
			return "ERR ZADD requires an even number of arguments"
		}
		newElements := 0
		for i := 2; i < len(parts); i += 2 {
			score, err := strconv.Atoi(parts[i])
			if err != nil {
				return "ERR ZADD invalid score"
			}
			member := parts[i+1]
			exists := false
			for _, existingMember := range kv.SortedSets[key] {
				if existingMember.Member == member {
					existingMember.score = float64(score)
					exists = true
					break
				}
			}
			if !exists {
				kv.SortedSets[key] = append(kv.SortedSets[key], sortedSetMember{member, float64(score)}) // Convert score to float64
				newElements++
			}
		}
		return fmt.Sprintf("(integer) %d", newElements)
	case "ZRANGE":
		if len(parts) != 4 {
			return "ERR ZRANGE requires 3 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		start, err := strconv.Atoi(parts[2])
		if err != nil {
			return "ERR ZRANGE invalid start index"
		}
		stop, err := strconv.Atoi(parts[3])
		if err != nil {
			return "ERR ZRANGE invalid stop index"
		}
	
		if sortedSet, exists := kv.SortedSets[key]; exists {
			// Adjusting start and stop for negative values
			if start < 0 {
				start = len(sortedSet) + start
			}
			if stop < 0 {
				stop = len(sortedSet) + stop
			}
			// Ensuring start and stop are within bounds
			if start < 0 {
				start = 0
			}
			if stop >= len(sortedSet) {
				stop = len(sortedSet) - 1
			}
	
			result := make([]string, 0)
			for i := start; i <= stop && i < len(sortedSet); i++ {
				result = append(result, sortedSet[i].Member)
			}
			return strings.Join(result, " ")
		}
		return "(empty sorted set)"
	case "ZREM":
		if len(parts) < 3 {
			return "ERR ZREM requires at least 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		key := parts[1]
		removed := 0
		if sortedSet, exists := kv.SortedSets[key]; exists {
			for i := 2; i < len(parts); i++ {
				member := parts[i]
				for j := 0; j < len(sortedSet); {
					if sortedSet[j].Member == member {
						// Remove by appending slices before and after the current index
						sortedSet = append(sortedSet[:j], sortedSet[j+1:]...)
						removed++
						continue // Skip the increment step to stay at the same index
					}
					j++
				}
			}
			kv.SortedSets[key] = sortedSet // Important to assign the modified slice back
			return fmt.Sprintf("(integer) %d", removed)
		}
		return "(integer) 0"	
	case "MULTI":
		tx, err := kv.MultiCommand()
		if err != nil {
			return err.Error()
		}
		kv.CurrentTx = tx
		return "OK"
	case "EXEC":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if kv.CurrentTx == nil {
			return "ERR EXEC without MULTI"
		}
		return kv.CurrentTx.ExecCommand()
	case "DISCARD":
		kv.mu.Lock()
    	defer kv.mu.Unlock()
		if kv.CurrentTx == nil {
			return "ERR DISCARD without MULTI"
		}
		return kv.CurrentTx.DiscardCommand()
	case "SUBSCRIBE":
		if len(parts) != 2 {
			return "ERR SUBSCRIBE requires 1 argument"
		}
		kv.mu.RLock()
		defer kv.mu.RUnlock()
		channel := parts[1]
		ch := pubsub.Subscribe(channel)
		go func() {
			for message := range ch {
				// Handle received message
				fmt.Printf("Received message on channel %s: %s\n", channel, message)
			}
		}()
		return "OK"
	case "PUBLISH":
		if len(parts) != 3 {
			return "ERR PUBLISH requires 2 arguments"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		channel, message := parts[1], parts[2]
		count := pubsub.Publish(channel, message)
		return fmt.Sprintf("(integer) %d", count)
	case "UNSUBSCRIBE":
		// Just close the channel to unsubscribe]
		// pubsub.UnsubscribeAll()
		// TODO: FIX THIS, just returning OK for now
		return "OK"
	case "PING":
		return "PONG"
	case "SHUTDOWN":
		kv.mu.Lock()
		defer kv.mu.Unlock()

		return "OK"
	case "SAVE":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		err := persistence.saveData()
		if err != nil {
			return "ERR " + err.Error()
		}
		return "OK"
	case "BGSAVE":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		persistence.shouldSave = true
		return "Background saving started"
	case "INCR":
		if len(parts) != 2 {
			return "ERR INCR requires 1 argument"
		}
		key := parts[1]
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if value, exists := kv.Strings[key]; exists {
			intValue, err := strconv.Atoi(value)
			if err != nil {
				return "ERR value is not an integer"
			}
			intValue++
			kv.Strings[key] = strconv.Itoa(intValue)
			return fmt.Sprintf("(integer) %d", intValue)
		} else {
			kv.Strings[key] = "1"
			return "(integer) 1"
		}
	case "INCRBY":
		// INCRBY key increment (increment is optional. Key is required, but does not need to exist)
		if len(parts) < 3 {
			return "ERR INCRBY requires at least 2 arguments"
		}
		key := parts[1]
		increment, err := strconv.Atoi(parts[2])
		if err != nil {
			return "ERR value is not an integer"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if value, exists := kv.Strings[key]; exists {
			intValue, err := strconv.Atoi(value)
			if err != nil {
				return "ERR value is not an integer"
			}
			intValue += increment
			kv.Strings[key] = strconv.Itoa(intValue)
			return fmt.Sprintf("(integer) %d", intValue)
		} else {
			kv.Strings[key] = strconv.Itoa(increment)
			return fmt.Sprintf("(integer) %d", increment)
		}
	case "DECRBY":
		// DECRBY key decrement (decrement is optional. Key is required, but does not need to exist)
		if len(parts) < 3 {
			return "ERR DECRBY requires at least 2 arguments"
		}
		key := parts[1]
		decrement, err := strconv.Atoi(parts[2])
		if err != nil {
			return "ERR value is not an integer"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if value, exists := kv.Strings[key]; exists {
			intValue, err := strconv.Atoi(value)
			if err != nil {
				return "ERR value is not an integer"
			}
			intValue -= decrement
			kv.Strings[key] = strconv.Itoa(intValue)
			return fmt.Sprintf("(integer) %d", intValue)
		} else {
			kv.Strings[key] = strconv.Itoa(-decrement)
			return fmt.Sprintf("(integer) %d", -decrement)
		}
	case "DECR":
		if len(parts) != 2 {
			return "ERR DECR requires 1 argument"
		}
		key := parts[1]
		kv.mu.Lock()
		defer kv.mu.Unlock()
		if value, exists := kv.Strings[key]; exists {
			intValue, err := strconv.Atoi(value)
			if err != nil {
				return "ERR value is not an integer"
			}
			intValue--
			kv.Strings[key] = strconv.Itoa(intValue)
			return fmt.Sprintf("(integer) %d", intValue)
		} else {
			kv.Strings[key] = "-1"
			return "(integer) -1"
		}
	case "MSET":
		if len(parts) < 3 || len(parts)%2 != 1 {
			return "ERR MSET requires an even number of arguments >= 3"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		for i := 1; i < len(parts); i += 2 {
			kv.Strings[parts[i]] = parts[i+1]
		}
		return "OK"
	case "MGET":
		if len(parts) < 2 {
			return "ERR MGET requires at least 1 argument"
		}
		kv.mu.Lock()
		defer kv.mu.Unlock()
		result := make([]string, 0)
		for _, key := range parts[1:] {
			if value, exists := kv.Strings[key]; exists {
				result = append(result, value)
			} else {
				result = append(result, "(nil)")
			}
		}
		return strings.Join(result, " ")
	case "FLUSHALL":
		kv.mu.Lock()
		defer kv.mu.Unlock()
		kv.Strings = make(map[string]string)
		kv.Lists = make(map[string][]string)
		kv.Hashes = make(map[string]map[string]string)
		kv.Sets = make(map[string]map[string]struct{})
		kv.SortedSets = make(map[string][]sortedSetMember)
		kv.Expirations = make(map[string]time.Time)
		kv.CurrentTx = nil
		return "OK"
	default:
		return "ERR unknown command"
	}
}

func handleConnection(conn net.Conn, kv *KeyValueStore) {
    defer conn.Close()
    kv.connectedClients[conn.RemoteAddr().String()] = conn

    parser := redisproto.NewParser(conn)
    writer := redisproto.NewWriter(bufio.NewWriter(conn))

    for {
        command, err := parser.ReadCommand()
        if err != nil {
            _, ok := err.(*redisproto.ProtocolError)
            if ok {
                ew := writer.WriteError(err.Error())
                if ew != nil {
                    fmt.Println("Error writing response:", ew)
                    break
                }
            } else {
                fmt.Println(err, "closed connection to", conn.RemoteAddr())
                break
            }
		} else {
			response := kv.CommandHandler(command)
			if response != "" {
				ew := writer.WriteBulkString(response)
				if ew != nil {
					fmt.Println("Error writing response:", ew)
					break
				}
			}
		}

        if command.IsLast() {
            writer.Flush()
        }
    }
}

func main() {
    dataFile := flag.String("dataFile", "data.gob", "Path where the 'data.gob'-file is located/created")
    flag.Parse()

    listener, err := net.Listen("tcp", ":6379")
	kv := NewKeyValueStore()

    if err != nil {
        fmt.Println("Error listening:", err.Error())
        return
    }
    defer listener.Close()
    fmt.Println("Listening on :6379")

	persistence = NewPersistence(kv, *dataFile)

	kv = persistence.kv
	
	go persistence.backgroundSave()

    for {
        conn, err := listener.Accept()
        if err != nil {
            fmt.Println("Error accepting: ", err.Error())
            return
        }
        go handleConnection(conn, kv)
    }
}
