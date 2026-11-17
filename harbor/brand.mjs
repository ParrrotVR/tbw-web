// Harbor wordmark: lowercase "harbor" drawn on a 100-unit x-height grid
// (baseline y=200) with one harbor object worked in. "Afloat" is the
// usual mark; the others turn up now and then.
const WEIGHTS = { afloat: 55, lifering: 9, waterline: 9, porthole: 9, lighthouse: 9, crane: 9 };
let uid = 0;
const INK = 'var(--logo-ink)';

function pick() {
  try {
    const forced = new URLSearchParams(location.search).get('logo');
    if (forced && WEIGHTS[forced]) return forced;
  } catch {}
  let roll = Math.random() * Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  for (const [name, weight] of Object.entries(WEIGHTS)) if ((roll -= weight) < 0) return name;
  return 'afloat';
}
export const variant = pick();

const stroke = (color, body, extra = '') =>
  `<g fill="none" stroke="${color}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</g>`;

function letters(skip = []) {
  const p = [];
  if (!skip.includes('h')) p.push('<path d="M11 61V189M11 150A39 39 0 0 1 89 150V189"/>');
  p.push('<circle cx="166" cy="150" r="39"/><path d="M205 111V189"/>');
  p.push('<path d="M243 111V189M243 150A39 39 0 0 1 282 111"/>');
  p.push('<path d="M321 61V189"/><circle cx="360" cy="150" r="39"/>');
  if (!skip.includes('o')) p.push('<circle cx="476" cy="150" r="39"/>');
  if (!skip.includes('r2')) p.push('<path d="M553 111V189M553 150A39 39 0 0 1 592 111"/>');
  return p.join('');
}

// A smooth sine-like curve made of cubic segments (no sharp joins).
function wave(y, x0, x1, amp, period) {
  const h = period / 2, k = h * 0.3642;
  let d = `M${x0} ${y}`, up = true;
  for (let x = x0; x < x1; x += h, up = !up) {
    const dy = up ? -amp : amp;
    d += ` C${(x + k).toFixed(2)} ${y + dy * 1.33} ${(x + h - k).toFixed(2)} ${y + dy * 1.33} ${(x + h).toFixed(2)} ${y}`;
  }
  return d;
}

function ring(cx, cy = 150, { ink = INK, band = 'var(--accent)', cls = 'hb-spin', r = 39, sw = 22 } = {}) {
  const c = 2 * Math.PI * r, dash = c * 0.082, gap = c / 4 - dash, start = 45 - (dash / c) * 180;
  return `<g class="${cls}" style="transform-origin:${cx}px ${cy}px"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ink}" stroke-width="${sw}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${band}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" transform="rotate(${start.toFixed(1)} ${cx} ${cy})"/></g>`;
}

function tower() {
  const hw = y => 9 + (y - 46) / 154 * 5;
  const band = (a, b) => `<polygon fill="var(--accent)" points="${11 - hw(a)},${a} ${11 + hw(a)},${a} ${11 + hw(b)},${b} ${11 - hw(b)},${b}"/>`;
  return `<polygon fill="${INK}" points="-3,200 25,200 20,46 2,46"/>${band(72, 92)}${band(122, 142)}<rect x="7" y="181" width="8" height="19" rx="4" fill="var(--logo-knock)"/><rect x="-3" y="39" width="28" height="8" rx="2.5" fill="${INK}"/><rect x="3" y="19" width="16" height="21" fill="var(--lamp)"/><path d="M11 19V39" stroke="${INK}" stroke-width="2.5"/><path d="M-1 21 L11 6 L23 21 Z" fill="${INK}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><circle cx="11" cy="4" r="3.5" fill="${INK}"/>`;
}

// Letters change to sea colour below a gentle water line. The line runs the
// full width behind the letters, with a few ripples underneath.
function waterWord(u, y, body, under) {
  const P = 64, line = wave(y, -160, 780, 4, P), motion = `class="hb-wave" style="--p:${P}px;--d:4s"`;
  return {
    vb: [-12, 38, 628, 184],
    inner: `<defs><clipPath id="hu${u}"><path ${motion} d="${line} V-100 H-160 Z"/></clipPath><clipPath id="hd${u}"><path ${motion} d="${line} V400 H-160 Z"/></clipPath></defs><path ${motion} d="${line}" fill="none" stroke="var(--sea)" stroke-width="4.5" stroke-linecap="round"/><g clip-path="url(#hu${u})">${body}</g><g clip-path="url(#hd${u})">${under}</g><g class="hb-ripple" stroke="var(--sea)" stroke-width="3.5" stroke-linecap="round" opacity=".45"><path d="M40 214h34M300 214h46M540 214h22"/><path d="M150 219h22M450 219h30"/></g>`,
  };
}

