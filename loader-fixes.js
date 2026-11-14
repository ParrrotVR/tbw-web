(function (root) {
  "use strict";
  var loader = root.UnityLoader;
  if (loader) {
    loader.reportStartupError = function (module, message) {
      if (module.startupError) return;
      module.startupError = String(message);
      var pending = (module.pendingDownloads || []).slice();
      module.pendingDownloads = [];
      pending.forEach(function (request) {
        try { request.abort(); } catch (_) {}
      });
      if (module.unityInstance && typeof module.unityInstance.onerror === "function")
        module.unityInstance.onerror(module.startupError);
      else if (typeof module.printErr === "function") module.printErr(module.startupError);
    };

    loader.processDataJob = function (module, job) {
      if (module.startupError) return;
      try {
        var data = loader.Job.result(module, "downloadData");
        var prefix = "UnityWebData1.0\0";
        if (!data || data.byteLength < prefix.length + 4 ||
            String.fromCharCode.apply(null, data.subarray(0, prefix.length)) !== prefix)
          throw new Error("The game data has an invalid header. The server may have returned an error page.");
        var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        var pos = prefix.length;
        var headerSize = view.getUint32(pos, true);
        pos += 4;
        if (headerSize < pos || headerSize > data.byteLength)
          throw new Error("The game data header is incomplete.");
        var entries = [];
        while (pos < headerSize) {
          if (headerSize - pos < 12) throw new Error("The game data directory is incomplete.");
          var offset = view.getUint32(pos, true); pos += 4;
          var size = view.getUint32(pos, true); pos += 4;
          var pathLength = view.getUint32(pos, true); pos += 4;
          if (!pathLength || pathLength > headerSize - pos || offset < headerSize ||
              offset > data.byteLength || size > data.byteLength - offset)
            throw new Error("The game download is truncated or corrupt.");
          var path = String.fromCharCode.apply(null, data.subarray(pos, pos + pathLength));
          pos += pathLength;
          entries.push({ path: path, offset: offset, size: size });
        }
        entries.forEach(function (entry) {
          var path = entry.path;
          for (var folder = 0, next = path.indexOf("/") + 1; next > 0;
               folder = next, next = path.indexOf("/", folder) + 1)
            module.FS_createPath(path.substring(0, folder), path.substring(folder, next - 1), true, true);
          module.FS_createDataFile(path, null, data.subarray(entry.offset, entry.offset + entry.size), true, true, true);
        });
        module.removeRunDependency("processDataJob");
        job.complete();
      } catch (error) {
        loader.reportStartupError(module, "Unable to load game data: " + error.message);
      }
    };

    loader.downloadJob = function (module, job) {
      if (module.startupError) return;
      var xhr = !root.TBWSplitConfig && job.parameters.objParameters
        ? new loader.UnityCache.XMLHttpRequest(job.parameters.objParameters) : new root.XMLHttpRequest();
      var settled = false;
      var timer;
      var timeout = module.downloadTimeout || 120000;
      module.pendingDownloads = module.pendingDownloads || [];
      module.pendingDownloads.push(xhr);
      function cleanup() {
        root.clearTimeout(timer);
        var index = module.pendingDownloads.indexOf(xhr);
        if (index >= 0) module.pendingDownloads.splice(index, 1);
      }
      function fail(reason) {
        if (settled) return;
        settled = true;
        cleanup();
        loader.reportStartupError(module, reason + ": " + job.parameters.url);
        try { xhr.abort(); } catch (_) {}
      }
      function resetTimeout() {
        root.clearTimeout(timer);
        timer = root.setTimeout(function checkIdle() {
          if (root.TBWSplitConfig && root.TBWSplitLastActivity &&
              Date.now() - root.TBWSplitLastActivity < timeout) {
            timer = root.setTimeout(checkIdle, timeout);
            return;
          }
          fail("The game download stopped responding");
        }, timeout);
      }
      try {
        xhr.open("GET", job.parameters.url);
        xhr.responseType = "arraybuffer";
        xhr.onerror = function () { fail("Unable to download a game file"); };
        xhr.onabort = function () { fail("The game download was interrupted"); };
        xhr.ontimeout = function () { fail("The game download timed out"); };
        xhr.addEventListener("progress", function (event) {
          if (settled) return;
          resetTimeout();
          if (job.parameters.onprogress) job.parameters.onprogress(event);
        });
        xhr.onload = function (event) {
          if (settled || module.startupError) return;
          if (xhr.status < 200 || xhr.status >= 300) {
            fail("Game file request failed (HTTP " + xhr.status + ")");
            return;
          }
          if (!xhr.response || !xhr.response.byteLength) { fail("The game file is empty"); return; }
          resetTimeout();
          try {
            loader.Compression.decompress(new Uint8Array(xhr.response), function (data) {
              if (settled || module.startupError) return;
              if (!data || !data.byteLength) { fail("Unable to decompress a game file"); return; }
              settled = true;
              cleanup();
              try { job.complete(data); }
              catch (error) { loader.reportStartupError(module, error.message || String(error)); }
            });
            if (job.parameters.onload) job.parameters.onload(event);
          } catch (error) { fail("Unable to read the game file (" + error.message + ")"); }
        };
        resetTimeout();
        xhr.send();
      } catch (error) { fail("Unable to start the game download (" + error.message + ")"); }
    };
  }

  root.TBWWebGL = {
    start: function (containerId, buildUrl) {
      if (root.TBWSplitReady && !root.TBWSplitStarted) {
        root.TBWSplitStarted = true;
        root.TBWSplitReady.then(function () { root.TBWWebGL.start(containerId, buildUrl); })
          .catch(function (error) { root.console.error(error); });
        return;
      }

      if (root.TBWOfflineReady && !root.TBWOfflineStarted) {
        root.TBWOfflineStarted = true;
        root.TBWOfflineReady.then(function () { root.TBWWebGL.start(containerId, buildUrl); });
        return;
      }
      var status = root.document.getElementById("status");
      var container = root.document.getElementById(containerId);
      var failed = false;
      function showError(message) {
        if (failed) return;
        failed = true;
        status.hidden = false;
        status.setAttribute("role", "alert");
        status.textContent = "Unable to run the game. " + String(message);
        root.console.error(message);
      }
      if (!loader) { showError("The game loader could not be downloaded. Reload the page."); return; }
      if (root.location.protocol === "file:") {
        showError("Open this page through a local HTTP server or a hosted website; browsers cannot load this game directly from a file.");
        return;
      }
      root.addEventListener("error", function (event) {
        if (event.message) showError(event.message);
      });
      root.addEventListener("unhandledrejection", function (event) {
        showError(event.reason && event.reason.message || event.reason || "Unexpected loading failure.");
      });
      container.addEventListener("webglcontextlost", function () {
        showError("The browser lost its graphics connection. Reload the page to restart.");
      }, true);
      status.textContent = "Checking game files…";
      var controller = new root.AbortController();
      var manifestTimer = root.setTimeout(function () { controller.abort(); }, 30000);
      root.fetch(buildUrl, { signal: controller.signal }).then(function (response) {
        if (!response.ok) throw new Error("Game configuration request failed (HTTP " + response.status + ").");
        return response.json();
      }).then(function (config) {
        root.clearTimeout(manifestTimer);
        ["dataUrl", "wasmCodeUrl", "wasmFrameworkUrl"].forEach(function (key) {
          if (typeof config[key] !== "string" || !config[key]) throw new Error("The game configuration is incomplete.");
        });
        if (failed) return;
        root.unityInstance = loader.instantiate(containerId, buildUrl, {
          onerror: showError,
          onProgress: function (instance, progress) {
            if (failed) return;
            status.textContent = progress < 1 ? "Loading game… " + Math.round(progress * 100) + "%" : "";
            status.hidden = progress >= 1;
          },
          Module: {
            onAbort: function (message) { showError(message || "The game stopped unexpectedly."); },
            print: function (message) {
              if (String(message).indexOf("Could not download ") === 0) showError(message);
              else root.console.log(message);
            }
          }
        });
      }).catch(function (error) {
        root.clearTimeout(manifestTimer);
        showError(error.name === "AbortError" ? "The game configuration request timed out." : error.message);
      });
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
