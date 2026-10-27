"""v13.8 C09 — neo mã xác thực chuỗi truy xuất (PL01 mục 4b, tính năng
`farming-06`): gom → gốc Merkle → `anchor_batches` → provider cắm được.

Contract:
  - Lá (`collect`, tất định, sắp theo khóa) — CHỈ bản ghi đã bất biến trong
    DB, KHÔNG PII/tọa độ:
      plot_logs_head:<id>  đầu chuỗi `plot_logs` (id, row_hash) tại `as_of`
                           — row_hash nối cả chuỗi phía trước (v9.3)
      qr_sig:<id>          chữ ký hồ sơ lô (`qr_signatures`: lô, vai, sha bản
                           chụp lô + lời văn, thời điểm) — KHÔNG tên người ký
      qr_issue:<mã>        phát hành mã QR (lô, sha, thời điểm)
      qr_revoke:<mã>       thu hồi mã (thời điểm) — lịch sử thu hồi
    Lô `source='sample'` bị bỏ (không neo dữ liệu mẫu). Bản chụp lô
    (`qr_lot_snapshot_sha`) đã gồm lô SX + nguồn gốc nhật ký thu hoạch.
  - Hash lá = sha256(0x00 ‖ JSON chuẩn); nút = sha256(0x01 ‖ trái ‖ phải),
    lẻ thì đẩy nút cuối lên. Bản kê (manifest) = JSON chuẩn {v, as_of_us,
    leaves[{k,d,h}], merkle_root}; digest gửi ra ngoài = sha256(bản kê) —
    32 byte DUY NHẤT rời hệ thống.
  - `build`: chuỗi `plot_logs` có vấn đề (`verify_plot_logs` không rỗng) →
    từ chối (không neo chuỗi hỏng); 0 lá → từ chối; gốc trùng lần gom mới
    nhất → không tạo dòng mới. Rollout: tính năng `tat` → không gom.
  - `submit`: provider `none` → `AnchorBlocked` (exit 2, KHÔNG ghi gì — "chưa
    neo"; chọn chuỗi/phí là quyết định hai bên). `opentimestamps` → kiểm lại
    bản kê dựng từ DB khớp `manifest_sha256`, rollout biên DÙNG (chạy thử/tắt
    chặn; có người duyệt chỉ khi `--by` là người), POST digest tới calendar
    đầu tiên nhận → biên nhận .ots (`OTS_MAGIC` ‖ v1 ‖ sha256 ‖ digest ‖ phản
    hồi) vào `anchor_receipts` `da_gui`; mọi calendar lỗi → 1 dòng `loi`
    (lớp lỗi), exit 1, chạy lại = thử lại. Đã `da_gui` → no-op. HTTP qua
    `post` truyền vào (test KHÔNG mở mạng): chỉ https, không redirect, trần
    byte, timeout.
  - `verify` (đối chiếu NỘI BỘ — không phải bằng chứng bên thứ ba): gốc
    tính lại từ lá đã lưu, sha bản kê, lá tính lại từ DB tại `as_of` khớp
    y hệt (thiếu/lệch/thừa đều báo), chuỗi `plot_logs` nguyên vẹn, biên nhận
    mang đúng digest. Bên thứ ba: `--export` → `anchor-<id>.json` +
    `.json.ots`, chạy `ots upgrade` rồi `ots verify anchor-<id>.json.ots`.

Chạy:
  python -m pipelines.anchor --build [--dry-run]
  python -m pipelines.anchor --submit ID|latest [--by NAME]
  python -m pipelines.anchor --verify ID|latest
  python -m pipelines.anchor --export ID|latest --out DIR
  python -m pipelines.anchor --status
Exit: 0 ok · 1 từ chối (chuỗi hỏng / 0 lá / lệch / gửi lỗi) · 2 tham số sai
/ cấu hình lỗi / DB down / provider `none` (external-dep: chưa neo).
"""

import argparse
import hashlib
import http.client
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "anchor_config.json"
PROVIDERS = ("none", "opentimestamps")
FEATURE = "farming-06"
CREATED_BY = "agent:anchor"
OTS_MAGIC = (b"\x00OpenTimestamps\x00\x00Proof\x00"
             b"\xbf\x89\xe2\xe8\x84\xe8\x92\x94")
OTS_HEAD = OTS_MAGIC + b"\x01\x08"      # phiên bản 1 + phép băm SHA256
MAX_RESP = 8192
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
LAG = timedelta(minutes=5)


class AnchorError(ValueError):
    """Từ chối nghiệp vụ / cấu hình — fail-closed."""


class AnchorBlocked(AnchorError):
    """Provider chưa chọn (`none`) — chưa neo, external-dep."""


# ------------------------------------------------------------ cấu hình


