"""r15 data_platform-06 — quyết toán qua API sàn CHỈ ĐỌC → CÙNG sổ `settlement_rows`
của `ingest.settlement_csv` (validation, chống trùng, đối chiếu finance-01, view
`v_settlement_khoan` dùng chung — KHÔNG có hệ quyết toán thứ hai).

Gọi qua `python -m ingest.market_api --channel shopee|tiktok --kind settlement
--from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]` (transport/ký/refresh/thử lại/
allowlist của `ingest.market_api` — không HTTP riêng).

Tài liệu CHÍNH THỨC (đọc 25/10/2026 — evidence/itacc_r15_remaining/
NGUON_TAI_LIEU.md):
  shopee  GET /api/v2/payment/get_escrow_list (release_time_from/to, page_size
          ≤100, page_no ≥1, `more`) → GET /api/v2/payment/get_escrow_detail
          (order_sn) → `response.order_income` (~100 trường số).
  tiktok  GET /finance/202309/statements (statement_time_ge/lt, sort_field=
          statement_time, page_size ≤100, page_token) → GET /finance/202501/
          statements/{statement_id}/statement_transactions (sort_field=
          order_create_time, page_token) → transactions[] (ORDER/RESERVE/điều
          chỉnh) với số tiền dạng chuỗi + breakdown lồng nhau.

ÁNH XẠ = QUYẾT ĐỊNH KẾ TOÁN, không phải code: `data/settlement_api_map.json`
mỗi kênh `trang_thai` (`chua_chot`|`da_chot`) + `duyet_boi`/`can_cu`/`ngay_chot`
+ `thanh_phan` {tên trường API → null | {"cot": <cột settlement>, "dau": 1|-1}
| {"bo_qua": true}} (+ TikTok `loai_giao_dich` {type → null | {"ma_don":
order_id|adjustment_order_id|associated_order_id, "txn_type": str|null} |
{"bo_qua": true}}). Code chỉ CỘNG theo bảng: không tự gộp, đổi dấu, suy công
thức. Chưa chốt / thiếu người-căn cứ / thành phần LẠ hoặc null có trong dữ liệu /
loại giao dịch chưa quyết → BLOCKED (exit 2) TRƯỚC khi ghi; `--dry-run` liệt kê
trạng thái từng thành phần (tên trường, không giá trị) và không đụng DB.

Nguồn (`source_kind`): host `partner.shopeemobile.com` = api_live, host sandbox
Shopee = api_sandbox, 127.0.0.1/localhost = api_local; TikTok sandbox và thật
CÙNG host → chỉ api_live khi người vận hành khai `TIKTOK_API_ENV=live`, không
khai = khong_ro. CHỈ api_live được ghi sổ (8 agent đọc thẳng `settlement_rows`
để tính doanh thu/phí, bảng không có cột mẫu) — nguồn khác chỉ `--dry-run`.

Ghi: toàn bộ trang + chi tiết kéo xong, kiểm hết rồi mới connect; 1 transaction
`settlement_csv.load(source_kind=api_live)` + `reconcile` + `overlaps` → commit;
lỗi → rollback, 0 dòng. `file_sha256` = sha256 NỘI DUNG dòng chuẩn hóa (không
theo cửa sổ/tên/request id) → cùng dữ liệu = `[skip]`; cửa sổ chồng trùng nguyên
văn tính 1 lần qua view; cùng khoản số khác = `lech`, giữ cả hai. Đơn đã có dòng
từ NGUỒN KHÁC (CSV ↔ API — khóa txn_type hai nguồn có thể khác) → chặn, người đối
soát quyết. Ngày quyết toán = ngày giờ VN (UTC+7) của `escrow_release_time`
(Shopee) / `statement_time` (TikTok) — GIẢ ĐỊNH, ghi trong bảng ánh xạ để Kế toán
xác nhận. Không in mã đơn/tên người mua/token.

r15-fix1 (26/10/2026): F1 — kiểm nguồn khác + INSERT dưới `settlement_csv.
lock_orders` (advisory xact lock theo (kênh, đơn), cùng khóa với loader CSV).
F2 — thành phần đã ánh xạ vào cột mà thiếu/null/("" TikTok) = LỖI, không phải 0
(trừ `khi_vang: bang_0` do Kế toán quyết, cấm cho order_amount/payout); sai kiểu
luôn lỗi; `check_rows` chặn lần cuối trong `_write` (cột None/bool/lẻ → 0
connect). F3 — Shopee ghi một trường chỉ khi đồng tiền của ĐÚNG trường đó là
VND: `*_pri` theo `pri_currency`, trường thường theo `aff_currency`; response
không có mã → `tien_te_shop` (null = chặn). Không quy đổi tỷ giá.
"""

