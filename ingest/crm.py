"""KD-A2 (WP07, v5.2) — CRM lead & đại lý theo vùng: kho liên hệ
(contact_vault) + đồng ý theo mục đích + gán đại lý theo tỉnh.

Contract:
  - PII khách (SĐT/tên/email/địa chỉ) CHỈ nằm trong bảng `contacts`, mã
    hóa ở TẦNG ỨNG DỤNG bằng Fernet (thư viện `cryptography`) với khóa env
    `CONTACT_VAULT_KEY`. KHÔNG dùng pgcrypto: khóa sẽ đi trong câu SQL →
    lộ ở log server / pg_stat_statements. Bảng khác chỉ giữ `contact_id`.
  - Tra trùng: `phone_hmac` = HMAC-SHA256(khóa lookup, SĐT chuẩn hóa);
    khóa lookup dẫn xuất HKDF(SHA256, info=LOOKUP_INFO) từ cùng khóa vault
    (tách miền với khóa mã hóa). Không dùng sha256 trần: SĐT VN chỉ ~10^9
    giá trị → dò ngược trong vài phút.
  - Thiếu/sai khóa → `VaultKeyError` → CLI exit 2 TRƯỚC khi connect, không
    ghi gì (fail-closed). Mất khóa = mất PII (sop: backup khóa tách DB).
  - Đồng ý (`consents`) append-only theo mục đích cskh|marketing|dai_ly|
    b2b (v8.2: b2b = gửi báo giá cho người liên hệ của TỔ CHỨC — ghi bởi
    `connectors.b2b_form`);
    `can_contact()` mặc định False — chỉ True khi dòng MỚI NHẤT (theo id)
    của đúng (contact, mục đích, đại lý) là granted. `dai_ly` phải đích
    danh đại lý nhận.
  - Agent KHÔNG tự liên hệ khách/đại lý: module không import mạng/LLM
    (drift-guard `tests/test_data_flow_map.py`). `--handoff` chỉ IN payload
    cho NGƯỜI tự chuyển; mọi thao tác ghi cần `--by <tên người>` và để lại
    1 dòng `agent_action_log` (detail KHÔNG chứa PII/HMAC/ciphertext).
  - PII vào qua JSON stdin (`-`) hoặc file NGOÀI repo — không nhận qua
    argv (lộ shell history / process list); thông báo lỗi không echo PII.
  - Tỉnh/thành: 34 đơn vị sau sáp nhập 2025 — GIẢ ĐỊNH chưa đối chiếu văn
    bản chính thức (`data/vn_provinces_2025.json`); vùng + đại lý MẪU ở
    `data/dealer_regions.json`.

Chạy: `python -m ingest.crm --help`.
"""

import argparse
import base64
import functools
import hashlib
import hmac
import json
import os
import re
import sys
import unicodedata
from decimal import Decimal
from pathlib import Path

import psycopg
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

from ingest import lead_store
from pipelines.llm_gateway import _strip_accents
from pipelines.pii import _PII_RE, _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
PROVINCES_FILE = DATA_DIR / "vn_provinces_2025.json"
REGIONS_FILE = DATA_DIR / "dealer_regions.json"

KEY_ENV = "CONTACT_VAULT_KEY"
LOOKUP_INFO = b"samsam/contact_vault/lookup/v1"
PURPOSES = ("cskh", "marketing", "dai_ly", "b2b")
CONSENT_SOURCES = ("form_giay", "zalo", "web", "dien_thoai", "email",
                   "truc_tiep")
LEAD_FLOW = ("new", "contacted", "qualified", "won")
LEAD_STATES = LEAD_FLOW + ("lost",)
TERMINAL = ("won", "lost")
DEALER_STATUSES = ("active", "paused", "ended")
CATEGORIES = ("tpbvsk", "food", "alcohol")   # khớp sku_master.category
CONTACT_KEYS = ("phone", "name", "email", "address", "province", "source")
MAX_BY_LEN = 100
MAX_FIELD = {"name": 200, "email": 254, "address": 500}
MAX_INPUT_BYTES = 64 * 1024
MAX_EVIDENCE = 200
MAX_POLICY = 50
MAX_PROVINCE_TEXT = 5000
DEALER_CODE_RE = re.compile(r"^[A-Z0-9_-]{2,20}$")
REGION_CODE_RE = re.compile(r"^[A-Z0-9_]{2,30}$")
SOURCE_RE = re.compile(r"^[a-z0-9_.:-]{1,50}$")

_LOG_SQL = (
    "insert into agent_action_log (actor, action, object_type, object_id, "
    "detail) values (%s, %s, %s, %s, %s)")


class VaultKeyError(Exception):
    """Thiếu/sai khóa vault hoặc khóa không khớp dữ liệu — fail-closed."""


