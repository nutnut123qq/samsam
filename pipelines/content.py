"""Pipeline sinh nội dung đa kênh + listing sàn theo SKU (MKT-02).

Contract:
  draft(brief, channel="facebook", *, readiness=None, sku=None,
        content_type="post") -> {"text", "guardrail", "meta"}
  draft_multi(brief, channels, *, readiness=None, sku=None,
              content_type="post") -> {channel: {"text","guardrail","meta"}}
  listing(sku, channel, *, readiness=None, llm=True)
      -> {"ok", "refused", "text", "fields", "guardrail", "meta"}
  listing_batch(conn, skus, channels, *, by, readiness=None, llm=True)
      -> [{"sku", "channel", "status", ...}]
  precheck(sku, channel, content_type, *, readiness=None) -> dict | None
  load_template(name) -> (text, version, sha256)

  - Gọi LLM qua `pipelines.llm_gateway.chat("content", ...)` (v3.1 — PII
    mask + privacy routing + usage/cap; model OR_CHAT_MODEL)
    với system prompt chứa brand voice + claims_whitelist (chỉ được viết
    công dụng trong whitelist).
  - Output BẮT BUỘC qua guardrail CHẾ ĐỘ ĐĂNG BÀI trước khi trả về (v4.2):
    `pipelines.guardrail_llm.check_publish_llm(text, channel=<kênh>,
    content_type=<loại>, sku=<sku>, is_ai=True)` = luật `check_publish`
    (XNQC, câu khuyến cáo, nhãn AI, "Ngọc Linh"...) + lớp LLM-check phụ
    nếu cấu hình GUARDRAIL_LLM_MODEL (chỉ chặn thêm). Không bao giờ trả
    text chưa-check.
  - v6.1 nhãn/câu khuyến cáo do CODE chèn: chạy `check_publish` trên bản
    nháp, thiếu nhãn AI / nhãn quảng cáo / câu khuyến cáo -> nối
    `labels.ai[0]` / `labels.ad[0]` / `disclaimer.canonical + "."` đọc từ
    data/guardrail_rules.json (không chép tay, không trông LLM nhớ).
  - v6.1 template theo kênh: `data/prompts/<tên>.md`, version + sha256 ở
    `data/prompts/manifest.json` (sha trên UTF-8 sau CRLF->LF). Template
    lệch sha / thiếu / tên lạ -> ValueError (sửa template phải bump
    version). Luật TPBVSK vẫn nằm trong code (system prompt) — template
    chỉ là phần định dạng kênh. `meta.prompt_version`/`prompt_sha256` lưu
    kèm draft.
  - v6.1 precheck (thuần, 0 LLM, không ghi DB): SKU lạ / kênh lạ / rượu
    (mọi loại nội dung public) / loại có `ad: true` cho TPBVSK chưa
    QC_DAY_DU / listing ở mức CAM -> từ chối kèm lý do, KHÔNG gọi LLM.
    `draft()` không gắn SKU và loại `post` giữ nguyên hành vi v4.2.
    v6.2: `draft(content_type="image")` -> từ chối `loai_la` (0 LLM) — ảnh
    chỉ sinh qua `pipelines.image_studio` (ghép packshot thật + nhãn AI).
    v6.3: `draft(content_type="video")` -> `loai_la` (0 LLM) — video chỉ
    dựng qua `pipelines.video_studio`.
  - v6.1 listing: tên/quy cách/số ĐKSP/giá list của kênh/hạn dùng do CODE
    dựng từ golden (data/golden_skus.json) — KHÔNG BAO GIỜ đưa giá
    floor/promo. Phần chữ LLM (hook/mô tả/gạch đầu dòng/từ khóa) chỉ khi
    mức TP_THUONG/QC_DAY_DU; mọi câu/mục chứa chữ số bị loại. TPBVSK mức
    MO_TA = khung cố định, 0 lời gọi LLM. Giới hạn ký tự theo
    data/listing_rules.json (GIẢ ĐỊNH — chờ xác minh Seller Center).
  - Agent KHÔNG đăng, KHÔNG sửa listing trên sàn: output chỉ là nháp
    `pending` qua `store.save_draft` (batch chỉ lưu bản guardrail ok;
    idempotent theo (sku, kênh, prompt_version)). Module này không có
    đường chuyển trạng thái/duyệt và không gọi mạng ngoài gateway.
  - `readiness`: map `(sku_key, channel) -> mức` của view `sku_readiness`
    (caller đọc qua `store.readiness_from_db`/`store.readiness_now`) —
    None = soi gương golden file (fail-closed); map thiếu key = CAM.

  - v13.6 `daily_batch` (PL01 Marketing "Soạn 3 bài mỗi ngày theo lịch
    mùa vụ, qua kiểm duyệt trước khi trình"): chủ đề từ
    `mkt_calendar.daily_candidates`, lọc `precheck` (readiness DB), slot i
    = ứng viên hợp lệ thứ i, khóa `[daily YYYY-MM-DD #i]` đầu brief + index
    unique → retry/restart không nhân bản; thiếu chủ đề hợp lệ → báo THIẾU
    (exit 1), không soạn nội dung vi phạm cho đủ số. Người tạo cố định
    agent:mkt02 (tính năng marketing-01; rollout `tat` → exit 2, 0 LLM).

CLI:
  python -m pipelines.content --listing --sku all --channel shopee \\
      [--channel tiktok] [--by agent:mkt02] [--no-llm]
  python -m pipelines.content --daily [--date YYYY-MM-DD]
  Exit 0 khi không có `failed` (daily: đủ per_day nháp sống); 1 khi có
  `failed` / daily THIẾU / lịch hỏng; 2 khi usage sai, DB không kết nối
  được (kiểm conn TRƯỚC mọi lời gọi LLM) hoặc tính năng tắt.
"""

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from pipelines import guardrail, rollout, store
from pipelines import mkt_calendar as mc
from pipelines.guardrail_llm import check_publish_llm
from pipelines.llm_gateway import chat

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

