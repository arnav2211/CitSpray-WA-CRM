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
### Iteration 13 (Feb 2026) — ExportersIndia API-key auth
- **`POST /api/webhooks/exportersindia?key=…`** now enforces the configured API key. If no key is configured → webhook stays public (dev-friendly). If configured → any request missing the key or with a wrong key returns HTTP 401.
- **`GET /api/settings/exportersindia`** (admin) returns `{api_key_masked, has_key, webhook_url, full_integration_url}` — last field is ready-to-paste with `?key=…` appended.
- **`PUT /api/settings/exportersindia {api_key}`** (admin) persists the key to `system_settings` collection (or clears it with empty string). Env-var `EXPORTERSINDIA_API_KEY` also supported as fallback.
- **`_get_exportersindia_api_key()`** — DB override > env. Cached per request (no extra mongo call needed as reads are cheap and infrequent).
- **UI** — new "ExportersIndia API key" panel on `/settings`: masked display, paste field with eye toggle, Save/Clear buttons, and a green highlighted box showing the full integration URL with a Copy button once a key is set. `/settings/webhooks-info` also returns `full_integration_url` so the Webhooks panel stamps the URL with `?key=…` automatically.
- **Verified**: wrong key → 401, no key → 401, correct key → 200; UI panel renders key as `bDE1QT…Zz09 (32 chars)` and shows the full ready-to-paste URL.
- **Tested**: 39/39 iter7+iter8 regression green.

### Iteration 12 (Feb 2026) — ExportersIndia integration + enquiry_type badge
- **New public webhook** `POST /api/webhooks/exportersindia` (+ per-tenant `/exportersindia/{identifier}`) — parses ExportersIndia's enquiry JSON (fields `inq_id`, `supplier_id`, `inq_type`, `product`, `subject`, `detail_req`, `mobile`, `email`, `name`, `company`, `address`, `country`, `state`, `city`, `enq_date`). Requirement defaults to `detail_req` → `subject` → `product`. Dedup via `_lead_dedup_hash(name, enq_date, inq_id)` plus phone-based cross-source merge. Debug endpoint `GET /api/webhooks/exportersindia/_debug/recent` for admins.
- **`Lead.enquiry_type` + `Lead.country`** — added to `LeadCreate`/`LeadUpdate` Pydantic models and persisted by `_create_lead_internal`. IndiaMART parser also now captures `QUERY_TYPE`/`INQUIRY_TYPE` into the same `enquiry_type` field for uniformity.
- **`EnquiryTypeBadge` component** — unified badge renderer that accepts free-text (`direct` / `buyleads` / `inquiry` / `catalog` → colour-coded) and falls back to IndiaMART's `QUERY_TYPE` single-char code via the existing `QueryTypeBadge`. Replaces all three usages in `Leads.jsx`.
- **UI touch-ups** — `Leads.jsx` source filter now includes "ExportersIndia" (pink `#BE185D` border); location column shows `area, city, state, country`; LeadDrawer header pin also renders country. Settings → Webhooks panel lists the new ExportersIndia URL with copy-paste instructions + sample payload.
- **Verified end-to-end** — posting the user's exact sample JSON creates a lead with `source=ExportersIndia`, `enquiry_type=direct`, `country=India`; dedup on re-post returns the same UUID; `source_data` retains the full original payload.
- **Tested**: 39/39 iter7+iter8 regression green.

