package main

import (
	"encoding/gob"
	"log"
	"os"
	"sync"
)

type Persistence struct {
	kv         *KeyValueStore
	dataFile   string
	mu         sync.Mutex
	shouldSave bool
}

func NewPersistence(kv *KeyValueStore, dataFile string) *Persistence {
	p := &Persistence{
		kv:       kv,
		dataFile: dataFile,
	}

	err := p.loadData()
	if err != nil {
		log.Printf("Error loading data: %v", err)
	}

	return p
}

// Add a method to set shouldSave to true
func (p *Persistence) MarkAsDirty() {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.shouldSave = true
}

func (p *Persistence) loadData() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	file, err := os.Open(p.dataFile)
	if err != nil {
		return err
	}
	defer file.Close()

	dec := gob.NewDecoder(file)

	err = dec.Decode(p.kv)
	if err != nil {
		return err
	}

	return nil
}

func (p *Persistence) saveData() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	tmpFile := p.dataFile + ".tmp"
	file, err := os.Create(tmpFile)
	if err != nil {
		return err
	}

	enc := gob.NewEncoder(file)
	err = enc.Encode(p.kv)
	if err != nil {
		file.Close()
		os.Remove(tmpFile)
		return err
	}

	file.Close()
	err = os.Rename(tmpFile, p.dataFile)
	if err != nil {
		os.Remove(tmpFile)
		return err
	}

	return nil
}

func (p *Persistence) backgroundSave() {
	for {
		if p.shouldSave {
			p.shouldSave = false
			err := p.saveData()
			if err != nil {
				log.Printf("Error saving data: %v", err)
			}
		}
	}
}
