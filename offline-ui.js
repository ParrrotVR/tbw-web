(function (root) {
  "use strict";
  var query = new URLSearchParams(root.location.search);
  root.TBWMobile = query.get("mobile") === "1" || (query.get("mobile") !== "0" &&
    (/iPad|iPhone|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)));
  var button = document.getElementById("offline-download");
  var label = document.getElementById("offline-status");
  if (!navigator.serviceWorker || !root.isSecureContext) {
    label.textContent = "Offline storage needs HTTPS hosting. Online play is available.";
    root.TBWOfflineReady = Promise.resolve();
    return;
  }
  root.TBWOfflineReady = navigator.serviceWorker.register("sw.js", {updateViaCache: "none"})
    .then(function () { return navigator.serviceWorker.ready; })
    .then(function () {
      return new Promise(function (resolve) {
        if (navigator.serviceWorker.controller) { resolve(); return; }
        var done = function () { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", done); resolve(); };
        var timer = setTimeout(done, 8000);
        navigator.serviceWorker.addEventListener("controllerchange", done);
      });
    }).then(function () {
      if (!navigator.serviceWorker.controller) throw new Error("Offline storage is not active yet. Reload to enable it.");
      button.disabled = false;
      label.textContent = "Scenes are saved as you play. Download the full game to play every scene offline.";
      return fetch("offline-manifest.json").then(function (response) {
        if (!response.ok) return;
        return response.json().then(function (manifest) {
          var mb = Math.ceil(manifest.files.reduce(function (sum, file) { return sum + file.bytes; }, 0) / 1048576);
          button.textContent = "Download full game for offline play (about " + mb + " MB)";
        });
      }).catch(function () {});
    }).catch(function (error) {
      label.textContent = "Offline storage unavailable: " + error.message + " Online play is available.";
    });
  var startupTimer;
  root.TBWOfflineReady = Promise.race([root.TBWOfflineReady, new Promise(function (resolve) {
    startupTimer = setTimeout(function () {
      label.textContent = "Offline storage is taking too long. Starting online play.";
      resolve();
    }, 10000);
  })]).then(function () { clearTimeout(startupTimer); });
  button.addEventListener("click", function () {
    if (!navigator.serviceWorker.controller) return;
    button.disabled = true;
    label.textContent = "Preparing offline downloadâ€¦";
    var persistence = navigator.storage && navigator.storage.persist ? navigator.storage.persist().catch(function () { return false; }) : Promise.resolve(false);
    persistence.then(function () {
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) {
        var data = event.data;
        if (data.error) { label.textContent = data.error; button.disabled = false; channel.port1.close(); }
        else if (data.complete) { label.textContent = "Full game downloaded for offline play. Browser storage can still be cleared by the device or its owner."; channel.port1.close(); }
        else label.textContent = "Saving for offline play: " + Math.floor(data.done / 1048576) + " / " + Math.ceil(data.total / 1048576) + " MB. Keep this page open.";
      };
      navigator.serviceWorker.controller.postMessage({type: "CACHE_ALL"}, [channel.port2]);
    });
  });
})(window);
