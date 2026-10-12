"""v9.4 Lô + QR truy xuất (WP13 VT — thí điểm mật ong, 3 chữ ký, phương án B).

Luồng NGƯỜI (mọi bước ghi cần `--by`, đi qua function DB SECURITY DEFINER
trong block "v9.4 lô + QR truy xuất" của `docs/schema.sql` — module KHÔNG
insert thẳng `approvals`/`lot_origins`/`qr_signatures`/`qr_codes`):
  link    GĐ Sản xuất ánh xạ lô ↔ nhật ký `thu hoạch` ĐÃ CHAIN (v9.3)
  preview xem lời văn trang + sha + guardrail kênh `qr` + vai đã ký/còn thiếu
  sign    3 vai (GĐ SX, GĐ vùng trồng, Pháp chế/QA) — 3 người khác nhau —
          ký CÙNG bản chụp dữ liệu + CÙNG lời văn
  issue   phát hành mã ngẫu nhiên `secrets.token_urlsafe(16)` (không suy ra
          được mã lô) — DB kiểm đủ 3 chữ ký
  revoke  thu hồi mã → trang "đã thu hồi"
  site    sinh trang tĩnh `data/qr_site/<code>/index.html` (gitignored)
  planb   bản tin phương án B theo mốc cấu hình (tem không QR — GĐ quyết)

Danh tính `--by` hiện là TỰ KHAI + allowlist `data/qr_signers.json` (ship
rỗng) — SSO thật = external-dep. Không sinh ảnh QR (lib QR không có trong
interpreter): in URL, nhà in tạo QR (external-dep). Không gửi, không in,
không gọi LLM. Trang công khai: KHÔNG tọa độ/vị trí khoảnh/mã khoảnh, KHÔNG
tên/SĐT/email người (nhật ký, ảnh, người ký) — mọi lời văn qua
`guardrail.check_publish(channel="qr")` + probe PII/tọa độ.

Hàm thuần (nhận `today` làm tham số — chỉ `main()` đọc đồng hồ):
  load_config(path=None, golden=None) / load_signers(path=None)
  page_text(lot, origins, product, config) -> str
  text_sha(text) -> str ; check_page(text, sku) -> [mã vi phạm]
  new_code() -> str ; page_html(text, media) / revoked_html(day) -> str
  plan_b_report(lots, signed_roles, today, config, golden) -> str

CLI: python -m pipelines.qr_trace
       link    --lot L --log ID [--media SHA ...] --by NAME
       unlink  --lot L --log ID --by NAME
       preview --lot L
       sign    --lot L --role gd_san_xuat|gd_vung_trong|phap_che_qa --by NAME
               [--note ..]
       issue   --lot L --by NAME
       revoke  --code C --by NAME [--reason ..]
       site    [--out DIR]
       planb   [--date YYYY-MM-DD]
Exit: 0 OK; 1 từ chối nghiệp vụ / dữ liệu / DB lỗi; 2 sai usage.
"""

import argparse
import datetime as dt
import hashlib
import html
import os
import re
import secrets
import sys
import unicodedata
from pathlib import Path

from ingest import golden_store
from pipelines import guardrail, production
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "qr_config.json"
SIGNERS_FILE = ROOT / "data" / "qr_signers.json"
SITE_DIR = ROOT / "data" / "qr_site"
GOLDEN_FILE = golden_store.GOLDEN_FILE
TZ_VN = production.TZ_VN

ROLES = {"gd_san_xuat": "GĐ Sản xuất", "gd_vung_trong": "GĐ vùng trồng",
         "phap_che_qa": "Pháp chế/QA"}
CHANNEL = "qr"
MAX_REGION = 120
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{22,64}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
COORD_RE = re.compile(r"\d{1,3}[.,]\d{4,}")
TITLE = "Truy xuất nguồn gốc sản phẩm"
SAMPLE_LINE = "[MẪU] dữ liệu mẫu — không dùng in tem"
REVOKED = "Mã truy xuất này đã thu hồi"
MEDIA_EXT = ("jpg", "png")


class QrError(ValueError):
    """Cấu hình/dữ liệu QR không dùng được — fail-closed."""


_err = production._err


def _d(d: dt.date) -> str:
    return d.strftime("%d/%m/%Y")


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s.casefold())
    return "".join(c for c in s if not unicodedata.combining(c)
                   ).replace("đ", "d")


