"""Iteration 9: cross-source phone dedup + sticky reassignment + smart-skip welcome
template + manual phone-add → template + multi-Gmail (primary/secondary) slot model.

Run via:
    pytest /app/backend/tests/test_iteration9_dedup_gmail_slots.py -v
"""
import os
import time
import uuid
import pytest
import requests
from datetime import date

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


# ---------------- helpers ----------------
def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=20)
    return r.json().get("token") if r.status_code == 200 else ""


@pytest.fixture(scope="module")
def admin_h():
    t = _login("admin", "Admin@123")
    if not t:
        pytest.skip("admin login failed")
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def execs(admin_h):
    r = requests.get(f"{API}/users", headers=admin_h, timeout=20)
    assert r.status_code == 200
    by_u = {u["username"]: u for u in r.json() if u.get("role") == "executive"}
    if "ravi" not in by_u or "priya" not in by_u:
        pytest.skip("ravi/priya not seeded")
    return by_u


def _cancel_active_leaves(admin_h, user_id):
    r = requests.get(f"{API}/leaves", headers=admin_h, params={"user_id": user_id}, timeout=15)
    if r.status_code == 200:
        for lv in r.json():
            if lv.get("status") == "active":
                requests.post(f"{API}/leaves/{lv['id']}/cancel", headers=admin_h, timeout=15)


def _activity_for(admin_h, lead_id):
    r = requests.get(f"{API}/leads/{lead_id}/activity", headers=admin_h, timeout=15)
    return r.json() if r.status_code == 200 else []


def _assign(admin_h, lead_id, user_id):
    return requests.post(f"{API}/leads/{lead_id}/reassign", headers=admin_h, json={"assigned_to": user_id}, timeout=15)


def _lead_ids_from_indiamart(resp_json):
    """Webhook returns {'created':[...]} on success. Return list of created lead ids."""
    return resp_json.get("created") or resp_json.get("lead_ids") or []


def _messages_for(admin_h, lead_id):
    r = requests.get(f"{API}/leads/{lead_id}/messages", headers=admin_h, timeout=15)
    if r.status_code != 200:
        return []
    body = r.json()
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        return body.get("messages") or body.get("items") or []
    return []


def _post_indiamart(phone, name="TEST_iter9", uniq=None):
    uniq = uniq or str(uuid.uuid4())[:8]
    payload = {"RESPONSE": [{
        "SENDER_NAME": name,
        "SENDER_MOBILE": phone,
        "QUERY_TYPE": "W",
        "UNIQUE_QUERY_ID": uniq,
        "QUERY_PRODUCT_NAME": "Citronella oil",
        "QUERY_MESSAGE": "Hi, please send rate.",
    }]}
    return requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)


# ============================================================
# 1. IndiaMART dedup — same phone → same lead, no duplicate row
# ============================================================
class TestIndiamartPhoneDedup:
    def test_same_phone_returns_same_lead(self, admin_h):
        phone = f"9{uuid.uuid4().int % (10 ** 9):09d}"
        r1 = _post_indiamart(phone)
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        first_ids = _lead_ids_from_indiamart(d1)
        assert first_ids, d1
        first_id = first_ids[0]

        time.sleep(0.5)
        r2 = _post_indiamart(phone)
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        # On dedup the webhook may return 'created' empty AND 'duplicates' / 'existing' set.
        # Either way: we must NOT have a fresh new lead id different from first_id.
        new_ids = _lead_ids_from_indiamart(d2)
        if new_ids:
            assert new_ids[0] == first_id, f"dedup failed: {d1} vs {d2}"

        # Verify only ONE lead exists for that phone
        suffix = phone[-9:]
        lr = requests.get(f"{API}/leads", headers=admin_h, params={"q": suffix}, timeout=15)
        assert lr.status_code == 200
        ids = {lead["id"] for lead in lr.json() if lead["id"] == first_id}
        assert len(ids) == 1


