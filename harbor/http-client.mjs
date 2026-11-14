import { relayFetch } from './relay-settings.mjs';
// The relay envelope carries raw duplicate headers without putting cookies or
// destination URLs in local request URLs. Binary bodies remain streaming.
export class NativeHttpTransport {
  ready = false;
  async init() { this.ready = true; }
  async meta() {}
  async request(url, method, body, headers, signal) {
    const metadata = JSON.stringify({ url: url.href, method, headers });
    const bytes = new TextEncoder().encode(metadata);
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    // Upload streaming is inconsistent across browsers. Buffer uploads only;
    // response bodies (including images) remain streams in either case.
    if (body instanceof ReadableStream) body = await new Response(body).arrayBuffer();
    const response = await relayFetch('/http/', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Harbor-Request': encoded },
      body: body ?? undefined, signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok || response.headers.get('x-harbor-stream') !== '1') throw new Error(await response.text());
    const reader = response.body.getReader();
    let chunk = new Uint8Array(); let offset = 0;
    async function take(length) {
      const output = new Uint8Array(length); let written = 0;
      while (written < length) {
        if (offset === chunk.length) {
          const next = await reader.read();
          if (next.done) throw new Error('Incomplete relay response');
          chunk = next.value; offset = 0;
        }
        const count = Math.min(length - written, chunk.length - offset);
        output.set(chunk.subarray(offset, offset + count), written); offset += count; written += count;
      }
      return output;
    }
    const size = new DataView((await take(4)).buffer).getUint32(0);
    if (size > 256 * 1024) { await reader.cancel(); throw new Error('Relay response headers are too large'); }
    const result = JSON.parse(new TextDecoder().decode(await take(size)));
    return { ...result, body: new ReadableStream({
      async pull(controller) {
        try {
          if (offset < chunk.length) { controller.enqueue(chunk.subarray(offset)); offset = chunk.length; return; }
          const next = await reader.read();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    }) };
  }
}
