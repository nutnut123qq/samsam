> **CHẠY THỬ — KHÔNG GỬI.** Tính năng farming-02.2 đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.

# Bản tin vùng trồng — 2026-10-16 → 2026-10-22 (7 ngày, giờ VN)

_Tất định, không LLM. Không chứa tọa độ/vị trí/diện tích/người ghi. Mỗi mục có SQL đối chứng tái lập con số._

## 1. Toàn vẹn nhật ký (hash chain)

OK — 1 nhật ký đã chain, 0 vấn đề.

SQL đối chứng:
```sql
select id, problem from verify_plot_logs() order by id, problem;
select count(*) from plot_logs where row_hash is not null;
```

## 2. Dữ liệu mẫu còn lại

3 khoảnh mẫu, 6 nhật ký mẫu — chờ GĐ vùng trồng ký gỡ (`--precheck` rồi `--purge-sample --by`).

SQL đối chứng:
```sql
select (select count(*) from plots where source like 'sample:%') as plots, (select count(*) from plot_logs where source like 'sample:%') as plot_logs;
```

## 3. Nhắc lịch & gap (tính tại hết ngày 2026-10-22, gap 14 ngày)

- [gap] KV-A01: 15 ngày chưa có nhật ký (gần nhất 2026-10-07)
- [gap] KV-A02: 14 ngày chưa có nhật ký (gần nhất 2026-10-08)
- [no-logs] IT-K01: chưa có nhật ký nào
- [no-logs] IT-K02: chưa có nhật ký nào
- [no-logs] IT-K03: chưa có nhật ký nào
- [no-logs] IT-K04: chưa có nhật ký nào
- [overdue] KV-A01: 'bón' trễ lịch (gần nhất chưa từng)
- [overdue] KV-A01: 'kiểm tra sâu bệnh' trễ lịch (gần nhất 2026-10-07, 15 ngày trước)
- [overdue] KV-A01: 'làm cỏ' trễ lịch (gần nhất chưa từng)
- [overdue] KV-A01: 'tưới' trễ lịch (gần nhất 2026-10-05, 17 ngày trước)
- [overdue] KV-A02: 'kiểm tra sâu bệnh' trễ lịch (gần nhất chưa từng)
- [overdue] KV-A02: 'tưới' trễ lịch (gần nhất chưa từng)
- [overdue] KV-B01: 'bón' trễ lịch (gần nhất chưa từng)
- [overdue] KV-B01: 'kiểm tra sâu bệnh' trễ lịch (gần nhất chưa từng)
- [overdue] KV-B01: 'làm cỏ' trễ lịch (gần nhất chưa từng)
- [overdue] KV-B01: 'tưới' trễ lịch (gần nhất chưa từng)

SQL đối chứng:
```sql
select id from plots where status = 'active' order by id;
select plot_id, max(ts) from plot_logs where ts < '2026-10-22T17:00:00+00:00'::timestamptz group by plot_id order by plot_id;
select plot_id, activity, max(ts) from plot_logs where ts < '2026-10-22T17:00:00+00:00'::timestamptz group by plot_id, activity order by plot_id, activity;
```

## 4. Nhật ký mới trong kỳ (ngày hoạt động hoặc ngày ghi)

Không có nhật ký nào trong kỳ.

SQL đối chứng:
```sql
select plot_id, count(*) filter (where source like 'sample:%') as mau, count(*) filter (where source not like 'sample:%') as that from plot_logs where (ts >= '2026-10-15T17:00:00+00:00'::timestamptz and ts < '2026-10-22T17:00:00+00:00'::timestamptz) or (source not like 'sample:%' and created_at >= '2026-10-15T17:00:00+00:00'::timestamptz and created_at < '2026-10-22T17:00:00+00:00'::timestamptz) group by plot_id order by plot_id;
```

## 5. Cảnh báo từ khóa (chỉ quét chi tiết nhật ký)

Không có cảnh báo.

_Lọc keyword `FLAG_KEYS` trên cột detail bằng Python (lower), không quét tên hoạt động._

SQL đối chứng:
```sql
select id, plot_id, ts, source, detail from plot_logs where ((ts >= '2026-10-15T17:00:00+00:00'::timestamptz and ts < '2026-10-22T17:00:00+00:00'::timestamptz) or (source not like 'sample:%' and created_at >= '2026-10-15T17:00:00+00:00'::timestamptz and created_at < '2026-10-22T17:00:00+00:00'::timestamptz)) and detail is not null order by ts, id;
```

## 6. Ảnh/video vườn mới (đã gỡ EXIF/GPS)

Không có ảnh/video mới.

SQL đối chứng:
```sql
select plot_id, count(*) from garden_media where created_at >= '2026-10-15T17:00:00+00:00'::timestamptz and created_at < '2026-10-22T17:00:00+00:00'::timestamptz group by plot_id order by plot_id;
```