import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.parse
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg

from ingest import market_api as ma
from ingest import market_csv as mc
from ingest import settlement_csv as sc

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAP_FILE = ROOT / "data" / "settlement_api_map.json"
MAX_DAYS = 31
COLS = sc.MONEY                       # order_amount, 7 khoản trừ, payout
LIVE_HOSTS = {"shopee": ("partner.shopeemobile.com",),
              "tiktok": ("open-api.tiktokglobalshop.com",)}
SANDBOX_HOSTS = {"shopee": ("openplatform.sandbox.test-stable.shopee.sg",),
                 "tiktok": ()}
TT_ORDER_FIELDS = ("order_id", "adjustment_order_id", "associated_order_id")
TT_IDENTITY = {"id", "type", "order_create_time", "adjustment_id", "reserve_id",
               "reserve_status", "estimated_release_time", *TT_ORDER_FIELDS}
SP_CURRENCY = ("pri_currency", "aff_currency")
# Thành phần đã ánh xạ mà VẮNG: null/"loi" (mặc định) = lỗi dữ liệu; "bang_0" =
# Kế toán quyết rõ vắng tính 0 (chỉ cột không bắt buộc).
KHI_VANG = (None, "loi", "bang_0")
REQUIRED_COLS = ("order_amount", "payout")     # = settlement_csv.MUST (trừ mã đơn)
_AMT_RE = re.compile(r"-?[0-9]{1,15}(?:\.0{1,6})?")
_SID_RE = re.compile(r"[0-9]{1,30}")
MAX_SHOW = 60


class MapError(Exception):
    """Bảng ánh xạ hỏng dạng — message chỉ nêu khóa, không giá trị."""


# ---------------------------------------------------------------- nguồn


def source_kind(channel: str, base: str) -> str:
    host = urllib.parse.urlsplit(base).hostname or ""
    if host in ma.LOCAL_HOSTS:
        return "api_local"
    if host in SANDBOX_HOSTS[channel]:
        return "api_sandbox"
    if host in LIVE_HOSTS[channel]:
        if channel == "tiktok" and (
                os.environ.get("TIKTOK_API_ENV") or "").strip() != "live":
            return "khong_ro"
        return "api_live"
    return "khong_ro"


# ---------------------------------------------------------------- ánh xạ


def _is_person(v) -> bool:
    if not isinstance(v, str) or not v.strip():
        return False
    s = unicodedata.normalize("NFKC", v).strip().lower()
    return not s.startswith(("agent:", "system:", "auto_policy:"))


def _decision(name: str, d, tiktok_type: bool = False):
    if d is None:
        return
    if not isinstance(d, dict):
        raise MapError(f"quyết định '{mc._clean(name, 80)}' phải là object/null")
    if d.get("bo_qua") is True and len(d) <= 2 and set(d) <= {"bo_qua", "ghi_chu"}:
        return
    if tiktok_type:
        if (d.get("ma_don") in TT_ORDER_FIELDS and set(d) <= {"ma_don", "txn_type",
                                                              "ghi_chu"}
                and (d.get("txn_type") is None or (
                    isinstance(d.get("txn_type"), str)
                    and d["txn_type"].strip() and len(d["txn_type"]) <= 64))):
            return
    elif (d.get("cot") in COLS and d.get("dau") in (1, -1)
          and not isinstance(d.get("dau"), bool)
          and set(d) <= {"cot", "dau", "ghi_chu", "khi_vang"}
          and d.get("khi_vang") in KHI_VANG):
        # r15-fix1 F2: cột bắt buộc không được lấp bằng 0 khi vắng.
        if d.get("khi_vang") == "bang_0" and d["cot"] in REQUIRED_COLS:
            raise MapError(f"quyết định '{mc._clean(name, 80)}': khi_vang "
                           f"bang_0 không dùng được cho cột bắt buộc {d['cot']}")
        return
    raise MapError(f"quyết định '{mc._clean(name, 80)}' sai dạng")


