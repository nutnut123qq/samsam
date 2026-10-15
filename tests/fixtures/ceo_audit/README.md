# Fixture audit outside-in P1 (v8.1 W81.4) — DỮ LIỆU MẪU

File MẪU cho `tests/test_ceo_audit.py` (nghiệm thu WP10: "Audit outside-in
phát hiện đúng bài lệch bản approved trên fixture"). Không có tên/SĐT/email
người thật; text bài sạch guardrail và mang nhãn AI. Danh sách bài đang đăng
THẬT + file listing Seller Center THẬT = external-dep.

## `posts_MAU.csv` — bài đang đăng (định dạng `agents.ra_kenh`)

`draft_id` `__DRAFT_Pn__` là chỗ trống: test tạo draft thật bằng
`store.save_draft` + duyệt `store.set_status(..., 'approved', <người khác>)`
rồi sinh bản tmp thay id thật trước khi nạp qua `ra_kenh.ingest`.

| Dòng | Bài | Thiết lập | Kỳ vọng audit |
|---|---|---|---|
| P1 | facebook `posts/p1` | text ĐÚNG bản duyệt draft P1 | `khop` |
| P2 | facebook `posts/p2` | bản duyệt draft P2 + sửa 1 ký tự (`.` → `!`) | `lech_ban_duyet` |
| P3 | facebook `posts/p3?ref=0905123456` | không `draft_id`, ngày 2026-10-13 ≥ `quy_trinh_duyet_tu` | `thieu_ban_duyet` (URL có SĐT GIẢ — report phải che) |
| P4 | facebook `posts/p4` | không `draft_id`, ngày 2026-09-01 | `truoc_quy_trinh` (ngoài mẫu số) |
| P5 | facebook `posts/p5` | text ĐÚNG bản duyệt draft P5 lúc nạp; SAU khi nạp test thêm 1 dòng `approvals` `rejected` (thu hồi) cùng sha | `thieu_ban_duyet` (chứng minh tính lại, không tin `codes` lưu) |
| P6 | facebook `posts/p6` | không `draft_id` → vi phạm mở; NGƯỜI `--mark-removed` | đã gỡ (ngoài mẫu số) |

Facebook: mẫu số 4 (P1, P2, P3, P5), khớp 1 → 25%.

## `listing_shopee_MAU.csv` — listing Shopee (header theo `data/market_csv_map.json`)

Test tạo nháp listing bằng `pipelines.content.listing(sku, 'shopee',
llm=False)` → `store.save_draft(content_type='listing')` → duyệt; nạp file
bằng `market_csv.read_export` + `load` (golden nạp vào schema tạm).

| Dòng | Item | SKU (map theo `shopee_item_id`) | Thiết lập | Kỳ vọng |
|---|---|---|---|---|
| L1 | 24325987926 | savigout-30v | tiêu đề == dòng đầu listing đã duyệt | `khop` |
| L2 | 27357883504 | savina-12v | có listing duyệt nhưng tiêu đề khác | `lech_ban_duyet` |
| L3 | 24825885894 | saphraton-20v | không có listing duyệt | `thieu_ban_duyet` |
| L4 | 99900000002 | (không map) | item không có trong golden | `khong_xac_dinh_sku` |

Shopee: mẫu số 4, khớp 1 → 25%. TikTok: không có file → "chưa có dữ liệu
quan sát (chỉ file xuất tay)".
