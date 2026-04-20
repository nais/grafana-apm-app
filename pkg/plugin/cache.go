package plugin

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// responseCache is a simple in-memory cache for expensive API responses.
// Keys are hashed from the handler name + query parameters, values are
// pre-serialized JSON bytes with a TTL.
type responseCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
	ttl     time.Duration
	maxSize int
}

type cacheEntry struct {
	data      []byte
	createdAt time.Time
}

func newResponseCache(ttl time.Duration, maxSize int) *responseCache {
	return &responseCache{
		entries: make(map[string]*cacheEntry, maxSize),
		ttl:     ttl,
		maxSize: maxSize,
	}
}

// cacheKey builds a deterministic cache key from handler name and params.
func cacheKey(handler string, params ...string) string {
	h := sha256.New()
	h.Write([]byte(handler))
	for _, p := range params {
		h.Write([]byte("|"))
		h.Write([]byte(p))
	}
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

// get returns cached JSON bytes if the entry exists and hasn't expired.
func (c *responseCache) get(key string) ([]byte, bool) {
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()

	if !ok || time.Since(entry.createdAt) > c.ttl {
		return nil, false
	}
	return entry.data, true
}

// set stores pre-serialized JSON bytes in the cache.
func (c *responseCache) set(key string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Evict expired entries if at capacity
	if len(c.entries) >= c.maxSize {
		now := time.Now()
		for k, e := range c.entries {
			if now.Sub(e.createdAt) > c.ttl {
				delete(c.entries, k)
			}
		}
	}

	c.entries[key] = &cacheEntry{data: data, createdAt: time.Now()}
}

// setJSON marshals the value and stores it.
func (c *responseCache) setJSON(key string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.set(key, data)
}
