<div align="center">
<!-- logo -->
<img src = "assets/icon.png" width="300">
<h1 align="center">Radish</h1>
<img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /><br> 
Super fast drop-in replacement of the in memory key-value store redis in golang
</div>

***
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](code_of_conduct.md)
[Try it out instantly](#installation)

## 👀 What is this? Why?
`Radish` is a super fast drop-in replacement of the in memory key-value store redis, built with golang.

---

**Redis recently switched to a new [dual 'source-available' license](https://news.ycombinator.com/item?id=39772562) , causing frustration among users.** 

To address this, **I created a solution in Go.** 

While not battle-tested, **it's my best effort for reliability.** 

Plus, **it comes with a cute mascot!** 

All I ask is **a ⭐ to keep me off Twitter for dopamine hits.**

---

![Godis](assets/godis.png)

## 📜 Features

| Feature                   | Redis | Radish |
| ------------------------- | ----- | ------ |
| In-memory key-value store | ✅     | ✅      |
| Strings                   | ✅     | ✅      |
| Lists                     | ✅     | ✅      |
| Sets                      | ✅     | ✅      |
| Sorted sets               | ✅     | ✅      |
| Hashes                    | ✅     | ✅      |
| Streams                   | ✅     | ❌      |
| HyperLogLogs              | ✅     | ❌      |
| Bitmaps                   | ✅     | ❌      |
| Persistence               | ✅     | ✅      |
| Pub/Sub                   | ✅     | ✅      |
| Transactions              | ✅     | ✅      |
| Lua scripting             | ✅     | ❌      |
| LRU eviction              | ✅     | ❌      |
| TTL                       | ✅     | 😅      |
| Clustering                | ✅     | ❌      |
| Auth                      | ✅     | ❌      |

### Available commands

For now, these commands are available (more to come)

#### MISC
`INFO` `PING` `FLUSHALL` `SHUTDOWN` `SAVE` `BGSAVE`

#### Keys
`DEL` `EXISTS` `KEYS` `EXPIRE` `TTL`

#### Strings
`SET` `GET` `APPEND` `INCR` `INCRBY` `DECR` `DECRBY` `MSET` `MGET`

#### Lists
`LPUSH` `LPOP` `RPUSH` `RPOP` `LRANGE` `LLEN`

#### Hashes
`HSET` `HGET` `HMSET` `HMGET` `HGETALL` `HDEL`

#### Sets
`SADD` `SMEMBERS` `SISMEMBER` `SREM`

#### Sorted Sets
`ZADD` `ZRANGE` `ZREM`

#### Pub/Sub
`SUBSCRIBE` `PUBLISH` `UNSUBSCRIBE`

#### Transactions
`MULTI` `EXEC` `DISCARD`

## Installation

### Using `docker`
To get it up and running instantly, you can use the docker image

```
docker run -d -p 6379:6379 dhravyashah/radish
```

### Using `go`

```
go install github.com/dhravya/radish@latest && radish
```

and then just build and run the binary


### Using the binary

Download the binary executables from `./bin/radish`.

Click here to get it [instantly](
    https://github.com/dhrvyashah/radish/releases/download/v0.1.0/radish-0.1.0-linux-amd64.tar.gz).


## Having fun

This IS compatible with the existing redis tooling and client libraries! Try it out with some of them.

For eg.
```
npm i -g redis-cli
```
(make sure the server is running - docker is the easiest and fastest way)
```
❯ rdcli
127.0.0.1:6379> incr mycounter
(integer) 1
127.0.0.1:6379> incr mycounter
(integer) 2
127.0.0.1:6379> set foo bar
OK
127.0.0.1:6379> get foo
bar
127.0.0.1:6379> get bar
(nil)
```

## Contributing
radish is *completely* open source. If you want to contribute, please create an issue on the repo and I will assign the task to someone (or you).

Steps to contribute:
1. Clone the repo
```
git clone https://github.com/dhravya/radish
```

2. Create a new branch

3. Make sure to build and test the code before creating a PR
```
go build -o ./bin
```

4. Create a PR

## Help and the community
If you need any help, or want to ask questions, or suggest features, please feel free to DM me on twitter - [https://dm.new/dhravya](https://dm.new/dhravya) or create an issue on the repo.

You can also join our [Discord server](https://discord.gg/z7MZYhmx6w) where we have a community of developers ready to help you out.

## License

Unlike redis, radish is licensed under the MIT license. You can use it for commercial purposes without any restrictions. Go wild!
