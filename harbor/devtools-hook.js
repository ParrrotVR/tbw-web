// Harbor developer tools: runs at the start of every page and frame the engine opens
// (it is prepended to vendor/controller.inject.js at build time). It reports the page's
// errors to Harbor's developer panel and, only while that panel has been opened, its
// console messages too. Wrapping console functions is visible to bot checks, so it stays
// off unless someone is actually looking.
(function () {
  "use strict";
  try {
    if (window.__harborDevHook) return;
    Object.defineProperty(window, "__harborDevHook", { value: true });
    var host = null, child = window, w = window;
    for (var i = 0; i < 16 && w.parent && w.parent !== w; i++) {
      child = w; w = w.parent;
      try { if (w.harborDevtools) { host = w; break; } } catch (_) { return; }
    }
    if (!host) return;
    var hub = host.harborDevtools;
    // The engine hides frameElement from pages, so Harbor matches the tab by its window.
    var tabWindow = child;
    var describe = function (value) {
      try {
        if (typeof value === "string") return value;
        if (value instanceof Error || (value && typeof value.stack === "string" && typeof value.message === "string"))
          return String(value.name || "Error") + ": " + value.message + (value.stack ? "\n" + String(value.stack).split("\n").slice(value.stack.indexOf(value.message) >= 0 ? 1 : 0, 6).join("\n") : "");
        if (value === undefined) return "undefined";
        if (typeof value === "function") return "function " + (value.name || "(anonymous)");
        if (typeof value === "object" && value !== null && value.nodeType === 1) return "<" + String(value.tagName).toLowerCase() + (value.id ? "#" + value.id : "") + ">";
        var text = JSON.stringify(value);
        return text === undefined ? String(value) : text.length > 600 ? text.slice(0, 600) + "…" : text;
      } catch (_) { try { return String(value); } catch (__) { return "[value]"; } }
    };
    var send = function (level, args) {
      try {
        var parts = [], j = 0;
        // Apply console format placeholders like browsers do; %c styling is dropped.
        if (typeof args[0] === "string" && args[0].indexOf("%") >= 0) {
          j = 1;
          parts.push(args[0].replace(/%([sdifoOc%])/g, function (match, kind) {
            if (kind === "%") return "%";
            if (j >= args.length) return match;
            var value = args[j++];
            if (kind === "c") return "";
            if (kind === "d" || kind === "i") return String(parseInt(value, 10));
            if (kind === "f") return String(parseFloat(value));
            return describe(value);
          }));
        }
        for (; j < args.length && j < 12; j++) parts.push(describe(args[j]));
        hub.log({ level: level, text: parts.join(" ").trim(), page: location.href, win: tabWindow, top: child === window });
      } catch (_) {}
    };
    try { if (hub.frame) hub.frame({ page: location.href, win: tabWindow, top: child === window }); } catch (_) {}
    addEventListener("error", function (event) {
      if (event.target && event.target !== window && event.target.tagName) {
        var element = event.target, source = element.src || element.href || "";
        send("error", ["Failed to load <" + String(element.tagName).toLowerCase() + ">", source]);
        return;
      }
      send("error", [event.error || event.message, event.filename ? "(" + event.filename + ":" + event.lineno + ")" : ""]);
    }, true);
    addEventListener("unhandledrejection", function (event) { send("error", ["Unhandled promise rejection:", event.reason]); });
    if (hub.captureConsole) {
      ["log", "info", "warn", "error", "debug"].forEach(function (name) {
        var original = console[name];
        if (typeof original !== "function") return;
        try {
          console[name] = function () { send(name, arguments); return original.apply(this, arguments); };
        } catch (_) {}
      });
    }
  } catch (_) {}
})();
