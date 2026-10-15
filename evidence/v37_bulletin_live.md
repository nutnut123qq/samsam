# Bản tin sức khỏe hệ thống — 2026-10-12

_Sinh lúc 2026-10-12 00:02 giờ VN — số liệu từ SQL, không dùng LLM. Bản tin chỉ BÁO, không tự xử lý._

## 1. DB

- DB: sống (connect + query OK)

## 2. Job 24h

_Nguồn: bảng `job_runs` (24h qua)._

| Job | OK | Lỗi |
|---|---:|---:|
| agents.report | 2 | 0 |
| gate.v37.smoke | 2 | 0 |
| ingest.lead_store | 2 | 0 |

## 3. Chi phí AI tháng này theo agent

_Nguồn: bảng `llm_usage` (`sum(cost_usd)` từ 00:00 ngày 1 giờ VN) + trần `data/llm_gateway.json` `monthly_cap_usd`. Ngưỡng: ≥80% cảnh báo, ≥100% gateway chặn._

| Agent | Đã dùng (USD) | Trần (USD) | % | Trạng thái |
|---|---:|---:|---:|---|
| chatbot | 0.0000 | 20.00 | 0% | OK |
| content | 0.0000 | 10.00 | 0% | OK |
| ingest | 0.0000 | 5.00 | 0% | OK |
| smoke | 0.0000 | 0.50 | 0% | OK |

## 4. Lời gọi LLM lỗi 24h

_Nguồn: bảng `llm_usage` `ok = false` (24h qua)._

- Tổng: 0

## 5. Hàng chờ duyệt

_Nguồn: bảng `content_drafts` `status = 'pending'`._

- Draft chờ duyệt: 0