def load_config(path: Path | None = None) -> dict:
    p = Path(path or CONFIG_FILE)
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise AnchorError(f"{p.name}: không đọc được ({type(e).__name__})") \
            from None
    prov = cfg.get("provider") if isinstance(cfg, dict) else None
    if prov not in PROVIDERS:
        raise AnchorError(f"{p.name}: provider phải thuộc {PROVIDERS}")
    out = {"provider": prov, "calendars": [], "timeout_s": 15}
    if prov == "opentimestamps":
        ots = cfg.get("opentimestamps")
        cals = ots.get("calendars") if isinstance(ots, dict) else None
        t = ots.get("timeout_s", 15) if isinstance(ots, dict) else None
        if (not isinstance(cals, list) or not cals or not all(
                isinstance(c, str) and c.startswith("https://")
                and not any(x in c for x in "?#@ ") for c in cals)):
            raise AnchorError(f"{p.name}: opentimestamps.calendars cần list "
                              "URL https:// không query/userinfo")
        if isinstance(t, bool) or not isinstance(t, int) or not 1 <= t <= 60:
            raise AnchorError(f"{p.name}: opentimestamps.timeout_s 1..60")
        out.update(calendars=[c.rstrip("/") for c in cals], timeout_s=t)
    return out


# ------------------------------------------------------------ thuần


def canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("ascii")


def leaf_hash(data: dict) -> str:
    return hashlib.sha256(b"\x00" + canon(data)).hexdigest()


def merkle_root(hashes: list[str]) -> str:
    level = [bytes.fromhex(h) for h in hashes]
    if not level:
        raise AnchorError("không có lá nào để tính gốc Merkle")
    while len(level) > 1:
        nxt = [hashlib.sha256(b"\x01" + level[i] + level[i + 1]).digest()
               for i in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])
        level = nxt
    return level[0].hex()


def _us(ts: datetime) -> int:
    return (ts - EPOCH) // timedelta(microseconds=1)


def manifest(as_of_us: int, leaves: list[dict], root: str) -> bytes:
    return canon({"v": 1, "as_of_us": as_of_us, "leaves": leaves,
                  "merkle_root": root})


def ots_file(digest: bytes, resp: bytes) -> bytes:
    """Tệp .ots (DetachedTimestampFile) cho digest SHA256 = header + phản
    hồi calendar (timestamp đã tuần tự hóa cho đúng digest)."""
    return OTS_HEAD + digest + resp


# ------------------------------------------------------------ DB


_PLOT_HEAD_SQL = ("select id, row_hash from plot_logs where row_hash is not"
                  " null and created_at <= %s order by id desc limit 1")
_SIG_SQL = ("select s.id, s.lot_code, s.role, s.snapshot_sha256,"
            " s.text_sha256, s.signed_at from qr_signatures s join"
            " production_lots l on l.lot_code = s.lot_code where"
            " l.source <> 'sample' and s.signed_at <= %s order by s.id")
_QR_SQL = ("select q.code, q.lot_code, q.snapshot_sha256, q.text_sha256,"
           " q.issued_at, q.revoked_at from qr_codes q join production_lots"
           " l on l.lot_code = q.lot_code where l.source <> 'sample' and"
           " q.issued_at <= %s order by q.code")


def chain_problems(conn) -> list:
    return conn.execute("select id, problem from verify_plot_logs()"
                        " order by id, problem").fetchall()


def collect(conn, as_of: datetime) -> list[dict]:
    """Lá tại `as_of` → [{k, d, h}] sắp theo k."""
    items = []
    head = conn.execute(_PLOT_HEAD_SQL, (as_of,)).fetchone()
    if head:
        items.append((f"plot_logs_head:{head[0]}",
                      {"t": "plot_logs_head", "id": head[0],
                       "row_hash": head[1]}))
    for sid, lot, role, snap, text, at in conn.execute(
            _SIG_SQL, (as_of,)).fetchall():
        items.append((f"qr_sig:{sid}", {
            "t": "qr_sig", "id": sid, "lot": lot, "role": role,
            "snap": snap, "text": text, "at_us": _us(at)}))
    for code, lot, snap, text, at, rev in conn.execute(
            _QR_SQL, (as_of,)).fetchall():
        items.append((f"qr_issue:{code}", {
            "t": "qr_issue", "code": code, "lot": lot, "snap": snap,
            "text": text, "at_us": _us(at)}))
        if rev is not None and rev <= as_of:
            items.append((f"qr_revoke:{code}", {
                "t": "qr_revoke", "code": code, "at_us": _us(rev)}))
    items.sort(key=lambda x: x[0])
    return [{"k": k, "d": d, "h": leaf_hash(d)} for k, d in items]


