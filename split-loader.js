(function (root) {
  "use strict";
  var config = root.TBWSplitConfig;
  var launcher = root.TBWSplitLauncher === true;
  function progress(step, message) {
    var label = document.getElementById("status");
    var bar = document.getElementById("startup-progress");
    if (label) { label.hidden = false; label.textContent = message; }
    if (bar) bar.value = step;
  }
  function deadline(promise, milliseconds, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, milliseconds);
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });
    });
  }
  root.TBWSplitReady = (async function () {
    progress(0, "Step 1 of 3: connecting the download worker…");
    if (!config || !config.revision) throw new Error("The split-file configuration is missing.");
    if (!root.isSecureContext || !navigator.serviceWorker)
      throw new Error("Split downloads need HTTPS and a browser that supports service workers. Open this link directly in Safari.");
    if (!root.ReadableStream || !root.crypto || !root.crypto.subtle)
      throw new Error("This browser does not support verified split downloads.");
    var workerURL = new URL("sw.js", document.baseURI).href;
    var registration = await deadline(navigator.serviceWorker.register(workerURL, { updateViaCache: "none" }), 30000,
      "The browser did not finish registering the download worker. Open the link directly in Safari and reload.");
    progress(1, "Step 2 of 3: preparing the game page…");
    var worker = await new Promise(function (resolve, reject) {
      var finished = false;
      var watched = [];
      var candidate = registration.installing || registration.waiting || registration.active;
      var timer = setTimeout(function () { finish(new Error("The download worker did not activate. Reload to try again.")); }, 45000);
      function finish(error, ready) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        registration.removeEventListener("updatefound", watch);
        watched.forEach(function (item) { item.removeEventListener("statechange", check); });
        if (error) reject(error); else resolve(ready);
      }
      function check() {
        if (!candidate) return;
        if (candidate.state === "redundant") finish(new Error("The download worker failed to install. Reload to retry the page files."));
        else if (candidate.state === "activated") finish(null, candidate);
      }
      function watch() {
        candidate = registration.installing || registration.waiting || registration.active || candidate;
        if (candidate && watched.indexOf(candidate) < 0) {
          watched.push(candidate);
          candidate.addEventListener("statechange", check);
        }
        check();
      }
      registration.addEventListener("updatefound", watch);
      watch();
    });
    if (!launcher && (!navigator.serviceWorker.controller || navigator.serviceWorker.controller.scriptURL !== workerURL)) {
      await new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { finish(new Error("The worker is ready, but the browser did not attach it to the game page. Reload this page.")); }, 15000);
        function finish(error) {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("controllerchange", check);
          if (error) reject(error); else resolve();
        }
        function check() {
          var current = navigator.serviceWorker.controller;
          if (current && current.scriptURL === workerURL) finish();
        }
        navigator.serviceWorker.addEventListener("controllerchange", check);
        check();
      });
    }
    progress(2, "Step 3 of 3: checking the asset list…");
    await new Promise(function (resolve, reject) {
      var channel = new MessageChannel();
      var timer = setTimeout(function () {
        channel.port1.close();
        reject(new Error("The download worker did not answer. Reload to try again."));
      }, 15000);
      channel.port1.onmessage = function (event) {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data && event.data.revision === config.revision) resolve();
        else reject(new Error(event.data && event.data.error || "The site has mixed game versions. Open the latest game link."));
      };
      worker.postMessage({ type: "TBW_SPLIT_READY" }, [channel.port2]);
    });
    progress(3, launcher ? "Opening the game…" : "Starting the game…");
  })().catch(function (error) {
    var label = document.getElementById("status");
    if (label) {
      label.hidden = false;
      label.setAttribute("role", "alert");
      label.textContent = "Unable to prepare game downloads. " + error.message;
    }
    var bar = document.getElementById("startup-progress");
    if (bar) bar.hidden = true;
    throw error;
  });
})(window);

navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", function (event) {
  if (event.data && event.data.type === "TBW_SPLIT_ERROR") {
    var label = document.getElementById("scene-status") || document.getElementById("status");
    if (label) {
      label.hidden = false;
      label.setAttribute("role", "alert");
      label.textContent = "Game asset download failed. " + event.data.error + " Reload to retry; verified parts are kept.";
    }
  }
});
