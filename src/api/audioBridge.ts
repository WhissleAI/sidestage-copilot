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
  var room = null, stream = null;
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
      // Video is requested because Chrome will not offer tab AUDIO without it;
      // the video track is stopped immediately and never published.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      var audio = stream.getAudioTracks()[0];
      stream.getVideoTracks().forEach(function (t) { t.stop(); });
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

      // The live-signal stream: transcripts and voice metadata arrive on the
      // data channel. Shapes vary by gateway version, so read defensively.
      room.on(LivekitClient.RoomEvent.DataReceived, function (payload) {
        var msg;
        try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
        var type = msg.type || (msg.data && msg.data.type) || "";
        var d = msg.data || msg;
        if (/transcription|transcript/i.test(type)) {
          var text = d.text || (d.data && d.data.text) || "";
          var final = d.final !== false;
          if (text && final) { log("host: " + text); postTranscript(showId, text); }
        } else if (/metadata|signal/i.test(type)) {
          var m = d.metadata || d;
          if (m.emotion) pending.emotion = m.emotion;
          if (m.intent) pending.intent = m.intent;
          if (typeof m.speech_rate === "number") pending.speechRate = m.speech_rate;
          if (typeof m.speechRate === "number") pending.speechRate = m.speechRate;
          log("signal: " + JSON.stringify(d).slice(0, 140));
        }
      });

      room.on(LivekitClient.RoomEvent.Disconnected, function () { status("disconnected", "err"); log("room disconnected"); });

      await room.connect(s.url, s.token);
      await room.localParticipant.publishTrack(audio, { name: "host-audio", source: LivekitClient.Track.Source.Microphone });

      status("capturing — host speech is feeding the copilot", "on");
      log("published host audio into room " + (s.room || "(unnamed)"));
      el("start").disabled = true; el("stop").disabled = false;

      audio.onended = function () { log("tab sharing ended by the browser"); el("stop").click(); };
    } catch (e) {
      status("capture failed", "err");
      log(String(e && e.message ? e.message : e));
    }
  };

  el("stop").onclick = async function () {
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
