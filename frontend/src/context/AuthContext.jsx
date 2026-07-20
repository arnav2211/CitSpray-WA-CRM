import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null = loading, false = anon
  const [error, setError] = useState("");
  const [isAttendanceLocked, setAttendanceLocked] = useState(false);
  const leaveNoticeRef = useRef(false);

  const fetchMe = useCallback(async () => {
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
      setAttendanceLocked(false);
    } catch {
      setUser(false);
    }
  }, []);

  useEffect(() => {
    const t = localStorage.getItem("token");
    if (!t) {
      setUser(false);
      return;
    }
    fetchMe();
  }, [fetchMe]);

  // Global soft-logout interceptor: if any request returns 401 with a
  // `user_on_leave` code (or the user has been deactivated), clear the token
  // and redirect to the login screen. Intercepts 403 attendance lockout as well.
  useEffect(() => {
    const id = api.interceptors.response.use(
      (r) => r,
      (err) => {
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail;
        const code = typeof detail === "object" ? detail?.code : null;
        
        if (status === 401 && localStorage.getItem("token")) {
          if (!leaveNoticeRef.current) {
            leaveNoticeRef.current = true;
            if (code === "user_on_leave") {
              const msg = (typeof detail === "object" && detail?.message) || "You are on leave — access disabled.";
              toast.error(msg);
            } else {
              toast.error("Session expired — please log in again.");
            }
            setTimeout(() => { leaveNoticeRef.current = false; }, 4000);
          }
          localStorage.removeItem("token");
          setUser(false);
          setAttendanceLocked(false);
          if (window.location.pathname !== "/login") {
            window.location.href = "/login";
          }
        } else if (status === 403 && code === "attendance_required") {
          setAttendanceLocked(true);
        }
        return Promise.reject(err);
      },
    );
    return () => { api.interceptors.response.eject(id); };
  }, []);

  const login = async (username, password) => {
    setError("");
    try {
      const { data } = await api.post("/auth/login", { username, password });
      localStorage.setItem("token", data.token);
      setUser(data.user);
      setAttendanceLocked(false);
      return true;
    } catch (e) {
      const detail = e?.response?.data?.detail;
      const code = typeof detail === "object" ? detail?.code : null;
      if (code === "user_on_leave") {
        const msg = (typeof detail === "object" && detail?.message) || "You are on leave — access disabled.";
        setError(msg);
      } else {
        setError(errMsg(e, "Login failed"));
      }
      return false;
    }
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch { /* ignore */ }
    localStorage.removeItem("token");
    setUser(false);
    setAttendanceLocked(false);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, error, refresh: fetchMe, isAttendanceLocked, setAttendanceLocked }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
