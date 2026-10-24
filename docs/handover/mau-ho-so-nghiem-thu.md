# Mẫu hồ sơ nghiệm thu P1/P2 — DỰ THẢO (PL05 chưa được cung cấp)

Đợt an toàn + nghiệm thu A06 (22/10/2026). **DỰ THẢO do Bên A soạn** để người có
thẩm quyền dùng tạm khi chưa có mẫu PL05; khi có PL05 thì thay theo PL05. Không
phải biên bản; mọi ô chữ ký/ngày/số để TRỐNG. Hồ sơ cụ thể (có tên người, số
liệu kinh doanh) lưu NGOÀI repo public; repo chỉ giữ mẫu + tham chiếu.

## 0. Bộ hồ sơ đề nghị nghiệm thu (PL02 mục 1d) — lệnh dựng

| Thành phần | Lệnh / nguồn | Ghi chú |
|---|---|---|
| Danh sách tính năng/hạng mục theo giai đoạn + kết quả chạy thử + nhật ký lỗi nghiêm trọng + sự cố vận hành + tiêu chí kỹ thuật + phiên bản bàn giao + ngoại lệ | `python -m pipelines.rollout --dossier --phase P1\|P2 --out <ngoài repo>/ho-so-P1.md` (chạy trên DB server Bên B) | tiêu đề DỰ THẢO; sha256 tệp ghi vào sổ nghĩa vụ mục 6 khi gửi |
| Ma trận 96 mục (điều kiện, thiếu gì, tiêu chí hành vi) | `python -m pipelines.acceptance --matrix --db --out <ngoài repo>/ma-tran.md` | |
| KPI + tiêu chí kỹ thuật tháng | `python scripts/ops_monthly.py --month YYYY-MM` | thiếu dữ liệu = "chưa có dữ liệu", không thành 100% |
| Bằng chứng duyệt từng đầu ra | `python -m pipelines.rollout --outputs ID` | |
| Chuỗi nhật ký | `python -m pipelines.store --verify-log`; `python -m agents.bks_audit --report --month YYYY-MM` | |
| Diễn tập khôi phục (30/11, 18/12, mỗi quý) | `python scripts/db_restore_drill.py` trên server Bên B | DR Docker dev KHÔNG thay |
| Tài sản bàn giao | `data/tai_san_hop_tac.json` + commit/tag + sha256 schema/roles/danh mục (mục 6 hồ sơ) | |

## 1. Biên bản giao nhận hồ sơ đề nghị nghiệm thu — DỰ THẢO

- Giai đoạn: P1 / P2 (gạch bỏ)
- Hồ sơ giao: tên tệp …… · sha256 …… · số trang/mục ……
- Phiên bản mã nguồn: commit/tag …… · sha256 `docs/schema.sql` …… · `docs/roles.sql` ……
- Danh sách ngoại lệ/blocker còn mở kèm theo: có / không
- Ngày Bên B NHẬN hồ sơ: ……/……/…… (mốc 30 ngày PL02 mục 1đ tính từ ngày này —
  KHÔNG tính từ ngày tạo tệp)
- Hình thức nhận: biên bản ký / email xác nhận (đính kèm) ……

| Đại diện Bên A (giao) | Đại diện Bên B (nhận) |
|---|---|
| | |

## 2. Danh sách lỗi (Bên B gửi trong 30 ngày) — DỰ THẢO

Ngày Bên A NHẬN danh sách: ……/……/…… (hạn sửa 07 ngày PL02 mục 1e tính từ ngày này)

| # | Mục/ID | Mô tả lỗi | Mức (nghiêm trọng/thường) | Bằng chứng | Ngày sửa xong | Bằng chứng kiểm lại | Bên B xác nhận |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |

## 3. Đề nghị nghiệm thu lại phần đã sửa — DỰ THẢO

- Danh sách lỗi số/ngày: ……
- Phần đã sửa + bằng chứng kiểm lại (lệnh, kết quả, commit): ……
- Ngày gửi đề nghị: ……

| Đại diện Bên A | Đại diện Bên B |
|---|---|
| | |

## 4. Quy tắc đồng hồ (ghi vào sổ nghĩa vụ mục 6)

- 30 ngày: chỉ chạy từ bằng chứng Bên B THỰC nhận bàn giao (mục 1).
- "Coi là đã nghiệm thu" (PL02 1đ): chỉ ghi khi có ĐỦ bằng chứng giao nhận + hết
  30 ngày + bằng chứng không có danh sách lỗi, VÀ người có thẩm quyền xác nhận
  áp dụng điều khoản — repo/agent không tự đánh dấu, không đổi
  `acceptance_status`.
- 07 ngày sửa: từ ngày Bên A nhận danh sách lỗi; mỗi lỗi có bằng chứng kiểm
  lại trước khi đề nghị nghiệm thu lại.
- Hồ sơ KHÔNG tự gửi: người có quyền của Bên A gửi và ghi sha256 + ngày gửi.
