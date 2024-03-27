# Introduction

## This is a fork of [radishproto](https://github.com/secmask/radishproto) to make it work with radish server.

radishproto is a go library to create server, service for RPC that compatible with redis protocol
I use it for some projects that require RPC, redis-protocol is a good choice because it can be parsed fast and
we have many client libraries that already exist to use. radishproto use it's own buffered reader to avoid memory copy.

Some other tool that use `radishproto`

1. https://github.com/secmask/mqueue    
2. https://github.com/secmask/roller

# License
radishproto is available under The MIT License (MIT).
