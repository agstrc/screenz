// Package signaling provides types and functions for WebRTC signaling between streamers and viewers.
//
// It defines the Signaler, Streamer, and Viewer types, as well as registries and message types
// for managing signaling sessions and message exchange over WebSockets.
package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Registry is a generic thread-safe registry for storing entries by key.
type Registry[K comparable, V any] struct {
	Entries map[K]V
	Mu      sync.RWMutex
}

// StreamerRegistry is a registry for Streamer instances, keyed by code.
// ViewerRegistry is a registry for Viewer instances, keyed by UUID.
type (
	StreamerRegistry = Registry[string, *Streamer]
	ViewerRegistry   = Registry[uuid.UUID, *Viewer]
)

// Signaler coordinates signaling between streamers and viewers.
// It manages the registries and handles WebSocket connections for signaling.
type Signaler struct {
	SR *StreamerRegistry
	VR *ViewerRegistry
}

// Streamer represents a streaming client participating in signaling.
type Streamer struct {
	Code string
	Conn *websocket.Conn

	In  chan ViewerMessage   // In receives signaling messages from viewers.
	Out chan StreamerMessage // Out sends signaling messages to viewers.

	Ctx    context.Context
	Cancel context.CancelCauseFunc
}

// Viewer represents a viewing client participating in signaling.
type Viewer struct {
	ID       uuid.UUID
	Conn     *websocket.Conn
	Streamer *Streamer

	Ctx    context.Context
	Cancel context.CancelCauseFunc
}

// ViewerMessage is a message sent from a viewer to a streamer.
type ViewerMessage struct {
	From string          `json:"from"` // From is the viewer's UUID as a string.
	Data json.RawMessage `json:"data"` // Data is the signaling payload.
}

// StreamerMessage is a message sent from a streamer to a viewer.
type StreamerMessage struct {
	To   string          `json:"to"`   // To is the viewer's UUID as a string.
	Data json.RawMessage `json:"data"` // Data is the signaling payload.
}

// Code is sent to a streamer after connection to identify its session.
type Code struct {
	Code string `json:"code"`
}

// HandleStreamerWS upgrades the HTTP connection to a WebSocket for a streamer
// and manages the signaling session lifecycle.
func (s *Signaler) HandleStreamerWS(rw http.ResponseWriter, req *http.Request) {
	conn, err := websocket.Accept(rw, req, nil)
	if err != nil {
		slog.Error("Failed to accept WS connection", "type", "streamer", "error", err)
		return
	}

	code := generateStreamerCode()
	ctx, cancel := context.WithCancelCause(context.Background())

	_ = wsjson.Write(ctx, conn, Code{code})

	context.AfterFunc(ctx, func() {
		_ = conn.Close(websocket.StatusNormalClosure, "Done")

		s.SR.Mu.Lock()
		delete(s.SR.Entries, code)
		s.SR.Mu.Unlock()
	})

	context.AfterFunc(ctx, func() {
		err := context.Cause(ctx)

		var closeError websocket.CloseError
		if errors.As(err, &closeError) {
			slog.Info("Streamer disconnected", "code", code)
			return
		}

		slog.Error("Streamer context closed", "error", err)
	})

	streamer := &Streamer{
		Code:   code,
		Conn:   conn,
		In:     make(chan ViewerMessage),
		Out:    make(chan StreamerMessage),
		Ctx:    ctx,
		Cancel: cancel,
	}

	s.SR.Mu.Lock()
	s.SR.Entries[code] = streamer

	go streamer.readWS()
	go streamer.handleIn()
	go streamer.handleOut(s.VR)

	slog.Info("Streamer connected", "code", code)
	s.SR.Mu.Unlock()
}

const clientSignalingTimeout = time.Minute

var errClientSignalTimeout = errors.New("the client has exceeded its signaling time limit")

