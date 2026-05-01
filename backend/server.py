from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import re
import json
import uuid
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal, Any, Dict

import bcrypt
import jwt
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Query
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, ConfigDict
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# ------------- Setup -------------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("crm")

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_ALGORITHM = "HS256"
JWT_SECRET = os.environ.get("JWT_SECRET", "devsecret")

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
    is matched on a digits-only suffix of length >= 7."""
    digits = re.sub(r"\D+", "", query or "")
    if not digits:
        return None
    if len(digits) >= 10:
        digits = digits[-10:]
    return re.escape(digits) + "$"


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


async def wa_send_text(to_phone: str, body: str) -> Dict[str, Any]:
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

def create_access_token(user_id: str, username: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "exp": now_utc() + timedelta(hours=12),
        "type": "access",
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

class UserCreate(BaseModel):
    username: str
    password: str
    name: str
    role: Literal["admin", "executive"] = "executive"
    active: bool = True
    working_hours: List[Dict[str, Any]] = []
    receiver_numbers: List[str] = []

class UserUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Literal["admin", "executive"]] = None
    active: Optional[bool] = None
    working_hours: Optional[List[Dict[str, Any]]] = None
    receiver_numbers: Optional[List[str]] = None

class ReceiverNumbersInput(BaseModel):
    receiver_numbers: List[str]

class LeadCreate(BaseModel):
    customer_name: str
    phone: Optional[str] = None
    phones: Optional[List[str]] = None
    email: Optional[str] = None
    requirement: Optional[str] = None
    area: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    source: str = "Manual"
    contact_link: Optional[str] = None
    source_data: Dict[str, Any] = {}
    assigned_to: Optional[str] = None  # user id

class LeadUpdate(BaseModel):
    customer_name: Optional[str] = None
    phone: Optional[str] = None
    phones: Optional[List[str]] = None
    aliases: Optional[List[str]] = None
    email: Optional[str] = None
    requirement: Optional[str] = None
    area: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    status: Optional[Literal["new", "contacted", "qualified", "converted", "lost"]] = None
    assigned_to: Optional[str] = None
    active_wa_phone: Optional[str] = None


CALL_OUTCOMES = ("connected", "no_response", "rejected", "not_reachable", "busy", "invalid")


class CallLogInput(BaseModel):
    phone: str
    outcome: Literal["connected", "no_response", "rejected", "not_reachable", "busy", "invalid"]
    summary: Optional[str] = None  # required only for outcome=connected


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
    user.pop("password_hash", None)
    return user

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# ------------- Auth endpoints -------------
@api.post("/auth/login")
async def login(body: LoginInput, response: Response):
    uname = body.username.strip().lower()
    user = await db.users.find_one({"username": uname})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.get("active", True):
        raise HTTPException(status_code=403, detail="Account disabled")
    token = create_access_token(user["id"], user["username"], user["role"])
    response.set_cookie(
        key="access_token", value=token, httponly=True, secure=False,
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
    # executives can list colleagues to see names, but not passwords
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
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
    }
    await db.users.insert_one(doc.copy())
    return strip_mongo(doc)

@api.patch("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    updates: Dict[str, Any] = {}
    for f in ["name", "role", "active", "working_hours"]:
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
        await db.users.update_one({"id": user_id}, {"$set": updates})
    doc = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return doc

@api.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    await db.users.delete_one({"id": user_id})
    return {"ok": True}

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
    weekday = at.weekday()
    hhmm = at.strftime("%H:%M")
    for slot in wh:
        try:
            if int(slot.get("weekday", -1)) == weekday:
                if slot.get("start", "00:00") <= hhmm <= slot.get("end", "23:59"):
                    return True
        except Exception:
            continue
    return False

async def pick_next_executive(exclude_user_id: Optional[str] = None) -> Optional[dict]:
    rules = await get_routing_rules()
    execs = await db.users.find(
        {"role": "executive", "active": True}, {"_id": 0, "password_hash": 0}
    ).to_list(500)
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
    if not eligible:
        eligible = [e for e in execs if e["id"] != exclude_user_id] or execs
    # sort deterministic
    eligible.sort(key=lambda e: e["username"])
    idx = int(rules.get("last_assigned_index", -1))
    idx = (idx + 1) % len(eligible)
    chosen = eligible[idx]
    await db.routing_rules.update_one(
        {"key": "default"}, {"$set": {"last_assigned_index": idx}}, upsert=True
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
    await db.leads.update_one(
        {"id": lead_id},
        {
            "$set": {"assigned_to": chosen_id, "last_assignment_at": iso(now_utc()), "opened_at": None},
            "$push": {"assignment_history": entry},
        },
    )
    await log_activity(by_user_id, "lead_assigned", lead_id, {"assigned_to": chosen_id})
    return chosen_id

async def auto_send_whatsapp_on_create(lead: dict):
    rules = await get_routing_rules()
    if not rules.get("auto_whatsapp_on_create", True):
        return
    if not lead.get("phone"):
        return  # cannot send without a recipient
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
        await db.leads.update_one({"id": lead["id"]}, {"$set": {"has_whatsapp": True}})

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
    # we return it so callers can decide whether to surface or 409.
    if data.get("phone"):
        existing_by_phone = await _find_lead_by_phone(data["phone"])
        if existing_by_phone:
            return existing_by_phone

    # Legacy hash dedup (kept for IndiaMART unique-id style payloads)
    dhash = data.get("dedup_hash")
    if dhash:
        existing = await db.leads.find_one({"dedup_hash": dhash}, {"_id": 0})
        if existing:
            return existing
    lead = {
        "id": str(uuid.uuid4()),
        "customer_name": data.get("customer_name", "Unknown"),
        "phone": data.get("phone"),
        "phones": data.get("phones") or [],
        "email": data.get("email"),
        "requirement": data.get("requirement"),
        "area": data.get("area"),
        "city": data.get("city"),
        "state": data.get("state"),
        "source": data.get("source", "Manual"),
        "contact_link": data.get("contact_link"),
        "source_data": data.get("source_data", {}),
        "raw_email_html": data.get("raw_email_html"),
        "raw_email_text": data.get("raw_email_text"),
        "dedup_hash": dhash,
        "status": "new",
        "assigned_to": data.get("assigned_to"),
        "assignment_history": [],
        "notes": [],
        "opened_at": None,
        "has_whatsapp": bool(data.get("has_whatsapp")),
        "last_action_at": iso(now_utc()),
        "created_at": data.get("_created_at_override") or iso(now_utc()),
    }
    await db.leads.insert_one(lead.copy())
    # auto-assign if no explicit assignee
    if not lead["assigned_to"]:
        try:
            await assign_lead(lead["id"], target_user_id=None, by_user_id=by_user_id)
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
    # auto WhatsApp welcome (mock)
    try:
        await auto_send_whatsapp_on_create(lead)
    except Exception as e:
        logger.warning(f"auto whatsapp failed: {e}")
    return lead

@api.get("/leads")
async def list_leads(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    source: Optional[str] = None,
    assigned_to: Optional[str] = None,
    last_call_outcome: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 500,
):
    query: Dict[str, Any] = {}
    if user["role"] == "executive":
        query["assigned_to"] = user["id"]
    else:
        if assigned_to:
            query["assigned_to"] = assigned_to
    if status:
        query["status"] = status
    if source:
        query["source"] = source
    if last_call_outcome:
        if last_call_outcome not in CALL_OUTCOMES:
            raise HTTPException(status_code=400, detail=f"Invalid outcome. Must be one of {CALL_OUTCOMES}")
        query["last_call_outcome"] = last_call_outcome
    if q:
        import re as _re
        q_safe = _re.escape(q)
        ors: List[Dict[str, Any]] = [
            {"customer_name": {"$regex": q_safe, "$options": "i"}},
            {"aliases": {"$regex": q_safe, "$options": "i"}},
            {"requirement": {"$regex": q_safe, "$options": "i"}},
            {"city": {"$regex": q_safe, "$options": "i"}},
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
    leads = await db.leads.find(query, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})\
        .sort("created_at", -1).to_list(limit)
    return leads

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
                    # Surface the existing lead — caller will open it
                    return {**existing, "duplicate": True, "existed": True}
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
    lead = await _create_lead_internal(data, by_user_id=user["id"])
    return lead

@api.get("/leads/{lead_id}")
async def get_lead(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    # mark opened (only assignee)
    if user["role"] == "executive" and not lead.get("opened_at"):
        await db.leads.update_one(
            {"id": lead_id}, {"$set": {"opened_at": iso(now_utc()), "last_action_at": iso(now_utc())}}
        )
        lead["opened_at"] = iso(now_utc())
        await log_activity(user["id"], "lead_opened", lead_id)
    return lead

@api.patch("/leads/{lead_id}")
async def update_lead(lead_id: str, body: LeadUpdate, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    updates: Dict[str, Any] = {}
    for f in ["customer_name", "phone", "phones", "aliases", "email", "requirement", "area", "city", "state", "status", "active_wa_phone"]:
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

@api.post("/leads/{lead_id}/notes")
async def add_note(lead_id: str, body: NoteInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
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
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    new_phone = normalize_phone_display((body.phone or "").strip())
    if not new_phone:
        raise HTTPException(status_code=400, detail="Phone required")
    existing_phones = list(lead.get("phones") or [])
    if new_phone == lead.get("phone") or new_phone in existing_phones:
        raise HTTPException(status_code=409, detail="Phone already on this lead")
    # Cross-lead dedup: stop the user from adding a phone that already lives on another lead
    other = await _find_lead_by_phone(new_phone, exclude_id=lead_id)
    if other:
        owner = await db.users.find_one({"id": other.get("assigned_to")}, {"_id": 0, "name": 1}) or {}
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_phone",
                "message": f"Phone {new_phone} is already on another lead ({other.get('customer_name')}).",
                "existing_lead_id": other["id"],
                "owned_by_id": other.get("assigned_to"),
                "owned_by_name": owner.get("name"),
            },
        )
    update: Dict[str, Any] = {"last_action_at": iso(now_utc())}
    if not lead.get("phone"):
        update["phone"] = new_phone  # first-ever phone → becomes primary
    else:
        existing_phones.append(new_phone)
        update["phones"] = existing_phones
    await db.leads.update_one({"id": lead_id}, {"$set": update})
    await log_activity(user["id"], "phone_added", lead_id, {"phone": new_phone})
    return await db.leads.find_one({"id": lead_id}, {"_id": 0})


@api.delete("/leads/{lead_id}/phones")
async def remove_phone(lead_id: str, phone: str = Query(...), user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
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

@api.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str, admin: dict = Depends(require_admin)):
    await db.leads.delete_one({"id": lead_id})
    await db.messages.delete_many({"lead_id": lead_id})
    await db.followups.delete_many({"lead_id": lead_id})
    return {"ok": True}

@api.get("/leads/{lead_id}/activity")
async def lead_activity(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
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
async def list_messages(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    msgs = await db.messages.find({"lead_id": lead_id}, {"_id": 0}).sort("at", 1).to_list(500)
    return msgs


# ------------- Call logs -------------
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
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    if body.outcome == "connected" and not (body.summary or "").strip():
        raise HTTPException(status_code=400, detail="Conversation summary is required for a connected call")
    doc = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "phone": body.phone,
        "outcome": body.outcome,
        "summary": (body.summary or "").strip() if body.outcome == "connected" else None,
        "by_user_id": user["id"],
        "by_user_name": user["name"],
        "at": iso(now_utc()),
    }
    await db.call_logs.insert_one(doc.copy())
    await db.leads.update_one(
        {"id": lead_id},
        {"$set": {
            "last_call_outcome": body.outcome,
            "last_call_at": doc["at"],
            "last_action_at": doc["at"],
        }},
    )
    await log_activity(user["id"], "call_logged", lead_id, {"outcome": body.outcome, "phone": body.phone})
    return strip_mongo(doc)


@api.get("/leads/{lead_id}/calls")
async def list_lead_calls(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    return await db.call_logs.find({"lead_id": lead_id}, {"_id": 0}).sort("at", -1).to_list(500)


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
    return await db.call_logs.find(query, {"_id": 0}).sort("at", -1).to_list(limit)


@api.put("/leads/{lead_id}/active-wa-phone")
async def set_active_wa_phone(lead_id: str, body: ActiveWaPhoneInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
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

@api.post("/whatsapp/send")
async def whatsapp_send(body: WhatsAppSendInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    # Pick the recipient: explicit active_wa_phone wins, else primary
    target_phone = lead.get("active_wa_phone") or lead.get("phone")
    if not target_phone:
        raise HTTPException(status_code=400, detail="Lead has no phone number")

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
        api_result = await wa_send_template(
            to_phone=target_phone,
            template_name=body.template_name,
            lang_code=tpl_meta.get("language") or body.template_lang or cfg["default_template_lang"],
            body_params=params_to_send,
        )
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
        api_result = await wa_send_text(to_phone=target_phone, body=body.body)

    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "direction": "out",
        "body": body.body,
        "to_phone": target_phone,
        "template_name": body.template_name,
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "at": iso(now_utc()),
        "by_user_id": user["id"],
    }
    await db.messages.insert_one(msg.copy())
    update_lead = {"last_action_at": iso(now_utc())}
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        update_lead["has_whatsapp"] = True
    await db.leads.update_one({"id": body.lead_id}, {"$set": update_lead})
    # Per-phone WA status
    if msg["status"] in ("sent", "delivered", "read", "sent_mock"):
        await _set_wa_status(body.lead_id, target_phone, True)
    elif msg["status"] == "failed" and (msg.get("error_code") in (131026, 131047, 470, 100) or "not on whatsapp" in (msg.get("error") or "").lower()):
        # Meta returns 131026 / "not in WhatsApp" type errors when the number isn't on WA
        await _set_wa_status(body.lead_id, target_phone, False)
    await log_activity(user["id"], "whatsapp_sent", body.lead_id, {"status": msg["status"], "wamid": msg["wamid"], "error": msg["error"]})
    if msg["status"] == "failed":
        # Surface the Meta error so the executive sees what to fix
        raise HTTPException(status_code=400, detail=msg["error"] or "WhatsApp send failed")
    return strip_mongo(msg)

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
):
    query: Dict[str, Any] = {}
    if user["role"] == "executive" or scope == "mine":
        query["executive_id"] = user["id"]
    if status:
        query["status"] = status
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
@api.get("/reports/overview")
async def reports_overview(admin: dict = Depends(require_admin)):
    total = await db.leads.count_documents({})
    by_status_cursor = db.leads.aggregate([{"$group": {"_id": "$status", "c": {"$sum": 1}}}])
    by_status = {doc["_id"] or "unknown": doc["c"] async for doc in by_status_cursor}
    by_source_cursor = db.leads.aggregate([{"$group": {"_id": "$source", "c": {"$sum": 1}}}])
    by_source = {doc["_id"] or "unknown": doc["c"] async for doc in by_source_cursor}
    converted = by_status.get("converted", 0)
    conversion_rate = round((converted / total) * 100, 2) if total else 0
    # reassigned = count leads with > 1 assignment history entry
    reassigned = await db.leads.count_documents({"assignment_history.1": {"$exists": True}})
    # missed = pending followups past due_at
    now_iso = iso(now_utc())
    missed_followups = await db.followups.count_documents({"status": "pending", "due_at": {"$lt": now_iso}})
    # per executive
    execs = await db.users.find({"role": "executive"}, {"_id": 0, "password_hash": 0}).to_list(500)
    per_exec = []
    # Pre-aggregate calls by user × outcome
    call_pipeline = [
        {"$group": {"_id": {"user": "$by_user_id", "outcome": "$outcome"}, "c": {"$sum": 1}}},
    ]
    call_buckets: Dict[str, Dict[str, int]] = {}
    async for d in db.call_logs.aggregate(call_pipeline):
        u = (d.get("_id") or {}).get("user")
        oc = (d.get("_id") or {}).get("outcome")
        if not u:
            continue
        call_buckets.setdefault(u, {})[oc] = d["c"]
    # Pre-aggregate messages by user (sent count)
    msg_pipeline = [
        {"$match": {"direction": "out", "by_user_id": {"$ne": None}}},
        {"$group": {"_id": "$by_user_id", "c": {"$sum": 1}}},
    ]
    msgs_sent: Dict[str, int] = {}
    async for d in db.messages.aggregate(msg_pipeline):
        msgs_sent[d["_id"]] = d["c"]
    for e in execs:
        count = await db.leads.count_documents({"assigned_to": e["id"]})
        conv = await db.leads.count_documents({"assigned_to": e["id"], "status": "converted"})
        qualified = await db.leads.count_documents({"assigned_to": e["id"], "status": "qualified"})
        lost = await db.leads.count_documents({"assigned_to": e["id"], "status": "lost"})
        contacted = await db.leads.count_documents({"assigned_to": e["id"], "status": "contacted"})
        new_leads = await db.leads.count_documents({"assigned_to": e["id"], "status": "new"})
        wa_threads = await db.leads.count_documents({"assigned_to": e["id"], "has_whatsapp": True})
        # Followup completion rate
        fu_total = await db.followups.count_documents({"executive_id": e["id"]})
        fu_done = await db.followups.count_documents({"executive_id": e["id"], "status": "done"})
        fu_pending = await db.followups.count_documents({"executive_id": e["id"], "status": "pending"})
        fu_completion = round((fu_done / fu_total) * 100, 1) if fu_total else 0
        # avg response = avg(opened_at - created_at) where both present
        pipeline = [
            {"$match": {"assigned_to": e["id"], "opened_at": {"$ne": None}}},
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
            "conversion_rate": round((conv / count) * 100, 1) if count else 0,
            "avg_response_seconds": int(avg_ms / 1000) if avg_ms else 0,
            "calls_total": total_calls,
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
    # last 14 days chart
    from collections import Counter
    leads_all = await db.leads.find({}, {"_id": 0, "created_at": 1, "source": 1}).to_list(10000)
    days: Dict[str, int] = {}
    for i in range(13, -1, -1):
        d = (now_utc() - timedelta(days=i)).strftime("%Y-%m-%d")
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
    }

@api.get("/reports/my")
async def reports_my(user: dict = Depends(get_current_user)):
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

# ------------- Inbox / Conversations / Quick Replies -------------
class QuickReplyInput(BaseModel):
    title: str
    text: str

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
    status: Optional[str] = None,
    assigned_to: Optional[str] = None,
    include_all: bool = False,
):
    """Returns a list of leads optimized for the chat inbox: each row carries last_msg preview,
    unread count, last_user_message_at and within_24h flag.
    Default filters to WhatsApp-active leads (`has_whatsapp=true` OR has at least one message).
    Pass `include_all=true` to bypass the WA filter (admin debugging)."""
    query: Dict[str, Any] = {}
    if user["role"] == "executive":
        query["assigned_to"] = user["id"]
    elif assigned_to:
        query["assigned_to"] = assigned_to
    if status:
        query["status"] = status
    if q:
        import re as _re
        q_safe = _re.escape(q)
        ors: List[Dict[str, Any]] = [
            {"customer_name": {"$regex": q_safe, "$options": "i"}},
            {"aliases": {"$regex": q_safe, "$options": "i"}},
            {"requirement": {"$regex": q_safe, "$options": "i"}},
        ]
        phone_pat = phone_match_pattern(q)
        if phone_pat:
            ors.append({"phone": {"$regex": phone_pat}})
            ors.append({"phones": {"$regex": phone_pat}})
        else:
            ors.append({"phone": {"$regex": q_safe, "$options": "i"}})
            ors.append({"phones": {"$regex": q_safe, "$options": "i"}})
        query["$or"] = ors
    leads = await db.leads.find(query, {
        "_id": 0, "raw_email_html": 0, "raw_email_text": 0,
    }).sort("last_action_at", -1).to_list(500)
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
        # Only show WhatsApp-active leads (has_whatsapp=true OR at least one message exchanged)
        is_wa_active = bool(ld.get("has_whatsapp")) or bool(last)
        if not include_all and not is_wa_active:
            continue
        out.append({
            **{k: ld.get(k) for k in [
                "id", "customer_name", "phone", "phones", "email", "requirement",
                "area", "city", "state", "source", "source_data", "status",
                "assigned_to", "contact_link", "created_at", "opened_at", "last_action_at",
                "has_whatsapp", "notes",
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
        })
    return out


@api.post("/inbox/leads/{lead_id}/mark-read")
async def mark_thread_read(lead_id: str, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
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
    return await db.quick_replies.find({}, {"_id": 0}).sort("title", 1).to_list(200)


@api.post("/quick-replies")
async def create_quick_reply(body: QuickReplyInput, admin: dict = Depends(require_admin)):
    doc = {
        "id": str(uuid.uuid4()),
        "title": body.title.strip(),
        "text": body.text,
        "created_by": admin["id"],
        "created_at": iso(now_utc()),
    }
    await db.quick_replies.insert_one(doc.copy())
    return strip_mongo(doc)


@api.put("/quick-replies/{qr_id}")
async def update_quick_reply(qr_id: str, body: QuickReplyInput, admin: dict = Depends(require_admin)):
    res = await db.quick_replies.update_one(
        {"id": qr_id},
        {"$set": {"title": body.title.strip(), "text": body.text, "updated_at": iso(now_utc())}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Quick reply not found")
    return await db.quick_replies.find_one({"id": qr_id}, {"_id": 0})


@api.delete("/quick-replies/{qr_id}")
async def delete_quick_reply(qr_id: str, admin: dict = Depends(require_admin)):
    await db.quick_replies.delete_one({"id": qr_id})
    return {"ok": True}


# Webhook URLs panel (admin)
@api.get("/settings/webhooks-info")
async def webhooks_info(admin: dict = Depends(require_admin)):
    base = (FRONTEND_BASE_URL or os.environ.get("FRONTEND_BASE_URL") or "").rstrip("/")
    cfg = await get_wa_config()
    return {
        "indiamart": {
            "label": "IndiaMART Push API",
            "url": f"{base}/api/webhooks/indiamart",
            "method": "POST",
            "where_to_paste": "IndiaMART Lead Manager → Push API → Webhook URL",
            "auth": "none (public endpoint)",
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

    data = {
        "customer_name": name,
        "requirement": parsed.get("requirement"),
        "area": parsed.get("area"),
        "city": parsed.get("city"),
        "state": parsed.get("state"),
        "phone": parsed.get("phone"),
        "source": "Justdial",
        "contact_link": parsed.get("contact_link"),
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
        receiver = (
            e.get("RECEIVER_MOBILE") or e.get("CALL_RECEIVER_NUMBER")
            or e.get("receiver_mobile") or e.get("call_receiver_number")
        )
        if receiver:
            user_match = await _find_user_for_receiver(receiver)
            if user_match:
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

@api.post("/webhooks/indiamart")
async def webhook_indiamart(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return await _handle_indiamart_payload(payload, identifier=None)

@api.post("/webhooks/indiamart/{identifier}")
async def webhook_indiamart_tenant(identifier: str, request: Request):
    """Tenant-identifier variant per IndiaMART docs: https://{host}/indiamart/{identifier}"""
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
    if challenge and not token:
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


