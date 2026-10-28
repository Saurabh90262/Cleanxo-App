/**
 * CLEANXO - frontend (single file)
 * React 19 + hash routing. Talks to Server.js through /api.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/* ================================================================== */
/* Constants + helpers                                                 */
/* ================================================================== */
const API = (() => {
  const raw = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '/api'; // local dev: Vite proxies /api to the backend
  return /\/api$/.test(raw) ? raw : raw + '/api';
})();
const LS = { token: 'cleanxo_token', cart: 'cleanxo_cart' };
const FLOW = ['pending', 'confirmed', 'shipped', 'out_for_delivery', 'delivered'];
const STATUS_LABEL = {
  pending: 'Order placed',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};
const DELIVERY_LABEL = {
  pending: 'Awaiting dispatch',
  confirmed: 'Awaiting dispatch',
  shipped: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Not delivered',
};
const DEFAULT_CONFIG = {
  freeShippingMin: 499,
  shippingFee: 49,
  maxQty: 10,
  company: {
    name: 'CLEANXO Home Care Pvt. Ltd.',
    email: '',
    phone: '',
    address: '',
    hours: '',
    mapLink: '',
    mapEmbed: '',
    social: {},
  },
};
const DEFAULT_CATEGORIES = ['Floor Care', 'Bathroom', 'Toilet Care', 'Laundry', 'Kitchen', 'Personal Care', 'Home Care'];
const SWATCHES = ['#0e7c86', '#d9a521', '#3b82c4', '#d1643b', '#5a9e4b', '#8b5fbf', '#c2477a'];

const store = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (d) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const swatchFor = (text = '') => SWATCHES[[...text].reduce((a, c) => a + c.charCodeAt(0), 0) % SWATCHES.length];
const discount = (p) => (p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0);
const passwordOk = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

async function api(path, { method = 'GET', body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: payload });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and make sure the API is running.');
  }
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Something went wrong (error ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- tiny hash router ---------- */
function parseHash() {
  const raw = (window.location.hash || '#/').slice(1);
  const [pathPart, qs] = raw.split('?');
  return { parts: pathPart.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs || '') };
}
function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
const go = (to) => {
  window.location.hash = to;
};
const Link = ({ to, children, ...rest }) => (
  <a href={'#' + to} {...rest}>
    {children}
  </a>
);

const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

/* ================================================================== */
/* Small UI pieces                                                     */
/* ================================================================== */
function Bottle({ color = '#0e7c86', label = '' }) {
  return (
    <svg viewBox="0 0 100 170" className="bottleSvg" aria-hidden="true">
      <rect x="38" y="4" width="24" height="16" rx="4" fill="#0a2a33" />
      <rect x="42" y="20" width="16" height="12" fill={color} opacity=".85" />
      <path d="M30 40c0-8 8-10 20-10s20 2 20 10v110c0 9-6 16-20 16s-20-7-20-16z" fill={color} />
      <path d="M36 44c0-4 4-5 8-5v118c-5 0-8-3-8-9z" fill="#fff" opacity=".22" />
      <rect x="34" y="78" width="32" height="46" rx="6" fill="#fff" opacity=".92" />
      <circle cx="50" cy="94" r="7" fill={color} opacity=".85" />
      <rect x="40" y="107" width="20" height="3" rx="1.5" fill={color} opacity=".6" />
      <rect x="43" y="113" width="14" height="3" rx="1.5" fill={color} opacity=".35" />
      {label && (
        <text x="50" y="140" textAnchor="middle" fontSize="7" fill="#fff" opacity=".85">
          {label}
        </text>
      )}
    </svg>
  );
}

function ProductImage({ product, className = '' }) {
  const [bad, setBad] = useState(!product.image);
  useEffect(() => setBad(!product.image), [product.image]);
  if (bad) {
    return (
      <div className={`imgFallback ${className}`} role="img" aria-label={product.name} style={{ background: swatchFor(product.category) + '22' }}>
        <Bottle color={swatchFor(product.category)} />
      </div>
    );
  }
  return (
    <img
      className={className}
      src={product.image}
      alt={product.name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBad(true)}
    />
  );
}

const Spinner = ({ label = 'Loading…' }) => (
  <div className="center" role="status">
    <span className="spinner" />
    <span>{label}</span>
  </div>
);

const Field = ({ label, hint, children }) => (
  <label className="field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
);

const StatusPill = ({ status }) => <span className={`pill s-${status}`}>{STATUS_LABEL[status] || status}</span>;

function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="iconBtn closeBtn" onClick={onClose} aria-label="Close">
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

const Icon = {
  instagram: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
    </svg>
  ),
  facebook: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 21v-8h3l.5-3.5H14V7.4c0-1 .4-1.7 1.8-1.7h1.8V2.6C17.3 2.5 16.3 2.4 15.2 2.4 12.8 2.4 11 3.9 11 6.7v2.8H8V13h3v8z" fill="currentColor" />
    </svg>
  ),
  twitter: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.7 3h3l-6.6 7.5L21.9 21h-6.1l-4.8-6.3L5.500 21h-3l7-8.1L2.100 3h6.200l4.300 5.700zm-1 16.200h1.700L7.400 4.700H5.600z" fill="currentColor" />
    </svg>
  ),
  bag: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 21c0-4.400 3.600-7 8-7s8 2.600 8 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m16.500 16.500 4.500 4.500" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

