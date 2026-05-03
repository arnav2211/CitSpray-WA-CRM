"""Iteration-7 ChatFlow engine tests.

Covers: admin-only CRUD; node CRUD + options replace; flow start (text/button/list);
button >3 options validation; 24h-window respect; webhook button_reply / list_reply
dispatch; edge cases; chat_sessions persistence; api_version not hardcoded.
"""
import os
import re
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=30)
    assert r.status_code == 200, f"login failed {u}: {r.status_code} {r.text}"
    return r.json()["token"]


def _h(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "Admin@123")


@pytest.fixture(scope="module")
def ravi_token(admin_token):
    try:
        return _login("ravi", "Exec@123")
    except AssertionError:
        users = requests.get(f"{API}/users", headers=_h(admin_token), timeout=30).json()
        r = next((u for u in users if u.get("username") == "ravi"), None)
        if r:
            requests.patch(f"{API}/users/{r['id']}", headers=_h(admin_token),
                           json={"password": "Exec@123"}, timeout=30)
        return _login("ravi", "Exec@123")


# Track flows & leads created to clean up at module teardown
CREATED_FLOWS: list = []
CREATED_LEAD_PHONES: list = []


@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_token):
    yield
    for fid in CREATED_FLOWS:
        try:
            requests.delete(f"{API}/chatflows/{fid}", headers=_h(admin_token), timeout=30)
        except Exception:
            pass


def _rand10():
    n = "".join(str((uuid.uuid4().int >> (i * 8)) % 10) for i in range(10))
    if n[0] in "01":
        n = "9" + n[1:]
    return n


def _create_flow(token, name, active=False):
    r = requests.post(f"{API}/chatflows", headers=_h(token),
                      json={"name": name, "is_active": active}, timeout=30)
    assert r.status_code == 200, r.text
    f = r.json()
    CREATED_FLOWS.append(f["id"])
    return f


