"""
Iteration 13 — Backend tests for:
1. Quick Replies CRUD with media fields (media_url, media_type, media_filename, caption)
2. Transfer Requests admin endpoints (list, approve, reject) + assignment_history mutation
3. Auto-reassign cron skips leads whose status != 'new' (review-style: only verify the query in code)
"""
import os
import time
import uuid
import requests
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"


def _login(username, password):
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed for {username}: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"no token for {username}: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "Admin@123")


@pytest.fixture(scope="module")
def ravi_token():
    return _login("ravi", "Exec@123")


@pytest.fixture(scope="module")
def priya_token():
    return _login("priya", "Exec@123")


def H(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# -------------------- Quick Replies --------------------
class TestQuickReplies:
    def test_list_qr_admin(self, admin_token):
        r = requests.get(f"{API}/quick-replies", headers=H(admin_token), timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)

    def test_create_text_only_qr(self, admin_token):
        body = {
            "title": f"TEST_iter13_text_{uuid.uuid4().hex[:6]}",
            "text": "Hello {{name}}, thanks for reaching out!",
        }
        r = requests.post(f"{API}/quick-replies", headers=H(admin_token), json=body, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["title"] == body["title"]
        assert data["text"] == body["text"]
        assert data.get("media_url") is None
        assert data.get("media_type") is None
        assert "id" in data
        # GET to verify persistence
        r2 = requests.get(f"{API}/quick-replies", headers=H(admin_token), timeout=20)
        assert any(x["id"] == data["id"] for x in r2.json()), "created QR not persisted"
        TestQuickReplies._text_id = data["id"]

    def test_create_media_qr(self, admin_token):
        body = {
            "title": f"TEST_iter13_media_{uuid.uuid4().hex[:6]}",
            "text": "",
            "media_url": "https://example.com/test.jpg",
            "media_type": "image",
            "media_filename": "test.jpg",
            "caption": "Hi {{name}}, check this!",
        }
        r = requests.post(f"{API}/quick-replies", headers=H(admin_token), json=body, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["media_url"] == body["media_url"]
        assert data["media_type"] == "image"
        assert data["media_filename"] == "test.jpg"
        assert data["caption"] == body["caption"]
        TestQuickReplies._media_id = data["id"]

    def test_create_media_qr_invalid_type_400(self, admin_token):
        body = {
            "title": f"TEST_iter13_invalid_{uuid.uuid4().hex[:6]}",
            "text": "",
            "media_url": "https://example.com/x.bin",
            "media_type": "sticker",
        }
        r = requests.post(f"{API}/quick-replies", headers=H(admin_token), json=body, timeout=20)
        assert r.status_code == 400
        assert "media_type" in r.text.lower()

    def test_update_qr_media_fields(self, admin_token):
        qr_id = getattr(TestQuickReplies, "_text_id", None)
        assert qr_id, "text-only QR not created in prior test"
        body = {
            "title": "TEST_iter13_text_updated",
            "text": "",
            "media_url": "https://example.com/doc.pdf",
            "media_type": "document",
            "media_filename": "doc.pdf",
            "caption": "See attached",
        }
        r = requests.put(f"{API}/quick-replies/{qr_id}", headers=H(admin_token), json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["media_url"] == body["media_url"]
        assert d["media_type"] == "document"
        assert d["media_filename"] == "doc.pdf"
        assert d["caption"] == "See attached"

    def test_executive_cannot_create_qr(self, ravi_token):
        body = {"title": "TEST_iter13_exec_attempt", "text": "no"}
        r = requests.post(f"{API}/quick-replies", headers=H(ravi_token), json=body, timeout=20)
        assert r.status_code in (401, 403)

    def test_executive_can_list_qr(self, ravi_token):
        r = requests.get(f"{API}/quick-replies", headers=H(ravi_token), timeout=20)
        assert r.status_code == 200

    def test_cleanup_qr(self, admin_token):
        for attr in ("_text_id", "_media_id"):
            qid = getattr(TestQuickReplies, attr, None)
            if qid:
                requests.delete(f"{API}/quick-replies/{qid}", headers=H(admin_token), timeout=20)


# -------------------- Transfer Requests --------------------
class TestTransferRequests:
    @pytest.fixture(autouse=True, scope="class")
    def setup_lead_and_request(self, request, admin_token, ravi_token, priya_token):
        # 1) Find or create a lead currently assigned to ravi
        r = requests.get(f"{API}/auth/me", headers=H(ravi_token), timeout=20)
        ravi_id = r.json()["id"]
        r2 = requests.get(f"{API}/auth/me", headers=H(priya_token), timeout=20)
        priya_id = r2.json()["id"]
        request.cls.ravi_id = ravi_id
        request.cls.priya_id = priya_id

        # Admin creates a lead and assigns to priya so ravi can request transfer to himself
        lead_payload = {
            "source": "manual",
            "customer_name": f"TEST_iter13_lead_{uuid.uuid4().hex[:6]}",
            "phone": f"+9199{uuid.uuid4().int % 100000000:08d}",
            "assigned_to": priya_id,
        }
        rl = requests.post(f"{API}/leads", headers=H(admin_token), json=lead_payload, timeout=20)
        assert rl.status_code in (200, 201), rl.text
        lead = rl.json()
        request.cls.lead_id = lead["id"]
        request.cls.initial_assignee = lead.get("assigned_to")

        # ravi creates a transfer request
        rr = requests.post(f"{API}/inbox/transfer-request",
                           headers=H(ravi_token),
                           json={"lead_id": lead["id"], "reason": "TEST_iter13: pls transfer"},
                           timeout=20)
        assert rr.status_code == 200, rr.text
        request.cls.req_id = rr.json()["id"]
        yield

    def test_admin_lists_pending_transfer_requests(self, admin_token):
        r = requests.get(f"{API}/inbox/transfer-requests?status=pending", headers=H(admin_token), timeout=20)
        assert r.status_code == 200
        ids = [x["id"] for x in r.json()]
        assert self.req_id in ids, "admin should see ravi's pending request"

    def test_executive_sees_only_own_requests(self, ravi_token, priya_token):
        # ravi should see his own request
        r1 = requests.get(f"{API}/inbox/transfer-requests?status=pending", headers=H(ravi_token), timeout=20)
        assert r1.status_code == 200
        ravi_ids = [x["id"] for x in r1.json()]
        assert self.req_id in ravi_ids

        # priya should NOT see ravi's request
        r2 = requests.get(f"{API}/inbox/transfer-requests?status=pending", headers=H(priya_token), timeout=20)
        assert r2.status_code == 200
        priya_ids = [x["id"] for x in r2.json()]
        assert self.req_id not in priya_ids, "priya leaked into ravi's request list"

    def test_executive_cannot_approve(self, ravi_token):
        r = requests.post(f"{API}/inbox/transfer-requests/{self.req_id}/approve",
                          headers=H(ravi_token), timeout=20)
        assert r.status_code in (401, 403)

    def test_admin_approves_and_lead_reassigned(self, admin_token):
        # Snapshot history length BEFORE
        l_before = requests.get(f"{API}/leads/{self.lead_id}", headers=H(admin_token), timeout=20).json()
        hist_before = len(l_before.get("assignment_history") or [])
        prev_assignee = l_before.get("assigned_to")

        r = requests.post(f"{API}/inbox/transfer-requests/{self.req_id}/approve",
                          headers=H(admin_token), timeout=20)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        l_after = requests.get(f"{API}/leads/{self.lead_id}", headers=H(admin_token), timeout=20).json()
        assert l_after["assigned_to"] == self.ravi_id, (
            f"expected ravi ({self.ravi_id}) got {l_after.get('assigned_to')}")
        hist_after = len(l_after.get("assignment_history") or [])
        assert hist_after == hist_before + 1, (
            f"assignment_history len did not grow: {hist_before} -> {hist_after}")
        # Latest entry should target ravi
        latest = l_after["assignment_history"][-1]
        assert latest["user_id"] == self.ravi_id

        # Status flip on the request
        rl = requests.get(f"{API}/inbox/transfer-requests?status=approved",
                          headers=H(admin_token), timeout=20)
        assert any(x["id"] == self.req_id and x["status"] == "approved" for x in rl.json())

    def test_admin_double_approve_returns_400(self, admin_token):
        r = requests.post(f"{API}/inbox/transfer-requests/{self.req_id}/approve",
                          headers=H(admin_token), timeout=20)
        assert r.status_code == 400

    def test_admin_rejects_request_does_not_change_assignee(self, admin_token, priya_token, ravi_token):
        # Create a 2nd lead → assigned to ravi → priya requests transfer → admin rejects
        lead_payload = {
            "source": "manual",
            "customer_name": f"TEST_iter13_lead2_{uuid.uuid4().hex[:6]}",
            "phone": f"+9198{uuid.uuid4().int % 100000000:08d}",
            "assigned_to": self.ravi_id,
        }
        rl = requests.post(f"{API}/leads", headers=H(admin_token), json=lead_payload, timeout=20)
        assert rl.status_code in (200, 201), rl.text
        lead2 = rl.json()
        before_assignee = lead2["assigned_to"]

        rr = requests.post(f"{API}/inbox/transfer-request",
                           headers=H(priya_token),
                           json={"lead_id": lead2["id"], "reason": "TEST_iter13_reject"},
                           timeout=20)
        assert rr.status_code == 200, rr.text
        req2 = rr.json()["id"]

        rrej = requests.post(f"{API}/inbox/transfer-requests/{req2}/reject",
                             headers=H(admin_token), timeout=20)
        assert rrej.status_code == 200

        l_after = requests.get(f"{API}/leads/{lead2['id']}", headers=H(admin_token), timeout=20).json()
        assert l_after["assigned_to"] == before_assignee, "assignee changed after reject!"

        # Check status=rejected listing
        rl2 = requests.get(f"{API}/inbox/transfer-requests?status=rejected",
                           headers=H(admin_token), timeout=20)
        assert any(x["id"] == req2 for x in rl2.json())


# -------------------- Auto-reassign skip-non-new (server-code review) --------------------
class TestAutoReassignSkip:
    def test_auto_reassign_query_filters_status_new(self):
        """Verify auto_reassign_task only picks status='new' leads (regression guard)."""
        with open("/app/backend/server.py") as f:
            src = f.read()
        # Both unopened and noaction queries must filter status:'new'
        idx = src.find("async def auto_reassign_task()")
        assert idx > 0, "auto_reassign_task not found"
        body = src[idx: idx + 4000]
        assert body.count('"status": "new"') >= 2, (
            "auto_reassign_task must filter status='new' on BOTH unopened and noaction cursors")
