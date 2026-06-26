import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  get,
  remove,
  onValue,
  onChildAdded,
  onDisconnect
} from "firebase/database";

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyB0Y_cDkdOvpbkr1IJDzxS5pcrKONLh9Pg",
  authDomain: "webrtc-video-chat-tk.firebaseapp.com",
  databaseURL: "https://webrtc-video-chat-tk-default-rtdb.firebaseio.com",
  projectId: "webrtc-video-chat-tk",
  storageBucket: "webrtc-video-chat-tk.firebasestorage.app",
  messagingSenderId: "776519124229",
  appId: "1:776519124229:web:6c239a7d73ae3d7d2aa36c"
};

const app = initializeApp(firebaseConfig);
const rtdb = getDatabase(app);
const auth = getAuth(app);

// --- WEBRTC CONFIGURATION ---
const iceConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ],
  iceCandidatePoolSize: 10
};

// --- STATE ---
let userID = "";
let localStream = null;
let remoteStream = null;
let pc = null;
let unsubscribes = [];
let remoteDescriptionSet = false;
const iceCandidatesQueue = [];

// --- DOM ELEMENTS ---
const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");
const copyButton = document.getElementById("copyButton");

const connectionStatus = document.getElementById("connectionStatus");
const connectionText = document.getElementById("connectionText");
const localStatus = document.getElementById("localStatus");
const remoteStatus = document.getElementById("remoteStatus");

// --- TOAST NOTIFICATIONS ---
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  const closeBtn = toast.querySelector(".toast-close");
  closeBtn.onclick = () => {
    toast.style.animation = "fade-out 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards";
    toast.addEventListener("animationend", () => toast.remove());
  };

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.animation = "fade-out 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards";
      toast.addEventListener("animationend", () => toast.remove());
    }
  }, 4000);
}

// --- STATE INDICATOR UPDATE ---
function updateConnectionState(state) {
  if (!connectionStatus || !connectionText) return;
  connectionStatus.setAttribute("data-status", state.toLowerCase());

  let label = "Disconnected";
  if (state === "connecting") label = "Connecting...";
  if (state === "connected") label = "Connected";
  if (state === "failed") label = "Failed/Timeout";
  if (state === "closed") label = "Call Closed";

  connectionText.textContent = label;
}

// --- INITIALIZATION ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    userID = user.uid;
    console.log("Authenticated. UID:", userID);
    webcamButton.disabled = false;
    showToast("Authenticated with signaling server.", "success");
  } else {
    signInAnonymously(auth).catch(error => {
      console.error("Auth Error:", error.message);
      showToast("Authentication failed.", "error");
    });
  }
});

// --- PEER CONNECTION HELPER ---
function setupPeerConnection() {
  if (pc) {
    pc.close();
  }

  pc = new RTCPeerConnection(iceConfig);
  remoteDescriptionSet = false;
  iceCandidatesQueue.length = 0;
  remoteStream = new MediaStream();

  // Track connection state
  pc.onconnectionstatechange = () => {
    console.log("PeerConnection State Change:", pc.connectionState);
    if (pc.connectionState === "connected") {
      updateConnectionState("connected");
      remoteStatus.textContent = "Connected";
      showToast("WebRTC connection established!", "success");
    } else if (pc.connectionState === "connecting") {
      updateConnectionState("connecting");
      remoteStatus.textContent = "Connecting...";
    } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      updateConnectionState("disconnected");
      remoteStatus.textContent = "Offline";
      showToast("WebRTC connection lost.", "error");
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE Connection State Change:", pc.iceConnectionState);
  };

  // Process incoming streams
  pc.ontrack = (event) => {
    console.log("Remote stream track added:", event.streams);
    if (event.streams && event.streams[0]) {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      remoteVideo.srcObject = remoteStream;
      remoteStatus.textContent = "Active";
    }
  };

  // Add local stream tracks to peer connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }
}