def _create_node(token, fid, name, mtype, body="hello", is_start=False, header=None,
                 footer=None, button_text=None):
    content = {"body": body}
    if header:
        content["header"] = header
    if footer:
        content["footer"] = footer
    if button_text:
        content["button_text"] = button_text
    r = requests.post(f"{API}/chatflows/{fid}/nodes", headers=_h(token), json={
        "name": name, "message_type": mtype, "message_content": content,
        "is_start_node": is_start,
    }, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _put_options(token, fid, nid, options):
    r = requests.put(f"{API}/chatflows/{fid}/nodes/{nid}/options",
                     headers=_h(token), json=options, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# ---------- RBAC ----------
class TestRBAC:
    def test_executive_403_on_chatflows_list(self, ravi_token):
        r = requests.get(f"{API}/chatflows", headers=_h(ravi_token), timeout=30)
        assert r.status_code == 403, f"exec must be 403, got {r.status_code}"

    def test_executive_403_on_chatflows_create(self, ravi_token):
        r = requests.post(f"{API}/chatflows", headers=_h(ravi_token),
                          json={"name": "TEST_IT7_RBAC"}, timeout=30)
        assert r.status_code == 403

    def test_executive_403_on_chat_sessions(self, ravi_token):
        r = requests.get(f"{API}/chat-sessions", headers=_h(ravi_token), timeout=30)
        assert r.status_code == 403


# ---------- Flow CRUD ----------
class TestFlowCRUD:
    def test_create_active_deactivates_others(self, admin_token):
        f1 = _create_flow(admin_token, f"TEST_IT7_F1_{uuid.uuid4().hex[:6]}", active=True)
        f2 = _create_flow(admin_token, f"TEST_IT7_F2_{uuid.uuid4().hex[:6]}", active=True)
        # Re-fetch f1 and verify it was deactivated
        g = requests.get(f"{API}/chatflows/{f1['id']}", headers=_h(admin_token), timeout=30).json()
        assert g["is_active"] is False, "Activating f2 should have deactivated f1"
        g2 = requests.get(f"{API}/chatflows/{f2['id']}", headers=_h(admin_token), timeout=30).json()
        assert g2["is_active"] is True

    def test_get_returns_nodes_and_options_grouped(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_GETF_{uuid.uuid4().hex[:6]}")
        n1 = _create_node(admin_token, f["id"], "Greet", "button", body="Hi", is_start=True)
        n2 = _create_node(admin_token, f["id"], "Thanks", "text", body="Thanks!")
        _put_options(admin_token, f["id"], n1["id"], [
            {"option_id": "buy", "label": "Buy", "next_node_id": n2["id"], "position": 0},
            {"option_id": "info", "label": "Info", "position": 1},
        ])
        g = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30).json()
        assert any(n["id"] == n1["id"] for n in g["nodes"])
        # options should be grouped under node
        for nd in g["nodes"]:
            if nd["id"] == n1["id"]:
                assert len(nd.get("options", [])) == 2
                assert {o["option_id"] for o in nd["options"]} == {"buy", "info"}

    def test_patch_name_and_active(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_PATCH_{uuid.uuid4().hex[:6]}")
        r = requests.patch(f"{API}/chatflows/{f['id']}", headers=_h(admin_token),
                           json={"name": "TEST_IT7_PATCHED", "description": "d"}, timeout=30)
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_IT7_PATCHED"

    def test_delete_cascades(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_DEL_{uuid.uuid4().hex[:6]}")
        n = _create_node(admin_token, f["id"], "N", "button", body="X", is_start=True)
        _put_options(admin_token, f["id"], n["id"], [{"option_id": "a", "label": "A", "position": 0}])
        r = requests.delete(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200
        g = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30)
        assert g.status_code == 404
        if f["id"] in CREATED_FLOWS:
            CREATED_FLOWS.remove(f["id"])


# ---------- Node CRUD ----------
class TestNodeCRUD:
    def test_node_is_start_deactivates_others(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_NSTART_{uuid.uuid4().hex[:6]}")
        n1 = _create_node(admin_token, f["id"], "N1", "text", is_start=True)
        n2 = _create_node(admin_token, f["id"], "N2", "text", is_start=True)
        g = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30).json()
        starts = [n for n in g["nodes"] if n.get("is_start_node")]
        assert len(starts) == 1 and starts[0]["id"] == n2["id"]

    def test_node_delete_clears_next_node_refs(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_NDEL_{uuid.uuid4().hex[:6]}")
        n1 = _create_node(admin_token, f["id"], "N1", "button", is_start=True)
        n2 = _create_node(admin_token, f["id"], "N2", "text")
        _put_options(admin_token, f["id"], n1["id"], [
            {"option_id": "go", "label": "Go", "next_node_id": n2["id"], "position": 0}
        ])
        # Delete n2
        r = requests.delete(f"{API}/chatflows/{f['id']}/nodes/{n2['id']}",
                            headers=_h(admin_token), timeout=30)
        assert r.status_code == 200
        # Re-fetch flow → option's next_node_id should now be null
        g = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30).json()
        for nd in g["nodes"]:
            if nd["id"] == n1["id"]:
                for o in nd.get("options", []):
                    if o["option_id"] == "go":
                        assert o.get("next_node_id") in (None, ""), \
                            f"next_node_id should be cleared, got {o.get('next_node_id')}"

    def test_options_replace_full_set(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_OPTREP_{uuid.uuid4().hex[:6]}")
        n = _create_node(admin_token, f["id"], "N", "button", is_start=True)
        _put_options(admin_token, f["id"], n["id"], [
            {"option_id": "a", "label": "A", "position": 0},
            {"option_id": "b", "label": "B", "position": 1},
        ])
        # Replace with single option
        _put_options(admin_token, f["id"], n["id"], [{"option_id": "c", "label": "C", "position": 0}])
        g = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30).json()
        for nd in g["nodes"]:
            if nd["id"] == n["id"]:
                assert [o["option_id"] for o in nd.get("options", [])] == ["c"]


# ---------- Interactive payload validation ----------
class TestPayloadValidation:
    def test_button_more_than_3_options_start_fails(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_BTNMAX_{uuid.uuid4().hex[:6]}", active=False)
        n = _create_node(admin_token, f["id"], "Greet", "button", body="Pick", is_start=True)
        _put_options(admin_token, f["id"], n["id"], [
            {"option_id": f"o{i}", "label": f"Opt{i}", "position": i} for i in range(4)
        ])
        # open 24h via simulate first
        phone = _rand10()
        requests.post(f"{API}/webhooks/whatsapp/_debug/simulate", headers=_h(admin_token),
                      json={"from_phone": phone, "name": "T", "body": "hi"}, timeout=30)
        r = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert r.status_code == 200
        d = r.json()
        # Should surface error about max 3 buttons
        assert d.get("error") and "3" in str(d["error"]), f"expected 3-button error, got {d}"

    def test_list_node_no_options_fails_on_start(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_LISTEMPTY_{uuid.uuid4().hex[:6]}")
        n = _create_node(admin_token, f["id"], "L", "list", body="pick", is_start=True,
                         button_text="Choose")
        phone = _rand10()
        requests.post(f"{API}/webhooks/whatsapp/_debug/simulate", headers=_h(admin_token),
                      json={"from_phone": phone, "name": "T", "body": "hi"}, timeout=30)
        r = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d.get("error") and "option" in d["error"].lower()


# ---------- Flow start ----------
class TestFlowStart:
    def test_text_node_sends_without_24h(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_TXT_{uuid.uuid4().hex[:6]}")
        _create_node(admin_token, f["id"], "Hi", "text", body="Hello there", is_start=True)
        phone = _rand10()  # no lead exists → text always sends (Meta gates)
        r = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d.get("status") in ("sent", "sent_mock"), f"text node status={d}"

    def test_button_outside_24h_skipped_when_lead_exists(self, admin_token):
        # Create a lead via manual POST, no inbound message → no last_user_message_at
        f = _create_flow(admin_token, f"TEST_IT7_BTNSKIP_{uuid.uuid4().hex[:6]}")
        n = _create_node(admin_token, f["id"], "Greet", "button", body="Pick", is_start=True)
        _put_options(admin_token, f["id"], n["id"], [
            {"option_id": "a", "label": "A", "position": 0},
            {"option_id": "b", "label": "B", "position": 1},
        ])
        phone = _rand10()
        users = requests.get(f"{API}/users", headers=_h(admin_token), timeout=30).json()
        admin_id = next(u["id"] for u in users if u["username"] == "admin")
        # create lead WITHOUT inbound (no 24h window)
        r = requests.post(f"{API}/leads", headers=_h(admin_token), json={
            "customer_name": f"TEST_IT7_BTN_{phone}", "phone": phone, "source": "Manual",
            "assigned_to": admin_id,
        }, timeout=30)
        assert r.status_code == 200
        CREATED_LEAD_PHONES.append(phone)
        r2 = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                           json={"phone": phone}, timeout=30)
        assert r2.status_code == 200
        d = r2.json()
        assert d.get("status") == "skipped_outside_24h", \
            f"expected skipped_outside_24h, got {d}"

    def test_button_inside_24h_sends_after_simulate(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_BTNOK_{uuid.uuid4().hex[:6]}")
        n = _create_node(admin_token, f["id"], "Greet", "button", body="Pick one", is_start=True)
        _put_options(admin_token, f["id"], n["id"], [
            {"option_id": "yes", "label": "Yes", "position": 0},
            {"option_id": "no", "label": "No", "position": 1},
        ])
        phone = _rand10()
        sim = requests.post(f"{API}/webhooks/whatsapp/_debug/simulate",
                            headers=_h(admin_token),
                            json={"from_phone": phone, "name": "Sim", "body": "hi"},
                            timeout=30)
        assert sim.status_code == 200, sim.text
        time.sleep(0.5)
        r = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d.get("status") in ("sent", "sent_mock"), \
            f"24h-open button should send, got {d}"
        assert d.get("node_id") == n["id"]


# ---------- chat_sessions persistence ----------
class TestChatSessions:
    def test_chat_sessions_after_send(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_SESS_{uuid.uuid4().hex[:6]}")
        _create_node(admin_token, f["id"], "Hi", "text", body="hello", is_start=True)
        phone = _rand10()
        r = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert r.status_code == 200 and r.json().get("status") in ("sent", "sent_mock")
        time.sleep(0.5)
        sess = requests.get(f"{API}/chat-sessions", headers=_h(admin_token), timeout=30).json()
        key = phone[-10:]
        match = [s for s in sess if s.get("phone_key") == key]
        assert match, f"no chat_session for phone_key {key}"
        s = match[0]
        assert s.get("current_flow_id") == f["id"]
        assert s.get("current_node_id")
        assert s.get("last_interaction_at")


# ---------- Webhook dispatch button_reply / list_reply ----------
def _send_inbound_interactive(phone, kind, opt_id):
    """Build a minimal Meta-style webhook payload with interactive button_reply or list_reply."""
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "0",
            "changes": [{
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {"phone_number_id": "0"},
                    "contacts": [{"profile": {"name": "Tester"}, "wa_id": phone}],
                    "messages": [{
                        "from": phone,
                        "id": f"wamid.IT7.{uuid.uuid4().hex[:12]}",
                        "timestamp": str(int(time.time())),
                        "type": "interactive",
                        "interactive": {
                            "type": kind,
                            kind: {"id": opt_id, "title": opt_id},
                        },
                    }],
                },
                "field": "messages",
            }],
        }],
    }
    r = requests.post(f"{API}/webhooks/whatsapp", json=payload, timeout=30)
    return r


class TestWebhookDispatch:
    def _setup_flow(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_WH_{uuid.uuid4().hex[:6]}", active=True)
        greet = _create_node(admin_token, f["id"], "Greet", "button", body="Pick",
                             is_start=True)
        thanks = _create_node(admin_token, f["id"], "Thanks", "text", body="Thanks!")
        info = _create_node(admin_token, f["id"], "Info", "text", body="Here's info")
        _put_options(admin_token, f["id"], greet["id"], [
            {"option_id": "buy", "label": "Buy", "next_node_id": thanks["id"], "position": 0},
            {"option_id": "info", "label": "Info", "next_node_id": info["id"], "position": 1},
        ])
        return f, greet, thanks, info

    def _get_lead_id_by_phone(self, admin_token, phone):
        lst = requests.get(f"{API}/leads", headers=_h(admin_token),
                           params={"q": phone}, timeout=30).json()
        for l in lst:
            if l.get("phone") == phone or (l.get("phone") or "").endswith(phone[-10:]):
                return l["id"]
        return None

    def test_button_reply_advances(self, admin_token):
        f, greet, thanks, info = self._setup_flow(admin_token)
        phone = _rand10()
        # Open 24h
        sim = requests.post(f"{API}/webhooks/whatsapp/_debug/simulate",
                            headers=_h(admin_token),
                            json={"from_phone": phone, "name": "Tester", "body": "hi"},
                            timeout=30)
        assert sim.status_code == 200
        time.sleep(0.3)
        # start flow
        s = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert s.status_code == 200, s.text
        time.sleep(0.3)
        # Send inbound button_reply.id=buy
        r = _send_inbound_interactive(phone, "button_reply", "buy")
        assert r.status_code == 200, r.text
        time.sleep(0.5)
        # Verify outbound message with flow_node_id == thanks["id"]
        lead_id = self._get_lead_id_by_phone(admin_token, phone)
        assert lead_id, f"no lead found for {phone}"
        msgs = requests.get(f"{API}/leads/{lead_id}/messages",
                            headers=_h(admin_token), timeout=30).json()
        out_thanks = [m for m in msgs if m.get("direction") == "out"
                      and m.get("flow_node_id") == thanks["id"]]
        assert out_thanks, f"no outbound flow message with flow_node_id={thanks['id']} found in {len(msgs)} msgs"

    def test_list_reply_advances(self, admin_token):
        f = _create_flow(admin_token, f"TEST_IT7_WH_LIST_{uuid.uuid4().hex[:6]}", active=True)
        greet = _create_node(admin_token, f["id"], "G", "list", body="pick",
                             is_start=True, button_text="Choose")
        target = _create_node(admin_token, f["id"], "T", "text", body="thx")
        _put_options(admin_token, f["id"], greet["id"], [
            {"option_id": "x", "label": "X", "next_node_id": target["id"], "position": 0,
             "section_title": "S"},
        ])
        phone = _rand10()
        requests.post(f"{API}/webhooks/whatsapp/_debug/simulate", headers=_h(admin_token),
                      json={"from_phone": phone, "name": "T", "body": "hi"}, timeout=30)
        time.sleep(0.3)
        s = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert s.status_code == 200 and s.json().get("status") in ("sent", "sent_mock"), s.text
        time.sleep(0.3)
        r = _send_inbound_interactive(phone, "list_reply", "x")
        assert r.status_code == 200
        time.sleep(0.5)
        lead_id = self._get_lead_id_by_phone(admin_token, phone)
        assert lead_id
        msgs = requests.get(f"{API}/leads/{lead_id}/messages",
                            headers=_h(admin_token), timeout=30).json()
        assert any(m.get("direction") == "out" and m.get("flow_node_id") == target["id"]
                   for m in msgs), "list_reply did not advance to next node"

    def test_unknown_option_keeps_session(self, admin_token):
        f, greet, thanks, info = self._setup_flow(admin_token)
        phone = _rand10()
        requests.post(f"{API}/webhooks/whatsapp/_debug/simulate", headers=_h(admin_token),
                      json={"from_phone": phone, "name": "T", "body": "hi"}, timeout=30)
        time.sleep(0.3)
        s = requests.post(f"{API}/chatflows/{f['id']}/start", headers=_h(admin_token),
                          json={"phone": phone}, timeout=30)
        assert s.status_code == 200
        time.sleep(0.3)
        sess_before = requests.get(f"{API}/chat-sessions", headers=_h(admin_token),
                                    timeout=30).json()
        s_before = next((s for s in sess_before if s.get("phone_key") == phone[-10:]), None)
        assert s_before
        # Unknown option
        r = _send_inbound_interactive(phone, "button_reply", "no_such_opt_xyz")
        assert r.status_code == 200
        time.sleep(0.5)
        sess_after = requests.get(f"{API}/chat-sessions", headers=_h(admin_token),
                                   timeout=30).json()
        s_after = next((s for s in sess_after if s.get("phone_key") == phone[-10:]), None)
        assert s_after
        assert s_after["current_node_id"] == s_before["current_node_id"], \
            "session should NOT advance on unknown option"

    def test_no_session_inbound_starts_active_flow(self, admin_token):
        # Create active flow
        f = _create_flow(admin_token, f"TEST_IT7_AUTO_{uuid.uuid4().hex[:6]}", active=True)
        greet = _create_node(admin_token, f["id"], "G", "button", body="pick",
                             is_start=True)
        nxt = _create_node(admin_token, f["id"], "N", "text", body="ok")
        _put_options(admin_token, f["id"], greet["id"], [
            {"option_id": "go", "label": "Go", "next_node_id": nxt["id"], "position": 0},
        ])
        phone = _rand10()
        # The inbound itself opens 24h window AND triggers the dispatch
        r = _send_inbound_interactive(phone, "button_reply", "go")
        assert r.status_code == 200
        time.sleep(0.5)
        lead_id = None
        for _ in range(3):
            lst = requests.get(f"{API}/leads", headers=_h(admin_token),
                               params={"q": phone}, timeout=30).json()
            if lst:
                lead_id = lst[0]["id"]
                break
            time.sleep(0.3)
        assert lead_id, "no lead auto-created"
        msgs = requests.get(f"{API}/leads/{lead_id}/messages",
                            headers=_h(admin_token), timeout=30).json()
        assert any(m.get("direction") == "out" and m.get("flow_node_id") == nxt["id"]
                   for m in msgs), "auto-start path did not advance to next node"


# ---------- API version not hardcoded ----------
class TestApiVersionDynamic:
    def test_no_hardcoded_v_prefixed_versions_in_server(self):
        with open("/app/backend/server.py", "r") as fh:
            src = fh.read()
        # Find any literal vNN.0 strings outside of WHATSAPP_API_VERSION default
        bad = []
        for m in re.finditer(r"['\"]v\d+\.0['\"]", src):
            line_start = src.rfind("\n", 0, m.start()) + 1
            line_end = src.find("\n", m.end())
            line = src[line_start:line_end]
            # Allow only the WHATSAPP_API_VERSION default
            if "WHATSAPP_API_VERSION" in line:
                continue
            bad.append((line.strip(), m.group()))
        assert not bad, f"Found hardcoded WA api versions: {bad}"

    def test_wa_send_interactive_uses_cfg_api_version(self):
        with open("/app/backend/server.py", "r") as fh:
            src = fh.read()
        # find wa_send_interactive function block
        i = src.find("async def wa_send_interactive")
        assert i > -1
        # next def
        j = src.find("\nasync def ", i + 10)
        block = src[i:j if j > -1 else len(src)]
        assert "cfg['api_version']" in block or 'cfg["api_version"]' in block, \
            "wa_send_interactive must read cfg['api_version']"
