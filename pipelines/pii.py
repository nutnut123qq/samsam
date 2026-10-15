"""Che PII (SĐT VN / email) trong free text — dùng chung cho convlog Zalo
(connectors.zalo) và LLM gateway (pipelines.llm_gateway, v3.1: mọi
payload gửi ra provider phải qua đây). Dời nguyên văn từ connectors/zalo.py
(W31.1) — lịch sử vá D5.3..V8.3 giữ trong comment bên dưới; zalo.py import
lại cùng tên nên test cũ không đổi.
v13.1 (F02): thêm `mask_identity` / `scrub_user` / `identity_residual` —
tên + địa chỉ tự do (xem mục cuối file).
"""

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

# SĐT VN hoặc email trong câu hỏi -> mask trước khi log (D5.3).
# Alternative 1 (D5.10 + D6.11): "0" + >=9 số, sep được LẶP nhiều ký tự
# NHƯNG phải cùng 1 ký tự ("0901  234  567", "0901--234--567") — sep
# trộn (" - ") không nối 2 số được, nên khoảng giá/ngày
# "50.000.000 - 100.000.000" không bị ăn (reviewer M1: `[ .-]*` cũ
# nuốt " - " -> 2 số dính thành run >=9 -> mất cả khoảng).
# `(?<!\d)` = số 0 mở đầu không đứng sau chữ số khác -> giá
# "10.050.000.000" không bị ăn giữa chừng; `{9,}` greedy mask hết
# run dài, không lộ đuôi số.
# Alternative 2 (D6.11): "+84"/"84" + >=8 số (VN mobile quốc tế),
# cùng luật sep cùng-ký-tự; `(?<![\d+])` chặn "84" đứng sau digit/'+'.
# Ngày "05.10.2026" (7 số) hay "1.500.000" quá ngắn -> không match.
# V3.1: `_mask_pii` unwrap nhóm ngoặc TOÀN-digit ("(90)" -> " 90 ",
# "(+84)" -> " +84 ") TRƯỚC khi match, nên SĐT dạng ngoặc
# ("+84 (90) 123 4567", "(0901) 234 567") được bắt qua đường đó —
# KHÔNG đưa ngoặc vào sep class (mở lại bridging ở trên) và không
# normalize ngoặc non-digit (làm ")(" -> sep-run -> bridging mới).
# Tên người vẫn không detect được bằng regex.
# V5.1: 2 lớp lách còn lọt sau V3.1 (cold-check v1.2 MINOR):
# (a) SĐT chia qua nhiều nhóm ngoặc nối sep TRỘN — "(0901) - (234) -
# (567)": sau unwrap joint giữa các nhóm là " - " (sep trộn) nên không
# bridge; (b) ngoặc lồng "((0901))" / ngoặc có space "( 0901 )" —
# unwrap strict `\+?\d+` không bắt -> ")" chặn bridge.
# Fix trong `_mask_pii`: fixpoint merge+unwrap — merge gộp 2 nhóm
# ngoặc-toàn-digit KỀ NHAU qua sep-run bất kỳ (kể cả ")(" dính) thành
# 1 group; unwrap space-tolerant mở từng lớp. Ngoặc bọc NON-digit
# (giá "(1.500.000)" có '.') không merge/unwrap -> ")" vẫn chặn
# bridge. `_PII_RE` giữ nguyên — không nới sep class.
_PII_RE = re.compile(
    r"(?<!\d)0(?:(?:([ .-])\1*)?\d){9,}"
    r"|(?<![\d+])(?:\+84|84)(?:(?:([ .-])\2*)?\d){8,}"
    r"|(?<![\w.+-])[\w.+-]{1,256}@[\w-]{1,253}(?:\.[\w-]{1,253})+")
# V5.1: 2 lớp lách còn lọt sau V3.1 (cold-check v1.2 MINOR):
# (a) SĐT chia qua nhiều nhóm ngoặc nối sep TRỘN — "(0901) - (234) -
# (567)": sau unwrap joint giữa các nhóm là " - " (sep trộn) nên không
# bridge; (b) ngoặc lồng "((0901))" / ngoặc có space "( 0901 )" —
# unwrap strict `\+?\d+` không bắt -> ")" chặn bridge.
# Vá bằng QUÉT 1 LƯỢT (cold-check v1.4 MAJOR: bản đầu dùng fixpoint
# merge+unwrap = re-regex toàn văn mỗi vòng -> O(n*depth), "("*5000
# đốt >10s CPU trong _log_lock = DoS qua webhook). Scanner dưới đây
# O(n): mỗi vị trí quét <=1 lần — group parse xong nhảy qua, fail
# thì bước 1; rescan sau group-fail chặn bởi budget (xem _mask_pii).
# V5.1 r2 (cùng cụm DoS — cold-check vá theo cụm): email alternative
# `[\w.+-]+@[\w-]+\.[\w.]+` cũng QUADRATIC trên text dài không-'@'
# (probe: 'x'*50K=18.9s, *100K=77.8s — unbounded `+` backtrack per
# position). Bound cứng (không phải unbounded `+`) giữ O(n) worst-case:
# per-position work <= ~256 char. V6.3 nới 64/63 -> 256/253: local >64
# hay label >63 đều RFC-invalid nhưng hướng che-thừa vẫn mask trọn
# (bản {1,64} chỉ mask 64 cuối, lộ đầu local-part — cold-check v1.4
# MINOR). V8.3 thêm lookbehind `(?<![\w.+-])`: local >256 trước đây
# SLIDE — engine bắt 256 ký tự cuối trước '@', lộ đầu local; giờ
# fail hẳn -> '@' sót lại -> `_mask_email_oversize` che trọn run.

