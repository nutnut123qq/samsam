# Playbook — Nhân viên vườn (nhật ký vùng trồng)

**Dành cho ai:** nhân viên vườn sâm Ngọc Linh — người đi khoảnh và ghi
hoạt động hằng ngày.
**Làm việc gì:** ghi nhật ký theo khoảnh (tưới/bón/làm cỏ/kiểm tra sâu
bệnh/thu hoạch...) → hệ thống chuẩn hóa tên hoạt động + báo ngay nếu
nhật ký có dấu hiệu bất thường → rà mục "Cần chú ý" (khoảnh lâu chưa
ghi / từ khóa sâu bệnh).
**Cần gì:** app đang chạy (`streamlit run app/streamlit_app.py`) và DB
Postgres chạy — tab này **bắt buộc DB** (khác tab Leads vẫn hiện phần
convlog khi DB chết). Nếu không mở app được thì dùng CLI (mục cuối).

## Tab bạn dùng

| Tab | Dùng để |
|---|---|
| **Nhật ký vườn** | Form "Ghi nhật ký" + panel "Cần chú ý" + bảng "Nhật ký gần nhất" |

## Nguyên tắc không đổi

- **Bạn ghi tay — hệ thống không tự sinh, không tự sửa nhật ký.**
- Mỗi nhật ký gắn **1 khoảnh + 1 ngày + 1 hoạt động**. Trùng đúng bộ ba
  (khoảnh, giờ, hoạt động) hệ thống báo "đã có nhật ký trùng" — không
  ghi đè.
- Hoạt động tự gõ ngoài từ vựng vẫn được ghi nguyên văn (kèm cảnh báo
  "chưa có trong vocab") — nhưng cố dùng đúng tên chuẩn để báo cáo gộp
  đẹp.
- Cảnh báo "Cần chú ý" là **để bạn báo quản lý vườn**, không phải lỗi
  nhập liệu.

## Từ vựng hoạt động chuẩn (selectbox "Hoạt động")

`trồng` · `tưới` · `bón` · `làm cỏ` · `kiểm tra sâu bệnh` ·
`phun thuốc sinh học` · `thu hoạch` · `ghi nhận` · `khác…` (tự ghi)

Gõ tắt/không dấu trong ô "Hoạt động khác" vẫn được chuẩn hóa (vd "tuoi"
→ "tưới", "sau benh" → "kiểm tra sâu bệnh"). Từ khóa đáng chú ý sẽ kích
cảnh báo vàng: `sâu bệnh`, `rệp`, `bệnh`, `chết`, `héo`, `vàng lá`,
`nấm`, `dịch` — trong cả tên hoạt động lẫn ô Chi tiết.

## Quy trình ngày mẫu

1. **Vào tab "Nhật ký vườn".** Nếu hiện "Chưa nạp — không kết nối được
   Postgres" → báo người vận hành (xem `sop.md`), không ghi được.
2. **Ghi nhật ký:** chọn **Khoảnh** (vd `KV-A01 — ...`) → chọn **Hoạt
   động** (chọn `khác…` thì gõ vào ô "Hoạt động khác") → chọn **Ngày**
   → ghi **Chi tiết** (đã làm gì, liều lượng, dấu hiệu thấy được) →
   điền **Người ghi** → bấm **"Ghi nhật ký"**.
   - Thành công: "Đã ghi nhật ký #id". Có cảnh báo vàng → đọc kỹ (vd
     "nhật ký có dấu hiệu cần chú ý: 'sâu bệnh'") — nhật ký vẫn đã ghi,
     cảnh báo để bạn **báo quản lý vườn kiểm tra thực địa**.
   - Lỗi "khoảnh không tồn tại" → khoảnh chưa có trong DB — báo người
     vận hành thêm khoảnh vào bảng `plots`.
3. **Rà panel "Cần chú ý"** (ngay dưới form):
   - `chưa có nhật ký nào` / `không có nhật ký N ngày` → khoảnh bị bỏ
     quên — kiểm tra ai phụ trách khoảnh đó.
   - `keyword` → nhật ký gần đây có từ khóa sâu bệnh — mở lại nhật ký,
     báo quản lý vườn.
4. **Đối chiếu bảng "Nhật ký gần nhất"** — xác nhận dòng vừa ghi đã lên
   (Thời gian UTC / Khoảnh / Hoạt động / Chi tiết / Người ghi / Nguồn
   `manual:garden`).

## CLI thay thế (máy có cài Python + .env)

```
# Ghi nhật ký
python -m agents.garden --plot KV-A01 --activity "tưới" ^
    --detail "tưới phun sương 20 phút" --author "Hùng"

# Chỉ xem bất thường (không ghi gì)
python -m agents.garden --check                 # gap mặc định 14 ngày
python -m agents.garden --check --gap-days 7    # nghiêm hơn
```

Ghi xong CLI in `[done] nhật ký #id`; `--check` in từng dòng
`[no-logs|gap|keyword] <khoảnh>: ...`. Khi DB chết: ghi → báo lỗi
(không mất lệnh — ghi lại sau), `--check` → in "chưa nạp".

## Nhật ký đã ghi là bằng chứng (v9.3 — hash chain)

