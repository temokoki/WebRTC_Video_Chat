// =============================================================================
// Firestore signaling adapter. Handles offer/answer exchange and ICE candidate
// relay via Cloud Firestore. All shared WebRTC logic lives in webrtc-core.js.
// =============================================================================

import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  writeBatch,
  onSnapshot,
} from "firebase/firestore";
import { app } from "./firebase-config.js";
import {
  state,
  DOM,
  callbacks,
  showToast,
  updateConnectionState,
  setupPeerConnection,
  addRemoteIceCandidate,
  processQueuedIceCandidates,
  clearSubscriptions,
  handleHangup,
  enterCallMode
} from "./webrtc-core.js";

const db = getFirestore(app);

// --- HELPERS ---

// Deletes offerCandidates, answerCandidates sub-collections and the call doc
async function cleanupCallData(callId) {
  if (!callId) return;
  const callDoc = doc(db, "calls", callId);
  const batch = writeBatch(db);
  try {
    const [offerSnap, answerSnap] = await Promise.all([
      getDocs(collection(callDoc, "offerCandidates")),
      getDocs(collection(callDoc, "answerCandidates"))
    ]);
    offerSnap.forEach((d) => batch.delete(d.ref));
    answerSnap.forEach((d) => batch.delete(d.ref));
    batch.delete(callDoc);
    await batch.commit();
    console.log(`Firestore cleared for call ID: ${callId}`);
  } catch (error) {
    console.warn("Firestore cleanup skipped or failed:", error.message);
  }
}

// --- HANGUP CLEANUP CALLBACK ---
callbacks.hangupCleanup = async (callId, userID) => {
  const callDoc = doc(db, "calls", callId);
  await updateDoc(callDoc, { status: "ended" });
  if (callId === userID) {
    await cleanupCallData(callId);
  }
};

// =============================================================================
// CALL BUTTON — Create offer and wait for an answer
// =============================================================================
DOM.callButton.onclick = async () => {
  try {
    DOM.callButton.disabled = true;
    DOM.answerButton.disabled = true;
    clearSubscriptions();

    const callDoc = doc(db, "calls", state.userID);
    const offerCandidates = collection(callDoc, "offerCandidates");
    const answerCandidates = collection(callDoc, "answerCandidates");

    DOM.callInput.value = state.userID;
    updateConnectionState("connecting");
    showToast("Preparing call session...", "info");

    // Remove any leftover data from previous sessions
    await cleanupCallData(state.userID);

    setupPeerConnection();

    // Stream local ICE candidates to Firestore as they are gathered
    state.pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(offerCandidates, event.candidate.toJSON()).catch((e) => {
          console.error("Error saving caller ICE candidate:", e);
        });
      }
    };

    // Create and persist the SDP offer
    const offerDescription = await state.pc.createOffer();
    await state.pc.setLocalDescription(offerDescription);

    await setDoc(callDoc, {
      author_uid: state.userID,
      status: "pending",
      offer: { type: offerDescription.type, sdp: offerDescription.sdp }
    });
    showToast("Call started. Ready for incoming connection.", "success");
    enterCallMode();

    // Listen for the remote answer
    const unsubCall = onSnapshot(callDoc, async (snapshot) => {
      const data = snapshot.data();
      if (data.answer && state.pc.signalingState === "have-local-offer") {
        try {
          await state.pc.setRemoteDescription(data.answer);
          await processQueuedIceCandidates();
        } catch (e) {
          console.error("Error setting remote description:", e);
        }
      }

      if (data?.status === "ended") {
        showToast("The peer has left the session.", "info");
        handleHangup(false);
      }
    });
    state.unsubscribes.push(unsubCall);

    // Listen for answerer's ICE candidates
    const unsubCandidates = onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          await addRemoteIceCandidate(change.doc.data());
        }
      });
    });
    state.unsubscribes.push(unsubCandidates);

  } catch (error) {
    console.error("Calling error:", error);
    showToast(`Call creation failed: ${error.message}`, "error");
    updateConnectionState("disconnected");
    DOM.callButton.disabled = false;
    DOM.answerButton.disabled = false;
  }
};

// =============================================================================
// ANSWER BUTTON — Join an existing call by ID
// =============================================================================
DOM.answerButton.onclick = async () => {
  const callId = DOM.callInput.value.trim();
  if (!callId) {
    showToast("Please enter a call ID to join.", "error");
    return;
  }

  try {
    DOM.callButton.disabled = true;
    DOM.answerButton.disabled = true;
    clearSubscriptions();

    const callDoc = doc(db, "calls", callId);
    const offerCandidates = collection(callDoc, "offerCandidates");
    const answerCandidates = collection(callDoc, "answerCandidates");

    updateConnectionState("connecting");
    showToast("Retrieving session details...", "info");

    const callSnap = await getDoc(callDoc);
    const callData = callSnap.data();

    if (!callData || callData.status === "ended") {
      showToast("Session not found or already closed.", "error");
      updateConnectionState("disconnected");
      DOM.callButton.disabled = false;
      DOM.answerButton.disabled = false;
      return;
    }

    setupPeerConnection();

    // Stream local ICE candidates to Firestore as they are gathered
    state.pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(answerCandidates, event.candidate.toJSON()).catch((e) => {
          console.error("Error saving answerer ICE candidate:", e);
        });
      }
    };

    // Apply the caller's offer and create an answer
    await state.pc.setRemoteDescription(callData.offer);

    const answerDescription = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answerDescription);

    await updateDoc(callDoc, {
      answerer_uid: state.userID,
      status: "active",
      answer: { type: answerDescription.type, sdp: answerDescription.sdp }
    });
    showToast("Joined session. Connecting...", "success");
    enterCallMode();

    // Listen for caller's ICE candidates
    const unsubCandidates = onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          await addRemoteIceCandidate(change.doc.data());
        }
      });
    });
    state.unsubscribes.push(unsubCandidates);

    // Listen for session termination by the caller
    const unsubCall = onSnapshot(callDoc, (snapshot) => {
      if (snapshot.data()?.status === "ended") {
        showToast("The peer has left the session.", "info");
        handleHangup(false);
      }
    });
    state.unsubscribes.push(unsubCall);

  } catch (error) {
    console.error("Joining error:", error);
    showToast(`Failed to join call: ${error.message}`, "error");
    updateConnectionState("disconnected");
    DOM.callButton.disabled = false;
    DOM.answerButton.disabled = false;
  }
};