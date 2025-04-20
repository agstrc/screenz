package main

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// wrappedResponseWriter wraps an http.ResponseWriter to capture the status code
// and provide support for the [http.Hijacker] interface.
//
// It is used to enable logging of HTTP response status codes and to allow
// connection hijacking when required.
type wrappedResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *wrappedResponseWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *wrappedResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("not implemented")
	}

	return hijacker.Hijack()
}

func requestLogger(next http.Handler) http.Handler {
	fn := func(w http.ResponseWriter, r *http.Request) {
		wrapped := &wrappedResponseWriter{w, http.StatusOK}

		before := time.Now()
		next.ServeHTTP(wrapped, r)
		total := time.Since(before)

		slog.Info(
			"Request",
			"time", total,
			"addr", r.RemoteAddr,
			"path", r.URL.Path,
			"status", wrapped.statusCode,
			"user-agent", r.UserAgent(),
		)
	}

	return http.HandlerFunc(fn)
}
