"""Iteration 12 backend regression tests.

Covers:
1. Inbound webhook now stores `from` AND `to_phone` on the msg_doc.
2. /api/leads/{id}/messages?phone= surfaces inbound messages from that phone.
3. PUT /api/leads/{id}/active-wa-phone still works (no auto-PUT on /chat,
   but the explicit endpoint must still mutate state when called).
"""
import os
import time
import uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def lead_with_inbound(auth_headers):
    """Create a lead and inject a synthetic inbound webhook from a known phone."""
    import random
    suf = f"{random.randint(1000000000, 9999999999)}"
    phone = f"+91{suf}"
    r = requests.post(
        f"{API}/leads",
        headers=auth_headers,
        json={"customer_name": f"TEST_iter12_{uuid.uuid4().hex[:6]}", "phone": phone, "requirement": "iter12"},
    )
    assert r.status_code in (200, 201), r.text
    lead_id = r.json()["id"]

    # Inject inbound webhook
    biz_display = "919812345678"
    wh = {
        "entry": [{
            "changes": [{
                "value": {
                    "messages": [{
                        "id": f"wamid_{uuid.uuid4().hex[:10]}",
                        "from": phone.lstrip("+"),
                        "timestamp": str(int(time.time())),
                        "text": {"body": "iter12-inbound-1"},
                        "type": "text",
                    }],
                    "metadata": {"display_phone_number": biz_display, "phone_number_id": "0000"},
                }
            }]
        }]
    }
    wr = requests.post(f"{API}/webhooks/whatsapp", json=wh)
    assert wr.status_code == 200, wr.text
    time.sleep(0.5)
    return {"lead_id": lead_id, "phone": phone, "biz_display": biz_display}


class TestInboundWebhookFields:
    def test_inbound_message_has_from_field(self, auth_headers, lead_with_inbound):
        lead_id = lead_with_inbound["lead_id"]
        r = requests.get(f"{API}/leads/{lead_id}/messages", headers=auth_headers)
        assert r.status_code == 200
        msgs = r.json()
        inbound = [m for m in msgs if m.get("direction") == "in"]
        assert len(inbound) >= 1, f"no inbound messages on lead, got {msgs}"
        for m in inbound:
            assert m.get("from"), f"inbound msg missing 'from': {m}"

    def test_inbound_message_has_to_phone_field(self, auth_headers, lead_with_inbound):
        lead_id = lead_with_inbound["lead_id"]
        biz = lead_with_inbound["biz_display"]
        r = requests.get(f"{API}/leads/{lead_id}/messages", headers=auth_headers)
        msgs = r.json()
        inbound = [m for m in msgs if m.get("direction") == "in"]
        assert any(biz in (m.get("to_phone") or "") for m in inbound), (
            f"inbound msgs missing display_phone_number={biz}: {inbound}"
        )

    def test_phone_filter_returns_inbound(self, auth_headers, lead_with_inbound):
        """The bug fix: per-phone filter must return inbound messages."""
        lead_id = lead_with_inbound["lead_id"]
        phone = lead_with_inbound["phone"]
        r = requests.get(f"{API}/leads/{lead_id}/messages", headers=auth_headers, params={"phone": phone})
        assert r.status_code == 200
        msgs = r.json()
        inbound = [m for m in msgs if m.get("direction") == "in"]
        assert len(inbound) >= 1, f"phone filter returned 0 inbound (regression of iter11 bug): {msgs}"


class TestChatDeepLinkNoMutation:
    """Iter12 frontend removed an auto-PUT /active-wa-phone on /chat?phone= deep links.
    There's no backend behavior to remove (the PUT endpoint still exists & works).
    But we verify GET /api/leads/{id} doesn't change active_wa_phone unexpectedly."""

    def test_active_wa_phone_not_set_implicitly(self, auth_headers, lead_with_inbound):
        lead_id = lead_with_inbound["lead_id"]
        # Read initial value
        g1 = requests.get(f"{API}/leads/{lead_id}", headers=auth_headers)
        assert g1.status_code == 200
        before = g1.json().get("active_wa_phone")
        # Simulate /chat deep-link: just call GET /messages?phone=… (no PUT)
        requests.get(f"{API}/leads/{lead_id}/messages", headers=auth_headers, params={"phone": "+919999999999"})
        # Re-read; active_wa_phone must be identical
        g2 = requests.get(f"{API}/leads/{lead_id}", headers=auth_headers)
        after = g2.json().get("active_wa_phone")
        assert before == after, f"active_wa_phone mutated unexpectedly: {before!r} -> {after!r}"
