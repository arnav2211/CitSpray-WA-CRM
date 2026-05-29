import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Send, Bell, CheckCircle2, Clock, Users, User, Loader2, Search, X, Ban } from "lucide-react";

const ROLES = [
  { value: "executive", label: "Executives" },
];

export default function AdminAlerts() {
  const [users, setUsers] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderResults, setOrderResults] = useState([]);
  const [orderSearching, setOrderSearching] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const searchTimeout = useRef(null);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState("send");

  useEffect(() => {
    api
      .get("/users")
      .then((r) =>
        setUsers(r.data.filter((u) => u.role !== "admin" && u.active !== false))
      )
      .catch(() => {});
    loadHistory();
  }, []);

  const loadHistory = () => {
    api
      .get("/admin/alerts/history")
      .then((r) => setHistory(r.data))
      .catch(() => {});
  };

  const toggleUser = (id) =>
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  const toggleRole = (role) =>
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((x) => x !== role) : [...prev, role]
    );

  const handleOrderSearch = (val) => {
    setOrderSearch(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!val.trim()) {
      setOrderResults([]);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      setOrderSearching(true);
      try {
        const res = await api.get(
          `/leads?q=${encodeURIComponent(val.trim())}&limit=8`
        );
        // GET /leads returns a bare array by default
        setOrderResults(Array.isArray(res.data) ? res.data : []);
      } catch {
        setOrderResults([]);
      } finally {
        setOrderSearching(false);
      }
    }, 300);
  };

  const pickOrder = (o) => {
    setSelectedOrder(o);
    setOrderId(o.id);
    setCustomerName(o.customer_name);
    setOrderSearch("");
    setOrderResults([]);
  };

  const clearOrder = () => {
    setSelectedOrder(null);
    setOrderId("");
    setCustomerName("");
  };

  const handleSend = async () => {
    if (!title.trim()) return toast.error("Enter a title");
    if (selectedUserIds.length === 0 && selectedRoles.length === 0)
      return toast.error("Select at least one recipient or team");
    setSending(true);
    try {
      const res = await api.post("/admin/alerts", {
        title: title.trim(),
        message: message.trim(),
        recipients: selectedUserIds,
        recipient_roles: selectedRoles,
        order_id: orderId.trim(),
        customer_name: customerName.trim(),
      });
      toast.success(res.data.message);
      setTitle("");
      setMessage("");
      setOrderId("");
      setCustomerName("");
      setSelectedUserIds([]);
      setSelectedRoles([]);
      setSelectedOrder(null);
      loadHistory();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to send alert");
    } finally {
      setSending(false);
    }
  };

  const cancelAlert = async (alertId) => {
    try {
      await api.put(`/admin/alerts/${alertId}/cancel`);
      toast.success("Alert cancelled");
      loadHistory();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to cancel");
    }
  };

  const fmt = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 px-4 md:px-8 py-6">
      <div>
        <h1
          className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
          data-testid="admin-alerts-title"
        >
          Admin Alerts
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Send urgent popup notifications to users in CRM and OMS
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          variant={tab === "send" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("send")}
          data-testid="tab-send"
        >
          <Send className="w-4 h-4 mr-1" /> Send Alert
        </Button>
        <Button
          variant={tab === "history" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setTab("history");
            loadHistory();
          }}
          data-testid="tab-history"
        >
          <Clock className="w-4 h-4 mr-1" /> History
        </Button>
      </div>

      {tab === "send" && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="w-4 h-4" /> Compose Alert
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Team Selection */}
            <div>
              <Label className="mb-2 block">Select Team(s)</Label>
              <div className="flex flex-wrap gap-2">
                {ROLES.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => toggleRole(r.value)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      selectedRoles.includes(r.value)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-gray-200 hover:bg-gray-100"
                    }`}
                    data-testid={`role-${r.value}`}
                  >
                    <Users className="w-3.5 h-3.5 inline mr-1" />
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Individual User Selection */}
            <div>
              <Label className="mb-2 block">Or Select Individual User(s)</Label>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                {users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleUser(u.id)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      selectedUserIds.includes(u.id)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-gray-200 hover:bg-gray-100"
                    }`}
                    data-testid={`user-${u.id}`}
                  >
                    <User className="w-3.5 h-3.5 inline mr-1" />
                    {u.name} <span className="text-[10px] opacity-70">({u.role})</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Call lead back immediately"
                data-testid="alert-title-input"
                className="mt-1"
              />
            </div>

            <div>
              <Label>Message</Label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Enter detailed instruction..."
                data-testid="alert-message-input"
                className="mt-1"
                rows={3}
              />
            </div>

            <div>
              <Label>Link Lead (optional)</Label>
              {selectedOrder ? (
                <div className="mt-1 flex items-center gap-2 px-3 py-2 rounded-lg border bg-gray-50 dark:bg-zinc-800">
                  <div className="flex-1 min-w-0 text-sm">
                    <span className="font-semibold">{selectedOrder.customer_name}</span>
                    {selectedOrder.phone && (
                      <span className="text-gray-500"> — {selectedOrder.phone}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={clearOrder}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="relative mt-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    value={orderSearch}
                    onChange={(e) => handleOrderSearch(e.target.value)}
                    placeholder="Search lead by name, phone..."
                    className="pl-9"
                    data-testid="alert-order-search"
                  />
                  {orderSearching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-gray-400" />
                  )}
                  {orderResults.length > 0 && (
                    <div
                      className="absolute z-50 w-full mt-1 bg-white dark:bg-zinc-800 border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
                      data-testid="alert-order-results"
                    >
                      {orderResults.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors border-b border-gray-100 last:border-0 flex justify-between"
                          onClick={() => pickOrder(o)}
                        >
                          <span className="font-medium text-gray-900 dark:text-white">{o.customer_name}</span>
                          <span className="text-gray-400 truncate ml-2">
                            {o.phone || ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Button
              onClick={handleSend}
              disabled={sending}
              className="w-full"
              data-testid="send-alert-btn"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Send Alert
            </Button>
          </CardContent>
        </Card>
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {history.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No alerts sent yet
            </p>
          )}
          {history.map((a) => (
            <Card key={a.id} data-testid={`alert-history-${a.id}`}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-gray-900 dark:text-white">{a.title}</p>
                    {a.message && (
                      <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">
                        {a.message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {a.cancelled ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-red-300 text-red-600"
                      >
                        <Ban className="w-3 h-3 mr-0.5" /> Cancelled
                      </Badge>
                    ) : (
                      <>
                        <Badge
                          variant={a.fully_acknowledged ? "default" : "outline"}
                          className={`text-[10px] ${
                            a.fully_acknowledged
                              ? "bg-green-600 text-white"
                              : "border-amber-400 text-amber-600"
                          }`}
                        >
                          {a.fully_acknowledged ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 mr-0.5" /> All Acked
                            </>
                          ) : (
                            <>
                              <Clock className="w-3 h-3 mr-0.5" /> {a.ack_count}/
                              {a.total_count}
                            </>
                          )}
                        </Badge>
                        {!a.fully_acknowledged && (
                          <button
                            type="button"
                            onClick={() => cancelAlert(a.id)}
                            className="text-red-500 hover:text-red-700 transition-colors p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/30"
                            title="Cancel alert"
                            data-testid={`cancel-alert-${a.id}`}
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="text-[11px] text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Sent: {fmt(a.created_at)}</span>
                  {a.order_id && <span>Linked Lead ID: {a.order_id}</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {a.recipients_info?.map((r) => {
                    const ack = a.acknowledgements?.[r.id];
                    return (
                      <span
                        key={r.id}
                        className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${
                          ack
                            ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-950/30 dark:border-green-800 dark:text-green-400"
                            : "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-400"
                        }`}
                      >
                        {ack ? (
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                        ) : (
                          <Clock className="w-3 h-3 mr-1" />
                        )}
                        {r.name}
                        {ack && <span className="ml-1 opacity-60">{fmt(ack.at)}</span>}
                      </span>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
