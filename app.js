
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var cfg = window.RAVELITE_CONFIG || {};
  var socket = null;
  var room = null;
  var isHost = false;
  var video = null;
  var hls = null;
  var dash = null;
  var yt = null;
  var historyList = [];

  function base() {
    return String(cfg.serverUrl || "").trim().replace(/\/+$/, "");
  }

  function msg(text) {
    if ($("status")) $("status").textContent = text;
  }

  function roomMsg(text) {
    if ($("roomStatus")) $("roomStatus").textContent = text;
  }

  function connectionMsg(text) {
    if ($("connection")) $("connection").textContent = text;
  }

  function validUrl(raw) {
    try {
      var u = new URL(String(raw || "").trim());
      if (u.protocol === "http:" || u.protocol === "https:") return u;
    } catch (e) {}
    return null;
  }

  function mediaKind(u) {
    var host = u.hostname.toLowerCase();

    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) {
      return "youtube";
    }

    if (host === "drive.google.com" || host === "docs.google.com") {
      return "drive";
    }

    if (/\.m3u8$/i.test(u.pathname)) return "hls";
    if (/\.mpd$/i.test(u.pathname)) return "dash";

    return "direct";
  }

  function cleanupPlayer() {
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }

    if (dash) {
      try { dash.reset(); } catch (e) {}
      dash = null;
    }

    if (yt) {
      try { yt.destroy(); } catch (e) {}
      yt = null;
    }

    video = null;

    if ($("playerArea")) {
      $("playerArea").innerHTML = "";
    }
  }

  function send(eventName, data) {
    data = data || {};

    if (socket && socket.connected && room) {
      data.room = room;
      socket.emit(eventName, data);
    }
  }

  function addHistory(url) {
    historyList = [url].concat(
      historyList.filter(function (item) {
        return item !== url;
      })
    ).slice(0, 8);

    var container = $("history");
    if (!container) return;

    container.innerHTML = "";

    historyList.forEach(function (item) {
      var button = document.createElement("button");
      button.textContent = item;
      button.onclick = function () {
        loadMedia(item);
      };
      container.appendChild(button);
    });
  }

  function driveId(u) {
    var match = u.pathname.match(/\/file\/d\/([^/]+)/);
    return (match && match[1]) || u.searchParams.get("id");
  }

  function youtubeId(u) {
    if (u.hostname.indexOf("youtu.be") !== -1) {
      return u.pathname.split("/").filter(Boolean)[0];
    }

    return u.searchParams.get("v") ||
      ((u.pathname.match(/\/(?:embed|shorts)\/([^/]+)/) || [])[1]);
  }

  function loadMedia(raw, remote) {
    var u = validUrl(raw);

    if (!u) {
      msg("Enter a valid HTTP or HTTPS media URL.");
      return;
    }

    cleanupPlayer();

    if ($("mediaUrl")) $("mediaUrl").value = u.href;

    var kind = mediaKind(u);
    addHistory(u.href);

    if (kind === "drive") {
      var id = driveId(u);

      if (!id) {
        msg("Could not identify the Google Drive file ID.");
        return;
      }

      var frame = document.createElement("iframe");
      frame.src = "https://drive.google.com/file/d/" +
        encodeURIComponent(id) + "/preview";
      frame.title = "Google Drive preview";
      frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;

      $("playerArea").appendChild(frame);

      msg("Google Drive preview loaded if sharing permissions allow playback.");

      if (!remote) send("media:load", { url: u.href, type: kind });
      return;
    }

    if (kind === "youtube") {
      var videoId = youtubeId(u);

      if (!videoId) {
        msg("Could not identify the YouTube video.");
        return;
      }

      var target = document.createElement("div");
      target.id = "ytplayer";
      $("playerArea").appendChild(target);

      function createYouTubePlayer() {
        if (!window.YT || !window.YT.Player) {
          msg("YouTube player API did not load.");
          return;
        }

        yt = new window.YT.Player("ytplayer", {
          width: "100%",
          height: "100%",
          videoId: videoId,
          playerVars: { playsinline: 1, rel: 0 },
          events: {
            onReady: function () {
              msg("YouTube player ready if embedding is permitted.");
            },
            onError: function (event) {
              msg("YouTube playback error: " + event.data);
            },
            onStateChange: function (event) {
              if (!remote && (event.data === 1 || event.data === 2)) {
                send("playback:state", {
                  playing: event.data === 1,
                  time: yt.getCurrentTime(),
                  url: u.href,
                  type: kind
                });
              }
            }
          }
        });
      }

      if (window.YT && window.YT.Player) {
        createYouTubePlayer();
      } else {
        window.onYouTubeIframeAPIReady = createYouTubePlayer;
      }

      msg("Loading YouTube player…");

      if (!remote) send("media:load", { url: u.href, type: kind });
      return;
    }

    var player = document.createElement("video");
    player.controls = true;
    player.playsInline = true;
    player.preload = "metadata";
    player.crossOrigin = "anonymous";
    video = player;

    $("playerArea").appendChild(player);

    player.onerror = function () {
      msg("Playback failed. Check the media URL, CORS, format and stream permissions.");
    };

    player.onloadedmetadata = function () {
      msg(kind.toUpperCase() + " media loaded.");
    };

    player.onplay = function () {
      if (!remote) {
        send("playback:state", {
          playing: true,
          time: player.currentTime,
          url: u.href,
          type: kind
        });
      }
    };

    player.onpause = function () {
      if (!remote) {
        send("playback:state", {
          playing: false,
          time: player.currentTime,
          url: u.href,
          type: kind
        });
      }
    };

    if (kind === "hls") {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(u.href);
        hls.attachMedia(player);

        hls.on(window.Hls.Events.ERROR, function (event, data) {
          if (data && data.fatal) {
            msg("HLS failed. Check stream validity and CORS.");
          }
        });
      } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
        player.src = u.href;
      } else {
        msg("HLS is not supported in this browser.");
        return;
      }
    } else if (kind === "dash") {
      if (!window.dashjs) {
        msg("DASH player library did not load.");
        return;
      }

      dash = window.dashjs.MediaPlayer().create();
      dash.initialize(player, u.href, false);
      dash.on(window.dashjs.MediaPlayer.events.ERROR, function () {
        msg("DASH playback failed. Check the stream and codecs.");
      });
    } else {
      player.src = u.href;
    }

    msg("Loading " + kind + " media…");

    if (!remote) send("media:load", { url: u.href, type: kind });
  }

  function currentTime() {
    try {
      if (yt) return yt.getCurrentTime();
      if (video) return video.currentTime || 0;
    } catch (e) {}

    return 0;
  }

  function applyPlayback(state) {
    if (!state) return;

    var targetTime = Number(state.time) || 0;
    var drift = Math.abs(currentTime() - targetTime);

    if (yt) {
      try {
        if (drift > 2) yt.seekTo(targetTime, true);
        if (state.playing) yt.playVideo();
        else yt.pauseVideo();
      } catch (e) {}
      return;
    }

    if (video) {
      if (drift > 2) {
        try { video.currentTime = targetTime; } catch (e) {}
      }

      if (state.playing) {
        var result = video.play();

        if (result && result.catch) {
          result.catch(function () {
            msg("Tap Play in the video controls, then try Sync.");
          });
        }
      } else {
        video.pause();
      }
    }
  }

  function updateParticipants(list) {
    if (!$("participants")) return;

    $("participants").textContent = (list || []).map(function (person) {
      return person.name + (person.isHost ? " · host" : "");
    }).join(" · ") || "None";
  }

  function addChatMessage(message) {
    var log = $("chatLog");
    if (!log) return;

    if (log.textContent === "Join a room to chat.") {
      log.textContent = "";
    }

    var line = document.createElement("div");
    line.textContent = (message.name || "Guest") + ": " + message.text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function connect() {
    if (!base()) {
      connectionMsg("Backend URL missing in config.js");
      return;
    }

    if (!window.io) {
      connectionMsg("Socket.IO library failed to load");
      return;
    }

    try {
      socket = window.io(base());

      socket.on("connect", function () {
        connectionMsg("Connected");
        if (room) {
          socket.emit("room:join", {
            room: room,
            name: $("displayName") ? $("displayName").value : "Guest"
          });
        }
      });

      socket.on("disconnect", function () {
        connectionMsg("Disconnected — reconnecting…");
      });

      socket.on("connect_error", function (error) {
        connectionMsg("Backend connection failed");
        console.error("RaveLite Socket.IO error:", error);
      });

      socket.on("room:error", function (data) {
        roomMsg(data && data.message ? data.message : "Room error.");
      });

      socket.on("room:joined", function (data) {
        room = data.room;
        isHost = !!data.isHost;

        if ($("roomCode")) $("roomCode").value = room;

        roomMsg("Joined " + room + (isHost ? " as host" : ""));
        updateParticipants(data.participants || []);

        if (data.media && data.media.url) {
          loadMedia(data.media.url, true);
        }
      });

      socket.on("room:participants", updateParticipants);
      socket.on("chat:message", addChatMessage);

      socket.on("media:load", function (data) {
        if (data && data.url) loadMedia(data.url, true);
      });

      socket.on("playback:state", applyPlayback);
    } catch (error) {
      connectionMsg("Connection setup failed");
      console.error("RaveLite setup error:", error);
    }
  }

  function createRoom() {
    if (!socket || !socket.connected) {
      roomMsg("Backend is not connected. Check config.js and Render.");
      return;
    }

    socket.emit("room:create", {
      name: $("displayName") ? $("displayName").value : "Guest"
    });
  }

  function joinRoom() {
    if (!socket || !socket.connected) {
      roomMsg("Backend is not connected. Check config.js and Render.");
      return;
    }

    socket.emit("room:join", {
      room: $("roomCode").value.trim().toUpperCase(),
      name: $("displayName") ? $("displayName").value : "Guest"
    });
  }

  if ($("loadBtn")) {
    $("loadBtn").onclick = function () {
      loadMedia($("mediaUrl").value);
    };
  }

  if ($("mediaUrl")) {
    $("mediaUrl").onkeydown = function (event) {
      if (event.key === "Enter") loadMedia(event.target.value);
    };
  }

  if ($("openBtn")) {
    $("openBtn").onclick = function () {
      var u = validUrl($("mediaUrl").value);
      if (u) window.open(u.href, "_blank", "noopener,noreferrer");
    };
  }

  if ($("createBtn")) $("createBtn").onclick = createRoom;
  if ($("joinBtn")) $("joinBtn").onclick = joinRoom;

  if ($("leaveBtn")) {
    $("leaveBtn").onclick = function () {
      send("room:leave");
      room = null;
      roomMsg("Left room.");
    };
  }

  if ($("copyBtn")) {
    $("copyBtn").onclick = function () {
      if (!room) {
        roomMsg("Join a room first.");
        return;
      }

      var invite = new URL(window.location.href);
      invite.searchParams.set("room", room);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(invite.href).then(function () {
          roomMsg("Invite copied.");
        }).catch(function () {
          roomMsg(invite.href);
        });
      } else {
        roomMsg(invite.href);
      }
    };
  }

  if ($("sendBtn")) {
    $("sendBtn").onclick = function () {
      var input = $("chatInput");
      var text = input ? input.value.trim() : "";

      if (text && room && socket && socket.connected) {
        send("chat:send", { text: text });
        input.value = "";
      } else {
        roomMsg("Join a connected room to chat.");
      }
    };
  }

  if ($("chatInput")) {
    $("chatInput").onkeydown = function (event) {
      if (event.key === "Enter" && $("sendBtn")) {
        $("sendBtn").click();
      }
    };
  }

  if ($("playBtn")) {
    $("playBtn").onclick = function () {
      if (yt) {
        yt.playVideo();
      } else if (video) {
        var result = video.play();
        if (result && result.catch) {
          result.catch(function () {
            msg("Tap Play in the video controls.");
          });
        }
      } else {
        msg("Load a video first.");
      }
    };
  }

  if ($("pauseBtn")) {
    $("pauseBtn").onclick = function () {
      if (yt) yt.pauseVideo();
      else if (video) video.pause();
    };
  }

  if ($("syncBtn")) {
    $("syncBtn").onclick = function () {
      if (room && socket && socket.connected) {
        send("playback:request");
      } else {
        msg("Join a connected room first.");
      }
    };
  }

  if ($("pipBtn")) {
    $("pipBtn").onclick = function () {
      if (video && document.pictureInPictureEnabled &&
          video.requestPictureInPicture) {
        video.requestPictureInPicture().catch(function () {
          msg("Picture-in-picture is unavailable.");
        });
      } else {
        msg("Picture-in-picture is not supported for this player.");
      }
    };
  }

  if ($("clearHistory")) {
    $("clearHistory").onclick = function () {
      historyList = [];
      if ($("history")) $("history").textContent = "History cleared.";
    };
  }

  if ($("convertBtn")) {
    $("convertBtn").onclick = async function () {
      var fileInput = $("uploadFile");
      var file = fileInput && fileInput.files ? fileInput.files[0] : null;

      if (!file) {
        $("convertStatus").textContent = "Choose a file first.";
        return;
      }

      if (!base()) {
        $("convertStatus").textContent = "Backend URL missing in config.js.";
        return;
      }

      var form = new FormData();
      form.append("video", file);

      $("convertStatus").textContent = "Uploading and converting…";

      try {
        var response = await fetch(base() + "/api/convert", {
          method: "POST",
          body: form
        });

        var data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Conversion failed.");
        }

        loadMedia(data.url);
        $("convertStatus").textContent =
          "Conversion finished. Temporary output may expire.";
      } catch (error) {
        $("convertStatus").textContent =
          "Conversion failed: " + error.message;
      }
    };
  }

  var params = new URLSearchParams(window.location.search);
  var roomFromUrl = params.get("room");

  if (roomFromUrl && $("roomCode")) {
    $("roomCode").value = roomFromUrl;
  }

  connectionMsg("Starting connection…");
  connect();
})();ive preview";

      $("playerArea").append(f);

      msg(
        "Drive preview only. It can fail while processing, " +
        "due to permissions or playback limits; it cannot " +
        "be synchronized reliably."
      );

      if (!remote) {
        send("media:load", {
          url: u.href,
          type: k
        });
      }

      return;
    }

    /*
     * YOUTUBE
     */
    if (k === "youtube") {
      const id = ytID(u);

      if (!id) {
        msg("Could not identify YouTube video.");
        return;
      }

      const d = document.createElement("div");
      d.id = "ytplayer";

      $("playerArea").append(d);

      const create = () => {
        yt = new YT.Player("ytplayer", {
          width: "100%",
          height: "100%",
          videoId: id,

          playerVars: {
            playsinline: 1,
            rel: 0,
            controls: 1
          },

          events: {
            onReady: () => {
              msg(
                "YouTube embed ready if the owner permits embedding."
              );
            },

            onError: e => {
              msg(
                "YouTube declined embedding/playback " +
                "(error " + e.data + ")."
              );
            },

            onStateChange: e => {
              if (!remote && (e.data === 1 || e.data === 2)) {
                send("playback:state", {
                  playing: e.data === 1,
                  time: yt.getCurrentTime(),
                  url: u.href,
                  type: k
                });
              }
            }
          }
        });
      };

      if (window.YT?.Player) {
        create();
      } else {
        window.onYouTubeIframeAPIReady = create;
      }

      msg("Loading YouTube player…");

      if (!remote) {
        send("media:load", {
          url: u.href,
          type: k
        });
      }

      return;
    }

    /*
     * DIRECT / HLS / DASH VIDEO
     */
    const v = createVideoPlayer();

    video = v;

    v.onerror = () => {
      msg(
        "Playback failed. Check direct URL, CORS, permissions, " +
        "MIME type, codecs and stream segments."
      );
    };

    v.onloadedmetadata = () => {
      msg(k.toUpperCase() + " media loaded.");
    };

    /*
     * HLS
     */
    if (k === "hls") {
      if (window.Hls?.isSupported()) {
        hls = new Hls();

        hls.loadSource(u.href);
        hls.attachMedia(v);

        hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal) {
            msg(
              "HLS failed. Verify manifest/segment CORS " +
              "and stream validity."
            );
          }
        });

      } else if (
        v.canPlayType("application/vnd.apple.mpegurl")
      ) {
        v.src = u.href;

      } else {
        msg("HLS unsupported in this browser.");
        return;
      }

    /*
     * DASH
     */
    } else if (k === "dash") {

      if (!window.dashjs) {
        msg("DASH library failed to load.");
        return;
      }

      dash = dashjs.MediaPlayer().create();

      dash.initialize(
        v,
        u.href,
        false
      );

      dash.on(
        dashjs.MediaPlayer.events.ERROR,
        () => {
          msg(
            "DASH failed. Check manifest, CORS, codecs and DRM."
          );
        }
      );

    /*
     * DIRECT MP4/WebM/etc.
     */
    } else {
      v.src = u.href;
    }

    msg("Loading " + k + "…");

    if (!remote) {
      send("media:load", {
        url: u.href,
        type: k
      });
    }
  }

  function now() {
    try {
      if (yt) {
        return yt.getCurrentTime();
      }

      return video?.currentTime || 0;
    } catch {
      return 0;
    }
  }

  function apply(p) {
    if (!p) return;

    const targetTime = Number(p.time || 0);
    const drift = Math.abs(now() - targetTime);

    if (yt) {
      try {
        window.__raveliteRemotePlayback = true;

        if (drift > 2) {
          yt.seekTo(targetTime, true);
        }

        if (p.playing) {
          yt.playVideo();
        } else {
          yt.pauseVideo();
        }
      } catch {}

      return;
    }

    if (video) {
      window.__raveliteRemotePlayback = true;

      if (drift > 2) {
        try {
          video.currentTime = targetTime;
        } catch {}
      }

      if (p.playing) {
        video.play().catch(() => {
          msg(
            "Tap Play once to enable playback, " +
            "then Sync to host."
          );
        });
      } else {
        video.pause();
      }
    }
  }

  function people(list) {
    $("participants").textContent =
      list
        .map(p =>
          p.name + (p.isHost ? " · host" : "")
        )
        .join(" · ") || "None";
  }

  function chat(m) {
    const el = $("chatLog");

    if (el.textContent === "Join a room to chat.") {
      el.textContent = "";
    }

    const d = document.createElement("div");

    d.textContent =
      (m.name || "Guest") + ": " + m.text;

    el.append(d);
    el.scrollTop = el.scrollHeight;
  }

  function connect() {
    if (!base()) {
      $("connection").textContent = "Local-only mode";
      return;
    }

    if (!window.io) return;

    socket = io(base());

    socket.on("connect", () => {
      $("connection").textContent = "Connected";

      if (room) {
        socket.emit("room:join", {
          room,
          name: $("displayName").value
        });
      }
    });

    socket.on(
      "disconnect",
      () => {
        $("connection").textContent = "Reconnecting…";
      }
    );

    socket.on(
      "connect_error",
      () => {
        $("connection").textContent = "Backend unavailable";
      }
    );

    socket.on(
      "room:error",
      d => roomMsg(d.message)
    );

    socket.on("room:joined", d => {
      room = d.room;
      isHost = d.isHost;

      $("roomCode").value = room;

      roomMsg(
        "Joined " +
        room +
        (isHost ? " as host" : "")
      );

      people(d.participants || []);

      if (d.media?.url) {
        load(d.media.url, true);
      }
    });

    socket.on(
      "room:participants",
      people
    );

    socket.on(
      "chat:message",
      chat
    );

    socket.on(
      "media:load",
      d => load(d.url, true)
    );

    socket.on(
      "playback:state",
      apply
    );
  }

  function create() {
    if (!socket?.connected) {
      roomMsg(
        "Deploy backend and set config.js serverUrl first."
      );
      return;
    }

    socket.emit("room:create", {
      name: $("displayName").value
    });
  }

  function join() {
    if (!socket?.connected) {
      roomMsg(
        "Backend not connected. Configure config.js."
      );
      return;
    }

    socket.emit("room:join", {
      room: $("roomCode")
        .value
        .trim()
        .toUpperCase(),

      name: $("displayName").value
    });
  }

  /*
   * BUTTONS
   */

  $("loadBtn").onclick = () =>
    load($("mediaUrl").value);

  $("mediaUrl").onkeydown = e => {
    if (e.key === "Enter") {
      load(e.target.value);
    }
  };

  $("openBtn").onclick = () => {
    const u = url($("mediaUrl").value);

    if (u) {
      open(
        u.href,
        "_blank",
        "noopener,noreferrer"
      );
    }
  };

  $("createBtn").onclick = create;
  $("joinBtn").onclick = join;

  $("leaveBtn").onclick = () => {
    send("room:leave");

    room = null;

    roomMsg("Left room.");
  };

  $("copyBtn").onclick = async () => {
    if (!room) {
      roomMsg("Join a room first.");
      return;
    }

    const u = new URL(location.href);

    u.searchParams.set("room", room);

    try {
      await navigator.clipboard.writeText(u.href);

      roomMsg("Invite copied.");
    } catch {
      roomMsg(u.href);
    }
  };

  $("sendBtn").onclick = () => {
    const text = $("chatInput")
      .value
      .trim();

    if (
      text &&
      room &&
      socket?.connected
    ) {
      send("chat:send", { text });

      $("chatInput").value = "";
    } else {
      roomMsg("Join a live room to chat.");
    }
  };

  $("chatInput").onkeydown = e => {
    if (e.key === "Enter") {
      $("sendBtn").click();
    }
  };

  /*
   * EXISTING EXTERNAL PLAY BUTTON
   */
  $("playBtn").onclick = () => {
    if (yt) {
      yt.playVideo();
      return;
    }

    if (video) {
      video.play().catch(() => {
        msg(
          "Tap Play once to enable playback."
        );
      });

      return;
    }

    msg(
      "Drive controls are inside its preview."
    );
  };

  /*
   * EXISTING EXTERNAL PAUSE BUTTON
   */
  $("pauseBtn").onclick = () => {
    if (yt) {
      yt.pauseVideo();
      return;
    }

    if (video) {
      video.pause();
    }
  };

  /*
   * SYNC
   */
  $("syncBtn").onclick = () => {
    if (
      room &&
      socket?.connected
    ) {
      send("playback:request");
    } else {
      msg(
        "Join a connected room first."
      );
    }
  };

  /*
   * PICTURE IN PICTURE
   */
  $("pipBtn").onclick = () => {
    if (!video) {
      msg(
        "Picture-in-picture is available for direct video players."
      );
      return;
    }

    if (
      document.pictureInPictureEnabled &&
      !video.disablePictureInPicture
    ) {
      video
        .requestPictureInPicture()
        .catch(() =>
          msg("PiP unavailable.")
        );
    } else {
      msg(
        "PiP unsupported for this player."
      );
    }
  };

  /*
   * HISTORY
   */
  $("clearHistory").onclick = () => {
    $("history").textContent =
      "History cleared.";

    history = [];
  };

  /*
   * CONVERSION
   */
  $("convertBtn").onclick = async () => {
    const f =
      $("uploadFile").files[0];

    if (!f) {
      $("convertStatus").textContent =
        "Choose a file.";
      return;
    }

    if (!base()) {
      $("convertStatus").textContent =
        "Backend URL missing in config.js.";
      return;
    }

    const form = new FormData();

    form.append("video", f);

    $("convertStatus").textContent =
      "Uploading and converting…";

    try {
      const r = await fetch(
        base() + "/api/convert",
        {
          method: "POST",
          body: form
        }
      );

      const d = await r.json();

      if (!r.ok) {
        throw Error(
          d.error || "Conversion failed"
        );
      }

      load(d.url);

      $("convertStatus").textContent =
        "Conversion finished. Temporary output expires in 30 minutes.";

    } catch (e) {
      $("convertStatus").textContent =
        "Conversion failed: " +
        e.message;
    }
  };

  /*
   * ROOM FROM URL
   */
  const r =
    new URLSearchParams(location.search)
      .get("room");

  if (r) {
    $("roomCode").value = r;
  }

  connect();
})();
```