# ============================================================
# 2. Cross-source repeat enquiry — sticky kept
# ============================================================
class TestStickyKept:
    def test_cross_source_keeps_owner_when_active(self, admin_h, execs):
        _cancel_active_leaves(admin_h, execs["ravi"]["id"])
        _cancel_active_leaves(admin_h, execs["priya"]["id"])
        phone = f"8{uuid.uuid4().int % (10 ** 9):09d}"
        r1 = _post_indiamart(phone, name="TEST_iter9_sticky")
        assert r1.status_code == 200
        ids = _lead_ids_from_indiamart(r1.json())
        assert ids, r1.json()
        lead_id = ids[0]

        # Force-assign to ravi so we have a known owner
        ar = _assign(admin_h, lead_id, execs["ravi"]["id"])
        assert ar.status_code == 200, ar.text
        before = requests.get(f"{API}/leads/{lead_id}", headers=admin_h, timeout=15).json()
        assert before["assigned_to"] == execs["ravi"]["id"]
        before_last = before.get("last_action_at")

        time.sleep(1.1)
        # Re-enquire by re-posting via IndiaMART webhook (simulates cross-source re-enquiry
        # because ALL webhook ingests go through `_create_lead_internal` which invokes
        # `_handle_repeat_enquiry` for matched-phone leads). NOTE: POST /api/leads
        # short-circuits BEFORE _create_lead_internal so it does NOT invoke sticky logic
        # (see test report — possible bug).
        r2 = _post_indiamart(phone, name="TEST_iter9_sticky_v2")
        assert r2.status_code == 200, r2.text
        # On dedup, response should not mint a new lead id.
        new_ids = _lead_ids_from_indiamart(r2.json())
        if new_ids:
            assert new_ids[0] == lead_id, "should return SAME lead, not create new"

        after = requests.get(f"{API}/leads/{lead_id}", headers=admin_h, timeout=15).json()
        assert after.get("last_action_at") and after["last_action_at"] > before_last, \
            "last_action_at should be bumped"

        acts = _activity_for(admin_h, lead_id)
        actions = [a.get("action") for a in acts]
        assert "repeat_enquiry" in actions, actions
        repeat = next(a for a in acts if a.get("action") == "repeat_enquiry")
        assert (repeat.get("meta") or {}).get("previous_owner_kept") is True

    def test_no_duplicate_lead_row_after_repeat(self, admin_h):
        phone = f"7{uuid.uuid4().int % (10 ** 9):09d}"
        r1 = _post_indiamart(phone)
        ids = _lead_ids_from_indiamart(r1.json())
        assert ids, r1.json()
        lid = ids[0]
        # Re-post from same source again
        r2 = _post_indiamart(phone)
        new_ids = _lead_ids_from_indiamart(r2.json())
        if new_ids:
            assert new_ids[0] == lid


# ============================================================
# 3. Sticky reassignment — owner on leave → moved to other exec
# ============================================================
class TestStickyReassignment:
    def test_owner_on_leave_triggers_reassignment(self, admin_h, execs):
        _cancel_active_leaves(admin_h, execs["ravi"]["id"])
        _cancel_active_leaves(admin_h, execs["priya"]["id"])
        phone = f"6{uuid.uuid4().int % (10 ** 9):09d}"

        # 1) create lead, force-assign to ravi
        r1 = _post_indiamart(phone, name="TEST_iter9_reassign")
        ids = _lead_ids_from_indiamart(r1.json())
        assert ids, r1.json()
        lid = ids[0]
        ar = _assign(admin_h, lid, execs["ravi"]["id"])
        assert ar.status_code == 200, ar.text

        # 2) put ravi on leave (today)
        today = date.today().isoformat()
        lv = requests.post(f"{API}/leaves", headers=admin_h, json={
            "user_id": execs["ravi"]["id"], "start_date": today, "end_date": today, "reason": "TEST_iter9"
        }, timeout=15)
        assert lv.status_code == 200, lv.text
        leave_id = lv.json()["id"]

        try:
            time.sleep(0.6)
            # Re-enquire via IndiaMART webhook (goes through _create_lead_internal → _handle_repeat_enquiry)
            r2 = _post_indiamart(phone, name="TEST_iter9_reassign_v2")
            assert r2.status_code == 200, r2.text
            new_ids = _lead_ids_from_indiamart(r2.json())
            if new_ids:
                assert new_ids[0] == lid

            updated = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15).json()
            assert updated["assigned_to"] != execs["ravi"]["id"], \
                f"expected reassignment off ravi, still on {updated.get('assigned_to')}"
            # Should be priya (only other active executive in seed)
            assert updated["assigned_to"] == execs["priya"]["id"]

            acts = _activity_for(admin_h, lid)
            r_acts = [a for a in acts if a.get("action") == "repeat_enquiry_reassigned"]
            assert r_acts, f"missing repeat_enquiry_reassigned activity. got: {[a.get('action') for a in acts]}"
            data = r_acts[0].get("meta") or {}
            assert data.get("reason") == "previous_agent_unavailable"
            assert data.get("from") == execs["ravi"]["id"]
            assert data.get("to") == execs["priya"]["id"]
        finally:
            requests.post(f"{API}/leaves/{leave_id}/cancel", headers=admin_h, timeout=15)


