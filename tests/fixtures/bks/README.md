# Fixture đối soát độc lập BKS (v10.0 W100.5) — DỮ LIỆU GIẢ

Bản sao rút gọn của `tests/fixtures/finance/settlement_shopee_MAU.csv` /
`order_shopee_MAU.csv` (mã đơn `FAKESET*`, tên/SĐT/địa chỉ người mua GIẢ —
không PII thật), ngày quyết toán dời sang **tháng 09/2026**.

- `*_sach_MAU.csv` — bản SẠCH: 11 dòng quyết toán (FAKESET0001–0009 khớp,
  0013/0014 hoàn) + đơn tương ứng. Kỳ vọng: 0 khác biệt, 0 phát hiện dòng.
- `*_lech_MAU.csv` — bản SẠCH + 3 lệch CÀI SẴN:
  1. `settlement_shopee_lech_MAU.csv` dòng 3 (FAKESET0002): thực nhận sai
     248.120 → 238.120 (−10.000 đ) → `quyet_toan_lech` (lý do `thuc_nhan`).
  2. `order_shopee_lech_MAU.csv` dòng 14 (FAKESET0050): đơn KHÔNG có dòng
     quyết toán → `don_chua_quyet_toan` (`market_snapshots#<id> dòng 14`).
  3. `settlement_shopee_lech_MAU.csv` dòng 13 (FAKESET0097): quyết toán
     KHÔNG có đơn → `quyet_toan_khong_don` + `don_lech_quyet_toan`
     (Σ giá trị đơn trên quyết toán − Σ đơn sàn = 300.000 đ, refs dòng 13).
- Test DB cài thêm 1 dòng `channel_snapshots` `sales.settlement_vnd`
  kênh `shopee` tháng 09/2026 LỆCH +50.000 đ so với Σ thực nhận →
  `cockpit_lech_quyet_toan`. P&L (`fp_pnl.compute`) tính từ chính dòng
  quyết toán → khớp (0 `pnl_lech_quyet_toan`).

Kỳ vọng viết TAY ở đây (không tính lại bằng chính module).
