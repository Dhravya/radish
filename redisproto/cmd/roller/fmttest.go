package main

import (
	"bufio"
	"bytes"
	"log"

	"github.com/dhravya/radish/redisproto"
)

func main() {
	bback := bytes.NewBuffer(nil)
	buff := bufio.NewWriter(bback)
	var c int64 = 1
	redisproto.SendObjects(buff, []interface{}{[]byte("SUBSCRIBED"), []byte("rm"), c})
	log.Println(bback.String())
}