# V6.2: ký tự ngoặc/sep trong blob nối -> ' ' (chuỗi dịch cho
# str.translate — bare-run "234.567" -> "234 567", group "(0901)" ->
# " 0901 " gồm cả ngoặc ngoài).
_BLOB_SEP_TR = str.maketrans("().- ", "     ")


def _mask_pii(text: str) -> str:
    """Che SĐT/email user gõ vào câu hỏi trước khi ghi convlog — file đã
    gitignore nhưng vẫn nằm plaintext trên đĩa khi deploy. Tên người
    không detect được bằng regex — production cần retention policy.
    V3.1: chỉ unwrap nhóm ngoặc chứa TOÀN digit (kèm '+' đầu tùy chọn)
    — "(90)" -> " 90 ", "(+84)" -> " +84 " — để bắt SĐT dạng ngoặc mà
    KHÔNG normalize mọi ngoặc (normalize tràn làm ")(" -> space-run ->
    bridging mới nối 2 số, reviewer F1). Ngoặc bọc non-digit (giá
    "(1.500.000)" có '.') không match -> ngoặc giữ nguyên -> ")" tự
    chặn bridging vì không thuộc sep class.
    V5.1 (r2 — scanner tuyến tính thay fixpoint regex, cold-check v1.4
    MAJOR: fixpoint re-regex toàn văn mỗi vòng = O(n*depth), "("*5000
    đốt >10s CPU trong _log_lock = DoS qua webhook): 1 pass trái->phải.
    Group digit hợp lệ -> emit ' ' + content với ngoặc -> ' ' (nested
    tự bóc phẳng) + ' '; sau đó nếu tiếp là sep-run `[ .-]*` + group
    digit khác -> MERGE — joint trộn sập thành ' ' -> sep cùng-ký-tự
    -> `_PII_RE` bridge được, bắt "(A) - (B) - (C)" mà không đụng
    "50.000.000 - 100.000.000".
    V6.2: bare-run digit kề group qua joint sep TRỘN cũng nối vào blob
    — "(0901) - 234.567" / "0901 - (234) - (567)" trước lọt (0901 |
    234.567 đều <10 số). Group ngoặc là "mỏ neo": CHỈ bridge khi tổng
    digit của blob >= 10 (đủ hình SĐT); ít hơn emit như cũ — không
    normalize "05.10 (2)" hay nối 2 bare-run trần (giá
    "50.000.000 - 100.000.000" vẫn an toàn vì bridge luôn cần group).
    Residual: bare "0901 - 234.567" không ngoặc vẫn lọt (sửa = phá
    luật chống nối khoảng giá — chấp nhận).
    V6.1 (cold-check v1.4 MINOR): budget cạn trước đây emit đuôi RAW —
    "("*26 + "x" + "(0901) - (234) - (567)" lọt trọn. Vá: đuôi còn '('
    -> "***" (hướng không-rò); đuôi không ngoặc emit raw như cũ (bare
    digit đã bị _PII_RE bắt).
    O(n): mọi scan (group parse, run-scan, left-run) đều trừ `budget`
    hoặc chặn bởi ')' group trước — pathological hết ngân sách thì đuôi
    có ngoặc thành '***' thay vì lọt raw."""
    n = len(text)
    out: list[str] = []
    # Tổng ký tự các lần scan duyệt (group + run + left-run) — vượt
    # budget -> dừng flatten, đuôi còn '(' ghi '***' (V6.1).
    budget = 4 * n + 64
    i = 0
    while i < n and budget > 0:
        if text[i] != '(':
            out.append(text[i])
            i += 1
            continue
        end, scanned = _paren_group_end(text, i)
        budget -= max(scanned - i, 1)
        if end < 0:
            out.append('(')
            i += 1
            continue
        # Group hợp lệ tại i. Left bare-run (V6.2): scan-back trên text
        # thô, chặn bởi ')' của group trước/ký tự ngoài run -> tuyến
        # tính tổng thể.
        i0 = i
        j = i0
        while j > 0 and (text[j - 1].isdigit() or text[j - 1] in '+ .-'):
            j -= 1
        left = j if any(c.isdigit() for c in text[j:i0]) else i0
        # Gom chain: group/bare-run xen kẽ qua joint `[ .-]*`.
        # parts = (start, end, is_group) trên text THÔ.
        parts: list[tuple[int, int, bool]] = [(i0, end, True)]
        i = end
        while i < n and budget > 0:
            k = i
            while k < n and text[k] in ' .-':
                k += 1
            if k >= n:
                break
            if text[k] == '(':
                end2, scanned2 = _paren_group_end(text, k)
                budget -= max(scanned2 - k, 1)
                if end2 < 0 or budget <= 0:
                    break
                parts.append((k, end2, True))
                i = end2
            elif text[k].isdigit() or text[k] == '+':
                m = k + 1
                while m < n and (text[m].isdigit() or text[m] in '+ .-'):
                    m += 1
                while m > k and not (text[m - 1].isdigit()
                                     or text[m - 1] == '+'):
                    m -= 1
                budget -= m - k
                parts.append((k, m, False))
                i = m
            else:
                break
        digits = sum(c.isdigit() for c in text[left:i0])
        digits += sum(c.isdigit()
                      for a, b, _ in parts for c in text[a:b])
        if digits >= 10:
            # Blob >=10 số: nối left-run + mọi part bằng ' ', sep/ngoặc
            # trong part -> ' ' -> _PII_RE bắt trọn run. Pop left-run
            # đã emit raw (run char không phải '(' nên 1 raw char = 1
            # phần tử out — không đè group emit trước: ')' chặn run).
            del out[len(out) - (i0 - left):]
            chunks = []
            if left < i0:
                chunks.append(text[left:i0].translate(_BLOB_SEP_TR)
                                .strip(' '))
            chunks.extend(text[a:b].translate(_BLOB_SEP_TR).strip(' ')
                          for a, b, _g in parts)
            out.append(' ')
            out.append(' '.join(chunks))
            if parts[-1][2]:
                out.append(' ')  # group emit cũ luôn kèm ' ' đuôi
        else:
            # <10 số: emit như trước — chỉ group parts (dừng ở bare-run
            # đầu tiên), bare-run/group sau re-process bởi vòng ngoài.
            out.append(' ')
            i = i0
            for a, b, g in parts:
                if not g:
                    break
                out.append(text[a + 1:b - 1]
                           .replace('(', ' ').replace(')', ' '))
                out.append(' ')
                i = b
    if i < n:
        tail = text[i:]
        out.append('***' if '(' in tail else tail)
    return _mask_email_oversize(_PII_RE.sub("***", ''.join(out)))


