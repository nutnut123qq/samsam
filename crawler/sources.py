"""Danh sách nguồn crawl public của Công ty TNHH Sâm Sâm.

Mỗi nguồn khai báo: tên, loại (wp_api | html), url entry, output file.
samsamngoclinh.com là WooCommerce/WordPress — thử REST API trước:
  - /wp-json/wp/v2/posts?per_page=100          (bài viết/tin tức)
  - /wp-json/wp/v2/pages                       (trang giới thiệu)
  - /wp-json/wc/store/v1/products?per_page=100 (sản phẩm, public)
samsam.net.vn là NukeViet — không có REST API gọn, parse HTML.
"""

SOURCES = [
    # TODO(T1.1): điền url thật, thử endpoint wp-json trước, fallback html
]

CRAWL_DELAY_S = 1.0  # luật: ≥1s giữa request