@api.post("/webhooks/whatsapp")
async def webhook_whatsapp(request: Request):
    """Receive incoming WhatsApp messages and delivery status updates from Meta."""
    try:
        payload = await request.json()
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
                    body_text = ""
                    if msg_type == "text":
                        body_text = ((m.get("text") or {}).get("body")) or ""
                    elif msg_type == "image":
                        img = m.get("image") or {}
                        body_text = f"[image] {img.get('caption','')}".strip()
                    elif msg_type == "document":
                        doc = m.get("document") or {}
                        body_text = f"[document: {doc.get('filename','file')}] {doc.get('caption','')}".strip()
                    elif msg_type == "audio":
                        body_text = "[audio message]"
                    elif msg_type == "video":
                        body_text = f"[video] {(m.get('video') or {}).get('caption','')}".strip()
                    elif msg_type == "location":
                        loc = m.get("location") or {}
                        body_text = f"[location: {loc.get('latitude')},{loc.get('longitude')}]"
                    elif msg_type == "button":
                        body_text = f"[button reply] {(m.get('button') or {}).get('text','')}"
                    elif msg_type == "interactive":
                        ia = m.get("interactive") or {}
                        body_text = f"[interactive] {json.dumps(ia)[:200]}"
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
                    }
                    await db.messages.insert_one(msg_doc.copy())
                    await db.leads.update_one(
                        {"id": lead["id"]},
                        {"$set": {
                            "last_action_at": iso(now_utc()),
                            "last_user_message_at": iso(now_utc()),
                            "has_whatsapp": True,
                            f"wa_status_map.{(_normalize_phone(from_phone or '')[-10:] or 'unk')}": True,
                        }},
                    )
                    created_msgs += 1

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
async def auto_reassign_task():
    try:
        rules = await get_routing_rules()
        unopened_mins = int(rules.get("unopened_reassign_minutes") or 15)
        noaction_mins = int(rules.get("no_action_reassign_minutes") or 60)
        unopened_cutoff = iso(now_utc() - timedelta(minutes=unopened_mins))
        noaction_cutoff = iso(now_utc() - timedelta(minutes=noaction_mins))
        # Unopened: assigned but not opened within X minutes
        cursor = db.leads.find({
            "assigned_to": {"$ne": None},
            "opened_at": None,
            "status": {"$in": ["new", "contacted"]},
            "last_assignment_at": {"$lt": unopened_cutoff},
        }, {"_id": 0})
        count = 0
        async for lead in cursor:
            prev = lead.get("assigned_to")
            rules2 = await get_routing_rules()
            if not rules2.get("round_robin_enabled", True):
                break
            chosen = await pick_next_executive(exclude_user_id=prev)
            if chosen and chosen["id"] != prev:
                await assign_lead(lead["id"], target_user_id=chosen["id"], by_user_id=None)
                await log_activity(None, "auto_reassigned_unopened", lead["id"], {"from": prev, "to": chosen["id"]})
                count += 1
            if count >= 20:
                break
        # No action: opened but no activity
        cursor2 = db.leads.find({
            "assigned_to": {"$ne": None},
            "status": {"$in": ["new", "contacted"]},
            "last_action_at": {"$lt": noaction_cutoff},
            "opened_at": {"$ne": None},
        }, {"_id": 0}).limit(20)
        async for lead in cursor2:
            prev = lead.get("assigned_to")
            chosen = await pick_next_executive(exclude_user_id=prev)
            if chosen and chosen["id"] != prev:
                await assign_lead(lead["id"], target_user_id=chosen["id"], by_user_id=None)
                await log_activity(None, "auto_reassigned_noaction", lead["id"], {"from": prev, "to": chosen["id"]})
        # Followups: mark missed
        await db.followups.update_many(
            {"status": "pending", "due_at": {"$lt": iso(now_utc() - timedelta(minutes=30))}},
            {"$set": {"status": "missed"}},
        )
    except Exception as e:
        logger.exception(f"auto_reassign_task failed: {e}")

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
GMAIL_POLL_MINUTES = max(1, int(os.environ.get("GMAIL_POLL_INTERVAL_MINUTES", "2")))
GMAIL_QUERY = os.environ.get("GMAIL_JUSTDIAL_QUERY", "from:instantemail@justdial.com is:unread newer_than:7d")
GMAIL_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)

