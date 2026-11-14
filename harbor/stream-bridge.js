/* Harbor's optional Safari stream-transfer adapter. Loaded before the controller
   in the page and worker; never injected into third-party pages. */
(() => {
  if (globalThis.harborStreamBridge) return;
  let transferable = false;
  try {
    const channel = new MessageChannel();
    const stream = new ReadableStream({ start(controller) { controller.close(); } });
    channel.port1.postMessage(stream, [stream]);
    channel.port1.close(); channel.port2.close();
    transferable = true;
  } catch {}
  const forced = globalThis.location?.search?.includes('buffered=1');
  globalThis.harborStreamBridge = { mode: transferable && !forced ? 'streaming' : 'buffered', bufferedMessages: 0 };
  if (transferable && !forced) return;
  const original = MessagePort.prototype.postMessage;
  const queues = new WeakMap();
  function replace(value, replacements, seen = new Map()) {
    if (replacements.has(value)) return replacements.get(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) result[key] = replace(value[key], replacements, seen);
    return result;
  }
  MessagePort.prototype.postMessage = function (message, options) {
    const list = Array.isArray(options) ? options : (options?.transfer || []);
    const streams = list.filter(item => item instanceof ReadableStream);
    const independentRpc = message && typeof message === 'object' && Object.entries(message).some(([key, value]) => (key.startsWith('tabchannel-') || key === 'transport') && (value?.$type === 'request' || value?.$type === 'response'));
    if (streams.length && independentRpc) {
      // RPC responses are paired by token, not arrival order. Buffer in parallel
      // so one slow asset cannot block every other response on this channel.
      (async () => {
        const replacements = new Map();
        await Promise.all(streams.map(async stream => replacements.set(stream, await new Response(stream).arrayBuffer())));
        original.call(this, replace(message, replacements), list.map(item => replacements.get(item) || item));
        globalThis.harborStreamBridge.bufferedMessages++;
      })().catch(error => console.error('Harbor stream adapter failed:', error));
      return;
    }
    const pending = queues.get(this);
    if (!streams.length && !pending) return original.call(this, message, options);
    const send = async () => {
      const replacements = new Map();
      for (const stream of streams) replacements.set(stream, await new Response(stream).arrayBuffer());
      const transfer = list.map(item => replacements.get(item) || item);
      original.call(this, replace(message, replacements), transfer);
      if (streams.length) globalThis.harborStreamBridge.bufferedMessages++;
    };
    const task = (pending || Promise.resolve()).then(send);
    queues.set(this, task);
    task.catch(error => { console.error('Harbor stream adapter failed:', error); globalThis.dispatchEvent(new ErrorEvent('error', { message: String(error), error })); })
      .finally(() => { if (queues.get(this) === task) queues.delete(this); });
  };
})();
