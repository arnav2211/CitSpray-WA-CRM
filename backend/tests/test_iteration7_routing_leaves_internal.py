"""Iteration 7: Buyleads routing, Leave management, Internal Q&A chat.
Tests the three new feature groups end-to-end via the public REACT_APP_BACKEND_URL.
"""
import os
import time
import uuid
import pytest
import requests
from datetime import date, timedelta

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=20)
    if r.status_code != 200:
        return ""
    return r.json().get("token") or ""


@pytest.fixture(scope="module")
def admin_token():
    t = _login("admin", "Admin@123")
    if not t:
        pytest.skip("admin login failed")
    return t


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def execs(admin_h):
    r = requests.get(f"{API}/users", headers=admin_h, timeout=20)
    assert r.status_code == 200
    users = r.json()
    by_uname = {u["username"]: u for u in users if u.get("role") == "executive"}
    if "ravi" not in by_uname or "priya" not in by_uname:
        pytest.skip("ravi/priya not seeded")
    return {"ravi": by_uname["ravi"], "priya": by_uname["priya"]}


@pytest.fixture(scope="module")
def ravi_token():
    t = _login("ravi", "Exec@123")
    if not t:
        pytest.skip("ravi login failed")
    return t


@pytest.fixture(scope="module")
def priya_token():
    t = _login("priya", "Exec@123")
    if not t:
        pytest.skip("priya login failed")
    return t


def _reset_routing(admin_h):
    for src in ("IndiaMART", "ExportersIndia"):
        requests.put(f"{API}/settings/buyleads-routing/{src}", headers=admin_h,
                     json={"mode": "all", "agent_ids": []}, timeout=15)


def _cancel_user_leaves(admin_h, user_id):
    r = requests.get(f"{API}/leaves", headers=admin_h, params={"user_id": user_id}, timeout=15)
    if r.status_code == 200:
        for lv in r.json():
            if not lv.get("cancelled"):
                requests.post(f"{API}/leaves/{lv['id']}/cancel", headers=admin_h, timeout=15)