PROMPTS_DIR = ROOT / "data" / "prompts"
LISTING_RULES = ROOT / "data" / "listing_rules.json"
CONTENT_TEMPLATES = {"facebook": "content_facebook", "tiktok": "content_tiktok",
                     "zalo": "content_zalo", "blog": "content_blog"}
LISTING_LEVELS = ("MO_TA", "TP_THUONG", "QC_DAY_DU")
LLM_LEVELS = ("TP_THUONG", "QC_DAY_DU")
DEFAULT_BY = "agent:mkt02"
# Mã từ chối precheck -> code violation guardrail tương ứng (UI hiển thị
# qua store.guardrail_lines). Mã khác (sku_la/kenh_la/loai_la/readiness/
# config) giữ nguyên làm code — code thiếu luật = critical block.
REFUSAL_CODE = {"ruou": "ruou_cam_quang_cao", "xnqc": "sku_chua_xnqc"}
_SENT_RE = re.compile(r"(?<=[.!?…])\s+")
# Phần chữ LLM của listing KHÔNG được chạm thông số (fix nghiệm thu v6.1):
# nhãn khung (giá/quy cách/ĐKSP/hạn dùng/khối lượng...), số viết bằng chữ
# (mươi/trăm/nghìn/triệu...; số nhỏ một..chín chỉ khi đi kèm đơn vị —
# "một món quà" vẫn giữ), đơn vị đo. Khớp trên NFC casefold. Ngoại lệ hẹp:
# "giá trị", "đánh giá" (không phải giá bán), "tỉ mỉ".
_SPEC_RE = re.compile(
    r"(?<!\w)(?:(?<!đánh )giá(?! trị)|quy cách|số đksp|đksp|số đăng ký"
    r"|hạn sử dụng|hạn dùng|hsd|nsx|khối lượng|trọng lượng|dung tích"
    r"|mươi|trăm|nghìn|ngàn|triệu|tỷ|tỉ(?! mỉ)|chục|rưỡi|mười"
    r"|gram|gam|kg|mg|ml|lít|lit|vnd|vnđ"
    r"|(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|nửa|đôi)\s+"
    r"(?:hũ|lọ|chai|hộp|gói|viên|củ|túi|ống|đồng|năm|tháng|ngày|tuần"
    r"|lạng|cân|cặp))(?!\w)")


def _spec_like(s: str) -> bool:
    """Câu/mục LLM chạm thông số -> True (bị loại). Ký tự số MỌI loại
    Unicode (`isnumeric`: Nd/No/Nl — ０-９, ①, ², Ⅻ) hoặc khớp `_SPEC_RE`.
    Chuẩn hóa CÙNG guardrail (fix nghiệm thu v6.1 F2): bỏ mọi ký tự Cf
    (ZWSP/soft hyphen/BOM...), NFC, `guardrail._fold` (NFKC fullwidth +
    casefold + homoglyph Cyrillic/Greek), NFC lại (ghép "а"+dấu sắc sau
    homoglyph); khớp trên bản đó VÀ bản nén bỏ ký tự chèn giữa 2 chữ cái
    (`guardrail._FILLER_RE`: "Gi.á", "g i á") — giả nhãn khung kiểu
    "Gi\\u200bá: Liên hệ" mâu thuẫn giá golden phải bị loại."""
    if any(c.isnumeric() for c in s):
        return True
    t = "".join(c for c in s if unicodedata.category(c) != "Cf")
    t = unicodedata.normalize(
        "NFC", guardrail._fold(unicodedata.normalize("NFC", t)))
    return any(_SPEC_RE.search(v) is not None
               for v in (t, guardrail._FILLER_RE.sub("", t)))


def load_template(name: str) -> tuple[str, str, str]:
    """(text, version, sha256) của template `data/prompts/<name>.md`.
    sha256 trên byte UTF-8 sau CRLF->LF; lệch manifest / thiếu file / tên
    lạ -> ValueError ("template đổi mà chưa bump version")."""
    try:
        man = json.loads((PROMPTS_DIR / "manifest.json")
                         .read_text(encoding="utf-8"))
        ent = man["templates"][name]
        ver, want = str(ent["version"]), str(ent["sha256"])
        raw = (PROMPTS_DIR / f"{name}.md").read_bytes()
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ValueError(f"template {name!r} không dùng được "
                         f"({type(e).__name__})") from e
    data = raw.replace(b"\r\n", b"\n")
    sha = hashlib.sha256(data).hexdigest()
    if sha != want:
        raise ValueError(f"template {name!r} lệch sha256 manifest — template "
                         "đổi mà chưa bump version")
    return data.decode("utf-8").strip(), ver, sha


# View đọc từ template (test cũ + prompt-library dẫn tên này).
CHANNEL_HINT = {ch: load_template(n)[0] for ch, n in CONTENT_TEMPLATES.items()}


def _whitelist_block() -> str:
    """Render claims whitelist thành đoạn nhét vào system prompt."""
    raw = json.loads(
        (ROOT / "data" / "claims_whitelist.json").read_text(encoding="utf-8"))
    lines = []
    for sku, v in raw.items():
        if not isinstance(v, dict):
            continue
        claims = v.get("approved_claims") or []
        if claims:
            lines.append(f"- {sku}: " + "; ".join(claims))
        else:
            lines.append(f"- {sku}: CHƯA CÓ công dụng công bố — không được nêu công dụng")
    return "\n".join(lines)


def _publish_texts() -> tuple[str, list[str], list[str]]:
    """(câu khuyến cáo chuẩn, nhãn AI, nhãn QC) đọc từ guardrail_rules.json
    (cùng thư mục guardrail đọc). File hỏng -> ("", [], []) — guardrail tự
    fail-closed "config" ở bước check."""
    try:
        doc = json.loads((guardrail.DATA_DIR / "guardrail_rules.json")
                         .read_text(encoding="utf-8"))
        canon = str(doc["disclaimer"]["canonical"]).strip()
        ai = [str(x) for x in doc["labels"]["ai"] if str(x).strip()]
        ad = [str(x) for x in doc["labels"]["ad"] if str(x).strip()]
    except (OSError, ValueError, KeyError, TypeError):
        return "", [], []
    return canon, ai, ad