@api.get("/integrations/gmail/status")
async def gmail_status(user: dict = Depends(get_current_user)):
    if not GMAIL_ENABLED:
        return {"enabled": False, "reason": "GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI not configured"}
    cfg = await db.gmail_connections.find_one({"key": "default"}, {"_id": 0, "access_token": 0, "refresh_token": 0})
    if not cfg:
        return {"enabled": True, "connected": False, "redirect_uri": GOOGLE_REDIRECT_URI}
    last_poll = await db.gmail_polls.find_one({"key": "last"}, {"_id": 0})
    return {
        "enabled": True,
        "connected": True,
        "email": cfg.get("email"),
        "connected_at": cfg.get("connected_at"),
        "connected_by_user_id": cfg.get("connected_by"),
        "scopes": cfg.get("scopes"),
        "expires_at": cfg.get("expires_at"),
        "last_poll": last_poll,
        "poll_interval_minutes": GMAIL_POLL_MINUTES,
        "query": GMAIL_QUERY,
        "redirect_uri": GOOGLE_REDIRECT_URI,
    }

@api.get("/integrations/gmail/auth/init")
async def gmail_auth_init(admin: dict = Depends(require_admin)):
    if not GMAIL_ENABLED:
        raise HTTPException(status_code=400, detail="Gmail integration not configured")
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
        "created_at": iso(now_utc()),
        "expires_at": iso(now_utc() + timedelta(minutes=10)),
    })
    return {"auth_url": auth_url}


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
        doc = {
            "key": "default",
            "email": email_addr,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_uri": "https://oauth2.googleapis.com/token",
            "scopes": scope.split(" "),
            "expires_at": iso(now_utc() + timedelta(seconds=expires_in)),
            "connected_by": state_doc.get("user_id"),
            "connected_at": iso(now_utc()),
        }
        await db.gmail_connections.update_one({"key": "default"}, {"$set": doc}, upsert=True)
        return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=connected&email={email_addr}"})
    except Exception as e:
        logger.exception(f"Gmail OAuth callback failed: {e}")
        return Response(status_code=302, headers={"Location": f"{redirect_target}?gmail_status=error&reason={str(e)[:140]}"})