def _rollout():
    from pipelines import rollout  # lười: rollout → director → ...
    return rollout


def build(conn, now: datetime, dry_run: bool = False) -> dict:
    """Gom 1 lần → {"id", "root", "n", "new"}."""
    _rollout().check_generate(conn, FEATURE, "gom neo blockchain")
    bad = chain_problems(conn)
    if bad:
        raise AnchorError(f"chuỗi plot_logs có {len(bad)} vấn đề (dòng đầu "
                          f"#{bad[0][0]} {bad[0][1]}) — không neo chuỗi hỏng")
    leaves = collect(conn, now)
    if not leaves:
        raise AnchorError("chưa có nhật ký đã chain / hồ sơ lô nào để neo")
    root = merkle_root([x["h"] for x in leaves])
    last = conn.execute("select id, merkle_root from anchor_batches"
                        " order by id desc limit 1").fetchone()
    if last and last[1] == root:
        conn.commit()
        return {"id": last[0], "root": root, "n": len(leaves), "new": False}
    if dry_run:
        conn.commit()
        return {"id": None, "root": root, "n": len(leaves), "new": True}
    sha = hashlib.sha256(manifest(_us(now), leaves, root)).hexdigest()
    with conn.transaction():
        bid = conn.execute(
            "insert into anchor_batches (as_of, leaves, merkle_root,"
            " manifest_sha256, created_by) values (%s, %s, %s, %s, %s)"
            " returning id", (now, Jsonb(leaves), root, sha, CREATED_BY)
        ).fetchone()[0]
    conn.commit()
    return {"id": bid, "root": root, "n": len(leaves), "new": True}


def _batch(conn, ref) -> tuple:
    if ref == "latest":
        row = conn.execute("select id, as_of, leaves, merkle_root,"
                           " manifest_sha256 from anchor_batches order by id"
                           " desc limit 1").fetchone()
    else:
        try:
            bid = int(ref)
        except (TypeError, ValueError):
            raise AnchorError(f"mã lần gom '{_oneline(ref, 30)}' sai") \
                from None
        row = conn.execute("select id, as_of, leaves, merkle_root,"
                           " manifest_sha256 from anchor_batches where id ="
                           " %s", (bid,)).fetchone()
    if row is None:
        raise AnchorError(f"không có lần gom '{_oneline(ref, 30)}'")
    return row


def _manifest_of(row) -> bytes:
    return manifest(_us(row[1]), row[2], row[3])


# ------------------------------------------------------- định dạng .ots (r13)
# Định dạng OpenTimestamps (python-opentimestamps / opentimestamps.org): sau
# OTS_HEAD + digest là CÂY timestamp: mỗi nút = dãy mục, mục không phải cuối
# có tiền tố 0xff; mục = attestation (0x00 ‖ tag 8 byte ‖ varbytes payload)
# hoặc phép (tag 1 byte [‖ varbytes đối số] ‖ nút con). varuint = LEB128.
# Pending: payload = varbytes(URI calendar); Bitcoin: payload = varuint(chiều
# cao khối). KHÔNG kiểm khối Bitcoin ở đây (cần node/header thật — bên thứ ba).
ATT_PENDING = bytes.fromhex("83dfe30d2ef90c8e")
ATT_BITCOIN = bytes.fromhex("0588960d73d71901")
_OP_BIN = {0xf0: "append", 0xf1: "prepend"}
_OP_HASH = {0x08: "sha256", 0x02: "sha1"}
_MAX_OPS = 512


class OtsError(ValueError):
    """Biên nhận .ots sai định dạng / không khớp digest."""


