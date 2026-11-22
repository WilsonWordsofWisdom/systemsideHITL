// Behaviour signals for actor classification (architecture 4.3 and 4.7, FR9, FR11).
// Collects counts and timings only: no keystrokes, field values or pointer positions.
// On sign-in the snapshot travels in the form's hidden "signals" field; on signed-in
// pages it is posted to /api/signals with the session's CSRF token.
(function () {
  "use strict";
  var start = Date.now();
  var firstInputAt = null;
  var c = {
    pointerMoves: 0,
    clicks: 0,
    clicksWithoutMove: 0,
    keys: 0,
    pastes: 0,
    untrusted: 0,
    focusChanges: 0,
    visibilityChanges: 0,
  };
  var movesSinceClick = 0;
  var intervals = [];
  var last = null;

  function mark(e) {
    var t = performance.now();
    if (last !== null) {
      intervals.push(t - last);
      if (intervals.length > 200) intervals.shift();
    }
    last = t;
    if (!e.isTrusted) c.untrusted++;
    if (firstInputAt === null) firstInputAt = Date.now();
  }

  addEventListener(
    "pointermove",
    function (e) {
      c.pointerMoves++;
      movesSinceClick++;
      if (!e.isTrusted) c.untrusted++;
    },
    { passive: true, capture: true },
  );
  addEventListener(
    "click",
    function (e) {
      mark(e);
      c.clicks++;
      if (movesSinceClick === 0) c.clicksWithoutMove++;
      movesSinceClick = 0;
    },
    true,
  );
  addEventListener("keydown", mark, true);
  addEventListener(
    "paste",
    function (e) {
      mark(e);
      c.pastes++;
    },
    true,
  );
  addEventListener("focus", function () {
    c.focusChanges++;
  });
  addEventListener("blur", function () {
    c.focusChanges++;
  });
  document.addEventListener("visibilitychange", function () {
    c.visibilityChanges++;
  });

  function stats() {
    if (intervals.length < 2) return { mean: null, sd: null };
    var sum = 0;
    for (var i = 0; i < intervals.length; i++) sum += intervals[i];
    var mean = sum / intervals.length;
    var v = 0;
    for (var j = 0; j < intervals.length; j++) v += Math.pow(intervals[j] - mean, 2);
    return { mean: Math.round(mean), sd: Math.round(Math.sqrt(v / intervals.length)) };
  }

  // Lets the passkey sign-in send the same snapshot as the password form.
  window.__dgSignals = function () {
    return snapshot();
  };

  function snapshot() {
    var s = stats();
    var ua = navigator.userActivation;
    return {
      v: 1,
      webdriver: navigator.webdriver === true,
      pointerMoves: c.pointerMoves,
      clicks: c.clicks,
      clicksWithoutMove: c.clicksWithoutMove,
      keys: c.keys,
      pastes: c.pastes,
      untrusted: c.untrusted,
      focusChanges: c.focusChanges,
      visibilityChanges: c.visibilityChanges,
      msToFirstInput: firstInputAt === null ? null : firstInputAt - start,
      msOnPage: Date.now() - start,
      intervalCount: intervals.length,
      intervalMeanMs: s.mean,
      intervalSdMs: s.sd,
      hasBeenActive: ua ? ua.hasBeenActive === true : null,
    };
  }

  document.addEventListener(
    "submit",
    function (e) {
      var field =
        e.target && e.target.querySelector && e.target.querySelector('input[name="signals"]');
      if (field) field.value = JSON.stringify(snapshot());
    },
    true,
  );

  var meta = document.querySelector('meta[name="csrf-token"]');
  if (meta && meta.content) {
    var send = function () {
      fetch("/api/signals", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": meta.content },
        body: JSON.stringify(snapshot()),
        credentials: "same-origin",
        keepalive: true,
      }).catch(function () {});
    };
    setInterval(send, 15000);
    addEventListener("pagehide", send);
  }
})();