def norm_name(s: str) -> str:
    """Chuẩn hóa danh tính người ký: NFC + gộp khoảng trắng + casefold."""
    return " ".join(unicodedata.normalize("NFC", s).split()).casefold()


def _read(path) -> dict:
    try:
        return production.read_json(path, "")
    except production.ProductionError as e:
        raise QrError(str(e)) from e


# ---------- cấu hình (fail-closed TRƯỚC connect) ----------

def golden_map(path=None) -> dict:
    doc, why = golden_store.read_golden(Path(path or GOLDEN_FILE))
    if doc is None:
        raise QrError(f"golden: {why}")
    return {s["sku_key"]: s for s in doc["skus"]
            if isinstance(s, dict) and isinstance(s.get("sku_key"), str)}


def validate_config(doc: dict, golden: dict) -> dict:
    status = doc.get("status")
    if not isinstance(status, str) or not status.strip():
        raise QrError("qr_config: thiếu 'status'")
    skus = doc.get("pilot_skus")
    if (not isinstance(skus, list) or not skus
            or not all(isinstance(k, str) for k in skus)):
        raise QrError("qr_config: 'pilot_skus' phải là list chuỗi không rỗng")
    if len(set(skus)) != len(skus):
        raise QrError("qr_config: 'pilot_skus' bị trùng")
    for k in skus:
        if k not in golden:
            raise QrError(f"qr_config: SKU {production._clean(k, 60)} không "
                          "có trong golden")
        if golden[k].get("category") == "alcohol":
            raise QrError(f"qr_config: {k} là rượu — không thí điểm QR")
    region = doc.get("region_text")
    if not isinstance(region, str) or not 0 < len(region.strip()) <= MAX_REGION:
        raise QrError(f"qr_config: 'region_text' 1..{MAX_REGION} ký tự")
    region = region.strip()
    if any(c.isdigit() for c in region) or not region.isprintable():
        raise QrError("qr_config: 'region_text' không được có chữ số/ký tự "
                      "điều khiển (chặn tọa độ, số nhà)")
    if "ngoc linh" in " ".join(_fold(region).split()):
        raise QrError("qr_config: 'region_text' không dùng 'Ngọc Linh' (chưa "
                      "SKU nào có quyết định chỉ dẫn địa lý)")
    if not guardrail.check(region)["ok"]:
        raise QrError("qr_config: 'region_text' không qua guardrail")
    try:
        deadline = dt.date.fromisoformat(doc.get("plan_b_deadline"))
    except (TypeError, ValueError) as e:
        raise QrError("qr_config: 'plan_b_deadline' phải là YYYY-MM-DD") from e
    base = doc.get("public_base_url")
    if not isinstance(base, str):
        raise QrError("qr_config: 'public_base_url' phải là chuỗi")
    base = base.strip()
    if base and (not base.startswith("https://") or len(base) <= 8
                 or any(c in base for c in "?#<>\"' ")
                 or not base.isprintable()):
        raise QrError("qr_config: 'public_base_url' rỗng hoặc https://... "
                      "không query")
    return {"status": status.strip(), "pilot_skus": list(skus),
            "region_text": region, "plan_b_deadline": deadline,
            "public_base_url": base.rstrip("/")}


def load_config(path=None, golden: dict | None = None) -> dict:
    return validate_config(_read(path or CONFIG_FILE),
                           golden if golden is not None else golden_map())


def validate_signers(doc: dict) -> dict[str, set[str]]:
    status = doc.get("status")
    if not isinstance(status, str) or not status.strip():
        raise QrError("qr_signers: thiếu 'status'")
    roles = doc.get("roles")
    if not isinstance(roles, dict) or set(roles) != set(ROLES):
        raise QrError("qr_signers: 'roles' phải có đúng 3 vai "
                      + ", ".join(ROLES))
    out, owner = {}, {}
    for role in ROLES:
        names = roles[role]
        if not isinstance(names, list):
            raise QrError(f"qr_signers: {role} phải là list")
        out[role] = set()
        for n in names:
            if (not isinstance(n, str) or not n.strip()
                    or len(n.strip()) > production.MAX_BY_LEN
                    or not n.isprintable()):
                raise QrError(f"qr_signers: {role} có tên không hợp lệ")
            k = norm_name(n)
            if owner.get(k, role) != role:
                raise QrError("qr_signers: 1 người không được nằm ở 2 vai "
                              f"({owner[k]} và {role})")
            owner[k] = role
            out[role].add(k)
    return out


