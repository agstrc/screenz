// --- Constants and Element References ---
// UI elements for displaying status and errors
const STATUS_DISPLAY = document.getElementById("status");
const ERROR_DISPLAY = document.getElementById("error");
// Tab buttons for switching between viewer and streamer roles
const watchTabButton = document.getElementById("watchTabButton");
const streamTabButton = document.getElementById("streamTabButton");
// Viewer-specific UI elements
const CODE_INPUT = document.getElementById("codeInput"); // Input for the streamer's code
const connectViewerButton = document.getElementById("connectViewer"); // Button to initiate connection as viewer
const REMOTE_VIDEO = document.getElementById("remoteVideo"); // Video element for displaying the remote stream
// Streamer-specific UI elements
const initiateStreamButton = document.getElementById("initiateStreamButton"); // Button to start the screen sharing process
const STREAMER_CODE_DISPLAY = document.getElementById("streamerCode"); // Displays the unique code for viewers
const VIEWER_COUNT_DISPLAY = document.getElementById("viewerCount"); // Displays the number of connected viewers
const LOCAL_VIDEO = document.getElementById("localVideo"); // Video element for the streamer's local preview
// Determine WebSocket protocol based on page protocol (ws or wss)
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
// Construct the base URL for the WebSocket signaling server
const WS_URL_BASE = `${wsProtocol}//${window.location.host}`;
console.log(`Using WebSocket Base URL: ${WS_URL_BASE}`);

// --- Global State Variables ---
// Holds the WebSocket connection object for signaling
let ws = null;
// Flag indicating if the WebSocket connection is currently active
let wsConnected = false;
// Map storing active RTCPeerConnection objects. Key: 'streamer' (for viewer) or viewerId (for streamer). Value: RTCPeerConnection instance.
let peerConnections = new Map();
// Holds the MediaStream object representing the streamer's screen capture
let localStream = null;
// Current role of the user ('viewer' or 'streamer'), determined by the active tab
let role = null;
// The unique code generated for the streamer, shared with viewers
let streamerCode = null;
// The code entered by the viewer to connect to a specific streamer
let viewerTargetCode = null;
// Timeout ID for the viewer's signaling connection attempt
let signalingTimeout = null;
// Flag indicating if the streamer initialization process has begun
let streamerInitialized = false;
// Plyr player instance for the local video preview (streamer)
let localPlayer = null;
// Plyr player instance for the remote video stream (viewer)
let remotePlayer = null;
// Flag to prevent recursive calls to closeConnections
let closingConnections = false;
// Flag for display media support
let isDisplayMediaSupported = false;

// --- Constants for Audio Quality ---
const TARGET_AUDIO_BITRATE = 128000; // Target bitrate in bps (e.g., 128kbps) - adjust as needed

/**
 * Initializes or resets the Plyr video player instances for local and remote videos.
 * This ensures players are ready when needed and reset correctly during cleanup,
 * primarily by nullifying the srcObject rather than destroying the player instances.
 * Called on page load and during connection cleanup (`closeConnections`).
 * @param {boolean} playLocalPreview - Whether to attempt playing the local preview after initialization (used potentially if srcObject is already set).
 */
function initializePlyrPlayers(playLocalPreview = false) {
  console.log("Attempting to initialize/reset Plyr players...");
  try {
    // Reset local player source if it exists
    if (localPlayer && LOCAL_VIDEO) {
      console.log("Resetting local player source.");
      LOCAL_VIDEO.srcObject = null; // Set underlying video element source to null
    }
    // Reset remote player source if it exists and hide controls
    if (remotePlayer && REMOTE_VIDEO) {
      console.log("Resetting remote player source.");
      REMOTE_VIDEO.srcObject = null; // Set underlying video element source to null
      document
        .getElementById("remoteVideoContainer")
        ?.classList.add("plyr-inactive"); // Keep remote inactive after reset
    }

    // Create local player instance if it doesn't exist and the video element is present
    if (!localPlayer && LOCAL_VIDEO) {
      localPlayer = new Plyr(LOCAL_VIDEO, {
        title: "Local Preview",
        controls: [], // No controls for local preview
        muted: true, // Always muted
        clickToPlay: false,
        tooltips: { controls: false, seek: false },
      });
      console.log("Plyr initialized for local video.");
      // Note: Autoplay logic might need refinement based on when srcObject is actually assigned later.
    }
    // Create remote player instance if it doesn't exist and the video element is present
    if (!remotePlayer && REMOTE_VIDEO) {
      remotePlayer = new Plyr(REMOTE_VIDEO, {
        title: "Stream",
        // Standard controls for the viewer
        controls: ["play-large", "play", "mute", "volume", "fullscreen"],
        clickToPlay: false, // Start might be handled programmatically
      });
      console.log("Plyr initialized for remote video.");
      // Start with controls hidden until stream arrives
      document
        .getElementById("remoteVideoContainer")
        ?.classList.add("plyr-inactive");
    }
  } catch (e) {
    console.error("Failed to initialize/reset Plyr:", e);
    setError("Error initializing/resetting video player.");
  }
}
// Initialize players when the page content is loaded
document.addEventListener("DOMContentLoaded", () =>
  initializePlyrPlayers(false)
);

// --- UI Helper Functions ---

/**
 * Updates the status message displayed to the user in the status area.
 * Optionally styles the message as success or warning.
 * Logs the status update to the console.
 * @param {string} message - The status message to display.
 * @param {boolean} [isSuccess=false] - If true, style as a success message.
 * @param {boolean} [isWarning=false] - If true, style as a warning message.
 */
function setStatus(message, isSuccess = false, isWarning = false) {
  STATUS_DISPLAY.textContent = `Status: ${message}`;
  if (isSuccess) {
    STATUS_DISPLAY.className = "success";
  } else if (isWarning) {
    STATUS_DISPLAY.className = "warning";
  } else {
    STATUS_DISPLAY.className = "";
  }
  console.log(`Status Update: ${message}`);
}

/**
 * Displays an error message in the dedicated error area, clearing the normal status.
 * Logs the error to the console.
 * Used for critical failures or user-facing errors.
 * @param {string} message - The error message to display.
 */
function setError(message) {
  ERROR_DISPLAY.textContent = `Error: ${message}`;
  STATUS_DISPLAY.textContent = ""; // Clear normal status when error occurs
  STATUS_DISPLAY.className = "";
  console.error(`Error Set: ${message}`);
}

/**
 * Clears any message currently displayed in the error area.
 * Typically called when starting a new action or switching tabs.
 */
function clearError() {
  ERROR_DISPLAY.textContent = "";
}

/**
 * Updates the viewer count display in the streamer's UI.
 * Only functions if the current role is 'streamer'.
 * Calculates count based on the size of the `peerConnections` map.
 */
function updateViewerCount() {
  if (role !== "streamer") return; // Only relevant for the streamer
  const count = peerConnections.size;
  VIEWER_COUNT_DISPLAY.textContent = count;
  console.log(`Viewer count updated: ${count}`);
}

/**
 * Checks if the browser supports the `getDisplayMedia` API.
 * Updates the `isDisplayMediaSupported` flag.
 */
