// =============================================================================
// Shared WebRTC, media, UI, and auth logic used by both signaling adapters.
// Signaling-specific code (Firestore / RTDB API calls) lives in the adapters.
// =============================================================================

import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase-config.js";

// --- WEBRTC CONFIGURATION ---
export const ICE_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ],
  iceCandidatePoolSize: 10
};

// --- SHARED MUTABLE STATE ---
export const state = {
  userID: "",
  localStream: null,
  remoteStream: null,
  screenShareStream: null,
  pc: null,
  unsubscribes: [],
  iceCandidatesQueue: []
};

// --- ADAPTER CALLBACKS ---
// Signaling adapters set `callbacks.hangupCleanup` to perform their own
// backend-specific teardown when a call ends (e.g. update Firestore doc,
// remove RTDB node). Signature: async (callId: string, userID: string) => void
export const callbacks = {
  hangupCleanup: null
};

// --- DOM ELEMENTS ---
export const DOM = {
  webcamButton: document.getElementById("webcamButton"),
  webcamVideo: document.getElementById("webcamVideo"),
  screenShareButton: document.getElementById("screenShareButton"),
  callButton: document.getElementById("callButton"),
  callInput: document.getElementById("callInput"),
  answerButton: document.getElementById("answerButton"),
  remoteVideo: document.getElementById("remoteVideo"),
  hangupButton: document.getElementById("hangupButton"),
  copyButton: document.getElementById("copyButton"),
  cameraEnableOverlay: document.getElementById("cameraEnableOverlay"),
  connectionStatus: document.getElementById("connectionStatus"),
  connectionText: document.getElementById("connectionText"),
  localStatus: document.getElementById("localStatus"),
  remoteStatus: document.getElementById("remoteStatus")
};

// =============================================================================
// UI HELPERS
// =============================================================================

export function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  const dismiss = () => {
    toast.style.animation = "fade-out 0.5s cubic-bezier(0.16, 1, 0.5, 1) forwards";
    toast.addEventListener("animationend", () => toast.remove());
  };

  toast.querySelector(".toast-close").onclick = dismiss;
  setTimeout(() => { if (toast.parentNode) dismiss(); }, 4000);
}

export function updateConnectionState(connectionState) {
  if (!DOM.connectionStatus || !DOM.connectionText) return;
  DOM.connectionStatus.setAttribute("data-status", connectionState.toLowerCase());

  const labels = {
    connecting: "Connecting...",
    connected: "Connected",
    failed: "Failed/Timeout",
    closed: "Call Closed"
  };
  DOM.connectionText.textContent = labels[connectionState] ?? "Disconnected";
}

export function resetUIAfterHangup() {
  // Camera stays on — only reset call controls
  DOM.callButton.disabled = false;
  DOM.callInput.disabled = false;
  DOM.callInput.value = "";
  DOM.copyButton.disabled = false;
  // Swap: hide End Call → restore Answer Call
  DOM.hangupButton.style.display = "none";
  DOM.answerButton.style.display = "";
  DOM.answerButton.disabled = false;
}

// Called by the signaling adapter once a call session begins
export function enterCallMode() {
  DOM.callButton.disabled = true;
  DOM.callInput.disabled = true;
  // Swap: hide Answer Call → show End Call
  DOM.answerButton.style.display = "none";
  DOM.hangupButton.style.display = "";
  DOM.hangupButton.disabled = false;
}

// =============================================================================
// SUBSCRIPTION MANAGEMENT
// =============================================================================

export function clearSubscriptions() {
  state.unsubscribes.forEach((unsub) => {
    try { unsub(); } catch (e) { console.warn("Unsubscribing error:", e); }
  });
  state.unsubscribes = [];
}

// =============================================================================
// PEER CONNECTION
// =============================================================================

