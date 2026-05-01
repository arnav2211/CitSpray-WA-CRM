"""Iteration-5 regression tests: strict phone dedup + admin self-assign.

Covers:
- Phone normalization (+91, 0, hyphen, space → bare 10 digit)
- Cross-source dedup (IndiaMART vs manual)
- Admin vs executive duplicate POST /api/leads
- POST /api/leads/{id}/phones cross-lead rejection
- POST /api/inbox/start-chat dedup
- Phone-variation search (+, 0, hyphen)
- Admin reassign-to-self
- Round-robin still excludes admin
- Migration: stored phones canonicalized
"""

import os
import re
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def login(username: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"username": username, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed {username}: {r.status_code} {r.text}"
    return r.json()["token"]


def auth(t: str):
    return {"Authorization": f"Bearer {t}"}


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def admin_token():
    return login("admin", "Admin@123")


@pytest.fixture(scope="module")
def ravi_token(admin_token):
    try:
        return login("ravi", "Exec@123")
    except AssertionError:
        # try reset via admin
        users = requests.get(f"{API}/users", headers=auth(admin_token), timeout=30).json()
        r = next((u for u in users if u.get("username") == "ravi"), None)
        if r:
            requests.patch(f"{API}/users/{r['id']}", headers=auth(admin_token), json={"password": "Exec@123"}, timeout=30)
        return login("ravi", "Exec@123")


@pytest.fixture(scope="module")
def priya_token(admin_token):
    try:
        return login("priya", "Exec@123")
    except AssertionError:
        users = requests.get(f"{API}/users", headers=auth(admin_token), timeout=30).json()
        p = next((u for u in users if u.get("username") == "priya"), None)
        if p:
            requests.patch(f"{API}/users/{p['id']}", headers=auth(admin_token), json={"password": "Exec@123"}, timeout=30)
        return login("priya", "Exec@123")


@pytest.fixture(scope="module")
def user_ids(admin_token):
    users = requests.get(f"{API}/users", headers=auth(admin_token), timeout=30).json()
    return {u["username"]: u["id"] for u in users if "username" in u}


def _rand10() -> str:
    # 10 random digits, Indian-like, never starts with 0/1
    n = "".join([str((uuid.uuid4().int >> (i * 8)) % 10) for i in range(10)])
    if n[0] in "01":
        n = "9" + n[1:]
    return n


# ---------- phone normalization ----------
class TestPhoneNormalization:
    def test_indian_variants_all_canonicalize_to_10_digits(self, admin_token, user_ids):
        base = _rand10()
        admin_id = user_ids["admin"]
        for i, raw in enumerate([f"+91 {base[:5]}-{base[5:]}", f"0{base}", f"91{base}"]):
            payload = {
                "customer_name": f"TEST_IT5_NORM_{i}_{base}",
                "phone": raw,
                "requirement": "norm test",
                "source": "Manual",
                "assigned_to": admin_id,
            }
            r = requests.post(f"{API}/leads", headers=auth(admin_token), json=payload, timeout=30)
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["phone"] == base, f"expected {base}, got {data['phone']}"
            if i == 0:
                first_id = data["id"]
            else:
                # subsequent variants MUST resolve to the same lead (dedup)
                assert data.get("duplicate") is True or data.get("existed") is True or data["id"] == first_id, \
                    f"variant {raw} should dedup to existing; got new lead {data['id']}"

    def test_international_stored_as_plus_digits(self, admin_token, user_ids):
        r = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={
                "customer_name": f"TEST_IT5_INTL_{uuid.uuid4().hex[:6]}",
                "phone": "+255-123 45 6789",
                "source": "Manual",
                "assigned_to": user_ids["admin"],
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["phone"] == "+2551234567890"[:13] or r.json()["phone"] == "+2551234567890"
        # less strict — just assert structure
        p = r.json()["phone"]
        assert p.startswith("+"), f"intl phone should start with '+': {p}"
        assert re.fullmatch(r"\+\d+", p), f"intl phone should be +<digits>: {p}"


# ---------- cross-source dedup ----------
class TestCrossSourceDedup:
    def test_indiamart_webhook_dedups_with_existing_manual_lead(self, admin_token, user_ids):
        phone = _rand10()
        # seed via manual
        r = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={
                "customer_name": f"TEST_IT5_XS_{phone}",
                "phone": phone,
                "source": "Manual",
                "assigned_to": user_ids["admin"],
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        original_id = r.json()["id"]

        # Fire IndiaMART webhook with Indian variant
        wh = {
            "RESPONSE": [
                {
                    "UNIQUE_QUERY_ID": f"TEST_IT5_XS_{uuid.uuid4().hex[:8]}",
                    "SENDER_NAME": "Cross Source Tester",
                    "SENDER_MOBILE": f"+91 {phone}",
                    "SENDER_EMAIL": "",
                    "SENDER_CITY": "Pune",
                    "SENDER_STATE": "MH",
                    "QUERY_PRODUCT_NAME": "Re-enquiry",
                    "QUERY_MESSAGE": "same number",
                    "QUERY_TIME": "2026-01-15 10:00:00",
                }
            ]
        }
        r2 = requests.post(f"{API}/webhooks/indiamart", json=wh, timeout=30)
        assert r2.status_code in (200, 201), r2.text

        # Verify only one lead matches this phone
        lst = requests.get(f"{API}/leads", headers=auth(admin_token), params={"q": phone}, timeout=30).json()
        matching = [l for l in lst if l.get("phone") == phone]
        assert len(matching) == 1, f"expected exactly 1 lead for {phone}, got {len(matching)}"
        assert matching[0]["id"] == original_id


# ---------- admin vs exec duplicate ----------
class TestDedupRBAC:
    def test_admin_post_duplicate_returns_existing_flagged(self, admin_token, user_ids):
        phone = _rand10()
        # seed
        r = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_ADM_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["admin"]},
            timeout=30,
        )
        assert r.status_code == 200
        first_id = r.json()["id"]
        # duplicate post
        r2 = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": "WhoeverNew", "phone": phone, "source": "Manual"},
            timeout=30,
        )
        assert r2.status_code == 200, r2.text
        data = r2.json()
        assert data["id"] == first_id
        assert data.get("duplicate") is True
        assert data.get("existed") is True

    def test_exec_duplicate_owned_by_self_returns_existing(self, admin_token, ravi_token, user_ids):
        phone = _rand10()
        # admin seeds lead assigned to ravi
        r = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_RAVI_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        )
        assert r.status_code == 200
        lead_id = r.json()["id"]
        # ravi posts same phone
        r2 = requests.post(
            f"{API}/leads",
            headers=auth(ravi_token),
            json={"customer_name": "Ravi Retry", "phone": phone, "source": "Manual"},
            timeout=30,
        )
        assert r2.status_code == 200, f"exec self-dup should return 200, got {r2.status_code} {r2.text}"
        assert r2.json()["id"] == lead_id

    def test_exec_duplicate_owned_by_other_returns_409_structured(self, admin_token, priya_token, user_ids):
        phone = _rand10()
        # admin seeds assigned to ravi
        r = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_FOREIGN_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        )
        assert r.status_code == 200
        existing_id = r.json()["id"]
        # priya tries
        r2 = requests.post(
            f"{API}/leads",
            headers=auth(priya_token),
            json={"customer_name": "Priya Try", "phone": phone, "source": "Manual"},
            timeout=30,
        )
        assert r2.status_code == 409, f"expected 409, got {r2.status_code} {r2.text}"
        detail = r2.json().get("detail") or {}
        assert detail.get("code") == "duplicate_phone"
        assert detail.get("existing_lead_id") == existing_id
        assert detail.get("owned_by_id") == user_ids["ravi"]
        assert detail.get("owned_by_username") == "ravi"
        assert detail.get("owned_by_name")
        assert "message" in detail


