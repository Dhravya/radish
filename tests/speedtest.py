import redis 
import time
import threading

CLIENT_1: redis.Redis = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)
CLIENT_2: redis.Redis = redis.Redis(host="localhost", port=6378, db=0, decode_responses=True)

# Thread-safe counter
class Counter(object):
    def __init__(self):
        self.val = 0
        self._lock = threading.Lock()

    def increment(self):
        with self._lock:
            self.val += 1

    def value(self):
        with self._lock:
            return self.val

command_counter_1 = Counter()
command_counter_2 = Counter()

# Test how many SET commands can be sent to both the servers in 10 seconds
def test_speed():
    print("Testing speed...")
    
    def send_command(client: redis.Redis, command: str, counter: Counter, *args):
        """
        Send a command to the Redis server using the redis library.
        """
        func = getattr(client, command.lower())
        response = func(*args)
        counter.increment()  # Increment the counter
        return response.decode() if isinstance(response, bytes) else response
    
    def test_set(client: redis.Redis, counter: Counter):
        key = "mykey" + str(counter.value())
        value = "Hello, World!"
        send_command(client, "set", counter, key, value)
    
    def test_get(client: redis.Redis, counter: Counter):
        key = "mykey"
        send_command(client, "get", counter, key)

    start = time.time()
    test_set(CLIENT_1, command_counter_1)
    test_set(CLIENT_2, command_counter_2)
    while time.time() - start < 10:
        threading.Thread(target=test_set, args=(CLIENT_1, command_counter_1)).start()
        threading.Thread(target=test_set, args=(CLIENT_2, command_counter_2)).start()

    print(f"Number of SET commands sent by CLIENT_1: {command_counter_1.value()}")
    print(f"Number of SET commands sent by CLIENT_2: {command_counter_2.value()}")

test_speed()