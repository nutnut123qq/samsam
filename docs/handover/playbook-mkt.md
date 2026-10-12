# Playbook — Nhân viên Marketing (MKT)

**Dành cho ai:** nhân viên Marketing Sâm Sâm — người viết/duyệt bài đăng
Facebook, TikTok, Zalo OA, blog.
**Làm việc gì:** sinh bài từ brief → kiểm guardrail → đưa vào hàng duyệt →
duyệt/từ chối → xếp lịch đăng → **đăng tay** lên kênh → cuối kỳ sinh báo
cáo cho lãnh đạo.
**Cần gì:** app đang chạy (`streamlit run app/streamlit_app.py`), file
`.env` đã điền `OPENROUTER_API_KEY` + `DATABASE_URL` (xem `sop.md`).

## Tab bạn dùng

| Tab | Dùng để |
|---|---|
| **Content Studio** | Nhập brief → chọn kênh → "Sinh bài" → xem draft + kết quả guardrail; ô "Text cần check" để check tay đoạn text có sẵn |
| **Duyệt & Lịch** | Hàng chờ duyệt: đọc từng draft → Duyệt / Từ chối; xếp lịch bài đã duyệt; bảng "Lịch đăng 14 ngày" |
| **Báo cáo** | Sinh/xem báo cáo định kỳ (file markdown trong `data/reports/`) — BẢN NHÁP để người duyệt rồi gửi lãnh đạo |

## Nguyên tắc không đổi (đọc trước khi dùng)

- **Hệ thống KHÔNG tự đăng, KHÔNG tự gửi.** "Lịch đăng" chỉ là kế hoạch —
  đến ngày, NGƯỜI copy nội dung đã duyệt đăng tay lên kênh. Báo cáo là
  bản nháp — NGƯỜI đọc, sửa nếu cần, rồi gửi lãnh đạo.
- **Bài vi phạm guardrail không duyệt được** — nút "Duyệt" bị khóa. Không
  có chuyện "duyệt kèm ghi chú": bài vi phạm phải Từ chối hoặc sinh lại.
- Guardrail chạy 2 lớp: từ cấm TPBVSK (chữa, điều trị, thuốc, khỏi bệnh,
  chống ung thư...) + claim công dụng chỉ được nêu đúng whitelist đã
  công bố của đúng sản phẩm (xem `prompt-library.md`).

## Quy trình ngày mẫu

1. **Viết brief.** Mở tab **Content Studio**, nhập brief vào ô "Brief"
   (mẫu brief: xem `prompt-library.md` mục cuối).
2. **Chọn kênh** trong ô "Kênh" — chọn nhiều kênh cùng lúc được
   (`facebook` / `tiktok` / `zalo` / `blog`); mỗi kênh sinh 1 bản riêng
   và guardrail kiểm độc lập.
3. **Bấm "Sinh bài".** Với mỗi kênh hệ thống hiển thị bản nháp + kết quả
   guardrail: xanh "PASS" hoặc đỏ liệt kê vi phạm (từ cấm / claim ngoài
   whitelist / claim sai sản phẩm).
