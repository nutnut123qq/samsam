# Sổ nghĩa vụ hợp đồng ngoài code (v13.8 C10)

Căn cứ: Hợp đồng hợp tác đầu tư TEDO–Sâm Sâm 2026 + PL01–04 (bản gốc KHÔNG
nằm trong repo — repo public; sổ này chỉ dẫn số điều khoản, không chép
nguyên văn, không ghi MST/tên người ký/địa chỉ). **PL05 (mẫu biên bản nghiệm
thu, giao nhận, đối soát) CHƯA được cung cấp** — mọi biên bản dưới đây chờ
mẫu PL05.

Đây là checklist thủ công: hợp đồng không bắt buộc tự động hóa các nghĩa vụ
pháp lý này thành phần mềm (không dựng ERP). Mỗi dòng có owner (vai trò, không
tên người), hạn, bằng chứng hoặc blocker.

**Quy ước trạng thái** — phân biệt rõ ba mức, agent KHÔNG tự nâng mức:

| Trạng thái | Nghĩa |
|---|---|
| `de_xuat` | Dev soạn/đề xuất, chưa bên nào xác nhận |
| `cho_ky` | Đã có văn bản/bằng chứng, chờ người có thẩm quyền ký |
| `da_duyet` | Có biên bản/văn bản ký của người có thẩm quyền (ghi số/ngày biên bản ở cột bằng chứng) |

Tại 15/10/2026 mọi dòng đang `de_xuat`. Mốc có ngày nằm ở
`data/projects/milestones.json` (bảng tuần `python -m agents.da_pmo --board`
liệt kê cả mốc chưa có ngày); nghĩa vụ không có mốc riêng chỉ nằm ở sổ này.

## 1. Nghĩa vụ đầu kỳ và trong thời gian thực hiện

| # | Nghĩa vụ | Căn cứ | Owner | Hạn | Bằng chứng cần có | Blocker | Trạng thái |
|---|---|---|---|---|---|---|---|
| N01 | Bố trí đội triển khai tối thiểu 02 người toàn thời gian | HĐ 6.2 | Bên A — đại diện dự án | Suốt P1 (từ ngày ký) | Danh sách vai trò + xác nhận toàn thời gian gửi Bên B (không ghi tên trong repo) | Ngày ký chưa chốt | de_xuat |
| N02 | Bàn giao hồ sơ, dữ liệu đầu vào (danh mục tối thiểu khoản 4 Điều 2) | HĐ 2.4; PL01 mục 7 | Bên B | 05 ngày kể từ ngày ký | Biên bản/email giao nhận từng hồ sơ (14 hồ sơ sản phẩm: `data/product_dossiers.json`) | Ngày ký chưa chốt — chưa tính được hạn | de_xuat |
| N03 | Bảo đảm hạ tầng (server vật lý, thiết bị, đường truyền, nơi đặt máy); Bên A cài đặt | HĐ 4 (góp của Bên B, mục hạ tầng); PL01 mục 7, 8 | Bên B (hạ tầng) / Bên A (cài đặt) | Khi bắt đầu triển khai | Biên bản bàn giao server; `deploy/onprem/README.md` checklist đạt | Server Bên B chưa bàn giao | de_xuat |
| N04 | Người duyệt cho từng phòng ban (văn bản ủy quyền) | HĐ 4 (nguồn lực kinh doanh), 6.7; PL01 mục 2 | Bên B — TGĐ | Trước Mốc B 07/11/2026 | Văn bản ủy quyền → `approvers` trong `data/directors/<khối>.json` (C04) | Chưa có văn bản; `approvers` rỗng = chế độ thực chặn hết | de_xuat |
| N05 | Đào tạo người dùng/người duyệt | Không thấy điều khoản riêng trong HĐ/PL01–04 hiện có — kế hoạch triển khai | Bên A | Trước Mốc B (đề xuất) | Biên bản/danh sách buổi đào tạo; tài liệu `docs/handover/playbook-*.md`, `sop.md` | Hai bên chốt có/không và tiêu chí — không tự coi là nghĩa vụ HĐ | de_xuat |
| N06 | Lịch trực sự cố (kể cả đóng băng Tết 21/12/2026–10/02/2027); phản hồi lỗi nghiêm trọng 03 giờ, lỗi thường 03 ngày làm việc, sửa 07 ngày | HĐ 6.5, 6.6; PL01 mục 7; PL02 mục 2 | Bên A (trực) / Bên B (người nhận cảnh báo) | Trước Mốc D 18/12/2026 | Lịch trực có người + `data/red_alert_routing.json` có người nhận độc lập; sổ sự cố (C07) | Người trực/nhận cảnh báo chưa chỉ định | de_xuat |
| N07 | Công khai xung đột lợi ích (người vừa thuộc Bên A vừa vận hành/duyệt tại Bên B); người đó không tự duyệt nghiệm thu/chi phí/quyền lợi của mình | HĐ 7.6 | Mỗi cá nhân liên quan; Bên A tổng hợp | Trước khi người đó duyệt việc đầu tiên | Văn bản công khai; code chặn người tạo tự duyệt (`pipelines.auth.authorize`, `decide_item`) | Danh sách người kiêm nhiệm chưa có | de_xuat |
| N08 | Kế hoạch năm: Bên A trình trước 30/11, Bên B duyệt trước 31/12 hằng năm | HĐ 6.1; PL01 mục 7 | Bên A (trình) / Bên B (duyệt) | 30/11/2026 và 31/12/2026 (mốc `KH-NAM-2027-*`) | Bản kế hoạch + ngân sách; văn bản duyệt | — | de_xuat |
| N09 | Danh mục tài sản hợp tác lập + cập nhật; mã nguồn ở kho HAI BÊN đều truy cập; backup hằng ngày có bản sao ngoài hệ thống | HĐ 5.4; PL01 mục 8; PL04 mục 3 | Bên A (lập) / Bên B (giữ quyền cao nhất) | Mỗi lần thay đổi + gửi kèm báo cáo tháng | `data/tai_san_hop_tac.json` (vị trí/phiên bản/chủ quản/quyền — `cho_xac_nhan`); biên bản kiểm kê | Kho chung, tài khoản quyền cao nhất, offsite chưa xác nhận | de_xuat |

