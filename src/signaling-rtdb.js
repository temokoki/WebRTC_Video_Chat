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

// =============================================================================
// signaling-rtdb.js
// Realtime Database signaling adapter. Handles offer/answer exchange and ICE
// candidate relay via Firebase RTDB. All shared WebRTC logic lives in webrtc-core.js.
// =============================================================================

const rtdb = getDatabase(app);

// --- HANGUP CLEANUP CALLBACK ---
callbacks.hangupCleanup = async (callId, userID) => {
  const callRef = ref(rtdb, `calls/${callId}`);
  await update(callRef, { status: "ended" });
  // Caller removes the entire room; answerer just signals ended
  if (callId === userID) {
    await remove(callRef);
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

    const callRef = ref(rtdb, `calls/${state.userID}`);
    const offerCandidatesRef = ref(rtdb, `calls/${state.userID}/offerCandidates`);
    const answerCandidatesRef = ref(rtdb, `calls/${state.userID}/answerCandidates`);

    DOM.callInput.value = state.userID;
    updateConnectionState("connecting");
    showToast("Preparing call session...", "info");

    // Remove leftover data and register auto-cleanup on disconnect
    await remove(callRef);
    onDisconnect(callRef).remove();

    setupPeerConnection();

    // Stream local ICE candidates to RTDB as they are gathered
    state.pc.onicecandidate = (event) => {
      if (event.candidate) {
        push(offerCandidatesRef, event.candidate.toJSON()).catch((e) => {
          console.error("Error saving caller ICE candidate:", e);
        });
      }
    };

    // Create and persist the SDP offer
    const offerDescription = await state.pc.createOffer();
    await state.pc.setLocalDescription(offerDescription);

    await set(callRef, {
      author_uid: state.userID,
      status: "pending",
      offer: { type: offerDescription.type, sdp: offerDescription.sdp }
    });
    showToast("Call started. Ready for incoming connection.", "success");
    enterCallMode();

    // Guard flag: ensure remote description is applied exactly once
    let remoteDescriptionApplied = false;

    // Listen for the remote answer
    const unsubCall = onValue(callRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      if (!remoteDescriptionApplied && data.answer && state.pc.signalingState === "have-local-offer") {
        remoteDescriptionApplied = true;
        try {
          await state.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
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
    state.unsubscribes.push(unsubCall);

    // Listen for answerer's ICE candidates
    const unsubCandidates = onChildAdded(answerCandidatesRef, (snapshot) => {
      addRemoteIceCandidate(snapshot.val());
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
      DOM.callButton.disabled = false;
      DOM.answerButton.disabled = false;
      return;
    }

    setupPeerConnection();

    // Stream local ICE candidates to RTDB as they are gathered
    state.pc.onicecandidate = (event) => {
      if (event.candidate) {
        push(answerCandidatesRef, event.candidate.toJSON()).catch((e) => {
          console.error("Error saving answerer ICE candidate:", e);
        });
      }
    };

    // Apply the caller's offer and create an answer
    await state.pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    await processQueuedIceCandidates();

    const answerDescription = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answerDescription);

    await update(callRef, {
      answerer_uid: state.userID,
      status: "active",
      answer: { type: answerDescription.type, sdp: answerDescription.sdp }
    });
    showToast("Joined session. Connecting...", "success");
    enterCallMode();

    // Listen for caller's ICE candidates
    const unsubCandidates = onChildAdded(offerCandidatesRef, (snapshot) => {
      addRemoteIceCandidate(snapshot.val());
    });
    state.unsubscribes.push(unsubCandidates);

    // Listen for session termination by the caller
    const unsubCall = onValue(callRef, (snapshot) => {
      if (!snapshot.exists() || snapshot.val()?.status === "ended") {
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
