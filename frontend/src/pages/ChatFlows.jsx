import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import {
  Plus, Trash, Flag, PaperPlaneTilt, ChatCircleDots, Check, X, Upload,
  TextAlignLeft, ListBullets, Image as ImageIcon, VideoCamera, FileText, SquaresFour,
} from "@phosphor-icons/react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, Handle, Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const TYPES = [
  { v: "text", label: "Text", icon: TextAlignLeft, color: "#002FA7" },
  { v: "button", label: "Buttons (max 3)", icon: ChatCircleDots, color: "#7C3AED" },
  { v: "list", label: "List (grouped)", icon: ListBullets, color: "#0891B2" },
  { v: "image", label: "Image", icon: ImageIcon, color: "#C2410C" },
  { v: "video", label: "Video", icon: VideoCamera, color: "#BE185D" },
  { v: "document", label: "Document", icon: FileText, color: "#475569" },
  { v: "carousel", label: "Carousel", icon: SquaresFour, color: "#15803D" },
];
const typeMeta = (t) => TYPES.find((x) => x.v === t) || TYPES[0];
const REMOTE_BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const mediaHref = (url) => (url && url.startsWith("/api/") ? `${REMOTE_BACKEND}${url}` : url);

// Custom node renderer for React Flow
function FlowNodeCard({ data }) {
  const { node, isSelected } = data;
  const meta = typeMeta(node.message_type);
  const Icon = meta.icon;
  const content = node.message_content || {};
  const preview = (content.body || "").slice(0, 80) || (content.caption || "").slice(0, 80) || "";
  const optionsCount = (node.options || []).length;
  return (
    <div
      className={`bg-white border ${isSelected ? "border-[#002FA7]" : "border-gray-300"} w-[240px] shadow-sm`}
      style={{ borderLeft: `4px solid ${meta.color}` }}
      data-testid={`canvas-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#111", width: 8, height: 8, border: "2px solid #fff" }} />
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={12} weight="bold" style={{ color: meta.color }} />
          <span className="text-[9px] uppercase tracking-widest font-bold text-gray-600 truncate">
            {meta.label}
          </span>
        </div>
        {node.is_start_node && (
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-[#FF8800]">
            <Flag size={10} weight="fill" /> Start
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="font-semibold text-xs truncate">{node.name || "Untitled"}</div>
        {preview && (
          <div className="text-[11px] text-gray-600 mt-1 line-clamp-2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {preview}
          </div>
        )}
        {node.message_type === "carousel" && (content.cards || []).length > 0 && (
          <div className="text-[10px] text-gray-500 mt-1">{(content.cards || []).length} card(s)</div>
        )}
      </div>
      {(node.message_type === "button" || node.message_type === "list" || node.message_type === "carousel") && (
        <div className="border-t border-gray-100 px-3 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-gray-400 font-bold mb-1">
            {optionsCount} option{optionsCount === 1 ? "" : "s"}
          </div>
          {(node.options || []).slice(0, 4).map((o, i) => (
            <div key={o.id || i} className="relative flex items-center justify-between py-0.5 text-[10px]">
              <span className="truncate mr-2">• {o.label || o.option_id}</span>
              <Handle
                type="source"
                id={o.option_id}
                position={Position.Right}
                style={{
                  position: "absolute",
                  right: -14,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: o.next_node_id ? "#002FA7" : "#d1d5db",
                  width: 8,
                  height: 8,
                  border: "2px solid #fff",
                }}
              />
            </div>
          ))}
          {optionsCount > 4 && <div className="text-[9px] text-gray-400 mt-0.5">+{optionsCount - 4} more…</div>}
        </div>
      )}
      {node.message_type === "text" && (
        <Handle type="source" position={Position.Right} style={{ background: "#002FA7", width: 8, height: 8, border: "2px solid #fff" }} />
      )}
      {(node.message_type === "image" || node.message_type === "video" || node.message_type === "document") && (
        <Handle type="source" position={Position.Right} style={{ background: "#002FA7", width: 8, height: 8, border: "2px solid #fff" }} />
      )}
    </div>
  );
}

const nodeTypes = { flowNode: FlowNodeCard };

export default function ChatFlows() {
  const [flows, setFlows] = useState([]);
  const [selectedFlowId, setSelectedFlowId] = useState(null);
  const [flow, setFlow] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadFlows = async () => {
    try {
      const { data } = await api.get("/chatflows");
      setFlows(data);
      if (data.length && !selectedFlowId) setSelectedFlowId(data[0].id);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const loadFlow = async (id) => {
    try { const { data } = await api.get(`/chatflows/${id}`); setFlow(data); }
    catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { loadFlows(); }, []);
  useEffect(() => { if (selectedFlowId) loadFlow(selectedFlowId); }, [selectedFlowId]);

  const createFlow = async () => {
    if (!newName.trim()) return;
    try {
      const { data } = await api.post("/chatflows", { name: newName.trim(), is_active: flows.length === 0 });
      setNewName(""); setCreating(false);
      await loadFlows();
      setSelectedFlowId(data.id);
      toast.success("Flow created");
    } catch (e) { toast.error(errMsg(e)); }
  };
  const toggleActive = async (f) => {
    try { await api.patch(`/chatflows/${f.id}`, { is_active: !f.is_active }); await loadFlows(); if (selectedFlowId) await loadFlow(selectedFlowId); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const deleteFlow = async (f) => {
    if (!window.confirm(`Delete flow "${f.name}" and all its nodes?`)) return;
    try { await api.delete(`/chatflows/${f.id}`); await loadFlows(); if (selectedFlowId === f.id) { setSelectedFlowId(null); setFlow(null); } toast.success("Deleted"); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="chatflows-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Chatbot</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Conversation Flows</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Visual flow designer — drag nodes, connect replies. Supports text, buttons, lists,
            images, videos, documents and carousels. The <b>active</b> flow auto-replies to
            customer button taps.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="new-flow-btn">
          <Plus size={12} weight="bold" /> New Flow
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
        <div className="border border-gray-200 bg-white self-start" data-testid="flows-list">
          {flows.length === 0 && <div className="p-6 text-center text-xs uppercase tracking-widest text-gray-400">No flows yet</div>}
          {flows.map(f => (
            <div key={f.id} onClick={() => setSelectedFlowId(f.id)}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedFlowId(f.id); } }}
              className={`cursor-pointer text-left px-4 py-3 border-b border-gray-100 ${selectedFlowId === f.id ? "bg-gray-50 border-l-2 border-l-[#002FA7]" : ""}`}
              data-testid={`flow-row-${f.id}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-sm truncate">{f.name}</div>
                {f.is_active && <span className="text-[9px] uppercase tracking-widest text-[#008A00] font-bold bg-[#E6F7E6] px-1.5 py-0.5" data-testid="flow-active-flag">Active</span>}
              </div>
              <div className="text-[10px] text-gray-400 mt-1 flex items-center gap-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); toggleActive(f); }} className="uppercase tracking-widest font-bold hover:underline" data-testid={`toggle-active-${f.id}`}>
                  {f.is_active ? "Deactivate" : "Activate"}
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); deleteFlow(f); }} className="text-[#E60000] hover:underline" data-testid={`delete-flow-${f.id}`}>Delete</button>
              </div>
            </div>
          ))}
        </div>

        {flow ? (
          <ReactFlowProvider>
            <FlowCanvas key={flow.id} flow={flow} reload={() => loadFlow(selectedFlowId)} />
          </ReactFlowProvider>
        ) : (
          <div className="border border-gray-200 bg-white p-8 text-center text-xs uppercase tracking-widest text-gray-400" data-testid="flow-editor-empty">
            Pick or create a flow
          </div>
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setCreating(false)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); createFlow(); }} className="w-full max-w-md bg-white border border-gray-900 p-6 space-y-3">
            <h3 className="font-chivo font-black text-xl">New Flow</h3>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Sales qualification" className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-flow-name-input" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
              <button className="bg-[#002FA7] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="create-flow-submit-btn">Create</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ────────────────────── Canvas + Side-panel editor ──────────────────────

