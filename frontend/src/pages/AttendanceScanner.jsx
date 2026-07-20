import React, { useEffect, useRef, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Camera, Spinner, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";

export default function AttendanceScanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle, loading_models, active, processing, success, error
  const [message, setMessage] = useState("Position your face in the camera frame");
  const [resultData, setResultData] = useState(null);

  const detectIntervalRef = useRef(null);
  const streamRef = useRef(null);

  // Check permissions: only allow logged in users (e.g. scanner or admin)
  useEffect(() => {
    if (user === false) {
      navigate("/login");
    }
  }, [user, navigate]);

  // Load face-api.js models
  useEffect(() => {
    const loadModels = async () => {
      setStatus("loading_models");
      setMessage("Loading Face Recognition AI models...");
      try {
        // Load from local public/models directory
        const MODEL_URL = "/models";
        await window.faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        
        setModelsLoaded(true);
        setStatus("idle");
        setMessage("Models loaded. Starting camera...");
        startCamera();
      } catch (e) {
        console.error("Error loading face-api models:", e);
        toast.error("Failed to load face detection models. Ensure they exist in public/models");
        setStatus("error");
        setMessage("Failed to load Face AI. Check console.");
      }
    };

    if (window.faceapi) {
      loadModels();
    } else {
      // Retry in 1s if script not fully evaluated
      const timer = setTimeout(() => {
        if (window.faceapi) loadModels();
        else {
          setStatus("error");
          setMessage("FaceAPI script not loaded in index.html");
        }
      }, 1000);
      return () => clearTimeout(timer);
    }

    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    try {
      if (streamRef.current) {
        stopCamera();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" }
      });
      
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
        setStatus("active");
        setMessage("Detecting face... Please blink or smile to verify liveness.");
      }
    } catch (e) {
      console.error("Camera access failed:", e);
      toast.error("Camera access denied. Please allow camera permissions.");
      setStatus("error");
      setMessage("Camera access denied.");
    }
  };

  const stopCamera = () => {
    if (detectIntervalRef.current) {
      clearInterval(detectIntervalRef.current);
      detectIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  // Start face detection loop when camera is active
  useEffect(() => {
    if (status === "active" && cameraActive && videoRef.current) {
      detectIntervalRef.current = setInterval(async () => {
        await detectFace();
      }, 800); // Check face every 800ms
    }
    return () => {
      if (detectIntervalRef.current) {
        clearInterval(detectIntervalRef.current);
      }
    };
  }, [status, cameraActive]);

  // Landmark distance helper (Euclidean)
  const getDistance = (p1, p2) => {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
  };

  const detectFace = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    // Make sure video has data
    if (video.paused || video.ended || video.readyState < 2) return;

    try {
      const displaySize = { width: video.videoWidth, height: video.videoHeight };
      
      // Run face detection with landmarks and embedding descriptors
      const detection = await window.faceapi
        .detectSingleFace(video, new window.faceapi.SsdMobilenetv1Options({ minConfidence: 0.7 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (detection) {
        // Draw real-time face frame box
        const resizedDetection = window.faceapi.resizeResults(detection, displaySize);
        window.faceapi.draw.drawDetections(canvas, resizedDetection);

        // Liveness check logic:
        const landmarks = detection.landmarks.positions;
        
        // 1. Smile Detection (Left mouth corner 48, Right mouth corner 54, Lip heights)
        const mouthLeft = landmarks[48];
        const mouthRight = landmarks[54];
        const mouthWidth = getDistance(mouthLeft, mouthRight);
        const noseBridge = landmarks[27];
        const chin = landmarks[8];
        const faceHeight = getDistance(noseBridge, chin);
        
        // Smile ratio (mouth width divided by face scale)
        const smileRatio = mouthWidth / faceHeight;
        
        // 2. Eye Blink Detection (vertical height of eyelids)
        const leftEyeTop = landmarks[37];
        const leftEyeBottom = landmarks[41];
        const leftEyeDist = getDistance(leftEyeTop, leftEyeBottom);
        const leftEyeWidth = getDistance(landmarks[36], landmarks[39]);
        const leftEyeRatio = leftEyeDist / leftEyeWidth;

        const isSmiling = smileRatio > 0.44;
        const isBlinking = leftEyeRatio < 0.22;

        if (isSmiling || isBlinking) {
          // Liveness validated! Trigger verification.
          clearInterval(detectIntervalRef.current);
          detectIntervalRef.current = null;
          setStatus("processing");
          setMessage("Liveness verified! Comparing with database...");

          // Capture current frame as base64 photo
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = video.videoWidth;
          tempCanvas.height = video.videoHeight;
          const tempCtx = tempCanvas.getContext("2d");
          tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
          const photoBase64 = tempCanvas.toDataURL("image/jpeg", 0.8);

          // Get the 128 float embedding array
          const embedding = Array.from(detection.descriptor);

          await submitVerification(embedding, photoBase64);
        } else {
          setMessage("Blink or Smile to Clock In / Out");
        }
      } else {
        setMessage("Align your face in the bounding box");
      }
    } catch (err) {
      console.error("Face detection loop error:", err);
    }
  };

  const submitVerification = async (embedding, photoBase64) => {
    try {
      const { data } = await api.post("/attendance/verify", {
        face_embedding: embedding,
        photo_base64: photoBase64
      });

      if (data.status === "ignored" || data.status === "already_completed") {
        setStatus("active");
        setMessage(data.message || "Punch ignored.");
        setTimeout(() => {
          setMessage("Ready for next face...");
        }, 4000);
        return;
      }

      setStatus("success");
      setResultData(data);

      const greetingMsg = data.action === "check_in"
        ? `${data.user_name} clocked in successfully.`
        : `${data.user_name} clocked out successfully.`;
        
      setMessage(greetingMsg);
      speak(greetingMsg);

      // Reset back to scanning state after 4 seconds
      setTimeout(() => {
        setResultData(null);
        setStatus("active");
        setMessage("Ready for next face...");
        startCamera();
      }, 4000);

    } catch (e) {
      setStatus("error");
      const errDetail = e?.response?.data?.detail;
      const errorMsg = typeof errDetail === "string" ? errDetail : "Face not matched. Try again.";
      setMessage(errorMsg);
      speak("Authentication failed.");

      setTimeout(() => {
        setStatus("active");
        setMessage("Try aligning your face again...");
        startCamera();
      }, 3000);
    }
  };

  const speak = (txt) => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(txt);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  };

  const [showManual, setShowManual] = useState(false);

  return (
    <div className="min-h-screen bg-[#0d0f14] text-white flex flex-col justify-between p-6 select-none font-chivo">
      {/* Top Bar */}
      <header className="flex justify-between items-center border-b border-white/10 pb-4">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="font-mono text-xs uppercase tracking-widest text-gray-400">CitSpray Entrance Attendance Portal</span>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowManual(true)} 
            className="text-xs font-bold uppercase tracking-widest text-emerald-500 hover:text-white border border-emerald-500 px-3 py-1.5 transition-all"
          >
            Manual Password Punch
          </button>
          <button 
            onClick={() => navigate("/dashboard")} 
            className="text-xs font-bold uppercase tracking-widest text-[#002FA7] hover:text-white border border-[#002FA7] px-3 py-1.5 transition-all"
          >
            Exit Dashboard
          </button>
        </div>
      </header>

      {/* Main Scanner Window */}
      <main className="flex-1 flex flex-col items-center justify-center my-6">
        <div className="relative w-full max-w-lg aspect-[4/3] rounded-2xl overflow-hidden border border-white/20 shadow-2xl bg-black/40 backdrop-blur-xl">
          {/* Camera Feed */}
          {cameraActive && (
            <video 
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover scale-x-[-1]"
            />
          )}

          {/* Canvas for facial overlay */}
          <canvas 
            ref={canvasRef}
            width={640}
            height={480}
            className="absolute inset-0 w-full h-full object-cover scale-x-[-1]"
          />

          {/* Scanning Animation Line */}
          {status === "active" && (
            <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-[#002FA7] to-transparent animate-scan z-10"></div>
          )}

          {/* Loading Models Overlay */}
          {status === "loading_models" && (
            <div className="absolute inset-0 bg-[#0d0f14]/90 flex flex-col items-center justify-center gap-4 z-20">
              <Spinner size={36} className="animate-spin text-[#002FA7]" />
              <div className="text-sm font-semibold tracking-wide text-gray-400">Initialising Face AI Networks...</div>
            </div>
          )}

          {/* Processing Overlay */}
          {status === "processing" && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-4 z-20 backdrop-blur-sm">
              <Spinner size={36} className="animate-spin text-emerald-400" />
              <div className="text-sm font-semibold tracking-wide text-emerald-400">Processing Face ID...</div>
            </div>
          )}

          {/* Success Overlay */}
          {status === "success" && resultData && (
            <div className="absolute inset-0 bg-[#081C15]/95 flex flex-col items-center justify-center gap-4 z-20 animate-in fade-in duration-200">
              <CheckCircle size={72} weight="fill" className="text-emerald-500 animate-bounce" />
              <div className="text-2xl font-black tracking-wide text-white">{resultData.user_name}</div>
              <div className="text-xs uppercase tracking-widest text-emerald-400 font-bold bg-emerald-950/80 px-4 py-1.5 border border-emerald-800 rounded-full">
                {resultData.action === "check_in" ? "Clock In Verified" : "Clock Out Verified"}
              </div>
              <div className="text-xs text-gray-400 font-mono">Time: {new Date(resultData.time).toLocaleTimeString()}</div>
            </div>
          )}

          {/* Failure Overlay */}
          {status === "error" && (
            <div className="absolute inset-0 bg-[#2C0B0E]/95 flex flex-col items-center justify-center gap-4 z-20 animate-in fade-in duration-200">
              <XCircle size={72} weight="fill" className="text-red-500 animate-pulse" />
              <div className="text-lg font-bold text-white">Authentication Failed</div>
              <div className="text-xs text-red-300 max-w-xs text-center px-4 font-semibold">{message}</div>
            </div>
          )}
        </div>

        {/* Message Indicator */}
        <div className="mt-8 text-center max-w-md">
          <div className="text-xs uppercase tracking-widest text-gray-500 font-bold mb-1">Status / Instruction</div>
          <div className="text-lg font-semibold tracking-wide bg-white/5 border border-white/10 px-6 py-2.5 rounded-full inline-block backdrop-blur-md">
            {message}
          </div>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="flex justify-between items-center text-[10px] uppercase tracking-widest text-gray-500 border-t border-white/10 pt-4">
        <span>© 2026 CitSpray WA-CRM</span>
        <span>Secure Facial Scan System v1.0 (ArcFace)</span>
      </footer>

      {/* Manual Password Punch Modal */}
      {showManual && (
        <ManualPunchModal 
          onClose={() => setShowManual(false)} 
          onSaved={() => setShowManual(false)} 
        />
      )}

      {/* Embedded CSS for scanning line */}
      <style>{`
        @keyframes scan {
          0% { top: 0%; }
          50% { top: 100%; }
          100% { top: 0%; }
        }
        .animate-scan {
          animation: scan 3s linear infinite;
        }
      `}</style>
    </div>
  );
}

function ManualPunchModal({ onClose, onSaved }) {
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get("/users")
      .then(({ data }) => {
        setUsers((data || []).filter(u => u.role === "executive" && u.active));
      })
      .catch(err => console.error(err));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!username) {
      toast.error("Please select your name");
      return;
    }
    if (!password) {
      toast.error("Please enter your password");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/attendance/manual-punch", { username, password });
      toast.success(data.action === "check_in" ? "Clocked In Successfully!" : "Clocked Out Successfully!");
      
      const greetingMsg = data.action === "check_in"
        ? `${data.user_name} clocked in successfully.`
        : `${data.user_name} clocked out successfully.`;
        
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(greetingMsg);
        window.speechSynthesis.speak(utterance);
      }
      
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-sm bg-[#121620] border border-white/20 p-6 rounded-sm text-white space-y-4">
        <div>
          <span className="text-[10px] uppercase font-bold text-gray-500 tracking-wider">Manual Attendance</span>
          <h3 className="font-chivo font-black text-xl mt-0.5">Punch In / Out</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1">Select Executive</label>
            <select
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-[#1b2030] border border-white/10 text-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            >
              <option value="">— Select Name —</option>
              {users.map(u => (
                <option key={u.id} value={u.username}>{u.name} (@{u.username})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1">Login Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#1b2030] border border-white/10 text-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="border border-white/10 px-3 py-1.5 text-xs font-bold uppercase hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button disabled={loading} className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-1.5 text-xs font-bold uppercase transition-colors disabled:opacity-50">
            {loading ? "Verifying…" : "Submit"}
          </button>
        </div>
      </form>
    </div>
  );
}
