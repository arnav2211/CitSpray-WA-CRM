import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/AuthContext";
import { ProtectedRoute, AdminOnly } from "@/components/ProtectedRoute";
import AppShell from "@/components/AppShell";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Leads from "@/pages/Leads";
import LeadDetail from "@/pages/LeadDetail";
import Followups from "@/pages/Followups";
import UsersPage from "@/pages/Users";
import RoutingRules from "@/pages/RoutingRules";
import Templates from "@/pages/Templates";
import Reports from "@/pages/Reports";
import Integrations from "@/pages/Integrations";
import Settings from "@/pages/Settings";
import Chat from "@/pages/Chat";
import QuickReplies from "@/pages/QuickReplies";
import ChatFlows from "@/pages/ChatFlows";
import InternalQA from "@/pages/InternalQA";
import TransferRequests from "@/pages/TransferRequests";

export default function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter>
          <Toaster position="top-right" richColors closeButton />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/leads/:id" element={<><Leads /><LeadDetail /></>} />
              <Route path="/followups" element={<Followups />} />
              <Route path="/qa" element={<InternalQA />} />
              <Route path="/transfer-requests" element={<TransferRequests />} />
              <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
              <Route path="/routing" element={<AdminOnly><RoutingRules /></AdminOnly>} />
              <Route path="/integrations" element={<AdminOnly><Integrations /></AdminOnly>} />
              <Route path="/templates" element={<AdminOnly><Templates /></AdminOnly>} />
              <Route path="/chatflows" element={<AdminOnly><ChatFlows /></AdminOnly>} />
              <Route path="/quick-replies" element={<AdminOnly><QuickReplies /></AdminOnly>} />
              <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
              <Route path="/reports" element={<AdminOnly><Reports /></AdminOnly>} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
