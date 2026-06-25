import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  getDatabase, ref, set, update, push, get, remove,
  onValue, onChildAdded, onDisconnect
} from "firebase/database";

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
const auth = getAuth();

// --- STATE ---
let userID = "";
let pc = new RTCPeerConnection({
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ]
});
let localStream = null;
let remoteStream = null;

// --- DOM ELEMENTS ---
const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");

// --- INITIALIZATION ---
webcamButton.disabled = true;

onAuthStateChanged(auth, (user) => {
  if (user) {
    userID = user.uid;
    console.log("Authenticated. UID:", userID);
    webcamButton.disabled = false;
  } else {
    signInAnonymously(auth).catch(error => console.error("Auth Error:", error.message));
  }
});

// --- EVENT LISTENERS ---

webcamButton.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  remoteStream = new MediaStream();

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  webcamButton.disabled = true;
  callButton.disabled = false;
  answerButton.disabled = false;
  hangupButton.disabled = false;
};

callButton.onclick = async () => {
  const callId = userID;
  callInput.value = callId;

  // RTDB References
  const callRef = ref(rtdb, `calls/${callId}`);
  const offerCandidatesRef = ref(rtdb, `calls/${callId}/offerCandidates`);
  const answerCandidatesRef = ref(rtdb, `calls/${callId}/answerCandidates`);

  // BULLETPROOF CLEANUP: Tell server to wipe this room if caller disconnects/closes tab
  onDisconnect(callRef).remove();

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      push(offerCandidatesRef, event.candidate.toJSON());
    }
  };

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  // Write initial offer to RTDB
  await set(callRef, {
    author_uid: userID,
    offer: {
      type: offerDescription.type,
      sdp: offerDescription.sdp,
    }
  });

  // Listen for the Answerer's SDP
  onValue(callRef, (snapshot) => {
    const data = snapshot.val();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // Listen for Answerer's ICE Candidates (onChildAdded replaces Firestore's docChanges loop)
  onChildAdded(answerCandidatesRef, (snapshot) => {
    const candidate = new RTCIceCandidate(snapshot.val());
    pc.addIceCandidate(candidate);
  });
};

answerButton.onclick = async () => {
  const callId = callInput.value;
  if (!callId) return alert("Please enter a call ID");

  // RTDB References
  const callRef = ref(rtdb, `calls/${callId}`);
  const offerCandidatesRef = ref(rtdb, `calls/${callId}/offerCandidates`);
  const answerCandidatesRef = ref(rtdb, `calls/${callId}/answerCandidates`);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      push(answerCandidatesRef, event.candidate.toJSON());
    }
  };

  // Read the original offer
  const snapshot = await get(callRef);
  const callData = snapshot.val();
  if (!callData) return alert("Call ID not found");

  const offerDescription = new RTCSessionDescription(callData.offer);
  await pc.setRemoteDescription(offerDescription);

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  // Write Answerer UID and SDP answer securely
  await update(callRef, {
    answerer_uid: userID,
    answer: {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    }
  });

  // Listen for Caller's ICE Candidates
  onChildAdded(offerCandidatesRef, (snapshot) => {
    const candidate = new RTCIceCandidate(snapshot.val());
    pc.addIceCandidate(candidate);
  });
};

hangupButton.onclick = async () => {
  hangupButton.disabled = true;

  // Manual cleanup: Only the caller has permission to delete the whole room.
  const callId = callInput.value;
  if (callId && userID === callId) {
    try {
      await remove(ref(rtdb, `calls/${callId}`));
    } catch (e) {
      console.warn("Cleanup error (or not authorized to delete):", e);
    }
  }

  // Stop media tracks
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  if (remoteStream) remoteStream.getTracks().forEach(track => track.stop());

  // Close connection
  if (pc) pc.close();

  // Reset UI
  window.location.reload();
};