def _with_required(text: str, *, channel, content_type, sku,
                   readiness) -> str:
    """Nối TẤT ĐỊNH câu khuyến cáo / nhãn QC / nhãn AI mà `check_publish`
    báo thiếu (`thieu_khuyen_cao` / `thieu_nhan_quang_cao` /
    `thieu_nhan_ai`) — không tốn lượt sửa LLM."""
    res = guardrail.check_publish(text, channel=channel,
                                  content_type=content_type, sku=sku,
                                  is_ai=True, readiness=readiness)
    codes = {v.get("code") for v in res.get("violations") or []}
    canon, ai, ad = _publish_texts()
    for code, piece in (("thieu_khuyen_cao", canon and canon + "."),
                        ("thieu_nhan_quang_cao", ad and ad[0]),
                        ("thieu_nhan_ai", ai and ai[0])):
        if code in codes and piece:
            text = text + "\n\n" + piece
    return text


def _cfg():
    """Cấu hình guardrail đã validate (rules + golden) — CÙNG nguồn với
    `check_publish` (guardrail.DATA_DIR). Lỗi -> (None, lý do)."""
    return guardrail._load_rules(guardrail.DATA_DIR)


def _level(cfg, sku, channel, readiness) -> str:
    if readiness is not None:
        return str(readiness.get((sku, channel), "CAM"))
    return guardrail._readiness_of(cfg["golden"].get(sku), channel)


def precheck(sku, channel, content_type, *, readiness=None) -> dict | None:
    """Từ chối TRƯỚC khi gọi LLM/ghi DB -> {"code", "reason"}; None = được
    sinh. Code: config | loai_la | sku_la | kenh_la | ruou | readiness |
    xnqc. Rượu kiểm theo category golden TRƯỚC readiness (map bị sửa thành
    QC_DAY_DU vẫn từ chối)."""
    cfg, err = _cfg()
    if err:
        return {"code": "config", "reason": err}
    ctype = (cfg["content_types"].get(content_type)
             if isinstance(content_type, str) else None)
    if not isinstance(ctype, dict):
        return {"code": "loai_la",
                "reason": f"loại nội dung lạ: {str(content_type)[:40]!r}"}
    if readiness is not None and not isinstance(readiness, dict):
        return {"code": "config", "reason": "readiness không phải map"}
    if sku is not None and (not isinstance(sku, str)
                            or sku not in cfg["golden"]):
        return {"code": "sku_la",
                "reason": f"SKU {str(sku)[:60]!r} không có trong golden"}
    listing = content_type == "listing"
    if listing:
        rules, rerr = _listing_rules()
        if rerr:
            return {"code": "config", "reason": rerr}
        ok_ch = channel in rules["channels"]
    else:
        if isinstance(channel, str):
            channel = cfg["channel_alias"].get(channel, channel)
        ok_ch = channel in cfg["channels"]
    if not ok_ch:
        return {"code": "kenh_la",
                "reason": f"kênh {str(channel)[:40]!r} không hỗ trợ cho "
                          f"{content_type}"}
    if sku is None:
        return ({"code": "sku_la", "reason": "listing cần SKU"}
                if listing else None)
    g = cfg["golden"][sku]
    if g.get("category") == "alcohol" and ctype.get("public", True):
        return {"code": "ruou",
                "reason": f"{sku} là rượu — cấm quảng cáo/khuyến mại rượu "
                          "(Luật 44/2019), không sinh nội dung/listing online"}
    level = _level(cfg, sku, channel, readiness)
    if listing and level not in LISTING_LEVELS:
        return {"code": "readiness",
                "reason": f"{sku} mức {level} trên kênh {channel} — chưa đủ "
                          "điều kiện listing (golden allowed_channels / "
                          "XNQC / tự công bố)"}
    if ctype.get("ad") and g.get("category") == "tpbvsk" \
            and level != "QC_DAY_DU":
        return {"code": "xnqc",
                "reason": f"{sku} mức {level} trên kênh {channel} — TPBVSK "
                          "chưa có XNQC, không được làm nội dung quảng cáo"}
    return None


def _refused_guardrail(ref: dict) -> dict:
    base = {"ok": False, "violations": [], "matched_claims": [],
            "warnings": [], "skus": [], "required_labels": []}
    return guardrail.with_violation(
        base, REFUSAL_CODE.get(ref["code"], ref["code"]),
        f"từ chối ({ref['code']}): {ref['reason']}")


def _system(fmt: str, *, price_rule: bool = True) -> str:
    """System prompt. Listing (`price_rule=False`) bỏ dòng "Không bịa giá
    ... ghi Liên hệ" — giá listing do CODE dựng từ golden, câu đó chỉ
    xúi LLM tự viết giá (fix nghiệm thu v6.1)."""
    canon, ai, _ = _publish_texts()
    price = ('- Không bịa giá — sản phẩm không có giá công khai thì ghi '
             '"Liên hệ".' if price_rule else
             '- KHÔNG viết giá, quy cách, khối lượng, hạn dùng hay bất kỳ '
             'con số nào (kể cả viết bằng chữ) — hệ thống tự điền.')
    ai_label = ai[0] if ai else "Nội dung có sử dụng AI"
    return f"""Bạn là copywriter của Công ty TNHH Sâm Sâm (Quảng Nam). Giọng
điệu: tự hào đặc sản quê hương, tử tế, không phóng đại. Viết {fmt}.

LUẬT TPBVSK — vi phạm là bài bị loại:
- CHỈ được nêu công dụng nằm trong whitelist dưới đây của ĐÚNG sản phẩm,
  dùng gần nguyên văn:
{_whitelist_block()}
- Câu trang trí TUYỆT ĐỐI không chứa động từ claim (giúp/hỗ trợ/bồi bổ/
  giảm/tăng cường/cải thiện/tốt cho/phòng ngừa) — những từ đó chỉ xuất
  hiện trong cụm claim whitelist. Mở bài/kết bài chỉ kể chuyện thương
  hiệu, đặc sản quê hương, quà tặng.
- Sản phẩm không có claim -> chỉ giới thiệu, không nêu công dụng.
- Khi nêu công dụng hoặc nhắc sản phẩm TPBVSK, kết bài bằng câu khuyến
  cáo NGUYÊN VĂN (không sửa chữ nào): "{canon}."
- Không dùng tên vùng chỉ dẫn địa lý "Ngọc Linh" (không dùng — chờ Pháp
  chế xác nhận quyền sử dụng chỉ dẫn địa lý cho từng sản phẩm).
- Bài đăng có nhãn "{ai_label}" ở cuối (hệ thống tự thêm nếu thiếu).
- TUYỆT ĐỐI cấm các từ dùng theo nghĩa khẳng định: chữa, điều trị, thuốc,
  khỏi bệnh, trị bệnh, đặc trị, thần dược, tiêu diệt, chống ung thư.
{price}
- TRƯỚC KHI XUẤT: rà từng câu — câu nào chứa động từ claim (giúp, hỗ trợ,
  giảm, bồi bổ, tăng cường, cải thiện, tốt cho, phòng ngừa, góp phần) mà
  không phải cụm claim whitelist nguyên văn thì VIẾT LẠI câu đó.
"""