### Iteration 11 (Feb 2026) — WhatsApp Reactions (send + receive)
- **`wa_send_reaction(to, message_wamid, emoji)`** — thin helper via `_wa_send_typed`. Empty emoji (`""`) clears the reaction per WA spec.
- **`POST /api/whatsapp/react {message_id, emoji}`** — admin/exec endpoint. Resolves local UUID → target's Meta wamid, calls Meta, and upserts one reaction entry per `(direction="out", user_id)` on the target message's `reactions` array. Enforces RBAC (same lead-ownership rules), 24h window, and 404 for invalid target.
- **Inbound webhook — `type: reaction`** — parser now handles reaction messages: does NOT create a bubble, instead finds the target message by `wamid + lead_id` and upserts one entry per `(direction="in", from_phone)`. Empty emoji removes the customer's reaction. Unknown target wamid is logged & skipped (never crashes the webhook).
- **Chat UI (`Chat.jsx`)** — `Bubble` now aggregates `m.reactions[]` into `{emoji: {count, mine}}` and renders tiny white pills (WhatsApp-style) anchored to the bubble's bottom. On hover, a small 😊 button next to the reply arrow opens a 6-emoji quick picker (👍 ❤️ 😂 😮 😢 🙏) with an X to close. Clicking your own reaction pill clears it. Pill has green border if it's yours, grey otherwise; count shown only when ≥2 reactions on the same emoji.
- **Currently-user awareness** — `currentUserId` flows from parent to highlight "mine" reactions correctly.
- **Verified live against +917447717744** — 8/8 scenarios: react 👍, change to ❤️, verify single entry (not dupe), remove (empty string), inbound reaction 🔥 stored, inbound change to 👏 overwrites, inbound empty clears, 404 for invalid target. All sends returned real Meta wamids.
- **Tested**: 39/39 iter7+iter8 regression green + 8/8 reaction scenarios.

### Iteration 10 (Feb 2026) — Media transcoding + preview/download (prod-ready media pipeline)
- **Root cause fix for "audio/video not playable"** — Browser `MediaRecorder` outputs `audio/webm;codecs=opus` which WhatsApp does NOT accept (spec allows: audio/ogg-opus, audio/aac, audio/mp4 m4a, audio/mpeg mp3, audio/amr). Similarly quicktime (.mov) video isn't in WA's whitelist (only mp4 / 3gp). Meta was happily accepting our sends (returning wamids) but the recipient's device could not decode → appeared as "not sent".
- **Backend transcoder (ffmpeg)** — `POST /api/chatflows/upload-media` now invokes ffmpeg when needed: `_prepare_audio_for_whatsapp` remuxes opus-in-webm to opus-in-ogg (preferred, no quality loss) with a libmp3lame fallback; `_prepare_video_for_whatsapp` transcodes any non-mp4/3gp to H.264/AAC mp4 with `+faststart` (uses temp input+output files because MP4 mux needs seekable output); `_prepare_image_for_whatsapp` converts webp/heic/gif to jpeg. Response now includes `mime_type` and `transcoded: bool`.
- **`media_files` collection** — every uploaded/downloaded file gets a DB row (stored_name, original_filename, mime_type, size, kind, uploaded_by, uploaded_at). Inbound webhook media also creates rows and overrides original_filename when Meta provides one for documents.
- **`GET /api/media/{stored_name}`** — enhanced to: (a) set accurate `Content-Type` from stored mime, (b) set `Content-Disposition: inline` for previews (default), (c) `?download=1` switches to `attachment; filename="original.ext"` so browser "Save As" preserves the original filename, (d) `Cache-Control: public, max-age=86400` for CDN caching.
- **Frontend (`Chat.jsx`)**:
  - `<Lightbox />` component (mounted globally) — full-screen image preview triggered by clicking any image bubble, with a top-right Download button + X (or Esc) to close.
  - Every media bubble (image/video/document/audio) now has a `DownloadSimple` icon that downloads the file with the original filename via `?download=1`.
  - Image bubbles render with `cursor-zoom-in` and open the lightbox instead of a new tab.
  - Video/audio still use native HTML5 `<video>`/`<audio>` controls (play/pause/seek/volume all built-in).
- **File size validation** — client 50 MB hard-block + server 50 MB hard-block with HTTP 413.
- **Verified against live Meta** — `+917447717744` received both transcoded mp4 video (30 KB mov → 42 KB mp4) and ogg/opus voice note (19 KB webm → 18 KB ogg) with real wamids.
- **Tested**: 39/39 iter7+iter8 regression green.