def _email_local_ch(c: str) -> bool:
    return c.isalnum() or c in '_.+-'


def _email_label_ch(c: str) -> bool:
    return c.isalnum() or c in '_-'


def _mask_email_oversize(text: str) -> str:
    """Post-pass sau `_PII_RE.sub` (V8.3): email quá bound regex
    (local >256, label >253 — đều RFC-invalid) giờ fail hẳn nhờ
    lookbehind -> '@' còn sót lộ cả run. Mỗi '@' sót scan left-run
    `[\\w.+-]` + right label-run `[\\w-]+(\\.[\\w-]+)*`: trông
    email-like (left >=1 VÀ right có '.label') mà local >256 hoặc một
    label >253 -> cả run '***' (che thừa). '@' không email-like
    ('a@b' không dot, mention '@samsam', 'tag@') giữ nguyên — không
    over-mask mới. O(n): run quanh '@' cắt ở mọi '@' nên mỗi char
    duyệt <=2 lần; email đã mask mất '@' khỏi phạm vi."""
    out: list[str] = []
    i, n = 0, len(text)
    while True:
        at = text.find('@', i)
        if at < 0:
            out.append(text[i:])
            break
        ls = at
        while ls > i and _email_local_ch(text[ls - 1]):
            ls -= 1
        has_dot, over, re_ = False, at - ls > 256, at + 1
        while re_ < n and _email_label_ch(text[re_]):
            le = re_
            while le < n and _email_label_ch(text[le]):
                le += 1
            over = over or le - re_ > 253
            re_ = le
            if re_ + 1 < n and text[re_] == '.' \
                    and _email_label_ch(text[re_ + 1]):
                has_dot, re_ = True, re_ + 1
            else:
                break
        if ls < at and has_dot and over:
            out.append(text[i:ls])
            out.append('***')
            i = re_
        else:
            out.append(text[i:at + 1])
            i = at + 1
    return ''.join(out)


def _paren_group_end(text: str, i: int) -> tuple[int, int]:
    """text[i] == '('. Trả (end, scanned): end = index ngay SAU ')'
    khớp nếu group "(...)" cân bằng và content toàn
    [digit/space/'('/')'/'+'] với >=1 digit — nested "((0901))" khớp
    trọn, "(50.000)" fail ngay ở '.', "(abc" fail ở 'a', unclosed fail
    ở EOF. scanned = index quét tới — caller trừ budget rescan (group
    fail được duyệt lại bởi các '(' bên trong)."""
    depth, has_digit, n = 1, False, len(text)
    j = i + 1
    while j < n:
        c = text[j]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return (j + 1 if has_digit else -1), j
        elif '0' <= c <= '9':
            has_digit = True
        elif c != ' ' and c != '+':
            return -1, j
        j += 1
    return -1, j


# --- v13.1 (F02): tên + địa chỉ tự do ------------------------------------
# Regex SĐT/email ở trên KHÔNG che được tên/địa chỉ. Hai tầng:
#   - `mask_identity(text, allow_addr)` — gateway áp cho MỌI message/input:
#     tên sau mẫu XƯNG DANH ("tên em là ...", "tôi tên ...", "họ tên:",
#     "tôi là <Viết Hoa>") + địa chỉ có SỐ NHÀ (số nhà + đường/phố/ngõ/hẻm/
#     kiệt...; "ngõ/hẻm/số nhà <số>"; số + >=2 chữ Viết Hoa sau từ gợi ý
#     địa chỉ "giao/gửi/ship/địa chỉ/ở/tại/về..."). Địa chỉ công khai của
#     công ty trong `allow_addr` giữ nguyên (KB showroom).
#   - `scrub_user(text)` — text KHÁCH gõ (api.rag): thêm danh xưng + tên
#     Viết Hoa ("chị Lan", "anh Nguyễn Văn A"), rồi `identity_residual`:
#     còn dấu hiệu PII không che chắc (từ gợi ý địa chỉ + số nhà chưa che,
#     xưng danh + từ chưa che) -> True = KHÔNG gọi AI, chuyển người.
# Cụm khớp trên bản bỏ dấu + chữ thường GIỮ ĐỘ DÀI (`_fold_keep`) để khách
# gõ trộn dấu/không dấu vẫn bắt; Viết Hoa xét trên text gốc. Mọi quét
# tuyến tính: cue là alternation cố định, sau cue chỉ đi tới <=6 từ; KHÔNG
# để 2 lượng từ khoảng trắng kề nhau (`[ 	]*,?[ 	]+` = O(n²) trên chuỗi
# trắng dài — probe 40K space 15s) -> tách nhánh `[ 	]*,[ 	]*|[ 	]+`.
_MASK = "***"
_WORD_RE = re.compile(r"[^\W\d_]+")
_NUM = r"\d{1,5}[a-z]?(?:[ \t]*[/-][ \t]*\d{1,5}[a-z]?){0,3}"
_NAME_STRONG_RE = re.compile(
    r"(?<!\w)(?:(?:ho[ \t]+(?:va[ \t]+)?)?ten[ \t]+(?:cua[ \t]+)?"
    r"(?:toi|em|minh|to|chau|con|anh|chi|nguoi[ \t]+nhan)(?:[ \t]+la)?"
    r"|(?:toi|em|minh|to|chau|con)[ \t]+ten(?:[ \t]+la)?"
    r"|ho[ \t]+(?:va[ \t]+)?ten(?:[ \t]+la)?"
    r"|nguoi[ \t]+nhan(?:[ \t]+la)?)(?!\w)[ \t]*[:\-]?[ \t]*")