// --- ICE QUEUE HELPER ---
async function addRemoteIceCandidate(candidateData) {
  try {
    const candidate = new RTCIceCandidate(candidateData);
    if (!remoteDescriptionSet) {
      iceCandidatesQueue.push(candidate);
      console.log("Queued ICE candidate (Remote SDP not set yet)");
    } else {
      await pc.addIceCandidate(candidate);
      console.log("Applied ICE candidate directly");
    }
  } catch (error) {
    console.error("Error setting ICE candidate:", error);
  }
}

async function processQueuedIceCandidates() {
  console.log(`Processing ${iceCandidatesQueue.length} queued ICE candidates`);
  remoteDescriptionSet = true;
  for (const candidate of iceCandidatesQueue) {
    await pc.addIceCandidate(candidate).catch(error => {
      console.error("Error applying queued ICE candidate:", error);
    });
  }
  iceCandidatesQueue.length = 0;
}

// --- EVENT LISTENERS ---
webcamButton.onclick = async () => {
  try {
    webcamButton.disabled = true;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();

    webcamVideo.srcObject = localStream;
    localStatus.textContent = "Active";
    showToast("Media streams started successfully.", "success");

    callButton.disabled = false;
    answerButton.disabled = false;
    hangupButton.disabled = false;
    copyButton.disabled = false;
  } catch (error) {
    console.error("Webcam access error:", error);
    showToast("Failed to acquire video/audio streams.", "error");
    webcamButton.disabled = false;
  }
};

callButton.onclick = async () => {
  try {
    callButton.disabled = true;
    answerButton.disabled = true;

    clearSubscriptions();

    const callRef = ref(rtdb, `calls/${userID}`);
    const offerCandidatesRef = ref(rtdb, `calls/${userID}/offerCandidates`);
    const answerCandidatesRef = ref(rtdb, `calls/${userID}/answerCandidates`);

    callInput.value = userID;
    updateConnectionState("connecting");
    showToast("Preparing call session...", "info");

    // Clean up previous call data
    await remove(callRef);

    // Wipe database record on network disconnect
    onDisconnect(callRef).remove();

    // Initialize WebRTC
    setupPeerConnection();

    // Register ICE candidates gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        push(offerCandidatesRef, event.candidate.toJSON()).catch(e => {
          console.error("Error saving caller ICE candidate:", e);
        });
      }
    };

    // Create & set local description (SDP Offer)
    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    // Write call offer info
    await set(callRef, {
      author_uid: userID,
      status: "pending",
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp
      }
    });
    showToast("Room created. Ready for incoming connection.", "success");

    // Listen for SDP Answer
    let remoteDescriptionApplied = false;
    const unsubCall = onValue(callRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      if (!remoteDescriptionApplied && data.answer && pc.signalingState === "have-local-offer") {
        remoteDescriptionApplied = true;
        try {
          const answerDescription = new RTCSessionDescription(data.answer);
          await pc.setRemoteDescription(answerDescription);
          await processQueuedIceCandidates();
        } catch (e) {
          console.error("Error setting remote description:", e);
          remoteDescriptionApplied = false;
        }
      }

      if (data.status === "ended") {
        showToast("The peer has left the session.", "info");
        handleHangup(false);
      }
    });
    unsubscribes.push(unsubCall);

    // Listen for Answerer's ICE Candidates
    const unsubCandidates = onChildAdded(answerCandidatesRef, (snapshot) => {
      addRemoteIceCandidate(snapshot.val());
    });
    unsubscribes.push(unsubCandidates);

  } catch (error) {
    console.error("Calling error:", error);
    showToast(`Call creation failed: ${error.message}`, "error");
    updateConnectionState("disconnected");
    callButton.disabled = false;
    answerButton.disabled = false;
  }
};

