package main

import (
	_ "embed"
	"net/http"
)

var (
	//go:embed static/index.html
	index []byte

	//go:embed static/thumbnail.png
	thumbnail []byte
)

func serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	w.Header().Set("Cache-Control", "max-age=600")

	w.Write(index)
}

func serveThumbnail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "max-age=600")

	w.Write(thumbnail)
}

func serveNotFound(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/", http.StatusPermanentRedirect)
}