function checkDisplayMediaSupport() {
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    isDisplayMediaSupported = true;
    console.log("getDisplayMedia is supported by this browser.");
  } else {
    isDisplayMediaSupported = false;
    console.warn("getDisplayMedia is NOT supported by this browser.");
    // Notify user and disable stream tab immediately
    setError(
      "Screen sharing is not supported by your browser. You cannot start a stream."
    );
    if (streamTabButton) {
      streamTabButton.disabled = true;
      streamTabButton.title =
        "Screen sharing is not supported by your browser."; // Add tooltip
    }
    // Also disable the button inside the tab as an extra measure
    if (initiateStreamButton) {
      initiateStreamButton.disabled = true;
      initiateStreamButton.title =
        "Screen sharing is not supported by your browser.";
    }
  }
}

/**
 * Handles switching between the 'Watch Stream' (viewer) and 'Start Stream' (streamer) tabs.
 * Updates the visual appearance of tabs and content areas.
 * Sets the global `role` variable based on the selected tab.
 * Clears any existing errors (unless it's the unsupported browser error).
 * @param {string} targetId - The ID of the tab content element to activate ('watchTabContent' or 'streamTabContent').
 */
function switchTab(targetId) {
  // Do not allow switching to stream tab if unsupported
  if (targetId === "streamTabContent" && !isDisplayMediaSupported) {
    console.warn(
      "Attempted to switch to stream tab, but it's disabled due to lack of support."
    );
    // Optionally re-focus the error message or flash the disabled tab
    return;
  }

  // Deactivate all tabs and content first
  document
    .querySelectorAll(".tab-button")
    .forEach((b) => b.classList.remove("active"));
  document
    .querySelectorAll(".tab-content")
    .forEach((c) => c.classList.remove("active"));

  // Activate the target tab and content
  const targetButton = document.querySelector(
    `.tab-button[data-target="${targetId}"]`
  );
  const targetContent = document.getElementById(targetId);

  if (targetButton && targetContent) {
    targetButton.classList.add("active");
    targetContent.classList.add("active");
    console.log(`Switched tab to: ${targetId}`);
    // Set the application role based on the active tab
    role = targetId === "streamTabContent" ? "streamer" : "viewer";
    console.log(`Current role set to: ${role}`);
  } else {
    console.error(`Tab target not found: ${targetId}`);
  }
  // Clear previous errors, but *keep* the 'unsupported' error if present
  if (!ERROR_DISPLAY.textContent.includes("not supported by your browser")) {
    clearError();
  }
}
// Attach event listeners to tab buttons to trigger switching
watchTabButton.addEventListener("click", () => switchTab("watchTabContent"));
streamTabButton.addEventListener("click", () => switchTab("streamTabContent"));

// --- Core Logic (WebSocket Signaling and WebRTC) ---

/**
 * Establishes a WebSocket connection to the signaling server at the specified URL.
 * Handles reconnection attempts if a connection already exists.
 * Manages WebSocket lifecycle events (open, message, error, close).
 * Returns a Promise that resolves with the WebSocket object on successful connection
 * or rejects on initial connection failure.
 * @param {string} url - The WebSocket URL to connect to.
 * @returns {Promise<WebSocket>} A promise resolving with the WebSocket instance.
 */
function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    setStatus(`Connecting signaling server...`);
    wsConnected = false; // Reset connection status flag

    // If a WS connection exists, close it before creating a new one
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log("Closing existing WebSocket for reconnection.");
      ws.onclose = null; // Prevent old handler from firing
      ws.onerror = null;
      ws.close(1001, "Reconnecting"); // 1001: Going Away
    }

    // Create the new WebSocket instance
    ws = new WebSocket(url);

    // --- WebSocket Event Handlers ---

    // Called when the WebSocket connection is successfully established.
    ws.onopen = () => {
      console.log("WebSocket Connected successfully.");
      wsConnected = true;
      resolve(ws); // Resolve the promise with the connected WebSocket
    };

    // Called when a message is received from the signaling server.
    // Delegates processing to handleWebSocketMessage.
    ws.onmessage = handleWebSocketMessage;

    // Called when a WebSocket error occurs.
    ws.onerror = (event) => {
      const errorMsg =
        event.message ||
        (event.type ? `WebSocket event: ${event.type}` : "WebSocket error");
      console.error("WebSocket error details:", event);
      ws = null; // Nullify ws object on error

      if (!wsConnected) {
        // Failure during the initial connection attempt
        setError(`Signaling connection failed: ${errorMsg}`);
        reject(new Error(errorMsg)); // Reject the promise
        closeConnections(false); // Clean up any partial state, don't try to close WS again
      } else {
        // Error occurred after connection was established (interruption)
        setError(`Signaling error: ${errorMsg}`);
        setStatus(
          "Warning: Signaling interrupted. Peer connections might still be active.",
          false,
          true
        );
        wsConnected = false; // Update connection state
      }
    };

    // Called when the WebSocket connection is closed.
    ws.onclose = (event) => {
      const reason = event.reason;
      const code = event.code;
      console.log(
        `WebSocket closed: Code=${code}, Reason='${reason || ""}', WasClean=${
          event.wasClean
        }`
      );

      let handledSpecific = false; // Flag for specific close reasons

      // Handle specific case for viewers: If the server closes because the streamer wasn't found.
      if (role === "viewer" && code === 1000 && reason === "NO_STREAMER") {
        const targetCode =
          viewerTargetCode ||
          CODE_INPUT.value.trim().toUpperCase() ||
          "the requested code";
        setError(`Streamer '${targetCode}' not found or is no longer active.`);
        clearTimeout(signalingTimeout); // Stop connection timeout timer
        signalingTimeout = null;
        if (connectViewerButton) connectViewerButton.disabled = false; // Re-enable connect button
        handledSpecific = true; // Mark as handled
      }

      // If the connection was previously established and closed unexpectedly (not a normal close or NO_STREAMER)
      if (!handledSpecific && wsConnected && code !== 1000 && code !== 1001) {
        setStatus(
          `Warning: Signaling disconnected unexpectedly (Code: ${code}). Peer connections might remain active.`,
          false,
          true
        );
      } else if (!handledSpecific) {
        // Log normal closures or closures before connection, unless already handled (e.g., NO_STREAMER)
        console.log(
          `WebSocket closed normally or before full connection established (Code: ${code}).`
        );
      }

      // Common cleanup for any closure
      ws = null;
      wsConnected = false;

      // Update UI based on role, ONLY if not handled by a specific case (like NO_STREAMER)
      if (!handledSpecific) {
        if (role === "streamer") {
          updateViewerCount(); // Reset viewer count if streamer's WS closes
        } else if (role === "viewer") {
          // For viewers, re-enable the connect button if it's disabled and the closure wasn't NO_STREAMER
          if (connectViewerButton && connectViewerButton.disabled) {
            connectViewerButton.disabled = false;
          }
        }
      }
    };
  });
}

/**
 * Initiates the process for the streamer to start sharing their screen.
 * Triggered by the 'Start Streaming' button.
 * Checks if already initialized, disables button, requests screen capture (`startLocalStream`),
 * connects to the signaling server (`connectWebSocket`), and updates status.
 * Handles errors during the process and calls `closeConnections` on failure.
 */