def _varuint(buf: bytes, i: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        if i >= len(buf) or shift > 63:
            raise OtsError("varuint cụt/quá dài")
        b = buf[i]
        i += 1
        v |= (b & 0x7f) << shift
        if not b & 0x80:
            return v, i
        shift += 7


def _put_varuint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7f
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def _varbytes(buf: bytes, i: int, cap: int = 4096) -> tuple[bytes, int]:
    n, i = _varuint(buf, i)
    if n > cap or i + n > len(buf):
        raise OtsError("varbytes cụt/quá cỡ")
    return buf[i:i + n], i + n


def _apply(op: int, arg: bytes | None, msg: bytes) -> bytes:
    if op == 0xf0:
        return msg + arg
    if op == 0xf1:
        return arg + msg
    return hashlib.new(_OP_HASH[op], msg).digest()


def parse_tree(buf: bytes, i: int, msg: bytes, budget: list) -> tuple[dict, int]:
    """Nút timestamp tại `msg` → ({"msg", "atts": [(tag, payload)],
    "ops": [(op, arg, nút)]}, chỉ số kế). Phép lạ/cụt/quá nhiều → OtsError."""
    node = {"msg": msg, "atts": [], "ops": []}
    while True:
        if i >= len(buf):
            raise OtsError("cây timestamp cụt")
        more = buf[i] == 0xff
        i += more
        if i >= len(buf):
            raise OtsError("cây timestamp cụt")
        tag = buf[i]
        i += 1
        budget[0] -= 1
        if budget[0] < 0:
            raise OtsError("quá nhiều phép")
        if tag == 0x00:
            if i + 8 > len(buf):
                raise OtsError("attestation cụt")
            atag = buf[i:i + 8]
            payload, i = _varbytes(buf, i + 8)
            node["atts"].append((atag, payload))
        elif tag in _OP_BIN or tag in _OP_HASH:
            arg = None
            if tag in _OP_BIN:
                arg, i = _varbytes(buf, i)
            child, i = parse_tree(buf, i, _apply(tag, arg, msg), budget)
            node["ops"].append((tag, arg, child))
        else:
            raise OtsError(f"phép 0x{tag:02x} không hỗ trợ")
        if not more:
            return node, i


def write_tree(node: dict) -> bytes:
    items = ([b"\x00" + t + _put_varuint(len(p)) + p for t, p in node["atts"]]
             + [bytes([op]) + (_put_varuint(len(a)) + a if a is not None
                               else b"") + write_tree(c)
                for op, a, c in node["ops"]])
    if not items:
        raise OtsError("nút rỗng")
    return b"".join(b"\xff" + x for x in items[:-1]) + items[-1]


def attestations(node: dict) -> list[tuple[str, bytes, bytes]]:
    """[(pending|bitcoin|khac, commitment, payload)] trong cả cây."""
    kind = {ATT_PENDING: "pending", ATT_BITCOIN: "bitcoin"}
    out = [(kind.get(t, "khac"), node["msg"], p) for t, p in node["atts"]]
    for _op, _a, c in node["ops"]:
        out += attestations(c)
    return out


def parse_receipt(receipt: bytes, digest_hex: str) -> dict:
    """Biên nhận .ots đã lưu → cây (gốc tại digest). Sai đầu tệp / digest
    khác bản kê / byte thừa / không có attestation → OtsError."""
    head = OTS_HEAD + bytes.fromhex(digest_hex)
    if not receipt.startswith(head):
        raise OtsError("đầu biên nhận không mang đúng digest bản kê")
    tree, i = parse_tree(receipt, len(head), bytes.fromhex(digest_hex),
                         [_MAX_OPS])
    if i != len(receipt):
        raise OtsError("byte thừa sau cây timestamp")
    if not attestations(tree):
        raise OtsError("biên nhận không có attestation nào")
    return tree


def _graft(node: dict, commitment: bytes, sub: dict) -> bool:
    """Gắn cây con `sub` (gốc tại `commitment`) vào nút pending tương ứng; bỏ
    attestation pending ở nút đó. True = đã gắn."""
    if node["msg"] == commitment and any(t == ATT_PENDING for t, _ in node["atts"]):
        node["atts"] = [a for a in node["atts"] if a[0] != ATT_PENDING] + sub["atts"]
        node["ops"] += sub["ops"]
        return True
    return any(_graft(c, commitment, sub) for _o, _a, c in node["ops"])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        raise urllib.error.URLError("redirect bị chặn")


def http_post(url: str, body: bytes, timeout: int) -> bytes:
    if not url.startswith("https://"):
        raise ValueError("chỉ https")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Accept": "application/vnd.opentimestamps.v1",
        "User-Agent": "samsam-anchor/1"})
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(req, timeout=timeout) as r:
        if r.status != 200:
            raise ValueError(f"HTTP {r.status}")
        data = r.read(MAX_RESP + 1)
    if not data or len(data) > MAX_RESP:
        raise ValueError("phản hồi rỗng/quá cỡ")
    return data