export function setupPeerConnection() {
  if (state.pc) state.pc.close();

  state.pc = new RTCPeerConnection(ICE_CONFIG);
  state.iceCandidatesQueue.length = 0;
  // Fresh stream for each new call so stale tracks don't linger
  state.remoteStream = new MediaStream();

  state.pc.onconnectionstatechange = () => {
    const s = state.pc.connectionState;
    console.log("PeerConnection State:", s);

    if (s === "connected") {
      updateConnectionState("connected");
      DOM.remoteStatus.textContent = "Connected";
      showToast("WebRTC connection established!", "success");
    } else if (s === "connecting") {
      updateConnectionState("connecting");
      DOM.remoteStatus.textContent = "Connecting...";
    } else if (s === "failed" || s === "disconnected") {
      updateConnectionState("disconnected");
      DOM.remoteStatus.textContent = "Offline";
      showToast("WebRTC connection lost.", "error");
    }
  };

  state.pc.oniceconnectionstatechange = () => {
    console.log("ICE Connection State:", state.pc.iceConnectionState);
  };

  state.pc.ontrack = (event) => {
    console.log("Remote stream track added:", event.streams);
    if (event.streams?.[0]) {
      event.streams[0].getTracks().forEach((track) => {
        state.remoteStream.addTrack(track);
      });
      DOM.remoteVideo.srcObject = state.remoteStream;
      DOM.remoteStatus.textContent = "Active";
    }
  };

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      state.pc.addTrack(track, state.localStream);
    });
  }
}

// =============================================================================
// ICE CANDIDATE HELPERS
// =============================================================================

export async function addRemoteIceCandidate(candidateData) {
  try {
    if (!state.pc.remoteDescription) {
      state.iceCandidatesQueue.push(candidateData);
      console.log("Queued ICE candidate (remote SDP not set yet)");
    } else {
      await state.pc.addIceCandidate(candidateData);
      console.log("Applied ICE candidate directly");
    }
  } catch (error) {
    console.error("Error setting ICE candidate:", error);
  }
}

export async function processQueuedIceCandidates() {
  console.log(`Processing ${state.iceCandidatesQueue.length} queued ICE candidates`);
  for (const candidate of state.iceCandidatesQueue) {
    await state.pc.addIceCandidate(candidate).catch((error) => {
      console.error("Error applying queued ICE candidate:", error);
    });
  }
  state.iceCandidatesQueue.length = 0;
}

// =============================================================================
// MEDIA MANAGEMENT
// =============================================================================

export function stopAllMedia() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    DOM.webcamVideo.srcObject = null;
    DOM.localStatus.textContent = "Inactive";
  }
  if (state.remoteStream) {
    state.remoteStream.getTracks().forEach((t) => t.stop());
    state.remoteStream = null;
    DOM.remoteVideo.srcObject = null;
    DOM.remoteStatus.textContent = "Offline";
  }
}

// =============================================================================
// HANGUP
// =============================================================================

export async function handleHangup(notifyPeer = true) {
  DOM.hangupButton.disabled = true;
  showToast("Leaving session...", "info");

  clearSubscriptions();

  const callId = DOM.callInput.value.trim();
  if (notifyPeer && callId && callbacks.hangupCleanup) {
    try {
      await callbacks.hangupCleanup(callId, state.userID);
    } catch (e) {
      console.warn("Signaling cleanup error:", e.message);
    }
  }

  // Stop REMOTE stream only — local camera stays active
  if (state.remoteStream) {
    state.remoteStream.getTracks().forEach((t) => t.stop());
    state.remoteStream = null;
    DOM.remoteVideo.srcObject = null;
    DOM.remoteStatus.textContent = "Offline";
  }

  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }

  updateConnectionState("disconnected");
  showToast("Session ended.", "success");
  resetUIAfterHangup();
}

// =============================================================================
// BUTTON EVENT LISTENERS (shared across both adapters)
// =============================================================================

DOM.webcamButton.onclick = async () => {
  try {
    DOM.webcamButton.disabled = true;
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // Hide the overlay permanently — camera is now live
    DOM.cameraEnableOverlay.style.display = "none";
    DOM.webcamVideo.srcObject = state.localStream;
    DOM.localStatus.textContent = "Active";
    showToast("Camera enabled.", "success");

    // Show screen share button now that camera is active
    DOM.screenShareButton.style.display = "";

    // Unlock call controls
    DOM.callButton.disabled = false;
    DOM.callInput.disabled = false;
    DOM.answerButton.disabled = false;
    DOM.copyButton.disabled = false;
  } catch (error) {
    console.error("Webcam access error:", error);
    showToast("Failed to enable camera. Please allow access and try again.", "error");
    DOM.webcamButton.disabled = false;
  }
};

