# Hồ sơ XNQC (PC-A1) và rà kênh sở hữu, gỡ/sửa 24 giờ (PC-A4) — BẢN NHÁP

> **BẢN NHÁP — chờ Chuyên viên Pháp chế duyệt.** Agent không kết luận tuân
> thủ; mọi ngưỡng, câu chữ, luật S1/S2 và cấu hình `data/phap_che.json` là
> bản dev soạn (v4.3, WP05).

- **Dành cho ai:** Chuyên viên Pháp chế (người DUY NHẤT duyệt), Quản lý
  MXH – sàn (xuất danh sách bài, người được ủy quyền gỡ/ẩn tuyến 1), Quản lý
  hạ tầng AI (mục trang mặc định hosting), người phụ trách golden.
- **Làm gì:** theo dõi hồ sơ XNQC từng SKU tới hạn đợt 2 (trước
  30/11/2026); rà bài ĐANG ĐĂNG trên kênh sở hữu, mở lệnh gỡ/sửa có hạn 24
  giờ; báo cáo Pháp chế tuần.
- **Cần gì:** file xuất tay danh sách bài (CSV), scan giấy XNQC đã nạp qua
  `ingest.doc_intake` và được Pháp chế đối chiếu bản gốc, DB `DATABASE_URL`.

## 1. Agent làm gì — và KHÔNG làm gì

Agent CHỈ phát hiện + đề xuất. KHÔNG gỡ/sửa/ẩn bài trên kênh, KHÔNG gọi API
kênh, KHÔNG sửa golden (file lẫn bảng), KHÔNG tự chuyển hồ sơ sang
`da_cap`, KHÔNG tự quyết mục hàng duyệt. Không dùng LLM, không gửi dữ liệu
ra ngoài.

## 2. Sổ hồ sơ XNQC (PC-A1)

Mỗi maket/kịch bản là 1 hồ sơ. Trạng thái: `chuan_bi → da_nop → (bo_sung →
da_nop)* → da_cap → het_han`. Chuyển khác bị từ chối.

```
python -m agents.xnqc --add --sku savigout-30v --loai maket --ten "maket fanpage" --by "<tên Pháp chế>"
python -m agents.xnqc --set <id> --status da_nop --ngay-nop 2026-11-20 --by "<tên>"
python -m agents.xnqc --set <id> --status da_cap --so-giay <số> --ngay-cap <ngày> --doc-sha <sha256 scan> --by "<tên>" [--het-han <ngày>]
python -m agents.xnqc --list
python -m agents.xnqc --remind [--today 2026-11-16]
python -m agents.xnqc --sync-golden
```

- `da_cap` cần: tên NGƯỜI (không `agent:`/`system:`), số giấy, ngày cấp
  (không ở tương lai), scan giấy trong `documents` đã `verified` (Pháp chế
  chạy `python -m ingest.doc_intake --verify <sha> --by "<tên>"` sau khi
  đối chiếu bản gốc). DB cũng chặn bằng CHECK.
- Nhắc mốc: CHƯA NỘP / SẮP HẠN (≤ 14 ngày) / QUÁ HẠN đợt 2; giấy SẮP HẾT HẠN
  (≤ 30 ngày) / ĐÃ QUÁ HẠN (Pháp chế tự chuyển `het_han`).
- **Đồng bộ golden:** khi trạng thái hồ sơ làm `xnqc_status` của SKU khác
  `data/golden_skus.json`, agent đẩy mục `golden_xnqc_sync` (hạn 72 giờ) vào
  hàng duyệt. Pháp chế duyệt (`python -m pipelines.approval_queue
  --approve <id> --by "<tên>"`) rồi người phụ trách golden sửa file và chạy
  `python -m ingest.golden_store`. Guardrail chỉ cho quảng cáo TPBVSK khi
  golden đã `approved`. Hồ sơ đổi trong lúc mục cũ còn chờ (vd đã cấp rồi
  hết hạn trong 72 giờ) → mục mới ghi "THAY THẾ mục #X — chỉ duyệt mục mới
  nhất"; `python -m agents.xnqc --sync-golden` và báo cáo tuần mục 1 liệt
  kê mục LỖI THỜI (KHÔNG duyệt) và mục đã duyệt đang chờ người sửa golden.
  Agent không tự duyệt/rút mục nào.

## 3. Rà kênh sở hữu, lệnh gỡ/sửa 24 giờ (PC-A4)

### Định dạng file xuất tay (CSV UTF-8, ≤ 5 MB, ≤ 2 000 dòng)

