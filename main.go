package main

import (
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	signaling "screenz/signaling"
	"screenz/static"
)

func main() {
	port := flag.String("port", "8080", "Port to run the server on")
	logLevel := flag.String("log-level", "info", "Log level (debug, info, warn, error)")

	flag.Parse()

	var level slog.Level
	switch *logLevel {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		slog.Warn("Invalid log level, defaulting to info", "log-level", *logLevel)
		level = slog.LevelInfo
	}
	slog.SetLogLoggerLevel(level)

	server := &signaling.Signaler{
		SR: &signaling.StreamerRegistry{
			Entries: map[string]*signaling.Streamer{},
			Mu:      sync.RWMutex{},
		},
		VR: &signaling.ViewerRegistry{
			Entries: map[uuid.UUID]*signaling.Viewer{},
			Mu:      sync.RWMutex{},
		},
	}

	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(requestLogger)
	r.Use(middleware.Recoverer)

	r.Get("/stream", server.HandleStreamerWS)
	r.Get("/watch/{streamerCode}", server.HandleViewerWS)

	r.Get("/", static.Serve(static.IndexHTML, "text/html; charset=utf-8"))
	r.Get("/style.css", static.Serve(static.StyleCSS, "text/css; charset=utf-8"))
	r.Get("/main.js", static.Serve(static.MainJS, "application/javascript; charset=utf-8"))
	r.Get("/thumbnail.png", static.Serve(static.ThumbnailPNG, "image/png"))

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusPermanentRedirect)
	})

	listener, err := net.Listen("tcp", ":"+*port)
	if err != nil {
		slog.Error("Unable to listen on port", "port", *port, "error", err)
		os.Exit(1)
	}

	slog.Info("Server listening", "addr", listener.Addr().String())
	http.Serve(listener, r)
}