# ------------------------------------------------------------------ vault
def load_vault_key(env=os.environ) -> tuple[Fernet, bytes]:
    """`CONTACT_VAULT_KEY` (khóa Fernet urlsafe-base64 32 byte) →
    (Fernet, khóa lookup HMAC). Message lỗi KHÔNG chứa giá trị env."""
    raw = (env.get(KEY_ENV) or "").strip()
    if not raw:
        raise VaultKeyError(f"thiếu {KEY_ENV} — không ghi/đọc PII "
                            "(xem sop mục CRM để sinh khóa)")
    try:
        f = Fernet(raw.encode("ascii"))
        master = base64.urlsafe_b64decode(raw.encode("ascii"))
    except (ValueError, TypeError, UnicodeEncodeError):
        raise VaultKeyError(f"{KEY_ENV} không phải khóa Fernet hợp lệ "
                            "(urlsafe-base64 32 byte)") from None
    lookup = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                  info=LOOKUP_INFO).derive(master)
    return f, lookup


def normalize_phone(raw) -> str:
    """SĐT → dạng `0xxxxxxxxx` (bỏ ký tự không phải số, `+84`/`84` đầu
    → `0`, `+84 (0)`/`84 0` → `0`; tiền tố `00` bị từ chối). Sai →
    ValueError KHÔNG kèm giá trị đầu vào."""
    # Chỉ nhận số + ký tự ngăn cách thường gặp; chữ cái giữa số ("0905-
    # 12x-98765") là gõ sai → từ chối, KHÔNG lặng lẽ bỏ chữ rồi chấp nhận.
    # Chỉ chữ số ASCII: `\d` Unicode nhận cả số Ả Rập/Devanagari → chuỗi
    # khác → HMAC khác → lách tra trùng.
    if not isinstance(raw, str) or len(raw) > 40 \
            or not re.fullmatch(r"[ \t(]*\+?[0-9 \t().-]+", raw):
        raise ValueError("SĐT không hợp lệ")
    digits = re.sub(r"[^0-9]", "", raw)
    # Chuẩn hóa về 1 dạng duy nhất (HMAC tra trùng + consent phụ thuộc):
    # "+84 (0) 905…"/"84 0905…" (giữ số 0 trung kế sau mã nước) → bỏ
    # "84", giữ 0; "+84 905…" → thay "84" bằng 0. Sau đó chữ số thứ 2
    # KHÔNG được là 0 — chặn "00905…" thành contact thứ hai cùng người.
    if digits.startswith("840") and len(digits) in (12, 13):
        digits = digits[2:]
    elif digits.startswith("84") and len(digits) in (11, 12):
        digits = "0" + digits[2:]
    if not re.fullmatch(r"0[1-9][0-9]{8,9}", digits):
        raise ValueError("SĐT không hợp lệ")
    return digits


def phone_lookup(phone_norm: str, lookup_key: bytes) -> str:
    return hmac.new(lookup_key, phone_norm.encode("utf-8"),
                    hashlib.sha256).hexdigest()


def seal(f: Fernet, value):
    """Mã hóa 1 field; None/rỗng → None (cột null)."""
    if value is None:
        return None
    v = unicodedata.normalize("NFC", str(value)).strip()
    return f.encrypt(v.encode("utf-8")).decode("ascii") if v else None


def unseal(f: Fernet, token):
    if token is None:
        return None
    try:
        return f.decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise VaultKeyError("khóa không khớp dữ liệu") from None


def _check_by(by) -> str:
    b = (by or "").strip() if isinstance(by, str) else ""
    if not b or len(b) > MAX_BY_LEN or not b.isprintable():
        raise ValueError(f"--by phải là tên người 1..{MAX_BY_LEN} ký tự "
                         "in được")
    return b


def _log(conn, by, action, otype, oid, detail: dict):
    """1 dòng agent_action_log — detail CHỈ id/mục đích/mã/tỉnh/trạng
    thái, không PII/HMAC/ciphertext."""
    conn.execute(_LOG_SQL, (by, action, otype, str(oid), Jsonb(detail)))


