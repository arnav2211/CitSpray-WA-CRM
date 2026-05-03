import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash, Flag, PaperPlaneTilt, ChatCircleDots, PencilSimple, Check } from "@phosphor-icons/react";

const TYPES = [
  { v: "text", label: "Text" },
  { v: "button", label: "Buttons (max 3)" },
  { v: "list", label: "List (grouped rows)" },
];

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
    try { await api.patch(`/chatflows/${f.id}`, { is_active: !f.is_active }); await loadFlows(); await loadFlow(selectedFlowId); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const deleteFlow = async (f) => {
    if (!window.confirm(`Delete flow "${f.name}" and all its nodes?`)) return;
    try { await api.delete(`/chatflows/${f.id}`); await loadFlows(); if (selectedFlowId === f.id) { setSelectedFlowId(null); setFlow(null); } toast.success("Deleted"); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="chatflows-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Chatbot</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Conversation Flows</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Build button / list-based interactive conversations. The <b>active</b> flow drives
            replies whenever a customer taps a button without an ongoing session.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="new-flow-btn">
          <Plus size={12} weight="bold" /> New Flow
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        {/* Flow list */}
        <div className="border border-gray-200 bg-white" data-testid="flows-list">
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
              {f.description && <div className="text-xs text-gray-500 mt-0.5 truncate">{f.description}</div>}
              <div className="text-[10px] text-gray-400 mt-1 flex items-center gap-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); toggleActive(f); }} className="uppercase tracking-widest font-bold hover:underline" data-testid={`toggle-active-${f.id}`}>
                  {f.is_active ? "Deactivate" : "Activate"}
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); deleteFlow(f); }} className="text-[#E60000] hover:underline" data-testid={`delete-flow-${f.id}`}>Delete</button>
              </div>
            </div>
          ))}
        </div>

        {/* Editor */}
        {flow ? <FlowEditor flow={flow} onChanged={() => loadFlow(selectedFlowId)} /> : <div className="border border-gray-200 bg-white p-8 text-center text-xs uppercase tracking-widest text-gray-400" data-testid="flow-editor-empty">Pick or create a flow</div>}
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

