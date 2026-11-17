// Old Harbor releases live at frozen commit links that can't be edited. Their
// background workers, though, serve the Harbor page from Cache Storage, which
// every page on this origin shares. When someone opens the current Harbor, this
// swaps the cached page of each retired release on that device for a short
// "Harbor has moved" notice. The Tactical Breach Wizards game commit is never
// listed here, so its saves and files are untouched.
const RETIRED = new Set(["b38d96240f76414286d8e14885c956f232647694","013622587a11e7d6736285829710d4b0464c3329","1fc195995c782e3e7cf7c281f3ef84e7e735de12","4deb923159f27a4215fc16a949ce3ff8699b08bd","0351a960b312d6888a4b9c7aeb27fd2d34625859","0986ab8d107d11f9cb5c3f54d878dc58b924f4ee","112ee5d45b29745376cf2536437f013bbb702af3","18d86502ab356e94b5a98194b15e3bf24180801c","1adb36fd981cb345c6ae61fadcfc19a3a3e6e220","2362250ce992b152fc85c6c6c240d2d8ec4cfd66","23cfa0c85dc3e7bff0cfcda6f67839c8a7fa5723","28fa2c86d90b33aa151f5b188d25b269bb76cfe9","3274868604de6f0b34ecdefef993c2ba8961f099","4325998e0c323bc710e6cf0ecaa4c25b7532e0b8","4758ecb8e359a47ca101a31364f5f8b46506263a","568b41d7926f97d5a13af3d27f67368f52c8bd0b","5786b2ae2008ea9c060f660f93c0f28ee5cb52e5","643391be4c3b9fd36a4897ed7622138c7e0f8a61","6615e9648f11c732e81924ff379b97c8fafd6a3c","6af5616fca2f127ba6a6bc8157fc0b2497ade7cc","6af8117318e59ae46238f319ce47d83308741316","73f3baf42d098bc93f75301fbbec55eec9116e56","9dc49a1a09de04d3282993268c432f476be6ce92","9f369fb4f9d5f9beb795b4d265700a15a61022ef","a71c90fed79bd21e994d8c25c0b0af0fa7d9bedb","b8539cc51c1e24bd4cea21e887b7eb012f0ceffd","cc697e25b79b7328ee24b15edeca2e689e5043f0","ccdd52016d29b11d3a9a483b7d63be93d32b9910","cd2e571bd593ba77912cf949b61876eaa7fd59f2","f549be6be67d15c729027709b2bd5530925f07dd"]);
const PERMANENT = 'https://cdn.jsdelivr.net/gh/ParrrotVR/tbw-web@launch/index.svg';

const MOVED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor has moved</title>
<style>html,body{margin:0;height:100%;background:#0e2738;color:#f3eada;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
#harbor-app{min-height:100%;display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box}
.card{max-width:460px;text-align:center}svg{width:72px;height:72px}h1{font-size:30px;font-weight:600;margin:22px 0 10px}
p{color:#97aebb;line-height:1.6;font-size:16px;margin:0 0 22px}code{display:block;font:13px ui-monospace,Menlo,Consolas,monospace;color:#f3eada;background:#14344a;border:1px solid rgba(240,230,210,.13);border-radius:12px;padding:12px;word-break:break-all;margin:0 0 20px}
a.go{display:inline-block;background:#ff6b3d;color:#2a0f05;font-weight:600;text-decoration:none;padding:13px 24px;border-radius:999px;font-size:16px}
button{margin-left:8px;background:#14344a;color:#f3eada;border:1px solid rgba(240,230,210,.13);border-radius:999px;padding:12px 18px;font:inherit;font-size:15px;cursor:pointer}</style></head>
<body><div id="harbor-app"><div class="card">
<svg viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#1b4058"/><path d="M33 19V79M33 54A19 19 0 0 1 71 54V79" fill="none" stroke="#f3eada" stroke-width="13" stroke-linecap="round"/><path d="M-4 66C6 62 14 62 24 66S42 70 52 66 70 62 80 66 98 70 108 66V104H-4Z" fill="#58c4bb" opacity=".85"/></svg>
<h1>Harbor has moved</h1>
<p>This is an old copy of Harbor and it won't get any more updates. Open the new link below, pin it or bookmark it, and stop using this one.</p>
<code>${PERMANENT}</code>
<a class="go" href="${PERMANENT}" target="_top">Open the new Harbor</a><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText('${PERMANENT}').then(()=>{this.textContent='Copied'})">Copy link</button>
</div></div></body></html>`;

export async function retireOldReleases() {
  if (!globalThis.caches || location.hostname !== 'cdn.jsdelivr.net') return 0;
  const here = /\/gh\/ParrrotVR\/tbw-web@([0-9a-f]{40})\//.exec(location.pathname)?.[1];
  let retired = 0;
  for (const name of await caches.keys()) {
    const match = /^tbw-split:(\/gh\/ParrrotVR\/tbw-web@([0-9a-f]{40})\/):/.exec(name);
    if (!match || !RETIRED.has(match[2]) || match[2] === here) continue;
    const cache = await caches.open(name);
    const base = location.origin + match[1];
    if (!(await cache.match(base + 'harbor/portal.mjs')) && !(await cache.match(base + 'harbor/browser.html'))) continue;
    await cache.put(base + 'harbor/browser.html', new Response(MOVED, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    retired++;
  }
  return retired;
}