def _feedback(result: dict) -> str:
    detail = "; ".join(f"{v.get('code') or v.get('type')}: "
                       f"{v.get('span') or v.get('detail')}"
                       for v in result["violations"])
    return (f"Bài vi phạm guardrail: {detail}. Viết lại — chỉ dùng claim "
            "whitelist nguyên văn, câu trang trí không chứa động từ claim.")


def _feature(content_type: str) -> str:
    """Mã tính năng sở hữu nháp loại này (trần/nút tắt chi phí theo tính
    năng — PL01 Cổng AI an toàn): theo nguồn đầu ra content_drafts của danh
    mục; loại chưa có mục riêng → nội dung hằng ngày (marketing-01.1)."""
    from pipelines import rollout  # lười: rollout → director → ...
    return rollout.feature_for(table="content_drafts", created_by="agent:mkt02",
                               content_type=content_type) or "marketing-01.1"


def draft(brief: str, channel: str = "facebook", *,
          readiness: dict | None = None, sku: str | None = None,
          content_type: str = "post") -> dict:
    """Sinh draft theo brief -> qua guardrail đăng bài (kênh/loại/SKU,
    readiness DB nếu caller truyền) -> {"text", "guardrail", "meta"}.
    Gắn SKU hoặc loại khác `post` -> precheck trước (từ chối = 0 LLM)."""
    fmt, ver, sha = load_template(
        CONTENT_TEMPLATES.get(channel, CONTENT_TEMPLATES["facebook"]))
    meta = {"content_type": content_type, "sku": sku, "is_ai": True,
            "prompt_version": ver, "prompt_sha256": sha, "refused": None}
    if content_type == "image":
        # v6.2: nháp ảnh PHẢI có file ảnh (packshot thật ghép + nhãn AI) —
        # draft() chỉ sinh chữ, không được tạo nháp "image" không-có-ảnh.
        ref = {"code": "loai_la", "reason": "ảnh đi qua pipelines."
               "image_studio (ghép packshot thật) — draft() không sinh "
               "nháp ảnh"}
        return {"text": "", "guardrail": _refused_guardrail(ref),
                "meta": {**meta, "refused": ref}}
    if content_type == "video":
        # v6.3: nháp video PHẢI có file mp4 (khung packshot thật + nhãn AI
        # mọi khung) — draft() chỉ sinh chữ, không tạo nháp video không-video.
        ref = {"code": "loai_la", "reason": "video đi qua pipelines."
               "video_studio (dựng từ packshot thật) — draft() không sinh "
               "nháp video"}
        return {"text": "", "guardrail": _refused_guardrail(ref),
                "meta": {**meta, "refused": ref}}
    if sku is not None or content_type != "post":
        ref = precheck(sku, channel, content_type, readiness=readiness)
        if ref:
            return {"text": "", "guardrail": _refused_guardrail(ref),
                    "meta": {**meta, "refused": ref}}
    user = f"BRIEF: {brief}"
    if sku is not None:
        cfg, _ = _cfg()
        user += f"\nSẢN PHẨM: {cfg['golden'][sku]['name']} (mã {sku})"
    messages = [{"role": "system", "content": _system(fmt)},
                {"role": "user", "content": user}]
    ctx = {"channel": channel, "content_type": content_type, "sku": sku,
           "readiness": readiness}
    for _ in range(2):  # draft -> check; vi phạm -> 1 lượt sửa có feedback
        resp = chat("content", messages, temperature=0.3, max_tokens=600,
                    feature=_feature(content_type))
        text = _with_required(
            (resp.choices[0].message.content or "").strip(), **ctx)
        result = check_publish_llm(text, is_ai=True, **ctx)
        if result["ok"]:
            break
        messages += [{"role": "assistant", "content": text},
                     {"role": "user", "content": _feedback(result)}]
    return {"text": text, "guardrail": result, "meta": meta}


def draft_multi(brief: str, channels, *, readiness: dict | None = None,
                sku: str | None = None, content_type: str = "post") -> dict:
    """Sinh draft cho nhiều kênh → {channel: {"text","guardrail","meta"}}.

    Mỗi kênh qua `draft()` riêng — guardrail check độc lập từng bài
    (invariant). Kênh lạ vẫn được draft() (fallback hint facebook như
    draft() hiện). Trùng kênh trong `channels` tự gộp (giữ thứ tự)."""
    if isinstance(channels, str):
        channels = [channels]
    return {ch: draft(brief, ch, readiness=readiness, sku=sku,
                      content_type=content_type)
            for ch in dict.fromkeys(channels)}


# ---------------------------------------------------------------- listing