async function startStreamerInitialization() {
  // --- MODIFIED: Add check for support here too as a safeguard ---
  if (!isDisplayMediaSupported) {
    console.error(
      "startStreamerInitialization called, but getDisplayMedia is not supported."
    );
    setError(
      "Cannot start stream: Screen sharing is not supported by your browser."
    );
    if (initiateStreamButton) initiateStreamButton.disabled = true; // Ensure button stays disabled
    return;
  }
  // --- End MODIFIED ---

  // Prevent starting if not in streamer role or already initialized
  if (role !== "streamer" || streamerInitialized) {
    console.warn(
      "Streamer initialization skipped: Incorrect role or already initialized."
    );
    return;
  }
  streamerInitialized = true; // Mark as initialized
  initiateStreamButton.disabled = true; // Disable button during setup
  initiateStreamButton.style.display = "none"; // Hide button after starting
  clearError(); // Clear previous errors
  setStatus("Starting Stream...");

  try {
    // Request screen capture permission and stream
    setStatus("Requesting screen capture...");
    await startLocalStream(); // startLocalStream already checks support internally now
    // Ensure stream was successfully obtained
    if (!localStream || !localStream.active) {
      throw new Error("Screen capture failed or permission was denied.");
    }

    // Connect to the signaling server's streamer endpoint
    ws = await connectWebSocket(`${WS_URL_BASE}/stream`);

    // If WebSocket connection is successful, update status
    setStatus("Streaming setup complete. Waiting for code...", true); // Status indicates ready for code
  } catch (error) {
    setError(`Failed to start stream: ${error.message}`);
    console.error("Streamer initialization error:", error);
    closeConnections(); // Clean up resources on failure
  }
}
// Attach listener to the streamer start button
initiateStreamButton.addEventListener("click", startStreamerInitialization);

/**
 * Requests screen capture using `navigator.mediaDevices.getDisplayMedia`.
 * Includes requests for both video and audio tracks with high-quality constraints.
 * Stores the resulting MediaStream in `localStream`.
 * Displays a video-only preview in the `LOCAL_VIDEO` element.
 * Attaches an `onended` handler to the video track to detect when the user stops sharing via browser UI.
 * Throws an error if capture fails or is denied.
 * --- MODIFIED: Added the support check at the beginning ---
 */
async function startLocalStream() {
  // --- NEW: Explicit check at the beginning of this function ---
  if (!isDisplayMediaSupported) {
    console.error(
      "startLocalStream called, but getDisplayMedia is not supported."
    );
    throw new Error(
      "Screen sharing (getDisplayMedia) is not supported by this browser."
    );
  }
  // --- End NEW ---

  // Stop any existing local stream tracks first
  if (localStream) {
    console.log("Stopping existing local stream before starting new one...");
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;
  if (LOCAL_VIDEO) LOCAL_VIDEO.srcObject = null; // Clear preview

  try {
    // Request display media (screen and audio) with high-quality hints
    // Note: Browser support for these specific constraints can vary.
    const displayMediaOptions = {
      video: true,
      audio: {
        // --- NEW: Audio constraints for higher quality ---
        // Request ideal sample rate (e.g., 48kHz)
        sampleRate: { ideal: 48000 },
        // Attempt to disable processing that might degrade *system* audio capture
        // These are often default ON for microphone input but may be undesirable here.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // sampleSize: { ideal: 16 }, // Less common support, but can try
        // channelCount: { ideal: 2 } // Request stereo if available/relevant
        // --- END NEW ---
      },
    };
    console.log(
      "Requesting getDisplayMedia with constraints:",
      displayMediaOptions
    );

    const fullStream = await navigator.mediaDevices.getDisplayMedia(
      displayMediaOptions
    );

    // Validate the obtained stream
    if (
      !fullStream ||
      !fullStream.active ||
      fullStream.getTracks().length === 0
    ) {
      throw new Error("Screen capture returned an invalid or empty stream.");
    }

    console.log(
      `Screen capture started successfully. Stream ID: ${fullStream.id}`
    );
    localStream = fullStream; // Store the full stream (video + audio if available)

    // Check actual audio track settings (for debugging)
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length > 0) {
      const settings = audioTracks[0].getSettings();
      console.log("Actual captured audio track settings:", settings);
      if (!settings.sampleRate || settings.sampleRate < 44100) {
        console.warn("Low audio sample rate captured:", settings.sampleRate);
      }
      if (settings.echoCancellation === true) {
        console.warn("Audio track has echoCancellation enabled.");
      }
    } else {
      console.warn("No audio track captured with screen share.");
      setStatus(
        "Screen sharing started, but audio capture failed or was not permitted.",
        false,
        true
      );
    }

    // Attach 'onended' event listeners to tracks
    localStream.getTracks().forEach((track) => {
      console.log(
        ` - Acquired Track: Kind=${track.kind}, ID=${track.id}, State=${track.readyState}, Label=${track.label}`
      );
      if (track.kind === "video") {
        // Detect when the user manually stops sharing via the browser's UI
        track.onended = () => {
          console.log(
            `>>> Video track (${track.id}) ended (likely stopped via browser UI) <<<`
          );
          handleStreamEnded(); // Trigger cleanup when sharing stops
        };
        console.log(`  Attached 'onended' handler to video track ${track.id}`);
      } else {
        // Log ending of other tracks (e.g., audio) for debugging
        track.onended = () => {
          console.warn(`Non-video track (${track.kind}, ${track.id}) ended.`);
        };
      }
    });

    // Create a separate stream containing only video tracks for the local preview
    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length > 0) {
      const previewStream = new MediaStream(videoTracks);
      if (LOCAL_VIDEO) {
        LOCAL_VIDEO.srcObject = previewStream;
        LOCAL_VIDEO.muted = true; // Preview should be muted
        // Attempt to play the preview
        LOCAL_VIDEO.play().catch((e) =>
          console.warn("Local preview playback failed:", e)
        );
        console.log("Assigned video-only stream to local preview element.");
      }
    } else {
      console.warn("No video track found in the captured stream for preview.");
      if (LOCAL_VIDEO) LOCAL_VIDEO.srcObject = null;
    }
  } catch (error) {
    console.error("getDisplayMedia error:", error);
    localStream = null; // Ensure stream is null on error
    if (LOCAL_VIDEO) LOCAL_VIDEO.srcObject = null; // Clear preview on error
    // Provide more specific error messages
    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      throw new Error("Screen sharing permission was denied.");
    } else if (
      error.name === "NotFoundError" ||
      error.name === "DevicesNotFoundError"
    ) {
      throw new Error("No compatible screen capture devices found.");
    } else if (
      error.name === "NotReadableError" ||
      error.name === "TrackStartError"
    ) {
      throw new Error(
        "Screen or audio source is currently busy or unreadable."
      );
    } else if (error.name === "AbortError") {
      throw new Error("Screen sharing request was cancelled.");
    } else if (error.name === "OverconstrainedError") {
      console.error("OverconstrainedError Details:", error.constraint);
      throw new Error(
        `Requested audio/video constraints cannot be met by the device/browser (Constraint: ${
          error.constraint || "unknown"
        }). Try simplifying constraints.`
      );
    } else {
      throw error; // Re-throw the original error for other cases
    }
  }
}

/**
 * Handles the event when the streamer's screen sharing track ends (e.g., user clicks "Stop sharing").
 * This function is primarily called by the `onended` event handler of the local video track.
 * It initiates the cleanup process by calling `closeConnections`.
 */
