import redis
import time
import threading

# Connect to Redis
r = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)


def send_command(command, *args):
    """
    Send a command to the Redis server using the redis library.
    """
    func = getattr(r, command.lower())
    response = func(*args)
    return response.decode() if isinstance(response, bytes) else response


def setup_redis():
    print("Setting up Redis...")
    send_command("flushall")


def test_strings():
    print("Testing string operations...")
    key = "mykey"
    value = "Hello, World!"

    print(send_command("set", key, value))
    print(send_command("append", key, " from Python"))
    print(send_command("get", key))
    print(send_command("set", 'counter', 0))
    print(r.incr('counter'))
    print(r.incr('counter'))
    print(send_command("decr", "counter"))
    print(send_command("mset", {"a": 1, "b": 2, "c": 3}))
    print(send_command("mget", "a", "b", "c"))


def test_lists():
    print("Testing list operations...")
    key = "mylist"

    print(send_command("lpush", key, "c", "b", "a"))
    print(send_command("rpush", key, "d", "e", "f"))
    print(send_command("lrange", key, 0, -1))
    print(send_command("lpop", key))
    print(send_command("rpop", key))
    print(send_command("llen", key))


def test_hashes():
    print("Testing hash operations...")
    key = "myhash"

    assert send_command("hset", key, "field1", "value1") >= 0
    assert send_command("hget", key, "field1") == "value1"
    assert send_command("hmset", key, {"field2": "value2", "field3": "value3"}) is True
    assert send_command("hmget", key, "field1", "field2", "field3") == [
        "value1",
        "value2",
        "value3",
    ]
    assert send_command("hgetall", key) == {
        "field1": "value1",
        "field2": "value2",
        "field3": "value3",
    }
    assert send_command("hdel", key, "field1", "field3") >= 0


def test_sets():
    print("Testing set operations...")
    key = "myset"

    assert send_command("sadd", key, "a", "b", "c") == 3
    assert send_command("sismember", key, "a") is True
    assert send_command("sismember", key, "d") is False
    assert set(send_command("smembers", key)) == {"a", "b", "c"}
    assert send_command("srem", key, "b") == 1
    assert set(send_command("smembers", key)) == {"a", "c"}


def main():
    setup_redis()
    test_strings()
    test_lists()
    test_hashes()
    test_sets()

# TODO Additional tests for sorted sets, transactions, pub/sub, persistence, and speed


if __name__ == "__main__":
    main()