def _listing_rules() -> tuple[dict | None, str | None]:
    """data/listing_rules.json đã validate -> (rules, None) | (None, lý do)."""
    try:
        doc = json.loads(LISTING_RULES.read_text(encoding="utf-8"))
        chans = {}
        for ch, d in doc["channels"].items():
            lim = {k: int(d[k]) for k in ("title_max", "desc_max",
                                          "bullets_max", "keywords_max")}
            if min(lim.values()) < 1:
                raise ValueError(f"giới hạn kênh {ch} < 1")
            chans[str(ch)] = lim
        rules = {"channels": chans,
                 "missing_price": str(doc["missing_price"]),
                 "missing_attr": str(doc["missing_attr"]),
                 "brand_keywords": [str(x) for x in doc["brand_keywords"]
                                    if str(x).strip()]}
        if not chans or not rules["missing_price"].strip() \
                or not rules["missing_attr"].strip():
            raise ValueError("thiếu kênh / missing_price / missing_attr")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        return None, f"listing_rules.json không dùng được ({type(e).__name__})"
    return rules, None


def _vnd(v: int) -> str:
    return f"{v:,}".replace(",", ".") + " đ"


def listing_fields(sku: str, channel: str) -> dict:
    """Thông số listing render từ golden — KHÔNG đi qua LLM. Giá = `list`
    của kênh (không bao giờ floor/promo); thiếu -> missing_price. Số ĐKSP
    chỉ TPBVSK (None -> bỏ dòng). Hạn dùng: golden chưa có field ->
    missing_attr (khối lượng nằm trong pack_spec)."""
    cfg, _ = _cfg()
    rules, _ = _listing_rules()
    g = cfg["golden"][sku]
    p = (g.get("prices") or {}).get(channel)
    lp = p.get("list") if isinstance(p, dict) else None
    ok_price = isinstance(lp, int) and not isinstance(lp, bool) and lp > 0
    return {"name": g["name"], "pack_spec": g.get("pack_spec"),
            "receipt_no": (g.get("receipt_no")
                           if g.get("category") == "tpbvsk" else None),
            "price": _vnd(lp) if ok_price else rules["missing_price"],
            "han_dung": rules["missing_attr"]}


def _one_line(s) -> str:
    return " ".join(s.split()) if isinstance(s, str) else ""


def _cut_words(s: str, n: int) -> str:
    """Cắt theo từ để len ≤ n (bỏ dấu nối thừa ở cuối)."""
    if len(s) <= n:
        return s
    return s[:n + 1].rsplit(" ", 1)[0][:n].rstrip(" ,;:–-")


def _parse_llm(content) -> dict | None:
    """JSON chặt {"hook": str, "description": str, "bullets": [str],
    "keywords": [str]} (bỏ 1 lớp code-fence). Sai shape -> None."""
    if not isinstance(content, str):
        return None
    s = content.strip()
    m = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1)
    try:
        obj = json.loads(s)
    except ValueError:
        return None
    if not (isinstance(obj, dict) and isinstance(obj.get("hook"), str)
            and isinstance(obj.get("description"), str)
            and isinstance(obj.get("bullets"), list)
            and isinstance(obj.get("keywords"), list)
            and all(isinstance(x, str) for x in obj["bullets"])
            and all(isinstance(x, str) for x in obj["keywords"])):
        return None
    return obj


def _clean_llm(obj: dict, lim: dict) -> dict:
    """Phần LLM sau lọc: gộp khoảng trắng về 1 dòng (không giả được dòng
    'Giá:'/'Quy cách:' của khung), loại câu/bullet/từ khóa/hook chạm
    thông số (`_spec_like`), cắt theo giới hạn kênh."""
    hook = _one_line(obj["hook"])
    desc, total = [], 0
    for sent in _SENT_RE.split(_one_line(obj["description"])):
        if not sent or _spec_like(sent):
            continue
        if total + len(sent) + 1 > lim["desc_max"]:
            break
        desc.append(sent)
        total += len(sent) + 1
    return {"hook": "" if _spec_like(hook) else hook,
            "description": " ".join(desc),
            "bullets": [b for b in map(_one_line, obj["bullets"])
                        if b and not _spec_like(b)][:lim["bullets_max"]],
            "keywords": [k for k in map(_one_line, obj["keywords"])
                         if k and not _spec_like(k)]}


def _render(fields: dict, lim: dict, brand_kw: list[str],
            part: dict | None) -> str:
    """Khung listing (code, số liệu golden) + phần chữ LLM đã lọc (nếu có)."""
    part = part or {"hook": "", "description": "", "bullets": [],
                    "keywords": []}
    title = fields["name"]
    if part["hook"]:
        hooked = _cut_words(f"{title} – {part['hook']}", lim["title_max"])
        if len(hooked) > len(title) + 3:
            title = hooked
    out = [title]
    if part["description"]:
        out += ["", part["description"]]
    if part["bullets"]:
        out += ["", "Đặc điểm nổi bật:"] + [f"- {b}" for b in part["bullets"]]
    out += ["", "Thông tin sản phẩm:", f"Tên sản phẩm: {fields['name']}"]
    if fields["pack_spec"]:
        out.append(f"Quy cách: {fields['pack_spec']}")
    if fields["receipt_no"]:
        out.append(f"Số ĐKSP: {fields['receipt_no']}")
    out += [f"Giá: {fields['price']}", f"Hạn sử dụng: {fields['han_dung']}"]
    seen, kws = set(), []
    for k in [fields["name"], *brand_kw, *part["keywords"]]:
        key = unicodedata.normalize("NFC", k).casefold()
        if key not in seen:
            seen.add(key)
            kws.append(k)
    out += ["", "Từ khóa: " + ", ".join(kws[:lim["keywords_max"]])]
    return "\n".join(out)


def _listing_messages(fmt: str, fields: dict, sku: str, level: str) -> list:
    kind = ("thực phẩm thường — KHÔNG nêu bất kỳ công dụng sức khỏe nào, chỉ"
            " cảm quan/nguồn gốc/cách dùng chung" if level == "TP_THUONG"
            else "TPBVSK đã có XNQC — chỉ claim whitelist nguyên văn")
    return [{"role": "system", "content": _system(fmt, price_rule=False)},
            {"role": "user", "content": f"SẢN PHẨM: {fields['name']} (mã "
                                        f"{sku}) — {kind}."}]


