from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import re
import json
import uuid
import hashlib
import hmac as hmac_mod
import logging
import smtplib
import ssl
import asyncio
import io
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal, Any, Dict

import bcrypt
import jwt
import httpx
from bs4 import BeautifulSoup
import pandas as pd
from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Query, UploadFile, File, Form, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import UpdateOne
from pydantic import BaseModel, Field, ConfigDict
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# ------------- Setup -------------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("crm")

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# ------------- OMS Integration Setup -------------
OMS_DB_NAME = os.environ.get("OMS_DB_NAME", "test_database")
OMS_BASE_URL = os.environ.get("OMS_BASE_URL", "https://oms.mangalamagro.in").rstrip("/")
oms_db = client[OMS_DB_NAME]

JWT_ALGORITHM = "HS256"
JWT_SECRET = os.environ.get("JWT_SECRET", "devsecret")
if JWT_SECRET == "devsecret":
    logging.getLogger("crm").critical(
        "JWT_SECRET is not set — running with the default dev secret. "
        "Every auth token is forgeable. Set JWT_SECRET in backend/.env immediately.")

# ------------- WhatsApp Cloud API config -------------
# Fallback defaults come from .env; the effective config can be overridden at
# runtime by writing to the `system_settings` collection (key="whatsapp") via
# /api/settings/whatsapp. This lets admins rotate phone numbers / tokens from
# inside the app without a redeploy.
WA_BASE_URL = "https://graph.facebook.com"

_WA_ENV_DEFAULTS = {
    "access_token": os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip(),
    "phone_number_id": os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip(),
    "waba_id": os.environ.get("WHATSAPP_WABA_ID", "").strip(),
    "api_version": os.environ.get("WHATSAPP_API_VERSION", "v22.0").strip() or "v22.0",
    "verify_token": os.environ.get("WHATSAPP_VERIFY_TOKEN", "leadorbit_meta_verify").strip(),
    "app_secret": os.environ.get("WHATSAPP_APP_SECRET", "").strip(),
    "default_template": os.environ.get("WHATSAPP_DEFAULT_TEMPLATE", "hello_world").strip() or "hello_world",
    "default_template_lang": os.environ.get("WHATSAPP_DEFAULT_TEMPLATE_LANG", "en_US").strip() or "en_US",
}

_WA_EDITABLE_FIELDS = list(_WA_ENV_DEFAULTS.keys())

async def get_wa_config() -> Dict[str, Any]:
    """Effective WhatsApp config = DB overrides > env defaults."""
    doc = await db.system_settings.find_one({"key": "whatsapp"}, {"_id": 0}) or {}
    out: Dict[str, Any] = {}
    for k, v in _WA_ENV_DEFAULTS.items():
        override = (doc.get(k) or "").strip() if isinstance(doc.get(k), str) else doc.get(k)
        out[k] = override if override else v
    out["enabled"] = bool(out["access_token"] and out["phone_number_id"])
    return out


def _normalize_phone(p: Optional[str]) -> str:
    if not p:
        return ""
    return re.sub(r"\D+", "", p)


def normalize_phone_display(p: Optional[str]) -> str:
    """Canonical storage / display format for phone numbers.
    Indian numbers (+91XXXXXXXXXX, 91XXXXXXXXXX, 091XXXXXXXXXX, 0XXXXXXXXXX, XXXXXXXXXX)
    are normalized to the bare 10-digit national form (e.g. '8790934618').
    All other numbers are returned as `+<digits>` (E.164-ish) so they stay searchable
    across +/space/dash variations.
    Empty / unparseable input returns ''."""
    if not p:
        return ""
    digits = re.sub(r"\D+", "", p)
    if not digits:
        return ""
    # Indian: 10-digit mobile, possibly prefixed with 91 / 091 / 0
    if len(digits) == 10:
        return digits
    if len(digits) in (11, 12, 13) and digits.endswith(digits[-10:]):
        prefix = digits[:-10]
        if prefix in ("0", "91", "091", "0091"):
            return digits[-10:]
    # International — keep full digits with leading +
    return "+" + digits


def phone_match_pattern(query: str) -> Optional[str]:
    """Return a regex pattern that matches stored phone fields against any of the
    common variations (with/without +, +91, 0, spaces, dashes). Indian 10-digit
    inputs are matched against the stored canonical 10-digit form. Anything else
    is matched on a digits-only substring."""
    digits = re.sub(r"\D+", "", query or "")
    if not digits:
        return None
    if len(digits) >= 10:
        return re.escape(digits[-10:]) + "$"
    return re.escape(digits)


_TPL_PLACEHOLDER_RX = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

def count_template_placeholders(body_text: Optional[str]) -> int:
    """Return the number of distinct placeholders ({{1}}, {{2}}, …, or {{name}}) in a
    WhatsApp template body. Used to decide whether to include `components` and to
    validate caller-supplied params against the actual template structure.
    For positional placeholders we return the highest index; for named placeholders
    we return the count of distinct names; mixed → max of the two."""
    if not body_text:
        return 0
    found = _TPL_PLACEHOLDER_RX.findall(body_text)
    if not found:
        return 0
    positional: List[int] = []
    named: set = set()
    for raw in found:
        s = raw.strip()
        if s.isdigit():
            try:
                positional.append(int(s))
            except Exception:
                pass
        else:
            named.add(s.lower())
    pos_max = max(positional) if positional else 0
    return max(pos_max, len(named))


async def _resolve_template_meta(template_name: str, lang_code: Optional[str] = None) -> Dict[str, Any]:
    """Look up an approved template doc by name (and optionally language) and return
    {body, language, params_required}. Falls back to {} when not found locally — caller
    can then send without components (Meta will reject if it actually has params)."""
    if not template_name:
        return {}
    query: Dict[str, Any] = {"name": template_name}
    doc = None
    if lang_code:
        doc = await db.whatsapp_templates.find_one({**query, "language": lang_code}, {"_id": 0})
    if not doc:
        doc = await db.whatsapp_templates.find_one(query, {"_id": 0})
    if not doc:
        return {}
    body = doc.get("body") or ""
    params_required = doc.get("params_required")
    if params_required is None:
        params_required = count_template_placeholders(body)
    return {
        "body": body,
        "language": doc.get("language"),
        "params_required": int(params_required),
        "status": doc.get("status"),
    }


async def wa_send_text(to_phone: str, body: str, reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    cfg = await get_wa_config()
    if not cfg["enabled"]:
        return {"mock": True, "status": "sent_mock", "wamid": None}
    to = _normalize_phone(to_phone)
    if not to:
        return {"error": "no_phone", "status": "failed"}
    url = f"{WA_BASE_URL}/{cfg['api_version']}/{cfg['phone_number_id']}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "text",
        "text": {"preview_url": False, "body": body},
    }
    if reply_to_wamid:
        payload["context"] = {"message_id": reply_to_wamid}

    async def _post(p: Dict[str, Any]) -> Any:
        async with httpx.AsyncClient(timeout=20.0) as cli:
            return await cli.post(url, json=p, headers={
                "Authorization": f"Bearer {cfg['access_token']}",
                "Content-Type": "application/json",
            })

    r = await _post(payload)
    # Meta returns 131009 / similar when context message_id is stale or from a different chat.
    # Spec asks us to fall back to a plain send in that case.
    if r.status_code >= 400 and reply_to_wamid:
        try:
            err = (r.json().get("error") or {})
        except Exception:
            err = {}
        if err.get("code") in (131009, 100, 131026) or "context" in (err.get("message") or "").lower():
            logger.info(f"Reply-context failed ({err.get('code')}); retrying without context")
            payload.pop("context", None)
            r = await _post(payload)
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text}
    if r.status_code >= 400:
        err = (data.get("error") or {}) if isinstance(data, dict) else {}
        return {"status": "failed", "http": r.status_code, "error": err.get("message") or str(data), "code": err.get("code"), "raw": data}
    wamid = None
    try:
        wamid = data["messages"][0]["id"]
    except Exception:
        pass
    return {"status": "sent", "wamid": wamid, "raw": data}


async def wa_send_template(to_phone: str, template_name: str, lang_code: Optional[str] = None, body_params: Optional[List[str]] = None) -> Dict[str, Any]:
    cfg = await get_wa_config()
    if not cfg["enabled"]:
        return {"mock": True, "status": "sent_mock", "wamid": None}
    to = _normalize_phone(to_phone)
    if not to:
        return {"error": "no_phone", "status": "failed"}
    url = f"{WA_BASE_URL}/{cfg['api_version']}/{cfg['phone_number_id']}/messages"
    template_block: Dict[str, Any] = {
        "name": template_name,
        "language": {"code": lang_code or cfg["default_template_lang"]},
    }
    # CRITICAL: only attach `components` when there is at least one param.
    # Sending an empty components/parameters array, or any params for a template
    # with zero placeholders, triggers Meta error (#132000).
    cleaned_params = [str(p) for p in (body_params or []) if str(p) != ""]
    if cleaned_params:
        template_block["components"] = [{
            "type": "body",
            "parameters": [{"type": "text", "text": p} for p in cleaned_params],
        }]
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "template",
        "template": template_block,
    }
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.post(url, json=payload, headers={
            "Authorization": f"Bearer {cfg['access_token']}",
            "Content-Type": "application/json",
        })
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text}
    if r.status_code >= 400:
        err = (data.get("error") or {}) if isinstance(data, dict) else {}
        return {"status": "failed", "http": r.status_code, "error": err.get("message") or str(data), "code": err.get("code"), "raw": data}
    wamid = None
    try:
        wamid = data["messages"][0]["id"]
    except Exception:
        pass
    return {"status": "sent", "wamid": wamid, "raw": data}

app = FastAPI(title="LeadOrbit CRM API")
UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

api = APIRouter(prefix="/api")

# ------------- Helpers -------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    return dt.astimezone(timezone.utc).isoformat()

def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False

def create_access_token(user_id: str, username: str, role: str, token_version: int = 0) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "exp": now_utc() + timedelta(hours=12),
        "type": "access",
        "token_version": token_version,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def strip_mongo(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return doc
    doc.pop("_id", None)
    doc.pop("password_hash", None)
    return doc

# ------------- Models -------------
class LoginInput(BaseModel):
    username: str
    password: str

class UserOut(BaseModel):
    id: str
    username: str
    name: str
    role: str
    active: bool = True
    working_hours: List[Dict[str, Any]] = []
    created_at: Optional[str] = None
    joining_date: Optional[str] = None
    base_salary: float = 0.0
    bypass_attendance: bool = False
    employee_code: Optional[str] = None

class UserCreate(BaseModel):
    username: str
    password: str
    name: str
    role: Literal["admin", "executive", "data_entry", "staff"] = "executive"
    active: bool = True
    working_hours: List[Dict[str, Any]] = []
    receiver_numbers: List[str] = []
    joining_date: Optional[str] = None
    base_salary: float = 0.0
    bypass_attendance: bool = False
    employee_code: Optional[str] = None
    department: Optional[str] = None

class UserUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Literal["admin", "executive", "data_entry", "staff"]] = None
    active: Optional[bool] = None
    working_hours: Optional[List[Dict[str, Any]]] = None
    receiver_numbers: Optional[List[str]] = None
    joining_date: Optional[str] = None
    base_salary: Optional[float] = None
    bypass_attendance: Optional[bool] = None
    employee_code: Optional[str] = None
    department: Optional[str] = None

class HolidayCreate(BaseModel):
    date: str  # YYYY-MM-DD
    name: str
    is_paid: bool = True
    holiday_type: Literal["full", "early_off"] = "full"
    early_off_time: Optional[str] = None  # "HH:MM" — punch-outs at/after this count as full day

class FaceRegisterInput(BaseModel):
    user_id: str
    face_embedding: List[float]

class FaceVerifyInput(BaseModel):
    face_embedding: List[float]
    photo_base64: str

class PayrollAdjustInput(BaseModel):
    user_id: str
    date: str  # YYYY-MM-DD
    status: Literal["informed", "uninformed", "present", "half_day", "leave", "paid", "wfh", "auto"]


class PunchEditInput(BaseModel):
    user_id: str
    date: str                      # YYYY-MM-DD
    check_in: Optional[str] = None   # "HH:MM" (IST) or null to leave unchanged
    check_out: Optional[str] = None  # "HH:MM" (IST) or null to leave unchanged
    clear_check_out: bool = False    # remove the punch-out
    remove: bool = False             # delete the whole day's log


class AttendanceSettingsInput(BaseModel):
    office_start: Optional[str] = None            # "10:30"
    late_grace_until: Optional[str] = None        # "11:00"
    office_end: Optional[str] = None              # "19:00"
    full_day_out_grace_minutes: Optional[int] = None
    half_day_cutoff: Optional[str] = None         # "15:00"
    late_streak_threshold: Optional[int] = None
    stale_new_days: Optional[int] = None
    wfh_pool_user_ids: Optional[List[str]] = None
    wfh_afterhours_enabled: Optional[bool] = None
    attendance_routing_enabled: Optional[bool] = None


class ReceiverNumbersInput(BaseModel):
    receiver_numbers: List[str]

class LeadCreate(BaseModel):
    customer_name: str
    phone: Optional[str] = None
    phones: Optional[List[str]] = None
    email: Optional[str] = None
    emails: Optional[List[str]] = None
    requirement: Optional[str] = None
    area: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    source: str = "Manual"
    enquiry_type: Optional[str] = None
    contact_link: Optional[str] = None
    gst_no: Optional[str] = None
    source_data: Dict[str, Any] = {}
    assigned_to: Optional[str] = None  # user id

class LeadUpdate(BaseModel):
    customer_name: Optional[str] = None
    phone: Optional[str] = None
    phones: Optional[List[str]] = None
    aliases: Optional[List[str]] = None
    email: Optional[str] = None
    emails: Optional[List[str]] = None
    requirement: Optional[str] = None
    area: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    enquiry_type: Optional[str] = None
    status: Optional[Literal["new", "contacted", "qualified", "converted", "lost"]] = None
    assigned_to: Optional[str] = None
    active_wa_phone: Optional[str] = None
    starred: Optional[bool] = None
    gst_no: Optional[str] = None


CALL_OUTCOMES = ("connected", "no_response", "rejected", "not_reachable", "busy", "invalid", "initiated")


class CallLogInput(BaseModel):
    phone: str
    outcome: Literal["connected", "no_response", "rejected", "not_reachable", "busy", "invalid", "initiated"]
    summary: Optional[str] = None  # required only for outcome=connected
    lead_status: Optional[str] = None


class SyncedCallRecord(BaseModel):
    phone: str
    call_type: str
    timestamp: str
    duration_seconds: int
    note: Optional[str] = None
    direction: Optional[str] = None
    lead_status: Optional[str] = None


class CallSyncBatchInput(BaseModel):
    logs: List[SyncedCallRecord]


class ActiveWaPhoneInput(BaseModel):
    phone: str

class PhoneInput(BaseModel):
    phone: str

class NoteInput(BaseModel):
    body: str

class ReassignInput(BaseModel):
    assigned_to: str

class FollowupCreate(BaseModel):
    lead_id: str
    due_at: str  # iso
    note: Optional[str] = ""

class FollowupUpdate(BaseModel):
    status: Optional[Literal["pending", "done", "missed"]] = None
    note: Optional[str] = None
    due_at: Optional[str] = None

class WhatsAppSendInput(BaseModel):
    lead_id: str
    body: str
    template_name: Optional[str] = None
    template_lang: Optional[str] = None
    template_params: Optional[List[str]] = None  # explicit body params; if omitted backend infers
    reply_to_message_id: Optional[str] = None  # local UUID of the message being replied to
    to_all_numbers: Optional[bool] = False  # send the same message to every number on the lead

class TemplateCreate(BaseModel):
    name: str
    category: Literal["utility", "marketing"] = "utility"
    body: str

class RoutingRulesUpdate(BaseModel):
    round_robin_enabled: Optional[bool] = None
    unopened_reassign_minutes: Optional[int] = None
    no_action_reassign_minutes: Optional[int] = None
    time_slot_enabled: Optional[bool] = None
    auto_whatsapp_on_create: Optional[bool] = None

class JustdialIngestInput(BaseModel):
    raw_email_html: Optional[str] = ""
    raw_email_text: Optional[str] = ""
    subject: Optional[str] = ""
    from_email: Optional[str] = "instantemail@justdial.com"

# Buyleads routing (per-source selective round-robin)
class BuyleadsRoutingInput(BaseModel):
    mode: Optional[str] = None          # "all" | "selected"
    agent_ids: Optional[List[str]] = None

# Leave / Holiday management
class LeaveCreate(BaseModel):
    user_id: str
    start_date: str                     # "YYYY-MM-DD"
    end_date: str                       # "YYYY-MM-DD"
    reason: Optional[str] = ""

class LeaveUpdate(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    reason: Optional[str] = None

class LeaveApplyInput(BaseModel):
    start_date: str                     # "YYYY-MM-DD"
    end_date: str                       # "YYYY-MM-DD"
    reason: str                         # required — employees must give a proper reason

class LeaveDecisionInput(BaseModel):
    note: Optional[str] = ""

# Internal Admin↔Agent Q&A
class InternalChatSend(BaseModel):
    lead_id: str
    body: str
    message_id: Optional[str] = None    # optional WA message the agent is referring to
    to_user_id: Optional[str] = None    # required when admin replies (which agent)

# ------------- Auth dependencies -------------
async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user or not user.get("active", True):
        raise HTTPException(status_code=401, detail="User not found or inactive")
    if user.get("token_version", 0) != payload.get("token_version", 0):
        raise HTTPException(status_code=401, detail="Session expired or logged out from all devices")
    # Soft-logout: if this is an executive currently on leave, force-401 so the
    # frontend's global 401 interceptor logs them out on the next poll (~4s).
    # Admins are never blocked even if they are marked on leave (edge-case safety).
    if user.get("role") == "executive":
        leave = await _is_user_on_leave(user["id"])
        if leave:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "user_on_leave",
                    "message": "You are currently on leave. Access has been disabled until your return.",
                    "leave_start": leave.get("start_date"),
                    "leave_end": leave.get("end_date"),
                },
            )
        # Attendance lockout enforcement (completely disabled as requested)
        pass
    user.pop("password_hash", None)
    return user

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# ------------- Auth endpoints -------------

# Simple in-memory login throttle: after 5 failed attempts for a username+IP
# pair, block further attempts for 15 minutes. Per-worker (4 workers), which
# still caps brute force at ~20 attempts / 15 min — plenty for a small team.
_LOGIN_FAILS: Dict[str, List[float]] = {}
_LOGIN_MAX_FAILS = 5
_LOGIN_WINDOW_SECS = 15 * 60

def _login_throttle_key(uname: str, request: Optional[Request]) -> str:
    ip = request.client.host if (request and request.client) else "?"
    return f"{uname}|{ip}"

def _login_blocked(key: str) -> bool:
    import time as _time
    now = _time.time()
    fails = [t for t in _LOGIN_FAILS.get(key, []) if now - t < _LOGIN_WINDOW_SECS]
    _LOGIN_FAILS[key] = fails
    return len(fails) >= _LOGIN_MAX_FAILS

def _login_record_fail(key: str):
    import time as _time
    _LOGIN_FAILS.setdefault(key, []).append(_time.time())

@api.post("/auth/login")
async def login(body: LoginInput, response: Response, request: Request):
    uname = body.username.strip().lower()
    throttle_key = _login_throttle_key(uname, request)
    if _login_blocked(throttle_key):
        raise HTTPException(status_code=429, detail="Too many failed attempts — try again in 15 minutes")
    user = await db.users.find_one({"username": uname})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        _login_record_fail(throttle_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    _LOGIN_FAILS.pop(throttle_key, None)
    if not user.get("active", True):
        raise HTTPException(status_code=403, detail="Account disabled")
    # Block login during an active leave (executives only). Admins stay active.
    if user.get("role") == "executive":
        leave = await _is_user_on_leave(user["id"])
        if leave:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "user_on_leave",
                    "message": f"You are on leave until {leave.get('end_date')}. Access is disabled during this period.",
                    "leave_start": leave.get("start_date"),
                    "leave_end": leave.get("end_date"),
                },
            )
    token = create_access_token(user["id"], user["username"], user["role"], user.get("token_version", 0))
    response.set_cookie(
        key="access_token", value=token, httponly=True,
        # HTTPS-only by default (prod runs behind TLS); set COOKIE_SECURE=0 for local http dev
        secure=os.environ.get("COOKIE_SECURE", "1") != "0",
        samesite="lax", max_age=43200, path="/",
    )
    user.pop("_id", None)
    user.pop("password_hash", None)
    return {"user": user, "token": token}

@api.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}

@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user

# ------------- Users management -------------
@api.get("/users")
async def list_users(user: dict = Depends(get_current_user)):
    # Admins get the full record; everyone else only needs names/roles for
    # dropdowns — never salaries, face embeddings, or receiver numbers.
    if user.get("role") == "admin":
        users = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    else:
        users = await db.users.find({}, {
            "_id": 0, "id": 1, "name": 1, "username": 1, "role": 1,
            "active": 1, "department": 1, "employee_code": 1,
        }).to_list(500)
    return users

@api.post("/users")
async def create_user(body: UserCreate, admin: dict = Depends(require_admin)):
    uname = body.username.strip().lower()
    if await db.users.find_one({"username": uname}):
        raise HTTPException(status_code=409, detail="Username already exists")
    rx = _normalize_receiver_list(body.receiver_numbers or [])
    await _ensure_receiver_unique(rx, exclude_user_id=None)
    doc = {
        "id": str(uuid.uuid4()),
        "username": uname,
        "name": body.name,
        "password_hash": hash_password(body.password),
        "role": body.role,
        "active": body.active,
        "working_hours": body.working_hours,
        "receiver_numbers": rx,
        "created_at": iso(now_utc()),
        "joining_date": body.joining_date or (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d"),
        "base_salary": body.base_salary or 0.0,
        "bypass_attendance": body.bypass_attendance or False,
        "employee_code": body.employee_code,
        "department": body.department,
    }
    await db.users.insert_one(doc.copy())
    return strip_mongo(doc)

@api.patch("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    updates: Dict[str, Any] = {}
    for f in ["name", "role", "active", "working_hours", "joining_date", "base_salary", "bypass_attendance", "employee_code", "department"]:
        v = getattr(body, f)
        if v is not None:
            updates[f] = v
    if body.receiver_numbers is not None:
        rx = _normalize_receiver_list(body.receiver_numbers)
        await _ensure_receiver_unique(rx, exclude_user_id=user_id)
        updates["receiver_numbers"] = rx
    if body.password:
        updates["password_hash"] = hash_password(body.password)
    if updates:
        ops: Dict[str, Any] = {"$set": updates}
        if body.password:
            # Revoke all existing sessions when the password changes
            ops["$inc"] = {"token_version": 1}
        await db.users.update_one({"id": user_id}, ops)
    doc = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return doc

@api.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    strategy: str = "none",
    single_agent_id: Optional[str] = None,
    multiple_agent_ids: Optional[str] = None,
    admin: dict = Depends(require_admin)
):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
        
    if u.get("role") == "executive":
        leads = await db.leads.find({"assigned_to": user_id}).to_list(100000)
        if leads:
            active_execs = await db.users.find(
                {"role": "executive", "active": True, "id": {"$ne": user_id}},
                {"id": 1}
            ).to_list(500)
            active_exec_ids = [ae["id"] for ae in active_execs]
            
            targets = []
            if strategy == "all_equally":
                targets = active_exec_ids
            elif strategy == "single" and single_agent_id:
                targets = [single_agent_id]
            elif strategy == "multiple" and multiple_agent_ids:
                sel_ids = [i.strip() for i in multiple_agent_ids.split(",") if i.strip()]
                targets = [uid for uid in sel_ids if uid in active_exec_ids]
                
            if not targets:
                await db.leads.update_many(
                    {"assigned_to": user_id},
                    {"$set": {"assigned_to": None, "last_reassigned_at": iso(now_utc()), "sort_at": iso(now_utc())}}
                )
            else:
                import random
                random.shuffle(targets)
                bulk_ops = []
                for idx, lead in enumerate(leads):
                    target_agent = targets[idx % len(targets)]
                    entry = {"user_id": target_agent, "at": iso(now_utc()), "by": admin["id"]}
                    bulk_ops.append(
                        UpdateOne(
                            {"id": lead["id"]},
                            {
                                "$set": {
                                    "assigned_to": target_agent,
                                    "last_reassigned_at": iso(now_utc()),
                                    "sort_at": iso(now_utc()),
                                    "opened_at": None
                                },
                                "$push": {"assignment_history": entry}
                            }
                        )
                    )
                if bulk_ops:
                    await db.leads.bulk_write(bulk_ops)
                    
    await db.users.delete_one({"id": user_id})
    return {"ok": True}

@api.get("/admin/data-entry-stats")
async def get_data_entry_stats(admin: dict = Depends(require_admin)):
    data_entry_users = await db.users.find({"role": "data_entry"}, {"_id": 0, "password_hash": 0}).to_list(100)
    stats = []
    for u in data_entry_users:
        count = await db.leads.count_documents({"created_by": u["id"]})
        stats.append({
            "id": u["id"],
            "username": u["username"],
            "name": u["name"],
            "active": u.get("active", True),
            "leads_uploaded": count
        })
    return stats

# ------------- Receiver numbers (PNS / call routing) -------------
def _normalize_receiver_list(items: List[str]) -> List[str]:
    out: List[str] = []
    seen: set = set()
    for raw in items or []:
        n = _normalize_phone(raw)
        if not n:
            continue
        # Compare on last 10 digits to avoid +91 / 0 prefixes mismatching
        key = n[-10:] if len(n) >= 10 else n
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    return out


async def _ensure_receiver_unique(numbers: List[str], exclude_user_id: Optional[str]):
    if not numbers:
        return
    suffixes = [n[-10:] if len(n) >= 10 else n for n in numbers]
    cursor = db.users.find({"receiver_numbers": {"$exists": True, "$ne": []}}, {"_id": 0, "id": 1, "name": 1, "receiver_numbers": 1})
    async for u in cursor:
        if exclude_user_id and u.get("id") == exclude_user_id:
            continue
        for ex in (u.get("receiver_numbers") or []):
            ex_suffix = _normalize_phone(ex)[-10:]
            if ex_suffix and ex_suffix in suffixes:
                raise HTTPException(status_code=409, detail=f"Number {ex} is already mapped to {u.get('name')}")


async def _find_user_for_receiver(receiver_phone: str) -> Optional[dict]:
    """Find the user (admin or executive) whose receiver_numbers contain this phone (suffix-match)."""
    if not receiver_phone:
        return None
    suffix = _normalize_phone(receiver_phone)[-10:]
    if not suffix:
        return None
    cursor = db.users.find({"active": True}, {"_id": 0, "password_hash": 0})
    async for u in cursor:
        # 1. New: receiver_numbers array
        for r in (u.get("receiver_numbers") or []):
            if _normalize_phone(r)[-10:] == suffix:
                return u
        # 2. Legacy: phone field on the user record
        if _normalize_phone(u.get("phone") or "")[-10:] == suffix:
            return u
    return None


@api.put("/users/{user_id}/receiver-numbers")
async def set_user_receiver_numbers(user_id: str, body: ReceiverNumbersInput, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    rx = _normalize_receiver_list(body.receiver_numbers)
    await _ensure_receiver_unique(rx, exclude_user_id=user_id)
    await db.users.update_one({"id": user_id}, {"$set": {"receiver_numbers": rx}})
    await log_activity(admin["id"], "receiver_numbers_updated", None, {"user_id": user_id, "count": len(rx)})
    doc = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return doc


@api.get("/settings/receiver-routing")
async def get_receiver_routing(admin: dict = Depends(require_admin)):
    """Return the receiver-number → user mapping for the admin Call Routing UI."""
    users = await db.users.find({"active": True}, {"_id": 0, "password_hash": 0}).sort("name", 1).to_list(500)
    rows = []
    for u in users:
        rows.append({
            "id": u["id"],
            "name": u["name"],
            "username": u["username"],
            "role": u["role"],
            "receiver_numbers": u.get("receiver_numbers") or [],
        })
    return {"users": rows}


# ------------- Buyleads routing (admin-only) -------------
BUYLEADS_SOURCES = ("IndiaMART", "ExportersIndia")

@api.get("/settings/buyleads-routing")
async def get_buyleads_routing(admin: dict = Depends(require_admin)):
    """Return the per-source buyleads routing config + eligible executives for the UI."""
    out = []
    for src in BUYLEADS_SOURCES:
        cfg = await _get_buyleads_routing(src)
        out.append(cfg)
    # Include active executives so UI can render the multi-select
    execs = await db.users.find(
        {"role": "executive", "active": True},
        {"_id": 0, "password_hash": 0},
    ).sort("name", 1).to_list(500)
    return {"configs": out, "executives": execs}


@api.put("/settings/buyleads-routing/{source}")
async def update_buyleads_routing(source: str, body: BuyleadsRoutingInput, admin: dict = Depends(require_admin)):
    if source not in BUYLEADS_SOURCES:
        raise HTTPException(status_code=400, detail=f"source must be one of {list(BUYLEADS_SOURCES)}")
    patch: Dict[str, Any] = {"source": source, "updated_at": iso(now_utc()), "updated_by": admin["id"]}
    if body.mode is not None:
        if body.mode not in ("all", "selected"):
            raise HTTPException(status_code=400, detail="mode must be 'all' or 'selected'")
        patch["mode"] = body.mode
    if body.agent_ids is not None:
        # Validate agents exist and are executives
        valid_ids: List[str] = []
        for uid in body.agent_ids:
            u = await db.users.find_one({"id": uid, "role": "executive"}, {"_id": 0, "id": 1})
            if u:
                valid_ids.append(uid)
        patch["agent_ids"] = valid_ids
    await db.buyleads_routing.update_one({"source": source}, {"$set": patch}, upsert=True)
    await log_activity(admin["id"], "buyleads_routing_updated", None, {"source": source, "mode": patch.get("mode"), "count": len(patch.get("agent_ids", []) or [])})
    cfg = await _get_buyleads_routing(source)
    return cfg


# ------------- Leave / Holiday management (admin-only CRUD) -------------
def _valid_date_str(s: str) -> bool:
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except Exception:
        return False


@api.get("/leaves")
async def list_leaves(admin: dict = Depends(require_admin), user_id: Optional[str] = None, active_only: bool = False, status: Optional[str] = None):
    query: Dict[str, Any] = {"cancelled": {"$ne": True}}
    if user_id:
        query["user_id"] = user_id
    if status == "pending":
        query["status"] = "pending"
    elif status == "approved":
        query["status"] = {"$nin": ["pending", "rejected"]}
    elif status == "rejected":
        query["status"] = "rejected"
    if active_only:
        today = now_utc().strftime("%Y-%m-%d")
        query["start_date"] = {"$lte": today}
        query["end_date"] = {"$gte": today}
    leaves = await db.leaves.find(query, {"_id": 0}).sort("start_date", -1).to_list(500)
    # Enrich with user name for easy display
    by_id: Dict[str, dict] = {}
    for lv in leaves:
        uid = lv.get("user_id")
        if uid and uid not in by_id:
            u = await db.users.find_one({"id": uid}, {"_id": 0, "id": 1, "name": 1, "username": 1, "role": 1})
            if u:
                by_id[uid] = u
        u = by_id.get(uid) or {}
        lv["user_name"] = u.get("name")
        lv["user_username"] = u.get("username")
        today = now_utc().strftime("%Y-%m-%d")
        lv["is_active"] = (lv.get("start_date", "") <= today <= lv.get("end_date", ""))
        if not lv.get("status"):
            lv["status"] = "approved"  # legacy admin-created leaves
    return leaves


@api.post("/leaves")
async def create_leave(body: LeaveCreate, admin: dict = Depends(require_admin)):
    if not _valid_date_str(body.start_date) or not _valid_date_str(body.end_date):
        raise HTTPException(status_code=400, detail="start_date/end_date must be YYYY-MM-DD")
    if body.start_date > body.end_date:
        raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
    u = await db.users.find_one({"id": body.user_id}, {"_id": 0, "id": 1, "name": 1, "role": 1})
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    leave = {
        "id": str(uuid.uuid4()),
        "user_id": body.user_id,
        "start_date": body.start_date,
        "end_date": body.end_date,
        "reason": (body.reason or "").strip(),
        "status": "approved",          # admin-created leaves are approved by definition
        "decided_by": admin["id"],
        "decided_at": iso(now_utc()),
        "cancelled": False,
        "created_at": iso(now_utc()),
        "created_by": admin["id"],
    }
    await db.leaves.insert_one(leave.copy())
    leave.pop("_id", None)
    await log_activity(admin["id"], "leave_created", None, {"user_id": body.user_id, "start_date": body.start_date, "end_date": body.end_date})
    return leave


@api.post("/leaves/apply")
async def apply_leave(body: LeaveApplyInput, user: dict = Depends(get_current_user)):
    """Employee self-service leave application. Requires a proper reason.
    Goes to the admin as 'pending'; approved leave costs 1 day's salary per day,
    absence without approval costs 2 days per day."""
    if user.get("role") == "admin":
        raise HTTPException(status_code=400, detail="Admins add leaves directly from the Payroll page")
    if not _valid_date_str(body.start_date) or not _valid_date_str(body.end_date):
        raise HTTPException(status_code=400, detail="start_date/end_date must be YYYY-MM-DD")
    if body.start_date > body.end_date:
        raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
    reason = (body.reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(status_code=400, detail="Please give a proper reason for the leave")
    overlap = await db.leaves.find_one({
        "user_id": user["id"],
        "cancelled": {"$ne": True},
        "status": {"$ne": "rejected"},
        "start_date": {"$lte": body.end_date},
        "end_date": {"$gte": body.start_date},
    }, {"_id": 0, "id": 1})
    if overlap:
        raise HTTPException(status_code=409, detail="You already have a leave request overlapping these dates")
    leave = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "start_date": body.start_date,
        "end_date": body.end_date,
        "reason": reason,
        "status": "pending",
        "cancelled": False,
        "created_at": iso(now_utc()),
        "created_by": user["id"],
    }
    await db.leaves.insert_one(leave.copy())
    leave.pop("_id", None)
    await log_activity(user["id"], "leave_applied", None, {"start_date": body.start_date, "end_date": body.end_date})
    await create_system_alert(
        "leave_request",
        f"Leave request: {user['name']}",
        f"{user['name']} applied for leave {body.start_date} → {body.end_date}. Reason: {reason}",
        dedup_key=f"leave_request:{leave['id']}",
    )
    return leave


@api.get("/leaves/my")
async def my_leaves(user: dict = Depends(get_current_user)):
    leaves = await db.leaves.find(
        {"user_id": user["id"], "cancelled": {"$ne": True}}, {"_id": 0}
    ).sort("start_date", -1).to_list(100)
    for lv in leaves:
        if not lv.get("status"):
            lv["status"] = "approved"  # legacy admin-created
    return leaves


@api.post("/leaves/{leave_id}/approve")
async def approve_leave(leave_id: str, body: LeaveDecisionInput, admin: dict = Depends(require_admin)):
    existing = await db.leaves.find_one({"id": leave_id, "cancelled": {"$ne": True}}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="leave not found")
    await db.leaves.update_one({"id": leave_id}, {"$set": {
        "status": "approved", "decision_note": (body.note or "").strip(),
        "decided_by": admin["id"], "decided_at": iso(now_utc()),
    }})
    await log_activity(admin["id"], "leave_approved", None, {"leave_id": leave_id, "user_id": existing.get("user_id")})
    return {"ok": True, "status": "approved"}


@api.post("/leaves/{leave_id}/reject")
async def reject_leave(leave_id: str, body: LeaveDecisionInput, admin: dict = Depends(require_admin)):
    existing = await db.leaves.find_one({"id": leave_id, "cancelled": {"$ne": True}}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="leave not found")
    await db.leaves.update_one({"id": leave_id}, {"$set": {
        "status": "rejected", "decision_note": (body.note or "").strip(),
        "decided_by": admin["id"], "decided_at": iso(now_utc()),
    }})
    await log_activity(admin["id"], "leave_rejected", None, {"leave_id": leave_id, "user_id": existing.get("user_id")})
    return {"ok": True, "status": "rejected"}


@api.patch("/leaves/{leave_id}")
async def update_leave(leave_id: str, body: LeaveUpdate, admin: dict = Depends(require_admin)):
    existing = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="leave not found")
    patch: Dict[str, Any] = {"updated_at": iso(now_utc()), "updated_by": admin["id"]}
    if body.start_date is not None:
        if not _valid_date_str(body.start_date):
            raise HTTPException(status_code=400, detail="start_date must be YYYY-MM-DD")
        patch["start_date"] = body.start_date
    if body.end_date is not None:
        if not _valid_date_str(body.end_date):
            raise HTTPException(status_code=400, detail="end_date must be YYYY-MM-DD")
        patch["end_date"] = body.end_date
    if body.reason is not None:
        patch["reason"] = body.reason.strip()
    final_start = patch.get("start_date", existing.get("start_date"))
    final_end = patch.get("end_date", existing.get("end_date"))
    if final_start > final_end:
        raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
    await db.leaves.update_one({"id": leave_id}, {"$set": patch})
    await log_activity(admin["id"], "leave_updated", None, {"leave_id": leave_id, **{k: v for k, v in patch.items() if k != "updated_at"}})
    updated = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
    return updated


@api.post("/leaves/{leave_id}/cancel")
async def cancel_leave(leave_id: str, admin: dict = Depends(require_admin)):
    existing = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="leave not found")
    await db.leaves.update_one({"id": leave_id}, {"$set": {
        "cancelled": True, "cancelled_at": iso(now_utc()), "cancelled_by": admin["id"],
    }})
    await log_activity(admin["id"], "leave_cancelled", None, {"leave_id": leave_id, "user_id": existing.get("user_id")})
    return {"ok": True}


@api.delete("/leaves/{leave_id}")
async def delete_leave(leave_id: str, admin: dict = Depends(require_admin)):
    # Alias for cancel — keeps the DELETE verb available for the UI.
    return await cancel_leave(leave_id, admin=admin)


# ------------- Internal Admin ↔ Agent Q&A chat -------------
async def _admin_ids() -> List[str]:
    admins = await db.users.find({"role": "admin", "active": True}, {"_id": 0, "id": 1}).to_list(50)
    return [a["id"] for a in admins]


@api.post("/internal-chat/send")
async def internal_chat_send(body: InternalChatSend, user: dict = Depends(get_current_user)):
    """Send an internal Q&A message.
    - Agents always send TO an admin (to_user_id ignored — broadcast to all admins).
    - Admins send TO a specific agent (to_user_id required). Admin→agent is 1:1.
    - Agent↔Agent is strictly forbidden.
    """
    body_text = (body.body or "").strip()
    if not body_text:
        raise HTTPException(status_code=400, detail="body required")
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0, "id": 1, "assigned_to": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="lead not found")
    role = user.get("role")
    if role == "executive":
        # Executive can only use internal chat for leads assigned to them
        if lead.get("assigned_to") != user["id"]:
            raise HTTPException(status_code=403, detail="You can only use internal chat on your own leads")
        agent_id = user["id"]
        sender_role = "executive"
    elif role == "admin":
        if not body.to_user_id:
            raise HTTPException(status_code=400, detail="to_user_id (agent) required for admin replies")
        target = await db.users.find_one({"id": body.to_user_id, "role": "executive"}, {"_id": 0, "id": 1})
        if not target:
            raise HTTPException(status_code=400, detail="Target must be an executive")
        agent_id = body.to_user_id
        sender_role = "admin"
    else:
        raise HTTPException(status_code=403, detail="Not permitted")

    # Optional quote: the WA message the agent is referring to
    quoted = None
    if body.message_id:
        qm = await db.messages.find_one({"id": body.message_id, "lead_id": body.lead_id}, {"_id": 0})
        if qm:
            quoted = {
                "id": qm["id"],
                "direction": qm.get("direction"),
                "body": (qm.get("body") or qm.get("caption") or "").strip()[:200],
                "at": qm.get("at"),
                "msg_type": qm.get("msg_type"),
            }
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "agent_id": agent_id,           # thread key (per-agent per-lead)
        "from_user_id": user["id"],
        "from_role": sender_role,
        "body": body_text,
        "quoted": quoted,
        "read_by": [user["id"]],
        "at": iso(now_utc()),
    }
    await db.internal_messages.insert_one(msg.copy())
    msg.pop("_id", None)
    return msg


@api.get("/internal-chat/{lead_id}")
async def internal_chat_get(lead_id: str, agent_id: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Fetch messages for a (lead, agent) thread.
    - Executive: always their own thread (agent_id ignored).
    - Admin: if agent_id omitted → return list of threads for this lead with last-message preview.
             if agent_id provided → return the full thread.
    """
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0, "id": 1, "assigned_to": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="lead not found")
    role = user.get("role")
    if role == "executive":
        # Strict isolation: only the lead's assignee can view the internal thread.
        if lead.get("assigned_to") != user["id"]:
            raise HTTPException(status_code=403, detail="You can only view internal chat on your own leads")
        msgs = await db.internal_messages.find(
            {"lead_id": lead_id, "agent_id": user["id"]}, {"_id": 0}
        ).sort("at", 1).to_list(1000)
        return {"thread": msgs}
    if role == "admin":
        if agent_id:
            msgs = await db.internal_messages.find(
                {"lead_id": lead_id, "agent_id": agent_id}, {"_id": 0}
            ).sort("at", 1).to_list(1000)
            return {"thread": msgs}
        # List threads grouped by agent_id
        cursor = db.internal_messages.find({"lead_id": lead_id}, {"_id": 0}).sort("at", 1)
        all_msgs = await cursor.to_list(2000)
        groups: Dict[str, List[dict]] = {}
        for m in all_msgs:
            groups.setdefault(m["agent_id"], []).append(m)
        threads = []
        for aid, lst in groups.items():
            last = lst[-1]
            unread_for_admin = sum(1 for x in lst if user["id"] not in (x.get("read_by") or []))
            agent = await db.users.find_one({"id": aid}, {"_id": 0, "id": 1, "name": 1, "username": 1})
            threads.append({
                "agent_id": aid,
                "agent_name": (agent or {}).get("name"),
                "agent_username": (agent or {}).get("username"),
                "count": len(lst),
                "unread_for_admin": unread_for_admin,
                "last_at": last.get("at"),
                "last_body": last.get("body", "")[:120],
            })
        threads.sort(key=lambda t: t.get("last_at") or "", reverse=True)
        return {"threads": threads}
    raise HTTPException(status_code=403, detail="Not permitted")


@api.post("/internal-chat/{lead_id}/mark-read")
async def internal_chat_mark_read(lead_id: str, agent_id: Optional[str] = None, user: dict = Depends(get_current_user)):
    role = user.get("role")
    query: Dict[str, Any] = {"lead_id": lead_id}
    if role == "executive":
        query["agent_id"] = user["id"]
    elif role == "admin":
        if agent_id:
            query["agent_id"] = agent_id
    else:
        raise HTTPException(status_code=403, detail="Not permitted")
    await db.internal_messages.update_many(
        {**query, "read_by": {"$ne": user["id"]}},
        {"$push": {"read_by": user["id"]}},
    )
    return {"ok": True}


@api.get("/internal-chat/inbox/unread")
async def internal_chat_unread(user: dict = Depends(get_current_user)):
    """Return total unread internal messages for the current user (admin or exec) —
    used by the UI to display a badge on the lead drawer tab."""
    query: Dict[str, Any] = {"read_by": {"$ne": user["id"]}}
    role = user.get("role")
    if role == "executive":
        query["agent_id"] = user["id"]
    # Admin: count anything addressed to any agent where admin hasn't read yet.
    total = await db.internal_messages.count_documents(query)
    return {"unread": total}


@api.get("/internal-qa/threads")
async def internal_qa_threads(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,     # 'pending' | 'answered' | None
    agent_id: Optional[str] = None,   # admin-only filter
    q: Optional[str] = None,          # free-text search on customer name / lead requirement
):
    """List all internal Q&A threads visible to the caller, one row per (lead_id, agent_id).
    Each row reports: asked_by, replied_by, first/last question timestamps, last admin reply
    timestamp, overall status (pending/answered/new), unread count, and lead preview info."""
    match: Dict[str, Any] = {}
    if user["role"] == "executive":
        match["agent_id"] = user["id"]
    elif agent_id:
        match["agent_id"] = agent_id

    pipeline = [
        {"$match": match} if match else {"$match": {}},
        {"$sort": {"at": 1}},
        {"$group": {
            "_id": {"lead_id": "$lead_id", "agent_id": "$agent_id"},
            "messages": {"$push": "$$ROOT"},
            "count": {"$sum": 1},
            "unread_for_me": {"$sum": {"$cond": [
                {"$not": {"$in": [user["id"], {"$ifNull": ["$read_by", []]}]}},
                1, 0,
            ]}},
            "first_at": {"$min": "$at"},
            "last_at": {"$max": "$at"},
        }},
    ]
    cursor = db.internal_messages.aggregate(pipeline)
    raw_threads = []
    async for doc in cursor:
        raw_threads.append(doc)

    # Enrich with lead + user info
    lead_ids = list({t["_id"]["lead_id"] for t in raw_threads})
    agent_ids = list({t["_id"]["agent_id"] for t in raw_threads})

    leads = {}
    if lead_ids:
        async for ld in db.leads.find({"id": {"$in": lead_ids}}, {
            "_id": 0, "id": 1, "customer_name": 1, "phone": 1, "status": 1,
            "source": 1, "assigned_to": 1,
        }):
            leads[ld["id"]] = ld

    users_map: Dict[str, dict] = {}
    if agent_ids:
        async for u in db.users.find({"id": {"$in": agent_ids}}, {
            "_id": 0, "id": 1, "name": 1, "username": 1,
        }):
            users_map[u["id"]] = u

    rows: List[dict] = []
    for t in raw_threads:
        msgs = t["messages"]
        exec_msgs = [m for m in msgs if m.get("from_role") == "executive"]
        admin_msgs = [m for m in msgs if m.get("from_role") == "admin"]
        last_msg = msgs[-1] if msgs else None
        first_question = exec_msgs[0] if exec_msgs else None
        last_question = exec_msgs[-1] if exec_msgs else None
        last_reply = admin_msgs[-1] if admin_msgs else None
        # Status: if last overall message is from agent → pending. If from admin → answered.
        # If only admin has messaged (admin initiated, no agent yet) → "answered" semantics don't fit
        # so we label it "answered" (nothing awaits admin). Frontend chip handles both.
        if last_msg is None:
            st = "new"
        elif last_msg.get("from_role") == "executive":
            st = "pending"
        else:
            st = "answered"
        # Resolve replier name (name of the admin who sent last_reply)
        replied_by_id = last_reply.get("from_user_id") if last_reply else None
        replied_by = None
        if replied_by_id:
            ru = await db.users.find_one({"id": replied_by_id}, {"_id": 0, "id": 1, "name": 1, "username": 1})
            replied_by = {"id": replied_by_id, "name": (ru or {}).get("name"), "username": (ru or {}).get("username")} if ru else None
        lead = leads.get(t["_id"]["lead_id"]) or {}
        agent = users_map.get(t["_id"]["agent_id"]) or {}
        row = {
            "lead_id": t["_id"]["lead_id"],
            "agent_id": t["_id"]["agent_id"],
            "agent_name": agent.get("name"),
            "agent_username": agent.get("username"),
            "replied_by": replied_by,
            "lead_customer_name": lead.get("customer_name"),
            "lead_phone": lead.get("phone"),
            "lead_status": lead.get("status"),
            "lead_source": lead.get("source"),
            "count": t["count"],
            "unread_for_me": t["unread_for_me"],
            "first_asked_at": first_question.get("at") if first_question else t.get("first_at"),
            "last_asked_at": last_question.get("at") if last_question else None,
            "last_replied_at": last_reply.get("at") if last_reply else None,
            "last_body": (last_msg.get("body") if last_msg else "")[:160],
            "last_from_role": last_msg.get("from_role") if last_msg else None,
            "status": st,
        }
        rows.append(row)

    # Post-filters (status, q)
    if status in ("pending", "answered", "new"):
        rows = [r for r in rows if r["status"] == status]
    if q:
        ql = q.lower()
        rows = [r for r in rows if
                (r.get("lead_customer_name") or "").lower().find(ql) >= 0
                or (r.get("lead_phone") or "").lower().find(ql) >= 0
                or (r.get("agent_name") or "").lower().find(ql) >= 0
                or (r.get("last_body") or "").lower().find(ql) >= 0]

    # Sort: pending first, then by most-recent activity
    rows.sort(key=lambda r: (0 if r["status"] == "pending" else 1, r.get("last_asked_at") or r.get("last_replied_at") or ""), reverse=False)
    rows.sort(key=lambda r: (r.get("last_asked_at") or r.get("last_replied_at") or ""), reverse=True)
    rows.sort(key=lambda r: 0 if r["status"] == "pending" else 1)
    return rows


@api.get("/internal-qa/pending-count")
async def internal_qa_pending_count(user: dict = Depends(get_current_user)):
    """Lightweight count of Q&A threads awaiting an answer — a thread is pending when its
    latest message is from the executive. Admin: all threads; executive: own threads only.
    Polled by the sidebar badge."""
    match: Dict[str, Any] = {}
    if user["role"] == "executive":
        match["agent_id"] = user["id"]
    pipeline = [
        {"$match": match},
        {"$sort": {"at": 1}},
        {"$group": {
            "_id": {"lead_id": "$lead_id", "agent_id": "$agent_id"},
            "last_from_role": {"$last": "$from_role"},
        }},
        {"$match": {"last_from_role": "executive"}},
        {"$count": "pending"},
    ]
    docs = await db.internal_messages.aggregate(pipeline).to_list(1)
    return {"pending": docs[0]["pending"] if docs else 0}


# ------------- Assignment Engine -------------
async def get_routing_rules() -> dict:
    r = await db.routing_rules.find_one({"key": "default"}, {"_id": 0})
    if not r:
        r = {
            "key": "default",
            "round_robin_enabled": True,
            "unopened_reassign_minutes": int(os.environ.get("AUTO_REASSIGN_UNOPENED_MINUTES", "15")),
            "no_action_reassign_minutes": int(os.environ.get("AUTO_REASSIGN_NOACTION_MINUTES", "60")),
            "time_slot_enabled": False,
            "auto_whatsapp_on_create": True,
            "last_assigned_index": -1,
        }
        await db.routing_rules.insert_one(r.copy())
    return r

def _exec_in_working_hours(exec_user: dict, at: datetime) -> bool:
    wh = exec_user.get("working_hours") or []
    if not wh:
        return True  # no hours set -> always available
    from zoneinfo import ZoneInfo
    at_ist = at.astimezone(ZoneInfo("Asia/Kolkata"))
    weekday = at_ist.weekday()
    hhmm = at_ist.strftime("%H:%M")
    for slot in wh:
        try:
            if int(slot.get("weekday", -1)) == weekday:
                if slot.get("start", "00:00") <= hhmm <= slot.get("end", "23:59"):
                    return True
        except Exception:
            continue
    return False

async def _is_user_on_leave(user_id: str, at: Optional[datetime] = None) -> Optional[dict]:
    """Return the active leave doc if the user is on leave at `at` (default: now).
    A leave is "active" when start_date <= today <= end_date AND not cancelled."""
    at = at or now_utc()
    today = at.strftime("%Y-%m-%d")
    leave = await db.leaves.find_one({
        "user_id": user_id,
        "cancelled": {"$ne": True},
        # legacy admin-created leaves have no status field → treat as approved
        "status": {"$nin": ["pending", "rejected"]},
        "start_date": {"$lte": today},
        "end_date": {"$gte": today},
    }, {"_id": 0})
    return leave


async def _get_buyleads_routing(source: str) -> dict:
    """Return the buyleads routing config for a source ('IndiaMART' / 'ExportersIndia')."""
    doc = await db.buyleads_routing.find_one({"source": source}, {"_id": 0})
    return {
        "source": source,
        "mode": (doc or {}).get("mode", "all"),  # 'all' | 'selected'
        "agent_ids": (doc or {}).get("agent_ids", []),
        "updated_at": (doc or {}).get("updated_at"),
        "updated_by": (doc or {}).get("updated_by"),
    }


def _is_round_robin_source(source: Optional[str]) -> bool:
    """Only portal enquiries take part in automatic round-robin assignment and
    auto-reassignment. Historic data has messy casing ('indiamart', 'INDIAMART',
    'india mart', 'Justdial'...), so normalize before comparing."""
    s = (source or "").strip().lower().replace(" ", "")
    return s in ("indiamart", "justdial", "exportersindia")


# Mongo-side filter matching the same three sources (case/space-insensitive) for
# the auto-reassign queries.
ROUND_ROBIN_SOURCE_REGEX = r"^\s*(india\s*mart|just\s*dial|exporters\s*india)\s*$"


def _is_buylead(lead_data: dict) -> bool:
    """Strict buylead detection per spec:
    IndiaMART: source_data.QUERY_TYPE == 'B'
    ExportersIndia: enquiry_type (case-insensitive) == 'buyleads'."""
    src = (lead_data.get("source") or "").strip()
    if src == "IndiaMART":
        qt = (lead_data.get("source_data") or {}).get("QUERY_TYPE") or (lead_data.get("source_data") or {}).get("query_type")
        return (qt or "").strip().upper() == "B"
    if src == "ExportersIndia":
        et = (lead_data.get("enquiry_type") or "").strip().lower()
        return et == "buyleads"
    return False


ATTENDANCE_DEFAULTS = {
    "office_start": "10:30",
    "late_grace_until": "11:00",
    "office_end": "19:00",
    "full_day_out_grace_minutes": 15,   # punch-out within 15 min before office_end still = full day
    "half_day_cutoff": "15:00",         # punch-out before this = full day cut (no half day)
    "late_streak_threshold": 3,          # consecutive late arrivals (after office_start) → admin flag
    "stale_new_days": 3,                 # leads still 'new' after this many days → round-robin reassign
    "wfh_pool_user_ids": [],             # execs allowed to receive leads outside office hours (WFH)
    "wfh_afterhours_enabled": True,
    "attendance_routing_enabled": True,  # master switch: gate lead assignment on punch-in status
}


async def get_attendance_config() -> dict:
    doc = await db.attendance_settings.find_one({"key": "general_settings"}, {"_id": 0}) or {}
    cfg = dict(ATTENDANCE_DEFAULTS)
    for k in cfg:
        if doc.get(k) is not None:
            cfg[k] = doc[k]
    # legacy fields kept for the device punch endpoints
    cfg["shift_start"] = doc.get("shift_start", cfg["office_start"])
    cfg["grace_period_minutes"] = doc.get("grace_period_minutes", 30)
    return cfg


def _ist_now() -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)


def _hhmm_to_minutes(hhmm: str, fallback: int = 0) -> int:
    try:
        h, m = map(int, hhmm.split(":"))
        return h * 60 + m
    except Exception:
        return fallback


async def _office_open_now(cfg: Optional[dict] = None) -> bool:
    """True when the office is currently open in IST: Mon–Sat between office_start
    and office_end, and today is not a declared full holiday (early-off holidays
    close the office at early_off_time)."""
    cfg = cfg or await get_attendance_config()
    now = _ist_now()
    if now.weekday() == 6:  # Sunday
        return False
    mins = now.hour * 60 + now.minute
    start = _hhmm_to_minutes(cfg["office_start"], 630)
    end = _hhmm_to_minutes(cfg["office_end"], 1140)
    hol = await db.holidays.find_one({"date": now.strftime("%Y-%m-%d")}, {"_id": 0})
    if hol:
        if (hol.get("holiday_type") or "full") == "full":
            return False
        if hol.get("early_off_time"):
            end = min(end, _hhmm_to_minutes(hol["early_off_time"], end))
    return start <= mins < end


async def _is_user_available_by_attendance(user: dict) -> bool:
    """Gate lead assignment on real attendance:
    - bypass_attendance users are always available;
    - while the office is open: available only if punched IN today and NOT punched out
      (early punch-out closes their queue for the day);
    - outside office hours / Sundays / holidays: only the configured WFH pool
      (e.g. Ankita & Anmol) receives leads."""
    cfg = await get_attendance_config()
    if not cfg.get("attendance_routing_enabled", True):
        return True
    if user.get("bypass_attendance"):
        return True
    if await _office_open_now(cfg):
        today = _ist_now().strftime("%Y-%m-%d")
        log = await db.attendance_logs.find_one(
            {"user_id": user["id"], "date": today}, {"_id": 0, "check_in": 1, "check_out": 1}
        )
        return bool(log and log.get("check_in") and not log.get("check_out"))
    # office closed → WFH pool only
    if not cfg.get("wfh_afterhours_enabled", True):
        return False
    return user["id"] in (cfg.get("wfh_pool_user_ids") or [])


async def create_system_alert(alert_type: str, title: str, message: str, dedup_key: Optional[str] = None):
    """Raise an alert to all admins through the existing admin-alert pipeline
    (bell + websocket toast). dedup_key prevents re-raising the same flag."""
    try:
        if dedup_key:
            existing = await db.admin_alerts.find_one({"meta.dedup_key": dedup_key}, {"_id": 1})
            if existing:
                return
        admin_ids = [a["id"] for a in await db.users.find(
            {"role": "admin", "active": True}, {"_id": 0, "id": 1}).to_list(50)]
        if not admin_ids:
            return
        alert_doc = {
            "id": str(uuid.uuid4()),
            "title": title,
            "message": message,
            "sent_by": "System",
            "sent_by_id": None,
            "order_id": "",
            "customer_name": "",
            "recipient_ids": admin_ids,
            "recipient_roles": [],
            "acknowledgements": {},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "meta": {"type": alert_type, "dedup_key": dedup_key},
        }
        await db.admin_alerts.insert_one(alert_doc.copy())
        for r_id in admin_ids:
            try:
                await manager.broadcast_to_user(r_id, {
                    "type": "admin_alert",
                    "action": "trigger",
                    "alert": {"id": alert_doc["id"], "title": title, "message": message, "sent_by": "System"},
                })
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"create_system_alert failed: {e}")


async def _pick_buyleads_executive(source: str) -> Optional[dict]:
    """Round-robin across the allow-listed agents for a given buyleads source.
    Respects leave status and `active` flag. Falls back to `pick_next_executive` if
    the config is mode='all' or no eligible agent remains."""
    cfg = await _get_buyleads_routing(source)
    if cfg["mode"] != "selected" or not cfg["agent_ids"]:
        return None
    # Filter by active + not-on-leave
    eligible: List[dict] = []
    for uid in cfg["agent_ids"]:
        u = await db.users.find_one({"id": uid, "role": "executive", "active": True}, {"_id": 0, "password_hash": 0})
        if not u:
            continue
        if await _is_user_on_leave(uid):
            continue
        if not await _is_user_available_by_attendance(u):
            continue
        eligible.append(u)
    if not eligible:
        return None
    eligible.sort(key=lambda e: e["username"])
    # Round-robin on a stored username pointer per source (robust to the
    # eligible set changing between calls — see pick_next_executive).
    ptr_doc = await db.buyleads_routing.find_one({"source": source}, {"_id": 0, "last_assigned_username": 1})
    last_uname = (ptr_doc or {}).get("last_assigned_username") or ""
    chosen = next((e for e in eligible if e["username"] > last_uname), eligible[0])
    await db.buyleads_routing.update_one({"source": source}, {"$set": {"last_assigned_username": chosen["username"]}}, upsert=True)
    return chosen


async def pick_next_executive(exclude_user_id: Optional[str] = None) -> Optional[dict]:
    rules = await get_routing_rules()
    execs = await db.users.find(
        {"role": "executive", "active": True, "username": {"$ne": "test_user"}}, {"_id": 0, "password_hash": 0}
    ).to_list(500)
    
    # Filter by attendance (punched in or bypass)
    after_attendance = []
    for e in execs:
        if await _is_user_available_by_attendance(e):
            after_attendance.append(e)
    execs = after_attendance
    
    if not execs:
        return None
    # filter by working hours if enabled
    now = now_utc()
    if rules.get("time_slot_enabled"):
        eligible = [e for e in execs if _exec_in_working_hours(e, now)]
    else:
        eligible = execs
    if exclude_user_id:
        eligible = [e for e in eligible if e["id"] != exclude_user_id]
    # Remove users on leave
    after_leave: List[dict] = []
    for e in eligible:
        if not await _is_user_on_leave(e["id"]):
            after_leave.append(e)
    eligible = after_leave
    if not eligible:
        # Fallback: ignore working-hours filter, still exclude leave
        fallback = []
        for e in execs:
            if e["id"] == exclude_user_id:
                continue
            if not await _is_user_on_leave(e["id"]):
                fallback.append(e)
        eligible = fallback or []
    if not eligible:
        return None
    # Round-robin on a stored USERNAME pointer, not a positional index: the
    # eligible set changes constantly (attendance, leave, working hours), so an
    # index into it skips/double-serves people. "First username after the last
    # assigned one" stays fair no matter how the set changes.
    eligible.sort(key=lambda e: e["username"])
    last_uname = (rules.get("last_assigned_username") or "")
    chosen = next((e for e in eligible if e["username"] > last_uname), eligible[0])
    await db.routing_rules.update_one(
        {"key": "default"}, {"$set": {"last_assigned_username": chosen["username"]}}, upsert=True
    )
    return chosen

async def log_activity(actor_id: Optional[str], action: str, lead_id: Optional[str] = None, meta: Optional[dict] = None):
    await db.activity_logs.insert_one({
        "id": str(uuid.uuid4()),
        "actor_id": actor_id,
        "action": action,
        "lead_id": lead_id,
        "meta": meta or {},
        "at": iso(now_utc()),
    })

async def assign_lead(lead_id: str, target_user_id: Optional[str] = None, by_user_id: Optional[str] = None) -> Optional[str]:
    if target_user_id:
        user = await db.users.find_one({"id": target_user_id, "active": True})
        if not user:
            raise HTTPException(status_code=400, detail="Target executive not found/active")
        chosen_id = target_user_id
    else:
        chosen = await pick_next_executive()
        if not chosen:
            return None
        chosen_id = chosen["id"]
    entry = {"user_id": chosen_id, "at": iso(now_utc()), "by": by_user_id}
    # Detect whether this is a *reassignment* (lead already has a prior owner)
    # vs a first assignment. Reassignments get `last_reassigned_at` so the
    # /leads list can bubble them up alongside brand-new leads.
    prev = await db.leads.find_one({"id": lead_id}, {"_id": 0, "assigned_to": 1, "assignment_history": 1})
    is_reassignment = bool(prev and (prev.get("assigned_to") or (prev.get("assignment_history") or [])))
    set_ops: Dict[str, Any] = {"assigned_to": chosen_id, "last_assignment_at": iso(now_utc()), "opened_at": None}
    if is_reassignment:
        set_ops["last_reassigned_at"] = iso(now_utc())
        set_ops["sort_at"] = set_ops["last_reassigned_at"]
    await db.leads.update_one(
        {"id": lead_id},
        {"$set": set_ops, "$push": {"assignment_history": entry}},
    )
    await log_activity(by_user_id, "lead_reassigned" if is_reassignment else "lead_assigned", lead_id, {"assigned_to": chosen_id})
    return chosen_id

async def auto_send_whatsapp_on_create(lead: dict):
    rules = await get_routing_rules()
    if not rules.get("auto_whatsapp_on_create", True):
        return
    if not lead.get("phone"):
        return  # cannot send without a recipient
    # Smart skip: if the customer has ever replied to us on this lead OR on this phone,
    # do NOT send the welcome template — they are already in an active conversation.
    try:
        phone_or: List[Dict[str, Any]] = [{"lead_id": lead["id"]}]
        phone_pat = phone_match_pattern(lead.get("phone") or "")
        if phone_pat:
            phone_or.append({"from": {"$regex": phone_pat}})
        prior_inbound = await db.messages.find_one(
            {"direction": "in", "$or": phone_or},
            {"_id": 0, "id": 1},
        )
        if prior_inbound:
            logger.info(f"Skipping welcome template for lead {lead['id']} — customer already replied on WhatsApp.")
            return
    except Exception as e:
        logger.warning(f"auto-send smart-skip check failed; proceeding with send: {e}")
    cfg = await get_wa_config()
    tpl_name = cfg["default_template"]
    tpl_meta = await _resolve_template_meta(tpl_name, cfg["default_template_lang"])
    params_required = int(tpl_meta.get("params_required") or 0)
    # Only send body params if the template actually has placeholders.
    body_params: Optional[List[str]] = None
    if params_required > 0:
        # Default substitution: {{1}} = customer name, remaining placeholders padded
        # with the customer name as a safe filler so we never ship an under-counted
        # parameters array (Meta error #132000).
        first = lead.get("customer_name", "there")
        body_params = [first] + [first] * (params_required - 1)
    api_result = await wa_send_template(
        to_phone=lead["phone"],
        template_name=tpl_name,
        lang_code=tpl_meta.get("language") or cfg["default_template_lang"],
        body_params=body_params,
    )
    body_preview = f"[Template: {tpl_name}] sent to {lead['phone']}"
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": lead["id"],
        "direction": "out",
        "body": body_preview,
        "template_name": tpl_name,
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "at": iso(now_utc()),
        "by_user_id": None,
    }
    await db.messages.insert_one(msg.copy())
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        await db.leads.update_one({"id": lead["id"]}, {"$set": {"has_whatsapp": True, "last_message_at": msg["at"]}})

# ------------- Leads -------------
def _lead_dedup_hash(name: str, ts: Optional[str], extra: str = "") -> str:
    raw = f"{(name or '').strip().lower()}|{ts or ''}|{extra}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

async def _find_lead_by_phone(phone: str, exclude_id: Optional[str] = None) -> Optional[dict]:
    """Find an existing lead whose primary phone OR any extra phones suffix-match the
    given input. Indian numbers match on the last-10-digit national form; international
    numbers match on full digit string."""
    if not phone:
        return None
    pattern = phone_match_pattern(phone)
    if not pattern:
        return None
    query: Dict[str, Any] = {"$or": [
        {"phone": {"$regex": pattern}},
        {"phones": {"$regex": pattern}},
    ]}
    if exclude_id:
        query["id"] = {"$ne": exclude_id}
    return await db.leads.find_one(query, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})


async def _handle_repeat_enquiry(existing: dict, new_data: dict) -> None:
    """A lead with this phone already exists — the same customer is enquiring again.
    Apply the 'sticky' reassignment rule across all sources:
      - If the existing assignee is active and NOT on leave → keep them.
      - If the assignee is on leave / inactive / missing → reassign to next eligible exec.
      - Always bump `last_action_at` + push a 'repeat_enquiry' activity entry so the
        inbox resurfaces the lead and admins can see the re-inquiry.
    We never touch the lead's customer_name / requirement — the original payload is
    preserved; only assignment + timestamps + activity are updated.
    """
    lead_id = existing["id"]
    current_uid = existing.get("assigned_to")
    new_source = (new_data.get("source") or "").strip() or existing.get("source") or "Manual"
    new_enquiry = {
        "id": str(uuid.uuid4()),
        "customer_name": new_data.get("customer_name", "Unknown"),
        "phone": new_data.get("phone"),
        "phones": new_data.get("phones") or [],
        "email": new_data.get("email"),
        "emails": new_data.get("emails") or [],
        "requirement": new_data.get("requirement"),
        "area": new_data.get("area"),
        "city": new_data.get("city"),
        "state": new_data.get("state"),
        "country": new_data.get("country"),
        "source": new_source,
        "contact_link": new_data.get("contact_link"),
        "justdial_profile_url": new_data.get("justdial_profile_url"),
        "source_data": new_data.get("source_data", {}),
        "created_at": new_data.get("_created_at_override") or iso(now_utc()),
    }

    enquiries = _ensure_lead_enquiries(existing)
    enquiries.append(new_enquiry)
    try:
        enquiries.sort(key=lambda x: x.get("created_at") or "")
    except Exception:
        pass

    update_ops: Dict[str, Any] = {
        "$set": {
            "last_action_at": iso(now_utc()),
            "last_enquiry_source": new_source,
            "last_enquiry_at": iso(now_utc()),
            "enquiries": enquiries,
            "status": "new",
            "opened_at": None,
        }
    }

    # Merge phones
    existing_phones = list(existing.get("phones") or [])
    primary_phone = existing.get("phone")
    new_phones = []
    if new_data.get("phone"):
        new_phones.append(normalize_phone_display(new_data["phone"]))
    if new_data.get("phones"):
        new_phones.extend([normalize_phone_display(p) for p in new_data["phones"] if p])
    added_phone = False
    for p in new_phones:
        if p and p != primary_phone and p not in existing_phones:
            existing_phones.append(p)
            added_phone = True
    if added_phone:
        update_ops["$set"]["phones"] = existing_phones

    # Merge emails
    existing_emails = list(existing.get("emails") or [])
    primary_email = existing.get("email")
    new_emails = []
    if new_data.get("email"):
        new_emails.append(new_data["email"])
    if new_data.get("emails"):
        new_emails.extend(new_data["emails"])
    added_email = False
    for e in new_emails:
        if e and e != primary_email and e not in existing_emails:
            existing_emails.append(e)
            added_email = True
    if added_email:
        update_ops["$set"]["emails"] = existing_emails

    # Backfill missing top-level details if available
    for field in ["requirement", "area", "city", "state", "country"]:
        if not existing.get(field) and new_data.get(field):
            update_ops["$set"][field] = new_data[field]

    # Determine if the current assignee is still eligible
    keep_owner = False
    if current_uid:
        u = await db.users.find_one({"id": current_uid, "active": True}, {"_id": 0, "id": 1, "role": 1, "bypass_attendance": 1})
        if u and not await _is_user_on_leave(current_uid):
            keep_owner = True
            # During office hours, an exec who never punched in / already punched
            # out should not keep hoarding repeat enquiries either.
            try:
                att_cfg = await get_attendance_config()
                if att_cfg.get("attendance_routing_enabled", True) and await _office_open_now(att_cfg):
                    keep_owner = await _is_user_available_by_attendance(u)
            except Exception:
                pass

    if keep_owner:
        # Retain existing assignment — no change needed; just touch timestamps.
        await db.leads.update_one({"id": lead_id}, update_ops)
        await log_activity(None, "repeat_enquiry", lead_id, {
            "source": new_source,
            "assigned_to": current_uid,
            "sticky": True,
            "previous_owner_kept": True,
        })
        return

    # Assignee is on leave / inactive / unassigned → pick a fresh eligible executive.
    target_uid: Optional[str] = None
    try:
        if _is_buylead({**new_data, "source": new_source}):
            chosen_bl = await _pick_buyleads_executive(new_source)
            if chosen_bl:
                target_uid = chosen_bl["id"]
        if not target_uid:
            chosen = await pick_next_executive(exclude_user_id=current_uid)
            if chosen:
                target_uid = chosen["id"]
    except Exception as e:
        logger.warning(f"repeat-enquiry reassign pick failed: {e}")

    if target_uid:
        update_ops["$set"]["assigned_to"] = target_uid
        update_ops["$set"]["last_assignment_at"] = iso(now_utc())
        update_ops["$push"] = {"assignment_history": {"user_id": target_uid, "at": iso(now_utc()), "by": None, "reason": "repeat_enquiry_sticky_fallback"}}
        await db.leads.update_one({"id": lead_id}, update_ops)
        await log_activity(None, "repeat_enquiry_reassigned", lead_id, {
            "source": new_source,
            "from": current_uid,
            "to": target_uid,
            "reason": "previous_agent_unavailable",
        })
    else:
        # Nobody eligible — keep timestamps fresh; do not strand the lead silently.
        await db.leads.update_one({"id": lead_id}, update_ops)
        await log_activity(None, "repeat_enquiry", lead_id, {
            "source": new_source,
            "assigned_to": current_uid,
            "sticky": False,
            "reassign_failed": "no_eligible_executive",
        })


async def _create_lead_internal(data: dict, by_user_id: Optional[str] = None) -> dict:
    # Normalize phones to canonical storage format BEFORE dedup so all downstream
    # comparisons are consistent.
    if data.get("phone"):
        data["phone"] = normalize_phone_display(data["phone"])
    if data.get("phones"):
        data["phones"] = [normalize_phone_display(p) for p in data["phones"] if p]
        # remove duplicates and the primary phone if it slipped in
        seen = set()
        unique: List[str] = []
        for p in data["phones"]:
            if not p or p == data.get("phone"):
                continue
            if p in seen:
                continue
            seen.add(p)
            unique.append(p)
        data["phones"] = unique

    # Phone-based dedup (cross-source). If a lead with this number already exists,
    # we return it so callers can decide whether to surface or 409. On a repeat
    # enquiry we ALSO:
    #  - keep the lead's existing assignee if they are active & not-on-leave
    #  - reassign to the next eligible executive if the assignee is on leave / inactive
    #    or if the lead was somehow unassigned
    #  - bump last_action_at so the conversation resurfaces in the inbox
    #  - log an activity entry so admins can see the repeat
    if data.get("phone"):
        existing_by_phone = await _find_lead_by_phone(data["phone"])
        if existing_by_phone:
            try:
                await _handle_repeat_enquiry(existing_by_phone, data)
            except Exception as e:
                logger.warning(f"repeat-enquiry handling failed: {e}")
            # Re-fetch so callers receive the updated assignment/timestamps.
            refreshed = await db.leads.find_one({"id": existing_by_phone["id"]}, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})
            return refreshed or existing_by_phone

    # Legacy hash dedup (kept for IndiaMART unique-id style payloads)
    dhash = data.get("dedup_hash")
    if dhash:
        existing = await db.leads.find_one({"dedup_hash": dhash}, {"_id": 0})
        if existing:
            return existing
    # Build initial enquiry
    initial_enquiry = {
        "id": str(uuid.uuid4()),
        "customer_name": data.get("customer_name", "Unknown"),
        "phone": data.get("phone"),
        "phones": data.get("phones") or [],
        "email": data.get("email"),
        "emails": data.get("emails") or [],
        "requirement": data.get("requirement"),
        "area": data.get("area"),
        "city": data.get("city"),
        "state": data.get("state"),
        "country": data.get("country"),
        "source": data.get("source", "Manual"),
        "contact_link": data.get("contact_link"),
        "justdial_profile_url": data.get("justdial_profile_url"),
        "source_data": data.get("source_data", {}),
        "gst_no": data.get("gst_no"),
        "created_at": data.get("_created_at_override") or iso(now_utc()),
    }

    lead = {
        "id": str(uuid.uuid4()),
        "customer_name": data.get("customer_name", "Unknown"),
        "phone": data.get("phone"),
        "phones": data.get("phones") or [],
        "email": data.get("email"),
        "emails": data.get("emails") or [],
        "email_sent_to": [],  # addresses we've already auto-emailed (dedup)
        "requirement": data.get("requirement"),
        "area": data.get("area"),
        "city": data.get("city"),
        "state": data.get("state"),
        "country": data.get("country"),
        "enquiry_type": data.get("enquiry_type"),
        "source": data.get("source", "Manual"),
        "contact_link": data.get("contact_link"),
        "justdial_profile_url": data.get("justdial_profile_url"),
        "gst_no": data.get("gst_no"),
        "source_data": data.get("source_data", {}),
        "raw_email_html": data.get("raw_email_html"),
        "raw_email_text": data.get("raw_email_text"),
        "dedup_hash": dhash,
        "status": "new",
        "assigned_to": data.get("assigned_to"),
        "created_by": by_user_id,
        "assignment_history": [],
        "notes": [],
        "opened_at": None,
        "has_whatsapp": bool(data.get("has_whatsapp")),
        "last_action_at": iso(now_utc()),
        "created_at": data.get("_created_at_override") or iso(now_utc()),
        "sort_at": data.get("_created_at_override") or iso(now_utc()),
        "is_backlog": bool(data.get("_is_backlog")),
        "enquiries": [initial_enquiry],
    }
    from pymongo.errors import DuplicateKeyError
    try:
        await db.leads.insert_one(lead.copy())
    except DuplicateKeyError:
        jd_url = data.get("justdial_profile_url")
        if jd_url:
            existing_summary = await _find_lead_by_justdial_link(jd_url)
            if existing_summary:
                existing = await db.leads.find_one({"id": existing_summary["id"]}, {"_id": 0})
                if existing:
                    await _handle_repeat_enquiry(existing, data)
                    refreshed = await db.leads.find_one({"id": existing["id"]}, {"_id": 0})
                    return refreshed or existing
        raise

    # auto-assign if no explicit assignee. Every live source goes through the
    # round-robin so no lead ever sits unassigned; only Excel-backlog uploads
    # stay out of the rotation (they are old leads distributed manually).
    if not lead["assigned_to"] and not lead.get("is_backlog"):
        try:
            # Buyleads routing: if the lead qualifies as a "buylead" for its source
            # and an admin has configured mode=selected with agent_ids, route it
            # through the round-robin of that allow-list. Falls back to the normal
            # pick_next_executive() when mode=all or no eligible selected agent.
            target_uid: Optional[str] = None
            if _is_buylead(data):
                chosen_bl = await _pick_buyleads_executive(lead["source"])
                if chosen_bl:
                    target_uid = chosen_bl["id"]
            await assign_lead(lead["id"], target_user_id=target_uid, by_user_id=by_user_id)
        except Exception as e:
            logger.warning(f"auto-assign failed: {e}")
    else:
        entry = {"user_id": lead["assigned_to"], "at": iso(now_utc()), "by": by_user_id}
        await db.leads.update_one(
            {"id": lead["id"]},
            {"$push": {"assignment_history": entry}, "$set": {"last_assignment_at": iso(now_utc())}},
        )
    lead = await db.leads.find_one({"id": lead["id"]}, {"_id": 0})
    await log_activity(by_user_id, "lead_created", lead["id"], {"source": lead["source"]})
    # Website-order leads get an order-confirmation utility template instead of the
    # generic welcome — callers set _suppress_auto_welcome to avoid double-messaging.
    suppress_welcome = bool(data.get("_suppress_auto_welcome"))
    # auto WhatsApp welcome (mock)
    if not suppress_welcome:
        try:
            await auto_send_whatsapp_on_create(lead)
        except Exception as e:
            logger.warning(f"auto whatsapp failed: {e}")
    # auto email welcome (SMTP) — best-effort; never blocks lead creation
    if not suppress_welcome:
        try:
            await auto_send_email_on_create(lead)
        except Exception as e:
            logger.warning(f"auto email failed: {e}")
    return lead

@api.get("/leads")
async def list_leads(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    source: Optional[str] = None,
    assigned_to: Optional[str] = None,
    last_call_outcome: Optional[str] = None,
    q: Optional[str] = None,
    date_from: Optional[str] = None,  # YYYY-MM-DD (IST) inclusive
    date_to: Optional[str] = None,    # YYYY-MM-DD (IST) inclusive
    limit: int = 500,
    offset: int = 0,
    paginate: bool = False,
    starred: Optional[bool] = None,
):
    """List leads with optional filters. Backwards-compatible:
    - Default returns a bare array (existing callers unchanged).
    - Pass `paginate=true&limit=25&offset=0` to receive `{items, total, limit, offset}`
      so the UI can render page controls.
    - Pass `date_from=YYYY-MM-DD` and/or `date_to=YYYY-MM-DD` (IST, inclusive) to
      narrow by created_at."""
    query: Dict[str, Any] = {}
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    elif user["role"] == "executive":
        query["assigned_to"] = user["id"]
    else:
        if assigned_to:
            query["assigned_to"] = assigned_to
    if status:
        query["status"] = status
    if starred:
        query["starred"] = True
    if source:
        query["source"] = source
    if last_call_outcome:
        if last_call_outcome not in CALL_OUTCOMES:
            raise HTTPException(status_code=400, detail=f"Invalid outcome. Must be one of {CALL_OUTCOMES}")
        query["last_call_outcome"] = last_call_outcome
    if date_from or date_to:
        try:
            from zoneinfo import ZoneInfo
            ist = ZoneInfo("Asia/Kolkata")
            range_q: Dict[str, str] = {}
            if date_from:
                d_from = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=ist)
                range_q["$gte"] = iso(d_from.astimezone(timezone.utc))
            if date_to:
                # Inclusive end-of-day in IST
                d_to = datetime.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, microsecond=999000, tzinfo=ist)
                range_q["$lte"] = iso(d_to.astimezone(timezone.utc))
            if range_q:
                query["created_at"] = range_q
        except ValueError:
            raise HTTPException(status_code=400, detail="date_from / date_to must be YYYY-MM-DD")
    if q:
        import re as _re
        q_safe = _re.escape(q)
        ors: List[Dict[str, Any]] = [
            {"customer_name": {"$regex": q_safe, "$options": "i"}},
            {"aliases": {"$regex": q_safe, "$options": "i"}},
            {"requirement": {"$regex": q_safe, "$options": "i"}},
            {"city": {"$regex": q_safe, "$options": "i"}},
            {"email": {"$regex": q_safe, "$options": "i"}},
            {"gst_no": {"$regex": q_safe, "$options": "i"}},
            {"source_data.SENDER_COMPANY": {"$regex": q_safe, "$options": "i"}},
            {"source_data.company_name": {"$regex": q_safe, "$options": "i"}},
        ]
        # Phone-aware match: if the search query contains 7+ digits, treat it as a phone
        # search and look it up by canonical-suffix regex (so '+918790934618',
        # '08790934618' and '8790934618' all resolve to the same lead).
        phone_pat = phone_match_pattern(q)
        if phone_pat:
            ors.append({"phone": {"$regex": phone_pat}})
            ors.append({"phones": {"$regex": phone_pat}})
        else:
            ors.append({"phone": {"$regex": q_safe, "$options": "i"}})
            ors.append({"phones": {"$regex": q_safe, "$options": "i"}})
        query["$or"] = ors
    safe_limit = max(1, min(int(limit), 500))
    safe_offset = max(0, int(offset))
    # Sort STRICTLY by creation date, newest first — a lead enquired TODAY always
    # outranks anything older. Reassignments must NOT bump a lead up the list
    # (that was burying today's enquiries under recycled 2023/24 leads).
    pipeline: List[Dict[str, Any]] = [
        {"$match": query},
        # Excel-uploaded leads are OLD backlog fed into the CRM — they must never
        # outrank live enquiries, so they sort in a lower tier below everything
        # else regardless of upload date.
        {"$addFields": {"_src_tier": {"$cond": [
            {"$or": [{"$eq": ["$source", "Excel Upload"]}, {"$eq": ["$is_backlog", True]}]}, 1, 0]}}},
        {"$sort": {"_src_tier": 1, "created_at": -1}},
        {"$skip": safe_offset},
        {"$limit": safe_limit},
        {"$project": {"_id": 0, "raw_email_html": 0, "raw_email_text": 0, "_src_tier": 0}},
    ]
    items = await db.leads.aggregate(pipeline).to_list(safe_limit)
    if paginate:
        total = await db.leads.count_documents(query)
        return {"items": items, "total": total, "limit": safe_limit, "offset": safe_offset}
    return items

@api.get("/leads/upload-template")
async def download_upload_template(user: dict = Depends(get_current_user)):
    """Generate and return a sample Excel template for bulk lead uploading."""
    columns = [
        "Customer Name", "Phone", "Email", "Requirement", 
        "Area", "City", "State", "Country", "Source", "Enquiry Type", "GST No."
    ]
    df = pd.DataFrame(columns=columns)
    df.loc[0] = [
        "John Doe", "8790934618", "john.doe@example.com", "Requires citrus spray sample pack",
        "Industrial Area", "Hyderabad", "Telangana", "India", "Excel Upload", "Samples", "36AAAAA1111A1Z1"
    ]
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Leads Template")
    output.seek(0)
    excel_bytes = output.getvalue()
    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": "attachment; filename=leads_upload_template.xlsx",
            "Access-Control-Expose-Headers": "Content-Disposition"
        }
    )

async def _process_upload_task(
    upload_id: str,
    rows: list,
    target_assignee: Optional[str],
    source: Optional[str],
    override_date_str: Optional[str],
    user_id: str
):
    imported_count = 0
    duplicate_count = 0
    error_count = 0
    errors = []
    processed_count = 0
    
    override_date = None
    if override_date_str:
        override_date = datetime.fromisoformat(override_date_str)
        
    for index, row in enumerate(rows):
        row_num = index + 2
        
        cust_name = row.get("customer_name")
        if not cust_name or (isinstance(cust_name, float) and pd.isna(cust_name)) or not str(cust_name).strip():
            err_msg = f"Row {row_num}: Customer Name is missing"
            errors.append(err_msg)
            error_count += 1
            processed_count += 1
            await db.upload_status.update_one(
                {"id": upload_id},
                {"$set": {"processed": processed_count, "errors_count": error_count}, "$push": {"errors": err_msg}}
            )
            continue
            
        cust_name = str(cust_name).strip()
        
        phone_val = row.get("phone")
        phone_str = None
        if phone_val and not (isinstance(phone_val, float) and pd.isna(phone_val)) and str(phone_val).strip():
            if isinstance(phone_val, float):
                if phone_val.is_integer():
                    phone_str = str(int(phone_val))
                else:
                    phone_str = str(phone_val)
            else:
                phone_str = str(phone_val).strip()
                
        canonical_phone = None
        if phone_str:
            canonical_phone = normalize_phone_display(phone_str)
            
        existing = None
        if canonical_phone:
            existing = await _find_lead_by_phone(canonical_phone)
            
        email = str(row.get("email")).strip() if (row.get("email") and not (isinstance(row.get("email"), float) and pd.isna(row.get("email")))) else None
        requirement = str(row.get("requirement")).strip() if (row.get("requirement") and not (isinstance(row.get("requirement"), float) and pd.isna(row.get("requirement")))) else None
        area = str(row.get("area")).strip() if (row.get("area") and not (isinstance(row.get("area"), float) and pd.isna(row.get("area")))) else None
        city = str(row.get("city")).strip() if (row.get("city") and not (isinstance(row.get("city"), float) and pd.isna(row.get("city")))) else None
        state = str(row.get("state")).strip() if (row.get("state") and not (isinstance(row.get("state"), float) and pd.isna(row.get("state")))) else None
        country = str(row.get("country")).strip() if (row.get("country") and not (isinstance(row.get("country"), float) and pd.isna(row.get("country")))) else None
        
        row_source = str(row.get("source")).strip() if (row.get("source") and not (isinstance(row.get("source"), float) and pd.isna(row.get("source")))) else None
        if not row_source:
            row_source = source if source else "Excel Upload"
            
        enquiry_type = str(row.get("enquiry_type")).strip() if (row.get("enquiry_type") and not (isinstance(row.get("enquiry_type"), float) and pd.isna(row.get("enquiry_type")))) else None
        gst_no = str(row.get("gst_no")).strip() if (row.get("gst_no") and not (isinstance(row.get("gst_no"), float) and pd.isna(row.get("gst_no")))) else None
        
        lead_payload = {
            "customer_name": cust_name,
            "phone": canonical_phone,
            "email": email,
            "requirement": requirement,
            "area": area,
            "city": city,
            "state": state,
            "country": country,
            "source": row_source,
            "enquiry_type": enquiry_type,
            "gst_no": gst_no,
            "assigned_to": target_assignee,
            # Excel rows are backlog: they sort below live leads and never
            # enter the round-robin, whatever their Source column says.
            "_is_backlog": True,
        }
        if override_date:
            lead_payload["_created_at_override"] = iso(override_date + timedelta(seconds=index))
            
        if existing:
            try:
                await _handle_repeat_enquiry(existing, {**lead_payload, "source": row_source})
                duplicate_count += 1
            except Exception as ex_dup:
                logger.warning(f"Failed to handle repeat enquiry for duplicate lead: {ex_dup}")
                err_msg = f"Row {row_num}: Error handling duplicate ({str(ex_dup)})"
                errors.append(err_msg)
                error_count += 1
        else:
            lead_payload["dedup_hash"] = _lead_dedup_hash(cust_name, iso(now_utc()), canonical_phone or "")
            try:
                await _create_lead_internal(lead_payload, by_user_id=user_id)
                imported_count += 1
            except Exception as ex_create:
                logger.error(f"Failed to create lead in upload: {ex_create}")
                err_msg = f"Row {row_num}: Failed to create lead ({str(ex_create)})"
                errors.append(err_msg)
                error_count += 1
                
        processed_count += 1
        await db.upload_status.update_one(
            {"id": upload_id},
            {
                "$set": {
                    "processed": processed_count,
                    "imported": imported_count,
                    "duplicates": duplicate_count,
                    "errors_count": error_count,
                    "errors": errors
                }
            }
        )
        
    await db.upload_status.update_one(
        {"id": upload_id},
        {
            "$set": {
                "status": "completed",
                "summary": {
                    "total": len(rows),
                    "imported": imported_count,
                    "duplicates": duplicate_count,
                    "errors": error_count
                }
            }
        }
    )

@api.post("/leads/upload")
async def upload_leads(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    assigned_to: Optional[str] = Form(None),
    source: Optional[str] = Form(None),
    month: Optional[int] = Form(None),
    year: Optional[int] = Form(None),
    user: dict = Depends(get_current_user)
):
    """Bulk upload leads from an Excel or CSV file."""
    target_assignee = assigned_to
    if user["role"] == "executive":
        target_assignee = user["id"]
    elif user["role"] == "data_entry":
        target_assignee = None
        
    override_date = None
    if month is not None and year is not None:
        try:
            m = int(month)
            y = int(year)
            if 1 <= m <= 12 and 1900 <= y <= 2100:
                import calendar
                dt = now_utc()
                max_days = calendar.monthrange(y, m)[1]
                day = min(dt.day, max_days)
                override_date = dt.replace(year=y, month=m, day=day)
        except Exception as ex_date:
            logger.warning(f"Failed to parse custom upload date: {ex_date}")
        
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
        
    try:
        filename = file.filename.lower()
        if filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        else:
            df = pd.read_excel(io.BytesIO(contents))
    except Exception as e:
        logger.error(f"Failed to parse spreadsheet: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid file format: {str(e)}")
        
    columns_mapping = {}
    for col in df.columns:
        col_lower = str(col).strip().lower()
        if col_lower in ("customer name", "customer_name", "name", "full name", "customer"):
            columns_mapping[col] = "customer_name"
        elif col_lower in ("phone", "mobile", "phone number", "mobile number", "contact", "phone_number"):
            columns_mapping[col] = "phone"
        elif col_lower in ("email", "email address", "email_address", "email id", "email_id"):
            columns_mapping[col] = "email"
        elif col_lower in ("requirement", "requirements", "query", "message", "notes", "description"):
            columns_mapping[col] = "requirement"
        elif col_lower in ("area", "locality", "region"):
            columns_mapping[col] = "area"
        elif col_lower in ("city", "town"):
            columns_mapping[col] = "city"
        elif col_lower in ("state", "province"):
            columns_mapping[col] = "state"
        elif col_lower in ("country",):
            columns_mapping[col] = "country"
        elif col_lower in ("source",):
            columns_mapping[col] = "source"
        elif col_lower in ("enquiry type", "enquiry_type", "type"):
            columns_mapping[col] = "enquiry_type"
        elif col_lower in ("gst no", "gst number", "gstin", "gst"):
            columns_mapping[col] = "gst_no"
            
    df = df.rename(columns=columns_mapping)
    
    if "customer_name" not in df.columns:
        raise HTTPException(
            status_code=400, 
            detail="Spreadsheet must contain a 'Customer Name' (or Name, Full Name) column"
        )
        
    rows_list = []
    for index, row in df.iterrows():
        row_dict = {}
        for col in df.columns:
            val = row[col]
            if pd.isna(val):
                row_dict[col] = None
            else:
                row_dict[col] = val
        rows_list.append(row_dict)
        
    upload_id = str(uuid.uuid4())
    initial_status = {
        "id": upload_id,
        "total": len(rows_list),
        "processed": 0,
        "imported": 0,
        "duplicates": 0,
        "errors_count": 0,
        "errors": [],
        "status": "processing",
        "created_at": iso(now_utc()),
    }
    await db.upload_status.insert_one(initial_status)
    
    background_tasks.add_task(
        _process_upload_task,
        upload_id,
        rows_list,
        target_assignee,
        source,
        iso(override_date) if override_date else None,
        user["id"]
    )
    
    return {
        "success": True,
        "upload_id": upload_id
    }

@api.get("/leads/upload/status/{upload_id}")
async def get_upload_status(upload_id: str, user: dict = Depends(get_current_user)):
    status = await db.upload_status.find_one({"id": upload_id}, {"_id": 0})
    if not status:
        raise HTTPException(status_code=404, detail="Upload session not found")
    return status

@api.post("/leads")
async def create_lead(body: LeadCreate, user: dict = Depends(get_current_user)):
    """Create a new lead — but enforce per-phone duplicate prevention.
    - If the phone already belongs to a lead owned by the same user (or no one), return it.
    - Admin: always returns the existing lead so they can open it.
    - Executive whose phone matches a lead owned by ANOTHER executive: 409 with structured
      payload so the UI can offer a 'Request reassignment' flow."""
    data = body.model_dump()
    if data.get("phone"):
        canonical = normalize_phone_display(data["phone"])
        if canonical:
            existing = await _find_lead_by_phone(canonical)
            if existing:
                owner_id = existing.get("assigned_to")
                if user["role"] == "admin" or not owner_id or owner_id == user["id"]:
                    # Surface the existing lead — also apply sticky re-enquiry handling
                    # (bump last_action_at, reassign if the current owner is on leave, log activity).
                    try:
                        await _handle_repeat_enquiry(existing, {**data, "source": data.get("source") or "Manual"})
                    except Exception as e:
                        logger.warning(f"manual repeat-enquiry handling failed: {e}")
                    refreshed = await db.leads.find_one({"id": existing["id"]}, {"_id": 0})
                    return {**(refreshed or existing), "duplicate": True, "existed": True}
                # Different executive owns the lead → block create
                owner = await db.users.find_one({"id": owner_id}, {"_id": 0, "id": 1, "name": 1, "username": 1}) or {}
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "duplicate_phone",
                        "message": "This lead is already assigned to another executive.",
                        "existing_lead_id": existing["id"],
                        "owned_by_id": owner_id,
                        "owned_by_name": owner.get("name"),
                        "owned_by_username": owner.get("username"),
                    },
                )
    data["dedup_hash"] = _lead_dedup_hash(data["customer_name"], iso(now_utc()), data.get("phone", "") or "")
    # If an executive is creating a lead manually, force-assign it to themselves
    # (don't run round-robin or honour any payload-supplied assignee). Admins
    # retain the ability to either pass an explicit assignee or let
    # _create_lead_internal route via round-robin / buyleads rules.
    if user["role"] == "executive":
        data["assigned_to"] = user["id"]
    elif user["role"] == "data_entry":
        data["assigned_to"] = None
    lead = await _create_lead_internal(data, by_user_id=user["id"])
    return lead

@api.get("/leads/{lead_id}")
async def get_lead(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    # mark opened (only assignee)
    if user["role"] == "executive" and not lead.get("opened_at"):
        await db.leads.update_one(
            {"id": lead_id}, {"$set": {"opened_at": iso(now_utc()), "last_action_at": iso(now_utc()), "auto_reassign_count": 0}}
        )
        lead["opened_at"] = iso(now_utc())
        await log_activity(user["id"], "lead_opened", lead_id)
    return lead

@api.patch("/leads/{lead_id}")
async def update_lead(lead_id: str, body: LeadUpdate, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    updates: Dict[str, Any] = {}
    for f in ["customer_name", "phone", "phones", "aliases", "email", "requirement", "area", "city", "state", "status", "active_wa_phone", "starred", "gst_no", "enquiry_type"]:
        v = getattr(body, f)
        if v is not None:
            updates[f] = v
    if body.requirement is not None:
        updates["requirement_updated_at"] = iso(now_utc())
    if body.assigned_to is not None and user["role"] == "admin":
        updates["assigned_to"] = body.assigned_to
    updates["last_action_at"] = iso(now_utc())
    await db.leads.update_one({"id": lead_id}, {"$set": updates})
    await log_activity(user["id"], "lead_updated", lead_id, {"fields": list(updates.keys())})
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return lead


@api.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str, admin: dict = Depends(require_admin)):
    """Admin-only hard-delete of a lead and its related data. Cascades:
    messages, internal_messages, followups, call_logs, activity_logs,
    transfer_requests. Email logs are kept (audit trail) but their lead_id
    pointer is nulled."""
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    summary = {
        "lead_id": lead_id,
        "customer_name": lead.get("customer_name"),
        "deleted_by": admin["id"],
        "deleted_at": iso(now_utc()),
    }
    # Cascade
    msgs = (await db.messages.delete_many({"lead_id": lead_id})).deleted_count
    intms = (await db.internal_messages.delete_many({"lead_id": lead_id})).deleted_count
    fups = (await db.followups.delete_many({"lead_id": lead_id})).deleted_count
    calls = (await db.call_logs.delete_many({"lead_id": lead_id})).deleted_count
    acts = (await db.activity_logs.delete_many({"lead_id": lead_id})).deleted_count
    trs = (await db.transfer_requests.delete_many({"lead_id": lead_id})).deleted_count
    await db.email_logs.update_many({"lead_id": lead_id}, {"$set": {"lead_id": None, "lead_deleted_at": iso(now_utc())}})
    await db.leads.delete_one({"id": lead_id})
    summary.update({
        "messages_deleted": msgs,
        "internal_messages_deleted": intms,
        "followups_deleted": fups,
        "call_logs_deleted": calls,
        "activity_logs_deleted": acts,
        "transfer_requests_deleted": trs,
    })
    logger.info(f"Lead deleted by admin {admin['id']}: {summary}")
    return summary

@api.post("/leads/{lead_id}/notes")
async def add_note(lead_id: str, body: NoteInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    note = {
        "id": str(uuid.uuid4()),
        "by_user_id": user["id"],
        "by_name": user["name"],
        "body": body.body,
        "at": iso(now_utc()),
    }
    await db.leads.update_one(
        {"id": lead_id},
        {"$push": {"notes": note}, "$set": {"last_action_at": iso(now_utc())}},
    )
    await log_activity(user["id"], "note_added", lead_id)
    return note


@api.post("/leads/{lead_id}/phones")
async def add_phone(lead_id: str, body: PhoneInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    new_phone = normalize_phone_display((body.phone or "").strip())
    if not new_phone:
        raise HTTPException(status_code=400, detail="Phone required")
    existing_phones = list(lead.get("phones") or [])
    if new_phone == lead.get("phone") or new_phone in existing_phones:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_phone_same_lead",
                "message": "Phone already on this lead",
                "existing_lead_id": lead_id,
            },
        )
    # Cross-lead dedup: if a phone already lives on another lead, merge this lead into it
    other = await _find_lead_by_phone(new_phone, exclude_id=lead_id)
    if other:
        merged_lead = await _merge_leads(source_lead=lead, dest_lead=other, by_user_id=user["id"])
        return {
            "merged": True,
            "redirect_lead_id": other["id"],
            "lead": merged_lead
        }
    update: Dict[str, Any] = {"last_action_at": iso(now_utc())}
    is_first_phone = not lead.get("phone")
    if is_first_phone:
        update["phone"] = new_phone  # first-ever phone → becomes primary
    else:
        existing_phones.append(new_phone)
        update["phones"] = existing_phones
    await db.leads.update_one({"id": lead_id}, {"$set": update})
    await log_activity(user["id"], "phone_added", lead_id, {"phone": new_phone})
    updated = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    # Justdial leads often arrive without a mobile number — when the agent later
    # adds one manually, fire the welcome template so the customer gets contacted
    # immediately. The smart-skip in auto_send_whatsapp_on_create protects us from
    # double-sending if the customer has already replied.
    if is_first_phone and (updated or {}).get("source") == "Justdial":
        try:
            await auto_send_whatsapp_on_create(updated)
        except Exception as e:
            logger.warning(f"auto whatsapp on manual phone-add failed: {e}")
    return updated


@api.delete("/leads/{lead_id}/phones")
async def remove_phone(lead_id: str, phone: str = Query(...), user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target = normalize_phone_display(phone)
    updates: Dict[str, Any] = {"last_action_at": iso(now_utc())}
    existing_phones = [p for p in (lead.get("phones") or []) if p != target]
    if target == lead.get("phone"):
        # Removing the primary — promote next alt if available
        if existing_phones:
            updates["phone"] = existing_phones[0]
            updates["phones"] = existing_phones[1:]
        else:
            updates["phone"] = None
            updates["phones"] = []
    else:
        updates["phones"] = existing_phones
    await db.leads.update_one({"id": lead_id}, {"$set": updates})
    await log_activity(user["id"], "phone_removed", lead_id, {"phone": phone})
    return await db.leads.find_one({"id": lead_id}, {"_id": 0})

@api.post("/leads/{lead_id}/reassign")
async def reassign_lead(lead_id: str, body: ReassignInput, admin: dict = Depends(require_admin)):
    await assign_lead(lead_id, target_user_id=body.assigned_to, by_user_id=admin["id"])
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return lead

@api.get("/leads/{lead_id}/activity")
async def lead_activity(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    logs = await db.activity_logs.find({"lead_id": lead_id}, {"_id": 0}).sort("at", -1).to_list(200)
    if user["role"] != "admin":
        # Hide system/reassignment/admin-level actions from executives
        hidden = {"lead_assigned", "auto_reassigned_unopened", "auto_reassigned_noaction", "transfer_requested"}
        logs = [item for item in logs if item.get("action") not in hidden]
    # Enrich with actor name for the UI
    actor_ids = list({item.get("actor_id") for item in logs if item.get("actor_id")})
    name_map: Dict[str, str] = {}
    if actor_ids:
        async for u in db.users.find({"id": {"$in": actor_ids}}, {"_id": 0, "id": 1, "name": 1}):
            name_map[u["id"]] = u.get("name") or ""
    for item in logs:
        item["actor_name"] = name_map.get(item.get("actor_id") or "", "" if item.get("actor_id") else "System")
    return logs

# ------------- Messages (WhatsApp mock) -------------
@api.get("/leads/{lead_id}/messages")
async def list_messages(
    lead_id: str,
    user: dict = Depends(get_current_user),
    phone: Optional[str] = None,
    limit: Optional[int] = Query(None),
    offset: Optional[int] = Query(None),
):
    """List WhatsApp messages for a lead. When `phone` is supplied, restrict the
    result to only messages addressed to/from that specific phone (matched by
    last-10-digit suffix). This lets the lead drawer show a per-number chat
    history when an agent toggles between primary/secondary numbers — without
    merging conversations across multiple numbers."""
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    query: Dict[str, Any] = {"lead_id": lead_id}
    if phone:
        pat = phone_match_pattern(phone)
        if pat:
            query["$or"] = [
                {"to_phone": {"$regex": pat}},
                {"from": {"$regex": pat}},
            ]
    if limit is not None:
        skip = offset or 0
        msgs = await db.messages.find(query, {"_id": 0}).sort("at", -1).skip(skip).limit(limit).to_list(limit)
        msgs.reverse()
    else:
        msgs = await db.messages.find(query, {"_id": 0}).sort("at", 1).to_list(2000)
    return msgs


# ------------- Call logs -------------
def _check_duplicate_call(norm_phone: str, user_id: str, new_at_str: str, new_duration: int, existing_logs: list) -> Optional[dict]:
    try:
        new_dt = datetime.fromisoformat(new_at_str.replace("Z", "+00:00"))
    except Exception:
        return None
        
    for doc in existing_logs:
        if doc.get("phone") != norm_phone or doc.get("by_user_id") != user_id:
            continue
            
        doc_at = doc.get("at")
        if not doc_at:
            continue
            
        try:
            doc_dt = datetime.fromisoformat(doc_at.replace("Z", "+00:00"))
            doc_duration = doc.get("duration_seconds") or 0
            
            diff_time = abs((new_dt - doc_dt).total_seconds())
            diff_new_end = abs((new_dt - doc_dt).total_seconds() - new_duration)
            diff_doc_end = abs((doc_dt - new_dt).total_seconds() - doc_duration)
            
            # If any of the differences is within 60 seconds, it's a duplicate
            if diff_time <= 60 or diff_new_end <= 60 or diff_doc_end <= 60:
                return doc
        except Exception:
            pass
            
    return None


async def _set_wa_status(lead_id: str, phone: Optional[str], has_wa: bool):
    """Track per-phone WhatsApp availability on a lead. Updates `wa_status_map` (suffix-key
    → bool) plus the overall `has_whatsapp` rollup (true if any phone is WA-active)."""
    if not phone:
        return
    key = _normalize_phone(phone)[-10:] if phone else ""
    if not key:
        return
    field = f"wa_status_map.{key}"
    update_ops: Dict[str, Any] = {"$set": {field: has_wa}}
    if has_wa:
        update_ops["$set"]["has_whatsapp"] = True
    await db.leads.update_one({"id": lead_id}, update_ops)


@api.post("/leads/{lead_id}/calls")
async def log_call(lead_id: str, body: CallLogInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if body.outcome == "connected" and not (body.summary or "").strip():
        raise HTTPException(status_code=400, detail="Conversation summary is required for a connected call")
        
    outcome_str = {
        "connected": "Connected",
        "no_response": "No Response (PNR)",
        "rejected": "Rejected",
        "not_reachable": "Not Reachable",
        "busy": "Busy",
        "invalid": "Invalid Number",
        "initiated": "Initiated"
    }.get(body.outcome, body.outcome.title())
    
    summary_val = (body.summary or "").strip()
    note_body = f"Manual Call ({outcome_str}): {summary_val}" if summary_val else f"Manual Call ({outcome_str})"
    
    now_str = iso(now_utc())
    
    note = {
        "id": str(uuid.uuid4()),
        "by_user_id": user["id"],
        "by_name": user["name"],
        "body": note_body,
        "at": now_str,
    }
    
    update_fields: Dict[str, Any] = {
        "last_call_outcome": body.outcome,
        "last_call_at": now_str,
        "last_action_at": now_str,
    }
    # Auto-promote status if not initiated call
    if body.outcome != "initiated" and lead.get("status") == "new":
        update_fields["status"] = "contacted"
        
    # Directly update status if lead_status is provided and valid
    if body.lead_status and body.lead_status in ["new", "contacted", "qualified", "converted", "lost"]:
        update_fields["status"] = body.lead_status

    await db.leads.update_one(
        {"id": lead_id},
        {"$push": {"notes": note}, "$set": update_fields},
    )
    
    await log_activity(user["id"], "call_logged", lead_id, {"outcome": body.outcome, "phone": body.phone})

    # Intelligent Reassignment Logic
    current_assignee = lead.get("assigned_to")
    if body.outcome == "connected" and user["role"] == "executive":
        if not current_assignee:
            await assign_lead(lead_id, target_user_id=user["id"], by_user_id=user["id"])
            await log_activity(
                user["id"],
                "lead_auto_assigned_callback",
                lead_id,
                {
                    "previous_assignee": None,
                    "new_assignee": user["id"],
                    "reason": "Connected call on unassigned lead"
                }
            )
        elif current_assignee != user["id"]:
            has_connected = await db.call_logs.find_one({
                "lead_id": lead_id,
                "by_user_id": current_assignee,
                "outcome": "connected"
            })
            if not has_connected:
                await assign_lead(lead_id, target_user_id=user["id"], by_user_id=user["id"])
                await log_activity(
                    user["id"],
                    "lead_auto_reassigned_connected_call",
                    lead_id,
                    {
                        "previous_assignee": current_assignee,
                        "new_assignee": user["id"],
                        "reason": "Successful call connection by another executive while current assignee had no successful contact"
                    }
                )

    mock_doc = {
        "id": note["id"],
        "lead_id": lead_id,
        "phone": body.phone,
        "outcome": body.outcome,
        "summary": summary_val if body.outcome == "connected" else None,
        "by_user_id": user["id"],
        "by_user_name": user["name"],
        "at": now_str,
        "direction": "outgoing",
    }
    return mock_doc


@api.get("/leads/{lead_id}/calls")
async def list_lead_calls(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    return await db.call_logs.find({"lead_id": lead_id}, {"_id": 0}).sort("at", -1).to_list(500)


@api.post("/calls/sync-batch")
async def sync_call_batch(body: CallSyncBatchInput, user: dict = Depends(get_current_user)):
    # Only allow executives or admin
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    
    synced_count = 0
    matched_count = 0
    reassigned_count = 0
    
    for record in body.logs:
        norm = normalize_phone_display(record.phone)
        if not norm:
            continue
        
        # Determine outcome (support direct outcome mappings from dialer UI)
        if record.call_type in ("connected", "busy", "rejected", "no_response", "invalid", "not_reachable"):
            outcome = record.call_type
        else:
            outcome = "connected"
            if record.duration_seconds == 0:
                if record.call_type in ("rejected", "rejected_type"):
                    outcome = "rejected"
                elif record.call_type in ("busy", "busy_type"):
                    outcome = "busy"
                else:
                    outcome = "no_response"
            
        lead = await _find_lead_by_phone(norm)
        if not lead:
            lead_id = str(uuid.uuid4())
            lead_doc = {
                "id": lead_id,
                "phone": norm,
                "customer_name": f"New Call Lead {norm}",
                "status": "new",
                "source": "Auto-Created",
                "assigned_to": user["id"],
                "created_at": record.timestamp,
                "requirement": "Auto-created via calling app sync",
                "last_action_at": record.timestamp,
                "sort_at": record.timestamp,
            }
            await db.leads.insert_one(lead_doc)
            await log_activity(user["id"], "lead_created", lead_id, {"source": "Auto-Created", "phone": norm})
            lead = lead_doc

        # Duplicate check (same phone, same user, same timestamp or duration-adjusted matching)
        existing_logs = await db.call_logs.find({
            "phone": norm,
            "by_user_id": user["id"]
        }).sort("at", -1).to_list(50)
        existing = _check_duplicate_call(norm, user["id"], record.timestamp, record.duration_seconds or 0, existing_logs)
        
        if existing:
            # If the sync payload contains a user note/outcome (e.g. from PostCallActivity),
            # we should update the existing call log with the note and outcome!
            note_str = record.note.strip() if record.note else ""
            update_fields = {
                "outcome": outcome,
            }
            if note_str:
                update_fields["summary"] = note_str
            if record.duration_seconds and not existing.get("duration_seconds"):
                update_fields["duration_seconds"] = record.duration_seconds
                
            await db.call_logs.update_one({"id": existing["id"]}, {"$set": update_fields})
            
            if lead:
                lead_update = {
                    "last_call_outcome": outcome,
                    "last_call_at": record.timestamp,
                    "last_action_at": record.timestamp,
                }
                if outcome != "initiated" and lead.get("status") == "new":
                    lead_update["status"] = "contacted"
                if record.lead_status and record.lead_status in ["new", "contacted", "qualified", "converted", "lost"]:
                    lead_update["status"] = record.lead_status
                await db.leads.update_one({"id": lead["id"]}, {"$set": lead_update})
            continue

        note_str = record.note.strip() if record.note else ""
        summary_val = note_str if note_str else f"Synced via Android App ({record.direction or 'outgoing'} Call, Outcome: {outcome}, Duration: {record.duration_seconds}s)"
        
        doc = {
            "id": str(uuid.uuid4()),
            "phone": norm,
            "outcome": outcome,
            "summary": summary_val,
            "by_user_id": user["id"],
            "by_user_name": user["name"],
            "at": record.timestamp,
            "duration_seconds": record.duration_seconds,
            "synced_from_app": True,
            "direction": record.direction or "outgoing",
        }
        
        if lead:
            lead_id = lead["id"]
            doc["lead_id"] = lead_id
            matched_count += 1
            
            # Save the call log
            await db.call_logs.insert_one(doc.copy())
            
            # Update lead fields
            update_fields: Dict[str, Any] = {
                "last_call_outcome": outcome,
                "last_call_at": doc["at"],
                "last_action_at": doc["at"],
            }
            if outcome != "initiated" and lead.get("status") == "new":
                update_fields["status"] = "contacted"
            if record.lead_status and record.lead_status in ["new", "contacted", "qualified", "converted", "lost"]:
                update_fields["status"] = record.lead_status
            await db.leads.update_one({"id": lead_id}, {"$set": update_fields})
            
            # Log standard activity
            await log_activity(user["id"], "call_logged", lead_id, {
                "outcome": outcome, 
                "phone": norm,
                "duration_seconds": record.duration_seconds,
                "synced_from_app": True
            })
            
            # Intelligent Reassignment check
            current_assignee = lead.get("assigned_to")
            if outcome == "connected" and current_assignee and current_assignee != user["id"]:
                # Check if current assignee has ever successfully connected
                has_connected = await db.call_logs.find_one({
                    "lead_id": lead_id,
                    "by_user_id": current_assignee,
                    "outcome": "connected"
                })
                if not has_connected:
                    # Reassign lead to the caller using standard assign_lead
                    await assign_lead(lead_id, target_user_id=user["id"], by_user_id=user["id"])
                    reassigned_count += 1
                    # Log activity detailing intelligent reassignment
                    await log_activity(
                        user["id"],
                        "lead_auto_reassigned_connected_call",
                        lead_id,
                        {
                            "previous_assignee": current_assignee,
                            "new_assignee": user["id"],
                            "reason": "Successful call connection by another executive while current assignee had no successful contact"
                        }
                    )
        else:
            # No matching lead found: save to general audit logs / orphan call logs
            doc["lead_id"] = None
            await db.call_logs.insert_one(doc.copy())
            
        synced_count += 1
        
    return {
        "success": True,
        "synced": synced_count,
        "matched": matched_count,
        "reassigned": reassigned_count
    }


class CallEventInput(BaseModel):
    phone: str
    event: Literal["started", "answered", "ended"]
    duration_seconds: Optional[int] = 0
    outcome: Optional[str] = None
    direction: Optional[str] = "outgoing"


@api.post("/calls/events")
async def report_call_event(body: CallEventInput, user: dict = Depends(get_current_user)):
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
        
    norm = normalize_phone_display(body.phone)
    if not norm:
        raise HTTPException(status_code=400, detail="Invalid phone number")
        
    lead = await _find_lead_by_phone(norm)
    if not lead:
        return {"success": True, "detail": "Lead not found, event skipped"}
        
    lead_id = lead["id"]
    now_str = iso(now_utc())
    
    if body.event == "started":
        await db.leads.update_one(
            {"id": lead_id},
            {"$set": {
                "last_call_outcome": "initiated",
                "last_call_at": now_str,
                "last_action_at": now_str
            }}
        )
    elif body.event == "answered":
        update_q = {
            "last_call_outcome": "connected",
            "last_call_at": now_str,
            "last_action_at": now_str
        }
        if lead.get("status") == "new":
            update_q["status"] = "contacted"
        await db.leads.update_one({"id": lead_id}, {"$set": update_q})
    elif body.event == "ended":
        outcome = body.outcome or "no_response"
        duration = body.duration_seconds or 0
        
        # Duplicate check (same phone, same user, same timestamp or duration-adjusted matching)
        existing_logs = await db.call_logs.find({
            "phone": norm,
            "by_user_id": user["id"]
        }).sort("at", -1).to_list(50)
        existing = _check_duplicate_call(norm, user["id"], now_str, duration, existing_logs)
        
        if existing:
            # If it already exists, update duration, outcome, and summary
            update_fields = {
                "outcome": outcome,
                "duration_seconds": duration,
            }
            # Only overwrite summary if existing one is empty or generic/auto-logged
            existing_summary = existing.get("summary") or ""
            if not existing_summary or "Auto-logged" in existing_summary or "Synced via" in existing_summary:
                update_fields["summary"] = f"Call ended. Duration: {duration}s. (Auto-logged via app)"
                
            await db.call_logs.update_one({"id": existing["id"]}, {"$set": update_fields})
            doc_id = existing["id"]
        else:
            doc = {
                "id": str(uuid.uuid4()),
                "lead_id": lead_id,
                "phone": norm,
                "outcome": outcome,
                "summary": f"Call ended. Duration: {duration}s. (Auto-logged via app)",
                "by_user_id": user["id"],
                "by_user_name": user["name"],
                "at": now_str,
                "duration_seconds": duration,
                "direction": body.direction or "outgoing",
                "synced_from_app": True
            }
            await db.call_logs.insert_one(doc.copy())
            doc_id = doc["id"]
        
        update_q = {
            "last_call_outcome": outcome,
            "last_call_at": now_str,
            "last_action_at": now_str
        }
        if outcome == "connected" and lead.get("status") == "new":
            update_q["status"] = "contacted"
            
        await db.leads.update_one({"id": lead_id}, {"$set": update_q})
        await log_activity(user["id"], "call_logged", lead_id, {
            "outcome": outcome,
            "phone": norm,
            "duration_seconds": duration,
            "synced_from_app": True
        })
        
        # Intelligent Reassignment
        current_assignee = lead.get("assigned_to")
        if outcome == "connected" and user["role"] == "executive":
            if not current_assignee:
                await assign_lead(lead_id, target_user_id=user["id"], by_user_id=user["id"])
                await log_activity(
                    user["id"],
                    "lead_auto_assigned_callback",
                    lead_id,
                    {
                        "previous_assignee": None,
                        "new_assignee": user["id"],
                        "reason": "Connected call event on unassigned lead"
                    }
                )
            elif current_assignee != user["id"]:
                has_connected = await db.call_logs.find_one({
                    "lead_id": lead_id,
                    "by_user_id": current_assignee,
                    "outcome": "connected"
                })
                if not has_connected:
                    await assign_lead(lead_id, target_user_id=user["id"], by_user_id=user["id"])
                    await log_activity(
                        user["id"],
                        "lead_auto_reassigned_connected_call",
                        lead_id,
                        {
                            "previous_assignee": current_assignee,
                            "new_assignee": user["id"],
                            "reason": "Successful call connection event by another executive while current assignee had no successful contact"
                        }
                    )
                    
    return {"success": True}


@api.get("/calls")
async def list_all_calls(
    user: dict = Depends(get_current_user),
    outcome: Optional[str] = None,
    by_user_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 500,
):
    """Cross-lead call log feed. Executives only see their own calls."""
    query: Dict[str, Any] = {}
    if user["role"] == "executive":
        query["by_user_id"] = user["id"]
    elif by_user_id:
        query["by_user_id"] = by_user_id
    if outcome:
        if outcome not in CALL_OUTCOMES:
            raise HTTPException(status_code=400, detail=f"Invalid outcome. Must be one of {CALL_OUTCOMES}")
        query["outcome"] = outcome
    if start or end:
        rng: Dict[str, Any] = {}
        if start:
            rng["$gte"] = start
        if end:
            rng["$lte"] = end
        query["at"] = rng
    calls = await db.call_logs.find(query, {"_id": 0}).sort("at", -1).to_list(limit)
    # Enrich with lead names so clients can show who the call was with
    lead_ids = list({c["lead_id"] for c in calls if c.get("lead_id")})
    if lead_ids:
        leads = await db.leads.find(
            {"id": {"$in": lead_ids}}, {"_id": 0, "id": 1, "customer_name": 1}
        ).to_list(len(lead_ids))
        name_map = {ld["id"]: ld.get("customer_name") for ld in leads}
        for c in calls:
            if c.get("lead_id"):
                c["lead_name"] = name_map.get(c["lead_id"])
    return calls


@api.put("/leads/{lead_id}/active-wa-phone")
async def set_active_wa_phone(lead_id: str, body: ActiveWaPhoneInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target = (body.phone or "").strip()
    all_phones = [lead.get("phone")] + (lead.get("phones") or [])
    target_key = _normalize_phone(target)[-10:]
    matched = next((p for p in all_phones if p and _normalize_phone(p)[-10:] == target_key), None)
    if not matched:
        raise HTTPException(status_code=400, detail="Phone is not on this lead")
    await db.leads.update_one({"id": lead_id}, {"$set": {"active_wa_phone": matched, "last_action_at": iso(now_utc())}})
    await log_activity(user["id"], "active_wa_phone_set", lead_id, {"phone": matched})
    return await db.leads.find_one({"id": lead_id}, {"_id": 0})


@api.get("/leads/{lead_id}/oms-data")
async def get_lead_oms_data(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")

    # Collect and normalize all phone numbers (primary + alternate list)
    raw_phones = [lead.get("phone")] + (lead.get("phones") or [])
    suffixes = []
    for p in raw_phones:
        if not p:
            continue
        digits = re.sub(r"\D+", "", p)
        if len(digits) >= 10:
            suffixes.append(digits[-10:])
        elif digits:
            suffixes.append(digits)

    if not suffixes:
        return {"customer": None, "orders": [], "pis": [], "oms_base_url": OMS_BASE_URL}

    # Search OMS Customers by suffix-match (robust cross-number matching)
    or_conditions = [{"phone_numbers": {"$regex": f"{suffix}$"}} for suffix in suffixes]
    matched_customers = await oms_db.customers.find({"$or": or_conditions}, {"_id": 0}).to_list(20)

    if not matched_customers:
        return {"customer": None, "orders": [], "pis": [], "oms_base_url": OMS_BASE_URL}

    customer_ids = [c["id"] for c in matched_customers]

    # Fetch matched orders and PIs from OMS
    orders = await oms_db.orders.find({"customer_id": {"$in": customer_ids}}, {"_id": 0}).sort("created_at", -1).to_list(100)
    pis = await oms_db.proforma_invoices.find({"customer_id": {"$in": customer_ids}}, {"_id": 0}).sort("created_at", -1).to_list(100)

    return {
        "customer": matched_customers[0],
        "customers": matched_customers,
        "orders": orders,
        "pis": pis,
        "oms_base_url": OMS_BASE_URL
    }

@api.post("/whatsapp/send")
async def whatsapp_send(body: WhatsAppSendInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    # Pick the recipient(s): explicit active_wa_phone wins, else primary.
    # to_all_numbers=True sends the same message to EVERY number on the lead
    # (deduped on the last 10 digits).
    if body.to_all_numbers:
        seen_digits: set = set()
        targets: List[str] = []
        for p in [lead.get("phone")] + list(lead.get("phones") or []):
            digits = re.sub(r"\D", "", p or "")[-10:]
            if p and digits and digits not in seen_digits:
                seen_digits.add(digits)
                targets.append(p)
    else:
        targets = [lead.get("active_wa_phone") or lead.get("phone")]
    targets = [t for t in targets if t]
    if not targets:
        raise HTTPException(status_code=400, detail="Lead has no phone number")
    target_phone = targets[0]

    # If a template_name is given, send as template; else send freeform text.
    if body.template_name:
        cfg = await get_wa_config()
        tpl_meta = await _resolve_template_meta(body.template_name, body.template_lang or cfg["default_template_lang"])
        params_required = int(tpl_meta.get("params_required") or 0)
        # Resolve params: caller-supplied wins; else default-substitute when needed.
        provided = list(body.template_params) if body.template_params is not None else None
        if params_required == 0:
            # MUST NOT include any params for zero-placeholder templates (Meta #132000)
            params_to_send: Optional[List[str]] = None
            if provided:
                # Caller passed extras for a template that takes none — silently drop
                # rather than 400, so old clients keep working.
                logger.info(f"Dropping {len(provided)} stray params for zero-placeholder template {body.template_name}")
        else:
            if provided is None:
                # Legacy fallback: default {{1}} = customer_name; pad remaining
                first = lead.get("customer_name", "there")
                params_to_send = [first] + [first] * (params_required - 1)
            else:
                if len(provided) != params_required:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Incorrect number of template parameters: template '{body.template_name}' requires {params_required}, got {len(provided)}",
                    )
                params_to_send = provided
        send_results: List[tuple] = []
        for tp in targets:
            r = await wa_send_template(
                to_phone=tp,
                template_name=body.template_name,
                lang_code=tpl_meta.get("language") or body.template_lang or cfg["default_template_lang"],
                body_params=params_to_send,
            )
            send_results.append((tp, r))
    else:
        # Free-text: enforce WhatsApp's 24-hour customer-care window
        last_in = lead.get("last_user_message_at")
        within = False
        if last_in:
            try:
                d = datetime.fromisoformat(last_in.replace("Z", "+00:00"))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                within = (now_utc() - d) < timedelta(hours=24)
            except Exception:
                within = False
        if not within:
            raise HTTPException(
                status_code=400,
                detail="Outside the 24-hour customer service window — please use a template message",
            )
        # Resolve reply context: must reference a message on the SAME lead.
        reply_ctx_wamid: Optional[str] = None
        reply_ctx_local_id: Optional[str] = None
        reply_ctx_preview: Optional[str] = None
        if body.reply_to_message_id:
            src = await db.messages.find_one(
                {"id": body.reply_to_message_id, "lead_id": body.lead_id},
                {"_id": 0, "id": 1, "wamid": 1, "body": 1, "caption": 1, "direction": 1},
            )
            if src and src.get("wamid"):
                reply_ctx_wamid = src["wamid"]
                reply_ctx_local_id = src["id"]
                reply_ctx_preview = (src.get("caption") or src.get("body") or "")[:120]
            # If src not found or has no wamid (e.g. mock), we skip the context — fallback to plain send.
        send_results = []
        for i, tp in enumerate(targets):
            # Reply context only applies to the first (active) number — the quoted
            # message lives in that number's conversation.
            r = await wa_send_text(to_phone=tp, body=body.body, reply_to_wamid=reply_ctx_wamid if i == 0 else None)
            send_results.append((tp, r))

    msgs_out: List[dict] = []
    ok_count = 0
    any_ok = False
    for i, (tp, api_result) in enumerate(send_results):
        msg = {
            "id": str(uuid.uuid4()),
            "lead_id": body.lead_id,
            "direction": "out",
            "body": body.body,
            "to_phone": tp,
            "template_name": body.template_name,
            "status": api_result.get("status", "failed"),
            "wamid": api_result.get("wamid"),
            "error": api_result.get("error"),
            "error_code": api_result.get("code"),
            "at": iso(now_utc()),
            "by_user_id": user["id"],
        }
        # Attach reply-context metadata so the chat bubble can render a quoted preview
        if i == 0 and not body.template_name and body.reply_to_message_id:
            if 'reply_ctx_local_id' in locals() and reply_ctx_local_id:
                msg["reply_to_message_id"] = reply_ctx_local_id
            if 'reply_ctx_wamid' in locals() and reply_ctx_wamid:
                msg["reply_to_wamid"] = reply_ctx_wamid
            if 'reply_ctx_preview' in locals() and reply_ctx_preview:
                msg["reply_to_preview"] = reply_ctx_preview
        await db.messages.insert_one(msg.copy())
        sent_ok = msg["status"] in ("sent", "delivered", "read", "sent_mock")
        if sent_ok:
            ok_count += 1
            any_ok = True
            await _set_wa_status(body.lead_id, tp, True)
        elif msg["status"] == "failed" and (msg.get("error_code") in (131026, 131047, 470, 100) or "not on whatsapp" in (msg.get("error") or "").lower()):
            # Meta returns 131026 / "not in WhatsApp" type errors when the number isn't on WA
            await _set_wa_status(body.lead_id, tp, False)
        await log_activity(user["id"], "whatsapp_sent", body.lead_id, {"status": msg["status"], "wamid": msg["wamid"], "error": msg["error"], "to_phone": tp})
        msgs_out.append(strip_mongo(msg))

    update_lead = {"last_action_at": iso(now_utc()), "last_message_at": msgs_out[-1]["at"]}
    if any_ok:
        update_lead["has_whatsapp"] = True
    await db.leads.update_one({"id": body.lead_id}, {"$set": update_lead})

    if len(msgs_out) == 1:
        if msgs_out[0]["status"] == "failed":
            # Surface the Meta error so the executive sees what to fix
            raise HTTPException(status_code=400, detail=msgs_out[0].get("error") or "WhatsApp send failed")
        return msgs_out[0]
    failed = len(msgs_out) - ok_count
    if ok_count == 0:
        raise HTTPException(status_code=400, detail=f"Send failed on all {len(msgs_out)} numbers: {msgs_out[0].get('error') or 'unknown error'}")
    return {"multi": True, "sent": ok_count, "failed": failed, "messages": msgs_out}


# ------------- Rich-media composer endpoints (image / video / document / audio / location / contact / resend) -------------

class WAComposerBase(BaseModel):
    lead_id: str
    reply_to_message_id: Optional[str] = None


class WASendMedia(WAComposerBase):
    media_type: Literal["image", "video", "document", "audio"]
    media_url: str
    caption: Optional[str] = None
    filename: Optional[str] = None  # document only


class WASendPiPdf(BaseModel):
    lead_id: str
    pi_id: str
    pi_number: str


class WASendLocation(WAComposerBase):
    latitude: float
    longitude: float
    name: Optional[str] = None
    address: Optional[str] = None


class WAContactPhone(BaseModel):
    phone: str
    type: Optional[str] = "CELL"


class WAContactEmail(BaseModel):
    email: str
    type: Optional[str] = "WORK"


class WASendContact(WAComposerBase):
    name: str  # formatted display name
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phones: List[WAContactPhone]
    emails: Optional[List[WAContactEmail]] = None
    organization: Optional[str] = None


async def _assert_chat_permitted(user: dict, lead_id: str) -> dict:
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target_phone = lead.get("active_wa_phone") or lead.get("phone")
    if not target_phone:
        raise HTTPException(status_code=400, detail="Lead has no phone number")
    last_in = lead.get("last_user_message_at")
    within = False
    if last_in:
        try:
            d = datetime.fromisoformat(last_in.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            within = (now_utc() - d) < timedelta(hours=24)
        except Exception:
            within = False
    if not within:
        raise HTTPException(status_code=400, detail="Outside the 24-hour customer service window — please use a template message")
    return {"lead": lead, "target_phone": target_phone}


async def _resolve_reply_context(lead_id: str, reply_to_message_id: Optional[str]) -> Dict[str, Optional[str]]:
    if not reply_to_message_id:
        return {"wamid": None, "local_id": None, "preview": None}
    src = await db.messages.find_one({"id": reply_to_message_id, "lead_id": lead_id},
                                      {"_id": 0, "id": 1, "wamid": 1, "body": 1, "caption": 1})
    if not src or not src.get("wamid"):
        return {"wamid": None, "local_id": None, "preview": None}
    return {
        "wamid": src["wamid"],
        "local_id": src["id"],
        "preview": (src.get("caption") or src.get("body") or "")[:120],
    }


async def _record_sent_message(lead_id: str, user_id: str, target_phone: str, body_preview: str,
                                api_result: Dict[str, Any], extra: Dict[str, Any],
                                reply_ctx: Dict[str, Optional[str]]) -> Dict[str, Any]:
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "direction": "out",
        "body": body_preview,
        "to_phone": target_phone,
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "at": iso(now_utc()),
        "by_user_id": user_id,
        **extra,
    }
    if reply_ctx.get("local_id"):
        msg["reply_to_message_id"] = reply_ctx["local_id"]
    if reply_ctx.get("wamid"):
        msg["reply_to_wamid"] = reply_ctx["wamid"]
    if reply_ctx.get("preview"):
        msg["reply_to_preview"] = reply_ctx["preview"]
    await db.messages.insert_one(msg.copy())
    update_lead = {"last_action_at": iso(now_utc()), "last_message_at": msg["at"]}
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        update_lead["has_whatsapp"] = True
    await db.leads.update_one({"id": lead_id}, {"$set": update_lead})
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        await _set_wa_status(lead_id, target_phone, True)
    return msg


@api.post("/whatsapp/send-media")
async def whatsapp_send_media(body: WASendMedia, user: dict = Depends(get_current_user)):
    """Send an image/video/document/audio message to the lead. Media must be a public HTTPS URL
    (use POST /chatflows/upload-media first if uploading a local file)."""
    ctx = await _assert_chat_permitted(user, body.lead_id)
    target_phone = ctx["target_phone"]
    reply_ctx = await _resolve_reply_context(body.lead_id, body.reply_to_message_id)
    if body.media_type == "audio":
        api_result = await wa_send_audio(to_phone=target_phone, url=body.media_url, reply_to_wamid=reply_ctx["wamid"])
        preview = "[voice note]"
    else:
        api_result = await wa_send_media(
            to_phone=target_phone, media_type=body.media_type, url=body.media_url,
            caption=body.caption, filename=body.filename, reply_to_wamid=reply_ctx["wamid"],
        )
        if body.media_type == "image":
            preview = f"[image] {body.caption or ''}".rstrip()
        elif body.media_type == "video":
            preview = f"[video] {body.caption or ''}".rstrip()
        else:
            preview = f"[document: {body.filename or 'file'}] {body.caption or ''}".rstrip()
    extra = {"media_type": body.media_type, "media_url": body.media_url}
    if body.caption:
        extra["caption"] = body.caption
    if body.filename:
        extra["filename"] = body.filename
    msg = await _record_sent_message(body.lead_id, user["id"], target_phone, preview, api_result, extra, reply_ctx)
    await log_activity(user["id"], "whatsapp_sent", body.lead_id,
                       {"status": msg["status"], "wamid": msg["wamid"], "media_type": body.media_type})
    if msg["status"] == "failed":
        raise HTTPException(status_code=400, detail=msg.get("error") or "WhatsApp media send failed")
    return strip_mongo(msg)


@api.post("/whatsapp/send-pi-pdf")
async def whatsapp_send_pi_pdf(body: WASendPiPdf, user: dict = Depends(get_current_user)):
    ctx = await _assert_chat_permitted(user, body.lead_id)
    target_phone = ctx["target_phone"]
    
    # Resolve OMS JWT secret
    oms_jwt_secret = os.environ.get("OMS_JWT_SECRET", "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c")
    
    # Find active user in OMS database
    oms_user = await oms_db.users.find_one({"active": True})
    if not oms_user:
        oms_user = await oms_db.users.find_one({})
    if not oms_user:
        raise HTTPException(status_code=400, detail="No active user found in OMS to authenticate PDF request")
        
    # Generate token for OMS PDF endpoint
    token_payload = {
        "user_id": oms_user["id"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=1)
    }
    token = jwt.encode(token_payload, oms_jwt_secret, algorithm="HS256")
    
    pdf_fetched = False
    pdf_content = None
    
    # Try fetching internally from localhost:8000
    try:
        async with httpx.AsyncClient(timeout=15.0) as http_client:
            url = f"http://127.0.0.1:8000/api/proforma-invoices/{body.pi_id}/pdf"
            r = await http_client.get(url, params={"token": token})
            if r.status_code == 200:
                pdf_content = r.content
                pdf_fetched = True
                logger.info(f"Fetched PI PDF internally from localhost:8000 for PI {body.pi_number}")
    except Exception as e:
        logger.warning(f"Failed to fetch PI PDF internally from localhost:8000: {e}")
        
    # Fallback to public/configured OMS_BASE_URL
    if not pdf_fetched:
        try:
            async with httpx.AsyncClient(timeout=15.0) as http_client:
                url = f"{OMS_BASE_URL}/api/proforma-invoices/{body.pi_id}/pdf"
                r = await http_client.get(url, params={"token": token})
                if r.status_code == 200:
                    pdf_content = r.content
                    pdf_fetched = True
                    logger.info(f"Fetched PI PDF from OMS_BASE_URL {OMS_BASE_URL} for PI {body.pi_number}")
                else:
                    logger.error(f"Failed to fetch PI PDF from OMS_BASE_URL: status={r.status_code}, body={r.text[:200]}")
        except Exception as e:
            logger.error(f"Failed to fetch PI PDF from OMS_BASE_URL: {e}")
            
    if not pdf_fetched or not pdf_content:
        raise HTTPException(status_code=500, detail="Failed to fetch Proforma Invoice PDF from OMS server")
        
    # Save PDF locally
    filename = f"{uuid.uuid4()}_{body.pi_number}.pdf"
    filepath = UPLOAD_DIR / filename
    
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: filepath.write_bytes(pdf_content))
    
    # Construct CRM public URL
    crm_base_url = os.environ.get("FRONTEND_BASE_URL", "https://crm.mangalamagro.in").rstrip("/")
    public_url = f"{crm_base_url}/api/uploads/{filename}"
    
    # Send via WhatsApp
    caption = f"📄 *Proforma Invoice - CitSpray Aroma Sciences*\n\nDear Customer, please find attached Proforma Invoice *{body.pi_number}*."
    filename_param = f"{body.pi_number}.pdf"
    
    reply_ctx = await _resolve_reply_context(body.lead_id, None)
    
    api_result = await wa_send_media(
        to_phone=target_phone,
        media_type="document",
        url=public_url,
        caption=caption,
        filename=filename_param,
        reply_to_wamid=reply_ctx["wamid"]
    )
    
    preview = f"[document: {filename_param}] {caption}".rstrip()
    extra = {"media_type": "document", "media_url": public_url, "caption": caption, "filename": filename_param}
    
    msg = await _record_sent_message(body.lead_id, user["id"], target_phone, preview, api_result, extra, reply_ctx)
    await log_activity(user["id"], "whatsapp_sent", body.lead_id,
                       {"status": msg["status"], "wamid": msg["wamid"], "media_type": "document"})
                       
    if msg["status"] == "failed":
        raise HTTPException(status_code=400, detail=msg.get("error") or "WhatsApp document send failed")
        
    return strip_mongo(msg)


@api.post("/whatsapp/send-location")
async def whatsapp_send_location(body: WASendLocation, user: dict = Depends(get_current_user)):
    ctx = await _assert_chat_permitted(user, body.lead_id)
    target_phone = ctx["target_phone"]
    reply_ctx = await _resolve_reply_context(body.lead_id, body.reply_to_message_id)
    api_result = await wa_send_location(
        to_phone=target_phone, latitude=body.latitude, longitude=body.longitude,
        name=body.name, address=body.address, reply_to_wamid=reply_ctx["wamid"],
    )
    preview = f"[location] {body.name or ''} ({body.latitude:.4f}, {body.longitude:.4f})".strip()
    extra = {"msg_type": "location", "location": {
        "latitude": body.latitude, "longitude": body.longitude,
        "name": body.name, "address": body.address,
    }}
    msg = await _record_sent_message(body.lead_id, user["id"], target_phone, preview, api_result, extra, reply_ctx)
    if msg["status"] == "failed":
        raise HTTPException(status_code=400, detail=msg.get("error") or "WhatsApp location send failed")
    return strip_mongo(msg)


@api.post("/whatsapp/send-contact")
async def whatsapp_send_contact(body: WASendContact, user: dict = Depends(get_current_user)):
    ctx = await _assert_chat_permitted(user, body.lead_id)
    target_phone = ctx["target_phone"]
    reply_ctx = await _resolve_reply_context(body.lead_id, body.reply_to_message_id)
    contact_payload: Dict[str, Any] = {
        "name": {
            "formatted_name": body.name,
            "first_name": body.first_name or body.name.split(" ")[0],
            **({"last_name": body.last_name} if body.last_name else {}),
        },
        "phones": [{"phone": p.phone, "type": (p.type or "CELL").upper()} for p in body.phones],
    }
    if body.emails:
        contact_payload["emails"] = [{"email": e.email, "type": (e.type or "WORK").upper()} for e in body.emails]
    if body.organization:
        contact_payload["org"] = {"company": body.organization}
    api_result = await wa_send_contacts(to_phone=target_phone, contacts=[contact_payload], reply_to_wamid=reply_ctx["wamid"])
    phones_str = ", ".join(p.phone for p in body.phones)
    preview = f"[contact] {body.name} · {phones_str}"
    extra = {"msg_type": "contacts", "contacts": [contact_payload]}
    msg = await _record_sent_message(body.lead_id, user["id"], target_phone, preview, api_result, extra, reply_ctx)
    if msg["status"] == "failed":
        raise HTTPException(status_code=400, detail=msg.get("error") or "WhatsApp contact send failed")
    return strip_mongo(msg)


class ResendInput(BaseModel):
    message_id: str


class ReactInput(BaseModel):
    message_id: str  # local UUID of the target message
    emoji: str = ""  # "" clears the reaction


@api.post("/whatsapp/react")
async def whatsapp_react(body: ReactInput, user: dict = Depends(get_current_user)):
    """Send or remove a reaction on a message. Emits one `reaction` message to Meta
    and upserts the reaction on the target message doc. Only one reaction per user per
    message (per WA semantics). Empty emoji removes the reaction."""
    target = await db.messages.find_one({"id": body.message_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Message not found")
    target_wamid = target.get("wamid")
    if not target_wamid:
        raise HTTPException(status_code=400, detail="Target message has no WhatsApp id (mock?) — cannot react")
    ctx = await _assert_chat_permitted(user, target["lead_id"])
    to_phone = ctx["target_phone"]
    api_result = await wa_send_reaction(to_phone=to_phone, message_wamid=target_wamid, emoji=body.emoji or "")
    if api_result.get("status") == "failed":
        raise HTTPException(status_code=400, detail=api_result.get("error") or "Reaction send failed")
    # Upsert reaction on the target message: one per (direction=out, user_id)
    reactions = [r for r in (target.get("reactions") or []) if not (r.get("direction") == "out" and r.get("user_id") == user["id"])]
    if body.emoji:
        reactions.append({
            "emoji": body.emoji,
            "direction": "out",
            "user_id": user["id"],
            "user_name": user.get("name") or user.get("username"),
            "wamid": api_result.get("wamid"),
            "at": iso(now_utc()),
        })
    await db.messages.update_one({"id": body.message_id}, {"$set": {"reactions": reactions}})
    return {"ok": True, "emoji": body.emoji or None, "reactions": reactions}


@api.post("/whatsapp/resend")
async def whatsapp_resend(body: ResendInput, user: dict = Depends(get_current_user)):
    """Retry sending a previously-failed outbound message. Picks up every field from the
    original message doc (text / media / location / contacts / reply context) and re-sends."""
    src = await db.messages.find_one({"id": body.message_id}, {"_id": 0})
    if not src:
        raise HTTPException(status_code=404, detail="Message not found")
    if src.get("direction") != "out":
        raise HTTPException(status_code=400, detail="Only outbound messages can be resent")
    if src.get("status") not in ("failed",):
        raise HTTPException(status_code=400, detail=f"Only failed messages can be resent (current status: {src.get('status')})")
    ctx = await _assert_chat_permitted(user, src["lead_id"])
    target_phone = ctx["target_phone"]
    reply_to_wamid = src.get("reply_to_wamid")
    if src.get("media_type") in ("image", "video", "document"):
        api_result = await wa_send_media(target_phone, src["media_type"], src.get("media_url"),
                                         caption=src.get("caption"), filename=src.get("filename"),
                                         reply_to_wamid=reply_to_wamid)
    elif src.get("media_type") == "audio":
        api_result = await wa_send_audio(target_phone, src.get("media_url"), reply_to_wamid=reply_to_wamid)
    elif src.get("msg_type") == "location":
        loc = src.get("location") or {}
        api_result = await wa_send_location(target_phone, loc.get("latitude"), loc.get("longitude"),
                                             loc.get("name"), loc.get("address"), reply_to_wamid=reply_to_wamid)
    elif src.get("msg_type") == "contacts":
        api_result = await wa_send_contacts(target_phone, src.get("contacts") or [], reply_to_wamid=reply_to_wamid)
    else:
        api_result = await wa_send_text(target_phone, src.get("body") or "", reply_to_wamid=reply_to_wamid)
    await db.messages.update_one({"id": src["id"]}, {"$set": {
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "resent_at": iso(now_utc()),
    }})
    updated = await db.messages.find_one({"id": src["id"]}, {"_id": 0})
    if updated.get("status") == "failed":
        raise HTTPException(status_code=400, detail=updated.get("error") or "Resend failed")
    return strip_mongo(updated)




@api.get("/whatsapp/templates")
async def list_templates(user: dict = Depends(get_current_user)):
    return await db.whatsapp_templates.find({}, {"_id": 0}).sort("name", 1).to_list(200)

@api.post("/whatsapp/templates")
async def create_template(body: TemplateCreate, admin: dict = Depends(require_admin)):
    existing = await db.whatsapp_templates.find_one({"name": body.name})
    if existing:
        raise HTTPException(status_code=409, detail="Template name exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "category": body.category,
        "body": body.body,
        "params_required": count_template_placeholders(body.body),
        "created_at": iso(now_utc()),
    }
    await db.whatsapp_templates.insert_one(doc.copy())
    return strip_mongo(doc)

@api.delete("/whatsapp/templates/{tpl_id}")
async def delete_template(tpl_id: str, admin: dict = Depends(require_admin)):
    await db.whatsapp_templates.delete_one({"id": tpl_id})
    return {"ok": True}


# ------------- WhatsApp Cloud API status & template sync -------------
@api.get("/whatsapp/status")
async def whatsapp_status(user: dict = Depends(get_current_user)):
    cfg = await get_wa_config()
    if not cfg["enabled"]:
        return {"enabled": False, "reason": "WhatsApp access_token or phone_number_id not configured"}
    out: Dict[str, Any] = {
        "enabled": True,
        "phone_number_id": cfg["phone_number_id"],
        "waba_id": cfg["waba_id"],
        "api_version": cfg["api_version"],
        "verify_token": cfg["verify_token"],
        "default_template": cfg["default_template"],
        "default_template_lang": cfg["default_template_lang"],
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            r = await cli.get(
                f"{WA_BASE_URL}/{cfg['api_version']}/{cfg['phone_number_id']}",
                params={"fields": "verified_name,display_phone_number,quality_rating,code_verification_status,name_status"},
                headers={"Authorization": f"Bearer {cfg['access_token']}"},
            )
            if r.status_code < 400:
                out["phone"] = r.json()
            else:
                out["phone_error"] = r.json()
    except Exception as e:
        out["phone_error"] = str(e)
    return out


@api.post("/whatsapp/templates/sync")
async def sync_templates(admin: dict = Depends(require_admin)):
    cfg = await get_wa_config()
    if not (cfg["enabled"] and cfg["waba_id"]):
        raise HTTPException(status_code=400, detail="WhatsApp not configured (need access_token + phone_number_id + waba_id)")
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.get(
            f"{WA_BASE_URL}/{cfg['api_version']}/{cfg['waba_id']}/message_templates",
            params={"fields": "name,status,language,category,components", "limit": 200},
            headers={"Authorization": f"Bearer {cfg['access_token']}"},
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Meta error: {r.text}")
    data = r.json()
    upserted = 0
    for t in data.get("data", []):
        # Skip Meta's sample hello_world template
        if (t.get("name") or "").lower() == "hello_world":
            continue
        body = ""
        try:
            for c in (t.get("components") or []):
                if c.get("type") == "BODY":
                    body = c.get("text") or ""
                    break
        except Exception:
            pass
        doc = {
            "id": str(uuid.uuid4()),
            "name": t.get("name"),
            "category": (t.get("category") or "utility").lower(),
            "language": t.get("language"),
            "status": t.get("status"),
            "body": body,
            "params_required": count_template_placeholders(body),
            "synced_from_meta": True,
            "synced_at": iso(now_utc()),
        }
        # upsert by name+language (Meta uniqueness key)
        existing = await db.whatsapp_templates.find_one({"name": doc["name"], "language": doc["language"]}, {"_id": 0})
        if existing:
            await db.whatsapp_templates.update_one(
                {"name": doc["name"], "language": doc["language"]},
                {"$set": {k: v for k, v in doc.items() if k != "id"}},
            )
        else:
            await db.whatsapp_templates.insert_one(doc.copy())
        upserted += 1
    return {"ok": True, "synced": upserted, "templates": [t.get("name") for t in data.get("data", [])]}

# ------------- Followups -------------
@api.get("/followups")
async def list_followups(
    user: dict = Depends(get_current_user),
    scope: str = "mine",
    status: Optional[str] = None,
    lead_id: Optional[str] = None,
):
    query: Dict[str, Any] = {}
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    if lead_id:
        query["lead_id"] = lead_id
    if user["role"] == "executive" or scope == "mine":
        query["executive_id"] = user["id"]
    if status:
        query["status"] = status
    # Exclude followups that are snoozed until a future time
    now_iso = datetime.now(timezone.utc).isoformat()
    query["snoozed_until"] = {"$not": {"$gt": now_iso}}
    fu = await db.followups.find(query, {"_id": 0}).sort("due_at", 1).to_list(500)
    # Enrich each follow-up with the parent lead's customer_name + phone (so the
    # alarm UI doesn't need a second roundtrip).
    lead_ids = list({f.get("lead_id") for f in fu if f.get("lead_id")})
    name_map: Dict[str, Dict[str, Any]] = {}
    if lead_ids:
        async for ld in db.leads.find({"id": {"$in": lead_ids}}, {"_id": 0, "id": 1, "customer_name": 1, "phone": 1, "active_wa_phone": 1}):
            name_map[ld["id"]] = ld
    for f in fu:
        ld = name_map.get(f.get("lead_id") or "") or {}
        f["lead_customer_name"] = ld.get("customer_name")
        f["lead_phone"] = ld.get("active_wa_phone") or ld.get("phone")
    return fu

@api.post("/followups")
async def create_followup(body: FollowupCreate, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    doc = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "executive_id": lead.get("assigned_to") or user["id"],
        "created_by": user["id"],
        "due_at": body.due_at,
        "note": body.note or "",
        "status": "pending",
        "created_at": iso(now_utc()),
        "completed_at": None,
    }
    await db.followups.insert_one(doc.copy())
    await log_activity(user["id"], "followup_created", body.lead_id, {"due_at": body.due_at})
    return strip_mongo(doc)

@api.patch("/followups/{fu_id}")
async def update_followup(fu_id: str, body: FollowupUpdate, user: dict = Depends(get_current_user)):
    fu = await db.followups.find_one({"id": fu_id}, {"_id": 0})
    if not fu:
        raise HTTPException(status_code=404, detail="Followup not found")
    if user["role"] == "executive" and fu["executive_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    updates: Dict[str, Any] = {}
    if body.status:
        updates["status"] = body.status
        if body.status == "done":
            updates["completed_at"] = iso(now_utc())
            clear_event = {
                "type": "followup",
                "action": "clear",
                "fu_id": fu_id
            }
            await manager.broadcast_to_user(fu["executive_id"], clear_event)
    if body.note is not None:
        updates["note"] = body.note
    if body.due_at is not None:
        updates["due_at"] = body.due_at
    if updates:
        await db.followups.update_one({"id": fu_id}, {"$set": updates})
    fu = await db.followups.find_one({"id": fu_id}, {"_id": 0})
    return fu

# ------------- Routing rules -------------
@api.get("/routing-rules")
async def get_rules(user: dict = Depends(get_current_user)):
    return await get_routing_rules()

@api.put("/routing-rules")
async def update_rules(body: RoutingRulesUpdate, admin: dict = Depends(require_admin)):
    await get_routing_rules()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if updates:
        await db.routing_rules.update_one({"key": "default"}, {"$set": updates}, upsert=True)
    r = await db.routing_rules.find_one({"key": "default"}, {"_id": 0})
    return r

# ------------- Reports -------------
def _parse_ist_range(date_from: Optional[str], date_to: Optional[str]) -> Dict[str, str]:
    """Build an inclusive ISO range (UTC) from two YYYY-MM-DD IST dates."""
    if not date_from and not date_to:
        return {}
    from zoneinfo import ZoneInfo
    ist = ZoneInfo("Asia/Kolkata")
    out: Dict[str, str] = {}
    if date_from:
        d = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=ist)
        out["$gte"] = iso(d.astimezone(timezone.utc))
    if date_to:
        d = datetime.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, microsecond=999000, tzinfo=ist)
        out["$lte"] = iso(d.astimezone(timezone.utc))
    return out


@api.get("/reports/overview")
async def reports_overview(
    admin: dict = Depends(require_admin),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """Optional `date_from`/`date_to` (YYYY-MM-DD, IST, inclusive) narrow lead-creation,
    call-log, message and followup counters to that window. Omitting both = all-time.
    Conversion rate, source/status breakdown and the timeseries also respect the window."""
    try:
        date_range = _parse_ist_range(date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="date_from / date_to must be YYYY-MM-DD")
    lead_q: Dict[str, Any] = {}
    msg_q: Dict[str, Any] = {}
    call_q: Dict[str, Any] = {}
    fup_q: Dict[str, Any] = {}
    if date_range:
        lead_q["created_at"] = date_range
        msg_q["at"] = date_range
        call_q["at"] = date_range
        fup_q["created_at"] = date_range
    total = await db.leads.count_documents(lead_q)
    by_status_cursor = db.leads.aggregate([{"$match": lead_q}, {"$group": {"_id": "$status", "c": {"$sum": 1}}}])
    by_status = {doc["_id"] or "unknown": doc["c"] async for doc in by_status_cursor}
    by_source_cursor = db.leads.aggregate([{"$match": lead_q}, {"$group": {"_id": "$source", "c": {"$sum": 1}}}])
    by_source = {doc["_id"] or "unknown": doc["c"] async for doc in by_source_cursor}
    converted = by_status.get("converted", 0)
    total_non_new = await db.leads.count_documents({**lead_q, "status": {"$ne": "new"}})
    conversion_rate = round((converted / total_non_new) * 100, 2) if total_non_new else 0
    # reassigned = count leads (in window) with > 1 assignment history entry
    reassigned = await db.leads.count_documents({**lead_q, "assignment_history.1": {"$exists": True}})
    # missed = pending followups past due_at (always cross-window — pending reflects current state)
    now_iso = iso(now_utc())
    missed_followups = await db.followups.count_documents({"status": "pending", "due_at": {"$lt": now_iso}})
    # per executive
    execs = await db.users.find({"role": "executive"}, {"_id": 0, "password_hash": 0}).to_list(500)
    per_exec = []
    # Pre-aggregate calls (windowed) by user × outcome
    call_pipeline = [
        {"$match": call_q} if call_q else {"$match": {}},
        {"$group": {"_id": {"user": "$by_user_id", "outcome": "$outcome"}, "c": {"$sum": 1}}},
    ]
    call_buckets: Dict[str, Dict[str, int]] = {}
    async for d in db.call_logs.aggregate(call_pipeline):
        u = (d.get("_id") or {}).get("user")
        oc = (d.get("_id") or {}).get("outcome")
        if not u:
            continue
        call_buckets.setdefault(u, {})[oc] = d["c"]
    # Pre-aggregate calls duration (windowed) by user
    call_duration_pipeline = [
        {"$match": call_q} if call_q else {"$match": {}},
        {"$group": {"_id": "$by_user_id", "total_duration": {"$sum": "$duration_seconds"}}}
    ]
    call_durations: Dict[str, int] = {}
    async for d in db.call_logs.aggregate(call_duration_pipeline):
        u = d.get("_id")
        if u:
            call_durations[u] = d.get("total_duration", 0)
    # Pre-aggregate messages (windowed) by user (sent count)
    msg_pipeline = [
        {"$match": {**msg_q, "direction": "out", "by_user_id": {"$ne": None}}},
        {"$group": {"_id": "$by_user_id", "c": {"$sum": 1}}},
    ]
    msgs_sent: Dict[str, int] = {}
    async for d in db.messages.aggregate(msg_pipeline):
        msgs_sent[d["_id"]] = d["c"]
        
    # Pre-aggregate unique numbers called by user
    unique_calls_pipeline = [
        {"$match": call_q} if call_q else {"$match": {}},
        {"$group": {"_id": {"user": "$by_user_id", "phone": "$phone"}}},
        {"$group": {"_id": "$_id.user", "unique_count": {"$sum": 1}}}
    ]
    unique_calls: Dict[str, int] = {}
    async for d in db.call_logs.aggregate(unique_calls_pipeline):
        u = d.get("_id")
        if u:
            unique_calls[u] = d.get("unique_count", 0)

    for e in execs:
        base = {**lead_q, "assigned_to": e["id"]}
        count = await db.leads.count_documents(base)
        conv = await db.leads.count_documents({**base, "status": "converted"})
        qualified = await db.leads.count_documents({**base, "status": "qualified"})
        lost = await db.leads.count_documents({**base, "status": "lost"})
        contacted = await db.leads.count_documents({**base, "status": "contacted"})
        new_leads = await db.leads.count_documents({**base, "status": "new"})
        wa_threads = await db.leads.count_documents({**base, "has_whatsapp": True})
        # Followup completion rate (windowed)
        fu_base = {**fup_q, "executive_id": e["id"]}
        fu_total = await db.followups.count_documents(fu_base)
        fu_done = await db.followups.count_documents({**fu_base, "status": "done"})
        fu_pending = await db.followups.count_documents({**fu_base, "status": "pending"})
        fu_completion = round((fu_done / fu_total) * 100, 1) if fu_total else 0
        # avg response = avg(opened_at - created_at) where both present, windowed
        pipeline = [
            {"$match": {**lead_q, "assigned_to": e["id"], "opened_at": {"$ne": None}}},
            {"$project": {"delta": {"$subtract": [
                {"$toDate": "$opened_at"}, {"$toDate": "$created_at"}
            ]}}},
            {"$group": {"_id": None, "avg": {"$avg": "$delta"}}},
        ]
        avg_ms = 0
        async for doc in db.leads.aggregate(pipeline):
            avg_ms = int(doc.get("avg") or 0)
        calls = call_buckets.get(e["id"], {})
        total_calls = sum(calls.values())
        per_exec.append({
            "id": e["id"],
            "username": e["username"],
            "name": e["name"],
            "active": e.get("active", True),
            "leads": count,
            "new_leads": new_leads,
            "contacted": contacted,
            "qualified": qualified,
            "converted": conv,
            "lost": lost,
            "conversion_rate": round((conv / (count - new_leads)) * 100, 1) if (count - new_leads) else 0,
            "avg_response_seconds": int(avg_ms / 1000) if avg_ms else 0,
            "calls_total": total_calls,
            "calls_unique_numbers": unique_calls.get(e["id"], 0),
            "calls_talk_time_seconds": call_durations.get(e["id"], 0),
            "calls_connected": calls.get("connected", 0),
            "calls_no_response": calls.get("no_response", 0),
            "calls_not_reachable": calls.get("not_reachable", 0),
            "calls_rejected": calls.get("rejected", 0),
            "calls_busy": calls.get("busy", 0),
            "calls_invalid": calls.get("invalid", 0),
            "wa_threads": wa_threads,
            "wa_messages_sent": msgs_sent.get(e["id"], 0),
            "followup_total": fu_total,
            "followup_done": fu_done,
            "followup_pending": fu_pending,
            "followup_completion_pct": fu_completion,
        })
    # Timeseries — show 14 days ending at date_to (or today). Always windowed
    # to whichever leads fall within (date_from..date_to) so the chart matches
    # the rest of the page.
    from collections import Counter
    if date_to:
        end = datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        end = now_utc()
    ts_q = lead_q.copy()
    if "created_at" not in ts_q:
        ts_q["created_at"] = {"$gte": iso(end - timedelta(days=14))}
    leads_all = await db.leads.find(ts_q, {"_id": 0, "created_at": 1, "source": 1}).to_list(20000)
    days: Dict[str, int] = {}
    for i in range(13, -1, -1):
        d = (end - timedelta(days=i)).strftime("%Y-%m-%d")
        days[d] = 0
    for ld in leads_all:
        ca = (ld.get("created_at") or "")[:10]
        if ca in days:
            days[ca] += 1
    chart = [{"date": d, "count": c} for d, c in days.items()]
    return {
        "total_leads": total,
        "by_status": by_status,
        "by_source": by_source,
        "conversion_rate": conversion_rate,
        "reassigned_leads": reassigned,
        "missed_followups": missed_followups,
        "per_executive": per_exec,
        "leads_timeseries": chart,
        "date_from": date_from,
        "date_to": date_to,
    }

@api.get("/reports/executive-detail/{exec_id}")
async def executive_detail_report(
    exec_id: str,
    user: dict = Depends(get_current_user),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """Detailed executive activity report for a date range.
    Returns:
    - call_log: chronological list of calls with customer name, phone, outcome,
      summary, time, and gap (seconds) since the previous call.
    - leads_assigned: total leads assigned to this exec in the window.
    - leads_worked: how many of those leads the exec actually touched (called,
      messaged, or changed status on) in the window.
    """
    if user["role"] != "admin" and user["id"] != exec_id:
        raise HTTPException(status_code=403, detail="Access denied")

    target = await db.users.find_one({"id": exec_id}, {"_id": 0, "password_hash": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Executive not found")
    try:
        date_range = _parse_ist_range(date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="date_from / date_to must be YYYY-MM-DD")

    # --- Call log ---
    call_q: Dict[str, Any] = {"by_user_id": exec_id}
    if date_range:
        call_q["at"] = date_range
    raw_calls = await db.call_logs.find(call_q, {"_id": 0}).sort("at", 1).to_list(2000)

    # Resolve lead names in one batch
    lead_ids = list({c["lead_id"] for c in raw_calls if c.get("lead_id")})
    lead_name_map: Dict[str, dict] = {}
    if lead_ids:
        async for ld in db.leads.find({"id": {"$in": lead_ids}}, {"_id": 0, "id": 1, "customer_name": 1, "phone": 1}):
            lead_name_map[ld["id"]] = ld

    call_log = []
    prev_at = None
    for c in raw_calls:
        gap_seconds = None
        if prev_at and c.get("at"):
            try:
                cur_dt = datetime.fromisoformat(c["at"].replace("Z", "+00:00"))
                prv_dt = datetime.fromisoformat(prev_at.replace("Z", "+00:00"))
                gap_seconds = int((cur_dt - prv_dt).total_seconds())
            except Exception:
                pass
        ld_info = lead_name_map.get(c.get("lead_id"), {})
        call_log.append({
            "id": c.get("id"),
            "lead_id": c.get("lead_id"),
            "customer_name": ld_info.get("customer_name", "Unknown"),
            "customer_phone": c.get("phone") or ld_info.get("phone"),
            "outcome": c.get("outcome"),
            "summary": c.get("summary"),
            "at": c.get("at"),
            "duration_seconds": c.get("duration_seconds") or 0,
            "gap_seconds": gap_seconds,
        })
        prev_at = c.get("at")

    # --- Leads assigned in window ---
    lead_q: Dict[str, Any] = {"assigned_to": exec_id}
    if date_range:
        lead_q["created_at"] = date_range
    leads_assigned = await db.leads.count_documents(lead_q)

    # --- Leads worked (touched): leads where exec made a call, sent a message,
    #     or changed status within the window ---
    worked_ids: set = set()
    # From calls
    for c in raw_calls:
        if c.get("lead_id"):
            worked_ids.add(c["lead_id"])
    # From outbound messages
    msg_q: Dict[str, Any] = {"by_user_id": exec_id, "direction": "out"}
    if date_range:
        msg_q["at"] = date_range
    msg_lead_ids = await db.messages.distinct("lead_id", msg_q)
    worked_ids.update(msg_lead_ids)
    # From activity logs (status changes etc.)
    act_q: Dict[str, Any] = {"user_id": exec_id}
    if date_range:
        act_q["at"] = date_range
    act_lead_ids = await db.activity_logs.distinct("lead_id", act_q)
    worked_ids.update(act_lead_ids)
    # Only count leads that are actually assigned to this exec
    if worked_ids:
        leads_worked = await db.leads.count_documents({
            "assigned_to": exec_id,
            "id": {"$in": list(worked_ids)}
        })
    else:
        leads_worked = 0

    total_talk_time_seconds = sum(c.get("duration_seconds") or 0 for c in raw_calls)
    unique_numbers_called = len({c.get("customer_phone") for c in call_log if c.get("customer_phone")})

    # --- Additional metrics for executive's own breakdown ---
    base = {**lead_q, "assigned_to": exec_id}
    count = leads_assigned
    conv = await db.leads.count_documents({**base, "status": "converted"})
    qualified = await db.leads.count_documents({**base, "status": "qualified"})
    lost = await db.leads.count_documents({**base, "status": "lost"})
    contacted = await db.leads.count_documents({**base, "status": "contacted"})
    new_leads = await db.leads.count_documents({**base, "status": "new"})

    fup_q: Dict[str, Any] = {}
    if date_range:
        fup_q["created_at"] = date_range
    fu_base = {**fup_q, "executive_id": exec_id}
    fu_total = await db.followups.count_documents(fu_base)
    fu_done = await db.followups.count_documents({**fu_base, "status": "done"})
    fu_pending = await db.followups.count_documents({**fu_base, "status": "pending"})
    fu_completion = round((fu_done / fu_total) * 100, 1) if fu_total else 0

    msg_out_q: Dict[str, Any] = {"by_user_id": exec_id, "direction": "out"}
    if date_range:
        msg_out_q["at"] = date_range
    wa_messages_sent = await db.messages.count_documents(msg_out_q)

    calls_by_outcome = {
        "connected": 0,
        "no_response": 0,
        "rejected": 0,
        "not_reachable": 0,
        "busy": 0,
        "invalid": 0,
    }
    for c in call_log:
        oc = c.get("outcome")
        if oc in calls_by_outcome:
            calls_by_outcome[oc] += 1

    return {
        "executive": {
            "id": target["id"],
            "name": target.get("name"),
            "username": target.get("username"),
        },
        "call_log": call_log,
        "total_calls": len(call_log),
        "unique_numbers_called": unique_numbers_called,
        "total_talk_time_seconds": total_talk_time_seconds,
        "leads_assigned": leads_assigned,
        "leads_worked": leads_worked,
        "conversions": conv,
        "conversion_rate": round((conv / (count - new_leads)) * 100, 1) if (count - new_leads) else 0,
        "leads_by_status": {
            "new": new_leads,
            "contacted": contacted,
            "qualified": qualified,
            "converted": conv,
            "lost": lost,
        },
        "followup_total": fu_total,
        "followup_done": fu_done,
        "followup_pending": fu_pending,
        "followup_completion_pct": fu_completion,
        "wa_messages_sent": wa_messages_sent,
        "calls_by_outcome": calls_by_outcome,
        "date_from": date_from,
        "date_to": date_to,
    }

@api.get("/reports/daily-calls")
async def reports_daily_calls(
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user_id: Optional[str] = None,
    user: dict = Depends(get_current_user)
):
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
        
    # Default to today in IST
    if not date_from and not date_to:
        if not date:
            from zoneinfo import ZoneInfo
            ist = ZoneInfo("Asia/Kolkata")
            date = datetime.now(ist).strftime("%Y-%m-%d")
        date_from = date
        date_to = date
        
    try:
        date_range = _parse_ist_range(date_from, date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="date formats must be YYYY-MM-DD")
        
    q: Dict[str, Any] = {}
    if date_range:
        q["at"] = date_range
        
    # Access control
    if user["role"] == "executive":
        q["by_user_id"] = user["id"]
    elif user["role"] == "admin":
        if user_id:
            q["by_user_id"] = user_id
            
    cursor = db.call_logs.find(q, {"_id": 0, "by_user_id": 1, "by_user_name": 1, "duration_seconds": 1, "outcome": 1, "phone": 1})
    logs = await cursor.to_list(None)
    
    total_calls = len(logs)
    unique_numbers_called = len({c.get("phone") for c in logs if c.get("phone")})
    total_talk_time_seconds = sum(c.get("duration_seconds") or 0 for c in logs)
    talked_calls = sum(1 for c in logs if (c.get("duration_seconds") or 0) > 0)
    
    response_data = {
        "total_calls": total_calls,
        "unique_numbers_called": unique_numbers_called,
        "total_talk_time_seconds": total_talk_time_seconds,
        "talked_calls": talked_calls,
        "date_from": date_from,
        "date_to": date_to
    }
    
    if user["role"] == "admin":
        # Get active executives
        executives = await db.users.find({"role": "executive"}, {"_id": 0, "id": 1, "name": 1, "username": 1}).to_list(100)
        exec_map = {
            e["id"]: {
                "user_id": e["id"],
                "user_name": e["name"],
                "total_calls": 0,
                "total_talk_time_seconds": 0,
                "talked_calls": 0,
                "unique_numbers_called": 0,
                "_phones": set()
            } for e in executives
        }
        
        for c in logs:
            uid = c.get("by_user_id")
            if not uid:
                continue
            if uid not in exec_map:
                exec_map[uid] = {
                    "user_id": uid,
                    "user_name": c.get("by_user_name") or "Unknown Executive",
                    "total_calls": 0,
                    "total_talk_time_seconds": 0,
                    "talked_calls": 0,
                    "unique_numbers_called": 0,
                    "_phones": set()
                }
            dur = c.get("duration_seconds") or 0
            exec_map[uid]["total_calls"] += 1
            exec_map[uid]["total_talk_time_seconds"] += dur
            if dur > 0:
                exec_map[uid]["talked_calls"] += 1
            phone = c.get("phone")
            if phone:
                exec_map[uid]["_phones"].add(phone)
                
        for em in exec_map.values():
            em["unique_numbers_called"] = len(em.pop("_phones"))
            
        response_data["per_executive"] = list(exec_map.values())
        
    return response_data


@api.get("/leads/phone-map")
async def get_leads_phone_map(user: dict = Depends(get_current_user)):
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    q = {}
    if user["role"] == "executive":
        q["assigned_to"] = user["id"]
        
    cursor = db.leads.find(q, {"_id": 0, "phone": 1, "customer_name": 1, "id": 1, "status": 1})
    leads = await cursor.to_list(None)
    
    out = {}
    for l in leads:
        norm = normalize_phone_display(l.get("phone"))
        if norm:
            out[norm] = {
                "name": l.get("customer_name") or "Unnamed",
                "id": l.get("id"),
                "status": l.get("status") or "new"
            }
    return out


@api.post("/leads/get-or-create")
async def get_or_create_lead(body: PhoneInput, user: dict = Depends(get_current_user)):
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    norm = normalize_phone_display(body.phone)
    if not norm:
        raise HTTPException(status_code=400, detail="Invalid phone number")
        
    lead = await _find_lead_by_phone(norm)
    if not lead:
        lead_id = str(uuid.uuid4())
        lead_doc = {
            "id": lead_id,
            "phone": norm,
            "customer_name": f"New Call Lead {norm}",
            "status": "new",
            "source": "Auto-Created",
            "assigned_to": user["id"],
            "created_at": iso(now_utc()),
            "requirement": "Auto-created via calling app lookup",
            "last_action_at": iso(now_utc()),
            "sort_at": iso(now_utc()),
        }
        await db.leads.insert_one(lead_doc)
        await log_activity(user["id"], "lead_created", lead_id, {"source": "Auto-Created", "phone": norm})
        lead = lead_doc
        
    return {"lead_id": lead["id"]}


@api.get("/reports/my")
async def reports_my(user: dict = Depends(get_current_user)):
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    my_id = user["id"]
    total = await db.leads.count_documents({"assigned_to": my_id})
    new_count = await db.leads.count_documents({"assigned_to": my_id, "status": "new"})
    converted = await db.leads.count_documents({"assigned_to": my_id, "status": "converted"})
    now_iso = iso(now_utc())
    pending_fu = await db.followups.count_documents({"executive_id": my_id, "status": "pending"})
    overdue_fu = await db.followups.count_documents({
        "executive_id": my_id, "status": "pending", "due_at": {"$lt": now_iso}
    })
    return {
        "total_leads": total,
        "new_leads": new_count,
        "converted": converted,
        "pending_followups": pending_fu,
        "overdue_followups": overdue_fu,
    }

# ------------- Payment QR (UPI) -------------
PAYMENT_QR_BASE = {
    "gst": "upi://pay?pa={pa}&mam=1&am={am}&cu=INR",
    "no_gst": "upi://pay?pa={pa}&mam=1&am={am}&cu=INR",
}

# Default seed accounts — written to system_settings.payment_qr on first read
# only if no doc exists. Admin can edit/add via /api/settings/payment-qr.
DEFAULT_PAYMENT_QR = {
    "gst": [
        {
            "id": str(uuid.uuid4()),
            "label": "Mangalam Agro · PNB",
            "name": "Mangalam Agro",
            "bank": "Punjab National Bank",
            "branch": "Khamla, Nagpur",
            "ifsc": "PUNB0147200",
            "account_number": "1472002100029992",
            "upi_phone": "9371177870",
            "upi_id": "archanaagrawal80-1@okicici",
        },
    ],
    "no_gst": [
        {
            "id": str(uuid.uuid4()),
            "label": "Arnav Mukul Agrawal · PNB",
            "name": "Arnav Mukul Agrawal",
            "bank": "Punjab National Bank",
            "branch": "Khamla, Nagpur",
            "ifsc": "PUNB0147200",
            "account_number": "1472000100369074",
            "upi_phone": "7385171720",
            "upi_id": "citronellaoilnagpur-2@okaxis",
        },
    ],
}


class PaymentQRAccount(BaseModel):
    id: Optional[str] = None
    label: str
    name: str
    bank: str
    branch: Optional[str] = ""
    ifsc: str
    account_number: str
    upi_phone: Optional[str] = ""
    upi_id: str


class PaymentQRSettings(BaseModel):
    gst: List[PaymentQRAccount]
    no_gst: List[PaymentQRAccount]


class PaymentQRGenerate(BaseModel):
    type: Literal["gst", "no_gst"]
    account_id: str
    amount: int  # whole rupees only


async def _get_payment_qr_settings() -> Dict[str, Any]:
    doc = await db.system_settings.find_one({"key": "payment_qr"}, {"_id": 0})
    if not doc:
        seed = {"key": "payment_qr", **DEFAULT_PAYMENT_QR, "seeded_at": iso(now_utc())}
        await db.system_settings.insert_one(seed.copy())
        doc = seed
    return {
        "gst": list(doc.get("gst") or []),
        "no_gst": list(doc.get("no_gst") or []),
    }


def _build_upi_url(pa: str, amount: int) -> str:
    """Encode a UPI deep-link with the given amount. Whole rupees only."""
    from urllib.parse import quote
    return f"upi://pay?pa={quote(pa, safe='@.-_')}&mam=1&am={int(amount)}&cu=INR"


def _render_payment_qr_jpeg(upi_url: str) -> bytes:
    """Generate a 600x600 black-on-white QR for the given UPI URL as JPEG.
    JPEG does not support transparency, so we flatten the QR's RGBA / 1-bit
    output onto a white background before encoding."""
    import qrcode
    from PIL import Image
    img = qrcode.make(upi_url, box_size=10, border=2)
    if img.mode != "RGB":
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img.convert("RGB"))
        img = bg
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92, optimize=True)
    return buf.getvalue()


def _format_payment_caption(account: Dict[str, Any], amount: int, qr_type: str) -> str:
    """Hard-coded caption layout per spec. Includes amount + bank info."""
    lines = [
        f"💳 Payment Request — ₹{amount:,}",
        "Scan the QR above with any UPI app to pay.",
        "",
        "BANK DETAILS",
        f"Name: {account.get('name', '')}",
        f"Bank: {account.get('bank', '')}",
    ]
    if account.get("branch"):
        lines.append(f"Branch: {account['branch']}")
    lines.extend([
        f"Account Number: {account.get('account_number', '')}",
        f"IFSC: {account.get('ifsc', '')}",
    ])
    if account.get("upi_phone"):
        lines.append(f"UPI No.: {account['upi_phone']}")
    lines.append(f"UPI ID: {account.get('upi_id', '')}")
    return "\n".join(lines)


@api.get("/settings/payment-qr")
async def get_payment_qr_settings(user: dict = Depends(get_current_user)):
    """Return both GST and Without-GST account lists. Visible to executives so
    they can pick which account to send; only admins can mutate."""
    return await _get_payment_qr_settings()


@api.put("/settings/payment-qr")
async def update_payment_qr_settings(body: PaymentQRSettings, admin: dict = Depends(require_admin)):
    """Replace the entire GST + Without-GST account lists. Each account gets a
    UUID id assigned if not present."""
    def normalise(accts: List[PaymentQRAccount]) -> List[Dict[str, Any]]:
        out = []
        for a in accts:
            d = a.model_dump()
            d["id"] = d.get("id") or str(uuid.uuid4())
            out.append(d)
        return out
    payload = {
        "key": "payment_qr",
        "gst": normalise(body.gst),
        "no_gst": normalise(body.no_gst),
        "updated_by": admin["id"],
        "updated_at": iso(now_utc()),
    }
    await db.system_settings.update_one({"key": "payment_qr"}, {"$set": payload}, upsert=True)
    await log_activity(admin["id"], "payment_qr_settings_updated", None, {"gst": len(payload["gst"]), "no_gst": len(payload["no_gst"])})
    return await _get_payment_qr_settings()


@api.post("/payment-qr/generate")
async def generate_payment_qr(body: PaymentQRGenerate, request: Request, user: dict = Depends(get_current_user)):
    """Render a fresh PNG QR code for the requested {type, account_id, amount}.
    Returns the public media URL + the formatted caption + the UPI URL.
    The caller (frontend chat composer) then fires `/whatsapp/send-media`
    with image=<media_url> and caption=<caption>."""
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be a positive whole rupee value")
    settings = await _get_payment_qr_settings()
    bucket = settings.get(body.type) or []
    account = next((a for a in bucket if a.get("id") == body.account_id), None)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account not found in {body.type} list")
    upi_url = _build_upi_url(account.get("upi_id") or "", body.amount)
    jpeg_bytes = _render_payment_qr_jpeg(upi_url)
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    stored_name = f"qr_{uuid.uuid4().hex}.jpg"
    (UPLOAD_ROOT / stored_name).write_bytes(jpeg_bytes)
    await db.media_files.update_one(
        {"stored_name": stored_name},
        {"$set": {
            "stored_name": stored_name,
            "original_filename": f"payment_qr_{body.amount}.jpg",
            "mime_type": "image/jpeg",
            "size": len(jpeg_bytes),
            "kind": "payment_qr",
            "uploaded_at": iso(now_utc()),
            "source": "payment_qr_generator",
            "meta": {"type": body.type, "account_id": body.account_id, "amount": body.amount, "upi_url": upi_url},
        }},
        upsert=True,
    )
    base = (os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if not base:
        fwd_proto = request.headers.get("x-forwarded-proto")
        fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        base = f"{fwd_proto or request.url.scheme}://{fwd_host}" if fwd_host else str(request.base_url).rstrip("/")
    public_url = f"{base}/api/media/{stored_name}"
    caption = _format_payment_caption(account, body.amount, body.type)
    return {
        "ok": True,
        "media_url": public_url,
        "media_type": "image",
        "stored_name": stored_name,
        "filename": f"payment_qr_{body.amount}.jpg",
        "caption": caption,
        "upi_url": upi_url,
        "account": account,
        "amount": body.amount,
        "type": body.type,
    }


# ------------- Inbox / Conversations / Quick Replies -------------
class QuickReplyInput(BaseModel):
    title: str
    text: Optional[str] = ""
    # Optional media attachment — an admin-pre-approved image / video / document
    # that can be sent as part of the canned reply (within the 24-hour window).
    media_url: Optional[str] = None
    media_type: Optional[str] = None  # 'image' | 'video' | 'document' | 'audio'
    media_filename: Optional[str] = None
    caption: Optional[str] = None  # used when media has a caption distinct from `text`

class StartChatInput(BaseModel):
    phone: str
    customer_name: Optional[str] = None
    requirement: Optional[str] = None
    assigned_to: Optional[str] = None  # admin can pre-assign, else current user

class TransferRequestInput(BaseModel):
    lead_id: str
    reason: Optional[str] = ""

@api.get("/inbox/conversations")
async def list_conversations(
    user: dict = Depends(get_current_user),
    q: Optional[str] = None,
    only_unread: bool = False,
    only_unreplied: bool = False,
    only_replied: bool = False,
    status: Optional[str] = None,
    assigned_to: Optional[str] = None,
    include_all: bool = False,
    limit: int = 50,
    offset: int = 0,
    starred: Optional[bool] = None,
):
    """Returns a list of leads optimized for the chat inbox: each row carries last_msg preview,
    unread count, last_user_message_at and within_24h flag.
    Default filters to WhatsApp-active leads (`has_whatsapp=true` OR has at least one message).
    Pass `include_all=true` to bypass the WA filter (admin debugging).
    Pagination: `limit` (default 50) + `offset` for infinite-scroll. Each batch is sorted
    by last_action_at DESC so newest activity bubbles to the top — pagination is stable
    within a single client session as long as the underlying messages don't reshuffle.
    Filters (only_unread/unreplied/replied/has_whatsapp) are applied AFTER paging the
    leads collection — so the returned page may contain fewer than `limit` rows when
    filters drop ineligible leads. Frontend should keep paging until the response is
    empty or noticeably short."""
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    query: Dict[str, Any] = {}
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Access denied")
    elif user["role"] == "executive":
        query["assigned_to"] = user["id"]
    elif assigned_to:
        query["assigned_to"] = assigned_to
    if status:
        query["status"] = status
    if starred:
        query["starred"] = True
    if not include_all:
        query["has_whatsapp"] = True
    q_clean = q.strip() if q else None
    if q_clean:
        import re as _re
        q_safe = _re.escape(q_clean)
        ors: List[Dict[str, Any]] = [
            {"customer_name": {"$regex": q_safe, "$options": "i"}},
            {"aliases": {"$regex": q_safe, "$options": "i"}},
            {"requirement": {"$regex": q_safe, "$options": "i"}},
        ]
        phone_pat = phone_match_pattern(q_clean)
        if phone_pat:
            ors.append({"phone": {"$regex": phone_pat}})
            ors.append({"phones": {"$regex": phone_pat}})
        else:
            ors.append({"phone": {"$regex": q_safe, "$options": "i"}})
            ors.append({"phones": {"$regex": q_safe, "$options": "i"}})
        query["$or"] = ors
    
    # Retrieve WhatsApp-active leads sorted strictly by latest message timestamp
    lead_pipeline: List[Dict[str, Any]] = [
        {"$match": query},
        {
            "$addFields": {
                "sort_time": {
                    "$ifNull": [
                        "$last_message_at",
                        {"$ifNull": ["$last_action_at", "$created_at"]}
                    ]
                }
            }
        },
        {"$sort": {"sort_time": -1}},
    ]
    # Pre-filter "replied" leads (those with at least one inbound message) BEFORE
    # pagination so the $skip/$limit window is filled entirely with matching leads
    if only_replied:
        lead_pipeline.append({
            "$lookup": {
                "from": "messages",
                "let": {"lead_id": "$id"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$lead_id", "$$lead_id"]},
                        {"$eq": ["$direction", "in"]},
                    ]}}},
                    {"$limit": 1},
                    {"$project": {"_id": 1}},
                ],
                "as": "_has_inbound"
            }
        })
        lead_pipeline.append({
            "$match": {"_has_inbound.0": {"$exists": True}}
        })

    # Pre-filter "unread" leads BEFORE pagination
    if only_unread:
        lead_pipeline.append({
            "$lookup": {
                "from": "messages",
                "let": {"lead_id": "$id"},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$lead_id", "$$lead_id"]},
                        {"$eq": ["$direction", "in"]},
                        {"$ne": ["$read_by_agent", True]},
                    ]}}},
                    {"$limit": 1},
                    {"$project": {"_id": 1}},
                ],
                "as": "_has_unread"
            }
        })
        lead_pipeline.append({
            "$match": {"_has_unread.0": {"$exists": True}}
        })

    # Pre-filter "unreplied" leads BEFORE pagination
    if only_unreplied:
        lead_pipeline.extend([
            {
                "$lookup": {
                    "from": "messages",
                    "let": {"lead_id": "$id"},
                    "pipeline": [
                        {"$match": {"$expr": {"$eq": ["$lead_id", "$$lead_id"]}}},
                        {"$sort": {"at": -1}},
                        {"$limit": 1}
                    ],
                    "as": "latest_msg"
                }
            },
            {
                "$addFields": {
                    "last_msg": {"$arrayElemAt": ["$latest_msg", 0]}
                }
            },
            {
                "$match": {
                    "last_msg": {"$ne": None},
                    "last_msg.direction": "in"
                }
            }
        ])
    lead_pipeline.extend([
        {"$skip": offset},
        {"$limit": limit},
        {"$project": {"_id": 0, "raw_email_html": 0, "raw_email_text": 0, "latest_msg": 0, "last_msg": 0, "_has_inbound": 0, "_has_unread": 0, "sort_time": 0}}
    ])
    leads = await db.leads.aggregate(lead_pipeline).to_list(limit)
    if not leads:
        return []
    lead_ids = [ld["id"] for ld in leads]
    # Aggregate last message + unread count per lead in one pass
    pipeline = [
        {"$match": {"lead_id": {"$in": lead_ids}}},
        {"$sort": {"at": -1}},
        {"$group": {
            "_id": "$lead_id",
            "last": {"$first": "$$ROOT"},
            "unread": {"$sum": {"$cond": [
                {"$and": [
                    {"$eq": ["$direction", "in"]},
                    {"$ne": ["$read_by_agent", True]},
                ]}, 1, 0]}},
            "last_in_at": {"$max": {"$cond": [{"$eq": ["$direction", "in"]}, "$at", None]}},
            "last_out_at": {"$max": {"$cond": [{"$eq": ["$direction", "out"]}, "$at", None]}},
        }},
    ]
    msg_map: Dict[str, dict] = {}
    async for doc in db.messages.aggregate(pipeline):
        msg_map[doc["_id"]] = doc
    # Aggregate internal Q&A status per lead for the current user.
    # Executives only see their own threads. Admins see all threads.
    iqa_match: Dict[str, Any] = {"lead_id": {"$in": lead_ids}}
    if user["role"] == "executive":
        iqa_match["agent_id"] = user["id"]
    iqa_pipeline = [
        {"$match": iqa_match},
        {"$sort": {"at": 1}},
        {"$group": {
            "_id": {"lead_id": "$lead_id", "agent_id": "$agent_id"},
            "last_role": {"$last": "$from_role"},
            "last_at": {"$max": "$at"},
        }},
    ]
    # Roll up per lead: pending wins over answered (one question outstanding → show pending)
    iqa_map: Dict[str, str] = {}
    async for doc in db.internal_messages.aggregate(iqa_pipeline):
        lid = doc["_id"]["lead_id"]
        this_status = "pending" if doc.get("last_role") == "executive" else "answered"
        cur = iqa_map.get(lid)
        if cur == "pending":
            continue
        if this_status == "pending" or not cur:
            iqa_map[lid] = this_status
    now = now_utc()
    out: List[dict] = []
    for ld in leads:
        m = msg_map.get(ld["id"]) or {}
        last = m.get("last") or {}
        last_in_at = m.get("last_in_at")
        last_out_at = m.get("last_out_at")
        within_24h = False
        if last_in_at:
            try:
                last_in_dt = datetime.fromisoformat((last_in_at).replace("Z", "+00:00"))
                if last_in_dt.tzinfo is None:
                    last_in_dt = last_in_dt.replace(tzinfo=timezone.utc)
                within_24h = (now - last_in_dt) < timedelta(hours=24)
            except Exception:
                pass
        # unreplied = last message is inbound and we never sent after it
        last_dir = last.get("direction")
        unreplied = last_dir == "in"
        if only_unread and (m.get("unread") or 0) == 0:
            continue
        if only_unreplied and not unreplied:
            continue
        # only_replied: customer has ever sent us at least one inbound message
        if only_replied and not last_in_at:
            continue
        # Only show WhatsApp-active leads (has_whatsapp=true OR at least one message exchanged)
        is_wa_active = bool(ld.get("has_whatsapp")) or bool(last)
        if not include_all and not is_wa_active:
            continue
        out.append({
            **{k: ld.get(k) for k in [
                "id", "customer_name", "phone", "phones", "email", "requirement",
                "area", "city", "state", "source", "source_data", "status",
                "assigned_to", "contact_link", "created_at", "opened_at", "last_action_at",
                "has_whatsapp", "notes", "starred",
            ]},
            "last_message": {
                "body": last.get("body"),
                "direction": last.get("direction"),
                "at": last.get("at"),
                "status": last.get("status"),
                "msg_type": last.get("msg_type"),
                "template_name": last.get("template_name"),
            } if last else None,
            "unread": m.get("unread") or 0,
            "last_in_at": last_in_at,
            "last_out_at": last_out_at,
            "within_24h": within_24h,
            "unreplied": unreplied,
            "internal_qa_status": iqa_map.get(ld["id"], "none"),
        })
    return out


@api.get("/inbox/search-messages")
async def search_messages(
    q: str,
    user: dict = Depends(get_current_user),
    limit: int = 50,
    offset: int = 0,
):
    """Global cross-conversation message search (WhatsApp 'Search by messages').
    Returns flat hits: each row carries the matching message body + a leading
    snippet around the matched substring + the lead identity, so the frontend
    can render a results list and click-to-jump to that exact bubble."""
    qq = (q or "").strip()
    if not qq:
        return {"items": [], "total": 0, "limit": limit, "offset": offset}
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    import re as _re
    rx = _re.compile(_re.escape(qq), _re.IGNORECASE)

    # 1. Find leads whose name, aliases, or phone match qq
    # We do a targeted MongoDB search rather than loading 20,000 leads in memory!
    match_query: Dict[str, Any] = {
        "$or": [
            {"customer_name": {"$regex": _re.escape(qq), "$options": "i"}},
            {"aliases": {"$regex": _re.escape(qq), "$options": "i"}},
        ]
    }
    phone_pat = phone_match_pattern(qq)
    if phone_pat:
        match_query["$or"].append({"phone": {"$regex": phone_pat}})
        match_query["$or"].append({"phones": {"$regex": phone_pat}})
    else:
        match_query["$or"].append({"phone": {"$regex": _re.escape(qq), "$options": "i"}})
        match_query["$or"].append({"phones": {"$regex": _re.escape(qq), "$options": "i"}})

    if user["role"] == "executive":
        match_query["assigned_to"] = user["id"]

    matched_leads = await db.leads.find(match_query, {
        "id": 1, "customer_name": 1, "aliases": 1, "phone": 1, "phones": 1, "assigned_to": 1
    }).to_list(1000)
    matched_lead_ids = [ld["id"] for ld in matched_leads]

    # 2. Build the lead index of matched leads
    lead_index: Dict[str, Dict[str, Any]] = {ld["id"]: ld for ld in matched_leads}

    # Build the query for messages
    msg_query: Dict[str, Any] = {}
    
    # We restrict search based on executive's assigned leads
    if user["role"] == "executive":
        # Get executive's assigned leads
        assigned_leads = await db.leads.find({"assigned_to": user["id"]}, {"id": 1}).to_list(10000)
        assigned_lead_ids = [ld["id"] for ld in assigned_leads]
        if not assigned_lead_ids:
            return {"items": [], "total": 0, "limit": limit, "offset": offset}
        
        msg_query = {
            "$or": [
                {
                    "lead_id": {"$in": assigned_lead_ids},
                    "$or": [
                        {"body": {"$regex": _re.escape(qq), "$options": "i"}},
                        {"caption": {"$regex": _re.escape(qq), "$options": "i"}},
                    ]
                }
            ]
        }
        if matched_lead_ids:
            msg_query["$or"].append({"lead_id": {"$in": matched_lead_ids}})
    else:
        # Admin: search all messages globally matching regex, OR messages belonging to matched leads
        msg_query = {
            "$or": [
                {"body": {"$regex": _re.escape(qq), "$options": "i"}},
                {"caption": {"$regex": _re.escape(qq), "$options": "i"}},
            ]
        }
        if matched_lead_ids:
            msg_query["$or"].append({"lead_id": {"$in": matched_lead_ids}})

    total = await db.messages.count_documents(msg_query)
    cursor = db.messages.find(msg_query, {
        "_id": 0, "id": 1, "lead_id": 1, "direction": 1, "body": 1, "caption": 1,
        "msg_type": 1, "at": 1, "media_url": 1,
    }).sort("at", -1).skip(offset).limit(limit)

    items = []
    fetched_messages = await cursor.to_list(limit)
    if fetched_messages:
        # Find any lead_ids from messages that are not yet in lead_index
        missing_lead_ids = list({m["lead_id"] for m in fetched_messages if m.get("lead_id") and m["lead_id"] not in lead_index})
        if missing_lead_ids:
            missing_leads = await db.leads.find({"id": {"$in": missing_lead_ids}}, {
                "id": 1, "customer_name": 1, "aliases": 1, "phone": 1, "phones": 1, "assigned_to": 1
            }).to_list(len(missing_lead_ids))
            for ld in missing_leads:
                lead_index[ld["id"]] = ld

        for m in fetched_messages:
            ld = lead_index.get(m.get("lead_id")) or {}
            text = (m.get("body") or "") or (m.get("caption") or "")
            # Build a 120-char snippet centered on the match
            snippet = text
            match = rx.search(text)
            if match and len(text) > 120:
                start = max(0, match.start() - 40)
                end = min(len(text), match.end() + 80)
                snippet = ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")
            items.append({
                "message_id": m.get("id"),
                "lead_id": m.get("lead_id"),
                "lead_name": ld.get("customer_name"),
                "lead_phone": ld.get("phone"),
                "lead_assigned_to": ld.get("assigned_to"),
                "direction": m.get("direction"),
                "msg_type": m.get("msg_type"),
                "body": text,
                "snippet": snippet,
                "at": m.get("at"),
                "has_media": bool(m.get("media_url")),
            })
            
    return {"items": items, "total": total, "limit": limit, "offset": offset, "q": qq}


@api.get("/inbox/conversations/{lead_id}")
async def get_one_conversation(lead_id: str, user: dict = Depends(get_current_user)):
    """Fetch a single conversation row — used by the chat UI when the user
    deep-links / clicks a search hit and the lead isn't in the current paginated
    page. RBAC matches the list endpoint."""
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    last = await db.messages.find_one({"lead_id": lead_id}, {"_id": 0}, sort=[("at", -1)])
    unread = await db.messages.count_documents({"lead_id": lead_id, "direction": "in", "read": {"$ne": True}})
    last_in_at = None
    last_out_at = None
    last_in = await db.messages.find_one({"lead_id": lead_id, "direction": "in"}, {"_id": 0, "at": 1}, sort=[("at", -1)])
    last_out = await db.messages.find_one({"lead_id": lead_id, "direction": "out"}, {"_id": 0, "at": 1}, sort=[("at", -1)])
    if last_in:
        last_in_at = last_in.get("at")
    if last_out:
        last_out_at = last_out.get("at")
    within_24h = False
    if last_in_at:
        try:
            d = datetime.fromisoformat(last_in_at.replace("Z", "+00:00"))
            within_24h = (now_utc() - d) < timedelta(hours=24)
        except Exception:
            pass
    unreplied = bool(last_in_at and (not last_out_at or last_in_at > last_out_at))
    iqa = await db.internal_messages.find_one({"lead_id": lead_id}, {"_id": 0, "qa_status": 1}, sort=[("at", -1)])
    return {
        **{k: lead.get(k) for k in [
            "id", "customer_name", "phone", "phones", "email", "requirement",
            "area", "city", "state", "source", "source_data", "status",
            "assigned_to", "contact_link", "created_at", "opened_at", "last_action_at",
            "has_whatsapp", "notes", "starred",
        ]},
        "last_message": {
            "body": last.get("body"),
            "direction": last.get("direction"),
            "at": last.get("at"),
            "status": last.get("status"),
            "msg_type": last.get("msg_type"),
            "template_name": last.get("template_name"),
        } if last else None,
        "unread": unread,
        "last_in_at": last_in_at,
        "last_out_at": last_out_at,
        "within_24h": within_24h,
        "unreplied": unreplied,
        "internal_qa_status": (iqa or {}).get("qa_status", "none"),
    }


@api.post("/inbox/leads/{lead_id}/mark-read")
async def mark_thread_read(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    res = await db.messages.update_many(
        {"lead_id": lead_id, "direction": "in", "read_by_agent": {"$ne": True}},
        {"$set": {"read_by_agent": True, "read_by_agent_at": iso(now_utc())}},
    )
    return {"ok": True, "marked": res.modified_count}


@api.post("/inbox/start-chat")
async def start_chat(body: StartChatInput, user: dict = Depends(get_current_user)):
    phone = normalize_phone_display((body.phone or "").strip())
    if not phone:
        raise HTTPException(status_code=400, detail="Phone is required")
    digits = _normalize_phone(phone)
    if len(digits) < 10:
        raise HTTPException(status_code=400, detail="Phone must contain at least 10 digits")
    suffix = digits[-10:]
    existing = await _find_lead_by_phone(phone)
    if existing:
        # Same exec or admin → return so caller can open it
        if user["role"] == "admin" or existing.get("assigned_to") == user["id"] or not existing.get("assigned_to"):
            return existing
        owner = await db.users.find_one({"id": existing.get("assigned_to")}, {"_id": 0, "name": 1, "username": 1}) or {}
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_phone",
                "message": "This lead is already assigned to another executive.",
                "existing_lead_id": existing["id"],
                "owned_by_id": existing.get("assigned_to"),
                "owned_by_name": owner.get("name"),
                "owned_by_username": owner.get("username"),
            },
        )
    target_assignee = body.assigned_to if (user["role"] == "admin" and body.assigned_to) else (
        body.assigned_to if user["role"] == "admin" else user["id"]
    )
    data = {
        "customer_name": (body.customer_name or "").strip() or phone,
        "phone": phone,
        "requirement": body.requirement or "",
        "source": "Manual",
        "dedup_hash": _lead_dedup_hash(body.customer_name or "manual", iso(now_utc()), suffix),
        "assigned_to": target_assignee,
        "has_whatsapp": True,
    }
    lead = await _create_lead_internal(data, by_user_id=user["id"])
    return lead


@api.post("/inbox/transfer-request")
async def transfer_request(body: TransferRequestInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    doc = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "from_user_id": user["id"],
        "from_user_name": user["name"],
        "current_assignee_id": lead.get("assigned_to"),
        "reason": body.reason or "",
        "status": "pending",  # pending | approved | rejected
        "created_at": iso(now_utc()),
    }
    await db.transfer_requests.insert_one(doc.copy())
    await log_activity(user["id"], "transfer_requested", body.lead_id, {"reason": body.reason})
    return strip_mongo(doc)


@api.get("/inbox/transfer-requests")
async def list_transfer_requests(user: dict = Depends(get_current_user), status: str = "pending"):
    query: Dict[str, Any] = {"status": status}
    if user["role"] == "executive":
        query["from_user_id"] = user["id"]
    docs = await db.transfer_requests.find(query, {"_id": 0}).sort("created_at", -1).to_list(200)
    return docs


@api.post("/inbox/transfer-requests/{req_id}/approve")
async def approve_transfer(req_id: str, admin: dict = Depends(require_admin)):
    req = await db.transfer_requests.find_one({"id": req_id}, {"_id": 0})
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req["status"] != "pending":
        raise HTTPException(status_code=400, detail="Already processed")
    await assign_lead(req["lead_id"], target_user_id=req["from_user_id"], by_user_id=admin["id"])
    await db.transfer_requests.update_one(
        {"id": req_id},
        {"$set": {"status": "approved", "decided_at": iso(now_utc()), "decided_by": admin["id"]}},
    )
    return {"ok": True}


@api.post("/inbox/transfer-requests/{req_id}/reject")
async def reject_transfer(req_id: str, admin: dict = Depends(require_admin)):
    await db.transfer_requests.update_one(
        {"id": req_id},
        {"$set": {"status": "rejected", "decided_at": iso(now_utc()), "decided_by": admin["id"]}},
    )
    return {"ok": True}


# Quick Replies
@api.get("/quick-replies")
async def list_quick_replies(user: dict = Depends(get_current_user)):
    # Sort by admin-defined sort_order asc (NULLS last via fallback to a high
    # default), then by title for stable ordering of unordered legacy rows.
    items = await db.quick_replies.find({}, {"_id": 0}).to_list(500)
    items.sort(key=lambda q: (q.get("sort_order") if isinstance(q.get("sort_order"), (int, float)) else 99999, (q.get("title") or "").lower()))
    return items


@api.post("/quick-replies")
async def create_quick_reply(body: QuickReplyInput, admin: dict = Depends(require_admin)):
    if body.media_url and body.media_type not in ("image", "video", "document", "audio"):
        raise HTTPException(status_code=400, detail="media_type must be image|video|document|audio when media_url is set")
    # Append new replies at the end of the order so admin sees them last —
    # they can drag/sort up later if needed.
    last = await db.quick_replies.find({}, {"_id": 0, "sort_order": 1}).sort("sort_order", -1).limit(1).to_list(1)
    next_order = (int(last[0].get("sort_order")) + 1) if (last and isinstance(last[0].get("sort_order"), (int, float))) else 1
    doc = {
        "id": str(uuid.uuid4()),
        "title": body.title.strip(),
        "text": (body.text or "").strip(),
        "media_url": body.media_url or None,
        "media_type": body.media_type or None,
        "media_filename": body.media_filename or None,
        "caption": (body.caption or "").strip() or None,
        "sort_order": next_order,
        "created_by": admin["id"],
        "created_at": iso(now_utc()),
    }
    await db.quick_replies.insert_one(doc.copy())
    return strip_mongo(doc)


@api.put("/quick-replies/{qr_id}")
async def update_quick_reply(qr_id: str, body: QuickReplyInput, admin: dict = Depends(require_admin)):
    if body.media_url and body.media_type not in ("image", "video", "document", "audio"):
        raise HTTPException(status_code=400, detail="media_type must be image|video|document|audio when media_url is set")
    res = await db.quick_replies.update_one(
        {"id": qr_id},
        {"$set": {
            "title": body.title.strip(),
            "text": (body.text or "").strip(),
            "media_url": body.media_url or None,
            "media_type": body.media_type or None,
            "media_filename": body.media_filename or None,
            "caption": (body.caption or "").strip() or None,
            "updated_at": iso(now_utc()),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Quick reply not found")
    return await db.quick_replies.find_one({"id": qr_id}, {"_id": 0})


class QuickReplyReorderInput(BaseModel):
    ids: List[str]


@api.post("/quick-replies/reorder")
async def reorder_quick_replies(body: QuickReplyReorderInput, admin: dict = Depends(require_admin)):
    """Persist the canonical display order. The list of ids is taken as the
    desired order — index becomes the row's sort_order. Any QR not present in
    the list keeps its previous sort_order (admin can re-drag later)."""
    for idx, qr_id in enumerate(body.ids):
        await db.quick_replies.update_one(
            {"id": qr_id},
            {"$set": {"sort_order": idx + 1, "updated_at": iso(now_utc())}},
        )
    return {"ok": True, "count": len(body.ids)}


@api.delete("/quick-replies/{qr_id}")
async def delete_quick_reply(qr_id: str, admin: dict = Depends(require_admin)):
    await db.quick_replies.delete_one({"id": qr_id})
    return {"ok": True}


# Webhook URLs panel (admin)
async def _get_exportersindia_api_key() -> Optional[str]:
    """Return the configured ExportersIndia API key (or None if unset)."""
    doc = await db.system_settings.find_one({"key": "exportersindia"}, {"_id": 0}) or {}
    val = (doc.get("api_key") or os.environ.get("EXPORTERSINDIA_API_KEY") or "").strip()
    return val or None


DEFAULT_EI_PULL_URL = "https://members.exportersindia.com/api-inquiry-detail.php"
DEFAULT_EI_INTERVAL = 60  # seconds


async def _get_exportersindia_pull_cfg() -> Dict[str, Any]:
    """Current pull-API config: api_key, email, interval_seconds, enabled, pull_url,
    last_pulled_at (last attempt), last_success_at (last successful run)."""
    doc = await db.system_settings.find_one({"key": "exportersindia_pull"}, {"_id": 0}) or {}
    return {
        "api_key": (doc.get("api_key") or "").strip(),
        "email": (doc.get("email") or "").strip(),
        "pull_url": (doc.get("pull_url") or DEFAULT_EI_PULL_URL).strip(),
        "interval_seconds": int(doc.get("interval_seconds") or DEFAULT_EI_INTERVAL),
        "enabled": bool(doc.get("enabled", False)),
        "last_pulled_at": doc.get("last_pulled_at"),
        "last_success_at": doc.get("last_success_at"),
        "last_error": doc.get("last_error"),
        "last_created_count": doc.get("last_created_count"),
        "last_date_from": doc.get("last_date_from"),
    }


async def _pull_exportersindia_once(force_date_from: Optional[str] = None) -> Dict[str, Any]:
    """Run a single pull of ExportersIndia enquiries. Uses `last_success_at` (or today)
    as `date_from` so we don't re-download old leads each tick. Dedup by inq_id / phone
    is already handled downstream by `_handle_exportersindia_payload`."""
    cfg = await _get_exportersindia_pull_cfg()
    api_key = cfg["api_key"]
    email = cfg["email"]
    pull_url = cfg["pull_url"]
    if not api_key or not email:
        return {"skipped": True, "reason": "api_key or email not configured"}
    # Choose date_from — prefer explicit override, else last successful pull date,
    # else today (UTC, YYYY-MM-DD).
    if force_date_from:
        date_from = force_date_from
    elif cfg.get("last_success_at"):
        try:
            dt = datetime.fromisoformat(cfg["last_success_at"].replace("Z", "+00:00"))
            # Step back 1 day to catch late-arriving enquiries; dedup will drop repeats.
            date_from = (dt - timedelta(days=1)).strftime("%Y-%m-%d")
        except Exception:
            date_from = now_utc().strftime("%Y-%m-%d")
    else:
        date_from = now_utc().strftime("%Y-%m-%d")

    params = {"k": api_key, "email": email, "date_from": date_from}
    started_at = iso(now_utc())
    try:
        async with httpx.AsyncClient(timeout=30) as client_http:
            r = await client_http.get(pull_url, params=params)
        if r.status_code >= 400:
            err = f"HTTP {r.status_code}: {r.text[:300]}"
            await db.system_settings.update_one(
                {"key": "exportersindia_pull"},
                {"$set": {"last_pulled_at": started_at, "last_error": err, "last_date_from": date_from, "key": "exportersindia_pull"}},
                upsert=True,
            )
            return {"ok": False, "error": err, "date_from": date_from}
        try:
            payload = r.json()
        except Exception:
            payload = {"raw": r.text}
    except Exception as e:
        err = str(e)
        await db.system_settings.update_one(
            {"key": "exportersindia_pull"},
            {"$set": {"last_pulled_at": started_at, "last_error": err, "last_date_from": date_from, "key": "exportersindia_pull"}},
            upsert=True,
        )
        return {"ok": False, "error": err, "date_from": date_from}

    # Ingest via the same parser as the push path
    result = await _handle_exportersindia_payload(payload, identifier="pull")
    finished_at = iso(now_utc())
    await db.system_settings.update_one(
        {"key": "exportersindia_pull"},
        {"$set": {
            "key": "exportersindia_pull",
            "last_pulled_at": started_at,
            "last_success_at": finished_at,
            "last_error": None,
            "last_created_count": len(result.get("created") or []),
            "last_date_from": date_from,
        }},
        upsert=True,
    )
    return {"ok": True, "date_from": date_from, **result}


async def _acquire_ei_lock() -> bool:
    now = datetime.now(timezone.utc)
    # Gunicorn worker lock: Only let one worker run the pull task in this interval
    res = await db.system_settings.find_one_and_update(
        {
            "key": "exportersindia_pull",
            "$or": [
                {"lock_acquired_at": None},
                {"lock_acquired_at": {"$lt": now - timedelta(minutes=4)}}
            ]
        },
        {"$set": {"lock_acquired_at": now}},
        return_document=True
    )
    return bool(res)

async def _release_ei_lock():
    await db.system_settings.update_one(
        {"key": "exportersindia_pull"},
        {"$set": {"lock_acquired_at": None}}
    )


async def exportersindia_pull_task():
    """APScheduler tick. Reads current config (so admins can enable/change interval at
    runtime without restart); reschedules itself when interval changes."""
    try:
        cfg = await _get_exportersindia_pull_cfg()
        if not cfg["enabled"]:
            return
        if not cfg["api_key"] or not cfg["email"]:
            return
        
        if not await _acquire_ei_lock():
            logger.info("ExportersIndia pull task: Lock already held by another worker - skipping")
            return
            
        try:
            res = await _pull_exportersindia_once()
            if not res.get("ok"):
                logger.warning(f"EI pull failed: {res.get('error')}")
            else:
                logger.info(f"EI pull ok date_from={res.get('date_from')} created={len(res.get('created') or [])}")
        finally:
            await _release_ei_lock()
    except Exception as e:
        logger.exception(f"EI pull task crashed: {e}")



async def _reschedule_exportersindia_pull(new_interval_seconds: int):
    """Update the scheduler job in place so interval changes are applied live."""
    global scheduler
    if not scheduler:
        return
    try:
        scheduler.remove_job("exportersindia_pull")
    except Exception:
        pass
    scheduler.add_job(
        exportersindia_pull_task, "interval",
        seconds=max(10, int(new_interval_seconds or DEFAULT_EI_INTERVAL)),
        id="exportersindia_pull", max_instances=1, coalesce=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=5),
    )


class ExportersIndiaPullInput(BaseModel):
    api_key: Optional[str] = None
    email: Optional[str] = None
    pull_url: Optional[str] = None
    interval_minutes: Optional[int] = None  # convenience input from UI
    interval_seconds: Optional[int] = None  # residual seconds component
    enabled: Optional[bool] = None


@api.get("/settings/exportersindia-pull")
async def get_exportersindia_pull(admin: dict = Depends(require_admin)):
    cfg = await _get_exportersindia_pull_cfg()
    total = cfg["interval_seconds"]
    return {
        "api_key_masked": _mask_token(cfg["api_key"]) if cfg["api_key"] else "",
        "has_key": bool(cfg["api_key"]),
        "email": cfg["email"],
        "pull_url": cfg["pull_url"],
        "interval_seconds_total": total,
        "interval_minutes": total // 60,
        "interval_seconds": total % 60,
        "enabled": cfg["enabled"],
        "last_pulled_at": cfg["last_pulled_at"],
        "last_success_at": cfg["last_success_at"],
        "last_error": cfg["last_error"],
        "last_created_count": cfg["last_created_count"],
        "last_date_from": cfg["last_date_from"],
        "defaults": {"pull_url": DEFAULT_EI_PULL_URL, "interval_seconds": DEFAULT_EI_INTERVAL},
    }


@api.put("/settings/exportersindia-pull")
async def update_exportersindia_pull(body: ExportersIndiaPullInput, admin: dict = Depends(require_admin)):
    updates: Dict[str, Any] = {"key": "exportersindia_pull", "updated_by": admin["id"], "updated_at": iso(now_utc())}
    unsets: Dict[str, str] = {}
    if body.api_key is not None:
        if body.api_key.strip():
            updates["api_key"] = body.api_key.strip()
        else:
            unsets["api_key"] = ""
    if body.email is not None:
        updates["email"] = body.email.strip()
    if body.pull_url is not None:
        updates["pull_url"] = (body.pull_url.strip() or DEFAULT_EI_PULL_URL)
    # Interval: combine minutes + residual seconds. Minimum 10s to avoid hammering the API.
    if body.interval_minutes is not None or body.interval_seconds is not None:
        mins = max(0, int(body.interval_minutes or 0))
        secs = max(0, int(body.interval_seconds or 0))
        total = mins * 60 + secs
        if total < 10:
            raise HTTPException(status_code=400, detail="Minimum interval is 10 seconds")
        updates["interval_seconds"] = total
    if body.enabled is not None:
        updates["enabled"] = bool(body.enabled)
    op: Dict[str, Any] = {"$set": updates}
    if unsets:
        op["$unset"] = unsets
    await db.system_settings.update_one({"key": "exportersindia_pull"}, op, upsert=True)
    await log_activity(admin["id"], "exportersindia_pull_updated", None, {k: (v if k != "api_key" else "***") for k, v in updates.items()})

    # Reschedule the job so interval/enabled changes take effect immediately
    cfg = await _get_exportersindia_pull_cfg()
    if cfg["enabled"]:
        await _reschedule_exportersindia_pull(cfg["interval_seconds"])
    else:
        global scheduler
        if scheduler:
            try:
                scheduler.remove_job("exportersindia_pull")
            except Exception:
                pass

    return await get_exportersindia_pull(admin)


@api.post("/settings/exportersindia-pull/run-now")
async def run_exportersindia_pull_now(admin: dict = Depends(require_admin), date_from: Optional[str] = Query(None)):
    """Manual trigger for an immediate pull (for admins to backfill or test)."""
    cfg = await _get_exportersindia_pull_cfg()
    if not cfg["api_key"] or not cfg["email"]:
        raise HTTPException(status_code=400, detail="api_key and email must be configured before running a pull")
    return await _pull_exportersindia_once(force_date_from=date_from)


class ExportersIndiaSettingsInput(BaseModel):
    api_key: Optional[str] = None  # empty string clears


@api.get("/settings/exportersindia")
async def get_exportersindia_settings(request: Request, admin: dict = Depends(require_admin)):
    """Admin-only: show the masked ExportersIndia API key and the full integration URL to paste."""
    key = await _get_exportersindia_api_key()
    base = (os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if not base:
        fwd_proto = request.headers.get("x-forwarded-proto")
        fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        base = f"{fwd_proto or request.url.scheme}://{fwd_host}" if fwd_host else str(request.base_url).rstrip("/")
    webhook_url = f"{base}/api/webhooks/exportersindia"
    full_url = f"{webhook_url}?key={key}" if key else webhook_url
    return {
        "api_key_masked": _mask_token(key or ""),
        "has_key": bool(key),
        "webhook_url": webhook_url,
        "full_integration_url": full_url,
    }


@api.put("/settings/exportersindia")
async def update_exportersindia_settings(body: ExportersIndiaSettingsInput, request: Request, admin: dict = Depends(require_admin)):
    """Admin-only: set or clear the ExportersIndia API key (empty string clears)."""
    val = (body.api_key or "").strip()
    if val:
        await db.system_settings.update_one(
            {"key": "exportersindia"},
            {"$set": {"key": "exportersindia", "api_key": val, "updated_by": admin["id"], "updated_at": iso(now_utc())}},
            upsert=True,
        )
    else:
        await db.system_settings.update_one(
            {"key": "exportersindia"},
            {"$unset": {"api_key": ""}, "$set": {"updated_by": admin["id"], "updated_at": iso(now_utc()), "key": "exportersindia"}},
            upsert=True,
        )
    await log_activity(admin["id"], "exportersindia_settings_updated", None, {"cleared": not val})
    return await get_exportersindia_settings(request, admin)


@api.get("/settings/webhooks-info")
async def webhooks_info(admin: dict = Depends(require_admin)):
    base = (FRONTEND_BASE_URL or os.environ.get("FRONTEND_BASE_URL") or "").rstrip("/")
    cfg = await get_wa_config()
    ei_key = await _get_exportersindia_api_key()
    ei_url = f"{base}/api/webhooks/exportersindia"
    ei_full_url = f"{ei_url}?key={ei_key}" if ei_key else ei_url
    return {
        "indiamart": {
            "label": "IndiaMART Push API",
            "url": f"{base}/api/webhooks/indiamart",
            "method": "POST",
            "where_to_paste": "IndiaMART Lead Manager → Push API → Webhook URL",
            "auth": "none (public endpoint)",
        },
        "shopify": {
            "label": "Shopify (citspray.com) Orders",
            "url": f"{base}/api/webhooks/shopify",
            "method": "POST",
            "where_to_paste": "Shopify Admin → Settings → Notifications → Webhooks → Create webhook (topics: Order creation + Fulfillment creation, format JSON)",
            "auth": "HMAC via SHOPIFY_WEBHOOK_SECRET env (Shopify shows the signing secret under the webhook list)",
            "topics": ["orders/create", "fulfillments/create"],
            "secret_configured": bool(SHOPIFY_WEBHOOK_SECRET),
        },
        "exportersindia": {
            "label": "ExportersIndia Webhook",
            "url": ei_url,
            "full_integration_url": ei_full_url,
            "method": "POST",
            "where_to_paste": "ExportersIndia Dashboard → Integrations → Webhook URL (paste the full URL above, including ?key=…)",
            "auth": "API key via `?key=…` query param (configure in Settings → Integrations → ExportersIndia)",
            "has_key": bool(ei_key),
            "sample_payload": {
                "inq_id": "84138043", "supplier_id": "7412131", "inq_type": "direct",
                "product": "500ml Avc Liquid Detergent", "subject": "Daily Shine Liquid Detergent",
                "detail_req": "I am interested in buying…", "mobile": "9876543xxx",
                "email": "buyer@example.com", "name": "Test Buyer", "company": "Weblink",
                "address": "Kirtinagar, Delhi", "country": "India", "state": "Delhi", "city": "Delhi",
                "enq_date": "2025-11-17 16:47:38",
            },
        },
        "whatsapp": {
            "label": "WhatsApp Cloud API",
            "url": f"{base}/api/webhooks/whatsapp",
            "method": "POST",
            "verify_token": cfg["verify_token"],
            "where_to_paste": "Meta App Dashboard → WhatsApp → Configuration → Webhooks → Callback URL + Verify Token",
            "subscribe_fields": ["messages"],
        },
        "gmail": {
            "label": "Gmail OAuth callback",
            "url": GOOGLE_REDIRECT_URI or f"{base}/api/integrations/gmail/auth/callback",
            "method": "GET",
            "where_to_paste": "Google Cloud Console → APIs & Services → Credentials → OAuth client → Authorized redirect URIs",
        },
        "justdial_manual_ingest": {
            "label": "Justdial manual ingest (testing)",
            "url": f"{base}/api/ingest/justdial",
            "method": "POST",
            "where_to_paste": "Optional — direct POST endpoint for raw email payloads (Gmail OAuth poll is the primary path).",
        },
    }


# ------------- Justdial email parser -------------
JD_FIELD = {
    "area": re.compile(r"User\s*Area\s*:?\s*(.+)", re.IGNORECASE),
    "city": re.compile(r"User\s*City\s*:?\s*(.+)", re.IGNORECASE),
    "state": re.compile(r"User\s*State\s*:?\s*(.+)", re.IGNORECASE),
    "timestamp": re.compile(r"Search\s*Date\s*&?\s*Time\s*:?\s*(.+)", re.IGNORECASE),
    "phone": re.compile(r"(?:Mobile(?:\s*No)?|Phone|Contact)\s*:?\s*([+\d][\d\- ]{5,})", re.IGNORECASE),
}

_JD_FIELD_STOPPERS = re.compile(
    r"\s+(?=User\s+(?:Area|City|State)|Search\s+Date|View\s+Contact|Dear\s)",
    re.IGNORECASE,
)


def parse_justdial_email(raw_text: str, raw_html: str) -> dict:
    """Extract name / requirement / area / city / state / timestamp / phone / contact_link
    from a Justdial enquiry notification email. HTML-first, with text fallback."""
    out: Dict[str, Any] = {}
    soup = None
    if raw_html:
        try:
            soup = BeautifulSoup(raw_html, "html.parser")
        except Exception:
            soup = None

    # Build a clean newline-separated text from HTML so block boundaries survive
    text = (raw_text or "").strip()
    if soup:
        for tag in soup.find_all(["br", "tr", "p", "div", "li"]):
            tag.append("\n")
        html_text = soup.get_text("\n")
        html_text = re.sub(r"[ \t]+", " ", html_text)
        html_text = re.sub(r"\n+", "\n", html_text).strip()
        if not text or len(html_text) > len(text):
            text = html_text

    # 1. NAME — primary: <strong> tag whose text is followed shortly by "enquired for"
    if soup:
        try:
            flat = soup.get_text(" ")
            for s in soup.find_all("strong"):
                name = (s.get_text() or "").strip()
                if not name or len(name) > 40:
                    continue
                if re.search(r"\b(dear|mr|mrs|ms|owner|sir|madam|you|hi|hello)\b", name, re.IGNORECASE):
                    continue
                pos = flat.find(name)
                if pos >= 0 and re.search(r"enquired\s+for", flat[pos:pos + 120], re.IGNORECASE):
                    out["customer_name"] = name
                    break
        except Exception:
            pass

    # 2. REQUIREMENT — everything between "enquired for" and the next label/period/newline
    m = re.search(
        r"(?:enquired|inquired)\s+for\s+(?P<req>[^\n\r.]+?)(?=\s*(?:User\s+(?:Area|City|State)|Search\s+Date|View\s+Contact|Dear\s|\.\s|\n|$))",
        text,
        re.IGNORECASE,
    )
    if m:
        req = m.group("req").strip().rstrip(",.;").strip()
        out["requirement"] = req
        # Text-fallback NAME: the last simple word/s before "enquired"
        if "customer_name" not in out:
            before = text[:m.start()].rstrip()
            tokens = before.split()
            cand: List[str] = []
            for w in reversed(tokens):
                if w.startswith("(") or w.endswith(")"):
                    break
                if re.fullmatch(r"[A-Za-z][A-Za-z.'\-]*", w):
                    cand.insert(0, w)
                else:
                    break
                if len(cand) >= 2:
                    break
            if cand:
                out["customer_name"] = " ".join(cand[-1:])  # usually just the first name

    # 3. Structured fields — clip at next known label so we don't swallow neighbours
    for key, rx in JD_FIELD.items():
        m2 = rx.search(text)
        if m2:
            val = m2.group(1).strip()
            val = _JD_FIELD_STOPPERS.split(val, maxsplit=1)[0].strip()
            val = val.rstrip(".,;").strip()
            if val:
                out[key] = val

    # 4. Contact link
    if soup:
        try:
            contact_link = None
            for a in soup.find_all("a"):
                label = (a.get_text() or "").strip().lower()
                href = a.get("href") or ""
                if "view contact" in label or "contact details" in label:
                    contact_link = href
                    break
            if not contact_link:
                for a in soup.find_all("a"):
                    href = a.get("href") or ""
                    if "justdial.com" in href.lower():
                        contact_link = href
                        break
            if contact_link:
                out["contact_link"] = contact_link
        except Exception:
            pass

    return out

def _normalize_justdial_link(url: Optional[str]) -> Optional[str]:
    """Normalise a Justdial profile / contact link for dedup. We INTENTIONALLY
    preserve the query string because Justdial encodes the unique enquiry id
    inside `?id=…` / `?fl=…` — stripping them would falsely collapse every
    distinct enquiry into one lead. Only the host casing + fragment + trailing
    slash on the path get normalised."""
    if not url:
        return None
    try:
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(url.strip())
        scheme = (parts.scheme or "https").lower()
        host = (parts.netloc or "").lower()
        path = (parts.path or "").rstrip("/")
        query = parts.query or ""  # KEEP — uniquely identifies the enquiry
        norm = urlunsplit((scheme, host, path, query, ""))  # drop fragment
        return norm or None
    except Exception:
        return url.strip() or None


def _ensure_lead_enquiries(lead: dict) -> list:
    enquiries = lead.get("enquiries")
    if enquiries and isinstance(enquiries, list):
        return enquiries
    
    # Construct the initial enquiry from the lead's main fields
    initial_enquiry = {
        "id": lead.get("initial_enquiry_id") or str(uuid.uuid4()),
        "customer_name": lead.get("customer_name", "Unknown"),
        "phone": lead.get("phone"),
        "phones": lead.get("phones") or [],
        "email": lead.get("email"),
        "emails": lead.get("emails") or [],
        "requirement": lead.get("requirement"),
        "area": lead.get("area"),
        "city": lead.get("city"),
        "state": lead.get("state"),
        "country": lead.get("country"),
        "source": lead.get("source", "Manual"),
        "contact_link": lead.get("contact_link"),
        "justdial_profile_url": lead.get("justdial_profile_url"),
        "source_data": lead.get("source_data", {}),
        "created_at": lead.get("created_at") or iso(now_utc()),
    }
    return [initial_enquiry]


async def _merge_leads(source_lead: dict, dest_lead: dict, by_user_id: Optional[str] = None) -> dict:
    """Merge source_lead into dest_lead.
    - Combines enquiries from both leads.
    - Combines notes from both leads.
    - Combines emails and alternate phone numbers.
    - Re-keys associated messages/chats to target the dest_lead.
    - Re-keys associated activities to target the dest_lead.
    - Deletes source_lead from the database.
    - Resets dest_lead's status to 'new' and opened_at to None so it resurfaces.
    """
    dest_id = dest_lead["id"]
    source_id = source_lead["id"]

    # 1. Compile enquiries
    dest_enquiries = _ensure_lead_enquiries(dest_lead)
    source_enquiries = _ensure_lead_enquiries(source_lead)
    merged_enquiries = dest_enquiries + source_enquiries
    # Sort merged_enquiries by created_at chronologically
    try:
        merged_enquiries.sort(key=lambda x: x.get("created_at") or "")
    except Exception:
        pass

    # 2. Compile notes
    dest_notes = list(dest_lead.get("notes") or [])
    source_notes = list(source_lead.get("notes") or [])
    # Add a note explaining the merge
    merge_note = {
        "id": str(uuid.uuid4()),
        "body": f"[System] Merged duplicate lead '{source_lead.get('customer_name')}' (ID: {source_id}) into this lead.",
        "by": by_user_id or "system",
        "by_name": "System",
        "at": iso(now_utc()),
    }
    merged_notes = dest_notes + source_notes + [merge_note]

    # 3. Combine alternate phones and emails
    dest_phones = list(dest_lead.get("phones") or [])
    all_source_phones = [source_lead.get("phone"), *(source_lead.get("phones") or [])]
    for p in all_source_phones:
        p_norm = normalize_phone_display(p) if p else None
        if p_norm and p_norm != dest_lead.get("phone") and p_norm not in dest_phones:
            dest_phones.append(p_norm)

    dest_emails = list(dest_lead.get("emails") or [])
    all_source_emails = [source_lead.get("email"), *(source_lead.get("emails") or [])]
    for e in all_source_emails:
        if e and e != dest_lead.get("email") and e not in dest_emails:
            dest_emails.append(e)

    # 4. Update dest_lead fields in database
    update_fields = {
        "enquiries": merged_enquiries,
        "notes": merged_notes,
        "phones": dest_phones,
        "emails": dest_emails,
        "status": "new",
        "opened_at": None,
        "last_action_at": iso(now_utc()),
    }
    
    # If the destination lead didn't have a requirement/area/etc. but the source lead did, copy them
    for field in ["requirement", "area", "city", "state", "country"]:
        if not dest_lead.get(field) and source_lead.get(field):
            update_fields[field] = source_lead[field]

    await db.leads.update_one({"id": dest_id}, {"$set": update_fields})

    # 5. Re-key messages (WhatsApp chats) to the destination lead ID
    await db.messages.update_many({"lead_id": source_id}, {"$set": {"lead_id": dest_id}})

    # 6. Re-key activities to the destination lead ID
    await db.activities.update_many({"lead_id": source_id}, {"$set": {"lead_id": dest_id}})
    # 6b. Re-key everything else that hangs off the lead so history survives
    for coll in (db.followups, db.call_logs, db.internal_messages, db.activity_logs):
        try:
            await coll.update_many({"lead_id": source_id}, {"$set": {"lead_id": dest_id}})
        except Exception as e:
            logger.warning(f"merge re-key failed for {coll.name}: {e}")
    
    # Also log a specific activity for the merge
    await log_activity(by_user_id, "lead_merged", dest_id, {
        "merged_lead_id": source_id,
        "merged_customer_name": source_lead.get("customer_name"),
    })

    # 7. Delete the source lead
    await db.leads.delete_one({"id": source_id})

    # Retrieve and return the updated destination lead
    refreshed = await db.leads.find_one({"id": dest_id}, {"_id": 0})
    return refreshed


class MergeLeadsInput(BaseModel):
    source_lead_id: str

@api.post("/leads/{lead_id}/merge")
async def merge_leads_manual(lead_id: str, body: MergeLeadsInput, user: dict = Depends(get_current_user)):
    """Manually merge another lead INTO this one. This lead (dest) survives with
    all phones/emails/notes/enquiries/chats/calls/followups; the source lead is
    deleted. Admin: any two leads. Executive: both must be assigned to them."""
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if lead_id == body.source_lead_id:
        raise HTTPException(status_code=400, detail="Cannot merge a lead into itself")
    dest = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    source = await db.leads.find_one({"id": body.source_lead_id}, {"_id": 0})
    if not dest or not source:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and (
        dest.get("assigned_to") != user["id"] or source.get("assigned_to") != user["id"]
    ):
        raise HTTPException(status_code=403, detail="You can only merge leads that are both assigned to you — ask an admin")
    merged = await _merge_leads(source_lead=source, dest_lead=dest, by_user_id=user["id"])
    return {"merged": True, "lead": merged}


async def _find_lead_by_justdial_link(url: Optional[str]) -> Optional[dict]:
    norm = _normalize_justdial_link(url)
    if not norm:
        return None
    return await db.leads.find_one(
        {"$or": [
            {"justdial_profile_url": norm},
            {"enquiries.justdial_profile_url": norm},
            {"enquiries.contact_link": norm},
        ]},
        {"_id": 0, "id": 1, "customer_name": 1, "assigned_to": 1, "source": 1, "phone": 1},
    )



@api.post("/ingest/justdial")
async def ingest_justdial(body: JustdialIngestInput):
    """Public endpoint that accepts a Justdial email payload.
    MOCK: in production this would be triggered by a Gmail API pull job.
    """
    # store raw email log
    email_doc = {
        "id": str(uuid.uuid4()),
        "from": body.from_email,
        "subject": body.subject,
        "raw_html": body.raw_email_html,
        "raw_text": body.raw_email_text,
        "received_at": iso(now_utc()),
        "processed": False,
    }
    await db.email_logs.insert_one(email_doc.copy())

    parsed = parse_justdial_email(body.raw_email_text or "", body.raw_email_html or "")
    if not parsed.get("customer_name") and not parsed.get("requirement"):
        await db.email_logs.update_one({"id": email_doc["id"]}, {"$set": {"processed": True, "error": "unparseable"}})
        raise HTTPException(status_code=400, detail="Unable to parse Justdial email content")

    name = parsed.get("customer_name") or "Justdial Lead"
    ts = parsed.get("timestamp") or iso(now_utc())
    content_hash = hashlib.sha256(((body.raw_email_text or "") + (body.raw_email_html or "")).encode("utf-8")).hexdigest()
    dhash = _lead_dedup_hash(name, ts, content_hash[:16])
    created_override = None
    if parsed.get("timestamp"):
        try:
            from zoneinfo import ZoneInfo
            dt = datetime.strptime(parsed["timestamp"].strip(), "%Y-%m-%d %H:%M:%S")
            created_override = iso(dt.replace(tzinfo=ZoneInfo("Asia/Kolkata")))
        except Exception:
            created_override = None

    # Profile-URL based dedup — short-circuit BEFORE creating a new lead. If a
    # lead already exists for the same Justdial profile link, return that lead
    # and mark the email as a duplicate.
    contact_link = parsed.get("contact_link")
    profile_url = _normalize_justdial_link(contact_link)
    if profile_url:
        existing_by_url = await _find_lead_by_justdial_link(profile_url)
        if existing_by_url:
            await db.email_logs.update_one(
                {"id": email_doc["id"]},
                {"$set": {"processed": True, "lead_id": existing_by_url["id"], "duplicate": True, "dedup_reason": "justdial_profile_url"}},
            )
            await log_activity(None, "justdial_duplicate_profile_url", existing_by_url["id"], {"url": profile_url})
            return {"ok": True, "lead_id": existing_by_url["id"], "duplicate": True, "dedup_reason": "justdial_profile_url"}

    data = {
        "customer_name": name,
        "requirement": parsed.get("requirement"),
        "area": parsed.get("area"),
        "city": parsed.get("city"),
        "state": parsed.get("state"),
        "phone": parsed.get("phone"),
        "source": "Justdial",
        "contact_link": contact_link,
        "justdial_profile_url": profile_url,
        "source_data": {"timestamp": ts},
        "raw_email_html": body.raw_email_html,
        "raw_email_text": body.raw_email_text,
        "dedup_hash": dhash,
        "_created_at_override": created_override,
    }
    existing = await db.leads.find_one({"dedup_hash": dhash}, {"_id": 0, "id": 1})
    is_duplicate = existing is not None
    lead = await _create_lead_internal(data, by_user_id=None)
    await db.email_logs.update_one({"id": email_doc["id"]}, {"$set": {"processed": True, "lead_id": lead["id"], "duplicate": is_duplicate}})
    return {"ok": True, "lead_id": lead["id"], "duplicate": is_duplicate}

# ------------- IndiaMART webhook -------------
async def _handle_indiamart_payload(payload: Any, identifier: Optional[str] = None) -> dict:
    # store raw
    raw = {
        "id": str(uuid.uuid4()),
        "source": "IndiaMART",
        "identifier": identifier,
        "payload": payload,
        "received_at": iso(now_utc()),
        "processed": False,
    }
    await db.webhook_payloads.insert_one(raw.copy())

    entries: List[dict] = []
    if isinstance(payload, dict):
        resp = payload.get("RESPONSE")
        if isinstance(resp, list):
            entries = resp
        elif isinstance(resp, dict):
            entries = [resp]
        else:
            entries = [payload]
    elif isinstance(payload, list):
        entries = payload

    created_ids: List[str] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        name = e.get("SENDER_NAME") or e.get("sender_name") or e.get("name") or "IndiaMART Buyer"
        phone = (
            e.get("SENDER_MOBILE") or e.get("MOBILE") or e.get("sender_mobile")
            or e.get("SENDER_MOBILE_ALT") or e.get("SENDER_PHONE") or e.get("SENDER_PHONE_ALT")
            or e.get("phone")
        )
        email = e.get("SENDER_EMAIL") or e.get("EMAIL") or e.get("SENDER_EMAIL_ALT") or e.get("sender_email") or e.get("email")
        company = e.get("SENDER_COMPANY") or e.get("sender_company")
        address = e.get("SENDER_ADDRESS") or e.get("sender_address")
        city = e.get("SENDER_CITY") or e.get("city")
        state = e.get("SENDER_STATE") or e.get("state")
        requirement = (
            e.get("SUBJECT") or e.get("QUERY_PRODUCT_NAME") or e.get("QUERY_MCAT_NAME")
            or e.get("QUERY_MESSAGE") or e.get("MESSAGE") or e.get("subject")
        )
        query_time = e.get("QUERY_TIME") or e.get("query_time") or iso(now_utc())
        unique_id = e.get("UNIQUE_QUERY_ID") or e.get("unique_query_id")
        enquiry_type = (
            e.get("QUERY_TYPE") or e.get("INQUIRY_TYPE") or e.get("ENQ_TYPE")
            or e.get("query_type") or e.get("inquiry_type")
        )
        dhash = _lead_dedup_hash(name, query_time, unique_id or (phone or ""))
        data = {
            "customer_name": name,
            "phone": phone,
            "email": email,
            "requirement": requirement,
            "area": address,
            "city": city,
            "state": state,
            "source": "IndiaMART",
            "source_data": {**e, **({"SENDER_COMPANY": company} if company else {})},
            "dedup_hash": dhash,
        }
        if enquiry_type:
            data["enquiry_type"] = str(enquiry_type).strip()
        receiver = (
            e.get("RECEIVER_MOBILE") or e.get("CALL_RECEIVER_NUMBER")
            or e.get("receiver_mobile") or e.get("call_receiver_number")
        )
        if receiver:
            user_match = await _find_user_for_receiver(receiver)
            if user_match:
                # Skip assignment if user is currently on leave — fall back to round-robin
                if await _is_user_on_leave(user_match["id"]):
                    data["source_data"] = {**(data.get("source_data") or {}), "matched_receiver": receiver, "receiver_on_leave": True}
                else:
                    data["assigned_to"] = user_match["id"]
                    data["source_data"] = {**(data.get("source_data") or {}), "matched_receiver": receiver}
        lead = await _create_lead_internal(data, by_user_id=None)
        created_ids.append(lead["id"])
    await db.webhook_payloads.update_one(
        {"id": raw["id"]},
        {"$set": {"processed": True, "lead_ids": created_ids, "entry_count": len(entries)}},
    )
    # IndiaMART expects HTTP 200; echoing CODE/STATUS is a safe acknowledgement pattern
    return {"CODE": 200, "STATUS": "SUCCESS", "ok": True, "created": created_ids, "received": len(entries)}

# Optional shared secret: when INDIAMART_WEBHOOK_KEY is set in .env, the push
# URL must include ?key=<value>. Unset = open (current behavior) so enabling it
# is an explicit step done together with updating the URL in IndiaMART.
_INDIAMART_WEBHOOK_KEY = os.environ.get("INDIAMART_WEBHOOK_KEY", "").strip()

def _check_indiamart_key(request: Request):
    if _INDIAMART_WEBHOOK_KEY and request.query_params.get("key") != _INDIAMART_WEBHOOK_KEY:
        raise HTTPException(status_code=403, detail="Invalid webhook key")

@api.post("/webhooks/indiamart")
async def webhook_indiamart(request: Request):
    _check_indiamart_key(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return await _handle_indiamart_payload(payload, identifier=None)

@api.post("/webhooks/indiamart/{identifier}")
async def webhook_indiamart_tenant(identifier: str, request: Request):
    """Tenant-identifier variant per IndiaMART docs: https://{host}/indiamart/{identifier}"""
    _check_indiamart_key(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return await _handle_indiamart_payload(payload, identifier=identifier)

@api.get("/webhooks/indiamart/_debug/recent")
async def webhook_indiamart_recent(admin: dict = Depends(require_admin), limit: int = 20):
    """Admin-only: inspect last N raw IndiaMART webhook payloads (useful for debugging activations)."""
    docs = await db.webhook_payloads.find(
        {"source": "IndiaMART"}, {"_id": 0}
    ).sort("received_at", -1).to_list(limit)
    return docs

# ------------- Shopify (citspray.com website) webhooks -------------
# Orders placed on the Shopify storefront flow into the CRM as source="Website"
# leads (round-robin assigned so executives can call), and the customer receives
# WhatsApp UTILITY messages only: order confirmation on orders/create and
# tracking details on fulfillments/create. No marketing content is sent here.

SHOPIFY_WEBHOOK_SECRET = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "").strip()
SHOPIFY_TPL_ORDER_CONFIRM = os.environ.get("SHOPIFY_TPL_ORDER_CONFIRM", "order_confirmation").strip()
SHOPIFY_TPL_ORDER_SHIPPED = os.environ.get("SHOPIFY_TPL_ORDER_SHIPPED", "order_shipped").strip()
SHOPIFY_TPL_ABANDONED = os.environ.get("SHOPIFY_TPL_ABANDONED", "abandoned_checkout").strip()
SHOPIFY_ABANDONED_DELAY_MIN = int(os.environ.get("SHOPIFY_ABANDONED_DELAY_MIN", "60") or 60)

def _shopify_verify_hmac(raw_body: bytes, header_hmac: str) -> bool:
    if not SHOPIFY_WEBHOOK_SECRET:
        # Not configured yet — accept but log loudly so setup isn't forgotten.
        logger.warning("SHOPIFY_WEBHOOK_SECRET not set — accepting Shopify webhook WITHOUT verification")
        return True
    if not header_hmac:
        return False
    digest = hmac_mod.new(SHOPIFY_WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac_mod.compare_digest(expected, header_hmac.strip())

def _shopify_order_phone(order: dict) -> Optional[str]:
    for path in (
        ("shipping_address", "phone"), ("billing_address", "phone"),
        ("customer", "phone"), ("customer", "default_address", "phone"),
    ):
        node: Any = order
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if node:
            return str(node)
    return order.get("phone")

def _shopify_order_name(order: dict) -> str:
    cust = order.get("customer") or {}
    ship = order.get("shipping_address") or {}
    name = " ".join(filter(None, [cust.get("first_name"), cust.get("last_name")])).strip()
    return name or ship.get("name") or "Website Customer"

def _shopify_items_summary(order: dict, max_items: int = 4) -> str:
    items = order.get("line_items") or []
    parts = []
    for li in items[:max_items]:
        title = li.get("title") or "Item"
        variant = li.get("variant_title")
        qty = li.get("quantity") or 1
        label = f"{title} ({variant})" if variant and variant != "Default Title" else title
        parts.append(f"{label} ×{qty}")
    extra = len(items) - max_items
    if extra > 0:
        parts.append(f"+{extra} more")
    return ", ".join(parts)

async def _shopify_send_template_for_lead(lead: dict, tpl_name: str, params: List[str]) -> dict:
    """Send a WA template to the lead, padding/truncating params to the template's
    actual placeholder count (mirrors the welcome-template send), and log the
    message into the conversation history. Returns the logged message dict so
    callers can react to failures. When the template isn't in the local
    whatsapp_templates cache, fall back to the caller-supplied param count —
    sending zero params for a parameterised template is a guaranteed #132000."""
    cfg = await get_wa_config()
    try:
        tpl_meta = await _resolve_template_meta(tpl_name, cfg["default_template_lang"])
    except Exception:
        tpl_meta = {}
    required = int(tpl_meta.get("params_required") or 0)
    if required <= 0:
        required = len([p for p in params if str(p) != ""])
    body_params: Optional[List[str]] = None
    if required > 0:
        padded = [str(p) for p in params if str(p) != ""]
        filler = padded[0] if padded else (lead.get("customer_name") or "Customer")
        while len(padded) < required:
            padded.append(filler)
        body_params = padded[:required]
    api_result = await wa_send_template(
        to_phone=lead["phone"],
        template_name=tpl_name,
        lang_code=tpl_meta.get("language") or cfg["default_template_lang"],
        body_params=body_params,
    )
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": lead["id"],
        "direction": "out",
        "body": f"[Template: {tpl_name}] sent to {lead['phone']}",
        "template_name": tpl_name,
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "at": iso(now_utc()),
        "by_user_id": None,
    }
    await db.messages.insert_one(msg.copy())
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        await db.leads.update_one({"id": lead["id"]}, {"$set": {"has_whatsapp": True, "last_message_at": msg["at"]}})
    else:
        logger.warning(f"Shopify WA template '{tpl_name}' failed for lead {lead['id']}: {msg.get('error')}")
    return msg

async def _shopify_handle_order_created(order: dict) -> dict:
    order_no = order.get("name") or f"#{order.get('order_number', '')}"
    phone = _shopify_order_phone(order)
    name = _shopify_order_name(order)
    email = (order.get("customer") or {}).get("email") or order.get("email")
    ship = order.get("shipping_address") or {}
    total = order.get("total_price") or "0"
    currency = order.get("currency") or "INR"
    items_summary = _shopify_items_summary(order)
    requirement = f"Website order {order_no} · {currency} {total} · {items_summary}"
    data = {
        "customer_name": name,
        "phone": phone,
        "email": email,
        "requirement": requirement,
        "area": ship.get("address1"),
        "city": ship.get("city"),
        "state": ship.get("province"),
        "country": ship.get("country"),
        "source": "Website",
        "enquiry_type": "order",
        "source_data": {
            "shopify_order_id": order.get("id"),
            "order_number": order_no,
            "total_price": total,
            "currency": currency,
            "financial_status": order.get("financial_status"),
            "items": items_summary,
            "order_status_url": order.get("order_status_url"),
            "gateway": order.get("gateway") or (order.get("payment_gateway_names") or [None])[0],
        },
        "_suppress_auto_welcome": True,
    }
    lead = await _create_lead_internal(data, by_user_id=None)
    await log_activity(None, "website_order", lead["id"], {"order": order_no, "total": f"{currency} {total}"})
    # WhatsApp UTILITY message: order confirmation ({{1}}=name, {{2}}=order no, {{3}}=total)
    if phone:
        try:
            await _shopify_send_template_for_lead(
                lead, SHOPIFY_TPL_ORDER_CONFIRM,
                [name, order_no, f"{currency} {total}"],
            )
        except Exception as e:
            logger.warning(f"Shopify order-confirmation WA failed: {e}")
    return {"lead_id": lead["id"], "order": order_no}

async def _shopify_handle_fulfillment_created(fulfillment: dict) -> dict:
    order_no = fulfillment.get("name") or ""
    if order_no and "." in order_no:
        order_no = order_no.split(".")[0]
    dest = fulfillment.get("destination") or {}
    phone = dest.get("phone")
    tracking_no = fulfillment.get("tracking_number") or ""
    tracking_url = fulfillment.get("tracking_url") or ""
    company = fulfillment.get("tracking_company") or "our courier"
    lead = None
    if phone:
        lead = await _find_lead_by_phone(str(phone))
    if not lead and fulfillment.get("order_id"):
        lead = await db.leads.find_one(
            {"source_data.shopify_order_id": fulfillment["order_id"]},
            {"_id": 0, "raw_email_html": 0, "raw_email_text": 0},
        )
    if not lead or not lead.get("phone"):
        return {"skipped": "no matching lead/phone", "order": order_no}
    tracking_bits = " ".join(filter(None, [tracking_no, tracking_url])) or "your order-status page"
    # WhatsApp UTILITY message: shipped ({{1}}=name, {{2}}=order no, {{3}}=carrier, {{4}}=tracking)
    try:
        await _shopify_send_template_for_lead(
            lead, SHOPIFY_TPL_ORDER_SHIPPED,
            [lead.get("customer_name") or "Customer", order_no or "your order", company, tracking_bits],
        )
    except Exception as e:
        logger.warning(f"Shopify shipped WA failed: {e}")
    await log_activity(None, "website_order_shipped", lead["id"], {"order": order_no, "tracking": tracking_no})
    return {"lead_id": lead["id"], "order": order_no}

async def _shopify_handle_checkout_upsert(checkout: dict) -> dict:
    """Track a storefront checkout (checkouts/create|update). If it never converts,
    abandoned_checkout_task() sends a WhatsApp reminder after SHOPIFY_ABANDONED_DELAY_MIN."""
    token = str(checkout.get("token") or checkout.get("id") or "").strip()
    if not token:
        return {"skipped": "no checkout token"}
    phone = _shopify_order_phone(checkout) or checkout.get("phone")
    name = _shopify_order_name(checkout)
    completed = bool(checkout.get("completed_at"))
    now_iso = iso(now_utc())
    doc = {
        "checkout_id": checkout.get("id"),
        "phone": str(phone) if phone else None,
        "customer_name": name,
        "email": checkout.get("email") or (checkout.get("customer") or {}).get("email"),
        "items": _shopify_items_summary(checkout),
        "total_price": checkout.get("total_price") or "0",
        "currency": checkout.get("currency") or "INR",
        "recovery_url": checkout.get("abandoned_checkout_url") or "",
        "updated_at": now_iso,
    }
    if completed:
        doc["status"] = "converted"
    await db.abandoned_checkouts.update_one(
        {"token": token},
        {"$set": doc, "$setOnInsert": {"token": token, "created_at": now_iso, "status": "pending", "reminder_sent_at": None, "send_attempts": 0}},
        upsert=True,
    )
    if completed:
        await db.abandoned_checkouts.update_one({"token": token}, {"$set": {"status": "converted"}})

    # Surface the checkout in the CRM IMMEDIATELY (don't wait for the reminder task)
    # so telecallers can see the live cart and call. Reuses an existing lead when the
    # phone matches; otherwise creates a Website/abandoned_checkout lead.
    lead_id = None
    if phone and not completed:
        try:
            cart_note = f"Abandoned checkout · {doc['currency']} {doc['total_price']} · {doc['items']}"
            lead = await _find_lead_by_phone(str(phone))
            if not lead:
                lead = await _create_lead_internal({
                    "customer_name": name or "Website Visitor",
                    "phone": str(phone),
                    "email": doc.get("email"),
                    "requirement": cart_note,
                    "source": "Website",
                    "enquiry_type": "abandoned_checkout",
                    "source_data": {
                        "checkout_token": token,
                        "recovery_url": doc.get("recovery_url"),
                        "total_price": doc.get("total_price"),
                        "items": doc.get("items"),
                    },
                    "_suppress_auto_welcome": True,
                }, by_user_id=None)
                await log_activity(None, "abandoned_checkout", lead["id"], {"total": f"{doc['currency']} {doc['total_price']}"})
            lead_id = lead["id"]
            # Live cart snapshot on the lead — rendered by the CRM UI and used by
            # the send-recovery endpoint. Never clobbers the lead's own fields.
            await db.leads.update_one({"id": lead_id}, {"$set": {"abandoned_cart": {
                "checkout_token": token,
                "items": doc.get("items"),
                "total_price": doc.get("total_price"),
                "currency": doc.get("currency"),
                "recovery_url": doc.get("recovery_url"),
                "updated_at": now_iso,
                "status": "pending",
            }}})
            await db.abandoned_checkouts.update_one({"token": token}, {"$set": {"lead_id": lead_id}})
        except Exception as e:
            logger.warning(f"abandoned-checkout lead upsert failed for {token}: {e}")
    if completed:
        # reflect conversion on any lead that carries this cart snapshot
        await db.leads.update_many(
            {"abandoned_cart.checkout_token": token},
            {"$set": {"abandoned_cart.status": "converted"}},
        )
    return {"checkout": token, "phone_present": bool(phone), "completed": completed, "lead_id": lead_id}


async def _shopify_mark_checkout_converted(order: dict) -> None:
    """Called from orders/create so a completed purchase never gets an abandoned-cart nudge."""
    ors = []
    if order.get("checkout_token"):
        ors.append({"token": str(order["checkout_token"])})
    if order.get("checkout_id"):
        ors.append({"checkout_id": order["checkout_id"]})
    phone = _shopify_order_phone(order)
    if phone:
        ors.append({"phone": str(phone)})
    if not ors:
        return
    await db.abandoned_checkouts.update_many(
        {"$or": ors, "status": {"$ne": "converted"}},
        {"$set": {"status": "converted", "converted_at": iso(now_utc())}},
    )


async def abandoned_checkout_task():
    """Every 10 min: WhatsApp-remind checkouts that stalled > SHOPIFY_ABANDONED_DELAY_MIN ago.
    One reminder per checkout; each becomes/updates a Website lead so execs can follow up."""
    cutoff = iso(now_utc() - timedelta(minutes=SHOPIFY_ABANDONED_DELAY_MIN))
    stale = iso(now_utc() - timedelta(days=3))  # don't dredge up ancient carts
    cursor = db.abandoned_checkouts.find({
        "status": "pending",
        "reminder_sent_at": None,
        "phone": {"$nin": [None, ""]},
        "updated_at": {"$lt": cutoff, "$gt": stale},
        "send_attempts": {"$not": {"$gte": 3}},
    }, {"_id": 0}).limit(20)
    async for co in cursor:
        try:
            # Atomic claim: gunicorn runs one scheduler per worker, so without this
            # a checkout could be reminded up to N-workers times.
            claimed = await db.abandoned_checkouts.find_one_and_update(
                {"token": co["token"], "reminder_sent_at": None, "send_attempts": {"$not": {"$gte": 3}}},
                {"$set": {"reminder_sent_at": iso(now_utc()), "status": "reminding"}, "$inc": {"send_attempts": 1}},
            )
            if not claimed:
                continue
            lead = None
            if co.get("lead_id"):
                lead = await db.leads.find_one({"id": co["lead_id"]}, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})
            if not lead:
                lead = await _find_lead_by_phone(co["phone"])
            if not lead:
                lead = await _create_lead_internal({
                    "customer_name": co.get("customer_name") or "Website Visitor",
                    "phone": co["phone"],
                    "email": co.get("email"),
                    "requirement": f"Abandoned checkout · {co.get('currency')} {co.get('total_price')} · {co.get('items')}",
                    "source": "Website",
                    "enquiry_type": "abandoned_checkout",
                    "source_data": {
                        "checkout_token": co.get("token"),
                        "recovery_url": co.get("recovery_url"),
                        "total_price": co.get("total_price"),
                        "items": co.get("items"),
                    },
                    "_suppress_auto_welcome": True,
                }, by_user_id=None)
                await log_activity(None, "abandoned_checkout", lead["id"], {"total": f"{co.get('currency')} {co.get('total_price')}"})
            # {{1}}=name, {{2}}=items, {{3}}=recovery link
            msg = await _shopify_send_template_for_lead(
                lead, SHOPIFY_TPL_ABANDONED,
                [co.get("customer_name") or "there", co.get("items") or "your items", co.get("recovery_url") or "https://www.citspray.com/cart"],
            )
            if msg.get("status") in ("sent", "delivered", "read", "sent_mock"):
                await db.abandoned_checkouts.update_one(
                    {"token": co["token"]},
                    {"$set": {"status": "reminded", "lead_id": lead["id"]}},
                )
            else:
                # release the claim so the next run retries (up to 3 attempts)
                await db.abandoned_checkouts.update_one(
                    {"token": co["token"]},
                    {"$set": {"status": "pending", "reminder_sent_at": None, "lead_id": lead["id"], "last_send_error": msg.get("error")}},
                )
        except Exception as e:
            logger.warning(f"abandoned_checkout_task failed for {co.get('token')}: {e}")
            await db.abandoned_checkouts.update_one(
                {"token": co["token"]},
                {"$set": {"status": "pending", "reminder_sent_at": None, "last_send_error": str(e)[:300]}},
            )


@api.post("/webhooks/shopify")
async def webhook_shopify(request: Request):
    raw = await request.body()
    header_hmac = request.headers.get("X-Shopify-Hmac-Sha256", "")
    topic = request.headers.get("X-Shopify-Topic", "")
    if not _shopify_verify_hmac(raw, header_hmac):
        raise HTTPException(status_code=401, detail="invalid hmac")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        payload = {}
    await db.webhook_payloads.insert_one({
        "id": str(uuid.uuid4()),
        "source": "Shopify",
        "topic": topic,
        "payload": payload,
        "received_at": iso(now_utc()),
        "processed": False,
    })
    result: dict = {"ok": True, "topic": topic}
    try:
        if topic == "orders/create":
            await _shopify_mark_checkout_converted(payload)
            result.update(await _shopify_handle_order_created(payload))
        elif topic in ("checkouts/create", "checkouts/update"):
            result.update(await _shopify_handle_checkout_upsert(payload))
        elif topic in ("fulfillments/create", "fulfillments/update"):
            # Only message on first tracking availability for updates
            if topic == "fulfillments/create" or payload.get("tracking_number"):
                result.update(await _shopify_handle_fulfillment_created(payload))
        else:
            result["skipped"] = f"unhandled topic {topic}"
    except Exception as e:
        logger.exception(f"Shopify webhook processing failed: {e}")
        result = {"ok": True, "error": "processing_failed"}  # 200 so Shopify doesn't retry-storm
    return result

@api.get("/webhooks/shopify/_debug/recent")
async def webhook_shopify_recent(admin: dict = Depends(require_admin), limit: int = 20):
    docs = await db.webhook_payloads.find(
        {"source": "Shopify"}, {"_id": 0, "payload.line_items": 0}
    ).sort("received_at", -1).to_list(limit)
    return docs


@api.post("/leads/{lead_id}/send-recovery")
async def send_checkout_recovery(lead_id: str, user: dict = Depends(get_current_user)):
    """Telecaller action: WhatsApp the customer their saved-cart recovery link
    (approved UTILITY template `abandoned_checkout`). Works for any lead that has
    an abandoned cart snapshot — either lead.abandoned_cart or a matching
    abandoned_checkouts doc."""
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not lead.get("phone"):
        raise HTTPException(status_code=400, detail="Lead has no phone number")
    cart = lead.get("abandoned_cart") or {}
    if not cart:
        co = await db.abandoned_checkouts.find_one(
            {"$or": [{"lead_id": lead_id}, {"phone": {"$regex": _normalize_phone(lead["phone"])[-10:] + "$"}}]},
            {"_id": 0}, sort=[("updated_at", -1)],
        )
        if co:
            cart = {
                "items": co.get("items"), "total_price": co.get("total_price"),
                "currency": co.get("currency"), "recovery_url": co.get("recovery_url"),
            }
    recovery_url = (cart.get("recovery_url") or "").strip() or "https://www.citspray.com/cart"
    items = cart.get("items") or "your items"
    msg = await _shopify_send_template_for_lead(
        lead, SHOPIFY_TPL_ABANDONED,
        [lead.get("customer_name") or "there", items, recovery_url],
    )
    await log_activity(user.get("id"), "recovery_link_sent", lead_id, {"status": msg.get("status")})
    ok = msg.get("status") in ("sent", "delivered", "read", "sent_mock")
    return {"ok": ok, "status": msg.get("status"), "error": msg.get("error"), "recovery_url": recovery_url}


# ---------------- ExportersIndia webhook ----------------

async def _handle_exportersindia_payload(payload: Any, identifier: Optional[str] = None) -> dict:
    """Parse and ingest lead enquiries pushed by ExportersIndia. Accepts either a single
    enquiry object or a list/wrapper array. Fields mirror IndiaMART semantically — we
    preserve `inq_type` in `enquiry_type` on the lead so the UI can show the same badge."""
    raw = {
        "id": str(uuid.uuid4()),
        "source": "ExportersIndia",
        "identifier": identifier,
        "payload": payload,
        "received_at": iso(now_utc()),
        "processed": False,
    }
    await db.webhook_payloads.insert_one(raw.copy())

    entries: List[dict] = []
    if isinstance(payload, dict):
        # Accept common wrapper keys first
        for k in ("RESPONSE", "response", "enquiries", "enquiry", "data"):
            v = payload.get(k)
            if isinstance(v, list):
                entries = v
                break
            if isinstance(v, dict):
                entries = [v]
                break
        if not entries:
            entries = [payload]
    elif isinstance(payload, list):
        entries = payload

    created_ids: List[str] = []
    skipped_empty = 0
    skipped_existing = 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        # Skip status/error wrapper payloads that ExportersIndia returns when there's
        # no data — e.g. {"msg":"No record found"} or {"msg":"Your next request will..."}.
        has_real_fields = any(
            e.get(k) for k in (
                "inq_id", "INQ_ID", "enquiry_id", "mobile", "MOBILE", "phone",
                "email", "EMAIL", "name", "NAME", "detail_req", "subject", "product",
            )
        )
        if not has_real_fields:
            skipped_empty += 1
            continue
        name = e.get("name") or e.get("NAME") or "ExportersIndia Buyer"
        phone = e.get("mobile") or e.get("MOBILE") or e.get("phone") or e.get("contact_no")
        email = e.get("email") or e.get("EMAIL")
        company = e.get("company") or e.get("COMPANY")
        address = e.get("address") or e.get("ADDRESS")
        city = e.get("city") or e.get("CITY")
        state = e.get("state") or e.get("STATE")
        country = e.get("country") or e.get("COUNTRY")

        # Requirement: prefer detail_req (full enquiry body), then subject, then product.
        requirement = (
            e.get("detail_req") or e.get("DETAIL_REQ") or e.get("message")
            or e.get("subject") or e.get("SUBJECT") or e.get("product") or e.get("PRODUCT")
        )
        inq_type = e.get("inq_type") or e.get("INQ_TYPE") or e.get("enquiry_type")

        # Dedup: ExportersIndia's inq_id is unique per enquiry.
        inq_id = e.get("inq_id") or e.get("INQ_ID") or e.get("enquiry_id")
        enq_date = e.get("enq_date") or e.get("ENQ_DATE") or iso(now_utc())
        dhash = _lead_dedup_hash(name, enq_date, str(inq_id) if inq_id else (phone or ""))

        # Do not pull the lead if it's already in the database
        existing = None
        if dhash:
            existing = await db.leads.find_one({"dedup_hash": dhash}, {"_id": 0, "id": 1})
        if not existing and phone:
            norm_phone = normalize_phone_display(phone)
            if norm_phone:
                existing = await _find_lead_by_phone(norm_phone)
        if not existing and email and email.strip():
            existing = await db.leads.find_one({"email": email.strip()}, {"_id": 0, "id": 1})
            if not existing:
                existing = await db.leads.find_one({"emails": email.strip()}, {"_id": 0, "id": 1})

        if existing:
            logger.info(f"ExportersIndia Ingest: Lead already exists (ID={existing['id']}) - skipping.")
            skipped_existing += 1
            continue

        data = {
            "customer_name": name,
            "phone": phone,
            "email": email,
            "requirement": requirement,
            "area": address,
            "city": city,
            "state": state,
            "country": country,
            "source": "ExportersIndia",
            "source_data": {**e, **({"company": company} if company else {})},
            "dedup_hash": dhash,
        }
        if inq_type:
            data["enquiry_type"] = str(inq_type).strip()
        lead = await _create_lead_internal(data, by_user_id=None)
        created_ids.append(lead["id"])
    await db.webhook_payloads.update_one(
        {"id": raw["id"]},
        {"$set": {
            "processed": True, 
            "lead_ids": created_ids, 
            "entry_count": len(entries), 
            "skipped_empty": skipped_empty,
            "skipped_existing": skipped_existing
        }},
    )
    return {
        "status": "SUCCESS", 
        "ok": True, 
        "created": created_ids, 
        "received": len(entries), 
        "skipped_empty": skipped_empty,
        "skipped_existing": skipped_existing
    }


@api.post("/webhooks/exportersindia")
async def webhook_exportersindia(request: Request, key: Optional[str] = Query(None)):
    # Kept for backwards-compat; prefer the Pull API configured in Settings.
    configured_push = await _get_exportersindia_api_key()
    if configured_push and key != configured_push:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return await _handle_exportersindia_payload(payload, identifier=None)


@api.post("/webhooks/exportersindia/{identifier}")
async def webhook_exportersindia_tenant(identifier: str, request: Request, key: Optional[str] = Query(None)):
    """Per-tenant variant so different ExportersIndia accounts can be routed to different sub-orgs."""
    configured = await _get_exportersindia_api_key()
    if configured and key != configured:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return await _handle_exportersindia_payload(payload, identifier=identifier)


@api.get("/webhooks/exportersindia/_debug/recent")
async def webhook_exportersindia_recent(admin: dict = Depends(require_admin), limit: int = 20):
    """Admin-only: inspect last N raw ExportersIndia webhook payloads."""
    docs = await db.webhook_payloads.find(
        {"source": "ExportersIndia"}, {"_id": 0}
    ).sort("received_at", -1).to_list(limit)
    return docs


@api.get("/webhooks/whatsapp/_debug/recent")
async def webhook_whatsapp_recent(admin: dict = Depends(require_admin), limit: int = 20):
    """Admin-only: inspect last N raw WhatsApp webhook payloads (useful for debugging Meta callbacks)."""
    docs = await db.webhook_payloads.find(
        {"source": "WhatsApp"}, {"_id": 0}
    ).sort("received_at", -1).to_list(limit)
    return docs


class WhatsAppSimulateInput(BaseModel):
    from_phone: str
    body: str = "Hello — testing inbound webhook"
    name: Optional[str] = None


@api.post("/webhooks/whatsapp/_debug/simulate")
async def webhook_whatsapp_simulate(body: WhatsAppSimulateInput, admin: dict = Depends(require_admin)):
    """Admin-only: simulate a Meta inbound text-message payload so we can verify the full
    pipeline (lead lookup/auto-create, message persistence, has_whatsapp flag, /chat sync)
    without needing Meta to actually deliver a message."""
    cfg = await get_wa_config()
    fake_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": cfg.get("waba_id") or "0",
            "changes": [{
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": cfg.get("phone_number_id") or "",
                        "phone_number_id": cfg.get("phone_number_id") or "",
                    },
                    "contacts": ([{
                        "profile": {"name": body.name},
                        "wa_id": _normalize_phone(body.from_phone),
                    }] if body.name else []),
                    "messages": [{
                        "from": _normalize_phone(body.from_phone),
                        "id": f"wamid.SIM.{uuid.uuid4().hex[:16]}",
                        "timestamp": str(int(now_utc().timestamp())),
                        "type": "text",
                        "text": {"body": body.body},
                    }],
                },
                "field": "messages",
            }],
        }],
    }
    # Re-route through the real handler so the simulation is identical to a Meta delivery
    fake_request = type("FakeReq", (), {"json": lambda self: fake_payload})()
    async def _aj(self):
        return fake_payload
    fake_request.json = _aj.__get__(fake_request)
    res = await webhook_whatsapp(fake_request)
    return {"ok": True, "result": res, "simulated_from": _normalize_phone(body.from_phone)}

# ------------- WhatsApp webhook (Meta Cloud API) -------------
@api.get("/webhooks/whatsapp")
async def whatsapp_verify(request: Request):
    cfg = await get_wa_config()
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")
    if mode == "subscribe" and token == cfg["verify_token"] and challenge:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(status_code=403, detail="Verify token mismatch")


async def _find_lead_by_phone_legacy(phone_digits: str) -> Optional[dict]:
    """[LEGACY — WhatsApp webhook fallback only] Best-effort lookup by digits suffix.
    The primary/structured _find_lead_by_phone is defined earlier in this module.
    Kept distinct to avoid name collision that previously overrode the main helper."""
    if not phone_digits:
        return None
    suffix = phone_digits[-10:] if len(phone_digits) >= 10 else phone_digits
    cursor = db.leads.find({"phone": {"$regex": suffix}}, {"_id": 0})
    async for lead in cursor:
        if _normalize_phone(lead.get("phone"))[-10:] == suffix:
            return lead
    return None


# ------------- Chatbot flow engine -------------
class ChatFlowInput(BaseModel):
    name: str
    is_active: bool = False
    description: Optional[str] = None


class ChatFlowUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None
    description: Optional[str] = None


class ChatNodeInput(BaseModel):
    name: str
    message_type: Literal["text", "button", "list", "image", "video", "document", "carousel"]
    message_content: Dict[str, Any] = {}
    is_start_node: bool = False


class ChatNodeUpdate(BaseModel):
    name: Optional[str] = None
    message_type: Optional[Literal["text", "button", "list", "image", "video", "document", "carousel"]] = None
    message_content: Optional[Dict[str, Any]] = None
    is_start_node: Optional[bool] = None
    x: Optional[float] = None  # canvas position
    y: Optional[float] = None


class ChatOptionInput(BaseModel):
    option_id: str
    label: str
    next_node_id: Optional[str] = None
    position: int = 0
    section_title: Optional[str] = None
    description: Optional[str] = None


async def _is_within_24h_window(lead: dict) -> bool:
    last_in = lead.get("last_user_message_at")
    if not last_in:
        return False
    try:
        d = datetime.fromisoformat(last_in.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (now_utc() - d) < timedelta(hours=24)
    except Exception:
        return False


async def wa_send_interactive(to_phone: str, interactive_payload: Dict[str, Any], reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    """Send a WA interactive message (button / list) using the existing WA abstraction.
    cfg['api_version'] is read dynamically — never hardcoded."""
    return await _wa_send_typed(to_phone, {"type": "interactive", "interactive": interactive_payload}, reply_to_wamid=reply_to_wamid)


async def wa_send_media(to_phone: str, media_type: str, url: str, caption: Optional[str] = None, filename: Optional[str] = None, reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    """Send an image, video, or document message via the existing WA abstraction.
    `media_type` is one of 'image','video','document'. `url` must be public HTTPS.
    Caption supported on image/video; filename on document."""
    if media_type not in ("image", "video", "document"):
        return {"error": f"invalid media_type {media_type}", "status": "failed"}
    media_block: Dict[str, Any] = {"link": url}
    if caption and media_type in ("image", "video", "document"):
        media_block["caption"] = caption
    if filename and media_type == "document":
        media_block["filename"] = filename
    return await _wa_send_typed(to_phone, {"type": media_type, media_type: media_block}, reply_to_wamid=reply_to_wamid)


async def wa_send_audio(to_phone: str, url: str, reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    """Send an audio/voice note. WA Cloud API does not accept caption/filename for audio."""
    return await _wa_send_typed(to_phone, {"type": "audio", "audio": {"link": url}}, reply_to_wamid=reply_to_wamid)


async def wa_send_location(to_phone: str, latitude: float, longitude: float, name: Optional[str] = None, address: Optional[str] = None, reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    loc: Dict[str, Any] = {"latitude": float(latitude), "longitude": float(longitude)}
    if name:
        loc["name"] = name
    if address:
        loc["address"] = address
    return await _wa_send_typed(to_phone, {"type": "location", "location": loc}, reply_to_wamid=reply_to_wamid)


async def wa_send_contacts(to_phone: str, contacts: List[Dict[str, Any]], reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    """Send one or more contact cards. Each contact must include a `name.formatted_name` and at least one phone."""
    return await _wa_send_typed(to_phone, {"type": "contacts", "contacts": contacts}, reply_to_wamid=reply_to_wamid)


async def wa_send_reaction(to_phone: str, message_wamid: str, emoji: str) -> Dict[str, Any]:
    """Send or remove a WhatsApp reaction. Passing emoji='' (empty string) removes the reaction.
    Per WA Cloud API, reactions don't support context / quoted replies — it's its own message type."""
    return await _wa_send_typed(to_phone, {
        "type": "reaction",
        "reaction": {"message_id": message_wamid, "emoji": emoji or ""},
    })


async def _wa_send_typed(to_phone: str, payload_extra: Dict[str, Any], reply_to_wamid: Optional[str] = None) -> Dict[str, Any]:
    """Shared transport for non-text WhatsApp messages. Keeps version, auth, error shape
    identical to the other wa_send_* helpers."""
    cfg = await get_wa_config()
    if not cfg["enabled"]:
        return {"mock": True, "status": "sent_mock", "wamid": None}
    to = _normalize_phone(to_phone)
    if not to:
        return {"error": "no_phone", "status": "failed"}
    url = f"{WA_BASE_URL}/{cfg['api_version']}/{cfg['phone_number_id']}/messages"
    body_payload: Dict[str, Any] = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, **payload_extra}
    if reply_to_wamid:
        body_payload["context"] = {"message_id": reply_to_wamid}
    headers = {"Authorization": f"Bearer {cfg['access_token']}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, json=body_payload, headers=headers)
            # Invalid/stale context → retry once without it
            if r.status_code >= 400 and reply_to_wamid:
                try:
                    err = (r.json().get("error") or {})
                except Exception:
                    err = {}
                if err.get("code") in (131009, 100, 131026) or "context" in (err.get("message") or "").lower():
                    logger.info(f"Reply-context failed ({err.get('code')}); retrying without context")
                    body_payload.pop("context", None)
                    r = await client.post(url, json=body_payload, headers=headers)
        data = r.json() if r.content else {}
        if r.status_code >= 400:
            err = (data.get("error") or {})
            return {"error": err.get("message") or r.text, "code": err.get("code"), "status": "failed"}
        wamid = None
        try:
            wamid = data["messages"][0]["id"]
        except Exception:
            pass
        return {"status": "sent", "wamid": wamid, "raw": data}
    except Exception as e:
        logger.exception(f"WA typed send failed: {e}")
        return {"error": str(e), "status": "failed"}


# ────────────── Inbound media download (Meta) ──────────────
_WA_MIME_EXT = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif", "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "audio/amr": ".amr", "audio/aac": ".aac", "audio/webm": ".webm",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/msword": ".doc", "text/plain": ".txt",
}


def _ext_for_mime(mime: Optional[str], fallback: str = "") -> str:
    if not mime:
        return fallback or ".bin"
    mime = mime.split(";", 1)[0].strip().lower()
    if mime in _WA_MIME_EXT:
        return _WA_MIME_EXT[mime]
    import mimetypes
    ext = mimetypes.guess_extension(mime)
    return ext or (fallback or ".bin")


async def _download_wa_media(media_id: str, mime_hint: Optional[str] = None, request: Optional[Request] = None) -> Optional[Dict[str, Any]]:
    """Fetch an inbound WhatsApp media blob from Meta and store it locally so the
    chat UI can render it. Returns {stored_name, url, mime} on success, None on failure.
    Two-step flow per Meta docs: (1) GET /{media_id} → {"url": ...}, (2) GET that URL
    with the same Bearer token → bytes."""
    cfg = await get_wa_config()
    if not cfg.get("enabled"):
        return None
    token = cfg.get("access_token")
    api_version = cfg.get("api_version")
    if not token or not media_id:
        return None
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r1 = await client.get(f"{WA_BASE_URL}/{api_version}/{media_id}", headers=headers)
            if r1.status_code >= 400:
                logger.warning(f"WA media lookup failed {r1.status_code}: {r1.text[:200]}")
                return None
            meta = r1.json() or {}
            download_url = meta.get("url")
            mime_type = meta.get("mime_type") or mime_hint
            if not download_url:
                return None
            r2 = await client.get(download_url, headers=headers)
            if r2.status_code >= 400:
                logger.warning(f"WA media blob fetch failed {r2.status_code}")
                return None
            content_bytes = r2.content
    except Exception as e:
        logger.warning(f"WA media download error: {e}")
        return None
    if len(content_bytes) > 100 * 1024 * 1024:
        logger.warning("WA media too large — skipping local cache")
        return None
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    ext = _ext_for_mime(mime_type)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_ROOT / stored_name).write_bytes(content_bytes)
    # Persist metadata so /api/media/{name}?download=1 can set a proper filename.
    try:
        await db.media_files.update_one(
            {"stored_name": stored_name},
            {"$set": {
                "stored_name": stored_name,
                "original_filename": f"whatsapp_{stored_name}",
                "mime_type": mime_type,
                "size": len(content_bytes),
                "kind": "inbound",
                "uploaded_at": iso(now_utc()),
                "source": "whatsapp_webhook",
            }},
            upsert=True,
        )
    except Exception:
        pass
    # Build absolute URL
    base = (os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if not base and request is not None:
        fwd_proto = request.headers.get("x-forwarded-proto")
        fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        if fwd_host:
            base = f"{fwd_proto or request.url.scheme}://{fwd_host}"
        else:
            base = str(request.base_url).rstrip("/")
    public_url = f"{base}/api/media/{stored_name}" if base else f"/api/media/{stored_name}"
    return {"stored_name": stored_name, "url": public_url, "mime": mime_type, "size": len(content_bytes)}




def _build_interactive_payload(node: dict, options: List[dict]) -> Dict[str, Any]:
    content = node.get("message_content") or {}
    body_text = (content.get("body") or "").strip()
    if not body_text:
        raise ValueError("Node body is required")
    block: Dict[str, Any] = {"body": {"text": body_text}}
    if content.get("header"):
        block["header"] = {"type": "text", "text": content["header"]}
    if content.get("footer"):
        block["footer"] = {"text": content["footer"]}
    if node["message_type"] == "button":
        if not options:
            raise ValueError("Button nodes require at least one option")
        if len(options) > 3:
            raise ValueError("WhatsApp allows a maximum of 3 buttons")
        block["type"] = "button"
        block["action"] = {"buttons": [
            {"type": "reply", "reply": {"id": o["option_id"], "title": o["label"][:20]}}
            for o in options
        ]}
    elif node["message_type"] == "list":
        if not options:
            raise ValueError("List nodes require at least one option")
        button_text = (content.get("button_text") or "Choose").strip()[:20]
        sections_map: Dict[str, List[Dict[str, Any]]] = {}
        sections_order: List[str] = []
        for o in options:
            title = (o.get("section_title") or "Options").strip()
            if title not in sections_map:
                sections_map[title] = []
                sections_order.append(title)
            row = {"id": o["option_id"], "title": o["label"][:24]}
            if o.get("description"):
                row["description"] = o["description"][:72]
            sections_map[title].append(row)
        sections = [{"title": t[:24], "rows": sections_map[t]} for t in sections_order]
        block["type"] = "list"
        block["action"] = {"button": button_text, "sections": sections}
    else:
        raise ValueError(f"Unsupported interactive type {node['message_type']}")
    return block


async def send_flow_message(to_phone: str, node_id: str, lead: Optional[dict] = None) -> Dict[str, Any]:
    node = await db.chat_nodes.find_one({"id": node_id}, {"_id": 0})
    if not node:
        return {"error": "node_not_found"}
    if not lead:
        lead = await _find_lead_by_phone(to_phone)
    options: List[Dict[str, Any]] = []
    if node["message_type"] in ("button", "list", "carousel"):
        options = await db.chat_options.find({"node_id": node_id}, {"_id": 0}).sort("position", 1).to_list(50)
        if lead and not await _is_within_24h_window(lead):
            return {"status": "skipped_outside_24h"}
    content = node.get("message_content") or {}
    msg_body_preview = content.get("body") or f"[flow:{node['message_type']}]"
    mtype = node["message_type"]
    if mtype == "text":
        api_result = await wa_send_text(to_phone=to_phone, body=msg_body_preview)
    elif mtype in ("image", "video", "document"):
        url = (content.get("media_url") or "").strip()
        if not url:
            return {"error": f"{mtype} node requires media_url"}
        api_result = await wa_send_media(
            to_phone=to_phone,
            media_type=mtype,
            url=url,
            caption=content.get("caption") or None,
            filename=content.get("filename") or None,
        )
        if mtype == "image":
            msg_body_preview = f"[image] {content.get('caption','')}".strip()
        elif mtype == "video":
            msg_body_preview = f"[video] {content.get('caption','')}".strip()
        else:
            msg_body_preview = f"[document: {content.get('filename','file')}] {content.get('caption','')}".strip()
    elif mtype == "carousel":
        # Pseudo-carousel: sequential images, then a single interactive button whose
        # reply IDs match chat_options (so webhook routing works unchanged).
        cards = content.get("cards") or []
        if not cards:
            return {"error": "Carousel node requires at least one card"}
        if lead and not await _is_within_24h_window(lead):
            return {"status": "skipped_outside_24h"}
        last_result: Dict[str, Any] = {"status": "sent"}
        for card in cards:
            img_url = (card.get("image_url") or "").strip()
            cap_parts = [card.get("title") or "", card.get("subtitle") or ""]
            # Preserve the caption exactly — join non-empty parts with a newline, no outer strip.
            cap = "\n".join([p for p in cap_parts if p]) or None
            if img_url:
                last_result = await wa_send_media(to_phone=to_phone, media_type="image", url=img_url, caption=cap)
            elif cap:
                last_result = await wa_send_text(to_phone=to_phone, body=cap)
        # Build the final button prompt from chat_options (same mechanism as 'button' nodes).
        # The UI ensures each card has a corresponding option row so that `next_node_id` works.
        if options:
            temp_node = {
                "message_type": "button",
                "message_content": {"body": content.get("body") or "Choose an option"},
            }
            try:
                interactive = _build_interactive_payload(temp_node, options[:3])
                last_result = await wa_send_interactive(to_phone=to_phone, interactive_payload=interactive)
            except ValueError as e:
                return {"error": str(e)}
        api_result = last_result
        msg_body_preview = f"[carousel] {len(cards)} cards"
    else:
        try:
            interactive = _build_interactive_payload(node, options)
        except ValueError as e:
            return {"error": str(e)}
        api_result = await wa_send_interactive(to_phone=to_phone, interactive_payload=interactive)
    if lead:
        msg_doc = {
            "id": str(uuid.uuid4()),
            "lead_id": lead["id"],
            "direction": "out",
            "body": msg_body_preview,
            "to_phone": to_phone,
            "flow_id": node.get("flow_id"),
            "flow_node_id": node_id,
            "status": api_result.get("status", "failed"),
            "wamid": api_result.get("wamid"),
            "error": api_result.get("error"),
            "at": iso(now_utc()),
            "by_user_id": None,
        }
        # Attach media metadata so the chat thread can render an inline preview.
        if mtype in ("image", "video", "document"):
            msg_doc["media_type"] = mtype
            msg_doc["media_url"] = content.get("media_url") or ""
            if content.get("caption"):
                msg_doc["caption"] = content.get("caption")
            if mtype == "document" and content.get("filename"):
                msg_doc["filename"] = content.get("filename")
        elif mtype == "carousel":
            msg_doc["media_type"] = "carousel"
            msg_doc["cards"] = content.get("cards") or []
        await db.messages.insert_one(msg_doc)
        if api_result.get("status") in ("sent", "sent_mock"):
            await db.leads.update_one({"id": lead["id"]}, {"$set": {"has_whatsapp": True, "last_action_at": iso(now_utc()), "last_message_at": msg_doc["at"]}})
    target_phone = _normalize_phone(to_phone)[-10:]
    if target_phone and api_result.get("status") in ("sent", "sent_mock"):
        await db.chat_sessions.update_one(
            {"phone_key": target_phone},
            {"$set": {
                "phone_key": target_phone,
                "phone": to_phone,
                "current_flow_id": node.get("flow_id"),
                "current_node_id": node_id,
                "last_interaction_at": iso(now_utc()),
                "lead_id": (lead or {}).get("id"),
            }},
            upsert=True,
        )
    return {"status": api_result.get("status"), "wamid": api_result.get("wamid"), "node_id": node_id}


async def handle_flow_inbound(from_phone: str, interactive: Dict[str, Any], lead: Optional[dict]) -> Optional[Dict[str, Any]]:
    selected_id: Optional[str] = None
    kind = interactive.get("type")
    if kind == "button_reply":
        selected_id = (interactive.get("button_reply") or {}).get("id")
    elif kind == "list_reply":
        selected_id = (interactive.get("list_reply") or {}).get("id")
    if not selected_id:
        return None
    phone_key = _normalize_phone(from_phone or "")[-10:]
    session = await db.chat_sessions.find_one({"phone_key": phone_key}, {"_id": 0}) if phone_key else None
    if not session or not session.get("current_node_id"):
        flow = await db.chat_flows.find_one({"is_active": True}, {"_id": 0})
        if not flow:
            return {"status": "no_active_flow"}
        start_node = await db.chat_nodes.find_one({"flow_id": flow["id"], "is_start_node": True}, {"_id": 0})
        if not start_node:
            return {"status": "no_start_node"}
        option = await db.chat_options.find_one({"node_id": start_node["id"], "option_id": selected_id}, {"_id": 0})
        if not option:
            return {"status": "unknown_option_on_start"}
        if option.get("next_node_id"):
            return await send_flow_message(from_phone, option["next_node_id"], lead=lead)
        return {"status": "flow_ended"}
    option = await db.chat_options.find_one({"node_id": session["current_node_id"], "option_id": selected_id}, {"_id": 0})
    if not option:
        return {"status": "no_match"}
    if option.get("next_node_id"):
        return await send_flow_message(from_phone, option["next_node_id"], lead=lead)
    await db.chat_sessions.delete_one({"phone_key": phone_key})
    return {"status": "flow_ended"}


# ────────────── Flow templates ──────────────
# Each template is a self-contained blueprint: nodes[] + per-node options[] referenced
# by local `ref` (e.g. "greet") so we don't need to know DB uuids up front. At import
# time we materialise real uuids and resolve every `next_ref` → `next_node_id`.
FLOW_TEMPLATES: List[Dict[str, Any]] = [
    {
        "id": "lead_qualification",
        "name": "Lead Qualification",
        "description": "Greet new enquirers, ask if they are ready to buy or just enquiring, and route to a human handoff.",
        "category": "Sales",
        "nodes": [
            {
                "ref": "greet", "name": "Greet", "is_start_node": True,
                "message_type": "button", "x": 80, "y": 80,
                "message_content": {"body": "Hi 👋 Welcome! Are you looking to buy or just enquiring?"},
                "options": [
                    {"option_id": "buy", "label": "Ready to buy", "next_ref": "handoff"},
                    {"option_id": "enq", "label": "Just enquiring", "next_ref": "enquiry_ack"},
                ],
            },
            {
                "ref": "handoff", "name": "Buying handoff",
                "message_type": "text", "x": 480, "y": 20,
                "message_content": {"body": "Great — a sales executive will call you within 15 minutes."},
                "options": [],
            },
            {
                "ref": "enquiry_ack", "name": "Enquiry acknowledged",
                "message_type": "text", "x": 480, "y": 200,
                "message_content": {"body": "Thanks for reaching out! Our team will share details shortly."},
                "options": [],
            },
        ],
    },
    {
        "id": "after_hours",
        "name": "After-hours autoresponder",
        "description": "A single friendly note sent automatically outside business hours.",
        "category": "Support",
        "nodes": [
            {
                "ref": "autoresp", "name": "After hours", "is_start_node": True,
                "message_type": "text", "x": 80, "y": 80,
                "message_content": {"body": "Thanks for your message! Our team is offline right now. We'll get back to you first thing tomorrow (9 AM IST)."},
                "options": [],
            },
        ],
    },
    {
        "id": "feedback_survey",
        "name": "Feedback Survey (CSAT)",
        "description": "Ask a 3-option CSAT after service, thank the user, and log the score.",
        "category": "Support",
        "nodes": [
            {
                "ref": "ask", "name": "Ask CSAT", "is_start_node": True,
                "message_type": "button", "x": 80, "y": 80,
                "message_content": {"body": "How was your experience with us today?"},
                "options": [
                    {"option_id": "good", "label": "Great", "next_ref": "thanks_good"},
                    {"option_id": "ok", "label": "Okay", "next_ref": "thanks_ok"},
                    {"option_id": "bad", "label": "Poor", "next_ref": "thanks_bad"},
                ],
            },
            {"ref": "thanks_good", "name": "Thanks (Great)", "message_type": "text", "x": 480, "y": -20,
             "message_content": {"body": "Thanks - glad you had a great experience!"}, "options": []},
            {"ref": "thanks_ok", "name": "Thanks (Okay)", "message_type": "text", "x": 480, "y": 160,
             "message_content": {"body": "Thanks for the feedback - we'll keep improving."}, "options": []},
            {"ref": "thanks_bad", "name": "Thanks (Poor)", "message_type": "text", "x": 480, "y": 340,
             "message_content": {"body": "Sorry we fell short. A team lead will reach out to make it right."}, "options": []},
        ],
    },
    {
        "id": "product_catalog",
        "name": "Product Catalog (List)",
        "description": "Show a list of product categories and route to each category's details.",
        "category": "Sales",
        "nodes": [
            {
                "ref": "menu", "name": "Catalog menu", "is_start_node": True,
                "message_type": "list", "x": 80, "y": 80,
                "message_content": {
                    "body": "Pick a category to see our bestsellers:",
                    "button_text": "Categories",
                },
                "options": [
                    {"option_id": "oils", "label": "Essential Oils", "section_title": "Wellness", "next_ref": "oils_info"},
                    {"option_id": "fragrance", "label": "Fragrance Oils", "section_title": "Wellness", "next_ref": "fragrance_info"},
                    {"option_id": "talk", "label": "Talk to an expert", "section_title": "Support", "next_ref": "expert_info"},
                ],
            },
            {"ref": "oils_info", "name": "Oils info", "message_type": "text", "x": 480, "y": -20,
             "message_content": {"body": "Our essential oils - lavender, tea tree, eucalyptus - starting at Rs.249."}, "options": []},
            {"ref": "fragrance_info", "name": "Fragrance info", "message_type": "text", "x": 480, "y": 160,
             "message_content": {"body": "Our fragrance oils - jasmine, rose, sandalwood - starting at Rs.199."}, "options": []},
            {"ref": "expert_info", "name": "Expert handoff", "message_type": "text", "x": 480, "y": 340,
             "message_content": {"body": "A product expert will call you within the hour."}, "options": []},
        ],
    },
]


@api.get("/chatflows/templates")
async def list_chatflow_templates(admin: dict = Depends(require_admin)):
    """Return the built-in template gallery so the admin UI can render it."""
    return [
        {
            "id": t["id"], "name": t["name"],
            "description": t.get("description", ""),
            "category": t.get("category", ""),
            "node_count": len(t["nodes"]),
            "types": sorted({n["message_type"] for n in t["nodes"]}),
        }
        for t in FLOW_TEMPLATES
    ]


class ImportTemplateInput(BaseModel):
    template_id: str
    name: Optional[str] = None
    is_active: bool = False


@api.post("/chatflows/import-template")
async def import_chatflow_template(body: ImportTemplateInput, admin: dict = Depends(require_admin)):
    """Materialise a built-in template into real DB docs (flow + nodes + options)."""
    template = next((t for t in FLOW_TEMPLATES if t["id"] == body.template_id), None)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    if body.is_active:
        await db.chat_flows.update_many({"is_active": True}, {"$set": {"is_active": False}})
    flow_id = str(uuid.uuid4())
    await db.chat_flows.insert_one({
        "id": flow_id,
        "name": body.name or template["name"],
        "description": template.get("description", ""),
        "is_active": body.is_active,
        "source_template": template["id"],
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    })
    ref_to_id: Dict[str, str] = {}
    for n in template["nodes"]:
        nid = str(uuid.uuid4())
        ref_to_id[n["ref"]] = nid
        await db.chat_nodes.insert_one({
            "id": nid,
            "flow_id": flow_id,
            "name": n["name"],
            "message_type": n["message_type"],
            "message_content": n.get("message_content", {}),
            "is_start_node": bool(n.get("is_start_node")),
            "x": float(n.get("x", 80)),
            "y": float(n.get("y", 80)),
            "created_at": iso(now_utc()),
        })
    for n in template["nodes"]:
        node_id = ref_to_id[n["ref"]]
        opts = n.get("options") or []
        if not opts:
            continue
        docs = []
        for i, o in enumerate(opts):
            next_ref = o.get("next_ref")
            docs.append({
                "id": str(uuid.uuid4()),
                "node_id": node_id,
                "option_id": o["option_id"],
                "label": o["label"],
                "next_node_id": ref_to_id.get(next_ref) if next_ref else None,
                "position": i,
                "section_title": o.get("section_title"),
                "description": o.get("description"),
            })
        await db.chat_options.insert_many([d.copy() for d in docs])
    nodes = await db.chat_nodes.find({"flow_id": flow_id}, {"_id": 0}).sort("is_start_node", -1).to_list(500)
    options = await db.chat_options.find({"node_id": {"$in": [n["id"] for n in nodes]}}, {"_id": 0}).sort("position", 1).to_list(2000)
    opts_by_node: Dict[str, List[Dict[str, Any]]] = {}
    for o in options:
        opts_by_node.setdefault(o["node_id"], []).append(o)
    for n in nodes:
        n["options"] = opts_by_node.get(n["id"], [])
    flow_doc = await db.chat_flows.find_one({"id": flow_id}, {"_id": 0})
    return {**flow_doc, "nodes": nodes}




@api.get("/chatflows")
async def list_chatflows(admin: dict = Depends(require_admin)):
    return await db.chat_flows.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)


@api.post("/chatflows")
async def create_chatflow(body: ChatFlowInput, admin: dict = Depends(require_admin)):
    if body.is_active:
        await db.chat_flows.update_many({"is_active": True}, {"$set": {"is_active": False}})
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "description": body.description,
        "is_active": body.is_active,
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    await db.chat_flows.insert_one(doc.copy())
    return strip_mongo(doc)


@api.get("/chatflows/{flow_id}")
async def get_chatflow(flow_id: str, admin: dict = Depends(require_admin)):
    flow = await db.chat_flows.find_one({"id": flow_id}, {"_id": 0})
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    nodes = await db.chat_nodes.find({"flow_id": flow_id}, {"_id": 0}).sort("is_start_node", -1).to_list(500)
    options = await db.chat_options.find({"node_id": {"$in": [n["id"] for n in nodes]}}, {"_id": 0}).sort("position", 1).to_list(2000)
    opts_by_node: Dict[str, List[Dict[str, Any]]] = {}
    for o in options:
        opts_by_node.setdefault(o["node_id"], []).append(o)
    for n in nodes:
        n["options"] = opts_by_node.get(n["id"], [])
    return {**flow, "nodes": nodes}


@api.patch("/chatflows/{flow_id}")
async def update_chatflow(flow_id: str, body: ChatFlowUpdate, admin: dict = Depends(require_admin)):
    flow = await db.chat_flows.find_one({"id": flow_id}, {"_id": 0})
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    upd: Dict[str, Any] = {"updated_at": iso(now_utc())}
    if body.name is not None:
        upd["name"] = body.name
    if body.description is not None:
        upd["description"] = body.description
    if body.is_active is not None:
        if body.is_active:
            await db.chat_flows.update_many({"id": {"$ne": flow_id}, "is_active": True}, {"$set": {"is_active": False}})
        upd["is_active"] = body.is_active
    await db.chat_flows.update_one({"id": flow_id}, {"$set": upd})
    return await db.chat_flows.find_one({"id": flow_id}, {"_id": 0})


@api.delete("/chatflows/{flow_id}")
async def delete_chatflow(flow_id: str, admin: dict = Depends(require_admin)):
    node_ids: List[str] = []
    async for n in db.chat_nodes.find({"flow_id": flow_id}, {"_id": 0, "id": 1}):
        node_ids.append(n["id"])
    if node_ids:
        await db.chat_options.delete_many({"node_id": {"$in": node_ids}})
    await db.chat_nodes.delete_many({"flow_id": flow_id})
    await db.chat_flows.delete_one({"id": flow_id})
    return {"ok": True}


@api.post("/chatflows/{flow_id}/nodes")
async def create_chat_node(flow_id: str, body: ChatNodeInput, admin: dict = Depends(require_admin)):
    if not await db.chat_flows.find_one({"id": flow_id}):
        raise HTTPException(status_code=404, detail="Flow not found")
    if body.is_start_node:
        await db.chat_nodes.update_many({"flow_id": flow_id, "is_start_node": True}, {"$set": {"is_start_node": False}})
    existing_count = await db.chat_nodes.count_documents({"flow_id": flow_id})
    # Stagger default positions so newly created nodes don't overlap on the canvas
    default_x = 80.0 + (existing_count % 4) * 320.0
    default_y = 80.0 + (existing_count // 4) * 220.0
    doc = {
        "id": str(uuid.uuid4()),
        "flow_id": flow_id,
        "name": body.name,
        "message_type": body.message_type,
        "message_content": body.message_content,
        "is_start_node": body.is_start_node,
        "x": default_x,
        "y": default_y,
        "created_at": iso(now_utc()),
    }
    await db.chat_nodes.insert_one(doc.copy())
    return strip_mongo(doc)


@api.patch("/chatflows/{flow_id}/nodes/{node_id}")
async def update_chat_node(flow_id: str, node_id: str, body: ChatNodeUpdate, admin: dict = Depends(require_admin)):
    node = await db.chat_nodes.find_one({"id": node_id, "flow_id": flow_id}, {"_id": 0})
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    upd: Dict[str, Any] = {}
    for f in ["name", "message_type", "message_content", "x", "y"]:
        v = getattr(body, f)
        if v is not None:
            upd[f] = v
    if body.is_start_node is not None:
        if body.is_start_node:
            await db.chat_nodes.update_many({"flow_id": flow_id, "is_start_node": True, "id": {"$ne": node_id}}, {"$set": {"is_start_node": False}})
        upd["is_start_node"] = body.is_start_node
    if upd:
        await db.chat_nodes.update_one({"id": node_id}, {"$set": upd})
    return await db.chat_nodes.find_one({"id": node_id}, {"_id": 0})


class BulkNodePositions(BaseModel):
    positions: Dict[str, Dict[str, float]]  # { node_id: {x,y} }


@api.put("/chatflows/{flow_id}/positions")
async def save_node_positions(flow_id: str, body: BulkNodePositions, admin: dict = Depends(require_admin)):
    """Persist canvas coordinates for many nodes at once (used by the drag-to-layout UI)."""
    if not await db.chat_flows.find_one({"id": flow_id}):
        raise HTTPException(status_code=404, detail="Flow not found")
    count = 0
    for nid, pos in body.positions.items():
        if "x" not in pos or "y" not in pos:
            continue
        res = await db.chat_nodes.update_one(
            {"id": nid, "flow_id": flow_id},
            {"$set": {"x": float(pos["x"]), "y": float(pos["y"])}},
        )
        count += res.modified_count
    return {"updated": count}


# -------- Media upload for flow nodes --------
UPLOAD_ROOT = Path("/app/backend/uploads")
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)

ALLOWED_MEDIA_KINDS = {"image", "video", "document", "audio"}


@api.post("/chatflows/upload-media")
async def upload_flow_media(
    request: Request,
    file: UploadFile = File(...),
    kind: str = Form("document"),
    user: dict = Depends(get_current_user),
):
    """Accept a local file upload and return an ABSOLUTE publicly accessible URL.
    Any authenticated user (admin or executive) can upload — this is the common
    entry point for WhatsApp voice notes, images, videos, documents, and chatflow
    builder assets. Per-lead send permission is enforced separately in the
    downstream /whatsapp/send-media endpoint via _assert_chat_permitted."""
    if kind not in ALLOWED_MEDIA_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(ALLOWED_MEDIA_KINDS)}")
    original = (file.filename or "upload.bin").strip().replace("/", "_").replace("\\", "_")
    original_ct = (file.content_type or "").lower()
    content_bytes = await file.read()
    if len(content_bytes) > 50 * 1024 * 1024:  # 50 MB cap
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")

    suffix_in = Path(original).suffix.lower()
    # Transcode to a WhatsApp-supported format if needed (audio/video only).
    final_bytes = content_bytes
    final_ext = suffix_in
    final_mime = original_ct
    if kind == "audio":
        final_bytes, final_ext, final_mime = _prepare_audio_for_whatsapp(content_bytes, suffix_in, original_ct)
    elif kind == "video":
        final_bytes, final_ext, final_mime = _prepare_video_for_whatsapp(content_bytes, suffix_in, original_ct)
    elif kind == "image":
        # WhatsApp supports jpeg / png only. If caller sent heic/webp/gif → convert to jpeg.
        final_bytes, final_ext, final_mime = _prepare_image_for_whatsapp(content_bytes, suffix_in, original_ct)

    stored_name = f"{uuid.uuid4().hex}{final_ext or '.bin'}"
    dest = UPLOAD_ROOT / stored_name
    try:
        dest.write_bytes(final_bytes)
    except Exception as e:
        logger.exception(f"upload failed: {e}")
        raise HTTPException(status_code=500, detail="Upload failed")

    # Persist original filename mapping so downloads preserve the name.
    await db.media_files.update_one(
        {"stored_name": stored_name},
        {"$set": {
            "stored_name": stored_name,
            "original_filename": original,
            "mime_type": final_mime,
            "size": len(final_bytes),
            "kind": kind,
            "uploaded_at": iso(now_utc()),
            "uploaded_by": user["id"],
        }},
        upsert=True,
    )

    base = (os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if not base:
        fwd_proto = request.headers.get("x-forwarded-proto")
        fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        base = f"{fwd_proto or request.url.scheme}://{fwd_host}" if fwd_host else str(request.base_url).rstrip("/")
    public_url = f"{base}/api/media/{stored_name}"
    return {
        "url": public_url,
        "filename": original,
        "stored_name": stored_name,
        "size": len(final_bytes),
        "original_size": len(content_bytes),
        "kind": kind,
        "mime_type": final_mime,
        "transcoded": len(content_bytes) != len(final_bytes) or (suffix_in != final_ext),
    }


def _run_ffmpeg(args: List[str], input_bytes: bytes, timeout: int = 60) -> Optional[bytes]:
    """Invoke ffmpeg with stdin input bytes, return stdout bytes or None on error."""
    import subprocess
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
            input=input_bytes, capture_output=True, timeout=timeout, check=False,
        )
        if proc.returncode != 0:
            logger.warning(f"ffmpeg failed (rc={proc.returncode}): {proc.stderr[:500].decode('utf-8', 'ignore')}")
            return None
        return proc.stdout
    except FileNotFoundError:
        logger.warning("ffmpeg not installed")
        return None
    except Exception as e:
        logger.warning(f"ffmpeg error: {e}")
        return None


_WA_AUDIO_OK_MIMES = {"audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"}
_WA_AUDIO_OK_EXTS = {".aac", ".m4a", ".mp3", ".amr", ".ogg"}
_WA_VIDEO_OK_MIMES = {"video/mp4", "video/3gpp"}
_WA_VIDEO_OK_EXTS = {".mp4", ".3gp"}


def _prepare_audio_for_whatsapp(raw: bytes, suffix: str, mime: str) -> tuple:
    """Return (bytes, ext, mime) — transcoded to ogg/opus if input isn't supported.
    Browsers' MediaRecorder default is audio/webm;codecs=opus, which WhatsApp rejects.
    Since the opus payload is already there, we remux the container without re-encoding."""
    mime_l = (mime or "").split(";", 1)[0].lower().strip()
    if mime_l in _WA_AUDIO_OK_MIMES or suffix in _WA_AUDIO_OK_EXTS:
        return raw, suffix or ".ogg", mime_l or "audio/ogg"
    # Common input: audio/webm;codecs=opus (.webm) → remux to ogg/opus
    # Use ffmpeg to transcode (copy opus stream into ogg, re-encode to opus if necessary)
    out = _run_ffmpeg(["-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "64k", "-f", "ogg", "pipe:1"], raw)
    if out:
        return out, ".ogg", "audio/ogg"
    # Fallback: encode to mp3 which WA also accepts
    out = _run_ffmpeg(["-i", "pipe:0", "-vn", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"], raw)
    if out:
        return out, ".mp3", "audio/mpeg"
    # Last resort: hand the file back untouched (will likely fail on Meta side)
    logger.warning("audio transcode failed — returning original bytes")
    return raw, suffix or ".bin", mime_l or "application/octet-stream"


def _prepare_video_for_whatsapp(raw: bytes, suffix: str, mime: str) -> tuple:
    """Return (bytes, ext, mime) — transcoded to H.264/AAC MP4 if input is not mp4/3gp.
    MP4 mux needs seekable output so we transcode via temp files (input + output)."""
    mime_l = (mime or "").split(";", 1)[0].lower().strip()
    if mime_l in _WA_VIDEO_OK_MIMES or suffix in _WA_VIDEO_OK_EXTS:
        return raw, suffix or ".mp4", mime_l or "video/mp4"
    import tempfile
    import subprocess
    with tempfile.NamedTemporaryFile(suffix=suffix or ".bin", delete=False) as tf_in:
        tf_in.write(raw)
        in_path = tf_in.name
    out_path = in_path + ".out.mp4"
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", in_path,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart",
             out_path],
            capture_output=True, timeout=300, check=False,
        )
        if proc.returncode == 0 and Path(out_path).exists():
            data = Path(out_path).read_bytes()
            return data, ".mp4", "video/mp4"
        logger.warning(f"video transcode failed rc={proc.returncode}: {proc.stderr[:400].decode('utf-8','ignore')}")
    except FileNotFoundError:
        logger.warning("ffmpeg not installed — returning original video")
    except Exception as e:
        logger.warning(f"video transcode error: {e}")
    finally:
        for p in (in_path, out_path):
            try:
                os.unlink(p)
            except Exception:
                pass
    return raw, suffix or ".bin", mime_l or "application/octet-stream"


def _prepare_image_for_whatsapp(raw: bytes, suffix: str, mime: str) -> tuple:
    """WhatsApp accepts image/jpeg and image/png only. Convert others (webp/gif/heic) → jpeg."""
    mime_l = (mime or "").split(";", 1)[0].lower().strip()
    if mime_l in ("image/jpeg", "image/png") or suffix in (".jpg", ".jpeg", ".png"):
        return raw, suffix or ".jpg", mime_l or "image/jpeg"
    # Transcode to jpeg via ffmpeg
    out = _run_ffmpeg(["-i", "pipe:0", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"], raw)
    if out:
        return out, ".jpg", "image/jpeg"
    return raw, suffix or ".bin", mime_l or "application/octet-stream"


@api.get("/media/{stored_name}")
async def serve_flow_media(stored_name: str, download: bool = False):
    """Serve files uploaded by admins or cached from WhatsApp. Public (no auth) so Meta
    can fetch on send and so `<img>` tags work from the chat UI. Pass `?download=1` to
    force `Content-Disposition: attachment` with the original filename preserved."""
    safe = stored_name.replace("..", "").replace("/", "").replace("\\", "")
    path = UPLOAD_ROOT / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    meta = await db.media_files.find_one({"stored_name": safe}, {"_id": 0})
    from fastapi.responses import FileResponse
    filename = (meta or {}).get("original_filename") or safe
    mime_type = (meta or {}).get("mime_type")
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    else:
        # Inline preview by default
        headers["Content-Disposition"] = f'inline; filename="{filename}"'
    headers["Cache-Control"] = "public, max-age=86400"
    return FileResponse(str(path), media_type=mime_type, headers=headers, filename=filename)


@api.delete("/chatflows/{flow_id}/nodes/{node_id}")
async def delete_chat_node(flow_id: str, node_id: str, admin: dict = Depends(require_admin)):
    await db.chat_options.delete_many({"node_id": node_id})
    await db.chat_options.update_many({"next_node_id": node_id}, {"$set": {"next_node_id": None}})
    await db.chat_nodes.delete_one({"id": node_id, "flow_id": flow_id})
    return {"ok": True}


@api.put("/chatflows/{flow_id}/nodes/{node_id}/options")
async def replace_node_options(flow_id: str, node_id: str, options: List[ChatOptionInput], admin: dict = Depends(require_admin)):
    if not await db.chat_nodes.find_one({"id": node_id, "flow_id": flow_id}):
        raise HTTPException(status_code=404, detail="Node not found")
    await db.chat_options.delete_many({"node_id": node_id})
    docs = [{
        "id": str(uuid.uuid4()),
        "node_id": node_id,
        "option_id": o.option_id.strip(),
        "label": o.label.strip(),
        "next_node_id": o.next_node_id,
        "position": o.position,
        "section_title": o.section_title,
        "description": o.description,
    } for o in options]
    if docs:
        await db.chat_options.insert_many([d.copy() for d in docs])
    return [strip_mongo(d) for d in docs]


class FlowStartInput(BaseModel):
    phone: str
    node_id: Optional[str] = None


@api.post("/chatflows/{flow_id}/start")
async def start_flow(flow_id: str, body: FlowStartInput, admin: dict = Depends(require_admin)):
    flow = await db.chat_flows.find_one({"id": flow_id}, {"_id": 0})
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    node_id = body.node_id
    if not node_id:
        start = await db.chat_nodes.find_one({"flow_id": flow_id, "is_start_node": True}, {"_id": 0})
        if not start:
            raise HTTPException(status_code=400, detail="Flow has no start node — mark one first.")
        node_id = start["id"]
    result = await send_flow_message(body.phone, node_id)
    # Surface build errors as 400 so the UI can distinguish them from successful sends
    if result.get("error") and not result.get("status"):
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@api.get("/chat-sessions")
async def list_chat_sessions(admin: dict = Depends(require_admin), limit: int = 200):
    return await db.chat_sessions.find({}, {"_id": 0}).sort("last_interaction_at", -1).to_list(limit)




@api.post("/webhooks/whatsapp")
async def webhook_whatsapp(request: Request):
    """Receive incoming WhatsApp messages and delivery status updates from Meta."""
    body_bytes = await request.body()
    # Verify Meta's HMAC signature when an app secret is configured. Reject a
    # PRESENT-but-wrong signature outright; tolerate a missing header only so a
    # misconfigured secret can't silently kill all inbound WhatsApp.
    try:
        cfg_sig = await get_wa_config()
        app_secret = (cfg_sig.get("app_secret") or "").strip()
        sig_header = request.headers.get("x-hub-signature-256", "")
        if app_secret and sig_header:
            expected = "sha256=" + hmac_mod.new(app_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
            if not hmac_mod.compare_digest(expected, sig_header):
                logger.warning("WhatsApp webhook: X-Hub-Signature-256 mismatch — rejecting payload")
                raise HTTPException(status_code=403, detail="Invalid signature")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"WhatsApp webhook signature check failed open: {e}")
    try:
        payload = json.loads(body_bytes.decode("utf-8"))
    except Exception:
        payload = {}
    raw = {
        "id": str(uuid.uuid4()),
        "source": "WhatsApp",
        "payload": payload,
        "received_at": iso(now_utc()),
        "processed": False,
    }
    await db.webhook_payloads.insert_one(raw.copy())

    created_msgs = 0
    status_updates = 0
    try:
        for entry in (payload.get("entry") or []):
            for change in (entry.get("changes") or []):
                value = change.get("value") or {}
                # ---- Incoming messages ----
                for m in (value.get("messages") or []):
                    from_phone = m.get("from")  # digits, e.g. "919876543210"
                    msg_type = m.get("type")
                    wamid = m.get("id")
                    inbound_context_wamid: Optional[str] = None
                    # Meta sends `context.id` when the user taps "Reply" and quotes one of our messages.
                    try:
                        inbound_context_wamid = (m.get("context") or {}).get("id")
                    except Exception:
                        inbound_context_wamid = None
                    body_text = ""
                    inbound_media_type = None
                    inbound_media_id = None
                    inbound_caption = None
                    inbound_filename = None
                    inbound_mime = None
                    if msg_type == "text":
                        body_text = ((m.get("text") or {}).get("body")) or ""
                    elif msg_type == "image":
                        img = m.get("image") or {}
                        body_text = f"[image] {img.get('caption','')}".strip()
                        inbound_media_type = "image"
                        inbound_media_id = img.get("id")
                        inbound_caption = img.get("caption")
                        inbound_mime = img.get("mime_type")
                    elif msg_type == "document":
                        doc = m.get("document") or {}
                        body_text = f"[document: {doc.get('filename','file')}] {doc.get('caption','')}".strip()
                        inbound_media_type = "document"
                        inbound_media_id = doc.get("id")
                        inbound_caption = doc.get("caption")
                        inbound_filename = doc.get("filename")
                        inbound_mime = doc.get("mime_type")
                    elif msg_type == "audio":
                        aud = m.get("audio") or {}
                        body_text = "[voice note]" if aud.get("voice") else "[audio message]"
                        inbound_media_type = "audio"
                        inbound_media_id = aud.get("id")
                        inbound_mime = aud.get("mime_type")
                    elif msg_type == "video":
                        vid = m.get("video") or {}
                        body_text = f"[video] {vid.get('caption','')}".strip()
                        inbound_media_type = "video"
                        inbound_media_id = vid.get("id")
                        inbound_caption = vid.get("caption")
                        inbound_mime = vid.get("mime_type")
                    elif msg_type == "location":
                        loc = m.get("location") or {}
                        body_text = f"[location: {loc.get('latitude')},{loc.get('longitude')}]"
                    elif msg_type == "contacts":
                        cc = m.get("contacts") or []
                        first_name = ""
                        if cc:
                            first_name = (cc[0].get("name") or {}).get("formatted_name") or ""
                        body_text = f"[contact] {first_name}".strip() or "[contact]"
                    elif msg_type == "button":
                        body_text = f"[button reply] {(m.get('button') or {}).get('text','')}"
                    elif msg_type == "interactive":
                        ia = m.get("interactive") or {}
                        ia_type = ia.get("type")
                        if ia_type == "button_reply":
                            body_text = f"[button] {(ia.get('button_reply') or {}).get('title','')}".strip()
                        elif ia_type == "list_reply":
                            body_text = f"[list] {(ia.get('list_reply') or {}).get('title','')}".strip()
                        else:
                            body_text = f"[interactive] {json.dumps(ia)[:200]}"
                    elif msg_type == "reaction":
                        # Customer reacted to one of our messages (or another of theirs).
                        # Do NOT create a regular message bubble — upsert the reaction onto the target.
                        rx = m.get("reaction") or {}
                        target_wamid = rx.get("message_id")
                        emoji = (rx.get("emoji") or "").strip()
                        target_lead = await _find_lead_by_phone(from_phone or "")
                        if target_wamid and target_lead:
                            target_msg = await db.messages.find_one(
                                {"wamid": target_wamid, "lead_id": target_lead["id"]},
                                {"_id": 0},
                            )
                            if target_msg:
                                reactions = [r for r in (target_msg.get("reactions") or [])
                                             if not (r.get("direction") == "in" and (r.get("from_phone") == from_phone))]
                                if emoji:
                                    reactions.append({
                                        "emoji": emoji,
                                        "direction": "in",
                                        "from_phone": from_phone,
                                        "wamid": wamid,
                                        "at": iso(now_utc()),
                                    })
                                await db.messages.update_one(
                                    {"id": target_msg["id"]},
                                    {"$set": {"reactions": reactions}},
                                )
                            else:
                                logger.info(f"Inbound reaction for unknown wamid={target_wamid} (lead={target_lead['id'][:8]})")
                        continue  # do not fall through to create a normal msg_doc
                    else:
                        body_text = f"[{msg_type}]"

                    lead = await _find_lead_by_phone(from_phone or "")
                    if not lead:
                        # Auto-create a lead so we don't lose the inbound enquiry
                        sender_name = ""
                        try:
                            sender_name = ((value.get("contacts") or [{}])[0].get("profile") or {}).get("name") or ""
                        except Exception:
                            pass
                        data = {
                            "customer_name": sender_name or f"WhatsApp +{from_phone}",
                            "phone": from_phone,
                            "requirement": body_text[:200],
                            "source": "WhatsApp",
                            "source_data": {"channel": "whatsapp_inbound", "wamid": wamid},
                            "dedup_hash": _lead_dedup_hash(sender_name or "wa", from_phone or "", wamid or ""),
                            "has_whatsapp": True,
                        }
                        lead = await _create_lead_internal(data, by_user_id=None)
                    msg_doc = {
                        "id": str(uuid.uuid4()),
                        "lead_id": lead["id"],
                        "direction": "in",
                        "body": body_text,
                        "wamid": wamid,
                        "msg_type": msg_type,
                        "status": "received",
                        "at": iso(now_utc()),
                        "by_user_id": None,
                        # Phone attribution — required for /leads per-phone history
                        # filter to surface inbound messages too. `from` is the
                        # customer's number; `to_phone` is our business number that
                        # received it (display_phone_number from the webhook).
                        "from": from_phone or "",
                        "to_phone": (value.get("metadata") or {}).get("display_phone_number") or "",
                    }
                    # Quoted-reply context from the customer
                    if inbound_context_wamid:
                        quoted = await db.messages.find_one(
                            {"wamid": inbound_context_wamid, "lead_id": lead["id"]},
                            {"_id": 0, "id": 1, "body": 1, "caption": 1, "direction": 1},
                        )
                        msg_doc["reply_to_wamid"] = inbound_context_wamid
                        if quoted:
                            msg_doc["reply_to_message_id"] = quoted["id"]
                            msg_doc["reply_to_preview"] = (quoted.get("caption") or quoted.get("body") or "")[:120]
                    if inbound_media_type:
                        msg_doc["media_type"] = inbound_media_type
                        if inbound_media_id:
                            msg_doc["media_id"] = inbound_media_id
                        if inbound_caption:
                            msg_doc["caption"] = inbound_caption
                        if inbound_filename:
                            msg_doc["filename"] = inbound_filename
                        if inbound_mime:
                            msg_doc["mime_type"] = inbound_mime
                        # Download the blob from Meta and re-serve it from /api/media
                        # so the chat UI can render the actual image/video/document/audio.
                        if inbound_media_id:
                            try:
                                dl = await _download_wa_media(inbound_media_id, mime_hint=inbound_mime, request=request)
                                if dl and dl.get("url"):
                                    msg_doc["media_url"] = dl["url"]
                                    msg_doc["media_stored_name"] = dl.get("stored_name")
                                    # If WhatsApp gave us a real filename for documents, overwrite the default
                                    if inbound_filename and dl.get("stored_name"):
                                        await db.media_files.update_one(
                                            {"stored_name": dl["stored_name"]},
                                            {"$set": {"original_filename": inbound_filename}},
                                        )
                            except Exception as _e:
                                logger.warning(f"Inbound media cache failed: {_e}")
                    # Structured location / contacts payload
                    if msg_type == "location":
                        loc = m.get("location") or {}
                        msg_doc["msg_type"] = "location"
                        msg_doc["location"] = {
                            "latitude": loc.get("latitude"),
                            "longitude": loc.get("longitude"),
                            "name": loc.get("name"),
                            "address": loc.get("address"),
                        }
                    elif msg_type == "contacts":
                        msg_doc["msg_type"] = "contacts"
                        msg_doc["contacts"] = m.get("contacts") or []
                    await db.messages.insert_one(msg_doc.copy())
                    await db.leads.update_one(
                        {"id": lead["id"]},
                        {"$set": {
                            "last_action_at": iso(now_utc()),
                            "last_user_message_at": iso(now_utc()),
                            "last_message_at": msg_doc["at"],
                            "has_whatsapp": True,
                            f"wa_status_map.{(_normalize_phone(from_phone or '')[-10:] or 'unk')}": True,
                        }},
                    )
                    created_msgs += 1

                    # ---- Attendance-aware urgent reassign ----
                    # Customer messaged, but the assigned exec is on leave / never
                    # punched in / already punched out → hand the conversation to an
                    # available exec immediately (office hours only, so assignments
                    # don't churn every night).
                    try:
                        assigned_uid = lead.get("assigned_to")
                        att_cfg = await get_attendance_config()
                        if assigned_uid and att_cfg.get("attendance_routing_enabled", True) and await _office_open_now(att_cfg):
                            owner = await db.users.find_one({"id": assigned_uid, "active": True}, {"_id": 0, "password_hash": 0})
                            owner_ok = False
                            if owner:
                                if not await _is_user_on_leave(assigned_uid):
                                    owner_ok = await _is_user_available_by_attendance(owner)
                            if not owner_ok:
                                new_uid = await _auto_reassign_lead(lead["id"], assigned_uid, "wa_inbound_owner_unavailable")
                                if new_uid:
                                    await db.leads.update_one({"id": lead["id"]}, {"$set": {
                                        "last_reassigned_at": iso(now_utc()),
                                        "sort_at": iso(now_utc()),
                                        "wa_reassign_notice": {
                                            "from_user_id": assigned_uid,
                                            "from_user_name": (owner or {}).get("name"),
                                            "to_user_id": new_uid,
                                            "at": iso(now_utc()),
                                            "reason": "customer_message_while_owner_away",
                                        },
                                    }})
                                    logger.info(f"WA inbound: lead {lead['id'][:8]} reassigned {assigned_uid} → {new_uid} (owner away)")
                    except Exception as _e:
                        logger.warning(f"inbound availability reassign failed: {_e}")

                    # ---- Auto-Reply Sequence Trigger ----
                    if not lead.get("auto_reply_sequence_triggered"):
                        # Only consume the first-time token when the sequence is actually live.
                        # This prevents permanently locking leads whose first reply predated
                        # the feature being set up — if disabled, the next inbound message
                        # from the same customer will still be eligible to trigger it.
                        _seq_check = await db.system_settings.find_one(
                            {"key": "auto_reply_sequence"},
                            {"_id": 0, "is_active": 1, "quick_reply_ids": 1}
                        )
                        if _seq_check and _seq_check.get("is_active") and _seq_check.get("quick_reply_ids"):
                            updated_lead = await db.leads.find_one_and_update(
                                {"id": lead["id"], "auto_reply_sequence_triggered": {"$ne": True}},
                                {"$set": {"auto_reply_sequence_triggered": True}},
                                return_document=True
                            )
                            if updated_lead:
                                asyncio.create_task(_trigger_auto_sequence(lead["id"], from_phone or lead.get("phone")))

                    # ---- Flow engine dispatch (interactive replies) ----
                    if msg_type == "interactive":
                        try:
                            flow_res = await handle_flow_inbound(from_phone or "", m.get("interactive") or {}, lead)
                            if flow_res:
                                logger.info(f"Flow dispatch for {from_phone}: {flow_res}")
                        except Exception as e:
                            logger.exception(f"Flow dispatch failed: {e}")

                # ---- Delivery status updates ----
                for s in (value.get("statuses") or []):
                    wamid = s.get("id")
                    status = s.get("status")  # sent | delivered | read | failed
                    err = None
                    if s.get("errors"):
                        try:
                            err = s["errors"][0].get("title") or s["errors"][0].get("message")
                        except Exception:
                            pass
                    upd = {"status": status}
                    if err:
                        upd["error"] = err
                    if wamid:
                        await db.messages.update_one({"wamid": wamid}, {"$set": upd})
                        status_updates += 1
    except Exception as e:
        logger.exception(f"WA webhook processing error: {e}")
    finally:
        await db.webhook_payloads.update_one(
            {"id": raw["id"]},
            {"$set": {"processed": True, "messages_created": created_msgs, "status_updates": status_updates}},
        )
    return {"ok": True}

# ------------- Auto-reassignment task -------------

MAX_AUTO_REASSIGN_HOPS = 3

async def _auto_reassign_lead(lead_id: str, current_assigned_to: Optional[str], reason: str,
                              reset_hop_count: bool = False) -> Optional[str]:
    """Auto-reassign a lead to the next executive in the rotation.

    - opened_at IS reset (the new owner hasn't opened it), but every hop
      increments auto_reassign_count; the cron passes stop picking a lead up
      once it hits MAX_AUTO_REASSIGN_HOPS, so a lead nobody opens can bounce at
      most 3 times instead of ping-ponging every 10 minutes forever.
    - last_reassigned_at / sort_at are set so the lead bubbles to the TOP of
      the new owner's list (before this, auto-reassigned leads stayed buried
      under newer leads and the new owner never saw them).
    - Conditional findOneAndUpdate (optimistic lock): if two workers race on
      the same lead, only the first write succeeds.
    """
    chosen = await pick_next_executive(exclude_user_id=current_assigned_to)
    if not chosen:
        return None
    chosen_id = chosen["id"]
    if chosen_id == current_assigned_to:
        return None  # no eligible alternative
    now_iso = iso(now_utc())
    entry = {"user_id": chosen_id, "at": now_iso, "by": None}
    update: Dict[str, Any] = {
        "$set": {
            "assigned_to": chosen_id,
            "last_assignment_at": now_iso,
            "last_action_at": now_iso,
            "last_reassigned_at": now_iso,
            "sort_at": now_iso,
            "opened_at": None,
        },
        "$push": {"assignment_history": entry},
    }
    if reset_hop_count:
        update["$set"]["auto_reassign_count"] = 1
    else:
        update["$inc"] = {"auto_reassign_count": 1}
    result = await db.leads.find_one_and_update(
        {"id": lead_id, "assigned_to": current_assigned_to},   # ← optimistic lock condition
        update,
        return_document=False,
    )
    if result is None:
        # Another worker already reassigned this lead; skip logging.
        return None
    await log_activity(None, reason, lead_id, {"from": current_assigned_to, "to": chosen_id})
    return chosen_id


_AUTO_REASSIGN_LOCK_KEY = "auto_reassign_lock"


async def _acquire_reassign_lock(ttl_seconds: int = 90) -> bool:
    """Distributed MongoDB lock so only ONE uvicorn worker runs the cron job.
    Returns True if the lock was acquired, False if another worker holds it."""
    now = now_utc()
    expires_at = now + timedelta(seconds=ttl_seconds)
    try:
        await db.system_locks.find_one_and_update(
            {
                "key": _AUTO_REASSIGN_LOCK_KEY,
                "$or": [
                    {"expires_at": {"$lt": now}},          # stale lock — steal it
                    {"expires_at": {"$exists": False}},    # first run
                ],
            },
            {"$set": {"key": _AUTO_REASSIGN_LOCK_KEY, "acquired_at": now, "expires_at": expires_at}},
            upsert=True,
            return_document=False,
        )
        return True
    except Exception:
        # Duplicate-key / write-conflict → another worker already has the lock
        return False


async def _release_reassign_lock():
    try:
        await db.system_locks.delete_one({"key": _AUTO_REASSIGN_LOCK_KEY})
    except Exception:
        pass


async def auto_reassign_task():
    # BUG FIX: Distributed lock prevents multiple uvicorn workers from running
    # this simultaneously, which caused the same lead to be written 2-3× at the
    # same timestamp (e.g. "Ankita → Ankita" repeated 3 times).
    if not await _acquire_reassign_lock(ttl_seconds=90):
        logger.debug("auto_reassign_task: lock held by another worker — skipping")
        return
    try:
        rules = await get_routing_rules()
        if not rules.get("round_robin_enabled", True):
            return
        unopened_mins = int(rules.get("unopened_reassign_minutes") or 15)
        noaction_mins = int(rules.get("no_action_reassign_minutes") or 60)
        unopened_cutoff = iso(now_utc() - timedelta(minutes=unopened_mins))
        noaction_cutoff = iso(now_utc() - timedelta(minutes=noaction_mins))

        # Only portal leads (IndiaMART / JustDial / ExportersIndia) take part in
        # auto-reassignment; hop cap stops the infinite ping-pong that was
        # generating ~80k reassignments/day and scrambling the round robin.
        rr_source = {"$regex": ROUND_ROBIN_SOURCE_REGEX, "$options": "i"}
        under_cap = {"$or": [{"auto_reassign_count": {"$exists": False}},
                             {"auto_reassign_count": {"$lt": MAX_AUTO_REASSIGN_HOPS}}]}

        # Unopened: assigned but not opened within X minutes (oldest first so a
        # backlog never starves the oldest leads)
        cursor = db.leads.find({
            "assigned_to": {"$ne": None},
            "opened_at": None,
            "status": "new",
            "source": rr_source,
            "last_assignment_at": {"$lt": unopened_cutoff},
            **under_cap,
        }, {"_id": 0, "id": 1, "assigned_to": 1}).sort("last_assignment_at", 1).limit(20)
        async for lead in cursor:
            await _auto_reassign_lead(lead["id"], lead.get("assigned_to"), "auto_reassigned_unopened")

        # No action: opened but no activity within Y minutes (still status='new')
        cursor2 = db.leads.find({
            "assigned_to": {"$ne": None},
            "status": "new",
            "source": rr_source,
            "last_action_at": {"$lt": noaction_cutoff},
            "opened_at": {"$ne": None},
            **under_cap,
        }, {"_id": 0, "id": 1, "assigned_to": 1}).sort("last_action_at", 1).limit(20)
        async for lead in cursor2:
            await _auto_reassign_lead(lead["id"], lead.get("assigned_to"), "auto_reassigned_noaction")

        # Stale: leads still status='new' N days (default 3) after their last assignment
        # → force a fresh round-robin so no enquiry rots in a dead queue. This pass
        # RESETS the hop counter, giving capped leads a fresh chance every N days.
        try:
            att_cfg = await get_attendance_config()
            stale_days = int(att_cfg.get("stale_new_days") or 3)
            stale_cutoff = iso(now_utc() - timedelta(days=stale_days))
            cursor3 = db.leads.find({
                "assigned_to": {"$ne": None},
                "status": "new",
                "source": rr_source,
                "last_assignment_at": {"$lt": stale_cutoff},
            }, {"_id": 0, "id": 1, "assigned_to": 1}).sort("last_assignment_at", 1).limit(20)
            async for lead in cursor3:
                await _auto_reassign_lead(lead["id"], lead.get("assigned_to"), "auto_reassigned_stale", reset_hop_count=True)
        except Exception as e:
            logger.warning(f"stale-new reassign pass failed: {e}")

        # Followups: mark missed
        await db.followups.update_many(
            {"status": "pending", "due_at": {"$lt": iso(now_utc() - timedelta(minutes=30))}},
            {"$set": {"status": "missed"}},
        )
    except Exception as e:
        logger.exception(f"auto_reassign_task failed: {e}")
    finally:
        await _release_reassign_lock()


async def reorder_reminder_task():
    """Daily: find OMS customers whose LAST order is 30+ days old, match them to
    their CRM lead, and drop a follow-up on the lead owner's queue with the
    previous order's details so they can pitch a repeat order.
    One reminder per (customer, last order) — dedup key prevents daily nagging;
    a fresh reminder only fires after the customer places (and then lapses on)
    a NEW order."""
    try:
        cutoff = iso(now_utc() - timedelta(days=30))
        created = 0
        pipeline = [
            {"$sort": {"created_at": -1}},
            {"$group": {"_id": "$customer_id", "last": {"$first": "$$ROOT"}}},
            {"$match": {"last.created_at": {"$lt": cutoff}}},
        ]
        async for doc in oms_db.orders.aggregate(pipeline):
            if created >= 30:  # cap per day so the first run doesn't flood queues
                break
            o = doc.get("last") or {}
            cust_id = doc.get("_id")
            if not cust_id or not o.get("id"):
                continue
            dedup = f"reorder:{cust_id}:{o['id']}"
            if await db.followups.find_one({"meta.dedup_key": dedup}, {"_id": 1}):
                continue
            cust = await oms_db.customers.find_one({"id": cust_id}, {"_id": 0})
            if not cust:
                continue
            # Match OMS customer → CRM lead by any phone number (suffix match)
            lead = None
            for pn in (cust.get("phone_numbers") or []):
                pat = phone_match_pattern(pn or "")
                if not pat:
                    continue
                lead = await db.leads.find_one(
                    {"$or": [{"phone": {"$regex": pat}}, {"phones": {"$regex": pat}}]},
                    {"_id": 0, "id": 1, "assigned_to": 1, "customer_name": 1})
                if lead:
                    break
            owner = None
            if lead and lead.get("assigned_to"):
                owner = await db.users.find_one(
                    {"id": lead["assigned_to"], "active": True}, {"_id": 0, "id": 1})
            if not owner:
                # No CRM lead / no live owner — tell the admin instead of dropping it
                if not await db.admin_alerts.find_one({"meta.dedup_key": dedup}, {"_id": 1}):
                    await create_system_alert(
                        "reorder_unrouted",
                        f"Reorder chance needs an owner: {cust.get('name')}",
                        f"OMS customer {cust.get('name')} (last order {o.get('order_number')} on "
                        f"{str(o.get('created_at'))[:10]}, ₹{o.get('grand_total')}) hasn't ordered in 30+ days, "
                        f"but has no CRM lead or no active executive assigned. Assign someone to chase the repeat order.",
                        dedup_key=dedup,
                    )
                    created += 1
                continue
            items = o.get("items") or []
            if not isinstance(items, list):
                items = []
            summary = ", ".join(
                f"{i.get('product_name')} × {i.get('qty'):g} {i.get('unit', '')}".strip()
                for i in items[:4] if isinstance(i, dict) and i.get("product_name")
            ) or "items unavailable"
            try:
                days_ago = (now_utc() - datetime.fromisoformat(str(o["created_at"]).replace("Z", "+00:00"))).days
            except Exception:
                days_ago = 30
            note = (f"REORDER NUDGE: {cust.get('name') or lead.get('customer_name')} hasn't ordered in {days_ago} days. "
                    f"Last order {o.get('order_number') or ''} on {str(o.get('created_at'))[:10]}: {summary} "
                    f"(₹{o.get('grand_total')}). Remind them of this order and try to take a repeat order.")
            fu = {
                "id": str(uuid.uuid4()),
                "lead_id": lead["id"],
                "executive_id": lead["assigned_to"],
                "created_by": None,
                "due_at": iso(now_utc() + timedelta(minutes=30)),
                "note": note,
                "status": "pending",
                "created_at": iso(now_utc()),
                "completed_at": None,
                "meta": {"type": "reorder", "dedup_key": dedup, "oms_customer_id": cust_id, "oms_order_id": o["id"]},
            }
            await db.followups.insert_one(fu)
            await log_activity(None, "reorder_reminder_created", lead["id"], {"customer": cust.get("name"), "order": o.get("order_number")})
            created += 1
        if created:
            logger.info(f"reorder_reminder_task: created {created} reorder follow-ups")
    except Exception as e:
        logger.exception(f"reorder_reminder_task failed: {e}")


async def attendance_monitor_task():
    """Every 10 min: raise admin flags for attendance rule breaches.
    All alerts are deduped per employee+date, so re-runs are harmless."""
    try:
        cfg = await get_attendance_config()
        now = _ist_now()
        today = now.strftime("%Y-%m-%d")
        now_m = now.hour * 60 + now.minute
        office_start_m = _hhmm_to_minutes(cfg["office_start"], 630)
        late_until_m = _hhmm_to_minutes(cfg["late_grace_until"], 660)
        half_cutoff_m = _hhmm_to_minutes(cfg["half_day_cutoff"], 900)
        office_end_m = _hhmm_to_minutes(cfg["office_end"], 1140)
        full_out_m = office_end_m - int(cfg.get("full_day_out_grace_minutes") or 0)
        streak_n = int(cfg.get("late_streak_threshold") or 3)

        employees = await db.users.find(
            {"active": True, "role": {"$ne": "admin"}}, {"_id": 0, "password_hash": 0}).to_list(200)
        employees = [u for u in employees if u.get("username") not in ("scanner", "test_user")
                     and (u.get("employee_code") or u.get("role") == "executive")]

        def _mins_of(t):
            try:
                return int(t[11:13]) * 60 + int(t[14:16])
            except Exception:
                return None

        async def _is_workday(d_str):
            dt = datetime.strptime(d_str, "%Y-%m-%d")
            if dt.weekday() == 6:
                return False
            hol = await db.holidays.find_one({"date": d_str}, {"_id": 0, "holiday_type": 1})
            return not (hol and (hol.get("holiday_type") or "full") == "full")

        today_is_workday = await _is_workday(today)

        for u in employees:
            uid = u["id"]
            log = await db.attendance_logs.find_one({"user_id": uid, "date": today}, {"_id": 0})
            in_m = _mins_of((log or {}).get("check_in", {}).get("time") or "")
            out_m = _mins_of(((log or {}).get("check_out") or {}).get("time") or "")

            if today_is_workday and in_m is not None:
                # Arrival after the 11:00 grace — no salary cut, but flag it
                if in_m > late_until_m:
                    await create_system_alert(
                        "late_arrival",
                        f"Late arrival: {u['name']}",
                        f"{u['name']} punched in at {(log or {}).get('check_in', {}).get('time', '')[11:16]} "
                        f"(after {cfg['late_grace_until']}) on {today}.",
                        dedup_key=f"after11:{uid}:{today}",
                    )

                # Consecutive-late streak (arrivals after office_start on consecutive workdays)
                streak = 1 if in_m > office_start_m else 0
                if streak:
                    d = datetime.strptime(today, "%Y-%m-%d")
                    back = 0
                    while streak < streak_n + 3 and back < 10:
                        back += 1
                        d_prev = (d - timedelta(days=back)).strftime("%Y-%m-%d")
                        if not await _is_workday(d_prev):
                            continue
                        prev_log = await db.attendance_logs.find_one({"user_id": uid, "date": d_prev}, {"_id": 0})
                        prev_in = _mins_of((prev_log or {}).get("check_in", {}).get("time") or "")
                        if prev_in is not None and prev_in > office_start_m:
                            streak += 1
                        else:
                            break
                    if streak >= streak_n:
                        await create_system_alert(
                            "late_streak",
                            f"Repeated late arrivals: {u['name']}",
                            f"{u['name']} has arrived after {cfg['office_start']} for {streak} working days in a row "
                            f"(latest: {today}).",
                            dedup_key=f"latestreak:{uid}:{today}",
                        )

            # Early punch-out today (before full-day time, while the office is still open)
            if today_is_workday and out_m is not None and out_m < full_out_m and now_m < office_end_m:
                kind = "FULL DAY CUT (left before 3 PM)" if out_m < half_cutoff_m else "half day"
                await create_system_alert(
                    "early_punch_out",
                    f"Early punch-out: {u['name']}",
                    f"{u['name']} punched out at {((log or {}).get('check_out') or {}).get('time', '')[11:16]} on {today} — "
                    f"counts as {kind}. No new leads will be assigned to them today.",
                    dedup_key=f"earlyout:{uid}:{today}",
                )

            # Yesterday's missing punch-out
            yday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
            if await _is_workday(yday) and (u.get("joining_date") or "0000") <= yday:
                ylog = await db.attendance_logs.find_one({"user_id": uid, "date": yday}, {"_id": 0})
                if ylog and ylog.get("check_in") and not ylog.get("check_out"):
                    await create_system_alert(
                        "missing_punch_out",
                        f"Missing punch-out: {u['name']}",
                        f"{u['name']} punched in on {yday} but never punched out. "
                        f"Payroll counts it as a half day until you correct it in the Payroll page.",
                        dedup_key=f"noout:{uid}:{yday}",
                    )

            # Salary pay-date reminder: pay date = joining-day anniversary + 8.
            # Remind the day BEFORE (and again on the day) until marked paid.
            try:
                jd = u.get("joining_date")
                if jd and float(u.get("base_salary") or 0) > 0:
                    import calendar as _cal
                    jday = int(jd[8:10])
                    t = now.date()

                    def _anchor(y, m):
                        return datetime(y, m, min(jday, _cal.monthrange(y, m)[1])).date()

                    a_cur = _anchor(t.year, t.month)
                    if a_cur > t:
                        pm_y, pm_m = (t.year - 1, 12) if t.month == 1 else (t.year, t.month - 1)
                        a_cur = _anchor(pm_y, pm_m)
                    pm_y, pm_m = (a_cur.year - 1, 12) if a_cur.month == 1 else (a_cur.year, a_cur.month - 1)
                    a_prev = _anchor(pm_y, pm_m)
                    cycle_start = a_prev.strftime("%Y-%m-%d")
                    cycle_end = (a_cur - timedelta(days=1)).strftime("%Y-%m-%d")
                    pay_date = a_cur + timedelta(days=8)
                    delta_days = (pay_date - t).days
                    if delta_days in (0, 1):
                        paid = await db.salary_payments.find_one({
                            "user_id": uid, "period_start": cycle_start,
                            "period_end": cycle_end, "paid": True}, {"_id": 1})
                        if not paid:
                            when = "TOMORROW" if delta_days == 1 else "TODAY"
                            await create_system_alert(
                                "salary_due",
                                f"Salary due {when}: {u['name']}",
                                f"{u['name']}'s salary for {cycle_start} → {cycle_end} is due on {pay_date} "
                                f"(joining day + 8). Open Payroll → their Sheet to review, pay, and tick 'Salary Paid'.",
                                dedup_key=f"salarydue:{uid}:{pay_date}:{when}",
                            )
            except Exception as _pe:
                logger.warning(f"salary reminder failed for {u.get('name')}: {_pe}")
    except Exception as e:
        logger.exception(f"attendance_monitor_task failed: {e}")

# ------------- System settings (WhatsApp runtime overrides) -------------
def _mask_token(t: str) -> str:
    if not t or len(t) < 12:
        return t or ""
    return t[:6] + "…" + t[-4:] + f" ({len(t)} chars)"

class WhatsAppSettingsInput(BaseModel):
    access_token: Optional[str] = None
    phone_number_id: Optional[str] = None
    waba_id: Optional[str] = None
    api_version: Optional[str] = None
    verify_token: Optional[str] = None
    app_secret: Optional[str] = None
    default_template: Optional[str] = None
    default_template_lang: Optional[str] = None

@api.get("/settings/whatsapp")
async def get_whatsapp_settings(admin: dict = Depends(require_admin)):
    """Returns effective WhatsApp config (access_token masked) + env defaults and DB overrides
    so the admin UI can show what's coming from where."""
    effective = await get_wa_config()
    db_doc = await db.system_settings.find_one({"key": "whatsapp"}, {"_id": 0}) or {}
    # Mask any token fields before returning
    safe_effective = dict(effective)
    safe_effective["access_token_masked"] = _mask_token(effective.get("access_token") or "")
    safe_effective.pop("access_token", None)
    safe_effective["app_secret_masked"] = _mask_token(effective.get("app_secret") or "")
    safe_effective.pop("app_secret", None)
    safe_overrides = {k: v for k, v in db_doc.items() if k != "key"}
    if "access_token" in safe_overrides:
        safe_overrides["access_token_masked"] = _mask_token(safe_overrides.pop("access_token") or "")
    if "app_secret" in safe_overrides:
        safe_overrides["app_secret_masked"] = _mask_token(safe_overrides.pop("app_secret") or "")
    env_defaults = dict(_WA_ENV_DEFAULTS)
    env_defaults["access_token_masked"] = _mask_token(env_defaults.pop("access_token") or "")
    env_defaults["app_secret_masked"] = _mask_token(env_defaults.pop("app_secret") or "")
    return {
        "effective": safe_effective,
        "overrides": safe_overrides,
        "env_defaults": env_defaults,
        "editable_fields": _WA_EDITABLE_FIELDS,
    }


@api.put("/settings/whatsapp")
async def update_whatsapp_settings(body: WhatsAppSettingsInput, admin: dict = Depends(require_admin)):
    """Update WhatsApp runtime overrides. Empty string clears an override so the .env default
    takes back over. Any field not provided in the request is left untouched."""
    patch: Dict[str, Any] = {}
    unset: Dict[str, Any] = {}
    for f in _WA_EDITABLE_FIELDS:
        v = getattr(body, f)
        if v is None:
            continue  # field not in request body
        if isinstance(v, str):
            v = v.strip()
        if v == "":
            unset[f] = ""
        else:
            patch[f] = v
    if not patch and not unset:
        raise HTTPException(status_code=400, detail="No changes supplied")
    update_ops: Dict[str, Any] = {}
    if patch:
        update_ops["$set"] = {"key": "whatsapp", **patch, "updated_by": admin["id"], "updated_at": iso(now_utc())}
    if unset:
        update_ops["$unset"] = unset
        update_ops.setdefault("$set", {}).update({"updated_by": admin["id"], "updated_at": iso(now_utc()), "key": "whatsapp"})
    await db.system_settings.update_one({"key": "whatsapp"}, update_ops, upsert=True)
    await log_activity(admin["id"], "whatsapp_settings_updated", None, {"changed": list(patch.keys()), "cleared": list(unset.keys())})
    # return fresh effective config
    effective = await get_wa_config()
    safe = {k: (_mask_token(v) if k in ("access_token", "app_secret") and isinstance(v, str) else v) for k, v in effective.items()}
    return {"ok": True, "effective": safe}


# ------------- WhatsApp Auto-Sequence -------------
class AutoSequenceInput(BaseModel):
    is_active: bool
    quick_reply_ids: List[str]


@api.get("/settings/auto-sequence")
async def get_auto_sequence(admin: dict = Depends(require_admin)):
    doc = await db.system_settings.find_one({"key": "auto_reply_sequence"}, {"_id": 0})
    if not doc:
        return {"is_active": False, "quick_reply_ids": []}
    return {"is_active": doc.get("is_active", False), "quick_reply_ids": doc.get("quick_reply_ids", [])}


@api.put("/settings/auto-sequence")
async def update_auto_sequence(body: AutoSequenceInput, admin: dict = Depends(require_admin)):
    await db.system_settings.update_one(
        {"key": "auto_reply_sequence"},
        {"$set": {
            "key": "auto_reply_sequence",
            "is_active": body.is_active,
            "quick_reply_ids": body.quick_reply_ids,
            "updated_by": admin["id"],
            "updated_at": iso(now_utc())
        }},
        upsert=True
    )
    return {"ok": True}


async def _trigger_auto_sequence(lead_id: str, target_phone: str):
    try:
        # Give Meta/Webhook a brief moment to finish updating before firing out
        await asyncio.sleep(1)
        doc = await db.system_settings.find_one({"key": "auto_reply_sequence"}, {"_id": 0})
        if not doc or not doc.get("is_active") or not doc.get("quick_reply_ids"):
            return
        
        for qr_id in doc["quick_reply_ids"]:
            api_result = {}
            body_val = ""
            extra = {}

            # 0. Inline custom text message (stored with __custom__: prefix)
            if qr_id.startswith("__custom__:"):
                custom_text = qr_id[len("__custom__:"):].strip()
                if not custom_text:
                    await asyncio.sleep(1.5)
                    continue
                api_result = await wa_send_text(to_phone=target_phone, body=custom_text)
                body_val = custom_text

            else:
                qr = await db.quick_replies.find_one({"id": qr_id})

                if qr:
                    # 1. Send as Quick Reply (freeform)
                    if qr.get("media_url"):
                        api_result = await wa_send_media(
                            to_phone=target_phone,
                            media_type=qr.get("media_type") or "document",
                            url=qr["media_url"],
                            caption=qr.get("caption") or qr.get("text"),
                            filename=qr.get("media_filename")
                        )
                    else:
                        api_result = await wa_send_text(
                            to_phone=target_phone,
                            body=qr.get("text") or ""
                        )
                    body_val = qr.get("text") or ""
                    if qr.get("media_url"):
                        extra["media_type"] = qr.get("media_type")
                        extra["media_url"] = qr["media_url"]
                        extra["filename"] = qr.get("media_filename")
                        extra["caption"] = qr.get("caption") or qr.get("text")
                else:
                    # 2. Search in WhatsApp Templates
                    tpl = await db.whatsapp_templates.find_one({"$or": [{"id": qr_id}, {"name": qr_id}]})
                    if not tpl:
                        logger.warning(f"Auto-sequence: item '{qr_id}' not found as quick reply or template — skipping")
                        await asyncio.sleep(1.5)
                        continue

                    wa_cfg = await get_wa_config()
                    params_required = int(tpl.get("params_required") or 0)
                    params_to_send = None
                    if params_required > 0:
                        lead_doc = await db.leads.find_one({"id": lead_id})
                        cust_name = lead_doc.get("customer_name", "Customer") if lead_doc else "Customer"
                        params_to_send = [cust_name] + [""] * (params_required - 1)

                    api_result = await wa_send_template(
                        to_phone=target_phone,
                        template_name=tpl["name"],
                        lang_code=tpl.get("language") or wa_cfg["default_template_lang"],
                        body_params=params_to_send
                    )

                    body_val = tpl.get("body") or f"[Template: {tpl['name']}]"
                    if params_to_send and tpl.get("body"):
                        try:
                            body_val = tpl["body"].replace("{{1}}", params_to_send[0])
                        except Exception:
                            pass
                    extra = {"template_name": tpl["name"]}

            msg = {
                "id": str(uuid.uuid4()),
                "lead_id": lead_id,
                "direction": "out",
                "body": body_val,
                "to_phone": target_phone,
                "status": api_result.get("status", "failed"),
                "wamid": api_result.get("wamid"),
                "error": api_result.get("error"),
                "error_code": api_result.get("code"),
                "at": iso(now_utc()),
                "by_user_id": None,  # automated
                **extra
            }
            await db.messages.insert_one(msg)
            await db.leads.update_one(
                {"id": lead_id},
                {"$set": {
                    "last_action_at": iso(now_utc()),
                    "last_message_at": msg["at"],
                    "has_whatsapp": True,
                }}
            )
            # Short wait before sending next to guarantee order on client device
            await asyncio.sleep(1.5)
            
    except Exception as e:
        logger.exception(f"Auto-sequence failed for lead {lead_id}: {e}")

# ------------- Email Auto-Send (SMTP) -------------
EMAIL_DEFAULT_HOST = "smtp.hostinger.com"
EMAIL_DEFAULT_PORT = 465
EMAIL_DEFAULT_SECURITY = "ssl"  # ssl | tls | none
_EMAIL_EDITABLE_FIELDS = ("host", "port", "security", "email", "password", "from_name", "enabled")


class EmailSettingsInput(BaseModel):
    host: Optional[str] = None
    port: Optional[int] = None
    security: Optional[Literal["ssl", "tls", "none"]] = None
    email: Optional[str] = None
    password: Optional[str] = None
    from_name: Optional[str] = None
    enabled: Optional[bool] = None


class EmailAttachmentInput(BaseModel):
    stored_name: str
    original_filename: str
    mime_type: Optional[str] = None


class EmailTemplateInput(BaseModel):
    subject: Optional[str] = None
    body: Optional[str] = None
    attachments: Optional[List[EmailAttachmentInput]] = None


class EmailTestSendInput(BaseModel):
    to: str
    subject: Optional[str] = None
    body: Optional[str] = None


class LeadEmailInput(BaseModel):
    email: str


async def _get_email_smtp_config() -> Dict[str, Any]:
    """Returns the effective SMTP config — DB overrides over defaults. Password
    returned in clear-text only for internal sender use; admin endpoints mask it."""
    doc = await db.system_settings.find_one({"key": "email_smtp"}, {"_id": 0}) or {}
    return {
        "host": doc.get("host") or EMAIL_DEFAULT_HOST,
        "port": int(doc.get("port") or EMAIL_DEFAULT_PORT),
        "security": doc.get("security") or EMAIL_DEFAULT_SECURITY,
        "email": doc.get("email") or "",
        "password": doc.get("password") or "",
        "from_name": doc.get("from_name") or "",
        "enabled": bool(doc.get("enabled")),
    }


async def _get_email_template() -> Dict[str, Any]:
    doc = await db.system_settings.find_one({"key": "email_template"}, {"_id": 0}) or {}
    return {
        "subject": doc.get("subject") or "",
        "body": doc.get("body") or "",
        "attachments": list(doc.get("attachments") or []),
    }


_EMAIL_REGEX = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _is_valid_email(value: Optional[str]) -> bool:
    return bool(value) and bool(_EMAIL_REGEX.match((value or "").strip()))


def _render_email_var(text: str, lead: Dict[str, Any], to_email: str = "") -> str:
    """Substitute {{name}} {{requirement}} {{phone}} {{email}} {{source}} placeholders."""
    if not text:
        return ""
    out = text
    out = out.replace("{{name}}", (lead.get("customer_name") or "").strip())
    out = out.replace("{{requirement}}", (lead.get("requirement") or "").strip())
    out = out.replace("{{phone}}", (lead.get("phone") or "").strip())
    out = out.replace("{{email}}", (to_email or lead.get("email") or "").strip())
    out = out.replace("{{source}}", (lead.get("source") or "").strip())
    return out


def _looks_like_html(text: str) -> bool:
    """Heuristic: body is HTML if it contains common HTML tags."""
    if not text:
        return False
    sample = text.lower()
    return bool(re.search(r"<\s*(html|body|table|div|p|h[1-6]|br|img|a|span|strong|em|ul|ol|li|tr|td|tbody)[\s>]", sample))


def _html_to_plain(html: str) -> str:
    """Strip HTML tags for the text/plain alternative part."""
    if not html:
        return ""
    try:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup.find_all(["br", "p", "tr", "li", "div"]):
            tag.append("\n")
        text = soup.get_text(" ")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n+", "\n", text).strip()
        return text
    except Exception:
        return re.sub(r"<[^>]+>", "", html)


def _smtp_send_blocking(cfg: Dict[str, Any], to_email: str, subject: str, body: str, attachments: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Synchronous SMTP send executed in a thread. Returns {ok, error?}.
    Auto-detects HTML in `body` and sends as multipart/alternative with a
    plain-text fallback. Plain-text bodies are sent as text/plain."""
    msg = EmailMessage()
    from_name = (cfg.get("from_name") or "").strip()
    sender_email = (cfg.get("email") or "").strip()
    msg["From"] = f'"{from_name}" <{sender_email}>' if from_name else sender_email
    msg["To"] = to_email
    msg["Subject"] = subject or ""
    is_html = _looks_like_html(body or "")
    if is_html:
        # Set plain-text fallback first, then add HTML alternative.
        msg.set_content(_html_to_plain(body or "") or " ", subtype="plain")
        msg.add_alternative(body or "", subtype="html")
    else:
        msg.set_content(body or "", subtype="plain")
    # Attach files from /app/backend/uploads/<stored_name>
    for att in attachments or []:
        try:
            stored = (att.get("stored_name") or "").strip()
            if not stored:
                continue
            path = ROOT_DIR / "uploads" / stored
            if not path.exists():
                logger.warning(f"Email attachment missing on disk: {stored}")
                continue
            with open(path, "rb") as fh:
                data = fh.read()
            mime = (att.get("mime_type") or "application/octet-stream").split("/", 1)
            maintype = mime[0] if len(mime) > 0 else "application"
            subtype = mime[1] if len(mime) > 1 else "octet-stream"
            msg.add_attachment(
                data,
                maintype=maintype,
                subtype=subtype,
                filename=att.get("original_filename") or stored,
            )
        except Exception as e:
            logger.warning(f"Skipping email attachment {att}: {e}")
    host = cfg.get("host") or EMAIL_DEFAULT_HOST
    port = int(cfg.get("port") or EMAIL_DEFAULT_PORT)
    security = (cfg.get("security") or EMAIL_DEFAULT_SECURITY).lower()
    user = (cfg.get("email") or "").strip()
    password = (cfg.get("password") or "").strip()
    try:
        if security == "ssl":
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, timeout=30, context=ctx) as smtp:
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(msg)
        elif security == "tls":
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(msg)
        return {"ok": True}
    except Exception as e:
        logger.exception(f"SMTP send failed to {to_email}: {e}")
        return {"ok": False, "error": str(e)[:300]}


async def _smtp_send_async(cfg: Dict[str, Any], to_email: str, subject: str, body: str, attachments: List[Dict[str, Any]]) -> Dict[str, Any]:
    return await asyncio.get_event_loop().run_in_executor(
        None, _smtp_send_blocking, cfg, to_email, subject, body, attachments
    )


async def _record_email_log(lead_id: Optional[str], to_email: str, subject: str, body: str, ok: bool, error: Optional[str], trigger: str) -> None:
    await db.email_send_logs.insert_one({
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "to": to_email,
        "subject": subject,
        "body_preview": (body or "")[:300],
        "status": "sent" if ok else "failed",
        "error": error,
        "trigger": trigger,
        "at": iso(now_utc()),
    })


async def auto_send_email_to_address(lead: Dict[str, Any], address: str, trigger: str = "lead_created") -> Optional[Dict[str, Any]]:
    """Send the configured email template to one address for one lead. Idempotent —
    skips if address is already in lead.email_sent_to. Returns the SMTP result."""
    addr = (address or "").strip()
    if not _is_valid_email(addr):
        return None
    cfg = await _get_email_smtp_config()
    if not cfg.get("enabled"):
        return None
    if not (cfg.get("host") and cfg.get("email") and cfg.get("password")):
        logger.info(f"Email auto-send skipped — SMTP not fully configured (lead={lead.get('id')})")
        return None
    # Refresh from DB so concurrent updates don't double-send
    fresh = await db.leads.find_one({"id": lead["id"]}, {"_id": 0, "email_sent_to": 1}) or {}
    already = set((fresh.get("email_sent_to") or []))
    norm = addr.lower()
    if norm in {a.lower() for a in already}:
        return {"ok": True, "skipped": "already_sent"}
    tpl = await _get_email_template()
    subject = _render_email_var(tpl.get("subject") or "", lead, addr)
    body = _render_email_var(tpl.get("body") or "", lead, addr)
    if not subject and not body:
        logger.info(f"Email auto-send skipped — empty template (lead={lead.get('id')})")
        return None
    res = await _smtp_send_async(cfg, addr, subject, body, tpl.get("attachments") or [])
    await _record_email_log(lead.get("id"), addr, subject, body, bool(res.get("ok")), res.get("error"), trigger)
    if res.get("ok"):
        await db.leads.update_one(
            {"id": lead["id"]},
            {"$addToSet": {"email_sent_to": addr}, "$set": {"last_email_sent_at": iso(now_utc())}},
        )
    return res


async def auto_send_email_on_create(lead: Dict[str, Any]) -> None:
    """Send the configured template to lead.email + every entry in lead.emails[].
    Triggered after _create_lead_internal. Best-effort — failures are logged
    but never block lead creation."""
    addresses: List[str] = []
    if lead.get("email"):
        addresses.append((lead.get("email") or "").strip())
    for e in lead.get("emails") or []:
        if e and e not in addresses:
            addresses.append(e.strip())
    addresses = [a for a in addresses if _is_valid_email(a)]
    if not addresses:
        return
    for a in addresses:
        try:
            await auto_send_email_to_address(lead, a, trigger="lead_created")
        except Exception as e:
            logger.warning(f"auto_send_email_on_create failed for {a}: {e}")


@api.get("/settings/email")
async def get_email_settings(admin: dict = Depends(require_admin)):
    cfg = await _get_email_smtp_config()
    return {
        "host": cfg["host"],
        "port": cfg["port"],
        "security": cfg["security"],
        "email": cfg["email"],
        "password_masked": _mask_token(cfg["password"] or ""),
        "has_password": bool(cfg["password"]),
        "from_name": cfg["from_name"],
        "enabled": cfg["enabled"],
    }


@api.put("/settings/email")
async def update_email_settings(body: EmailSettingsInput, admin: dict = Depends(require_admin)):
    patch: Dict[str, Any] = {}
    unset: Dict[str, Any] = {}
    for f in _EMAIL_EDITABLE_FIELDS:
        v = getattr(body, f)
        if v is None:
            continue
        if isinstance(v, str):
            v = v.strip()
        if v == "" and f in ("password", "from_name", "email", "host"):
            unset[f] = ""
        elif f == "port":
            patch[f] = int(v)
        elif f == "security":
            if v not in ("ssl", "tls", "none"):
                raise HTTPException(status_code=400, detail="security must be ssl|tls|none")
            patch[f] = v
        elif f == "enabled":
            patch[f] = bool(v)
        else:
            patch[f] = v
    if not patch and not unset:
        raise HTTPException(status_code=400, detail="No changes supplied")
    update_ops: Dict[str, Any] = {}
    if patch:
        update_ops["$set"] = {"key": "email_smtp", **patch, "updated_by": admin["id"], "updated_at": iso(now_utc())}
    if unset:
        update_ops["$unset"] = unset
        update_ops.setdefault("$set", {}).update({"key": "email_smtp", "updated_by": admin["id"], "updated_at": iso(now_utc())})
    await db.system_settings.update_one({"key": "email_smtp"}, update_ops, upsert=True)
    await log_activity(admin["id"], "email_settings_updated", None, {"changed": list(patch.keys()), "cleared": list(unset.keys())})
    return await get_email_settings(admin=admin)


@api.get("/settings/email-template")
async def get_email_template(admin: dict = Depends(require_admin)):
    return await _get_email_template()


@api.put("/settings/email-template")
async def update_email_template(body: EmailTemplateInput, admin: dict = Depends(require_admin)):
    patch: Dict[str, Any] = {}
    if body.subject is not None:
        patch["subject"] = body.subject
    if body.body is not None:
        patch["body"] = body.body
    if body.attachments is not None:
        patch["attachments"] = [a.model_dump() for a in body.attachments]
    if not patch:
        raise HTTPException(status_code=400, detail="No changes supplied")
    await db.system_settings.update_one(
        {"key": "email_template"},
        {"$set": {"key": "email_template", **patch, "updated_by": admin["id"], "updated_at": iso(now_utc())}},
        upsert=True,
    )
    return await _get_email_template()


@api.post("/settings/email/test-send")
async def email_test_send(body: EmailTestSendInput, admin: dict = Depends(require_admin)):
    if not _is_valid_email(body.to):
        raise HTTPException(status_code=400, detail="Invalid recipient email")
    cfg = await _get_email_smtp_config()
    if not (cfg.get("host") and cfg.get("email") and cfg.get("password")):
        raise HTTPException(status_code=400, detail="SMTP not fully configured (host/email/password required)")
    tpl = await _get_email_template()
    fake_lead = {"customer_name": "Test User", "requirement": "Sample requirement", "phone": "+91XXXXXXXXXX", "email": body.to, "source": "Test"}
    subject = _render_email_var(body.subject or tpl.get("subject") or "Test email from CRM", fake_lead, body.to)
    body_text = _render_email_var(body.body or tpl.get("body") or "This is a test email.", fake_lead, body.to)
    res = await _smtp_send_async(cfg, body.to, subject, body_text, tpl.get("attachments") or [])
    await _record_email_log(None, body.to, subject, body_text, bool(res.get("ok")), res.get("error"), "test")
    if not res.get("ok"):
        raise HTTPException(status_code=502, detail=f"SMTP send failed: {res.get('error')}")
    return {"ok": True, "to": body.to}


@api.post("/leads/{lead_id}/emails")
async def add_email(lead_id: str, body: LeadEmailInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    new_email = (body.email or "").strip()
    if not _is_valid_email(new_email):
        raise HTTPException(status_code=400, detail="Invalid email")
    existing_primary = (lead.get("email") or "").strip().lower()
    existing_others = [e.lower() for e in (lead.get("emails") or [])]
    if new_email.lower() == existing_primary or new_email.lower() in existing_others:
        raise HTTPException(status_code=409, detail="Email already on this lead")
    update: Dict[str, Any] = {"$set": {"last_action_at": iso(now_utc())}}
    if not lead.get("email"):
        # First email becomes the primary
        update["$set"]["email"] = new_email
    else:
        update["$addToSet"] = {"emails": new_email}
    await db.leads.update_one({"id": lead_id}, update)
    await log_activity(user["id"], "email_added", lead_id, {"email": new_email})
    refreshed = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    # Auto-send the configured template to this newly added address
    try:
        await auto_send_email_to_address(refreshed, new_email, trigger="email_added")
    except Exception as e:
        logger.warning(f"auto_send on email_added failed: {e}")
    return await db.leads.find_one({"id": lead_id}, {"_id": 0})


@api.delete("/leads/{lead_id}/emails")
async def remove_email(lead_id: str, email: str = Query(...), user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target = (email or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="Email required")
    update: Dict[str, Any] = {"$set": {"last_action_at": iso(now_utc())}}
    if (lead.get("email") or "").strip().lower() == target.lower():
        # Promote the next email[] to primary if available
        next_primary = None
        for e in lead.get("emails") or []:
            if (e or "").strip().lower() != target.lower():
                next_primary = e
                break
        update["$set"]["email"] = next_primary
        if next_primary:
            update["$pull"] = {"emails": next_primary}
    else:
        update["$pull"] = {"emails": target}
    await db.leads.update_one({"id": lead_id}, update)
    await log_activity(user["id"], "email_removed", lead_id, {"email": target})
    return await db.leads.find_one({"id": lead_id}, {"_id": 0})


# ------------- Gmail / Justdial integration -------------
import base64
from email.utils import parseaddr

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL", "").strip().rstrip("/")
GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
]
GMAIL_POLL_DEFAULT_SECONDS = max(10, int(os.environ.get("GMAIL_POLL_INTERVAL_SECONDS", "60")))
GMAIL_POLL_MINUTES = max(1, int(os.environ.get("GMAIL_POLL_INTERVAL_MINUTES", "1")))  # legacy fallback
GMAIL_QUERY = os.environ.get("GMAIL_JUSTDIAL_QUERY", "from:instantemail@justdial.com is:unread newer_than:2d")
GMAIL_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)
GMAIL_SLOTS = ("primary", "secondary")


def _normalize_gmail_slot(slot: Optional[str]) -> str:
    s = (slot or "primary").strip().lower()
    if s == "default":  # legacy alias
        return "primary"
    if s not in GMAIL_SLOTS:
        raise HTTPException(status_code=400, detail=f"slot must be one of {list(GMAIL_SLOTS)}")
    return s


async def _ensure_gmail_migrated():
    """Migrate legacy single-connection docs (key='default') to slot='primary'.
    Safe to call multiple times — no-op after first migration."""
    legacy = await db.gmail_connections.find_one({"key": "default"}, {"_id": 0})
    if legacy and not await db.gmail_connections.find_one({"key": "primary"}, {"_id": 0}):
        legacy["key"] = "primary"
        await db.gmail_connections.update_one({"key": "primary"}, {"$set": legacy}, upsert=True)
        await db.gmail_connections.delete_one({"key": "default"})


async def _get_gmail_poll_seconds() -> int:
    """DB override > env default. Min 10s. Returns the effective Gmail poll
    interval in seconds — used at boot AND on every settings change."""
    doc = await db.system_settings.find_one({"key": "gmail_poll"}, {"_id": 0}) or {}
    val = doc.get("interval_seconds")
    if val is None:
        return GMAIL_POLL_DEFAULT_SECONDS
    try:
        return max(10, int(val))
    except Exception:
        return GMAIL_POLL_DEFAULT_SECONDS


async def _reschedule_gmail_poll(new_interval_seconds: int):
    """Update the gmail_poll scheduler job in place so interval changes apply live."""
    global scheduler
    if not scheduler:
        return
    try:
        scheduler.remove_job("gmail_poll")
    except Exception:
        pass
    scheduler.add_job(
        gmail_poll_task, "interval",
        seconds=max(10, int(new_interval_seconds or GMAIL_POLL_DEFAULT_SECONDS)),
        id="gmail_poll", max_instances=1, coalesce=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=5),
    )


class GmailPollSettingsInput(BaseModel):
    interval_seconds: Optional[int] = None


@api.get("/settings/gmail-poll")
async def get_gmail_poll_settings(admin: dict = Depends(require_admin)):
    secs = await _get_gmail_poll_seconds()
    doc = await db.system_settings.find_one({"key": "gmail_poll"}, {"_id": 0}) or {}
    return {
        "interval_seconds": secs,
        "default_seconds": GMAIL_POLL_DEFAULT_SECONDS,
        "min_seconds": 10,
        "is_override": doc.get("interval_seconds") is not None,
        "updated_at": doc.get("updated_at"),
    }


@api.put("/settings/gmail-poll")
async def update_gmail_poll_settings(body: GmailPollSettingsInput, admin: dict = Depends(require_admin)):
    if body.interval_seconds is None:
        raise HTTPException(status_code=400, detail="interval_seconds required")
    secs = max(10, int(body.interval_seconds))
    await db.system_settings.update_one(
        {"key": "gmail_poll"},
        {"$set": {"key": "gmail_poll", "interval_seconds": secs, "updated_by": admin["id"], "updated_at": iso(now_utc())}},
        upsert=True,
    )
    has_gmail_conns = await db.gmail_connections.count_documents({}) > 0
    if GMAIL_ENABLED or has_gmail_conns:
        await _reschedule_gmail_poll(secs)
    await log_activity(admin["id"], "gmail_poll_interval_updated", None, {"interval_seconds": secs})
    return {"ok": True, "interval_seconds": secs}


@api.get("/integrations/gmail/status")
async def gmail_status(user: dict = Depends(get_current_user), slot: Optional[str] = None):
    """Returns status for one slot (if `slot` is supplied) or BOTH slots otherwise.
    Back-compat: legacy key='default' docs are migrated to 'primary' on first read."""
    await _ensure_gmail_migrated()
    secs = await _get_gmail_poll_seconds()
    oauth_enabled = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)
    
    if slot is None:
        out = {
            "enabled": True,
            "oauth_enabled": oauth_enabled,
            "slots": {},
            "redirect_uri": GOOGLE_REDIRECT_URI if oauth_enabled else "",
            "poll_interval_seconds": secs,
            "poll_interval_minutes": max(1, secs // 60),
            "query": GMAIL_QUERY
        }
        for s in GMAIL_SLOTS:
            cfg = await db.gmail_connections.find_one({"key": s}, {"_id": 0, "access_token": 0, "refresh_token": 0, "imap_password": 0})
            last_poll = await db.gmail_polls.find_one({"key": f"last:{s}"}, {"_id": 0})
            out["slots"][s] = {
                "connected": bool(cfg),
                "email": (cfg or {}).get("email"),
                "connection_type": (cfg or {}).get("connection_type") or "oauth",
                "imap_host": (cfg or {}).get("imap_host"),
                "imap_port": (cfg or {}).get("imap_port"),
                "connected_at": (cfg or {}).get("connected_at"),
                "connected_by_user_id": (cfg or {}).get("connected_by"),
                "scopes": (cfg or {}).get("scopes"),
                "expires_at": (cfg or {}).get("expires_at"),
                "last_poll": last_poll,
            }
        return out
        
    s = _normalize_gmail_slot(slot)
    cfg = await db.gmail_connections.find_one({"key": s}, {"_id": 0, "access_token": 0, "refresh_token": 0, "imap_password": 0})
    if not cfg:
        return {
            "enabled": True,
            "oauth_enabled": oauth_enabled,
            "connected": False,
            "slot": s,
            "redirect_uri": GOOGLE_REDIRECT_URI if oauth_enabled else ""
        }
        
    last_poll = await db.gmail_polls.find_one({"key": f"last:{s}"}, {"_id": 0})
    return {
        "enabled": True,
        "oauth_enabled": oauth_enabled,
        "connected": True,
        "slot": s,
        "email": cfg.get("email"),
        "connection_type": cfg.get("connection_type") or "oauth",
        "imap_host": cfg.get("imap_host"),
        "imap_port": cfg.get("imap_port"),
        "connected_at": cfg.get("connected_at"),
        "connected_by_user_id": cfg.get("connected_by"),
        "scopes": cfg.get("scopes"),
        "expires_at": cfg.get("expires_at"),
        "last_poll": last_poll,
        "poll_interval_seconds": secs,
        "poll_interval_minutes": max(1, secs // 60),
        "query": GMAIL_QUERY,
        "redirect_uri": GOOGLE_REDIRECT_URI if oauth_enabled else "",
    }

@api.get("/integrations/gmail/auth/init")
async def gmail_auth_init(admin: dict = Depends(require_admin), slot: Optional[str] = None):
    if not GMAIL_ENABLED:
        raise HTTPException(status_code=400, detail="Gmail integration not configured")
    s = _normalize_gmail_slot(slot)
    # Plain server-side OAuth 2.0 authorization_code — NO PKCE.
    state = str(uuid.uuid4())
    from urllib.parse import urlencode
    params = {
        "response_type": "code",
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "scope": " ".join(GMAIL_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)
    await db.oauth_states.insert_one({
        "state": state,
        "user_id": admin["id"],
        "slot": s,
        "created_at": iso(now_utc()),
        "expires_at": iso(now_utc() + timedelta(minutes=10)),
    })
    return {"auth_url": auth_url, "slot": s}


@api.get("/integrations/gmail/auth/callback")
async def gmail_auth_callback(request: Request):
    """Browser is redirected here by Google after consent.
    Confidential-client token exchange — server POSTs client_secret, no PKCE."""
    params = request.query_params
    code = params.get("code")
    state = params.get("state")
    err = params.get("error")
    redirect_target = f"{FRONTEND_BASE_URL or ''}/integrations"
    if err:
        return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=error&reason={err}"})
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")
    state_doc = await db.oauth_states.find_one({"state": state}, {"_id": 0})
    if not state_doc:
        raise HTTPException(status_code=400, detail="Invalid or expired state")
    await db.oauth_states.delete_one({"state": state})
    slot = _normalize_gmail_slot(state_doc.get("slot") or "primary")
    try:
        # Exchange authorization code for tokens (standard server-side OAuth)
        async with httpx.AsyncClient(timeout=20.0) as cli:
            tok = await cli.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if tok.status_code >= 400:
                raise RuntimeError(f"Google token exchange failed: {tok.status_code} {tok.text[:300]}")
            tdata = tok.json()
            access_token = tdata.get("access_token")
            refresh_token = tdata.get("refresh_token")
            expires_in = int(tdata.get("expires_in") or 3600)
            scope = tdata.get("scope") or " ".join(GMAIL_SCOPES)
            # Fetch the connected email address
            r = await cli.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            email_addr = (r.json() or {}).get("email", "") if r.status_code < 400 else ""
        # Prevent the same Gmail account from occupying both slots
        other_slot = "secondary" if slot == "primary" else "primary"
        other_cfg = await db.gmail_connections.find_one({"key": other_slot}, {"_id": 0, "email": 1})
        if other_cfg and (other_cfg.get("email") or "").lower() == (email_addr or "").lower() and email_addr:
            return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=error&reason=duplicate_account&slot={slot}"})
        doc = {
            "key": slot,
            "slot": slot,
            "email": email_addr,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_uri": "https://oauth2.googleapis.com/token",
            "scopes": scope.split(" "),
            "expires_at": iso(now_utc() + timedelta(seconds=expires_in)),
            "connected_by": state_doc.get("user_id"),
            "connected_at": iso(now_utc()),
        }
        await db.gmail_connections.update_one({"key": slot}, {"$set": doc}, upsert=True)
        return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=connected&email={email_addr}&slot={slot}"})
    except Exception as e:
        logger.exception(f"Gmail OAuth callback failed: {e}")
        return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=error&reason={str(e)[:140]}&slot={slot}"})

@api.post("/integrations/gmail/disconnect")
async def gmail_disconnect(admin: dict = Depends(require_admin), slot: Optional[str] = None):
    await _ensure_gmail_migrated()
    s = _normalize_gmail_slot(slot)
    cfg = await db.gmail_connections.find_one({"key": s}, {"_id": 0})
    if cfg and cfg.get("access_token"):
        try:
            async with httpx.AsyncClient(timeout=10.0) as cli:
                await cli.post("https://oauth2.googleapis.com/revoke", params={"token": cfg["access_token"]})
        except Exception:
            pass
    await db.gmail_connections.delete_one({"key": s})
    await db.gmail_polls.delete_one({"key": f"last:{s}"})
    return {"ok": True, "slot": s}


class ImapConnectInput(BaseModel):
    slot: str
    email: str
    password: str
    host: Optional[str] = "imap.gmail.com"
    port: Optional[int] = 993


@api.post("/integrations/gmail/connect-imap")
async def gmail_connect_imap(body: ImapConnectInput, admin: dict = Depends(require_admin)):
    import imaplib
    s = _normalize_gmail_slot(body.slot)
    host = (body.host or "imap.gmail.com").strip()
    port = body.port or 993
    email_addr = body.email.strip()
    password = body.password.strip()
    
    if not email_addr or not password:
        raise HTTPException(status_code=400, detail="Email and password are required")
        
    try:
        def _check_imap():
            mail = imaplib.IMAP4_SSL(host, port, timeout=15)
            mail.login(email_addr, password)
            mail.select("INBOX")
            mail.logout()
        await asyncio.get_event_loop().run_in_executor(None, _check_imap)
    except Exception as e:
        logger.warning(f"IMAP login verification failed for {email_addr} on {host}: {e}")
        raise HTTPException(status_code=400, detail=f"IMAP login failed: {str(e)}")
        
    other_slot = "secondary" if s == "primary" else "primary"
    other_cfg = await db.gmail_connections.find_one({"key": other_slot}, {"_id": 0, "email": 1})
    if other_cfg and (other_cfg.get("email") or "").lower() == email_addr.lower():
        raise HTTPException(status_code=400, detail="This email is already connected to the other slot")
        
    doc = {
        "key": s,
        "slot": s,
        "email": email_addr,
        "connection_type": "imap",
        "imap_host": host,
        "imap_port": port,
        "imap_password": password,
        "connected_by": admin["id"],
        "connected_at": iso(now_utc()),
    }
    await db.gmail_connections.update_one({"key": s}, {"$set": doc}, upsert=True)
    await db.gmail_polls.delete_one({"key": f"last:{s}"})
    
    # Enable scheduler job
    secs = await _get_gmail_poll_seconds()
    await _reschedule_gmail_poll(secs)
    
    return {"ok": True, "slot": s, "email": email_addr}


async def _imap_poll_one_slot(slot: str, cfg: dict, summary: dict) -> dict:
    import imaplib
    import email
    from email.header import decode_header
    import hashlib
    
    host = cfg.get("imap_host") or "imap.gmail.com"
    port = cfg.get("imap_port") or 993
    email_addr = cfg.get("email")
    password = cfg.get("imap_password")
    
    try:
        def _do_imap_poll():
            from datetime import timedelta
            res_messages = []
            mail = imaplib.IMAP4_SSL(host, port, timeout=30)
            try:
                mail.login(email_addr, password)
                mail.select("INBOX")
                since_dt = datetime.now(timezone.utc) - timedelta(days=2)
                since_date = since_dt.strftime("%d-%b-%Y")
                status, data = mail.search(None, 'UNSEEN', 'FROM', 'instantemail@justdial.com', 'SINCE', since_date)
                if status == 'OK':
                    mail_ids = data[0].split()
                    for m_id in mail_ids[:20]:
                        status, msg_data = mail.fetch(m_id, '(RFC822)')
                        if status == 'OK' and msg_data:
                            raw_email = msg_data[0][1]
                            res_messages.append((m_id, raw_email))
            finally:
                try:
                    mail.logout()
                except:
                    pass
            return res_messages

        fetched_messages = await asyncio.get_event_loop().run_in_executor(None, _do_imap_poll)
    except Exception as e:
        logger.exception(f"IMAP poll connection/fetch failed for slot={slot}: {e}")
        summary["fatal"] = f"IMAP connection failed: {str(e)[:150]}"
        summary["errors"] += 1
        return summary
        
    summary["fetched"] = len(fetched_messages)
    m_ids_to_mark_seen = []
    
    for m_id, raw_email in fetched_messages:
        try:
            msg = email.message_from_bytes(raw_email)
            msg_id_header = msg.get("Message-ID") or msg.get("Message-Id") or ""
            gmail_id = msg_id_header.strip().strip("<>") or f"imap-{slot}-{m_id.decode()}"
            
            already = await db.email_logs.find_one({"gmail_id": gmail_id}, {"_id": 0, "id": 1})
            if already:
                summary["skipped_dupe"] += 1
                m_ids_to_mark_seen.append(m_id)
                continue
                
            subject = ""
            subject_header = msg.get("Subject") or ""
            try:
                decoded = decode_header(subject_header)
                for part, encoding in decoded:
                    if isinstance(part, bytes):
                        subject += part.decode(encoding or "utf-8", errors="replace")
                    else:
                        subject += part
            except Exception:
                subject = subject_header
                
            from_h = msg.get("From") or ""
            from_email = parseaddr(from_h)[1] or "instantemail@justdial.com"
            
            bodies = {"text": "", "html": ""}
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    content_disposition = str(part.get("Content-Disposition"))
                    if "attachment" in content_disposition:
                        continue
                    payload = part.get_payload(decode=True)
                    if not payload:
                        continue
                    try:
                        charset = part.get_content_charset() or "utf-8"
                        text_content = payload.decode(charset, errors="replace")
                    except Exception:
                        text_content = payload.decode("utf-8", errors="replace")
                    
                    if content_type == "text/plain":
                        bodies["text"] = text_content
                    elif content_type == "text/html":
                        bodies["html"] = text_content
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    try:
                        charset = msg.get_content_charset() or "utf-8"
                        text_content = payload.decode(charset, errors="replace")
                    except Exception:
                        text_content = payload.decode("utf-8", errors="replace")
                    content_type = msg.get_content_type()
                    if content_type == "text/plain":
                        bodies["text"] = text_content
                    elif content_type == "text/html":
                        bodies["html"] = text_content
                        
            parsed = parse_justdial_email(bodies.get("text", ""), bodies.get("html", ""))
            if not parsed.get("customer_name") and not parsed.get("requirement"):
                summary["errors"] += 1
                await db.email_logs.insert_one({
                    "id": str(uuid.uuid4()),
                    "from": from_email,
                    "subject": subject,
                    "raw_html": bodies.get("html"),
                    "raw_text": bodies.get("text"),
                    "received_at": iso(now_utc()),
                    "processed": True,
                    "error": "unparseable",
                    "gmail_id": gmail_id,
                    "gmail_slot": slot,
                    "gmail_account_email": email_addr,
                })
            else:
                name = parsed.get("customer_name") or "Justdial Lead"
                ts = parsed.get("timestamp") or iso(now_utc())
                content_hash = hashlib.sha256(((bodies.get("text") or "") + (bodies.get("html") or "")).encode("utf-8")).hexdigest()
                dhash = _lead_dedup_hash(name, ts, content_hash[:16])
                
                contact_link = parsed.get("contact_link")
                profile_url = _normalize_justdial_link(contact_link)
                if profile_url:
                    existing_by_url = await _find_lead_by_justdial_link(profile_url)
                    if existing_by_url:
                        await db.email_logs.insert_one({
                            "id": str(uuid.uuid4()),
                            "from": from_email,
                            "subject": subject,
                            "raw_html": bodies.get("html"),
                            "raw_text": bodies.get("text"),
                            "received_at": iso(now_utc()),
                            "processed": True,
                            "lead_id": existing_by_url["id"],
                            "duplicate": True,
                            "dedup_reason": "justdial_profile_url",
                            "gmail_id": gmail_id,
                            "gmail_slot": slot,
                            "gmail_account_email": email_addr,
                        })
                        await log_activity(None, "justdial_duplicate_profile_url", existing_by_url["id"], {"url": profile_url, "gmail_id": gmail_id})
                        summary["skipped_dupe"] += 1
                        m_ids_to_mark_seen.append(m_id)
                        continue
                        
                created_override = None
                if parsed.get("timestamp"):
                    try:
                        from zoneinfo import ZoneInfo
                        dt = datetime.strptime(parsed["timestamp"].strip(), "%Y-%m-%d %H:%M:%S")
                        created_override = iso(dt.replace(tzinfo=ZoneInfo("Asia/Kolkata")))
                    except Exception:
                        try:
                            from datetime import timedelta, timezone as pytimezone
                            tz_kolkata = pytimezone(timedelta(hours=5, minutes=30))
                            created_override = iso(dt.replace(tzinfo=tz_kolkata))
                        except Exception:
                            created_override = None
                            
                if not created_override:
                    date_header = msg.get("Date")
                    if date_header:
                        try:
                            from email.utils import parsedate_to_datetime
                            dt = parsedate_to_datetime(date_header)
                            created_override = iso(dt.astimezone(pytimezone.utc))
                        except Exception:
                            pass
                            
                data = {
                    "customer_name": name,
                    "requirement": parsed.get("requirement"),
                    "area": parsed.get("area"),
                    "city": parsed.get("city"),
                    "state": parsed.get("state"),
                    "phone": parsed.get("phone"),
                    "source": "Justdial",
                    "contact_link": contact_link,
                    "justdial_profile_url": profile_url,
                    "source_data": {"timestamp": ts, "subject": subject, "from": from_email, "gmail_id": gmail_id, "gmail_slot": slot, "gmail_account_email": email_addr},
                    "raw_email_html": bodies.get("html"),
                    "raw_email_text": bodies.get("text"),
                    "dedup_hash": dhash,
                    "_created_at_override": created_override,
                }
                lead = await _create_lead_internal(data, by_user_id=None)
                await db.email_logs.insert_one({
                    "id": str(uuid.uuid4()),
                    "from": from_email,
                    "subject": subject,
                    "raw_html": bodies.get("html"),
                    "raw_text": bodies.get("text"),
                    "received_at": iso(now_utc()),
                    "processed": True,
                    "lead_id": lead["id"],
                    "gmail_id": gmail_id,
                    "gmail_slot": slot,
                    "gmail_account_email": email_addr,
                })
                summary["ingested"] += 1
                
            m_ids_to_mark_seen.append(m_id)
            
        except Exception as e:
            summary["errors"] += 1
            logger.exception(f"IMAP message processing failed for {m_id} (slot={slot}): {e}")
            
    if m_ids_to_mark_seen:
        try:
            def _do_imap_mark_seen():
                mail = imaplib.IMAP4_SSL(host, port, timeout=30)
                try:
                    mail.login(email_addr, password)
                    mail.select("INBOX")
                    for m_id in m_ids_to_mark_seen:
                        mail.store(m_id, '+FLAGS', '\\Seen')
                finally:
                    try:
                        mail.logout()
                    except:
                        pass
            await asyncio.get_event_loop().run_in_executor(None, _do_imap_mark_seen)
        except Exception as e:
            logger.warning(f"Failed to mark IMAP messages seen: {e}")
            
    await db.gmail_polls.replace_one({"key": f"last:{slot}"}, {**summary, "key": f"last:{slot}"}, upsert=True)
    return summary


async def _get_gmail_service(slot: str = "primary"):
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GoogleRequest
    from googleapiclient.discovery import build
    cfg = await db.gmail_connections.find_one({"key": slot}, {"_id": 0})
    if not cfg:
        return None, None
    creds = Credentials(
        token=cfg["access_token"],
        refresh_token=cfg.get("refresh_token"),
        token_uri=cfg.get("token_uri") or "https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=cfg.get("scopes") or GMAIL_SCOPES,
    )
    expires_at = cfg.get("expires_at")
    needs_refresh = True
    if expires_at:
        try:
            exp_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            needs_refresh = now_utc() >= (exp_dt - timedelta(minutes=2))
        except Exception:
            pass
    if needs_refresh and creds.refresh_token:
        try:
            creds.refresh(GoogleRequest())
            await db.gmail_connections.update_one(
                {"key": slot},
                {"$set": {
                    "access_token": creds.token,
                    "expires_at": iso(creds.expiry.replace(tzinfo=timezone.utc)) if creds.expiry else None,
                }},
            )
        except Exception as e:
            logger.warning(f"Gmail token refresh failed for slot={slot}: {e}")
            return None, cfg
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    return service, cfg

def _decode_b64url(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def _walk_parts(payload: dict) -> List[dict]:
    out: List[dict] = []
    if not payload:
        return out
    out.append(payload)
    for p in (payload.get("parts") or []):
        out.extend(_walk_parts(p))
    return out

def _extract_email_bodies(message: dict) -> Dict[str, str]:
    """Return {'text': ..., 'html': ...} from a Gmail message resource (format=full)."""
    text, html = "", ""
    payload = message.get("payload") or {}
    for part in _walk_parts(payload):
        mime = part.get("mimeType") or ""
        body = part.get("body") or {}
        data = body.get("data")
        if not data:
            continue
        try:
            raw = _decode_b64url(data).decode("utf-8", errors="replace")
        except Exception:
            continue
        if mime == "text/plain" and not text:
            text = raw
        elif mime == "text/html" and not html:
            html = raw
    return {"text": text, "html": html}

def _header(message: dict, name: str) -> str:
    for h in (message.get("payload", {}).get("headers") or []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""

async def _gmail_poll_one_slot(slot: str) -> dict:
    """Poll a single Gmail/IMAP slot for Justdial enquiries. Returns a per-slot summary dict."""
    summary = {"slot": slot, "ran_at": iso(now_utc()), "fetched": 0, "ingested": 0, "skipped_dupe": 0, "errors": 0}
    cfg = await db.gmail_connections.find_one({"key": slot}, {"_id": 0})
    if not cfg:
        summary["error"] = "not_connected"
        return summary
    summary["email"] = cfg.get("email")
    if cfg.get("connection_type") == "imap":
        return await _imap_poll_one_slot(slot, cfg, summary)
        
    if not GMAIL_ENABLED:
        summary["error"] = "google_oauth_not_configured_on_server"
        return summary
        
    service, _ = await _get_gmail_service(slot)
    if not service:
        summary["error"] = "not_connected"
        return summary
    try:
        resp = service.users().messages().list(userId="me", q=GMAIL_QUERY, maxResults=20).execute()
        ids = [m["id"] for m in (resp.get("messages") or [])]
        summary["fetched"] = len(ids)
        for mid in ids:
            try:
                # Hard dedup: if we have ever processed this gmail_id (across either slot),
                # skip silently. Protects against re-polling the same email after retries
                # and against cross-slot duplicates (same message in two inboxes).
                already = await db.email_logs.find_one({"gmail_id": mid}, {"_id": 0, "id": 1})
                if already:
                    summary["skipped_dupe"] += 1
                    # Still mark read so we don't pull it again on the next tick
                    try:
                        service.users().messages().modify(userId="me", id=mid, body={"removeLabelIds": ["UNREAD"]}).execute()
                    except Exception:
                        pass
                    continue
                full = service.users().messages().get(userId="me", id=mid, format="full").execute()
                bodies = _extract_email_bodies(full)
                subject = _header(full, "Subject")
                from_h = _header(full, "From")
                from_email = parseaddr(from_h)[1] or "instantemail@justdial.com"
                # Hand off to existing parser by reusing its core logic
                parsed = parse_justdial_email(bodies.get("text", ""), bodies.get("html", ""))
                if not parsed.get("customer_name") and not parsed.get("requirement"):
                    summary["errors"] += 1
                    await db.email_logs.insert_one({
                        "id": str(uuid.uuid4()),
                        "from": from_email,
                        "subject": subject,
                        "raw_html": bodies.get("html"),
                        "raw_text": bodies.get("text"),
                        "received_at": iso(now_utc()),
                        "processed": True,
                        "error": "unparseable",
                        "gmail_id": mid,
                        "gmail_slot": slot,
                        "gmail_account_email": (cfg or {}).get("email"),
                    })
                else:
                    name = parsed.get("customer_name") or "Justdial Lead"
                    ts = parsed.get("timestamp") or iso(now_utc())
                    content_hash = hashlib.sha256(((bodies.get("text") or "") + (bodies.get("html") or "")).encode("utf-8")).hexdigest()
                    dhash = _lead_dedup_hash(name, ts, content_hash[:16])
                    # Profile-URL dedup — skip ingestion if the same Justdial profile link
                    # already maps to an existing lead. Mark the email as processed/duplicate
                    # but DO NOT create a new lead.
                    contact_link = parsed.get("contact_link")
                    profile_url = _normalize_justdial_link(contact_link)
                    if profile_url:
                        existing_by_url = await _find_lead_by_justdial_link(profile_url)
                        if existing_by_url:
                            await db.email_logs.insert_one({
                                "id": str(uuid.uuid4()),
                                "from": from_email,
                                "subject": subject,
                                "raw_html": bodies.get("html"),
                                "raw_text": bodies.get("text"),
                                "received_at": iso(now_utc()),
                                "processed": True,
                                "lead_id": existing_by_url["id"],
                                "duplicate": True,
                                "dedup_reason": "justdial_profile_url",
                                "gmail_id": mid,
                                "gmail_slot": slot,
                                "gmail_account_email": (cfg or {}).get("email"),
                            })
                            await log_activity(None, "justdial_duplicate_profile_url", existing_by_url["id"], {"url": profile_url, "gmail_id": mid})
                            summary["skipped_dupe"] = int(summary.get("skipped_dupe") or 0) + 1
                            try:
                                service.users().messages().modify(userId="me", id=mid, body={"removeLabelIds": ["UNREAD"]}).execute()
                            except Exception as e:
                                logger.warning(f"Could not mark Gmail msg {mid} read after URL-dedup (slot={slot}): {e}")
                            continue
                    # Use Justdial's "Search Date & Time" (IST) as the lead's created_at.
                    # Fallback to Gmail's internalDate (the moment the email arrived).
                    created_override = None
                    if parsed.get("timestamp"):
                        try:
                            from zoneinfo import ZoneInfo
                            dt = datetime.strptime(parsed["timestamp"].strip(), "%Y-%m-%d %H:%M:%S")
                            created_override = iso(dt.replace(tzinfo=ZoneInfo("Asia/Kolkata")))
                        except Exception:
                            created_override = None
                    if not created_override:
                        idate = full.get("internalDate")
                        if idate:
                            try:
                                created_override = iso(datetime.fromtimestamp(int(idate) / 1000, tz=timezone.utc))
                            except Exception:
                                pass
                    data = {
                        "customer_name": name,
                        "requirement": parsed.get("requirement"),
                        "area": parsed.get("area"),
                        "city": parsed.get("city"),
                        "state": parsed.get("state"),
                        "phone": parsed.get("phone"),
                        "source": "Justdial",
                        "contact_link": contact_link,
                        "justdial_profile_url": profile_url,
                        "source_data": {"timestamp": ts, "subject": subject, "from": from_email, "gmail_id": mid, "gmail_slot": slot, "gmail_account_email": (cfg or {}).get("email")},
                        "raw_email_html": bodies.get("html"),
                        "raw_email_text": bodies.get("text"),
                        "dedup_hash": dhash,
                        "_created_at_override": created_override,
                    }
                    lead = await _create_lead_internal(data, by_user_id=None)
                    await db.email_logs.insert_one({
                        "id": str(uuid.uuid4()),
                        "from": from_email,
                        "subject": subject,
                        "raw_html": bodies.get("html"),
                        "raw_text": bodies.get("text"),
                        "received_at": iso(now_utc()),
                        "processed": True,
                        "lead_id": lead["id"],
                        "gmail_id": mid,
                        "gmail_slot": slot,
                        "gmail_account_email": (cfg or {}).get("email"),
                    })
                    summary["ingested"] += 1
                # Mark as read so we don't re-process
                try:
                    service.users().messages().modify(userId="me", id=mid, body={"removeLabelIds": ["UNREAD"]}).execute()
                except Exception as e:
                    logger.warning(f"Could not mark Gmail msg {mid} read (slot={slot}): {e}")
            except Exception as e:
                summary["errors"] += 1
                logger.exception(f"Gmail message processing failed for {mid} (slot={slot}): {e}")
    except Exception as e:
        summary["errors"] += 1
        summary["fatal"] = str(e)[:200]
        logger.exception(f"Gmail poll task failed for slot={slot}: {e}")
    # Persist per-slot last poll AND keep a combined "last" for back-compat
    await db.gmail_polls.replace_one({"key": f"last:{slot}"}, {**summary, "key": f"last:{slot}"}, upsert=True)
    return summary


async def gmail_poll_task():
    """Poll ALL connected Gmail/IMAP slots for Justdial enquiries and ingest them.
    Uses shared parse / dedup / assignment pipeline so every inbox is processed identically."""
    await _ensure_gmail_migrated()
    has_conns = await db.gmail_connections.count_documents({}) > 0
    if not GMAIL_ENABLED and not has_conns:
        return
    combined = {"key": "last", "ran_at": iso(now_utc()), "fetched": 0, "ingested": 0, "skipped_dupe": 0, "errors": 0, "slots": {}}
    has_active_slots = False
    for slot in GMAIL_SLOTS:
        cfg = await db.gmail_connections.find_one({"key": slot}, {"_id": 0})
        if not cfg:
            continue
        if cfg.get("connection_type") != "imap" and not GMAIL_ENABLED:
            continue
        has_active_slots = True
        slot_summary = await _gmail_poll_one_slot(slot)
        combined["slots"][slot] = slot_summary
        combined["fetched"] += int(slot_summary.get("fetched") or 0)
        combined["ingested"] += int(slot_summary.get("ingested") or 0)
        combined["skipped_dupe"] += int(slot_summary.get("skipped_dupe") or 0)
        combined["errors"] += int(slot_summary.get("errors") or 0)
    if has_active_slots:
        await db.gmail_polls.replace_one({"key": "last"}, {**combined, "key": "last"}, upsert=True)

@api.post("/integrations/gmail/sync-now")
async def gmail_sync_now(admin: dict = Depends(require_admin), slot: Optional[str] = None):
    """Sync all connected slots by default; sync a single slot when `slot=primary|secondary`."""
    await _ensure_gmail_migrated()
    if slot:
        s = _normalize_gmail_slot(slot)
        summary = await _gmail_poll_one_slot(s)
        return {"ok": True, "last_poll": summary}
    await gmail_poll_task()
    last = await db.gmail_polls.find_one({"key": "last"}, {"_id": 0})
    return {"ok": True, "last_poll": last}


# ------------- Seed -------------
async def seed_data():
    from pymongo.errors import DuplicateKeyError
    # admin
    admin_username = os.environ.get("ADMIN_USERNAME", "admin").strip().lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin@123")
    admin_name = os.environ.get("ADMIN_NAME", "System Admin")
    try:
        existing = await db.users.find_one({"username": admin_username})
        if not existing:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "username": admin_username,
                "name": admin_name,
                "password_hash": hash_password(admin_password),
                "role": "admin",
                "active": True,
                "working_hours": [],
                "created_at": iso(now_utc()),
            })
            logger.info("Seeded admin user")
    except DuplicateKeyError:
        pass

    # Seed Gayatri (data_entry)
    gayatri_uname = "gayatri"
    gayatri_pwd = "Gayatri@123"
    gayatri_name = "Gayatri"
    try:
        existing_gayatri = await db.users.find_one({"username": gayatri_uname})
        if not existing_gayatri:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "username": gayatri_uname,
                "name": gayatri_name,
                "password_hash": hash_password(gayatri_pwd),
                "role": "data_entry",
                "active": True,
                "working_hours": [],
                "created_at": iso(now_utc()),
            })
            logger.info("Seeded data entry user Gayatri")
    except DuplicateKeyError:
        pass

    # Seed Scanner Device User
    scanner_uname = "scanner"
    scanner_pwd = "CitSpray1"
    scanner_name = "Attendance Device Scanner"
    try:
        existing_scanner = await db.users.find_one({"username": scanner_uname})
        if not existing_scanner:
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "username": scanner_uname,
                "name": scanner_name,
                "password_hash": hash_password(scanner_pwd),
                "role": "data_entry",
                "active": True,
                "scanner_access": True,
                "created_at": iso(now_utc()),
            })
            logger.info("Seeded scanner device user")
    except DuplicateKeyError:
        pass
  


    # default routing rules
    await get_routing_rules()
    # indexes
    await db.users.create_index("username", unique=True)
    await db.leads.create_index("dedup_hash")
    await db.leads.create_index("id", unique=True)
    await db.leads.create_index([("sort_at", -1), ("created_at", -1)])
    await db.leads.create_index([("last_message_at", -1), ("created_at", -1)])
    try:
        await db.leads.create_index(
            "justdial_profile_url",
            unique=True,
            partialFilterExpression={"justdial_profile_url": {"$type": "string"}}
        )
    except Exception as e:
        logger.warning(f"Could not create unique partial index on justdial_profile_url: {e}")
    await db.leads.create_index("assigned_to")
    await db.leads.create_index("status")
    await db.leads.create_index("created_at")
    await db.leads.create_index("last_action_at")
    await db.leads.create_index([("last_assignment_at", -1)])
    await db.messages.create_index("lead_id")
    await db.messages.create_index([("lead_id", 1), ("at", -1)])
    await db.messages.create_index("wamid")
    await db.followups.create_index("executive_id")
    await db.followups.create_index("due_at")
    await db.activity_logs.create_index("lead_id")
    await db.transfer_requests.create_index([("status", 1), ("created_at", -1)])
    await db.quick_replies.create_index("title")
    await db.call_logs.create_index([("lead_id", 1), ("at", -1)])
    await db.call_logs.create_index([("by_user_id", 1), ("at", -1)])
    await db.call_logs.create_index("outcome")
    await db.chat_flows.create_index("is_active")
    await db.chat_nodes.create_index([("flow_id", 1), ("is_start_node", -1)])
    await db.chat_options.create_index([("node_id", 1), ("position", 1)])
    await db.chat_options.create_index([("node_id", 1), ("option_id", 1)])
    await db.chat_sessions.create_index("phone_key", unique=True)
    await db.system_locks.create_index("key", unique=True)
    # Phone canonicalization migration (one-shot per cold-start). Iterates through any
    # lead whose phone/phones haven't been flagged migrated yet and rewrites them in
    # canonical form (Indian → 10-digit national, others → +<digits>). Idempotent.
    n_migrated = 0
    async for ld in db.leads.find({"_phones_canonicalized": {"$ne": True}}, {"_id": 0, "id": 1, "phone": 1, "phones": 1}):
        new_primary = normalize_phone_display(ld.get("phone")) if ld.get("phone") else ld.get("phone")
        new_phones: List[str] = []
        seen: set = set()
        for raw in (ld.get("phones") or []):
            cn = normalize_phone_display(raw) if raw else None
            if not cn or cn == new_primary or cn in seen:
                continue
            seen.add(cn)
            new_phones.append(cn)
        await db.leads.update_one(
            {"id": ld["id"]},
            {"$set": {"phone": new_primary, "phones": new_phones, "_phones_canonicalized": True}},
        )
        n_migrated += 1
    if n_migrated:
        logger.info(f"Canonicalized phone format on {n_migrated} leads")

# ------------- WebSocket Push Sync -------------
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        self.active_connections[user_id].append(websocket)
        logger.info(f"WebSocket connected for user: {user_id}. Active connections: {len(self.active_connections[user_id])}")

    def disconnect(self, user_id: str, websocket: WebSocket):
        if user_id in self.active_connections:
            if websocket in self.active_connections[user_id]:
                self.active_connections[user_id].remove(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
        logger.info(f"WebSocket disconnected for user: {user_id}")

    async def broadcast_to_user(self, user_id: str, message: dict):
        if user_id in self.active_connections:
            dead_connections = []
            for ws in self.active_connections[user_id]:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    logger.warning(f"Error sending message to WebSocket for user {user_id}: {e}")
                    dead_connections.append(ws)
            for ws in dead_connections:
                self.disconnect(user_id, ws)

manager = ConnectionManager()

@api.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str, token: Optional[str] = Query(None)):
    if not token:
        logger.warning(f"WebSocket connection rejected for user {user_id}: missing token")
        await websocket.close(code=1008, reason="Missing token")
        return
        
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("sub") != user_id:
            logger.warning(f"WebSocket connection rejected: token subject {payload.get('sub')} does not match user_id {user_id}")
            await websocket.close(code=1008, reason="User ID mismatch")
            return
    except Exception as e:
        logger.warning(f"WebSocket connection rejected: invalid token: {e}")
        await websocket.close(code=1008, reason="Invalid token")
        return

    # Enforce the same liveness checks as HTTP auth: the account must still be
    # active and the token not revoked by a password change / forced logout.
    ws_user = await db.users.find_one({"id": user_id}, {"_id": 0, "active": 1, "token_version": 1})
    if not ws_user or not ws_user.get("active", True) or \
            ws_user.get("token_version", 0) != payload.get("token_version", 0):
        await websocket.close(code=1008, reason="Session revoked")
        return

    await manager.connect(user_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(user_id, websocket)
    except Exception as e:
        logger.warning(f"WebSocket error for user {user_id}: {e}")
        manager.disconnect(user_id, websocket)

async def check_due_followups_task():
    try:
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()
        
        query = {
            "status": "pending",
            "notified": {"$ne": True},
            "$or": [
                {"due_at": {"$lte": now_iso}},
                {"snoozed_until": {"$lte": now_iso}}
            ]
        }
        
        due_followups = await db.followups.find(query).to_list(100)
        for fu in due_followups:
            lead = await db.leads.find_one({"id": fu.get("lead_id")}, {"_id": 0, "customer_name": 1, "phone": 1, "active_wa_phone": 1})
            lead_customer_name = lead.get("customer_name") if lead else "Lead"
            lead_phone = (lead.get("active_wa_phone") or lead.get("phone")) if lead else ""
            
            await db.followups.update_one({"id": fu["id"]}, {"$set": {"notified": True}})
            
            event = {
                "type": "followup",
                "action": "trigger",
                "followup": {
                    "id": fu["id"],
                    "due_at": fu["due_at"],
                    "note": fu.get("note", ""),
                    "lead_customer_name": lead_customer_name,
                    "lead_phone": lead_phone
                }
            }
            await manager.broadcast_to_user(fu["executive_id"], event)
    except Exception as e:
        logger.error(f"Error in check_due_followups_task: {e}")

@api.put("/followups/{fu_id}/snooze")
async def snooze_followup(fu_id: str, user: dict = Depends(get_current_user)):
    fu = await db.followups.find_one({"id": fu_id})
    if not fu:
        raise HTTPException(status_code=404, detail="Followup not found")
    if user["role"] == "executive" and fu["executive_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    
    now = datetime.now(timezone.utc)
    snoozed_until = (now + timedelta(minutes=30)).isoformat()
    
    await db.followups.update_one(
        {"id": fu_id},
        {"$set": {"snoozed_until": snoozed_until, "notified": False}}
    )
    
    clear_event = {
        "type": "followup",
        "action": "clear",
        "fu_id": fu_id
    }
    await manager.broadcast_to_user(fu["executive_id"], clear_event)
    return {"status": "success", "message": "Followup snoozed", "snoozed_until": snoozed_until}

@api.put("/followups/{fu_id}/dismiss")
async def dismiss_followup(fu_id: str, user: dict = Depends(get_current_user)):
    fu = await db.followups.find_one({"id": fu_id})
    if not fu:
        raise HTTPException(status_code=404, detail="Followup not found")
    if user["role"] == "executive" and fu["executive_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    
    now = datetime.now(timezone.utc)
    snoozed_until = (now + timedelta(days=1)).isoformat()
    
    await db.followups.update_one(
        {"id": fu_id},
        {"$set": {"notified": True, "snoozed_until": snoozed_until}}
    )
    
    clear_event = {
        "type": "followup",
        "action": "clear",
        "fu_id": fu_id
    }
    await manager.broadcast_to_user(fu["executive_id"], clear_event)
    return {"status": "success", "message": "Followup dismissed"}

scheduler: Optional[AsyncIOScheduler] = None

@app.on_event("startup")
async def on_startup():
    global scheduler
    logger.info("DEBUG STARTUP: starting seed_data...")
    await seed_data()
    logger.info("DEBUG STARTUP: seed_data complete. Initializing scheduler...")
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(auto_reassign_task, "interval", minutes=1, id="auto_reassign", max_instances=1, coalesce=True)
    scheduler.add_job(check_due_followups_task, "interval", seconds=10, id="check_due_followups", max_instances=1, coalesce=True)
    scheduler.add_job(attendance_monitor_task, "interval", minutes=10, id="attendance_monitor", max_instances=1, coalesce=True)
    scheduler.add_job(reorder_reminder_task, "cron", hour=10, minute=45, timezone="Asia/Kolkata", id="reorder_reminder", max_instances=1, coalesce=True)
    scheduler.add_job(abandoned_checkout_task, "interval", minutes=10, id="abandoned_checkout", max_instances=1, coalesce=True)
    try:
        await db.attendance_logs.create_index([("user_id", 1), ("date", 1)])
        await db.leaves.create_index([("user_id", 1), ("start_date", 1)])
        await db.admin_alerts.create_index([("meta.dedup_key", 1)])
    except Exception as _e:
        logger.warning(f"index creation skipped: {_e}")
    logger.info("DEBUG STARTUP: counting gmail_connections...")
    has_gmail_conns = await db.gmail_connections.count_documents({}) > 0
    logger.info(f"DEBUG STARTUP: gmail connections count done (has_gmail_conns={has_gmail_conns}). GMAIL_ENABLED={GMAIL_ENABLED}")
    if GMAIL_ENABLED or has_gmail_conns:
        logger.info("DEBUG STARTUP: getting gmail poll seconds...")
        gmail_secs = await _get_gmail_poll_seconds()
        logger.info(f"DEBUG STARTUP: gmail poll seconds={gmail_secs}. Scheduling gmail_poll...")
        scheduler.add_job(
            gmail_poll_task, "interval", seconds=gmail_secs,
            id="gmail_poll", max_instances=1, coalesce=True,
        )
        logger.info(f"Gmail/IMAP poll scheduled every {gmail_secs}s")
    # ExportersIndia pull — only schedule if admin has enabled it
    try:
        logger.info("DEBUG STARTUP: getting exportersindia pull cfg...")
        ei_cfg = await _get_exportersindia_pull_cfg()
        logger.info(f"DEBUG STARTUP: exportersindia pull cfg={ei_cfg}")
        if ei_cfg.get("enabled") and ei_cfg.get("api_key") and ei_cfg.get("email"):
            scheduler.add_job(
                exportersindia_pull_task, "interval",
                seconds=max(10, int(ei_cfg.get("interval_seconds") or DEFAULT_EI_INTERVAL)),
                id="exportersindia_pull", max_instances=1, coalesce=True,
            )
            logger.info(f"ExportersIndia pull enabled every {ei_cfg['interval_seconds']}s")
    except Exception as e:
        logger.warning(f"Could not schedule ExportersIndia pull: {e}")
    logger.info("DEBUG STARTUP: starting scheduler...")
    scheduler.start()
    logger.info(f"Startup complete; scheduler running (gmail_enabled={GMAIL_ENABLED})")

@app.on_event("shutdown")
async def on_shutdown():
    global scheduler
    if scheduler:
        scheduler.shutdown(wait=False)
    client.close()

# ─── Admin Alert / Urgent Notification System ────────────────────────────

@api.get("/admin/alerts/other-users")
async def get_oms_users(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        oms_users = await oms_db.users.find({"active": {"$ne": False}}, {"_id": 0, "id": 1, "name": 1, "username": 1, "role": 1}).to_list(1000)
        return oms_users
    except Exception as e:
        logger.error(f"Failed to fetch OMS users: {e}")
        return []

@api.get("/admin/alerts/mappings")
async def get_user_mappings(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    mappings = await oms_db.user_mappings.find({}, {"_id": 0}).to_list(1000)
    return mappings

@api.post("/admin/alerts/mappings")
async def save_user_mappings(body: dict, user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    mappings = body.get("mappings", [])
    await oms_db.user_mappings.delete_many({})
    if mappings:
        valid_mappings = []
        for m in mappings:
            oms_id = m.get("oms_user_id")
            crm_id = m.get("crm_user_id")
            if oms_id and crm_id:
                valid_mappings.append({"oms_user_id": oms_id, "crm_user_id": crm_id})
        if valid_mappings:
            await oms_db.user_mappings.insert_many(valid_mappings)
    return {"status": "success", "message": "Mappings saved successfully"}

@api.post("/admin/alerts")
async def create_admin_alert(body: dict, user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can send alerts")
    title = body.get("title", "").strip()
    message = body.get("message", "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")

    recipients = body.get("recipients", [])  # list of CRM user IDs
    recipient_roles = body.get("recipient_roles", [])  # list of roles
    order_id = body.get("order_id", "")
    customer_name = body.get("customer_name", "")

    # Build CRM target user IDs
    target_user_ids = set(recipients)
    # Filter out special "oms_everyone" broadcast role from CRM lookup
    crm_recipient_roles = [r for r in recipient_roles if r != "oms_everyone"]
    if crm_recipient_roles:
        role_users = await db.users.find({"role": {"$in": crm_recipient_roles}, "active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(500)
        for u in role_users:
            target_user_ids.add(u["id"])

    if not target_user_ids and "oms_everyone" not in recipient_roles:
        raise HTTPException(status_code=400, detail="No recipients selected")

    alert_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    alert_doc = {
        "id": alert_id,
        "title": title,
        "message": message,
        "sent_by": user["name"],
        "sent_by_id": user["id"],
        "order_id": order_id,
        "customer_name": customer_name,
        "recipient_ids": list(target_user_ids),
        "recipient_roles": recipient_roles,
        "acknowledgements": {},
        "created_at": now,
    }
    # Only insert into CRM alerts database if there are actual CRM targets
    if target_user_ids:
        await db.admin_alerts.insert_one(alert_doc)
    else:
        # If CRM targets are empty (e.g. only OMS broadcast), save empty recipient list or still write it
        # Let's save alert_doc to crm db as well for admin history purposes
        await db.admin_alerts.insert_one(alert_doc)

    # Broadcast alert trigger to CRM recipients
    for r_id in alert_doc["recipient_ids"]:
        event = {
            "type": "admin_alert",
            "action": "trigger",
            "alert": {
                "id": alert_doc["id"],
                "title": alert_doc["title"],
                "message": alert_doc["message"],
                "sent_by": alert_doc["sent_by"]
            }
        }
        await manager.broadcast_to_user(r_id, event)

    # ─── Bidirectional Sync: Forward Alert to OMS ───
    try:
        # Find detail info of the CRM target recipients
        crm_target_users = await db.users.find({"id": {"$in": list(target_user_ids)}}, {"_id": 0, "id": 1, "username": 1}).to_list(500)

        # Get the mappings from the shared user_mappings collection in OMS DB
        mappings = await oms_db.user_mappings.find({}).to_list(1000)
        crm_to_oms = {m["crm_user_id"]: m["oms_user_id"] for m in mappings if m.get("oms_user_id") and m.get("crm_user_id")}

        oms_target_ids = set()
        mapped_crm_ids = set()

        for u in crm_target_users:
            crm_uid = u["id"]
            if crm_uid in crm_to_oms:
                oms_target_ids.add(crm_to_oms[crm_uid])
                mapped_crm_ids.add(crm_uid)

        # Fallback to username mapping for unmapped users
        unmapped_users = [u for u in crm_target_users if u["id"] not in mapped_crm_ids]
        if unmapped_users:
            unmapped_usernames = [u["username"] for u in unmapped_users if u.get("username")]
            if unmapped_usernames:
                oms_users_fallback = await oms_db.users.find({"username": {"$in": unmapped_usernames}, "active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(500)
                for ou in oms_users_fallback:
                    oms_target_ids.add(ou["id"])

        # Map recipient roles from CRM to OMS
        oms_recipient_roles = []
        for r in recipient_roles:
            if r == "admin":
                oms_recipient_roles.append("admin")
            elif r == "executive":
                oms_recipient_roles.append("telecaller")

        if oms_recipient_roles:
            oms_users_by_role = await oms_db.users.find({"role": {"$in": oms_recipient_roles}, "active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(500)
            for ou in oms_users_by_role:
                oms_target_ids.add(ou["id"])

        # SPECIAL: Handle Everyone in OMS broadcast
        if "oms_everyone" in recipient_roles:
            oms_all_active_users = await oms_db.users.find({"active": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(1000)
            for ou in oms_all_active_users:
                oms_target_ids.add(ou["id"])
            if "oms_everyone" not in oms_recipient_roles:
                oms_recipient_roles.append("oms_everyone")

        if oms_target_ids:
            oms_alert_doc = alert_doc.copy()
            oms_alert_doc["recipient_ids"] = list(oms_target_ids)
            oms_alert_doc["recipient_roles"] = oms_recipient_roles
            await oms_db.admin_alerts.insert_one(oms_alert_doc)
    except Exception as e:
        logger.error(f"Alert sync to OMS failed: {e}")

    return {"id": alert_id, "message": "Alert processed successfully"}

@api.get("/admin/alerts/pending")
async def get_pending_alerts(user=Depends(get_current_user)):
    uid = user["id"]
    alerts = await db.admin_alerts.find(
        {"recipient_ids": uid, f"acknowledgements.{uid}": {"$exists": False}, "cancelled": {"$ne": True}},
        {"_id": 0}
    ).sort("created_at", -1).to_list(50)
    return alerts

@api.put("/admin/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str, user=Depends(get_current_user)):
    now = datetime.now(timezone.utc).isoformat()
    result = await db.admin_alerts.update_one(
        {"id": alert_id, "recipient_ids": user["id"]},
        {"$set": {f"acknowledgements.{user['id']}": {"name": user["name"], "at": now}}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")

    # Broadcast clear alert to user
    clear_event = {
        "type": "admin_alert",
        "action": "clear",
        "alert_id": alert_id
    }
    await manager.broadcast_to_user(user["id"], clear_event)

    # ─── Bidirectional Sync: Acknowledge Alert in OMS ───
    try:
        # Check mapping first
        mapping = await oms_db.user_mappings.find_one({"crm_user_id": user["id"]})
        oms_user = None
        if mapping and mapping.get("oms_user_id"):
            oms_user = await oms_db.users.find_one({"id": mapping["oms_user_id"]})

        if not oms_user:
            # Fallback to username
            oms_user = await oms_db.users.find_one({"username": user["username"]})

        if oms_user:
            await oms_db.admin_alerts.update_one(
                {"id": alert_id, "recipient_ids": oms_user["id"]},
                {"$set": {f"acknowledgements.{oms_user['id']}": {"name": oms_user["name"], "at": now}}}
            )
    except Exception as e:
        logger.error(f"Acknowledgement sync to OMS failed: {e}")

    return {"message": "Acknowledged"}

@api.put("/admin/alerts/{alert_id}/cancel")
async def cancel_alert(alert_id: str, user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can cancel alerts")
    now = datetime.now(timezone.utc).isoformat()
    result = await db.admin_alerts.update_one(
        {"id": alert_id},
        {"$set": {"cancelled": True, "cancelled_at": now, "cancelled_by": user["name"]}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")

    # Broadcast clear (cancel) to all recipient_ids
    alert = await db.admin_alerts.find_one({"id": alert_id})
    if alert and alert.get("recipient_ids"):
        for r_id in alert["recipient_ids"]:
            clear_event = {
                "type": "admin_alert",
                "action": "clear",
                "alert_id": alert_id
            }
            await manager.broadcast_to_user(r_id, clear_event)

    # ─── Bidirectional Sync: Cancel Alert in OMS ───
    try:
        await oms_db.admin_alerts.update_one(
            {"id": alert_id},
            {"$set": {"cancelled": True, "cancelled_at": now, "cancelled_by": user["name"]}}
        )
    except Exception as e:
        logger.error(f"Cancellation sync to OMS failed: {e}")

    return {"message": "Alert cancelled"}

@api.get("/admin/alerts/history")
async def get_alert_history(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    alerts = await db.admin_alerts.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)
    
    # Enrich with user names for display
    all_user_ids = set()
    for a in alerts:
        all_user_ids.update(a.get("recipient_ids", []))
    users_map = {}
    if all_user_ids:
        users_list = await db.users.find({"id": {"$in": list(all_user_ids)}}, {"_id": 0, "id": 1, "name": 1, "role": 1}).to_list(500)
        users_map = {u["id"]: u for u in users_list}
    for a in alerts:
        a["recipients_info"] = [users_map.get(uid, {"id": uid, "name": "Unknown"}) for uid in a.get("recipient_ids", [])]
        total = len(a.get("recipient_ids", []))
        acked = len(a.get("acknowledgements", {}))
        a["ack_count"] = acked
        a["total_count"] = total
        a["fully_acknowledged"] = acked >= total
    return alerts

class TranslateRequest(BaseModel):
    text: str
    target_lang: str = "en"

@api.post("/translate")
async def translate_text(body: TranslateRequest, user: dict = Depends(get_current_user)):
    text = body.text.strip()
    target_lang = body.target_lang.strip()
    if not text:
        return {"translated_text": "", "source_lang": ""}
    
    url = "https://translate.googleapis.com/translate_a/single"
    params = {
        "client": "gtx",
        "sl": "auto",
        "tl": target_lang,
        "dt": "t",
        "q": text
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                data = resp.json()
                translated_segments = []
                if data and isinstance(data, list) and len(data) > 0 and data[0]:
                    for segment in data[0]:
                        if segment and len(segment) > 0:
                            translated_segments.append(segment[0])
                translated_text = "".join(translated_segments)
                source_lang = data[2] if len(data) > 2 else "auto"
                return {"translated_text": translated_text, "source_lang": source_lang}
            else:
                raise HTTPException(status_code=500, detail=f"Google Translate API error: status {resp.status_code}")
    except Exception as e:
        logger.error(f"Translation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")

# ------------- AI Assistant (Gemini free tier) -------------

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash").strip() or "gemini-2.0-flash"

class AISuggestRequest(BaseModel):
    lead_id: str
    intent: str = "reply"   # 'reply' | 'followup' | 'close_order'
    extra: Optional[str] = None  # optional hint from the executive

_AI_INTENT_BRIEF = {
    "reply": "Draft the next WhatsApp reply to the customer, moving the sale forward.",
    "followup": "Draft a short, polite follow-up nudge — the customer has gone quiet.",
    "close_order": "Draft a message that pushes to FINALIZE the order: confirm quantity, price, delivery and payment, and ask for the go-ahead.",
}

@api.post("/ai/suggest")
async def ai_suggest(body: AISuggestRequest, user: dict = Depends(get_current_user)):
    """Suggest 2 message drafts for a lead using Gemini (free tier).
    Executives can only use it on their own leads."""
    if user["role"] == "data_entry":
        raise HTTPException(status_code=403, detail="Not allowed")
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail=(
            "AI is not configured yet. Get a FREE API key at aistudio.google.com/apikey "
            "and add GEMINI_API_KEY=<key> to backend/.env, then restart."))
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your lead")

    msgs = await db.messages.find(
        {"lead_id": body.lead_id}, {"_id": 0, "direction": 1, "body": 1, "caption": 1, "at": 1}
    ).sort("at", -1).to_list(25)
    msgs.reverse()
    convo_lines = []
    for m in msgs:
        text = (m.get("body") or m.get("caption") or "").strip()
        if not text:
            continue
        who = "Customer" if m.get("direction") == "in" else "Us"
        convo_lines.append(f"{who}: {text[:400]}")
    convo = "\n".join(convo_lines[-25:]) or "(no WhatsApp conversation yet)"

    brief = _AI_INTENT_BRIEF.get(body.intent, _AI_INTENT_BRIEF["reply"])
    prompt = f"""You are a sales assistant for CitSpray / Mangalam Agro, an Indian agro-products company selling citrus sprays and related products. An executive needs help writing a WhatsApp message to a customer.

LEAD:
- Customer: {lead.get('customer_name') or 'Unknown'} ({lead.get('city') or ''} {lead.get('state') or ''})
- Requirement: {(lead.get('requirement') or 'not specified')[:300]}
- Lead status: {lead.get('status')} | Source: {lead.get('source')}
- Last call outcome: {lead.get('last_call_outcome') or 'none'}

RECENT CONVERSATION:
{convo}

TASK: {brief}
{('Executive note: ' + body.extra.strip()) if body.extra else ''}

Rules: WhatsApp tone (short, warm, professional), Indian business English (Hinglish OK if the customer used it), no placeholders like [Name] — use what you know, max 60 words per option.
Return STRICT JSON only: {{"suggestions": ["option 1", "option 2"]}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    try:
        async with httpx.AsyncClient(timeout=30.0) as cli:
            resp = await cli.post(url, params={"key": GEMINI_API_KEY}, json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.7, "maxOutputTokens": 500, "responseMimeType": "application/json"},
            })
        if resp.status_code != 200:
            detail = (resp.json().get("error", {}) or {}).get("message", resp.text[:200]) if resp.text else str(resp.status_code)
            raise HTTPException(status_code=502, detail=f"Gemini error: {detail}")
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        suggestions = [s.strip() for s in (parsed.get("suggestions") or []) if isinstance(s, str) and s.strip()][:3]
        if not suggestions:
            raise ValueError("empty suggestions")
        return {"suggestions": suggestions, "intent": body.intent}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ai_suggest failed: {e}")
        raise HTTPException(status_code=502, detail="AI suggestion failed — try again")

@api.get("/ai/status")
async def ai_status(user: dict = Depends(get_current_user)):
    return {"configured": bool(GEMINI_API_KEY), "model": GEMINI_MODEL if GEMINI_API_KEY else None}

# ------------- Android app self-update -------------
# The LeadOrbit app polls this on launch. Publish a new version by dropping
# the APK + version.json into backend/uploads/app/ (see version.json keys:
# version_code, version_name, apk_url, notes). Public endpoint — the app may
# check before login; the payload is not sensitive.

@api.get("/app/version")
async def app_version():
    vf = UPLOAD_DIR / "app" / "version.json"
    if not vf.exists():
        raise HTTPException(status_code=404, detail="No app version published")
    try:
        return json.loads(vf.read_text(encoding="utf-8"))
    except Exception as e:
        logger.error(f"app_version: bad version.json: {e}")
        raise HTTPException(status_code=500, detail="version.json is invalid")

# ------------- Attendance & Payroll Endpoints -------------

@api.get("/holidays")
async def list_holidays(user: dict = Depends(get_current_user)):
    hols = await db.holidays.find().to_list(1000)
    for h in hols:
        h.pop("_id", None)
    return hols

@api.post("/holidays")
async def create_holiday(body: HolidayCreate, admin: dict = Depends(require_admin)):
    existing = await db.holidays.find_one({"date": body.date})
    if existing:
        raise HTTPException(status_code=409, detail="Holiday for this date already exists")
    if body.holiday_type == "early_off" and not body.early_off_time:
        raise HTTPException(status_code=400, detail="early_off_time (HH:MM) required for an early-off day")
    doc = {
        "id": str(uuid.uuid4()),
        "date": body.date,
        "name": body.name,
        "is_paid": body.is_paid,
        "holiday_type": body.holiday_type,
        "early_off_time": body.early_off_time,
    }
    await db.holidays.insert_one(doc.copy())
    return doc

@api.delete("/holidays/{holiday_id}")
async def delete_holiday(holiday_id: str, admin: dict = Depends(require_admin)):
    res = await db.holidays.delete_one({"id": holiday_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"ok": True}

@api.get("/attendance/status")
async def get_attendance_status(user: dict = Depends(get_current_user)):
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")
    log = await db.attendance_logs.find_one({"user_id": user["id"], "date": today_ist}, {"_id": 0})
    if not log:
        return {"checked_in": False, "checked_out": False}
    return {
        "checked_in": "check_in" in log,
        "check_in_time": log.get("check_in", {}).get("time") if log else None,
        "checked_out": "check_out" in log,
        "check_out_time": log.get("check_out", {}).get("time") if log else None
    }

class ManualPunchInput(BaseModel):
    username: str
    password: str

PUNCH_FREEZE_MINUTES_DEFAULT = 2

def _punch_freeze_seconds(settings_doc: dict) -> float:
    try:
        return float(settings_doc.get("punch_freeze_minutes", PUNCH_FREEZE_MINUTES_DEFAULT)) * 60.0
    except Exception:
        return PUNCH_FREEZE_MINUTES_DEFAULT * 60.0

def _seconds_since_punch(prev_iso: str, now_dt: datetime):
    """Wall-clock seconds between a stored punch time and now. Punch times are
    IST wall time from mixed sources (some naive, some with a stale tz offset),
    so compare naively."""
    try:
        prev = datetime.fromisoformat(prev_iso)
        if prev.tzinfo is not None:
            prev = prev.replace(tzinfo=None)
        cur = now_dt.replace(tzinfo=None) if now_dt.tzinfo is not None else now_dt
        return abs((cur - prev).total_seconds())
    except Exception:
        return None

@api.post("/attendance/punch")
async def punch_attendance(user: dict = Depends(get_current_user)):
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    now_str = now_ist.isoformat()
    
    settings_doc = await db.attendance_settings.find_one({"key": "general_settings"}) or {}
    log = await db.attendance_logs.find_one({"user_id": user["id"], "date": today_ist})
    
    if not log:
        # Punch In
        log_doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "date": today_ist,
            "check_in": {
                "time": now_str,
                "photo_path": "web_dashboard_punch",
                "verification_score": 0.0
            },
            "status": "present"
        }
        
        shift_start_str = settings_doc.get("shift_start", "09:30")
        grace_mins = settings_doc.get("grace_period_minutes", 15)
        try:
            sh_h, sh_m = map(int, shift_start_str.split(":"))
            checkin_h, checkin_m = now_ist.hour, now_ist.minute
            minutes_late = (checkin_h * 60 + checkin_m) - (sh_h * 60 + sh_m)
            if minutes_late > grace_mins:
                log_doc["status"] = "late"
        except Exception:
            pass
            
        await db.attendance_logs.insert_one(log_doc.copy())
        return {
            "status": "success",
            "action": "check_in",
            "user_name": user["name"],
            "time": now_str
        }
        
    elif "check_out" not in log:
        # Punch Out
        freeze_secs = _punch_freeze_seconds(settings_doc)
        since_in = _seconds_since_punch(log.get("check_in", {}).get("time", ""), now_ist)
        if since_in is not None and since_in < freeze_secs:
            raise HTTPException(status_code=429, detail=f"Punch ignored: checked in {int(since_in)}s ago. Wait {int(freeze_secs // 60)} min before punching again.")

        total_hours = 0.0
        try:
            in_time = datetime.fromisoformat(log["check_in"]["time"])
            diff = now_ist - in_time
            total_hours = round(diff.total_seconds() / 3600.0, 2)
        except Exception:
            pass
            
        update_fields = {
            "check_out": {
                "time": now_str,
                "photo_path": "web_dashboard_punch",
                "verification_score": 0.0
            },
            "total_hours": total_hours
        }
        
        await db.attendance_logs.update_one({"id": log["id"]}, {"$set": update_fields})
        return {
            "status": "success",
            "action": "check_out",
            "user_name": user["name"],
            "time": now_str,
            "total_hours": total_hours
        }
    else:
        raise HTTPException(status_code=400, detail="Already checked out for today")

@api.post("/attendance/manual-punch")
async def manual_punch(body: ManualPunchInput):
    uname = body.username.strip().lower()
    user = await db.users.find_one({"username": uname})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.get("active", True):
        raise HTTPException(status_code=403, detail="Account disabled")
        
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    now_str = now_ist.isoformat()
    
    settings_doc = await db.attendance_settings.find_one({"key": "general_settings"}) or {}
    log = await db.attendance_logs.find_one({"user_id": user["id"], "date": today_ist})
    
    if not log:
        # Check in
        log_doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "date": today_ist,
            "check_in": {
                "time": now_str,
                "photo_path": "manual_punch",
                "verification_score": 0.0
            },
            "status": "present"
        }
        
        shift_start_str = settings_doc.get("shift_start", "09:30")
        grace_mins = settings_doc.get("grace_period_minutes", 15)
        try:
            sh_h, sh_m = map(int, shift_start_str.split(":"))
            checkin_h, checkin_m = now_ist.hour, now_ist.minute
            minutes_late = (checkin_h * 60 + checkin_m) - (sh_h * 60 + sh_m)
            if minutes_late > grace_mins:
                log_doc["status"] = "late"
        except Exception:
            pass
            
        await db.attendance_logs.insert_one(log_doc.copy())
        return {
            "status": "success",
            "action": "check_in",
            "user_name": user["name"],
            "time": now_str
        }
        
    elif "check_out" not in log:
        # Check out
        freeze_secs = _punch_freeze_seconds(settings_doc)
        since_in = _seconds_since_punch(log.get("check_in", {}).get("time", ""), now_ist)
        if since_in is not None and since_in < freeze_secs:
            raise HTTPException(status_code=429, detail=f"Punch ignored: checked in {int(since_in)}s ago. Wait {int(freeze_secs // 60)} min before punching again.")

        total_hours = 0.0
        try:
            in_time = datetime.fromisoformat(log["check_in"]["time"])
            diff = now_ist - in_time
            total_hours = round(diff.total_seconds() / 3600.0, 2)
        except Exception:
            pass
            
        update_fields = {
            "check_out": {
                "time": now_str,
                "photo_path": "manual_punch",
                "verification_score": 0.0
            },
            "total_hours": total_hours
        }
        
        await db.attendance_logs.update_one({"id": log["id"]}, {"$set": update_fields})
        return {
            "status": "success",
            "action": "check_out",
            "user_name": user["name"],
            "time": now_str,
            "total_hours": total_hours
        }
    else:
        raise HTTPException(status_code=400, detail="Already checked out for today")


# ------------- ZKTeco / eSSL ADMS (iClock) Protocol Endpoints -------------

async def _register_device_punch(emp_code: str, time_str: str):
    user = await db.users.find_one({"employee_code": emp_code, "active": True})
    if not user:
        logger.warning(f"Device punch: user with employee_code={emp_code} not found or inactive")
        return False
        
    try:
        dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
    except Exception:
        try:
            dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M")
        except Exception:
            dt = datetime.now()
            
    punch_date = dt.strftime("%Y-%m-%d")
    punch_time_str = dt.isoformat()
    
    log = await db.attendance_logs.find_one({"user_id": user["id"], "date": punch_date})
    settings_doc = await db.attendance_settings.find_one({"key": "general_settings"}) or {}
    
    if not log:
        log_doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "date": punch_date,
            "check_in": {
                "time": punch_time_str,
                "photo_path": "fingerprint_device",
                "verification_score": 0.0
            },
            "status": "present"
        }
        
        shift_start_str = settings_doc.get("shift_start", "09:30")
        grace_mins = settings_doc.get("grace_period_minutes", 15)
        try:
            sh_h, sh_m = map(int, shift_start_str.split(":"))
            checkin_h, checkin_m = dt.hour, dt.minute
            minutes_late = (checkin_h * 60 + checkin_m) - (sh_h * 60 + sh_m)
            if minutes_late > grace_mins:
                log_doc["status"] = "late"
        except Exception:
            pass
            
        await db.attendance_logs.insert_one(log_doc.copy())
        logger.info(f"Registered check-in for user {user['name']} via fingerprint device")
        return True
        
    elif "check_out" not in log:
        # Freeze window: fingerprint readers often register the same finger
        # 2-3 times in a row; don't let a duplicate scan become a check-out.
        freeze_secs = _punch_freeze_seconds(settings_doc)
        since_in = _seconds_since_punch(log.get("check_in", {}).get("time", ""), dt)
        if since_in is not None and since_in < freeze_secs:
            logger.info(f"Ignoring duplicate device punch for {user['name']}: {since_in:.0f}s since check-in (freeze {freeze_secs:.0f}s)")
            return False

        total_hours = 0.0
        try:
            in_time = datetime.fromisoformat(log["check_in"]["time"])
            diff = dt - in_time
            total_hours = round(diff.total_seconds() / 3600.0, 2)
        except Exception:
            pass

        update_fields = {
            "check_out": {
                "time": punch_time_str,
                "photo_path": "fingerprint_device",
                "verification_score": 0.0
            },
            "total_hours": total_hours
        }
        
        await db.attendance_logs.update_one({"id": log["id"]}, {"$set": update_fields})
        logger.info(f"Registered check-out for user {user['name']} via fingerprint device")
        return True
    else:
        logger.info(f"User {user['name']} already checked out today. Ignoring extra device punch.")
        return False

@api.get("/iclock/cdata")
@api.get("/iclock/cdata.aspx")
async def iclock_get(request: Request, SN: Optional[str] = Query(None)):
    res_text = (
        f"GET OPTION FROM: {SN or 'device'}\n"
        "Stamp=0\n"
        "OpStamp=0\n"
        "ErrorDelay=30\n"
        "Delay=10\n"
        "TransInterval=1\n"
        "TransFlag=1111111111\n"
        "Realtime=1\n"
        "SessionID=1234567890\n"
    )
    return Response(content=res_text, media_type="text/plain")

# Comma-separated allow-list of fingerprint-device serial numbers. Empty = allow
# all (backward compatible); set ICLOCK_ALLOWED_SN in .env to lock it down.
_ICLOCK_ALLOWED_SN = {s.strip() for s in os.environ.get("ICLOCK_ALLOWED_SN", "").split(",") if s.strip()}

def _iclock_sn_allowed(sn: Optional[str]) -> bool:
    return not _ICLOCK_ALLOWED_SN or (sn or "").strip() in _ICLOCK_ALLOWED_SN

@api.post("/iclock/cdata")
@api.post("/iclock/cdata.aspx")
async def iclock_post(request: Request, table: str = Query(...), SN: str = Query(...)):
    if not _iclock_sn_allowed(SN):
        logger.warning(f"iclock: rejected punch data from unknown device SN={SN}")
        raise HTTPException(status_code=403, detail="Unknown device")
    body = await request.body()
    content = body.decode('utf-8', errors='ignore')
    logger.info(f"ADMS Post received: table={table}, SN={SN}, body={content}")
    
    if table.upper() == "ATTLOG":
        lines = content.splitlines()
        success_count = 0
        for line in lines:
            if not line.strip():
                continue
            parts = line.strip().split()
            if len(parts) >= 2:
                emp_code = parts[0]
                time_str = parts[1]
                if len(parts) >= 3:
                    time_str = parts[1] + " " + parts[2]
                
                try:
                    if await _register_device_punch(emp_code, time_str):
                        success_count += 1
                except Exception as ex:
                    logger.error(f"Failed to register device punch for {emp_code} at {time_str}: {ex}")
                    
        return Response(content=f"OK: {success_count}\n", media_type="text/plain")
        
    return Response(content="OK\n", media_type="text/plain")

@api.get("/iclock/getrequest")
@api.get("/iclock/getrequest.aspx")
async def iclock_getrequest(request: Request, SN: str = Query(...)):
    return Response(content="OK\n", media_type="text/plain")

@api.post("/iclock/devicecmd")
@api.post("/iclock/devicecmd.aspx")
async def iclock_devicecmd(request: Request, SN: str = Query(...)):
    return Response(content="OK\n", media_type="text/plain")

@api.post("/attendance/register-face")
async def register_face(body: FaceRegisterInput, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({"id": body.user_id})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one({"id": body.user_id}, {"$set": {"face_embedding": body.face_embedding}})
    return {"ok": True, "message": f"Successfully registered face embedding for {u.get('name')}"}

@api.post("/attendance/verify")
async def verify_attendance(body: FaceVerifyInput, request: Request, scanner_user: dict = Depends(get_current_user)):
    import numpy as np
    import base64

    # Verify that the scanner_user is indeed active and has scanner access (or admin)
    if not (scanner_user.get("scanner_access") or scanner_user.get("role") == "admin"):
        raise HTTPException(status_code=403, detail="Only scanner devices or admins can perform attendance verification")
    
    settings_doc = await db.attendance_settings.find_one({"key": "general_settings"}) or {}
    if settings_doc.get("enforce_ip_lock") and settings_doc.get("allowed_office_ips"):
        client_ip = request.client.host
        if client_ip not in settings_doc["allowed_office_ips"]:
            raise HTTPException(status_code=403, detail=f"IP {client_ip} not authorized for scanner device")
            
    users = await db.users.find({
        "face_embedding": {"$exists": True, "$ne": None}, 
        "active": True
    }, {"_id": 0, "id": 1, "name": 1, "username": 1, "face_embedding": 1}).to_list(1000)
    
    if not users:
        raise HTTPException(status_code=404, detail="No users with registered face embeddings found in database")
        
    uploaded_vector = np.array(body.face_embedding)
    best_user = None
    min_distance = 999.0
    
    for u in users:
        db_vector = np.array(u["face_embedding"])
        dist = np.linalg.norm(uploaded_vector - db_vector)
        if dist < min_distance:
            min_distance = dist
            best_user = u
            
    match_threshold = settings_doc.get("match_threshold", 0.6)
    if min_distance > match_threshold:
        raise HTTPException(status_code=401, detail=f"No matching face found (best score: {round(min_distance, 3)})")
        
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")
    now_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30))
    now_str = now_ist.isoformat()
    
    photo_path = None
    if body.photo_base64:
        try:
            header, encoded = body.photo_base64.split(",", 1)
            file_data = base64.b64decode(encoded)
            filename = f"attendance_{best_user['id']}_{now_ist.strftime('%Y%m%d_%H%M%S')}.jpg"
            dest_file = UPLOAD_DIR / filename
            with open(dest_file, "wb") as f:
                f.write(file_data)
            photo_path = f"api/uploads/{filename}"
        except Exception as e:
            logger.error(f"Failed to save attendance photo: {e}")
            
    log = await db.attendance_logs.find_one({"user_id": best_user["id"], "date": today_ist})
    
    if not log:
        log_doc = {
            "id": str(uuid.uuid4()),
            "user_id": best_user["id"],
            "date": today_ist,
            "check_in": {
                "time": now_str,
                "photo_path": photo_path,
                "verification_score": float(min_distance)
            },
            "status": "present"
        }
        
        shift_start_str = settings_doc.get("shift_start", "09:30")
        grace_mins = settings_doc.get("grace_period_minutes", 15)
        try:
            sh_h, sh_m = map(int, shift_start_str.split(":"))
            checkin_h, checkin_m = now_ist.hour, now_ist.minute
            minutes_late = (checkin_h * 60 + checkin_m) - (sh_h * 60 + sh_m)
            if minutes_late > grace_mins:
                log_doc["status"] = "late"
        except Exception:
            pass
            
        await db.attendance_logs.insert_one(log_doc.copy())
        return {
            "status": "success",
            "action": "check_in",
            "user_name": best_user["name"],
            "time": now_str
        }
        
    elif "check_out" not in log:
        freeze_secs = _punch_freeze_seconds(settings_doc)
        since_in = _seconds_since_punch(log.get("check_in", {}).get("time", ""), now_ist)
        if since_in is not None and since_in < freeze_secs:
            return {
                "status": "ignored",
                "user_name": best_user["name"],
                "message": f"Duplicate scan ignored: checked in {int(since_in)}s ago"
            }

        total_hours = 0.0
        try:
            in_time = datetime.fromisoformat(log["check_in"]["time"])
            diff = now_ist - in_time
            total_hours = round(diff.total_seconds() / 3600.0, 2)
        except Exception:
            pass

        update_fields = {
            "check_out": {
                "time": now_str,
                "photo_path": photo_path,
                "verification_score": float(min_distance)
            },
            "total_hours": total_hours
        }
        
        await db.attendance_logs.update_one({"id": log["id"]}, {"$set": update_fields})
        return {
            "status": "success",
            "action": "check_out",
            "user_name": best_user["name"],
            "time": now_str,
            "total_hours": total_hours
        }
    else:
        return {
            "status": "already_completed",
            "user_name": best_user["name"],
            "message": "Already checked out for today"
        }

@api.get("/attendance/settings")
async def get_attendance_settings_ep(admin: dict = Depends(require_admin)):
    cfg = await get_attendance_config()
    users = await db.users.find(
        {"active": True, "role": {"$ne": "admin"}},
        {"_id": 0, "id": 1, "name": 1, "username": 1, "role": 1}
    ).to_list(200)
    cfg["all_users"] = [u for u in users if u.get("username") not in ("scanner", "test_user")]
    return cfg


@api.put("/attendance/settings")
async def update_attendance_settings_ep(body: AttendanceSettingsInput, admin: dict = Depends(require_admin)):
    patch = {k: v for k, v in body.dict().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=400, detail="No changes supplied")
    patch["updated_by"] = admin["id"]
    patch["updated_at"] = iso(now_utc())
    await db.attendance_settings.update_one({"key": "general_settings"}, {"$set": patch}, upsert=True)
    return await get_attendance_config()


@api.post("/attendance/edit")
async def edit_attendance_punch(body: PunchEditInput, admin: dict = Depends(require_admin)):
    """Admin manual override of punch times for any employee/date.
    Payroll recalculates automatically since it always reads attendance_logs live."""
    if not _valid_date_str(body.date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    u = await db.users.find_one({"id": body.user_id}, {"_id": 0, "id": 1, "name": 1})
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    log = await db.attendance_logs.find_one({"user_id": body.user_id, "date": body.date})

    if body.remove:
        if log:
            await db.attendance_logs.delete_one({"id": log["id"]})
            await log_activity(admin["id"], "attendance_punch_removed", None, {"user_id": body.user_id, "date": body.date})
        return {"ok": True, "removed": True}

    def _mk_time(hhmm: str) -> str:
        try:
            h, m = map(int, hhmm.split(":"))
            return f"{body.date}T{h:02d}:{m:02d}:00"
        except Exception:
            raise HTTPException(status_code=400, detail="times must be HH:MM")

    updates: Dict[str, Any] = {}
    if body.check_in:
        updates["check_in"] = {"time": _mk_time(body.check_in), "photo_path": "admin_manual_edit", "verification_score": 0.0}
    if body.clear_check_out:
        pass  # handled below via $unset
    elif body.check_out:
        updates["check_out"] = {"time": _mk_time(body.check_out), "photo_path": "admin_manual_edit", "verification_score": 0.0}

    if not log and not updates.get("check_in"):
        raise HTTPException(status_code=400, detail="check_in required to create a new day record")

    if not log:
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": body.user_id,
            "date": body.date,
            "status": "present",
            "edited_by": admin["id"],
            **updates,
        }
        await db.attendance_logs.insert_one(doc.copy())
        log = doc
    else:
        ops: Dict[str, Any] = {}
        if updates:
            ops["$set"] = {**updates, "edited_by": admin["id"]}
        if body.clear_check_out:
            ops.setdefault("$set", {})["edited_by"] = admin["id"]
            ops["$unset"] = {"check_out": "", "total_hours": ""}
        if ops:
            await db.attendance_logs.update_one({"id": log["id"]}, ops)
        log = await db.attendance_logs.find_one({"user_id": body.user_id, "date": body.date})

    # recompute total_hours + status
    try:
        cfg = await get_attendance_config()
        in_t = (log.get("check_in") or {}).get("time")
        out_t = (log.get("check_out") or {}).get("time")
        patch: Dict[str, Any] = {}
        if in_t:
            in_mins = int(in_t[11:13]) * 60 + int(in_t[14:16])
            patch["status"] = "present" if in_mins <= _hhmm_to_minutes(cfg["late_grace_until"], 660) else "late"
        if in_t and out_t:
            diff = datetime.fromisoformat(out_t) - datetime.fromisoformat(in_t)
            patch["total_hours"] = round(diff.total_seconds() / 3600.0, 2)
        if patch:
            await db.attendance_logs.update_one({"id": log["id"]}, {"$set": patch})
    except Exception:
        pass

    await log_activity(admin["id"], "attendance_punch_edited", None, {"user_id": body.user_id, "date": body.date})
    final = await db.attendance_logs.find_one({"user_id": body.user_id, "date": body.date}, {"_id": 0})
    return {"ok": True, "log": final}


@api.get("/attendance/today")
async def attendance_today(admin: dict = Depends(require_admin)):
    """Live view: every employee's punches + availability for today (IST)."""
    cfg = await get_attendance_config()
    today = _ist_now().strftime("%Y-%m-%d")
    users = await db.users.find(
        {"active": True, "role": {"$ne": "admin"}},
        {"_id": 0, "password_hash": 0}
    ).to_list(200)
    users = [u for u in users if u.get("username") not in ("scanner", "test_user")
             and (u.get("employee_code") or u.get("role") == "executive")]
    office_open = await _office_open_now(cfg)
    out = []
    for u in users:
        log = await db.attendance_logs.find_one({"user_id": u["id"], "date": today}, {"_id": 0})
        leave = await _is_user_on_leave(u["id"])
        out.append({
            "user_id": u["id"],
            "name": u["name"],
            "username": u["username"],
            "role": u.get("role"),
            "department": u.get("department"),
            "employee_code": u.get("employee_code"),
            "check_in": (log or {}).get("check_in", {}).get("time"),
            "check_out": ((log or {}).get("check_out") or {}).get("time"),
            "status": (log or {}).get("status"),
            "on_leave": bool(leave),
            "available_for_leads": await _is_user_available_by_attendance(u) if u.get("role") == "executive" else None,
        })
    return {"date": today, "office_open": office_open, "employees": out}


def _pay_date_for_period_end(joining_date_str: str, end_date_str: str) -> Optional[str]:
    """Salary is paid on the 8th day after the joining-day anniversary:
    joined on the 10th -> cycle ends the 9th -> paid on the 18th (= end + 9 days)."""
    try:
        end_dt = datetime.strptime(end_date_str, "%Y-%m-%d")
        return (end_dt + timedelta(days=9)).strftime("%Y-%m-%d")
    except Exception:
        return None


@api.get("/payroll/calculate")
async def calculate_payroll(
    start_date: str,
    end_date: str,
    user_id: Optional[str] = None,
    admin: dict = Depends(require_admin)
):
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
    if start_dt > end_dt:
        raise HTTPException(status_code=400, detail="start_date cannot be after end_date")

    cfg = await get_attendance_config()
    office_start_m = _hhmm_to_minutes(cfg["office_start"], 630)       # 10:30
    late_until_m = _hhmm_to_minutes(cfg["late_grace_until"], 660)     # 11:00
    office_end_m = _hhmm_to_minutes(cfg["office_end"], 1140)          # 19:00
    full_out_m = office_end_m - int(cfg.get("full_day_out_grace_minutes") or 0)
    half_cutoff_m = _hhmm_to_minutes(cfg["half_day_cutoff"], 900)     # 15:00
    late_streak_n = int(cfg.get("late_streak_threshold") or 3)

    date_list = [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d")
                 for i in range((end_dt - start_dt).days + 1)]
    today_ist = _ist_now().strftime("%Y-%m-%d")
    # Sunday sandwich-rule looks at the day before the first Sunday and the day
    # after the last one — widen lookups by 6 days back and 1 day forward.
    lookback_date = (start_dt - timedelta(days=6)).strftime("%Y-%m-%d")
    lookahead_date = (end_dt + timedelta(days=1)).strftime("%Y-%m-%d")

    # Payroll covers every active employee on the machine (any department) + all executives.
    users_list = await db.users.find(
        {"active": True, "role": {"$ne": "admin"}},
        {"_id": 0, "password_hash": 0}
    ).to_list(200)
    users_list = [u for u in users_list if u.get("username") not in ("scanner", "test_user")
                  and (u.get("employee_code") or u.get("role") == "executive")]
    if user_id:
        users_list = [u for u in users_list if u["id"] == user_id]
    users_list.sort(key=lambda u: (u.get("department") or "zz", u.get("name") or ""))

    holidays_list = await db.holidays.find({"date": {"$gte": lookback_date, "$lte": lookahead_date}}).to_list(1000)
    holidays_map = {h["date"]: h for h in holidays_list}

    def _mins_of(time_iso: Optional[str]) -> Optional[int]:
        if not time_iso:
            return None
        try:
            return int(time_iso[11:13]) * 60 + int(time_iso[14:16])
        except Exception:
            return None

    results = []
    for u in users_list:
        uid = u["id"]
        joining_date_str = u.get("joining_date") or today_ist
        base_salary = float(u.get("base_salary") or 0.0)
        daily_rate = base_salary / 31.0  # flat /31 as per company policy

        att_list = await db.attendance_logs.find(
            {"user_id": uid, "date": {"$gte": lookback_date, "$lte": lookahead_date}}).to_list(1000)
        att_map = {a["date"]: a for a in att_list}

        leaves_list = await db.leaves.find({
            "user_id": uid,
            "cancelled": {"$ne": True},
            "start_date": {"$lte": end_date},
            "end_date": {"$gte": start_date},
        }).to_list(200)

        def leave_on(d_str):
            for lv in leaves_list:
                if lv["start_date"] <= d_str <= lv["end_date"]:
                    return lv
            return None

        adjs_list = await db.payroll_adjustments.find(
            {"user_id": uid, "date": {"$gte": lookback_date, "$lte": lookahead_date}}).to_list(1000)
        adjs_map = {ad["date"]: ad["status"] for ad in adjs_list}

        def worked_credit(d_str: str) -> float:
            """How much of a working day this date counts for (full=1, half=0.5).
            Used for Sunday eligibility: a Sunday is paid only when the employee
            worked >= 5 days in the Mon–Sat before it."""
            hol = holidays_map.get(d_str)
            if hol and (hol.get("holiday_type") or "full") == "full":
                return 1.0  # company holiday shouldn't cost anyone their Sunday
            adj = adjs_map.get(d_str)
            if adj and adj != "auto":
                if adj in ("present", "wfh", "paid"):
                    return 1.0
                if adj == "half_day":
                    return 0.5
                return 0.0
            a = att_map.get(d_str)
            if not a:
                return 0.0
            in_t = (a.get("check_in") or {}).get("time")
            out_t = ((a.get("check_out") or {}).get("time")) if a.get("check_out") else None
            in_m2, out_m2 = _mins_of(in_t), _mins_of(out_t)
            if in_m2 is None:
                return 0.0
            if out_m2 is None:
                return 1.0 if d_str == today_ist else 0.5
            day_full = full_out_m
            if hol and hol.get("holiday_type") == "early_off" and hol.get("early_off_time"):
                day_full = min(full_out_m, _hhmm_to_minutes(hol["early_off_time"], office_end_m))
            if out_m2 >= day_full:
                return 1.0
            if out_m2 >= half_cutoff_m:
                return 0.5
            return 0.0

        daily_breakdown = []
        target_earnings = 0.0
        total_deductions = 0.0
        counts = {"present": 0.0, "half_day": 0, "leave_approved": 0, "absent_informed": 0,
                  "absent_uninformed": 0, "holiday": 0, "weekly_off": 0, "sunday_unpaid": 0,
                  "late": 0, "after_grace": 0, "early_exit": 0, "wfh": 0, "missing_punch_out": 0}
        flags = []
        late_streak = 0
        late_streak_flagged = False
        sunday_rows = []  # finalized after the loop (quota + sandwich rule)

        for d_str in date_list:
            dt = datetime.strptime(d_str, "%Y-%m-%d")
            is_sunday = dt.weekday() == 6
            hol = holidays_map.get(d_str)
            is_full_holiday = bool(hol and (hol.get("holiday_type") or "full") == "full")
            early_off_m = _hhmm_to_minutes(hol["early_off_time"], office_end_m) if (hol and hol.get("holiday_type") == "early_off" and hol.get("early_off_time")) else None
            day_full_out_m = min(full_out_m, early_off_m) if early_off_m else full_out_m

            day = {"date": d_str, "weekday": dt.strftime("%A"), "status": "absent_uninformed",
                   "earning": 0.0, "deduction": 0.0, "details": "", "punch_in": None,
                   "punch_out": None, "work_hours": None, "flags": []}

            log = att_map.get(d_str)
            in_m = out_m = None
            if log:
                in_t = (log.get("check_in") or {}).get("time")
                out_t = ((log.get("check_out") or {}).get("time")) if log.get("check_out") else None
                day["punch_in"] = in_t[11:16] if in_t else None
                day["punch_out"] = out_t[11:16] if out_t else None
                in_m, out_m = _mins_of(in_t), _mins_of(out_t)
                if log.get("total_hours") is not None:
                    day["work_hours"] = log["total_hours"]
                elif in_m is not None and out_m is not None:
                    day["work_hours"] = round((out_m - in_m) / 60.0, 2)

            if d_str < joining_date_str:
                day["status"] = "not_joined"
                day["details"] = "Not yet joined"
                daily_breakdown.append(day)
                continue
            if d_str > today_ist:
                day["status"] = "future"
                day["details"] = ""
                daily_breakdown.append(day)
                continue

            target_earnings += daily_rate
            adj = adjs_map.get(d_str)
            worked_day = (not is_sunday) and (not is_full_holiday)

            # late tracking happens on worked days regardless of the final status
            if worked_day and in_m is not None:
                if in_m > office_start_m:
                    counts["late"] += 1
                    late_streak += 1
                    if late_streak >= late_streak_n and not late_streak_flagged:
                        flags.append(f"Late {late_streak_n}+ days in a row (after {cfg['office_start']}), last on {d_str}")
                        late_streak_flagged = True
                else:
                    late_streak = 0
                    late_streak_flagged = False
                if in_m > late_until_m:
                    counts["after_grace"] += 1
                    day["flags"].append(f"Arrived after {cfg['late_grace_until']}")
            elif worked_day and log is None:
                late_streak = 0
                late_streak_flagged = False

            if adj and adj != "auto":
                if adj == "present":
                    day.update(status="excused_present", earning=daily_rate, details="Present (Admin Override)")
                    counts["present"] += 1.0
                elif adj == "wfh":
                    day.update(status="wfh", earning=daily_rate, details="Work From Home (Admin)")
                    counts["wfh"] += 1
                    counts["present"] += 1.0
                elif adj == "paid":
                    day.update(status="paid_leave", earning=daily_rate, details="Paid Leave / Comp-off (Admin)")
                elif adj == "half_day":
                    day.update(status="half_day", earning=0.5 * daily_rate, deduction=0.5 * daily_rate,
                               details="Half Day (Admin Override)")
                    total_deductions += 0.5 * daily_rate
                    counts["half_day"] += 1
                    counts["present"] += 0.5
                elif adj == "informed":
                    day.update(status="absent_informed", deduction=daily_rate,
                               details="Informed Absence (Admin Override, 1 day cut)")
                    total_deductions += daily_rate
                    counts["absent_informed"] += 1
                elif adj == "uninformed":
                    day.update(status="absent_uninformed", deduction=2.0 * daily_rate,
                               details="Uninformed Absence (Admin Override, 2 days cut)")
                    total_deductions += 2.0 * daily_rate
                    counts["absent_uninformed"] += 1
                elif adj == "leave":
                    day.update(status="leave_approved", deduction=daily_rate,
                               details="Approved Leave (Admin Override, 1 day cut)")
                    total_deductions += daily_rate
                    counts["leave_approved"] += 1
                daily_breakdown.append(day)
                continue

            if is_sunday:
                # Provisional — paid/unpaid decided after the loop from the
                # period-total quota and the sandwich rule.
                day["status"] = "weekly_off"
                day["details"] = "Sunday"
                sunday_rows.append(day)
            elif is_full_holiday:
                day.update(status="holiday", earning=daily_rate, details=f"Holiday: {hol.get('name')} (Paid)")
                counts["holiday"] += 1
            elif log and in_m is not None:
                in_s, out_s = day["punch_in"] or "--:--", day["punch_out"] or "--:--"
                if out_m is None:
                    if d_str == today_ist:
                        day.update(status="present", earning=daily_rate,
                                   details=f"Checked in {in_s} (active)")
                        counts["present"] += 1.0
                    else:
                        day.update(status="missing_punch_out", earning=0.5 * daily_rate,
                                   deduction=0.5 * daily_rate,
                                   details=f"No punch-out (In {in_s}) — counted half day, verify")
                        total_deductions += 0.5 * daily_rate
                        counts["missing_punch_out"] += 1
                        counts["present"] += 0.5
                        day["flags"].append("Missing punch-out")
                elif out_m >= day_full_out_m:
                    label = "Present"
                    if early_off_m and out_m < full_out_m:
                        label = f"Present (early-off day: {hol.get('name')})"
                    day.update(status="present", earning=daily_rate, details=f"{label} ({in_s} – {out_s})")
                    counts["present"] += 1.0
                elif out_m >= half_cutoff_m:
                    day.update(status="half_day", earning=0.5 * daily_rate, deduction=0.5 * daily_rate,
                               details=f"Half Day — left {out_s} before {cfg['office_end']}")
                    total_deductions += 0.5 * daily_rate
                    counts["half_day"] += 1
                    counts["present"] += 0.5
                else:
                    day.update(status="early_exit", deduction=daily_rate,
                               details=f"Left {out_s} before {cfg['half_day_cutoff']} — full day cut")
                    total_deductions += daily_rate
                    counts["early_exit"] += 1
                    day["flags"].append(f"Punched out early at {out_s}")
            else:
                lv = leave_on(d_str)
                lv_status = (lv or {}).get("status") or ("approved" if lv else None)
                if lv and lv_status == "approved":
                    day.update(status="leave_approved", deduction=daily_rate,
                               details=f"Approved Leave (1 day cut){' — ' + lv.get('reason') if lv.get('reason') else ''}")
                    total_deductions += daily_rate
                    counts["leave_approved"] += 1
                elif lv and lv_status == "pending":
                    day.update(status="absent_uninformed", deduction=2.0 * daily_rate,
                               details="Absent — leave request PENDING approval (2 days cut until approved)")
                    total_deductions += 2.0 * daily_rate
                    counts["absent_uninformed"] += 1
                    day["flags"].append("Pending leave request")
                elif d_str == today_ist:
                    day.update(status="pending_today", details="No punch-in yet today")
                    target_earnings -= daily_rate  # don't judge today until it's over
                else:
                    rej = " (leave was rejected)" if (lv and lv_status == "rejected") else ""
                    day.update(status="absent_uninformed", deduction=2.0 * daily_rate,
                               details=f"Uninformed Absence{rej} — 2 days cut")
                    total_deductions += 2.0 * daily_rate
                    counts["absent_uninformed"] += 1

            daily_breakdown.append(day)

        # ---- Sunday pay allocation: PERIOD-TOTAL quota + sandwich rule ----
        # Paid Sundays = floor(total worked days in the period / 5) — 20 worked
        # days pays 4 Sundays, 15 pays 3, and so on. Independently, a Sunday
        # with leave/absence on BOTH the day before and after is always unpaid.
        total_credits = 0.0
        for d_str in date_list:
            if d_str < joining_date_str or d_str > today_ist:
                continue
            ddt = datetime.strptime(d_str, "%Y-%m-%d")
            if ddt.weekday() == 6:
                continue
            hol2 = holidays_map.get(d_str)
            if hol2 and (hol2.get("holiday_type") or "full") == "full":
                total_credits += 1.0  # a company holiday never costs a Sunday
            else:
                total_credits += worked_credit(d_str)
        sunday_quota = int(total_credits // 5.0)

        def _side_absent(x_str: str) -> bool:
            """True when x_str is a workday the employee did not work at all."""
            if x_str < joining_date_str or x_str > today_ist:
                return False  # outside knowable range → don't penalize
            xd = datetime.strptime(x_str, "%Y-%m-%d")
            if xd.weekday() == 6:
                return False
            xh = holidays_map.get(x_str)
            if xh and (xh.get("holiday_type") or "full") == "full":
                return False
            return worked_credit(x_str) <= 0.0

        for s_day in sunday_rows:
            sdt = datetime.strptime(s_day["date"], "%Y-%m-%d")
            prev_str = (sdt - timedelta(days=1)).strftime("%Y-%m-%d")
            next_str = (sdt + timedelta(days=1)).strftime("%Y-%m-%d")
            if _side_absent(prev_str) and _side_absent(next_str):
                s_day.update(status="weekly_off_unpaid", earning=0.0, deduction=daily_rate,
                             details="Sunday UNPAID — leave/absent on both the day before and the day after")
                total_deductions += daily_rate
                counts["sunday_unpaid"] += 1
            elif sunday_quota > 0:
                sunday_quota -= 1
                s_day.update(status="weekly_off", earning=daily_rate,
                             details=f"Sunday (Paid — {total_credits:g} worked days in period)")
                counts["weekly_off"] += 1
            else:
                s_day.update(status="weekly_off_unpaid", earning=0.0, deduction=daily_rate,
                             details=f"Sunday UNPAID — only {total_credits:g} worked days in period (5 needed per paid Sunday)")
                total_deductions += daily_rate
                counts["sunday_unpaid"] += 1

        if counts["after_grace"] > 0:
            flags.append(f"Arrived after {cfg['late_grace_until']} on {counts['after_grace']} day(s)")
        if counts["early_exit"] > 0:
            flags.append(f"Punched out before {cfg['half_day_cutoff']} on {counts['early_exit']} day(s)")
        if counts["missing_punch_out"] > 0:
            flags.append(f"{counts['missing_punch_out']} day(s) missing punch-out — verify manually")
        if counts["sunday_unpaid"] > 0:
            flags.append(f"{counts['sunday_unpaid']} unpaid Sunday(s) — quota is 1 paid Sunday per 5 worked days, minus sandwiched Sundays")

        final_salary = max(0.0, target_earnings - total_deductions)
        payment = await db.salary_payments.find_one(
            {"user_id": uid, "period_start": start_date, "period_end": end_date}, {"_id": 0})
        results.append({
            "payment": payment,
            "user_id": uid,
            "name": u["name"],
            "username": u["username"],
            "role": u.get("role"),
            "department": u.get("department"),
            "employee_code": u.get("employee_code"),
            "joining_date": joining_date_str,
            "base_salary": base_salary,
            "daily_rate": round(daily_rate, 2),
            "pro_rated_target_salary": round(target_earnings, 2),
            "total_deductions": round(total_deductions, 2),
            "final_salary_payout": round(final_salary, 2),
            "pay_date": _pay_date_for_period_end(joining_date_str, end_date),
            "counts": counts,
            "flags": flags,
            "daily_breakdown": daily_breakdown,
        })

    return {
        "start_date": start_date,
        "end_date": end_date,
        "daily_rate_basis": 31,
        "payroll": results,
    }

class SalaryPaidInput(BaseModel):
    user_id: str
    period_start: str   # YYYY-MM-DD (cycle start)
    period_end: str     # YYYY-MM-DD (cycle end)
    paid: bool = True
    amount: Optional[float] = None
    note: Optional[str] = ""


@api.post("/payroll/mark-paid")
async def mark_salary_paid(body: SalaryPaidInput, admin: dict = Depends(require_admin)):
    """Tick/untick that the salary for a pay period was actually handed out.
    Drives the register 'PAID' badge and silences the pay-date reminders."""
    if not _valid_date_str(body.period_start) or not _valid_date_str(body.period_end):
        raise HTTPException(status_code=400, detail="period dates must be YYYY-MM-DD")
    u = await db.users.find_one({"id": body.user_id}, {"_id": 0, "id": 1, "name": 1})
    if not u:
        raise HTTPException(status_code=404, detail="user not found")
    key = {"user_id": body.user_id, "period_start": body.period_start, "period_end": body.period_end}
    if body.paid:
        await db.salary_payments.update_one(key, {"$set": {
            **key,
            "paid": True,
            "amount": body.amount,
            "note": (body.note or "").strip(),
            "paid_at": iso(now_utc()),
            "paid_by": admin["id"],
        }}, upsert=True)
    else:
        await db.salary_payments.delete_one(key)
    await log_activity(admin["id"], "salary_marked_paid" if body.paid else "salary_unmarked_paid",
                       None, {**key, "amount": body.amount})
    doc = await db.salary_payments.find_one(key, {"_id": 0})
    return {"ok": True, "payment": doc}


@api.post("/payroll/adjust")
async def adjust_payroll(body: PayrollAdjustInput, admin: dict = Depends(require_admin)):
    if body.status == "auto":
        await db.payroll_adjustments.delete_one({"user_id": body.user_id, "date": body.date})
    else:
        await db.payroll_adjustments.update_one(
            {"user_id": body.user_id, "date": body.date},
            {"$set": {"status": body.status, "updated_at": (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).isoformat(), "updated_by": admin["id"]}},
            upsert=True
        )
    return {"ok": True}

# Root ping for api
@api.get("/")
async def root():
    return {"service": "LeadOrbit CRM API", "status": "ok"}

app.include_router(api)

# REVERTED to permissive default (2026-07-20): a strict origin list broke real
# logins ("network error") for origin variants while adding little — the app is
# same-origin. Set CORS_ORIGINS in .env only with a verified full list.
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