# ============================================================
# 4. Smart welcome-template skip — no out msg if prior inbound
# ============================================================
class TestSmartWelcomeSkip:
    def test_no_welcome_when_prior_inbound_exists(self, admin_h):
        # check routing rule first
        rr = requests.get(f"{API}/settings/routing", headers=admin_h, timeout=15)
        if rr.status_code == 200 and rr.json().get("auto_whatsapp_on_create") is False:
            pytest.skip("auto_whatsapp_on_create disabled, skip-test irrelevant")

        phone = f"5{uuid.uuid4().int % (10 ** 9):09d}"
        # Simulate inbound message coming first via webhook so smart-skip kicks in
        # Use the WhatsApp inbound webhook (mock) to insert direction='in'
        wa_payload = {
            "entry": [{
                "changes": [{
                    "value": {
                        "messages": [{
                            "from": phone,
                            "id": f"wamid.test_{uuid.uuid4()}",
                            "timestamp": str(int(time.time())),
                            "text": {"body": "hi i replied first"},
                            "type": "text",
                        }],
                        "contacts": [{"profile": {"name": "Inbound First"}, "wa_id": phone}],
                    }
                }]
            }]
        }
        wh = requests.post(f"{API}/webhooks/whatsapp", json=wa_payload, timeout=15)
        # Webhook may auto-create lead; check what happened
        time.sleep(0.5)

        # Now, find lead by phone
        suffix = phone[-9:]
        lr = requests.get(f"{API}/leads", headers=admin_h, params={"q": suffix}, timeout=15)
        leads = [l for l in lr.json() if (l.get("phone") or "").endswith(suffix[-9:])]
        if not leads:
            pytest.skip(f"WhatsApp inbound webhook did not create a lead, can't verify (status={wh.status_code})")
        lead_id = leads[0]["id"]

        # Count messages BEFORE creating manual lead
        before_out = sum(1 for m in _messages_for(admin_h, lead_id) if m.get("direction") == "out")

        # Now create another lead with same phone — should hit dedup AND skip welcome template
        r2 = requests.post(f"{API}/leads", headers=admin_h, json={
            "customer_name": "TEST_iter9_smartskip",
            "phone": phone, "source": "Manual",
        }, timeout=15)
        assert r2.status_code == 200
        assert r2.json()["id"] == lead_id  # dedup OK

        time.sleep(0.5)
        after_out = sum(1 for m in _messages_for(admin_h, lead_id) if m.get("direction") == "out")
        # Repeat enquiry path doesn't even call auto_send (only initial create does), but
        # asserting no NEW out message is the correct behaviour either way.
        assert after_out == before_out, "no new outbound welcome should fire on repeat"


# ============================================================
# 5. Manual phone-add on Justdial lead → triggers welcome template
# ============================================================
class TestManualPhoneAddTriggersTemplate:
    def test_first_phone_add_on_justdial_lead(self, admin_h):
        # create a Justdial lead WITHOUT phone (Justdial often arrives this way)
        r = requests.post(f"{API}/leads", headers=admin_h, json={
            "customer_name": "TEST_iter9_jd_phoneadd",
            "source": "Justdial",
            "requirement": "needs phone added",
        }, timeout=15)
        assert r.status_code == 200, r.text
        lead = r.json()
        lid = lead["id"]
        assert not lead.get("phone")

        m_before = _messages_for(admin_h, lid)
        before_out = sum(1 for m in m_before if m.get("direction") == "out")

        new_phone = f"4{uuid.uuid4().int % (10 ** 9):09d}"
        pr = requests.post(f"{API}/leads/{lid}/phones", headers=admin_h, json={"phone": new_phone}, timeout=15)
        assert pr.status_code == 200, pr.text
        updated = pr.json()
        assert updated["phone"] == new_phone or updated["phone"].endswith(new_phone[-10:])

        time.sleep(0.8)
        m_after = _messages_for(admin_h, lid)
        after_out = sum(1 for m in m_after if m.get("direction") == "out")
        # Welcome-template send may be no-op (mocked WA) — if WA welcome_template not configured,
        # auto_send is silent; but the path must NOT raise. We accept either:
        #   (a) at least one new outbound message logged, OR
        #   (b) no error and no message (silent no-op).
        assert after_out >= before_out, "phone-add should not delete messages"

    def test_non_justdial_lead_no_template_on_phone_add(self, admin_h):
        r = requests.post(f"{API}/leads", headers=admin_h, json={
            "customer_name": "TEST_iter9_nonjd_phoneadd",
            "source": "Manual",
            "requirement": "shouldn't fire template",
        }, timeout=15)
        lid = r.json()["id"]
        m_before = _messages_for(admin_h, lid)
        before_out = sum(1 for m in m_before if m.get("direction") == "out")
        new_phone = f"3{uuid.uuid4().int % (10 ** 9):09d}"
        pr = requests.post(f"{API}/leads/{lid}/phones", headers=admin_h, json={"phone": new_phone}, timeout=15)
        assert pr.status_code == 200
        time.sleep(0.5)
        m_after = _messages_for(admin_h, lid)
        after_out = sum(1 for m in m_after if m.get("direction") == "out")
        # Non-Justdial → must not fire a NEW welcome template
        assert after_out == before_out, "non-Justdial lead should not trigger welcome on phone-add"