// HandleViewerWS upgrades the HTTP connection to a WebSocket for a viewer
// and manages the signaling session lifecycle.
func (s *Signaler) HandleViewerWS(rw http.ResponseWriter, req *http.Request) {
	code := chi.URLParam(req, "streamerCode")

	viewerID := uuid.New()
	conn, err := websocket.Accept(rw, req, nil)
	if err != nil {
		slog.Error("Failed to accept WS connection", "type", "viewer", "error", err)
		return
	}

	s.SR.Mu.RLock()
	streamer, ok := s.SR.Entries[code]
	s.SR.Mu.RUnlock()

	if !ok {
		_ = conn.Close(websocket.StatusNormalClosure, "NO_STREAMER")
		return
	}

	ctx, c := context.WithTimeoutCause(context.Background(), clientSignalingTimeout, errClientSignalTimeout)
	_ = c

	ctx, cancel := context.WithCancelCause(ctx)

	context.AfterFunc(ctx, func() {
		_ = conn.Close(websocket.StatusNormalClosure, "Done")

		s.VR.Mu.Lock()
		delete(s.VR.Entries, viewerID)
		s.VR.Mu.Unlock()
	})

	context.AfterFunc(ctx, func() {
		err := context.Cause(ctx)

		var closeError websocket.CloseError
		if errors.As(err, &closeError) {
			slog.Info("Viewer released WS connection", "id", viewerID)
			return
		}

		if errors.Is(err, errClientSignalTimeout) {
			slog.Info("Viewer WS timed out", "id", viewerID)
			return
		}

		slog.Error("Viewer context closed", "error", err)
	})

	viewer := Viewer{
		ID:       viewerID,
		Conn:     conn,
		Streamer: streamer,
		Ctx:      ctx,
		Cancel:   cancel,
	}

	s.VR.Mu.Lock()
	s.VR.Entries[viewerID] = &viewer

	go viewer.readWS()

	slog.Info("Viewer connected", "id", viewerID, "code", code)
	s.VR.Mu.Unlock()
}

// handleOut relays signaling messages from the streamer to viewers.
func (s *Streamer) handleOut(vr *ViewerRegistry) {
	logger := slog.With("code", s.Code)

	for {
		select {
		case <-s.Ctx.Done():
			return
		case out := <-s.Out:
			viewerID, err := uuid.Parse(out.To)
			if err != nil {
				logger.Info("Invalid target UUID provided", "id", out.To)
				continue
			}

			vr.Mu.RLock()
			viewer, ok := vr.Entries[viewerID]
			vr.Mu.RUnlock()

			if !ok {
				logger.Info("Target UUID does not exist", "id", viewerID)
				continue
			}

			err = wsjson.Write(s.Ctx, viewer.Conn, out.Data)
			if err != nil {
				viewer.Cancel(err)
			}
		}
	}
}

// handleIn relays signaling messages from viewers to the streamer.
func (s *Streamer) handleIn() {
	logger := slog.With("code", s.Code)

	for {
		select {
		case <-s.Ctx.Done():
			return
		case in := <-s.In:
			err := wsjson.Write(s.Ctx, s.Conn, in)
			if err == nil {
				logger.Debug("Streamer received message", "id", in.From)
				continue
			}
			s.Cancel(err)
		}
	}
}

// readWS reads signaling messages from the streamer's WebSocket connection.
func (s *Streamer) readWS() {
	for {
		var out StreamerMessage
		err := wsjson.Read(s.Ctx, s.Conn, &out)
		if err != nil {
			s.Cancel(err)
		}
		s.Out <- out
	}
}

// readWS reads signaling messages from the viewer's WebSocket connection.
func (v *Viewer) readWS() {
	logger := slog.With("id", v.ID, "code", v.Streamer.Code)

	for {
		var msg json.RawMessage
		if err := wsjson.Read(v.Ctx, v.Conn, &msg); err != nil {
			v.Cancel(err)
			return
		}

		message := ViewerMessage{
			From: v.ID.String(),
			Data: msg,
		}

		v.Streamer.In <- message
		logger.Debug("Viewer sent message")
	}
}

// generateStreamerCode generates a random code for identifying a streamer session.
func generateStreamerCode() string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	const length = 5

	code := make([]byte, length)
	for i := range code {
		code[i] = charset[rand.IntN(len(charset))]
	}

	return string(code)
}
