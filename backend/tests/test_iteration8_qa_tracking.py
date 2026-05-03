"""Iteration 8: Centralized Internal Q&A tracking endpoint + inbox internal_qa_status field.

Covers:
- GET /api/internal-qa/threads (admin → all, executive → own only, filters: status/agent_id/q)
- GET /api/inbox/conversations now includes `internal_qa_status` per conversation
- Status flips: pending when last_msg.from_role==executive, answered when admin replies
- Access control regression on /api/internal-chat/* for unassigned leads
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=20)
    if r.status_code != 200:
        return ""
    return r.json().get("token") or ""


@pytest.fixture(scope="module")
def admin_h():
    t = _login("admin", "Admin@123")
    if not t:
        pytest.skip("admin login failed")
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def ravi_h():
    t = _login("ravi", "Exec@123")
    if not t:
        pytest.skip("ravi login failed")
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def priya_h():
    t = _login("priya", "Exec@123")
    if not t:
        pytest.skip("priya login failed")
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def execs(admin_h):
    r = requests.get(f"{API}/users", headers=admin_h, timeout=20)
    assert r.status_code == 200
    by = {u["username"]: u for u in r.json() if u.get("role") == "executive"}
    if "ravi" not in by or "priya" not in by:
        pytest.skip("ravi/priya not seeded")
    return by


@pytest.fixture(scope="module")
def admin_user(admin_h):
    r = requests.get(f"{API}/auth/me", headers=admin_h, timeout=15)
    assert r.status_code == 200
    return r.json()


def _create_lead_for(admin_h, exec_user) -> str:
    payload = {
        "customer_name": f"TEST_iter8_{uuid.uuid4().hex[:6]}",
        "phone": f"99999{uuid.uuid4().int % 100000:05d}",
        "source": "Manual",
        "requirement": "iter8 qa tracking test",
        "assigned_to": exec_user["id"],
    }
    r = requests.post(f"{API}/leads", headers=admin_h, json=payload, timeout=15)
    assert r.status_code in (200, 201), f"create lead failed: {r.status_code} {r.text}"
    return r.json()["id"]


# ---------------- /api/internal-qa/threads ----------------
class TestInternalQAThreads:
    def test_admin_returns_all_threads_with_required_fields(self, admin_h, execs, ravi_h):
        # seed: a fresh pending thread for ravi
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        snd = requests.post(
            f"{API}/internal-chat/send",
            headers=ravi_h,
            json={"lead_id": lead_id, "body": "iter8 pending question"},
            timeout=15,
        )
        assert snd.status_code == 200, snd.text

        r = requests.get(f"{API}/internal-qa/threads", headers=admin_h, timeout=20)
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        assert len(rows) >= 1
        # Find our row
        mine = [x for x in rows if x.get("lead_id") == lead_id and x.get("agent_id") == ravi["id"]]
        assert mine, f"freshly seeded thread not in admin list (got {len(rows)})"
        row = mine[0]
        required = {
            "lead_id", "agent_id", "agent_name", "agent_username",
            "replied_by", "lead_customer_name", "lead_phone",
            "status", "first_asked_at", "last_asked_at",
            "last_replied_at", "last_body", "count", "unread_for_me",
        }
        missing = required - set(row.keys())
        assert not missing, f"missing fields: {missing}"
        assert row["status"] == "pending"
        assert row["agent_username"] == "ravi"
        assert row["count"] >= 1
        assert "iter8 pending question" in (row.get("last_body") or "")

    def test_executive_sees_only_own_threads(self, admin_h, execs, ravi_h, priya_h):
        # Seed Priya's thread
        priya = execs["priya"]
        priya_lead = _create_lead_for(admin_h, priya)
        snd = requests.post(
            f"{API}/internal-chat/send",
            headers=priya_h,
            json={"lead_id": priya_lead, "body": "iter8 priya question"},
            timeout=15,
        )
        assert snd.status_code == 200

        # Ravi should NOT see Priya's thread
        r = requests.get(f"{API}/internal-qa/threads", headers=ravi_h, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert all(x.get("agent_username") == "ravi" for x in rows), \
            f"executive isolation broken — found non-ravi: {[x.get('agent_username') for x in rows if x.get('agent_username') != 'ravi']}"
        assert all(x.get("lead_id") != priya_lead for x in rows), "ravi should not see priya's lead thread"

        # Priya should see her own
        r2 = requests.get(f"{API}/internal-qa/threads", headers=priya_h, timeout=20)
        assert r2.status_code == 200
        priya_rows = r2.json()
        assert any(x.get("lead_id") == priya_lead for x in priya_rows)
        assert all(x.get("agent_username") == "priya" for x in priya_rows)

    def test_status_filter_pending_only(self, admin_h):
        r = requests.get(f"{API}/internal-qa/threads", headers=admin_h, params={"status": "pending"}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert all(x.get("status") == "pending" for x in rows), "non-pending leaked into status=pending"

    def test_status_filter_answered_only(self, admin_h, execs, ravi_h):
        # Make sure at least one answered thread exists: reply to ravi's thread
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        requests.post(f"{API}/internal-chat/send", headers=ravi_h,
                      json={"lead_id": lead_id, "body": "iter8 q to answer"}, timeout=15)
        rep = requests.post(f"{API}/internal-chat/send", headers=admin_h,
                            json={"lead_id": lead_id, "to_user_id": ravi["id"], "body": "iter8 admin reply"},
                            timeout=15)
        assert rep.status_code == 200, rep.text

        r = requests.get(f"{API}/internal-qa/threads", headers=admin_h, params={"status": "answered"}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert all(x.get("status") == "answered" for x in rows), "non-answered leaked into status=answered"
        # The reply we just made should be there
        ours = [x for x in rows if x.get("lead_id") == lead_id and x.get("agent_id") == ravi["id"]]
        assert ours, "answered thread we just created not in answered filter"
        row = ours[0]
        assert row.get("replied_by") and row["replied_by"].get("username") == "admin"
        assert row.get("last_replied_at") is not None
        assert row.get("last_from_role") == "admin"

    def test_admin_filter_by_agent_id(self, admin_h, execs):
        priya = execs["priya"]
        r = requests.get(f"{API}/internal-qa/threads", headers=admin_h, params={"agent_id": priya["id"]}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert all(x.get("agent_id") == priya["id"] for x in rows), "agent_id filter leaked other agents"

    def test_executive_agent_id_filter_ignored(self, ravi_h, execs):
        # Executive should NEVER be able to see another agent's thread even with ?agent_id=
        priya = execs["priya"]
        r = requests.get(f"{API}/internal-qa/threads", headers=ravi_h, params={"agent_id": priya["id"]}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert all(x.get("agent_username") == "ravi" for x in rows), "executive agent_id filter broke isolation"

    def test_free_text_search(self, admin_h, execs, ravi_h):
        ravi = execs["ravi"]
        marker = f"iter8mark{uuid.uuid4().hex[:8]}"
        lead_id = _create_lead_for(admin_h, ravi)
        snd = requests.post(f"{API}/internal-chat/send", headers=ravi_h,
                            json={"lead_id": lead_id, "body": f"hello {marker} world"}, timeout=15)
        assert snd.status_code == 200
        r = requests.get(f"{API}/internal-qa/threads", headers=admin_h, params={"q": marker}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert any(x.get("lead_id") == lead_id for x in rows), "search by last_body marker did not return thread"
        for row in rows:
            blob = " ".join([
                row.get("lead_customer_name") or "",
                row.get("agent_name") or "",
                row.get("last_body") or "",
                row.get("lead_phone") or "",
            ]).lower()
            assert marker.lower() in blob

    def test_status_flips_pending_to_answered(self, admin_h, execs, ravi_h):
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        # Step 1: pending
        requests.post(f"{API}/internal-chat/send", headers=ravi_h,
                      json={"lead_id": lead_id, "body": "flip test q"}, timeout=15)
        r1 = requests.get(f"{API}/internal-qa/threads", headers=admin_h,
                          params={"agent_id": ravi["id"]}, timeout=20)
        assert r1.status_code == 200
        row1 = next((x for x in r1.json() if x["lead_id"] == lead_id), None)
        assert row1 and row1["status"] == "pending"
        # Step 2: admin reply
        requests.post(f"{API}/internal-chat/send", headers=admin_h,
                      json={"lead_id": lead_id, "to_user_id": ravi["id"], "body": "flip test reply"}, timeout=15)
        r2 = requests.get(f"{API}/internal-qa/threads", headers=admin_h,
                          params={"agent_id": ravi["id"]}, timeout=20)
        row2 = next((x for x in r2.json() if x["lead_id"] == lead_id), None)
        assert row2 and row2["status"] == "answered"
        assert row2.get("count") >= 2


# ---------------- /api/inbox/conversations internal_qa_status ----------------
class TestInboxInternalQAStatus:
    def test_inbox_includes_internal_qa_status_field(self, admin_h):
        r = requests.get(f"{API}/inbox/conversations", headers=admin_h,
                         params={"include_all": "true", "limit": 100}, timeout=20)
        assert r.status_code == 200
        convs = r.json()
        assert isinstance(convs, list)
        if not convs:
            pytest.skip("No conversations to inspect")
        for c in convs:
            assert "internal_qa_status" in c, f"missing internal_qa_status on {c.get('id')}"
            assert c["internal_qa_status"] in ("none", "pending", "answered")

    def test_inbox_pending_then_answered_for_lead(self, admin_h, execs, ravi_h):
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        # Pending
        requests.post(f"{API}/internal-chat/send", headers=ravi_h,
                      json={"lead_id": lead_id, "body": "inbox iqa pending"}, timeout=15)
        r1 = requests.get(f"{API}/inbox/conversations", headers=admin_h,
                          params={"include_all": "true", "limit": 200}, timeout=20)
        c1 = next((x for x in r1.json() if x["id"] == lead_id), None)
        assert c1 is not None, "newly created lead missing from inbox conversations"
        assert c1["internal_qa_status"] == "pending"
        # Answered
        requests.post(f"{API}/internal-chat/send", headers=admin_h,
                      json={"lead_id": lead_id, "to_user_id": ravi["id"], "body": "inbox iqa reply"}, timeout=15)
        r2 = requests.get(f"{API}/inbox/conversations", headers=admin_h,
                          params={"include_all": "true", "limit": 200}, timeout=20)
        c2 = next((x for x in r2.json() if x["id"] == lead_id), None)
        assert c2 is not None
        assert c2["internal_qa_status"] == "answered"

    def test_inbox_executive_only_sees_own_qa_status(self, admin_h, execs, ravi_h, priya_h):
        # Priya creates an internal Q on her own lead — Ravi shouldn't see it as "pending"
        priya = execs["priya"]
        priya_lead = _create_lead_for(admin_h, priya)
        requests.post(f"{API}/internal-chat/send", headers=priya_h,
                      json={"lead_id": priya_lead, "body": "priya isolate q"}, timeout=15)
        # Ravi requests inbox — should not see this lead at all (not assigned to him);
        # but if include_all surfaces it, internal_qa_status must NOT leak as pending.
        r = requests.get(f"{API}/inbox/conversations", headers=ravi_h,
                         params={"include_all": "true", "limit": 200}, timeout=20)
        assert r.status_code == 200
        for c in r.json():
            if c["id"] == priya_lead:
                assert c["internal_qa_status"] == "none", \
                    "executive saw another agent's iqa status in inbox"


# ---------------- Regression: access control ----------------
class TestAccessControlRegression:
    def test_executive_post_to_unassigned_lead_returns_403(self, admin_h, execs, priya_h):
        # Lead assigned to ravi → priya posts → 403
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        r = requests.post(f"{API}/internal-chat/send", headers=priya_h,
                          json={"lead_id": lead_id, "body": "should 403"}, timeout=15)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"

    def test_executive_get_unassigned_lead_returns_403(self, admin_h, execs, priya_h):
        ravi = execs["ravi"]
        lead_id = _create_lead_for(admin_h, ravi)
        r = requests.get(f"{API}/internal-chat/{lead_id}", headers=priya_h, timeout=15)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"
