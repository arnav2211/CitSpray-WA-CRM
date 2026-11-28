import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/AuthContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ProtectedRoute, AdminOnly, ExecutiveOrAdminOnly } from "@/components/ProtectedRoute";
import AppShell from "@/components/AppShell";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Leads from "@/pages/Leads";
import LeadDetail from "@/pages/LeadDetail";
import Followups from "@/pages/Followups";
import UsersPage from "@/pages/Users";
import RoutingRules from "@/pages/RoutingRules";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";
import Chat from "@/pages/Chat";
import InternalQA from "@/pages/InternalQA";
import TransferRequests from "@/pages/TransferRequests";
import AdminAlerts from "@/pages/AdminAlerts";
import DataEntry from "@/pages/DataEntry";
import DataEntryInspect from "@/pages/DataEntryInspect";
import CallLogs from "@/pages/CallLogs";
// AttendanceScanner import removed
import PayrollPage from "@/pages/Payroll";
import LeavesPage from "@/pages/Leaves";
import TeamCalls from "@/pages/TeamCalls";
import AiReports from "@/pages/AiReports";
import { WaCallHost } from "@/pages/WaCall";
import Promises from "@/pages/Promises";
import WinBack from "@/pages/WinBack";
import MyAttendance from "@/pages/MyAttendance";
import Documents from "@/pages/Documents";
import DailyVideos from "@/pages/DailyVideos";
import DocApprovals from "@/pages/DocApprovals";

export default function App() {
  return (
    <div className="App">
      <ThemeProvider>
      <AuthProvider>
        <CompanyProvider>
        <BrowserRouter>
          <Toaster position="top-right" richColors closeButton />
          <Routes>
            <Route path="/login" element={<Login />} />
            // AttendanceScanner route removed
            {/* Incoming WhatsApp call screen (opened by the phone app), full screen without the sidebar */}
            {/* the call itself is drawn by <WaCallHost> below, so leaving these screens never cuts the call */}
            <Route path="/wa-call/:id" element={<ProtectedRoute><div className="fixed inset-0 bg-[#075E54]" /></ProtectedRoute>} />
            <Route path="/wa-call-out/:leadId" element={<ProtectedRoute><div className="fixed inset-0 bg-[#075E54]" /></ProtectedRoute>} />
            <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<ExecutiveOrAdminOnly><Dashboard /></ExecutiveOrAdminOnly>} />
              <Route path="/chat" element={<ExecutiveOrAdminOnly><Chat /></ExecutiveOrAdminOnly>} />
              <Route path="/leads" element={<ExecutiveOrAdminOnly><Leads /></ExecutiveOrAdminOnly>} />
              {/* keyed so switching between /leads and /international remounts with fresh filters */}
              <Route path="/international" element={<ExecutiveOrAdminOnly><Leads key="international" international /></ExecutiveOrAdminOnly>} />
              <Route path="/international/chat" element={<ExecutiveOrAdminOnly><Chat key="international-chat" international /></ExecutiveOrAdminOnly>} />
              <Route path="/leads/:id" element={<ExecutiveOrAdminOnly><><Leads /><LeadDetail /></></ExecutiveOrAdminOnly>} />
              <Route path="/calls" element={<ExecutiveOrAdminOnly><CallLogs /></ExecutiveOrAdminOnly>} />
              <Route path="/team-calls" element={<ExecutiveOrAdminOnly><TeamCalls /></ExecutiveOrAdminOnly>} />
              <Route path="/ai-reports" element={<ExecutiveOrAdminOnly><AiReports /></ExecutiveOrAdminOnly>} />
              <Route path="/promises" element={<ExecutiveOrAdminOnly><Promises /></ExecutiveOrAdminOnly>} />
              <Route path="/winback" element={<ExecutiveOrAdminOnly><WinBack /></ExecutiveOrAdminOnly>} />
              <Route path="/followups" element={<ExecutiveOrAdminOnly><Followups /></ExecutiveOrAdminOnly>} />
              <Route path="/qa" element={<ExecutiveOrAdminOnly><InternalQA /></ExecutiveOrAdminOnly>} />
              <Route path="/transfer-requests" element={<ExecutiveOrAdminOnly><TransferRequests /></ExecutiveOrAdminOnly>} />
              <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
              <Route path="/routing" element={<AdminOnly><RoutingRules /></AdminOnly>} />
              <Route path="/integrations" element={<Navigate to="/settings?section=integrations" replace />} />
              <Route path="/templates" element={<Navigate to="/settings?section=templates" replace />} />
              <Route path="/chatflows" element={<Navigate to="/settings?section=chatflows" replace />} />
              <Route path="/quick-replies" element={<Navigate to="/settings?section=quick-replies" replace />} />
              <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
              <Route path="/payment-settings" element={<Navigate to="/settings?section=payment" replace />} />
              <Route path="/payroll" element={<AdminOnly><PayrollPage /></AdminOnly>} />
              <Route path="/daily-videos" element={<AdminOnly><DailyVideos /></AdminOnly>} />
              <Route path="/doc-approvals" element={<AdminOnly><DocApprovals /></AdminOnly>} />
              <Route path="/leaves" element={<LeavesPage />} />
              <Route path="/my-attendance" element={<MyAttendance />} />
              <Route path="/documents" element={<Documents />} />
              <Route path="/reports" element={<ExecutiveOrAdminOnly><Reports /></ExecutiveOrAdminOnly>} />
              <Route path="/alerts" element={<AdminOnly><AdminAlerts /></AdminOnly>} />
              <Route path="/data-entry" element={<DataEntry />} />
              <Route path="/data-entry-inspect" element={<AdminOnly><DataEntryInspect /></AdminOnly>} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          <WaCallHost />
        </BrowserRouter>
        </CompanyProvider>
      </AuthProvider>
      </ThemeProvider>
    </div>
  );
}
