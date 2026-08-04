import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/context/AuthContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { ProtectedRoute, AdminOnly, ExecutiveOrAdminOnly } from "@/components/ProtectedRoute";
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
import PaymentSettings from "@/pages/PaymentSettings";
import AdminAlerts from "@/pages/AdminAlerts";
import DataEntry from "@/pages/DataEntry";
import DataEntryInspect from "@/pages/DataEntryInspect";
import CallLogs from "@/pages/CallLogs";
// AttendanceScanner import removed
import PayrollPage from "@/pages/Payroll";
import LeavesPage from "@/pages/Leaves";

export default function App() {
  return (
    <div className="App">
      <AuthProvider>
        <CompanyProvider>
        <BrowserRouter>
          <Toaster position="top-right" richColors closeButton />
          <Routes>
            <Route path="/login" element={<Login />} />
            // AttendanceScanner route removed
            <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<ExecutiveOrAdminOnly><Dashboard /></ExecutiveOrAdminOnly>} />
              <Route path="/chat" element={<ExecutiveOrAdminOnly><Chat /></ExecutiveOrAdminOnly>} />
              <Route path="/leads" element={<ExecutiveOrAdminOnly><Leads /></ExecutiveOrAdminOnly>} />
              <Route path="/leads/:id" element={<ExecutiveOrAdminOnly><><Leads /><LeadDetail /></></ExecutiveOrAdminOnly>} />
              <Route path="/calls" element={<ExecutiveOrAdminOnly><CallLogs /></ExecutiveOrAdminOnly>} />
              <Route path="/followups" element={<ExecutiveOrAdminOnly><Followups /></ExecutiveOrAdminOnly>} />
              <Route path="/qa" element={<ExecutiveOrAdminOnly><InternalQA /></ExecutiveOrAdminOnly>} />
              <Route path="/transfer-requests" element={<ExecutiveOrAdminOnly><TransferRequests /></ExecutiveOrAdminOnly>} />
              <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
              <Route path="/routing" element={<AdminOnly><RoutingRules /></AdminOnly>} />
              <Route path="/integrations" element={<AdminOnly><Integrations /></AdminOnly>} />
              <Route path="/templates" element={<AdminOnly><Templates /></AdminOnly>} />
              <Route path="/chatflows" element={<AdminOnly><ChatFlows /></AdminOnly>} />
              <Route path="/quick-replies" element={<AdminOnly><QuickReplies /></AdminOnly>} />
              <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
              <Route path="/payment-settings" element={<AdminOnly><PaymentSettings /></AdminOnly>} />
              <Route path="/payroll" element={<AdminOnly><PayrollPage /></AdminOnly>} />
              <Route path="/leaves" element={<LeavesPage />} />
              <Route path="/reports" element={<ExecutiveOrAdminOnly><Reports /></ExecutiveOrAdminOnly>} />
              <Route path="/alerts" element={<AdminOnly><AdminAlerts /></AdminOnly>} />
              <Route path="/data-entry" element={<DataEntry />} />
              <Route path="/data-entry-inspect" element={<AdminOnly><DataEntryInspect /></AdminOnly>} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
        </CompanyProvider>
      </AuthProvider>
    </div>
  );
}
