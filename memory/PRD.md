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
