import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { TagBadge } from "@/components/Badges";

// Shared labels/tags editor (Fragvansh). The key feature is SUGGESTIONS: while
// typing, existing labels are offered as clickable chips so telecallers pick
// "phenyl" instead of typing "pheynl" — free typing stays possible for genuinely
// new labels, but selection is the primary path (fights the typo problem).
export default function TagsEditor({ tags: initialTags, canEdit, onSave }) {
  const [tags, setTags] = useState(initialTags || []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [allTags, setAllTags] = useState([]);

  useEffect(() => { setTags(initialTags || []); }, [initialTags]);

  // Load the company's existing labels once for suggestions
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/leads/tags");
        setAllTags((data || []).map((t) => t.tag));
      } catch { /* suggestions are best-effort */ }
    })();
  }, []);

  const save = (next) => {
    setTags(next);          // optimistic — the caller persists via PATCH
    onSave(next);
  };

  const addTag = (value) => {
    const v = (value || "").trim().toLowerCase();
    setDraft("");
    setAdding(false);
    if (!v || tags.includes(v)) return;
    save([...tags, v]);
  };

  const q = draft.trim().toLowerCase();
  const suggestions = allTags
    .filter((t) => !tags.includes(t))
    .filter((t) => !q || t.includes(q))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-1.5" data-testid="tags-editor">
      <div className="flex items-center gap-1.5 flex-wrap">
        {tags.length === 0 && !adding && (
          <span className="text-xs text-gray-400">No labels{canEdit ? " yet" : ""}</span>
        )}
        {tags.map((t) => (
          <TagBadge key={t} tag={t} onRemove={canEdit ? () => save(tags.filter((x) => x !== t)) : undefined} />
        ))}
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)}
            className="text-[10px] uppercase tracking-widest font-bold text-[#7C3AED] hover:underline"
            data-testid="tag-add-btn">+ Add label</button>
        )}
      </div>
      {canEdit && adding && (
        <div className="flex flex-col gap-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag(draft); }
              if (e.key === "Escape") { setAdding(false); setDraft(""); }
            }}
            placeholder="Pick below or type a new label"
            className="border border-[#7C3AED] px-2 py-1 text-xs outline-none w-48"
            data-testid="tag-add-input"
          />
          {suggestions.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap" data-testid="tag-suggestions">
              {suggestions.map((t) => (
                // onMouseDown so the click wins over the input's blur
                <button key={t} onMouseDown={(e) => { e.preventDefault(); addTag(t); }}
                  className="px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-bold border border-gray-300 text-gray-600 hover:border-[#7C3AED] hover:text-[#7C3AED]"
                  data-testid={`tag-suggest-${t}`}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => { setAdding(false); setDraft(""); }}
            className="self-start text-[10px] uppercase tracking-widest font-bold text-gray-400 hover:text-gray-900">cancel</button>
        </div>
      )}
    </div>
  );
}