_NAME_WEAK_RE = re.compile(
    r"(?<!\w)(?:toi|em|minh|to|day)[ \t]+la[ \t]+"
    r"(?:(?:anh|chi|co|chu|bac|ong|ba|em)[ \t]+)?")
# Danh xưng (xét trên text GỐC chữ thường — "có"/"cô", "bà"/"ba" bỏ dấu
# trùng nhau nên KHÔNG dùng bản bỏ dấu ở đây).
_HONORIFIC_RE = re.compile(
    r"(?<!\w)(?:anh|chị|cô|chú|bác|ông|bà|em|bạn|cháu|cậu|dì|mợ|thím|bé|cụ)"
    r"[ \t]+(?=[^\W\d_])")
_STREET = (r"(?:duong|d\.|pho|ngo|ngach|hem|kiet)")
_ADDR_NUM_FIRST_RE = re.compile(
    r"(?<![\w/])(?:(?:so[ \t]+nha|nha[ \t]+so|so|sn)[ \t]*(?:[:.][ \t]*)?)?"
    + _NUM + r"(?:[ \t]*,[ \t]*|[ \t]+)" + _STREET + r"(?!\w)")
_ADDR_PREFIXED_RE = re.compile(
    r"(?<![\w/])(?:so[ \t]+nha|nha[ \t]+so|sn|so)[ \t]*(?:[:.][ \t]*)?"
    + _NUM + r"(?:[ \t]*,[ \t]*|[ \t]+)(?:thon|xom|ap|to|khom|khu[ \t]+pho|kp|xa|"
    r"phuong|p\.|quan|q\.|huyen|thi[ \t]+tran|tt)(?!\w)")
_ADDR_KEY_FIRST_RE = re.compile(
    r"(?<!\w)(?:so[ \t]+nha|nha[ \t]+so|sn|ngo|ngach|hem|kiet)"
    r"[ \t]*(?:[:.][ \t]*)?" + _NUM + r"(?![\w/])")
_ADDR_NUM_RE = re.compile(r"(?<![\w/])" + _NUM + r"(?![\w/])")
_ADDR_CUE_RE = re.compile(
    r"(?<!\w)(?:dia[ \t]+chi|d/c|dc|giao|gui|ship|nha|o|tai|den|toi|ve|"
    r"so)(?!\w)")


def _set(words: str) -> frozenset:
    return frozenset(words.split())


# Từ dừng khi đi tiếp sau cue tên/địa chỉ (bản bỏ dấu).
_STOP = _set(
    "la o nha sdt so dien thoai muon can dat mua hoi giao gui ship va sinh "
    "nam day gi nao ai sao dang de nhe a ah khong ko k co duoc se oi ne "
    "nhu cua tai den toi ve cho voi shop ben em anh chi minh phuong xa quan "
    "huyen tinh tp thanh mat bao lau roi chua nhan email zalo")
_COARSE = _set("quan q phuong p huyen tinh tp xa thi")
_UNITS = _set(
    "hop hu chai goi vien lo cai sp san pham ngay gio tuan thang nam tieng "
    "phut km kg g gr ml l v k tr trieu nghin ngan d dong lan nguoi suat bo "
    "cap set combo phan tram duoc khong ko k nhe nha a roi chua mat bao "
    "truoc sau")
_QUESTION = _set("gi nao ai sao la")
_CLAUSE_END_RE = re.compile(r"[.?!;\n]")
# Chữ Viết Hoa ngay sau danh xưng nhưng là tên SP/thương hiệu, không phải
# tên người.
_NOT_NAME = _set(
    "sam saphraton sapentol savigout savina savitim samsam tet shop shopee "
    "tiktok zalo facebook messenger cod")
_RESIDUAL_ADDR_CUE_RE = re.compile(
    r"(?<!\w)(?:dia[ \t]+chi|d/c|so[ \t]+nha|nha[ \t]+so|"
    r"nha[ \t]+(?:toi|em|minh|anh|chi|con|chau)[ \t]+o|"
    r"(?:giao|gui|ship|chuyen)(?:[ \t]+hang)?[ \t]+(?:den|toi|ve|cho|vao|o)"
    r")(?!\w)")


