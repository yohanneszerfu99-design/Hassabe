/**
 * HASSABE — Frontend Configuration
 * ─────────────────────────────────────────────────────────────
 * BEFORE DEPLOYING:
 *   1. Change API to your Railway backend URL
 *   2. Change STRIPE_PK to your Stripe publishable key
 *
 * Every frontend page loads this file first via:
 *   <script src="/js/config.js"></script>
 * ─────────────────────────────────────────────────────────────
 */
window.HASSABE_CONFIG = {
  API:       'https://hassabe-production.up.railway.app, // ← CHANGE THIS
  STRIPE_PK: 'pk_live_your_stripe_publishable_key',      // ← CHANGE THIS
  DOMAIN:    'hassabe.com',
  CITIES: [
    'Calgary', 'Edmonton', 'Vancouver', 'Toronto',
    'Washington DC', 'New York', 'Los Angeles'
  ],
  UNLOCK_PRICE: '$49.99',
  UNLOCK_CENTS: 4999,
};

// Backward-compat alias
window.HASABE_CONFIG = window.HASSABE_CONFIG;

// ── Auth helpers used by every page ──────────────────────────
window.Auth = {
  getToken()  { return localStorage.getItem('hassabe_token'); },
  getUserId() { return localStorage.getItem('hassabe_user_id'); },
  isAdmin()   { return localStorage.getItem('hassabe_is_admin') === 'true'; },

  headers() {
    return {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.getToken()}`,
    };
  },

  save(data) {
    if (data.accessToken)  localStorage.setItem('hassabe_token',    data.accessToken);
    if (data.refreshToken) localStorage.setItem('hassabe_refresh',  data.refreshToken);
    if (data.userId)       localStorage.setItem('hassabe_user_id',  data.userId);
    if (data.isAdmin)      localStorage.setItem('hassabe_is_admin', 'true');
  },

  clear() {
    ['hassabe_token','hassabe_refresh','hassabe_user_id','hassabe_is_admin',
     'hasabe_token','hasabe_refresh','hasabe_user_id','hasabe_is_admin']
      .forEach(k => localStorage.removeItem(k));
  },

  requireAuth(redirect = '/auth.html') {
    if (!this.getToken()) { window.location.href = redirect; return false; }
    return true;
  },

  requireAdmin(redirect = '/auth.html') {
    if (!this.getToken() || !this.isAdmin()) { window.location.href = redirect; return false; }
    return true;
  },
};

// ── API fetch wrapper with auto token refresh ─────────────────
window.api = async function(path, opts = {}) {
  const url = window.HASSABE_CONFIG.API + path;
  const res = await fetch(url, {
    ...opts,
    headers: { ...window.Auth.headers(), ...(opts.headers || {}) },
  });

  if (res.status === 401) {
    const refresh = localStorage.getItem('hassabe_refresh');
    if (refresh) {
      const r = await fetch(window.HASSABE_CONFIG.API + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (r.ok) {
        const d = await r.json();
        window.Auth.save(d);
        return fetch(url, {
          ...opts,
          headers: { ...window.Auth.headers(), ...(opts.headers || {}) },
        });
      }
    }
    window.Auth.clear();
    window.location.href = '/auth.html';
    return;
  }
  return res;
};
