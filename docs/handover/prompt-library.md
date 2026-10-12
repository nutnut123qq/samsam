# Prompt library — Sâm Sâm AI

**Dành cho ai:** MKT viết brief, người vận hành/dev chỉnh prompt.
**Làm việc gì:** trích NGUYÊN VĂN các system prompt đang chạy (kèm
file:line để đối chiếu — khi sửa prompt ở source, cập nhật lại doc
này), ghi chú brand voice, và 3 template brief mẫu.
**Cần gì:** nguồn sự thật là code — `pipelines/content.py` (system
prompt content + `CHANNEL_HINT`, v6.1 template kênh `data/prompts/`) và
`api/rag.py` (system prompt chat).
Doc này chỉ là bản sao phục vụ đào tạo/bàn giao.

## 1. System prompt — sinh nội dung (`pipelines/content.py:248-274`)

Prompt trong hàm `_system()` (dùng chung `draft()` và phần chữ
`listing()`). `{fmt}` = template theo kênh (mục 2, v6.1 đọc từ
`data/prompts/`);
`{_whitelist_block()}` = claims whitelist render từ
`data/claims_whitelist.json` (mỗi SKU 1 dòng `- sku: claim1; claim2`
hoặc `- sku: CHƯA CÓ công dụng công bố — không được nêu công dụng`,
code ở `pipelines/content.py:124-137`). v4.2: `{canon}` = NGUYÊN VĂN
`disclaimer.canonical` và `{ai_label}` = `labels.ai[0]` đọc từ
`data/guardrail_rules.json` (`_publish_texts()`, không chép tay — bản dev
chờ Pháp chế duyệt). Bỏ "Ngọc Linh" khỏi brand voice: chỉ dẫn địa lý chưa
xác nhận cho SKU nào (`ngoc_linh_chua_xac_nhan`).

```text
Bạn là copywriter của Công ty TNHH Sâm Sâm (Quảng Nam). Giọng
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
- Không bịa giá — sản phẩm không có giá công khai thì ghi "Liên hệ".
- TRƯỚC KHI XUẤT: rà từng câu — câu nào chứa động từ claim (giúp, hỗ trợ,
  giảm, bồi bổ, tăng cường, cải thiện, tốt cho, phòng ngừa, góp phần) mà
  không phải cụm claim whitelist nguyên văn thì VIẾT LẠI câu đó.
```

User message kèm theo: `BRIEF: {brief}` (+ dòng `SẢN PHẨM: <tên golden>
(mã <sku>)` khi gắn SKU — v6.1) (`pipelines/content.py:300-303`).
Khi output vi phạm guardrail, hệ thống tự thêm 1 lượt sửa có feedback
(`pipelines/content.py:308-317`) rồi trả bản cuối kèm kết quả guardrail.
v4.2: mỗi lượt nối nhãn AI nếu thiếu (tất định) rồi chạy
`guardrail_llm.check_publish_llm(text, channel=<kênh>)` — luật đăng bài
(XNQC, câu khuyến cáo, nhãn AI, "Ngọc Linh") + lớp LLM-check phụ nếu
cấu hình `GUARDRAIL_LLM_MODEL`; feedback lượt sửa liệt kê `code: span`.

## 2. Template theo kênh (`data/prompts/`, v6.1)

`{fmt}` ở mục 1 đọc từ file `data/prompts/<tên>.md` qua
`content.load_template(name)` (`pipelines/content.py:99-118`). Dict
`CHANNEL_HINT` (`pipelines/content.py:121`) giữ làm VIEW đọc từ template
content_* (tên cũ còn dùng ở test); kênh lạ fallback `content_facebook`
(`content.py:292`). Version + sha256 mỗi template ở
`data/prompts/manifest.json` và được LƯU KÈM draft
(`content_drafts.prompt_version` / `prompt_sha256`) để truy bản prompt nào
ra bài nào.