def submit(conn, ref, cfg: dict, by: str = CREATED_BY,
           post=http_post) -> dict:
    """Gửi digest lần gom ra provider → {"id", "status", "calendar"}."""
    if cfg["provider"] == "none":
        raise AnchorBlocked("provider 'none' — CHƯA NEO (chọn chuỗi/provider/"
                            "phí là quyết định hai bên, PL01 mục 4b)")
    row = _batch(conn, ref)
    bid = row[0]
    body = _manifest_of(row)
    digest = hashlib.sha256(body).digest()
    if digest.hex() != row[4]:
        raise AnchorError(f"lần gom #{bid}: bản kê dựng lại LỆCH sha đã lưu"
                          " — không gửi")
    ro = _rollout()
    human = ro.is_human(by)
    why = ro.use_reason(conn, FEATURE, f"neo lần gom #{bid}", human)
    if why:
        raise AnchorError(why)
    done = conn.execute("select calendar from anchor_receipts where"
                        " batch_id = %s and status = 'da_gui' order by id"
                        " limit 1", (bid,)).fetchone()
    conn.commit()
    if done:
        return {"id": bid, "status": "da_gui", "calendar": done[0],
                "new": False}
    if human:
        # v15 fix P10.2: danh tính theo LOGIN (human_logins + khối farming)
        # kiểm ở DB TRƯỚC khi gửi digest ra ngoài — login chưa ánh xạ / khối
        # sai không làm phát sinh lần gửi nào (`auth.HumanDenied`).
        _human_call(conn, "select human_actor(%s, %s)",
                    (by, FEATURE.split("-")[0]), by, bid)
    errs = []
    for cal in cfg["calendars"]:
        try:
            resp = post(cal + "/digest", digest, cfg["timeout_s"])
            parse_receipt(ots_file(digest, resp), digest.hex())   # r13: kiểm cây
        except (OSError, ValueError, urllib.error.URLError,
                http.client.HTTPException) as e:   # r17: BadStatusLine...
            errs.append(f"{cal.removeprefix('https://')}: {type(e).__name__}")
            continue
        _receipt(conn, bid, "da_gui", cal, ots_file(digest, resp), None, by,
                 human)
        return {"id": bid, "status": "da_gui", "calendar": cal, "new": True}
    _receipt(conn, bid, "loi", None, None, "; ".join(errs)[:300], by, human)
    return {"id": bid, "status": "loi", "calendar": None, "new": True,
            "errors": errs}


def _human_call(conn, sql, args, by, bid):
    from pipelines import auth  # lười: auth → director → ...
    try:
        with conn.transaction():
            res = auth.call_human(conn, sql, args, by=by,
                                  block=FEATURE.split("-")[0],
                                  action="approve",
                                  object_type="anchor_batch",
                                  object_id=bid).fetchone()[0]
    except BaseException:
        conn.rollback()
        raise
    conn.commit()
    return res


def _receipt(conn, bid, status, cal, receipt, error, by, human) -> None:
    """1 dòng `anchor_receipts`. Người (`--by <người>`) → function
    `anchor_receipt_human` (SECURITY DEFINER — login `app_human` không có
    INSERT bảng; DB kiểm danh tính + khối farming + giai đoạn cho dùng +
    biên nhận mang đúng digest bản kê; đã `da_gui` → no-op). Job
    (`agent:anchor`, DSN owner/dịch vụ) ghi thẳng như cũ."""
    if human:
        _human_call(conn, "select anchor_receipt_human(%s, %s, %s, %s, %s,"
                    " %s)", (bid, status, cal, receipt, error, by), by, bid)
        return
    with conn.transaction():
        if status == "da_gui":
            conn.execute(
                "insert into anchor_receipts (batch_id, provider, status,"
                " calendar, receipt, created_by) values (%s,"
                " 'opentimestamps', 'da_gui', %s, %s, %s)",
                (bid, cal, receipt, by))
        else:
            conn.execute(
                "insert into anchor_receipts (batch_id, provider, status,"
                " error, created_by) values (%s, 'opentimestamps', 'loi', %s,"
                " %s)", (bid, error, by))
    conn.commit()


def verify(conn, ref) -> tuple[int, list[str]]:
    """Đối chiếu nội bộ → (id, [vấn đề]); rỗng = khớp."""
    row = _batch(conn, ref)
    bid, as_of, leaves, root, sha = row
    out = []
    if merkle_root([x["h"] for x in leaves]) != root:
        out.append("gốc Merkle tính lại từ lá đã lưu KHÁC gốc đã lưu")
    if any(leaf_hash(x["d"]) != x["h"] for x in leaves):
        out.append("lá đã lưu có hash không khớp dữ liệu lá")
    body = _manifest_of(row)
    if hashlib.sha256(body).hexdigest() != sha:
        out.append("sha256 bản kê KHÁC manifest_sha256 đã lưu")
    now = {x["k"]: x["h"] for x in collect(conn, as_of)}
    old = {x["k"]: x["h"] for x in leaves}
    for k in sorted(old.keys() - now.keys()):
        out.append(f"lá {k}: không còn trong DB")
    for k in sorted(old.keys() & now.keys()):
        if old[k] != now[k]:
            out.append(f"lá {k}: dữ liệu DB đã đổi sau khi gom")
    for k in sorted(now.keys() - old.keys()):
        out.append(f"lá {k}: bản ghi có thời điểm trước mốc gom nhưng không"
                   " có trong lần gom (chèn lùi giờ?)")
    bad = chain_problems(conn)
    if bad:
        out.append(f"chuỗi plot_logs có {len(bad)} vấn đề")
    for rid, rec in conn.execute(
            "select id, receipt from anchor_receipts where batch_id = %s and"
            " status in ('da_gui', 'da_nang_cap') order by id",
            (bid,)).fetchall():
        try:   # r13: phân tích cả cây .ots, không chỉ so tiền tố
            parse_receipt(bytes(rec), sha)
        except OtsError as e:
            out.append(f"biên nhận #{rid} hỏng: {e}")
    conn.commit()
    return bid, out