### Iteration 9 (Feb 2026) — Full rich-message support (audio, location, contact, resend)
- **Backend helpers** — new `wa_send_audio`, `wa_send_location`, `wa_send_contacts` (all routed through `_wa_send_typed` so they automatically get `context.message_id` reply support, 24h-window gating, mock-mode fallback, status tracking).
- **New composer endpoints** (all admin+exec with lead-assignment RBAC, 24h window enforcement, reply_to_message_id support, status+error persisted):
  - `POST /api/whatsapp/send-media` — image/video/document/audio. Pair with `POST /api/chatflows/upload-media` for file uploads (now accepts `kind=audio`); the returned absolute URL is fed back in.
  - `POST /api/whatsapp/send-location` — latitude/longitude with optional name & address.
  - `POST /api/whatsapp/send-contact` — formatted_name, phones[], emails[], organization → Meta's `contacts[]` payload.
  - `POST /api/whatsapp/resend` — re-send a previously `failed` outbound message; preserves media_type/caption/filename/location/contacts and reply context.
- **Inbound webhook** — now parses `audio` (distinguishes voice notes), `location` (stored as `location: {latitude, longitude, name, address}`), `contacts` (full Meta contacts array), and downloads audio media via the existing `_download_wa_media` helper (mime map extended to cover opus/mp3/m4a/amr/aac/webm).
- **Chat UI** — Paperclip attach button opens a menu: Photo / Video / Document / Audio file / Record voice note / Location / Contact. Voice recording uses browser `MediaRecorder` (opus/webm → server as file upload → send-media). Bubbles render `<audio controls>` for audio, an embedded Google Maps iframe + "Open →" for locations, and WhatsApp-style contact cards with clickable phone/email. `↻ Resend` button appears on any failed outbound bubble.
- **File size validation** — client-side 50 MB cap + backend 50 MB cap on upload. Quoted preview UI unchanged (still green for "You", blue for "Customer").
- **Not in scope** (WA Cloud API doesn't expose these for business accounts): typing indicators, user presence, last-seen.
- **Tested**: 39/39 iter7+iter8 regression green; `/tmp/test_rich.py` covers image / audio upload+send / location / contact / reply-with-media / resend / inbound audio+location+contacts parsing.

### Iteration 8 (Feb 2026) — Visual Canvas + Media Nodes + Inbound download + Templates + Quoted Replies
- **Visual Flow Designer** — `/app/frontend/src/pages/ChatFlows.jsx` fully rewritten on `@xyflow/react`. Custom `<FlowNodeCard />` with colour-banded left border per type, icon, body preview, option list, Start flag, source/target handles (one per option for button/list/carousel so edges render per-option).
- **Inbound media download-and-serve** — `_download_wa_media(media_id, mime_hint, request)` does Meta's 2-step flow (GET `/{api_version}/{media_id}` → `{url}` → download blob with Bearer). Saves to `/app/backend/uploads/<uuid><ext>` (mime → ext map covers jpg/png/webp/mp4/pdf/…), returns absolute public URL. Webhook now attaches `media_url`, `media_stored_name`, `mime_type` to inbound image/video/document messages. Fails silently in mock mode or on 4xx.
- **Flow Templates Gallery** — 4 built-in templates (Lead Qualification, After-hours autoresponder, Feedback Survey CSAT, Product Catalog List). `GET /api/chatflows/templates` lists them (admin only), `POST /api/chatflows/import-template {template_id, name?, is_active?}` materialises the full graph with resolved `next_node_id` refs, returns the hydrated flow. Frontend shows a new "Templates" button on `/chatflows` header → modal gallery with category badges, node count, type chips, "Use this template" CTA.
- **Quoted Replies** — all send helpers (`wa_send_text`, `wa_send_interactive`, `wa_send_media`, shared `_wa_send_typed`) accept an optional `reply_to_wamid` which injects `context: {message_id}` into Meta's payload. `POST /whatsapp/send` now accepts `reply_to_message_id` (local uuid of a message on the SAME lead); backend resolves it to the Meta wamid and preview text and persists `reply_to_message_id`, `reply_to_wamid`, `reply_to_preview` on the outbound doc. On Meta error codes 131009 / 100 / 131026 (invalid/stale context) the send retries once without context — per spec fallback. Inbound webhook captures the customer's `context.id` too, so inbound replies also get `reply_to_wamid` + `reply_to_preview` by matching against our own outbound messages. Chat bubble (`Chat.jsx` `Bubble`) renders a green-bordered quoted-preview block above the body and shows a "↩ Reply" button on hover; clicking opens a reply-preview banner above the composer with an X to cancel. Cross-lead / unknown reply_to_message_id is silently discarded.
- **Drag & Drop** — nodes drag freely; positions auto-save 600 ms after drop via `PUT /api/chatflows/{flow_id}/positions`. MiniMap + Controls + `fitView`.
- **Connect-by-drag** — drag from an option's right-edge handle to another node creates an edge, saved via `PUT /chatflows/{flow_id}/nodes/{src}/options` (writes `next_node_id` of the matching option).
- **Node Inspector (right-side panel)** — all fields rebuild per-selected node: name, type, body/header/footer/button_text (text/button/list), media_url/caption/filename (image/video/document), cards editor (carousel), options editor (button/list), start-node checkbox. Save does a combined node PATCH + options PUT.
- **Media Types** — `image`, `video`, `document` nodes now actually send via `wa_send_media` (image+video accept caption, document accepts filename). `send_flow_message` no longer raises ValueError for these.
- **Carousel (pseudo)** — sequential image sends (one per card with title+subtitle caption, no strip), followed by a single WhatsApp interactive-button prompt built from the node's `chat_options` so existing webhook routing works unchanged. Max 3 cards enforced. Adding a card auto-adds a matching option with `option_id = card_N`.
- **Media Upload** — `POST /api/chatflows/upload-media` accepts multipart file (50 MB cap), writes to `/app/backend/uploads/<uuid><ext>`, returns **absolute** `https://<host>/api/media/<stored_name>` URL (reads X-Forwarded-Host / Proto, falls back to `PUBLIC_BASE_URL` env). `GET /api/media/{stored_name}` serves the file publicly (no auth) so Meta can fetch.
- **Default x/y stagger** — new nodes land at `80 + col*320, 80 + row*220` instead of piling at (0,0).
- **Build-error contract tightened** — `POST /chatflows/{id}/start` now returns HTTP 400 with `{detail}` for validation failures (missing body, >3 buttons, 0 options, missing media_url) instead of `200 + {error}`.
- **Caption formatting fix** — caption input switched from `<input>` (which strips newlines) to `<textarea>` with `whitespace-pre-wrap`. Backend passes caption/body unchanged (no strip) so `\n` and `*bold*` / `_italic_` / `~strike~` markdown render on WhatsApp. Carousel subtitle is also a textarea.
- **Media rendering** — outbound flow messages now persist `media_type`, `media_url`, `caption`, `filename` on the message doc. Inbound webhook also captures `media_type`, `media_id`, `caption`, `filename`. Chat bubble (`Chat.jsx` `Bubble`) renders inline `<img>` / `<video>` / document card for outbound; placeholder with icon for inbound (no download-and-serve yet). Flow inspector renders actual image/video/document preview, not just the URL link. Carousel cards inspector shows image thumbnails.
- **Regression** — 17/17 new tests + 22/22 iter7 regression = 39/39.
- **Files**: `/app/backend/server.py` (send_flow_message, wa_send_media, POST upload-media with absolute URL, GET /media/{name}, stagger in create_chat_node, inbound media metadata), `/app/frontend/src/pages/ChatFlows.jsx` (full rewrite + media previews + textarea captions), `/app/frontend/src/pages/Chat.jsx` (Bubble + renderMedia). `/app/backend/tests/test_iteration8_canvas_media.py`.

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