def add_contact(conn, rec: dict, keys, by, lead_id=None) -> tuple[int, bool]:
    """Thêm liên hệ vào vault → (contact_id, mới?). Trùng SĐT (HMAC) →
    id cũ + False, KHÔNG ghi đè PII cũ. `lead_id` → gắn lead (lead không
    tồn tại / đã gắn contact khác → ValueError, rollback cả contact)."""
    f, lookup_key = keys
    by = _check_by(by)
    if not isinstance(rec, dict):
        raise TypeError("JSON liên hệ phải là object")
    if set(rec) - set(CONTACT_KEYS):
        raise ValueError("JSON liên hệ có key không hỗ trợ (chỉ nhận "
                         + "/".join(CONTACT_KEYS) + ")")
    phone = normalize_phone(rec.get("phone"))
    for k, cap in MAX_FIELD.items():
        v = rec.get(k)
        if v is not None and (not isinstance(v, str) or len(v) > cap):
            raise ValueError(f"field '{k}' phải là chuỗi ≤ {cap} ký tự")
    province = None
    if rec.get("province") not in (None, ""):
        province = province_of(rec["province"]) \
            if isinstance(rec["province"], str) else None
        if province is None:
            raise ValueError("tỉnh/thành không nhận ra (34 tỉnh sau sáp "
                             "nhập hoặc tên cũ)")
    source = rec.get("source") or "manual"
    if not isinstance(source, str) or not SOURCE_RE.fullmatch(source):
        raise ValueError("source phải khớp [a-z0-9_.:-]{1,50}")
    if lead_id is not None and (not isinstance(lead_id, int)
                                or isinstance(lead_id, bool)):
        raise ValueError("lead_id phải là số nguyên")
    with conn.transaction():
        row = conn.execute(
            "insert into contacts (phone_hmac, phone_enc, name_enc, "
            "email_enc, address_enc, province, source, created_by) values "
            "(%s, %s, %s, %s, %s, %s, %s, %s) "
            "on conflict (phone_hmac) do nothing returning id",
            (phone_lookup(phone, lookup_key), seal(f, phone),
             seal(f, rec.get("name")), seal(f, rec.get("email")),
             seal(f, rec.get("address")), province, source, by)).fetchone()
        new = row is not None
        cid = row[0] if new else conn.execute(
            "select id from contacts where phone_hmac = %s",
            (phone_lookup(phone, lookup_key),)).fetchone()[0]
        if lead_id is not None:
            cur = conn.execute(
                "select contact_id from leads where id = %s for update",
                (lead_id,)).fetchone()
            if cur is None:
                raise ValueError(f"không có lead #{lead_id}")
            if cur[0] is not None and cur[0] != cid:
                raise ValueError(f"lead #{lead_id} đã gắn contact khác")
            conn.execute("update leads set contact_id = %s where id = %s",
                         (cid, lead_id))
        _log(conn, by, "crm_contact_add", "contact", cid,
             {"new": new, "lead_id": lead_id, "province": province})
    return cid, new


# ---------------------------------------------------------------- consent
def record_consent(conn, contact_id, purpose, granted, source, by,
                   evidence_ref=None, policy_version=None,
                   dealer_code=None) -> int:
    """Ghi 1 dòng đồng ý/rút đồng ý (append-only) → id. Validate TRƯỚC
    khi ghi; vi phạm → ValueError, không ghi dòng nào."""
    by = _check_by(by)
    if purpose not in PURPOSES:
        raise ValueError(f"purpose phải là {'|'.join(PURPOSES)}")
    if source not in CONSENT_SOURCES:
        raise ValueError(f"source phải là {'|'.join(CONSENT_SOURCES)}")
    if not isinstance(granted, bool):
        raise TypeError("granted phải là True/False")
    if purpose == "dai_ly" and not dealer_code:
        raise ValueError("đồng ý dai_ly phải ghi ĐÍCH DANH đại lý (--dealer)")
    if purpose != "dai_ly" and dealer_code:
        raise ValueError("--dealer chỉ dùng với mục đích dai_ly")
    ev = (evidence_ref or "").strip() or None
    pv = (policy_version or "").strip() or None
    if ev is not None and (len(ev) > MAX_EVIDENCE or not ev.isprintable()
                           or _PII_RE.search(ev)):
        raise ValueError("evidence_ref phải là MÃ biên bản/scan ≤ "
                         f"{MAX_EVIDENCE} ký tự, không chứa SĐT/email")
    if pv is not None and (len(pv) > MAX_POLICY or not pv.isprintable()):
        raise ValueError(f"policy_version ≤ {MAX_POLICY} ký tự in được")
    if granted and (ev is None or pv is None):
        raise ValueError("ghi đồng ý cần --evidence và --policy-version")
    with conn.transaction():
        if conn.execute("select 1 from contacts where id = %s",
                        (contact_id,)).fetchone() is None:
            raise ValueError(f"không có contact #{contact_id}")
        if dealer_code and conn.execute(
                "select 1 from dealers where code = %s",
                (dealer_code,)).fetchone() is None:
            raise ValueError(f"không có đại lý {dealer_code}")
        cid = conn.execute(
            "insert into consents (contact_id, purpose, granted, "
            "recipient_dealer, source, evidence_ref, policy_version, "
            "recorded_by) values (%s, %s, %s, %s, %s, %s, %s, %s) "
            "returning id",
            (contact_id, purpose, granted, dealer_code or None, source, ev,
             pv, by)).fetchone()[0]
        _log(conn, by, "crm_consent", "contact", contact_id,
             {"consent_id": cid, "purpose": purpose, "granted": granted,
              "dealer": dealer_code or None})
    return cid