// --- SCREEN SHARE HELPERS ---

// Replace the video track sent over the peer connection with `newTrack`
function replaceVideoTrack(newTrack) {
  if (!state.pc) return;
  const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (sender) sender.replaceTrack(newTrack);
}

// Stop screen sharing and restore the webcam video track
export async function stopScreenShare() {
  if (!state.screenShareStream) return;

  // Stop all screen capture tracks
  state.screenShareStream.getTracks().forEach((t) => t.stop());
  state.screenShareStream = null;

  // Restore webcam video in local preview
  DOM.webcamVideo.srcObject = state.localStream;
  DOM.webcamVideo.classList.remove("no-mirror"); // restore webcam mirror effect

  // Send webcam video track back to peer
  const webcamVideoTrack = state.localStream.getVideoTracks()[0];
  if (webcamVideoTrack) replaceVideoTrack(webcamVideoTrack);

  // Update button UI
  const btn = DOM.screenShareButton;
  btn.classList.remove("sharing");
  btn.querySelector("span").textContent = "Share Screen";
  btn.querySelector("svg").innerHTML = `<rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />`;

  DOM.localStatus.textContent = "Active";
  showToast("Screen sharing stopped.", "info");
}

DOM.screenShareButton.onclick = async () => {
  // If already sharing — stop
  if (state.screenShareStream) {
    await stopScreenShare();
    return;
  }

  try {
    // Capture the display; also capture mic audio so voice is mixed in
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "always" },
      audio: false           // display audio (system/tab) captured separately below
    });

    // Try to get microphone audio to mix with screen share
    let micAudioTrack = null;
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micAudioTrack = micStream.getAudioTracks()[0];
    } catch (micErr) {
      console.warn("Could not capture microphone audio:", micErr);
    }

    // Build the composite stream shown locally (screen video only — no need to show mic waveform)
    state.screenShareStream = displayStream;
    if (micAudioTrack) displayStream.addTrack(micAudioTrack);

    const screenVideoTrack = displayStream.getVideoTracks()[0];

    // Show screen in local preview (no mirror — screen content should not be flipped)
    DOM.webcamVideo.srcObject = displayStream;
    DOM.webcamVideo.classList.add("no-mirror");

    // Send screen video to the remote peer
    replaceVideoTrack(screenVideoTrack);

    // Also replace audio track with mic audio if we captured it
    if (micAudioTrack && state.pc) {
      const audioSender = state.pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (audioSender) audioSender.replaceTrack(micAudioTrack);
    }

    // Auto-stop when the browser's native "Stop sharing" UI is triggered
    screenVideoTrack.onended = () => stopScreenShare();

    // Update button to "Stop Screen Sharing"
    const btn = DOM.screenShareButton;
    btn.classList.add("sharing");
    btn.querySelector("span").textContent = "Stop Sharing";
    // Swap icon to an X / stop monitor icon
    btn.querySelector("svg").innerHTML = `<rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><line x1="18" y1="6" x2="6" y2="15" /><line x1="6" y1="6" x2="18" y2="15" />`;

    DOM.localStatus.textContent = "Screen Sharing";
    showToast("Screen sharing started.", "success");
  } catch (error) {
    if (error.name === "NotAllowedError") {
      showToast("Screen share permission denied.", "error");
    } else {
      console.error("Screen share error:", error);
      showToast("Failed to start screen sharing.", "error");
    }
  }
};

DOM.hangupButton.onclick = () => handleHangup(true);

if (DOM.copyButton) {
  DOM.copyButton.onclick = async () => {
    const val = DOM.callInput.value.trim();
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showToast("Call ID copied to clipboard!", "success");
    } catch {
      showToast("Failed to copy Call ID.", "error");
    }
  };
}

// =============================================================================
// AUTH INITIALIZATION
// =============================================================================

onAuthStateChanged(auth, (user) => {
  if (user) {
    state.userID = user.uid;
    console.log("Authenticated. UID:", state.userID);
    DOM.webcamButton.disabled = false;
    showToast("Authenticated with signaling server.", "success");
  } else {
    signInAnonymously(auth).catch((error) => {
      console.error("Auth Error:", error.message);
      showToast("Authentication failed.", "error");
    });
  }
});