function FlowEditor({ flow, onChanged }) {
  const [selectedNodeId, setSelectedNodeId] = useState(flow.nodes?.[0]?.id || null);
  const [creatingNode, setCreatingNode] = useState(false);
  const [sendPhone, setSendPhone] = useState("");

  useEffect(() => { if (!selectedNodeId && flow.nodes?.length) setSelectedNodeId(flow.nodes[0].id); }, [flow.nodes, selectedNodeId]);
  const selectedNode = (flow.nodes || []).find(n => n.id === selectedNodeId);

  const addNode = async (form) => {
    try {
      const { data } = await api.post(`/chatflows/${flow.id}/nodes`, form);
      setCreatingNode(false);
      setSelectedNodeId(data.id);
      onChanged();
      toast.success("Node created");
    } catch (e) { toast.error(errMsg(e)); }
  };
  const deleteNode = async (n) => {
    if (!window.confirm(`Delete node "${n.name}"?`)) return;
    try { await api.delete(`/chatflows/${flow.id}/nodes/${n.id}`); onChanged(); if (selectedNodeId === n.id) setSelectedNodeId(null); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const triggerSend = async () => {
    if (!sendPhone.trim()) { toast.error("Enter a phone to test"); return; }
    try {
      const { data } = await api.post(`/chatflows/${flow.id}/start`, { phone: sendPhone.trim() });
      toast.success(`Sent: ${data.status || "ok"}`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="border border-gray-200 bg-white" data-testid="flow-editor">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-base truncate">{flow.name}</div>
          <div className="text-xs text-gray-500">
            {flow.is_active ? <span className="text-[#008A00] font-bold">Active — live</span> : "Draft (not active)"}
          </div>
        </div>
        <div className="flex gap-2">
          <input value={sendPhone} onChange={(e) => setSendPhone(e.target.value)} placeholder="Test phone e.g. +919000111222"
            className="border border-gray-300 px-2 py-1.5 text-xs font-mono w-52" data-testid="flow-test-phone" />
          <button onClick={triggerSend} className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="flow-test-send-btn">
            <PaperPlaneTilt size={12} /> Send start
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr]">
        <div className="border-r border-gray-200">
          <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Nodes</div>
            <button onClick={() => setCreatingNode(true)} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7]" data-testid="new-node-btn">+ Add</button>
          </div>
          <div>
            {(flow.nodes || []).length === 0 && <div className="px-4 py-4 text-xs text-gray-400">No nodes</div>}
            {(flow.nodes || []).map(n => (
              <button key={n.id} onClick={() => setSelectedNodeId(n.id)}
                className={`w-full text-left px-4 py-2 border-b border-gray-100 text-xs ${selectedNodeId === n.id ? "bg-gray-50 border-l-2 border-l-[#002FA7] font-bold" : ""}`}
                data-testid={`node-row-${n.id}`}>
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate">{n.name}</span>
                  {n.is_start_node && <Flag size={11} weight="fill" className="text-[#FF8800]" title="Start" />}
                </div>
                <div className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">{n.message_type}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          {selectedNode ? <NodeEditor flow={flow} node={selectedNode} onChanged={onChanged} onDelete={() => deleteNode(selectedNode)} /> :
            <div className="p-8 text-center text-xs uppercase tracking-widest text-gray-400">Pick a node to edit</div>
          }
        </div>
      </div>

      {creatingNode && <NewNodeModal onClose={() => setCreatingNode(false)} onCreate={addNode} />}
    </div>
  );
}

function NewNodeModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("button");
  const [body, setBody] = useState("");
  const [isStart, setIsStart] = useState(false);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onCreate({ name, message_type: type, message_content: { body }, is_start_node: isStart }); }}
        className="w-full max-w-md bg-white border border-gray-900 p-6 space-y-3">
        <h3 className="font-chivo font-black text-xl">New Node</h3>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal name (e.g. 'Greet')"
          className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-node-name-input" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-node-type-select">
          {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <textarea required value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message body the user will see"
          rows={3} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-node-body-input" />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={isStart} onChange={(e) => setIsStart(e.target.checked)} data-testid="new-node-start-checkbox" />
          Mark as start node (entry point of the flow)
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button className="bg-[#002FA7] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="create-node-submit-btn">Create</button>
        </div>
      </form>
    </div>
  );
}

function NodeEditor({ flow, node, onChanged, onDelete }) {
  const [name, setName] = useState(node.name || "");
  const [body, setBody] = useState((node.message_content || {}).body || "");
  const [header, setHeader] = useState((node.message_content || {}).header || "");
  const [footer, setFooter] = useState((node.message_content || {}).footer || "");
  const [buttonText, setButtonText] = useState((node.message_content || {}).button_text || "");
  const [isStart, setIsStart] = useState(!!node.is_start_node);
  const [options, setOptions] = useState((node.options || []).map(o => ({ ...o })));
  const [saving, setSaving] = useState(false);

  // re-sync when a different node is selected
  useEffect(() => {
    setName(node.name || "");
    setBody((node.message_content || {}).body || "");
    setHeader((node.message_content || {}).header || "");
    setFooter((node.message_content || {}).footer || "");
    setButtonText((node.message_content || {}).button_text || "");
    setIsStart(!!node.is_start_node);
    setOptions((node.options || []).map(o => ({ ...o })));
  }, [node.id]);

  const otherNodes = (flow.nodes || []).filter(n => n.id !== node.id);

  const addOption = () => {
    const next = [...options, { option_id: `opt_${options.length + 1}`, label: "", next_node_id: null, position: options.length, section_title: "Options" }];
    setOptions(next);
  };
  const updateOption = (idx, patch) => setOptions(options.map((o, i) => i === idx ? { ...o, ...patch } : o));
  const removeOption = (idx) => setOptions(options.filter((_, i) => i !== idx));

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name,
        message_content: {
          body,
          ...(header ? { header } : {}),
          ...(footer ? { footer } : {}),
          ...(node.message_type === "list" && buttonText ? { button_text: buttonText } : {}),
        },
        is_start_node: isStart,
      };
      await api.patch(`/chatflows/${flow.id}/nodes/${node.id}`, payload);
      if (node.message_type !== "text") {
        await api.put(`/chatflows/${flow.id}/nodes/${node.id}/options`, options.map((o, i) => ({
          option_id: o.option_id, label: o.label, next_node_id: o.next_node_id || null, position: i, section_title: o.section_title || null, description: o.description || null,
        })));
      }
      toast.success("Saved");
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  const maxButtons = node.message_type === "button";

  return (
    <div className="p-4 space-y-4" data-testid={`node-editor-${node.id}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-2">
            {node.message_type}
            {isStart && <span className="text-[#FF8800] flex items-center gap-1"><Flag size={10} weight="fill" /> Start</span>}
          </div>
          <h3 className="font-chivo font-black text-xl mt-1">{node.name}</h3>
        </div>
        <button onClick={onDelete} className="text-[#E60000] text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid={`delete-node-${node.id}`}>
          <Trash size={12} /> Delete node
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Node name"><input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-name-input" /></Field>
        <Field label="Header (optional)"><input value={header} onChange={(e) => setHeader(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-header-input" /></Field>
        <Field label="Body *" full>
          <textarea required value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-body-input" />
        </Field>
        <Field label="Footer (optional)"><input value={footer} onChange={(e) => setFooter(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="node-footer-input" /></Field>
        {node.message_type === "list" && (
          <Field label="List button text"><input value={buttonText} onChange={(e) => setButtonText(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" placeholder="e.g. Choose" data-testid="node-listbutton-input" /></Field>
        )}
        <Field label="Start node" full>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isStart} onChange={(e) => setIsStart(e.target.checked)} data-testid="node-start-checkbox" />
            Use this node as the entry point of the flow
          </label>
        </Field>
      </div>

      {node.message_type !== "text" && (
        <div className="border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><ChatCircleDots size={12} /> Options</div>
            <button onClick={addOption} disabled={maxButtons && options.length >= 3} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] disabled:opacity-40" data-testid="add-option-btn">
              + Add option
            </button>
          </div>
          <div className="space-y-2">
            {options.length === 0 && <div className="text-xs text-gray-400">No options yet — add at least one so users can respond.</div>}
            {options.map((o, i) => (
              <div key={i} className="border border-gray-200 p-2 grid grid-cols-1 md:grid-cols-4 gap-2" data-testid={`option-row-${i}`}>
                <input placeholder="Option ID" value={o.option_id} onChange={(e) => updateOption(i, { option_id: e.target.value })} className="border border-gray-300 px-2 py-1.5 text-xs font-mono" data-testid={`option-id-input-${i}`} />
                <input placeholder="Label user sees" value={o.label} onChange={(e) => updateOption(i, { label: e.target.value })} className="border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-label-input-${i}`} />
                <select value={o.next_node_id || ""} onChange={(e) => updateOption(i, { next_node_id: e.target.value || null })} className="border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-next-select-${i}`}>
                  <option value="">— End of flow —</option>
                  {otherNodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
                <div className="flex gap-1">
                  {node.message_type === "list" && (
                    <input placeholder="Section" value={o.section_title || ""} onChange={(e) => updateOption(i, { section_title: e.target.value })} className="flex-1 border border-gray-300 px-2 py-1.5 text-xs" data-testid={`option-section-input-${i}`} />
                  )}
                  <button onClick={() => removeOption(i)} className="text-[#E60000] p-1" data-testid={`remove-option-${i}`}><Trash size={12} /></button>
                </div>
              </div>
            ))}
          </div>
          {maxButtons && options.length >= 3 && <div className="text-[10px] text-gray-400 mt-1">Max 3 buttons allowed — switch to a List node for more options.</div>}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
        <button onClick={save} disabled={saving} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="save-node-btn">
          <Check size={12} weight="bold" /> {saving ? "Saving…" : "Save node"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, full }) {
  return (
    <label className={full ? "md:col-span-2 block" : "block"}>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}