def load_map(channel: str, path: Path | None = None) -> tuple[dict, list[str]]:
    """→ (mục của kênh, lý do CHƯA được dùng để ghi sổ — [] = đã chốt hợp lệ).
    Tệp/khóa sai dạng → MapError."""
    path = MAP_FILE if path is None else Path(path)
    try:
        doc = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise MapError(f"{path.name}: không đọc được ({type(e).__name__})"
                       ) from None
    sec = doc.get(channel) if isinstance(doc, dict) else None
    if not isinstance(sec, dict):
        raise MapError(f"{path.name}: thiếu mục kênh {channel}")
    tp = sec.get("thanh_phan", {})
    lg = sec.get("loai_giao_dich", {}) if channel == "tiktok" else {}
    if not isinstance(tp, dict) or not isinstance(lg, dict):
        raise MapError(f"{path.name}/{channel}: thanh_phan/loai_giao_dich phải là object")
    for k, d in tp.items():
        _decision(k, d)
    for k, d in lg.items():
        _decision(k, d, tiktok_type=True)
    # r15-fix1 F3: đơn vị tiền shop Shopee khi response không có mã (shop
    # thường) — null/vắng = chưa xác nhận → dòng thiếu mã bị chặn; chỉ "VND".
    shop = sec.get("tien_te_shop")
    if "tien_te_shop" in sec and (channel != "shopee" or shop not in (None, "VND")):
        raise MapError(f"{path.name}/{channel}: tien_te_shop chỉ dùng cho shopee, "
                       "giá trị null|\"VND\"")
    why = []
    st = sec.get("trang_thai")
    if st not in ("chua_chot", "da_chot"):
        raise MapError(f"{path.name}/{channel}: trang_thai phải là chua_chot|da_chot")
    if st != "da_chot":
        why.append("trang_thai = chua_chot (Kế toán chưa chốt bảng ánh xạ)")
    if not _is_person(sec.get("duyet_boi")):
        why.append("thiếu duyet_boi (người chốt — không phải agent/system)")
    if not (isinstance(sec.get("can_cu"), str) and sec["can_cu"].strip()):
        why.append("thiếu can_cu (văn bản/biên bản chốt)")
    try:
        date.fromisoformat(sec.get("ngay_chot") or "")
    except (TypeError, ValueError):
        why.append("thiếu/sai ngay_chot (YYYY-MM-DD)")
    if n := sum(d is None for d in [*tp.values(), *lg.values()]):
        why.append(f"{n} quyết định còn trống (null)")
    used = {d["cot"] for d in tp.values() if isinstance(d, dict) and "cot" in d}
    for need in ("order_amount", "payout"):
        if need not in used:
            why.append(f"chưa có thành phần nào ghi vào cột {need}")
    if channel == "tiktok" and not any(
            isinstance(d, dict) and "ma_don" in d for d in lg.values()):
        why.append("chưa có loại giao dịch nào được ghi (loai_giao_dich)")
    return {"thanh_phan": tp, "loai_giao_dich": lg, "tien_te_shop": shop}, why


# ---------------------------------------------------------------- kéo + chuẩn hóa


def _vnd(v, name: str, where: str) -> int | None:
    """Số tiền API → int VND. "" → None (vắng). Lẻ/sai kiểu → DataError (chỉ
    nêu tên trường)."""
    n = None
    if isinstance(v, bool):
        n = None
    elif isinstance(v, int):
        n = v
    elif isinstance(v, float):
        n = int(v) if v.is_integer() else None
    elif isinstance(v, str):
        if v.strip() == "":
            return None
        if _AMT_RE.fullmatch(v.strip()):
            n = int(v.strip().split(".")[0])
    if n is None or abs(n) > sc.MONEY_CAP:
        raise ma.DataError(f"{where}: thành phần '{mc._clean(name, 80)}' không "
                           "phải số nguyên VND hợp lệ")
    return n


class _List:
    """Đánh dấu danh sách object không rỗng (chỉ được `bo_qua`)."""

    def __repr__(self):
        return "<danh sách>"


LIST = _List()


def _flatten(d: dict, where: str, skip=frozenset(), prefix: str = "",
             strings_are_money: bool = False) -> dict:
    """dict lồng → {tên dạng a.b.c: giá trị THÔ (int/float/str/bool/None) |
    LIST}. r15-fix1 F2: KHÔNG đổi số ở đây — thiếu / null / sai kiểu chỉ phán
    được khi biết trường có được ánh xạ hay không (`to_rows`): trường đã ánh
    xạ vào cột phải hợp lệ; trường không phải tiền (mã voucher, phương thức
    thanh toán, tỷ giá đã `bo_qua`) không làm hỏng lượt. `where`/
    `strings_are_money` giữ cho caller cũ (kênh quyết định cách đọc chuỗi)."""
    out = {}
    for k, v in d.items():
        if not isinstance(k, str) or (not prefix and k in skip):
            continue
        name = prefix + k
        if isinstance(v, dict):
            out.update(_flatten(v, where, skip, name + ".", strings_are_money))
        elif isinstance(v, list):
            if any(isinstance(x, dict) for x in v):
                out[name + "[]"] = LIST
        else:
            out[name] = v
    return out


