# Fixture PC-A4 rà kênh (v4.3) — F1–F5

File CSV dạng "file xuất tay" cho `python -m agents.ra_kenh --file`.
Cột: `url, kenh, is_ai, ngay_dang, text` (không comment trong CSV).
Text lấy từ dữ liệu crawl CÔNG KHAI trong repo — **CHƯA phải bản xuất
thật từ kênh**; Chuyên viên Pháp chế xác nhận kết quả quét lần đầu và đóng
băng fixture = external-dep.

| Mã | URL | Nguồn text | Ghi chú |
|---|---|---|---|
| F1 | `https://samsamngoclinh.com/` | tên + mô tả các sản phẩm `https://samsamngoclinh.com/product/*` trong `data/products.jsonl` | dựng từ crawl, CHƯA phải bản xuất trang chủ thật; ngày trống |
| F2 | `http://samsam.net.vn/` | `body` trang `ve-chung-toi` trong `data/about.jsonl` | ngày trống |
| F3 | `https://samsamngoclinh.com/product/savigout/` | `description` trong `data/products.jsonl` | ngày trống |
| F4 | `http://samsam.net.vn/vi/news/cam-nang-suc-khoe/savigout-xua-tan-noi-lo-benh-gout-10.html` | `body` trong `data/news.jsonl` | `ngay_dang` 2021-01-11 (trước quy trình duyệt) |
| F5 | `https://samsam.net.vn/` | trang mặc định hosting MẪU | giả lập, chờ bản chụp thật |

`f4_quet_lai.csv`: F4 sau khi NGƯỜI sửa bỏ hết từ cấm (thay 6 cụm), vẫn
nhắc Savigout nên còn `sku_chua_xnqc` — dùng kiểm "quét lại xác nhận"
(đồng hồ 24h không reset khi sửa dở).

Kỳ vọng (guardrail v4.1, `check_publish` kênh web, loại post, `is_ai=0`):
F1 S1 · F2 S2 (`ngoc_linh_chua_xac_nhan` + `thieu_ban_duyet`) · F3 S1 ·
F4 S1 (không `thieu_ban_duyet` vì 2021) · F5 chỉ `trang_mac_dinh_hosting`
(mục hạ tầng `hosting_fix`). Cả 5 `is_ai=0`.