function handleStreamEnded() {
  console.log(
    ">>> handleStreamEnded called (Streamer likely stopped sharing via browser UI) <<<"
  );
  // Ensure this only runs if the user is in the streamer role and has initialized
  if (role !== "streamer" || !streamerInitialized) {
    console.log(
      "handleStreamEnded exiting: Role not streamer or not initialized."
    );
    return;
  }
  console.log(
    "Proceeding with stream end cleanup initiated by track ending..."
  );
  // Initiate a clean shutdown of all connections and streams.
  // `closeConnections` will handle setting the final status messages.
  closeConnections(true); // Request explicit WebSocket closure as well
}

// --- NEW: SDP Modification Helper ---
/**
 * Modifies the SDP to prefer higher audio quality for the Opus codec.
 * Specifically, attempts to add/set 'maxaveragebitrate' in the 'a=fmtp' line.
 * @param {string} sdp - The original SDP string.
 * @param {number} targetBitrate - The desired average bitrate in bps.
 * @returns {string} The modified SDP string, or the original if modification fails.
 */
function modifySdpForAudioQuality(sdp, targetBitrate) {
  console.log(
    `Attempting to modify SDP for audio bitrate: ${targetBitrate}bps`
  );
  let sdpLines = sdp.split("\r\n");
  let opusPayloadType = null;
  let opusFmtpLineIndex = -1;
  let inAudioSection = false;

  // Find Opus payload type and existing fmtp line within the audio section
  for (let i = 0; i < sdpLines.length; i++) {
    const line = sdpLines[i];
    if (line.startsWith("m=audio")) {
      inAudioSection = true;
    } else if (line.startsWith("m=") && !line.startsWith("m=audio")) {
      inAudioSection = false; // Moved past audio section
    }

    if (inAudioSection) {
      // Find Opus rtpmap line: "a=rtpmap:<payload> opus/48000/2"
      const rtpmapMatch = line.match(/^a=rtpmap:(\d+) opus\/48000\/2/i);
      if (rtpmapMatch) {
        opusPayloadType = rtpmapMatch[1];
        console.log(`Found Opus payload type: ${opusPayloadType}`);
      }

      // Find existing fmtp line for this payload type: "a=fmtp:<payload> ..."
      if (opusPayloadType && line.startsWith(`a=fmtp:${opusPayloadType}`)) {
        opusFmtpLineIndex = i;
        console.log(`Found existing Opus fmtp line at index ${i}: ${line}`);
        break; // Assume only one fmtp per payload type needed
      }
    }
  }

  if (opusPayloadType) {
    const bitrateParam = `maxaveragebitrate=${targetBitrate}`;
    const stereoParam = "stereo=1"; // Often desired with higher bitrate
    const fecParam = "useinbandfec=1"; // Good for resilience

    if (opusFmtpLineIndex !== -1) {
      // Modify existing fmtp line
      let fmtpLine = sdpLines[opusFmtpLineIndex];
      let params = fmtpLine.substring(fmtpLine.indexOf(" ") + 1).split(";");
      let foundBitrate = false;
      let foundStereo = false;
      let foundFec = false;

      params = params.map((p) => p.trim()).filter((p) => p.length > 0); // Clean up parameters

      // Update or add parameters
      for (let j = 0; j < params.length; j++) {
        if (params[j].startsWith("maxaveragebitrate=")) {
          params[j] = bitrateParam;
          foundBitrate = true;
        } else if (params[j].startsWith("stereo=")) {
          params[j] = stereoParam; // Ensure stereo is set if desired
          foundStereo = true;
        } else if (params[j].startsWith("useinbandfec=")) {
          params[j] = fecParam;
          foundFec = true;
        }
      }

      if (!foundBitrate) params.push(bitrateParam);
      if (!foundStereo) params.push(stereoParam);
      if (!foundFec) params.push(fecParam);

      sdpLines[opusFmtpLineIndex] = `a=fmtp:${opusPayloadType} ${params.join(
        ";"
      )}`;
      console.log(`Modified fmtp line: ${sdpLines[opusFmtpLineIndex]}`);
    } else {
      // Add new fmtp line if none existed (less common)
      // Find the line index *after* the corresponding rtpmap line to insert fmtp
      let insertIndex = -1;
      for (let i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].includes(`a=rtpmap:${opusPayloadType}`)) {
          insertIndex = i + 1;
          // Keep searching for potentially better spots (e.g., after other 'a=' lines)
        } else if (
          insertIndex !== -1 &&
          (sdpLines[i].startsWith("m=") || !sdpLines[i].startsWith("a="))
        ) {
          // Stop searching if we hit next media description or non-attribute line
          break;
        }
      }
      if (insertIndex !== -1) {
        const newFmtpLine = `a=fmtp:${opusPayloadType} ${bitrateParam};${stereoParam};${fecParam}`;
        sdpLines.splice(insertIndex, 0, newFmtpLine);
        console.log(
          `Added new fmtp line at index ${insertIndex}: ${newFmtpLine}`
        );
      } else {
        console.warn(
          "Could not find suitable insertion point for new fmtp line."
        );
      }
    }
    return sdpLines.join("\r\n");
  } else {
    console.warn("Opus codec not found in SDP. Cannot modify audio bitrate.");
    return sdp; // Return original SDP if Opus not found
  }
}
// --- END NEW SDP HELPER ---

/**
 * Initiates the process for a viewer to connect to a streamer's broadcast.
 * Triggered by the 'Connect' button in the viewer tab.
 * Reads and validates the entered code, connects to the signaling server (`connectWebSocket`),
 * sets a timeout for the connection attempt, creates a peer connection (`createPeerConnection`),
 * generates an SDP offer, **modifies it for higher audio quality**, sets it as the local description,
 * and sends it to the streamer via WebSocket.
 * Handles errors during the process (invalid code, timeout, connection failure).
 */
async function connectViewer() {
  role = "viewer"; // Ensure role is set to viewer
  viewerTargetCode = CODE_INPUT.value.trim().toUpperCase(); // Get and format the code

  // Validate the entered code format
  if (!viewerTargetCode || viewerTargetCode.length !== 5) {
    setError("Invalid code format. Please enter the 5-character code.");
    return;
  }

  clearError(); // Clear previous errors
  setStatus(`Connecting to stream code ${viewerTargetCode}...`);
  connectViewerButton.disabled = true; // Disable button during connection attempt

  try {
    // Connect to the signaling server's watcher endpoint with the target code
    ws = await connectWebSocket(`${WS_URL_BASE}/watch/${viewerTargetCode}`);

    // Start a timeout for the signaling process (e.g., waiting for an answer)
    clearTimeout(signalingTimeout); // Clear any previous timeout
    signalingTimeout = setTimeout(() => {
      setError(
        `Connection timed out waiting for streamer: ${viewerTargetCode}.`
      );
      console.error("Signaling timeout reached for viewer connection.");
      closeConnections(); // Clean up on timeout
    }, 60000); // 60-second timeout

    // Create the RTCPeerConnection for communicating with the streamer
    const pc = await createPeerConnection(); // Viewer doesn't need a viewerId
    if (!pc) {
      throw new Error("Failed to create RTCPeerConnection.");
    }
    peerConnections.set("streamer", pc); // Store the connection (key 'streamer' identifies the single connection for a viewer)

    // Create an SDP offer to receive audio/video from the streamer
    console.log("Viewer: Creating SDP offer...");
    let offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });

    // --- NEW: Modify SDP Offer ---
    try {
      offer.sdp = modifySdpForAudioQuality(offer.sdp, TARGET_AUDIO_BITRATE);
    } catch (sdpError) {
      console.error("Failed to modify SDP offer for audio quality:", sdpError);
      // Proceed with the original offer if modification fails
    }
    // --- END NEW ---

    // Set the generated offer as the local description
    await pc.setLocalDescription(offer); // Use potentially modified offer
    console.log("Viewer: Set local description (offer).");

    // Send the offer to the streamer via the WebSocket signaling server
    sendMessage(pc.localDescription); // Viewer sends offer directly
  } catch (error) {
    // Provide specific error messages based on common issues
    if (error.message && error.message.includes("404")) {
      // Likely backend response for non-existent code
      setError(
        `Connection failed: Streamer code '${viewerTargetCode}' not found or inactive.`
      );
    } else {
      setError(`Failed to connect as viewer: ${error.message}`);
    }
    console.error("Viewer connection process error:", error);
    closeConnections(); // Clean up resources on failure
  }
}
// Attach listener to the viewer connect button
connectViewerButton.addEventListener("click", connectViewer);

