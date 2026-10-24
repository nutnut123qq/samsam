> **CHẠY THỬ — KHÔNG GỬI.** Tính năng ceo-04.6 đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.

# Đối soát độc lập BKS — tháng 2026-09

Sinh lúc 23/10/2026 10:45 giờ VN bởi `agent:bks_recon` (sổ lần chạy MÁY — KHÔNG phải chữ ký BKS). Chỉ đọc; không bút toán, không sửa đối soát của Tài chính.

## Bốn nguồn theo kênh

| Kênh | Quyết toán: giá trị đơn | Quyết toán: thực nhận | Số dòng | Đơn sàn | P&L thực nhận | Cockpit TGĐ |
|---|---|---|---|---|---|---|
| shopee | 959.000đ | 843.000đ | 3 | 459.000đ | 843.000đ | 800.000đ |
| tiktok | — | — | 0 | — | — | — |

## Tổng theo mã

| Mã | Số |
|---|---|
| pnl_lech_quyet_toan | 0 |
| cockpit_lech_quyet_toan | 1 |
| don_lech_quyet_toan | 1 |
| thieu_nguon | 0 |
| nhan_lech | 0 |
| chua_doi_soat | 0 |
| quyet_toan_lech | 1 |
| quyet_toan_khong_don | 1 |
| don_chua_quyet_toan | 1 |
| quyet_toan_chong_ky | 0 |

## Khác biệt 4 nguồn

- [cockpit_lech_quyet_toan] kênh shopee tháng 2026-09 — quyết toán (settlement_rows) 843.000đ ↔ cockpit TGĐ (channel_snapshots sales.settlement_vnd) 800.000đ · Δ 43.000đ · nguồn: it_g1_settlement_shopee.csv (3 dòng); channel_snapshots#29
- [don_lech_quyet_toan] kênh shopee tháng 2026-09 — quyết toán (settlement_rows) 959.000đ ↔ đơn sàn (market_rows, snapshot order mới nhất) 459.000đ · Δ 500.000đ · nguồn: it_g1_settlement_shopee.csv dòng 4

## Tính lại từng dòng + đơn chưa quyết toán

Lấy mẫu: seed 7 · 3/3 dòng quyết toán trong tháng được tính lại (100%; ngưỡng kiểm 100% = 200 dòng).

- [quyet_toan_lech] kênh shopee: it_g1_settlement_shopee.csv dòng 3 — lý do: thuc_nhan
- [quyet_toan_khong_don] kênh shopee: it_g1_settlement_shopee.csv dòng 4
- [don_chua_quyet_toan] kênh shopee: market_snapshots#2 dòng 4

---
*BẢN NHÁP — chờ BKS ký (external-dep). Số liệu thật Seller Center/kế toán là external-dep.*
