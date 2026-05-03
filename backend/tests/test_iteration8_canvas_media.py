"""Iteration-8 ChatFlow upgrade tests: visual canvas + media nodes.

Covers:
- POST /api/chatflows/{id}/nodes default x/y stagger
- PUT  /api/chatflows/{id}/positions bulk position save (drag persistence)
- POST /api/chatflows/upload-media + GET /api/media/<name>
- send_flow_message routes image/video/document/carousel without ValueError
- Carousel chat_options round-trip (image card -> option with next_node_id)
- Connect-edge equivalent: PUT /chatflows/{id}/nodes/{src}/options updates next_node_id
- Regression: list/create/toggle/delete + button/list nodes still OK.
- WA is mock => 'sent_mock' counts as success.
"""
import io
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://crm-lead-mgmt-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

CREATED_FLOWS: list = []


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=30)
    assert r.status_code == 200, f"login {u}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin", "Admin@123")


@pytest.fixture(scope="module", autouse=True)
def _cleanup(admin_token):
    yield
    for fid in CREATED_FLOWS:
        try:
            requests.delete(f"{API}/chatflows/{fid}", headers=_h(admin_token), timeout=30)
        except Exception:
            pass


def _create_flow(token, name="TEST_IT8_canvas", active=False):
    r = requests.post(f"{API}/chatflows", headers=_h(token),
                      json={"name": name, "is_active": active}, timeout=30)
    assert r.status_code == 200, r.text
    f = r.json()
    CREATED_FLOWS.append(f["id"])
    return f


