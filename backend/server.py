from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import re
import uuid
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal, Any, Dict

import bcrypt
import jwt
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
    tpl = await db.whatsapp_templates.find_one({"name": "welcome_lead"}, {"_id": 0})
    if tpl:
        body = tpl["body"].replace("{{name}}", lead.get("customer_name", ""))
    else:
        body = f"Hi {lead.get('customer_name','')}, thanks for your interest. Our team will connect with you shortly. — LeadOrbit"
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": lead["id"],
        "direction": "out",
        "body": body,
        "template_name": "welcome_lead",
        "status": "sent_mock",
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
    msg = {
        "id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "direction": "out",
        "body": body.body,
        "template_name": body.template_name,
        "status": "sent_mock",
        "at": iso(now_utc()),
        "by_user_id": user["id"],
    }
    await db.messages.insert_one(msg.copy())
    await db.leads.update_one({"id": body.lead_id}, {"$set": {"last_action_at": iso(now_utc())}})
    await log_activity(user["id"], "whatsapp_sent", body.lead_id, {"len": len(body.body)})
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

# ------------- WhatsApp webhook (MOCK) -------------
@api.get("/webhooks/whatsapp")
async def whatsapp_verify(request: Request):
    # Meta verification endpoint style
    params = request.query_params
    challenge = params.get("hub.challenge")
    if challenge:
        return Response(content=challenge, media_type="text/plain")
    return {"ok": True}

@api.post("/webhooks/whatsapp")
async def webhook_whatsapp(request: Request):
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
    # Simplified: expect { lead_id, from, body } for our mock
    lead_id = payload.get("lead_id")
    body = payload.get("body") or payload.get("text")
    if lead_id and body:
        msg = {
            "id": str(uuid.uuid4()),
            "lead_id": lead_id,
            "direction": "in",
            "body": body,
            "status": "received",
            "at": iso(now_utc()),
            "by_user_id": None,
        }
        await db.messages.insert_one(msg.copy())
        await db.leads.update_one({"id": lead_id}, {"$set": {"last_action_at": iso(now_utc())}})
    await db.webhook_payloads.update_one({"id": raw["id"]}, {"$set": {"processed": True}})
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