def _absent(channel: str, v) -> bool:
    """Vắng = khóa không có / null; TikTok (số dạng chuỗi) thêm "" (rỗng)."""
    return v is None or (channel == "tiktok" and isinstance(v, str)
                         and v.strip() == "")


def _money_like(channel: str, v) -> bool:
    """Giá trị TRÔNG như số tiền ở trường KHÔNG ánh xạ vào cột (→ LẠ / chưa
    chốt). Shopee: số (đặc tả float) — chuỗi (mã tiền tệ/voucher) không phải
    tiền; TikTok: mọi chuỗi không rỗng (tiền dạng chuỗi)."""
    if v is LIST:
        return True
    if isinstance(v, bool) or v is None:
        return False
    if isinstance(v, (int, float)):
        return True
    return channel == "tiktok" and isinstance(v, str) and bool(v.strip())


def _sp_currency(name: str, cur: dict | None, shop) -> object:
    """Đơn vị tiền của trường Shopee `name` theo đặc tả get_escrow_detail:
    `*_pri` = "amount is in the primary currency" → `pri_currency`; trường
    thường của đơn CB SIP = tiền shop affiliate (`exchange_rate` "from primary
    shop currency to affiliate shop currency", `commission_fee = commission_
    fee_pri * exchange_rate`) → `aff_currency`. Response không có cả hai mã
    (shop thường) → số theo "listing currency" mà response KHÔNG nêu → dùng
    `tien_te_shop` do người chốt bảng ánh xạ xác nhận (null = không xác định).
    → mã (str) | None (không xác định)."""
    if not cur:
        return shop
    return cur.get("pri_currency" if name.endswith("_pri") else "aff_currency")


def _vn_bounds(d0: date, d1: date) -> tuple[int, int]:
    """[đầu ngày d0, đầu ngày sau d1) giờ VN → Unix giây."""
    t0 = int(datetime(d0.year, d0.month, d0.day, tzinfo=ma.VN_TZ).timestamp())
    e = d1 + timedelta(days=1)
    return t0, int(datetime(e.year, e.month, e.day, tzinfo=ma.VN_TZ).timestamp())


def _vn_date(ts, field: str, where: str) -> date:
    if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0:
        raise ma.DataError(f"{where}: field '{field}' thiếu/sai kiểu")
    return datetime.fromtimestamp(ts, ma.VN_TZ).date()


def fetch_shopee(call, d0: date, d1: date) -> list[dict]:
    w = "shopee quyết toán"
    t0, t1 = _vn_bounds(d0, d1)
    seen: dict[str, tuple] = {}
    state = {"pn": 1}

    def page(cur):
        state["pn"] = cur or 1
        return ma._obj(call("GET", ma.SP_ESCROW_LIST, {
            "release_time_from": t0, "release_time_to": t1 - 1,
            "page_size": ma.PAGE_SIZE, "page_no": state["pn"]}), "response", w)

    def nxt(r):
        if not isinstance(r.get("more"), bool):
            raise ma.DataError(f"{w}: thiếu/sai field 'more'")
        return state["pn"] + 1 if r["more"] else None

    for r in ma._pages(page, nxt):
        for e in ma._list(r, "escrow_list", w):
            sn = ma._id(e.get("order_sn"), "order_sn", w)
            pay = _vnd(e.get("payout_amount"), "payout_amount", w)
            rel = _vn_date(e.get("escrow_release_time"), "escrow_release_time", w)
            if seen.setdefault(sn, (pay, rel)) != (pay, rel):
                raise ma.DataError(f"{w}: cùng 1 đơn xuất hiện 2 lần với số/ngày "
                                   "KHÁC nhau trong 1 lượt — không tự chọn bản")
    recs = []
    for sn, (_pay, rel) in seen.items():
        resp = ma._obj(call("GET", ma.SP_ESCROW_DETAIL, {"order_sn": sn}),
                       "response", w)
        if ma._id(resp.get("order_sn"), "order_sn", w) != sn:
            raise ma.DataError(f"{w}: escrow detail trả đơn khác đơn đã hỏi")
        inc = ma._obj(resp, "order_income", w)
        # r15-fix1 F3: mã tiền tệ là siêu dữ liệu của từng trường tiền, không
        # phải thành phần (không bao giờ thành "LẠ").
        recs.append({"order": sn, "type": None, "settled_on": rel,
                     "cur": {k: inc[k] for k in SP_CURRENCY if k in inc},
                     "comps": _flatten(inc, w, SP_CURRENCY)})
    return recs


