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

## Khi nào gọi người khác

| Tình huống | Gọi ai |
|---|---|
| Khoảnh mới chưa có trong ô chọn Khoảnh | Người vận hành — thêm row vào bảng `plots` (status='active') |
| Tab hiện "Chưa nạp — không kết nối được Postgres" | Người vận hành/IT — `sop.md` mục "DB không kết nối được" |
| Cảnh báo keyword sâu bệnh/rệp/nấm/dịch | **Quản lý vườn** — kiểm tra thực địa ngay |
| Nhập sai nhật ký muốn sửa/xóa | Người vận hành — sửa trực tiếp trong DB (pilot chưa có nút sửa) |
| Muốn nhắc nhật ký bằng tin Zalo thay form | Đội dự án — chat-intake chưa làm (đề xuất someday) |