def http_get(url: str, timeout: int) -> bytes | None:
    """GET https, không redirect, trần byte → body | None (404 = chưa có)."""
    if not url.startswith("https://"):
        raise ValueError("chỉ https")
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/vnd.opentimestamps.v1",
        "User-Agent": "samsam-anchor/1"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as r:
            data = r.read(MAX_RESP + 1)
    except urllib.error.HTTPError as e:
        e.close()
        if e.code == 404:
            return None
        raise ValueError(f"HTTP {e.code}") from None
    if not data or len(data) > MAX_RESP:
        raise ValueError("phản hồi rỗng/quá cỡ")
    return data


def upgrade(conn, ref, cfg: dict, get=http_get, *, by: str = CREATED_BY) -> dict:
    """r13: hỏi calendar attestation hoàn tất cho biên nhận mới nhất của lần
    gom (GET <calendar>/timestamp/<commitment hex>, chỉ calendar có trong cấu
    hình). Có attestation Bitcoin → dòng `da_nang_cap` mang .ots đã ghép
    (append-only). Vẫn KHÔNG phải xác minh bên thứ ba (chưa đối chiếu header
    khối Bitcoin) → {"id", "status": "da_nang_cap"|"cho"|"chua_gui", ...}."""
    row = _batch(conn, ref)
    bid, sha = row[0], row[4]
    # r13-fix4 F4: hỏi calendar = DÙNG ra ngoài như submit → cùng cổng triển khai
    # (HĐ 6.7) TRƯỚC mọi HTTP/INSERT; giai đoạn không xác định → chạy thử (chặn).
    # r14 C2: `co_nguoi_duyet` chỉ NGƯỜI (job agent vẫn chặn); danh tính + khối
    # farming kiểm ở DB (human_actor) TRƯỚC HTTP — `--by` chỉ là nhãn yêu cầu.
    ro = _rollout()
    human = ro.is_human(by)
    why = ro.use_reason(conn, FEATURE, f"nâng cấp biên nhận lần gom #{bid}",
                        human)
    if why:
        raise AnchorError(why)
    if human:
        _human_call(conn, "select human_actor(%s, %s)",
                    (by, FEATURE.split("-")[0]), by, bid)
    rec = conn.execute(
        "select status, calendar, receipt from anchor_receipts where batch_id"
        " = %s and status in ('da_gui', 'da_nang_cap') order by id desc"
        " limit 1", (bid,)).fetchone()
    conn.commit()
    if rec is None:
        return {"id": bid, "status": "chua_gui"}
    status, cal, receipt = rec[0], rec[1], bytes(rec[2])
    tree = parse_receipt(receipt, sha)
    if status == "da_nang_cap" or any(k == "bitcoin" for k, _c, _p in
                                      attestations(tree)):
        return {"id": bid, "status": "da_nang_cap", "new": False,
                "so_dong_nang_cap": _n_upgraded(conn, bid)}
    allowed = set(cfg["calendars"])
    got, errs = 0, []
    for kind, commitment, payload in attestations(tree):
        if kind != "pending":
            continue
        uri = _varbytes(payload, 0, 1000)[0].decode("utf-8", "replace")
        if uri not in allowed:
            if kind == "pending":
                errs.append("calendar ngoài cấu hình — không hỏi")
            continue
        try:
            body = get(f"{uri}/timestamp/{commitment.hex()}", cfg["timeout_s"])
        except (OSError, ValueError, urllib.error.URLError,
                http.client.HTTPException) as e:   # r17: BadStatusLine...
            errs.append(f"{uri.removeprefix('https://')}: {type(e).__name__}")
            continue
        if body is None:
            continue
        sub, i = parse_tree(body, 0, commitment, [_MAX_OPS])
        if i != len(body):
            raise OtsError("phản hồi calendar có byte thừa")
        if any(k == "bitcoin" for k, _c, _p in attestations(sub)):
            got += _graft(tree, commitment, sub)
    if not got:
        return {"id": bid, "status": "cho", "errors": errs}
    new = OTS_HEAD + bytes.fromhex(sha) + write_tree(tree)
    parse_receipt(new, sha)                    # tự kiểm trước khi ghi
    # r14-fix2 F2: ghi dưới khóa advisory theo lần gom (cùng khóa trigger
    # `anchor_receipts_upgrade_once`), kiểm lại "đã có" DƯỚI khóa — 2 caller đua
    # chỉ 1 dòng, `new` = có thật sự tạo dòng. Khóa chỉ giữ trong transaction
    # ghi ngắn, KHÔNG giữ lúc hỏi calendar.
    if human:   # login người không có INSERT bảng — chỉ qua function kiểm quyền
        created = _human_call(conn, "select created from anchor_upgrade_human("
                              "%s, %s, %s, %s)", (bid, cal, new, by), by, bid)
    else:
        with conn.transaction():
            conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))",
                         (f"anchor_receipts_upgrade:{bid}",))
            have = conn.execute(
                "select status from anchor_receipts where batch_id = %s and"
                " status = 'da_nang_cap' limit 1", (bid,)).fetchone()
            created = not (have and have[0] == "da_nang_cap")
            if created:
                conn.execute(
                    "insert into anchor_receipts (batch_id, provider, status,"
                    " calendar, receipt, created_by) values (%s,"
                    " 'opentimestamps', 'da_nang_cap', %s, %s, %s)",
                    (bid, cal, new, by))
        conn.commit()
    heights = sorted(_varuint(p, 0)[0] for k, _c, p in attestations(tree)
                     if k == "bitcoin")
    out = {"id": bid, "status": "da_nang_cap", "new": bool(created),
           "heights": heights}
    if not created:
        out["so_dong_nang_cap"] = _n_upgraded(conn, bid)
    return out


