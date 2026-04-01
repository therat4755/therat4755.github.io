const fileInput = document.getElementById("file-input");
const statsEl = document.getElementById("stats");
const aiStatusEl = document.getElementById("ai-status");
const codeOutput = document.getElementById("code-output");
const hzOutput = document.getElementById("hz-output");
const playBtn = document.getElementById("play-preview");
const vizCanvas = document.getElementById("viz-canvas");
const vizModeSelect = document.getElementById("viz-mode");
const hotBanner = document.getElementById("hot-banner");

let audioBuffer = null;
let currentSampleRate = 8000;
let currentFormula = "t*5&t>>7";
let audioCtx = null;
let previewSource = null;
let encodedLength = 0;

// visualizer state
let vizCtx = vizCanvas.getContext("2d");
let analyser = null;
let freqData = null;
let timeData = null;
let vizAnimId = null;

// initialize UI with default bytebeat so it can be heard immediately
hzOutput.value = currentSampleRate;
codeOutput.value = currentFormula;
playBtn.disabled = false;

// ensure canvas has proper pixel size for current layout
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = vizCanvas.getBoundingClientRect();
  const width = rect.width || 1;
  const height = rect.height || 1;
  if (vizCanvas.width !== width * dpr || vizCanvas.height !== height * dpr) {
    vizCanvas.width = width * dpr;
    vizCanvas.height = height * dpr;
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// show floating "hot page" banner once on load
function showHotBannerOnce() {
  if (!hotBanner) return;
  if (sessionStorage.getItem("hotBannerShown")) return;

  sessionStorage.setItem("hotBannerShown", "1");

  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;

  // random-ish positions
  const startX = -40; // just off the left edge
  const startY = Math.random() * (vh * 0.4) + vh * 0.1; // somewhere in upper-middle
  const midX = vw * (0.4 + Math.random() * 0.2);
  const midY = vh * (0.1 + Math.random() * 0.2);
  const endX = vw * (1.1 + Math.random() * 0.3); // off right side
  const endY = -vh * (0.1 + Math.random() * 0.2); // fly upward

  hotBanner.style.setProperty("--start-x", `${startX}px`);
  hotBanner.style.setProperty("--start-y", `${startY}px`);
  hotBanner.style.setProperty("--mid-x", `${midX}px`);
  hotBanner.style.setProperty("--mid-y", `${midY}px`);
  hotBanner.style.setProperty("--end-x", `${endX}px`);
  hotBanner.style.setProperty("--end-y", `${endY}px`);

  hotBanner.classList.remove("hidden");

  const handleEnd = () => {
    hotBanner.classList.add("hidden");
    hotBanner.removeEventListener("animationend", handleEnd);
  };
  hotBanner.addEventListener("animationend", handleEnd);
}

// delay a bit so layout is ready
window.addEventListener("load", () => {
  setTimeout(showHotBannerOnce, 400);
});

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  resetPlayback();
  aiStatusEl.textContent = "";
  codeOutput.value = "";
  hzOutput.value = "";
  statsEl.textContent = "Decoding audio…";

  try {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(arrayBuf);
    audioBuffer = buf;
    encodedLength = buf.length;
    const stats = analyseBuffer(buf);
    renderStats(stats, file);
    generateExactBytebeatFromBuffer(buf, file.name);
  } catch (err) {
    console.error(err);
    statsEl.textContent = "Error decoding audio";
    aiStatusEl.textContent = "";
  }
});

function analyseBuffer(buf) {
  const duration = buf.duration;
  const sampleRate = buf.sampleRate;
  const chData = buf.getChannelData(0);
  const len = chData.length;

  let peak = 0;
  let sumSquares = 0;
  let zeroCrossings = 0;
  let prevSign = Math.sign(chData[0] || 0);

  for (let i = 0; i < len; i++) {
    const v = chData[i];
    const av = Math.abs(v);
    if (av > peak) peak = av;
    sumSquares += v * v;
    const s = Math.sign(v);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) zeroCrossings++;
    if (s !== 0) prevSign = s;
  }

  const rms = Math.sqrt(sumSquares / len);
  const zcr = (zeroCrossings / len) * (sampleRate / 2);

  const sampleWindow = Math.min(len, sampleRate * 2);
  let energyLow = 0;
  let energyHigh = 0;
  for (let i = 0; i < sampleWindow; i += 3) {
    const v = chData[i];
    const idxNorm = i / sampleWindow;
    if (idxNorm < 0.4) energyLow += v * v;
    else energyHigh += v * v;
  }

  // downsample a short snapshot of the waveform for stats only
  const snapshotSeconds = Math.min(2, duration);
  const snapshotLen = Math.min(len, Math.floor(sampleRate * snapshotSeconds));
  const downCount = 128;
  const samplesPreview = [];
  if (snapshotLen > 0) {
    const step = Math.max(1, Math.floor(snapshotLen / downCount));
    for (let i = 0; i < snapshotLen && samplesPreview.length < downCount; i += step) {
      samplesPreview.push(+chData[i].toFixed(4));
    }
  }

  return {
    duration,
    sampleRate,
    length: len,
    peak: +peak.toFixed(3),
    rms: +rms.toFixed(3),
    zeroCrossRateHz: +zcr.toFixed(1),
    energyLow: +energyLow.toFixed(3),
    energyHigh: +energyHigh.toFixed(3),
    samplesPreview,
  };
}

