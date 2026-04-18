"""Comprehensive backend tests for LeadOrbit CRM."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_CREDS = {"username": "admin", "password": "Admin@123"}
RAVI_CREDS = {"username": "ravi", "password": "Exec@123"}
PRIYA_CREDS = {"username": "priya", "password": "Exec@123"}


def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    d = r.json()
    return d["token"], d["user"]


@pytest.fixture(scope="session")
def admin():
    tok, user = _login(ADMIN_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="session")
def ravi():
    tok, user = _login(RAVI_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="session")
def priya():
    tok, user = _login(PRIYA_CREDS)
    return {"token": tok, "user": user, "h": {"Authorization": f"Bearer {tok}"}}


# ------------- Auth -------------
class TestAuth:
    def test_login_admin_success(self):
        r = requests.post(f"{API}/auth/login", json=ADMIN_CREDS, timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "token" in d and "user" in d
        assert d["user"]["username"] == "admin"
        assert d["user"]["role"] == "admin"

    def test_login_wrong_password_401(self):
        r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "wrong"}, timeout=20)
        assert r.status_code == 401

    def test_me_with_bearer(self, admin):
        r = requests.get(f"{API}/auth/me", headers=admin["h"], timeout=20)
        assert r.status_code == 200
        assert r.json()["username"] == "admin"

    def test_me_without_token_401(self):
        r = requests.get(f"{API}/auth/me", timeout=20)
        assert r.status_code == 401


# ------------- Role guards -------------
class TestRoleGuards:
    def test_executive_cannot_access_reports_overview(self, ravi):
        r = requests.get(f"{API}/reports/overview", headers=ravi["h"], timeout=20)
        assert r.status_code == 403

    def test_admin_can_access_reports_overview(self, admin):
        r = requests.get(f"{API}/reports/overview", headers=admin["h"], timeout=20)
        assert r.status_code == 200


# ------------- Users CRUD -------------
class TestUsers:
    created_id = None

    def test_admin_list_users(self, admin):
        r = requests.get(f"{API}/users", headers=admin["h"], timeout=20)
        assert r.status_code == 200
        usernames = {u["username"] for u in r.json()}
        assert {"admin", "ravi", "priya"}.issubset(usernames)

    def test_admin_create_user(self, admin):
        payload = {"username": "TEST_exec_u1", "password": "Test@123", "name": "Test Exec U1", "role": "executive"}
        r = requests.post(f"{API}/users", headers=admin["h"], json=payload, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["username"] == "test_exec_u1"
        TestUsers.created_id = d["id"]

    def test_admin_update_user(self, admin):
        assert TestUsers.created_id
        r = requests.patch(f"{API}/users/{TestUsers.created_id}", headers=admin["h"], json={"name": "Updated Name"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["name"] == "Updated Name"

    def test_executive_cannot_create_user(self, ravi):
        r = requests.post(f"{API}/users", headers=ravi["h"],
                          json={"username": "TEST_blocked", "password": "x", "name": "x"}, timeout=20)
        assert r.status_code == 403

    def test_admin_delete_user(self, admin):
        assert TestUsers.created_id
        r = requests.delete(f"{API}/users/{TestUsers.created_id}", headers=admin["h"], timeout=20)
        assert r.status_code == 200


# ------------- IndiaMART webhook + round robin -------------
class TestIndiamart:
    created_ids = []

    def test_indiamart_round_robin(self, admin):
        # First reset last_assigned_index to -1 (via rule update — but rules model has no direct field)
        # We use 4 calls and check alternating
        assignments = []
        for i in range(4):
            payload = {
                "RESPONSE": [{
                    "UNIQUE_QUERY_ID": f"TEST_RR_{time.time_ns()}_{i}",
                    "SENDER_NAME": f"TEST_IM_{i}",
                    "MOBILE": f"90000000{i:02d}",
                    "SUBJECT": "Test lead",
                    "SENDER_CITY": "Mumbai",
                    "SENDER_STATE": "MH",
                    "QUERY_TIME": f"2026-01-0{i+1} 10:00:00",
                }]
            }
            r = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
            assert r.status_code == 200
            created = r.json()["created"]
            assert len(created) == 1
            TestIndiamart.created_ids.append(created[0])
            # fetch lead via admin
            rl = requests.get(f"{API}/leads/{created[0]}", headers=admin["h"], timeout=20)
            assignments.append(rl.json()["assigned_to"])
        # Check alternating (should toggle each time)
        alternations = sum(1 for i in range(1, len(assignments)) if assignments[i] != assignments[i-1])
        assert alternations >= 2, f"Expected alternating round-robin, got: {assignments}"
        # Raw payload stored — check by fetching a lead
        rl = requests.get(f"{API}/leads/{TestIndiamart.created_ids[0]}", headers=admin["h"], timeout=20)
        assert rl.json()["source"] == "IndiaMART"
        assert rl.json().get("source_data", {}).get("UNIQUE_QUERY_ID", "").startswith("TEST_RR_")


# ------------- Justdial parser -------------
class TestJustdial:
    lead_id = None

    def test_justdial_parse_and_create(self, admin):
        html = """<html><body>
        <p>Shoba enquired for Essential Oil Manufacturers</p>
        <p>User Area: Vadapalani</p>
        <p>User City: Chennai</p>
        <p>User State: Tamil Nadu</p>
        <p>Search Date & Time: 2026-01-15 10:30:00</p>
        <a href="https://justdial.com/contact/abc123">View Contact Details</a>
        </body></html>"""
        text = "Shoba enquired for Essential Oil Manufacturers\nUser Area: Vadapalani\nUser City: Chennai\nUser State: Tamil Nadu\nSearch Date & Time: 2026-01-15 10:30:00\n"
        r = requests.post(f"{API}/ingest/justdial", json={
            "raw_email_html": html, "raw_email_text": text,
            "subject": "JD Lead", "from_email": "instantemail@justdial.com"
        }, timeout=20)
        assert r.status_code == 200, r.text
        lead_id = r.json()["lead_id"]
        TestJustdial.lead_id = lead_id
        # Fetch as admin
        rl = requests.get(f"{API}/leads/{lead_id}", headers=admin["h"], timeout=20)
        assert rl.status_code == 200
        lead = rl.json()
        assert lead["customer_name"] == "Shoba"
        assert "Essential Oil Manufacturers" in (lead.get("requirement") or "")
        assert lead["area"] == "Vadapalani"
        assert lead["city"] == "Chennai"
        assert lead["state"] == "Tamil Nadu"
        assert lead["contact_link"] == "https://justdial.com/contact/abc123"
        assert lead["source"] == "Justdial"

    def test_justdial_duplicate_detection(self):
        html = """<html><body>
        <p>DupTester enquired for Duplicate Check Product</p>
        <p>User City: Pune</p>
        <p>Search Date & Time: 2026-01-16 11:30:00</p>
        </body></html>"""
        text = "DupTester enquired for Duplicate Check Product\nUser City: Pune\nSearch Date & Time: 2026-01-16 11:30:00\n"
        r1 = requests.post(f"{API}/ingest/justdial", json={"raw_email_html": html, "raw_email_text": text}, timeout=20)
        r2 = requests.post(f"{API}/ingest/justdial", json={"raw_email_html": html, "raw_email_text": text}, timeout=20)
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["lead_id"] == r2.json()["lead_id"]


# ------------- Leads role isolation + notes + open -------------
class TestLeadsIsolation:
    def test_executive_sees_only_own_leads(self, ravi, admin):
        r = requests.get(f"{API}/leads", headers=ravi["h"], timeout=20)
        assert r.status_code == 200
        for lead in r.json():
            assert lead["assigned_to"] == ravi["user"]["id"]
        ra = requests.get(f"{API}/leads", headers=admin["h"], timeout=20)
        assert ra.status_code == 200
        assert len(ra.json()) >= len(r.json())

    def test_admin_reassign(self, admin, ravi, priya):
        # find any lead assigned to ravi
        r = requests.get(f"{API}/leads", headers=admin["h"], timeout=20)
        leads = r.json()
        target = next((l for l in leads if l.get("assigned_to") == ravi["user"]["id"]), None)
        if not target:
            pytest.skip("No lead assigned to ravi")
        r2 = requests.post(f"{API}/leads/{target['id']}/reassign", headers=admin["h"],
                           json={"assigned_to": priya["user"]["id"]}, timeout=20)
        assert r2.status_code == 200
        assert r2.json()["assigned_to"] == priya["user"]["id"]

    def test_executive_cannot_reassign(self, ravi, priya, admin):
        # Create one lead via indiamart
        payload = {"SENDER_NAME": "TEST_NoReassign", "MOBILE": "9988776655",
                   "UNIQUE_QUERY_ID": f"TEST_NR_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        r = requests.post(f"{API}/leads/{lead_id}/reassign", headers=ravi["h"],
                          json={"assigned_to": priya["user"]["id"]}, timeout=20)
        assert r.status_code == 403

    def test_add_note_and_appears(self, admin):
        # create a lead
        payload = {"SENDER_NAME": "TEST_Note", "MOBILE": "1111111111",
                   "UNIQUE_QUERY_ID": f"TEST_N_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        rn = requests.post(f"{API}/leads/{lead_id}/notes", headers=admin["h"], json={"body": "My Test Note"}, timeout=20)
        assert rn.status_code == 200
        rget = requests.get(f"{API}/leads/{lead_id}", headers=admin["h"], timeout=20)
        notes = rget.json().get("notes", [])
        assert any(n["body"] == "My Test Note" for n in notes)

    def test_executive_opens_lead_marks_opened_at(self, admin, ravi, priya):
        # Create and reassign to ravi
        payload = {"SENDER_NAME": "TEST_Open", "MOBILE": "2222222222",
                   "UNIQUE_QUERY_ID": f"TEST_O_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        # Ensure assigned to ravi
        requests.post(f"{API}/leads/{lead_id}/reassign", headers=admin["h"], json={"assigned_to": ravi["user"]["id"]}, timeout=20)
        # before open
        before = requests.get(f"{API}/leads/{lead_id}", headers=admin["h"], timeout=20).json()
        assert before.get("opened_at") is None
        # ravi opens
        r = requests.get(f"{API}/leads/{lead_id}", headers=ravi["h"], timeout=20)
        assert r.status_code == 200
        assert r.json().get("opened_at") is not None


# ------------- WhatsApp send + welcome on create -------------
class TestWhatsApp:
    def test_welcome_auto_message_on_create(self, admin):
        payload = {"SENDER_NAME": "TEST_Welcome", "MOBILE": "3333333333",
                   "UNIQUE_QUERY_ID": f"TEST_W_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        time.sleep(0.5)
        rm = requests.get(f"{API}/leads/{lead_id}/messages", headers=admin["h"], timeout=20)
        assert rm.status_code == 200
        msgs = rm.json()
        assert any(m.get("template_name") == "welcome_lead" and m.get("status") == "sent_mock" for m in msgs)

    def test_whatsapp_send_stores_message(self, admin):
        payload = {"SENDER_NAME": "TEST_Send", "MOBILE": "4444444444",
                   "UNIQUE_QUERY_ID": f"TEST_S_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        rs = requests.post(f"{API}/whatsapp/send", headers=admin["h"],
                           json={"lead_id": lead_id, "body": "Hello from test"}, timeout=20)
        assert rs.status_code == 200
        rm = requests.get(f"{API}/leads/{lead_id}/messages", headers=admin["h"], timeout=20)
        assert any(m["body"] == "Hello from test" and m["direction"] == "out" for m in rm.json())

    def test_templates_list_and_crud(self, admin, ravi):
        rl = requests.get(f"{API}/whatsapp/templates", headers=admin["h"], timeout=20)
        assert rl.status_code == 200
        # executive cannot create
        rc_exec = requests.post(f"{API}/whatsapp/templates", headers=ravi["h"],
                                json={"name": "TEST_exec_tpl", "body": "x"}, timeout=20)
        assert rc_exec.status_code == 403
        # admin creates
        tname = f"TEST_tpl_{time.time_ns()}"
        rc = requests.post(f"{API}/whatsapp/templates", headers=admin["h"],
                           json={"name": tname, "body": "Hello {{name}}"}, timeout=20)
        assert rc.status_code == 200
        tid = rc.json()["id"]
        # delete
        rd = requests.delete(f"{API}/whatsapp/templates/{tid}", headers=admin["h"], timeout=20)
        assert rd.status_code == 200


# ------------- Followups -------------
class TestFollowups:
    def test_create_and_complete_followup(self, admin):
        payload = {"SENDER_NAME": "TEST_FU", "MOBILE": "5555555555",
                   "UNIQUE_QUERY_ID": f"TEST_FU_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        rc = requests.post(f"{API}/followups", headers=admin["h"],
                           json={"lead_id": lead_id, "due_at": "2026-12-01T10:00:00+00:00", "note": "Check"}, timeout=20)
        assert rc.status_code == 200, rc.text
        fu_id = rc.json()["id"]
        ru = requests.patch(f"{API}/followups/{fu_id}", headers=admin["h"], json={"status": "done"}, timeout=20)
        assert ru.status_code == 200
        assert ru.json()["status"] == "done"
        assert ru.json().get("completed_at")


# ------------- Routing rules -------------
class TestRoutingRules:
    def test_get_and_update(self, admin, ravi):
        r = requests.get(f"{API}/routing-rules", headers=ravi["h"], timeout=20)
        assert r.status_code == 200
        assert "round_robin_enabled" in r.json()
        # executive cannot update
        re_ = requests.put(f"{API}/routing-rules", headers=ravi["h"], json={"auto_whatsapp_on_create": True}, timeout=20)
        assert re_.status_code == 403
        ru = requests.put(f"{API}/routing-rules", headers=admin["h"],
                          json={"auto_whatsapp_on_create": True, "round_robin_enabled": True}, timeout=20)
        assert ru.status_code == 200
        assert ru.json()["auto_whatsapp_on_create"] is True


# ------------- Reports -------------
class TestReports:
    def test_overview_fields(self, admin):
        r = requests.get(f"{API}/reports/overview", headers=admin["h"], timeout=20)
        assert r.status_code == 200
        d = r.json()
        for k in ["total_leads", "by_status", "by_source", "conversion_rate",
                  "reassigned_leads", "missed_followups", "per_executive", "leads_timeseries"]:
            assert k in d, f"missing key {k}"
        assert isinstance(d["per_executive"], list)
        assert isinstance(d["leads_timeseries"], list)

    def test_my_reports_executive(self, ravi):
        r = requests.get(f"{API}/reports/my", headers=ravi["h"], timeout=20)
        assert r.status_code == 200
        for k in ["total_leads", "new_leads", "converted", "pending_followups", "overdue_followups"]:
            assert k in r.json()


# ------------- WhatsApp webhook -------------
class TestWhatsAppWebhook:
    def test_verify_challenge(self):
        r = requests.get(f"{API}/webhooks/whatsapp?hub.challenge=xyz123", timeout=20)
        assert r.status_code == 200
        assert r.text == "xyz123"

    def test_incoming_message(self, admin):
        payload = {"SENDER_NAME": "TEST_Inbound", "MOBILE": "6666666666",
                   "UNIQUE_QUERY_ID": f"TEST_IN_{time.time_ns()}", "QUERY_TIME": "2026-01-01 10:00:00"}
        cr = requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
        lead_id = cr.json()["created"][0]
        rw = requests.post(f"{API}/webhooks/whatsapp", json={"lead_id": lead_id, "body": "Incoming test"}, timeout=20)
        assert rw.status_code == 200
        rm = requests.get(f"{API}/leads/{lead_id}/messages", headers=admin["h"], timeout=20)
        assert any(m["direction"] == "in" and m["body"] == "Incoming test" for m in rm.json())