def _n_upgraded(conn, bid: int) -> int:
    """Số dòng `da_nang_cap` của lần gom — lịch sử trước r14 có thể > 1."""
    n = conn.execute("select count(*) from anchor_receipts where batch_id = %s"
                     " and status = 'da_nang_cap'", (bid,)).fetchone()[0]
    conn.commit()
    return n if isinstance(n, int) else 1


def receipt_state(conn, bid: int) -> str:
    r = conn.execute("select status, calendar, created_at from"
                     " anchor_receipts where batch_id = %s order by"
                     " (status = 'da_nang_cap') desc, (status = 'da_gui') desc,"
                     " id desc limit 1", (bid,)).fetchone()
    if r is None:
        return "chưa neo"
    if r[0] == "loi":
        return "chưa neo (lần gửi gần nhất lỗi — chạy lại --submit)"
    if r[0] == "da_nang_cap":
        return (f"calendar {r[1].removeprefix('https://')} đã trả attestation"
                " Bitcoin — CHƯA xác minh bên thứ ba (ots verify với header"
                " khối Bitcoin)")
    return (f"đã gửi calendar {r[1].removeprefix('https://')} — chờ xác nhận"
            " Bitcoin (--upgrade; bên thứ ba: ots verify)")


def export(conn, ref, out_dir: Path) -> list[Path]:
    row = _batch(conn, ref)
    bid = row[0]
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"anchor-{bid}.json"
    p.write_bytes(_manifest_of(row))
    files = [p]
    rec = conn.execute("select receipt from anchor_receipts where batch_id ="
                       " %s and status in ('da_gui', 'da_nang_cap') order by"
                       " (status = 'da_nang_cap') desc, id desc limit 1",
                       (bid,)).fetchone()
    conn.commit()
    if rec:
        q = out_dir / f"anchor-{bid}.json.ots"
        q.write_bytes(bytes(rec[0]))
        files.append(q)
    return files