4. **Draft có vi phạm:** sửa brief cho chặt hơn (nhấn "chỉ nêu công dụng
   đã công bố", gợi ý claim cụ thể) rồi sinh lại; hoặc copy text sang ô
   "Text cần check" để thử từng câu. Nếu vi phạm lặp lại nhiều lần vì
   công dụng mới chưa có trong whitelist → báo người quản lý (xem mục
   "Khi nào gọi người khác").
5. **"Lưu vào hàng duyệt"** khi ưng ý — draft vào hàng chờ (trạng thái
   `pending`). Kênh nào lưu xong sẽ biến mất khỏi màn hình — không lo
   lưu trùng.
6. **Duyệt bài** — qua tab **Duyệt & Lịch**:
   - Mở từng draft trong "Hàng chờ duyệt" (expander `#id [kênh] brief —
     guardrail PASS/VI PHẠM`), đọc kỹ nội dung.
   - Điền "Người duyệt" (bắt buộc — ghi audit) + "Ghi chú" nếu có →
     bấm **Duyệt** hoặc **Từ chối**. Nút Duyệt chỉ bấm được khi
     guardrail PASS.
7. **Xếp lịch:** mục "Bài đã duyệt chưa xếp lịch" → chọn bài → chọn
   "Ngày đăng" → **"Xếp lịch"**. Bảng "Lịch đăng 14 ngày" hiện ngay.
   Ngày quá khứ không xếp được.
8. **Đăng tay:** đến ngày trong lịch, mở draft (CLI `--calendar` hoặc
   DB), copy text đã duyệt, đăng lên Fanpage/TikTok/Zalo OA bằng tài
   khoản công ty. **Bạn chịu trách nhiệm bài lên sóng — hệ thống không
   đăng giúp.**
9. **Cuối tuần:** tab **Báo cáo** → chọn "7 ngày gần nhất" → "Sinh báo
   cáo" → đọc file hiện bên dưới → chỉnh sửa/duyệt → gửi lãnh đạo.

## CLI thay thế (khi không mở app)

```
python -m pipelines.store --pending            # xem hàng chờ
python -m pipelines.store --approve 3 --by "Lan"   # duyệt draft #3
python -m pipelines.store --reject 4 --by "Lan" --note "sai công dụng"
python -m pipelines.store --schedule 3 2026-10-20  # xếp lịch
python -m pipelines.store --calendar           # lịch 14 ngày tới
python -m agents.report                        # sinh báo cáo 7 ngày
```

(Flag đầy đủ: `--days N` cho calendar/report; 1 lệnh chỉ làm 1 thao tác.)

## Lịch tuần + bản tin + duyệt brief (v6.0)

- **Lịch tuần:** `python -m pipelines.mkt_calendar --weeks 4` in lịch
  chiến dịch ĐỀ XUẤT (GIẢ ĐỊNH tới khi GĐ Marketing chốt): mỗi ô kênh ×
  định dạng, SKU được phép, hạn brief/nháp/duyệt/đăng (giờ VN). Viết bài
  đúng hạn "nháp" để Pháp chế kịp duyệt trước hạn "duyệt". Ô ghi "câu
  chuyện thương hiệu — không nêu tên SKU" = không được nêu tên sản phẩm.
  Muốn lịch trên điện thoại: thêm `--ics` rồi import file `.ics`.
- **Bản tin thứ Hai:** người vận hành chạy `python -m agents.mkt_director
  --bulletin` → `data/reports/mkt-week-<thứ Hai>.md`: chiến dịch 28 ngày
  tới, việc trễ hạn, tải duyệt so với quota, SKU bị chặn kênh.
- **Duyệt brief:** brief chiến dịch do agent đẩy vào hàng duyệt chung ở
  trạng thái chờ — chỉ **GĐ Marketing** duyệt (`python -m
  pipelines.approval_queue --approve ID --by "<tên>"`). Agent không duyệt,
  không đăng, không chi tiền; cảnh báo "VƯỢT QUOTA" chỉ là đề xuất dời.

## Đo lường + SEO hằng tuần (v6.5)

- **Thứ Hai — đọc mục 5 "Marketing"** của báo cáo định kỳ (`python -m
  agents.report --days 7`): tỷ lệ nháp bị trả lại theo kênh × loại, thời gian
  duyệt trung vị/p90, vi phạm guardrail theo code (code nào lặp nhiều = viết
  lại brief/template), hiệu quả kênh tuần trước. Số `(MẪU)` là dữ liệu mẫu;
  Search Console/GA4 chờ bàn giao.
- **Rà SEO website** (`python -m agents.seo_web`, thêm `--submit` để gửi đề
  xuất vào hàng duyệt): tiêu đề trùng/dài, sản phẩm thiếu ảnh, trang có câu
  vi phạm luật. GĐ Marketing duyệt → người quản trị web sửa TAY trên CMS.
- **Gợi ý tiêu đề sàn** (`python -m agents.seo_san --run --dry-run` xem
  trước, bỏ `--dry-run` để tạo nháp listing chờ duyệt): từ khóa lấy từ
  Google Trends xuất tay; từ khóa rượu, "Ngọc Linh", từ cấm tự bị loại. Sau
  duyệt, sửa TAY trên Seller Center.

## Khi nào gọi người khác

| Tình huống | Gọi ai |
|---|---|
| Guardrail cứ chặn claim công dụng MỚI đã được công bố thật | Quản lý MKT + người vận hành — cập nhật `data/claims_whitelist.json` rồi chạy lại ingest (xem `sop.md`) |
| Draft hay bị sáo rỗng/lặp | Tự chỉnh brief theo mẫu `prompt-library.md`; vẫn kém → báo đội dự án chỉnh prompt |
| App hiện "Chưa nạp — không kết nối được Postgres" | Người vận hành/IT — xem `sop.md` mục "DB không kết nối được" |
| Báo cáo in "[chưa nạp]" ở mục Bán hàng/Leads/Vùng trồng | Người vận hành — DB đang chết; phần kênh chat vẫn có số |
| Muốn thêm kênh đăng mới / thay đổi format | Đội dự án (dev) — `CHANNEL_HINT` trong `pipelines/content.py` |
| Cần tài khoản Fanpage/TikTok/Zalo OA | Quản lý — thuộc Phụ lục C SOW, đứng tên công ty |