/**
 * Handles incoming messages received via the WebSocket connection.
 * Parses the JSON message and routes it based on the current `role` (streamer/viewer)
 * and the message content (type, sdp, candidate, etc.).
 * Manages the signaling exchange required for WebRTC setup (offer, answer, candidates).
 * Streamer: **modifies the answer SDP** before sending.
 * @param {MessageEvent} event - The WebSocket message event containing the data.
 */
async function handleWebSocketMessage(event) {
  try {
    const message = JSON.parse(event.data);
    console.log("WebSocket message received:", message);

    // --- Streamer Message Handling ---
    if (role === "streamer") {
      // Handle receiving the unique streamer code from the server
      if (message.code) {
        streamerCode = message.code;
        STREAMER_CODE_DISPLAY.textContent = streamerCode; // Display the code in the UI
        setStatus("Streaming - Share this code with viewers.", true);
        console.log(`Streamer received code: ${streamerCode}`);
        return; // Code message handled
      }

      // Handle notification that a viewer has disconnected (sent by server)
      if (message.type === "viewer_left" && message.viewerId) {
        console.log(
          `Streamer received notification: Viewer ${message.viewerId} left.`
        );
        handleViewerDisconnect(message.viewerId); // Clean up connection for this viewer
        return; // Viewer left message handled
      }

      // --- Handle SDP Offer from a new Viewer ---
      if (message.from && message.data && message.data.type === "offer") {
        const viewerId = message.from; // ID assigned by the server to the viewer
        const offerData = message.data;
        console.log(`Streamer: Received SDP offer from viewer ${viewerId}.`);

        // Check if a connection for this viewer already exists and is closed; clean up if so.
        let pc = peerConnections.get(viewerId);
        if (
          pc &&
          (pc.connectionState === "closed" || pc.signalingState === "closed")
        ) {
          console.warn(
            `Streamer: Stale/closed connection found for ${viewerId}, cleaning up before creating new one.`
          );
          handleViewerDisconnect(viewerId);
          pc = null;
        }

        // Create a new PeerConnection for this viewer if one doesn't exist
        if (!pc) {
          pc = await createPeerConnection(viewerId);
          if (!pc) {
            console.error(
              `Streamer: Failed to create PeerConnection for ${viewerId}.`
            );
            return;
          }
          peerConnections.set(viewerId, pc); // Store the new connection
          updateViewerCount(); // Update UI
        }

        // Ensure the local screen stream is active before proceeding
        if (!localStream || !localStream.active) {
          setError(
            `Streamer: Screen stream is not active. Cannot answer offer from ${viewerId}.`
          );
          console.error(
            `Streamer: Local stream inactive when receiving offer from ${viewerId}.`
          );
          handleViewerDisconnect(viewerId); // Disconnect this viewer
          return;
        }
        const activeTracks = localStream
          .getTracks()
          .filter((t) => t.readyState === "live");
        if (activeTracks.length === 0) {
          setError(
            `Streamer: No active tracks in the screen stream. Cannot answer offer from ${viewerId}.`
          );
          console.error(
            `Streamer: No live tracks in local stream when receiving offer from ${viewerId}.`
          );
          handleViewerDisconnect(viewerId); // Disconnect this viewer
          return;
        }

        // Set the received offer as the remote description
        await pc.setRemoteDescription(new RTCSessionDescription(offerData));
        console.log(
          `Streamer: Set remote description (offer) for viewer ${viewerId}.`
        );

        // Add local stream tracks to the PeerConnection to send to the viewer
        const senders = pc.getSenders();
        activeTracks.forEach((track) => {
          // Only add track if a sender for it doesn't already exist
          if (!senders.find((s) => s.track === track)) {
            console.log(
              `Streamer: Adding ${track.kind} track to PC for ${viewerId}`
            );
            pc.addTrack(track, localStream);
          } else {
            console.log(
              `Streamer: Sender for ${track.kind} track already exists for ${viewerId}`
            );
          }
        });

        // Create an SDP answer
        let answer = await pc.createAnswer();

        // --- NEW: Modify SDP Answer ---
        try {
          answer.sdp = modifySdpForAudioQuality(
            answer.sdp,
            TARGET_AUDIO_BITRATE
          );
        } catch (sdpError) {
          console.error(
            "Failed to modify SDP answer for audio quality:",
            sdpError
          );
          // Proceed with the original answer if modification fails
        }
        // --- END NEW ---

        // Set the answer as the local description
        await pc.setLocalDescription(answer); // Use potentially modified answer
        console.log(
          `Streamer: Set local description (answer) for viewer ${viewerId}.`
        );

        // Send the answer back to the specific viewer via WebSocket
        sendMessage(pc.localDescription, viewerId);
        console.log(`Streamer: Sent SDP answer to viewer ${viewerId}.`);
        return; // Offer handled
      }

      // --- Handle ICE Candidate from a Viewer ---
      if (
        message.from &&
        message.data &&
        message.data.type === "candidate" &&
        message.data.candidate
      ) {
        const viewerId = message.from;
        const candidateData = message.data.candidate;
        const pc = peerConnections.get(viewerId);

        // Add the ICE candidate if the connection exists and has a remote description set
        if (pc && pc.remoteDescription && pc.signalingState !== "closed") {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidateData));
            // console.log(`Streamer: Added ICE candidate from viewer ${viewerId}.`);
          } catch (e) {
            console.warn(
              `Streamer: Error adding ICE candidate from ${viewerId}: ${e.message}`
            );
          }
        } else if (pc && !pc.remoteDescription) {
          console.warn(
            `Streamer: Received ICE candidate from ${viewerId} before remote description was set. Ignoring.`
          );
        } else if (!pc) {
          console.warn(
            `Streamer: Received ICE candidate for unknown or closed viewer ${viewerId}. Ignoring.`
          );
        }
        return; // Candidate handled
      }
    }

    // --- Viewer Message Handling ---
    if (role === "viewer") {
      const pc = peerConnections.get("streamer"); // Viewer has only one connection

      // Ignore messages if the peer connection doesn't exist or is closed
      if (!pc || pc.signalingState === "closed") {
        console.warn(
          "Viewer: Received message but PeerConnection is missing or closed. Ignoring."
        );
        return;
      }

      // --- Handle SDP Answer from the Streamer ---
      if (message.type === "answer" && message.sdp) {
        console.log("Viewer: Received SDP answer from streamer.");

        // Check signaling state; should ideally be 'have-local-offer'
        if (pc.signalingState !== "have-local-offer") {
          console.warn(
            `Viewer: Received answer in unexpected signaling state: ${pc.signalingState}.`
          );
        }

        // Set the received answer as the remote description if not already set
        if (!pc.currentRemoteDescription) {
          try {
            // Note: We expect the streamer might have modified the SDP answer already.
            await pc.setRemoteDescription(new RTCSessionDescription(message));
            console.log(
              `Viewer: Set remote description (answer). WebRTC negotiation proceeding.`
            );
            clearTimeout(signalingTimeout); // Successfully received answer, clear timeout
            signalingTimeout = null;
          } catch (e) {
            console.error(
              "Viewer: Error setting remote description (answer):",
              e
            );
            setError(
              `Viewer: Failed to process streamer's answer: ${e.message}`
            );
            closeConnections();
          }
        } else {
          console.warn(
            "Viewer: Received answer but remote description already set. Ignoring duplicate."
          );
        }
        return; // Answer handled
      }

      // --- Handle ICE Candidate from the Streamer ---
      if (message.type === "candidate" && message.candidate) {
        // console.log("Viewer: Received ICE candidate from streamer.");
        try {
          // Add the ICE candidate. This can happen before or after the answer is received.
          await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) {
          // It's somewhat common to get candidates before the remote description is set,
          // the browser might buffer them, but log warnings if addIceCandidate fails.
          console.warn(`Viewer: Error adding ICE candidate: ${e.message}`);
        }
        return; // Candidate handled
      }
    }

    // Log any message that wasn't handled by the logic above
    console.warn("Unhandled WebSocket message:", message);
  } catch (error) {
    console.error(
      "Failed to process WebSocket message:",
      error,
      "Raw data:",
      event.data
    );
    setError(`Error processing signaling message: ${error.message}`);
    // Depending on the error severity, consider calling closeConnections() here.
  }
}