def load_signers(path=None) -> dict[str, set[str]]:
    return validate_signers(_read(path or SIGNERS_FILE))


def _prep() -> tuple[dict, dict]:
    golden = golden_map()
    return load_config(golden=golden), golden


# ---------- lời văn trang + guardrail (thuần) ----------

def _canonical() -> str:
    cfg, why = guardrail._load_rules(guardrail.DATA_DIR)
    if cfg is None:
        raise QrError(f"guardrail: {why}")
    return cfg["canonical"]


def _lot_lines(lot: dict, product: dict) -> list[str]:
    return [product["name"], f"Lô: {lot['lot_code']}",
            f"Ngày sản xuất: {_d(lot['mfg_date'])}",
            f"Hạn sử dụng: {_d(lot['exp_date'])}"]


def _tail_lines(lot: dict, product: dict) -> list[str]:
    out = [SAMPLE_LINE] if lot.get("source") == "sample" else []
    if product.get("category") == "tpbvsk":
        out.append(_canonical() + ".")
    return out


def page_text(lot: dict, origins: list[dict], product: dict,
              config: dict) -> str:
    """Lời văn trang công khai (bản 3 vai ký) — tất định. Chỉ tên SKU, lô,
    NSX, HSD, vùng mức tỉnh, tháng thu hoạch, số ảnh. KHÔNG mã/vị trí
    khoảnh, nội dung/tác giả nhật ký, tên người ký, giá, công dụng."""
    lines = [TITLE] + _lot_lines(lot, product)
    lines.append(f"Vùng nguyên liệu: {config['region_text']}")
    months = sorted({(o["harvest"].year, o["harvest"].month)
                     for o in origins})
    if months:
        lines.append("Thu hoạch: " + ", ".join(
            f"tháng {m:02d}/{y}" for y, m in months))
    n = sum(len(o["media"]) for o in origins)
    if n:
        lines.append(f"Ảnh tư liệu vườn: {n} ảnh")
    return "\n".join(lines + _tail_lines(lot, product)) + "\n"


def stamp_text(lot: dict, product: dict) -> str:
    """Lời văn tem KHÔNG QR (phương án B): tên SKU, lô, NSX, HSD."""
    return "\n".join(_lot_lines(lot, product)
                     + _tail_lines(lot, product)) + "\n"


def text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_page(text: str, sku: str) -> list[str]:
    """[] = được công khai. Guardrail kênh `qr` (luật web) + probe PII
    (`_mask_pii` đổi text → có SĐT/email) + tọa độ thập phân."""
    r = guardrail.check_publish(text, channel=CHANNEL, content_type="post",
                                sku=sku, is_ai=False)
    codes = ([] if r["ok"] else
             sorted({v["code"] for v in r["violations"]}) or ["guardrail"])
    if _mask_pii(text) != text:
        codes.append("pii")
    if COORD_RE.search(text):
        codes.append("toa_do")
    return codes


def new_code() -> str:
    """Mã công khai: 128 bit ngẫu nhiên — không dẫn xuất từ lô/thời gian."""
    return secrets.token_urlsafe(16)


_CSS = ("body{font-family:system-ui,sans-serif;max-width:40rem;margin:0 auto;"
        "padding:1rem;line-height:1.5;color:#222;background:#fff}"
        "h1{font-size:1.3rem}h2{font-size:1.1rem}"
        "img{max-width:100%;height:auto;margin:.5rem 0}")


def _html_doc(body: list[str]) -> str:
    return ("<!doctype html>\n<html lang=\"vi\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, "
            "initial-scale=1\"><meta name=\"robots\" content=\"noindex\">"
            f"<title>{html.escape(TITLE)}</title><style>{_CSS}</style>"
            "</head><body>\n" + "\n".join(body) + "\n</body></html>\n")