def listing(sku: str, channel: str, *, readiness: dict | None = None,
            llm: bool = True) -> dict:
    """Listing chuẩn theo kênh cho 1 SKU -> {"ok", "refused", "text",
    "fields", "guardrail", "meta"} (meta.llm_part ∈ none|used|
    dropped:<lý do>). Từ chối (precheck) = 0 LLM, text rỗng."""
    meta = {"content_type": "listing", "sku": sku, "is_ai": True,
            "prompt_version": None, "prompt_sha256": None, "refused": None,
            "llm_part": "none"}
    ref = precheck(sku, channel, "listing", readiness=readiness)
    fields = None
    if ref is None:
        fmt, meta["prompt_version"], meta["prompt_sha256"] = \
            load_template(f"listing_{channel}")
        rules, _ = _listing_rules()
        lim = rules["channels"][channel]
        fields = listing_fields(sku, channel)
        if len(fields["name"]) > lim["title_max"]:
            ref = {"code": "config",
                   "reason": f"tên SKU dài hơn title_max {lim['title_max']} "
                             f"của kênh {channel} — sửa golden/listing_rules"}
    if ref is not None:
        return {"ok": False, "refused": ref, "text": "", "fields": fields,
                "guardrail": _refused_guardrail(ref),
                "meta": {**meta, "refused": ref}}

    cfg, _ = _cfg()
    level = _level(cfg, sku, channel, readiness)
    ctx = {"channel": channel, "content_type": "listing", "sku": sku,
           "readiness": readiness}

    def finish(part):
        text = _with_required(_render(fields, lim, rules["brand_keywords"],
                                      part), **ctx)
        return text, check_publish_llm(text, is_ai=True, **ctx)

    if llm and level in LLM_LEVELS:
        messages = _listing_messages(fmt, fields, sku, level)
        for _ in range(2):  # 1 lượt sửa có feedback
            try:
                resp = chat("content", messages, temperature=0.3,
                            max_tokens=700, feature="sales-03")
                content = resp.choices[0].message.content
            except Exception as e:  # noqa: BLE001 — lỗi LLM -> khung thuần
                meta["llm_part"] = f"dropped:{type(e).__name__}"
                break
            obj = _parse_llm(content)
            if obj is None:
                meta["llm_part"] = "dropped:parse"
                break
            text, res = finish(_clean_llm(obj, lim))
            if res.get("ok") is True:
                meta["llm_part"] = "used"
                return {"ok": True, "refused": None, "text": text,
                        "fields": fields, "guardrail": res, "meta": meta}
            meta["llm_part"] = "dropped:guardrail"
            messages += [{"role": "assistant", "content": content},
                         {"role": "user", "content": _feedback(res)
                          + " Trả lại DUY NHẤT JSON đúng mẫu."}]
    text, res = finish(None)
    return {"ok": res.get("ok") is True, "refused": None, "text": text,
            "fields": fields, "guardrail": res, "meta": meta}


_EXISTING_SQL = (
    "select id from content_drafts where content_type = 'listing' "
    "and sku = %s and channel = %s and prompt_version = %s "
    "and status <> 'rejected' order by id limit 1")


def _existing(conn, sku, channel, version):
    row = conn.execute(_EXISTING_SQL, (sku, channel, version)).fetchone()
    return row[0] if row else None


def listing_batch(conn, skus, channels, *, by: str,
                  readiness: dict | None = None, llm: bool = True) -> list:
    """Listing cho mọi cặp (sku, kênh) -> list {"sku", "channel", "status",
    ...}: created (+id) | skipped (+id — đã có nháp listing sống cùng
    sku/kênh/prompt_version, kiểm TRƯỚC khi gọi LLM; UniqueViolation lúc
    INSERT do batch song song cũng = skipped) | refused (+code/reason) |
    failed (+codes — guardrail không ok, KHÔNG ghi, chạy lại được). Chỉ
    ghi nháp pending qua `store.save_draft` (source cli; save_draft ghi
    trong savepoint/transaction riêng -> vi phạm unique không làm hỏng
    conn)."""
    if readiness is None:
        readiness = store.readiness_from_db(conn)
    out = []
    for sku in dict.fromkeys(skus):
        for ch in dict.fromkeys(channels):
            item = {"sku": sku, "channel": ch}
            ref = precheck(sku, ch, "listing", readiness=readiness)
            if ref:
                out.append({**item, "status": "refused", **ref})
                continue
            _, ver, _ = load_template(f"listing_{ch}")
            did = _existing(conn, sku, ch, ver)
            if did is not None:
                out.append({**item, "status": "skipped", "id": did})
                continue
            r = listing(sku, ch, readiness=readiness, llm=llm)
            if r["refused"]:
                out.append({**item, "status": "refused", **r["refused"]})
                continue
            if r["guardrail"].get("ok") is not True:
                out.append({**item, "status": "failed", "codes": [
                    str(v.get("code")) for v in
                    r["guardrail"].get("violations") or []]})
                continue
            m = r["meta"]
            try:
                did = store.save_draft(
                    conn, f"listing {sku} {ch}", ch, r["text"],
                    r["guardrail"], store.SOURCE_CLI, created_by=by,
                    content_type="listing", sku=sku, is_ai=True,
                    prompt_version=m["prompt_version"],
                    prompt_sha256=m["prompt_sha256"])
            except psycopg.errors.UniqueViolation:
                out.append({**item, "status": "skipped",
                            "id": _existing(conn, sku, ch, ver)})
                continue
            out.append({**item, "status": "created", "id": did,
                        "llm_part": m["llm_part"]})
    return out


# ------------------------------------------------- v13.6 3 nháp bài/ngày

