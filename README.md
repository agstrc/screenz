# screez

Simple, secure, screen sharing with WebRTC.

See it in action [here](https://screenz.agst.dev).

## Overview

**screez** is a minimalist, browser-based screen sharing application. It uses WebRTC for real-time, peer-to-peer streaming and a single Go binary as the backend for signaling and static file serving. No plugins or installations required—just open your browser and start sharing or watching a screen.

- **One Go binary**: Serves the frontend and handles all backend logic (WebSocket signaling, session management).
- **WebRTC**: Direct, encrypted peer-to-peer streaming between streamer and viewers.
- **No dependencies for users**: Works in all modern browsers.

## Features

- **Instant screen sharing**: Start streaming your screen in seconds.
- **Secure**: All connections are encrypted (WebRTC, WSS).
- **No accounts or installs**: Just share a 5-character code.
- **Low latency**: Real-time video and audio.
- **Cross-platform**: Works on Windows, macOS, Linux, and mobile browsers (viewer only).

## How It Works

1. **Streamer** starts a session and receives a unique 5-character code.
2. **Viewers** enter the code to connect and watch the stream in real time.
3. All signaling (offer/answer/candidates) is handled via WebSocket, then the media flows directly peer-to-peer via WebRTC.

---

## Running Locally

### Prerequisites

- Go 1.24 or newer

### Build & Run

```sh
git clone https://github.com/yourusername/screenz.git
cd screenz
go build -o screez
./screez -port=8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## License

MIT License — see [LICENSE](LICENSE)