def page_html(text: str, media: list[tuple[str, str]]) -> str:
    """Trang tĩnh: 0 script, 0 URL ngoài; ảnh tham chiếu tương đối."""
    lines = text.rstrip("\n").split("\n")
    body = [f"<h1>{html.escape(lines[0])}</h1>",
            f"<h2>{html.escape(lines[1])}</h2>"]
    body += [f"<p>{html.escape(x)}</p>" for x in lines[2:]]
    body += [f"<img src=\"../media/{sha}.{ext}\" alt=\"Ảnh tư liệu vườn\">"
             for sha, ext in media
             if HEX64_RE.match(sha) and ext in MEDIA_EXT]
    return _html_doc(body)


def revoked_html(day: dt.date) -> str:
    return _html_doc([f"<h1>{html.escape(TITLE)}</h1>",
                      f"<p>{REVOKED}.</p>",
                      f"<p>Ngày thu hồi: {_d(day)}</p>"])


def _has_metadata(data: bytes, ext: str) -> bool:
    """Ảnh còn khối metadata (EXIF/XMP/IPTC/comment/text)? Duyệt marker
    JPEG tới SOS / chunk PNG tới IEND — không dò `b"GPS"` (3 byte, dễ
    khớp nhầm trong dữ liệu nén ảnh vài MB). Lớp 2: marker dài
    `Exif`+2 byte NUL (6 byte) / `ns.adobe.com/xap` (16 byte) ở BẤT KỲ đâu
    (khớp nhầm ~1e-8) + byte thừa sau EOI/IEND → True — bắt khối EXIF
    nhét sau SOS/EOI mà parser header bỏ qua. Hỏng → True."""
    if b"Exif\x00\x00" in data or b"ns.adobe.com/xap" in data:
        return True
    try:
        if ext == "jpg":
            if data[:2] != b"\xff\xd8":
                return True
            i = 2
            while i + 4 <= len(data):
                if data[i] != 0xFF:
                    return True
                m = data[i + 1]
                if m in (0xD9, 0xDA):        # EOI / SOS: hết vùng header
                    return not data.endswith(b"\xff\xd9")  # đuôi thừa
                if m == 0x01 or 0xD0 <= m <= 0xD7:
                    i += 2
                    continue
                if (0xE1 <= m <= 0xEF and m != 0xE2) or m == 0xFE:
                    return True               # APP1 Exif/XMP, APP13, COM...
                i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
            return True
        if ext == "png":
            if data[:8] != b"\x89PNG\r\n\x1a\n":
                return True
            i = 8
            while i + 8 <= len(data):
                n = int.from_bytes(data[i:i + 4], "big")
                kind = data[i + 4:i + 8]
                if kind in (b"eXIf", b"tEXt", b"zTXt", b"iTXt"):
                    return True
                if kind == b"IEND":
                    return i + 12 + n != len(data)   # byte thừa sau IEND
                i += 12 + n
            return True
    except (IndexError, ValueError):
        return True
    return True


def plan_b_report(lots: list[dict], signed_roles: dict, today: dt.date,
                  config: dict, golden: dict) -> str:
    """Bản tin phương án B — tất định, CHỈ tên vai (không tên người).
    Trước mốc: đếm ngày. Từ mốc: ĐỀ XUẤT tem không QR cho lô đã passed
    (GĐ vùng trồng quyết — agent KHÔNG tự đổi tem)."""
    dl = config["plan_b_deadline"]
    past = today >= dl
    out = [f"Bản tin phương án B — tem QR thí điểm (ngày {_d(today)})",
           f"Cấu hình: {config['status']}"]
    if past:
        out.append(f"ĐỀ XUẤT phương án B (mốc {_d(dl)}) — GĐ vùng trồng "
                   "quyết, báo Sales + Hạ tầng; agent KHÔNG tự đổi tem")
    else:
        out.append(f"Mốc phương án B {_d(dl)}: còn {(dl - today).days} ngày"
                   " — chưa đề xuất")
    lots = sorted(lots, key=lambda x: x["lot_code"])
    out.append("Đã phát hành mã QR:")
    done = [x for x in lots if x["issued"]]
    out += [f"- lô {x['lot_code']} ({x['sku_key']})" for x in done] or [
        "- không có"]
    out.append("Chưa phát hành:")
    todo = [x for x in lots if not x["issued"]]
    if not todo:
        out.append("- không có")
    for x in todo:
        product = golden.get(x["sku_key"], {"name": x["sku_key"]})
        miss = []
        if x["intake_status"] != "passed":
            miss.append("kiểm nhập passed")
        if not x["n_origins"]:
            miss.append("nguồn vùng trồng đã chain")
        roles = signed_roles.get(x["lot_code"], set())
        left = [ROLES[r] for r in ROLES if r not in roles]
        if left:
            miss.append("chữ ký vai " + ", ".join(left))
        tag = " [MẪU]" if x.get("source") == "sample" else ""
        out.append(f"- lô {x['lot_code']}{tag} — {product['name']}: còn "
                   f"thiếu {'; '.join(miss) or 'không (chờ phát hành)'}")
        if not past:
            continue
        if x["intake_status"] != "passed":
            out.append("    chưa đủ điều kiện in tem")
            continue
        text = stamp_text(x, product)
        bad = check_page(text, x["sku_key"])
        out.append("    Lời văn tem KHÔNG QR (guardrail: "
                   + (f"FAIL {', '.join(bad)}" if bad else "OK") + "):")
        out += [f"      {ln}" for ln in text.rstrip("\n").split("\n")]
    return "\n".join(out) + "\n"