| Template | Version | sha256 (12 hex đầu) | Trạng thái |
|---|---|---|---|
| `content_facebook` | `content_facebook@1` | `be83e6bc6f76` | chờ GĐ Marketing duyệt |
| `content_zalo` | `content_zalo@1` | `0e02dfeceb3c` | chờ GĐ Marketing duyệt |
| `content_tiktok` | `content_tiktok@1` | `ad1d6269a98b` | chờ GĐ Marketing duyệt |
| `content_blog` | `content_blog@1` | `e7e70342ded5` | chờ GĐ Marketing duyệt |
| `listing_shopee` | `listing_shopee@1` | `a577eb61f3b0` | chờ GĐ Marketing duyệt |
| `listing_tiktok` | `listing_tiktok@1` | `6d7ddf0c6980` | chờ GĐ Marketing duyệt |
| `listing_web` | `listing_web@1` | `f2858677a77e` | chờ GĐ Marketing duyệt |

**Quy tắc sửa template:** sửa 1 byte nội dung (trừ CRLF↔LF — sha tính sau
khi đổi CRLF→LF) mà không cập nhật manifest → `load_template` raise
`ValueError` ("template đổi mà chưa bump version") — app/CLI dừng chứ không
chạy prompt lạ. Sửa đúng: đổi file → bump `version` (`<tên>@N+1`) → cập
nhật `sha256` trong manifest → cập nhật bảng trên. Bump version listing =
batch coi là bản mới (sinh lại nháp cho cùng SKU × kênh). Luật TPBVSK /
whitelist / câu khuyến cáo KHÔNG nằm trong template — vẫn ở system prompt
trong code (mục 1).

**Luật listing (`content.listing()`, `pipelines/content.py:477`):**
- Tên, quy cách, số ĐKSP (chỉ TPBVSK), giá (`prices[<kênh>].list` — KHÔNG
  BAO GIỜ giá sàn floor/promo), hạn sử dụng do CODE dựng từ
  `data/golden_skus.json`; thiếu giá → "Liên hệ", golden chưa có field hạn
  dùng → "Xem trên bao bì" (`data/listing_rules.json` — giới hạn ký tự sàn
  là GIẢ ĐỊNH, chờ xác minh Seller Center).
- LLM chỉ viết hook/mô tả/gạch đầu dòng/từ khóa (template listing_*, trả
  JSON) khi SKU mức `TP_THUONG`/`QC_DAY_DU`; mọi câu/mục chạm thông số
  bị LOẠI (`content._spec_like`): ký tự số mọi loại (fullwidth, ①, ², Ⅻ),
  nhãn khung (giá/quy cách/ĐKSP/hạn dùng/khối lượng/dung tích), số viết
  bằng chữ (mươi/trăm/nghìn/triệu...; một..chín kèm đơn vị), đơn vị đo
  (gram/ml/lít/vnđ...); xuống dòng bị gộp (không giả được dòng `Giá:`).
  System prompt listing là biến thể `_system(fmt, price_rule=False)`: bỏ
  câu "Không bịa giá ... ghi Liên hệ", thay "KHÔNG viết giá, quy cách,
  khối lượng, hạn dùng hay bất kỳ con số nào". JSON sai shape / gateway lỗi / vi phạm guardrail sau 1 lượt sửa
  → bỏ phần LLM, giữ khung (`meta.llm_part = dropped:*`).
- TPBVSK mức `MO_TA` = khung cố định, 0 lời gọi LLM.
- Rượu (golden `category = alcohol`) bị TỪ CHỐI mọi kênh kể cả khi map
  readiness ghi QC_DAY_DU; SKU mức `CAM` trên kênh → từ chối `readiness`.
- Nhãn AI / nhãn quảng cáo / câu khuyến cáo do CODE nối khi
  `check_publish` báo thiếu (`content._with_required`) — không trông LLM.

Nội dung các template content_* (chuyển nguyên nghĩa từ `CHANNEL_HINT`
v2.2):

```text
content_facebook: bài đăng Facebook 120-180 chữ, 1-2 emoji, có CTA inbox/hotline
content_tiktok:   kịch bản video TikTok ngắn 30-60 giây: hook 3 giây đầu + 2-3 cảnh (mỗi cảnh ghi mô tả hình ảnh + lời thoại/text overlay) + CTA cuối
content_zalo:     tin nhắn Zalo OA ngắn 60-100 chữ, lịch sự, kèm CTA
content_blog:     mở bài blog 200-300 chữ, có tiêu đề
```

