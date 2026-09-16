import socket
import subprocess
import time
import sys
import redis

HOST = "localhost"
PORT = 6379

def is_server_running():
    try:
        s = socket.create_connection((HOST, PORT), timeout=1)
        s.close()
        return True
    except (socket.error, ConnectionRefusedError):
        return False

def main():
    proc = None
    if not is_server_running():
        print("Starting Radish server...")
        proc = subprocess.Popen(["./bin/radish"])
        time.sleep(1)

    try:
        r = redis.Redis(host=HOST, port=PORT, db=0, decode_responses=True)
        r.flushall()

        print("Testing EXPIRE returns 1 on existing key...")
        r.set("expire_key", "value1")
        exp_res = r.expire("expire_key", 2)
        assert exp_res == 1 or exp_res is True, f"Expected 1/True, got {exp_res}"

        print("Testing EXPIRE returns 0 on non-existent key...")
        exp_missing = r.expire("missing_key", 2)
        assert exp_missing == 0 or exp_missing is False, f"Expected 0/False, got {exp_missing}"

        print("Testing TTL counts down...")
        ttl_val = r.ttl("expire_key")
        assert isinstance(ttl_val, int), f"Expected int, got {type(ttl_val)}"
        assert 1 <= ttl_val <= 2, f"Expected TTL between 1 and 2, got {ttl_val}"

        print("Testing TTL on key without expiration returns -1...")
        r.set("no_expire_key", "value2")
        assert r.ttl("no_expire_key") == -1, f"Expected -1, got {r.ttl('no_expire_key')}"

        print("Testing TTL on missing key returns -2...")
        assert r.ttl("missing_key") == -2, f"Expected -2, got {r.ttl('missing_key')}"

        print("Waiting for key to expire...")
        time.sleep(2.2)

        print("Testing TTL returns -2 after expiration...")
        expired_ttl = r.ttl("expire_key")
        assert expired_ttl == -2, f"Expected -2 after expiration, got {expired_ttl}"

        print("Testing GET returns nil after TTL expires...")
        get_val = r.get("expire_key")
        assert get_val is None, f"Expected None (nil), got {get_val}"

        print("Testing active background eviction...")
        r.set("auto_evict", "secret")
        r.expire("auto_evict", 1)
        time.sleep(1.3)
        assert r.ttl("auto_evict") == -2
        assert r.get("auto_evict") is None

        print("All TTL and key expiration tests passed successfully!")
    finally:
        if proc:
            proc.terminate()
            proc.wait()

if __name__ == "__main__":
    main()