# ---------- DB ----------

def fetch_lot(conn, lot_code: str) -> dict | None:
    row = conn.execute(
        "select lot_code, sku_key, mfg_date, exp_date, intake_status, source"
        " from production_lots where lot_code = %s", (lot_code,)).fetchone()
    if row is None:
        return None
    return dict(zip(("lot_code", "sku_key", "mfg_date", "exp_date",
                     "intake_status", "source"), row))


def fetch_origins(conn, lot_code: str) -> list[dict]:
    rows = conn.execute(
        "select o.plot_log_id, (g.ts at time zone 'Asia/Ho_Chi_Minh')::date,"
        " o.media_sha256 from lot_origins o join plot_logs g"
        " on g.id = o.plot_log_id where o.lot_code = %s"
        " order by o.plot_log_id", (lot_code,)).fetchall()
    return [{"plot_log_id": r[0], "harvest": r[1], "media": list(r[2])}
            for r in rows]


def lot_state(conn, lot_code: str, cfg: dict, golden: dict) -> dict:
    """Lô + nguồn + lời văn + sha hiện tại. Lô không có / ngoài
    pilot_skus → QrError."""
    lot = fetch_lot(conn, lot_code)
    if lot is None:
        raise QrError(f"không có lô {lot_code}")
    if lot["sku_key"] not in cfg["pilot_skus"]:
        raise QrError(f"lô {lot_code}: SKU {lot['sku_key']} ngoài "
                      "pilot_skus — không làm QR")
    origins = fetch_origins(conn, lot_code)
    text = page_text(lot, origins, golden[lot["sku_key"]], cfg)
    snap = conn.execute("select qr_lot_snapshot_sha(%s)",
                        (lot_code,)).fetchone()[0]
    roles = {r[0] for r in conn.execute(
        "select role from qr_signatures where lot_code = %s and"
        " snapshot_sha256 = %s and text_sha256 = %s",
        (lot_code, snap, text_sha(text)))}
    active = conn.execute(
        "select code from qr_codes where lot_code = %s and revoked_at is null",
        (lot_code,)).fetchone()
    return {"lot": lot, "origins": origins, "text": text,
            "tsha": text_sha(text), "snap": snap, "roles": roles,
            "active": active[0] if active else None}


def _media_files(conn, origins: list[dict], media_dir) -> list[tuple]:
    """[(sha, ext, bytes)] — chỉ khi file kho khớp sha256 trong DB và không
    còn khối metadata. Thiếu env/file / lệch → QrError (không phát hành
    thiếu: ảnh nằm trong bản đã ký)."""
    shas = sorted({m for o in origins for m in o["media"]})
    if not shas:
        return []
    if not media_dir:
        raise QrError("thiếu env GARDEN_MEDIA_DIR (kho ảnh ngoài repo)")
    ext_of = dict(conn.execute(
        "select sha256, ext from garden_media where sha256 = any(%s)",
        (shas,)).fetchall())
    out = []
    for sha in shas:
        ext = ext_of.get(sha)
        if ext not in MEDIA_EXT:
            raise QrError(f"ảnh {sha[:12]} không có trong garden_media")
        try:
            data = (Path(media_dir) / sha[:2] / f"{sha}.{ext}").read_bytes()
        except OSError as e:
            raise QrError(f"thiếu file ảnh {sha[:12]} trong kho "
                          f"({type(e).__name__})") from e
        if hashlib.sha256(data).hexdigest() != sha:
            raise QrError(f"file ảnh {sha[:12]} lệch sha256 (bị tráo?)")
        if _has_metadata(data, ext):
            raise QrError(f"file ảnh {sha[:12]} còn metadata EXIF/XMP")
        out.append((sha, ext, data))
    return out


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ---------- CLI ----------