def can_contact(conn, contact_id, purpose, dealer_code=None) -> bool:
    """True CHỈ khi dòng mới nhất (theo id) của (contact, purpose,
    dealer) là granted. Chưa có dòng / dai_ly không đích danh → False.
    DB lỗi → raise (caller quyết, không nuốt)."""
    if purpose not in PURPOSES:
        raise ValueError(f"purpose phải là {'|'.join(PURPOSES)}")
    if purpose == "dai_ly" and not dealer_code:
        return False
    row = conn.execute(
        "select granted from v_consent_current where contact_id = %s "
        "and purpose = %s and coalesce(recipient_dealer, '') = %s",
        (contact_id, purpose, dealer_code or "")).fetchone()
    return bool(row and row[0] is True)


# ------------------------------------------------------- tỉnh / vùng / đại lý
def _norm(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def _alt_re(names) -> re.Pattern:
    alts = sorted(names, key=len, reverse=True)   # tên dài khớp trước
    return re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, alts))
                      + r")(?!\w)")


@functools.lru_cache(maxsize=4)
def _province_index(path: Path = PROVINCES_FILE):
    doc = json.loads(path.read_bytes().decode("utf-8"))
    provinces = doc["provinces"]
    if len(provinces) != 34 or len(set(provinces)) != 34:
        raise ValueError(f"{path.name}: provinces phải đúng 34 tên duy nhất")
    names = {_norm(p): p for p in provinces}
    for alias, target in doc["aliases"].items():
        if target not in provinces:
            raise ValueError(f"{path.name}: alias trỏ ngoài 34 tỉnh")
        if names.setdefault(_norm(alias), target) != target:
            raise ValueError(f"{path.name}: alias trùng trỏ 2 tỉnh")
    plain: dict[str, str | None] = {}
    for n, p in names.items():
        k = _strip_accents(n)
        plain[k] = p if plain.get(k, p) == p else None   # đụng → bỏ
    plain = {k: v for k, v in plain.items() if v}
    return tuple(provinces), names, _alt_re(names), plain, _alt_re(plain)


def provinces() -> tuple:
    return _province_index()[0]


def province_of(text) -> str | None:
    """Text tự do → 1 trong 34 tên tỉnh mới | None. Khớp CÓ DẤU với ranh
    giới từ; fallback không dấu CHỈ khi text không có ký tự có dấu nào
    ("hoa huệ" ≠ Huế, "sơn là" ≠ Sơn La). >1 tỉnh mới khác nhau → None
    (mơ hồ — để người gán)."""
    if not isinstance(text, str) or not text.strip():
        return None
    t = _norm(text[:MAX_PROVINCE_TEXT])
    _, names, acc_re, plain, plain_re = _province_index()
    found = {names[m.group(0)] for m in acc_re.finditer(t)}
    if not found and _strip_accents(t) == t:
        found = {plain[m.group(0)] for m in plain_re.finditer(t)}
    return found.pop() if len(found) == 1 else None


