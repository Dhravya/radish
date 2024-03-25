package main

import (
	"bufio"
	"bytes"
	"github.com/dhravya/go-redis/go-redisproto"
	"log"
)

func main() {
	bback := bytes.NewBuffer(nil)
	buff := bufio.NewWriter(bback)
	var c int64 = 1
	redisproto.SendObjects(buff, []interface{}{[]byte("SUBSCRIBED"), []byte("rm"), c})
	log.Println(string(bback.Bytes()))
}
