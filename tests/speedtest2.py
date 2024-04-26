import datetime
import redis
import threading

r = redis.Redis(port=6379)  # Connect to Redis on port 6379
b = redis.Redis(port=6378)  # Connect to Radish on port 6378


def test_redis(client, port):
    begin = datetime.datetime.now()
    for i in range(10000):
        client.set(str(i), str(i))
        client.get(str(i))
    end = datetime.datetime.now()

    print(
        end - begin,
        f"port {'Radish on port 6378' if port == 6378 else 'redis on port 6379'}",
    )


# Create threads
thread1 = threading.Thread(target=test_redis, args=(r, 6379))
thread2 = threading.Thread(target=test_redis, args=(b, 6378))

# Start threads
thread1.start()
thread2.start()

# Wait for both threads to finish
thread1.join()
thread2.join()