# --- v13 vá review (F02 biến thể): chỉ áp cho text KHÁCH (`scrub_user`) ---
# (a) Họ tên KHÔNG cần mẫu xưng danh: họ phổ biến + >=1 chữ Viết Hoa kề
#     ("Giao cho Trần Thị Bích", "Nguyễn Văn Mẫu - 12 ..."), hoặc họ + đệm
#     "văn/thị" gõ thường/không dấu ("nguyen van mau"). Đệm phải đúng
#     "văn"/"thị" hoặc viết trần — "Lễ vẫn mở", "do vận chuyển" không trúng.
# (b) Cụm Viết Hoa bắt đầu bằng họ nhưng là ĐỊA DANH/cụm thường gặp
#     ("Hà Nội", "Hồ Chí Minh", "Cao Cấp") — giữ nguyên (`_NAME_EXCEPT`).
# (c) "giao/gửi/ship cho <Tên Viết Hoa>" = người nhận.
# (d) Số + >=2 chữ Viết Hoa KHÔNG có từ gợi ý ("12 Ví Dụ") = địa chỉ, trừ
#     khi chữ đầu là đơn vị/tên SP ("2 Hộp Quà", "120 Viên").
# (e) Thôn/xóm + số hoặc tên; ấp/tổ/bản + số ("thôn 3", "xóm Bến Đò").
# v14.1 (p1) khép phần "còn lọt" bằng TỪ ĐIỂN công khai `data/vn_names.json`
# (không NER/dịch vụ ngoài) — xem mục "v14.1" dưới `_HAMLET_L_RE`.
_SURNAMES = _set(
    "nguyen tran le pham hoang huynh phan vu vo dang bui do ho ngo duong "
    "ly dao doan vuong trinh truong lam to ha cao dinh luu ta quach chau "
    "luong hua thai kieu lai tang thach mac giang ton khuc ung nong")
_MIDDLE = frozenset(("văn", "thị", "van", "thi"))
_NAME_EXCEPT = tuple(tuple(p.split()) for p in (
    "ha noi", "ha tinh", "ha giang", "ha nam", "ha dong", "ha long",
    "ha tien", "ho chi minh", "ho tay", "ho guom", "ho tram", "lam dong",
    "cao bang", "cao lanh", "cao cap", "phan thiet", "phan rang", "ly son",
    "le hoi", "mai chau", "thai binh", "thai nguyen", "do son", "dong nai",
    "kieu bao", "lai chau"))
_RECIPIENT_RE = re.compile(
    r"(?<!\w)(?:giao|gui|ship|chuyen)(?:[ \t]+hang)?[ \t]+cho[ \t]+")
_HAMLET_F_RE = re.compile(r"(?<!\w)(?:thon|xom)[ \t]+(?=\w)")
_HAMLET_L_RE = re.compile(r"(?<!\w)(?:ấp|tổ|bản)[ \t]+(?=\d)")

# --- v14.1 (p1): tên KHÔNG theo mẫu — từ điển công khai ------------------
# `data/vn_names.json` (họ / tên đệm / tên phổ biến / địa danh, GIẢ ĐỊNH) +
# tên tỉnh/alias `vn_provinces_2025.json`. Chỉ áp cho text KHÁCH:
#   (f) từ gợi ý trao/nhận ("giao/gửi/ship/chuyển/tặng/cho/nhận" [hàng]
#       [cho]) + chữ Viết Hoa có trong từ điển: "giao Bích", "Cho Phương 1
#       hộp", "Gửi Mai Anh ở Hải Châu";
#   (g) họ hiếm (ngoài `_SURNAMES`) Viết Hoa + tên Viết Hoa trong từ điển:
#       "Âu Bích", "Mai Anh";
#   (h) "tên [là|:]" + tên trong từ điển (Viết Hoa hoặc gõ thường); "họ
#       [là|:]" + họ Viết Hoa: "Họ Âu tên Hoa", "tên là lan";
#   (i) "giao/gửi/ship cho" + tên gõ thường trong từ điển, không phải đại
#       từ/xưng hô/từ thường (`khong_phai_ten`): "giao cho hoa";
#   (j) họ ít nhập nhằng (`ho_ro`) gõ thường + >=1 tên/đệm: "nguyen minh
#       anh", "huynh bich".
# Từ có dấu so đúng dạng có dấu ("Quảng" ≠ "Quang"), không dấu so bản bỏ
# dấu. Cụm bắt đầu bằng địa danh/cụm thường ("Bình Dương", "Hội An", "Kim
# Long", "Phụ Nữ") không che. Che thừa (vd "Giao An toàn" -> "Giao ***
# toàn") rẻ hơn chuyển người, nên luật nghiêng về CHE; còn residual giữ như
# v13. Mọi luật đi tối đa 3 từ sau điểm neo (tuyến tính).
_DATA = Path(__file__).resolve().parent.parent / "data"
NAMES_FILE = _DATA / "vn_names.json"
PROVINCES_FILE = _DATA / "vn_provinces_2025.json"
_GIVE_CUE_RE = re.compile(
    r"(?<!\w)(?:giao|gui|goi|ship|chuyen|tang|cho|nhan)(?:[ \t]+hang)?"
    r"(?:[ \t]+cho)?(?:[ \t]*:[ \t]*|[ \t]+)")
