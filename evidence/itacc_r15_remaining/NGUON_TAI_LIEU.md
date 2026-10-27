# Nguồn tài liệu chính thức — quyết toán qua API sàn (đọc 25/10/2026 qua trình duyệt; không lưu bản sao nội dung, không credential)

Dùng làm căn cứ cho `ingest/settlement_api.py` + allowlist `ingest/market_api.py` (r15). Nguồn bên thứ ba KHÔNG dùng làm căn cứ.

## Đính chính r14

`evidence/itacc_r14_code_gaps/NGUON_TAI_LIEU.md` ghi TikTok finance “không tìm được trang chính thức bản hiện hành (đường dẫn
đoán trả No document found)”. Sai: Partner Center có nhóm **Finance** chính thức, hiện hành (liệt kê trong cây tài liệu
`/docv2`). Bản ghi r14 giữ nguyên làm lịch sử; đính chính ghi ở đây và ở `docs/handover/doi-chieu-docx.md`.

## Shopee Open Platform

| Nội dung | URL | Phiên bản / ngày trên trang | Đặc tả dùng cho code |
|---|---|---|---|
| v2.payment.get_escrow_list | https://open.shopee.com/documents/v2/v2.payment.get_escrow_list?module=97&type=1 | Update log 2025-09-08 | `GET /api/v2/payment/get_escrow_list`. Live Global `https://partner.shopeemobile.com`; Sandbox Global `https://openplatform.sandbox.test-stable.shopee.sg`. Tham số chung partner_id/timestamp/access_token/shop_id/sign (như các API shop). Request: `release_time_from`, `release_time_to` (timestamp, bắt buộc), `page_size` (≤100, mặc định 40), `page_no` (≥1, mặc định 1). Response `response.escrow_list[{order_sn, payout_amount (float), escrow_release_time}]`, `response.more` (boolean). Mã lỗi nghiệp vụ gồm `error_param`, `error_server`, `income_not_found`, `order_not_found`, `income_error_server`… (không theo tiền tố `error_`). Quyền app: ERP / Seller In House / Accounting And Finance / Swam ERP. |
| v2.payment.get_escrow_detail | https://open.shopee.com/documents/v2/v2.payment.get_escrow_detail?module=97&type=1 | — | `GET /api/v2/payment/get_escrow_detail`, `order_sn` (bắt buộc). Response `response.order_sn`, `buyer_user_name` (PII — không lưu), `return_order_sn_list`, `order_income` (~100 trường: `escrow_amount` có công thức ~30 thành phần “thay đổi trước khi đơn hoàn tất”, phí/thuế khấu trừ `withholding_vat_tax`/`withholding_pit_tax`/`withholding_cit_tax`, phí FBS, danh sách `items`, `order_adjustment`…). Danh sách tên trường số nằm trong `data/settlement_api_map.json` (mọi quyết định null). |
| Có thêm trong nhóm Payment (chưa dùng) | (cùng cây tài liệu) | — | `get_escrow_detail_batch`, `get_income_statement`, `get_income_report`, `get_income_detail`… — KHÔNG dùng (chưa cần; chỉ 2 endpoint GET ở allowlist). |

## TikTok Shop Partner Center

| Nội dung | URL | Phiên bản | Đặc tả dùng cho code |
|---|---|---|---|
| Finance API overview | https://partner.tiktokshop.com/docv2/page/finance-api-overview | — | Luồng đề nghị cho quyết toán mức đơn: Get Statements (mỗi ngày 1 statement, sinh 00:00 UTC) → Get Transactions by Statement (statement_id); đơn chưa quyết toán không có trong API. Danh sách loại điều chỉnh. |
| Get Statements | https://partner.tiktokshop.com/docv2/page/get-statements-202309 | 202309 (còn trong cây tài liệu hiện hành) | `GET /finance/202309/statements`; scope `seller.finance.info`; query `statement_time_ge` (gồm) / `statement_time_lt` (không gồm), `sort_field` (bắt buộc, chỉ `statement_time`), `page_size` [1–100] mặc định 20, `page_token`, `payment_status`; response `data.next_page_token`, `data.statements[{id, statement_time, settlement_amount, currency, revenue_amount, fee_amount, adjustment_amount, payment_status, payment_id, net_sales_amount, shipping_cost_amount, payment_time}]`. Header `x-tts-access-token`, `content-type: application/json`; query chung app_key/sign/timestamp/shop_cipher. |
| Get Transactions by Statement | https://partner.tiktokshop.com/docv2/page/get-transactions-by-statement-202501 | 202501 | `GET /finance/202501/statements/{statement_id}/statement_transactions`; query `sort_field` (bắt buộc, chỉ `order_create_time`), `page_size` [1–100], `page_token`; response `data.{next_page_token, id, create_time, status (SETTLED), currency, payable_amount, total_*}` + `data.transactions[]`: `id, type, order_id | adjustment_id + adjustment_order_id | reserve_id + associated_order_id`, số tiền DẠNG CHUỖI: `settlement_amount` (= revenue − shipping − fee_tax − adjustment theo tài liệu), `revenue_amount` + `revenue_breakdown.*`, `shipping_cost_amount` + `shipping_cost_breakdown.*` (+ `supplementary_component.*`), `fee_tax_amount` + `fee_tax_breakdown.fee.*`/`.tax.*`, `supplementary_component.*`, `adjustment_amount`, `reserve_amount`. `type`: ORDER, RESERVE, CHARGE_BACK, CUSTOMER_SERVICE_COMPENSATION, DEDUCTIONS_INCURRED_BY_SELLER, GMV_PAYMENT_FOR_ADS, PLATFORM_COMMISSION_ADJUSTMENT, PLATFORM_COMMISSION_COMPENSATION, PLATFORM_PENALTY, PROMOTION_ADJUSTMENT, REBATE, PLATFORM_COMPENSATION, PLATFORM_REIMBURSEMENT, COFUNDED_CREATOR_REWARDS, STAMP_DUTY, FBT_WAREHOUSE_SERVICE_FEE, LOGISTICS_REIMBURSEMENT, SHIPPING_FEE_ADJUSTMENT, SHIPPING_FEE_COMPENSATION, SHIPPING_FEE_REBATE, SAMPLE_SHIPPING_FEE, SELLER_MISSION_REWARD, OTHER_ADJUSTMENT. Chỉ dữ liệu sau 2023-07-01. |
| Có thêm (chưa dùng) | Get Transactions by Order 202501, Get Unsettled Transactions 202507, Get Payments 202605, Get Seller Financial Transactions 202309 | — | KHÔNG dùng — mức SKU/chưa quyết toán/thanh toán ngân hàng ngoài phạm vi sổ quyết toán. |

Ghi chú thu thập: trang TikTok là ứng dụng JS — bảng tham số đọc qua JSON mô tả tài liệu mà chính trang tải
(`/api/v1/document/api_meta?src_document_id=<trang>`), cùng nội dung hiển thị. Danh sách tên trường TikTok dùng để sinh khung
bảng ánh xạ: `harness/tt_params_202501.txt` (sinh bằng `harness/gen_settlement_map_r15.py.txt`).

## Điều KHÔNG có trong tài liệu (không đoán)

- Host sandbox riêng của TikTok cho finance: không thấy → code chỉ coi là API thật khi người vận hành khai `TIKTOK_API_ENV=live`.
- Cách hạch toán từng thành phần vào sổ quyết toán / doanh thu chia sẻ (HĐ 7.6): quyết định của Kế toán, không phải tài liệu sàn.
