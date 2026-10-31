// Port `crawler/sources.py` — danh sách nguồn crawl public của Công ty TNHH Sâm Sâm.
// samsamngoclinh.com là WooCommerce/WordPress — dùng REST API trước:
//   /wp-json/wp/v2/posts (bài viết), /wp-json/wp/v2/pages (trang giới thiệu),
//   /wp-json/wc/store/v1/products (sản phẩm, public).
// samsam.net.vn là NukeViet — không có REST API gọn, parse HTML; HTTPS trỏ về trang hosting mặc
// định → bắt buộc http://; danh sách URL lấy từ sitemap-vi.*.xml.

export type CrawlSource = {
  name: string;
  type: 'wp_api' | 'html' | 'bricks_listing';
  kind: 'wc_product' | 'wp_post' | 'nv_shop' | 'nv_page' | 'nv_article' | 'bricks_loc';
  url: string;
  output: string;
};

export const SOURCES: readonly CrawlSource[] = [
  {
    name: 'ngoclinh:products',
    type: 'wp_api',
    kind: 'wc_product',
    url: 'https://samsamngoclinh.com/wp-json/wc/store/v1/products',
    output: 'products.jsonl',
  },
  {
    name: 'ngoclinh:posts',
    type: 'wp_api',
    kind: 'wp_post',
    url: 'https://samsamngoclinh.com/wp-json/wp/v2/posts',
    output: 'articles.jsonl',
  },
  {
    name: 'ngoclinh:pages',
    type: 'wp_api',
    kind: 'wp_post',
    url: 'https://samsamngoclinh.com/wp-json/wp/v2/pages',
    output: 'articles.jsonl',
  },
  {
    name: 'netvn:shops',
    type: 'html',
    kind: 'nv_shop',
    url: 'http://samsam.net.vn/sitemap-vi.shops.xml',
    output: 'products.jsonl',
  },
  {
    name: 'netvn:about',
    type: 'html',
    kind: 'nv_page',
    url: 'http://samsam.net.vn/sitemap-vi.about.xml',
    output: 'about.jsonl',
  },
  {
    name: 'netvn:news',
    type: 'html',
    kind: 'nv_article',
    url: 'http://samsam.net.vn/sitemap-vi.news.xml',
    output: 'news.jsonl',
  },
  {
    name: 'netvn:camnang',
    type: 'html',
    kind: 'nv_article',
    url: 'http://samsam.net.vn/sitemap-vi.cam-nang-sam-ngoc-linh.xml',
    output: 'news.jsonl',
  },
  {
    // Trang listing Bricks + AJAX pagination: REST API chỉ trả title, địa chỉ chỉ render trong HTML
    // sau JS → Python render bằng playwright. Bản TS chưa có trình duyệt headless → bỏ qua có cảnh
    // báo (như Python thiếu playwright).
    name: 'ngoclinh:distributors',
    type: 'bricks_listing',
    kind: 'bricks_loc',
    url: 'https://samsamngoclinh.com/he-thong-phan-phoi/',
    output: 'articles.jsonl',
  },
];

export const CRAWL_DELAY_S = 1.0; // luật: ≥1s giữa request