def _create_node(token, fid, name, mtype, content, is_start=False):
    body = {"name": name, "message_type": mtype, "message_content": content,
            "is_start_node": is_start}
    r = requests.post(f"{API}/chatflows/{fid}/nodes", headers=_h(token), json=body, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _put_options(token, fid, node_id, options):
    r = requests.put(f"{API}/chatflows/{fid}/nodes/{node_id}/options",
                     headers=_h(token), json=options, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# -------------------- canvas position --------------------

class TestCanvasNodePositions:
    def test_default_xy_stagger_for_first_few_nodes(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_xy")
        n0 = _create_node(admin_token, flow["id"], "n0", "text", {"body": "hi"}, is_start=True)
        n1 = _create_node(admin_token, flow["id"], "n1", "text", {"body": "hi"})
        n2 = _create_node(admin_token, flow["id"], "n2", "text", {"body": "hi"})
        # Defaults: 80 + (i%4)*320  for x; 80 + (i//4)*220 for y
        assert n0["x"] == 80.0 and n0["y"] == 80.0
        assert n1["x"] == 400.0 and n1["y"] == 80.0
        assert n2["x"] == 720.0 and n2["y"] == 80.0

    def test_bulk_position_save_persists(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_pos")
        n0 = _create_node(admin_token, flow["id"], "a", "text", {"body": "x"}, is_start=True)
        n1 = _create_node(admin_token, flow["id"], "b", "text", {"body": "y"})
        payload = {"positions": {n0["id"]: {"x": 123.5, "y": 456.5},
                                 n1["id"]: {"x": 999.0, "y": 1000.0}}}
        r = requests.put(f"{API}/chatflows/{flow['id']}/positions",
                         headers=_h(admin_token), json=payload, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("updated") == 2
        # GET to verify persisted
        flow_full = requests.get(f"{API}/chatflows/{flow['id']}", headers=_h(admin_token), timeout=30).json()
        by_id = {n["id"]: n for n in flow_full["nodes"]}
        assert by_id[n0["id"]]["x"] == 123.5 and by_id[n0["id"]]["y"] == 456.5
        assert by_id[n1["id"]]["x"] == 999.0 and by_id[n1["id"]]["y"] == 1000.0

    def test_positions_endpoint_404_for_unknown_flow(self, admin_token):
        r = requests.put(f"{API}/chatflows/{uuid.uuid4().hex}/positions",
                         headers=_h(admin_token), json={"positions": {}}, timeout=30)
        assert r.status_code == 404

    def test_positions_endpoint_admin_only(self):
        try:
            ravi = _login("ravi", "Exec@123")
        except AssertionError:
            pytest.skip("ravi not seeded")
        r = requests.put(f"{API}/chatflows/anything/positions",
                         headers=_h(ravi), json={"positions": {}}, timeout=30)
        assert r.status_code in (401, 403)


# -------------------- upload + serve --------------------

class TestUploadAndServeMedia:
    def test_upload_image_and_fetch(self, admin_token):
        png_bytes = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        files = {"file": ("hello.png", io.BytesIO(png_bytes), "image/png")}
        r = requests.post(f"{API}/chatflows/upload-media",
                          headers=_h(admin_token),
                          files=files, data={"kind": "image"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["url"].startswith("/api/media/")
        assert data["filename"] == "hello.png"
        assert data["size"] == len(png_bytes)
        # Fetch it
        r2 = requests.get(BASE_URL + data["url"], timeout=30)
        assert r2.status_code == 200
        assert r2.content[:8] == png_bytes[:8]

    def test_upload_invalid_kind_rejected(self, admin_token):
        files = {"file": ("x.bin", io.BytesIO(b"abc"), "application/octet-stream")}
        r = requests.post(f"{API}/chatflows/upload-media",
                          headers=_h(admin_token),
                          files=files, data={"kind": "audio"}, timeout=30)
        assert r.status_code == 400

    def test_upload_admin_only(self):
        try:
            ravi = _login("ravi", "Exec@123")
        except AssertionError:
            pytest.skip("ravi not seeded")
        files = {"file": ("x.png", io.BytesIO(b"123"), "image/png")}
        r = requests.post(f"{API}/chatflows/upload-media",
                          headers=_h(ravi),
                          files=files, data={"kind": "image"}, timeout=30)
        assert r.status_code in (401, 403)

    def test_serve_404_for_unknown(self):
        r = requests.get(f"{API}/media/{uuid.uuid4().hex}.png", timeout=30)
        assert r.status_code == 404


# -------------------- send_flow_message routing for new media types --------------------

def _ensure_lead_in_window(admin_token, phone):
    """Create lead and open 24h window via debug simulate webhook."""
    requests.post(f"{API}/leads", headers=_h(admin_token),
                  json={"name": "TEST_IT8 Lead", "phone": phone, "source": "manual"}, timeout=30)
    r = requests.post(f"{API}/webhooks/whatsapp/_debug/simulate",
                      headers=_h(admin_token),
                      json={"phone": phone, "text": "hi"}, timeout=30)
    # debug endpoint may not exist; ignore failures (text/media don't need 24h)
    return r.status_code in (200, 201, 204)


class TestMediaNodeSends:
    def _phone(self):
        # 10-digit IN-style phone
        n = uuid.uuid4().int % 10**10
        s = str(n).zfill(10)
        if s[0] in "01":
            s = "9" + s[1:]
        return s

    def test_image_node_send_returns_sent_mock(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_img", active=True)
        node = _create_node(admin_token, flow["id"], "img", "image",
                            {"media_url": "https://example.com/a.png", "caption": "cap"},
                            is_start=True)
        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": node["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") in ("sent", "sent_mock"), body

    def test_video_node_send_returns_sent_mock(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_vid", active=True)
        node = _create_node(admin_token, flow["id"], "vid", "video",
                            {"media_url": "https://example.com/v.mp4", "caption": "vc"},
                            is_start=True)
        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": node["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("status") in ("sent", "sent_mock")

    def test_document_node_send_returns_sent_mock(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_doc", active=True)
        node = _create_node(admin_token, flow["id"], "doc", "document",
                            {"media_url": "https://example.com/d.pdf", "caption": "spec",
                             "filename": "spec.pdf"}, is_start=True)
        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": node["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("status") in ("sent", "sent_mock")

    def test_image_node_missing_media_url_returns_error(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_img_nourl", active=True)
        node = _create_node(admin_token, flow["id"], "img2", "image",
                            {"caption": "x"}, is_start=True)
        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": node["id"]}, timeout=30)
        # send_flow_message returns {error:..} which start_flow surfaces as 400
        assert r.status_code in (200, 400)
        if r.status_code == 200:
            assert "error" in r.json()


class TestCarouselNode:
    def _phone(self):
        n = uuid.uuid4().int % 10**10
        s = str(n).zfill(10)
        if s[0] in "01":
            s = "9" + s[1:]
        return s

    def test_carousel_send_with_two_cards_options_and_next_node(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_car", active=True)
        # Targets for carousel button next_node_id
        t1 = _create_node(admin_token, flow["id"], "t1", "text", {"body": "Opt A"})
        t2 = _create_node(admin_token, flow["id"], "t2", "text", {"body": "Opt B"})
        car = _create_node(admin_token, flow["id"], "car", "carousel", {
            "body": "Pick one",
            "cards": [
                {"image_url": "https://example.com/a.png", "title": "A", "subtitle": "sub a",
                 "button_label": "Pick A"},
                {"image_url": "https://example.com/b.png", "title": "B", "subtitle": "sub b",
                 "button_label": "Pick B"},
            ],
        }, is_start=True)
        # link cards -> options -> next_node_id (this is what the canvas connect-edge does)
        opts = _put_options(admin_token, flow["id"], car["id"], [
            {"option_id": "card_0", "label": "Pick A", "next_node_id": t1["id"], "position": 0},
            {"option_id": "card_1", "label": "Pick B", "next_node_id": t2["id"], "position": 1},
        ])
        assert len(opts) == 2
        assert {o["next_node_id"] for o in opts} == {t1["id"], t2["id"]}

        # Verify GET returns options inside node
        full = requests.get(f"{API}/chatflows/{flow['id']}", headers=_h(admin_token), timeout=30).json()
        car_full = next(n for n in full["nodes"] if n["id"] == car["id"])
        assert len(car_full["options"]) == 2

        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": car["id"]}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        # Possible: sent / sent_mock / skipped_outside_24h (if simulate didn't open window)
        assert body.get("status") in ("sent", "sent_mock", "skipped_outside_24h"), body

    def test_carousel_no_cards_returns_error(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_car_empty", active=True)
        car = _create_node(admin_token, flow["id"], "car", "carousel", {"body": "p", "cards": []},
                           is_start=True)
        phone = self._phone()
        _ensure_lead_in_window(admin_token, phone)
        r = requests.post(f"{API}/chatflows/{flow['id']}/start",
                          headers=_h(admin_token),
                          json={"phone": phone, "node_id": car["id"]}, timeout=30)
        assert r.status_code in (200, 400)
        if r.status_code == 200:
            assert "error" in r.json()


# -------------------- Connect edge equivalent --------------------

class TestConnectEdgeUpdatesNextNodeId:
    def test_put_options_updates_next_node_id(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_conn")
        target = _create_node(admin_token, flow["id"], "tgt", "text", {"body": "after"})
        src = _create_node(admin_token, flow["id"], "src", "button",
                           {"body": "Pick", "header": "h"}, is_start=True)
        _put_options(admin_token, flow["id"], src["id"], [
            {"option_id": "yes", "label": "Yes", "next_node_id": None, "position": 0},
        ])
        # Simulate canvas drag: source-handle -> target-node connects "yes" to target
        opts = _put_options(admin_token, flow["id"], src["id"], [
            {"option_id": "yes", "label": "Yes", "next_node_id": target["id"], "position": 0},
        ])
        assert opts[0]["next_node_id"] == target["id"]
        full = requests.get(f"{API}/chatflows/{flow['id']}", headers=_h(admin_token), timeout=30).json()
        src_full = next(n for n in full["nodes"] if n["id"] == src["id"])
        assert src_full["options"][0]["next_node_id"] == target["id"]


# -------------------- Regression: list/toggle/delete still working --------------------

class TestRegressionFlowAdmin:
    def test_list_create_toggle_delete(self, admin_token):
        # create
        f = _create_flow(admin_token, "TEST_IT8_reg", active=False)
        # list
        r = requests.get(f"{API}/chatflows", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200
        assert any(x["id"] == f["id"] for x in r.json())
        # toggle on
        r = requests.patch(f"{API}/chatflows/{f['id']}", headers=_h(admin_token),
                           json={"is_active": True}, timeout=30)
        assert r.status_code == 200 and r.json()["is_active"] is True
        # toggle off
        r = requests.patch(f"{API}/chatflows/{f['id']}", headers=_h(admin_token),
                           json={"is_active": False}, timeout=30)
        assert r.status_code == 200 and r.json()["is_active"] is False
        # delete (auto-cleanup will retry; verify success here)
        r = requests.delete(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30)
        assert r.status_code == 200
        try:
            CREATED_FLOWS.remove(f["id"])
        except ValueError:
            pass
        r = requests.get(f"{API}/chatflows/{f['id']}", headers=_h(admin_token), timeout=30)
        assert r.status_code == 404

    def test_button_and_list_nodes_still_work(self, admin_token):
        flow = _create_flow(admin_token, "TEST_IT8_btnlist")
        b = _create_node(admin_token, flow["id"], "btn", "button",
                         {"body": "Pick", "header": "Hi"}, is_start=True)
        _put_options(admin_token, flow["id"], b["id"], [
            {"option_id": "y", "label": "Yes", "next_node_id": None, "position": 0},
            {"option_id": "n", "label": "No", "next_node_id": None, "position": 1},
        ])
        l = _create_node(admin_token, flow["id"], "lst", "list",
                         {"body": "Choose", "button_text": "Open"})
        _put_options(admin_token, flow["id"], l["id"], [
            {"option_id": "a", "label": "A", "next_node_id": None, "position": 0,
             "section_title": "First", "description": "d"},
        ])
        full = requests.get(f"{API}/chatflows/{flow['id']}", headers=_h(admin_token), timeout=30).json()
        assert len(full["nodes"]) == 2
        types = {n["message_type"] for n in full["nodes"]}
        assert types == {"button", "list"}
