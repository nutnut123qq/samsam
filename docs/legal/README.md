# Hồ sơ Pháp chế – DPO (NHÁP)

> **BẢN NHÁP — mọi file trong thư mục này chưa có giá trị pháp lý; chờ Chuyên viên Pháp chế, luật sư, TGĐ rà/ký — agent không kết luận tuân thủ.**
> Văn bản pháp lý nội bộ — có chứa từ cấm trong điều khoản CẤM; không đăng, không nạp vào KB chatbot.

| File | Nội dung | Sinh/kiểm bằng | Chờ ai |
|---|---|---|---|
| `DPIA-nhap.md` | Đánh giá tác động xử lý dữ liệu cá nhân | `python scripts/dpia_draft.py` (sinh từ `data/data_flow_map.json`, KHÔNG sửa tay) | Pháp chế ký, luật sư rà |
| `TIA-nhap.md` | Đánh giá chuyển dữ liệu ra nước ngoài | `python scripts/dpia_draft.py` | Pháp chế ký, luật sư rà |
| `form-dong-y-NHAP.md` | Mẫu thông báo + xin đồng ý, 3 mục đích tách riêng | viết tay; test `tests/test_dpia_draft.py` | Pháp chế duyệt; Hạ tầng gắn kênh |
| `mau-hop-dong-koc-NHAP.md` | Mẫu hợp đồng KOC/KOL | `python scripts/contract_check.py --kind koc --file ...` | Luật sư xác nhận |
| `mau-hop-dong-dai-ly-NHAP.md` | Mẫu hợp đồng đại lý | `python scripts/contract_check.py --kind dai_ly --file ...` | Luật sư xác nhận |

Đồng bộ: sửa code thêm luồng dữ liệu ra ngoài → cập nhật `data/data_flow_map.json` → chạy
`python scripts/dpia_draft.py` → `python scripts/dpia_draft.py --check` phải exit 0.
