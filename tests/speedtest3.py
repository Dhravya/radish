import redis
import time

# Configuration for the Redis clients
config = {
    "client1": {"host": "localhost", "port": 6379},
    "client2": {"host": "localhost", "port": 6378}
}

# Connect to Redis instances
clients = {
    name: redis.Redis(host=conf['host'], port=conf['port'])
    for name, conf in config.items()
}

# Function to test set operation
def test_set(client, key, value):
    start_time = time.time()
    client.set(key, value)
    return time.time() - start_time

# Function to test get operation
def test_get(client, key):
    start_time = time.time()
    client.get(key)
    return time.time() - start_time

# Function to test delete operation
def test_delete(client, key):
    start_time = time.time()
    client.delete(key)
    return time.time() - start_time

# Number of iterations to average the results
iterations = 100

results = {name: {"set": [], "get": [], "delete": []} for name in clients}

# Run tests
for _ in range(iterations):
    key = "test_key"
    value = "test_value"
    for name, client in clients.items():
        results[name]["set"].append(test_set(client, key, value))
        results[name]["get"].append(test_get(client, key))
        results[name]["delete"].append(test_delete(client, key))

# Calculate and print average times
for name in clients:
    print(f"Results for {name}:")
    for operation in ["set", "get", "delete"]:
        avg_time = sum(results[name][operation]) / len(results[name][operation])
        print(f"Average time for {operation}: {avg_time:.6f} seconds")

