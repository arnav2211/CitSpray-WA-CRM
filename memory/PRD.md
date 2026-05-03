# LeadOrbit CRM — PRD

## Original Problem Statement
Production-ready CRM + Lead Management + WhatsApp Automation for a sales team. Multi-source lead import (IndiaMART webhook + Justdial email parsing via Gmail), intelligent assignment (round-robin + manual + PNS + time-slot routing + auto-reassign), WhatsApp Business Cloud API with templates and conversation history, follow-ups/reminders, strict RBAC (admin vs executive), analytics, and a WhatsApp Web–style chat console.

## Stack
FastAPI + MongoDB (motor) + React 19 + JWT + APScheduler. Swiss / High-Contrast design system (Chivo + IBM Plex Sans, Klein blue #002FA7, sharp-edge components).

## User Personas
- **Admin** — owns routing rules, manages executives, reassigns anywhere, sees full pipeline, configures WhatsApp/Gmail credentials, reviews reports.
- **Executive** — sees ONLY their own assigned leads, can update status, add notes, send WhatsApp messages within the 24-hour window, schedule follow-ups, and request transfer of leads owned by other executives.

## Core Requirements (static)
- Multi-source ingestion: IndiaMART webhook (real RESPONSE-object format), Justdial via Gmail OAuth poll, IndiaMART real-time PNS, Manual.
- Round-robin + manual + PNS + time-slot + auto-reassign (unopened/no-action thresholds).
- Strict RBAC enforced at API boundary (executive read query auto-filtered to assigned leads).
- WhatsApp Business Cloud API: outbound text + templates, inbound + status webhooks, 24-hour window enforcement, real-time message status (✓ / ✓✓ / read).
- Quick replies (admin-managed) — internal canned messages, not WhatsApp templates.
- Follow-ups with overdue/missed escalation.
- Analytics: leads per executive, response time, conversion rate, missed/reassigned counts.
- Runtime config overrides (WhatsApp credentials editable from `/settings`).
- Gmail OAuth flow (server-side, no PKCE) with background poller.

## What's Been Implemented
### Iteration 8 (Feb 2026) — Visual Canvas + Media Nodes
- **Visual Flow Designer** — `/app/frontend/src/pages/ChatFlows.jsx` fully rewritten on `@xyflow/react`. Custom `<FlowNodeCard />` with colour-banded left border per type, icon, body preview, option list, Start flag, source/target handles (one per option for button/list/carousel so edges render per-option).
- **Drag & Drop** — nodes drag freely; positions auto-save 600 ms after drop via `PUT /api/chatflows/{flow_id}/positions`. MiniMap + Controls + `fitView`.
- **Connect-by-drag** — drag from an option's right-edge handle to another node creates an edge, saved via `PUT /chatflows/{flow_id}/nodes/{src}/options` (writes `next_node_id` of the matching option).
- **Node Inspector (right-side panel)** — all fields rebuild per-selected node: name, type, body/header/footer/button_text (text/button/list), media_url/caption/filename (image/video/document), cards editor (carousel), options editor (button/list), start-node checkbox. Save does a combined node PATCH + options PUT.
- **Media Types** — `image`, `video`, `document` nodes now actually send via `wa_send_media` (image+video accept caption, document accepts filename). `send_flow_message` no longer raises ValueError for these.
- **Carousel (pseudo)** — sequential image sends (one per card with title+subtitle caption), followed by a single WhatsApp interactive-button prompt built from the node's `chat_options` so existing webhook routing works unchanged. Max 3 cards enforced. Adding a card auto-adds a matching option with `option_id = card_N`.
- **Media Upload** — `POST /api/chatflows/upload-media` accepts multipart file (50 MB cap), writes to `/app/backend/uploads/<uuid><ext>`, returns `/api/media/<stored_name>` URL. `GET /api/media/{stored_name}` serves the file. Upload button in inspector + per-card. URL field is still editable for admin-hosted CDN URLs.
- **Default x/y stagger** — new nodes land at `80 + col*320, 80 + row*220` instead of piling at (0,0).
- **Build-error contract tightened** — `POST /chatflows/{id}/start` now returns HTTP 400 with `{detail}` for validation failures (missing body, >3 buttons, 0 options, missing media_url) instead of `200 + {error}`.
- **Regression** — 17/17 new tests + 22/22 iter7 regression = 39/39.
- **Files**: `/app/backend/server.py` (send_flow_message, wa_send_media, POST upload-media, GET /media/{name}, stagger in create_chat_node), `/app/frontend/src/pages/ChatFlows.jsx` (full rewrite). `/app/backend/tests/test_iteration8_canvas_media.py`.

### Iteration 7 (May 2026) — Chatbot flow engine (WATI / AiSensy-style)
- **Data model** — `chat_flows`, `chat_nodes`, `chat_options`, `chat_sessions` (phone_key unique).
- **Flow engine** — `send_flow_message(phone, node_id)` reads node + options, renders the right WhatsApp payload (text / interactive-button / interactive-list), sends via the existing WA abstraction (cfg['api_version'] dynamic, never hardcoded), logs to messages with `flow_id` + `flow_node_id`, and upserts the per-user session. Button/list nodes gated by the 24-hour window; text nodes are not.
- **Webhook dispatcher** — `/api/webhooks/whatsapp` now detects interactive replies, looks up the user's session, matches `button_reply.id` / `list_reply.id` against the current node's options, and auto-sends the `next_node_id`. If no session exists but an active flow is configured, the start node's options become the entry point. End-of-flow clears the session.
- **Admin CRUD** — `/api/chatflows`, `/api/chatflows/{id}/nodes`, `/api/chatflows/{id}/nodes/{node_id}/options` (replace semantics), `/api/chatflows/{id}/start` (test-send — returns 400 on build failures), `/api/chat-sessions`. Admin-only. `_build_interactive_payload` enforces max-3-buttons and required body.
- **Frontend admin UI** at `/chatflows` — flows list + create modal, node list per flow, node editor (name, type, header, body, footer, list button text, start toggle, inline options with next-node dropdown), "Send start" test harness. All data-testids exposed for automation. Nested-button hydration warning fixed by switching flow-row to a div with role="button".
- **Sidebar entry** — "Chatbot Flows" nav for admins.
- **Regression safe** — 22/22 new + 37/37 prior backend tests pass.

### Iteration 5 (May 2026) — Duplicate-lead prevention + phone standardization
- **Phone canonicalization** — new helpers `normalize_phone_display` (Indian → bare 10-digit, e.g. `8790934618`; international → `+<digits>`) and `phone_match_pattern` (last-10-digit suffix regex). One-shot startup migration tags each lead with `_phones_canonicalized=true` after rewriting `phone`/`phones`.
- **Cross-source dedup by phone** — `_find_lead_by_phone(phone, exclude_id?)` matches stored canonical phone OR phones[] suffix-aware. Used by `_create_lead_internal` (returns existing instead of creating), `POST /api/leads/{id}/phones` (rejects cross-lead duplicates with structured 409), and `POST /api/inbox/start-chat`.
- **POST /api/leads dedup policy** — admin or same-owner exec receives the existing lead with `duplicate: true, existed: true`. Different-exec ownership returns 409 with `{code: 'duplicate_phone', message, existing_lead_id, owned_by_id, owned_by_name, owned_by_username}`.
- **POST /api/leads/{id}/phones** — same-lead duplicate now returns structured 409 (`code: 'duplicate_phone_same_lead'`); cross-lead duplicate returns the same shape as POST /api/leads with `owned_by_username`.
- **Search robustness** — user `q` is `re.escape`d before injection into Mongo regex (no more 51091 errors when user types `+91`). Phone-aware: 7+ digit queries fall through `phone_match_pattern` so `+918790934618`, `08790934618`, `8790934618` all return the same hits.
- **Critical fix** (caught by testing agent) — duplicate `_find_lead_by_phone` definition lower in the file was shadowing the iter-5 helper. Renamed to `_find_lead_by_phone_legacy`.
- **Admin self-assign** — `/api/users` consumers (NewLeadModal, LeadDrawer reassign, Chat header, Chat NewChatModal) now include admins with an `(admin)` suffix. Round-robin auto-assign STILL excludes admins (`pick_next_executive` filters role=executive).
- **Frontend reassignment CTA** — both NewLeadModal (`/leads`) and NewChatModal (`/chat`) catch the structured 409 and render an inline conflict panel (`duplicate-conflict-panel` / `chat-duplicate-conflict-panel`) with a 'Request Reassignment' button that POSTs to `/api/inbox/transfer-request` (already wired to admin's transfer-requests queue).

### Iteration 4 (May 2026) — Sales operating system upgrades
- **Call activity logging** — new `call_logs` collection with structured outcomes (connected, no_response, rejected, not_reachable, busy, invalid). Endpoints: `POST/GET /api/leads/{id}/calls`, `GET /api/calls` (admin sees all, executive sees own). Connected calls require a conversation summary (400 otherwise). Lead doc carries `last_call_outcome` + `last_call_at` + `/api/leads?last_call_outcome=` filter.
- **Reports** — `/api/reports/overview.per_executive` now exposes 19 metrics per executive: leads, new_leads, contacted, qualified, converted, lost, conversion_rate, avg_response_seconds, calls_total, calls_connected, calls_no_response, calls_not_reachable, calls_rejected, calls_busy, calls_invalid, wa_threads, wa_messages_sent, followup_total, followup_done, followup_pending, followup_completion_pct. Reports UI redesigned with full breakdown table on desktop + card grid on mobile.
- **Lead activity log moved behind an Info button** in the LeadDrawer. New `ActivityPanel` slide-over: admin sees full reassignment trail with from→to enrichment + actor names; executives have system/reassignment events filtered out server-side.
- **Editable customer name + aliases** — `aliases: List[str]` field on lead doc; included in regex search across `/api/leads` and `/api/inbox/conversations`. Pencil-edit UI updates everywhere via single source of truth.
- **Editable requirement** — Edit button + textarea; `requirement_updated_at` timestamp set on save.
- **Per-phone WhatsApp detection** — `wa_status_map` keyed by last-10 digits of each phone, set on every outbound (true on success, false on Meta error 131026/470/100), and on every inbound. UI shows green WA / grey NO-WA / `?` per phone.
- **Active-WA-phone selector** — `PUT /api/leads/{id}/active-wa-phone` validates the phone is on the lead (suffix match), persists `active_wa_phone`. WA send routes to `active_wa_phone || phone`. UI: 'Use for WA' button next to each non-active phone.
- **Follow-up alarm** — global `FollowupAlerts` mounted in AppShell. Polls `/api/followups?status=pending` every 30s; when a follow-up is due within ±90s and not snoozed, plays a 6-second WebAudio two-tone alarm and shows a Mark-Done / Snooze-30-min modal. `/api/followups` enriched with `lead_customer_name` + `lead_phone` so the modal needs zero extra calls.

### Iteration 3 (Apr 2026) — Mobile-first responsiveness
- **Sidebar drawer** — desktop persistent (`md+`), mobile hidden by default; hamburger button in header opens sidebar as fixed overlay with backdrop, X close button, auto-close on route change, body-scroll lock while open.
- **Header** — compact on mobile (`p-4`) with hamburger, larger on desktop (`p-8`).
- **Pages** — all admin pages dropped to `p-4 md:p-8`, H1 down-scaled to `text-2xl md:text-4xl`, modal grids stack 1-col on mobile.
- **Tables → cards on mobile**: `/leads` and `/users` render proper card lists below `md`, full table at `md+`. No horizontal scroll on mobile.
- **Dashboard** — Per-Executive table hides Avg-Response and Status columns on mobile (key metrics only).
- **Lead drawer** — H2 down-scaled, header padding reduced; existing `grid-cols-1 lg:grid-cols-5` already stacks correctly on mobile.
- **Chat info-panel** — slides over the thread on mobile (`fixed inset-y-0 right-0 w-full sm:w-[360px]`), side-by-side at `lg+` (`w-[300px]`).
- **Chat container** — switched from `h-[calc(100vh-57px)]` to `h-full` so the parent flex container handles height, eliminating overflow when header height changes.

### Iteration 2 (Feb 2026) — Strict fixes + feature upgrades
- WhatsApp inbound webhook hardened. Added admin-only `/api/webhooks/whatsapp/_debug/simulate` that replays a real Meta-shaped payload through the actual handler so the full pipeline (lead lookup/auto-create, message persistence, status updates, has_whatsapp flip, /chat sync) is verifiable without Meta. `/api/webhooks/whatsapp/_debug/recent` lets admin inspect raw recent payloads.
- New `has_whatsapp` boolean on every lead. Set true on (a) successful outbound send, (b) any inbound webhook message, (c) /api/inbox/start-chat creation, (d) `auto_send_whatsapp_on_create` success.
- `/api/inbox/conversations` now FILTERS to WhatsApp-active leads only by default (has_whatsapp=true OR at least one message). Pass `include_all=true` to bypass. Each row now also carries `requirement`, `notes`, `has_whatsapp`.
- `/chat` UI: chat list rows show phone under customer name. Chat thread header has inline status dropdown + admin-only Assigned-to dropdown + phone display + 24h-window flag. Info icon toggles a right-side `lead-info-panel` showing requirement, source, status, location, notes list, and an Add-note textarea+button.
- Receiver-numbers feature for IndiaMART PNS / call-tracked leads. Each user (admin or executive) can have multiple `receiver_numbers`. New endpoints: `PUT /api/users/{id}/receiver-numbers`, `GET /api/settings/receiver-routing`. Same number cannot belong to multiple users (409 conflict). IndiaMART webhook now matches `RECEIVER_MOBILE` against `_find_user_for_receiver` (last-10-digit suffix match across +91/91/0). Auto-round-robin still EXCLUDES admins (`pick_next_executive` filters role=executive); admin can still be assigned manually.
- `/settings` has a new admin section: **Call Routing / Receiver Numbers** with per-user add/remove and conflict messaging.

### Backend
- JWT auth with username + role gate (admin / executive). bcrypt hashing.
- Users CRUD with working_hours; admin seed + 2 test executives.
- Leads CRUD with role isolation, multi-phone (`phone` primary + `phones[]`), notes, reassign, activity log, `opened_at` + `last_action_at` + `last_user_message_at`.
- Assignment engine (deterministic round-robin, working-hours filter, PNS receiver-mobile match).
- IndiaMART webhook (`RESPONSE` object/array/flat, `QUERY_TYPE` mapping, returns `CODE/STATUS/SUCCESS`).
- Gmail OAuth (server-side authorization_code, no PKCE), token refresh, background poller every 2 min.
- Justdial parser: HTML-first, `<strong>`-based name extraction, requirement clipping, IST-aware `created_at` from email timestamp.
- WhatsApp Cloud API: real outbound text + template send, webhook verify (Meta hub.verify_token), inbound parser handling text/image/document/audio/video/location/button/interactive, status updates (sent/delivered/read/failed) keyed by wamid, auto-creation of leads from inbound messages, 24-hour window enforcement on free-text sends.
- WhatsApp template list + sync from Meta WABA.
- Runtime WhatsApp config: `system_settings` collection overrides `.env` defaults; admin GET/PUT `/api/settings/whatsapp` with masked tokens, eye/reveal toggles, per-field clear.
- Inbox endpoint `/api/inbox/conversations` with last-message aggregation, unread counts, 24-hour flag, unreplied detection, admin filters (agent/status/unread/unreplied).
- `/api/inbox/start-chat` (find-by-phone-suffix or create), `/api/inbox/leads/{id}/mark-read`, transfer-request flow with admin approve/reject.
- Quick replies CRUD (admin manages, all users list).
- `/api/settings/webhooks-info` — single endpoint exposing all webhook URLs to paste into IndiaMART, Meta, Google.
- APScheduler jobs: auto-reassign every 60s, Gmail poll every 2 min.
- Phone add/remove endpoints with auto-promotion of next alt when primary is removed.

### Frontend
- Login, role-gated routes (`AdminOnly`).
- Dashboard with role-specific widgets, 14-day timeseries, status/source charts, executive table.
- Leads page: table + kanban toggle, filters (status/source/assignee/search), `New Lead` modal with auto-assign, IndiaMART query-type badges, lead drawer with full activity timeline.
- Lead drawer: notes, follow-up scheduler, WhatsApp panel, IndiaMART details section, multi-phone manager, role-aware controls, IST timestamps.
- **WhatsApp page (`/chat`)** — WhatsApp Web–style:
  - Left rail: filter chips (Unread, Not replied, Status, Agent for admin), search, conversation list with avatar, last-message preview, ✓/✓✓/read ticks, unread badge, 24h-open flag.
  - Right thread: green WhatsApp-Web-style background, message bubbles with delivery ticks + send status + IST time, auto-scroll, mark-read on open.
  - Composer: free-text disabled outside 24h window with clear CTA; Quick Replies dropdown (lightning bolt); Templates dropdown with approved status from Meta sync.
  - "Start new chat by phone" modal — finds existing or creates new lead, executive auto-assigns to self, admin can pick.
  - Transfer-request flow inline when executive opens a lead they don't own.
  - 4-second polling for near real-time sync across `/chat` + `/leads` + drawers.
- Quick Replies admin page — CRUD with `{{name}}` substitution.
- Settings page — WhatsApp config (masked tokens, eye toggles, per-field override + clear) + Webhooks panel with copy buttons for IndiaMART, WhatsApp, Gmail OAuth, Justdial ingest URLs.
- Integrations page — Gmail connect/disconnect/sync-now with poll stats.
- Reports — bar/line/pie charts with executive performance breakdown.
- Sidebar — role-gated nav: Dashboard, WhatsApp, Leads, Follow-ups, Executives, Routing, Integrations, WA Templates, Quick Replies, Settings, Reports.

## Backlog — P0 (next)
- Mobile slide-nav refinement on `/chat` (currently stack-based; works but not fully WhatsApp-mobile feeling).
- Drag-and-drop on Kanban board to change status.
- IndiaMART webhook HMAC signing if Meta releases one (currently public).
## Backlog — P1
- WebSockets replacing the 4-second poll for sub-second sync.
- Bulk lead actions (bulk reassign, bulk status).
- CSV export from `/reports`.
- In-app notification bell for newly assigned leads.
- Brute-force lockout on login.

## Backlog — P2
- Modularize `server.py` into routers (`auth.py`, `leads.py`, `webhooks.py`, etc.).
- Multi-tenant Gmail (multiple admin accounts).
- Puppeteer-based optional Justdial contact auto-fetch.