## 2. Nghiệm thu, giao nhận, đối soát

| # | Nghĩa vụ | Căn cứ | Owner | Hạn | Bằng chứng cần có | Blocker | Trạng thái |
|---|---|---|---|---|---|---|---|
| N10 | Nghiệm thu từng giai đoạn bằng biên bản có chữ ký đại diện hợp pháp hai bên | HĐ 6.4; PL01 mục 6–7; PL02 | Hai bên | P1: 11/02–20/02/2027; P2: trước hết năm hợp tác thứ nhất | Biên bản theo mẫu PL05; hồ sơ đề nghị `python -m pipelines.rollout --dossier --phase P1\|P2` (chỉ là ĐỀ NGHỊ) | PL05 chưa có; ngày ký chưa chốt (P2) | de_xuat |
| N11 | Bên B phản hồi nghiệm thu trong 30 ngày kể từ ngày NHẬN BÀN GIAO (ký hoặc gửi danh sách lỗi) | HĐ 6.4 | Bên B | 30 ngày từ ngày nhận bàn giao ghi trên biên bản bàn giao | Biên bản bàn giao có ngày nhận + chữ ký người nhận Bên B | Đồng hồ 30 ngày CHỈ chạy từ biên bản bàn giao có chữ ký — báo cáo/hồ sơ do agent tự sinh KHÔNG là "bàn giao", không làm căn cứ nghiệm thu mặc nhiên | de_xuat |
| N12 | Sửa lỗi trong 07 ngày kể từ ngày nhận danh sách lỗi | HĐ 6.5 | Bên A | 07 ngày từ ngày nhận danh sách lỗi | Danh sách lỗi có ngày nhận + commit/biên bản sửa; sổ sự cố (C07) | Chưa có danh sách lỗi | de_xuat |
| N13 | Bảo hành Nền tảng suốt thời gian đối tác chiến lược; 06 tháng khi không còn | HĐ 6.6 | Bên A | Theo trạng thái đối tác chiến lược | Bản cam kết hợp tác chiến lược (ngoài repo) | Bản cam kết không có trong repo | de_xuat |
| N14 | Đối soát doanh thu thuần quý, biên bản theo mẫu PL05; chênh lệch giải trình 05 ngày làm việc | HĐ 7.5, 8.3; PL02 mục 4–5 | Hai bên | Mỗi quý | Báo cáo `python -m agents.rev_share --quarter` (ĐỀ XUẤT, ô ký trống) + biên bản ký | PL05; tỷ lệ phí/thưởng/ngày ký/ngày vận hành chưa chốt (`data/rev_share.json` null) | de_xuat |

