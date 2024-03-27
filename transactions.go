package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/dhravya/radish/redisproto"
)

type Transaction struct {
	Commands []*redisproto.Command
	Kv       *KeyValueStore
}

func (kv *KeyValueStore) MultiCommand() (*Transaction, error) {
	if kv.CurrentTx != nil {
		return nil, errors.New("ERR MULTI calls can't be nested")
	}

	kv.CurrentTx = &Transaction{
		Commands: make([]*redisproto.Command, 0),
		Kv:       kv,
	}

	return kv.CurrentTx, nil
}

func (tx *Transaction) ExecCommand() string {
	fmt.Println("Executing transaction")
    if tx == nil || tx.Kv == nil || tx.Kv.CurrentTx != tx {
        return "ERR EXEC without MULTI"
    }

	for _, command := range tx.Commands {
		parts := make([]string, command.ArgCount())
		for i := 0; i < command.ArgCount(); i++ {
			parts[i] = string(command.Get(i))
		}
		response := tx.Kv.executeCommand(parts)
		if strings.HasPrefix(response, "ERR") {
			tx.Kv.CurrentTx = nil
			return response
		}
	}

	tx.Kv.CurrentTx = nil
	return "OK"
}

func (tx *Transaction) DiscardCommand() string {
	if tx.Kv.CurrentTx != tx {
		return "ERR DISCARD without MULTI"
	}

	tx.Commands = make([]*redisproto.Command, 0)
	tx.Kv.CurrentTx = nil
	return "OK"
}

func (tx *Transaction) QueueCommand(command *redisproto.Command) error {
	if tx.Kv.CurrentTx != tx {
		return errors.New("ERR commands can't be queued without MULTI")
	}

	tx.Commands = append(tx.Commands, command)
	return nil
}