# ---------- add-phone cross-lead ----------
class TestAddPhoneCrossLead:
    def test_add_phone_already_on_other_lead_409(self, admin_token, user_ids):
        p1 = _rand10(); p2 = _rand10()
        # lead A with p1
        a = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_A_{p1}", "phone": p1, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        ).json()
        # lead B with p2
        b = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_B_{p2}", "phone": p2, "source": "Manual", "assigned_to": user_ids["priya"]},
            timeout=30,
        ).json()
        # Try to add p1 to lead B
        r = requests.post(
            f"{API}/leads/{b['id']}/phones",
            headers=auth(admin_token),
            json={"phone": f"+91 {p1}"},
            timeout=30,
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code} {r.text}"
        detail = r.json().get("detail") or {}
        assert detail.get("code") == "duplicate_phone"
        assert detail.get("existing_lead_id") == a["id"]

    def test_add_phone_already_on_same_lead_409(self, admin_token, user_ids):
        p = _rand10()
        lead = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_SAME_{p}", "phone": p, "source": "Manual", "assigned_to": user_ids["admin"]},
            timeout=30,
        ).json()
        r = requests.post(f"{API}/leads/{lead['id']}/phones", headers=auth(admin_token), json={"phone": p}, timeout=30)
        assert r.status_code == 409
        # detail is a string here, accept either
        detail = r.json().get("detail")
        if isinstance(detail, str):
            assert "already" in detail.lower()
        else:
            assert detail.get("code") in ("duplicate_phone",) or "already" in (detail.get("message", "").lower())


