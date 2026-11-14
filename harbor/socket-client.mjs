import { getRelay, relayProtocols } from './relay-settings.mjs';
const NativeWebSocket = window.WebSocket;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function connectSocket(url, protocols, headers, onopen, onmessage, onclose, onerror, record) {
  const relay = getRelay();
  const address = new URL('/socket/', relay.address);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new NativeWebSocket(address.href, relayProtocols(relay.key));
  socket.binaryType = 'arraybuffer';
  let closed = false;
  let writeQueue = Promise.resolve();
  const finish = (code, reason) => { if (closed) return; closed = true; record.state = 'closed'; record.closeCode = code; onclose(code, reason); };
  socket.onopen = () => socket.send(JSON.stringify({ url: url.href, protocols: typeof protocols === 'string' ? [protocols] : (protocols || []), headers }));
  socket.onmessage = event => {
    const bytes = new Uint8Array(event.data);
    if (bytes[0] === 0) {
      const control = JSON.parse(decoder.decode(bytes.subarray(1)));
      if (control.type === 'open') { record.state = 'open'; onopen(control.protocol, control.extensions); }
      if (control.type === 'error') { record.state = 'error'; record.error = control.message; onerror(control.message); }
      if (control.type === 'close') finish(control.code, control.reason);
    } else {
      record.receivedFrames++;
      onmessage(bytes[0] === 1 ? decoder.decode(bytes.subarray(1)) : bytes.slice(1).buffer);
    }
  };
  socket.onclose = event => finish(event.code, event.reason);
  socket.onerror = () => { record.state = 'error'; onerror('Local WebSocket relay is unavailable'); };
  const send = data => {
    // Blob conversion is asynchronous. Queue writes so a later string/buffer
    // cannot overtake an earlier Blob, preserving native WebSocket ordering.
    writeQueue = writeQueue.then(async () => {
      if (socket.readyState !== NativeWebSocket.OPEN || closed) return;
      const text = typeof data === 'string';
      const payload = text ? encoder.encode(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
      const packet = new Uint8Array(payload.byteLength + 1); packet[0] = text ? 1 : 2; packet.set(payload, 1);
      record.sentFrames++; socket.send(packet);
    }).catch(error => onerror(String(error)));
  };
  const close = (code = 1000) => { writeQueue = writeQueue.then(() => { if (socket.readyState === NativeWebSocket.OPEN) { const text = encoder.encode(JSON.stringify({ type: 'close', code })); const bytes = new Uint8Array(text.length + 1); bytes.set(text, 1); socket.send(bytes); } else socket.close(); }); };
  return [send, close];
}
