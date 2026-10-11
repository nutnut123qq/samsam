# Bản tin sức khỏe hệ thống — 2026-10-12

_Sinh lúc 2026-10-12 00:02 giờ VN — số liệu từ SQL, không dùng LLM. Bản tin chỉ BÁO, không tự xử lý._

## 1. DB

- **DB không truy cập được** (ConnectionTimeout) — kiểm service Postgres / `DATABASE_URL` (SOP mục 7).

## 2. Job 24h

_Nguồn: bảng `job_runs` (24h qua)._

- không có số liệu (DB không truy cập được)

## 3. Chi phí AI tháng này theo agent

_Nguồn: bảng `llm_usage` (`sum(cost_usd)` từ 00:00 ngày 1 giờ VN) + trần `data/llm_gateway.json` `monthly_cap_usd`. Ngưỡng: ≥80% cảnh báo, ≥100% gateway chặn._

- không có số liệu (DB không truy cập được)

## 4. Lời gọi LLM lỗi 24h

_Nguồn: bảng `llm_usage` `ok = false` (24h qua)._

- không có số liệu (DB không truy cập được)

## 5. Hàng chờ duyệt

_Nguồn: bảng `content_drafts` `status = 'pending'`._

- không có số liệu (DB không truy cập được)
