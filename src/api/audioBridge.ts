// Host-audio grounding: put what the seller is SAYING on the bus.
//
// This is the capability the SideStage brief does not have and Whissle does. The
// catalog knows what a card is; it does not know the host just said "this one is
// a jersey patch, numbered to 25, and it's the last one tonight". A buyer who
// types "is that numbered?" four seconds later is asking about THAT.
//
// Path:
//   browser  getDisplayMedia({audio}) on the eBay Live tab
//        ->  publishes the track into a Whissle LISTEN-ONLY session
//            (STT + emotion metadata, no LLM, no TTS — the bot never speaks)
//        ->  transcript comes back on the LiveKit data channel
//        ->  POSTed here, into that show's rolling context engine
//
// Two things are deliberate:
//
//  * The `wsk_` key never leaves the server. The browser receives only a
//    short-lived LiveKit token for one room.
//  * Capture needs an operator GESTURE. Browsers will not hand a page tab audio
//    without a user picking the tab, so this is a page the seller opens and
//    clicks once — it cannot be started from the backend, by anyone.

export const AUDIO_BRIDGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SideStage — host audio bridge</title>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2.5.9/dist/livekit-client.umd.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0A0B0D; color:#E8EAED; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  main { max-width:720px; margin:0 auto; padding:32px 20px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#9BA1AC; margin:0 0 24px; }
  .panel { border:1px solid #23262E; border-radius:6px; padding:16px; background:#101216; margin-bottom:16px; }
  button { font:inherit; background:#4C8DFF; color:#fff; border:0; border-radius:4px; padding:10px 16px; cursor:pointer; }
  button:disabled { background:#23262E; color:#646B77; cursor:default; }
  button.secondary { background:#161920; color:#E8EAED; border:1px solid #23262E; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  label { color:#9BA1AC; font-size:12px; }
  input { font:inherit; background:#0A0B0D; color:#E8EAED; border:1px solid #23262E; border-radius:4px; padding:8px 10px; min-width:260px; }
  #status { font-family:ui-monospace,monospace; font-size:12px; color:#9BA1AC; }
  #log { font-family:ui-monospace,monospace; font-size:12px; white-space:pre-wrap;
         max-height:320px; overflow:auto; border:1px solid #23262E; border-radius:6px;
         padding:12px; background:#0A0B0D; }
  .dot { width:8px; height:8px; border-radius:50%; background:#646B77; display:inline-block; margin-right:6px; }
  .dot.on { background:#3FB950; }
  .dot.err { background:#F85149; }
  ol { color:#9BA1AC; font-size:13px; padding-left:20px; }
  code { color:#E8EAED; }
</style>
</head>
<body>
<main>
  <h1>Host audio bridge</h1>
  <p class="sub">Puts what the seller is saying into the copilot's rolling show context.</p>

  <div class="panel">
    <ol>
      <li>Open the eBay Live show in another tab and make sure it is playing.</li>
      <li>Pick a show below, click <strong>Start capture</strong>.</li>
      <li>In the picker choose that <strong>tab</strong> and tick <strong>Share tab audio</strong>.</li>
    </ol>
    <div class="row">
      <label for="show">showId</label>
      <input id="show" value="" placeholder="ebay_xxxxxxxx" />
      <button id="start">Start capture</button>
      <button id="stop" class="secondary" disabled>Stop</button>
    </div>
    <p id="status" style="margin:14px 0 0"><span class="dot" id="dot"></span>idle</p>
  </div>

  <div class="panel">
    <div id="log">waiting…</div>
  </div>
</main>

<script>
(function () {
  var API = location.origin;
  var room = null, stream = null, visualTimer = null, visualEl = null;
  var levelCtx = null, levelTimer = null, levelPost = null, levelWindow = [];
  var recorder = null, chunkSeq = 0, chunkStartedAt = 0;
  // One id per page load: the server numbers chunks and uses this to tell a
  // retry (replace) from a reopened bridge (append).
  var RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Transcript watchdog. The listen session can stop transcribing while the
  // audio it is fed is still speech (measured 2026-09-15: ninety seconds of
  // speech-level chunks after the last utterance). Loud audio with no final
  // transcript for this long → reconnect, at most a few times a session.
  var STALL_MS = 45000, lastFinalAt = 0, loudSince = 0, stallTimer = null, reconnects = 0, MAX_RECONNECTS = 5;
  var listenShowId = null, listenAudio = null;
  /** How long each kept audio chunk is. Ten seconds is short enough that a
   *  failed upload loses little and long enough that a two-hour show is 720
   *  files, not 7,200. */
  var CHUNK_MS = 10000;
  /** ~10 Hz. Fine enough to show a pause, coarse enough to stay cheap. */
  var LEVEL_EVERY_MS = 100;
  /** How often a keyframe is offered to the copilot. Lots change on the order of
   *  a minute; the server throttles again at 8s regardless. */
  var VISUAL_EVERY_MS = 12000;
  var el = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  // The console hands its session over in the URL; every call back carries it.
  var TOKEN = params.get("token") || "";
  var AUTH = TOKEN ? { authorization: "Bearer " + TOKEN } : {};
  el("show").value = params.get("showId") || "";

  function log(line) {
    var box = el("log");
    var t = new Date().toISOString().slice(11, 19);
    box.textContent = (box.textContent === "waiting…" ? "" : box.textContent + "\\n") + t + "  " + line;
    box.scrollTop = box.scrollHeight;
  }
  function status(text, cls) {
    el("status").innerHTML = '<span class="dot ' + (cls || "") + '" id="dot"></span>' + text;
  }

  // Whissle emits voice metadata on its own frames, slightly out of step with
  // the transcript. Hold the most recent and attach it to the next final
  // segment — near enough at a one-utterance granularity, and far simpler than
  // trying to align two streams by timestamp.
  var pending = { emotion: null, intent: null, speechRate: null };

  async function postTranscript(showId, text) {
    if (!text || !text.trim()) return;
    var body = {
      text: text,
      emotion: pending.emotion,
      intent: pending.intent,
      speechRate: pending.speechRate
    };
    // The loudness while this was being said. Drained, so two utterances never
    // claim the same audio.
    body.levels = levelWindow.splice(0, levelWindow.length).map(function (v) {
      return Math.round(v * 100) / 100;
    });
    pending = { emotion: null, intent: null, speechRate: null };
    await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/transcript", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, AUTH),
      body: JSON.stringify(body)
    }).catch(function (e) { log("transcript post failed: " + e.message); });
  }

  el("start").onclick = async function () {
    var showId = el("show").value.trim();
    if (!showId) { log("enter a showId first"); return; }

    try {
      status("requesting tab audio…");
      // Video is requested because Chrome will not offer tab AUDIO without it.
      // We used to stop that track on arrival, which for a live SELLING show is
      // the wrong instinct: the host is holding the item up to camera, and
      // "what's that one?" is answerable from the frame and nothing else. It is
      // kept now and sampled — see startVisual() below.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      var audio = stream.getAudioTracks()[0];
      var video = stream.getVideoTracks()[0] || null;
      if (!audio) {
        status("no audio track — did you tick “Share tab audio”?", "err");
        log("the picker returned video only; stop and retry with tab audio ticked");
        return;
      }
      log("captured tab audio: " + audio.label);

      status("minting a listen-only Whissle session…");
      var r = await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/session", { method: "POST", headers: AUTH });
      var s = await r.json();
      if (!r.ok) { status("session failed", "err"); log(s.error || ("HTTP " + r.status)); return; }
      log("listen-only session on " + s.url);

      room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });

      // RTVI frames. Two envelopes matter, and getting the second one wrong is
      // why voice metadata never appeared: signals arrive as "server-message",
      // NOT as a type containing the word "signal", so a naive match on
      // msg.type never fired.
      //
      //   { type:"user-transcription", data:{ text, final } }
      //   { type:"server-message", data:{ kind:"signal", type:"emotion",
      //       data:{ top_k:[…], top_label, top_p, changed, prev_label, flips } } }
      wireRoom(room, showId);

      await room.connect(s.url, s.token);
      await room.localParticipant.publishTrack(audio, { name: "host-audio", source: LivekitClient.Track.Source.Microphone });

      status("capturing — host speech is feeding the copilot", "on");
      log("published host audio into room " + (s.room || "(unnamed)"));
      el("start").disabled = true; el("stop").disabled = false;
      listenShowId = showId; listenAudio = audio; lastFinalAt = Date.now(); loudSince = 0;
      startStallWatch();

      if (video) startVisual(showId, video);
      else log("no video track — the copilot will hear the show but not see it");

      startLevels(showId, audio);
      startRecording(showId, audio);

      audio.onended = function () { log("tab sharing ended by the browser"); el("stop").click(); };
    } catch (e) {
      status("capture failed", "err");
      log(String(e && e.message ? e.message : e));
    }
  };

  /**
   * Keep the host's audio, in chunks, beside the transcript.
   *
   * The same track that goes to Whissle also goes through a MediaRecorder here,
   * so the post-show report can play the show back against what was said and
   * shown. Opus in WebM at 32 kbps: speech, not music, about 40 KB per ten
   * seconds. Each chunk is posted with its own sequence number so a retry
   * replaces rather than duplicates.
   *
   * timeslice chunks from MediaRecorder are only independently playable when
   * the recorder is restarted per chunk — a continuation chunk has no header.
   * So the recorder is stopped and started every CHUNK_MS, which costs a few
   * milliseconds of audio at each boundary and nothing else.
   */
  function startRecording(showId, audioTrack) {
    if (typeof MediaRecorder === "undefined") { log("MediaRecorder unavailable — audio will not be kept"); return; }
    var mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].filter(function (m) {
      return MediaRecorder.isTypeSupported(m);
    })[0];
    if (!mime) { log("no supported audio recording format — audio will not be kept"); return; }
    var ms = new MediaStream([audioTrack]);

    function cut() {
      var seq = chunkSeq++;
      var startedAt = Date.now();
      var rec;
      try { rec = new MediaRecorder(ms, { mimeType: mime, audioBitsPerSecond: 32000 }); }
      catch (e) { log("recorder failed: " + e.message); return; }
      recorder = rec;
      var parts = [];
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) parts.push(ev.data); };
      rec.onstop = function () {
        var blob = new Blob(parts, { type: mime.split(";")[0] });
        var durationMs = Math.max(1, Date.now() - startedAt);
        if (blob.size) post(seq, blob, durationMs);
        // Keep going while the session is up. Stop cleared the recorder.
        if (recorder === rec) cut();
      };
      rec.start();
      setTimeout(function () { if (rec.state === "recording") rec.stop(); }, CHUNK_MS);
    }

    function post(seq, blob, durationMs, attempt) {
      attempt = attempt || 0;
      fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/chunk?seq=" + seq + "&run=" + RUN + "&durationMs=" + durationMs, {
        method: "POST",
        headers: Object.assign({ "content-type": blob.type || "audio/webm" }, AUTH),
        body: blob
      }).then(function (r) {
        if (r.status === 409) { log("audio is off in settings — chunks are not being kept"); return; }
        if (!r.ok && attempt < 2) setTimeout(function () { post(seq, blob, durationMs, attempt + 1); }, 2000);
        else if (!r.ok) log("chunk " + seq + " lost after 3 attempts (HTTP " + r.status + ")");
      }).catch(function () {
        if (attempt < 2) setTimeout(function () { post(seq, blob, durationMs, attempt + 1); }, 2000);
        else log("chunk " + seq + " lost after 3 attempts");
      });
    }

    chunkSeq = 0;
    cut();
    log("keeping audio in " + (CHUNK_MS / 1000) + "s chunks (" + mime + ")");
  }

  /**
   * Measure the show's loudness off the track we are already publishing.
   *
   * The console draws a timeline of the host's audio, and a timeline built from
   * the transcript alone freezes whenever nobody is recognised as speaking —
   * which on a selling show is most of the interesting moments, because the
   * pause while the host waits for bids IS the signal.
   *
   * Time-domain RMS, not an FFT. We have the samples, so loudness over time is
   * something we can honestly measure; frequency bins are not, and drawing bins
   * we never computed would be a picture of nothing.
   */
  function startLevels(showId, audioTrack) {
    try {
      levelCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = levelCtx.createMediaStreamSource(new MediaStream([audioTrack]));
      var analyser = levelCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      var buf = new Float32Array(analyser.fftSize);
      var pending = [];

      levelTimer = setInterval(function () {
        analyser.getFloatTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        var rms = Math.sqrt(sum / buf.length);
        // Perceptual, not linear: speech sits in a narrow band of raw RMS and a
        // linear strip reads as a flat line with occasional spikes.
        var v = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-7) + 60) / 60));
        pending.push(Math.round(v * 100) / 100);
        levelWindow.push(v);
        if (levelWindow.length > 600) levelWindow.shift();
        if (v > 0.25) { if (!loudSince) loudSince = Date.now(); } else if (loudSince && Date.now() - loudSince < 3000) loudSince = 0;
      }, LEVEL_EVERY_MS);

      // Batched: one request a second rather than ten.
      levelPost = setInterval(function () {
        if (!pending.length) return;
        var batch = pending.splice(0, pending.length);
        fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/levels", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, AUTH),
          body: JSON.stringify({ levels: batch })
        }).catch(function () {});
      }, 1000);

      log("measuring loudness at " + Math.round(1000 / LEVEL_EVERY_MS) + " Hz");
    } catch (e) {
      log("level metering unavailable: " + (e && e.message ? e.message : e));
    }
  }

  /**
   * Sample the shared tab's video and send a keyframe to the copilot.
   *
   * Deliberately NOT every frame. A vision read costs a model call, and a live
   * show's screen changes meaningfully on the order of lots, not frames — so
   * this runs on a slow timer and downscales hard before encoding. The server
   * throttles again on its own side, because a client's throttle is a request
   * rather than a guarantee.
   */
  function startVisual(showId, track) {
    // The element has to be IN the document and actually PLAYING. A detached,
    // never-played <video> reports a size but Chrome does not decode into it, so
    // every drawImage() produced a black canvas — and the copilot dutifully
    // reported "completely black, nothing clear" into the show context once a
    // minute. Off-screen rather than hidden: display:none stops decoding too.
    var el2 = document.createElement("video");
    el2.muted = true; el2.playsInline = true; el2.autoplay = true;
    el2.setAttribute("aria-hidden", "true");
    el2.style.cssText = "position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0.01;pointer-events:none";
    document.body.appendChild(el2);
    el2.srcObject = new MediaStream([track]);
    var playing = el2.play();
    if (playing && playing.catch) playing.catch(function (e) { log("video play blocked: " + e.message); });
    visualEl = el2;
    var canvas = document.createElement("canvas");

    visualTimer = setInterval(async function () {
      try {
        var w = el2.videoWidth, h = el2.videoHeight;
        if (!w || !h) return;
        // Long edge 640: enough for the model to read a shoe or a slab label,
        // small enough that the frame is tens of KB rather than hundreds.
        var scale = Math.min(1, 960 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var cx = canvas.getContext("2d");
        cx.drawImage(el2, 0, 0, canvas.width, canvas.height);

        // Do not pay a vision call for a frame with nothing in it. A stream
        // between lots, a paused tab or a still-warming decoder all produce a
        // near-black frame, and asking a model to describe one gets back a
        // paragraph about how dark it is — which then becomes "show context".
        if (isBlank(cx, canvas)) { return; }

        var frame = canvas.toDataURL("image/jpeg", 0.8);

        var r = await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/visual/frame", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, AUTH),
          body: JSON.stringify({ frame: frame })
        });
        var out = await r.json().catch(function () { return {}; });
        if (out && out.onScreen) log("on camera: " + out.onScreen);
      } catch (e) {
        log("frame skipped: " + (e && e.message ? e.message : e));
      }
    }, VISUAL_EVERY_MS);

    log("watching the show's video, one frame every " + (VISUAL_EVERY_MS / 1000) + "s");
  }

  /**
   * Is this frame worth a model call?
   *
   * Mean luma plus spread, on a coarse sample. Mean alone calls a flat grey
   * slate "content"; spread alone passes noise. Both have to clear the floor.
   */
  function isBlank(cx, canvas) {
    try {
      var d = cx.getImageData(0, 0, canvas.width, canvas.height).data;
      var n = 0, sum = 0, sumSq = 0;
      for (var i = 0; i < d.length; i += 64) {  // every 16th pixel
        var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += y; sumSq += y * y; n++;
      }
      if (!n) return true;
      var mean = sum / n;
      var sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      if (mean < 12 || sd < 6) {
        log("frame skipped: nothing on screen (luma " + mean.toFixed(0) + ", spread " + sd.toFixed(0) + ")");
        return true;
      }
      return false;
    } catch (e) {
      return false;  // a tainted canvas is not a reason to stop looking
    }
  }

  /**
   * Loud audio, no transcript, for STALL_MS: the session has gone deaf. Mint a
   * new listen session and republish the same track; the console keeps its
   * strip and the recorder keeps its chunks, because neither depends on the
   * room. Bounded so a gateway that is truly down does not get hammered.
   */
  function wireRoom(r, showId) {
    r.on(LivekitClient.RoomEvent.DataReceived, function (payload) {
      var msg;
      try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
      var t = msg.type || "";
      var d = msg.data || {};

      if (/transcription|transcript/i.test(t)) {
        var text = d.text || (d.data && d.data.text) || "";
        if (text && d.final !== false) { lastFinalAt = Date.now(); loudSince = 0; log("host: " + text); postTranscript(showId, text); }
        return;
      }

      if (t === "server-message" && d.kind === "signal") {
        if (d.type === "emotion") { pending.emotion = d.data; note("emotion", d.data); }
        else if (d.type === "intent") { pending.intent = d.data; note("intent", d.data); }
        else if (d.data && typeof d.data.words_per_minute === "number") pending.speechRate = d.data.words_per_minute;
        return;
      }

      // Older gateways emitted a flat metadata frame.
      if (/metadata/i.test(t)) {
        if (d.emotion) pending.emotion = d.emotion;
        if (d.intent) pending.intent = d.intent;
        if (typeof d.speech_rate === "number") pending.speechRate = d.speech_rate;
      }
    });

    function note(kind, dist) {
      if (!dist) return;
      var top = dist.top_label || dist.label || "?";
      var p = typeof dist.top_p === "number" ? " " + dist.top_p.toFixed(2) : "";
      var flip = dist.changed ? "  FLIP from " + (dist.prev_label || "?") : "";
      log(kind + ": " + top + p + flip);
    }

    r.on(LivekitClient.RoomEvent.Disconnected, function () { status("disconnected", "err"); log("room disconnected"); });
  }

  function startStallWatch() {
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = setInterval(async function () {
      if (!room || !listenShowId || !listenAudio) return;
      var now = Date.now();
      var loudFor = loudSince ? now - loudSince : 0;
      var quiet = now - lastFinalAt;
      if (loudFor < STALL_MS || quiet < STALL_MS) return;
      if (reconnects >= MAX_RECONNECTS) { status("transcript stalled — reconnect limit reached, stop and start again", "err"); return; }
      reconnects++;
      log("transcript stalled " + Math.round(quiet / 1000) + "s while audio is live — reconnecting the listen session (" + reconnects + "/" + MAX_RECONNECTS + ")");
      status("transcript stalled — reconnecting…", "err");
      try {
        var old = room; room = null;
        try { await old.disconnect(); } catch (e) {}
        var r = await fetch(API + "/api/shows/" + encodeURIComponent(listenShowId) + "/audio/session", { method: "POST", headers: AUTH });
        var s = await r.json();
        if (!r.ok) { log("reconnect failed: " + (s.error || ("HTTP " + r.status))); return; }
        var next = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
        wireRoom(next, listenShowId);
        await next.connect(s.url, s.token);
        await next.localParticipant.publishTrack(listenAudio, { name: "host-audio", source: LivekitClient.Track.Source.Microphone });
        room = next; lastFinalAt = Date.now(); loudSince = 0;
        status("capturing — host speech is feeding the copilot (reconnected)", "on");
        log("reconnected into room " + (s.room || "(unnamed)"));
      } catch (e) {
        log("reconnect failed: " + String(e && e.message ? e.message : e));
      }
    }, 5000);
  }

  el("stop").onclick = async function () {
    if (recorder) { var r = recorder; recorder = null; try { if (r.state === "recording") r.stop(); } catch (e) {} }
    if (visualTimer) { clearInterval(visualTimer); visualTimer = null; }
    if (visualEl) { try { visualEl.remove(); } catch (e) {} visualEl = null; }
    if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
    if (levelPost) { clearInterval(levelPost); levelPost = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    listenShowId = null; listenAudio = null;
    if (levelCtx) { try { levelCtx.close(); } catch (e) {} levelCtx = null; }
    levelWindow = [];
    try { if (room) await room.disconnect(); } catch (e) {}
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    room = null; stream = null;
    status("stopped");
    el("start").disabled = false; el("stop").disabled = true;
  };
})();
</script>
</body>
</html>`;
