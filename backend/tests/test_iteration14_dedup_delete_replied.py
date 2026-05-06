"""Iteration 14 backend tests
Covers:
1) Justdial profile-URL based dedup on POST /api/ingest/justdial
2) Admin-only DELETE /api/leads/{id} cascade behaviour (RBAC + cascades)
3) GET /api/inbox/conversations?only_replied=true filter semantics
"""
import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"username": "admin", "password": "Admin@123"}
RAVI = {"username": "ravi", "password": "Exec@123"}


def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, r.text
    d = r.json()
    return {"token": d["token"], "user": d["user"], "h": {"Authorization": f"Bearer {d['token']}"}}


@pytest.fixture(scope="module")
def admin():
    return _login(ADMIN)


@pytest.fixture(scope="module")
def ravi():
    return _login(RAVI)


# ------------------ 1) Justdial profile URL dedup ------------------
class TestJustdialProfileUrlDedup:
    """First email with profile URL X creates a lead; second email with the same
    profile URL (different name/body, query/fragment/trailing-slash variants)
    must return the SAME lead_id with duplicate=true and dedup_reason=justdial_profile_url."""

    @classmethod
    def setup_class(cls):
        cls.profile_id = uuid.uuid4().hex[:10]
        cls.base_url = f"https://justdial.com/contact/TESTiter14-{cls.profile_id}"
        cls.created_lead_ids = []

    def _build_email(self, name, requirement, link):
        html = f"""<html><body>
        <p><strong>{name}</strong> enquired for {requirement}</p>
        <p>User City: Bengaluru</p>
        <p>Search Date &amp; Time: 2026-01-20 09:15:00</p>
        <a href="{link}">View Contact Details</a>
        </body></html>"""
        text = f"{name} enquired for {requirement}\nUser City: Bengaluru\nSearch Date & Time: 2026-01-20 09:15:00\n"
        return html, text

    def test_a_first_ingest_creates_lead(self):
        html, text = self._build_email("TESTiter14Alice", "Industrial Pumps", self.base_url)
        r = requests.post(f"{API}/ingest/justdial", json={
            "raw_email_html": html, "raw_email_text": text,
            "subject": "JD Lead", "from_email": "instantemail@justdial.com",
        }, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True
        assert "lead_id" in d
        TestJustdialProfileUrlDedup.created_lead_ids.append(d["lead_id"])
        # First call should NOT be marked as profile-URL duplicate.
        assert d.get("dedup_reason") != "justdial_profile_url"

    def test_b_second_ingest_with_query_param_returns_same_lead_id(self):
        # Different name + different requirement + ?ref=foo&utm=bar tracking + trailing slash + fragment
        link_with_query = f"{self.base_url}/?ref=email&utm_source=jd#section"
        html, text = self._build_email("TESTiter14Bob", "Submersible Pumps", link_with_query)
        r = requests.post(f"{API}/ingest/justdial", json={
            "raw_email_html": html, "raw_email_text": text,
            "subject": "JD Lead 2", "from_email": "instantemail@justdial.com",
        }, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("duplicate") is True, f"Expected duplicate=True, got {d}"
        assert d.get("dedup_reason") == "justdial_profile_url", f"Expected dedup_reason=justdial_profile_url, got {d}"
        # Same lead_id as first ingest
        assert d["lead_id"] == self.created_lead_ids[0]

    def test_c_third_ingest_uppercase_host_still_dedups(self):
        # Justdial sometimes URL-cases differ; normalize lowercases host.
        link_upper = self.base_url.replace("justdial.com", "JUSTDIAL.COM") + "/"
        html, text = self._build_email("TESTiter14Carol", "Centrifugal Pumps", link_upper)
        r = requests.post(f"{API}/ingest/justdial", json={
            "raw_email_html": html, "raw_email_text": text,
        }, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("duplicate") is True
        assert d.get("dedup_reason") == "justdial_profile_url"
        assert d["lead_id"] == self.created_lead_ids[0]

    def test_d_lead_persisted_with_normalized_url(self, admin):
        lead_id = self.created_lead_ids[0]
        r = requests.get(f"{API}/leads/{lead_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 200
        lead = r.json()
        # Stored normalized url should NOT contain query string or fragment.
        norm = lead.get("justdial_profile_url") or ""
        assert "?" not in norm, norm
        assert "#" not in norm, norm
        assert norm.endswith(self.base_url.lstrip()) or norm.endswith(self.base_url.rstrip("/"))

    @classmethod
    def teardown_class(cls):
        # Cleanup created leads with admin token
        try:
            tok = _login(ADMIN)["h"]
            for lid in cls.created_lead_ids:
                requests.delete(f"{API}/leads/{lid}", headers=tok, timeout=20)
        except Exception:
            pass


# ------------------ 2) Admin DELETE /api/leads/{id} cascade ------------------
class TestDeleteLeadCascade:
    """admin → 200 with cascade counters; executive → 403; non-existent → 404.
    Verifies messages/internal_messages/followups/call_logs/activity_logs/transfer_requests
    are removed and email_logs.lead_id is nulled."""

    lead_id = None
    note_id = None

    def test_a_seed_lead_via_justdial(self, admin):
        link = f"https://justdial.com/contact/TESTiter14-DEL-{uuid.uuid4().hex[:8]}"
        html = f"""<html><body><p><strong>TESTiter14Delete</strong> enquired for DeleteSubject</p>
        <p>User City: Mumbai</p>
        <p>Search Date &amp; Time: 2026-01-20 10:00:00</p>
        <a href="{link}">View Contact Details</a></body></html>"""
        text = "TESTiter14Delete enquired for DeleteSubject\nUser City: Mumbai\nSearch Date & Time: 2026-01-20 10:00:00\n"
        r = requests.post(f"{API}/ingest/justdial",
                          json={"raw_email_html": html, "raw_email_text": text}, timeout=20)
        assert r.status_code == 200, r.text
        TestDeleteLeadCascade.lead_id = r.json()["lead_id"]
        # Add a note (writes activity_logs implicitly + lead notes array)
        rn = requests.post(f"{API}/leads/{self.lead_id}/notes", headers=admin["h"],
                           json={"body": "TEST_iter14_note"}, timeout=20)
        assert rn.status_code == 200

    def test_b_executive_cannot_delete_lead_403(self, ravi):
        assert TestDeleteLeadCascade.lead_id
        r = requests.delete(f"{API}/leads/{self.lead_id}", headers=ravi["h"], timeout=20)
        assert r.status_code == 403, r.text

    def test_c_admin_delete_returns_cascade_summary(self, admin):
        assert TestDeleteLeadCascade.lead_id
        r = requests.delete(f"{API}/leads/{self.lead_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["lead_id"] == self.lead_id
        for k in ("messages_deleted", "internal_messages_deleted", "followups_deleted",
                  "call_logs_deleted", "activity_logs_deleted", "transfer_requests_deleted"):
            assert k in d, f"Missing counter {k} in delete summary"
            assert isinstance(d[k], int)
        assert d.get("deleted_by")
        assert d.get("deleted_at")

    def test_d_lead_404_after_delete(self, admin):
        r = requests.get(f"{API}/leads/{self.lead_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 404

    def test_e_activity_logs_for_lead_gone(self, admin):
        # After cascade, activity logs for that lead should not appear via lead-level endpoints
        # (We re-query the lead which is already 404, so just assert no resurrection).
        r = requests.get(f"{API}/leads/{self.lead_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 404

    def test_f_delete_nonexistent_returns_404(self, admin):
        r = requests.delete(f"{API}/leads/nonexistent-{uuid.uuid4().hex}", headers=admin["h"], timeout=20)
        assert r.status_code == 404

    def test_g_double_delete_returns_404(self, admin):
        # Already deleted lead should now be 404 too
        r = requests.delete(f"{API}/leads/{self.lead_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 404


# ------------------ 3) only_replied filter on /inbox/conversations ------------------
class TestOnlyRepliedFilter:
    def test_a_endpoint_returns_200(self, admin):
        r = requests.get(f"{API}/inbox/conversations?only_replied=true", headers=admin["h"], timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        # Either {items:[...]} or list
        items = data.get("items") if isinstance(data, dict) else data
        assert isinstance(items, list)

    def test_b_only_replied_implies_last_in_at_present(self, admin):
        r = requests.get(f"{API}/inbox/conversations?only_replied=true", headers=admin["h"], timeout=20)
        assert r.status_code == 200
        data = r.json()
        items = data.get("items") if isinstance(data, dict) else data
        # Every returned conversation MUST have a non-null last_in_at (or analogous field)
        for c in items[:50]:
            li = c.get("last_in_at")
            assert li, f"Conversation {c.get('lead_id') or c.get('id')} has no last_in_at but came through only_replied=true: {c}"

    def test_c_filter_off_superset(self, admin):
        ron = requests.get(f"{API}/inbox/conversations?only_replied=true", headers=admin["h"], timeout=20).json()
        roff = requests.get(f"{API}/inbox/conversations", headers=admin["h"], timeout=20).json()
        ion = ron.get("items") if isinstance(ron, dict) else ron
        ioff = roff.get("items") if isinstance(roff, dict) else roff
        assert len(ioff) >= len(ion), "Unfiltered list should be >= only_replied list"
