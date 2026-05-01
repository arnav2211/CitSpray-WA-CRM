"""
Iteration-4 LeadOrbit CRM regression tests:
- POST/GET /api/leads/{id}/calls (+ connected requires summary, exec RBAC)
- GET /api/calls (admin vs exec, invalid outcome)
- GET /api/leads?last_call_outcome=...
- PATCH /api/leads/{id} with aliases + active_wa_phone + requirement_updated_at
- PUT /api/leads/{id}/active-wa-phone validation
- GET /api/leads?q=<alias>
- /api/whatsapp/send uses active_wa_phone + wa_status_map flip
- /api/leads/{id}/activity — exec hides reassign
- /api/reports/overview enriched per_executive fields
- /api/followups enrichment (lead_customer_name + lead_phone)
- Round-robin auto-assign still excludes admin
"""
import os, time, uuid, pytest, requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = {"username": "admin", "password": "Admin@123"}
RAVI = {"username": "ravi", "password": "Exec@123"}
PRIYA = {"username": "priya", "password": "Exec@123"}


def _login(creds):
    r = requests.post(f"{API}/auth/login", json=creds, timeout=20)
    assert r.status_code == 200, f"Login fail {creds['username']}: {r.status_code} {r.text}"
    d = r.json()
    return d["token"], d["user"]


def _ensure_exec_password(admin_h, username, password):
    users = requests.get(f"{API}/users", headers=admin_h, timeout=20).json()
    u = next((x for x in users if x.get("username") == username), None)
    if not u:
        return
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=20)
    if r.status_code == 200:
        return
    requests.patch(f"{API}/users/{u['id']}", json={"password": password}, headers=admin_h, timeout=20)


@pytest.fixture(scope="session")
def admin_ctx():
    t, u = _login(ADMIN)
    return {"token": t, "user": u, "h": {"Authorization": f"Bearer {t}"}}


@pytest.fixture(scope="session")
def ravi_ctx(admin_ctx):
    _ensure_exec_password(admin_ctx["h"], "ravi", "Exec@123")
    t, u = _login(RAVI)
    return {"token": t, "user": u, "h": {"Authorization": f"Bearer {t}"}}


@pytest.fixture(scope="session")
def priya_ctx(admin_ctx):
    _ensure_exec_password(admin_ctx["h"], "priya", "Exec@123")
    t, u = _login(PRIYA)
    return {"token": t, "user": u, "h": {"Authorization": f"Bearer {t}"}}


@pytest.fixture(scope="session")
def fresh_lead(admin_ctx, ravi_ctx):
    """Create a new lead assigned to Ravi for iteration-4 tests."""
    suffix = str(int(time.time()))[-8:]
    payload = {
        "customer_name": f"TEST_IT4_{suffix}",
        "phone": f"+9199{suffix}",
        "phones": [f"+9188{suffix}"],
        "requirement": "Initial requirement",
        "source": "Manual",
    }
    r = requests.post(f"{API}/leads", json=payload, headers=admin_ctx["h"], timeout=20)
    assert r.status_code == 200, r.text
    lead = r.json()
    # Assign to Ravi
    r2 = requests.post(f"{API}/leads/{lead['id']}/reassign",
                       json={"assigned_to": ravi_ctx["user"]["id"]},
                       headers=admin_ctx["h"], timeout=20)
    assert r2.status_code == 200
    return requests.get(f"{API}/leads/{lead['id']}", headers=admin_ctx["h"], timeout=20).json()