## 3. Góp vốn, hoàn trả bằng sản phẩm

| # | Nghĩa vụ | Căn cứ | Owner | Hạn | Bằng chứng cần có | Blocker | Trạng thái |
|---|---|---|---|---|---|---|---|
| N15 | Góp vốn bằng công nghệ ghi nhận theo biên bản nghiệm thu P1/P2 | HĐ 4; PL03 mục 1 | Bên A | Theo nghiệm thu P1/P2 | Biên bản nghiệm thu P1, P2 | Giá trị ghi nhận từng đợt để trống | de_xuat |
| N16 | Hoàn trả vốn góp bằng sản phẩm (3 đợt), kế hoạch giao gửi trước ≥30 ngày, biên bản giao nhận từng đợt, chênh lệch đền bù 15 ngày | HĐ 9.1–9.6; PL03 mục 2–3; PL04 (tiêu chuẩn củ) | Bên B (giao) / Bên A (chấp thuận, nhận) | Đợt 1 sau ký (ngày để trống); đợt 2/3 sau nghiệm thu P1/P2 (số ngày để trống) | Kế hoạch giao + văn bản chấp thuận + biên bản giao nhận (PL05) | Tỷ lệ/khối lượng/thời hạn/tiêu chuẩn và giá quy đổi để trống — CHỜ HAI BÊN CHỐT, không tự điền | de_xuat |
| N17 | Phí vận hành quy đổi ra sản phẩm, giao sau biên bản đối soát quý | HĐ 9.3; PL02 mục 5 | Bên B | Số ngày để trống | Biên bản đối soát quý + biên bản giao nhận | Tỷ lệ phí + số ngày để trống | de_xuat |

## 4. Khi chấm dứt hợp đồng

| # | Nghĩa vụ | Căn cứ | Owner | Hạn | Bằng chứng cần có | Blocker | Trạng thái |
|---|---|---|---|---|---|---|---|
| N18 | Bàn giao hệ thống, mã nguồn, tài liệu | HĐ 13.3d | Hai bên | 15 ngày từ khi chấm dứt | Biên bản bàn giao kèm commit/tag + danh mục tài sản | Kho chung chưa xác định | de_xuat |
| N19 | Bàn giao lại và xóa toàn bộ bản sao dữ liệu của Bên B đang giữ | HĐ 12.3, 13.3d | Bên A | 30 ngày từ khi chấm dứt | Biên bản xác nhận xóa (quy trình `docs/handover/runbook-ha-tang.md` mục 9) | Mẫu biên bản (PL05) chưa có | de_xuat |
| N20 | Định giá tài sản hợp tác qua thẩm định giá độc lập | HĐ 13.3a | Hai bên | Khi chấm dứt | Biên bản định giá | — | de_xuat |

## 5. Quyết định cần hai bên (gom một lần)

- Ngày ký hợp đồng thực tế (mốc 05 ngày bàn giao, năm hợp tác, nghiệm thu P2,
  đánh giá năm đều phụ thuộc) và ngày bắt đầu vận hành thương mại.
- PL05 — mẫu biên bản nghiệm thu, giao nhận, đối soát.
- Tỷ lệ phí vận hành, mức thưởng, lịch/khối lượng hoàn trả, tiêu chuẩn củ và
  giá quy đổi (PL02–04 để trống).
- Tháng neo blockchain (PL01 mục 7 để trống) + chuỗi/provider/phí
  (`data/anchor_config.json` `provider: none`).
- Kho mã nguồn chung, người giữ quyền cao nhất Bên B, văn bản ủy quyền người
  duyệt, lịch trực, đào tạo.