# ------------------------------------------------------------ CLI


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.anchor",
                                 description=__doc__.split("\n")[0])
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--submit", metavar="ID|latest")
    ap.add_argument("--verify", metavar="ID|latest")
    ap.add_argument("--export", metavar="ID|latest")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--upgrade", metavar="ID|latest")
    ap.add_argument("--by", default=CREATED_BY)
    a = ap.parse_args(argv)
    ops = [a.build, a.submit, a.verify, a.export, a.status, a.upgrade]
    if sum(bool(x) for x in ops) != 1:
        ap.error("chọn đúng 1 trong --build/--submit/--verify/--export/"
                 "--status/--upgrade")
    if a.export and a.out is None:
        ap.error("--export cần --out DIR")
    by = " ".join(str(a.by).split())[:100]
    if not by:
        ap.error("--by rỗng")
    try:
        cfg = load_config()
    except AnchorError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 2
    if (a.submit or a.upgrade) and cfg["provider"] == "none":
        print("[external-dep] provider 'none' — CHƯA NEO: chọn chuỗi/provider"
              "/phí là quyết định hai bên (data/anchor_config.json).",
              file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[err] DB không kết nối được", file=sys.stderr)
        return 2
    try:
        # Mốc gom theo đồng hồ DB lùi LAG: dòng do tx khác đang mở ghi (giờ
        # = đầu tx của nó) đã commit trước khi tới mốc → không bị báo "chèn
        # lùi giờ" giả khi --verify.
        now = conn.execute("select now() - %s", (LAG,)).fetchone()[0]
        conn.commit()
        if a.build:
            r = build(conn, now, dry_run=a.dry_run)
            tag = "dry-run" if a.dry_run else ("mới" if r["new"] else
                                               "không đổi")
            print(f"[ok] lần gom #{r['id']} ({tag}): {r['n']} lá, gốc "
                  f"{r['root']}")
            if cfg["provider"] == "none":
                print("[external-dep] provider 'none' — lần gom CHƯA NEO ra "
                      "blockchain (chỉ đối chiếu nội bộ).")
        elif a.submit:
            # v15.4 (P10.2): `--by <người>` mở biên dùng ở giai đoạn "có người
            # duyệt" (gửi digest ra ngoài) = QUYẾT ĐỊNH của người được Bên B
            # ủy quyền khối của tính năng (auth.cli_gate). `--by` mặc định
            # `agent:anchor` (job) → không phải người, rollout đòi vận hành.
            from pipelines import auth  # lười: auth → director → ...
            if auth.is_human(by):
                why = auth.cli_gate(conn, by, FEATURE.split("-")[0],
                                    "approve", "anchor_batch", a.submit)
                if why:
                    print(f"[từ chối] {why}", file=sys.stderr)
                    return 1
            r = submit(conn, a.submit, cfg, by=by)
            if r["status"] == "loi":
                print(f"[err] lần gom #{r['id']}: mọi calendar lỗi — "
                      + "; ".join(r["errors"]), file=sys.stderr)
                return 1
            print(f"[ok] lần gom #{r['id']}: {receipt_state(conn, r['id'])}")
        elif a.upgrade:
            # r14 C2: như --submit — `--by <người>` = QUYẾT ĐỊNH khối farming
            # (auth.cli_gate) trước khi hỏi calendar; job giữ `agent:anchor`.
            from pipelines import auth  # lười: auth → director → ...
            if auth.is_human(by):
                why = auth.cli_gate(conn, by, FEATURE.split("-")[0],
                                    "approve", "anchor_batch", a.upgrade)
                if why:
                    print(f"[từ chối] {why}", file=sys.stderr)
                    return 1
            r = upgrade(conn, a.upgrade, cfg, by=by)
            if r["status"] == "chua_gui":
                print(f"[err] lần gom #{r['id']}: chưa có biên nhận đã gửi",
                      file=sys.stderr)
                return 1
            if r["status"] == "cho":
                print(f"[cho] lần gom #{r['id']}: calendar chưa có attestation"
                      " Bitcoin" + (" — " + "; ".join(r["errors"])
                                    if r["errors"] else ""))
                return 0
            n = r.get("so_dong_nang_cap", 1)
            print(f"[ok] lần gom #{r['id']}: {receipt_state(conn, r['id'])}"
                  + (f" · khối {r['heights']}" if r.get("heights") else "")
                  + (f" · {n} biên nhận da_nang_cap (lịch sử)" if n > 1
                     else ""))
        elif a.verify:
            bid, probs = verify(conn, a.verify)
            for p in probs:
                print(f"[lệch] #{bid} {p}")
            print(f"[{'ok' if not probs else 'err'}] lần gom #{bid}: "
                  f"{'khớp DB' if not probs else f'{len(probs)} vấn đề'} — "
                  f"{receipt_state(conn, bid)}")
            return 1 if probs else 0
        elif a.export:
            for p in export(conn, a.export, a.out):
                print(f"[ok] {p}")
            print("Bên thứ ba: `ots upgrade <file>.json.ots` rồi `ots verify "
                  "<file>.json.ots` (cần tệp .json cạnh .ots).")
        else:
            rows = conn.execute("select id, as_of, jsonb_array_length("
                                "leaves), merkle_root from anchor_batches"
                                " order by id desc limit 20").fetchall()
            print(f"provider: {cfg['provider']}")
            for bid, as_of, n, root in rows:
                print(f"  #{bid} {as_of:%Y-%m-%d %H:%M}Z {n} lá "
                      f"{root[:16]}… — {receipt_state(conn, bid)}")
            if not rows:
                print("  (chưa có lần gom nào)")
        return 0
    except AnchorBlocked as e:
        print(f"[external-dep] {e}", file=sys.stderr)
        return 2
    except ValueError as e:      # AnchorError + rollout.RolloutBlocked
        print(f"[err] {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[err] DB: {_oneline(_db_msg(e), 200)}", file=sys.stderr)
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
