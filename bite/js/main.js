/* ==========================================================================
   BITE — main.js
   1. Sound           — five soundscape layers via Web Audio, dock + mixer
   2. Page swapping   — internal links swap the page in place, so the music
                        never stops between pages (falls back to normal links)
   3. Filmstrip       — horizontal gallery: swipe, drag, arrows, buttons
   4. Develop on tap  — touch screens get the hover develop animation on tap
   ========================================================================== */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Small storage helpers (storage can throw in private mode) */
  function load(store, key, fallback) {
    try {
      var v = window[store].getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function save(store, key, value) {
    try {
      window[store].setItem(key, value);
    } catch (e) {
      /* ignore */
    }
  }


  /* 
     1. SOUND
     Five pre-built soundscape layers (rain, street, projector, flash, grain)
     loop through Web Audio. Each loop is a different length, so the layers
     drift against each other and the whole rarely repeats. The dock has
     play/pause and volume; the mixer lets visitors ride each layer's fader,
     mute/solo it, watch its meter and sweep a master filter. They shape the
     mix; the sounds themselves are fixed.
     */

  var TRACK = { title: "After Dark", sub: "Bite soundscape" };
  var STEMS = [
    { id: "rain", label: "Rain", src: "media/layers/rain.flac", level: 0.8 },
    { id: "street", label: "Street", src: "media/layers/street.flac", level: 0.75 },
    { id: "projector", label: "Projector", src: "media/layers/projector.flac", level: 0.5 },
    { id: "flash", label: "Flash", src: "media/layers/flash.flac", level: 0.7 },
    { id: "grain", label: "Grain", src: "media/layers/grain.flac", level: 0.55 }
  ];
  var DEFAULT_MIX = { volume: 0.7, filter: 1, stems: {} };
  STEMS.forEach(function (s) {
    DEFAULT_MIX.stems[s.id] = { level: s.level, mute: false, solo: false };
  });

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  var ICON_MIX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h2v6H5zM3 10h6v3H3zM5 14h2v7H5zM11 3h2v10h-2zM9 14h6v3H9zM11 18h2v3h-2zM17 3h2v3h-2zM15 7h6v3h-6zM17 11h2v10h-2z"/></svg>';

  function clamp01(v, fallback) {
    v = parseFloat(v);
    return isNaN(v) ? fallback : Math.max(0, Math.min(1, v));
  }

  function loadMix() {
    var mix = JSON.parse(JSON.stringify(DEFAULT_MIX));
    try {
      var saved = JSON.parse(load("localStorage", "bite-mix", "null"));
      if (saved) {
        mix.volume = clamp01(saved.volume, mix.volume);
        mix.filter = clamp01(saved.filter, mix.filter);
        STEMS.forEach(function (s) {
          var st = saved.stems && saved.stems[s.id];
          if (!st) return;
          mix.stems[s.id].level = clamp01(st.level, s.level);
          mix.stems[s.id].mute = !!st.mute;
          mix.stems[s.id].solo = !!st.solo;
        });
      }
    } catch (e) {
      /* keep defaults */
    }
    return mix;
  }

  var mix = loadMix();

  function saveMix() {
    save("localStorage", "bite-mix", JSON.stringify(mix));
  }

  /* ---------- Audio graph: stem -> gain -> (analyser) -> filter -> compressor -> master ---------- */
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = AC ? new AC() : null;
  var channels = {};
  var filterNode, masterGain;
  var loaded = false;
  var loadFailed = !ctx;
  var playing = false;
  var wantPlay = false;
  var waitingForGesture = false;
  var startedAt = 0;
  var userPaused = load("localStorage", "bite-music", "on") === "off";

  if (ctx) {
    filterNode = ctx.createBiquadFilter();
    filterNode.type = "lowpass";
    filterNode.Q.value = 0.9;
    var glue = ctx.createDynamicsCompressor();   // keeps boosted faders from clipping
    glue.threshold.value = -10;
    glue.knee.value = 6;
    glue.ratio.value = 4;
    glue.attack.value = 0.005;
    glue.release.value = 0.2;
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    filterNode.connect(glue);
    glue.connect(masterGain);
    masterGain.connect(ctx.destination);
    STEMS.forEach(function (s) {
      var gain = ctx.createGain();
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      gain.connect(filterNode);
      channels[s.id] = { gain: gain, analyser: analyser, data: new Float32Array(analyser.fftSize), meter: 0 };
    });
  }

  function faderGain(v) {
    return v * v * 1.25;              // 0.8 on the fader = unity-ish, top end gives a boost
  }

  function cutoff(v) {
    return 180 * Math.pow(20000 / 180, v);   // 0 = underwater, 1 = wide open
  }

  function applyMix(smooth) {
    if (!ctx) return;
    var t = ctx.currentTime;
    var tc = smooth === false ? 0.001 : 0.04;
    var anySolo = STEMS.some(function (s) { return mix.stems[s.id].solo; });
    STEMS.forEach(function (s) {
      var st = mix.stems[s.id];
      var on = !st.mute && (!anySolo || st.solo);
      channels[s.id].gain.gain.setTargetAtTime(on ? faderGain(st.level) : 0, t, tc);
    });
    filterNode.frequency.setTargetAtTime(cutoff(mix.filter), t, tc);
    if (playing) masterGain.gain.setTargetAtTime(mix.volume, t, 0.05);
  }

  function rampMaster(to, seconds) {
    var t = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(masterGain.gain.value, t);
    masterGain.gain.linearRampToValueAtTime(to, t + (reduceMotion ? 0.05 : seconds));
  }

  function decode(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function loadStems() {
    return Promise.all(STEMS.map(function (s) {
      return fetch(s.src).then(function (res) {
        if (!res.ok) throw new Error(s.src + " " + res.status);
        return res.arrayBuffer();
      }).then(decode).then(function (buffer) {
        channels[s.id].buffer = buffer;
      });
    }));
  }

  // All layers start on the same audio clock tick; each loops at its own length.
  function startSources(offset) {
    var when = ctx.currentTime + 0.06;
    STEMS.forEach(function (s) {
      var c = channels[s.id];
      var src = ctx.createBufferSource();
      src.buffer = c.buffer;
      src.loop = true;
      src.connect(c.gain);
      src.start(when, offset % c.buffer.duration);
      c.source = src;
    });
    startedAt = when - offset;
  }

  // Seconds since the soundscape started (each layer wraps this by its own length)
  function position() {
    return Math.max(0, ctx.currentTime - startedAt);
  }

  function play(fadeSeconds) {
    if (!ctx) return;
    wantPlay = true;
    if (!loaded) {
      render();
      return;
    }
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
      waitingForGesture = true;   // browser won't allow sound until the visitor interacts
      render();
      return;
    }
    waitingForGesture = false;
    playing = true;
    ctx.resume();
    rampMaster(mix.volume, fadeSeconds);
    setTimeout(function () {
      if (playing && ctx.state !== "running") {
        playing = false;
        waitingForGesture = true;
        render();
      }
    }, 500);
    render();
  }

  function pause() {
    wantPlay = false;
    playing = false;
    if (ctx) {
      rampMaster(0, 0.3);
      setTimeout(function () {
        if (!playing) ctx.suspend();
      }, 350);
    }
    render();
  }

  function toggle() {
    if (!playing || waitingForGesture) {
      userPaused = false;
      save("localStorage", "bite-music", "on");
      play(0.8);
    } else {
      userPaused = true;
      save("localStorage", "bite-music", "off");
      pause();
    }
  }

  /* ---------- Dock + mixer markup ---------- */
  var sound = document.createElement("div");
  sound.className = "sound";

  var channelHtml = STEMS.map(function (s) {
    return '<div class="channel" data-stem="' + s.id + '">' +
      '<div class="channel-strip">' +
        '<div class="channel-meter" aria-hidden="true"><span></span></div>' +
        '<input class="channel-fader" type="range" min="0" max="1" step="0.01" aria-label="' + s.label + ' level">' +
      "</div>" +
      '<span class="channel-name">' + s.label + "</span>" +
      '<div class="channel-buttons">' +
        '<button type="button" class="channel-mute" aria-pressed="false" aria-label="Mute ' + s.label + '">M</button>' +
        '<button type="button" class="channel-solo" aria-pressed="false" aria-label="Solo ' + s.label + '">S</button>' +
      "</div>" +
    "</div>";
  }).join("");

  sound.innerHTML =
    '<div class="mixer" id="bite-mixer" role="region" aria-label="Mixer" hidden>' +
      '<div class="mixer-head">' +
        '<span class="mixer-title">The mix</span>' +
        '<button type="button" class="mixer-reset">Reset</button>' +
      "</div>" +
      '<div class="mixer-channels">' + channelHtml + "</div>" +
      '<label class="mixer-filter"><span>Filter</span>' +
        '<input type="range" min="0" max="1" step="0.005" aria-label="Master filter, slide left to muffle">' +
      "</label>" +
    "</div>" +
    '<div class="dock" role="region" aria-label="Sound player">' +
      '<button class="dock-toggle" type="button" aria-label="Play sound">' + ICON_PLAY + "</button>" +
      '<div class="dock-info">' +
        '<span class="dock-title">' + TRACK.title + "</span>" +
        '<span class="dock-sub" aria-live="polite">' + TRACK.sub + "</span>" +
      "</div>" +
      '<div class="dock-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
      '<label class="dock-volume"><span class="visually-hidden">Volume</span>' +
        '<input type="range" min="0" max="1" step="0.01"></label>' +
      '<button class="dock-mix" type="button" aria-expanded="false" aria-controls="bite-mixer" aria-label="Open mixer">' +
        ICON_MIX + "</button>" +
    "</div>";

  var dock = sound.querySelector(".dock");
  var mixer = sound.querySelector(".mixer");
  var toggleBtn = sound.querySelector(".dock-toggle");
  var mixBtn = sound.querySelector(".dock-mix");
  var subLabel = sound.querySelector(".dock-sub");
  var volumeInput = sound.querySelector(".dock-volume input");
  var filterInput = sound.querySelector(".mixer-filter input");

  function renderMixer() {
    var anySolo = STEMS.some(function (s) { return mix.stems[s.id].solo; });
    STEMS.forEach(function (s) {
      var st = mix.stems[s.id];
      var el = sound.querySelector('.channel[data-stem="' + s.id + '"]');
      el.querySelector(".channel-fader").value = String(st.level);
      el.querySelector(".channel-mute").setAttribute("aria-pressed", st.mute ? "true" : "false");
      el.querySelector(".channel-solo").setAttribute("aria-pressed", st.solo ? "true" : "false");
      el.classList.toggle("is-silent", st.mute || (anySolo && !st.solo));
    });
    filterInput.value = String(mix.filter);
    volumeInput.value = String(mix.volume);
  }

  function render() {
    dock.classList.toggle("is-playing", playing);
    dock.classList.toggle("is-waiting", waitingForGesture && !userPaused);
    toggleBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    toggleBtn.setAttribute("aria-label", playing ? "Pause sound" : "Play sound");
    var sub = TRACK.sub;
    if (loadFailed) sub = "Sound needs the local server";
    else if (!loaded) sub = "Loading the layers…";
    else if (waitingForGesture && !userPaused) sub = "Click anywhere to start the sound";
    subLabel.textContent = sub;
    document.querySelectorAll("[data-music-toggle]").forEach(function (btn) {
      btn.textContent = playing ? "Pause the soundscape" : "Play the soundscape";
      btn.setAttribute("aria-pressed", playing ? "true" : "false");
    });
  }

  /* ---------- Mixer: open/close + level meters ---------- */
  var meterRaf = null;

  function drawMeters() {
    STEMS.forEach(function (s) {
      var c = channels[s.id];
      var peak = 0;
      if (playing) {
        c.analyser.getFloatTimeDomainData(c.data);
        for (var i = 0; i < c.data.length; i++) {
          var a = Math.abs(c.data[i]);
          if (a > peak) peak = a;
        }
      }
      c.meter = Math.max(Math.min(1, Math.sqrt(peak) * 1.3), c.meter * 0.88);   // sqrt so quiet layers still move
      var bar = sound.querySelector('.channel[data-stem="' + s.id + '"] .channel-meter span');
      bar.style.transform = "scaleY(" + c.meter.toFixed(3) + ")";
    });
    meterRaf = mixer.hidden ? null : requestAnimationFrame(drawMeters);
  }

  function setMixerOpen(open) {
    mixer.hidden = !open;
    mixBtn.setAttribute("aria-expanded", open ? "true" : "false");
    mixBtn.setAttribute("aria-label", open ? "Close mixer" : "Open mixer");
    dock.classList.toggle("is-mixing", open);
    if (open && ctx && !meterRaf) meterRaf = requestAnimationFrame(drawMeters);
  }

  mixBtn.addEventListener("click", function () {
    setMixerOpen(mixer.hidden);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !mixer.hidden) {
      setMixerOpen(false);
      mixBtn.focus();
    }
  });

  /* ---------- Controls ---------- */
  toggleBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    toggle();
  });

  volumeInput.addEventListener("input", function () {
    mix.volume = clamp01(volumeInput.value, mix.volume);
    applyMix();
    saveMix();
  });

  filterInput.addEventListener("input", function () {
    mix.filter = clamp01(filterInput.value, mix.filter);
    applyMix();
    saveMix();
  });

  STEMS.forEach(function (s) {
    var el = sound.querySelector('.channel[data-stem="' + s.id + '"]');
    el.querySelector(".channel-fader").addEventListener("input", function (e) {
      mix.stems[s.id].level = clamp01(e.target.value, s.level);
      applyMix();
      saveMix();
    });
    el.querySelector(".channel-mute").addEventListener("click", function () {
      mix.stems[s.id].mute = !mix.stems[s.id].mute;
      applyMix();
      renderMixer();
      saveMix();
    });
    el.querySelector(".channel-solo").addEventListener("click", function () {
      mix.stems[s.id].solo = !mix.stems[s.id].solo;
      applyMix();
      renderMixer();
      saveMix();
    });
  });

  sound.querySelector(".mixer-reset").addEventListener("click", function () {
    mix = JSON.parse(JSON.stringify(DEFAULT_MIX));
    applyMix();
    renderMixer();
    saveMix();
  });

  // First real interaction anywhere starts the music if the browser blocked it.
  function onFirstGesture(e) {
    if (!wantPlay || userPaused || playing) return;
    if (e.target && e.target.closest && e.target.closest(".dock-toggle")) return;
    play(2);
  }
  ["pointerdown", "pointerup", "touchend", "keydown"].forEach(function (type) {
    document.addEventListener(type, onFirstGesture, true);
  });

  // Remember position if the browser does a full page load (fallback path).
  window.addEventListener("pagehide", function () {
    if (loaded) save("sessionStorage", "bite-time", String(position()));
  });

  function startMusic() {
    document.body.appendChild(sound);
    renderMixer();
    render();
    if (!ctx) return;
    if (!userPaused) wantPlay = true;
    loadStems().then(function () {
      loaded = true;
      startSources(parseFloat(load("sessionStorage", "bite-time", "0")) || 0);
      applyMix(false);
      if (!playing) ctx.suspend();
      if (wantPlay && !userPaused) play(2.5);
      render();
    }).catch(function () {
      loadFailed = true;
      render();
    });
  }


  /* 
     2. PAGE SWAPPING
     Swaps header, main and footer from the target page so the audio element
     (and the dock) survive navigation. Needs http:// — on file:// fetch is
     blocked, so it quietly falls back to a normal page load.
      */

  var canSwap = window.location.protocol.indexOf("http") === 0 && "fetch" in window && "DOMParser" in window;

  function isInternalPage(a) {
    if (!a || a.target || a.hasAttribute("download")) return false;
    var url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    if (!/\.html?$|\/$/.test(url.pathname)) return false;
    // Same page, only a hash change: let the browser handle it
    if (url.pathname === window.location.pathname && url.hash) return false;
    return true;
  }

  function swapTo(href, push) {
    return fetch(href).then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      ["header.site-header", "main", "footer.site-footer"].forEach(function (sel) {
        var next = doc.querySelector(sel);
        var current = document.querySelector(sel);
        if (next && current) current.replaceWith(document.importNode(next, true));
      });
      document.title = doc.title;
      if (push) history.pushState({ bite: true }, "", href);
      var hash = new URL(href, window.location.href).hash;
      var target = hash && document.querySelector(hash);
      if (target) {
        target.scrollIntoView();
      } else {
        window.scrollTo(0, 0);
      }
      var main = document.querySelector("main");
      if (main) {
        main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }
      initPage();
    }).catch(function () {
      window.location.href = href;
    });
  }

  if (canSwap) {
    history.replaceState({ bite: true }, "", window.location.href);

    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest("a[href]");
      if (!isInternalPage(a)) return;
      e.preventDefault();
      swapTo(a.href, true);
    });

    window.addEventListener("popstate", function () {
      swapTo(window.location.href, false);
    });
  }


  /* 
     3. FILMSTRIP
     */

  function initFilmstrip(strip) {
    var track = strip.querySelector(".strip-track");
    var slides = Array.prototype.slice.call(track.querySelectorAll(".slide"));
    var prevBtn = strip.querySelector("[data-prev]");
    var nextBtn = strip.querySelector("[data-next]");
    var counter = strip.querySelector("[data-current]");
    var bar = strip.querySelector(".strip-progress span");
    var current = 0;
    var ticking = false;

    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function setActive(i) {
      current = i;
      slides.forEach(function (s, k) {
        s.classList.toggle("is-active", k === i);
      });
      if (counter) counter.textContent = pad(i + 1);
      if (bar) bar.style.width = ((i + 1) / slides.length) * 100 + "%";
      if (prevBtn) prevBtn.disabled = i === 0;
      if (nextBtn) nextBtn.disabled = i === slides.length - 1;
    }

    function nearest() {
      var mid = track.scrollLeft + track.clientWidth / 2;
      var best = 0;
      var bestDist = Infinity;
      slides.forEach(function (s, k) {
        var d = Math.abs(s.offsetLeft + s.offsetWidth / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      });
      return best;
    }

    function go(i) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      var s = slides[i];
      track.scrollTo({
        left: s.offsetLeft - (track.clientWidth - s.offsetWidth) / 2,
        behavior: reduceMotion ? "auto" : "smooth"
      });
    }

    track.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var n = nearest();
        if (n !== current) setActive(n);
      });
    }, { passive: true });

    if (prevBtn) prevBtn.addEventListener("click", function () { go(current - 1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { go(current + 1); });

    // Clicking a side photo brings it to the centre
    slides.forEach(function (s, k) {
      s.addEventListener("click", function () {
        if (!dragMoved && k !== current) go(k);
      });
    });

    // Arrow keys while the strip (or anything in it) has focus
    strip.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(current + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(current - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(slides.length - 1);
      }
    });

    // Mouse drag to sift (touch already scrolls natively)
    var dragging = false;
    var dragMoved = false;
    var startX = 0;
    var startScroll = 0;

    track.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      dragging = true;
      dragMoved = false;
      startX = e.clientX;
      startScroll = track.scrollLeft;
      track.classList.add("is-dragging");
    });

    window.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 4) dragMoved = true;
      track.scrollLeft = startScroll - dx;
    });

    window.addEventListener("pointerup", function () {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      go(nearest());
      // let the click handler see dragMoved, then reset
      setTimeout(function () { dragMoved = false; }, 0);
    });

    track.querySelectorAll("img").forEach(function (img) {
      img.setAttribute("draggable", "false");
    });

    setActive(0);
  }


  /* 
     4. DEVELOP ON TAP
     Hover/focus is pure CSS. Touch screens have no hover, so a tap adds
     .is-developing for a few seconds to play the same animation.
      */

  function initDevelop(root) {
    root.querySelectorAll(".photo-frame").forEach(function (frame) {
      frame.addEventListener("pointerup", function (e) {
        if (e.pointerType === "mouse") return;
        frame.classList.remove("is-developing");
        void frame.offsetWidth;                // restart the animation
        frame.classList.add("is-developing");
        clearTimeout(frame.developTimer);
        frame.developTimer = setTimeout(function () {
          frame.classList.remove("is-developing");
        }, 3000);
      });
    });
  }


  /* 
     PAGE INIT — runs on first load and after every page swap
      */

  function initMusicButtons(root) {
    root.querySelectorAll("[data-music-toggle]").forEach(function (btn) {
      btn.addEventListener("click", toggle);
    });
    root.querySelectorAll("[data-mixer-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setMixerOpen(true);
        if (!playing && !userPaused) play(0.8);
        sound.querySelector(".channel-fader").focus();
      });
    });
    render();
  }

  function initPage() {
    var main = document.querySelector("main") || document;
    main.querySelectorAll("[data-filmstrip]").forEach(initFilmstrip);
    initDevelop(main);
    initMusicButtons(main);
  }

  document.documentElement.classList.add("js");
  startMusic();
  initPage();
})();
