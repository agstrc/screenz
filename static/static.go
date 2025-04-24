package static

import (
	_ "embed"
	"net/http"
)

var (
	//go:embed index.html
	IndexHTML []byte

	//go:embed main.js
	MainJS []byte

	//go:embed style.css
	StyleCSS []byte

	//go:embed thumbnail.png
	ThumbnailPNG []byte
)

// Serve returns an http.HandlerFunc that serves the given data.
// The handler sets the "Content-Type" header to the provided contentType,
// adds a "Cache-Control: max-age=600" header, and writes the data to the response body.
func Serve(data []byte, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "max-age=600")

		w.Write(data)
	}
}