_TEN_CUE_RE = re.compile(r"(?<!\w)ten(?:[ \t]+la)?(?:[ \t]*:)?[ \t]+")
_HO_CUE_RE = re.compile(r"(?<!\w)ho(?:[ \t]+la)?(?:[ \t]*:)?[ \t]+")
_LOW_RECIPIENT_RE = re.compile(
    r"(?<!\w)(?:giao|gui|ship|chuyen)(?:[ \t]+hang)?[ \t]+cho[ \t]+")


def _fold_words(words) -> tuple:
    return tuple(_WORD_RE.findall(_fold_keep(unicodedata.normalize(
        "NFC", " ".join(words) if not isinstance(words, str) else words))))


class _Dict:
    """Từ điển đã chuẩn hóa: tập có dấu + tập bỏ dấu từng loại."""

    def __init__(self, doc: dict, provinces: dict):
        def pair(key):
            acc = frozenset(unicodedata.normalize("NFC", w).lower()
                            for w in doc[key])
            return acc, frozenset(_fold_keep(w) for w in acc)
        self.ho = pair("ho")
        self.ho_ro = pair("ho_ro")
        g_acc, g_fold = pair("ten")
        d_acc, d_fold = pair("dem")
        self.given = (g_acc | d_acc, g_fold | d_fold)
        self.not_name = pair("khong_phai_ten")
        places = [*doc["dia_danh"], *provinces.get("provinces", ()),
                  *provinces.get("aliases", {})]
        self.places: dict[str, list[tuple]] = {}
        for p in places:
            key = _fold_words(p)
            if key and key[0] in ("tp",):
                key = key[1:]
            if key:
                self.places.setdefault(key[0], []).append(key)
        for x in _NAME_EXCEPT:
            self.places.setdefault(x[0], []).append(x)


@lru_cache(maxsize=1)
def _names() -> "_Dict | None":
    """Từ điển tên; thiếu/hỏng file -> None (scrub_user fail-closed)."""
    try:
        doc = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
        prov = json.loads(PROVINCES_FILE.read_text(encoding="utf-8"))
        for k in ("ho", "ho_ro", "dem", "ten", "khong_phai_ten", "dia_danh"):
            v = doc[k]
            if not (isinstance(v, list) and v
                    and all(isinstance(w, str) and w.strip() for w in v)):
                raise ValueError(k)
        if not isinstance(prov, dict):
            raise TypeError("provinces")
        return _Dict(doc, prov)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def _in(t: str, f: str, s: int, e: int, sets) -> bool:
    """Từ t[s:e] thuộc `sets` (có dấu, bỏ dấu): gõ không dấu -> so bản bỏ
    dấu; có dấu -> so đúng dạng có dấu."""
    w, fw = t[s:e].lower(), f[s:e]
    return (fw in sets[1]) if w == fw else (w in sets[0])


def _is_place(d: _Dict, f: str, s: int, e: int) -> bool:
    """Cụm bắt đầu tại `s` là địa danh/cụm thường — xét <=5 từ kế tiếp
    (bất kể Viết Hoa: "Thanh toán" chỉ "Thanh" Viết Hoa). `e` giữ chữ ký
    cũ (không dùng để cắt)."""
    del e
    words = tuple(_WORD_RE.findall(f, s, s + 60))[:5]
    return bool(words) and any(words[:len(x)] == x
                               for x in d.places.get(words[0], ()))


def _cap_name_span(d: _Dict, t: str, f: str, p: int, first) -> int:
    """Từ Viết Hoa tại `p` thuộc `first` (từ điển) -> vị trí kết thúc chuỗi
    Viết Hoa (<=3 từ) nếu không phải địa danh/tên SP; ngược lại -> p."""
    w = _WORD_RE.match(f, p)
    if (not w or not t[p].isupper() or w.group(0) in _NOT_NAME
            or not any(_in(t, f, p, w.end(), s) for s in first)):
        return p
    e = _words_after(t, f, p, cap_only=True, first_free=True, limit=3,
                     stop=False)
    return p if e == p or _is_place(d, f, p, e) else e


def _low_name_end(d: _Dict, t: str, f: str, p: int,
                  check_not: bool = True) -> int:
    """Chuỗi <=3 từ liên tiếp (chỉ cách khoảng trắng) đều là tên/đệm trong
    từ điển, từ đầu không phải `khong_phai_ten` (khi `check_not`) -> vị
    trí kết thúc."""
    end, i = p, p
    for n in range(3):
        j = i
        while j < len(f) and f[j] in " \t":
            j += 1
        w = _WORD_RE.match(f, j)
        if not w or (n and j == i) or not _in(t, f, j, w.end(), d.given):
            break
        if n == 0 and check_not and _in(t, f, j, w.end(), d.not_name):
            break
        end = i = w.end()
    return p if _is_place(d, f, p, end) else end


