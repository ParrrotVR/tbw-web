import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function verifiedIntermediates(pems, trustedRoots, now = Date.now()) {
  const roots = trustedRoots.map(pem => new X509Certificate(pem));
  const candidates = pems.map(pem => ({ pem, cert: new X509Certificate(pem) })).filter(({ cert }) => cert.ca && cert.subject !== cert.issuer && Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) >= now);
  const trusted = [...roots]; const accepted = []; const remaining = new Set(candidates);
  while (remaining.size) {
    let progress = false;
    for (const item of remaining) {
      if (!trusted.some(issuer => issuer.subject === item.cert.issuer && item.cert.verify(issuer.publicKey))) continue;
      trusted.push(item.cert); accepted.push(item.pem); remaining.delete(item); progress = true;
    }
    if (!progress) break;
  }
  return accepted;
}

export function socketCertificateAuthorities() {
  const roots = tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates;
  // These public intermediates complete the omitted YE1 chain. They are only
  // accepted if their signatures lead to an already trusted Node root. This
  // neither installs an OS certificate nor adds a new self-signed trust root.
  const pems = ['int-ye1.pem', 'root-ye-by-x2.pem'].map(name => readFileSync(new URL('../certificates/' + name, import.meta.url), 'utf8'));
  return [...roots, ...verifiedIntermediates(pems, roots)];
}