/**
 * Sends signaling data (SDP offer/answer or ICE candidates) over the WebSocket connection.
 * Formats the message payload according to the user's role.
 * Streamers must specify the target viewer ID. Viewers send directly.
 * Checks WebSocket connection state before attempting to send.
 * @param {RTCSessionDescriptionInit | RTCIceCandidate} payload - The SDP data or ICE candidate to send.
 * @param {string | null} [targetViewerId=null] - The specific viewer ID to send to (used only by streamer).
 */
function sendMessage(payload, targetViewerId = null) {
  // Check if WebSocket is connected and ready to send
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Don't log error if viewer WS is expectedly closed after WebRTC connect
    if (
      !(
        role === "viewer" &&
        !wsConnected &&
        peerConnections.has("streamer") &&
        peerConnections.get("streamer").connectionState === "connected"
      )
    ) {
      console.error("sendMessage Error: WebSocket is not open or available.");
      // Avoid flooding errors if already showing a warning
      if (!STATUS_DISPLAY.className.includes("warning")) {
        setError("Cannot send message: Signaling connection inactive.");
      }
    } else {
      console.log(
        "sendMessage skipped: Viewer WebSocket intentionally closed after WebRTC connection."
      );
    }
    return;
  }

  if (!payload) {
    console.error("sendMessage Error: Payload is null or undefined.");
    return;
  }

  let messageToSend = {};
  let rtcPayload = {};

  // Format payload based on type (ICE Candidate or SDP)
  if (
    payload instanceof RTCIceCandidate ||
    (payload.type === "candidate" && typeof payload.candidate !== "undefined")
  ) {
    // Handle both actual RTCIceCandidate objects and plain candidate objects from signaling
    const candidate = payload.candidate;
    // Don't send null candidates which signify end-of-candidates
    if (!candidate) {
      // console.log("sendMessage: Null ICE candidate, skipping send.");
      return;
    }
    // Ensure we send the plain object representation
    rtcPayload = {
      type: "candidate",
      candidate:
        typeof candidate === "string" ? JSON.parse(candidate) : candidate,
    }; // Handle potential stringified candidate
    // Re-stringify just the candidate part if needed for consistency, or assume server handles object
    // Let's simplify: assume payload is the object ready to be embedded
    rtcPayload = { type: "candidate", candidate: payload.candidate };
  } else if (payload.type && payload.sdp) {
    // Check for SDP object (offer/answer)
    rtcPayload = { type: payload.type, sdp: payload.sdp };
  } else {
    console.error("sendMessage Error: Invalid payload type.", payload);
    return;
  }

  // Construct the final message based on role
  if (role === "streamer" && targetViewerId) {
    // Streamer sends directed messages to a specific viewer
    messageToSend = { to: targetViewerId, data: rtcPayload };
  } else if (role === "viewer") {
    // Viewer sends messages directly (server knows it's intended for the streamer)
    messageToSend = rtcPayload;
  } else {
    console.error(
      "sendMessage Error: Cannot determine message format (Invalid role or target)."
    );
    return;
  }

  // Send the message over WebSocket
  try {
    ws.send(JSON.stringify(messageToSend));
    // console.log(`Sent message: `, messageToSend); // Verbose logging for debugging
  } catch (e) {
    setError(`Failed to send signaling message: ${e.message}`);
    console.error(
      "WebSocket send failed for message:",
      messageToSend,
      "Error:",
      e
    );
  }
}

/**
 * Creates and configures a new RTCPeerConnection object.
 * Sets up essential event handlers for ICE candidates, track reception, and connection state changes.
 * These handlers manage the core WebRTC communication flow after signaling.
 * @param {string | null} [viewerId=null] - The ID of the viewer this connection is for (used by streamer for logging/context).
 * @returns {Promise<RTCPeerConnection | null>} A promise resolving with the created RTCPeerConnection, or null on failure.
 */
