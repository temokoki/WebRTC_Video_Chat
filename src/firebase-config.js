import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// --- FIREBASE CONFIGURATION ---
// Shared by both Firestore and RTDB signaling adapters.
const firebaseConfig = {
  apiKey: "AIzaSyB0Y_cDkdOvpbkr1IJDzxS5pcrKONLh9Pg",
  authDomain: "webrtc-video-chat-tk.firebaseapp.com",
  databaseURL: "https://webrtc-video-chat-tk-default-rtdb.firebaseio.com",
  projectId: "webrtc-video-chat-tk",
  storageBucket: "webrtc-video-chat-tk.firebasestorage.app",
  messagingSenderId: "776519124229",
  appId: "1:776519124229:web:6c239a7d73ae3d7d2aa36c"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