def _tt_pages(call, path: str, params: dict, w: str, path_params=None):
    def page(tok):
        p = {**params, "page_size": ma.PAGE_SIZE}
        if tok:
            p["page_token"] = tok
        return ma._obj(call("GET", path, p, path_params=path_params), "data", w)

    def nxt(d):
        t = d.get("next_page_token")
        if t is not None and not isinstance(t, str):
            raise ma.DataError(f"{w}: next_page_token sai kiểu")
        return t or None

    yield from ma._pages(page, nxt)


def _vnd_currency(d: dict, w: str) -> None:
    if d.get("currency") != "VND":
        raise ma.DataError(f"{w}: currency khác VND — sổ quyết toán chỉ nhận VND")


def fetch_tiktok(call, d0: date, d1: date) -> list[dict]:
    w = "tiktok quyết toán"
    t0, t1 = _vn_bounds(d0, d1)
    stmts: dict[str, date] = {}
    for d in _tt_pages(call, ma.TT_STATEMENTS, {
            "statement_time_ge": t0, "statement_time_lt": t1,
            "sort_field": "statement_time"}, w):
        for s in ma._list(d, "statements", w):
            sid = s.get("id")
            if not isinstance(sid, str) or not _SID_RE.fullmatch(sid):
                raise ma.DataError(f"{w}: statement id sai dạng")
            _vnd_currency(s, w)
            stmts.setdefault(sid, _vn_date(s.get("statement_time"),
                                           "statement_time", w))
    recs, seen = [], {}
    for sid, day in stmts.items():
        for d in _tt_pages(call, ma.TT_STATEMENT_TX, {
                "sort_field": "order_create_time"}, w,
                path_params={"statement_id": sid}):
            _vnd_currency(d, w)
            for t in ma._list(d, "transactions", w):
                tid = ma._id(t.get("id"), "id", w)
                typ = ma._str(t.get("type"), "type", w, 64)
                if typ is None:
                    raise ma.DataError(f"{w}: giao dịch thiếu 'type'")
                rec = {"order": None, "type": typ, "settled_on": day,
                       "ids": {f: ma._str(t.get(f), f, w, 64)
                               for f in TT_ORDER_FIELDS},
                       "comps": _flatten(t, w, TT_IDENTITY,
                                         strings_are_money=True)}
                if seen.setdefault(tid, rec) != rec:
                    raise ma.DataError(f"{w}: cùng 1 giao dịch xuất hiện 2 lần "
                                       "với nội dung KHÁC nhau — không tự chọn")
                if seen[tid] is rec:
                    recs.append(rec)
    return recs


def _status(dec) -> str:
    if dec is None:
        return "CHƯA CHỐT"
    if dec.get("bo_qua"):
        return "bỏ qua"
    if "ma_don" in dec:
        return f"ghi dòng, mã đơn từ {dec['ma_don']}"
    return (f"cột {dec['cot']} ({'+' if dec['dau'] == 1 else '−'})"
            + ("; vắng = 0" if dec.get("khi_vang") == "bang_0" else ""))


