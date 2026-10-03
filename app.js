```javascript
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const cfg = window.RAVELITE_CONFIG || {};

  let socket = null;
  let room = null;
  let isHost = false;
  let video = null;
  let hls = null;
  let dash = null;
  let yt = null;
  let history = [];
  let currentMediaUrl = "";
  let currentMediaType = "";
  let controlsTimer = null;

  const base = () => String(cfg.serverUrl || "").trim().replace(/\/+$/, "");

  function msg(s) {
    $("status").textContent = s;
  }

  function roomMsg(s) {
    $("roomStatus").textContent = s;
  }

  function url(raw) {
    try {
      const u = new URL(String(raw || "").trim());
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch {
      return null;
    }
  }

  function kind(u) {
    const h = u.hostname.toLowerCase();

    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h))
      return "youtube";

    if (h === "drive.google.com" || h === "docs.google.com")
      return "drive";

    if (/\.m3u8$/i.test(u.pathname))
      return "hls";

    if (/\.mpd$/i.test(u.pathname))
      return "dash";

    return "direct";
  }

  function clean() {
    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (dash) {
      dash.reset();
      dash = null;
    }

    if (yt) {
      try {
        yt.destroy();
      } catch {}
      yt = null;
    }

    video = null;
    currentMediaUrl = "";
    currentMediaType = "";
    clearTimeout(controlsTimer);

    $("playerArea").replaceChildren();
  }

  function send(ev, data = {}) {
    if (socket?.connected && room) {
      socket.emit(ev, { room, ...data });
    }
  }

  function hist(u) {
    history = [u, ...history.filter(x => x !== u)].slice(0, 8);

    $("history").replaceChildren();

    history.forEach(x => {
      const b = document.createElement("button");
      b.textContent = x;
      b.onclick = () => load(x);
      $("history").append(b);
    });
  }

  function driveID(u) {
    return u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ||
      u.searchParams.get("id");
  }

  function ytID(u) {
    return u.hostname.includes("youtu.be")
      ? u.pathname.split("/").filter(Boolean)[0]
      : u.searchParams.get("v") ||
        u.pathname.match(/\/(?:embed|shorts)\/([^/]+)/)?.[1];
  }

  /*
   * CUSTOM VIDEO PLAYER
   */

  function createVideoPlayer() {
    const wrapper = document.createElement("div");
    wrapper.className = "ravelite-video-wrapper";

    const v = document.createElement("video");

    v.className = "ravelite-video";
    v.playsInline = true;
    v.preload = "metadata";
    v.crossOrigin = "anonymous";
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");

    /*
     * Disable browser-native controls.
     * We use our own bottom control bar.
     */
    v.controls = false;

    wrapper.append(v);

    const controls = document.createElement("div");
    controls.className = "ravelite-controls";

    controls.innerHTML = `
      <div class="ravelite-progress-row">
        <input
          class="ravelite-progress"
          type="range"
          min="0"
          max="100"
          value="0"
          step="0.1"
          aria-label="Video progress"
        >
      </div>

      <div class="ravelite-control-row">

        <button
          type="button"
          class="ravelite-play"
          aria-label="Play"
        >▶</button>

        <span class="ravelite-time">0:00 / 0:00</span>

        <div class="ravelite-spacer"></div>

        <button
          type="button"
          class="ravelite-mute"
          aria-label="Mute"
        >🔊</button>

        <input
          class="ravelite-volume"
          type="range"
          min="0"
          max="1"
          value="1"
          step="0.05"
          aria-label="Volume"
        >

        <button
          type="button"
          class="ravelite-fullscreen"
          aria-label="Fullscreen"
        >⛶</button>

      </div>
    `;

    wrapper.append(controls);
    $("playerArea").append(wrapper);

    const playButton = controls.querySelector(".ravelite-play");
    const progress = controls.querySelector(".ravelite-progress");
    const timeLabel = controls.querySelector(".ravelite-time");
    const muteButton = controls.querySelector(".ravelite-mute");
    const volume = controls.querySelector(".ravelite-volume");
    const fullscreen = controls.querySelector(".ravelite-fullscreen");

    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0)
        return "0:00";

      const total = Math.floor(seconds);
      const minutes = Math.floor(total / 60);
      const secs = total % 60;

      return `${minutes}:${String(secs).padStart(2, "0")}`;
    }

    function updatePlayButton() {
      playButton.textContent = v.paused ? "▶" : "⏸";
      playButton.setAttribute(
        "aria-label",
        v.paused ? "Play" : "Pause"
      );
    }

    function updateProgress() {
      if (!Number.isFinite(v.duration) || v.duration <= 0) {
        progress.value = 0;
        timeLabel.textContent = `${formatTime(v.currentTime)} / 0:00`;
        return;
      }

      progress.value = (v.currentTime / v.duration) * 100;

      timeLabel.textContent =
        `${formatTime(v.currentTime)} / ${formatTime(v.duration)}`;
    }

    function updateMuteButton() {
      if (v.muted || v.volume === 0) {
        muteButton.textContent = "🔇";
        muteButton.setAttribute("aria-label", "Unmute");
      } else {
        muteButton.textContent = "🔊";
        muteButton.setAttribute("aria-label", "Mute");
      }
    }

    function showControls() {
      controls.classList.add("visible");
      clearTimeout(controlsTimer);

      if (!v.paused) {
        controlsTimer = setTimeout(() => {
          controls.classList.remove("visible");
        }, 3000);
      }
    }

    function togglePlay() {
      if (v.paused) {
        v.play().catch(() => {
          msg("Tap Play once to allow playback on this device.");
        });
      } else {
        v.pause();
      }
    }

    playButton.onclick = e => {
      e.stopPropagation();
      togglePlay();
      showControls();
    };

    /*
     * Progress bar seeking
     */
    progress.addEventListener("input", () => {
      if (!Number.isFinite(v.duration)) return;

      const position =
        (Number(progress.value) / 100) * v.duration;

      v.currentTime = position;
      updateProgress();
    });

    /*
     * Volume
     */
    volume.addEventListener("input", () => {
      v.volume = Math.max(
        0,
        Math.min(1, Number(volume.value))
      );

      v.muted = v.volume === 0;
      updateMuteButton();
    });

    muteButton.onclick = e => {
      e.stopPropagation();

      v.muted = !v.muted;

      if (!v.muted && v.volume === 0) {
        v.volume = 1;
        volume.value = "1";
      }

      updateMuteButton();
      showControls();
    };

    /*
     * Fullscreen
     */
    fullscreen.onclick = async e => {
      e.stopPropagation();

      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }

        if (wrapper.requestFullscreen) {
          await wrapper.requestFullscreen();
        } else if (v.webkitEnterFullscreen) {
          v.webkitEnterFullscreen();
        } else {
          msg("Fullscreen is not supported by this browser.");
        }
      } catch {
        try {
          if (v.webkitEnterFullscreen) {
            v.webkitEnterFullscreen();
          } else {
            msg("Fullscreen unavailable.");
          }
        } catch {
          msg("Fullscreen unavailable.");
        }
      }

      showControls();
    };

    /*
     * Tap video = play/pause.
     * This works well on Android.
     */
    v.addEventListener("click", () => {
      togglePlay();
      showControls();
    });

    v.addEventListener("touchstart", () => {
      showControls();
    }, { passive: true });

    wrapper.addEventListener("mousemove", showControls);
    wrapper.addEventListener("touchstart", showControls, {
      passive: true
    });

    v.addEventListener("play", updatePlayButton);
    v.addEventListener("pause", updatePlayButton);
    v.addEventListener("timeupdate", updateProgress);
    v.addEventListener("loadedmetadata", updateProgress);
    v.addEventListener("durationchange", updateProgress);
    v.addEventListener("volumechange", updateMuteButton);

    /*
     * Synchronization events
     */
    v.onplay = () => {
      updatePlayButton();

      if (!window.__raveliteRemotePlayback) {
        send("playback:state", {
          playing: true,
          time: v.currentTime,
          url: currentMediaUrl,
          type: currentMediaType
        });
      }

      window.__raveliteRemotePlayback = false;
    };

    v.onpause = () => {
      updatePlayButton();

      if (!window.__raveliteRemotePlayback) {
        send("playback:state", {
          playing: false,
          time: v.currentTime,
          url: currentMediaUrl,
          type: currentMediaType
        });
      }

      window.__raveliteRemotePlayback = false;
    };

    updatePlayButton();
    updateMuteButton();
    updateProgress();

    return v;
  }

  function load(raw, remote = false) {
    const u = url(raw);

    if (!u) {
      msg("Enter a valid HTTP(S) URL.");
      return;
    }

    clean();

    $("mediaUrl").value = u.href;

    const k = kind(u);

    currentMediaUrl = u.href;
    currentMediaType = k;

    hist(u.href);

    /*
     * GOOGLE DRIVE
     */
    if (k === "drive") {
      const id = driveID(u);

      if (!id) {
        msg("Could not identify the Drive file ID.");
        return;
      }

      const f = document.createElement("iframe");

      f.src =
        "https://drive.google.com/file/d/" +
        encodeURIComponent(id) +
        "/preview";

      f.allow =
        "autoplay; encrypted-media; picture-in-picture; fullscreen";

      f.allowFullscreen = true;
      f.title = "Google Drive preview";

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