# Khóa slot ở ĐẦU brief: "[daily YYYY-MM-DD #N]" (21 ký tự, N 1..9). Index
# unique `content_drafts_daily_key_idx` (docs/schema.sql v13.6) trên
# left(brief, 21) của nháp sống (≠ rejected) do DEFAULT_BY tạo → retry/
# restart/2 tiến trình song song không nhân bản; bản bị từ chối thì slot
# soạn lại được (cùng luật index listing).
DAILY_KEY_LEN = 21
DAILY_WHAT = "nháp bài hằng ngày"
_DAILY_EXISTING_SQL = (
    "select left(brief, 21), id from content_drafts where created_by = %s"
    " and content_type = 'post' and status <> 'rejected' and brief like %s")


def daily_key(day, slot: int) -> str:
    key = f"[daily {day.isoformat()} #{int(slot)}]"
    if len(key) != DAILY_KEY_LEN:
        raise ValueError(f"slot phải 1..{mc.DAILY_MAX}")
    return key


def _daily_brief(c: dict) -> str:
    if c["kind"] == "campaign":
        s = (f"Chiến dịch {c['ref']} — {c['pillar']}. Bài đăng ngày "
             f"{c['publish_day']:%d/%m/%Y}.")
    else:
        s = f"Bài thường ngày ({c['ref']}) — {c['pillar']}."
    return s + (f" ({c['note']})" if c.get("note") else "")


def daily_batch(conn, day, *, readiness: dict | None = None,
                inputs=None) -> dict:
    """Soạn tối đa `per_day` (HĐ: 3) nháp bài cho ngày VN `day` theo lịch
    mùa vụ (`mkt_calendar.daily_candidates`) → {"day", "per_day", "items",
    "refused", "overflow", "live", "missing", "reasons"}.

    - Tính năng (`rollout.feature_for` content_drafts/agent:mkt02/post) đang
      `tat` → `rollout.RolloutBlocked` TRƯỚC mọi lời gọi LLM.
    - Ứng viên lọc bằng `precheck` (readiness DB, fail-closed) — bị từ chối
      thì ghi `refused` với lý do, KHÔNG soạn nội dung vi phạm cho đủ số.
      Ứng viên hợp lệ thứ i → slot i.
    - Slot đã có nháp sống (khóa `daily_key`) → `skipped`, 0 LLM. Guardrail
      không ok / lỗi LLM → `failed`, KHÔNG ghi (chạy lại được). Ghi qua
      `store.save_draft` (pending, người duyệt — agent không đăng).
    - `live` = số slot có nháp sống sau lần chạy; `missing` = per_day −
      live (thiếu đầu vào hoặc failed) — không đếm quota duyệt làm "đã đủ"."""
    by = DEFAULT_BY
    fid = rollout.feature_for(table="content_drafts", created_by=by,
                              content_type="post")
    rollout.check_generate(conn, fid, DAILY_WHAT)
    cal, golden, sla = inputs if inputs is not None else mc.load_inputs()
    dc = mc.daily_candidates(cal, golden, day, sla)
    n = dc["per_day"]
    if readiness is None:
        readiness = store.readiness_from_db(conn)
    valid, refused = [], []
    for c in dc["candidates"]:
        ref = ({"code": "readiness", "reason": c["reason"]} if c["reason"]
               else precheck(c["sku"], c["channel"], "post",
                             readiness=readiness))
        if ref:
            refused.append({**c, **ref})
        else:
            valid.append(c)
    overflow = [c for c in valid[n:] if c["kind"] == "campaign"]
    existing = dict(conn.execute(
        _DAILY_EXISTING_SQL, (by, f"[daily {day.isoformat()} #%")).fetchall())
    conn.commit()   # không giữ tx mở trong lúc chờ LLM
    items = []
    for i in range(1, n + 1):
        key = daily_key(day, i)
        if key in existing:
            items.append({"slot": i, "status": "skipped",
                          "id": existing[key]})
            continue
        if i > len(valid):
            continue
        c = valid[i - 1]
        it = {"slot": i, "kind": c["kind"], "ref": c["ref"],
              "channel": c["channel"], "sku": c["sku"]}
        brief = _daily_brief(c)
        try:
            r = draft(brief, c["channel"], readiness=readiness, sku=c["sku"],
                      content_type="post")
        except psycopg.Error:
            raise
        except Exception as e:  # noqa: BLE001 — gateway chặn/lỗi → failed
            items.append({**it, "status": "failed",
                          "codes": [f"llm:{type(e).__name__}"]})
            continue
        if r["meta"]["refused"]:
            items.append({**it, "status": "refused", **r["meta"]["refused"]})
            continue
        if r["guardrail"].get("ok") is not True:
            items.append({**it, "status": "failed", "codes": [
                str(v.get("code")) for v in
                r["guardrail"].get("violations") or []]})
            continue
        m = r["meta"]
        try:
            did = store.save_draft(
                conn, f"{key} {brief}", c["channel"], r["text"],
                r["guardrail"], store.SOURCE_CLI, created_by=by,
                content_type="post", sku=c["sku"], is_ai=True,
                prompt_version=m["prompt_version"],
                prompt_sha256=m["prompt_sha256"])
        except psycopg.errors.UniqueViolation:
            row = conn.execute(_DAILY_EXISTING_SQL,
                               (by, key[:-1] + "%")).fetchone()
            conn.commit()
            items.append({**it, "status": "skipped",
                          "id": row[1] if row else None})
            continue
        items.append({**it, "status": "created", "id": did})
    live = sum(it["status"] in ("created", "skipped") for it in items)
    reasons = []
    if len(valid) < n:
        reasons.append(f"chỉ {len(valid)}/{n} chủ đề hợp lệ theo lịch mùa vụ"
                       " — xem danh sách bị từ chối")
    n_fail = sum(it["status"] in ("failed", "refused") for it in items)
    if n_fail:
        reasons.append(f"{n_fail} slot soạn không đạt (guardrail/LLM) —"
                       " chạy lại để soạn lại")
    return {"day": day, "per_day": n, "items": items, "refused": refused,
            "overflow": overflow, "live": live, "missing": n - live,
            "reasons": reasons if n - live else []}


