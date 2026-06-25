import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, writeBatch, onSnapshot } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyB0Y_cDkdOvpbkr1IJDzxS5pcrKONLh9Pg",
  authDomain: "webrtc-video-chat-tk.firebaseapp.com",
  projectId: "webrtc-video-chat-tk",
  storageBucket: "webrtc-video-chat-tk.firebasestorage.app",
  messagingSenderId: "776519124229",
  appId: "1:776519124229:web:6c239a7d73ae3d7d2aa36c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
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
// Disable buttons until auth completes
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

  // Push tracks from local stream to peer connection
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Pull tracks from peer connection, add them to remote video stream
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  // Update UI
  webcamButton.disabled = true;
  callButton.disabled = false;
  answerButton.disabled = false;
  hangupButton.disabled = false;
};

callButton.onclick = async () => {
  // Reference Firestore collections
  const callDoc = doc(db, "calls", userID);
  const offerCandidates = collection(callDoc, "offerCandidates");
  const answerCandidates = collection(callDoc, "answerCandidates");

  callInput.value = callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      addDoc(offerCandidates, event.candidate.toJSON());
    }
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  await setDoc(callDoc, {
    author_uid: userID,
    offer
  });

  // Listen for remote answer
  onSnapshot(callDoc, (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // When answered, add candidate to peer connection
  onSnapshot(answerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });
};

answerButton.onclick = async () => {
  const callId = callInput.value;
  if (!callId) return alert("Please enter a call ID");

  const callDoc = doc(db, "calls", callId);
  const offerCandidates = collection(callDoc, "offerCandidates");
  const answerCandidates = collection(callDoc, "answerCandidates");

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      addDoc(answerCandidates, event.candidate.toJSON());
    }
  };

  const callData = (await getDoc(callDoc)).data();
  if (!callData) return alert("Call ID not found");

  const offerDescription = new RTCSessionDescription(callData.offer);
  await pc.setRemoteDescription(offerDescription);

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  const answer = {
    type: answerDescription.type,
    sdp: answerDescription.sdp,
  };

  // CRITICAL FIX: Add answerer_uid to satisfy security rules
  await updateDoc(callDoc, {
    answerer_uid: userID,
    answer
  });

  onSnapshot(offerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });
};

hangupButton.onclick = async () => {
  // Turn off UI interaction immediately
  hangupButton.disabled = true;

  // 1. Clean up the database (Only works if current user is the Caller)
  const callId = callInput.value;
  await cleanupCallRoom(callId);

  // 2. Stop all media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  // 3. Close peer connection
  if (pc) {
    pc.close();
  }

  // 4. Reload page to clear memory/listeners easily for demo purposes
  window.location.reload();
};

window.addEventListener("beforeunload", (event) => {
  const callId = callInput.value;

  // Only attempt cleanup if the user is the Caller
  if (callId && userID === callId) {

    // 1. Fire the async cleanup function
    cleanupCallRoom(callId);

    // 2. Trigger the browser's "Are you sure you want to leave?" prompt.
    // This pauses the tab from closing immediately, giving our async 
    // function time to reach the Firestore servers.
    event.preventDefault();
    event.returnValue = ''; // Required for Chrome/Edge
  }
});

/**
 * Deletes all subcollection documents and the main call document atomically.
 * Note: This will only succeed if called by the Caller (room owner) due to security rules.
 */
async function cleanupCallRoom(callId) {
  if (!callId) return;

  const callDocRef = doc(db, "calls", callId);
  const offerCandidatesRef = collection(callDocRef, "offerCandidates");
  const answerCandidatesRef = collection(callDocRef, "answerCandidates");

  const batch = writeBatch(db);

  try {
    // 1. Fetch and batch-delete all offer candidates
    const offerSnap = await getDocs(offerCandidatesRef);
    offerSnap.forEach((snapshot) => {
      batch.delete(snapshot.ref);
    });

    // 2. Fetch and batch-delete all answer candidates
    const answerSnap = await getDocs(answerCandidatesRef);
    answerSnap.forEach((snapshot) => {
      batch.delete(snapshot.ref);
    });

    // 3. Batch-delete the main call document
    batch.delete(callDocRef);

    // 4. Commit all deletions at once
    await batch.commit();
    console.log(`Database successfully cleared for room: ${callId}`);
  } catch (error) {
    // This is expected to fail if the Answerer tries to run it, 
    // as our security rules restrict DELETE operations to the owner.
    console.warn("Database cleanup skipped or rejected:", error.message);
  }
}