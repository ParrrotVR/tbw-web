(function (root) {
  "use strict";
  var shell = document.getElementById("game-shell");
  var full = document.getElementById("fullscreen");
  var large = document.getElementById("large-view");
  function element() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function update() {
    full.textContent = element() ? "Exit fullscreen" : "Fullscreen";
    large.textContent = document.body.classList.contains("large-view") ? "Exit large view" : "Large view";
    root.dispatchEvent(new Event("resize"));
  }
  function expand(enabled) {
    document.body.classList.toggle("large-view", enabled);
    if (enabled) root.scrollTo(0, 0);
    update();
  }
  full.addEventListener("click", function () {
    if (element()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { var result = exit.call(document); if (result && result.catch) result.catch(update); }
      return;
    }
    expand(true);
    var request = shell.requestFullscreen || shell.webkitRequestFullscreen;
    if (request) {
      try {
        var result = request.call(shell);
        // Large view remains usable if fullscreen is unavailable or denied.
        if (result && result.catch) result.catch(update);
      } catch (_) { update(); }
    }
  });
  large.addEventListener("click", function () {
    var enabled = !document.body.classList.contains("large-view");
    if (!enabled && element()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { var result = exit.call(document); if (result && result.catch) result.catch(function () {}); }
    }
    expand(enabled);
  });
  document.addEventListener("fullscreenchange", update);
  document.addEventListener("webkitfullscreenchange", update);
  if (new URLSearchParams(root.location.search).get("view") === "large") expand(true);
})(window);
