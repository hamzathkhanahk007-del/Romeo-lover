
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var config = window.RAVELITE_CONFIG || {};
  var socket = null;
  var room = null;
  var isHost = false;
  var video = null;
  var hls = null;
  var dash = null;
  var youtube = null;
  var mediaHistory = [];

  function serverUrl() {
    return String(config.serverUrl || "").trim().replace(/\/+$/, "");
  }

  function setStatus(message) {
    if ($("status")) $("status").textContent = message;
  }

  function setRoomStatus(message) {
    if ($("roomStatus")) $("roomStatus").textContent = message;
  }

  function setConnectionStatus(message) {
    if ($("connection")) $("connection").textContent = message;
  }

  function parseUrl(value) {
    try {
      var parsed = new URL(String(value || "").trim());

      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed;
      }
    } catch (error) {
      // Invalid URL.
    }

    return null;
  }

  function getMediaType(url) {
    var hostname = url.hostname.toLowerCase();

    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(hostname)) {
      return "youtube";
    }

    if (hostname === "drive.google.com" || hostname === "docs.google.com") {
      return "drive";
    }

    if (/\.m3u8$/i.test(url.pathname)) return "hls";
    if (/\.mpd$/i.test(url.pathname)) return "dash";

    return "direct";
  }

  function clearPlayer() {
    if (hls) {
      try {
        hls.destroy();
      } catch (error) {}
      hls = null;
    }

    if (dash) {
      try {
        dash.reset();
      } catch (error) {}
      dash = null;
    }

    if (youtube) {
      try {
        youtube.destroy();
      } catch (error) {}
      youtube = null;
    }

    video = null;

    if ($("playerArea")) {
      $("playerArea").innerHTML = "";
    }
  }

  function send(eventName, data) {
    if (!data) data = {};

    if (socket && socket.connected && room) {
      data.room = room;
      socket.emit(eventName, data);
    }
  }

  function updateHistory(url) {
    mediaHistory = [url].concat(
      mediaHistory.filter(function (item) {
        return item !== url;
      })
    ).slice(0, 8);

    var list = $("history");
    if (!list) return;

    list.innerHTML = "";

    mediaHistory.forEach(function (item) {
      var button = document.createElement("button");
      button.textContent = item;

      button.onclick = function () {
        loadMedia(item, false);
      };

      list.appendChild(button);
    });
  }

  function getDriveId(url) {
    var match = url.pathname.match(/\/file\/d\/([^/]+)/);

    return (match && match[1]) || url.searchParams.get("id");
  }

  function getYouTubeId(url) {
    if (url.hostname.indexOf("youtu.be") !== -1) {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }

    var match = url.pathname.match(/\/(?:embed|shorts)\/([^/]+)/);

    return url.searchParams.get("v") || (match && match[1]) || "";
  }

  function loadMedia(rawUrl, remote) {
    var url = parseUrl(rawUrl);

    if (!url) {
      setStatus("Enter a valid HTTP or HTTPS media URL.");
      return;
    }

    if (!$("playerArea")) {
      setStatus("The player area was not found in index.html.");
      return;
    }

    clearPlayer();

    if ($("mediaUrl")) {
      $("mediaUrl").value = url.href;
    }

    var type = getMediaType(url);
    updateHistory(url.href);

    if (type === "drive") {
      var driveId = getDriveId(url);

      if (!driveId) {
        setStatus("Could not identify the Google Drive file ID.");
        return;
      }

      var frame = document.createElement("iframe");

      frame.src =
        "https://drive.google.com/file/d/" +
        encodeURIComponent(driveId) +
        "/preview";

      frame.title = "Google Drive preview";
      frame.allow =
        "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;

      $("playerArea").appendChild(frame);

      setStatus("Google Drive preview loaded if permissions allow playback.");

      if (!remote) {
        send("media:load", {
          url: url.href,
          type: type
        });
      }

      return;
    }

    if (type === "youtube") {
      var youtubeId = getYouTubeId(url);

      if (!youtubeId) {
        setStatus("Could not identify the YouTube video.");
        return;
      }

      var target = document.createElement("div");
      target.id = "ytplayer";
      $("playerArea").appendChild(target);

      function createYouTubePlayer() {
        if (!window.YT || !window.YT.Player) {
          setStatus("YouTube player API did not load.");
          return;
        }

        youtube = new window.YT.Player("ytplayer", {
          width: "100%",
          height: "100%",
          videoId: youtubeId,
          playerVars: {
            playsinline: 1,
            rel: 0
          },
          events: {
            onReady: function () {
              setStatus("YouTube player ready.");
            },

            onError: function (event) {
              setStatus("YouTube playback error: " + event.data);
            },

            onStateChange: function (event) {
              if (!remote && (event.data === 1 || event.data === 2)) {
                send("playback:state", {
                  playing: event.data === 1,
                  time: youtube.getCurrentTime(),
                  url: url.href,
                  type: type
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

      setStatus("Loading YouTube player...");

      if (!remote) {
        send("media:load", {
          url: url.href,
          type: type
        });
      }

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
      setStatus(
        "Playback failed. Check the media URL, permissions, format and CORS."
      );
    };

    player.onloadedmetadata = function () {
      setStatus(type.toUpperCase() + " media loaded.");
    };

    player.onplay = function () {
      if (!remote) {
        send("playback:state", {
          playing: true,
          time: player.currentTime,
          url: url.href,
          type: type
        });
      }
    };

    player.onpause = function () {
      if (!remote) {
        send("playback:state", {
          playing: false,
          time: player.currentTime,
          url: url.href,
          type: type
        });
      }
    };

    if (type === "hls") {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(url.href);
        hls.attachMedia(player);

        hls.on(window.Hls.Events.ERROR, function (event, data) {
          if (data && data.fatal) {
            setStatus("HLS playback failed. Check the stream and CORS.");
          }
        });
      } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
        player.src = url.href;
      } else {
        setStatus("HLS is not supported by this browser.");
        return;
      }
    } else if (type === "dash") {
      if (!window.dashjs) {
        setStatus("DASH player library failed to load.");
        return;
      }

      dash = window.dashjs.MediaPlayer().create();
      dash.initialize(player, url.href, false);

      dash.on(window.dashjs.MediaPlayer.events.ERROR, function () {
        setStatus("DASH playback failed. Check the stream and codecs.");
      });
    } else {
      player.src = url.href;
    }

    setStatus("Loading " + type + " media...");

    if (!remote) {
      send("media:load", {
        url: url.href,
        type: type
      });
    }
  }

  function getCurrentTime() {
    try {
      if (youtube) return youtube.getCurrentTime();
      if (video) return video.currentTime || 0;
    } catch (error) {}

    return 0;
  }

  function synchronizePlayback(state) {
    if (!state) return;

    var targetTime = Number(state.time) || 0;
    var difference = Math.abs(getCurrentTime() - targetTime);

    if (youtube) {
      try {
        if (difference > 2) {
          youtube.seekTo(targetTime, true);
        }

        if (state.playing) {
          youtube.playVideo();
        } else {
          youtube.pauseVideo();
        }
      } catch (error) {}

      return;
    }

    if (video) {
      if (difference > 2) {
        try {
          video.currentTime = targetTime;
        } catch (error) {}
      }

      if (state.playing) {
        var result = video.play();

        if (result && result.catch) {
          result.catch(function () {
            setStatus("Tap Play in the video controls, then try Sync.");
          });
        }
      } else {
        video.pause();
      }
    }
  }

  function updateParticipants(participants) {
    if (!$("participants")) return;

    $("participants").textContent = (participants || []).map(function (person) {
      return person.name + (person.isHost ? " - host" : "");
    }).join(" · ") || "None";
  }

  function addChatMessage(message) {
    var log = $("chatLog");
    if (!log) return;

    if (log.textContent === "Join a room to chat.") {
      log.textContent = "";
    }

    var line = document.createElement("div");
    line.textContent =
      (message.name || "Guest") + ": " + (message.text || "");

    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function connect() {
    if (!serverUrl()) {
      setConnectionStatus("Backend URL missing in config.js");
      return;
    }

    if (!window.io) {
      setConnectionStatus("Socket.IO library failed to load");
      return;
    }

    try {
      socket = window.io(serverUrl());

      socket.on("connect", function () {
        setConnectionStatus("Connected");

        if (room) {
          socket.emit("room:join", {
            room: room,
            name: $("displayName") ? $("displayName").value : "Guest"
          });
        }
      });

      socket.on("disconnect", function () {
        setConnectionStatus("Disconnected - reconnecting...");
      });

      socket.on("connect_error", function (error) {
        setConnectionStatus("Backend connection failed");
        console.error("RaveLite connection error:", error);
      });

      socket.on("room:error", function (data) {
        setRoomStatus(
          data && data.message ? data.message : "Room error."
        );
      });

      socket.on("room:joined", function (data) {
        room = data.room;
        isHost = !!data.isHost;

        if ($("roomCode")) {
          $("roomCode").value = room;
        }

        setRoomStatus(
          "Joined " + room + (isHost ? " as host" : "")
        );

        updateParticipants(data.participants || []);

        if (data.media && data.media.url) {
          loadMedia(data.media.url, true);
        }
      });

      socket.on("room:participants", updateParticipants);
      socket.on("chat:message", addChatMessage);

      socket.on("media:load", function (data) {
        if (data && data.url) {
          loadMedia(data.url, true);
        }
      });

      socket.on("playback:state", synchronizePlayback);
    } catch (error) {
      setConnectionStatus("Connection setup failed");
      console.error("RaveLite setup error:", error);
    }
  }

  function createRoom() {
    if (!socket || !socket.connected) {
      setRoomStatus("Backend is not connected. Check config.js and Render.");
      return;
    }

    socket.emit("room:create", {
      name: $("displayName") ? $("displayName").value : "Guest"
    });
  }

  function joinRoom() {
    if (!socket || !socket.connected) {
      setRoomStatus("Backend is not connected. Check config.js and Render.");
      return;
    }

    socket.emit("room:join", {
      room: $("roomCode").value.trim().toUpperCase(),
      name: $("displayName") ? $("displayName").value : "Guest"
    });
  }

  if ($("loadBtn")) {
    $("loadBtn").onclick = function () {
      loadMedia($("mediaUrl").value, false);
    };
  }

  if ($("mediaUrl")) {
    $("mediaUrl").onkeydown = function (event) {
      if (event.key === "Enter") {
        loadMedia(event.target.value, false);
      }
    };
  }

  if ($("openBtn")) {
    $("openBtn").onclick = function () {
      var url = parseUrl($("mediaUrl").value);

      if (url) {
        window.open(url.href, "_blank", "noopener,noreferrer");
      } else {
        setStatus("Enter a valid URL first.");
      }
    };
  }

  if ($("createBtn")) {
    $("createBtn").onclick = createRoom;
  }

  if ($("joinBtn")) {
    $("joinBtn").onclick = joinRoom;
  }

  if ($("leaveBtn")) {
    $("leaveBtn").onclick = function () {
      send("room:leave");
      room = null;
      isHost = false;
      setRoomStatus("Left room.");
    };
  }

  if ($("copyBtn")) {
    $("copyBtn").onclick = function () {
      if (!room) {
        setRoomStatus("Join a room first.");
        return;
      }

      var invite = new URL(window.location.href);
      invite.searchParams.set("room", room);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(invite.href).then(function () {
          setRoomStatus("Invite copied.");
        }).catch(function () {
          setRoomStatus(invite.href);
        });
      } else {
        setRoomStatus(invite.href);
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
        setRoomStatus("Join a connected room to chat.");
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
      if (youtube) {
        youtube.playVideo();
      } else if (video) {
        var result = video.play();

        if (result && result.catch) {
          result.catch(function () {
            setStatus("Tap Play in the video controls.");
          });
        }
      } else {
        setStatus("Load a video first.");
      }
    };
  }

  if ($("pauseBtn")) {
    $("pauseBtn").onclick = function () {
      if (youtube) {
        youtube.pauseVideo();
      } else if (video) {
        video.pause();
      }
    };
  }

  if ($("syncBtn")) {
    $("syncBtn").onclick = function () {
      if (room && socket && socket.connected) {
        send("playback:request");
      } else {
        setStatus("Join a connected room first.");
      }
    };
  }

  if ($("pipBtn")) {
    $("pipBtn").onclick = function () {
      if (
        video &&
        document.pictureInPictureEnabled &&
        video.requestPictureInPicture
      ) {
        video.requestPictureInPicture().catch(function () {
          setStatus("Picture-in-picture is unavailable.");
        });
      } else {
        setStatus("Picture-in-picture is not supported for this player.");
      }
    };
  }

  if ($("clearHistory")) {
    $("clearHistory").onclick = function () {
      mediaHistory = [];

      if ($("history")) {
        $("history").textContent = "History cleared.";
      }
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

      if (!serverUrl()) {
        $("convertStatus").textContent =
          "Backend URL missing in config.js.";
        return;
      }

      var form = new FormData();
      form.append("video", file);

      $("convertStatus").textContent = "Uploading and converting...";

      try {
        var response = await fetch(serverUrl() + "/api/convert", {
          method: "POST",
          body: form
        });

        var data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Conversion failed.");
        }

        if (!data.url) {
          throw new Error("The server did not return a video URL.");
        }

        loadMedia(data.url, false);

        $("convertStatus").textContent =
          "Conversion finished. Temporary output may expire.";
      } catch (error) {
        $("convertStatus").textContent =
          "Conversion failed: " + error.message;
      }
    };
  }

  var query = new URLSearchParams(window.location.search);
  var roomFromUrl = query.get("room");

  if (roomFromUrl && $("roomCode")) {
    $("roomCode").value = roomFromUrl;
  }

  setConnectionStatus("Starting connection...");
  connect();
})();