def _db(fn):
    def wrapped(conn):
        try:
            return fn(conn)
        except QrError as e:
            conn.rollback()
            return _err(f"{e} — không ghi.")
    return production._db_call(wrapped)


def _call(conn, sql: str, params: tuple):
    """Function DB SECURITY DEFINER; RAISE → (None, lý do), không commit."""
    return production._decide(conn, sql, params)


def _prep_or_err():
    try:
        return _prep(), None
    except QrError as e:
        return None, _err(f"{e} — không connect.")


def cmd_link(args, unlink: bool = False) -> int:
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep

    def run(conn):
        lot_state(conn, args.lot, cfg, golden)       # lô có + thuộc pilot
        if unlink:
            row, why = _call(conn, "select unlink_lot_origin(%s, %s, %s)",
                             (args.lot, args.log, args.by))
        else:
            row, why = _call(conn,
                             "select link_lot_origin(%s, %s, %s, %s)",
                             (args.lot, args.log, list(args.media or []),
                              args.by))
        if row is None:
            conn.rollback()
            return _err(f"{why} — không ghi.")
        conn.commit()
        verb = "gỡ ánh xạ" if unlink else "ánh xạ"
        print(f"[done] lô {args.lot}: {verb} nhật ký #{args.log}"
              + ("" if unlink else f" ({len(args.media or [])} ảnh)")
              + f" — người thực hiện: {args.by}. Chữ ký cũ (nếu có) không "
              "còn tính — ký lại trên bản mới.")
        return 0
    return _db(run)


def cmd_preview(args) -> int:
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep

    def run(conn):
        st = lot_state(conn, args.lot, cfg, golden)
        lot = st["lot"]
        bad = check_page(st["text"], lot["sku_key"])
        tag = " [MẪU]" if lot["source"] == "sample" else ""
        print(f"Lô {lot['lot_code']}{tag} — kiểm nhập: {lot['intake_status']}"
              f" — nguồn đã chain: {len(st['origins'])} nhật ký thu hoạch")
        print("--- lời văn trang (3 vai ký trên đúng bản này) ---")
        print(st["text"], end="")
        print("---")
        print(f"text_sha256: {st['tsha']}")
        print(f"snapshot_sha256: {st['snap']}")
        print("guardrail kênh qr: " + (f"FAIL {', '.join(bad)}" if bad
                                       else "OK"))
        done = [ROLES[r] for r in ROLES if r in st["roles"]]
        left = [ROLES[r] for r in ROLES if r not in st["roles"]]
        print("Đã ký (bản hiện tại): " + (", ".join(done) or "chưa vai nào"))
        print("Còn thiếu: " + (", ".join(left) or "không"))
        print("Mã còn hiệu lực: " + (f"có ({st['active']}/)" if st["active"]
                                     else "chưa"))
        conn.rollback()
        return 0
    return _db(run)


def cmd_sign(args) -> int:
    try:
        signers = load_signers()
    except QrError as e:
        return _err(f"{e} — không connect.")
    label = ROLES[args.role]
    if not signers[args.role]:
        return _err(f"chưa cấu hình người ký vai {label} (external-dep SSO) "
                    "— không connect.")
    if norm_name(args.by) not in signers[args.role]:
        return _err(f"--by không thuộc danh sách người ký vai {label} "
                    "(data/qr_signers.json) — không connect.")
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep

    def run(conn):
        st = lot_state(conn, args.lot, cfg, golden)
        if production.qr_payload(st["lot"]) is None:
            raise QrError(f"lô {args.lot} chưa kiểm nhập passed")
        bad = check_page(st["text"], st["lot"]["sku_key"])
        if bad:
            raise QrError(f"lời văn trang không qua guardrail kênh qr "
                          f"({', '.join(bad)})")
        row, why = _call(conn, "select sign_qr_lot(%s, %s, %s, %s, %s)",
                         (args.lot, args.role, args.by, st["tsha"],
                          args.note))
        if row is None:
            conn.rollback()
            return _err(f"{why} — không ghi.")
        conn.commit()
        print(f"[done] lô {args.lot}: vai {label} đã ký (approvals #{row[0]})"
              f" — người ký: {args.by}")
        return 0
    return _db(run)


