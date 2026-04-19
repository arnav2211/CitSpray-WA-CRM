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
WA_TOKEN = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
WA_PHONE_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
WA_API_VERSION = os.environ.get("WHATSAPP_API_VERSION", "v22.0").strip()
WA_VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "leadorbit_meta_verify").strip()
WA_APP_SECRET = os.environ.get("WHATSAPP_APP_SECRET", "").strip()
WA_DEFAULT_TPL = os.environ.get("WHATSAPP_DEFAULT_TEMPLATE", "hello_world").strip()
WA_DEFAULT_TPL_LANG = os.environ.get("WHATSAPP_DEFAULT_TEMPLATE_LANG", "en_US").strip()
WA_BASE_URL = "https://graph.facebook.com"
WA_ENABLED = bool(WA_TOKEN and WA_PHONE_ID)


def _normalize_phone(p: Optional[str]) -> str:
    """Strip everything except digits — Meta sends numbers as digits-only without +."""
    if not p:
        return ""
    return re.sub(r"\D+", "", p)


async def wa_send_text(to_phone: str, body: str) -> Dict[str, Any]:
    """Send a freeform text message via WhatsApp Cloud API.
    Only allowed within a 24-hour customer-initiated window. Otherwise Meta returns error 131047."""
    if not WA_ENABLED:
        return {"mock": True, "status": "sent_mock", "wamid": None}
    to = _normalize_phone(to_phone)
    if not to:
        return {"error": "no_phone", "status": "failed"}
    url = f"{WA_BASE_URL}/{WA_API_VERSION}/{WA_PHONE_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "text",
        "text": {"preview_url": False, "body": body},
    }
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.post(url, json=payload, headers={
            "Authorization": f"Bearer {WA_TOKEN}",
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


async def wa_send_template(to_phone: str, template_name: str, lang_code: str = "en_US", body_params: Optional[List[str]] = None) -> Dict[str, Any]:
    """Send a pre-approved template message. Required for first-touch / outside the 24-hour window."""
    if not WA_ENABLED:
        return {"mock": True, "status": "sent_mock", "wamid": None}
    to = _normalize_phone(to_phone)
    if not to:
        return {"error": "no_phone", "status": "failed"}
    url = f"{WA_BASE_URL}/{WA_API_VERSION}/{WA_PHONE_ID}/messages"
    template_block: Dict[str, Any] = {
        "name": template_name,
        "language": {"code": lang_code},
    }
    if body_params:
        template_block["components"] = [{
            "type": "body",
            "parameters": [{"type": "text", "text": str(p)} for p in body_params],
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
            "Authorization": f"Bearer {WA_TOKEN}",
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

class UserUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Literal["admin", "executive"]] = None
    active: Optional[bool] = None
    working_hours: Optional[List[Dict[str, Any]]] = None

class LeadCreate(BaseModel):
    customer_name: str
    phone: Optional[str] = None
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
    email: Optional[str] = None
    requirement: Optional[str] = None
    area: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    status: Optional[Literal["new", "contacted", "qualified", "converted", "lost"]] = None
    assigned_to: Optional[str] = None

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
    doc = {
        "id": str(uuid.uuid4()),
        "username": uname,
        "name": body.name,
        "password_hash": hash_password(body.password),
        "role": body.role,
        "active": body.active,
        "working_hours": body.working_hours,
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
    tpl_name = WA_DEFAULT_TPL or "hello_world"
    # Try sending real template via Meta Cloud API. First-touch must use a template.
    api_result = await wa_send_template(
        to_phone=lead["phone"],
        template_name=tpl_name,
        lang_code=WA_DEFAULT_TPL_LANG or "en_US",
        body_params=[lead.get("customer_name", "there")],
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

# ------------- Leads -------------
def _lead_dedup_hash(name: str, ts: Optional[str], extra: str = "") -> str:
    raw = f"{(name or '').strip().lower()}|{ts or ''}|{extra}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

async def _create_lead_internal(data: dict, by_user_id: Optional[str] = None) -> dict:
    # dedup
    dhash = data.get("dedup_hash")
    if dhash:
        existing = await db.leads.find_one({"dedup_hash": dhash}, {"_id": 0})
        if existing:
            return existing
    lead = {
        "id": str(uuid.uuid4()),
        "customer_name": data.get("customer_name", "Unknown"),
        "phone": data.get("phone"),
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
        "last_action_at": iso(now_utc()),
        "created_at": iso(now_utc()),
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
    if q:
        query["$or"] = [
            {"customer_name": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
            {"requirement": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
        ]
    leads = await db.leads.find(query, {"_id": 0, "raw_email_html": 0, "raw_email_text": 0})\
        .sort("created_at", -1).to_list(limit)
    return leads

@api.post("/leads")
async def create_lead(body: LeadCreate, user: dict = Depends(get_current_user)):
    data = body.model_dump()
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
    for f in ["customer_name", "phone", "email", "requirement", "area", "city", "state", "status"]:
        v = getattr(body, f)
        if v is not None:
            updates[f] = v
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

@api.post("/whatsapp/send")
async def whatsapp_send(body: WhatsAppSendInput, user: dict = Depends(get_current_user)):
    lead = await db.leads.find_one({"id": body.lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if user["role"] == "executive" and lead.get("assigned_to") != user["id"]:
        raise HTTPException(status_code=403, detail="Not allowed")
    if not lead.get("phone"):
        raise HTTPException(status_code=400, detail="Lead has no phone number")

    # If a template_name is given, send as template; else send freeform text.
    if body.template_name:
        # Replace {{name}} in body if present (so executive sees what they sent),
        # but Meta uses template body params positional substitution.
        api_result = await wa_send_template(
            to_phone=lead["phone"],
            template_name=body.template_name,
            lang_code=WA_DEFAULT_TPL_LANG or "en_US",
            body_params=[lead.get("customer_name", "there")],
        )
    else:
        api_result = await wa_send_text(to_phone=lead["phone"], body=body.body)

    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "direction": "out",
        "body": body.body,
        "template_name": body.template_name,
        "status": api_result.get("status", "failed"),
        "wamid": api_result.get("wamid"),
        "error": api_result.get("error"),
        "error_code": api_result.get("code"),
        "at": iso(now_utc()),
        "by_user_id": user["id"],
    }
    await db.messages.insert_one(msg.copy())
    await db.leads.update_one({"id": body.lead_id}, {"$set": {"last_action_at": iso(now_utc())}})
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
    """Live health of the configured Meta WhatsApp Business account."""
    if not WA_ENABLED:
        return {"enabled": False, "reason": "WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set"}
    out: Dict[str, Any] = {"enabled": True, "phone_number_id": WA_PHONE_ID, "api_version": WA_API_VERSION,
                           "verify_token": WA_VERIFY_TOKEN}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            r = await cli.get(
                f"{WA_BASE_URL}/{WA_API_VERSION}/{WA_PHONE_ID}",
                params={"fields": "verified_name,display_phone_number,quality_rating,code_verification_status,name_status"},
                headers={"Authorization": f"Bearer {WA_TOKEN}"},
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
    """Pull approved templates from Meta into our local DB so executives can pick them in the UI."""
    waba_id = os.environ.get("WHATSAPP_WABA_ID", "").strip()
    if not (WA_ENABLED and waba_id):
        raise HTTPException(status_code=400, detail="WhatsApp not configured (need ACCESS_TOKEN + PHONE_NUMBER_ID + WABA_ID)")
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.get(
            f"{WA_BASE_URL}/{WA_API_VERSION}/{waba_id}/message_templates",
            params={"fields": "name,status,language,category,components", "limit": 200},
            headers={"Authorization": f"Bearer {WA_TOKEN}"},
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
async def list_followups(user: dict = Depends(get_current_user), scope: str = "mine"):
    query: Dict[str, Any] = {}
    if user["role"] == "executive" or scope == "mine":
        query["executive_id"] = user["id"]
    fu = await db.followups.find(query, {"_id": 0}).sort("due_at", 1).to_list(500)
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
    for e in execs:
        count = await db.leads.count_documents({"assigned_to": e["id"]})
        conv = await db.leads.count_documents({"assigned_to": e["id"], "status": "converted"})
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
        per_exec.append({
            "id": e["id"],
            "username": e["username"],
            "name": e["name"],
            "active": e.get("active", True),
            "leads": count,
            "converted": conv,
            "avg_response_seconds": int(avg_ms / 1000) if avg_ms else 0,
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

# ------------- Justdial email parser -------------
JD_REQ_REGEX = re.compile(r"^\s*(?P<name>[A-Za-z][A-Za-z0-9 .'_-]{0,80}?)\s+(?:enquired|inquired)\s+for\s+(?P<req>.+?)\s*$", re.IGNORECASE | re.MULTILINE)
JD_FIELD = {
    "area": re.compile(r"User\s*Area\s*:\s*(.+)", re.IGNORECASE),
    "city": re.compile(r"User\s*City\s*:\s*(.+)", re.IGNORECASE),
    "state": re.compile(r"User\s*State\s*:\s*(.+)", re.IGNORECASE),
    "timestamp": re.compile(r"Search\s*Date\s*&?\s*Time\s*:\s*(.+)", re.IGNORECASE),
    "phone": re.compile(r"(?:Mobile|Phone|Mobile No|Contact)\s*:\s*([+\d\- ]{6,})", re.IGNORECASE),
}

def parse_justdial_email(raw_text: str, raw_html: str) -> dict:
    text = (raw_text or "").strip()
    if not text and raw_html:
        try:
            text = BeautifulSoup(raw_html, "html.parser").get_text("\n")
        except Exception:
            text = ""
    out: Dict[str, Any] = {}
    m = JD_REQ_REGEX.search(text)
    if m:
        out["customer_name"] = m.group("name").strip()
        out["requirement"] = m.group("req").strip()
    else:
        # fallback — try to capture first line
        first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        if first:
            out["requirement"] = first[:200]
    for key, rx in JD_FIELD.items():
        m2 = rx.search(text)
        if m2:
            out[key] = m2.group(1).strip()
    # Contact link from HTML
    contact_link = None
    if raw_html:
        try:
            soup = BeautifulSoup(raw_html, "html.parser")
            for a in soup.find_all("a"):
                label = (a.get_text() or "").strip().lower()
                href = a.get("href") or ""
                if "view contact" in label or "contact details" in label:
                    contact_link = href
                    break
            if not contact_link:
                # fallback: first justdial.com link
                for a in soup.find_all("a"):
                    href = a.get("href") or ""
                    if "justdial.com" in href:
                        contact_link = href
                        break
        except Exception:
            pass
    if contact_link:
        out["contact_link"] = contact_link
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
            exec_match = await db.users.find_one({"role": "executive", "active": True, "phone": receiver}, {"_id": 0})
            if exec_match:
                data["assigned_to"] = exec_match["id"]
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

# ------------- WhatsApp webhook (Meta Cloud API) -------------
@api.get("/webhooks/whatsapp")
async def whatsapp_verify(request: Request):
    """Meta sends GET with hub.mode/hub.verify_token/hub.challenge during webhook setup.
    Configure 'verify token' in Meta dashboard to match WHATSAPP_VERIFY_TOKEN in .env."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")
    if mode == "subscribe" and token == WA_VERIFY_TOKEN and challenge:
        return Response(content=challenge, media_type="text/plain")
    if challenge and not token:
        # Older test tools sometimes ping with just challenge — keep echo for compat
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(status_code=403, detail="Verify token mismatch")


async def _find_lead_by_phone(phone_digits: str) -> Optional[dict]:
    """Best-effort lookup: leads store phone in original format; normalize for compare.
    Tries exact suffix match (last 10 digits) for Indian numbers."""
    if not phone_digits:
        return None
    suffix = phone_digits[-10:] if len(phone_digits) >= 10 else phone_digits
    # Use regex to match any stored phone whose digits-only suffix equals our suffix
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
                    await db.leads.update_one({"id": lead["id"]}, {"$set": {"last_action_at": iso(now_utc())}})
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
        await db.whatsapp_templates.insert_one({
            "id": str(uuid.uuid4()),
            "name": "welcome_lead",
            "category": "utility",
            "body": "Hi {{name}}, thanks for your interest. Our team will connect with you shortly. — LeadOrbit",
            "created_at": iso(now_utc()),
        })
    if not await db.whatsapp_templates.find_one({"name": "followup_reminder"}):
        await db.whatsapp_templates.insert_one({
            "id": str(uuid.uuid4()),
            "name": "followup_reminder",
            "category": "utility",
            "body": "Hi {{name}}, just checking in regarding your enquiry. Let us know a good time to connect.",
            "created_at": iso(now_utc()),
        })
    # default routing rules
    await get_routing_rules()
    # indexes
    await db.users.create_index("username", unique=True)
    await db.leads.create_index("dedup_hash")
    await db.leads.create_index("assigned_to")
    await db.leads.create_index("status")
    await db.leads.create_index("created_at")
    await db.messages.create_index("lead_id")
    await db.followups.create_index("executive_id")
    await db.followups.create_index("due_at")
    await db.activity_logs.create_index("lead_id")

scheduler: Optional[AsyncIOScheduler] = None

@app.on_event("startup")
async def on_startup():
    global scheduler
    await seed_data()
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(auto_reassign_task, "interval", minutes=1, id="auto_reassign", max_instances=1, coalesce=True)
    scheduler.start()
    logger.info("Startup complete; scheduler running")

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