@api.post("/integrations/gmail/disconnect")
async def gmail_disconnect(admin: dict = Depends(require_admin)):
    cfg = await db.gmail_connections.find_one({"key": "default"}, {"_id": 0})
    if cfg and cfg.get("access_token"):
        try:
            async with httpx.AsyncClient(timeout=10.0) as cli:
                await cli.post("https://oauth2.googleapis.com/revoke", params={"token": cfg["access_token"]})
        except Exception:
            pass
    await db.gmail_connections.delete_one({"key": "default"})
    return {"ok": True}

async def _get_gmail_service():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GoogleRequest
    from googleapiclient.discovery import build
    cfg = await db.gmail_connections.find_one({"key": "default"}, {"_id": 0})
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
                {"key": "default"},
                {"$set": {
                    "access_token": creds.token,
                    "expires_at": iso(creds.expiry.replace(tzinfo=timezone.utc)) if creds.expiry else None,
                }},
            )
        except Exception as e:
            logger.warning(f"Gmail token refresh failed: {e}")
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

async def gmail_poll_task():
    """Poll Gmail for new Justdial enquiries and ingest them."""
    if not GMAIL_ENABLED:
        return
    service, cfg = await _get_gmail_service()
    if not service:
        return
    summary = {"key": "last", "ran_at": iso(now_utc()), "fetched": 0, "ingested": 0, "errors": 0}
    try:
        resp = service.users().messages().list(userId="me", q=GMAIL_QUERY, maxResults=20).execute()
        ids = [m["id"] for m in (resp.get("messages") or [])]
        summary["fetched"] = len(ids)
        for mid in ids:
            try:
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
                    })
                else:
                    name = parsed.get("customer_name") or "Justdial Lead"
                    ts = parsed.get("timestamp") or iso(now_utc())
                    content_hash = hashlib.sha256(((bodies.get("text") or "") + (bodies.get("html") or "")).encode("utf-8")).hexdigest()
                    dhash = _lead_dedup_hash(name, ts, content_hash[:16])
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
                        "contact_link": parsed.get("contact_link"),
                        "source_data": {"timestamp": ts, "subject": subject, "from": from_email, "gmail_id": mid},
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
                    })
                    summary["ingested"] += 1
                # Mark as read so we don't re-process
                try:
                    service.users().messages().modify(userId="me", id=mid, body={"removeLabelIds": ["UNREAD"]}).execute()
                except Exception as e:
                    logger.warning(f"Could not mark Gmail msg {mid} read: {e}")
            except Exception as e:
                summary["errors"] += 1
                logger.exception(f"Gmail message processing failed for {mid}: {e}")
    except Exception as e:
        summary["errors"] += 1
        summary["fatal"] = str(e)[:200]
        logger.exception(f"Gmail poll task failed: {e}")
    await db.gmail_polls.update_one({"key": "last"}, {"$set": summary}, upsert=True)

