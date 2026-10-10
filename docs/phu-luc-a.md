# Phụ lục A — Danh mục & số lượng dữ liệu số hóa (DRAFT)

Phụ lục kèm SOW (§11 — "điền sau data audit tuần 1–2"). Bảng kê dưới
được **đếm thật** bằng `python scripts/data_audit.py` — số liệu trong
bảng phải khớp log mới nhất `evidence/v18_audit.log` (chạy lại script
khi data thay đổi, KHÔNG sửa số bằng tay).

*Snapshot 2026-10-10:*

| Domain (SOW) | File nguồn | Records | DB lõi (theo nguồn) | Trạng thái |
|---|---|---|---|---|
| Sản phẩm + bảng giá (P0) | `data/products.jsonl` | 27 | 27 | thật (crawl) |
| Bài báo/cẩm nang (P0) | `data/articles.jsonl` | 103 | 103 | thật (crawl) |
| Tin tức + điểm phân phối (P0) | `data/news.jsonl` | 41 | 41 | thật (crawl) |
| Giới thiệu công ty (P0) | `data/about.jsonl` | 4 | 10 | thật (crawl) |
| Vùng trồng/khoảnh (P1) | `data/sample_plots.jsonl` | 3 | 3 | MẪU — chờ bàn giao |
| Nhật ký vườn (P1) | `data/sample_plot_logs.jsonl` | 6 | 6 | MẪU — chờ bàn giao |
| Bán hàng/đơn (P1) | `data/sample_orders.jsonl` | 5 | 5 | MẪU — chờ bàn giao |
| Claims đã công bố (P0) | `data/claims_whitelist.json` | 10 SKU / 18 claim | 22 | thật (trích tay từ crawl) |
| Ảnh/media sản phẩm (P0) | images[] trong products.jsonl | 75 | 75 | thật (crawl) |
| Vector index (phục vụ WS2/WS3) | bảng `chunks` | — | 916 | đã embed |

Ghi chú đọc bảng:
- "DB lõi (theo nguồn)" = số row trong bảng lõi Postgres `samsam` do
  nguồn đó nạp (cột `source`). `assets` gom ảnh + bài báo (kind=
  image/article); dòng "Giới thiệu" đếm số chunk trong `chunks` (mỗi
  record → vài chunk), không phải bảng lõi riêng.
- `claims_approved` có 22 rows = 18 claim đã công bố + 4 marker
  claim=NULL cho SKU "chưa có công bố" (không suy diễn).
- `orders` không lưu PII khách (quyết định pilot — xem schema).

## Domain còn chờ công ty bàn giao (SOW §5.2)

Chưa thể đếm vì chưa có data — **đây là phần Phụ lục A phải bổ sung sau
data audit thật tại công ty**:

| Domain | Dạng dữ liệu kỳ vọng | Phục vụ |
|---|---|---|
| Hồ sơ pháp lý & công bố sản phẩm gốc (P0) | Scan/PDF theo SKU, số ĐKSP | Thay claims_whitelist tự trích → guardrail |
| Catalog + bảng giá chính thức (P0) | File/excel giá niêm yết | Đối chiếu products.jsonl |
| Tài sản truyền thông trong drive công ty (P0) | Ảnh/video gốc, bài báo clipping | assets |
| Dữ liệu vùng trồng thật (P1) | Bản đồ khoảnh, số cây, giống, nhật ký | plots, plot_logs |
| Sổ bán hàng/điểm phân phối thật (P1) | Sổ/excel bán hàng, 13 điểm đã crawl | orders |

## Quy trình nhập liệu mới (WS1)

- **Nhật ký vùng trồng**: hiện nạp qua `data/sample_plot_logs.jsonl`
  (format chuẩn hóa sẵn: `{plot_id, ts, activity, detail, author}` →
  `python -m ingest.core_store`). Form/chat nhập liệu cho nhân viên
  vườn là phần WS3 (agent nhật ký) — cùng bảng `plot_logs`.
- **Sản phẩm/đơn hàng nhập tay**: insert trực tiếp với
  `source='manual'` — loader chỉ xóa-nạp lại rows của file nguồn nên
  không đè nhập tay.
