import os
import uuid
import pytest
import requests

# Use the staging/production backend URL or local fallback
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "https://crm.mangalamagro.in").rstrip("/")
API = f"{BASE_URL}/api"

@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "Admin@123"})
    assert r.status_code == 200, f"Admin login failed: {r.text}"
    token = r.json()["token"]
    return {"Authorization": f"Bearer {token}"}

def test_executive_reports_rbac_and_enrichment(admin_headers):
    # 1. Create a temporary executive user
    suffix = uuid.uuid4().hex[:6]
    exec_username = f"exec_{suffix}"
    exec_password = "Password@123"
    
    r_create = requests.post(
        f"{API}/users",
        headers=admin_headers,
        json={
            "name": f"Test Exec {suffix}",
            "username": exec_username,
            "password": exec_password,
            "role": "executive",
            "active": True
        }
    )
    assert r_create.status_code in (200, 201), f"Failed to create test executive: {r_create.text}"
    exec_user = r_create.json()
    exec_id = exec_user["id"]
    
    try:
        # 2. Login as the temporary executive user
        r_login = requests.post(
            f"{API}/auth/login",
            json={"username": exec_username, "password": exec_password}
        )
        assert r_login.status_code == 200, f"Executive login failed: {r_login.text}"
        exec_token = r_login.json()["token"]
        exec_headers = {"Authorization": f"Bearer {exec_token}"}
        
        # 3. Test RBAC: Executive should NOT be able to access the admin overview reports
        r_overview = requests.get(f"{API}/reports/overview", headers=exec_headers)
        assert r_overview.status_code == 403, f"Executive should be denied from overview reports, but got {r_overview.status_code}"
        
        # 4. Test RBAC: Executive should NOT be able to access other executives' reports
        r_other = requests.get(f"{API}/reports/executive-detail/admin", headers=exec_headers)
        assert r_other.status_code == 403, f"Executive should be denied from other user reports, but got {r_other.status_code}"
        
        # 5. Test RBAC: Executive SHOULD be able to access their own report
        r_self = requests.get(f"{API}/reports/executive-detail/{exec_id}", headers=exec_headers)
        assert r_self.status_code == 200, f"Executive failed to retrieve their own report: {r_self.text}"
        
        data = r_self.json()
        
        # 6. Verify enriched data structure
        assert "executive" in data
        assert data["executive"]["id"] == exec_id
        assert "conversions" in data
        assert "conversion_rate" in data
        assert "leads_by_status" in data
        assert "calls_by_outcome" in data
        assert "followup_total" in data
        assert "followup_done" in data
        assert "followup_pending" in data
        assert "followup_completion_pct" in data
        assert "wa_messages_sent" in data
        assert "call_log" in data
        assert "total_calls" in data
        
        # Verify status breakdown contains all key statuses
        status_map = data["leads_by_status"]
        for status in ["new", "contacted", "qualified", "converted", "lost"]:
            assert status in status_map, f"Missing status '{status}' in leads_by_status"
            
        # Verify call outcomes breakdown contains all key outcomes
        outcome_map = data["calls_by_outcome"]
        for outcome in ["connected", "no_response", "rejected", "not_reachable", "busy", "invalid"]:
            assert outcome in outcome_map, f"Missing outcome '{outcome}' in calls_by_outcome"
            
    finally:
        # Cleanup: delete the temporary executive user
        requests.delete(f"{API}/users/{exec_id}", headers=admin_headers)
