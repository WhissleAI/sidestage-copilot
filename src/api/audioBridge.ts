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
  /** How often a keyframe is offered to the copilot. Lots change on the order of
   *  a minute; the server throttles again at 8s regardless. */
  var VISUAL_EVERY_MS = 12000;
  var el = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
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
    pending = { emotion: null, intent: null, speechRate: null };
    await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/transcript", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      var r = await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/audio/session", { method: "POST" });
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
      room.on(LivekitClient.RoomEvent.DataReceived, function (payload) {
        var msg;
        try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
        var t = msg.type || "";
        var d = msg.data || {};

        if (/transcription|transcript/i.test(t)) {
          var text = d.text || (d.data && d.data.text) || "";
          if (text && d.final !== false) { log("host: " + text); postTranscript(showId, text); }
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

      room.on(LivekitClient.RoomEvent.Disconnected, function () { status("disconnected", "err"); log("room disconnected"); });

      await room.connect(s.url, s.token);
      await room.localParticipant.publishTrack(audio, { name: "host-audio", source: LivekitClient.Track.Source.Microphone });

      status("capturing — host speech is feeding the copilot", "on");
      log("published host audio into room " + (s.room || "(unnamed)"));
      el("start").disabled = true; el("stop").disabled = false;

      if (video) startVisual(showId, video);
      else log("no video track — the copilot will hear the show but not see it");

      audio.onended = function () { log("tab sharing ended by the browser"); el("stop").click(); };
    } catch (e) {
      status("capture failed", "err");
      log(String(e && e.message ? e.message : e));
    }
  };

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
        var scale = Math.min(1, 640 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var cx = canvas.getContext("2d");
        cx.drawImage(el2, 0, 0, canvas.width, canvas.height);

        // Do not pay a vision call for a frame with nothing in it. A stream
        // between lots, a paused tab or a still-warming decoder all produce a
        // near-black frame, and asking a model to describe one gets back a
        // paragraph about how dark it is — which then becomes "show context".
        if (isBlank(cx, canvas)) { return; }

        var frame = canvas.toDataURL("image/jpeg", 0.7);

        var r = await fetch(API + "/api/shows/" + encodeURIComponent(showId) + "/visual/frame", {
          method: "POST",
          headers: { "content-type": "application/json" },
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

  el("stop").onclick = async function () {
    if (visualTimer) { clearInterval(visualTimer); visualTimer = null; }
    if (visualEl) { try { visualEl.remove(); } catch (e) {} visualEl = null; }
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
