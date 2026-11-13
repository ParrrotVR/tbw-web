(function (root) {
  "use strict";
  var state = null;
  var status = document.getElementById("save-status");
  var saveButton = document.getElementById("save-now");
  var downloadButton = document.getElementById("save-download");
  var restoreButton = document.getElementById("save-restore");
  var picker = document.getElementById("save-file");
  function message(text, error) {
    status.textContent = text;
    status.setAttribute("role", error ? "alert" : "status");
  }
  function ready() { return state && state.module.calledRun && state.module.indexedDB; }
  function flush(done) {
    if (!ready()) { done(new Error("Saving is unavailable. Use a normal Safari tab with website storage enabled.")); return; }
    root.clearTimeout(state.timer);
    state.fs.syncfs(false, done);
  }
  root.TBWSaves = {
    attach: function (module, fs) {
      if (module.TBWStorageAttached) return;
      module.TBWStorageAttached = true;
      module.TBWFileSystem = fs;
      state = { module: module, fs: fs, version: 0, saved: 0, timer: null, root: null, restoring: false };
      var queue = [], running = false;
      var originalSync = fs.syncfs;
      function drain() {
        if (running || !queue.length) return;
        running = true;
        var job = queue.shift(), version = state.version;
        var finished = false;
        function complete(error) {
          if (finished) return;
          finished = true;
          running = false;
          if (error) message("Could not save on this device: " + (error.message || error), true);
          else if (!job.populate && module.calledRun) {
            state.saved = Math.max(state.saved, version);
            message(state.saved === state.version ? "Progress saved on this device." : "Saving progress…");
          }
          try { if (job.callback) job.callback(error); }
          finally { drain(); }
        }
        try { originalSync.call(fs, job.populate, complete); }
        catch (error) { complete(error); }
      }
      // Serialize our requests with Unity's own IDBFS syncs, including initial restore.
      fs.syncfs = function (populate, callback) {
        if (typeof populate === "function") { callback = populate; populate = false; }
        queue.push({ populate: !!populate, callback: callback });
        drain();
      };
      function changed(path) {
        if (typeof path !== "string" || path.indexOf("/idbfs/") !== 0) return;
        var part = path.indexOf("/SaveData");
        if (part >= 0 && (path.length === part + 9 || path.charAt(part + 9) === "/"))
          state.root = path.substring(0, part + 9);
        if (!module.calledRun || state.restoring) return;
        state.version++;
        message("Saving progress…");
        root.clearTimeout(state.timer);
        state.timer = root.setTimeout(function () { flush(function () {}); }, 700);
      }
      var close = fs.close;
      fs.close = function (stream) {
        var path = stream.path, writable = (stream.flags & 3) !== 0;
        var result = close.apply(fs, arguments);
        if (writable) changed(path);
        return result;
      };
      ["mkdir", "unlink", "rmdir", "rename", "truncate"].forEach(function (name) {
        var original = fs[name];
        fs[name] = function () {
          var result = original.apply(fs, arguments);
          for (var i = 0; i < arguments.length; i++) changed(arguments[i]);
          return result;
        };
      });
      var startup = root.setInterval(function () {
        if (!module.calledRun) return;
        root.clearInterval(startup);
        saveButton.disabled = downloadButton.disabled = restoreButton.disabled = !module.indexedDB;
        if (!module.indexedDB) message("Website storage is unavailable; progress cannot be kept here.", true);
        else if (state.saved < state.version) flush(function () {});
        else message("Local saving ready. Progress is kept at this site address.");
      }, 500);
    }
  };

  function saveNow(done) {
    if (!ready()) { flush(done); return; }
    try {
      var sceneStatus = document.getElementById("scene-status");
      if (sceneStatus && !sceneStatus.hidden) throw new Error("Wait for the scene to finish loading before saving.");
      message("Saving progress…");
      root.unityInstance.SendMessage("Save Manager", "SaveProgressData");
      // Turn checkpoints continue to be created by the game's existing autosave.
      flush(done);
    } catch (error) { done(error); }
  }
  saveButton.addEventListener("click", function () {
    saveButton.disabled = true;
    saveNow(function (error) {
      saveButton.disabled = false;
      if (error) message(error.message, true);
    });
  });
  function saveRoot() {
    if (state.root) return state.root;
    var fs = state.fs;
    var children = fs.readdir("/idbfs");
    for (var i = 0; i < children.length; i++) {
      if (children[i] === "." || children[i] === "..") continue;
      var path = "/idbfs/" + children[i] + "/SaveData";
      try { if (fs.isDir(fs.stat(path).mode)) return (state.root = path); } catch (_) {}
    }
    throw new Error("No game save has been created yet.");
  }
  function encode(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i += 8192)
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return root.btoa(text);
  }
  function filesIn(path, prefix, output) {
    var fs = state.fs;
    fs.readdir(path).forEach(function (name) {
      if (name === "." || name === "..") return;
      var child = path + "/" + name, relative = prefix + name;
      if (fs.isDir(fs.stat(child).mode)) filesIn(child, relative + "/", output);
      else output.push({ path: relative, data: encode(fs.readFile(child)) });
    });
  }
  downloadButton.addEventListener("click", function () {
    saveNow(function (error) {
      if (error) { message(error.message, true); return; }
      try {
        var files = [];
        filesIn(saveRoot(), "", files);
        var backup = { format: "tbw-save-v1", created: new Date().toISOString(), files: files };
        var url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
        var link = document.createElement("a");
        link.href = url; link.download = "tbw-save-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(link); link.click(); link.remove();
        root.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        message("Save backup downloaded. Keep it somewhere safe.");
      } catch (failure) { message(failure.message, true); }
    });
  });
  restoreButton.addEventListener("click", function () { picker.click(); });
  picker.addEventListener("change", function () {
    var file = picker.files[0];
    picker.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { message("The backup could not be read.", true); };
    reader.onload = function () {
      try {
        var backup = JSON.parse(reader.result);
        if (backup.format !== "tbw-save-v1" || !Array.isArray(backup.files) || !backup.files.length)
          throw new Error("This is not a Tactical Breach Wizards save backup.");
        var seen = Object.create(null);
        var files = backup.files.map(function (entry) {
          if (typeof entry.path !== "string" || !entry.path || entry.path.indexOf("\\") >= 0 ||
              entry.path.indexOf("\0") >= 0 || entry.path.split("/").some(function (p) { return !p || p === "." || p === ".."; }) || seen[entry.path])
            throw new Error("The backup contains an invalid file path.");
          seen[entry.path] = true;
          var binary = root.atob(entry.data), bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return { path: entry.path, bytes: bytes };
        });
        if (!root.confirm("Restore this save and reload the game? A copy of the current save will be kept on this device.")) return;
        flush(function (error) {
          if (error) { message(error.message, true); return; }
          var fs = state.fs, directory = saveRoot(), previous = directory + ".before-restore-" + Date.now();
          state.restoring = true;
          if (state.module.pauseMainLoop) state.module.pauseMainLoop();
          try {
            fs.rename(directory, previous);
            fs.mkdirTree(directory);
            files.forEach(function (entry) {
              var path = directory + "/" + entry.path;
              fs.mkdirTree(path.substring(0, path.lastIndexOf("/")));
              fs.writeFile(path, entry.bytes);
            });
            fs.syncfs(false, function (failure) {
              if (failure) rollback(failure);
              else { message("Backup restored. Reloading…"); root.location.reload(); }
            });
          } catch (failure) { rollback(failure); }
          function rollback(failure) {
            // Keep both trees: return the original to the game's expected location.
            try { fs.rename(directory, directory + ".failed-restore-" + Date.now()); } catch (_) {}
            try { fs.rename(previous, directory); } catch (_) {}
            state.restoring = false;
            fs.syncfs(false, function () {});
            if (state.module.resumeMainLoop) state.module.resumeMainLoop();
            message("Restore failed; the previous save was retained. " + (failure.message || failure), true);
          }
        });
      } catch (error) { message(error.message, true); }
    };
    reader.readAsText(file);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && ready()) flush(function () {});
  });
  root.addEventListener("pagehide", function () { if (ready()) flush(function () {}); });
})(window);