| Cột | Bắt buộc | Ý nghĩa |
|---|---|---|
| `url` | có | link bài (http/https). Kênh `web` chỉ nhận host website sở hữu |
| `kenh` | có | shopee / tiktok / web / facebook / zalo / chatbot (`blog` = web) |
| `is_ai` | có | 0/1 — ô trống coi là 1 (có AI, phải có nhãn) |
| `text` | có | toàn văn bài đang đăng |
| `loai_noi_dung` | không | post (mặc định) / ads / koc / livestream_script / ... |
| `ngay_dang` | không | YYYY-MM-DD — trống coi như bài mới |
| `draft_id` | không | id bản đã duyệt trong hàng duyệt nội dung |
| `sku` | không | sku_key golden |
| `is_sponsored` | không | 0/1 |

Ví dụ (không PII):

```
url,kenh,is_ai,ngay_dang,draft_id,text
https://samsamngoclinh.com/product/vi-du/,web,0,2026-10-12,15,"Nội dung bài..."
```

Cột khác (bình luận, tên người tương tác...) → cả file bị từ chối. Lỗi chỉ
in số dòng + tên cột, không in giá trị ô.

### Quy trình

1. Quản lý MXH xuất danh sách bài đang đăng của kênh sở hữu.
2. Xem trước: `python -m agents.ra_kenh --file <csv> --by "<tên>" --dry-run`
   (không ghi DB; chưa kiểm lệch bản duyệt).
3. Pháp chế xem kết quả, nạp: `python -m agents.ra_kenh --file <csv> --by
   "<tên>"`. Nạp lại cùng file không sinh gì mới — trừ khi luật guardrail,
   golden hoặc cột bài (vd thêm `draft_id`) đổi: bài được rà lại và mở/đóng
   vi phạm theo kết quả mới. Giờ ghi nhận luôn là giờ thật (`--now` chỉ
   dùng cho `--report`/`--dry-run`).
4. Mỗi bài vi phạm có 1 mục `channel_takedown` (khối Pháp chế, hạn 24 giờ
   đồng hồ thật kể cả T7/CN/Tết); trang mặc định hosting (chỉ kênh web,
   khi KHÔNG có vi phạm nội dung — có thì vẫn là mục Pháp chế) → mục
   `hosting_fix` (khối hạ tầng). S1 ghi thêm cảnh báo đỏ. URL đổi giữa trang
   mặc định và nội dung vi phạm → đợt mới, mục mới đúng khối.
5. Pháp chế duyệt mục = xác nhận lệnh gỡ/sửa. Người được ủy quyền gỡ/ẩn hoặc
   sửa trên kênh (agent không làm).
6. Đóng vi phạm: xuất lại danh sách (bài đã sạch → `da_sua`) hoặc ghi nhận
   đã gỡ: `python -m agents.ra_kenh --mark-removed <url> --by "<tên>"`.
   Duyệt/từ chối/hết hạn mục hàng duyệt KHÔNG đóng vi phạm. Sửa dở (vẫn còn
   vi phạm) không đặt lại đồng hồ 24 giờ.
7. Báo cáo tuần: `python -m agents.ra_kenh --report [--days 7]` → hồ sơ XNQC
   theo trạng thái, vi phạm mở theo URL, khối QUÁ 24H, đã đóng đúng hạn/trễ,
   lệch/thiếu bản duyệt, mục hạ tầng.

### Mức S1/S2 (plan §5 — bản dev)

- **S1**: có vi phạm mức critical — từ cấm, quảng cáo rượu, TPBVSK chưa
  XNQC, thiếu câu khuyến cáo. Người được ủy quyền ẩn ngay.
- **S2**: còn lại — lệch bản đã duyệt (`lech_ban_duyet`), thiếu bản duyệt
  (`thieu_ban_duyet`, bài đăng từ 12/10/2026 không có `draft_id`), thiếu
  nhãn, "Ngọc Linh" chưa xác nhận, trang mặc định hosting.

## 4. Phụ thuộc bên ngoài (chưa có — không giả lập)

- Quyền đọc kênh thật (API Fanpage/TikTok/Shopee) — hiện chỉ file xuất tay;
  danh sách page/tài khoản sở hữu ngoài 2 website.
- Chuyên viên Pháp chế xác nhận kết quả quét lần đầu F1–F5 + đóng băng.
- Hồ sơ XNQC thật (số giấy, ngày cấp, scan) — DB hiện chỉ có dữ liệu test.
- Người nhận cảnh báo đỏ (`data/red_alert_routing.json` đang rỗng).
- Văn bản ủy quyền GỠ/ẨN + lịch trực (TGĐ ký).
- Đăng nhập SSO/vai trò cho `--by` (pilot ghi tên tự do).
- Chưa làm: leo thang S2 sau 2 giờ (A0-3), hạn nộp sửa 90 ngày, quét trực
  tiếp website.
