package plugin

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// responseCache is a simple in-memory cache for expensive API responses.
// Keys are hashed from the handler name + query parameters, values are
// pre-serialized JSON bytes with a TTL.
type responseCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
	ttl     time.Duration
	maxSize int
	group   singleflight.Group
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

// roundedUnix rounds a timestamp down to a 30s bucket for cache keys, so
// near-simultaneous requests with slightly different ranges share entries.
func roundedUnix(t time.Time) string {
	return fmt.Sprintf("%d", t.Unix()/30*30)
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

	if !ok {
		return nil, false
	}
	if time.Since(entry.createdAt) > c.ttl {
		// Lazy cleanup of expired entry
		c.mu.Lock()
		if e, exists := c.entries[key]; exists && time.Since(e.createdAt) > c.ttl {
			delete(c.entries, key)
		}
		c.mu.Unlock()
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

	// Hard limit: drop the write if still at capacity after eviction
	if len(c.entries) >= c.maxSize {
		return
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

// getOrCompute returns cached JSON bytes on hit; on miss it runs compute,
// coalescing concurrent callers for the same key into a single execution
// (stampede protection — wallboards polling in lockstep would otherwise all
// re-run the expensive query fan-out when an entry expires).
func (c *responseCache) getOrCompute(key string, compute func() (any, error)) ([]byte, error) {
	if data, ok := c.get(key); ok {
		return data, nil
	}
	v, err, _ := c.group.Do(key, func() (any, error) {
		// Re-check: another caller may have populated the cache while we
		// waited for the flight slot.
		if data, ok := c.get(key); ok {
			return data, nil
		}
		val, err := compute()
		if err != nil {
			return nil, err
		}
		data, err := json.Marshal(val)
		if err != nil {
			return nil, fmt.Errorf("marshaling response: %w", err)
		}
		c.set(key, data)
		return data, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

// writeCached serves the response for key from the cache (with an X-Cache: HIT
// header), or computes, caches, and writes it. Concurrent misses for the same
// key are coalesced by getOrCompute. errMsg is written on compute failure.
func (a *App) writeCached(w http.ResponseWriter, key, errMsg string, compute func() (any, error)) {
	if cached, ok := a.respCache.get(key); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}
	data, err := a.respCache.getOrCompute(key, compute)
	if err != nil {
		http.Error(w, errMsg, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}
