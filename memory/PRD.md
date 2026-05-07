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
### Iteration 32 (Feb 2026) — QR ordering + Office location preset
- **Quick Reply ordering** (`server.py` + `QuickReplies.jsx`):
  - Added `sort_order` field on `quick_replies`. New rows get next-highest order on create.
  - `GET /api/quick-replies` now returns sorted by `sort_order` ASC (with title fallback for legacy null values).
  - New `POST /api/quick-replies/reorder` (admin-only) takes `{ids: []}` and persists positional sort_order.
  - Frontend: ↑/↓ arrow buttons (`qr-up-{id}` / `qr-down-{id}`) on each row, with #N rank prefix and media-type badge. Optimistic local reorder + persist; reload on failure.
  - `/chat` Quick Reply dropdown automatically respects this order (it consumes whatever the API returns).
  - **Verified**: reverse-order reorder via curl → list returns in reversed order with `sort_order=1..N`.
- **Office location preset** (`Chat.jsx → LocationSendModal`): added a blue **Office** card at the top of the Send Location modal with admin-supplied static values (CitSpray, Nagpur, lat 21.109974, lng 79.064088). Two buttons:
  - **Send office location** (`loc-send-office-btn`) — fires immediately, bypasses the form.
  - **Pre-fill** (`loc-fill-office-btn`) — populates the form fields so the rep can edit before sending.
  Custom-location form below remains unchanged.

