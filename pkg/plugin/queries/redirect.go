package queries

import (
	"fmt"
	"net/http"
)

// RejectRedirect keeps authenticated Grafana requests at their configured
// endpoint, including same-origin redirects that could escape the proxy path.
// Callers must check RedirectResponseError before reading a response body.
func RejectRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

// RedirectResponseError omits the body and Location, which may contain secrets.
// Returning an error from CheckRedirect instead would expose Location through
// net/http's url.Error, so rejection happens after Do returns the original 3xx.
func RedirectResponseError(resp *http.Response) error {
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("redirect response rejected (HTTP %d)", resp.StatusCode)
	}
	return nil
}