def load_regions(path: Path = REGIONS_FILE) -> dict:
    """Đọc + validate bảng vùng/đại lý → {"regions", "dealers",
    "province_region"}. Lỗi → ValueError nêu field."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    valid = set(provinces())
    regions = doc.get("regions") if isinstance(doc, dict) else None
    dealers = doc.get("dealers") if isinstance(doc, dict) else None
    if not isinstance(regions, dict) or not regions:
        raise ValueError("regions: phải là object không rỗng")
    if not isinstance(dealers, list):
        raise TypeError("dealers: phải là list")
    owner: dict[str, str] = {}
    for code, provs in regions.items():
        if not REGION_CODE_RE.fullmatch(code):
            raise ValueError(f"regions.{code}: mã vùng sai mẫu")
        if not isinstance(provs, list):
            raise TypeError(f"regions.{code}: phải là list tỉnh")
        for p in provs:
            if p not in valid:
                raise ValueError(f"regions.{code}: tỉnh ngoài 34 ({p!r})")
            if p in owner:
                raise ValueError(f"regions.{code}: tỉnh {p} đã thuộc vùng "
                                 f"{owner[p]}")
            owner[p] = code
    missing = sorted(valid - set(owner))
    if missing:
        raise ValueError(f"regions: tỉnh không thuộc vùng nào {missing}")
    seen = set()
    for i, d in enumerate(dealers):
        if not isinstance(d, dict):
            raise TypeError(f"dealers[{i}]: phải là object")
        code = d.get("code")
        if not isinstance(code, str) or not DEALER_CODE_RE.fullmatch(code):
            raise ValueError(f"dealers[{i}].code: sai mẫu [A-Z0-9_-]{{2,20}}")
        if code in seen:
            raise ValueError(f"dealers[{i}].code: trùng {code}")
        seen.add(code)
        if not isinstance(d.get("name"), str) or not d["name"].strip():
            raise ValueError(f"dealers[{i}].name: thiếu")
        if d.get("region") not in regions:
            raise ValueError(f"dealers[{i}].region: vùng lạ")
        if d.get("status", "active") not in DEALER_STATUSES:
            raise ValueError(f"dealers[{i}].status: phải là "
                             f"{'|'.join(DEALER_STATUSES)}")
        c = d.get("commission_default", 0)
        if isinstance(c, bool) or not isinstance(c, (int, float)) \
                or not 0 <= c <= 100:
            raise ValueError(f"dealers[{i}].commission_default: 0..100")
    return {"regions": regions, "dealers": dealers,
            "province_region": owner}


def commission_rate(dealer: dict, category, online: bool) -> Decimal:
    """Hoa hồng % cho 1 dòng bán qua đại lý. Rượu kênh online luôn 0
    (WP07: "Rượu có hoa hồng 0"); category lạ/None → 0 (fail-closed);
    đại lý không active → 0."""
    if category not in CATEGORIES:
        return Decimal(0)
    if category == "alcohol" and online:
        return Decimal(0)
    if dealer.get("status", "active") != "active":
        return Decimal(0)
    return Decimal(str(dealer.get("commission_default") or 0))


def load_dealers(conn, regions: dict, by) -> dict:
    """Upsert `dealers` theo code từ file vùng (source
    'dealer_regions.json'); dòng source='manual' KHÔNG bị đè."""
    by = _check_by(by)
    res = {"new": 0, "updated": 0, "kept": 0}
    with conn.transaction():
        for d in regions["dealers"]:
            row = conn.execute(
                "insert into dealers (code, name, region, status, "
                "commission_default, source) values (%s, %s, %s, %s, %s, "
                "'dealer_regions.json') on conflict (code) do update set "
                "name = excluded.name, region = excluded.region, "
                "status = excluded.status, commission_default = "
                "excluded.commission_default, updated_at = now() "
                "where dealers.source <> 'manual' and (dealers.name, "
                "dealers.region, dealers.status, dealers.commission_default)"
                " is distinct from (excluded.name, excluded.region, "
                "excluded.status, excluded.commission_default) "
                "returning (xmax = 0)",
                (d["code"], d["name"].strip(), d["region"],
                 d.get("status", "active"),
                 d.get("commission_default", 0))).fetchone()
            res["kept" if row is None else
                "new" if row[0] else "updated"] += 1
        _log(conn, by, "crm_dealer_load", "dealer", "*", dict(res))
    return res


# ------------------------------------------------------------------ leads
def assign_lead(conn, lead_id, dealer_code, by, province=None,
                regions=None) -> str:
    """Gán lead cho đại lý phụ trách vùng → tên tỉnh. Tỉnh = `province`
    (nhận cả tên cũ) hoặc suy từ câu hỏi; không xác định / đại lý không
    active / vùng không phủ tỉnh / lead đã gán đại lý khác → ValueError."""
    by = _check_by(by)
    regions = regions or load_regions()
    with conn.transaction():
        lead = conn.execute(
            "select question, dealer_code from leads where id = %s "
            "for update", (lead_id,)).fetchone()
        if lead is None:
            raise ValueError(f"không có lead #{lead_id}")
        if lead[1] is not None and lead[1] != dealer_code:
            raise ValueError(f"lead #{lead_id} đã gán {lead[1]} — tranh chấp "
                             "chuyển người duyệt (không gán đè)")
        if province not in (None, ""):
            prov = province_of(province)
            if prov is None:
                raise ValueError("--province không nhận ra (34 tỉnh sau "
                                 "sáp nhập hoặc tên cũ)")
        else:
            prov = province_of(lead[0] or "")
            if prov is None:
                raise ValueError("chưa xác định tỉnh — truyền --province")
        dealer = conn.execute(
            "select region, status from dealers where code = %s",
            (dealer_code,)).fetchone()
        if dealer is None:
            raise ValueError(f"không có đại lý {dealer_code}")
        if dealer[1] != "active":
            raise ValueError(f"đại lý {dealer_code} đang {dealer[1]}")
        if regions["province_region"].get(prov) != dealer[0]:
            raise ValueError(f"đại lý {dealer_code} (vùng {dealer[0]}) "
                             f"không phụ trách {prov}")
        conn.execute(
            "update leads set province = %s, dealer_code = %s, "
            "assigned_by = %s, assigned_at = now() where id = %s",
            (prov, dealer_code, by, lead_id))
        _log(conn, by, "crm_assign", "lead", lead_id,
             {"dealer": dealer_code, "province": prov})
    return prov


def set_lead_status(conn, lead_id, status, by) -> str:
    """Đổi trạng thái chỉ tiến: new → contacted → qualified → won; mọi
    trạng thái chưa kết thúc → lost. Lùi / đổi từ won|lost → ValueError.
    Trả trạng thái cũ."""
    by = _check_by(by)
    if status not in LEAD_STATES:
        raise ValueError(f"trạng thái phải là {'|'.join(LEAD_STATES)}")
    with conn.transaction():
        row = conn.execute("select status from leads where id = %s "
                           "for update", (lead_id,)).fetchone()
        if row is None:
            raise ValueError(f"không có lead #{lead_id}")
        old = row[0]
        if old in TERMINAL:
            raise ValueError(f"lead #{lead_id} đã kết thúc ({old})")
        if old not in LEAD_FLOW:
            raise ValueError(f"lead #{lead_id} trạng thái lạ — sửa tay")
        if status != "lost" and LEAD_FLOW.index(status) <= \
                LEAD_FLOW.index(old):
            raise ValueError(f"không lùi/giữ trạng thái {old} → {status}")
        conn.execute("update leads set status = %s where id = %s",
                     (status, lead_id))
        _log(conn, by, "crm_status", "lead", lead_id,
             {"from": old, "to": status})
    return old


def report(conn, regions=None) -> str:
    """Báo cáo CRM CHỈ SELECT, KHÔNG giải mã (không cần khóa): tổng
    liên hệ, đồng ý hiện hành, lead theo tỉnh/đại lý/trạng thái, lead chưa
    gán + đại lý gợi ý. KHÔNG in question/user_hash/PII/HMAC/ciphertext."""
    regions = regions or load_regions()
    q = conn.execute
    out = ["# CRM — lead & đại lý (không chứa PII)"]
    out.append(f"Liên hệ trong vault: "
               f"{q('select count(*) from contacts').fetchone()[0]}")
    out.append("Đồng ý hiện hành (mục đích: đồng ý / đã rút):")
    cons = {p: (g, w) for p, g, w in q(
        "select purpose, count(*) filter (where granted), "
        "count(*) filter (where not granted) from v_consent_current "
        "group by purpose").fetchall()}
    for p in PURPOSES:
        g, w = cons.get(p, (0, 0))
        out.append(f"  {p}: {g} / {w}")
    for title, col in (("tỉnh", "coalesce(province, 'chưa xác định')"),
                       ("đại lý", "coalesce(dealer_code, 'chưa gán')"),
                       ("trạng thái", "status")):
        out.append(f"Lead theo {title}:")
        rows = q(f"select {col}, count(*) from leads group by 1 "
                 "order by 2 desc, 1").fetchall()
        out.extend([f"  {k}: {n}" for k, n in rows]
                   or ["  (chưa có lead)"])
    active = q("select code, region from dealers where status = 'active' "
               "order by code").fetchall()
    pending = q("select id, ts, intent, province, question from leads "
                "where dealer_code is null and status not in ('won','lost') "
                "order by ts limit 50").fetchall()
    out.append(f"Lead CHƯA gán ({len(pending)} — tối đa 50):")
    for lid, ts, intent, prov, question in pending:
        prov = prov or province_of(question or "")
        reg = regions["province_region"].get(prov)
        sug = [c for c, r in active if reg and r == reg]
        out.append(f"  #{lid} {ts:%Y-%m-%d} {intent} — tỉnh: "
                   f"{prov or 'chưa xác định'} — gợi ý: "
                   f"{', '.join(sug) or '-'}")
    return "\n".join(out)


def handoff_payload(conn, lead_id, dealer_code, keys) -> dict:
    """Payload cho NGƯỜI chuyển lead tới đại lý (hệ thống không gửi).
    Luôn có lead_id/province/intent/question (đã mask). PII giải mã CHỈ
    khi lead có contact VÀ consent dai_ly ĐÍCH DANH đại lý này hiện hành
    — ngược lại các key PII không có mặt."""
    f, _ = keys
    lead = conn.execute(
        "select dealer_code, province, intent, question, contact_id "
        "from leads where id = %s", (lead_id,)).fetchone()
    if lead is None:
        raise ValueError(f"không có lead #{lead_id}")
    if lead[0] != dealer_code:
        raise ValueError(f"lead #{lead_id} không gán cho {dealer_code}")
    st = conn.execute("select status from dealers where code = %s",
                      (dealer_code,)).fetchone()
    if st is None or st[0] != "active":
        raise ValueError(f"đại lý {dealer_code} không active")
    payload = {"lead_id": lead_id, "dealer": dealer_code,
               "province": lead[1], "intent": lead[2],
               "question": _mask_pii(lead[3] or "")}
    if lead[4] is not None and can_contact(conn, lead[4], "dai_ly",
                                           dealer_code):
        c = conn.execute(
            "select phone_enc, name_enc, email_enc, address_enc "
            "from contacts where id = %s", (lead[4],)).fetchone()
        for k, tok in zip(("phone", "name", "email", "address"), c):
            v = unseal(f, tok)
            if v is not None:
                payload[k] = v
    return payload


# -------------------------------------------------------------------- CLI
def _read_contact_json(src: str) -> dict:
    """`-` = stdin; PATH phải nằm NGOÀI repo (không để file PII trong
    git). Lỗi → ValueError không echo nội dung."""
    if src == "-":
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    else:
        p = Path(src).resolve()
        if p == ROOT or ROOT in p.parents:
            raise ValueError("file liên hệ phải nằm NGOÀI repo "
                             "(không lưu PII trong git) — dùng stdin `-`")
        try:
            with p.open("rb") as fh:
                data = fh.read(MAX_INPUT_BYTES + 1)
        except OSError as e:
            raise ValueError(f"không đọc được file ({type(e).__name__})") \
                from None
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("JSON liên hệ quá lớn")
    try:
        rec = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("JSON liên hệ không hợp lệ") from None
    if not isinstance(rec, dict):
        raise TypeError("JSON liên hệ phải là object")
    return rec


def _connect():
    return lead_store.connect()


# v14.2: thao tác CLI → hành động `auth.cli_gate` (khối sales).
GATED_OPS = {"consent": "consent", "assign": "assign", "handoff": "handoff",
             "load-dealers": "load_dealers"}


def _db_msg(e: psycopg.Error) -> str:
    """Thông điệp lỗi DB không kèm DETAIL (DETAIL có thể chứa giá trị)."""
    prim = getattr(getattr(e, "diag", None), "message_primary", None)
    return _mask_pii(f"{type(e).__name__}: {prim or ''}"[:300])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.crm",
        description="CRM lead & đại lý (contact_vault + đồng ý). Agent "
                    "không tự liên hệ khách/đại lý — mọi thao tác ghi do "
                    "NGƯỜI chạy với --by.")
    ap.add_argument("--add-contact", metavar="SRC",
                    help="thêm liên hệ từ JSON {phone,name,email,address,"
                         "province,source}: '-' = stdin, hoặc file NGOÀI "
                         "repo (cần CONTACT_VAULT_KEY)")
    ap.add_argument("--lead", type=int, metavar="ID",
                    help="(với --add-contact) gắn liên hệ vào lead")
    ap.add_argument("--consent", type=int, metavar="CONTACT_ID",
                    help="ghi đồng ý/rút đồng ý cho 1 liên hệ")
    ap.add_argument("--purpose", choices=PURPOSES)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--grant", action="store_true")
    g.add_argument("--withdraw", action="store_true")
    ap.add_argument("--source", choices=CONSENT_SOURCES)
    ap.add_argument("--evidence", metavar="REF",
                    help="mã biên bản/scan (bắt buộc khi --grant)")
    ap.add_argument("--policy-version", metavar="V",
                    help="phiên bản nội dung đồng ý (bắt buộc khi --grant)")
    ap.add_argument("--dealer", metavar="CODE",
                    help="mã đại lý (consent dai_ly / --assign / --handoff)")
    ap.add_argument("--assign", type=int, metavar="LEAD",
                    help="gán lead cho --dealer theo vùng")
    ap.add_argument("--province", metavar="TÊN",
                    help="(với --assign) tỉnh của lead, nhận cả tên cũ")
    ap.add_argument("--status", nargs=2, metavar=("LEAD", "STATE"),
                    help=f"đổi trạng thái lead ({'|'.join(LEAD_STATES)})")
    ap.add_argument("--report", action="store_true",
                    help="báo cáo CRM (không PII, không cần khóa)")
    ap.add_argument("--handoff", type=int, metavar="LEAD",
                    help="in payload lead cho --dealer (NGƯỜI tự chuyển; "
                         "cần CONTACT_VAULT_KEY)")
    ap.add_argument("--load-dealers", nargs="?", const=str(REGIONS_FILE),
                    metavar="PATH", help="nạp đại lý từ file vùng (mặc "
                    "định data/dealer_regions.json)")
    ap.add_argument("--by", help="tên NGƯỜI thực hiện (bắt buộc khi ghi)")
    args = ap.parse_args(argv)

    ops = {"add-contact": args.add_contact is not None,
           "consent": args.consent is not None,
           "assign": args.assign is not None,
           "status": args.status is not None, "report": args.report,
           "handoff": args.handoff is not None,
           "load-dealers": args.load_dealers is not None}
    chosen = [k for k, v in ops.items() if v]
    if len(chosen) != 1:
        ap.error("cần đúng 1 thao tác: --" + " | --".join(ops))
    op = chosen[0]
    if args.lead is not None and op != "add-contact":
        ap.error("--lead chỉ dùng với --add-contact")
    if op != "consent" and (args.purpose or args.grant or args.withdraw
                            or args.source or args.evidence
                            or args.policy_version):
        ap.error("--purpose/--grant/--withdraw/--source/--evidence/"
                 "--policy-version chỉ dùng với --consent")
    if args.province is not None and op != "assign":
        ap.error("--province chỉ dùng với --assign")
    if args.dealer is not None and op not in ("consent", "assign",
                                              "handoff"):
        ap.error("--dealer chỉ dùng với --consent/--assign/--handoff")
    if args.dealer is not None and not DEALER_CODE_RE.fullmatch(args.dealer):
        ap.error("--dealer sai mẫu mã đại lý [A-Z0-9_-]{2,20}")
    if op == "report":
        if args.by is not None:
            ap.error("--report chỉ đọc — không dùng --by")
        by = None
    else:
        try:
            by = _check_by(args.by)
        except ValueError as e:
            ap.error(str(e))
    if op == "consent":
        if not args.purpose or not args.source or not (args.grant
                                                       or args.withdraw):
            ap.error("--consent cần --purpose, --source và --grant|--withdraw")
        if args.purpose == "dai_ly" and not args.dealer:
            ap.error("--purpose dai_ly cần --dealer (đồng ý ĐÍCH DANH)")
        if args.purpose != "dai_ly" and args.dealer:
            ap.error("--dealer chỉ dùng với --purpose dai_ly")
        if args.grant and not (args.evidence and args.policy_version):
            ap.error("--grant cần --evidence và --policy-version")
    if op in ("assign", "handoff") and not args.dealer:
        ap.error(f"--{op} cần --dealer")
    status_lead = None
    if op == "status":
        lead_s, state = args.status
        if not re.fullmatch(r"[0-9]{1,18}", lead_s) \
                or state not in LEAD_STATES:
            ap.error(f"--status LEAD STATE — LEAD số, STATE "
                     f"{'|'.join(LEAD_STATES)}")
        status_lead = int(lead_s)

    load_dotenv(ROOT / ".env")
    keys = None
    rec = None
    regions = None
    try:
        if op in ("add-contact", "handoff"):
            keys = load_vault_key(os.environ)
        if op == "add-contact":
            rec = _read_contact_json(args.add_contact)
            normalize_phone(rec.get("phone"))
        if op in ("assign", "report", "load-dealers"):
            regions = load_regions(Path(args.load_dealers)
                                   if op == "load-dealers" else REGIONS_FILE)
    except VaultKeyError as e:
        print(f"[err] {e}", flush=True)
        return 2
    except (ValueError, TypeError) as e:
        print(f"[err] {e} — không ghi gì.", flush=True)
        return 2

    conn = _connect()
    if conn is None:
        print("[err] DB không truy cập được — kiểm DATABASE_URL / chạy "
              "`python scripts/apply_schema.py`", flush=True)
        return 1
    # v14.2: quyết định cho phép dùng/chuyển PII (đồng ý, gán/chuyển đại lý,
    # sổ đại lý) = người được Bên B ủy quyền khối sales (auth.cli_gate).
    # Nhập liên hệ / đổi trạng thái lead = việc nhập liệu, không qua cổng.
    gated = GATED_OPS.get(op)
    if gated:
        from pipelines import auth  # lười: auth → director → ...
        oid = {"consent": args.consent, "assign": args.assign,
               "handoff": args.handoff}.get(op, "dealers")
        why = auth.cli_gate(conn, by, "sales", gated, "crm", oid)
        if why:
            conn.close()
            print(f"[err] {why} — không ghi.", flush=True)
            return 1
    try:
        if op == "add-contact":
            cid, new = add_contact(conn, rec, keys, by, args.lead)
            conn.commit()
            print(f"[ok] contact #{cid} ({'mới' if new else 'đã có'})"
                  + (f" — gắn lead #{args.lead}" if args.lead else ""))
        elif op == "consent":
            cid = record_consent(
                conn, args.consent, args.purpose, bool(args.grant),
                args.source, by, args.evidence, args.policy_version,
                args.dealer)
            conn.commit()
            print(f"[ok] consent #{cid}: contact #{args.consent} "
                  f"{args.purpose}"
                  + (f"/{args.dealer}" if args.dealer else "")
                  + (" ĐỒNG Ý" if args.grant else " RÚT"))
        elif op == "load-dealers":
            res = load_dealers(conn, regions, by)
            conn.commit()
            print(f"[ok] đại lý: mới={res['new']} cập nhật="
                  f"{res['updated']} giữ nguyên={res['kept']}")
        elif op == "assign":
            prov = assign_lead(conn, args.assign, args.dealer, by,
                               args.province, regions)
            conn.commit()
            print(f"[ok] lead #{args.assign} → {args.dealer} ({prov})")
        elif op == "status":
            old = set_lead_status(conn, status_lead, args.status[1], by)
            conn.commit()
            print(f"[ok] lead #{status_lead}: {old} → {args.status[1]}")
        elif op == "report":
            print(report(conn, regions))
        elif op == "handoff":
            payload = handoff_payload(conn, args.handoff, args.dealer, keys)
            pii = "phone" in payload
            with conn.transaction():
                _log(conn, by, "crm_handoff", "lead", args.handoff,
                     {"lead_id": args.handoff, "dealer": args.dealer,
                      "pii_included": pii})
            conn.commit()
            print("[ok] payload cho NGƯỜI chuyển tới đại lý (hệ thống "
                  "không gửi):")
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, TypeError, VaultKeyError) as e:
        conn.rollback()
        print(f"[err] {e} — không ghi.", flush=True)
        return 1
    except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn):
        conn.rollback()
        print("[err] DB không truy cập được / thiếu bảng — chạy "
              "`python scripts/apply_schema.py`", flush=True)
        return 1
    except psycopg.Error as e:
        try:
            conn.rollback()
        except psycopg.Error:
            pass
        print(f"[err] lỗi DB — {_db_msg(e)}", flush=True)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
