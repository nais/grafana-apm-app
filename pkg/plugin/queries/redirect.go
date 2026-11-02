package queries

import (
	"fmt"
	"net/http"
)

// RedirectBlockingTransport rejects redirects before http.Client can parse a
// secret-bearing Location header. A nil base uses http.DefaultTransport.
func RedirectBlockingTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return redirectBlockingTransport{base: base}
}

type redirectBlockingTransport struct {
	base http.RoundTripper
}

func (t redirectBlockingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// Do not drain: a redirect body can stream until the request times out.
		_ = resp.Body.Close()
		return nil, fmt.Errorf("redirect response rejected (HTTP %d)", resp.StatusCode)
	}
	return resp, nil
}