def _dict_spans(d: _Dict, t: str, f: str) -> list[tuple[int, int]]:
    spans = []
    for m in _GIVE_CUE_RE.finditer(f):                          # (f)
        e = _cap_name_span(d, t, f, m.end(), (d.given, d.ho))
        if e > m.end():
            spans.append((m.end(), e))
    for m in _WORD_RE.finditer(f):                              # (g)(j)
        s = m.start()
        if m.group(0) in _SURNAMES and t[s].isupper():
            continue                       # luật họ phổ biến (a) đã xử lý
        nxt = _WORD_RE.match(f, m.end() + 1)
        if not nxt or f[m.end()] != " ":
            continue
        if t[s].isupper() and _in(t, f, s, m.end(), d.ho):
            if _cap_name_span(d, t, f, nxt.start(), (d.given,)) > nxt.start():
                e = _words_after(t, f, s, cap_only=True, limit=4, stop=False)
                if not _is_place(d, f, s, e):
                    spans.append((s, e))
        elif not t[s].isupper() and _in(t, f, s, m.end(), d.ho_ro):
            e = _low_name_end(d, t, f, m.end(), check_not=False)
            if e > m.end():
                spans.append((s, e))
    for m in _TEN_CUE_RE.finditer(f):                           # (h)
        e = _cap_name_span(d, t, f, m.end(), (d.given, d.ho))
        if e == m.end() and not t[m.end():m.end() + 1].isupper():
            e = _low_name_end(d, t, f, m.end())
        if e > m.end():
            spans.append((m.end(), e))
    for m in _HO_CUE_RE.finditer(f):                            # (h)
        e = _cap_name_span(d, t, f, m.end(), (d.ho,))
        if e > m.end():
            spans.append((m.end(), e))
    for m in _LOW_RECIPIENT_RE.finditer(f):                     # (i)
        if t[m.end():m.end() + 1].isupper():
            continue                       # Viết Hoa: luật (c)/(f)
        e = _low_name_end(d, t, f, m.end())
        if e > m.end():
            spans.append((m.end(), e))
    return spans


def _name_spans(t: str, f: str) -> list[tuple[int, int]]:
    spans = []
    d = _names()
    for m in _WORD_RE.finditer(f):
        if m.group(0) not in _SURNAMES:
            continue
        s = m.start()
        # v14.1: gõ CÓ DẤU thì phải đúng dạng họ có dấu — "Tặng Mẹ" (tặng
        # ≠ Tăng), "Đỗ" vẫn khớp; gõ không dấu giữ như v13.
        if (d is not None and t[s:m.end()].lower() != m.group(0)
                and not _in(t, f, s, m.end(), d.ho)):
            continue
        if t[s].isupper():
            # Trong chuỗi Viết Hoa sau họ, chữ trùng từ dừng vẫn là tên
            # ("Nguyễn Chí Thanh", "Lê Thị Anh") — không áp _STOP.
            e = _words_after(t, f, m.end(), cap_only=True, first_free=True,
                             limit=3, stop=False)
            if e == m.end():
                continue
            words = tuple(_WORD_RE.findall(f, s, e))
            if any(words[:len(x)] == x for x in _NAME_EXCEPT):
                continue
            # v14.1: địa danh trong từ điển ("Hà Đông", "Phan Thiết")
            if d is not None and _is_place(d, f, s, e):
                continue
            spans.append((s, e))
            continue
        nxt = _WORD_RE.match(f, m.end() + 1)
        if (nxt and f[m.end()] == " "
                and t[nxt.start():nxt.end()].lower() in _MIDDLE):
            e = _words_after(t, f, nxt.end(), cap_only=False, first_free=True,
                             limit=2)
            if e > nxt.end():
                spans.append((s, e))
    return spans


def _user_extra_spans(t: str, f: str) -> list[tuple[int, int]]:
    spans = _name_spans(t, f)
    d = _names()
    if d is not None:
        spans += _dict_spans(d, t, f)
    for m in _RECIPIENT_RE.finditer(f):
        e = _words_after(t, f, m.end(), cap_only=True, first_free=True)
        if e > m.end():
            spans.append((m.end(), e))
    for m in _ADDR_NUM_RE.finditer(f):
        e = _words_after(t, f, m.end(), cap_only=True, stop=False)
        words = _WORD_RE.findall(f, m.end(), e)
        if (len(words) >= 2 and words[0] not in _UNITS
                and words[0] not in _NOT_NAME):
            spans.append((m.start(), e))
    low = t.lower() if len(t.lower()) == len(t) else ""
    hamlets = [*_HAMLET_F_RE.finditer(f), *_HAMLET_L_RE.finditer(low)]
    for m in hamlets:
        num = _ADDR_NUM_RE.match(f, m.end())
        start = num.end() if num else m.end()
        e = _words_after(t, f, start, cap_only=False, first_free=not num,
                         limit=6)
        if e > m.end() or num:
            spans.append((m.start(), max(e, start)))
    return spans


@lru_cache(maxsize=4096)
def _fold_ch(c: str) -> str:
    if c in "đĐ":
        return "d"
    base = "".join(x for x in unicodedata.normalize("NFD", c)
                   if not unicodedata.combining(x)) or c
    low = base[0].lower()
    return low if len(low) == 1 else base[0]


def _fold_keep(t: str) -> str:
    """Bỏ dấu + chữ thường, len(_fold_keep(t)) == len(t) (offset dùng
    chung với text gốc)."""
    return "".join(map(_fold_ch, t))