def to_rows(channel: str, recs: list[dict], cfg: dict
            ) -> tuple[list[dict], list[str], list[str], dict]:
    """→ (rows chuẩn settlement_csv, BLOCKED (cần quyết định), lỗi dữ liệu,
    {tên thành phần/loại: trạng thái}). rows chỉ dùng khi 2 danh sách rỗng."""
    tp, lg = cfg["thanh_phan"], cfg["loai_giao_dich"]
    blocked, errs, status, keyed, units = [], [], {}, {}, set()
    for r in recs:
        txn_type = None
        if channel == "tiktok":
            dec = lg.get(r["type"])
            status[f"loại {r['type']}"] = ("LẠ — chưa có trong ánh xạ"
                                           if r["type"] not in lg else _status(dec))
            if dec is None:
                blocked.append(f"loại giao dịch '{mc._clean(r['type'], 64)}' "
                               + ("LẠ" if r["type"] not in lg else "chưa chốt"))
                continue
            if dec.get("bo_qua"):
                continue
            oid = r["ids"].get(dec["ma_don"])
            if not oid:
                errs.append(f"giao dịch loại '{mc._clean(r['type'], 64)}' thiếu "
                            f"{dec['ma_don']}")
                continue
            txn_type = dec.get("txn_type")
        else:
            oid = r["order"]
            cur = r.get("cur") or {}
            units.add(", ".join(f"{k}={mc._clean(str(cur[k]), 8)}" for k in SP_CURRENCY
                                if k in cur)
                      or f"không có mã → tien_te_shop={cfg.get('tien_te_shop')}")
        # r15-fix1 F2: cột = None (độc) khi một thành phần ánh xạ vào nó vắng/
        # sai kiểu/sai đơn vị → errs + `_write` từ chối dòng có None.
        sums = dict.fromkeys(COLS, 0)
        comps = r["comps"]
        for name, v in comps.items():
            dec = tp.get(name)
            if name not in tp:
                if _money_like(channel, v):
                    status[name] = "LẠ — chưa có trong ánh xạ"
                    blocked.append(f"thành phần '{mc._clean(name, 80)}' LẠ")
                continue                  # chuỗi/null không ánh xạ: không phải tiền
            status[name] = _status(dec)
            if dec is None:
                if _money_like(channel, v):
                    blocked.append(f"thành phần '{mc._clean(name, 80)}' chưa chốt")
            elif dec.get("bo_qua"):
                continue
            elif v is LIST:
                blocked.append(f"thành phần '{mc._clean(name, 80)}' là danh sách "
                               "— chỉ được bo_qua")
        for name, dec in tp.items():
            if not (isinstance(dec, dict) and "cot" in dec):
                continue
            col, v, nm = dec["cot"], comps.get(name), mc._clean(name, 80)
            if v is LIST:
                sums[col] = None          # đã chặn ở trên
                continue
            if _absent(channel, v):
                status.setdefault(name, _status(dec) + " — VẮNG trong dữ liệu")
                if dec.get("khi_vang") == "bang_0":
                    continue
                errs.append(f"thành phần '{nm}' (cột {col}) thiếu/null — không "
                            "coi là 0 (khi_vang chưa quyết)")
                sums[col] = None
                continue
            try:
                n = _vnd(v, name, "quyết toán")
            except ma.DataError:
                n = None
            if n is None:
                errs.append(f"thành phần '{nm}' (cột {col}) sai kiểu — không phải "
                            "số nguyên VND")
                sums[col] = None
                continue
            if channel == "shopee":
                c = _sp_currency(name, r.get("cur"), cfg.get("tien_te_shop"))
                if c is None:
                    k = "primary" if name.endswith("_pri") else "affiliate"
                    why = (f"response có mã tiền nhưng thiếu/null mã tiền {k}" if r.get("cur")
                           else "response không có mã; tien_te_shop chưa xác nhận")
                    blocked.append(f"thành phần '{nm}': không xác định được đơn vị "
                                   f"tiền ({why})")
                    sums[col] = None
                    continue
                if c != "VND":
                    errs.append(f"thành phần '{nm}': đơn vị tiền "
                                f"'{mc._clean(str(c), 8)}' không phải VND — sổ chỉ "
                                "nhận VND, không quy đổi tỷ giá")
                    sums[col] = None
                    continue
            if sums[col] is not None:
                sums[col] += dec["dau"] * n
        h = sc.order_hash(channel, oid)
        if (h, txn_type) in keyed:
            blocked.append("≥2 giao dịch cùng đơn + cùng txn_type trong 1 lượt — "
                           "cần nhãn txn_type riêng theo loại (Kế toán)")
            continue
        if any(sums[c] is not None and sums[c] < 0 for c in ("order_amount",
                                                              "refund")):
            errs.append("cột order_amount/refund âm sau ánh xạ (1 dòng)")
        if any(x is not None and abs(x) > sc.MONEY_CAP for x in sums.values()):
            errs.append("số tiền vượt trần sau ánh xạ (1 dòng)")
        keyed[(h, txn_type)] = {"order_id_hash": h, "txn_type": txn_type,
                                "settled_on": r["settled_on"], **sums}
    if units:
        status["(đơn vị tiền)"] = "; ".join(sorted(units))
    rows = [keyed[k] for k in sorted(keyed, key=lambda k: (k[0], k[1] or ""))]
    for i, row in enumerate(rows, 2):     # row_no ≥ 2 như file (dòng 1 = header)
        row["row_no"] = i
    return rows, sorted(set(blocked)), sorted(set(errs)), status


