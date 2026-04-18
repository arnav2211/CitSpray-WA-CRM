import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { Navigate } from "react-router-dom";
import { Compass, ArrowRight } from "@phosphor-icons/react";

export default function Login() {
  const { user, login, error } = useAuth();
  const [username, setU] = useState("admin");
  const [password, setP] = useState("Admin@123");
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    await login(username.trim(), password);
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Left panel */}
      <div className="hidden md:flex login-grid-bg flex-1 p-12 flex-col justify-between relative">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#002FA7] flex items-center justify-center">
            <Compass size={18} weight="bold" color="white" />
          </div>
          <div className="font-chivo font-black text-lg tracking-tight">LEADORBIT</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">/ Command Console</div>
          <h1 className="font-chivo font-black text-5xl lg:text-6xl leading-[0.95] tracking-tight max-w-xl">
            Every lead.<br/>
            Every minute.<br/>
            Accounted for.
          </h1>
          <p className="mt-6 max-w-md text-sm text-gray-600">
            A production CRM for sales teams running on IndiaMART, Justdial and WhatsApp — with
            deterministic round-robin assignment, auto-reassignment and role-isolated visibility.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-0 border-t border-gray-300">
          {[
            ["00", "Sources"],
            ["00", "Round-robin"],
            ["00", "Auto-reassign"],
          ].map(([n, label], i) => (
            <div key={i} className="border-r last:border-r-0 border-gray-300 py-4 pr-4">
              <div className="font-chivo font-black text-2xl">{n}</div>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-1">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-12 bg-white">
        <form onSubmit={submit} className="w-full max-w-sm border border-gray-900 p-8 bg-white" data-testid="login-form">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Secure Access</div>
          <h2 className="font-chivo font-black text-3xl mt-1 mb-6">Sign in</h2>

          <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-1">Username</label>
          <input
            data-testid="login-username-input"
            value={username} onChange={(e) => setU(e.target.value)}
            autoComplete="username"
            className="w-full border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#002FA7] focus:border-[#002FA7] outline-none mb-4"
            placeholder="admin"
            required
          />

          <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-1">Password</label>
          <input
            data-testid="login-password-input"
            type="password"
            value={password} onChange={(e) => setP(e.target.value)}
            autoComplete="current-password"
            className="w-full border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#002FA7] focus:border-[#002FA7] outline-none"
            required
          />

          {error && (
            <div className="mt-4 border border-[#E60000] text-[#E60000] text-xs p-2" data-testid="login-error">
              {error}
            </div>
          )}

          <button
            disabled={loading}
            data-testid="login-submit-btn"
            className="mt-6 w-full bg-[#002FA7] hover:bg-[#002288] text-white uppercase tracking-widest text-xs font-bold py-3 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? "Authenticating…" : "Enter Console"} <ArrowRight size={14} weight="bold" />
          </button>

          <div className="mt-6 border-t border-gray-200 pt-4 text-[11px] text-gray-500 leading-relaxed">
            <div className="font-bold uppercase tracking-widest text-gray-400 text-[10px] mb-1">Dev credentials</div>
            admin / Admin@123<br/>
            ravi / Exec@123<br/>
            priya / Exec@123
          </div>
        </form>
      </div>
    </div>
  );
}