## 2b. Ảnh AI (MKT-03, v6.2 — `pipelines/image_studio.py`)

Ảnh marketing NHÁP = packshot THẬT (ảnh sản phẩm công ty cấp) dán nguyên
khối lên một nền. AI (nếu có) chỉ vẽ NỀN — không bao giờ nhận ảnh sản phẩm,
không sửa nhãn bao bì. Layout/màu/font ở `data/image_studio.json` (bản dev —
chờ GĐ Marketing duyệt; font thương hiệu chưa có).

| Template | Version | sha256 (12 hex đầu) | Trạng thái |
|---|---|---|---|
| `image_background` | `image_background@1` | `fe0fd85f3967` | chờ GĐ Marketing duyệt |

Template `image_background` chỉ mô tả bối cảnh/ánh sáng/chất liệu, "không
người, không chữ, không logo, không bao bì sản phẩm", chừa khoảng trống cho
sản phẩm; `{scene}` (mô tả nền người nhập, rỗng → `default_scene` của
config) thay bằng `str.replace`. Prompt cuối + sha256 + version lưu ở sidecar
và bảng `image_assets` (truy vết).

**Luật prompt nền (`image_studio.check_scene`):** `scene` bị trả về
(`prompt_cam`) khi chứa từ `prompt_banned` (bác sĩ, blouse, dược sĩ, y tá,
bệnh viện, phòng khám, ống nghe, chữ, nhãn, logo, bao bì, trước sau... — khớp
chuẩn hóa như guardrail: hoa/thường, có/không dấu, ký tự chèn), câu nhắc
sức khỏe/bệnh (`llm_gateway.is_health_question`) hoặc `guardrail.check`
không ok (vd nhắc rượu). Ví dụ "bác sĩ áo blouse cầm sản phẩm" → trả về.

**Provider nền:** env `IMAGE_PROVIDER`, mặc định `none` = gradient tất định 2
màu `brand_colors`, 0 lời gọi mạng, `ai_generated=false`. Provider thật
(OpenAI/Google/Stability… — có phí) = **external-dep**, CHƯA cắm: hàm
`fn(prompt, size) -> (PIL.Image, {"model": str})` đăng ký vào
`image_studio.PROVIDERS` SAU khi có key + hợp đồng, và PHẢI bọc như
`llm_gateway` (kill-switch `LLM_KILL` + trần chi phí tháng agent `image`
trong `data/llm_gateway.json` + ghi `llm_usage`). Provider trả sai kích
thước / lỗi / không khai model → từ chối `provider` (không resize ngầm).

**Luật nhãn:** nhãn AI `labels.ai[0]` ("Nội dung có sử dụng AI") LUÔN vẽ
trên tấm nền ở `label_box` — kể cả nền tất định (lúc duyệt store kiểm lại
với is_ai cố định, thiếu nhãn = không duyệt được; Pháp chế quyết sau có cần
không). Loại `image` là quảng cáo (`ad: true`) → nhãn QC `labels.ad[0]`
cũng vẽ. Cỡ chữ nhãn = max(`font_px_min`, `font_ratio` × cao ảnh) — không
vừa ô → từ chối `config` (không thu nhỏ nhãn). Font phải đủ glyph mọi ký
tự (kiểm từng ký tự) — thiếu → từ chối `font`, không vẽ ô vuông. MỌI chữ
trên ảnh (headline + nhãn) = `text_layer`, qua `check_publish_llm`.

**Luật packshot:** dán SAU CÙNG bằng alpha của chính nó, chỉ THU NHỎ (không
phóng) 1 lần; ô headline/nhãn không được giao ô packshot (`config`). Sau khi
ghi PNG, đọc lại và so MỌI pixel đặc (alpha 255) của packshot đã thu nhỏ
với ảnh — lệch 1 pixel → `packshot_lech`, xóa file, không ghi DB. Output
chỉ PNG, dựng mới từ pixel → không EXIF/GPS/XMP/ICC.