@api.post("/integrations/gmail/sync-now")
async def gmail_sync_now(admin: dict = Depends(require_admin)):
    await gmail_poll_task()
    last = await db.gmail_polls.find_one({"key": "last"}, {"_id": 0})
    return {"ok": True, "last_poll": last}


# ------------- Seed -------------
async def seed_data():
    # admin
    admin_username = os.environ.get("ADMIN_USERNAME", "admin").strip().lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin@123")
    admin_name = os.environ.get("ADMIN_NAME", "System Admin")
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
    else:
        # ensure password matches .env
        if not verify_password(admin_password, existing.get("password_hash", "")):
            await db.users.update_one(
                {"username": admin_username},
                {"$set": {"password_hash": hash_password(admin_password), "role": "admin", "active": True}},
            )
    # test executives
    for uname, name in [("ravi", "Ravi Kumar"), ("priya", "Priya Sharma")]:
        if not await db.users.find_one({"username": uname}):
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "username": uname,
                "name": name,
                "password_hash": hash_password("Exec@123"),
                "role": "executive",
                "active": True,
                "working_hours": [
                    {"weekday": d, "start": "09:00", "end": "19:00"} for d in range(7)
                ],
                "created_at": iso(now_utc()),
            })
    # default template
    if not await db.whatsapp_templates.find_one({"name": "welcome_lead"}):
        body_w = "Hi {{name}}, thanks for your interest. Our team will connect with you shortly. — LeadOrbit"
        await db.whatsapp_templates.insert_one({
            "id": str(uuid.uuid4()),
            "name": "welcome_lead",
            "category": "utility",
            "body": body_w,
            "params_required": count_template_placeholders(body_w),
            "created_at": iso(now_utc()),
        })
    if not await db.whatsapp_templates.find_one({"name": "followup_reminder"}):
        body_f = "Hi {{name}}, just checking in regarding your enquiry. Let us know a good time to connect."
        await db.whatsapp_templates.insert_one({
            "id": str(uuid.uuid4()),
            "name": "followup_reminder",
            "category": "utility",
            "body": body_f,
            "params_required": count_template_placeholders(body_f),
            "created_at": iso(now_utc()),
        })
    # Backfill params_required for any existing templates that don't have it (one-shot)
    cursor = db.whatsapp_templates.find({"params_required": {"$exists": False}}, {"_id": 0, "id": 1, "body": 1})
    async for t in cursor:
        await db.whatsapp_templates.update_one(
            {"id": t["id"]},
            {"$set": {"params_required": count_template_placeholders(t.get("body") or "")}},
        )
    # default routing rules
    await get_routing_rules()
    # default quick replies
    if not await db.quick_replies.find_one({}):
        defaults = [
            ("Greeting", "Hi {{name}}, thanks for reaching out — how can we help you today?"),
            ("Will call shortly", "Thanks for your enquiry! Our team will call you in the next 30 minutes."),
            ("Price request", "Could you please share the quantity and delivery location so we can share an accurate quote?"),
            ("Send brochure", "Here's our brochure with pricing and specifications. Let me know if any product catches your eye."),
            ("Follow-up", "Just checking in on our previous conversation — is now a good time to discuss next steps?"),
        ]
        for title, text in defaults:
            await db.quick_replies.insert_one({
                "id": str(uuid.uuid4()),
                "title": title,
                "text": text,
                "created_by": None,
                "created_at": iso(now_utc()),
            })
    # indexes
    await db.users.create_index("username", unique=True)
    await db.leads.create_index("dedup_hash")
    await db.leads.create_index("assigned_to")
    await db.leads.create_index("status")
    await db.leads.create_index("created_at")
    await db.leads.create_index("last_action_at")
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

scheduler: Optional[AsyncIOScheduler] = None

@app.on_event("startup")
async def on_startup():
    global scheduler
    await seed_data()
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(auto_reassign_task, "interval", minutes=1, id="auto_reassign", max_instances=1, coalesce=True)
    if GMAIL_ENABLED:
        scheduler.add_job(
            gmail_poll_task, "interval", minutes=GMAIL_POLL_MINUTES,
            id="gmail_poll", max_instances=1, coalesce=True,
        )
    scheduler.start()
    logger.info(f"Startup complete; scheduler running (gmail_enabled={GMAIL_ENABLED})")

@app.on_event("shutdown")
async def on_shutdown():
    global scheduler
    if scheduler:
        scheduler.shutdown(wait=False)
    client.close()

# Root ping for api
@api.get("/")
async def root():
    return {"service": "LeadOrbit CRM API", "status": "ok"}

app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