function renderStats(stats, file) {
  const parts = [];
  parts.push(`${file.name}`);
  parts.push(`${stats.duration.toFixed(2)}s`);
  parts.push(`${(stats.sampleRate / 1000).toFixed(1)}kHz`);
  parts.push(`rms ${stats.rms}`);
  parts.push(`peak ${stats.peak}`);
  parts.push(`zeroX ~${stats.zeroCrossRateHz}Hz`);
  statsEl.innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
}

function generateExactBytebeatFromBuffer(buf, fileName) {
  const chData = buf.getChannelData(0);
  const len = chData.length;
  const sr = clampSampleRate(buf.sampleRate);

  // Map -1..1 float samples to 0..255 integers
  const ints = new Array(len);
  for (let i = 0; i < len; i++) {
    let v = chData[i];
    if (!Number.isFinite(v)) v = 0;
    let s = Math.round(((v + 1) / 2) * 255);
    if (s < 0) s = 0;
    if (s > 255) s = 255;
    ints[i] = s;
  }

  const arrLiteral = ints.join(",");
  const code = `t<${len}?[${arrLiteral}][t]:0`;

  currentSampleRate = sr;
  currentFormula = code;
  encodedLength = len;

  hzOutput.value = sr;
  codeOutput.value = code;

  aiStatusEl.textContent = `Exact sample playback bytebeat for "${fileName}" generated. Set bytebeat speed to ${sr} Hz.`;
  playBtn.disabled = false;
}

function clampSampleRate(sr) {
  let n = Number(sr) || 8000;
  if (!Number.isFinite(n)) n = 8000;
  if (n < 4000) n = 4000;
  if (n > 48000) n = 48000;
  return Math.round(n);
}

playBtn.addEventListener("click", () => {
  if (!currentFormula) return;
  if (playBtn.dataset.state === "playing") {
    stopPlayback();
    return;
  }
  startPlayback();
});

vizModeSelect.addEventListener("change", () => {
  // force a redraw on mode change
  if (playBtn.dataset.state === "playing") {
    // nothing special, draw loop already running
  } else {
    clearCanvas();
  }
});

function resetPlayback() {
  stopPlayback();
}

function stopPlayback() {
  if (previewSource) {
    previewSource.stop();
    previewSource.disconnect();
    previewSource = null;
  }
  stopVisualizer();
  if (audioCtx) {
    // keep context for reuse, do not close to avoid user gesture issues
  }
  playBtn.dataset.state = "";
  playBtn.textContent = "▶ preview";
}

function startPlayback() {
  try {
    const fn = new Function(
      "t",
      `return (${codeOutput.value || currentFormula});`
    );
    const sr = clampSampleRate(Number(hzOutput.value) || currentSampleRate);
    currentSampleRate = sr;
    hzOutput.value = sr;

    const totalSamples = encodedLength > 0 ? encodedLength : Math.floor(sr * 6);
    const buffer = new Float32Array(totalSamples);

    for (let t = 0; t < totalSamples; t++) {
      let v;
      try {
        v = fn(t);
      } catch {
        v = 0;
      }
      if (!Number.isFinite(v)) v = 0;
      let s = v;
      if (s > 255) s = 255;
      if (s < 0) s = 0;
      buffer[t] = (s - 128) / 128;
    }

    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const abuf = audioCtx.createBuffer(1, totalSamples, sr);
    abuf.getChannelData(0).set(buffer);

    const src = audioCtx.createBufferSource();
    src.buffer = abuf;

    // setup analyser for visuals
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      const bufferLength = analyser.frequencyBinCount;
      freqData = new Uint8Array(bufferLength);
      timeData = new Uint8Array(bufferLength);
    }

    src.connect(analyser);
    analyser.connect(audioCtx.destination);

    src.start();
    previewSource = src;

    src.onended = () => {
      if (previewSource === src) {
        stopPlayback();
      }
    };

    playBtn.dataset.state = "playing";
    playBtn.textContent = "■ stop";

    startVisualizer();
  } catch (err) {
    console.error(err);
    aiStatusEl.textContent = "Error evaluating bytebeat code.";
  }
}

