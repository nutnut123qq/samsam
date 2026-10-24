> **CHẠY THỬ — KHÔNG GỬI.** Tính năng production-01 đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.

# Bản tin Sản xuất tuần — 2028-12-01

Cấu hình mốc/SLA: GIẢ ĐỊNH — chờ GĐ sản xuất chốt
KHÔNG phải doanh số cam kết — agent chỉ đề xuất; không chuyển kho, không đặt mua, không lệnh sản xuất.

## Thiếu hàng theo mốc chốt
Nguồn: `allocation_proposals` (run mới nhất mỗi mốc).
- chot_11_11 (2026-10-25, đã qua 768 ngày) · run 0401169a5ab8 [approved] · mat-ong-sam-300ml: tồn 15, cơ sở 49 (thấp 35, cao 66) — THIẾU CẢ KỊCH BẢN THẤP (thiếu 34 so với cơ sở)
- chưa có số tồn — không kết luận thiếu: da-an-sam-30v, mat-ong-sam-120ml-1hu, mat-ong-sam-120ml-2hu, ruou-sam-binh-su-do-500ml, saphraton-20v, saphraton-40v, saphraton-80v, saphraton-combo-2x20v, savigout-30v

## Lô chờ kiểm nhập
Nguồn: `production_lots` (pending).
không có

## BOM lỗi
Nguồn: `bom_combos` + `bom_items` × golden file hiện tại.
không có

## Mục chờ duyệt & SLA
Nguồn: `allocation_proposals` + `production_lots` (nhắc ≥ 24h, SLA 48h — chỉ là chữ trong bản tin, không tự chuyển/duyệt thay).
không có

## Hàng cận hạn (FEFO)
Nguồn: `production_lots` (passed, HSD ≤ 90 ngày tới, gồm lô đã quá hạn) × `inventory_snapshots` (tồn theo SKU — chưa theo lô; tồn 0 → bỏ).
không có

## Tiến độ sản xuất
Nguồn: `production_plans` (NGƯỜI khối sản xuất ghi) × `production_plan_lots` (lô gắn tường minh) × `production_lots`. % = số lượng lô ĐẠT kiểm nhập / kế hoạch.
- KH-IT-001 · savina-12v · kế hoạch 500 (2026-09-01→2026-11-30) · đạt 200 (40%) · chờ kiểm 0 · không đạt 0 · CHẬM — quá hạn 732 ngày

## Phiếu kiểm nghiệm lô
Nguồn: `lot_test_certificates` (phiên bản mới nhất) × `production_lots` chờ/đạt. Lô chưa có dòng phiếu = THIẾU phiếu — kiểm tệp/hash: `production cert-verify`.
- IT-LOT-001 (passed) · THIẾU phiếu
- IT-LOT-002 (passed) · THIẾU phiếu
- IT-LOT-003 (passed) · THIẾU phiếu
