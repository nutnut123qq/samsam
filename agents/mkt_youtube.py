"""v10.1 MKT-12 (WP16) — gói video YouTube dài NHÁP + bản xem trước Shorts.

`write_package(brief, *, readiness=None)` → {"ok", "refused", "error",
"title", "description", "chapters", "segments", "srt", "shorts", "dropped",
"guardrail", "meta", "text", "llm_calls", "prompt_version",
"prompt_sha256"}:
  - Từ chối TRƯỚC LLM (0 lời gọi): brief rỗng/> 500 ký tự (`brief_cam`) |
    nhắc rượu (`ruou`) | `video_studio.check_brief` (từ cấm kịch bản, sức
    khỏe/bệnh, guardrail → `brief_cam`).
  - LLM (gateway agent `mkt_youtube`, cap tháng) trả JSON {title,
    description, segments[{title, text, visual, duration_s}], shorts[{
    segments: [idx], title}]}. Câu chạm số/giá (`content._spec_like`), từ
    cấm kịch bản (`script_banned` của video_studio), nhắc rượu → BỎ.
    Σ duration_s ∉ [300, 900] → `thoi_luong`; < 3 phần/phần < 10 giây /
    JSON sai mẫu → `kich_ban`.
  - CODE dựng tất định: chương (mốc cộng dồn, dòng đầu 00:00), phụ đề SRT
    (1 cue/phần), mô tả = mô tả LLM + chương + câu khuyến cáo (khi nhắc
    TPBVSK) + nhãn AI + nhãn QC; `meta.privacyStatus` là HẰNG "private"
    (không tham số đổi — chuyển chế độ hiển thị là việc của NGƯỜI role mxh
    trên YouTube Studio, external-dep).
  - Toàn văn qua `check_publish(channel='youtube' → alias web,
    content_type='video', is_ai=True)` → 1 lượt sửa có feedback → còn vi
    phạm → `kich_ban`.
`save_package(conn, pkg)` → `store.save_draft(channel='youtube',
content_type='video', created_by='agent:mkt12')` pending.
`render_shorts(pkg, *, broll_dir, out_dir, conn=None, draft_id=None)`:
TÁI DÙNG video_studio (`find_ffmpeg`, `_brolls`, `_broll_frame`, `_encode`,
`_extract_frame`, `label_visible`) — khung 9:16 từ B-roll CÓ license, tiêu
đề phần + nhãn AI/QC trên MỌI khung, 15–45 giây, không track âm thanh,
không metadata; kiểm nhãn trên 3 khung trích từ mp4 → `<out>/<sha256>.mp4`
+ sidecar `.json` + 1 dòng `agent_action_log` `youtube_short_render`.
KHÔNG ghi `video_assets` (bảng đó bắt buộc sku/packshot). Không B-roll
license → `broll_thieu`; không ffmpeg → `ffmpeg_thieu` (gói kịch bản vẫn
lưu). Module KHÔNG có đường đăng lên YouTube (tài khoản kênh + API =
external-dep).

CLI: python -m agents.mkt_youtube --brief "..." [--render] [--dry-run]
     [--broll-dir D] [--out-dir D]
Exit: 0 ok · 1 từ chối/lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect
from pipelines import content, guardrail, kb_filter, store
from pipelines import image_studio as ims
from pipelines import video_studio as vs
from pipelines.llm_gateway import chat
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

TEMPLATE = "youtube_long"
AGENT = "mkt_youtube"
CHANNEL = "youtube"
CONTENT_TYPE = "video"
CREATED_BY = "agent:mkt12"
PRIVACY = "private"
SIDECAR_SCHEMA = "youtube_short@1"
FMT = "9:16"
MAX_BRIEF = 500
MAX_TEXT = 600
TOTAL_S = (300, 900)
SEG_S = (10, 600)
MIN_SEGMENTS = 3
MAX_SEGMENTS = 12
MAX_SHORTS = 3
SHORT_S = (15, 45)
MAX_SHORT_SEGS = 3
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
_SENT_RE = re.compile(r"(?<=[.!?…])\s+")


def ts_chapter(s: int) -> str:
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def ts_srt(s: int) -> str:
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d},000"


def _parse(text) -> dict | None:
    if not isinstance(text, str):
        return None
    s = text.strip()
    m = _FENCE_RE.fullmatch(s)
    try:
        obj = json.loads(m.group(1) if m else s)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    segs = obj.get("segments")
    if not (isinstance(segs, list) and all(
            isinstance(x, dict) and isinstance(x.get("title"), str)
            and isinstance(x.get("text"), str)
            and isinstance(x.get("duration_s"), int)
            and not isinstance(x.get("duration_s"), bool) for x in segs)):
        return None
    if not (isinstance(obj.get("title"), str)
            and isinstance(obj.get("description"), str)):
        return None
    return obj


def _filter(s, banned, dropped) -> str:
    """Giữ câu sạch của 1 đoạn LLM; câu số/giá, từ cấm kịch bản, rượu →
    BỎ (ghi `dropped`)."""
    kept = []
    for sent in _SENT_RE.split(ims._clean(s)[:MAX_TEXT]):
        t = sent.strip()
        if not t:
            continue
        if content._spec_like(t):
            why = "so_lieu"
        elif vs._banned(t, banned):
            why = "tu_cam_kich_ban"
        elif kb_filter.is_alcohol(t):
            why = "ruou"
        else:
            kept.append(t)
            continue
        dropped.append({"text": t, "ly_do": why})
    return " ".join(kept)


def _pre(brief) -> dict | None:
    s = ims._clean(brief)
    if not s or len(s) > MAX_BRIEF:
        return {"code": "brief_cam",
                "reason": f"brief rỗng hoặc dài hơn {MAX_BRIEF} ký tự"}
    if kb_filter.is_alcohol(s):
        return {"code": "ruou", "reason": "brief nhắc rượu — cấm quảng cáo/"
                "khuyến mại rượu (Luật 44/2019)"}
    return vs.check_brief(s)


def build(obj: dict, banned: list[str]) -> dict:
    """JSON LLM → gói (THUẦN, tất định). → {"title", "description",
    "segments", "chapters", "srt", "shorts", "dropped", "refused"}."""
    canon, ai, ad = content._publish_texts()
    dropped: list = []
    segs = []
    t0 = 0
    for i, x in enumerate(obj["segments"][:MAX_SEGMENTS]):
        title = _filter(x["title"], banned, dropped)[:60] or f"Phần {i + 1}"
        text = _filter(x["text"], banned, dropped)
        segs.append({"i": i, "title": title, "text": text,
                     "visual": _filter(x.get("visual") or "", banned,
                                       dropped),
                     "start_s": t0, "duration_s": x["duration_s"]})
        t0 += x["duration_s"]
    out = {"title": _filter(obj["title"], banned, dropped)[:100],
           "segments": segs, "dropped": dropped, "refused": None}
    if len(segs) < MIN_SEGMENTS or any(
            not SEG_S[0] <= s["duration_s"] <= SEG_S[1] for s in segs):
        out["refused"] = {"code": "kich_ban", "reason": f"cần ≥ {MIN_SEGMENTS}"
                          f" phần, mỗi phần {SEG_S[0]}–{SEG_S[1]} giây"}
        return out
    if not TOTAL_S[0] <= t0 <= TOTAL_S[1]:
        out["refused"] = {"code": "thoi_luong", "reason": f"tổng {t0} giây"
                          f" ngoài [{TOTAL_S[0]}, {TOTAL_S[1]}]"}
        return out
    if not out["title"]:
        out["refused"] = {"code": "kich_ban", "reason": "tiêu đề bị bỏ hết"}
        return out
    chapters = [f"{ts_chapter(s['start_s'])} {s['title']}" for s in segs]
    srt = []
    for n, s in enumerate(segs, 1):
        srt += [str(n), (f"{ts_srt(s['start_s'])} --> "
                         f"{ts_srt(s['start_s'] + s['duration_s'])}"),
                s["text"] or s["title"], ""]
    shorts = []
    for sh in (obj.get("shorts") or [])[:MAX_SHORTS] \
            if isinstance(obj.get("shorts"), list) else []:
        idx = sh.get("segments") if isinstance(sh, dict) else None
        if not (isinstance(idx, list) and 1 <= len(idx) <= MAX_SHORT_SEGS
                and all(isinstance(j, int) and not isinstance(j, bool)
                        and 0 <= j < len(segs) for j in idx)
                and len(set(idx)) == len(idx)):
            continue
        title = _filter(sh.get("title") or "", banned, dropped)[:60]
        if title:
            shorts.append({"title": title, "segments": list(idx)})
    desc = [_filter(obj["description"], banned, dropped), "",
            "Chương:", *chapters, ""]
    out.update(chapters=chapters, srt="\n".join(srt), shorts=shorts,
               description="\n".join(desc + ai[:1] + ad[:1]),
               canon=canon)
    return out


def package_text(pkg: dict) -> str:
    """Toàn văn bản nháp (đúng chữ guardrail chấm + lưu content_drafts)."""
    L = [f"Tiêu đề: {pkg['title']}", "", "Mô tả:", pkg["description"], "",
         "Kịch bản theo chương:"]
    for s in pkg["segments"]:
        L += [f"[{ts_chapter(s['start_s'])}] {s['title']}", s["text"]]
    if pkg["shorts"]:
        L += ["", "Shorts (bản xem trước dựng từ B-roll):"]
        L += [f"- {sh['title']}" for sh in pkg["shorts"]]
    mode = pkg["meta"]["privacyStatus"]
    L += ["", (f"Chế độ hiển thị khi đưa lên kênh: {mode} (người phụ trách"
               " kênh đổi sau khi duyệt)"), "", "Phụ đề SRT:", pkg["srt"]]
    return "\n".join(L)


def _msgs_sha(messages) -> str:
    return hashlib.sha256(json.dumps(messages, ensure_ascii=False,
                                     sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def write_package(brief, *, readiness=None) -> dict:
    out = {"ok": False, "refused": None, "error": None, "title": "",
           "description": "", "chapters": [], "segments": [], "srt": "",
           "shorts": [], "dropped": [], "guardrail": None,
           "meta": {"privacyStatus": PRIVACY,
                    "containsSyntheticMedia": True},
           "text": "", "llm_calls": 0, "prompt_version": None,
           "prompt_sha256": None}

    def refuse(code, reason, g=None, **kw):
        ref = {"code": code, "reason": reason}
        return {**out, **kw, "refused": ref,
                "guardrail": g if g is not None
                else content._refused_guardrail(ref)}

    ref = _pre(brief)
    if ref:
        return refuse(ref["code"], ref["reason"])
    vcfg, err = vs.load_config()
    if err:
        return refuse("config", err)
    try:
        tmpl, ver, _ = content.load_template(TEMPLATE)
    except ValueError as e:
        return refuse("config", str(e))
    fmt = tmpl.replace("{brief}", ims._clean(brief))
    messages = [{"role": "system",
                 "content": content._system(fmt, price_rule=False)},
                {"role": "user", "content": "Trả về DUY NHẤT JSON đúng mẫu."}]
    for calls in (1, 2):
        sha = _msgs_sha(messages)
        try:
            resp = chat(AGENT, messages, temperature=0.4, max_tokens=2500,
                        feature="marketing-07.2")
            raw = resp.choices[0].message.content
        except Exception as e:  # noqa: BLE001 — gateway fail-closed
            return {**out, "llm_calls": calls,
                    "error": f"llm: {type(e).__name__}: {str(e)[:160]}"}
        state = {"llm_calls": calls, "prompt_version": ver,
                 "prompt_sha256": sha}
        obj = _parse(raw)
        if obj is None:
            return refuse("kich_ban", "LLM trả sai mẫu JSON", **state)
        pkg = build(obj, vcfg["script_banned"])
        canon = pkg.pop("canon", "")
        if pkg["refused"]:
            r = pkg.pop("refused")
            return refuse(r["code"], r["reason"], **state, **pkg)
        pkg.pop("refused")
        pkg["meta"] = out["meta"]
        ctx = {"channel": CHANNEL, "content_type": CONTENT_TYPE,
               "is_ai": True, "readiness": readiness}
        text = package_text(pkg)
        g = guardrail.check_publish(text, **ctx)
        if canon and any(v.get("code") == "thieu_khuyen_cao"
                         for v in g.get("violations") or []):
            pkg["description"] += f"\n{canon}."
            text = package_text(pkg)
            g = guardrail.check_publish(text, **ctx)
        state.update(pkg, text=text)
        if g.get("ok") is True:
            return {**out, **state, "ok": True, "guardrail": g}
        if calls == 2:
            return refuse("kich_ban", "gói video vi phạm guardrail sau 1"
                          " lượt sửa", g, **state)
        messages = messages + [
            {"role": "assistant", "content": str(raw)},
            {"role": "user", "content": content._feedback(g)
             + " Không viết số/giá. Trả lại DUY NHẤT JSON đúng mẫu."}]
    raise AssertionError("unreachable")


def save_package(conn, pkg: dict, brief: str) -> int:
    return store.save_draft(
        conn, ims._clean(brief), CHANNEL, pkg["text"], pkg["guardrail"],
        store.SOURCE_CLI, created_by=CREATED_BY, content_type=CONTENT_TYPE,
        is_ai=True, prompt_version=pkg["prompt_version"],
        prompt_sha256=pkg["prompt_sha256"])


# ------------------------------------------------------------ Shorts

def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _render_one(ff, sh, pkg, brolls, odir, vcfg, labels) -> dict:
    icfg = vcfg["img"]
    rgb = icfg["label"]["text_rgb"]
    W, H = icfg["formats"][FMT]
    lbox = ims._px(icfg["layout"][FMT]["label_box"], (W, H))
    texts = [pkg["segments"][j]["title"] for j in sh["segments"]]
    n = len(texts)
    scene_s = max(vcfg["scene_s"], math.ceil(SHORT_S[0] / n))
    total_s = scene_s * n
    if not SHORT_S[0] <= total_s <= SHORT_S[1]:
        return {"ok": False, "refused": "thoi_luong", "title": sh["title"]}
    with tempfile.TemporaryDirectory(prefix=".tmp-", dir=odir,
                                     ignore_cleanup_errors=True) as td:
        seq = Path(td) / "seq"
        seq.mkdir()
        frames, used = [], []
        for i, text in enumerate(texts):
            b = brolls[i % len(brolls)]
            r = vs._broll_frame(b, text, FMT, icfg, labels)
            if r[0] is None:
                return {"ok": False, "refused": r[1], "title": sh["title"]}
            data, img, bsha = r
            if not vs._label_drawn(img, lbox, rgb):
                return {"ok": False, "refused": "nhan_ai",
                        "title": sh["title"]}
            (seq / f"{i:03d}.png").write_bytes(data)
            frames.append(img)
            used.append({"file": b["file"], "file_sha256": bsha,
                         "license": b["license"]})
        tmp = Path(td) / "out.mp4"
        try:
            vs._encode(ff, seq, tmp, scene_s, total_s, vcfg["fps"])
            info = vs._probe(ff, tmp)
            got = vs._duration_ms(info)
            if got is None or abs(got - total_s * 1000) > 100 \
                    or re.search(r"Stream #\S+: Audio:", info):
                raise RuntimeError("mp4 sai thời lượng / có track âm thanh")
            checks = []
            for t in (500, total_s * 500, total_s * 1000 - 500):
                ref = frames[min(t // (scene_s * 1000), n - 1)]
                ratio = vs.label_visible(vs._extract_frame(ff, tmp, t), ref,
                                         lbox, rgb, tol=vcfg["extract_tol"])
                checks.append({"t_ms": t, "label_ratio": round(ratio, 4)})
        except RuntimeError as e:
            return {"ok": False, "error": str(e)[:200], "title": sh["title"]}
        if any(c["label_ratio"] < vcfg["extract_min_ratio"] for c in checks):
            return {"ok": False, "refused": "nhan_ai", "title": sh["title"],
                    "checks": checks}
        data = tmp.read_bytes()
        sha = _sha(data)
        mp4 = odir / f"{sha}.mp4"
        try:
            same = _sha(mp4.read_bytes()) == sha
        except OSError:
            same = False
        if not same:
            os.replace(tmp, mp4)
    meta = {"schema": SIDECAR_SCHEMA, "file": mp4.name, "asset_sha256": sha,
            "size": [W, H], "duration_ms": total_s * 1000,
            "labels": labels, "title": sh["title"], "segments": sh["segments"],
            "broll": used, "extract_check": checks, "tts": None,
            "music": None, "privacyStatus": PRIVACY,
            "created_at": datetime.now(timezone.utc)
            .isoformat(timespec="seconds")}
    side = odir / f"{sha}.json"
    kept = ims._same_sidecar(side, meta)
    if kept is None:
        ims._write_atomic(side, json.dumps(meta, ensure_ascii=False,
                                           indent=2).encode("utf-8"))
    return {"ok": True, "path": str(mp4), "sidecar": str(side), "sha256": sha,
            "title": sh["title"], "checks": checks}


def render_shorts(pkg: dict, *, broll_dir=None, out_dir=None, conn=None,
                  draft_id=None) -> list[dict]:
    """Dựng xem trước từng Short → list kết quả {ok, path, sha256, ...} |
    {ok False, refused: broll_thieu|ffmpeg_thieu|config|nhan_ai|...}."""
    if not pkg.get("ok") or not pkg.get("shorts"):
        return []
    vcfg, err = vs.load_config()
    if err:
        return [{"ok": False, "refused": "config", "title": sh["title"]}
                for sh in pkg["shorts"]]
    _canon, ai, ad = content._publish_texts()
    brolls, _skipped = vs._brolls(
        Path(broll_dir or os.environ.get("BROLL_DIR")
             or vs.DEFAULT_BROLL_DIR), vcfg["img"])
    if not brolls:
        return [{"ok": False, "refused": "broll_thieu", "title": sh["title"]}
                for sh in pkg["shorts"]]
    ff = vs.find_ffmpeg()
    if ff is None:
        return [{"ok": False, "refused": "ffmpeg_thieu",
                 "title": sh["title"]} for sh in pkg["shorts"]]
    if not (ai and ad):
        return [{"ok": False, "refused": "config", "title": sh["title"]}
                for sh in pkg["shorts"]]
    odir = Path(out_dir or os.environ.get("VIDEO_OUT_DIR")
                or vs.DEFAULT_OUT_DIR)
    odir.mkdir(parents=True, exist_ok=True)
    res = [_render_one(ff, sh, pkg, brolls, odir, vcfg, [ai[0], ad[0]])
           for sh in pkg["shorts"]]
    if conn is not None:
        with conn.transaction():
            for r in res:
                if r["ok"]:
                    conn.execute(store._LOG_SQL, (
                        CREATED_BY, "youtube_short_render", "content_draft",
                        str(draft_id) if draft_id is not None else None,
                        Jsonb({"sha256": r["sha256"], "draft_id": draft_id})))
        conn.commit()
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.mkt_youtube",
        description="MKT-12 — nháp gói video YouTube dài + Shorts xem trước "
                    "(chế độ riêng tư; không đăng)")
    ap.add_argument("--brief", required=True)
    ap.add_argument("--render", action="store_true",
                    help="dựng Shorts xem trước từ B-roll có license")
    ap.add_argument("--dry-run", action="store_true",
                    help="không lưu nháp, không dựng")
    ap.add_argument("--broll-dir", type=Path)
    ap.add_argument("--out-dir", type=Path)
    args = ap.parse_args(argv)
    if args.render and args.dry_run:
        ap.error("--render không đi với --dry-run")
    conn = None
    if not args.dry_run:
        conn = connect()
        if conn is None:
            print("[error] không kết nối được Postgres (DATABASE_URL thiếu"
                  " hoặc host chết)", file=sys.stderr)
            return 2
    try:
        rmap = store.readiness_from_db(conn) if conn is not None else None
        pkg = write_package(args.brief, readiness=rmap)
        if pkg["error"]:
            print(f"[error] {pkg['error']}", file=sys.stderr)
            return 1
        if not pkg["ok"]:
            r = pkg["refused"]
            print(f"[refuse] {r['code']}: {r['reason']} (LLM"
                  f" {pkg['llm_calls']} lời gọi)")
            return 1
        print(pkg["text"])
        if args.dry_run:
            print("[dry-run] KHÔNG lưu nháp, không dựng Shorts")
            return 0
        did = save_package(conn, pkg, args.brief)
        print(f"[ok] nháp #{did} pending (YouTube, chế độ {PRIVACY}) — chờ"
              " người duyệt")
        if args.render:
            for r in render_shorts(pkg, broll_dir=args.broll_dir,
                                   out_dir=args.out_dir, conn=conn,
                                   draft_id=did):
                if r["ok"]:
                    print(f"[short] {Path(r['path']).name}")
                else:
                    print(f"[short-fail] {r.get('refused') or r.get('error')}")
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)[:300]}", file=sys.stderr)
        return 1
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
