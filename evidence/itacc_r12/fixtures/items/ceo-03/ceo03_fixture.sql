-- FIXTURE ceo-03 (SQL owner trên DB thử) — lượt 2 (lượt 1 thiếu document_sha256 → CHECK chặn, không ghi gì):
-- 1 tài liệu giấy XNQC giả (sha = sha256('giay-xnqc-thu-it')) + 2 hồ sơ đã cấp: 1 hết hạn, 1 sắp hết hạn.
insert into documents (sha256, filename, doc_type, text_source, status, verified_by, verified_at)
values (encode(sha256('giay-xnqc-thu-it'::bytea),'hex'), 'giay_xnqc_thu_it.pdf', 'khac', 'none', 'verified', 'Pháp chế Thử IT', now());
insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so, status, so_giay, ngay_nop, ngay_cap, ngay_het_han, document_sha256, updated_by)
values ('savina-12v','maket','Maket Thử IT hết hạn','da_cap','IT-XNQC-001','2025-01-05','2025-02-01','2026-10-01', encode(sha256('giay-xnqc-thu-it'::bytea),'hex'),'Pháp chế Thử IT'),
       ('saphraton-20v','maket','Maket Thử IT sắp hết hạn','da_cap','IT-XNQC-002','2025-03-05','2025-04-01','2026-11-05', encode(sha256('giay-xnqc-thu-it'::bytea),'hex'),'Pháp chế Thử IT');
