// Narrow host rules for advertising/measurement networks observed in profiles.
// Game servers, sign-in providers and general-purpose asset CDNs stay allowed.
const hosts = new Set([
  'scriptwrapper.com', 'journeymv.com', 'mediavine.com', 'pubnation.com',
  'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com',
  'scorecardresearch.com', 'id5-sync.com', 'amazon-adsystem.com', 'adsrvr.org',
  'adnxs.com', 'pubmatic.com', 'criteo.com', 'criteo.net', 'rubiconproject.com',
  'fastclick.net', 'openx.net', 'opecloud.com', 'casalemedia.com',
]);
export function isFilteredHost(hostname) {
  const labels = hostname.toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) if (hosts.has(labels.slice(i).join('.'))) return true;
  return false;
}
export function filteredResponse() { return { status: 204, statusText: 'No Content', headers: [['Cache-Control', 'no-store']], body: null }; }
