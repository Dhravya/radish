import redis
import time
import threading

# Connect to Redis
r = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)


def send_command(command, *args):
    """
    Send a command to the Redis server using the redis library.
    
    Args:
        command (str): The Redis command to be executed.
        *args: Variable number of arguments to be passed with the command.
    
    Returns:
        str: Response from the Redis server.
    """
    func = getattr(r, command.lower())
    response = func(*args)
    # Decode response if it's in bytes
    return response.decode() if isinstance(response, bytes) else response


def setup_redis():
    """
    Prepare Redis for testing by flushing all existing data.
    """
    print("Setting up Redis...")
    send_command("flushall")


def test_strings():
    """
    Test various string operations in Redis.
    """
    print("Testing string operations...")
    key = "mykey"
    value = "Hello, World!"

    # Set a string key-value pair
    print(send_command("set", key, value))
    # Append a string to an existing key's value
    print(send_command("append", key, " from Python"))
    # Retrieve the value of a key
    print(send_command("get", key))
    # Set a counter and increment it
    print(send_command("set", 'counter', 0))
    print(r.incr('counter'))
    print(r.incr('counter'))
    # Decrement a counter
    print(send_command("decr", "counter"))
    # Set multiple key-value pairs
    print(send_command("mset", {"a": 1, "b": 2, "c": 3}))
    # Get the values of multiple keys
    print(send_command("mget", "a", "b", "c"))


def test_lists():
    """
    Test various list operations in Redis.
    """
    print("Testing list operations...")
    key = "mylist"

    # Insert elements into the head of a list
    print(send_command("lpush", key, "c", "b", "a"))
    # Insert elements into the tail of a list
    print(send_command("rpush", key, "d", "e", "f"))
    # Retrieve all elements of a list
    print(send_command("lrange", key, 0, -1))
    # Remove and return the first element of a list
    print(send_command("lpop", key))
    # Remove and return the last element of a list
    print(send_command("rpop", key))
    # Get the length of a list
    print(send_command("llen", key))


def test_hashes():
    """
    Test various hash operations in Redis.
    """
    print("Testing hash operations...")
    key = "myhash"

    # Set the string value of a hash field
    assert send_command("hset", key, "field1", "value1") >= 0
    # Get the value of a hash field
    assert send_command("hget", key, "field1") == "value1"
    # Set multiple hash fields to multiple values
    assert send_command("hmset", key, {"field2": "value2", "field3": "value3"}) is True
    # Get the values of all given hash fields
    assert send_command("hmget", key, "field1", "field2", "field3") == [
        "value1",
        "value2",
        "value3",
    ]
    # Get all the fields and values in a hash
    assert send_command("hgetall", key) == {
        "field1": "value1",
        "field2": "value2",
        "field3": "value3",
    }
    # Delete one or more hash fields
    assert send_command("hdel", key, "field1", "field3") >= 0


def test_sets():
    """
    Test various set operations in Redis.
    """
    print("Testing set operations...")
    key = "myset"

    # Add one or more members to a set
    assert send_command("sadd", key, "a", "b", "c") == 3
    # Determine if a given value is a member of a set
    assert send_command("sismember", key, "a") is True
    assert send_command("sismember", key, "d") is False
    # Get all the members of a set
    assert set(send_command("smembers", key)) == {"a", "b", "c"}
    # Remove one or more members from a set
    assert send_command("srem", key, "b") == 1
    assert set(send_command("smembers", key)) == {"a", "c"}


def main():
    """
    Main function to run Redis tests.
    """
    setup_redis()
    test_strings()
    test_lists()
    test_hashes()
    test_sets()

# TODO Additional tests for sorted sets, transactions, pub/sub, persistence, and speed


if __name__ == "__main__":
    main()
