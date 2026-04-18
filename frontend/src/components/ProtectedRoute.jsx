import React from "react";
import { useAuth } from "@/context/AuthContext";
import { Navigate } from "react-router-dom";

export function ProtectedRoute({ children }) {
  const { user } = useAuth();
  if (user === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-widest text-gray-500">Authenticating…</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function AdminOnly({ children }) {
  const { user } = useAuth();
  if (!user || user.role !== "admin") return <Navigate to="/dashboard" replace />;
  return children;
}