- Mỗi nhật ký thật (không phải dữ liệu mẫu) được DB nối vào **chuỗi băm**
  ngay lúc ghi: dòng sau giữ dấu vân tay của dòng trước. Nhật ký đã ghi
  **không sửa, không xóa được** — kể cả xóa khoảnh cũng bị chặn khi khoảnh
  đó còn nhật ký.
- **Ghi sai → ghi dòng MỚI kèm lý do**, không nhờ ai "sửa trong DB".
- Ai đó sửa lén bằng quyền quản trị DB sẽ bị phát hiện khi kiểm chuỗi:
  `python -m agents.garden_director --verify` (exit 0 = nguyên vẹn,
  exit 1 = có dòng bị đụng → báo GĐ vùng trồng + người phụ trách hạ tầng).

## Bản tin tuần + nhắc lịch (Agent GĐ vùng trồng)

```
python -m agents.garden_director --bulletin                    # tuần kết thúc HÔM QUA (giờ VN) — chạy sau 0h
python -m agents.garden_director --bulletin --until 2026-10-11 # kỳ cụ thể (ngày đã qua)
python -m agents.garden_director --remind                      # chỉ in danh sách nhắc
```

- Bản tin ghi file `data/reports/garden-week-<ngày>.md` (BẢN NHÁP, người
  đọc rồi gửi tay — hệ thống không tự gửi Zalo/email). 6 mục: toàn vẹn
  chuỗi nhật ký, dữ liệu mẫu còn lại, nhắc lịch/gap, nhật ký mới theo
  khoảnh, cảnh báo từ khóa (CHỈ quét ô Chi tiết — tên hoạt động "kiểm tra
  sâu bệnh" không tự kích cảnh báo), ảnh mới. Mỗi mục có "SQL đối chứng"
  để người kiểm tự chạy lại ra đúng con số. Không có vị trí/diện tích/tọa
  độ/tên người ghi.
- Nhật ký "mới trong kỳ" = ngày hoạt động trong kỳ HOẶC được GHI trong kỳ
  — nhập bù từ sổ giấy (ngày hoạt động tuần trước) vẫn lên bản tin tuần
  này, cảnh báo đánh dấu "(ghi bù)". Điều này chỉ đúng khi kỳ gồm các ngày
  ĐÃ HẾT: mặc định `--until` = hôm qua. Đừng truyền `--until` = hôm nay —
  nhật ký ghi sau giờ chạy trong ngày đó không vào bản tin nào (kỳ sau bắt
  đầu từ 0h hôm sau).
- Nhắc lịch theo `data/garden_schedule.json` — **GIẢ ĐỊNH** (tưới 7 ngày,
  kiểm tra sâu bệnh 7, làm cỏ 30, bón 60, gap 14) chờ GĐ vùng trồng chốt
  lịch canh tác thật. Loại nhắc: `[no-logs]` khoảnh chưa có nhật ký nào,
  `[gap]` quá N ngày không có nhật ký, `[overdue]` hoạt động định kỳ trễ.

## Gửi ảnh vườn vào kho tư liệu (gỡ EXIF/GPS)

```
python scripts/garden_media.py --file anh.jpg --plot KV-A01 --date 2026-10-12 --by "Tên"
```

- Ảnh điện thoại chứa **tọa độ GPS = vị trí khoảnh**. Lệnh trên dựng lại
  ảnh từ điểm ảnh → bản lưu **không còn EXIF/GPS/XMP** nào; in ra `có
  GPS: có` nghĩa là ảnh GỐC có GPS và đã được gỡ.
- Kho ảnh nằm NGOÀI repo (`GARDEN_MEDIA_DIR` hoặc `--store`), tên file =
  sha256 → gửi trùng ảnh không nhân đôi. Nhận JPEG (kể cả ảnh iPhone/Samsung
  nhiều khung MPO — chỉ giữ ảnh chính)/PNG/WEBP ≤ 25 MB;
  video/HEIC chưa nhận (đổi sang JPEG trước).
- Đừng gửi ảnh gốc qua kênh khác (Zalo nhóm, email) — gửi bản trong kho.

## Khi nào gọi người khác

| Tình huống | Gọi ai |
|---|---|
| Khoảnh mới chưa có trong ô chọn Khoảnh | Người vận hành — thêm row vào bảng `plots` (status='active') |
| Bản tin/`--verify` báo vấn đề hash chain | **GĐ vùng trồng** + người phụ trách hạ tầng (`sop.md` mục "`--verify` vùng trồng báo lỗi") |
| Tab hiện "Chưa nạp — không kết nối được Postgres" | Người vận hành/IT — `sop.md` mục "DB không kết nối được" |
| Cảnh báo keyword sâu bệnh/rệp/nấm/dịch | **Quản lý vườn** — kiểm tra thực địa ngay |
| Nhập sai nhật ký muốn sửa/xóa | **Không sửa/xóa được** (v9.3 hash chain) — ghi dòng MỚI kèm lý do (vd hoạt động `ghi nhận`, chi tiết "đính chính nhật ký ngày .. : ..."). Đính chính có duyệt = đề xuất someday |
| Muốn nhắc nhật ký bằng tin Zalo thay form | Đội dự án — chat-intake chưa làm (đề xuất someday) |
