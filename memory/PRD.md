# LeadOrbit CRM — PRD

## Original Problem Statement
Production-ready CRM + Lead Management + WhatsApp Automation for a sales team. Multi-source lead import (IndiaMART webhook + Justdial email parsing), intelligent assignment (round-robin + manual override + time-slot routing + auto-reassign), WhatsApp Business API with templates and conversation history, follow-ups/reminders, strict RBAC (admin vs executive), analytics.

## Stack (actual)
FastAPI + MongoDB (motor) + React 19 + JWT + APScheduler. Swiss / High-Contrast design system (Chivo + IBM Plex Sans, Klein blue #002FA7, sharp-edge flat components).

## User Personas
- **Admin**: owns routing rules, manages executives, reassigns anywhere, sees full pipeline and reports.
- **Executive**: sees ONLY their own assigned leads, updates status, sends WhatsApp (mock), adds notes, schedules follow-ups.

## Core Requirements (static)
- Multi-source lead ingestion: IndiaMART webhook + Justdial email parser (HTML + text).
- Round-robin + manual + PNS (CALL_RECEIVER_NUMBER match) + time-slot routing.
- Auto-reassign if unopened within X minutes or no-action within Y minutes.
- Role-based access: executive isolation enforced at API level.
- WhatsApp: auto welcome on lead create, manual send, templates, conversation log, webhook verify + inbound (mock).
- Follow-ups with overdue/missed escalation.
- Reports: total leads, conversion rate, per-executive performance (leads, converted, avg response), 14-day timeseries, by status, by source.

## What's Been Implemented — v1 (2026-04-18)
### Backend
- JWT auth (username-based) with httpOnly cookie + Bearer header fallback (`/api/auth/login`, `/me`, `/logout`).
- Users CRUD with working_hours (admin-only create/edit/delete).
- Leads CRUD with role isolation, notes, reassign, activity log, `opened_at` tracking.
- Assignment engine (deterministic round-robin with working-hours filter, PNS matching).
- IndiaMART webhook `/api/webhooks/indiamart` (handles flat + RESPONSE[] arrays).
- Justdial ingest `/api/ingest/justdial` (regex + BeautifulSoup, contact_link extraction, dedup by content hash).
- WhatsApp send (mock), templates CRUD, conversation history, Meta-style webhook verify, inbound webhook.
- Follow-ups CRUD, auto-mark missed.
- Routing rules singleton (`/api/routing-rules`).
- Reports `/api/reports/overview` and `/api/reports/my`.
- APScheduler auto-reassign job every 60s.
- Seed: admin + 2 test executives + 2 default WhatsApp templates + routing rules.

### Frontend
- Login page — Swiss split layout with architectural grid background.
- Admin dashboard — stats cards, 14-day line chart, status bar chart, per-executive table, recent leads.
- Executive dashboard — personal KPIs, quick actions.
- Leads page — table + kanban toggle, filters (status/source/assignee/search), new-lead modal, unopened-bold + overdue left-border markers.
- Lead drawer — detail + notes timeline + activity log + follow-up scheduler + dark WhatsApp panel + reassign/status controls + "Open Justdial Lead" button.
- Users page (admin) — list + create/edit modal with working-hours matrix.
- Routing page (admin) — toggles + minute fields + save.
- Templates page (admin) — list/create/delete WA templates.
- Reports page (admin) — line + pie + bar + per-executive horizontal chart + detailed table.
- Follow-ups page — Overdue / Upcoming / Missed / Completed sections.

## Testing
- 28/28 backend pytest tests pass.
- Frontend verified via Playwright: login, role gating, admin/exec isolation, lead drawer, Justdial button, WhatsApp mock panel, logout.

## Backlog — P0 (next)
- Real WhatsApp Business API (Meta Cloud) integration (send + webhook verification signing).
- Gmail API OAuth + pull loop for Justdial (replacing the mock `/api/ingest/justdial` direct endpoint).

## Backlog — P1
- Drag-and-drop on kanban to change status.
- Bulk actions on leads list (multi-select, bulk reassign).
- CSV/Excel export from reports.
- In-app notifications/toast for newly assigned leads (socket or polling).
- Brute-force lockout on login (mentioned in auth playbook).

## Backlog — P2
- Refactor `server.py` into modules (auth, leads, webhooks, reports, assignment).
- HMAC signature validation on public webhooks.
- Leader-election for the auto-reassign scheduler in multi-worker deploys.
- Puppeteer-based Justdial contact auto-fetch (disabled by default — stated as optional in spec).
