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

	r.Get("/", serveIndex)
	r.Get("/thumbnail.png", serveThumbnail)

	r.NotFound(serveNotFound)

	listener, err := net.Listen("tcp", ":"+*port)
	if err != nil {
		slog.Error("Unable to listen on port", "port", *port, "error", err)
		os.Exit(1)
	}

	slog.Info("Server listening", "addr", listener.Addr().String())
	http.Serve(listener, r)
}
