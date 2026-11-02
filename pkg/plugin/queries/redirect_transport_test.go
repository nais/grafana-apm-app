package queries

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type redirectTestTransport func(*http.Request) (*http.Response, error)

func (f redirectTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type redirectTestBody struct {
	read   bool
	closed bool
}

func (b *redirectTestBody) Read([]byte) (int, error) {
	b.read = true
	return 0, errors.New("redirect body must not be read")
}

func (b *redirectTestBody) Close() error {
	b.closed = true
	return nil
}

func TestRedirectTransportClosesWithoutReading(t *testing.T) {
	for status := 300; status < 400; status++ {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			body := &redirectTestBody{}
			base := redirectTestTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: status, Body: body, Header: http.Header{"Location": {"/%zz?token=secret-location"}}}, nil
			})
			client := &http.Client{Transport: RedirectBlockingTransport(base)}
			resp, err := client.Get("http://grafana.example/api/ds/query")
			if resp != nil {
				defer func() { _ = resp.Body.Close() }()
			}
			if resp != nil || err == nil || !strings.Contains(err.Error(), fmt.Sprintf("redirect response rejected (HTTP %d)", status)) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("response = %v, error = %v", resp, err)
			}
			if !body.closed || body.read {
				t.Fatalf("body closed = %v, read = %v", body.closed, body.read)
			}
		})
	}
}

func TestRedirectTransportPreservesOtherResponses(t *testing.T) {
	for _, status := range []int{200, 201, 400, 401, 403, 404, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", "/%zz?token=secret-location")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("original diagnostic body"))
			}))
			defer server.Close()
			client := &http.Client{Transport: RedirectBlockingTransport(nil)}
			resp, err := client.Get(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			body, err := io.ReadAll(resp.Body)
			if err != nil || resp.StatusCode != status || string(body) != "original diagnostic body" || resp.Header.Get("Location") != "/%zz?token=secret-location" {
				t.Fatalf("response changed: status=%d body=%q err=%v", resp.StatusCode, body, err)
			}
		})
	}
}

func TestRedirectTransportPreservesErrors(t *testing.T) {
	want := errors.New("original transport error")
	base := redirectTestTransport(func(*http.Request) (*http.Response, error) { return nil, want })
	client := &http.Client{Transport: RedirectBlockingTransport(base)}
	resp, err := client.Get("http://grafana.example/api/ds/query")
	if resp != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}