# ---------- start-chat dedup ----------
class TestStartChatDedup:
    def test_start_chat_foreign_owner_returns_structured_409(self, admin_token, priya_token, user_ids):
        phone = _rand10()
        requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_SC_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        )
        r = requests.post(
            f"{API}/inbox/start-chat",
            headers=auth(priya_token),
            json={"phone": f"+91 {phone}", "customer_name": "Priya"},
            timeout=30,
        )
        assert r.status_code == 409, r.text
        detail = r.json().get("detail") or {}
        assert detail.get("code") == "duplicate_phone"
        assert detail.get("owned_by_id") == user_ids["ravi"]

    def test_start_chat_admin_bypasses_and_returns_existing(self, admin_token, user_ids):
        phone = _rand10()
        seed = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_SCA_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        ).json()
        r = requests.post(
            f"{API}/inbox/start-chat",
            headers=auth(admin_token),
            json={"phone": phone, "customer_name": "Admin"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["id"] == seed["id"]


# ---------- search variations ----------
class TestSearchVariations:
    def test_all_variations_match(self, admin_token, user_ids):
        phone = _rand10()
        requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_SEARCH_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["admin"]},
            timeout=30,
        )
        for q in [f"+91{phone}", f"0{phone}", phone]:
            r = requests.get(f"{API}/leads", headers=auth(admin_token), params={"q": q}, timeout=30)
            assert r.status_code == 200, f"search q={q} failed: {r.status_code} {r.text}"
            hits = [l for l in r.json() if l.get("phone") == phone]
            assert len(hits) >= 1, f"no hits for q={q}"


# ---------- admin self-assign ----------
class TestAdminSelfAssign:
    def test_admin_reassign_to_self(self, admin_token, user_ids):
        phone = _rand10()
        lead = requests.post(
            f"{API}/leads",
            headers=auth(admin_token),
            json={"customer_name": f"TEST_IT5_SELF_{phone}", "phone": phone, "source": "Manual", "assigned_to": user_ids["ravi"]},
            timeout=30,
        ).json()
        r = requests.post(
            f"{API}/leads/{lead['id']}/reassign",
            headers=auth(admin_token),
            json={"assigned_to": user_ids["admin"]},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        after = requests.get(f"{API}/leads/{lead['id']}", headers=auth(admin_token), timeout=30).json()
        assert after["assigned_to"] == user_ids["admin"]


# ---------- round-robin excludes admin ----------
class TestRoundRobinExcludesAdmin:
    def test_indiamart_no_receiver_never_assigns_to_admin(self, admin_token, user_ids):
        # fire a fresh webhook (no RECEIVER_MOBILE)
        uid = f"TEST_IT5_RR_{uuid.uuid4().hex[:8]}"
        phone = _rand10()
        wh = {
            "RESPONSE": [
                {
                    "UNIQUE_QUERY_ID": uid,
                    "SENDER_NAME": "RR Tester",
                    "SENDER_MOBILE": phone,
                    "QUERY_PRODUCT_NAME": "RR",
                    "QUERY_MESSAGE": "auto",
                    "QUERY_TIME": "2026-01-15 10:00:00",
                }
            ]
        }
        r = requests.post(f"{API}/webhooks/indiamart", json=wh, timeout=30)
        assert r.status_code in (200, 201)
        # find created lead
        lst = requests.get(f"{API}/leads", headers=auth(admin_token), params={"q": phone}, timeout=30).json()
        assert lst, "no lead found"
        assert lst[0]["assigned_to"] != user_ids["admin"], f"round-robin leaked to admin: {lst[0]['assigned_to']}"


# ---------- migration ----------
class TestMigration:
    def test_no_plus91_or_hyphenated_indian_phones_remain(self, admin_token):
        leads = requests.get(f"{API}/leads", headers=auth(admin_token), params={"limit": 500}, timeout=30).json()
        offenders = []
        for l in leads:
            p = l.get("phone") or ""
            if not p:
                continue
            # Indian canonical = 10 digits exactly, int = +digits. Reject anything with spaces/hyphens/+91.
            if " " in p or "-" in p:
                offenders.append((l["id"], p))
                continue
            digits = re.sub(r"\D+", "", p)
            if len(digits) == 10 and p != digits:
                offenders.append((l["id"], p))
                continue
            if digits.startswith("91") and len(digits) == 12 and len(p) > 1 and not p.startswith("+"):
                offenders.append((l["id"], p))
        assert not offenders, f"non-canonical phones found: {offenders[:10]}"