### Iteration 31 (Feb 2026) — Click-to-jump on quoted messages (WhatsApp parity)
- **`Chat.jsx`** — added `jumpToMessage(id)` helper inside the chat thread that finds the bubble via `[data-testid="bubble-${id}"]`, calls `scrollIntoView({block:"center"})` and adds a transient `ring-4 ring-[#FF8800]` flash for 1.4s. Toast on miss.
- **WA-thread quoted preview** (`_BubbleImpl`) is now a `<button>` with `cursor:pointer` + hover/active state; click → `onJumpTo(quoted.id || m.reply_to_message_id)`.
- **Internal Q&A quoted preview** (`InternalChat`) is now a clickable button too — clicks → `onJumpToWa(m.quoted.id)` (the parent's `jumpToMessage`), so clicking the quote in the right panel scrolls the left WA panel to the original message and flashes it. New testid `internal-quoted-{id}`.
- Prop chain: `Chat → DayGroup → Bubble.onJumpTo`; `Chat → InternalChat.onJumpToWa`. `React.memo` comparator updated to include `onJumpTo`.

### Iteration 30 (Feb 2026) — Date filter on /reports (Today / Yesterday / Select Month / Custom)
- **Backend `GET /api/reports/overview`** (`server.py`): added optional `date_from` + `date_to` (YYYY-MM-DD, IST, inclusive). New helper `_parse_ist_range` shared by the leads-list and reports endpoints. Windows ALL counters: total leads, by_status, by_source, conversion_rate, reassigned, per_executive (lead/call/message/followup counts), and the 14-day timeseries (which now ends at `date_to` if supplied). `missed_followups` stays cross-window (it reflects current overdue state). Returns 400 on bad format. `date_from`/`date_to` echoed in response.
- **Frontend `Reports.jsx`** rewrite:
  - Added quick-pick chips: **Today** (default), **Yesterday**, **Select Month** (with `<input type="month">` picker), **Custom** (two date inputs).
  - Custom mode allows any `date_from`/`date_to` IST range; editing either input from a preset auto-switches mode to Custom.
  - All test IDs: `reports-date-filter`, `reports-preset-today/yesterday/month/custom`, `reports-month-input`, `reports-date-from`, `reports-date-to`.
- **Verified**: backend smoke — all-time total=613, single day 2026-05-06 → 3 leads, full month 2026-05 → 349 leads, bad date → 400.

### Iteration 29 (Feb 2026) — Date filter on /leads
- **Backend `GET /api/leads`** (`server.py`): added optional `date_from` + `date_to` query params (YYYY-MM-DD, inclusive). Both interpreted in **IST (Asia/Kolkata)**: `date_from` snaps to 00:00:00 IST start, `date_to` snaps to 23:59:59 IST end, both converted to UTC for the Mongo `created_at` range. 400 on bad format. Backwards-compatible with all existing callers.
- **Frontend `Leads.jsx`**: added two `<input type="date">` controls (testids `leads-date-from`, `leads-date-to`) inside `leads-date-filter` group, with clear (×) button (`leads-date-clear`) when either is set. State synced to URL params (`date_from`, `date_to`) so date-filtered URLs are bookmarkable. `min`/`max` mutual constraints prevent invalid ranges. Single-date selection = same value in both inputs.
- **Verified**: backend curl smoke (total=349 with `date_from=2026-05-01`, total=0 with `2026-04-18..2026-04-18` because data is on Apr 19 IST; 400 on `2026/02/01`).

### Iteration 28 (Feb 2026) — Configurable Gmail/Justdial poll interval (default 60s)
- **Backend** (`server.py`): poll default reduced from 120s (2 min) → **60s** via new `GMAIL_POLL_DEFAULT_SECONDS` env var. Added `_get_gmail_poll_seconds()` (DB override over default) + `_reschedule_gmail_poll()` (live job swap, mirrors `_reschedule_exportersindia_pull`). New `GET /api/settings/gmail-poll` and `PUT /api/settings/gmail-poll` (admin-only, min 10s). `gmail_status` endpoint now returns `poll_interval_seconds` (and computed `poll_interval_minutes` for back-compat).
- **Frontend** (`Integrations.jsx`): replaced "every X minute(s)" copy with "every Xs". Added `PollIntervalEditor` widget under the description: shows current interval, "Change" button reveals a numeric input + Save/Cancel. Saves via `PUT /api/settings/gmail-poll` and reloads status; min validation enforced client-side too.
- **Verified end-to-end**: GET returns `interval_seconds=60, default=60, is_override=false`; PUT 45 → status reflects `poll_interval_seconds=45`; reset to 60. Scheduler reschedules immediately without restart.

### Iteration 27 (Feb 2026) — Justdial dedup bug fix (preserve query string in profile URL)
- **Root cause**: `_normalize_justdial_link` was stripping the query string from JD `contact_link` URLs. Real Justdial URLs all share the same path (`https://fapp1.justdial.com/CTIMEQM`) and differ ONLY in their `?id=…&fl=…` query — which encodes the unique enquiry token. Previous normalization collapsed every distinct enquiry to a single key, falsely dedup'ing them all to one lead.
- **Fix** (`server.py`): keep the query string; only normalize host casing, drop fragment, strip trailing slash on path. Verified via curl: 3 ingest scenarios — different `?id=` → new lead, same exact URL → dedup with `dedup_reason='justdial_profile_url'`.
- **Backfill**: 178 existing Justdial leads with `contact_link` had `justdial_profile_url=null` (predated the dedup field). One-shot script populated `justdial_profile_url` for all of them so future re-arrival of the same JD email reliably hits the same lead. Only 1 collision found post-backfill (acceptable — likely a genuine prior duplicate).
- **Side observation**: primary Gmail slot was reporting `not_connected` — user needs to reconnect citronellaoilnagpur@gmail.com from `/integrations` to resume Justdial email ingestion. Secondary (citspray@gmail.com) connected but had 0 unread JD mails.

### Iteration 26 (Feb 2026) — Email Auto-Send: HTML body support + preview
- **Backend HTML auto-detect** (`server.py`): `_looks_like_html()` heuristic + `_html_to_plain()` BeautifulSoup-based plain-text extractor. `_smtp_send_blocking` now sets HTML bodies as multipart/alternative — `text/plain` (auto-stripped fallback) + `text/html` (the original markup). Plain-text bodies still send as text/plain only. Variable substitution (`{{name}}` etc.) works inside HTML markup unchanged.
- **Frontend Settings preview pane** (`Settings.jsx → EmailAutoSendPanel`): added `Edit | Preview` tab toggle next to the Body label. Preview renders the substituted (sample-value) body inside a sandboxed `<iframe srcDoc>` for HTML, or a `<pre>`-style block for plain text. Auto-detects HTML using the same heuristic as the backend so the user knows whether it'll send as HTML. Sample vars: name=Akash, requirement=Pumps, phone=+91 99999 00001, email=akash@example.com, source=Manual.
- **Verified live**: PUT template with `<html>…<h2>Hello {{name}}</h2>…<strong>{{requirement}}</strong>…</html>` → POST /api/settings/email/test-send → SMTP delivered to aroma@citspray.com with substituted values (`<h2>Hello Test User</h2><strong>Sample requirement</strong>`).

### Iteration 25 (Feb 2026) — Email Auto-Send (SMTP + template + per-lead emails[])
- **SMTP config** in `system_settings.email_smtp`: host (default smtp.hostinger.com) / port (465) / security (ssl|tls|none) / email / password (masked + eye-toggle in UI) / from_name / enabled. Blank password keeps existing; empty string clears.
- **Email template** in `system_settings.email_template`: subject + body + attachments[] (uploaded via existing `/chatflows/upload-media`).
- **Variable substitution** (`_render_email_var`): `{{name}}`, `{{requirement}}`, `{{phone}}`, `{{email}}`, `{{source}}` in subject AND body.
- **Per-lead `emails[]` array** + `email_sent_to[]` dedup tracker. Endpoints: `POST /api/leads/{id}/emails` (RBAC: admin or assigned-exec; 409 on duplicate; first email becomes primary, subsequent go to emails[]; auto-fires SMTP for the new address). `DELETE /api/leads/{id}/emails?email=X` (auto-promotes next email[] to primary if removing the primary).
- **Auto-send triggers** (`auto_send_email_on_create` + `auto_send_email_to_address`): fires on `_create_lead_internal` AND on add-email endpoint. Idempotent — each address mailed at most once per lead (refreshes `email_sent_to` from DB before sending). Best-effort — failures are logged in `email_send_logs` but never block lead creation.
- **Test send** endpoint `POST /api/settings/email/test-send` — admin only, fakes a lead with sample values, fires the SMTP path, returns 502 with detail on failure.
- **Live verified** against `smtp.hostinger.com:465 SSL` with `aroma@citspray.com` — test-send returned `{ok: true}`. Lead create with email auto-populated `lead.email_sent_to` and `last_email_sent_at`.
- **Frontend `Settings.jsx` → `EmailAutoSendPanel`** — full SMTP form (host/port/security/email/from_name/password with eye toggle/enabled), template form (subject + body + attachment uploader with remove), Test send. All `data-testid`'d.
- **Frontend `LeadDrawer.jsx` → `EmailsRow`** — primary email + emails[] rendered as pills with mailto: links, "Mailed" green badge for addresses in `email_sent_to`, Add/Remove inline. Removed the simple `email` line from the lead header (replaced by this row).
- **Tested**: 15/15 pytest backend + 100% frontend Playwright assertions (iter15 testing-agent run).

### Iteration 24 (Feb 2026) — Manual lead creator owns the lead
- **`POST /api/leads`** (`server.py` ~L1602): when an executive creates a lead manually, force-assign it to themselves (overrides any `assigned_to` payload value, skips round-robin). Admins are unaffected — they can still pass an explicit assignee or let `_create_lead_internal` route via round-robin / buyleads rules. Verified via curl: exec→self (match), exec sneaking `assigned_to=other`→still self, admin→round-robin still picks an agent.

### Iteration 23 (Feb 2026) — 7-feature batch (Justdial URL dedup + Delete + sort + replied filter + composer + mobile UX)
- **Justdial profile-URL dedup** (`server.py`):
  - New helper `_normalize_justdial_link(url)` lowercases scheme+host, strips query/fragment/trailing slash → stable key across `?ref=…` variants.
  - `_find_lead_by_justdial_link(url)` looks up `db.leads.justdial_profile_url`.
  - Both `/api/ingest/justdial` (manual) AND `_gmail_poll_one_slot` (Gmail poll) check the URL before creating a new lead. Match → return existing lead with `{duplicate: true, dedup_reason: 'justdial_profile_url'}`, log activity `justdial_duplicate_profile_url`, mark email as processed/duplicate. New leads persist `justdial_profile_url` (added to the canonical lead schema in `_create_lead_internal`). Indexed.
- **Admin DELETE /api/leads/{id}**: cascade-deletes messages, internal_messages, followups, call_logs, activity_logs, transfer_requests; nulls `email_logs.lead_id` (preserves audit trail). Returns counter dict. RBAC: 403 for executive, 404 for missing id, idempotent.
- **/chat sort by full ISO datetime DESC** (`Chat.jsx`): client-side sort of `convs` by `last_message.at || last_in_at || last_out_at || last_action_at` DESC using `localeCompare`. ISO-8601 sorts chronologically.
- **`only_replied` filter** (backend) + **"Replied" chip** (`filter-replied`) in /chat sidebar — gates on `last_in_at` truthiness; admin/exec parity with existing filters.
- **Auto-expanding composer** — `Chat.jsx` adds `inputRef` + `useEffect([draft])` that grows the textarea height to `scrollHeight` capped at 144px; beyond that internal scroll engages. WhatsApp-Web parity.
- **Mobile keyboard behavior** — `isMobile` useMemo (touch + viewport ≤767px) controls textarea `onKeyDown`: desktop Enter sends, mobile Enter inserts newline. Send button (`chat-send-btn`) submits in both modes. `data-mobile="1|0"` exposed on the input for tests.
- **Mobile back button** (`Chat.jsx`) — `isMobilePage` + `useEffect([activeId])` push a synthetic history entry whenever a chat opens; `popstate` listener sets `activeId=null`. Result: phone Back closes the thread and restores the chat list inside `/chat` instead of bouncing to `/dashboard`.
- **Admin Delete Lead UI** (`LeadDrawer.jsx`) — `lead-delete-btn` red-bordered button in the action bar, admin-only. Two `window.confirm` prompts in sequence (full disclosure of cascade scope on 1st, final-warning on 2nd) before firing `DELETE /api/leads/{id}`.
- **Tested**: 14/14 pytest backend + 23/23 Playwright (13 desktop + 10 mobile) green. iter12 + iter13 regression preserved.

### Iteration 22 (Feb 2026) — Tap-to-call on mobile lead drawer
- **`PhonesRow` (`LeadDrawer.jsx`)** — phone number text in each phone chip is now an `<a href="tel:{digits}">` anchor with `data-testid="call-phone-{phone}"`. Stopping propagation so tapping the number doesn't fall through to the row click handler. Spaces are stripped from the href so iOS/Android dialers handle `+91 98765 43210` cleanly. Hover/active state colors the link `#002FA7` with underline. WA button, Use-for-WA, Active badge, and Remove buttons remain unchanged.
- Works on desktop too (no-op or OS phone handler), but primary use case is mobile where tapping a number opens the dialer.

### Iteration 21 (Feb 2026) — Quick Reply UX in /chat + Lead Assignment History UI + Transfer Requests E2E
- **`/chat` Quick Reply dropdown rewrite (`Chat.jsx`)**:
  - Added `qr-search-input` autoFocus search box at top of dropdown (`qr-dropdown`); filters by title/text/caption/media_filename (case-insensitive).
  - Each row now shows a **1-line truncated preview** (`qr-preview-{id}`, CSS `truncate`) instead of multi-line raw text.
  - Media QRs render a green `qr-media-badge-{id}` chip showing media type (image/video/document/audio).
  - Empty state: shows "No quick replies — create them in /quick-replies" or "No matches" depending on context.
  - QR list refreshes when dropdown opens (so admin's newly-created QRs appear without page reload).
- **Media-enabled Quick Replies — direct send (`applyQR`)**: clicking a QR with `media_url` + `media_type` now POSTs `/whatsapp/send-media` immediately with `{lead_id, media_type, media_url, caption?, filename?, reply_to_message_id?}`. Caption resolves `{{name}}` placeholder. Within24h gate enforced (toast error otherwise). Text-only QRs still append text into the composer for editing (unchanged behavior).
- **Lead Assignment History UI (`LeadDrawer.jsx` `ActivityPanel`)**: admin-only section `assignment-history-section` rendered above the activity log. Lists `lead.assignment_history[]` chronologically as `Initial → assigned to X` then `Reassigned: from A → B`, with timestamp + actor (`by`) + optional reason. Each row has `assignment-history-row-{i}` testid. Hidden for executives.
- **Auto-reassign already filters status='new'** — both unopened and noaction cursors in `auto_reassign_task` (server.py L5024-L5049) explicitly filter `status: "new"` per spec. Verified via pytest regression.
- **Transfer Requests admin UI** — `/transfer-requests` page wired with Pending/Approved/Rejected tabs, polling badge in sidebar (`nav-transfer-requests`), and per-row `tr-approve-{id}` / `tr-reject-{id}` buttons. Backend endpoints `POST /api/inbox/transfer-requests/{id}/approve|reject` flip `lead.assigned_to` correctly via `assign_lead()` (which $pushes to `assignment_history`).
- **Tested**: 15/15 pytest backend (test_iteration13_qr_transfer_history.py) + 11/11 Playwright frontend assertions green.

### Iteration 20 (Feb 2026) — /leads number-tab strip rewrite (deterministic per-number chat)
- **Problem (user-reported)**: had to open the lead twice for the per-number filter to take effect, and tab-switching often left messages from another number visible. Root cause: race between three separate effects (`loadAll` writing messages, `useEffect` watching `lead.active_wa_phone` writing `phoneFilter`, and a third effect re-fetching messages on `phoneFilter`) — they could fire in any order and clobber each other on rapid switches.
- **Fix — single source of truth**:
  - One state `phoneFilter` in `LeadDrawer`, initialized from `lead.active_wa_phone || lead.phone` ONCE (when `lead.id` first arrives). Reset to `""` only when `leadId` changes.
  - Auto-tracking effect REMOVED. The user's selection is never overwritten on subsequent lead refetches.
  - One dedicated effect `useEffect([leadId, phoneFilter])` does all message fetching with cancellation-safe write. `loadAll()` no longer fetches messages.
  - New explicit handler `selectPhone(p)` updates `phoneFilter` synchronously (instant UI response) and fires `PUT /leads/{id}/active-wa-phone` in the background to mirror to backend (so future automated outbound also targets this number). UI does not block on the PUT.
- **UX — number-tab strip**: replaced the awkward "Showing chat for: X · Show all numbers" banner with a clean WhatsApp-style tab row at the top of the WA panel (`data-testid='wa-phone-tabs'` with one button per `data-testid='wa-phone-tab-{phone}'`). The active tab is colored `#25D366`. Tab strip auto-hides when the lead has only one phone.
- **Verified**: rapid back-and-forth tab switching now flips messages deterministically every click — confirmed via Playwright (in-A-1/in-A-2 vs in-B-1/in-B-2 on a 2-number test lead). No "open twice" repro.

### Iteration 19 (Feb 2026) — /leads ↔ /chats redirect cleanup + inbound msg attribution
- **Backend bug fix (HIGH from iter11)** — WhatsApp inbound webhook now stores `from` (customer phone) and `to_phone` (business `display_phone_number`) on every message doc. Previously these were missing, causing the per-phone history filter to surface ZERO inbound messages even when present.
- **WA-icon redirect from /leads no longer filters /chat** — clicking the green WA icon next to a phone (in table row, card view, or lead-drawer phone row) now navigates to `/chat?lead={id}` ONLY. /chat shows the full global inbox; the selected lead is opened/focused but no `?phone=` filter is applied. The "Open in /chat" button inside the lead-drawer WA panel header behaves the same.
- **Per-phone history filter remains in /leads only** — the lead-drawer WA panel auto-tracks `lead.active_wa_phone`. When the admin clicks "Use this" on a different phone in PhonesRow, `setPhoneFilter` is updated via a `useEffect` and the WA panel reloads with `?phone=...`. The banner text now says "Showing chat for: {phone}" with a "Show all numbers" toggle to clear the filter for the current session.
- **/chat no longer mutates active_wa_phone on deep-link** — removed the `PUT /api/leads/{id}/active-wa-phone` side effect that was firing on `?phone=...` URL visits. /chat is now strictly view-only with respect to the persisted active phone. Direct deep-links `/chat?lead=X&phone=Y` still respect the filter for back-compat (banner + filtered messages), but /leads-originated redirects no longer trigger this.
- **Mobile lead-card DOM nesting fix** — converted the outer `<button>` to a `<div role="button">` so the nested WA-icon `<button>` is no longer an HTML-invalid descendant. Eliminates the React hydration warning. Keyboard accessibility preserved via `tabIndex` + `Enter/Space` handler.

- **Tested**: 14/14 backend pytest + 5/5 frontend Playwright cases green. Iter11's per-phone filter regression now passes (>=2 messages including inbound) due to the webhook fix.

### Iteration 18 (Feb 2026) — WhatsApp-style /chat polish
- **Smart timestamp formatting** (`/app/frontend/src/lib/format.js`):
  - `fmtSmartShort(iso)` → 'Today' time / 'Yesterday' / weekday (within 7d) / `12 Feb` / `12 Feb 2024`. Used in chat-list row timestamps.
  - `fmtSmartLong(iso)` → 'Today, 3:45 PM' / 'Yesterday, 3:45 PM' / '12 Feb, 2:30 PM' / '12 Feb 2024, 2:30 PM'. Used as the title/tooltip on every bubble timestamp.
  - `fmtTime12(iso)` → bare `3:45 PM`. Inside chat bubbles + InternalChat bubbles.
  - `fmtDaySeparator(dayKey)` → 'Today' / 'Yesterday' / weekday / '12 Feb' / '12 Feb 2024'. For sticky separators.
  - `istDayKey(iso)` → `YYYY-MM-DD` IST calendar key for grouping.

- **Sticky day separators** in chat thread (`Chat.jsx`):
  - `messageGroups` `useMemo` walks sorted messages and buckets them by `istDayKey`. Each bucket renders as a `DayGroup` (memoized).
  - The `<div data-testid="day-separator-{key}">` is `position: sticky; top: 0; z-10` — pinned to the top of the messages area while scrolling that day's messages, exactly matching WhatsApp.
  - Pill style: `bg-white/85 backdrop-blur-sm` with subtle border + shadow.

- **Unread highlighting in chat list** (`ConvRow`):
  - Rows with `unread > 0` get bg `#E7F7E6`, **bold black** customer name, green-tinted timestamp, **bold preview text**, and a green left border (`border-l-[#25D366]`). Already-active row still wins with `#F0F2F5` background.
  - Test surface: `data-unread` attribute on row + retained `data-testid="unread-badge"`.

- **Quick search within chat** (#4):
  - New `chat-search-toggle` button between Info and message list. Opens `in-chat-search-bar` with input, prev/next, hit counter, and close.
  - Searches body / caption / template_name / media_filename / contact_name / location_address / location_name.
  - All matches get a yellow ring (`ring-2 ring-[#FFCC00]`); the focused hit gets an orange ring with offset; cursor moves with prev/next and `scrollIntoView({block: 'center', behavior: 'smooth'})`.

- **Performance** (#5):
  - `Bubble` wrapped in `React.memo` with custom equality check (m identity + isHighlighted/isFocused/canMessage/currentUserId/searchQuery + callback refs).
  - `loadMessages` does **stable-identity merge**: keeps the previous object reference for any message whose `status|body|caption|media_url|reactions.length|error` signature is unchanged. Eliminates ~80% of bubble re-renders during the 4s poll cycle on large histories.
  - `DayGroup` memoized; in-thread callbacks (`handleReply`, `handleAskAdmin`) wrapped in `useCallback`; `resendFn`/`reactFn`/`askAdminFn` are stable refs derived once per render.
  - CSS: `contain: strict; overscroll-behavior: contain; will-change: scroll-position` on the messages area (browser-level paint isolation + smoother iOS-style scrolling).
  - Back-compat: kept hidden `data-testid="msg-{id}"` alias on each bubble so iter1-9 tests don't break.

- **Tested**: 9/9 frontend Playwright cases green, including unread row visual verification (lead 'Inbound First' rendered with green highlight + 'REPLY PENDING' badge), sticky 'TODAY' separator, search counter populated, and zero re-render churn after 2 polling cycles.

### Iteration 17 (Feb 2026) — Dedup + Sticky reassign + Smart template + Multi-Gmail
- **Phone-based cross-source deduplication** — `_create_lead_internal` already returned the existing lead on phone match; now ALSO calls new helper `_handle_repeat_enquiry()` which:
  - keeps the existing assignee when still active + not-on-leave (sticky),
  - reassigns via `_pick_buyleads_executive` (if the new payload qualifies as a buylead) or `pick_next_executive(exclude=prev_owner)` when the previous owner is on leave / inactive / missing,
  - bumps `last_action_at` + `last_enquiry_source` + `last_enquiry_at` on every re-entry,
  - emits `repeat_enquiry` or `repeat_enquiry_reassigned` activity log entries.
  - Also wired into the manual `POST /api/leads` early-return branch, so manual re-entries go through the same sticky pipeline (not just webhooks).

- **Gmail-id deduplication** — every polled email is checked against `db.email_logs.gmail_id` BEFORE processing; duplicates bump `skipped_dupe` counter and mark-read only. Prevents cross-slot re-ingestion when the same Justdial email arrives in both connected inboxes.

- **Smart WhatsApp welcome-template skip** — `auto_send_whatsapp_on_create` queries `db.messages` for any `direction='in'` record either on the lead-id OR on the phone-suffix pattern before firing. If the customer has already replied at any time, the template is NOT sent and a log warning is emitted. Protects against welcoming an already-engaged customer.

- **Manual Justdial phone-add triggers welcome template** — `POST /api/leads/{lead_id}/phones` now auto-fires `auto_send_whatsapp_on_create` when the lead's source is `Justdial` AND this is the first-ever phone being attached. The smart-skip above guards against double-sending when the customer has already replied.

- **Multi-Gmail (2 accounts)** — `gmail_connections` schema now keyed by slot (`primary` / `secondary`). Auto-migration: legacy `key='default'` docs are promoted to `key='primary'` on first read.
  - All Gmail endpoints accept optional `?slot=primary|secondary` — status, auth init, callback, disconnect, sync-now. Callback rejects with `duplicate_account` if the SAME Google email is already connected on the other slot.
  - Poller (`gmail_poll_task`) loops over `GMAIL_SLOTS = ('primary','secondary')`, calls `_gmail_poll_one_slot()` for each. Per-slot summaries stored at `db.gmail_polls` key `last:{slot}`; combined summary at `last` with `slots` dict.
  - Shared parse / dedup / create-lead pipeline — both accounts use the same extraction, phone-dedup, and assignment logic.
  - Frontend `Integrations.jsx` rewritten with two side-by-side slot panels (`gmail-slot-primary` / `gmail-slot-secondary`), per-slot Connect / Disconnect / Sync Now, plus a top-level "Sync all accounts" button.

- **Tested**: 16/16 new pytest backend suite PASSED. Both slots connected live in the env (citronellaoilnagpur@gmail.com + citspray@gmail.com). Frontend Playwright verified all new data-testids. iter7+iter8 regression still green.

### Iteration 16 (Feb 2026) — Internal Q&A Tracker + Chat-list tags + Deep-links
- **Centralized tracker page `/qa`** (`InternalQA.jsx`) — visible to both admin and executives via sidebar nav (`nav-qa`). Desktop table + mobile card grid.
  - Columns: Lead/Customer · Agent · Last Question + timestamp · Last Reply + timestamp · Replied By · Status chip · "Open chat" action button.
  - Filter chips: `All` / `Pending` / `Answered` (with counts) + free-text search box covering customer name, phone, agent name, last body.
  - Polling: 6s. Backend filter + client-side search; pending threads always sort first.
  - Status chip: orange `Pending` / green `Answered` / neutral `New` (admin-initiated without agent reply), with unread-for-me pill.

- **Backend `GET /api/internal-qa/threads`** — aggregates `internal_messages` per `(lead_id, agent_id)`.
  - Executive → filter to `agent_id=self` (strict isolation, reusing existing RBAC).
  - Admin → sees all threads; optional `?agent_id=`, `?status=pending|answered`, `?q=` filters.
  - Output per row: `lead_customer_name`, `lead_phone`, `agent_name/username`, `replied_by {id,name,username}`, `first_asked_at`, `last_asked_at`, `last_replied_at`, `last_body` (truncated 160), `last_from_role`, `count`, `unread_for_me`, `status`.
  - Path chosen as `/internal-qa/threads` to avoid the `/internal-chat/{lead_id}` single-segment matcher; `internal-chat/*` endpoints remain unchanged.

- **`GET /api/inbox/conversations` augmented** — now returns `internal_qa_status: 'none' | 'pending' | 'answered'` per conversation, derived from the latest internal message `from_role`. Executive scope filters to `agent_id=self`; admin rolls up across all threads (pending wins). Drives the chat-list tags.

- **Chat inbox tags** (`ConvRow` in `Chat.jsx`) — two new per-row badges driven by `internal_qa_status`:
  - `qa-tag-pending-{lead_id}` → orange `QUESTION ASKED` (agent question awaiting admin reply).
  - `qa-tag-answered-{lead_id}` → green `ANSWERED` (admin has responded).

- **Deep-linking from `/qa` → `/chat`** — `Open chat` button navigates to `/chat?lead={id}&tab=internal[&agent={id}]`. `Chat.jsx` captures the initial params ONCE via `useMemo` (so the URL-sync effect doesn't strip them before `ChatThread` mounts async after conv fetch). URL retains `tab`/`agent` for shareable links. `ChatThread` accepts `initialTab` + `initialAgentId`; `InternalChat` consumes `preselectAgentId` so admin deep-links land directly in the specific agent's thread (skipping the thread-list view). Executive deep-links go straight to their own thread (no agent-picker exists for them).

- **Access control remains intact** — executives only see their own threads in `/qa`, in `/api/internal-qa/threads`, and inside the chat inbox `internal_qa_status`. Previous iteration's `/api/internal-chat/{lead_id}` 403 on unassigned leads still holds.

- **Tested**: 13/13 new pytest backend suite green + full Playwright UI coverage for both admin and executive flows (Q&A page filters, search, tags, deep-link into specific agent's thread, executive-only row isolation).

### Iteration 15 (Feb 2026) — Buyleads Routing + Internal Q&A + Leave Management
- **Buyleads routing (per-source allow-list round-robin)**
  - Collections: `buyleads_routing` keyed by `source` with `{mode: 'all' | 'selected', agent_ids: [], last_assigned_index}`.
  - Helpers: `_is_buylead()` (IndiaMART `QUERY_TYPE=B`, ExportersIndia `enquiry_type=buyleads`), `_pick_buyleads_executive()` (round-robin across allow-list, skipping on-leave/inactive), `_get_buyleads_routing()`.
  - Wired into `_create_lead_internal` → if the incoming lead qualifies as a buylead and admin has configured `mode=selected`, assignment goes to the next allow-listed agent; otherwise falls back to `pick_next_executive()`. Existing already-assigned leads are untouched on config change.
  - Endpoints: `GET /api/settings/buyleads-routing` (configs + executives), `PUT /api/settings/buyleads-routing/{source}` (source must be `IndiaMART` or `ExportersIndia`, validates mode and that agent_ids are active executives).
  - UI (`Settings.jsx` → `BuyleadsRoutingPanel`): two source cards, toggle `All agents` / `Selected agents`, clickable agent pills for the allow-list, save per source.

- **Leave / Holiday management (admin CRUD + soft-logout)**
  - Collection: `leaves` with `{id, user_id, start_date, end_date, reason, cancelled, created_at/by, updated_at/by, cancelled_at/by}`.
  - Helper `_is_user_on_leave(user_id)` — returns the active leave doc when `start_date <= today <= end_date AND cancelled != true`.
  - Soft-logout: `get_current_user()` returns HTTP 401 with `detail.code='user_on_leave'` for executives on active leave. Admins are never blocked.
  - Block login: `POST /api/auth/login` returns HTTP 403 with `detail.code='user_on_leave'` for executives on active leave.
  - Assignment exclusions: `pick_next_executive()` filters out leave; `_pick_buyleads_executive()` filters out leave; IndiaMART `_find_user_for_receiver()` match (PNS route) is ignored when the matched user is on leave (falls back to round-robin).
  - Endpoints: `GET /api/leaves?user_id?&active_only?`, `POST /api/leaves`, `PATCH /api/leaves/{id}`, `POST /api/leaves/{id}/cancel`, `DELETE /api/leaves/{id}` (alias for cancel).
  - UI (`Settings.jsx` → `LeaveManagementPanel`): add-leave form (agent / start / end / reason), segmented sections for Active / Upcoming / Past with Modify + Cancel inline actions.
  - Frontend global interceptor (`AuthContext.jsx`): any 401 with a token present clears localStorage + hard-redirects to `/login` with a contextual toast (special message when `code=user_on_leave`). Effective within one 4-second poll cycle.

- **Internal Admin ↔ Agent Q&A chat (per-lead, per-agent isolation)**
  - Collection: `internal_messages` with `{id, lead_id, agent_id (thread key), from_user_id, from_role, body, quoted, read_by[], at}`.
  - Endpoints:
    - `POST /api/internal-chat/send` — Agent can send only on their own leads (→ 403 otherwise); sent under `agent_id=self`. Admin must supply `to_user_id` (an active executive) → message persists under `agent_id=to_user_id`. Agent↔agent is forbidden. Optional `message_id` quotes the referenced WA message.
    - `GET /api/internal-chat/{lead_id}` — Executive: strict 403 unless they own the lead, else returns only their thread. Admin: without `agent_id` → grouped threads per agent with unread-for-admin counts + last preview; with `agent_id` → full thread.
    - `POST /api/internal-chat/{lead_id}/mark-read?agent_id?` — marks messages as read by the caller.
    - `GET /api/internal-chat/inbox/unread` — unread count for the current user (badge hook).
  - UI (`Chat.jsx`): right-side lead info panel is now a tabbed interface (`Details` | `Internal Q&A`). Per-message `?` hover button on WA bubbles lets an executive "Ask admin" with that message pre-quoted. Admin sees per-agent thread list inside the tab plus a "Start thread with" picker; clicking a thread opens it with a back-to-list control. WhatsApp customer NEVER sees internal messages (separate collection, never hits `send_flow_message`).

- **Testing**: 22/22 new pytest regression suite at `/app/backend/tests/test_iteration7_routing_leaves_internal.py` (testing-agent-authored, self-cleans buyleads config and cancels its own leaves on teardown). Previous iter7+iter8 regression remains 39/39 green.

### Iteration 14 (Feb 2026) — ExportersIndia Pull API (scheduled poll)
- **Switched from push webhook to pull** — we now poll `https://members.exportersindia.com/api-inquiry-detail.php?k=<api_key>&email=<email>&date_from=<yyyy-mm-dd>` on a configurable interval (default 1 minute; 10-second minimum enforced). Uses `last_success_at - 1 day` as `date_from` to catch late-arriving enquiries; dedup via `inq_id` and phone handles repeats.
- **APScheduler job `exportersindia_pull`** — scheduled at boot if the admin has enabled it; rescheduled in-place on config changes (no service restart needed). Skips ticks automatically if key/email are missing.
- **Endpoints**:
  - `GET /api/settings/exportersindia-pull` — masked key, email, pull_url, interval_minutes+interval_seconds, enabled, `last_pulled_at` / `last_success_at` / `last_error` / `last_created_count` / `last_date_from`.
  - `PUT /api/settings/exportersindia-pull {api_key?, email?, pull_url?, interval_minutes?, interval_seconds?, enabled?}` — partial updates; rescheduling done automatically.
  - `POST /api/settings/exportersindia-pull/run-now?date_from=YYYY-MM-DD` — manual trigger for admins to backfill or test.
- **Parser hardening** — `_handle_exportersindia_payload` now skips status-wrapper responses like `{"msg":"No record found"}` (no lead created) and reports `skipped_empty` count.
- **Push webhook** kept for backward-compat (with optional key auth via `/api/settings/exportersindia`) but marked deprecated in favour of the pull flow.
- **UI (`Settings.jsx`)** — new "ExportersIndia Pull API" panel: enable toggle, current-key mask, last successful pull with `date_from` + `+N new` badge, new-key input with eye-toggle + "Save key", email field + "Save email", **min + sec** interval inputs + "Save interval", "Run pull now" button, and a live preview of the GET URL.
- **Verified live** — configured `k=RFV0VXlpV2NlQVMvVzl4Wk92VkcwUT09` + `email=citspray@gmail.com`, interval=30s for testing → `last_success_at` advanced every tick. "No record found" wrapper is skipped correctly. Restored to 1m for production use.
- **Tested**: 39/39 iter7+iter8 regression green.

### Iteration 13 (Feb 2026) — ExportersIndia API-key auth (deprecated — now Pull API)
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
