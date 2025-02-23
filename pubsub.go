package main

import (
	"sync"
)

type Subscription struct {
	channel     string
	subscribers []chan<- string
}

type PubSub struct {
	subscriptions map[string]*Subscription
	mu            sync.RWMutex
}

func NewPubSub() *PubSub {
	return &PubSub{
		subscriptions: make(map[string]*Subscription),
	}
}

func (ps *PubSub) Subscribe(channel string) chan string {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	sub, exists := ps.subscriptions[channel]
	if !exists {
		sub = &Subscription{
			channel:     channel,
			subscribers: make([]chan<- string, 0),
		}
		ps.subscriptions[channel] = sub
	}

	ch := make(chan string, 1)
	sub.subscribers = append(sub.subscribers, ch)
	return ch
}

func (ps *PubSub) Unsubscribe(channel string, subscriber chan string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	sub, exists := ps.subscriptions[channel]
	if exists {
		for i, ch := range sub.subscribers {
			if ch == subscriber {
				sub.subscribers = append(sub.subscribers[:i], sub.subscribers[i+1:]...)
				break
			}
		}
	}
}

func (ps *PubSub) UnsubscribeAll() {
	ps.subscriptions = make(map[string]*Subscription)
}

func (ps *PubSub) Publish(channel, message string) int {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	sub, exists := ps.subscriptions[channel]
	if exists {
		count := 0
		for _, ch := range sub.subscribers {
			select {
			case ch <- message:
				count++
			default:
			}
		}
		return count
	}

	return 0
}