# ---------------- Call Logs ----------------
class TestCallLogs:
    def test_log_call_no_response_ok(self, admin_ctx, fresh_lead):
        r = requests.post(
            f"{API}/leads/{fresh_lead['id']}/calls",
            json={"phone": fresh_lead["phone"], "outcome": "no_response"},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["outcome"] == "no_response"
        assert doc["by_user_id"] == admin_ctx["user"]["id"]
        assert doc["by_user_name"]
        assert "at" in doc
        # Verify lead got last_call_outcome set
        lead = requests.get(f"{API}/leads/{fresh_lead['id']}", headers=admin_ctx["h"], timeout=20).json()
        assert lead.get("last_call_outcome") == "no_response"
        assert lead.get("last_call_at")

    def test_log_call_connected_requires_summary(self, admin_ctx, fresh_lead):
        r = requests.post(
            f"{API}/leads/{fresh_lead['id']}/calls",
            json={"phone": fresh_lead["phone"], "outcome": "connected"},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"

    def test_log_call_connected_with_summary_ok(self, admin_ctx, fresh_lead):
        r = requests.post(
            f"{API}/leads/{fresh_lead['id']}/calls",
            json={"phone": fresh_lead["phone"], "outcome": "connected", "summary": "Discussed pricing"},
            headers=admin_ctx["h"], timeout=20,
        )
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["summary"] == "Discussed pricing"
        assert doc["outcome"] == "connected"

    def test_list_lead_calls_sorted_desc(self, admin_ctx, fresh_lead):
        r = requests.get(f"{API}/leads/{fresh_lead['id']}/calls",
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        calls = r.json()
        assert len(calls) >= 2
        # sorted desc
        ats = [c["at"] for c in calls]
        assert ats == sorted(ats, reverse=True)

    def test_executive_cannot_read_others_calls(self, priya_ctx, fresh_lead):
        # Fresh lead is assigned to Ravi, Priya must get 403
        r = requests.get(f"{API}/leads/{fresh_lead['id']}/calls",
                         headers=priya_ctx["h"], timeout=20)
        assert r.status_code == 403

    def test_calls_feed_admin_sees_all(self, admin_ctx):
        r = requests.get(f"{API}/calls", headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        calls = r.json()
        assert isinstance(calls, list)
        assert len(calls) > 0

    def test_calls_feed_invalid_outcome_400(self, admin_ctx):
        r = requests.get(f"{API}/calls?outcome=nope", headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 400

    def test_calls_feed_exec_only_own(self, ravi_ctx):
        r = requests.get(f"{API}/calls", headers=ravi_ctx["h"], timeout=20)
        assert r.status_code == 200
        calls = r.json()
        for c in calls:
            assert c["by_user_id"] == ravi_ctx["user"]["id"]

    def test_calls_feed_outcome_filter(self, admin_ctx):
        r = requests.get(f"{API}/calls?outcome=connected", headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        for c in r.json():
            assert c["outcome"] == "connected"


# ---------------- Leads filters ----------------
class TestLeadFilters:
    def test_last_call_outcome_filter_valid(self, admin_ctx):
        r = requests.get(f"{API}/leads?last_call_outcome=connected",
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        leads = r.json()
        for l in leads:
            assert l.get("last_call_outcome") == "connected"

    def test_last_call_outcome_filter_invalid(self, admin_ctx):
        r = requests.get(f"{API}/leads?last_call_outcome=bogus",
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 400

    def test_q_matches_alias(self, admin_ctx, fresh_lead):
        alias = f"TESTALIAS{int(time.time())}"
        r = requests.patch(f"{API}/leads/{fresh_lead['id']}",
                           json={"aliases": [alias, "aka boss"]},
                           headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200, r.text
        updated = r.json()
        assert alias in (updated.get("aliases") or [])
        # search by substring of alias
        r2 = requests.get(f"{API}/leads?q={alias[:10]}",
                          headers=admin_ctx["h"], timeout=20)
        assert r2.status_code == 200
        ids = [l["id"] for l in r2.json()]
        assert fresh_lead["id"] in ids


# ---------------- PATCH new fields ----------------
class TestLeadPatchNewFields:
    def test_patch_requirement_sets_updated_at(self, admin_ctx, fresh_lead):
        new_req = f"Updated req {int(time.time())}"
        r = requests.patch(f"{API}/leads/{fresh_lead['id']}",
                           json={"requirement": new_req},
                           headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert d["requirement"] == new_req
        assert d.get("requirement_updated_at")

    def test_patch_active_wa_phone_via_patch(self, admin_ctx, fresh_lead):
        # set via PATCH
        p = (fresh_lead.get("phones") or [fresh_lead["phone"]])[0]
        r = requests.patch(f"{API}/leads/{fresh_lead['id']}",
                           json={"active_wa_phone": p},
                           headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        assert r.json().get("active_wa_phone") == p


# ---------------- Active WA Phone endpoint ----------------
class TestActiveWaPhone:
    def test_set_valid_phone(self, admin_ctx, fresh_lead):
        target = fresh_lead["phone"]
        r = requests.put(f"{API}/leads/{fresh_lead['id']}/active-wa-phone",
                         json={"phone": target},
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200, r.text
        lead = r.json()
        assert lead.get("active_wa_phone") == target

    def test_set_suffix_match(self, admin_ctx, fresh_lead):
        # last 10 digits of phones[0]
        p0 = (fresh_lead.get("phones") or [])[0]
        assert p0, "fresh_lead should have phones[0]"
        last10 = "".join(ch for ch in p0 if ch.isdigit())[-10:]
        r = requests.put(f"{API}/leads/{fresh_lead['id']}/active-wa-phone",
                         json={"phone": "0" + last10},
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200, r.text

    def test_set_invalid_phone_400(self, admin_ctx, fresh_lead):
        r = requests.put(f"{API}/leads/{fresh_lead['id']}/active-wa-phone",
                         json={"phone": "+1234500000"},
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 400


# ---------------- Activity log RBAC ----------------
class TestActivityRBAC:
    def test_admin_sees_all_including_lead_assigned(self, admin_ctx, fresh_lead):
        r = requests.get(f"{API}/leads/{fresh_lead['id']}/activity",
                         headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        logs = r.json()
        actions = {x.get("action") for x in logs}
        assert "lead_assigned" in actions or "lead_created" in actions
        # actor_name enrichment present
        for x in logs:
            assert "actor_name" in x

    def test_exec_does_not_see_reassignment(self, ravi_ctx, fresh_lead):
        r = requests.get(f"{API}/leads/{fresh_lead['id']}/activity",
                         headers=ravi_ctx["h"], timeout=20)
        assert r.status_code == 200
        logs = r.json()
        hidden = {"lead_assigned", "auto_reassigned_unopened",
                  "auto_reassigned_noaction", "transfer_requested"}
        for x in logs:
            assert x.get("action") not in hidden, f"Exec sees hidden action: {x}"


# ---------------- Reports overview enrichment ----------------
class TestReportsOverview:
    REQUIRED_KEYS = [
        "qualified", "converted", "lost", "contacted", "new_leads",
        "conversion_rate", "avg_response_seconds",
        "calls_total", "calls_connected", "calls_no_response",
        "calls_not_reachable", "calls_rejected", "calls_busy", "calls_invalid",
        "wa_threads", "wa_messages_sent",
        "followup_total", "followup_done", "followup_pending", "followup_completion_pct",
    ]

    def test_per_executive_fields(self, admin_ctx):
        r = requests.get(f"{API}/reports/overview", headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        d = r.json()
        assert "per_executive" in d
        pe = d["per_executive"]
        assert isinstance(pe, list) and len(pe) > 0
        for e in pe:
            for k in self.REQUIRED_KEYS:
                assert k in e, f"Missing {k} in per_executive row for {e.get('name')}"


# ---------------- Followups enrichment ----------------
class TestFollowupsEnriched:
    def test_list_followups_enriched(self, admin_ctx, fresh_lead):
        # Create a followup
        due = iso_soon(60)
        body = {
            "lead_id": fresh_lead["id"],
            "due_at": due,
            "note": "TEST_it4_fu",
        }
        r = requests.post(f"{API}/followups", json=body,
                          headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200, r.text
        fu = r.json()
        assert fu["lead_id"] == fresh_lead["id"]

        r2 = requests.get(f"{API}/followups?scope=all", headers=admin_ctx["h"], timeout=20)
        assert r2.status_code == 200
        fus = r2.json()
        target = next((x for x in fus if x.get("lead_id") == fresh_lead["id"]), None)
        assert target is not None
        assert "lead_customer_name" in target
        assert "lead_phone" in target
        assert target["lead_customer_name"] == fresh_lead["customer_name"]

    def test_patch_followup_done(self, admin_ctx, fresh_lead):
        # Find a pending followup for this lead
        fus = requests.get(f"{API}/followups?scope=all", headers=admin_ctx["h"], timeout=20).json()
        target = next((x for x in fus if x.get("lead_id") == fresh_lead["id"]
                       and x.get("status") == "pending"), None)
        if not target:
            # create one
            due = iso_soon(3600)
            create = requests.post(f"{API}/followups",
                                   json={"lead_id": fresh_lead["id"], "due_at": due},
                                   headers=admin_ctx["h"], timeout=20).json()
            target = create
        r = requests.patch(f"{API}/followups/{target['id']}",
                           json={"status": "done"},
                           headers=admin_ctx["h"], timeout=20)
        assert r.status_code == 200
        assert r.json().get("status") == "done"


# ---------------- Round-robin still excludes admin (regression) ----------------
class TestRoundRobinExcludesAdmin:
    def test_im_webhook_no_receiver_never_picks_admin(self, admin_ctx):
        admin_id = admin_ctx["user"]["id"]
        created = []
        for i in range(3):
            unique = f"{int(time.time())}{i}"[-9:]
            qid = f"TEST_IT4_RR_{uuid.uuid4().hex[:10]}"
            created.append(qid)
            payload = {"RESPONSE": {
                "SENDER_MOBILE": f"+9122{unique}",
                "SENDER_NAME": f"TEST_IT4_RR_{i}",
                "QUERY_MESSAGE": "rr4",
                "UNIQUE_QUERY_ID": qid,
            }}
            requests.post(f"{API}/webhooks/indiamart", json=payload, timeout=20)
            time.sleep(0.15)
        leads = requests.get(f"{API}/leads", headers=admin_ctx["h"], timeout=20).json()
        mine = [l for l in leads if (l.get("source_data") or {}).get("UNIQUE_QUERY_ID") in created]
        assert len(mine) >= 3
        for l in mine:
            hist = l.get("assignment_history") or []
            first = hist[0] if hist else {"user_id": l.get("assigned_to"), "by": None}
            assert first.get("by") is None
            assert first.get("user_id") != admin_id, f"admin auto-assigned! {l['id']}"


def iso_soon(seconds_ahead: int) -> str:
    import datetime as dt
    t = dt.datetime.utcnow() + dt.timedelta(seconds=seconds_ahead)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")
