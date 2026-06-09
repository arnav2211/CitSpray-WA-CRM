"""Lead starring backend tests.

Covers:
1. PATCH /api/leads/{id} updates the starred status.
2. GET /api/leads?starred=true filters leads to only show starred ones.
3. GET /api/inbox/conversations?starred=true filters conversations to only show starred ones.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8000").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def test_lead_starring_lifecycle(auth_headers):
    # 1. Create two unique leads
    import random
    suffix = uuid.uuid4().hex[:6]
    phone1 = f"+91{random.randint(1000000000, 9999999999)}"
    phone2 = f"+91{random.randint(1000000000, 9999999999)}"
    
    # Lead 1: Will be starred
    r1 = requests.post(
        f"{API}/leads",
        headers=auth_headers,
        json={"customer_name": f"StarredLead_{suffix}", "phone": phone1, "requirement": "need stars"},
    )
    assert r1.status_code in (200, 201), r1.text
    lead1 = r1.json()
    lead1_id = lead1["id"]
    
    # Lead 2: Will NOT be starred
    r2 = requests.post(
        f"{API}/leads",
        headers=auth_headers,
        json={"customer_name": f"UnstarredLead_{suffix}", "phone": phone2, "requirement": "no stars"},
    )
    assert r2.status_code in (200, 201), r2.text
    lead2 = r2.json()
    lead2_id = lead2["id"]
    
    # Verify initial starred status is falsy/None
    assert not lead1.get("starred")
    assert not lead2.get("starred")
    
    # 2. PATCH Lead 1 to be starred
    patch_r = requests.patch(
        f"{API}/leads/{lead1_id}",
        headers=auth_headers,
        json={"starred": True}
    )
    assert patch_r.status_code == 200, patch_r.text
    assert patch_r.json().get("starred") is True
    
    # 3. Verify via GET /leads
    get_all_r = requests.get(f"{API}/leads", headers=auth_headers)
    assert get_all_r.status_code == 200
    all_leads = get_all_r.json()
    # If returned as paginated dict, extract items
    leads_list = all_leads.get("items") if isinstance(all_leads, dict) else all_leads
    
    l1_found = next((ld for ld in leads_list if ld["id"] == lead1_id), None)
    l2_found = next((ld for ld in leads_list if ld["id"] == lead2_id), None)
    assert l1_found and l1_found.get("starred") is True
    assert l2_found and not l2_found.get("starred")
    
    # 4. Filter by starred=true on GET /leads
    get_starred_r = requests.get(f"{API}/leads", headers=auth_headers, params={"starred": "true"})
    assert get_starred_r.status_code == 200
    starred_leads = get_starred_r.json()
    starred_list = starred_leads.get("items") if isinstance(starred_leads, dict) else starred_leads
    
    starred_ids = [ld["id"] for ld in starred_list]
    assert lead1_id in starred_ids
    assert lead2_id not in starred_ids
    
    # 5. Inject message webhook for both leads to make them active in WhatsApp inbox
    for idx, phone in enumerate([phone1, phone2]):
        wh = {
            "entry": [{
                "changes": [{
                    "value": {
                        "messages": [{
                            "id": f"wamid_{uuid.uuid4().hex[:10]}",
                            "from": phone.lstrip("+"),
                            "timestamp": str(int(time.time())),
                            "text": {"body": f"inbox-msg-{idx}"},
                            "type": "text",
                        }],
                        "metadata": {"display_phone_number": "919812345678", "phone_number_id": "0000"},
                    }
                }]
            }]
        }
        wr = requests.post(f"{API}/webhooks/whatsapp", json=wh)
        assert wr.status_code == 200, wr.text
    
    time.sleep(0.5)
    
    # 6. Verify GET /inbox/conversations returns starred status and filters correctly
    get_convs_r = requests.get(f"{API}/inbox/conversations", headers=auth_headers)
    assert get_convs_r.status_code == 200
    convs = get_convs_r.json()
    
    c1_found = next((c for c in convs if c["id"] == lead1_id), None)
    c2_found = next((c for c in convs if c["id"] == lead2_id), None)
    
    assert c1_found, f"Lead 1 not found in inbox: {convs}"
    assert c2_found, f"Lead 2 not found in inbox: {convs}"
    assert c1_found.get("starred") is True
    assert not c2_found.get("starred")
    
    # Filter inbox by starred=true
    get_starred_convs_r = requests.get(f"{API}/inbox/conversations", headers=auth_headers, params={"starred": "true"})
    assert get_starred_convs_r.status_code == 200
    starred_convs = get_starred_convs_r.json()
    
    starred_conv_ids = [c["id"] for c in starred_convs]
    assert lead1_id in starred_conv_ids
    assert lead2_id not in starred_conv_ids