async function createPeerConnection(viewerId = null) {
  const logPrefix =
    role === "streamer" ? `[PC for Viewer ${viewerId}]` : "[Viewer PC]";
  console.log(`${logPrefix} Creating new RTCPeerConnection...`);

  // Configuration using a public STUN server for NAT traversal
  const configuration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      // Add TURN servers here if needed for more complex network scenarios
    ],
  };

  let pc = null;
  try {
    pc = new RTCPeerConnection(configuration);
  } catch (e) {
    console.error(`${logPrefix} Failed to create RTCPeerConnection object:`, e);
    setError(
      `WebRTC setup failed: Could not create PeerConnection. ${e.message}`
    );
    return null; // Return null on creation failure
  }

  // --- RTCPeerConnection Event Handlers ---

  // Called when the local ICE agent needs to deliver a candidate to the remote peer via the signaling channel.
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      // Send the generated ICE candidate to the other peer via WebSocket
      // console.log(`${logPrefix} Generated ICE candidate:`, event.candidate.type, event.candidate.sdpMLineIndex);
      // Pass the candidate object directly
      sendMessage(
        { type: "candidate", candidate: event.candidate.toJSON() },
        role === "streamer" ? viewerId : null
      );
    } else {
      // Null candidate indicates the end of candidate gathering
      console.log(`${logPrefix} ICE candidate gathering complete.`);
    }
  };

  // Called when a remote track is added to the connection (i.e., when media starts arriving).
  // CRUCIAL for the viewer to receive and display the stream.
  pc.ontrack = (event) => {
    console.log(
      `>>> ${logPrefix} Received remote track: Kind=${event.track.kind}, ID=${event.track.id} <<<`
    );
    if (role === "viewer" && REMOTE_VIDEO) {
      // Assign the received stream(s) to the remote video element
      if (event.streams && event.streams[0]) {
        // Check if the stream is already assigned to prevent unnecessary updates
        if (REMOTE_VIDEO.srcObject !== event.streams[0]) {
          REMOTE_VIDEO.srcObject = event.streams[0];
          console.log(
            `${logPrefix} Assigned incoming stream to remote video element.`
          );

          // Activate the Plyr controls now that the stream is ready
          const container = document.getElementById("remoteVideoContainer");
          if (container) {
            container.classList.remove("plyr-inactive");
            console.log(
              `${logPrefix} Activated Plyr controls for remote video.`
            );
          }
          // Attempt to play the remote video via Plyr
          remotePlayer
            ?.play()
            .catch((err) =>
              console.warn(
                `${logPrefix} Remote video play() failed (might autoplay block):`,
                err
              )
            );
        }
      } else {
        // Should not happen with standard WebRTC, but log if a track arrives without a stream
        console.warn(
          `${logPrefix} Received track event without associated MediaStream.`
        );
      }
    } else if (role === "streamer") {
      // Streamer typically doesn't receive tracks in this setup, but log if it happens.
      console.log(
        `${logPrefix} Received unexpected track of kind: ${event.track.kind}`
      );
    }
  };

  // Called when the state of the ICE connection changes (e.g., checking, connected, failed).
  pc.oniceconnectionstatechange = () => {
    const state = pc?.iceConnectionState; // Use optional chaining
    console.log(`${logPrefix} ICE Connection State Changed: ${state}`);
    switch (state) {
      case "connected":
        // Usually superseded by 'connectionstatechange', but good to log.
        console.log(`${logPrefix} ICE connection established.`);
        break;
      case "disconnected":
        // May recover, treat as a warning. 'failed' is terminal.
        console.warn(
          `${logPrefix} ICE connection disconnected. Waiting for potential reconnection...`
        );
        // Optionally start a timer here to check for 'failed' state later.
        break;
      case "failed":
        // Terminal failure in ICE connectivity.
        setError(
          `WebRTC connection failed (ICE negotiation) ${
            role === "streamer" ? "for viewer " + viewerId : ""
          }.`
        );
        console.error(`${logPrefix} ICE connection failed.`);
        if (role === "streamer") {
          handleViewerDisconnect(viewerId); // Clean up streamer side
        } else {
          closeConnections(); // Clean up viewer side
        }
        break;
      case "closed":
        console.log(`${logPrefix} ICE connection closed.`);
        break;
    }
    // Update viewer count on state changes (relevant for streamer)
    if (role === "streamer") updateViewerCount();
  };

  // Called when the overall connection state changes (combines ICE and DTLS states).
  // This is often the most reliable indicator of the connection status.
  pc.onconnectionstatechange = () => {
    const state = pc?.connectionState; // Use optional chaining
    console.log(`${logPrefix} Connection State Changed: ${state}`);

    switch (state) {
      case "connected":
        // Successfully connected peer-to-peer.
        // Set success status only if not already showing success (avoids flicker)
        if (STATUS_DISPLAY.className !== "success") {
          setStatus(
            role === "viewer"
              ? "Connected to Stream"
              : `Viewer ${viewerId || ""} Connected`,
            true
          );
        }
        // **Viewer Optimization:** Once WebRTC is connected, the viewer no longer needs the WebSocket for signaling.
        if (role === "viewer") {
          console.log("Viewer: WebRTC connected. Closing signaling WebSocket.");
          clearTimeout(signalingTimeout); // Stop connection timeout
          signalingTimeout = null;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "WebRTC connected, signaling no longer needed"); // Normal closure
          }
          wsConnected = false; // Mark WS as disconnected
          connectViewerButton.disabled = false; // Re-enable button (maybe to connect to another stream later)
        }
        break;
      case "failed":
        // Terminal failure in the connection (ICE or DTLS).
        setError(
          `WebRTC connection failed ${
            role === "streamer" ? "for viewer " + viewerId : ""
          }.`
        );
        console.error(`${logPrefix} PeerConnection failed.`);
        if (role === "streamer") {
          handleViewerDisconnect(viewerId); // Clean up streamer side
        } else {
          closeConnections(); // Clean up viewer side
        }
        break;
      case "closed":
        // Connection has been closed (either locally or remotely).
        console.log(`${logPrefix} PeerConnection closed.`);
        // Set status to indicate closure, unless an error is already displayed
        if (!ERROR_DISPLAY.textContent) {
          setStatus(
            role === "viewer"
              ? "Stream ended or connection closed."
              : `Connection to viewer ${viewerId || ""} closed.`
          );
        }
        // Reset player if viewer connection closes
        if (role === "viewer") {
          console.log("Viewer connection closed, resetting remote player.");
          // Resetting players ensures video stops and controls might hide
          initializePlyrPlayers(false);
          if (connectViewerButton) connectViewerButton.disabled = false; // Re-enable connect button
        } else if (role === "streamer" && peerConnections.has(viewerId)) {
          // Ensure cleanup if the connection closed unexpectedly from streamer's perspective
          handleViewerDisconnect(viewerId);
        }
        break;
      case "disconnected":
        // Connection lost temporarily (e.g., network interruption). Might recover to 'connected' or transition to 'failed'.
        console.warn(
          `${logPrefix} PeerConnection disconnected. Monitoring for failure or recovery...`
        );
        // Can add a timer here for cleanup if it stays disconnected too long.
        break;
      case "new": // Initial state
      case "connecting": // Negotiation in progress
        console.log(`${logPrefix} PeerConnection state: ${state}`);
        break;
    }
    // Update viewer count on state changes (relevant for streamer)
    if (role === "streamer") updateViewerCount();
  };

  // Called when the signaling state changes (related to SDP offer/answer exchange).
  pc.onsignalingstatechange = () => {
    // Mostly for debugging the offer/answer flow.
    console.log(`${logPrefix} Signaling State Changed: ${pc?.signalingState}`);
    // States: stable, have-local-offer, have-remote-offer, have-local-pranswer, have-remote-pranswer, closed
  };

  console.log(
    `${logPrefix} RTCPeerConnection created and event listeners attached.`
  );
  return pc;
}

/**
 * Handles the disconnection of a specific viewer from the streamer's perspective.
 * Closes the RTCPeerConnection associated with the viewer, removes it from the map,
 * and updates the viewer count display.
 * Called when the server sends a 'viewer_left' message or when a connection fails/closes.
 * @param {string} viewerId - The ID of the viewer to disconnect.
 */
