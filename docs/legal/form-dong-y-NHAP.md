# Mẫu thông báo và xin đồng ý xử lý dữ liệu cá nhân (NHÁP)

> **BẢN NHÁP — chưa có giá trị pháp lý; chờ Chuyên viên Pháp chế duyệt, luật sư rà — agent không kết luận tuân thủ.**
> Phiên bản chính sách: {{policy_version}} · Ngày hiệu lực: {{ngay_hieu_luc}}
> Trạng thái: **chưa gắn kênh — chờ cơ chế consent (Hạ tầng)**. Hiện code CHƯA có bảng
> `consent` hay tin chào kèm link chính sách (GAP trong `docs/legal/DPIA-nhap.md`), nên mẫu
> này chưa được hiển thị cho khách ở Zalo/web.
> Căn cứ: Luật BVDLCN 91/2025/QH15 + NĐ 356/2025 — nội dung bắt buộc của thông báo xử lý
> dữ liệu theo NĐ 356/2025: CẦN LUẬT SƯ XÁC NHẬN.

Nguyên tắc của mẫu: **ba mục đích tách riêng, mỗi mục một ô đồng ý riêng** — không gộp
thành một ô "đồng ý tất cả". Không đánh dấu sẵn ô nào. Khách từ chối mục 2 hoặc mục 3 vẫn
được dùng mục 1.

Bên kiểm soát dữ liệu: {{ten_cong_ty}} · Đầu mối bảo vệ dữ liệu: {{lien_he_dau_moi}}

---

## Mục đích 1 — Chăm sóc khách hàng qua chatbot (Zalo OA / web)

- [ ] Tôi đồng ý cho {{ten_cong_ty}} xử lý tin nhắn của tôi để trả lời câu hỏi về sản phẩm.

| Mục | Nội dung |
|---|---|
| Dữ liệu | Mã người dùng Zalo, nội dung câu hỏi, câu trả lời |
| Mục đích | Trả lời câu hỏi sản phẩm, đo chất lượng trả lời |
| Bên nhận | Zalo/VNG (kênh nhắn tin, Việt Nam); nhà cung cấp AI qua OpenRouter (Mỹ) |
| Chuyển ra nước ngoài | CÓ — câu hỏi thường được **che số điện thoại và email** trước khi gửi nhà cung cấp AI ở nước ngoài. Tên, địa chỉ viết tự do trong câu hỏi CHƯA được che tự động — xin đừng gửi. Câu hỏi có yếu tố sức khỏe (bệnh, triệu chứng, thuốc đang dùng, thai kỳ...) được **chuyển nhân viên trả lời, không gửi AI** |
| Thời hạn lưu | Nhật ký hội thoại 30 ngày (tự xóa); lịch sử hội thoại ngắn hạn chỉ trong bộ nhớ máy chủ, mất khi khởi động lại |
| Quyền của bạn | Rút đồng ý, xem dữ liệu, yêu cầu xóa dữ liệu, phản đối xử lý |
| Cách rút đồng ý | Nhắn "RÚT ĐỒNG Ý" tới OA hoặc liên hệ {{lien_he_dau_moi}} — cơ chế ghi nhận rút đồng ý: chờ Hạ tầng (GAP) |

## Mục đích 2 — Marketing (nhận tin khuyến mãi, sản phẩm mới)

- [ ] Tôi đồng ý nhận tin marketing. *(Mặc định: KHÔNG — chỉ bật khi khách tự chọn.)*

| Mục | Nội dung |
|---|---|
| Dữ liệu | Mã người dùng Zalo, lịch sử quan tâm sản phẩm |
| Mục đích | Gửi thông tin sản phẩm, chương trình — KHÔNG gửi khuyến mại rượu (Luật 44/2019 Điều 5) |
| Bên nhận | Zalo/VNG (Việt Nam) |
| Chuyển ra nước ngoài | Không (theo code hiện tại) |
| Thời hạn lưu | Đến khi rút đồng ý — hạn lưu cụ thể: {{han_luu_marketing}} (CHƯA có trong code) |
| Quyền của bạn | Rút đồng ý bất kỳ lúc nào, xem, xóa dữ liệu |
| Cách rút đồng ý | Nhắn "HỦY TIN" tới OA hoặc liên hệ {{lien_he_dau_moi}} — cơ chế ghi nhận: chờ Hạ tầng (GAP) |

## Mục đích 3 — Liên hệ đại lý / KOC (hợp tác phân phối, quảng bá)

- [ ] Tôi đồng ý để {{ten_cong_ty}} liên hệ lại về hợp tác đại lý / KOC.

| Mục | Nội dung |
|---|---|
| Dữ liệu | Mã người dùng (dạng băm), câu hỏi hợp tác, thông tin liên hệ bạn tự cung cấp |
| Mục đích | Liên hệ đối tác, đánh giá hợp tác |
| Bên nhận | Bộ phận Kinh doanh nội bộ |
| Chuyển ra nước ngoài | Không (theo code hiện tại) |
| Thời hạn lưu | {{han_luu_lead}} — hiện bảng `leads` CHƯA có hạn lưu (GAP) |
| Quyền của bạn | Rút đồng ý, xem, yêu cầu xóa dữ liệu |
| Cách rút đồng ý | Liên hệ {{lien_he_dau_moi}} — dữ liệu liên hệ đối tác bị xóa khỏi danh sách chăm sóc |

---

Ký duyệt mẫu (để trống — chưa ai duyệt):

| Vai trò | Họ tên | Chữ ký | Ngày |
|---|---|---|---|
| Chuyên viên Pháp chế | {{ho_ten_phap_che}} | {{chu_ky_phap_che}} | {{ngay_ky_phap_che}} |
| Luật sư rà soát | {{ho_ten_luat_su}} | {{chu_ky_luat_su}} | {{ngay_ky_luat_su}} |
