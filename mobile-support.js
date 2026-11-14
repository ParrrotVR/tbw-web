(function (root) {
  "use strict";
  if (!root.TBWMobile || !root.UnityLoader) return;

  var original = root.UnityLoader.instantiate;
  root.UnityLoader.instantiate = function (id, url, options) {
    options = options || {};
    options.Module = options.Module || {};
    // Unity 2019's mouse coordinates and canvas must share one CSS-pixel space.
    options.Module.devicePixelRatio = 1;
    var previousProgress = options.onProgress;
    options.onProgress = function (instance, progress) {
      attach(id, instance);
      if (previousProgress) previousProgress(instance, progress);
    };
    var instance = original.call(this, id, url, options);
    attach(id, instance);
    return instance;
  };

  function attach(id, instance) {
    var container = document.getElementById(id);
    var module = instance && instance.Module;
    var canvas = module && module.canvas || container.querySelector("canvas");
    if (!canvas || canvas.TBWTouchAttached) return;
    canvas.TBWTouchAttached = true;
    canvas.tabIndex = 0;
    canvas.style.touchAction = "none";
    canvas.style.webkitUserSelect = "none";
    canvas.style.imageRendering = "auto";

    var panel = document.createElement("div");
    panel.id = "mobile-controls";
    var right = document.createElement("button");
    right.type = "button";
    right.textContent = "Right-click next tap";
    right.setAttribute("aria-pressed", "false");
    panel.appendChild(right);
    var hint = document.createElement("span");
    hint.textContent = " Tap to select or press buttons. Drag to move the pointer.";
    panel.appendChild(hint);
    document.getElementById("game-toolbar").appendChild(panel);
    var nextButton = 0;
    right.addEventListener("click", function () {
      nextButton = nextButton === 2 ? 0 : 2;
      right.textContent = nextButton ? "Next tap: right click" : "Right-click next tap";
      right.setAttribute("aria-pressed", nextButton ? "true" : "false");
    });

    var queued = false;
    function resize() {
      queued = false;
      var viewport = root.visualViewport;
      var width = viewport ? viewport.width : root.innerWidth;
      var height = viewport ? viewport.height : root.innerHeight;
      var expanded = document.body.classList.contains("large-view") || document.fullscreenElement || document.webkitFullscreenElement;
      var toolbar = document.getElementById("game-toolbar");
      var reserve = expanded ? Math.max(50, toolbar.getBoundingClientRect().height + 12) : 200;
      var w = Math.max(160, Math.floor(Math.min(1280, width - 8, Math.max(100, height - reserve) * 1.6)));
      var h = Math.max(100, Math.round(w / 1.6));
      container.style.width = w + "px";
      container.style.height = h + "px";
      canvas.style.setProperty("width", "100%", "important");
      canvas.style.setProperty("height", "100%", "important");
      module = instance.Module;
      if (module && module.calledRun && typeof module.setCanvasSize === "function" &&
          (canvas.width !== w || canvas.height !== h)) module.setCanvasSize(w, h);
    }
    function scheduleResize() {
      if (!queued) { queued = true; root.requestAnimationFrame(resize); }
    }
    root.addEventListener("resize", scheduleResize);
    if (root.visualViewport) root.visualViewport.addEventListener("resize", scheduleResize);
    var sizeObserver = new MutationObserver(scheduleResize);
    sizeObserver.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    resize();
    // The engine exports setCanvasSize after the initial download/initialization.
    var startupSize = root.setInterval(function () {
      resize();
      if (instance.Module && instance.Module.calledRun) root.clearInterval(startupSize);
    }, 500);

    var active = null;
    var releaseTimer = null;
    var pendingRelease = null;
    function mouse(type, state, pressed) {
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: root,
        clientX: state.x, clientY: state.y,
        screenX: state.x, screenY: state.y,
        button: state.button, buttons: pressed ? (state.button === 2 ? 2 : 1) : 0,
        movementX: state.dx || 0, movementY: state.dy || 0
      }));
    }
    function release() {
      root.clearTimeout(releaseTimer);
      if (pendingRelease) mouse("mouseup", pendingRelease, false);
      pendingRelease = null;
    }
    function applies(event) { return event.target === canvas; }
    root.addEventListener("touchstart", function (event) {
      if (!applies(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (active || !event.changedTouches.length) return;
      release();
      var touch = event.changedTouches[0];
      active = { id: touch.identifier, x: touch.clientX, y: touch.clientY, button: nextButton, began: Date.now() };
      try { canvas.focus({ preventScroll: true }); } catch (_) { canvas.focus(); }
      mouse("mousemove", active, false);
      mouse("mousedown", active, true);
    }, { capture: true, passive: false });
    root.addEventListener("touchmove", function (event) {
      if (!applies(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!active) return;
      for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        if (touch.identifier !== active.id) continue;
        active.dx = touch.clientX - active.x; active.dy = touch.clientY - active.y;
        active.x = touch.clientX; active.y = touch.clientY;
        mouse("mousemove", active, true);
      }
    }, { capture: true, passive: false });
    function end(event) {
      if (!applies(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!active) return;
      for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        if (touch.identifier !== active.id) continue;
        active.x = touch.clientX; active.y = touch.clientY;
        mouse("mousemove", active, true);
        pendingRelease = active; active = null;
        releaseTimer = root.setTimeout(release, Math.max(0, 100 - (Date.now() - pendingRelease.began)));
        nextButton = 0;
        right.textContent = "Right-click next tap";
        right.setAttribute("aria-pressed", "false");
        break;
      }
    }
    root.addEventListener("touchend", end, { capture: true, passive: false });
    root.addEventListener("touchcancel", end, { capture: true, passive: false });
    canvas.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    root.addEventListener("blur", function () {
      if (active) { pendingRelease = active; active = null; }
      release();
    });
  }
})(window);