function handleViewerDisconnect(viewerId) {
  if (role !== "streamer") return; // Only applicable for the streamer role

  const pc = peerConnections.get(viewerId);
  if (pc) {
    console.log(`Streamer: Disconnecting viewer ${viewerId}.`);
    // Remove event listeners to prevent potential issues during close
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    // Close the connection if not already closed
    if (pc.signalingState !== "closed") {
      pc.close();
    }
    // Remove the connection from the map
    peerConnections.delete(viewerId);
    console.log(
      `Streamer: Removed PeerConnection for viewer ${viewerId}. Remaining viewers: ${peerConnections.size}`
    );
    updateViewerCount(); // Update the UI
  } else {
    console.warn(
      `Streamer: Attempted to disconnect viewer ${viewerId}, but no active connection was found.`
    );
  }
}

/**
 * Gracefully closes all active connections and resets the application state.
 * Stops local and remote media streams, closes all RTCPeerConnections,
 * optionally closes the WebSocket connection, resets video players,
 * and resets UI elements (buttons, status displays) to their initial state.
 * Includes a flag to prevent recursive calls.
 * @param {boolean} [closeWsExplicitly=true] - Whether to explicitly close the WebSocket connection. Set to false if WS closure is handled elsewhere (e.g., onerror).
 */
function closeConnections(closeWsExplicitly = true) {
  // Prevent recursion if closeConnections is called from within an event handler it triggers
  if (closingConnections) {
    console.log(
      "closeConnections() called while already running, skipping to prevent recursion."
    );
    return;
  }
  closingConnections = true; // Set flag
  console.log(
    `>>> closeConnections called (Explicit WebSocket Close: ${closeWsExplicitly}) <<<`
  );
  setStatus("Closing connections..."); // Initial status update for cleanup process
  clearTimeout(signalingTimeout); // Clear any pending connection timeouts
  signalingTimeout = null;

  // 1. Stop Media Streams FIRST to release camera/screen resources
  if (localStream) {
    console.log("Stopping local stream tracks in closeConnections...");
    localStream.getTracks().forEach((track) => {
      track.onended = null; // Remove event handlers before stopping
      track.stop();
    });
    localStream = null;
    if (LOCAL_VIDEO) LOCAL_VIDEO.srcObject = null; // Clear local preview
    console.log("Local stream stopped and preview cleared.");
  }
  // Stop remote video tracks if viewer
  if (REMOTE_VIDEO && REMOTE_VIDEO.srcObject) {
    console.log("Stopping remote video stream tracks...");
    try {
      // Access tracks safely
      const remoteTracks = REMOTE_VIDEO.srcObject.getTracks();
      remoteTracks.forEach((track) => track.stop());
    } catch (e) {
      console.warn("Error stopping remote video tracks:", e);
    }
    REMOTE_VIDEO.srcObject = null; // Clear remote video display
    console.log("Remote video stream stopped and display cleared.");
  }

  // 2. Close all active RTCPeerConnections
  if (peerConnections.size > 0) {
    console.log(`Closing ${peerConnections.size} PeerConnection(s)...`);
    peerConnections.forEach((pc, id) => {
      console.log(
        `Closing PC for ${role === "viewer" ? "streamer" : "viewer " + id}`
      );
      // Remove listeners before closing
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      // Close the connection
      if (pc.signalingState !== "closed") {
        pc.close();
      }
    });
    peerConnections.clear(); // Clear the map
    if (role === "streamer") updateViewerCount(); // Update UI count
    console.log("All PeerConnections closed and map cleared.");
  }

  // 3. Close WebSocket Connection (optional)
  if (ws && closeWsExplicitly) {
    console.log(
      `Explicitly closing WebSocket (Current state: ${ws.readyState})...`
    );
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      // Remove handlers to prevent them firing after explicit close request
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close(1000, "Client initiated disconnect"); // Normal closure
    }
    ws = null; // Nullify reference
    wsConnected = false;
    console.log("WebSocket explicitly closed.");
  } else if (ws && !closeWsExplicitly) {
    console.log("Skipping explicit WebSocket closure as requested.");
  }

  // 4. Reset Video Players (after sources are cleared and PCs are closed)
  // This ensures the players are in a clean state for potential reuse.
  console.log("Resetting video players in closeConnections...");
  try {
    initializePlyrPlayers(false); // Re-initialize/reset player state
    console.log("Plyr players reset.");
  } catch (e) {
    console.error("Error during player reset in closeConnections:", e);
  }

  // 5. Reset State Flags and UI Elements
  streamerInitialized = false; // Reset streamer initialization flag
  streamerCode = null; // Clear streamer code
  viewerTargetCode = null; // Clear viewer target code

  // Reset Streamer UI elements
  if (STREAMER_CODE_DISPLAY) STREAMER_CODE_DISPLAY.textContent = "Waiting...";
  if (VIEWER_COUNT_DISPLAY) VIEWER_COUNT_DISPLAY.textContent = "0";
  // --- MODIFIED: Only re-enable if supported ---
  if (initiateStreamButton && isDisplayMediaSupported) {
    initiateStreamButton.style.display = "inline-block"; // Show the start button again
    initiateStreamButton.disabled = false; // Re-enable it
  }
  // Reset Viewer UI elements
  if (connectViewerButton) {
    connectViewerButton.disabled = false; // Re-enable connect button
  }
  if (CODE_INPUT) {
    // Optionally clear the code input: CODE_INPUT.value = '';
  }
  // Reset player container inactive state for viewer
  const remoteContainer = document.getElementById("remoteVideoContainer");
  if (remoteContainer) remoteContainer.classList.add("plyr-inactive");

  console.log("Application state and UI elements reset.");

  // 6. Set Final Status
  // Set a final, neutral status AFTER all cleanup. Avoids being overwritten by intermediate statuses.
  // Do not clear errors here, let them persist if set during the closing process (like the 'unsupported' error).
  if (!ERROR_DISPLAY.textContent.includes("not supported by your browser")) {
    setStatus("Connections closed. Ready."); // Indicate ready state
  }
  console.log(">>> Finished closeConnections <<<");

  closingConnections = false; // Reset recursion prevention flag
}

// --- Page Lifecycle Cleanup ---
// Attempt cleanup when the user navigates away or closes the tab/window.

// 'pagehide' is often more reliable than 'unload', especially for mobile backgrounding.
window.addEventListener("pagehide", (event) => {
  // event.persisted is true if the page is put into the back-forward cache.
  if (!event.persisted) {
    console.log("pagehide event (not persisted): Initiating cleanup.");
    closeConnections(true); // Attempt full cleanup
  } else {
    console.log(
      "pagehide event (persisted): Page may be restored, skipping full cleanup."
    );
  }
});

// 'beforeunload' provides a last chance, but execution isn't guaranteed.
window.addEventListener("beforeunload", () => {
  console.log("beforeunload event: Attempting basic cleanup.");
  // Less reliable cleanup: Quickly close connections without full state reset logic.
  if (peerConnections) {
    peerConnections.forEach((pc) => {
      if (pc && pc.signalingState !== "closed") {
        pc.close();
      }
    });
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Use code 1001 (Going Away) to indicate the browser window is closing.
    ws.close(1001, "Browser unloading");
  }
  // Don't call full closeConnections here as it might be too slow or interrupted.
});

// --- Initial Setup ---
checkDisplayMediaSupport();
// Set the default view to the 'Watch Stream' tab when the page loads.
switchTab("watchTabContent");
setStatus("Idle"); // Set initial status after checks