def rows_sha(channel: str, kind: str, rows: list[dict]) -> str:
    blob = json.dumps({"channel": channel, "source_kind": kind, "rows": [
        {k: (v.isoformat() if isinstance(v, date) else v) for k, v in r.items()
         if k != "row_no"} for r in rows]}, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- CLI (qua market_api)


def parse_window(s_from: str, s_to: str) -> tuple[date, date] | str:
    try:
        d0, d1 = date.fromisoformat(s_from), date.fromisoformat(s_to)
    except (TypeError, ValueError):
        return "--from/--to phải là YYYY-MM-DD"
    if d1 < d0 or (d1 - d0).days + 1 > MAX_DAYS:
        return f"--to ≥ --from và tối đa {MAX_DAYS} ngày"
    return d0, d1


def precheck(channel: str, base: str, dry_run: bool):
    """TRƯỚC mọi request: → (cfg, fees, kind, None) | (None, None, None, exit)."""
    try:
        cfg, why = load_map(channel)
    except MapError as e:
        print(f"[err] bảng ánh xạ quyết toán: {e} — 0 request.", flush=True)
        return None, None, None, 1
    kind = source_kind(channel, base)
    if dry_run:
        return cfg, None, kind, None
    if why:
        print(f"[blocked] {channel}: bảng ánh xạ quyết toán CHƯA dùng được để ghi "
              "sổ — " + "; ".join(why) + f" ({MAP_FILE.name}, Kế toán chốt). 0 "
              "request, 0 dòng. Xem dữ liệu: thêm --dry-run.", flush=True)
        return None, None, None, 2
    if kind != "api_live":
        print(f"[blocked] {channel}: nguồn {kind} — chỉ API THẬT được ghi sổ quyết "
              "toán; sandbox/server giả chạy --dry-run. 0 request.", flush=True)
        return None, None, None, 2
    fees, fwhy = sc.load_fees()
    if fees is None:
        print(f"[err] {fwhy} — 0 request.", flush=True)
        return None, None, None, 1
    return cfg, fees, kind, None


def run(args, creds: dict, base: str, cfg: dict, fees: dict | None,
        kind: str) -> int:
    def call(method, path, params, body=None, path_params=None):
        return ma._request(args.channel, method, path, params, body, creds=creds,
                           base=base, path_params=path_params)

    d0, d1 = args.window
    try:
        recs = (fetch_shopee if args.channel == "shopee" else fetch_tiktok)(
            call, d0, d1)
    except (ma.ApiError, ma.DataError, ma.ScopeError) as e:
        print(f"[err] {e} — không connect, không nạp gì.", flush=True)
        return 1
    rows, blocked, errs, status = to_rows(args.channel, recs, cfg)
    if args.dry_run:
        _, why = load_map(args.channel)
        print(f"[dry-run] {args.channel}: {len(recs)} giao dịch → {len(rows)} dòng "
              f"quyết toán (nguồn {kind}) — KHÔNG ghi sổ, không kết nối DB.")
        print("  bảng ánh xạ: " + ("đã chốt" if not why else
                                   "CHƯA CHỐT — " + "; ".join(why)))
        print(f"  thành phần/loại có trong dữ liệu ({len(status)}):")
        for name in sorted(status)[:MAX_SHOW]:
            print(f"    - {mc._clean(name, 90)}: {status[name]}")
        if len(status) > MAX_SHOW:
            print(f"    ... còn {len(status) - MAX_SHOW}")
    for e in errs[:mc.MAX_PRINT_ERRS]:
        print(f"[err] {e}", flush=True)
    for b in blocked[:mc.MAX_PRINT_ERRS]:
        print(f"[blocked] {b}", flush=True)
    if errs:
        print("[err] dữ liệu sàn không nạp được — 0 dòng.", flush=True)
        return 1
    if blocked:
        print("[blocked] cần quyết định của Kế toán trong bảng ánh xạ — 0 dòng.",
              flush=True)
        return 2
    if args.dry_run:
        return 0 if not why else 2
    if not rows:
        print(f"[warn] {args.channel}: 0 dòng quyết toán trong cửa sổ — không "
              "nạp gì.", flush=True)
        return 0
    return _write(args.channel, rows, kind, fees, d0, d1)


_HASH_RE = re.compile(r"[0-9a-f]{16}")


def check_rows(rows: list[dict]) -> list[str]:
    """r15-fix1 F2 (chốt cuối trước ghi): mọi cột tiền là int hợp lệ — None
    (thành phần vắng/sai kiểu/sai đơn vị ở `to_rows`), bool, vượt trần → lỗi;
    hash đơn/ngày/txn_type đúng dạng. Lỗi chỉ nêu dòng + tên cột."""
    errs = []
    for i, r in enumerate(rows, 1):
        for c in COLS:
            v = r.get(c)
            if isinstance(v, bool) or not isinstance(v, int) or abs(v) > sc.MONEY_CAP:
                errs.append(f"dòng {i}: cột {c} thiếu/không phải số nguyên VND")
        if any(isinstance(r.get(c), int) and not isinstance(r.get(c), bool)
               and r[c] < 0 for c in ("order_amount", "refund")):
            errs.append(f"dòng {i}: cột order_amount/refund âm")
        if not (isinstance(r.get("order_id_hash"), str)
                and _HASH_RE.fullmatch(r["order_id_hash"])):
            errs.append(f"dòng {i}: order_id_hash sai dạng")
        if r.get("settled_on") is not None and not isinstance(r["settled_on"], date):
            errs.append(f"dòng {i}: settled_on sai kiểu")
        t = r.get("txn_type")
        if t is not None and not (isinstance(t, str) and 0 < len(t) <= sc.TXN_TYPE_MAX):
            errs.append(f"dòng {i}: txn_type sai dạng")
    return errs


def _write(channel: str, rows: list[dict], kind: str, fees: dict, d0: date,
           d1: date) -> int:
    from pipelines import auth, rollout  # lười: auth/rollout → director → ...
    if bad := check_rows(rows):
        for e in bad[:mc.MAX_PRINT_ERRS]:
            print(f"[err] {e}", flush=True)
        print("[err] dòng quyết toán không hợp lệ — không connect, 0 dòng.",
              flush=True)
        return 1
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL", flush=True)
        return 1
    sha = rows_sha(channel, kind, rows)
    fname = f"api-{channel}-quyet-toan-{d0:%Y%m%d}-{d1:%Y%m%d}"
    try:
        conn = _connect(dsn)
    except psycopg.Error as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}", flush=True)
        return 1
    try:
        try:   # r15-fix1 F1: khóa (kênh, đơn) TRƯỚC kiểm đã nạp/nguồn khác/INSERT
            sc.lock_orders(conn, channel, {r["order_id_hash"] for r in rows})
        except sc.LockError as e:
            conn.rollback()
            print(f"[err] {e} — 0 dòng.", flush=True)
            return 1
        if conn.execute("select 1 from settlement_rows where file_sha256 = %s"
                        " limit 1", (sha,)).fetchone():
            conn.rollback()                  # nhả khóa
            print("[skip] dữ liệu quyết toán không đổi (đã nạp) — không ghi gì.",
                  flush=True)
            return 0
        if n := sc.cross_source(conn, channel,
                                {r["order_id_hash"] for r in rows}, kind):
            conn.rollback()
            print(f"[blocked] {n} đơn đã có dòng quyết toán từ NGUỒN KHÁC (file "
                  "CSV) — không ghi chồng; người đối soát quyết. 0 dòng.",
                  flush=True)
            return 2
        sc.load(conn, rows, channel, fname, sha, source_kind=kind)
        rc = 0
        try:
            counts = sc.reconcile(conn, fees, sha)
        except rollout.RolloutBlocked as e:
            print(f"[blocked] {e} — nạp dòng quyết toán, KHÔNG đối soát.",
                  flush=True)
            counts, rc = {}, rollout.EXIT_BLOCKED   # như settlement_csv.main
        ov = sc.overlaps(conn, [channel]).get(channel)
        conn.commit()
    except psycopg.errors.UniqueViolation as e:
        conn.rollback()
        if "file_sha256" in (e.diag.constraint_name or ""):
            print("[skip] dữ liệu vừa được nạp song song — không ghi gì.",
                  flush=True)
            return 0
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback — 0 dòng: {type(e).__name__}",
              flush=True)
        return 1
    finally:
        conn.close()
    print(f"[load] quyết toán {channel} {fname} (nguồn {kind}): {len(rows)} dòng;"
          " đối chiếu: " + ", ".join(f"{k}={v}" for k, v in counts.items()),
          flush=True)
    if ov:
        print(f"[warn] khoản xuất lại ở ≥2 lần nạp: trùng {ov['trung']}, lệch "
              f"{ov['lech']} — lệch giữ cả hai, chờ người đối soát.", flush=True)
    print("[done]", flush=True)
    return rc


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)