def cmd_issue(args) -> int:
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep

    def run(conn):
        st = lot_state(conn, args.lot, cfg, golden)
        if production.qr_payload(st["lot"]) is None:
            raise QrError(f"lô {args.lot} chưa kiểm nhập passed")
        bad = check_page(st["text"], st["lot"]["sku_key"])
        if bad:
            raise QrError(f"lời văn trang không qua guardrail kênh qr "
                          f"({', '.join(bad)})")
        code = new_code()
        row, why = _call(conn, "select issue_qr(%s, %s, %s, %s)",
                         (args.lot, code, st["tsha"], args.by))
        if row is None:
            conn.rollback()
            return _err(f"{why} — không phát hành.")
        conn.commit()
        print(f"[done] lô {args.lot}: đã phát hành mã — người phát hành: "
              f"{args.by}")
        if cfg["public_base_url"]:
            print(f"URL: {cfg['public_base_url']}/{code}/")
        else:
            print(f"chưa có domain công khai (external-dep) — đường dẫn "
                  f"{code}/")
        print("ảnh QR: nhà in tạo từ URL (lib QR không có — external-dep). "
              "Chạy `site` để sinh trang.")
        return 0
    return _db(run)


def cmd_revoke(args) -> int:
    def run(conn):
        row, why = _call(conn, "select revoke_qr(%s, %s, %s)",
                         (args.code, args.by, args.reason))
        if row is None:
            conn.rollback()
            return _err(f"{why} — không ghi.")
        conn.commit()
        print(f"[done] đã thu hồi mã {args.code} — người thu hồi: {args.by}."
              " Chạy `site` để cập nhật trang 'đã thu hồi'.")
        return 0
    return _db(run)


def cmd_site(args) -> int:
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep
    out = Path(args.out) if args.out else SITE_DIR
    media_dir = os.environ.get("GARDEN_MEDIA_DIR")

    def run(conn):
        rows = conn.execute(
            "select code, lot_code, snapshot_sha256, text_sha256, revoked_at"
            " from qr_codes order by issued_at, code").fetchall()
        n_err, pages, keep = 0, [], set()
        for code, lot_code, snap, tsha, revoked in rows:
            if not CODE_RE.match(code):
                n_err += 1
                print("[err] mã sai định dạng trong DB — bỏ qua")
                continue
            if revoked is not None:
                pages.append((code, revoked_html(
                    revoked.astimezone(TZ_VN).date()), []))
                continue
            try:
                st = lot_state(conn, lot_code, cfg, golden)
                if st["tsha"] != tsha or st["snap"] != snap:
                    raise QrError("nội dung đổi sau khi ký — cần thu hồi + "
                                  "ký lại")
                bad = check_page(st["text"], st["lot"]["sku_key"])
                if bad:
                    raise QrError(f"guardrail kênh qr FAIL ({', '.join(bad)})")
                media = _media_files(conn, st["origins"], media_dir)
            except QrError as e:
                n_err += 1
                print(f"[err] mã {code[:6]}…: {e} — không ghi trang này")
                continue
            pages.append((code, page_html(st["text"],
                                          [(s, x) for s, x, _ in media]),
                          media))
        conn.rollback()
        for code, body, media in pages:
            for sha, ext, data in media:
                _write_atomic(out / "media" / f"{sha}.{ext}", data)
                keep.add(f"{sha}.{ext}")
            _write_atomic(out / code / "index.html", body.encode("utf-8"))
        mdir = out / "media"
        if n_err == 0 and mdir.is_dir():    # gỡ ảnh không còn trang dùng
            for f in mdir.iterdir():
                stem, _, ext = f.name.partition(".")
                if (f.is_file() and HEX64_RE.match(stem)
                        and ext in MEDIA_EXT and f.name not in keep):
                    f.unlink()
        print(f"[done] {len(pages)} trang → {out} ({n_err} lỗi)")
        return 1 if n_err else 0
    return _db(run)