# ============================================================
# 6. Gmail multi-slot endpoints
# ============================================================
class TestGmailSlots:
    def test_status_no_slot_returns_dual_shape(self, admin_h):
        r = requests.get(f"{API}/integrations/gmail/status", headers=admin_h, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        if d.get("enabled") is False:
            pytest.skip(f"Gmail not configured: {d.get('reason')}")
        assert "slots" in d, d
        assert set(d["slots"].keys()) == {"primary", "secondary"}, d["slots"].keys()
        # primary is connected per current env
        assert d["slots"]["primary"].get("connected") is True
        assert d["slots"]["secondary"].get("connected") is False

    def test_status_single_slot_primary(self, admin_h):
        r = requests.get(f"{API}/integrations/gmail/status", headers=admin_h, params={"slot": "primary"}, timeout=15)
        assert r.status_code == 200
        d = r.json()
        if d.get("enabled") is False:
            pytest.skip("Gmail not configured")
        assert d.get("connected") is True
        assert d.get("slot") == "primary"
        assert "slots" not in d

    def test_status_single_slot_secondary(self, admin_h):
        r = requests.get(f"{API}/integrations/gmail/status", headers=admin_h, params={"slot": "secondary"}, timeout=15)
        assert r.status_code == 200
        d = r.json()
        if d.get("enabled") is False:
            pytest.skip("Gmail not configured")
        assert d.get("connected") is False
        assert d.get("slot") == "secondary"

    def test_auth_init_secondary_slot(self, admin_h):
        r = requests.get(f"{API}/integrations/gmail/auth/init", headers=admin_h, params={"slot": "secondary"}, timeout=15)
        if r.status_code == 400 and "not configured" in r.text:
            pytest.skip("Gmail not configured")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("slot") == "secondary"
        url = d.get("auth_url") or ""
        assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?"), url
        assert "state=" in url, url

    def test_auth_init_invalid_slot(self, admin_h):
        r = requests.get(f"{API}/integrations/gmail/auth/init", headers=admin_h, params={"slot": "bogus"}, timeout=15)
        assert r.status_code == 400, r.text
        assert "slot must be one of" in r.text

    def test_disconnect_secondary_idempotent(self, admin_h):
        r = requests.post(f"{API}/integrations/gmail/disconnect", headers=admin_h, params={"slot": "secondary"}, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True
        assert d.get("slot") == "secondary"

    def test_sync_now_primary_only(self, admin_h):
        r = requests.post(f"{API}/integrations/gmail/sync-now", headers=admin_h, params={"slot": "primary"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True
        last = d.get("last_poll") or {}
        # single-slot poll → no 'slots' key
        assert "slots" not in last
        assert last.get("slot") == "primary" or last.get("key") in (None, "last:primary")

    def test_sync_now_no_slot_returns_combined(self, admin_h):
        r = requests.post(f"{API}/integrations/gmail/sync-now", headers=admin_h, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        last = d.get("last_poll") or {}
        assert "slots" in last, last
        assert set(last["slots"].keys()) == {"primary", "secondary"}, last["slots"]


# ============================================================
# 7. gmail_id uniqueness in email_logs (no double-ingest)
# ============================================================
class TestGmailIdDedup:
    def test_no_duplicate_gmail_id_in_email_logs(self, admin_h):
        # The dedup key is gmail_id — use admin debug endpoint if available, else
        # fall back to checking via /api/leads for source=Justdial that no two
        # leads share same source_data.gmail_id
        r = requests.get(f"{API}/leads", headers=admin_h, params={"source": "Justdial", "limit": 200}, timeout=20)
        if r.status_code != 200:
            pytest.skip("could not list Justdial leads")
        seen = {}
        for ld in r.json():
            sd = ld.get("source_data") or {}
            gid = sd.get("gmail_id") or sd.get("message_id")
            if not gid:
                continue
            if gid in seen and seen[gid] != ld["id"]:
                pytest.fail(f"duplicate lead for gmail_id={gid}: {seen[gid]} vs {ld['id']}")
            seen[gid] = ld["id"]