/* ================================================================== */
/* Authentication modal (login / register with email OTP / forgot)     */
/* ================================================================== */
function AuthModal({ initialMode = 'login', onClose }) {
  const { loginDone, toast } = useApp();
  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ name: '', email: '', phone: '', otp: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [cool, setCool] = useState(0);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (cool <= 0) return undefined;
    const t = setTimeout(() => setCool((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const switchMode = (m) => {
    setMode(m);
    setStep(1);
    setErr('');
    setInfo('');
    setF((s) => ({ ...s, otp: '', password: '', confirm: '' }));
  };

  const sendOtp = async () => {
    setErr('');
    setBusy(true);
    try {
      await api('/auth/send-otp', { method: 'POST', body: { email: f.email, purpose: mode === 'register' ? 'register' : 'reset' } });
      setStep(2);
      setCool(30);
      setInfo(`We sent a 6-digit code to ${f.email}. It stays valid for 10 minutes.`);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    const email = f.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return setErr('Enter a valid email address.');

    if (mode === 'login') {
      if (!f.password) return setErr('Enter your password.');
      setBusy(true);
      try {
        loginDone(await api('/auth/login', { method: 'POST', body: { email, password: f.password } }));
      } catch (er) {
        setErr(er.message);
      }
      return setBusy(false);
    }

    if (step === 1) {
      if (mode === 'register' && f.name.trim().length < 2) return setErr('Enter your full name.');
      return sendOtp();
    }

    if (!/^\d{6}$/.test(f.otp.trim())) return setErr('Enter the 6-digit code from your email.');
    if (!passwordOk(f.password)) return setErr('Password needs at least 8 characters with a letter and a number.');
    if (f.password !== f.confirm) return setErr('The two passwords do not match.');
    setBusy(true);
    try {
      if (mode === 'register') {
        loginDone(
          await api('/auth/register', {
            method: 'POST',
            body: { name: f.name, email, phone: f.phone, password: f.password, otp: f.otp.trim() },
          }),
          true,
        );
      } else {
        await api('/auth/reset-password', { method: 'POST', body: { email, otp: f.otp.trim(), password: f.password } });
        toast('Password updated. Sign in with your new password.');
        switchMode('login');
      }
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };

  const titles = { login: 'Sign in to CLEANXO', register: 'Create your account', forgot: 'Reset your password' };
  const pwType = showPw ? 'text' : 'password';

  return (
    <Modal title={titles[mode]} onClose={onClose}>
      <form className="authForm" onSubmit={submit} noValidate>
        <h2>{titles[mode]}</h2>
        <p className="muted">
          {mode === 'login' && 'Welcome back. Sign in to check out and track your orders.'}
          {mode === 'register' && (step === 1 ? 'Start with your name and email. We will send a code to verify it.' : 'Enter the code and choose a password.')}
          {mode === 'forgot' && (step === 1 ? 'Enter your account email and we will send a reset code.' : 'Enter the code and a new password.')}
        </p>

        {mode === 'register' && step === 1 && (
          <>
            <Field label="Full name">
              <input value={f.name} onChange={set('name')} autoComplete="name" autoFocus />
            </Field>
            <Field label="Mobile number (optional)">
              <input value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="10-digit number" />
            </Field>
          </>
        )}

        <Field label="Email address">
          <input type="email" value={f.email} onChange={set('email')} autoComplete="email" disabled={step === 2} autoFocus={mode !== 'register'} />
        </Field>

        {mode === 'login' && (
          <Field label="Password">
            <input type={pwType} value={f.password} onChange={set('password')} autoComplete="current-password" />
          </Field>
        )}

        {mode !== 'login' && step === 2 && (
          <>
            <Field label="6-digit code">
              <input value={f.otp} onChange={set('otp')} inputMode="numeric" maxLength={6} autoComplete="one-time-code" className="otpInput" autoFocus />
            </Field>
            <Field label={mode === 'forgot' ? 'New password' : 'Password'} hint="At least 8 characters, with a letter and a number.">
              <input type={pwType} value={f.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
            <Field label="Confirm password">
              <input type={pwType} value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
            </Field>
          </>
        )}

        {(mode === 'login' || step === 2) && (
          <label className="check">
            <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} /> Show password
          </label>
        )}

        {info && <div className="note ok">{info}</div>}
        {err && (
          <div className="note bad" role="alert">
            {err}
          </div>
        )}

        <button className="btn primary full" disabled={busy}>
          {busy
            ? 'Please wait…'
            : mode === 'login'
              ? 'Sign in'
              : step === 1
                ? 'Send verification code'
                : mode === 'register'
                  ? 'Verify and create account'
                  : 'Update password'}
        </button>

        {mode !== 'login' && step === 2 && (
          <button type="button" className="linkBtn" onClick={sendOtp} disabled={busy || cool > 0}>
            {cool > 0 ? `Resend code in ${cool}s` : 'Resend code'}
          </button>
        )}

        <div className="authLinks">
          {mode === 'login' && (
            <>
              <button type="button" className="linkBtn" onClick={() => switchMode('forgot')}>
                Forgot password?
              </button>
              <button type="button" className="linkBtn" onClick={() => switchMode('register')}>
                New here? Create an account
              </button>
            </>
          )}
          {mode !== 'login' && (
            <button type="button" className="linkBtn" onClick={() => switchMode('login')}>
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/* ================================================================== */
/* Header / footer                                                     */
/* ================================================================== */
function Header() {
  const { user, cartCount, openAuth, menu, setMenu, route, config } = useApp();
  const [q, setQ] = useState('');
  const page = route.parts[0] || '';
  const submit = (e) => {
    e.preventDefault();
    go(`/shop?q=${encodeURIComponent(q.trim())}`);
    setMenu(false);
  };
  const navItems = [
    ['', 'Home'],
    ['shop', 'Shop'],
    ['about', 'Our story'],
    ['contact', 'Contact'],
  ];
  return (
    <>
      <div className="announce">
        Free shipping on orders over {inr(config.freeShippingMin)}. Pay cash on delivery.
      </div>
      <header className="header">
        <button className="iconBtn menuBtn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>
          {Icon.menu}
        </button>
        <Link to="/" className="brand" aria-label="CLEANXO home">
          CLEAN<span>XO</span>
        </Link>
        <nav className={`nav ${menu ? 'open' : ''}`} aria-label="Main">
          {navItems.map(([p, label]) => (
            <Link key={p} to={'/' + p} className={page === p ? 'active' : ''} onClick={() => setMenu(false)}>
              {label}
            </Link>
          ))}
          {user?.role === 'admin' && (
            <Link to="/admin" className={page === 'admin' ? 'active' : ''} onClick={() => setMenu(false)}>
              Admin
            </Link>
          )}
          <form className="searchMobile" onSubmit={submit}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" aria-label="Search products" />
          </form>
        </nav>
        <div className="headerRight">
          <form className="search" onSubmit={submit} role="search">
            <button aria-label="Search">{Icon.search}</button>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" aria-label="Search products" />
          </form>
          <button className="hBtn" onClick={() => (user ? go('/account/orders') : openAuth('login'))}>
            {Icon.user}
            <span>{user ? user.name.split(' ')[0] : 'Sign in'}</span>
          </button>
          <Link to="/cart" className="hBtn bagBtn" aria-label={`Bag, ${cartCount} items`}>
            {Icon.bag}
            <span>Bag</span>
            {cartCount > 0 && <b className="badge">{cartCount}</b>}
          </Link>
        </div>
      </header>
    </>
  );
}

function Footer() {
  const { config, products } = useApp();
  const c = config.company;
  const cats = [...new Set(products.map((p) => p.category))].slice(0, 5);
  const socials = [
    ['instagram', 'Instagram'],
    ['youtube', 'YouTube'],
    ['facebook', 'Facebook'],
    ['twitter', 'X (Twitter)'],
  ];
  return (
    <footer className="footer">
      <div className="footGrid">
        <div>
          <div className="brand light">
            CLEAN<span>XO</span>
          </div>
          <p>Everyday cleaning essentials for floors, bathrooms, kitchens and laundry. Made in India, delivered to your door.</p>
          <div className="socials">
            {socials.map(([k, label]) =>
              c.social?.[k] ? (
                <a key={k} href={c.social[k]} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
                  {Icon[k]}
                </a>
              ) : null,
            )}
          </div>
        </div>
        <div>
          <h4>Shop</h4>
          <Link to="/shop">All products</Link>
          {cats.map((cat) => (
            <Link key={cat} to={`/shop?cat=${encodeURIComponent(cat)}`}>
              {cat}
            </Link>
          ))}
        </div>
        <div>
          <h4>Help</h4>
          <Link to="/account/orders">Track my order</Link>
          <Link to="/account/help">Contact support</Link>
          <Link to="/policy/shipping">Shipping and returns</Link>
          <Link to="/policy/privacy">Privacy policy</Link>
          <Link to="/about">Our story</Link>
        </div>
        <div>
          <h4>Visit and contact</h4>
          {c.address && <p>{c.address}</p>}
          {c.phone && (
            <p>
              <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a>
            </p>
          )}
          {c.email && (
            <p>
              <a href={`mailto:${c.email}`}>{c.email}</a>
            </p>
          )}
          {c.hours && <p>{c.hours}</p>}
          {(c.mapEmbed || c.mapLink) && (
            <div className="mapCard">
              {c.mapEmbed && <iframe title="CLEANXO location" loading="lazy" referrerPolicy="no-referrer-when-downgrade" src={c.mapEmbed} />}
              {c.mapLink && (
                <a href={c.mapLink} target="_blank" rel="noopener noreferrer">
                  Open in Google Maps
                </a>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="footBottom">
        <span>© {new Date().getFullYear()} {c.name}. All rights reserved.</span>
        <span>Cash on delivery across India. Easy returns on damaged items.</span>
      </div>
    </footer>
  );
}

/* ================================================================== */
/* Product card + home                                                 */
/* ================================================================== */
function ProductCard({ p }) {
  const { addToCart } = useApp();
  const out = p.stock < 1;
  return (
    <article className="card product">
      <Link to={`/product/${p._id}`} className="pImage" aria-label={p.name}>
        {p.badge && <span className="tag">{p.badge}</span>}
        {out && <span className="tag soldout">Sold out</span>}
        <ProductImage product={p} />
      </Link>
      <div className="pBody">
        <span className="pCat">{p.category}</span>
        <h3>
          <Link to={`/product/${p._id}`}>{p.name}</Link>
        </h3>
        <p className="muted small">{p.size}</p>
        <div className="pFoot">
          <div className="price">
            <b>{inr(p.price)}</b>
            {discount(p) > 0 && <s>{inr(p.mrp)}</s>}
          </div>
          <button className="btn small dark" disabled={out} onClick={() => addToCart(p, 1)}>
            {out ? 'Sold out' : 'Add to bag'}
          </button>
        </div>
      </div>
    </article>
  );
}

function ProductGrid({ items, loading }) {
  if (loading) {
    return (
      <div className="grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card skeleton" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid">
      {items.map((p) => (
        <ProductCard key={p._id} p={p} />
      ))}
    </div>
  );
}

const CAT_NOTE = {
  'Floor Care': 'Tiles, marble, wood',
  Bathroom: 'Scale, soap scum, shine',
  'Toilet Care': 'Gels and bowl cleaners',
  Laundry: 'Powders and liquids',
  Kitchen: 'Dishwash and degreasers',
  'Personal Care': 'Hand wash and soaps',
  'Home Care': 'Glass and surfaces',
};

function Home() {
  const { products, productsLoading, productsError, config } = useApp();
  const cats = [...new Set(products.map((p) => p.category))];
  const best = [...products].sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 4);
  return (
    <main>
      <section className="hero">
        <div className="heroText">
          <h1>Cleaner floors, fresher rooms, zero fuss.</h1>
          <p className="lead">
            CLEANXO makes the cleaners you reach for every day: floor, bathroom, toilet, kitchen and laundry. Strong on grime, light on scent, and priced fairly.
          </p>
          <div className="heroCta">
            <Link to="/shop" className="btn primary big">
              Shop all products
            </Link>
            <Link to="/about" className="btn ghost big">
              Why CLEANXO
            </Link>
          </div>
          <ul className="heroFacts">
            <li>
              <b>Free delivery</b> over {inr(config.freeShippingMin)}
            </li>
            <li>
              <b>Pay on delivery</b> anywhere in India
            </li>
            <li>
              <b>Easy returns</b> on damaged items
            </li>
          </ul>
        </div>
        <div className="heroArt" aria-hidden="true">
          <span className="bubble b1" />
          <span className="bubble b2" />
          <span className="bubble b3" />
          <span className="bubble b4" />
          <span className="bubble b5" />
          <div className="heroBottles">
            <div className="hb h1">
              <Bottle color="#d9a521" />
            </div>
            <div className="hb h2">
              <Bottle color="#0e7c86" />
            </div>
            <div className="hb h3">
              <Bottle color="#3b82c4" />
            </div>
          </div>
          <div className="wave" />
        </div>
      </section>

      <section className="wrap section">
        <div className="sectionHead">
          <h2>Pick a room, we have the cleaner</h2>
          <Link to="/shop" className="textLink">
            View all products
          </Link>
        </div>
        <div className="catGrid">
          {(cats.length ? cats : DEFAULT_CATEGORIES.slice(0, 6)).map((c) => (
            <Link key={c} to={`/shop?cat=${encodeURIComponent(c)}`} className="catTile" style={{ '--sw': swatchFor(c) }}>
              <span className="catDot" />
              <b>{c}</b>
              <small>{CAT_NOTE[c] || 'Browse the range'}</small>
            </Link>
          ))}
        </div>
      </section>

      <section className="wrap section">
        <div className="sectionHead">
          <h2>Most loved at home</h2>
          <Link to="/shop" className="textLink">
            See everything
          </Link>
        </div>
        {productsError ? <div className="note bad">{productsError}</div> : <ProductGrid items={best} loading={productsLoading} />}
      </section>

      <section className="band">
        <div className="wrap bandGrid">
          <div>
            <h2>Made to work hard, and to be nice to live with</h2>
            <p>
              Every formula is tested on real Indian homes: hard water, humid summers and heavy-use kitchens. We keep the fragrance gentle and the packaging simple so the product does the talking.
            </p>
          </div>
          <ul className="points">
            <li>
              <b>Hard-water tested</b>
              <span>Cuts limescale and soap scum on fittings and tiles.</span>
            </li>
            <li>
              <b>Concentrated</b>
              <span>A little goes a long way, so a bottle lasts longer.</span>
            </li>
            <li>
              <b>Fair prices</b>
              <span>Direct from our factory to you, no middlemen.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="wrap section">
        <h2>What customers say</h2>
        <div className="quotes">
          {[
            ['The bathroom cleaner took off stains my old one never touched. Floors smell fresh without being heavy.', 'Priya S., Pune'],
            ['Ordering was easy and the parcel came in two days. The detergent is gentle on school uniforms.', 'Rahul M., Delhi'],
            ['Toilet gel clings properly and works fast. Good value for the size.', 'Anita K., Bengaluru'],
          ].map(([t, n]) => (
            <figure key={n} className="card quote">
              <blockquote>{t}</blockquote>
              <figcaption>{n}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="wrap section narrow">
        <h2>Questions people ask</h2>
        {[
          ['How do I pay?', 'Pay cash on delivery when your order arrives. We will add online payments soon.'],
          ['How long does delivery take?', 'Most orders arrive in 2 to 5 working days. You can follow every step from My orders.'],
          ['Can I cancel an order?', 'Yes, from My orders as long as it has not shipped yet. Stock goes back instantly.'],
          ['What if an item arrives damaged?', 'Write to us from Help and support with your order number and we will replace it.'],
        ].map(([q, a]) => (
          <details key={q} className="faq">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>
    </main>
  );
}

/* ================================================================== */
/* Shop + product page                                                 */
/* ================================================================== */
function Shop() {
  const { products, productsLoading, productsError, route } = useApp();
  const cat = route.query.get('cat') || 'All';
  const q = route.query.get('q') || '';
  const [sort, setSort] = useState('featured');
  const cats = ['All', ...new Set(products.map((p) => p.category))];
  const items = useMemo(() => {
    let list = products.filter(
      (p) =>
        (cat === 'All' || p.category === cat) &&
        (!q || `${p.name} ${p.category} ${p.shortDescription} ${p.uses}`.toLowerCase().includes(q.toLowerCase())),
    );
    if (sort === 'low') list = [...list].sort((a, b) => a.price - b.price);
    if (sort === 'high') list = [...list].sort((a, b) => b.price - a.price);
    if (sort === 'popular') list = [...list].sort((a, b) => (b.sold || 0) - (a.sold || 0));
    return list;
  }, [products, cat, q, sort]);
  const setParam = (k, v) => {
    const next = new URLSearchParams(route.query);
    if (v && v !== 'All') next.set(k, v);
    else next.delete(k);
    go(`/shop${next.toString() ? '?' + next : ''}`);
  };
  return (
    <main className="wrap section">
      <h1>{q ? `Results for “${q}”` : cat === 'All' ? 'All products' : cat}</h1>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Categories">
          {cats.map((c) => (
            <button key={c} className={`chip ${c === cat ? 'on' : ''}`} onClick={() => setParam('cat', c)}>
              {c}
            </button>
          ))}
        </div>
        <label className="sortBox">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="featured">Newest</option>
            <option value="popular">Most popular</option>
            <option value="low">Price: low to high</option>
            <option value="high">Price: high to low</option>
          </select>
        </label>
      </div>
      {q && (
        <button className="linkBtn" onClick={() => setParam('q', '')}>
          Clear search
        </button>
      )}
      {productsError ? (
        <div className="note bad">{productsError}</div>
      ) : !productsLoading && !items.length ? (
        <div className="empty">
          <p>No products match that search. Try another word or pick a different category.</p>
          <Link to="/shop" className="btn primary">
            See all products
          </Link>
        </div>
      ) : (
        <ProductGrid items={items} loading={productsLoading} />
      )}
    </main>
  );
}

function ProductPage({ id }) {
  const { products, productsLoading, addToCart, config } = useApp();
  const [qty, setQty] = useState(1);
  const p = products.find((x) => x._id === id);
  if (productsLoading) return <Spinner />;
  if (!p)
    return (
      <main className="wrap section empty">
        <h1>We could not find that product</h1>
        <p>It may have been removed.</p>
        <Link to="/shop" className="btn primary">
          Back to shop
        </Link>
      </main>
    );
  const maxQ = Math.max(1, Math.min(p.stock, config.maxQty));
  const out = p.stock < 1;
  const related = products.filter((x) => x.category === p.category && x._id !== p._id).slice(0, 4);
  return (
    <main className="wrap section">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/shop">Shop</Link> / <Link to={`/shop?cat=${encodeURIComponent(p.category)}`}>{p.category}</Link> / <span>{p.name}</span>
      </nav>
      <div className="pdp">
        <div className="pdpImage card">
          {p.badge && <span className="tag">{p.badge}</span>}
          <ProductImage product={p} />
        </div>
        <div className="pdpInfo">
          <span className="pCat">{p.category}</span>
          <h1>{p.name}</h1>
          <p className="lead small">{p.shortDescription}</p>
          <div className="price big">
            <b>{inr(p.price)}</b>
            {discount(p) > 0 && (
              <>
                <s>{inr(p.mrp)}</s>
                <span className="save">{discount(p)}% off</span>
              </>
            )}
          </div>
          <p className="muted small">Pack size: {p.size}. Inclusive of taxes.</p>
          <p className={`stockLine ${out ? 'bad' : p.stock <= 10 ? 'warn' : 'good'}`}>
            {out ? 'Currently sold out' : p.stock <= 10 ? `Only ${p.stock} left in stock` : 'In stock'}
          </p>
          {!out && (
            <div className="buyRow">
              <div className="qty" role="group" aria-label="Quantity">
                <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease">
                  −
                </button>
                <span>{Math.min(qty, maxQ)}</span>
                <button onClick={() => setQty((q) => Math.min(maxQ, q + 1))} aria-label="Increase">
                  +
                </button>
              </div>
              <button className="btn primary big" onClick={() => addToCart(p, Math.min(qty, maxQ))}>
                Add to bag
              </button>
              <button
                className="btn ghost big"
                onClick={() => {
                  addToCart(p, Math.min(qty, maxQ), true);
                  go('/cart');
                }}
              >
                Buy now
              </button>
            </div>
          )}
          <div className="infoBlock">
            <h3>About this product</h3>
            <p>{p.details || p.shortDescription}</p>
          </div>
          {p.uses && (
            <div className="infoBlock">
              <h3>Where and how to use</h3>
              <p>{p.uses}</p>
            </div>
          )}
          <p className="muted small">Delivery in 2 to 5 working days. Pay cash on delivery.</p>
        </div>
      </div>
      {related.length > 0 && (
        <section className="section">
          <h2>More from {p.category}</h2>
          <ProductGrid items={related} />
        </section>
      )}
    </main>
  );
}

/* ================================================================== */
/* Cart + checkout                                                     */
/* ================================================================== */
function ShipBar({ subtotal }) {
  const { config } = useApp();
  const left = config.freeShippingMin - subtotal;
  return (
    <div className="shipBar">
      <p>{left > 0 ? `Add ${inr(left)} more for free delivery` : 'You have free delivery on this order'}</p>
      <div className="track">
        <span style={{ width: `${Math.min(100, (subtotal / config.freeShippingMin) * 100)}%` }} />
      </div>
    </div>
  );
}

function CartPage() {
  const { lines, setQty, removeLine, subtotal, shipping, total, user, openAuth, config, productsLoading } = useApp();
  const buyable = lines.filter((l) => !l.unavailable);
  if (productsLoading) return <Spinner />;
  return (
    <main className="wrap section">
      <h1>Your bag</h1>
      {!lines.length ? (
        <div className="empty">
          <p>Your bag is empty. Find something for your home.</p>
          <Link to="/shop" className="btn primary">
            Start shopping
          </Link>
        </div>
      ) : (
        <div className="split">
          <div>
            {lines.map((l) => (
              <div className={`line ${l.unavailable ? 'dim' : ''}`} key={l._id}>
                <Link to={`/product/${l._id}`} className="lineImg">
                  <ProductImage product={l} />
                </Link>
                <div className="lineInfo">
                  <Link to={`/product/${l._id}`}>
                    <b>{l.name}</b>
                  </Link>
                  <span className="muted small">{l.size}</span>
                  {l.unavailable ? <span className="stockLine bad">Sold out. Remove it to continue.</span> : <span>{inr(l.price)}</span>}
                </div>
                {!l.unavailable && (
                  <div className="qty" role="group" aria-label={`Quantity of ${l.name}`}>
                    <button onClick={() => setQty(l._id, l.qty - 1)} aria-label="Decrease">
                      −
                    </button>
                    <span>{l.qty}</span>
                    <button onClick={() => setQty(l._id, l.qty + 1)} aria-label="Increase" disabled={l.qty >= Math.min(l.stock, config.maxQty)}>
                      +
                    </button>
                  </div>
                )}
                <b className="lineTotal">{!l.unavailable && inr(l.price * l.qty)}</b>
                <button className="iconBtn" onClick={() => removeLine(l._id)} aria-label={`Remove ${l.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <aside className="summary card">
            <h3>Order summary</h3>
            <ShipBar subtotal={subtotal} />
            <div className="row">
              <span>Subtotal</span>
              <b>{inr(subtotal)}</b>
            </div>
            <div className="row">
              <span>Delivery</span>
              <b>{shipping ? inr(shipping) : 'Free'}</b>
            </div>
            <div className="row grand">
              <span>Total</span>
              <b>{inr(total)}</b>
            </div>
            <button
              className="btn primary full"
              disabled={!buyable.length || buyable.length !== lines.length}
              onClick={() => (user ? go('/checkout') : openAuth('login', '/checkout'))}
            >
              {user ? 'Continue to checkout' : 'Sign in to checkout'}
            </button>
            {!user && <p className="muted small">You can browse and fill your bag freely. An account is needed to place the order.</p>}
          </aside>
        </div>
      )}
    </main>
  );
}

const EMPTY_ADDR = { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };

function Checkout() {
  const { user, token, lines, subtotal, shipping, total, clearCart, toast } = useApp();
  const [addr, setAddr] = useState(() => ({
    ...EMPTY_ADDR,
    ...(user?.address || {}),
    name: user?.address?.name || user?.name || '',
    phone: user?.address?.phone || user?.phone || '',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setAddr((a) => ({ ...a, [k]: e.target.value }));

  if (!lines.length)
    return (
      <main className="wrap section empty">
        <h1>Nothing to check out</h1>
        <Link to="/shop" className="btn primary">
          Go to shop
        </Link>
      </main>
    );
  const blocked = lines.some((l) => l.unavailable);

  const place = async (e) => {
    e.preventDefault();
    setErr('');
    if (blocked) return setErr('Remove sold-out items from your bag first.');
    if (!/^(\+91)?[6-9]\d{9}$/.test(addr.phone.replace(/[\s-]/g, ''))) return setErr('Enter a valid 10-digit mobile number.');
    if (!/^[1-9]\d{5}$/.test(addr.pincode)) return setErr('Enter a valid 6-digit PIN code.');
    setBusy(true);
    try {
      const order = await api('/orders', {
        method: 'POST',
        token,
        body: { items: lines.map((l) => ({ productId: l._id, qty: l.qty })), shippingAddress: addr },
      });
      clearCart();
      toast('Order placed. A confirmation email is on its way.');
      go(`/order/${order._id}?placed=1`);
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };

  return (
    <main className="wrap section">
      <h1>Checkout</h1>
      <form className="split" onSubmit={place}>
        <div className="stack">
          <section className="card pad">
            <h3>Delivery address</h3>
            <div className="formGrid">
              <Field label="Full name">
                <input value={addr.name} onChange={set('name')} required autoComplete="name" />
              </Field>
              <Field label="Mobile number">
                <input value={addr.phone} onChange={set('phone')} required inputMode="tel" autoComplete="tel" />
              </Field>
              <Field label="House no., building, street">
                <input value={addr.line1} onChange={set('line1')} required autoComplete="address-line1" />
              </Field>
              <Field label="Area, landmark (optional)">
                <input value={addr.line2} onChange={set('line2')} autoComplete="address-line2" />
              </Field>
              <Field label="City">
                <input value={addr.city} onChange={set('city')} required autoComplete="address-level2" />
              </Field>
              <Field label="State">
                <input value={addr.state} onChange={set('state')} required autoComplete="address-level1" />
              </Field>
              <Field label="PIN code">
                <input value={addr.pincode} onChange={set('pincode')} required inputMode="numeric" maxLength={6} autoComplete="postal-code" />
              </Field>
            </div>
          </section>
          <section className="card pad">
            <h3>Payment</h3>
            <label className="radioRow">
              <input type="radio" checked readOnly /> <span><b>Cash on delivery</b><br /><small className="muted">Pay in cash or UPI to the delivery partner when your order arrives.</small></span>
            </label>
          </section>
        </div>
        <aside className="summary card">
          <h3>Your order</h3>
          {lines.map((l) => (
            <div className="row" key={l._id}>
              <span>
                {l.name} × {l.qty}
              </span>
              <b>{inr(l.price * l.qty)}</b>
            </div>
          ))}
          <hr />
          <div className="row">
            <span>Subtotal</span>
            <b>{inr(subtotal)}</b>
          </div>
          <div className="row">
            <span>Delivery</span>
            <b>{shipping ? inr(shipping) : 'Free'}</b>
          </div>
          <div className="row grand">
            <span>Total to pay</span>
            <b>{inr(total)}</b>
          </div>
          {err && (
            <div className="note bad" role="alert">
              {err}
            </div>
          )}
          <button className="btn primary full" disabled={busy}>
            {busy ? 'Placing order…' : 'Place order'}
          </button>
          <p className="muted small">Final prices and stock are confirmed by our server when you place the order.</p>
        </aside>
      </form>
    </main>
  );
}

/* ================================================================== */
/* Orders: tracker, detail, list                                       */
/* ================================================================== */
function Tracker({ order }) {
  if (order.status === 'cancelled') {
    return (
      <div className="note bad">
        <b>This order was cancelled</b>
        {order.cancelledAt && <> on {fmtDate(order.cancelledAt)}</>}
        {order.cancelReason && <>. Reason: {order.cancelReason}</>}
      </div>
    );
  }
  const idx = FLOW.indexOf(order.status);
  const when = (s) => order.history?.find((h) => h.status === s)?.at;
  return (
    <ol className="tracker">
      {FLOW.map((s, i) => (
        <li key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
          <span className="dot" />
          <b>{STATUS_LABEL[s]}</b>
          <small>{when(s) ? fmtDateTime(when(s)) : ''}</small>
        </li>
      ))}
    </ol>
  );
}

function useCancel(onDone) {
  const { token, toast, confirm } = useApp();
  return async (order) => {
    const ok = await confirm({
      title: `Cancel order ${order.orderNumber}?`,
      message: 'Your items go back into stock and you will not be charged. This cannot be undone.',
      confirmText: 'Cancel order',
      cancelText: 'Keep order',
      danger: true,
    });
    if (!ok) return;
    try {
      const o = await api(`/orders/${order._id}/cancel`, { method: 'PATCH', token, body: { reason: 'Cancelled by customer' } });
      toast('Order cancelled.');
      onDone?.(o);
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
}

function OrderPage({ id, placed }) {
  const { token, user } = useApp();
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api(`/orders/${id}`, { token })
      .then(setOrder)
      .catch((e) => setErr(e.message));
  }, [id, token]);
  const cancel = useCancel(setOrder);
  if (err)
    return (
      <main className="wrap section empty">
        <h1>Order not found</h1>
        <p>{err}</p>
        <Link to="/account/orders" className="btn primary">
          My orders
        </Link>
      </main>
    );
  if (!order) return <Spinner />;
  const a = order.shippingAddress || {};
  return (
    <main className="wrap section">
      {placed && (
        <div className="success">
          <h2>Thank you, your order is placed</h2>
          <p>We are emailing the full order details to <b>{user?.email}</b>. If it does not arrive in a few minutes, check your spam folder. Your order number is <b>{order.orderNumber}</b>.</p>
        </div>
      )}
      <div className="orderHead">
        <div>
          <h1>Order {order.orderNumber}</h1>
          <p className="muted">Placed on {fmtDateTime(order.createdAt)}</p>
        </div>
        <StatusPill status={order.status} />
      </div>
      <div className="split">
        <div className="stack">
          <section className="card pad">
            <h3>Delivery status: {DELIVERY_LABEL[order.status]}</h3>
            <Tracker order={order} />
          </section>
          <section className="card pad">
            <h3>Items</h3>
            {order.items.map((i, n) => (
              <div className="row itemRow" key={n}>
                <span>
                  {i.name} <small className="muted">({i.size})</small> × {i.qty}
                </span>
                <b>{inr(i.price * i.qty)}</b>
              </div>
            ))}
            <hr />
            <div className="row">
              <span>Subtotal</span>
              <b>{inr(order.subtotal)}</b>
            </div>
            <div className="row">
              <span>Delivery</span>
              <b>{order.shipping ? inr(order.shipping) : 'Free'}</b>
            </div>
            <div className="row grand">
              <span>Total ({order.paymentMethod})</span>
              <b>{inr(order.total)}</b>
            </div>
            <p className="muted small">Payment: {order.paymentStatus === 'paid' ? 'Paid' : 'To be paid on delivery'}</p>
          </section>
        </div>
        <aside className="stack">
          <section className="card pad">
            <h3>Delivering to</h3>
            <p>
              {a.name}
              <br />
              {a.line1}
              {a.line2 && <>, {a.line2}</>}
              <br />
              {a.city}, {a.state} {a.pincode}
              <br />
              {a.phone}
            </p>
          </section>
          <section className="card pad">
            <h3>Need something?</h3>
            {['pending', 'confirmed'].includes(order.status) && (
              <button className="btn danger full" onClick={() => cancel(order)}>
                Cancel this order
              </button>
            )}
            <Link to={`/account/help?order=${order.orderNumber}`} className="btn ghost full">
              Get help with this order
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}

/* ================================================================== */
/* Account area                                                        */
/* ================================================================== */
function AccountOrders() {
  const { token } = useApp();
  const [orders, setOrders] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api('/orders/my', { token })
      .then(setOrders)
      .catch((e) => setErr(e.message));
  }, [token]);
  useEffect(load, [load]);
  const cancel = useCancel(load);
  if (err) return <div className="note bad">{err}</div>;
  if (!orders) return <Spinner />;
  if (!orders.length)
    return (
      <div className="empty">
        <p>No orders yet. Your orders and their tracking will show up here.</p>
        <Link to="/shop" className="btn primary">
          Start shopping
        </Link>
      </div>
    );
  return (
    <div className="stack">
      {orders.map((o) => (
        <article className="card pad orderCard" key={o._id}>
          <div className="orderTop">
            <div>
              <b>{o.orderNumber}</b>
              <p className="muted small">
                {fmtDate(o.createdAt)} · {o.items.reduce((n, i) => n + i.qty, 0)} item(s) · {inr(o.total)}
              </p>
            </div>
            <StatusPill status={o.status} />
          </div>
          <p className="muted small">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</p>
          <p className="small">Delivery: {DELIVERY_LABEL[o.status]}</p>
          <div className="btnRow">
            <Link to={`/order/${o._id}`} className="btn small dark">
              Track order
            </Link>
            {['pending', 'confirmed'].includes(o.status) && (
              <button className="btn small danger" onClick={() => cancel(o)}>
                Cancel
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function AccountDetails() {
  const { user, token, setUser, toast } = useApp();
  const [f, setF] = useState({ name: user.name, phone: user.phone || '', address: { ...EMPTY_ADDR, ...(user.address || {}) } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const setA = (k) => (e) => setF((s) => ({ ...s, address: { ...s.address, [k]: e.target.value } }));
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await api('/auth/me', { method: 'PATCH', token, body: f });
      setUser(d.user);
      toast('Your details are saved.');
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };
  return (
    <form className="card pad stack" onSubmit={save}>
      <h3>Account details</h3>
      <div className="formGrid">
        <Field label="Full name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <Field label="Mobile number">
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" />
        </Field>
        <Field label="Email" hint="Your email is your login and cannot be changed.">
          <input value={user.email} disabled />
        </Field>
      </div>
      <h3>Default delivery address</h3>
      <div className="formGrid">
        <Field label="Recipient name">
          <input value={f.address.name} onChange={setA('name')} />
        </Field>
        <Field label="Recipient mobile">
          <input value={f.address.phone} onChange={setA('phone')} inputMode="tel" />
        </Field>
        <Field label="House no., building, street">
          <input value={f.address.line1} onChange={setA('line1')} />
        </Field>
        <Field label="Area, landmark">
          <input value={f.address.line2} onChange={setA('line2')} />
        </Field>
        <Field label="City">
          <input value={f.address.city} onChange={setA('city')} />
        </Field>
        <Field label="State">
          <input value={f.address.state} onChange={setA('state')} />
        </Field>
        <Field label="PIN code">
          <input value={f.address.pincode} onChange={setA('pincode')} inputMode="numeric" maxLength={6} />
        </Field>
      </div>
      {err && <div className="note bad">{err}</div>}
      <div>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function AccountSecurity() {
  const { token, setToken, toast } = useApp();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!passwordOk(f.newPassword)) return setErr('New password needs at least 8 characters with a letter and a number.');
    if (f.newPassword !== f.confirm) return setErr('The two new passwords do not match.');
    setBusy(true);
    try {
      const d = await api('/auth/change-password', { method: 'POST', token, body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
      setToken(d.token);
      setF({ currentPassword: '', newPassword: '', confirm: '' });
      toast('Password changed.');
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };
  return (
    <form className="card pad stack narrowForm" onSubmit={submit}>
      <h3>Change password</h3>
      <Field label="Current password">
        <input type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} autoComplete="current-password" required />
      </Field>
      <Field label="New password" hint="At least 8 characters, with a letter and a number.">
        <input type="password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password">
        <input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
      </Field>
      {err && <div className="note bad">{err}</div>}
      <div>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </div>
    </form>
  );
}

function AccountHelp({ prefillOrder }) {
  const { token, toast, config } = useApp();
  const [f, setF] = useState({ subject: prefillOrder ? `Help with order ${prefillOrder}` : '', message: '', orderNumber: prefillOrder || '' });
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/orders/my', { token })
      .then(setOrders)
      .catch(() => {});
  }, [token]);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await api('/support', { method: 'POST', token, body: f });
      toast(d.message);
      setF({ subject: '', message: '', orderNumber: '' });
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };
  return (
    <form className="card pad stack" onSubmit={submit}>
      <h3>Help and support</h3>
      <p className="muted">Tell us what went wrong and our care team will reply by email. We usually answer within one working day.</p>
      <Field label="Which order is this about? (optional)">
        <select value={f.orderNumber} onChange={(e) => setF({ ...f, orderNumber: e.target.value })}>
          <option value="">Not about a specific order</option>
          {orders.map((o) => (
            <option key={o._id} value={o.orderNumber}>
              {o.orderNumber} · {fmtDate(o.createdAt)} · {STATUS_LABEL[o.status]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Subject">
        <input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required maxLength={120} />
      </Field>
      <Field label="Message">
        <textarea rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required minLength={10} maxLength={3000} />
      </Field>
      {err && <div className="note bad">{err}</div>}
      <div className="btnRow">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send to care team'}
        </button>
        {config.company.phone && <span className="muted small">Or call {config.company.phone}</span>}
      </div>
    </form>
  );
}

function Account({ tab, query }) {
  const { user, logout } = useApp();
  const t = ['orders', 'details', 'help', 'security'].includes(tab) ? tab : 'orders';
  const tabs = [
    ['orders', 'My orders'],
    ['details', 'Account details'],
    ['help', 'Help and support'],
    ['security', 'Password'],
  ];
  return (
    <main className="wrap section">
      <h1>Hello, {user.name.split(' ')[0]}</h1>
      <div className="accountLayout">
        <nav className="sideNav" aria-label="Account">
          {tabs.map(([k, label]) => (
            <Link key={k} to={`/account/${k}`} className={t === k ? 'active' : ''}>
              {label}
            </Link>
          ))}
          {user.role === 'admin' && <Link to="/admin">Admin panel</Link>}
          <button onClick={logout}>Sign out</button>
        </nav>
        <div>
          {t === 'orders' && <AccountOrders />}
          {t === 'details' && <AccountDetails />}
          {t === 'help' && <AccountHelp prefillOrder={query.get('order') || ''} />}
          {t === 'security' && <AccountSecurity />}
        </div>
      </div>
    </main>
  );
}

/* ================================================================== */
/* Admin                                                               */
/* ================================================================== */
function SalesChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const W = 700;
  const H = 210;
  const bw = W / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Revenue for the last 14 days">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1="0" x2={W} y1={170 - 150 * g} y2={170 - 150 * g} className="gridLine" />
      ))}
      {data.map((d, i) => {
        const h = (d.revenue / max) * 150;
        return (
          <g key={d.date}>
            <rect x={i * bw + 8} y={170 - h} width={bw - 16} height={Math.max(h, d.revenue ? 3 : 0)} rx="5" className="bar">
              <title>{`${d.date}: ${inr(d.revenue)} from ${d.orders} order(s)`}</title>
            </rect>
            {d.revenue > 0 && (
              <text x={i * bw + bw / 2} y={164 - h} textAnchor="middle" className="barVal">
                {d.revenue >= 1000 ? (d.revenue / 1000).toFixed(1) + 'k' : d.revenue}
              </text>
            )}
            <text x={i * bw + bw / 2} y="192" textAnchor="middle" className="barLbl">
              {d.date.slice(8)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function AdminDashboard() {
  const { token } = useApp();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    api('/admin/dashboard', { token })
      .then(setD)
      .catch((e) => setErr(e.message));
  }, [token]);
  useEffect(load, [load]);
  if (err) return <div className="note bad">{err}</div>;
  if (!d) return <Spinner />;
  const t = d.totals;
  const stat = (label, value, sub, tone) => (
    <div className={`stat ${tone || ''}`} key={label}>
      <small>{label}</small>
      <b>{value}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
  const maxStatus = Math.max(1, ...Object.values(d.statusCounts));
  return (
    <div className="stack">
      <div className="btnRow spread">
        <h3>Sales and operations</h3>
        <button className="btn small ghost" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="statGrid">
        {stat('Revenue (excl. cancelled)', inr(t.revenue), `${inr(t.collected)} collected on delivery`)}
        {stat('Total orders', t.orders, `Avg order ${inr(t.avgOrderValue)}`)}
        {stat('Active orders', d.active, 'Placed to out for delivery')}
        {stat('Pending', d.statusCounts.pending, 'Need confirmation', d.statusCounts.pending ? 'warn' : '')}
        {stat('Delivered', d.statusCounts.delivered)}
        {stat('Cancelled', d.statusCounts.cancelled)}
        {stat('Customers', t.customers)}
        {stat('Stock on hand', d.inventory.units, `${inr(d.inventory.value)} at retail`)}
      </div>
      <div className="adminCols">
        <section className="card pad">
          <h3>Revenue, last 14 days</h3>
          <SalesChart data={d.salesByDay} />
        </section>
        <section className="card pad">
          <h3>Orders by status</h3>
          {Object.entries(d.statusCounts).map(([s, n]) => (
            <div className="hbar" key={s}>
              <span>{STATUS_LABEL[s]}</span>
              <div>
                <i className={`s-${s}`} style={{ width: `${(n / maxStatus) * 100}%` }} />
              </div>
              <b>{n}</b>
            </div>
          ))}
        </section>
      </div>
      <div className="adminCols">
        <section className="card pad">
          <h3>Top selling products</h3>
          {d.topProducts.length ? (
            d.topProducts.map((p) => (
              <div className="row" key={p.name}>
                <span>{p.name}</span>
                <span>
                  <b>{p.units}</b> sold · {inr(p.revenue)}
                </span>
              </div>
            ))
          ) : (
            <p className="muted">No sales yet.</p>
          )}
        </section>
        <section className="card pad">
          <h3>Inventory alerts</h3>
          <p className="muted small">
            {d.inventory.outOfStock} sold out · {d.inventory.lowStock} low (10 or fewer) · {d.inventory.active}/{d.inventory.products} listings live
          </p>
          {d.lowStock.length ? (
            d.lowStock.map((p) => (
              <div className="row" key={p._id}>
                <span>
                  {p.name} <small className="muted">{p.size}</small>
                </span>
                <b className={p.stock === 0 ? 'bad' : 'warnText'}>{p.stock === 0 ? 'Sold out' : `${p.stock} left`}</b>
              </div>
            ))
          ) : (
            <p className="muted">Everything is well stocked.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function AdminOrders() {
  const { token, toast, confirm } = useApp();
  const [orders, setOrders] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());
    api(`/admin/orders?${params}`, { token })
      .then((d) => {
        setOrders(d);
        setErr('');
      })
      .catch((e) => setErr(e.message));
  }, [token, status, q]);
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const update = async (o, next) => {
    if (next === 'cancelled') {
      const ok = await confirm({
        title: `Cancel ${o.orderNumber}?`,
        message: 'The customer is emailed and the stock is returned to inventory.',
        confirmText: 'Cancel order',
        cancelText: 'Keep order',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api(`/admin/orders/${o._id}`, { method: 'PATCH', token, body: { status: next } });
      toast(`${o.orderNumber} is now ${STATUS_LABEL[next].toLowerCase()}.`);
      load();
    } catch (e) {
      toast(e.message, 'bad');
      load();
    }
  };
  const resend = async (o) => {
    try {
      const r = await api(`/admin/orders/${o._id}/resend-emails`, { method: 'POST', token });
      toast(r.customer && r.company ? 'Emails sent to the customer and the company.' : `Email problem: customer ${r.customer ? 'sent' : 'failed'}, company ${r.company ? 'sent' : 'failed'}. Check the server logs.`, r.customer && r.company ? 'ok' : 'bad');
      load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const nextOptions = (s) => {
    if (['delivered', 'cancelled'].includes(s)) return [];
    return FLOW.slice(FLOW.indexOf(s) + 1);
  };
  const filters = [['', 'All'], ...Object.entries(STATUS_LABEL)];
  return (
    <div className="stack">
      <div className="toolbar">
        <div className="chips">
          {filters.map(([k, label]) => (
            <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>
              {label}
            </button>
          ))}
        </div>
        <input className="miniSearch" placeholder="Search order no., name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
      </div>
      {err && <div className="note bad">{err}</div>}
      {!orders ? (
        <Spinner />
      ) : !orders.length ? (
        <div className="empty">
          <p>No orders match these filters.</p>
        </div>
      ) : (
        orders.map((o) => (
          <article className="card pad adminOrder" key={o._id}>
            <div className="aoTop">
              <div>
                <b>{o.orderNumber}</b>
                <p className="muted small">
                  {fmtDateTime(o.createdAt)} · {o.customer?.name || o.shippingAddress?.name} ({o.customer?.email || 'deleted user'})
                </p>
              </div>
              <div className="aoRight">
                <b>{inr(o.total)}</b>
                <StatusPill status={o.status} />
              </div>
            </div>
            <div className="btnRow">
              {nextOptions(o.status).length > 0 && (
                <label className="inlineSel">
                  Move to
                  <select value="" onChange={(e) => e.target.value && update(o, e.target.value)}>
                    <option value="">Choose status</option>
                    {nextOptions(o.status).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!['delivered', 'cancelled'].includes(o.status) && (
                <button className="btn small danger" onClick={() => update(o, 'cancelled')}>
                  Cancel order
                </button>
              )}
              <button className="btn small ghost" onClick={() => resend(o)} title="Send the confirmation emails again">
                Resend emails
              </button>
              <button className="btn small ghost" onClick={() => setOpen(open === o._id ? '' : o._id)} aria-expanded={open === o._id}>
                {open === o._id ? 'Hide details' : 'View details'}
              </button>
            </div>
            {open === o._id && (
              <div className="aoDetail">
                <div>
                  <h4>Items</h4>
                  {o.items.map((i, n) => (
                    <div className="row" key={n}>
                      <span>
                        {i.name} ({i.size}) × {i.qty}
                      </span>
                      <b>{inr(i.price * i.qty)}</b>
                    </div>
                  ))}
                  <div className="row">
                    <span>Delivery</span>
                    <b>{o.shipping ? inr(o.shipping) : 'Free'}</b>
                  </div>
                  <p className="muted small">
                    {o.paymentMethod} · payment {o.paymentStatus} · delivery: {DELIVERY_LABEL[o.status]}
                  </p>
                  <p className={`small ${o.emails?.customer === 'failed' || o.emails?.company === 'failed' ? 'bad' : 'muted'}`}>
                    Emails: customer {o.emails?.customer || 'pending'}, company {o.emails?.company || 'pending'}
                  </p>
                </div>
                <div>
                  <h4>Ship to</h4>
                  <p className="small">
                    {o.shippingAddress?.name}, {o.shippingAddress?.phone}
                    <br />
                    {o.shippingAddress?.line1} {o.shippingAddress?.line2}
                    <br />
                    {o.shippingAddress?.city}, {o.shippingAddress?.state} {o.shippingAddress?.pincode}
                  </p>
                  <h4>History</h4>
                  {o.history?.map((h, n) => (
                    <p className="small" key={n}>
                      {fmtDateTime(h.at)}: {STATUS_LABEL[h.status] || h.status}
                      {h.note && h.note !== STATUS_LABEL[h.status] ? ` (${h.note})` : ''}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}

const EMPTY_PRODUCT = { name: '', category: '', size: '', price: '', mrp: '', stock: '', badge: '', shortDescription: '', details: '', uses: '', image: '', active: true };

function ProductForm({ product, categories, onClose, onSaved }) {
  const { token, toast } = useApp();
  const [f, setF] = useState(() => (product ? { ...EMPTY_PRODUCT, ...product, mrp: product.mrp || '' } : EMPTY_PRODUCT));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (e) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(picked.type)) return setErr('Choose a JPG, PNG or WebP image.');
    if (picked.size > 5 * 1024 * 1024) return setErr('Image must be smaller than 5 MB.');
    setErr('');
    setFile(picked);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const form = new FormData();
      ['name', 'category', 'size', 'price', 'mrp', 'stock', 'badge', 'shortDescription', 'details', 'uses'].forEach((k) => form.append(k, f[k] ?? ''));
      form.append('active', String(!!f.active));
      if (file) form.append('image', file);
      else form.append('image', f.image || '');
      const saved = await api(product ? `/admin/products/${product._id}` : '/admin/products', {
        method: product ? 'PUT' : 'POST',
        token,
        form,
      });
      toast(product ? 'Listing updated.' : 'Listing published.');
      onSaved(saved);
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };

  const shownImage = preview || f.image;
  return (
    <Modal title={product ? 'Edit product' : 'Add product'} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <h2>{product ? 'Edit listing' : 'New product listing'}</h2>
        <div className="formGrid">
          <Field label="Product name">
            <input value={f.name} onChange={set('name')} required maxLength={120} />
          </Field>
          <Field label="Category">
            <input value={f.category} onChange={set('category')} required list="catList" maxLength={60} />
            <datalist id="catList">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Pack size (e.g. 1 L)">
            <input value={f.size} onChange={set('size')} maxLength={40} />
          </Field>
          <Field label="Badge (optional)">
            <input value={f.badge} onChange={set('badge')} maxLength={24} placeholder="Bestseller" />
          </Field>
          <Field label="Selling price (₹)">
            <input type="number" min="1" step="1" value={f.price} onChange={set('price')} required />
          </Field>
          <Field label="MRP (₹, optional)" hint="Shown struck through when higher than the price.">
            <input type="number" min="0" step="1" value={f.mrp} onChange={set('mrp')} />
          </Field>
          <Field label="Stock (units)">
            <input type="number" min="0" step="1" value={f.stock} onChange={set('stock')} required />
          </Field>
          <label className="check pushDown">
            <input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Visible in the shop
          </label>
        </div>
        <Field label="One-line summary">
          <input value={f.shortDescription} onChange={set('shortDescription')} maxLength={200} />
        </Field>
        <Field label="Product details">
          <textarea rows={3} value={f.details} onChange={set('details')} maxLength={2000} />
        </Field>
        <Field label="Uses and directions">
          <textarea rows={3} value={f.uses} onChange={set('uses')} maxLength={1000} />
        </Field>
        <div className="imgPick">
          <div className="imgPreview">{shownImage ? <img src={shownImage} alt="Preview" referrerPolicy="no-referrer" /> : <span className="muted small">No image</span>}</div>
          <div className="stack">
            <Field label="Upload image (JPG, PNG, WebP, max 5 MB)" hint="Stored on Cloudflare R2.">
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} />
            </Field>
            <Field label="Or paste an image URL">
              <input
                value={f.image}
                onChange={(e) => {
                  setFile(null);
                  setPreview('');
                  setF({ ...f, image: e.target.value });
                }}
                placeholder="https://…"
              />
            </Field>
          </div>
        </div>
        {err && (
          <div className="note bad" role="alert">
            {err}
          </div>
        )}
        <div className="btnRow">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : product ? 'Save changes' : 'Publish product'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StockEditor({ p, onSaved }) {
  const { token, toast } = useApp();
  const [v, setV] = useState(String(p.stock));
  useEffect(() => setV(String(p.stock)), [p.stock]);
  const dirty = v !== String(p.stock);
  const save = async () => {
    try {
      const form = new FormData();
      form.append('stock', v);
      onSaved(await api(`/admin/products/${p._id}`, { method: 'PUT', token, form }));
      toast('Stock updated.');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  return (
    <span className="stockEd">
      <input type="number" min="0" value={v} onChange={(e) => setV(e.target.value)} aria-label={`Stock for ${p.name}`} className={p.stock <= 10 ? 'lowIn' : ''} />
      {dirty && (
        <button className="btn small primary" onClick={save}>
          Save
        </button>
      )}
    </span>
  );
}

function AdminProducts() {
  const { token, toast, confirm, refreshProducts } = useApp();
  const [items, setItems] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api('/admin/products', { token })
      .then(setItems)
      .catch((e) => setErr(e.message));
  }, [token]);
  useEffect(load, [load]);
  const categories = [...new Set([...DEFAULT_CATEGORIES, ...(items || []).map((p) => p.category)])];

  const replace = (saved) => {
    setItems((list) => list.map((x) => (x._id === saved._id ? saved : x)));
    refreshProducts();
  };
  const toggle = async (p) => {
    try {
      const form = new FormData();
      form.append('active', String(!p.active));
      replace(await api(`/admin/products/${p._id}`, { method: 'PUT', token, form }));
      toast(p.active ? 'Listing hidden from the shop.' : 'Listing is live.');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const remove = async (p) => {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      message: 'The listing and its image are removed for good. Past orders keep their own copy of the item details.',
      confirmText: 'Delete listing',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/admin/products/${p._id}`, { method: 'DELETE', token });
      setItems((list) => list.filter((x) => x._id !== p._id));
      refreshProducts();
      toast('Listing deleted.');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!items) return <Spinner />;
  return (
    <div className="stack">
      <div className="btnRow spread">
        <h3>{items.length} listings</h3>
        <button className="btn primary" onClick={() => setEdit({})}>
          Add product
        </button>
      </div>
      <div className="card tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Sold</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p._id}>
                <td>
                  <div className="cellProd">
                    <span className="thumb">
                      <ProductImage product={p} />
                    </span>
                    <span>
                      <b>{p.name}</b>
                      <small className="muted">
                        {p.category} · {p.size}
                      </small>
                    </span>
                  </div>
                </td>
                <td>{inr(p.price)}</td>
                <td>
                  <StockEditor p={p} onSaved={replace} />
                </td>
                <td>{p.sold || 0}</td>
                <td>
                  <button className={`pill toggle ${p.active ? 's-delivered' : 's-cancelled'}`} onClick={() => toggle(p)} title="Click to change">
                    {p.active ? 'Live' : 'Hidden'}
                  </button>
                </td>
                <td className="actions">
                  <button className="btn small ghost" onClick={() => setEdit(p)}>
                    Edit
                  </button>
                  <button className="btn small danger" onClick={() => remove(p)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <ProductForm
          product={edit._id ? edit : null}
          categories={categories}
          onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null);
            load();
            refreshProducts();
            return saved;
          }}
        />
      )}
    </div>
  );
}

function Admin() {
  const [tab, setTab] = useState('dashboard');
  const tabs = [
    ['dashboard', 'Dashboard'],
    ['orders', 'Orders'],
    ['products', 'Products and inventory'],
  ];
  return (
    <main className="wrap section">
      <h1>Admin</h1>
      <div className="chips tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'dashboard' && <AdminDashboard />}
      {tab === 'orders' && <AdminOrders />}
      {tab === 'products' && <AdminProducts />}
    </main>
  );
}

/* ================================================================== */
/* Static pages                                                        */
/* ================================================================== */
function About() {
  return (
    <main className="wrap section narrow">
      <h1>We started with a stubborn bathroom floor</h1>
      <p className="lead">
        CLEANXO began when a family-run chemicals workshop in Bengaluru got tired of cleaners that smelled loud and still left the tiles dull. We rebuilt the formulas around Indian water and Indian kitchens, and kept the range small and honest.
      </p>
      <p>
        Today we make floor, bathroom, toilet, kitchen, laundry and personal care essentials. Each batch is tested for cleaning power, rinse-off and shelf life before it is bottled, and we sell directly so you pay for the product, not the middlemen.
      </p>
      <div className="threeUp">
        <div className="card pad">
          <h3>Tested at home</h3>
          <p>Every formula runs through weeks of trials in real homes before launch.</p>
        </div>
        <div className="card pad">
          <h3>Gentle by design</h3>
          <p>Light fragrance and skin-friendly hand care, so cleaning day is less of a chore.</p>
        </div>
        <div className="card pad">
          <h3>Direct to you</h3>
          <p>No retail markups. Tracked delivery, cash on delivery and easy replacements.</p>
        </div>
      </div>
      <Link to="/shop" className="btn primary big">
        Shop the range
      </Link>
    </main>
  );
}

function Contact() {
  const { config, toast } = useApp();
  const c = config.company;
  const [f, setF] = useState({ name: '', email: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await api('/contact', { method: 'POST', body: f });
      toast(d.message);
      setF({ name: '', email: '', message: '' });
    } catch (er) {
      setErr(er.message);
    }
    setBusy(false);
  };
  return (
    <main className="wrap section">
      <h1>Talk to us</h1>
      <div className="split even">
        <div className="stack">
          <p className="lead small">Questions about a product, a bulk order or a delivery? Write to us and a real person will reply.</p>
          <div className="card pad">
            <h3>{c.name}</h3>
            {c.address && <p>{c.address}</p>}
            {c.phone && (
              <p>
                <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a>
              </p>
            )}
            {c.email && (
              <p>
                <a href={`mailto:${c.email}`}>{c.email}</a>
              </p>
            )}
            {c.hours && <p className="muted">{c.hours}</p>}
          </div>
        </div>
        <form className="card pad stack" onSubmit={submit}>
          <Field label="Your name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </Field>
          <Field label="Email">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </Field>
          <Field label="Message">
            <textarea rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required minLength={10} maxLength={2000} />
          </Field>
          {err && <div className="note bad">{err}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send message'}
          </button>
        </form>
      </div>
    </main>
  );
}

function Policy({ slug }) {
  const { config } = useApp();
  const pages = {
    shipping: [
      'Shipping and returns',
      [
        `Orders above ${inr(config.freeShippingMin)} ship free. Below that, delivery costs ${inr(config.shippingFee)}.`,
        'Most orders arrive in 2 to 5 working days. You can follow each step from My orders.',
        'Payment is cash on delivery. Please keep the amount ready when the parcel arrives.',
        'If an item arrives damaged or leaking, write to us from Help and support within 48 hours with your order number and a photo, and we will send a replacement.',
        'You can cancel from My orders until the order has shipped. After that, contact support.',
      ],
    ],
    privacy: [
      'Privacy policy',
      [
        'We collect only what we need to run your account and deliver your orders: your name, email, phone number and delivery address.',
        'Passwords are stored as one-way hashes. We never see or store them in plain text.',
        'We use your email for verification codes, order updates and support replies. We do not sell your data.',
        'Your delivery details are shared only with the delivery partner for your order.',
        `To ask for your data to be corrected or deleted, write to ${config.company.email || 'our care team'}.`,
      ],
    ],
  };
  const page = pages[slug];
  if (!page) return <NotFound />;
  return (
    <main className="wrap section narrow">
      <h1>{page[0]}</h1>
      {page[1].map((t) => (
        <p key={t}>{t}</p>
      ))}
    </main>
  );
}

function NotFound() {
  return (
    <main className="wrap section empty">
      <h1>That page is not here</h1>
      <p>The link may be old or mistyped.</p>
      <Link to="/" className="btn primary">
        Back to home
      </Link>
    </main>
  );
}

/* ================================================================== */
/* Auth gate                                                           */
/* ================================================================== */
function RequireAuth({ admin, children }) {
  const { user, authReady, openAuth } = useApp();
  useEffect(() => {
    if (authReady && !user) openAuth('login');
  }, [authReady, user, openAuth]);
  if (!authReady) return <Spinner label="Checking your session…" />;
  if (!user)
    return (
      <main className="wrap section empty">
        <h1>Please sign in</h1>
        <p>You need an account to view this page.</p>
        <button className="btn primary" onClick={() => openAuth('login')}>
          Sign in
        </button>
      </main>
    );
  if (admin && user.role !== 'admin')
    return (
      <main className="wrap section empty">
        <h1>Admins only</h1>
        <p>Your account does not have access to this area.</p>
        <Link to="/" className="btn primary">
          Back to home
        </Link>
      </main>
    );
  return children;
}

/* ================================================================== */
/* App shell                                                           */
/* ================================================================== */
export default function App() {
  const route = useRoute();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [token, setTokenState] = useState(() => store.get(LS.token, ''));
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(() => !store.get(LS.token, ''));
  const [cart, setCart] = useState(() => {
    const c = store.get(LS.cart, []);
    return Array.isArray(c) ? c.filter((x) => x && typeof x.id === 'string' && Number.isInteger(x.qty) && x.qty > 0) : [];
  });
  const [toasts, setToasts] = useState([]);
  const [authModal, setAuthModal] = useState(null);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const afterLogin = useRef(null);

  const toast = useCallback((msg, type = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setDialog({ ...opts, resolve });
      }),
    [],
  );

  const setToken = useCallback((t) => {
    if (t) store.set(LS.token, t);
    else store.del(LS.token);
    setTokenState(t || '');
  }, []);

  const logout = useCallback(() => {
    setToken('');
    setUser(null);
    setAuthReady(true);
    go('/');
    toast('You are signed out.');
  }, [setToken, toast]);

  const refreshProducts = useCallback(() => {
    return api('/products')
      .then((list) => {
        setProducts(list);
        setProductsError('');
      })
      .catch((e) => setProductsError(e.message))
      .finally(() => setProductsLoading(false));
  }, []);

  useEffect(() => {
    api('/config')
      .then(setConfig)
      .catch(() => {});
    refreshProducts();
  }, [refreshProducts]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setAuthReady(true);
      return;
    }
    let live = true;
    api('/auth/me', { token })
      .then((d) => live && setUser(d.user))
      .catch((e) => {
        if (!live) return;
        if (e.status === 401) {
          setToken('');
          setUser(null);
        }
      })
      .finally(() => live && setAuthReady(true));
    return () => {
      live = false;
    };
  }, [token, setToken]);

  useEffect(() => {
    if (!productsLoading) {
      setSlowLoad(false);
      return undefined;
    }
    const t = setTimeout(() => setSlowLoad(true), 5000);
    return () => clearTimeout(t);
  }, [productsLoading]);

  useEffect(() => store.set(LS.cart, cart), [cart]);
  useEffect(() => setMenu(false), [route]);

  const loginDone = useCallback(
    (data, isNew) => {
      setToken(data.token);
      setUser(data.user);
      setAuthReady(true);
      setAuthModal(null);
      toast(isNew ? `Welcome to CLEANXO, ${data.user.name.split(' ')[0]}.` : `Welcome back, ${data.user.name.split(' ')[0]}.`);
      if (afterLogin.current) {
        go(afterLogin.current);
        afterLogin.current = null;
      }
    },
    [setToken, toast],
  );

  const openAuth = useCallback((mode = 'login', next = null) => {
    afterLogin.current = next;
    setAuthModal(mode);
  }, []);

  /* ----- cart ----- */
  const lines = useMemo(
    () =>
      cart
        .map((c) => {
          const p = products.find((x) => x._id === c.id);
          if (!p) return null;
          const cap = Math.max(1, Math.min(p.stock, config.maxQty));
          return { ...p, qty: Math.min(c.qty, cap), unavailable: p.stock < 1 };
        })
        .filter(Boolean),
    [cart, products, config.maxQty],
  );
  const subtotal = lines.filter((l) => !l.unavailable).reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = subtotal === 0 || subtotal >= config.freeShippingMin ? 0 : config.shippingFee;
  const total = subtotal + shipping;
  const cartCount = lines.reduce((n, l) => n + (l.unavailable ? 0 : l.qty), 0);

  const addToCart = useCallback(
    (p, qty = 1, silent = false) => {
      const cap = Math.min(p.stock, config.maxQty);
      if (cap < 1) return toast(`${p.name} is sold out.`, 'bad');
      setCart((c) => {
        const found = c.find((x) => x.id === p._id);
        if (found) return c.map((x) => (x.id === p._id ? { ...x, qty: Math.min(cap, x.qty + qty) } : x));
        return [...c, { id: p._id, qty: Math.min(cap, qty) }];
      });
      if (!silent) toast(`${p.name} added to your bag.`);
      return undefined;
    },
    [config.maxQty, toast],
  );
  const setQty = useCallback(
    (id, qty) => {
      if (qty < 1) return setCart((c) => c.filter((x) => x.id !== id));
      return setCart((c) => c.map((x) => (x.id === id ? { ...x, qty } : x)));
    },
    [],
  );
  const removeLine = useCallback((id) => setCart((c) => c.filter((x) => x.id !== id)), []);
  const clearCart = useCallback(() => setCart([]), []);

  const ctx = {
    config, products, productsLoading, productsError, refreshProducts,
    token, setToken, user, setUser, authReady, loginDone, logout, openAuth,
    lines, subtotal, shipping, total, cartCount, addToCart, setQty, removeLine, clearCart,
    toast, confirm, menu, setMenu, route,
  };

  /* ----- routing ----- */
  const [page, arg] = route.parts;
  let view;
  switch (page) {
    case undefined:
      view = <Home />;
      break;
    case 'shop':
      view = <Shop />;
      break;
    case 'product':
      view = <ProductPage id={arg} />;
      break;
    case 'cart':
      view = <CartPage />;
      break;
    case 'checkout':
      view = (
        <RequireAuth>
          <Checkout />
        </RequireAuth>
      );
      break;
    case 'order':
      view = (
        <RequireAuth>
          <OrderPage id={arg} placed={route.query.get('placed') === '1'} />
        </RequireAuth>
      );
      break;
    case 'account':
      view = (
        <RequireAuth>
          <Account tab={arg} query={route.query} />
        </RequireAuth>
      );
      break;
    case 'admin':
      view = (
        <RequireAuth admin>
          <Admin />
        </RequireAuth>
      );
      break;
    case 'about':
      view = <About />;
      break;
    case 'contact':
      view = <Contact />;
      break;
    case 'policy':
      view = <Policy slug={arg} />;
      break;
    default:
      view = <NotFound />;
  }

  return (
    <AppCtx.Provider value={ctx}>
      <style>{CSS}</style>
      <a href="#main" className="skip" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <Header />
      {slowLoad && <div className="wake" role="status">Our server is waking up after a quiet spell. This can take up to a minute, thanks for waiting.</div>}
      <div id="main" tabIndex={-1}>{view}</div>
      <Footer />

      {authModal && <AuthModal initialMode={authModal} onClose={() => { afterLogin.current = null; setAuthModal(null); }} />}

      {dialog && (
        <Modal title={dialog.title} onClose={() => { dialog.resolve(false); setDialog(null); }}>
          <div className="stack">
            <h2>{dialog.title}</h2>
            <p>{dialog.message}</p>
            <div className="btnRow">
              <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} onClick={() => { dialog.resolve(true); setDialog(null); }}>
                {dialog.confirmText || 'Confirm'}
              </button>
              <button className="btn ghost" onClick={() => { dialog.resolve(false); setDialog(null); }}>
                {dialog.cancelText || 'Cancel'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
            {t.msg}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

/* ================================================================== */
/* Styles                                                              */
/* ================================================================== */
const CSS = `
:root{
  --ink:#0a2a33; --muted:#52707a; --line:#d9e8e8; --bg:#f6fbfa; --card:#ffffff;
  --lagoon:#0e7c86; --lagoon-d:#0a5f68; --foam:#e3f4f3; --lemon:#f2c94c; --lemon-d:#d9a521;
  --danger:#c0392b; --warn:#b7791f; --ok:#1f8a5b;
  --display:'Bricolage Grotesque',system-ui,sans-serif; --body:'Figtree',system-ui,sans-serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--display);line-height:1.12;margin:0 0 .5em;letter-spacing:-.02em}
h1{font-size:clamp(2rem,4.6vw,3.2rem);font-weight:800}
h2{font-size:clamp(1.5rem,3vw,2.2rem);font-weight:700}
h3{font-size:1.15rem;font-weight:700}
h4{font-size:1rem}
p{margin:0 0 .9em}
a{color:inherit}
img{max-width:100%}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:3px solid var(--lemon-d);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--ink);color:#fff;padding:8px 14px;border-radius:8px;z-index:100}
.skip:focus{left:8px}
.muted{color:var(--muted)} .small{font-size:.88rem} .bad{color:var(--danger)} .warnText{color:var(--warn)}
.wrap{max-width:1200px;margin:0 auto;padding-left:24px;padding-right:24px}
.section{padding-top:56px;padding-bottom:56px}
.narrow{max-width:820px}
.stack{display:flex;flex-direction:column;gap:18px}
.center{display:flex;gap:12px;align-items:center;justify-content:center;padding:80px 0;color:var(--muted)}
.spinner{width:22px;height:22px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--lagoon);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* buttons + fields */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:2px solid transparent;border-radius:999px;padding:11px 22px;font-weight:700;text-decoration:none;transition:background .15s,transform .15s,border-color .15s;line-height:1.2}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn.small{padding:7px 14px;font-size:.85rem}
.btn.big{padding:14px 28px;font-size:1.02rem}
.btn.full{width:100%}
.btn.primary{background:var(--lagoon);color:#fff}
.btn.primary:hover:not(:disabled){background:var(--lagoon-d)}
.btn.dark{background:var(--ink);color:#fff}
.btn.dark:hover:not(:disabled){background:#12414f}
.btn.ghost{background:transparent;border-color:var(--ink);color:var(--ink)}
.btn.ghost:hover:not(:disabled){background:var(--ink);color:#fff}
.btn.danger{background:#fff;border-color:var(--danger);color:var(--danger)}
.btn.danger:hover:not(:disabled){background:var(--danger);color:#fff}
.btnRow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btnRow.spread{justify-content:space-between}
.linkBtn{background:none;border:0;padding:4px 0;color:var(--lagoon-d);font-weight:600;text-decoration:underline;text-align:left}
.linkBtn:disabled{color:var(--muted);text-decoration:none;cursor:default}
.textLink{color:var(--lagoon-d);font-weight:700}
.iconBtn{background:none;border:0;width:40px;height:40px;border-radius:50%;font-size:1.6rem;line-height:1;display:grid;place-items:center}
.iconBtn:hover{background:var(--foam)}
.field{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:.9rem}
.field small{font-weight:400;color:var(--muted)}
input,select,textarea{width:100%;border:1.5px solid var(--line);background:#fff;border-radius:12px;padding:11px 13px;font-size:.97rem}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--lagoon);box-shadow:0 0 0 3px #0e7c8626}
input:disabled{background:#f1f6f6;color:var(--muted)}
input[type=checkbox],input[type=radio]{width:auto;accent-color:var(--lagoon)}
textarea{resize:vertical}
.check{display:flex;gap:8px;align-items:center;font-size:.9rem;font-weight:500}
.pushDown{align-self:end;padding-bottom:12px}
.formGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px}
.card.pad,.pad{padding:22px}
.note{padding:11px 14px;border-radius:12px;font-size:.92rem}
.note.ok{background:var(--foam);color:#0a5f68}
.note.bad{background:#fdecea;color:#8f2b20}
.empty{text-align:center;padding:56px 20px;display:flex;flex-direction:column;align-items:center;gap:6px}
.crumbs{font-size:.88rem;color:var(--muted);margin-bottom:20px}
.crumbs a{color:var(--lagoon-d)}

/* header */
.announce{background:var(--ink);color:#d3ecee;text-align:center;font-size:.85rem;padding:8px 12px}
.header{position:sticky;top:0;z-index:30;background:#f6fbfaee;backdrop-filter:blur(12px);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:28px;padding:0 24px;height:72px}
.brand{font-family:var(--display);font-weight:800;font-size:1.65rem;letter-spacing:-.05em;text-decoration:none;background:none;border:0;padding:0}
.brand span{color:var(--lagoon)}
.brand.light{color:#fff;display:block;margin-bottom:12px}
.brand.light span{color:var(--lemon)}
.nav{display:flex;gap:6px;margin-right:auto}
.nav a{text-decoration:none;font-weight:600;padding:8px 14px;border-radius:999px}
.nav a:hover{background:var(--foam)}
.nav a.active{background:var(--ink);color:#fff}
.menuBtn,.searchMobile{display:none}
.headerRight{display:flex;align-items:center;gap:8px;margin-left:auto}
.search{display:flex;align-items:center;background:#fff;border:1.5px solid var(--line);border-radius:999px;padding:0 6px 0 4px}
.search:focus-within{border-color:var(--lagoon)}
.search button{background:none;border:0;display:grid;place-items:center;width:34px;height:36px}
.search input{border:0;box-shadow:none!important;padding:8px 10px 8px 2px;width:150px;background:transparent}
.hBtn{position:relative;display:flex;align-items:center;gap:7px;background:none;border:0;padding:8px 12px;border-radius:999px;font-weight:600;text-decoration:none}
.hBtn:hover{background:var(--foam)}
.hBtn svg{width:22px;height:22px}
.badge{position:absolute;top:0;right:2px;background:var(--lemon);color:var(--ink);font-size:.72rem;min-width:19px;height:19px;border-radius:999px;display:grid;place-items:center;padding:0 5px}

/* hero */
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;max-width:1280px;margin:0 auto;padding:40px 24px 0;align-items:center}
.heroText{padding:30px 10px 50px}
.lead{font-size:1.15rem;color:var(--muted);max-width:540px}
.lead.small{font-size:1.02rem}
.heroCta{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0}
.heroFacts{list-style:none;padding:0;margin:30px 0 0;display:flex;flex-wrap:wrap;gap:10px 26px;font-size:.92rem;color:var(--muted)}
.heroFacts b{color:var(--ink)}
.heroArt{position:relative;min-height:470px;border-radius:44px 44px 0 0;background:linear-gradient(180deg,#bfe9e8 0%,#7fd0d0 100%);overflow:hidden}
.heroBottles{position:absolute;inset:auto 0 52px 0;display:flex;justify-content:center;align-items:flex-end;gap:10px;z-index:2}
.hb{filter:drop-shadow(0 14px 14px #0a2a3338)}
.hb.h1{width:23%;transform:rotate(-6deg)} .hb.h2{width:30%} .hb.h3{width:26%;transform:rotate(5deg)}
.bottleSvg{display:block;width:100%;height:auto}
.wave{position:absolute;left:-10%;right:-10%;bottom:-40px;height:140px;background:var(--bg);border-radius:50% 50% 0 0/100% 100% 0 0;z-index:3}
.bubble{position:absolute;border-radius:50%;background:radial-gradient(circle at 30% 28%,#fff 0 12%,#ffffff55 13% 60%,#ffffff22 100%);border:1.5px solid #ffffffaa;animation:rise 9s ease-in-out infinite}
.b1{width:70px;height:70px;left:10%;top:55%} .b2{width:34px;height:34px;left:78%;top:20%;animation-delay:-3s}
.b3{width:100px;height:100px;left:68%;top:52%;animation-delay:-5s} .b4{width:22px;height:22px;left:30%;top:18%;animation-delay:-1s}
.b5{width:48px;height:48px;left:46%;top:8%;animation-delay:-6s}
@keyframes rise{0%,100%{transform:translateY(0)}50%{transform:translateY(-26px)}}

/* sections */
.sectionHead{display:flex;justify-content:space-between;align-items:end;gap:12px;margin-bottom:24px}
.sectionHead h2{margin:0}
.catGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.catTile{display:flex;flex-direction:column;gap:2px;text-decoration:none;padding:18px;border-radius:20px;background:#fff;border:1px solid var(--line);transition:transform .15s,border-color .15s}
.catTile:hover{transform:translateY(-3px);border-color:var(--sw)}
.catDot{width:34px;height:34px;border-radius:50%;background:var(--sw);margin-bottom:12px;box-shadow:inset -6px -6px 0 #0000001f}
.catTile small{color:var(--muted)}
.band{background:var(--ink);color:#e5f4f5;padding:70px 0}
.band h2{color:#fff}
.bandGrid{display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:center}
.points{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:16px}
.points li{display:flex;flex-direction:column;border-left:4px solid var(--lemon);padding-left:16px}
.points span{color:#a9cfd3}
.quotes{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
.quote{margin:0;padding:24px}
.quote blockquote{margin:0 0 14px;font-size:1.02rem}
.quote figcaption{color:var(--muted);font-weight:600;font-size:.9rem}
.faq{border-bottom:1px solid var(--line);padding:16px 0}
.faq summary{font-weight:700;cursor:pointer}
.faq p{margin:10px 0 0;color:var(--muted)}
.threeUp{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}

/* products */
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.skeleton{height:360px;background:linear-gradient(100deg,#eef6f6 30%,#f8fcfc 50%,#eef6f6 70%);background-size:200% 100%;animation:shimmer 1.3s infinite}
@keyframes shimmer{to{background-position:-200% 0}}
.product{overflow:hidden;display:flex;flex-direction:column;transition:box-shadow .2s,transform .2s}
.product:hover{box-shadow:0 14px 30px #0a2a3318;transform:translateY(-2px)}
.pImage{position:relative;display:block;aspect-ratio:1/1;background:#eaf5f4;overflow:hidden}
.pImage img,.pImage .imgFallback{width:100%;height:100%;object-fit:cover;display:block}
.imgFallback{display:grid;place-items:center}
.imgFallback .bottleSvg{width:42%}
.tag{position:absolute;left:12px;top:12px;z-index:2;background:var(--lemon);color:var(--ink);font-weight:700;font-size:.76rem;padding:4px 10px;border-radius:999px}
.tag.soldout{background:var(--ink);color:#fff;left:auto;right:12px}
.pBody{padding:16px;display:flex;flex-direction:column;gap:2px;flex:1}
.pCat{color:var(--lagoon-d);font-weight:700;font-size:.8rem}
.pBody h3{margin:2px 0 0;font-size:1.02rem}
.pBody h3 a{text-decoration:none}
.pBody .muted{margin:0}
.pFoot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto;padding-top:12px}
.price{display:flex;gap:8px;align-items:baseline}
.price b{font-size:1.15rem}
.price s{color:var(--muted);font-size:.9rem}
.price.big b{font-size:2rem;font-family:var(--display)}
.save{background:var(--foam);color:var(--lagoon-d);font-weight:700;padding:2px 10px;border-radius:999px;font-size:.85rem}
.toolbar{display:flex;gap:14px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin:18px 0 24px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:#fff;border:1.5px solid var(--line);border-radius:999px;padding:7px 16px;font-weight:600;font-size:.9rem}
.chip:hover{border-color:var(--lagoon)}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff}
.sortBox{display:flex;align-items:center;gap:8px;font-size:.9rem;font-weight:600}
.sortBox select{width:auto}
.pdp{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:start}
.pdpImage{position:relative;aspect-ratio:1/1;overflow:hidden;background:#eaf5f4}
.pdpImage img,.pdpImage .imgFallback{width:100%;height:100%;object-fit:cover}
.pdpImage .imgFallback .bottleSvg{width:36%}
.stockLine{font-weight:700;margin:0 0 14px}
.stockLine.good{color:var(--ok)} .stockLine.warn{color:var(--warn)}
.buyRow{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:8px 0 26px}
.qty{display:inline-flex;align-items:center;border:1.5px solid var(--line);border-radius:999px;background:#fff}
.qty button{width:38px;height:40px;background:none;border:0;font-size:1.2rem;border-radius:999px}
.qty button:hover:not(:disabled){background:var(--foam)}
.qty button:disabled{opacity:.35}
.qty span{min-width:30px;text-align:center;font-weight:700}
.infoBlock{border-top:1px solid var(--line);padding-top:16px;margin-top:16px}

/* cart + checkout */
.split{display:grid;grid-template-columns:1fr 360px;gap:30px;align-items:start}
.split.even{grid-template-columns:1fr 1fr}
.summary{padding:22px;position:sticky;top:96px;display:flex;flex-direction:column;gap:6px}
.row{display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:.95rem}
.row.grand{font-size:1.15rem;font-weight:800;border-top:1px solid var(--line);margin-top:6px;padding-top:12px}
hr{border:0;border-top:1px solid var(--line);margin:8px 0;width:100%}
.line{display:grid;grid-template-columns:84px 1fr auto 90px 40px;gap:14px;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
.line.dim{opacity:.7}
.lineImg{width:84px;height:84px;border-radius:14px;overflow:hidden;background:#eaf5f4}
.lineImg img,.lineImg .imgFallback{width:100%;height:100%;object-fit:cover}
.lineImg .imgFallback .bottleSvg{width:50%}
.lineInfo{display:flex;flex-direction:column;gap:2px}
.lineInfo a{text-decoration:none}
.lineTotal{text-align:right}
.shipBar p{font-size:.88rem;margin:0 0 6px;color:var(--muted)}
.track{height:8px;border-radius:999px;background:var(--foam);overflow:hidden;margin-bottom:10px}
.track span{display:block;height:100%;background:var(--lemon-d);border-radius:999px;transition:width .3s}
.radioRow{display:flex;gap:12px;align-items:flex-start}

/* orders */
.success{background:var(--foam);border:1.5px solid var(--lagoon);border-radius:20px;padding:20px 24px;margin-bottom:28px}
.success h2{margin-bottom:6px}
.orderHead{display:flex;justify-content:space-between;align-items:start;gap:14px;flex-wrap:wrap}
.pill{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:700;font-size:.8rem;border:0;white-space:nowrap}
.s-pending{background:#fdf2d0;color:#7a5a0c} .s-confirmed{background:#dbeefa;color:#1b5a86}
.s-shipped{background:#e4e3fa;color:#4b3f9e} .s-out_for_delivery{background:#fde3cf;color:#9b4c14}
.s-delivered{background:#d9f2e4;color:#17663f} .s-cancelled{background:#fbdfdb;color:#912c20}
.toggle{cursor:pointer}
.tracker{list-style:none;margin:16px 0 0;padding:0;display:flex}
.tracker li{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative;gap:2px;font-size:.84rem;color:var(--muted)}
.tracker li::before{content:'';position:absolute;top:10px;left:-50%;width:100%;height:4px;background:var(--line);z-index:0}
.tracker li:first-child::before{display:none}
.tracker .dot{width:22px;height:22px;border-radius:50%;background:#fff;border:4px solid var(--line);z-index:1}
.tracker li.done .dot{background:var(--lagoon);border-color:var(--lagoon)}
.tracker li.done::before,.tracker li.now::before{background:var(--lagoon)}
.tracker li.now .dot{border-color:var(--lagoon);background:#fff;box-shadow:0 0 0 5px #0e7c8630}
.tracker li.done b,.tracker li.now b{color:var(--ink)}
.tracker small{font-size:.74rem}
.accountLayout{display:grid;grid-template-columns:220px 1fr;gap:34px;align-items:start;margin-top:20px}
.sideNav{display:flex;flex-direction:column;gap:4px;position:sticky;top:96px}
.sideNav a,.sideNav button{text-align:left;background:none;border:0;padding:11px 14px;border-radius:12px;text-decoration:none;font-weight:600}
.sideNav a:hover,.sideNav button:hover{background:var(--foam)}
.sideNav a.active{background:var(--ink);color:#fff}
.orderTop{display:flex;justify-content:space-between;gap:10px;align-items:start}
.orderCard p{margin:0 0 6px}
.itemRow{border-bottom:1px dashed var(--line)}
.narrowForm{max-width:520px}

/* admin */
.tabs{margin:18px 0 26px}
.statGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{background:#fff;border:1px solid var(--line);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:2px}
.stat small{color:var(--muted);font-weight:600}
.stat b{font-family:var(--display);font-size:1.7rem}
.stat span{font-size:.82rem;color:var(--muted)}
.stat.warn{border-color:var(--lemon-d);background:#fffaf0}
.adminCols{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}
.chart{width:100%;height:auto}
.gridLine{stroke:var(--line);stroke-width:1}
.bar{fill:var(--lagoon)} .barVal{font-size:11px;fill:var(--ink);font-weight:700} .barLbl{font-size:12px;fill:var(--muted)}
.hbar{display:grid;grid-template-columns:120px 1fr 30px;gap:10px;align-items:center;font-size:.88rem;padding:4px 0}
.hbar div{height:10px;border-radius:999px;background:var(--foam);overflow:hidden}
.hbar i{display:block;height:100%;border-radius:999px;min-width:2px}
.hbar b{text-align:right}
.adminOrder{display:flex;flex-direction:column;gap:12px}
.aoTop{display:flex;justify-content:space-between;gap:12px;align-items:start}
.aoTop p{margin:2px 0 0}
.aoRight{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.inlineSel{display:flex;gap:8px;align-items:center;font-size:.88rem;font-weight:600}
.inlineSel select{width:auto;padding:7px 10px}
.aoDetail{display:grid;grid-template-columns:1fr 1fr;gap:24px;border-top:1px solid var(--line);padding-top:14px}
.aoDetail p{margin:0 0 4px}
.miniSearch{max-width:300px}
.tableWrap{overflow-x:auto}
.table{width:100%;border-collapse:collapse;font-size:.92rem;min-width:720px}
.table th{text-align:left;font-size:.82rem;color:var(--muted);padding:12px 16px;border-bottom:1px solid var(--line)}
.table td{padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
.table tr:last-child td{border-bottom:0}
.cellProd{display:flex;gap:12px;align-items:center}
.cellProd span:last-child{display:flex;flex-direction:column}
.thumb{width:48px;height:48px;border-radius:12px;overflow:hidden;background:#eaf5f4;flex:none}
.thumb img,.thumb .imgFallback{width:100%;height:100%;object-fit:cover}
.thumb .imgFallback .bottleSvg{width:55%}
.stockEd{display:inline-flex;gap:6px;align-items:center}
.stockEd input{width:78px;padding:7px 9px}
.stockEd .lowIn{border-color:var(--lemon-d);background:#fffaf0}
.actions{white-space:nowrap;text-align:right}
.actions .btn{margin-left:6px}
.imgPick{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:start}
.imgPreview{aspect-ratio:1/1;border:1.5px dashed var(--line);border-radius:16px;display:grid;place-items:center;overflow:hidden;background:#f1f8f8}
.imgPreview img{width:100%;height:100%;object-fit:cover}

/* auth + modal */
.overlay{position:fixed;inset:0;background:#0a2a33b8;z-index:60;display:grid;place-items:center;padding:16px;overflow-y:auto}
.modal{position:relative;background:#fff;border-radius:26px;padding:30px;width:min(440px,100%);max-height:calc(100vh - 32px);overflow-y:auto}
.modal.wide{width:min(760px,100%)}
.closeBtn{position:absolute;right:12px;top:12px}
.authForm{display:flex;flex-direction:column;gap:14px}
.authForm h2{margin:0}
.authForm>p{margin:0}
.authLinks{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.otpInput{letter-spacing:.5em;font-size:1.3rem;text-align:center;font-weight:700}

/* footer */
.footer{background:var(--ink);color:#bcd8dc;margin-top:40px;padding:60px 24px 24px}
.footGrid{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1.2fr .8fr .9fr 1.3fr;gap:36px}
.footer h4{color:#fff;margin-bottom:14px}
.footer a{display:block;text-decoration:none;color:#bcd8dc;padding:3px 0}
.footer a:hover{color:var(--lemon)}
.footer p{font-size:.92rem;margin:0 0 10px}
.socials{display:flex;gap:10px;margin-top:16px}
.socials a{width:42px;height:42px;border-radius:50%;border:1.5px solid #ffffff33;display:grid;place-items:center;padding:0}
.socials a:hover{background:var(--lemon);color:var(--ink);border-color:var(--lemon)}
.socials svg{width:20px;height:20px}
.mapCard{margin-top:14px;border-radius:16px;overflow:hidden;background:#12414f;border:1px solid #ffffff22}
.mapCard iframe{width:100%;height:140px;border:0;display:block;filter:saturate(.85)}
.mapCard a{padding:9px 12px;font-size:.84rem;font-weight:700;color:var(--lemon)}
.footBottom{max-width:1200px;margin:40px auto 0;padding-top:20px;border-top:1px solid #ffffff1f;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:.82rem}

/* misc */
.wake{background:#fff6dc;color:#6b4b00;text-align:center;padding:10px 16px;font-size:.9rem;border-bottom:1px solid #f0dca0}

/* toasts */
.toasts{position:fixed;right:16px;bottom:16px;z-index:80;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px))}
.toast{background:var(--ink);color:#fff;padding:12px 16px;border-radius:14px;box-shadow:0 12px 30px #0a2a3340;cursor:pointer;font-size:.93rem;border-left:5px solid var(--lemon)}
.toast.bad{border-left-color:#ff7a6b}

/* responsive */
@media (max-width:1020px){
  .grid{grid-template-columns:repeat(3,1fr)}
  .footGrid{grid-template-columns:1fr 1fr}
  .statGrid{grid-template-columns:repeat(2,1fr)}
  .search input{width:100px}
}
@media (max-width:860px){
  .hero{grid-template-columns:1fr;padding-top:10px}
  .heroArt{min-height:340px;border-radius:32px 32px 0 0}
  .heroText{padding-bottom:20px}
  .bandGrid,.pdp,.split,.split.even,.adminCols,.aoDetail{grid-template-columns:1fr}
  .summary,.sideNav{position:static}
  .accountLayout{grid-template-columns:1fr;gap:16px}
  .sideNav{flex-direction:row;overflow-x:auto;gap:4px;padding-bottom:6px}
  .sideNav a,.sideNav button{white-space:nowrap;padding:9px 14px;background:#fff;border:1px solid var(--line)}
  .quotes,.threeUp{grid-template-columns:1fr}
  .header{gap:6px;padding:0 12px;height:64px}
  .menuBtn{display:grid}
  .search{display:none}
  .hBtn span{display:none}
  .hBtn.bagBtn span{display:none}
  .nav{display:none;position:absolute;top:64px;left:0;right:0;background:#fff;flex-direction:column;padding:14px;border-bottom:1px solid var(--line);box-shadow:0 20px 30px #0a2a3318;margin:0}
  .nav.open{display:flex}
  .nav a{padding:12px 14px}
  .searchMobile{display:block;margin-top:8px}
  .brand{margin-right:auto}
  .headerRight{margin-left:0}
  .line{grid-template-columns:70px 1fr 40px;grid-template-areas:'img info rm' 'img qty tot'}
  .line .lineImg{grid-area:img;width:70px;height:70px}
  .line .lineInfo{grid-area:info}
  .line .qty{grid-area:qty;justify-self:start}
  .line .lineTotal{grid-area:tot}
  .line .iconBtn{grid-area:rm}
  .tracker{flex-direction:column;gap:14px;align-items:flex-start}
  .tracker li{flex-direction:row;gap:10px;align-items:center;text-align:left}
  .tracker li::before{display:none}
  .section{padding-top:36px;padding-bottom:36px}
}
@media (max-width:620px){
  .grid{grid-template-columns:repeat(2,1fr);gap:12px}
  .pBody{padding:12px}
  .pFoot{flex-direction:column;align-items:stretch}
  .formGrid{grid-template-columns:1fr}
  .wrap{padding-left:16px;padding-right:16px}
  .footGrid{grid-template-columns:1fr}
  .statGrid{grid-template-columns:1fr 1fr;gap:10px}
  .imgPick{grid-template-columns:1fr}
  .imgPreview{max-width:160px}
  .hbar{grid-template-columns:96px 1fr 26px}
  .modal{padding:24px 20px}
  .announce{font-size:.78rem}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
`;