const MARKS = {
  afloat(u) {
    const word = (c, band) => stroke(c, letters(['o'])) + `<g class="hb-bob" style="transform-origin:476px 150px">${ring(476, 150, { ink: c, band, cls: '' })}</g>`;
    return waterWord(u, 174, word(INK, 'var(--accent)'), word('var(--sea)', 'color-mix(in srgb,var(--accent) 55%,var(--sea))'));
  },
  waterline(u) {
    return waterWord(u, 168, stroke(INK, letters()), stroke('var(--sea)', letters()));
  },
  lifering() {
    return { vb: [-12, 38, 628, 176], inner: stroke(INK, letters(['o'])) + ring(476) };
  },
  porthole(u) {
    const cx = 476;
    let bolts = '';
    for (let i = 0; i < 8; i++) { const a = (i * 45 + 22.5) * Math.PI / 180; bolts += `<circle cx="${(cx + 39 * Math.cos(a)).toFixed(1)}" cy="${(150 + 39 * Math.sin(a)).toFixed(1)}" r="2.8" fill="var(--logo-knock)"/>`; }
    return {
      vb: [-12, 38, 628, 176],
      inner: `<defs><clipPath id="hp${u}"><circle cx="${cx}" cy="150" r="29"/></clipPath></defs>${stroke(INK, letters(['o']))}<circle cx="${cx}" cy="150" r="29" fill="var(--glass)"/><g clip-path="url(#hp${u})"><path class="hb-wave" style="--p:36px;--d:5s" d="${wave(150, cx - 72, cx + 80, 2.5, 36)} V200 H${cx - 72} Z" fill="var(--sea)" opacity=".45"/><path class="hb-wave" style="--p:30px" d="${wave(157, cx - 60, cx + 80, 3, 30)} V200 H${cx - 60} Z" fill="var(--sea)"/></g><circle cx="${cx}" cy="150" r="39" fill="none" stroke="${INK}" stroke-width="22"/>${bolts}`,
    };
  },
  lighthouse(u) {
    return {
      vb: [-14, -8, 630, 222],
      inner: `<defs><linearGradient id="hg${u}" x1="0" x2="1"><stop offset="0" stop-color="var(--lamp)" stop-opacity=".6"/><stop offset=".7" stop-color="var(--lamp)" stop-opacity="0"/></linearGradient></defs><polygon class="hb-beam" style="transform-origin:11px 29px" points="11,29 640,-30 640,78" fill="url(#hg${u})"/>${stroke(INK, letters(['h']) + '<path d="M11 150A39 39 0 0 1 89 150V189"/>')}${tower()}`,
    };
  },
  crane() {
    let zig = 'M600 122';
    for (let x = 600, up = false; x < 702; x += 12.75, up = !up) zig += ` L${x + 12.75} ${up ? 122 : 144}`;
    let ribs = '';
    for (let x = 677; x <= 723; x += 7.6) ribs += `M${x} 147V183`;
    return {
      vb: [-12, 38, 762, 176],
      inner: `${stroke(INK, letters(['r2']) + '<path d="M553 111V189M553 150A39 39 0 0 1 592 111H712"/>')}<path d="${zig}M606 144H702" fill="none" stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/><g class="hb-swing" style="transform-origin:700px 122px"><path d="M700 122V134" stroke="${INK}" stroke-width="4"/><path d="M674 141 L700 132 L726 141" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><rect x="668" y="141" width="64" height="48" rx="3" fill="var(--accent)"/><path d="${ribs}" stroke="rgba(0,0,0,.22)" stroke-width="3"/></g>`,
    };
  },
};

export function wordmarkSVG(name = variant) {
  const { vb, inner } = MARKS[name](++uid);
  return `<svg class="hb hb-mark hb-${name}" viewBox="${vb.join(' ')}" style="aspect-ratio:${vb[2]}/${vb[3]}" role="img" aria-label="harbor">${inner}</svg>`;
}

// The small mark: the wordmark's "h", dipping into calm water.
export function iconSVG(tile = true) {
  const u = ++uid, line = wave(66, -40, 160, 2.2, 60);
  const h = color => `<path d="M33 19V79M33 54A19 19 0 0 1 71 54V79" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round"/>`;
  return `<svg class="hb hb-icon" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="ht${u}"><rect width="100" height="100" rx="24"/></clipPath><clipPath id="hw${u}"><path d="${line} V120 H-40 Z"/></clipPath></defs><g clip-path="url(#ht${u})">${tile ? '<rect width="100" height="100" fill="var(--tile)"/>' : ''}${h(INK)}<g clip-path="url(#hw${u})"><rect width="100" height="100" fill="var(--sea)" opacity=".22"/>${h('var(--sea)')}</g></g></svg>`;
}

// Real site icons: bundled for the built-in shortcuts, otherwise looked up by
// domain. The first letter stays as a fallback if no image loads.
const LOCAL_ICONS = [['mcdle.net', 'mcdle.png'], ['playdaily.org/krillion', 'krillion.png'], ['digdig.io', 'digdig.png'], ['neal.fun', 'neal.png']];
export function siteIconURL(address) {
  let url;
  try { url = new URL(address); } catch { return ''; }
  if (!/^https?:$/.test(url.protocol)) return '';
  const host = url.hostname.replace(/^www\./, '');
  for (const [prefix, file] of LOCAL_ICONS) if ((host + url.pathname).startsWith(prefix)) return new URL('sites/' + file, import.meta.url).href;
  return 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico';
}
export function fillSiteIcon(element, address, letter) {
  const src = siteIconURL(address);
  if (element.dataset.iconSrc === src && element.dataset.iconLetter === letter) return;
  element.dataset.iconSrc = src; element.dataset.iconLetter = letter;
  element.classList.remove('has-img');
  element.textContent = letter;
  if (!src) return;
  const image = new Image();
  image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  image.onload = () => { if (element.dataset.iconSrc !== src || image.naturalWidth < 2) return; element.textContent = ''; element.append(image); element.classList.add('has-img'); };
  image.src = src;
}

function mount() {
  document.documentElement.dataset.logo = variant;
  const wordmark = document.getElementById('wordmark');
  if (wordmark) {
    wordmark.innerHTML = wordmarkSVG();
    wordmark.classList.add('hb-live');
  }
  for (const slot of document.querySelectorAll('[data-harbor-icon]')) slot.innerHTML = iconSVG(slot.dataset.harborIcon !== 'bare');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
