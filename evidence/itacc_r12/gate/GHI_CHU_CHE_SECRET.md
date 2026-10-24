# Che secret trong log full (24/10/2026)

- Dòng `# DB …` của `harness/run_full_r12.sh.txt` in tên DB bằng `urlsplit(DATABASE_URL)`; DSN dạng từ khóa libpq
  (`user=… password=… dbname=…`) nên urlsplit trả cả chuỗi và bộ lọc URL `postgres://u:p@` không bắt → mật khẩu superuser
  của cluster Docker THỬ `samsam-itacc-r12` (127.0.0.1:55451, sinh ngẫu nhiên lượt r12, không phải credential dev/prod) lọt
  vào 2 log: `full_so_bo_fs1.txt`, `full_chot_fchot.txt` (dòng 7).
- Xử lý: thay giá trị bằng `***` (sed, chỉ dòng đó; nội dung kết quả pytest không đổi); sửa script in DB qua
  `psycopg.conninfo.conninfo_to_dict` (chỉ dbname/host/port). Cluster thử bị xóa khi dọn tài nguyên lượt → mật khẩu hết hiệu lực.
- sha256 sau khi che: full_so_bo_fs1.txt 8e888d3bde1107fa5ca9e213269dd116d4065922978f637b3a3b1ceca02dab31;
  full_chot_fchot.txt f9beb5c4d3a03805919d66804333920f03414a2a4d54f63878bd1c96981d6527.