def _norm_addr(s: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", _fold_keep(s)))


def _words_after(t: str, f: str, pos: int, *, cap_only: bool,
                 first_free: bool = False, limit: int = 4,
                 stop: bool = True) -> int:
    """Đi tiếp tối đa `limit` từ (chỉ cách nhau khoảng trắng) từ `pos`;
    dừng ở dấu câu/chữ số/từ dừng. cap_only: chỉ nhận từ Viết Hoa (theo
    text gốc). first_free: từ đầu không xét _STOP (tên "Anh"/"Em"), chỉ
    loại từ hỏi. Trả vị trí kết thúc (== pos nếu không lấy được từ nào)."""
    end, i, n = pos, pos, 0
    while n < limit:
        j = i
        while j < len(f) and f[j] in " \t":
            j += 1
        m = _WORD_RE.match(f, j)
        if not m or (n and j == i):
            break
        w = m.group(0)
        if cap_only and not t[j].isupper():
            break
        if n == 0 and first_free:
            if w in _QUESTION or (cap_only and w in _NOT_NAME):
                break
        elif stop and w in _STOP:
            break
        end = i = m.end()
        n += 1
    return end


def _addr_tail(t: str, f: str, pos: int) -> int:
    """Sau từ khóa đường/ngõ: nuốt tên đường tới dấu câu (<=6 từ), dừng ở
    đơn vị hành chính thô (phường/quận/...) và từ dừng."""
    return _words_after(t, f, pos, cap_only=False, limit=6)


def _spans_identity(t: str, f: str, user: bool) -> list[tuple[int, int]]:
    spans = []
    for m in _NAME_STRONG_RE.finditer(f):
        e = _words_after(t, f, m.end(), cap_only=False, first_free=True)
        if e > m.end():
            spans.append((m.end(), e))
    for m in _NAME_WEAK_RE.finditer(f):
        e = _words_after(t, f, m.end(), cap_only=True, first_free=True)
        if e > m.end():
            spans.append((m.end(), e))
    if user:
        low = t.lower() if len(t.lower()) == len(t) else f
        for m in _HONORIFIC_RE.finditer(low):
            e = _words_after(t, f, m.end(), cap_only=True, first_free=True)
            if e > m.end():
                spans.append((m.end(), e))
        spans += _user_extra_spans(t, f)
    for rx in (_ADDR_NUM_FIRST_RE, _ADDR_PREFIXED_RE, _ADDR_KEY_FIRST_RE):
        for m in rx.finditer(f):
            spans.append((m.start(), _addr_tail(t, f, m.end())))
    for m in _ADDR_NUM_RE.finditer(f):
        if not _ADDR_CUE_RE.search(f, max(0, m.start() - 30), m.start()):
            continue
        e = _words_after(t, f, m.end(), cap_only=True)
        # >=2 chữ Viết Hoa ("425 Phan Bội Châu") — 1 chữ dễ là "2 Hộp".
        if len(_WORD_RE.findall(f, m.end(), e)) >= 2:
            spans.append((m.start(), e))
    return spans


def _apply(t: str, spans, allow_addr) -> str:
    """Gộp span chồng/kề nhau thành 1 '***'; span chứa địa chỉ được phép
    (`allow_addr`, đã chuẩn hóa) giữ nguyên."""
    merged: list[list[int]] = []
    for s, e in sorted(spans):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    out, cur = [], 0
    for s, e in merged:
        if allow_addr and any(a and a in _norm_addr(t[s:e])
                              for a in allow_addr):
            continue
        out.append(t[cur:s])
        out.append(_MASK)
        cur = e
    out.append(t[cur:])
    return "".join(out)


def mask_identity(text: str, allow_addr=()) -> str:
    """Che tên theo mẫu xưng danh + địa chỉ có số nhà (xem đầu mục).
    `allow_addr`: địa chỉ công khai đã chuẩn hóa (`_norm_addr`) — span
    chứa nó thì giữ. Không phải str -> trả nguyên."""
    if not isinstance(text, str) or not text:
        return text
    t = unicodedata.normalize("NFC", text)
    allow = tuple(_norm_addr(a) for a in allow_addr if isinstance(a, str))
    return _apply(t, _spans_identity(t, _fold_keep(t), False), allow)


def identity_residual(text: str) -> bool:
    """True = còn dấu hiệu PII chưa che chắc (sau mask): (1) xưng danh mà
    từ kế tiếp chưa thành '***'; (2) từ gợi ý địa chỉ ('địa chỉ', 'số
    nhà', 'nhà em ở', 'giao/gửi/ship đến|về|tới') + trong cùng vế có số
    chưa che, không đứng sau phường/quận..., theo sau là một từ không phải
    đơn vị/thời gian ("ship về 12 le loi")."""
    if not isinstance(text, str) or not text:
        return False
    f = _fold_keep(unicodedata.normalize("NFC", text))
    for m in _NAME_STRONG_RE.finditer(f):
        w = _WORD_RE.match(f, m.end())
        if w and w.group(0) not in _QUESTION:
            return True
    for m in _RESIDUAL_ADDR_CUE_RE.finditer(f):
        stop = _CLAUSE_END_RE.search(f, m.end(), m.end() + 120)
        end = stop.start() if stop else min(len(f), m.end() + 120)
        for n in _ADDR_NUM_RE.finditer(f, m.end(), end):
            prev = _WORD_RE.findall(f, max(m.end(), n.start() - 12),
                                    n.start())
            if prev and prev[-1] in _COARSE:
                continue
            k = n.end()
            while k < end and f[k] in " \t,":
                k += 1
            nxt = _WORD_RE.match(f, k, end)
            if nxt and nxt.group(0) not in _UNITS:
                return True
    return False


def scrub_user(text: str) -> tuple[str, bool]:
    """Text khách gõ -> (đã che SĐT/email/tên/địa chỉ, còn_dấu_hiệu).
    còn_dấu_hiệu True -> caller KHÔNG gửi AI ngoài (chuyển người).
    v14.1: từ điển tên (`data/vn_names.json`) thiếu/hỏng -> còn_dấu_hiệu
    True với mọi câu có chữ (fail-closed — không biết che tên)."""
    if not isinstance(text, str):
        return text, False
    t = unicodedata.normalize("NFC", text)
    t = _apply(t, _spans_identity(t, _fold_keep(t), True), ())
    t = _mask_pii(t)
    if _names() is None and _WORD_RE.search(t):
        return t, True
    return t, identity_residual(t)