function clearCanvas() {
  resizeCanvas();
  vizCtx.fillStyle = "#050505";
  vizCtx.fillRect(0, 0, vizCanvas.width, vizCanvas.height);
}

function startVisualizer() {
  stopVisualizer();
  clearCanvas();
  const draw = () => {
    if (!analyser) return;
    resizeCanvas();
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);
    const mode = vizModeSelect.value;
    drawVisualizer(mode);
    vizAnimId = requestAnimationFrame(draw);
  };
  vizAnimId = requestAnimationFrame(draw);
}

function stopVisualizer() {
  if (vizAnimId !== null) {
    cancelAnimationFrame(vizAnimId);
    vizAnimId = null;
  }
  clearCanvas();
}

function drawVisualizer(mode) {
  const w = vizCanvas.width;
  const h = vizCanvas.height;
  vizCtx.save();
  vizCtx.clearRect(0, 0, w, h);
  vizCtx.fillStyle = "#050505";
  vizCtx.fillRect(0, 0, w, h);

  const len = freqData.length;
  const barCount = 64;
  const step = Math.max(1, Math.floor(len / barCount));

  const avgLevel =
    freqData.reduce((a, b) => a + b, 0) / (freqData.length * 255 || 1);

  switch (mode) {
    case "wave": {
      vizCtx.strokeStyle = "#35c759";
      vizCtx.lineWidth = 2;
      vizCtx.beginPath();
      const slice = w / timeData.length;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 255;
        const y = v * h;
        const x = i * slice;
        if (i === 0) vizCtx.moveTo(x, y);
        else vizCtx.lineTo(x, y);
      }
      vizCtx.stroke();
      break;
    }
    case "circles": {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) / 2;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const r = (v * maxR) * 0.9;
        vizCtx.beginPath();
        vizCtx.strokeStyle = `rgba(138,180,255,${0.05 + v * 0.5})`;
        vizCtx.lineWidth = 1 + v * 3;
        vizCtx.arc(cx, cy, r, 0, Math.PI * 2);
        vizCtx.stroke();
      }
      break;
    }
    case "vsa": {
      vizCtx.strokeStyle = "#ffcc00";
      vizCtx.lineWidth = 1.5;
      vizCtx.beginPath();
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const x = (i / (barCount - 1)) * w;
        const y = h * (0.5 - (v - 0.5) * 0.9);
        if (i === 0) vizCtx.moveTo(x, y);
        else vizCtx.lineTo(x, y);
      }
      vizCtx.stroke();
      break;
    }
    case "glorp": {
      const cx = w / 2;
      const cy = h / 2;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const angle = (i / barCount) * Math.PI * 2;
        const r = (0.2 + v * 0.8) * Math.min(w, h) * 0.5;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        vizCtx.fillStyle = `rgba(173,255,47,${0.1 + v * 0.7})`;
        vizCtx.beginPath();
        vizCtx.arc(x, y, 3 + v * 8, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    case "redring": {
      const cx = w / 2;
      const cy = h / 2;
      const baseR = Math.min(w, h) * 0.35;
      vizCtx.strokeStyle = `rgba(255,50,50,${0.4 + avgLevel * 0.6})`;
      vizCtx.lineWidth = 4 + avgLevel * 8;
      vizCtx.beginPath();
      vizCtx.arc(cx, cy, baseR + avgLevel * baseR * 0.5, 0, Math.PI * 2);
      vizCtx.stroke();
      break;
    }
    case "bars": {
      const barWidth = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const bh = v * h;
        const x = i * barWidth;
        vizCtx.fillStyle = `rgba(0,200,255,${0.2 + v * 0.8})`;
        vizCtx.fillRect(x, h - bh, barWidth * 0.9, bh);
      }
      break;
    }
    case "radial": {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) / 2;
      vizCtx.lineWidth = 2;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const angle = (i / barCount) * Math.PI * 2;
        const r = v * maxR;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        vizCtx.strokeStyle = `rgba(255,255,255,${0.05 + v * 0.7})`;
        vizCtx.beginPath();
        vizCtx.moveTo(cx, cy);
        vizCtx.lineTo(x, y);
        vizCtx.stroke();
      }
      break;
    }
    case "spiral": {
      const cx = w / 2;
      const cy = h / 2;
      vizCtx.strokeStyle = "#ffa500";
      vizCtx.lineWidth = 1.5;
      vizCtx.beginPath();
      let angle = 0;
      const turns = 3;
      const maxR = Math.min(w, h) / 2;
      const totalSteps = barCount * turns;
      for (let i = 0; i < totalSteps; i++) {
        const idx = Math.floor((i / totalSteps) * len);
        const v = freqData[idx] / 255;
        const r = (i / totalSteps) * maxR * (0.3 + v * 0.7);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) vizCtx.moveTo(x, y);
        else vizCtx.lineTo(x, y);
        angle += (Math.PI * 2 * turns) / totalSteps;
      }
      vizCtx.stroke();
      break;
    }
    case "shards": {
      const cx = w / 2;
      const cy = h / 2;
      vizCtx.lineWidth = 1.5;
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const angle = ((i + 0.5) / barCount) * Math.PI * 2;
        const r = (0.2 + v * 0.8) * Math.min(w, h) / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        vizCtx.strokeStyle = `rgba(0,255,200,${0.1 + v * 0.7})`;
        vizCtx.beginPath();
        vizCtx.moveTo(cx, cy);
        vizCtx.lineTo(x, y);
        vizCtx.stroke();
      }
      break;
    }
    case "grid": {
      const rows = 8;
      const cols = 16;
      const cellW = w / cols;
      const cellH = h / rows;
      let idx = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = freqData[idx] / 255;
          idx = (idx + step) % len;
          vizCtx.fillStyle = `rgba(180,180,255,${0.05 + v * 0.9})`;
          vizCtx.fillRect(c * cellW, r * cellH, cellW - 1, cellH - 1);
        }
      }
      break;
    }
    case "pulse": {
      const centerY = h / 2;
      vizCtx.strokeStyle = "#ff2d55";
      vizCtx.lineWidth = 3;
      vizCtx.beginPath();
      const slice = w / timeData.length;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 255;
        const y = centerY + (v - 0.5) * h * 0.8;
        const x = i * slice;
        if (i === 0) vizCtx.moveTo(x, y);
        else vizCtx.lineTo(x, y);
      }
      vizCtx.stroke();
      vizCtx.fillStyle = `rgba(255,45,85,${0.3 + avgLevel * 0.7})`;
      vizCtx.fillRect(0, centerY - 2, w, 4);
      break;
    }
    case "lava": {
      const columns = barCount;
      const colW = w / columns;
      for (let i = 0; i < columns; i++) {
        const v = freqData[i * step] / 255;
        const top = h * (1 - v);
        const grd = vizCtx.createLinearGradient(0, top, 0, h);
        grd.addColorStop(0, `rgba(255,${80 + v * 100},0,1)`);
        grd.addColorStop(1, `rgba(120,0,0,0.9)`);
        vizCtx.fillStyle = grd;
        vizCtx.fillRect(i * colW, top, colW + 1, h - top);
      }
      break;
    }
    case "comet": {
      const maxTail = barCount;
      const baseY = h * 0.3;
      vizCtx.strokeStyle = "#00e5ff";
      vizCtx.lineWidth = 2;
      vizCtx.beginPath();
      for (let i = 0; i < maxTail; i++) {
        const v = freqData[i * step] / 255;
        const x = (i / (maxTail - 1)) * w;
        const y = baseY + v * h * 0.5;
        if (i === 0) vizCtx.moveTo(x, y);
        else vizCtx.lineTo(x, y);
      }
      vizCtx.stroke();
      for (let i = 0; i < 5; i++) {
        const idx = i * step * 3;
        const v = freqData[idx % len] / 255;
        const x = (idx / len) * w;
        const y = baseY + v * h * 0.5;
        vizCtx.fillStyle = `rgba(0,229,255,${0.3 + v * 0.7})`;
        vizCtx.beginPath();
        vizCtx.arc(x, y, 4 + v * 6, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    case "tunnel": {
      const cx = w / 2;
      const cy = h / 2;
      const rings = 6;
      const maxR = Math.min(w, h) / 2;
      for (let i = 0; i < rings; i++) {
        const idx = Math.floor((i / rings) * len);
        const v = freqData[idx] / 255;
        const r = ((i + 1) / rings) * maxR;
        vizCtx.strokeStyle = `rgba(150,150,255,${0.1 + v * 0.7})`;
        vizCtx.lineWidth = 1 + v * 3;
        vizCtx.beginPath();
        vizCtx.arc(cx, cy, r, 0, Math.PI * 2);
        vizCtx.stroke();
      }
      break;
    }
    case "nebula": {
      for (let i = 0; i < barCount * 2; i++) {
        const idx = (i * step) % len;
        const v = freqData[idx] / 255;
        const x = (i / (barCount * 2)) * w;
        const y = (timeData[idx] / 255) * h;
        vizCtx.fillStyle = `rgba(150,${100 + v * 155},255,${0.05 + v * 0.5})`;
        vizCtx.beginPath();
        vizCtx.arc(x, y, 2 + v * 6, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    case "glitch": {
      const rows = 10;
      const rowH = h / rows;
      for (let r = 0; r < rows; r++) {
        const idx = (r * step * 7) % len;
        const v = freqData[idx] / 255;
        const offset = (v - 0.5) * 40;
        vizCtx.fillStyle = `rgba(${200 + v * 55},0,${200 - v * 150},${
          0.2 + v * 0.8
        })`;
        vizCtx.fillRect(offset, r * rowH, w, rowH * 0.8);
      }
      break;
    }
    case "radar": {
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2;
      vizCtx.strokeStyle = "#1aff1a";
      vizCtx.lineWidth = 1;
      vizCtx.beginPath();
      vizCtx.arc(cx, cy, r, 0, Math.PI * 2);
      vizCtx.stroke();
      const beamStrength = avgLevel;
      const angle = (Date.now() / 400) % (Math.PI * 2);
      const beamLen = r * (0.4 + beamStrength * 0.6);
      vizCtx.strokeStyle = `rgba(26,255,26,${0.3 + beamStrength * 0.7})`;
      vizCtx.lineWidth = 2;
      vizCtx.beginPath();
      vizCtx.moveTo(cx, cy);
      vizCtx.lineTo(cx + Math.cos(angle) * beamLen, cy + Math.sin(angle) * beamLen);
      vizCtx.stroke();
      for (let i = 0; i < barCount; i++) {
        const v = freqData[i * step] / 255;
        const ra = (i / barCount) * r;
        vizCtx.fillStyle = `rgba(26,255,26,${v * 0.5})`;
        vizCtx.beginPath();
        vizCtx.arc(cx, cy, ra, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    case "bloom": {
      const cx = w / 2;
      const cy = h / 2;
      const petals = 12;
      const maxR = Math.min(w, h) / 2;
      for (let i = 0; i < petals; i++) {
        const idx = (i * step * 3) % len;
        const v = freqData[idx] / 255;
        const angle = (i / petals) * Math.PI * 2;
        const r = (0.3 + v * 0.7) * maxR;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        const grd = vizCtx.createRadialGradient(cx, cy, 0, x, y, r * 0.6);
        grd.addColorStop(0, `rgba(255,200,200,0)`);
        grd.addColorStop(1, `rgba(255,${150 + v * 100},0,0.8)`);
        vizCtx.fillStyle = grd;
        vizCtx.beginPath();
        vizCtx.arc(x, y, r * 0.4, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    case "stripes": {
      const stripes = 24;
      const stripeW = w / stripes;
      for (let i = 0; i < stripes; i++) {
        const idx = (i * step * 2) % len;
        const v = freqData[idx] / 255;
        const hue = 200 + v * 80;
        vizCtx.fillStyle = `hsla(${hue},80%,60%,${0.1 + v * 0.7})`;
        vizCtx.fillRect(i * stripeW, 0, stripeW, h);
      }
      break;
    }
    case "orbit": {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) / 2;
      const planets = 6;
      for (let i = 0; i < planets; i++) {
        const idx = (i * step * 5) % len;
        const v = freqData[idx] / 255;
        const orbitR = ((i + 1) / (planets + 1)) * maxR;
        vizCtx.strokeStyle = "rgba(255,255,255,0.1)";
        vizCtx.beginPath();
        vizCtx.arc(cx, cy, orbitR, 0, Math.PI * 2);
        vizCtx.stroke();
        const angle = ((Date.now() / 600) + i * 0.7) % (Math.PI * 2);
        const x = cx + Math.cos(angle) * orbitR;
        const y = cy + Math.sin(angle) * orbitR;
        vizCtx.fillStyle = `rgba(255,255,255,${0.3 + v * 0.7})`;
        vizCtx.beginPath();
        vizCtx.arc(x, y, 3 + v * 5, 0, Math.PI * 2);
        vizCtx.fill();
      }
      break;
    }
    default:
      break;
  }

  vizCtx.restore();
}