answerButton.onclick = async () => {
  const callId = callInput.value.trim();
  if (!callId) {
    showToast("Please enter a call ID to join.", "error");
    return;
  }

  try {
    callButton.disabled = true;
    answerButton.disabled = true;

    clearSubscriptions();

    const callRef = ref(rtdb, `calls/${callId}`);
    const offerCandidatesRef = ref(rtdb, `calls/${callId}/offerCandidates`);
    const answerCandidatesRef = ref(rtdb, `calls/${callId}/answerCandidates`);

    updateConnectionState("connecting");
    showToast("Retrieving session details...", "info");

    const callSnap = await get(callRef);
    const callData = callSnap.val();

    if (!callData || callData.status === "ended") {
      showToast("Session not found or already closed.", "error");
      updateConnectionState("disconnected");
      callButton.disabled = false;
      answerButton.disabled = false;
      return;
    }

    // Initialize WebRTC
    setupPeerConnection();

    // Register ICE candidates gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        push(answerCandidatesRef, event.candidate.toJSON()).catch(e => {
          console.error("Error saving answerer ICE candidate:", e);
        });
      }
    };

    // Apply Offer SDP
    const offerDescription = new RTCSessionDescription(callData.offer);
    await pc.setRemoteDescription(offerDescription);
    await processQueuedIceCandidates();

    // Create & set local description (SDP Answer)
    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    // Save SDP Answer & update session status
    await update(callRef, {
      answerer_uid: userID,
      status: "active",
      answer: {
        type: answerDescription.type,
        sdp: answerDescription.sdp
      }
    });

    showToast("Joined session. Connecting...", "success");

    // Listen for Caller's ICE Candidates
    const unsubCandidates = onChildAdded(offerCandidatesRef, (snapshot) => {
      addRemoteIceCandidate(snapshot.val());
    });
    unsubscribes.push(unsubCandidates);

    // Listen for session termination
    const unsubCall = onValue(callRef, (snapshot) => {
      const data = snapshot.val();
      if (!snapshot.exists() || data?.status === "ended") {
        showToast("The peer has left the session.", "info");
        handleHangup(false);
      }
    });
    unsubscribes.push(unsubCall);

  } catch (error) {
    console.error("Joining error:", error);
    showToast(`Failed to join call: ${error.message}`, "error");
    updateConnectionState("disconnected");
    callButton.disabled = false;
    answerButton.disabled = false;
  }
};

// --- HANGUP & CLEANUP HELPERS ---

async function handleHangup(notifyPeer = true) {
  hangupButton.disabled = true;
  showToast("Leaving session...", "info");

  clearSubscriptions();

  const callId = callInput.value.trim();
  if (notifyPeer && callId) {
    try {
      const callRef = ref(rtdb, `calls/${callId}`);
      await update(callRef, { status: "ended" });
      if (callId === userID) {
        // Caller hangs up: remove call room completely
        await remove(callRef);
      }
    } catch (e) {
      console.warn("Signaling cleanup error:", e.message);
    }
  }

  // Terminate Media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    webcamVideo.srcObject = null;
    localStatus.textContent = "Inactive";
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
    remoteStatus.textContent = "Offline";
  }

  if (pc) {
    pc.close();
    pc = null;
  }

  updateConnectionState("disconnected");
  showToast("Session disconnected.", "success");

  // Re-enable and reset controls
  webcamButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
  copyButton.disabled = true;
  callInput.value = "";
}

hangupButton.onclick = () => {
  handleHangup(true);
};

function clearSubscriptions() {
  unsubscribes.forEach((unsub) => {
    try {
      unsub();
    } catch (e) {
      console.warn("Unsubscribing error:", e);
    }
  });
  unsubscribes = [];
}

// --- CLIPBOARD HELPER ---
if (copyButton) {
  copyButton.onclick = async () => {
    const val = callInput.value.trim();
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showToast("Call ID copied to clipboard!", "success");
    } catch (e) {
      showToast("Failed to copy Call ID.", "error");
    }
  };
}