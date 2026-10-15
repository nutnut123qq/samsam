"""Che PII (SĐT VN / email) trong free text — dùng chung cho convlog Zalo
(connectors.zalo) và LLM gateway (pipelines.llm_gateway, v3.1: mọi
payload gửi ra provider phải qua đây). Dời nguyên văn từ connectors/zalo.py
(W31.1) — lịch sử vá D5.3..V8.3 giữ trong comment bên dưới; zalo.py import
lại cùng tên nên test cũ không đổi.
"""

import re

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