def _fmt_daily(it: dict) -> str:
    head = f"#{it['slot']} "
    if it["status"] == "skipped":
        return head + f"skipped (đã có nháp #{it['id']})"
    head += f"{it['kind']}:{it['ref']} × {it['channel']}"
    head += f" [{it['sku']}]: " if it.get("sku") else ": "
    if it["status"] == "created":
        return head + f"created #{it['id']}"
    if it["status"] == "refused":
        return head + f"refused {it['code']}: {it['reason']}"
    return head + "failed: " + ", ".join(it.get("codes") or ["?"])


def _daily_main(day) -> int:
    with store._conn_or_none() as (conn, err):
        if conn is None:  # DB chết → exit 2, 0 lời gọi LLM
            print(f"[error] {err} — không ghi được nháp", file=sys.stderr)
            return 2
        try:
            res = daily_batch(conn, day)
        except rollout.RolloutBlocked as e:
            print(f"[blocked] {e}", file=sys.stderr)
            return 2
        except mc.CalendarError as e:
            print(f"[error] lịch mùa vụ: {e}", file=sys.stderr)
            return 1
        except psycopg.Error as e:
            print(f"[error] lỗi DB: {store._db_msg(e)}", file=sys.stderr)
            return 2
    print(f"# Nháp bài ngày {day:%d/%m/%Y} — cần {res['per_day']}/ngày "
          "(PL01 Marketing)")
    for it in res["items"]:
        print(_fmt_daily(it))
    for c in res["refused"]:
        sku = f" [{c['sku']}]" if c.get("sku") else ""
        print(f"[bị từ chối] {c['kind']}:{c['ref']} × {c['channel']}{sku}: "
              f"{c['code']} — {c['reason']}")
    for c in res["overflow"]:
        print(f"[vượt {res['per_day']}/ngày] chiến dịch {c['ref']} ×"
              f" {c['channel']} — GĐ Marketing quyết dời/thêm")
    if res["missing"]:
        print(f"[THIẾU] {res['missing']}/{res['per_day']} nháp: "
              + "; ".join(res["reasons"]))
    print(f"[done] {res['live']}/{res['per_day']} nháp sống cho ngày "
          f"{day.isoformat()} (pending — GĐ Marketing duyệt ở tab 'Duyệt &"
          " Lịch', người đăng tay; agent không đăng)")
    return 1 if res["missing"] else 0


def _fmt_item(it: dict) -> str:
    head = f"{it['sku']} × {it['channel']}: "
    if it["status"] in ("created", "skipped"):
        return head + f"{it['status']} #{it['id']}"
    if it["status"] == "refused":
        return head + f"refused {it['code']}: {it['reason']}"
    return head + "failed: " + ", ".join(it.get("codes") or ["?"])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.content",
        description="Sinh NHÁP listing theo SKU × kênh vào hàng duyệt "
                    "(pending) — agent KHÔNG đăng, KHÔNG sửa listing trên sàn")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--listing", action="store_true",
                      help="sinh listing SKU × kênh")
    mode.add_argument("--daily", action="store_true",
                      help="v13.6: soạn 3 nháp bài/ngày theo lịch mùa vụ")
    ap.add_argument("--date", type=mc._date_arg,
                    help="--daily: ngày YYYY-MM-DD (mặc định hôm nay VN)")
    ap.add_argument("--sku", action="append", default=[],
                    help="sku_key golden, lặp được; 'all' = mọi SKU golden")
    ap.add_argument("--channel", action="append", default=[],
                    choices=["shopee", "tiktok", "web"],
                    help="kênh listing, lặp được")
    ap.add_argument("--by", default=None,
                    help=f"--listing: người/agent tạo nháp (mặc định "
                         f"{DEFAULT_BY})")
    ap.add_argument("--no-llm", action="store_true",
                    help="--listing: chỉ khung golden, không gọi LLM")
    args = ap.parse_args(argv)
    if args.daily:
        if args.sku or args.channel or args.by is not None or args.no_llm:
            ap.error("--daily không nhận --sku/--channel/--by/--no-llm "
                     f"(người tạo cố định {DEFAULT_BY})")
        return _daily_main(args.date or datetime.now(store.VN_TZ).date())
    if not args.listing:
        ap.error("cần --listing hoặc --daily")
    if args.date is not None:
        ap.error("--date chỉ dùng với --daily")
    args.by = DEFAULT_BY if args.by is None else args.by
    if not args.sku or not args.channel:
        ap.error("cần ít nhất 1 --sku và 1 --channel")
    if not args.by.strip():
        ap.error("--by không được rỗng")
    skus = list(args.sku)
    if "all" in skus:
        cfg, err = _cfg()
        if err:
            print(f"[error] {err}", file=sys.stderr)
            return 2
        skus = [s for s in skus if s != "all"] + list(cfg["golden"])

    with store._conn_or_none() as (conn, err):
        if conn is None:  # ghi-tác-vụ: DB chết -> exit 2, 0 lời gọi LLM
            print(f"[error] {err} — không ghi được nháp", file=sys.stderr)
            return 2
        # r12 RB: listing tắt → chặn trước mọi lời gọi LLM/ghi nháp.
        why = rollout.blocked(conn, "listing", fid="sales-03")
        if why:
            return rollout.say_blocked(why)
        try:
            items = listing_batch(conn, skus, args.channel,
                                  by=args.by.strip(), llm=not args.no_llm)
        except psycopg.Error as e:
            print(f"[error] lỗi DB: {store._db_msg(e)}", file=sys.stderr)
            return 2
    for it in items:
        print(_fmt_item(it))
    n = {k: sum(it["status"] == k for it in items)
         for k in ("created", "skipped", "refused", "failed")}
    print(f"[done] {len(items)} cặp — created {n['created']}, skipped "
          f"{n['skipped']}, refused {n['refused']}, failed {n['failed']} "
          "(nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải "
          "lên sàn tay)")
    return 1 if n["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
