# Introduction

## This is a fork of [go-redisproto](https://github.com/secmask/go-redisproto) to make it work with go-redis server.

go-redisproto is a go library to create server, service for RPC that compatible with redis protocol
I use it for some projects that require RPC, redis-protocol is a good choice because it can be parsed fast and
we have many client libraries that already exist to use. go-redisproto use it's own buffered reader to avoid memory copy.

Some other tool that use `go-redisproto`

1. https://github.com/secmask/mqueue    
2. https://github.com/secmask/roller

# License
go-redisproto is available under The MIT License (MIT).