**Từ chối trước khi gọi provider (0 file, 0 dòng DB):** rượu (`ruou`, mọi
kênh/format kể cả map QC_DAY_DU), MỌI SKU TPBVSK (`maket_xnqc` — "creative
TPBVSK phải dùng maket XNQC", hồ sơ XNQC chưa có), SKU chưa đủ readiness
kênh (`readiness` — cần TP_THUONG/QC_DAY_DU), kênh/format lạ, headline vi
phạm/dài (`headline`), prompt nền cấm (`prompt_cam`), thiếu font, packshot
thiếu/hỏng (`packshot_thieu`/`packshot_loi`). Eval: `python
scripts/agent_eval.py --agent mkt03 --no-record` (suite
`data/eval/suites/mkt03.json`, chờ GĐ Marketing/Pháp chế duyệt nhãn).

## 2c. Video ngắn AI (MKT-04, v6.3 — `pipelines/video_studio.py`)

Video dọc NHÁP (9:16 hoặc 1:1, 16–44 giây) dựng TẤT ĐỊNH từ khung PNG: khung
packshot = `image_studio.compose` (packshot thật nguyên vẹn + phụ đề ở ô
headline + nhãn), khung B-roll = ảnh tĩnh công ty cấp có license, khung kết =
tên SKU golden (do code). AI chỉ viết KỊCH BẢN (phụ đề). Cấu hình
`data/video_studio.json` (bản dev — chờ GĐ Marketing duyệt template video/
layout; font thương hiệu, B-roll quay thật, nhạc có license chưa có).

| Template | Version | sha256 (12 hex đầu) | Trạng thái |
|---|---|---|---|
| `video_script` | `video_script@1` | `bba8df8bd37f` | chờ GĐ Marketing duyệt |

Template `video_script` đòi DUY NHẤT JSON `{"scenes": [{"text", "visual":
"packshot"|"broll"}]}`, 5–8 cảnh, mỗi câu ≤ 60 ký tự, không người/bác sĩ/
chuyên gia/cơ sở y tế, không trước-sau, không số/giá. `{channel}`,
`{sku_name}`, `{brief}` thay bằng `str.replace` (brief thay CUỐI); template
điền xong làm phần định dạng của system prompt `content._system(...,
price_rule=False)` (luật TPBVSK + "không viết số"). Gọi
`llm_gateway.chat("mkt_video", ...)` — cap tháng `mkt_video` 2.0 USD (ước
tính dev) trong `data/llm_gateway.json`, kill-switch `LLM_KILL=mkt_video`.

**Luật kịch bản:** câu chạm số/giá/quy cách (`content._spec_like` — kể cả
viết bằng chữ, số fullwidth) bị BỎ (`so_lieu`; v6.3 không đưa giá vào video
— giá đổi theo kênh/khuyến mãi, video sống lâu hơn giá); câu dài >
`subtitle.max_chars` bỏ (`dai`); quá `max_scenes` bỏ đuôi (`thua`). Từ cấm
`script_banned` (bác sĩ, dược sĩ, y tá, chuyên gia, khuyên dùng, bệnh viện,
phòng khám, lâm sàng, kiểm chứng, trước sau, cam kết hiệu quả... — khớp
chuẩn hóa như guardrail, cả dạng "chuyên-gia") trên MỌI câu LLM trả, hoặc
caption không qua `check_publish_llm` (content_type `video`) → 1 lượt sửa có
feedback → còn vi phạm → từ chối `kich_ban` (vd "Bác sĩ khuyên dùng mỗi
sáng" bị chặn TRƯỚC khi dựng). JSON sai mẫu / còn < 3 cảnh → `kich_ban`.

**Từ chối trước LLM (0 lời gọi):** rượu (`ruou`), MỌI SKU TPBVSK
(`maket_xnqc` — "creative TPBVSK phải dùng maket XNQC", vd brief "video
TikTok Sapentol hook mới"), SKU chưa đủ readiness (`readiness`), kênh/format
lạ, brief có từ cấm/nhắc sức khỏe/vi phạm guardrail/dài > 500 (`brief_cam`),
TTS chưa cắm (`tts`), thiếu packshot (`packshot_thieu`).

**TTS:** env `TTS_PROVIDER`, mặc định `none` = video không tiếng (không
giọng, không nhạc), 0 mạng. Provider thật (TTS tiếng Việt có phí) =
**external-dep**, CHƯA cắm: hàm `fn(text, voice) -> (wav_bytes, {"model",
"voice"})` vào `video_studio.TTS_PROVIDERS`, `voice` chỉ là giọng THƯ VIỆN
của nhà cung cấp (`tts.voices`) — KHÔNG có tham số âm thanh/ảnh mẫu, không
nhân bản giọng/hình người thật; PHẢI bọc như `llm_gateway` (kill-switch +
cap agent `mkt_video_tts` + `llm_usage`).

**Nhãn:** kịch bản luôn do LLM → video luôn là nội dung AI: nhãn
"Nội dung có sử dụng AI" (`labels.ai[0]`) + nhãn QC (`labels.ad[0]`, loại
`video` có `ad: true`) vẽ trên MỌI khung (suốt video) và có trong caption
nháp. Sau mã hóa trích 3 khung (đầu/giữa/cuối) kiểm nhãn còn hiện (pixel
gần màu chữ nhãn ≥ 0.5 × khung nguồn) — thiếu → `nhan_ai`, xóa mp4.

**Packshot:** khung packshot dựng bằng `image_studio.compose` (packshot dán
sau cùng + kiểm pixel), rồi video_studio đọc lại BYTES khung và chạy
`verify_packshot` TRƯỚC khi ghép — lệch 1 pixel → `packshot_lech`, 0 mp4.
mp4 ghép bằng ffmpeg không shell, không metadata (`-map_metadata -1`,
bitexact), không track âm thanh. Eval: `python scripts/agent_eval.py --agent
mkt04 --no-record` (suite `data/eval/suites/mkt04.json`, LLM giả, chờ GĐ
Marketing/Pháp chế duyệt).

## 3. System prompt — chatbot CSKH (`api/rag.py:23-42`)

Hằng `SYSTEM` dùng trong `answer()`; sentinel `NO_DATA = "Chưa đủ dữ
liệu để trả lời."` (`api/rag.py:21`), ngưỡng retrieve `MIN_SCORE =
0.25`, top-k `TOP_K = 8` (`api/rag.py:19-20`).

```text
Bạn là trợ lý CSKH của Công ty TNHH Sâm Sâm (sâm Ngọc Linh).
Trả lời bằng tiếng Việt, ngắn gọn, CHỈ dựa vào NGỮ CẢNH bên dưới.

Luật:
- Thông tin không có trong ngữ cảnh -> trả lời đúng câu "Chưa đủ dữ liệu để trả lời."
- Giá ghi 'Liên hệ' -> nói nguyên văn 'Liên hệ', tuyệt đối không tự bịa giá.
- Tên sản phẩm kèm hậu tố quy cách (vd 'Saphraton 20V') là MỘT QUY CÁCH
  của sản phẩm gốc, không phải sản phẩm khác. Hỏi giá/loại sản phẩm X phải
  nêu ĐỦ giá của cả X lẫn mọi quy cách 'X ...' trong ngữ cảnh.
  VD: hỏi 'Saphraton giá bao nhiêu' mà ngữ cảnh có 'Saphraton — 1.000.000 đ'
  và 'Saphraton 20V — 236.000 đ' thì PHẢI trả lời: 'Saphraton hộp 80 viên:
  1.000.000 đ; gói Saphraton 20V: 236.000 đ'. Hỏi danh sách sản phẩm ->
  liệt kê tên sản phẩm, không kể nhóm công dụng.
- 'Mã số doanh nghiệp' chính là mã số thuế của công ty.
- Hỏi liên hệ/hotline/điện thoại -> liệt kê ĐỦ mọi số xuất hiện trong
  ngữ cảnh kèm nhãn của nó (vd 'Hotline:', 'ĐT:').
- Không khẳng định công dụng y tế ngoài công dụng đã công bố trong ngữ cảnh;
  tuyệt đối không nói sản phẩm "chữa", "điều trị", "thuốc", "khỏi bệnh".
- Không trích link trong câu trả lời — nguồn do hệ thống hiển thị riêng.
```

## 4. Prompt phụ — rewrite câu follow-up (`api/rag.py:93-97`)

Dùng khi chat có history: viết lại câu hỏi cuối thành câu độc lập để
retrieve (chỉ phục vụ retrieval, câu trả lời vẫn dùng câu gốc của
user):

```text
Viết lại câu hỏi cuối của user thành một câu hỏi độc lập, đủ ngữ cảnh
để tra knowledge base, giữ nguyên ngôn ngữ. Chỉ trả về câu hỏi đã viết
lại, không giải thích.
```

## 5. Brand voice (rút ra từ prompt đang chạy)

- **Tự hào đặc sản quê hương** (Nam Trà My, Quảng Nam — v4.2 bỏ "Ngọc
  Linh" tới khi Pháp chế xác nhận chỉ dẫn địa lý),
  **tử tế, không phóng đại** — đây là luật giọng điệu cứng trong system
  prompt, không phải gợi ý.
- Mở/kết bài: kể chuyện thương hiệu, đặc sản quê hương, quà tặng —
  không động từ claim.
- Công dụng: chỉ whitelist của ĐÚNG SKU, gần nguyên văn; kèm câu khuyến
  cáo chuẩn `disclaimer.canonical` ("Thực phẩm này không phải là thuốc
  và không có tác dụng thay thế thuốc chữa bệnh.") khi nêu công dụng/
  nhắc TPBVSK; bài đăng mang nhãn "Nội dung có sử dụng AI".
- Giá: sản phẩm chưa công khai giá → ghi "Liên hệ", tuyệt đối không bịa.
- CTA đặc thù kênh: FB → inbox/hotline; Zalo OA → tin nhắn ngắn lịch sự;
  TikTok → kịch bản có hook + cảnh + CTA cuối.
- Xưng hô mẫu câu cứng trong các hằng gửi khách (`connectors/zalo.py`):
  "Sâm Sâm" — "Quý khách", kèm hotline 1800577732 (FALLBACK /
  HANDOFF_TEXT / NON_TEXT_TEXT / WELCOME_TEXT — text viết tay, không
  qua LLM).

## 6. Template brief mẫu (3 loại — dán vào ô Brief của Content Studio)

**A. Giới thiệu sản phẩm có claim:**
```
Viết bài giới thiệu Sapentol cho người tiểu đường: nhấn công dụng đã
công bố (hỗ trợ hạ đường huyết, giảm mỡ máu), kể thêm gốc vườn Nam
Trà My; CTA inbox để tư vấn.
```

**B. Kịch bản video TikTok:**
```
Viết kịch bản TikTok: nhân viên vườn dẫn khách đi khoảnh sâm vùng
Trà Linh — cảnh mở là rừng sâm, thoại giới thiệu cây sâm trồng
dưới tán rừng tự nhiên, kết mời ghé showroom/xem sản phẩm. Không nêu
công dụng.
```

**C. Tin Zalo OA chăm sóc khách:**
```
Viết tin nhắn Zalo OA: cảm ơn khách đã mua Saphraton tuần trước, nhắc
uống đúng hướng dẫn trên hộp, mời gọi hotline khi cần hỗ trợ; giới
thiệu thêm rượu sâm No.7 làm quà biếu. Không nêu công dụng mới.
```

Mẹo viết brief hiệu quả:

- Ghi rõ **sản phẩm + đối tượng + mục tiêu bài + CTA**; nêu thẳng claim
  đã công bố muốn nhấn (model chỉ được dùng whitelist).
- Muốn bài không công dụng (bài thương hiệu): ghi "không nêu công
  dụng" — an toàn tuyệt đối với guardrail.
- Draft bị guardrail chặn lặp: rà lại brief xem có tự gợi claim ngoài
  whitelist không; claim mới đã công bố thật → báo bổ sung
  `data/claims_whitelist.json` (xem `sop.md` mục 3).
