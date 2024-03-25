import socket
import time
import threading

#! This is an older test file that no longer works.
#! The reason is that this test isn't compatible with the redis protocol.

HOST = "localhost"
PORT = 6379

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect((HOST, PORT))


def send_command(command):
    # Send with redis protocol
    s.send(f"{command}\r\n".encode())
    response = s.recv(1024).decode()
    return response


def setup_redis():
    print("Setting up Redis...")
    send_command("FLUSHALL")


def test_strings():
    print("Testing string operations...")
    key = "mykey"
    value = '"Hello, World!"'

    print(send_command(f"SET {key} {value}"))
    assert send_command(f"SET {key} {value}") == "OK"
    assert send_command(f"APPEND {key} ' from Python'") == "OK"
    assert send_command(f"GET {key}") == value.replace('"', "") + " from Python"
    assert send_command("INCR counter") == "(integer) 1"
    assert send_command("INCR counter") == "(integer) 2"
    assert send_command("DECR counter") == "(integer) 1"
    assert send_command("MSET a 1 b 2 c 3") == "OK"
    assert send_command("MGET a b c") == "1 2 3"


def test_lists():
    print("Testing list operations...")
    key = "mylist"

    print(send_command(f"LPUSH {key} c b a"))
    # assert send_command(f"LPUSH {key} c b a") == "(integer) 3"
    assert send_command(f"RPUSH {key} d e f") == "(integer) 6"
    assert send_command(f"LRANGE {key} 0 -1") == "c b a d e f"
    assert send_command(f"LPOP {key}") == "c"
    assert send_command(f"RPOP {key}") == "f"
    assert send_command(f"LLEN {key}") == "(integer) 4"


def test_hashes():
    print("Testing hash operations...")
    key = "myhash"

    assert send_command(f"HSET {key} field1 value1") == "OK"
    assert send_command(f"HGET {key} field1") == "value1"
    assert send_command(f"HMSET {key} field2 value2 field3 value3") == "OK"
    assert send_command(f"HMGET {key} field1 field2 field3") == "value1 value2 value3"
    assert set(send_command(f"HGETALL {key}").split()) == set(
        "field1 value1 field2 value2 field3 value3".split()
    )
    assert send_command(f"HDEL {key} field1 field3") == "(integer) 2"


def test_sets():
    print("Testing set operations...")
    key = "myset"

    assert send_command(f"SADD {key} a b c") == "(integer) 3"
    assert send_command(f"SISMEMBER {key} a") == "(integer) 1"
    assert send_command(f"SISMEMBER {key} d") == "(integer) 0"
    assert set(send_command(f"SMEMBERS {key}").split()) == set("a b c".split())
    assert send_command(f"SREM {key} b") == "(integer) 1"
    assert set(send_command(f"SMEMBERS {key}").split()) == set("a c".split())


def test_sorted_sets():
    print("Testing sorted set operations...")
    key = "mysortedset"

    assert send_command(f"ZADD {key} 1 a 2 b 3 c") == "(integer) 3"
    assert send_command(f"ZRANGE {key} 0 -1") == "a b c"
    assert send_command(f"ZREM {key} b") == "(integer) 1"
    assert send_command(f"ZRANGE {key} 0 -1") == "a c"


def test_transactions():
    print("Testing transaction operations...")
    assert send_command("MULTI") == "OK"
    assert send_command("SET key1 value1") == "QUEUED"
    assert send_command("GET key1") == "QUEUED"
    assert send_command("EXEC") == "OK"
    assert send_command("GET key1") == "value1"

    assert send_command("MULTI") == "OK"
    assert send_command("SET key2 value2") == "QUEUED"
    assert send_command("DISCARD") == "OK"
    assert send_command("GET key2") == "(nil)"


def test_pubsub():
    print("Testing pub/sub operations...")
    channel = "mychannel"
    subscribe_response = send_command(f"SUBSCRIBE {channel}")
    assert subscribe_response == "OK"

    # Publish a message in a separate thread
    def publish_message():
        time.sleep(1)
        published = send_command(f"PUBLISH {channel} hello")
        assert published == "(integer) 1"

    publish_message()

    assert send_command("UNSUBSCRIBE") == "OK"


def test_persistence():
    print("Testing persistence operations...")
    key = "persistkey"
    value = '"persistent value"'

    assert send_command(f"SET {key} {value}") == "OK"
    assert send_command("BGSAVE") == "Background saving started"
    assert send_command("SAVE") == "OK"

    send_command("SHUTDOWN")
    time.sleep(1)
    assert send_command(f"GET {key}") == "persistent value"


def test_speed():
    print("Testing speed...")
    key = "speedkey"
    value = "x" * 1024

    start_time = time.time()
    for _ in range(1000):
        send_command(f"SET {key} {value}")
        send_command(f"GET {key}")
    end_time = time.time()

    duration = end_time - start_time
    print(f"Time taken for 1000 SET and GET operations: {duration:.2f} seconds")


def main():
    setup_redis()
    test_strings()
    test_lists()
    test_hashes()
    test_sets()
    test_sorted_sets()
    test_transactions()
    test_pubsub()
    test_persistence()
    test_speed()

    print(send_command("INFO"))


if __name__ == "__main__":
    main()
