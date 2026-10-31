export default function LoginPage() {
  return (
    <main style={{ maxWidth: 360, margin: '64px auto' }}>
      <h1>Đăng nhập</h1>
      <p>Dùng tài khoản nội bộ Sâm Sâm (Keycloak). Chỉ truy cập qua VPN WireGuard.</p>
      <a href="/api/auth/login" style={{ display: 'inline-block', padding: '10px 16px' }}>
        Đăng nhập bằng tài khoản công ty
      </a>
    </main>
  );
}