function FlowCanvas({ flow, reload }) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [creatingNode, setCreatingNode] = useState(false);
  const [sendPhone, setSendPhone] = useState("");

  // Build React Flow nodes + edges from the flow payload
  const buildRfNodes = useCallback((nodesArr) => {
    return (nodesArr || []).map((n, i) => ({
      id: n.id,
      type: "flowNode",
      position: { x: n.x ?? 80 + (i % 4) * 320, y: n.y ?? 80 + Math.floor(i / 4) * 220 },
      data: { node: n, isSelected: false },
      draggable: true,
    }));
  }, []);

  const buildRfEdges = useCallback((nodesArr) => {
    const edges = [];
    (nodesArr || []).forEach((n) => {
      (n.options || []).forEach((o) => {
        if (o.next_node_id) {
          edges.push({
            id: `${n.id}:${o.option_id}->${o.next_node_id}`,
            source: n.id,
            sourceHandle: o.option_id,
            target: o.next_node_id,
            animated: true,
            style: { stroke: "#002FA7", strokeWidth: 1.5 },
            label: (o.label || o.option_id || "").slice(0, 20),
            labelStyle: { fontSize: 10, fontWeight: 600, fill: "#1f2937" },
            labelBgStyle: { fill: "#fff", fillOpacity: 0.95 },
          });
        }
      });
    });
    return edges;
  }, []);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    const nextNodes = buildRfNodes(flow.nodes);
    setRfNodes(nextNodes.map((n) => ({
      ...n,
      data: { ...n.data, isSelected: n.id === selectedNodeId },
    })));
    setRfEdges(buildRfEdges(flow.nodes));
  }, [flow.nodes, selectedNodeId, buildRfNodes, buildRfEdges, setRfNodes, setRfEdges]);

  // Persist positions debounced
  const savePositionsTimer = useRef(null);
  const schedulePositionSave = useCallback(() => {
    if (savePositionsTimer.current) clearTimeout(savePositionsTimer.current);
    savePositionsTimer.current = setTimeout(async () => {
      const positions = {};
      rfNodes.forEach((n) => { positions[n.id] = { x: n.position.x, y: n.position.y }; });
      try { await api.put(`/chatflows/${flow.id}/positions`, { positions }); }
      catch (e) { /* silent */ }
    }, 600);
  }, [rfNodes, flow.id]);

  const handleNodesChange = useCallback((changes) => {
    onNodesChange(changes);
    if (changes.some((c) => c.type === "position" && !c.dragging)) {
      schedulePositionSave();
    }
  }, [onNodesChange, schedulePositionSave]);

  const onConnect = useCallback(async (connection) => {
    // Dropping a connection: set next_node_id of the matching option on the source node.
    const { source, sourceHandle, target } = connection;
    if (!source || !sourceHandle || !target) return;
    const srcNode = (flow.nodes || []).find((n) => n.id === source);
    if (!srcNode) return;
    const opts = (srcNode.options || []).map((o) => ({
      option_id: o.option_id,
      label: o.label,
      next_node_id: o.option_id === sourceHandle ? target : o.next_node_id || null,
      position: o.position || 0,
      section_title: o.section_title || null,
      description: o.description || null,
    }));
    try {
      await api.put(`/chatflows/${flow.id}/nodes/${source}/options`, opts);
      toast.success("Connection saved");
      reload();
    } catch (e) { toast.error(errMsg(e)); }
  }, [flow, reload]);

  const selectedNode = useMemo(
    () => (flow.nodes || []).find((n) => n.id === selectedNodeId),
    [flow.nodes, selectedNodeId]
  );

  const handleNodeClick = useCallback((_e, rfNode) => setSelectedNodeId(rfNode.id), []);
  const handlePaneClick = useCallback(() => setSelectedNodeId(null), []);

  const triggerSend = async () => {
    if (!sendPhone.trim()) { toast.error("Enter a phone to test"); return; }
    try {
      const { data } = await api.post(`/chatflows/${flow.id}/start`, { phone: sendPhone.trim() });
      toast.success(`Sent: ${data.status || "ok"}`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const deleteNode = async (n) => {
    if (!window.confirm(`Delete node "${n.name}"?`)) return;
    try {
      await api.delete(`/chatflows/${flow.id}/nodes/${n.id}`);
      if (selectedNodeId === n.id) setSelectedNodeId(null);
      reload();
      toast.success("Node deleted");
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="border border-gray-200 bg-white" data-testid="flow-editor">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-base truncate">{flow.name}</div>
          <div className="text-xs text-gray-500">
            {flow.is_active ? <span className="text-[#008A00] font-bold">Active — live</span> : "Draft (not active)"}
            <span className="mx-2">·</span>
            <span>{(flow.nodes || []).length} node(s)</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <button onClick={() => setCreatingNode(true)} className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="new-node-btn">
            <Plus size={12} weight="bold" /> Add node
          </button>
          <input value={sendPhone} onChange={(e) => setSendPhone(e.target.value)} placeholder="Test phone +91…"
            className="border border-gray-300 px-2 py-1.5 text-xs font-mono w-48" data-testid="flow-test-phone" />
          <button onClick={triggerSend} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="flow-test-send-btn">
            <PaperPlaneTilt size={12} /> Send start
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px]">
        <div className="h-[600px] border-r border-gray-200 bg-[#FAFAFA]" data-testid="flow-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} color="#e5e7eb" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-white !border !border-gray-200" />
          </ReactFlow>
        </div>

        <div className="max-h-[600px] overflow-y-auto">
          {selectedNode ? (
            <NodeInspector
              key={selectedNode.id}
              flow={flow}
              node={selectedNode}
              onChanged={reload}
              onDelete={() => deleteNode(selectedNode)}
              onClose={() => setSelectedNodeId(null)}
            />
          ) : (
            <div className="p-6 text-center text-xs text-gray-400">
              <div className="uppercase tracking-widest font-bold mb-2">Select a node</div>
              <div>Click a card on the canvas to edit its content, options and media. Drag
              between the coloured handles on the right edge to link an option to the next node.</div>
            </div>
          )}
        </div>
      </div>

      {creatingNode && <NewNodeModal flowId={flow.id} onClose={() => setCreatingNode(false)} onCreated={() => { setCreatingNode(false); reload(); }} />}
    </div>
  );
}

// ────────────────────── New Node modal ──────────────────────

function NewNodeModal({ flowId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("button");
  const [isStart, setIsStart] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    const defaultContent = (() => {
      if (type === "carousel") return { body: "Choose a product", cards: [] };
      if (["image", "video", "document"].includes(type)) return { media_url: "" };
      return { body: "" };
    })();
    try {
      await api.post(`/chatflows/${flowId}/nodes`, {
        name: name.trim(),
        message_type: type,
        message_content: defaultContent,
        is_start_node: isStart,
      });
      toast.success("Node created");
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="w-full max-w-lg bg-white border border-gray-900 p-6 space-y-3">
        <h3 className="font-chivo font-black text-xl">New Node</h3>
        <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal name (e.g. 'Greet')"
          className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-node-name-input" />
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1.5">Message type</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {TYPES.map((t) => {
              const Icon = t.icon;
              const active = type === t.v;
              return (
                <button type="button" key={t.v} onClick={() => setType(t.v)}
                  className={`border px-2 py-2 flex items-center gap-1.5 text-xs ${active ? "border-[#002FA7] bg-[#F0F4FF]" : "border-gray-300 hover:border-gray-500"}`}
                  data-testid={`new-node-type-${t.v}`} style={active ? { borderLeft: `4px solid ${t.color}` } : undefined}>
                  <Icon size={14} weight="bold" style={{ color: t.color }} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={isStart} onChange={(e) => setIsStart(e.target.checked)} data-testid="new-node-start-checkbox" />
          Mark as start node (entry point of the flow)
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button disabled={saving} className="bg-[#002FA7] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="create-node-submit-btn">
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ────────────────────── Node Inspector side panel ──────────────────────

function NodeInspector({ flow, node, onChanged, onDelete, onClose }) {
  const [name, setName] = useState(node.name || "");
  const [type, setType] = useState(node.message_type);
  const [content, setContent] = useState(node.message_content || {});
  const [isStart, setIsStart] = useState(!!node.is_start_node);
  const [options, setOptions] = useState((node.options || []).map((o) => ({ ...o })));
  const [saving, setSaving] = useState(false);

  const otherNodes = (flow.nodes || []).filter((n) => n.id !== node.id);
  const meta = typeMeta(type);
  const Icon = meta.icon;

  const patchContent = (patch) => setContent((c) => ({ ...c, ...patch }));

  const addOption = () => {
    setOptions((cur) => {
      const max = type === "button" || type === "carousel" ? 3 : 10;
      if (cur.length >= max) {
        toast.error(`Max ${max} options for ${type} nodes`);
        return cur;
      }
      return [...cur, {
        option_id: `opt_${cur.length + 1}`,
        label: "",
        next_node_id: null,
        position: cur.length,
        section_title: type === "list" ? "Options" : null,
        description: null,
      }];
    });
  };
  const updateOption = (i, patch) => setOptions((cur) => cur.map((o, idx) => idx === i ? { ...o, ...patch } : o));
  const removeOption = (i) => setOptions((cur) => cur.filter((_, idx) => idx !== i));

  const addCard = () => {
    const cards = content.cards || [];
    patchContent({ cards: [...cards, { image_url: "", title: "", subtitle: "", button_label: "" }] });
    // Also add a matching option so routing works
    setOptions((cur) => [...cur, {
      option_id: `card_${cards.length + 1}`,
      label: "",
      next_node_id: null,
      position: cur.length,
      section_title: null,
      description: null,
    }]);
  };
  const updateCard = (i, patch) => {
    const cards = [...(content.cards || [])];
    cards[i] = { ...cards[i], ...patch };
    patchContent({ cards });
    // Keep card.button_label in sync with option.label
    if (patch.button_label !== undefined) {
      setOptions((cur) => cur.map((o, idx) => idx === i ? { ...o, label: patch.button_label } : o));
    }
  };
  const removeCard = (i) => {
    const cards = (content.cards || []).filter((_, idx) => idx !== i);
    patchContent({ cards });
    setOptions((cur) => cur.filter((_, idx) => idx !== i));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Clean content per type so we don't persist stale fields
      let cleanedContent = {};
      if (type === "text") cleanedContent = { body: content.body || "" };
      else if (type === "button") cleanedContent = {
        body: content.body || "",
        ...(content.header ? { header: content.header } : {}),
        ...(content.footer ? { footer: content.footer } : {}),
      };
      else if (type === "list") cleanedContent = {
        body: content.body || "",
        button_text: content.button_text || "Choose",
        ...(content.header ? { header: content.header } : {}),
        ...(content.footer ? { footer: content.footer } : {}),
      };
      else if (type === "image" || type === "video") cleanedContent = {
        media_url: content.media_url || "",
        ...(content.caption ? { caption: content.caption } : {}),
      };
      else if (type === "document") cleanedContent = {
        media_url: content.media_url || "",
        ...(content.caption ? { caption: content.caption } : {}),
        ...(content.filename ? { filename: content.filename } : {}),
      };
      else if (type === "carousel") cleanedContent = {
        body: content.body || "Choose an option",
        cards: content.cards || [],
      };

      await api.patch(`/chatflows/${flow.id}/nodes/${node.id}`, {
        name,
        message_type: type,
        message_content: cleanedContent,
        is_start_node: isStart,
      });

      const optionBased = ["button", "list", "carousel"].includes(type);
      if (optionBased) {
        await api.put(`/chatflows/${flow.id}/nodes/${node.id}/options`, options.map((o, i) => ({
          option_id: o.option_id,
          label: o.label,
          next_node_id: o.next_node_id || null,
          position: i,
          section_title: o.section_title || null,
          description: o.description || null,
        })));
      } else {
        // Non-option node: clear any stale options
        await api.put(`/chatflows/${flow.id}/nodes/${node.id}/options`, []);
      }
      toast.success("Saved");
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 space-y-4" data-testid={`node-editor-${node.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1.5">
            <Icon size={12} weight="bold" style={{ color: meta.color }} /> {meta.label}
            {isStart && <span className="text-[#FF8800] flex items-center gap-1 ml-1"><Flag size={10} weight="fill" /> Start</span>}
          </div>
          <h3 className="font-chivo font-black text-lg truncate">{name || "Untitled"}</h3>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-900 p-1" data-testid="close-node-inspector"><X size={14} /></button>
      </div>

      <FieldBlock label="Internal name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-name-input" />
      </FieldBlock>

      <FieldBlock label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-type-select">
          {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
      </FieldBlock>

      {(type === "text" || type === "button" || type === "list" || type === "carousel") && (
        <FieldBlock label={type === "carousel" ? "Prompt body (sent with button card)" : "Body *"}>
          <textarea value={content.body || ""} onChange={(e) => patchContent({ body: e.target.value })} rows={3}
            className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-body-input" />
        </FieldBlock>
      )}

      {(type === "button" || type === "list") && (
        <>
          <FieldBlock label="Header (optional)">
            <input value={content.header || ""} onChange={(e) => patchContent({ header: e.target.value })}
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-header-input" />
          </FieldBlock>
          <FieldBlock label="Footer (optional)">
            <input value={content.footer || ""} onChange={(e) => patchContent({ footer: e.target.value })}
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-footer-input" />
          </FieldBlock>
        </>
      )}

      {type === "list" && (
        <FieldBlock label="List button text">
          <input value={content.button_text || ""} onChange={(e) => patchContent({ button_text: e.target.value })}
            placeholder="e.g. Choose" className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-listbutton-input" />
        </FieldBlock>
      )}

      {(type === "image" || type === "video" || type === "document") && (
        <>
          <FieldBlock label={`${type.charAt(0).toUpperCase()}${type.slice(1)} URL or upload *`}>
            <input value={content.media_url || ""} onChange={(e) => patchContent({ media_url: e.target.value })}
              placeholder="https://..." className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="node-media-url-input" />
            <MediaUploader kind={type} onUploaded={(res) => patchContent({ media_url: res.url, ...(type === "document" && res.filename && !content.filename ? { filename: res.filename } : {}) })} />
          </FieldBlock>
          <FieldBlock label={type === "document" ? "Caption (optional — supports line breaks, *bold*)" : "Caption (optional — supports line breaks, *bold*)"}>
            <textarea value={content.caption || ""} onChange={(e) => patchContent({ caption: e.target.value })}
              rows={6} className="w-full border border-gray-300 px-3 py-2 text-sm whitespace-pre-wrap font-mono" data-testid="node-caption-input"
              placeholder={"Dear Sir/Madam,\n\nGreetings from *CitSpray* 🌿\n\n*Our Bestsellers:*\n• Essential Oils\n• Fragrance Oils"} />
            <div className="text-[10px] text-gray-400 mt-1">Line breaks and WhatsApp markdown (*bold*, _italic_, ~strike~) are preserved.</div>
          </FieldBlock>
          {type === "document" && (
            <FieldBlock label="Filename shown to recipient">
              <input value={content.filename || ""} onChange={(e) => patchContent({ filename: e.target.value })}
                placeholder="brochure.pdf" className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-filename-input" />
            </FieldBlock>
          )}
          {content.media_url && (
            <div className="border border-gray-200 p-2 text-[11px] text-gray-500 break-all">
              Preview: <a href={mediaHref(content.media_url)} target="_blank" rel="noreferrer" className="text-[#002FA7] underline">{content.media_url}</a>
            </div>
          )}
        </>
      )}

      <FieldBlock label="Start node">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={isStart} onChange={(e) => setIsStart(e.target.checked)} data-testid="node-start-checkbox" />
          Use this node as the entry point of the flow
        </label>
      </FieldBlock>

      {/* Carousel cards */}
      {type === "carousel" && (
        <div className="border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><SquaresFour size={12} /> Cards (max 3)</div>
            <button onClick={addCard} disabled={(content.cards || []).length >= 3} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] disabled:opacity-40" data-testid="add-card-btn">
              + Add card
            </button>
          </div>
          <div className="space-y-2">
            {(content.cards || []).length === 0 && <div className="text-xs text-gray-400">No cards yet — each card is a separate image with an optional button.</div>}
            {(content.cards || []).map((c, i) => (
              <div key={i} className="border border-gray-200 p-2 space-y-2" data-testid={`card-row-${i}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Card {i + 1}</span>
                  <button onClick={() => removeCard(i)} className="text-[#E60000]" data-testid={`remove-card-${i}`}><Trash size={12} /></button>
                </div>
                <input placeholder="Image URL" value={c.image_url || ""} onChange={(e) => updateCard(i, { image_url: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs font-mono" data-testid={`card-image-url-${i}`} />
                <MediaUploader kind="image" onUploaded={(res) => updateCard(i, { image_url: res.url })} />
                <input placeholder="Title" value={c.title || ""} onChange={(e) => updateCard(i, { title: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`card-title-${i}`} />
                <textarea placeholder="Subtitle — supports line breaks & *bold*" rows={3} value={c.subtitle || ""} onChange={(e) => updateCard(i, { subtitle: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs whitespace-pre-wrap font-mono" data-testid={`card-subtitle-${i}`} />
                <input placeholder="Button label (max 20 chars)" maxLength={20} value={c.button_label || ""} onChange={(e) => updateCard(i, { button_label: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`card-button-label-${i}`} />
                <select value={(options[i] && options[i].next_node_id) || ""} onChange={(e) => updateOption(i, { next_node_id: e.target.value || null })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`card-next-select-${i}`}>
                  <option value="">— End of flow —</option>
                  {otherNodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Options editor for button / list nodes */}
      {(type === "button" || type === "list") && (
        <div className="border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><ChatCircleDots size={12} /> Options</div>
            <button onClick={addOption} disabled={type === "button" && options.length >= 3} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] disabled:opacity-40" data-testid="add-option-btn">
              + Add option
            </button>
          </div>
          <div className="space-y-2">
            {options.length === 0 && <div className="text-xs text-gray-400">No options yet — add at least one so users can respond.</div>}
            {options.map((o, i) => (
              <div key={i} className="border border-gray-200 p-2 space-y-1.5" data-testid={`option-row-${i}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Option {i + 1}</span>
                  <button onClick={() => removeOption(i)} className="text-[#E60000]" data-testid={`remove-option-${i}`}><Trash size={12} /></button>
                </div>
                <input placeholder="Option ID (machine key)" value={o.option_id} onChange={(e) => updateOption(i, { option_id: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs font-mono" data-testid={`option-id-input-${i}`} />
                <input placeholder={`Label (${type === "button" ? "max 20" : "max 24"} chars)`}
                  maxLength={type === "button" ? 20 : 24}
                  value={o.label} onChange={(e) => updateOption(i, { label: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-label-input-${i}`} />
                {type === "list" && (
                  <>
                    <input placeholder="Section title" value={o.section_title || ""} onChange={(e) => updateOption(i, { section_title: e.target.value })}
                      className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-section-input-${i}`} />
                    <input placeholder="Row description (optional)" value={o.description || ""} onChange={(e) => updateOption(i, { description: e.target.value })}
                      className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-desc-input-${i}`} />
                  </>
                )}
                <select value={o.next_node_id || ""} onChange={(e) => updateOption(i, { next_node_id: e.target.value || null })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-next-select-${i}`}>
                  <option value="">— End of flow —</option>
                  {otherNodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          {type === "button" && options.length >= 3 && <div className="text-[10px] text-gray-400 mt-1">Max 3 buttons — switch to List for more.</div>}
        </div>
      )}

      <div className="flex justify-between gap-2 pt-3 border-t border-gray-200">
        <button onClick={onDelete} className="text-[#E60000] text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid={`delete-node-${node.id}`}>
          <Trash size={12} /> Delete
        </button>
        <button onClick={save} disabled={saving} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="save-node-btn">
          <Check size={12} weight="bold" /> {saving ? "Saving…" : "Save node"}
        </button>
      </div>
    </div>
  );
}

function FieldBlock({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}

function MediaUploader({ kind, onUploaded }) {
  const [uploading, setUploading] = useState(false);
  const ref = useRef(null);
  const handle = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    try {
      const { data } = await api.post("/chatflows/upload-media", form, { headers: { "Content-Type": "multipart/form-data" } });
      onUploaded(data);
      toast.success(`Uploaded ${data.filename}`);
    } catch (err) { toast.error(errMsg(err)); }
    finally {
      setUploading(false);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <div className="flex items-center gap-2 mt-1.5">
      <input ref={ref} type="file" onChange={handle} className="hidden" data-testid={`upload-media-${kind}`}
        accept={kind === "image" ? "image/*" : kind === "video" ? "video/*" : undefined} />
      <button type="button" onClick={() => ref.current?.click()} disabled={uploading}
        className="border border-gray-300 hover:border-gray-900 px-2 py-1 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-40"
        data-testid={`upload-media-btn-${kind}`}>
        <Upload size={10} weight="bold" /> {uploading ? "Uploading…" : "Upload file"}
      </button>
      <span className="text-[10px] text-gray-400">or paste a URL above</span>
    </div>
  );
}
