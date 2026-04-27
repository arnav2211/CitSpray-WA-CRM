"""
Tests for LeadOrbit CRM iteration-2 upgrades:
- Inbound WhatsApp webhook simulator + has_whatsapp flip
- Status update webhook
- /api/inbox/conversations WA-active filter + new fields
- /api/whatsapp/send flips has_whatsapp
- Receiver-numbers CRUD + conflict 409
- /api/settings/receiver-routing (admin)
- IndiaMART webhook auto-routing by RECEIVER_MOBILE
- Admin excluded from round-robin auto-assign
- Admin can be manually assigned
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_CREDS = {"username": "admin", "password": "Admin@123"}
RAVI_CREDS = {"username": "ravi", "password": "Exec@123"}
PRIYA_CREDS = {"username": "priya", "password": "Exec@123"}


def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, f"Login fail: {r.status_code} {r.text}"
    d = r.json()
    return d["token"], d["user"]


@pytest.fixture(scope="session")
def admin_ctx():
    tok, user = _login(ADMIN_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


def _ensure_exec_password(admin_h, username, password):
    """Admin-reset an executive password (in case prior tests changed it)."""
    users = requests.get(f"{API}/users", headers=admin_h, timeout=20).json()
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        return
    # Try login first
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=20)
    if r.status_code == 200:
        return
    # Reset via PATCH
    requests.patch(f"{API}/users/{u['id']}", json={"password": password}, headers=admin_h, timeout=20)


@pytest.fixture(scope="session")
def ravi_ctx(admin_ctx):
    _ensure_exec_password(admin_ctx["h"], "ravi", "Exec@123")
    tok, user = _login(RAVI_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="session")
def priya_ctx(admin_ctx):
    _ensure_exec_password(admin_ctx["h"], "priya", "Exec@123")
    tok, user = _login(PRIYA_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


def _reset_receiver(admin_h, uid):
    requests.put(f"{API}/users/{uid}/receiver-numbers", json={"receiver_numbers": []}, headers=admin_h, timeout=20)


# ---------------- Receiver numbers ----------------
class TestReceiverNumbers:
    def test_admin_set_receiver_numbers_success(self, admin_ctx, ravi_ctx, priya_ctx):
        _reset_receiver(admin_ctx["h"], ravi_ctx["user"]["id"])
        _reset_receiver(admin_ctx["h"], priya_ctx["user"]["id"])
        r = requests.put(
            f"{API}/users/{ravi_ctx['user']['id']}/receiver-numbers",
            json={"receiver_numbers": ["+91 98765 11111", "9876522222"]},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "receiver_numbers" in body
        assert len(body["receiver_numbers"]) == 2
        # digits-only / at least not containing spaces
        for n in body["receiver_numbers"]:
            assert " " not in n

    def test_conflict_same_number_different_user(self, admin_ctx, ravi_ctx, priya_ctx):
        # Ravi already has 9876511111. Priya tries to claim it.
        r = requests.put(
            f"{API}/users/{priya_ctx['user']['id']}/receiver-numbers",
            json={"receiver_numbers": ["09876511111"]},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        assert "already mapped" in detail.lower() or "mapped" in detail.lower()

    def test_non_admin_forbidden(self, ravi_ctx):
        r = requests.put(
            f"{API}/users/{ravi_ctx['user']['id']}/receiver-numbers",
            json={"receiver_numbers": ["1111111111"]},
            headers=ravi_ctx["h"], timeout=20,
        )
        assert r.status_code in (401, 403)

    def test_receiver_routing_endpoint(self, admin_ctx):
        r = requests.get(f"{API}/settings/receiver-routing", headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "users" in d and isinstance(d["users"], list)
        # Each row has required fields
        for u in d["users"]:
            for k in ("id", "name", "username", "role", "receiver_numbers"):
                assert k in u, f"Missing {k} in routing row {u}"

    def test_receiver_routing_forbidden_for_exec(self, ravi_ctx):
        r = requests.get(f"{API}/settings/receiver-routing", headers=ravi_ctx["h"], timeout=20)
        assert r.status_code in (401, 403)


# ---------------- WhatsApp inbound simulator ----------------
class TestWhatsAppInboundSimulator:
    def test_simulate_creates_lead_and_message(self, admin_ctx):
        # Use a unique phone so we test NEW lead creation
        unique_suffix = str(int(time.time()))[-8:]
        phone = f"+9199{unique_suffix}"
        body = {"from_phone": phone, "name": "TEST_WASim", "body": "Hello from simulator"}
        r = requests.post(f"{API}/webhooks/whatsapp/_debug/simulate", json=body,
                          headers=admin_ctx["h"], timeout=30)
        assert r.status_code == 200, r.text
        resp = r.json()
        assert resp.get("ok") is True

        # Verify conversation/lead appears in inbox
        time.sleep(1)
        conv_r = requests.get(f"{API}/inbox/conversations", headers=admin_ctx["h"], timeout=20)
        assert conv_r.status_code == 200
        convs = conv_r.json()
        matches = [c for c in convs if str(c.get("phone", ""))[-8:] == unique_suffix]
        assert matches, f"Lead with phone suffix {unique_suffix} not found in /inbox/conversations"
        conv = matches[0]
        assert conv.get("has_whatsapp") is True
        # Required new fields in conversation row
        for k in ("phone", "requirement", "notes", "status", "has_whatsapp"):
            assert k in conv, f"Missing {k} in conversation row"

    def test_simulate_existing_lead_flips_has_whatsapp(self, admin_ctx):
        # Create a lead via IndiaMART webhook (no WA yet), then simulate inbound
        unique_suffix = str(int(time.time()))[-8:]
        phone = f"+9188{unique_suffix}"
        im_payload = {
            "RESPONSE": {
                "SENDER_MOBILE": phone, "SENDER_NAME": "TEST_Existing",
                "QUERY_PRODUCT_NAME": "Pipes", "QUERY_MESSAGE": "need quote",
                "UNIQUE_QUERY_ID": f"TEST_{uuid.uuid4().hex[:10]}",
            }
        }
        ri = requests.post(f"{API}/webhooks/indiamart", json=im_payload, timeout=20)
        assert ri.status_code == 200

        # Confirm lead exists and is NOT WA-active initially
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        lead = next((l for l in leads if str(l.get("phone", ""))[-8:] == unique_suffix), None)
        assert lead is not None
        assert not lead.get("has_whatsapp", False)

        # Simulate inbound WA
        sim = requests.post(
            f"{API}/webhooks/whatsapp/_debug/simulate",
            json={"from_phone": phone, "name": "TEST_Existing", "body": "hi"},
            headers=admin_ctx["h"], timeout=30,
        )
        assert sim.status_code == 200
        time.sleep(1)
        leads2 = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        lead2 = next((l for l in leads2 if str(l.get("phone", ""))[-8:] == unique_suffix), None)
        assert lead2 is not None
        assert lead2.get("has_whatsapp") is True

    def test_status_update_webhook(self, admin_ctx):
        # First simulate an inbound (to get a wamid stored) then send a status update.
        unique = str(int(time.time()))[-8:]
        phone = f"+9177{unique}"
        sim = requests.post(
            f"{API}/webhooks/whatsapp/_debug/simulate",
            json={"from_phone": phone, "name": "TEST_StatusSender", "body": "ping"},
            headers=admin_ctx["h"], timeout=30,
        )
        assert sim.status_code == 200

        # Send outbound to create an outbound message wamid we can address.
        # Find lead first
        convs = requests.get(f"{API}/inbox/conversations", headers=admin_ctx["h"], timeout=20).json()
        match = next((c for c in convs if str(c.get("phone", ""))[-8:] == unique), None)
        assert match is not None
        lead_id = match["id"]

        send = requests.post(
            f"{API}/whatsapp/send",
            json={"lead_id": lead_id, "body": "TEST outbound for status"},
            headers=admin_ctx["h"], timeout=30,
        )
        assert send.status_code == 200, send.text
        send_resp = send.json()
        wamid = send_resp.get("wamid") or send_resp.get("id")
        if not wamid:
            pytest.skip("Outbound send did not return wamid (mock mode); skip status update check")

        status_payload = {
            "object": "whatsapp_business_account",
            "entry": [{"changes": [{"value": {"statuses": [
                {"id": wamid, "status": "delivered", "timestamp": str(int(time.time()))}
            ]}, "field": "messages"}]}],
        }
        r = requests.post(f"{API}/webhooks/whatsapp", json=status_payload, timeout=20)
        assert r.status_code in (200, 204)

    def test_whatsapp_send_flips_has_whatsapp(self, admin_ctx):
        # Create fresh IM lead (no WA), then simulate an inbound WA to open the 24h
        # window, then POST /api/whatsapp/send → has_whatsapp flip should persist.
        unique = str(int(time.time()))[-8:]
        phone = f"+9166{unique}"
        im = {"RESPONSE": {"SENDER_MOBILE": phone, "SENDER_NAME": "TEST_Flip",
                           "QUERY_MESSAGE": "msg", "UNIQUE_QUERY_ID": f"TEST_{uuid.uuid4().hex[:10]}"}}
        requests.post(f"{API}/webhooks/indiamart", json=im, timeout=20)
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        lead = next((l for l in leads if str(l.get("phone", ""))[-8:] == unique), None)
        assert lead is not None

        # Open the 24h session by simulating an inbound WA
        requests.post(f"{API}/webhooks/whatsapp/_debug/simulate",
                      json={"from_phone": phone, "name": "TEST_Flip", "body": "hi"},
                      headers=admin_ctx["h"], timeout=20)
        time.sleep(0.5)

        r = requests.post(f"{API}/whatsapp/send",
                          json={"lead_id": lead["id"], "body": "TEST send flip"},
                          headers=admin_ctx["h"], timeout=30)
        assert r.status_code == 200, r.text

        time.sleep(1)
        leads2 = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        lead2 = next((l for l in leads2 if l["id"] == lead["id"]), None)
        assert lead2.get("has_whatsapp") is True


# ---------------- Inbox filter (WA-active only) ----------------
class TestInboxFilter:
    def test_include_all_returns_more_or_equal(self, admin_ctx):
        default = requests.get(f"{API}/inbox/conversations", headers=admin_ctx["h"], timeout=20).json()
        all_ = requests.get(f"{API}/inbox/conversations?include_all=true",
                            headers=admin_ctx["h"], timeout=20).json()
        assert isinstance(default, list) and isinstance(all_, list)
        assert len(all_) >= len(default)

    def test_default_only_wa_active(self, admin_ctx):
        default = requests.get(f"{API}/inbox/conversations", headers=admin_ctx["h"], timeout=20).json()
        # every returned conversation must have has_whatsapp=True OR a last_message/last_user_message_at
        for c in default:
            ok = bool(c.get("has_whatsapp")) or bool(c.get("last_message")) or bool(c.get("last_user_message_at"))
            assert ok, f"Non-WA-active conversation leaked: {c}"


# ---------------- IndiaMART routing by receiver ----------------
class TestIndiaMartRouting:
    def test_auto_route_by_receiver_mobile(self, admin_ctx, ravi_ctx, priya_ctx):
        # Give Ravi a unique receiver number
        unique = str(int(time.time()))[-8:]
        rx_num = f"+9190{unique}"
        _reset_receiver(admin_ctx["h"], ravi_ctx["user"]["id"])
        _reset_receiver(admin_ctx["h"], priya_ctx["user"]["id"])
        r = requests.put(
            f"{API}/users/{ravi_ctx['user']['id']}/receiver-numbers",
            json={"receiver_numbers": [rx_num]},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 200, r.text

        # Post IM lead with matching RECEIVER_MOBILE but different prefix
        matching_variant = "0" + rx_num[-10:]  # 0 prefix instead of +91
        lead_suffix = str(int(time.time()))[-7:]
        im_payload = {
            "RESPONSE": {
                "SENDER_MOBILE": f"+9155{lead_suffix}5",
                "SENDER_NAME": "TEST_RouteByReceiver",
                "RECEIVER_MOBILE": matching_variant,
                "QUERY_PRODUCT_NAME": "X",
                "QUERY_MESSAGE": "m",
                "UNIQUE_QUERY_ID": f"TEST_{uuid.uuid4().hex[:10]}",
            }
        }
        ri = requests.post(f"{API}/webhooks/indiamart", json=im_payload, timeout=20)
        assert ri.status_code == 200

        time.sleep(0.5)
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        match = next((l for l in leads if str(l.get("phone", ""))[-10:].endswith(f"55{lead_suffix}5")), None)
        assert match is not None, "Lead not created"
        assert match.get("assigned_to") == ravi_ctx["user"]["id"], \
            f"Expected assigned to Ravi ({ravi_ctx['user']['id']}), got {match.get('assigned_to')}"

        _reset_receiver(admin_ctx["h"], ravi_ctx["user"]["id"])


# ---------------- Round-robin excludes admin ----------------
class TestRoundRobinExcludesAdmin:
    def test_admin_never_auto_assigned(self, admin_ctx):
        admin_id = admin_ctx["user"]["id"]
        assigned = []
        created_qids = []
        for i in range(5):
            unique = f"{int(time.time())}{i}"[-9:]
            qid = f"TEST_RR_{uuid.uuid4().hex[:10]}"
            created_qids.append(qid)
            im_payload = {
                "RESPONSE": {
                    "SENDER_MOBILE": f"+9144{unique}",
                    "SENDER_NAME": f"TEST_RR_{i}",
                    "QUERY_MESSAGE": "rr",
                    "UNIQUE_QUERY_ID": qid,
                }
            }
            requests.post(f"{API}/webhooks/indiamart", json=im_payload, timeout=20)
            time.sleep(0.2)
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        # Only leads created in THIS run (match by UNIQUE_QUERY_ID in source_data)
        test_leads = [l for l in leads
                      if (l.get("source_data") or {}).get("UNIQUE_QUERY_ID") in created_qids]
        assert len(test_leads) >= 5, f"Only found {len(test_leads)} of the 5 created leads"
        for l in test_leads:
            # Check FIRST assignment (auto-assign), not later manual reassignments
            hist = l.get("assignment_history") or []
            first_assign = hist[0] if hist else {"user_id": l.get("assigned_to"), "by": None}
            assert first_assign.get("by") is None, f"Unexpected manual first-assign: {first_assign}"
            assert first_assign.get("user_id") != admin_id, \
                f"Admin auto-assigned on create: lead={l['id']} hist={hist}"
            assigned.append(first_assign.get("user_id"))
        assert any(a for a in assigned)

    def test_admin_can_be_manually_assigned(self, admin_ctx, ravi_ctx):
        admin_id = admin_ctx["user"]["id"]
        # Take any lead assigned to ravi and reassign to admin
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        any_lead = leads[0] if leads else None
        assert any_lead is not None
        r = requests.post(
            f"{API}/leads/{any_lead['id']}/reassign",
            json={"assigned_to": admin_id},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 200, r.text
        reloaded = requests.get(f"{API}/leads/{any_lead['id']}", headers=admin_ctx["h"], timeout=20).json()
        assert reloaded.get("assigned_to") == admin_id