# -------- Buyleads routing --------
class TestBuyleadsRouting:
    def test_get_routing_returns_configs_and_executives(self, admin_h):
        _reset_routing(admin_h)
        r = requests.get(f"{API}/settings/buyleads-routing", headers=admin_h, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "configs" in data and "executives" in data
        sources = {c["source"] for c in data["configs"]}
        assert {"IndiaMART", "ExportersIndia"}.issubset(sources)

    def test_non_admin_blocked(self, ravi_token):
        h = {"Authorization": f"Bearer {ravi_token}"}
        r = requests.get(f"{API}/settings/buyleads-routing", headers=h, timeout=15)
        assert r.status_code == 403

    def test_indiamart_buylead_with_selected_routes_to_priya(self, admin_h, execs):
        # Configure IndiaMART -> selected[priya]
        priya_id = execs["priya"]["id"]
        r = requests.put(f"{API}/settings/buyleads-routing/IndiaMART", headers=admin_h,
                        json={"mode": "selected", "agent_ids": [priya_id]}, timeout=15)
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["mode"] == "selected" and priya_id in cfg["agent_ids"]

        # Send IndiaMART buylead webhook
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"BL Buyer {unique}",
            "SENDER_MOBILE": f"99999{unique[:5]}",
            "SUBJECT": "Bulk steel buy lead",
            "QUERY_TYPE": "B",
            "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 10:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        assert wr.status_code == 200, wr.text
        created = wr.json().get("created", [])
        assert len(created) == 1
        # Verify lead routed to priya
        lr = requests.get(f"{API}/leads/{created[0]}", headers=admin_h, timeout=15)
        assert lr.status_code == 200
        lead = lr.json()
        assert lead.get("assigned_to") == priya_id, f"expected priya, got {lead.get('assigned_to')}"

    def test_non_buylead_indiamart_uses_default_rr(self, admin_h, execs):
        # Mode still selected[priya] but QUERY_TYPE=W → default RR
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"NB Buyer {unique}",
            "SENDER_MOBILE": f"88888{unique[:5]}",
            "SUBJECT": "Direct enquiry",
            "QUERY_TYPE": "W",
            "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 11:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        assert wr.status_code == 200
        created = wr.json().get("created", [])
        assert len(created) == 1
        lr = requests.get(f"{API}/leads/{created[0]}", headers=admin_h, timeout=15)
        assert lr.status_code == 200
        # Should be either priya or ravi (default RR), but not stuck on selected list logic
        assert lr.json().get("assigned_to") in (execs["priya"]["id"], execs["ravi"]["id"])

    def test_change_routing_does_not_reassign_existing(self, admin_h, execs):
        # Create a buylead routed to priya
        priya_id = execs["priya"]["id"]
        ravi_id = execs["ravi"]["id"]
        requests.put(f"{API}/settings/buyleads-routing/IndiaMART", headers=admin_h,
                     json={"mode": "selected", "agent_ids": [priya_id]}, timeout=15)
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"Stay Buyer {unique}",
            "SENDER_MOBILE": f"77777{unique[:5]}",
            "QUERY_TYPE": "B", "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 12:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lid = wr.json()["created"][0]
        # Change routing to ravi only
        requests.put(f"{API}/settings/buyleads-routing/IndiaMART", headers=admin_h,
                     json={"mode": "selected", "agent_ids": [ravi_id]}, timeout=15)
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        assert lr.json().get("assigned_to") == priya_id, "existing lead should not be reassigned"

    def test_mode_all_resets_buyleads_to_default_rr(self, admin_h, execs):
        r = requests.put(f"{API}/settings/buyleads-routing/IndiaMART", headers=admin_h,
                        json={"mode": "all", "agent_ids": []}, timeout=15)
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["mode"] == "all"
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"All Buyer {unique}",
            "SENDER_MOBILE": f"66666{unique[:5]}",
            "QUERY_TYPE": "B", "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 13:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lid = wr.json()["created"][0]
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        # Default RR allowed both — just must have assignee
        assert lr.json().get("assigned_to") in (execs["priya"]["id"], execs["ravi"]["id"])

    def test_exportersindia_buylead_routes_to_selected(self, admin_h, execs):
        # Routing logic is the same `_is_buylead` path; test via manual lead-create
        # since the public ExportersIndia webhook requires an API key in this env.
        ravi_id = execs["ravi"]["id"]
        r = requests.put(f"{API}/settings/buyleads-routing/ExportersIndia", headers=admin_h,
                        json={"mode": "selected", "agent_ids": [ravi_id]}, timeout=15)
        assert r.status_code == 200
        unique = str(uuid.uuid4())[:8]
        # Create lead as admin without explicit assignee so auto-assign + buyleads
        # routing kicks in. enquiry_type=buyleads + source=ExportersIndia → buylead.
        cr = requests.post(f"{API}/leads", headers=admin_h, json={
            "customer_name": f"EI Buyer {unique}",
            "phone": f"5555{unique}",
            "requirement": "Buy lead via EI",
            "source": "ExportersIndia",
            "enquiry_type": "buyleads",
        }, timeout=15)
        assert cr.status_code in (200, 201), cr.text
        lid = cr.json().get("id")
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        assert lr.json().get("assigned_to") == ravi_id
        _reset_routing(admin_h)


# -------- Leave management --------
class TestLeaveManagement:
    def test_create_active_leave_blocks_executive(self, admin_h, execs, ravi_token):
        _cancel_user_leaves(admin_h, execs["ravi"]["id"])
        today = date.today().isoformat()
        r = requests.post(f"{API}/leaves", headers=admin_h, json={
            "user_id": execs["ravi"]["id"], "start_date": today, "end_date": today,
            "reason": "TEST_iter7"
        }, timeout=15)
        assert r.status_code == 200, r.text
        leave = r.json()
        assert leave["user_id"] == execs["ravi"]["id"]

        # GET /auth/me with ravi token => 401 user_on_leave
        h = {"Authorization": f"Bearer {ravi_token}"}
        me = requests.get(f"{API}/auth/me", headers=h, timeout=15)
        assert me.status_code == 401, me.text
        detail = me.json().get("detail")
        assert isinstance(detail, dict) and detail.get("code") == "user_on_leave"

        # Login fresh as ravi → 403 with code=user_on_leave
        lr = requests.post(f"{API}/auth/login", json={"username": "ravi", "password": "Exec@123"}, timeout=15)
        assert lr.status_code == 403
        d = lr.json().get("detail")
        assert isinstance(d, dict) and d.get("code") == "user_on_leave"

        return leave

    def test_active_leave_excluded_from_auto_assign(self, admin_h, execs):
        # ravi already on leave from previous test
        priya_id = execs["priya"]["id"]
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"AutoAssign {unique}",
            "SENDER_MOBILE": f"44444{unique[:5]}",
            "QUERY_TYPE": "W", "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 14:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lid = wr.json()["created"][0]
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        assert lr.json().get("assigned_to") == priya_id, "ravi on-leave should be skipped"

    def test_pns_receiver_match_skipped_for_on_leave(self, admin_h, execs):
        # Set ravi a receiver number, then send IndiaMART payload with that receiver
        ravi = execs["ravi"]
        recv = "9000011223"
        requests.put(f"{API}/users/{ravi['id']}", headers=admin_h, json={"receiver_numbers": [recv]}, timeout=15)
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"PNS {unique}",
            "SENDER_MOBILE": f"33333{unique[:5]}",
            "RECEIVER_MOBILE": recv,
            "QUERY_TYPE": "W", "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 15:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lid = wr.json()["created"][0]
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        # Should be assigned to priya (RR fallback) instead of ravi
        assert lr.json().get("assigned_to") == execs["priya"]["id"]

    def test_buyleads_allowlist_only_on_leave_falls_back(self, admin_h, execs):
        # selected=[ravi only], ravi on leave → should fall back to default RR (priya)
        ravi_id = execs["ravi"]["id"]
        priya_id = execs["priya"]["id"]
        requests.put(f"{API}/settings/buyleads-routing/IndiaMART", headers=admin_h,
                     json={"mode": "selected", "agent_ids": [ravi_id]}, timeout=15)
        unique = str(uuid.uuid4())[:8]
        payload = {"RESPONSE": [{
            "SENDER_NAME": f"BLOnly {unique}",
            "SENDER_MOBILE": f"22222{unique[:5]}",
            "QUERY_TYPE": "B", "UNIQUE_QUERY_ID": unique,
            "QUERY_TIME": "2026-01-15 16:00:00",
        }]}
        wr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lid = wr.json()["created"][0]
        lr = requests.get(f"{API}/leads/{lid}", headers=admin_h, timeout=15)
        assert lr.json().get("assigned_to") == priya_id
        _reset_routing(admin_h)

    def test_patch_leave(self, admin_h, execs):
        # Find ravi's leave
        r = requests.get(f"{API}/leaves", headers=admin_h, params={"user_id": execs["ravi"]["id"]}, timeout=15)
        active = [lv for lv in r.json() if not lv.get("cancelled")]
        assert active, "no active leave for ravi"
        lv = active[0]
        new_end = (date.today() + timedelta(days=2)).isoformat()
        pr = requests.patch(f"{API}/leaves/{lv['id']}", headers=admin_h,
                            json={"end_date": new_end, "reason": "TEST_iter7_updated"}, timeout=15)
        assert pr.status_code == 200, pr.text
        assert pr.json().get("end_date") == new_end

    def test_cancel_leave_reinstates_access(self, admin_h, execs):
        _cancel_user_leaves(admin_h, execs["ravi"]["id"])
        # Now ravi can login again
        lr = requests.post(f"{API}/auth/login", json={"username": "ravi", "password": "Exec@123"}, timeout=15)
        assert lr.status_code == 200, lr.text
        ntoken = lr.json()["token"]
        me = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {ntoken}"}, timeout=15)
        assert me.status_code == 200

    def test_future_leave_does_not_block(self, admin_h, execs):
        future = (date.today() + timedelta(days=5)).isoformat()
        future_end = (date.today() + timedelta(days=7)).isoformat()
        r = requests.post(f"{API}/leaves", headers=admin_h, json={
            "user_id": execs["ravi"]["id"], "start_date": future, "end_date": future_end,
            "reason": "TEST_iter7_future"
        }, timeout=15)
        assert r.status_code == 200
        # ravi can login & access /me
        lr = requests.post(f"{API}/auth/login", json={"username": "ravi", "password": "Exec@123"}, timeout=15)
        assert lr.status_code == 200
        me = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {lr.json()['token']}"}, timeout=15)
        assert me.status_code == 200
        # cleanup future leave
        _cancel_user_leaves(admin_h, execs["ravi"]["id"])


# -------- Internal Q&A --------
class TestInternalChat:
    @pytest.fixture(scope="class")
    def lead_for_ravi(self, admin_h, execs):
        # create a lead and assign to ravi
        ravi_id = execs["ravi"]["id"]
        unique = str(uuid.uuid4())[:8]
        r = requests.post(f"{API}/leads", headers=admin_h, json={
            "customer_name": f"IC {unique}", "phone": f"7000{unique}",
            "requirement": "internal-chat test", "source": "Manual",
            "assigned_to": ravi_id,
        }, timeout=15)
        assert r.status_code in (200, 201), r.text
        return r.json()

    def test_executive_send_on_own_lead(self, lead_for_ravi, ravi_token):
        h = {"Authorization": f"Bearer {ravi_token}"}
        r = requests.post(f"{API}/internal-chat/send", headers=h, json={
            "lead_id": lead_for_ravi["id"], "body": "Hi admin, question about this lead"
        }, timeout=15)
        assert r.status_code == 200, r.text
        msg = r.json()
        assert msg["agent_id"] == lead_for_ravi["assigned_to"]
        assert msg["from_role"] == "executive"

    def test_executive_send_on_other_lead_403(self, lead_for_ravi, priya_token):
        h = {"Authorization": f"Bearer {priya_token}"}
        r = requests.post(f"{API}/internal-chat/send", headers=h, json={
            "lead_id": lead_for_ravi["id"], "body": "Sneaky"
        }, timeout=15)
        assert r.status_code == 403

    def test_executive_get_other_lead_403(self, lead_for_ravi, priya_token):
        h = {"Authorization": f"Bearer {priya_token}"}
        r = requests.get(f"{API}/internal-chat/{lead_for_ravi['id']}", headers=h, timeout=15)
        assert r.status_code == 403

    def test_admin_get_threads_list(self, admin_h, lead_for_ravi):
        r = requests.get(f"{API}/internal-chat/{lead_for_ravi['id']}", headers=admin_h, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "threads" in data
        assert any(t["agent_id"] == lead_for_ravi["assigned_to"] for t in data["threads"])

    def test_admin_get_specific_thread(self, admin_h, lead_for_ravi, execs):
        r = requests.get(f"{API}/internal-chat/{lead_for_ravi['id']}", headers=admin_h,
                        params={"agent_id": execs["ravi"]["id"]}, timeout=15)
        assert r.status_code == 200
        assert "thread" in r.json()

    def test_admin_send_requires_to_user_id(self, admin_h, lead_for_ravi):
        r = requests.post(f"{API}/internal-chat/send", headers=admin_h, json={
            "lead_id": lead_for_ravi["id"], "body": "Reply without target"
        }, timeout=15)
        assert r.status_code == 400

    def test_admin_send_with_to_user_id(self, admin_h, lead_for_ravi, execs):
        r = requests.post(f"{API}/internal-chat/send", headers=admin_h, json={
            "lead_id": lead_for_ravi["id"], "body": "Hi ravi, here's the answer",
            "to_user_id": execs["ravi"]["id"],
        }, timeout=15)
        assert r.status_code == 200
        msg = r.json()
        assert msg["agent_id"] == execs["ravi"]["id"]
        assert msg["from_role"] == "admin"

    def test_mark_read(self, ravi_token, lead_for_ravi):
        h = {"Authorization": f"Bearer {ravi_token}"}
        r = requests.post(f"{API}/internal-chat/{lead_for_ravi['id']}/mark-read", headers=h, timeout=15)
        assert r.status_code == 200
        assert r.json().get("ok") is True
