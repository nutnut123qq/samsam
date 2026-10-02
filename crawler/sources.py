"""Danh sách nguồn crawl public của Công ty TNHH Sâm Sâm.

Mỗi nguồn khai báo: tên, loại (wp_api | html), url entry, output file.
samsamngoclinh.com là WooCommerce/WordPress — thử REST API trước:
  - /wp-json/wp/v2/posts?per_page=100          (bài viết/tin tức)
  - /wp-json/wp/v2/pages                       (trang giới thiệu)
  - /wp-json/wc/store/v1/products?per_page=100 (sản phẩm, public)
samsam.net.vn là NukeViet — không có REST API gọn, parse HTML.
  HTTPS của net.vn trỏ về trang hosting mặc định -> bắt buộc dùng http://.
  Danh sách URL lấy từ sitemap-vi.*.xml (canonical, đỡ phải cào listing).
"""

SOURCES = [
    {
        "name": "ngoclinh:products",
        "type": "wp_api",
        "kind": "wc_product",
        "url": "https://samsamngoclinh.com/wp-json/wc/store/v1/products",
        "output": "products.jsonl",
    },
    {
        "name": "ngoclinh:posts",
        "type": "wp_api",
        "kind": "wp_post",
        "url": "https://samsamngoclinh.com/wp-json/wp/v2/posts",
        "output": "articles.jsonl",
    },
    {
        "name": "ngoclinh:pages",
        "type": "wp_api",
        "kind": "wp_post",
        "url": "https://samsamngoclinh.com/wp-json/wp/v2/pages",
        "output": "articles.jsonl",
    },
    {
        "name": "netvn:shops",
        "type": "html",
        "kind": "nv_shop",
        "url": "http://samsam.net.vn/sitemap-vi.shops.xml",
        "output": "products.jsonl",
    },
    {
        "name": "netvn:about",
        "type": "html",
        "kind": "nv_page",
        "url": "http://samsam.net.vn/sitemap-vi.about.xml",
        "output": "about.jsonl",
    },
    {
        "name": "netvn:news",
        "type": "html",
        "kind": "nv_article",
        "url": "http://samsam.net.vn/sitemap-vi.news.xml",
        "output": "news.jsonl",
    },
]

CRAWL_DELAY_S = 1.0  # luật: ≥1s giữa request