def cmd_planb(args) -> int:
    prep, rc = _prep_or_err()
    if prep is None:
        return rc
    cfg, golden = prep
    day = args.date or production._today_vn()

    def run(conn):
        codes = [r[0] for r in conn.execute(
            "select lot_code from production_lots where sku_key = any(%s)"
            " order by lot_code", (cfg["pilot_skus"],))]
        lots, signed = [], {}
        for c in codes:
            st = lot_state(conn, c, cfg, golden)
            lots.append(dict(st["lot"], n_origins=len(st["origins"]),
                             issued=st["active"] is not None))
            signed[c] = st["roles"]
        conn.rollback()
        print(plan_b_report(lots, signed, day, cfg, golden), end="")
        return 0
    return _db(run)


def _log_arg(s: str) -> int:
    try:
        v = int(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("id nhật ký là số nguyên") from e
    if not 0 < v < 2**63:
        raise argparse.ArgumentTypeError("id nhật ký > 0")
    return v


def _sha_arg(s: str) -> str:
    if not HEX64_RE.match(s):
        raise argparse.ArgumentTypeError("sha256 ảnh = 64 ký tự hex thường")
    return s


def _code_arg(s: str) -> str:
    if not CODE_RE.match(s):
        raise argparse.ArgumentTypeError("mã QR: 22..64 ký tự A-Za-z0-9_-")
    return s


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.qr_trace",
        description="Lô + QR truy xuất (thí điểm mật ong): ánh xạ nguồn, "
                    "3 chữ ký, phát hành/thu hồi mã, trang tĩnh, phương án "
                    "B — không sinh ảnh QR, không gửi, không in.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    by = {"required": True, "type": production._by_arg}
    for name, h in (("link", "GĐ SX ánh xạ lô ↔ nhật ký thu hoạch đã chain"),
                    ("unlink", "gỡ 1 ánh xạ (lô chưa có mã còn hiệu lực)")):
        p = sub.add_parser(name, help=h)
        p.add_argument("--lot", required=True, type=production._lot_arg)
        p.add_argument("--log", required=True, type=_log_arg,
                       help="id nhật ký plot_logs")
        if name == "link":
            p.add_argument("--media", nargs="+", type=_sha_arg,
                           metavar="SHA", help="≤3 ảnh garden_media")
        p.add_argument("--by", help="tên người thực hiện", **by)
    p = sub.add_parser("preview", help="xem lời văn + guardrail + vai đã ký")
    p.add_argument("--lot", required=True, type=production._lot_arg)
    p = sub.add_parser("sign", help="1 vai ký lô (3 người khác nhau)")
    p.add_argument("--lot", required=True, type=production._lot_arg)
    p.add_argument("--role", required=True, choices=tuple(ROLES))
    p.add_argument("--by", help="tên người ký (allowlist qr_signers)", **by)
    p.add_argument("--note", type=production._note_arg)
    p = sub.add_parser("issue", help="phát hành mã QR (đủ 3 chữ ký)")
    p.add_argument("--lot", required=True, type=production._lot_arg)
    p.add_argument("--by", help="tên người phát hành", **by)
    p = sub.add_parser("revoke", help="thu hồi mã → trang 'đã thu hồi'")
    p.add_argument("--code", required=True, type=_code_arg)
    p.add_argument("--by", help="tên người thu hồi", **by)
    p.add_argument("--reason", type=production._note_arg)
    p = sub.add_parser("site", help="sinh trang tĩnh cho mọi mã")
    p.add_argument("--out", type=Path, help="mặc định data/qr_site/")
    p = sub.add_parser("planb", help="bản tin phương án B theo mốc")
    p.add_argument("--date", type=production._date_arg)
    args = ap.parse_args(argv)

    if args.cmd in ("link", "unlink"):
        return cmd_link(args, unlink=args.cmd == "unlink")
    return {"preview": cmd_preview, "sign": cmd_sign, "issue": cmd_issue,
            "revoke": cmd_revoke, "site": cmd_site,
            "planb": cmd_planb}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
