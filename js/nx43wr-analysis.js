// nx43wr-analysis.js
// Drives the NX-43WR Waveform Analysis page.
//
// Reuses the existing AuralisationLite analysis modules:
//   - timeWeight.js  : timeWeight(), signalToSPL(), decimateSignal()
//   - freqWeight.js  : freqWeight() — A/C/Z weighting (BS EN 61672-1 design goals)
//   - octFilt.js     : octFilt()
//   - fftSPL.js      : fftSPL()
//   - sonogramSPL.js : sonogramSPL()
//
// Calibration:
//   AuralisationLite uses a fullScale multiplier where pressure_in_Pa =
//   normalized_sample * fullScale. NX-43WR's RIFF chunk gives us
//   scaleFactor where pressure_in_Pa = raw_integer * scaleFactor, and
//   raw_integer = normalized_sample * 2^(nbits-1). So the equivalent
//   fullScale for AuralisationLite-compatible Pa scaling is
//   scaleFactor * 2^(nbits-1).

let reader = null;
let currentTab = 'timehistory';

// Cached after upload
let cachedSignalPa = null;   // calibrated signal in Pa (Float32Array)
let cachedFs = null;
let cachedFileName = '';
let cachedDuration = 0;

// Active charts (one per tab)
const charts = {};
let animationFrameId = null;

// Cached spectrogram time range so the playhead can position itself
let spectrogramTimeRange = null;
let bs4142SpectrogramTimeRange = null;

// BS 4142 selection state
let selectActive = false;
let selectDragging = false;
let selectStart = null;       // { plotKey, x } in plot-wrapper-relative pixels
let selectedRegions = [];     // [{ tStart, tEnd }] sorted ascending

// Cache of the Lp time series displayed on the BS 4142 chart, kept so the
// L90 tiles can derive percentiles from the same numbers shown on the plot.
// Sample step is fixed at 100 ms (set in renderBs4142TimeChart).
let bs4142LpCache = null;     // { values: Float32Array, fw: 'Lin'|'A'|'C' }

// ---------------------------------------------------------------------------
//  Initialisation
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    console.log('NX-43WR Analysis: Initializing...');
    reader = new NX43WRReader();

    setupUpload();
    setupTabs();
    setupControlListeners();
    setupPlayhead();
    setupZoom();
    setupResetRange();
    setupSelection();
});

// ---------------------------------------------------------------------------
//  Upload bar
// ---------------------------------------------------------------------------
function setupUpload() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') fileInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.backgroundColor = '#f5e6e6';
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.style.backgroundColor = '#ffffff';
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.backgroundColor = '#ffffff';
        if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });
}

async function handleFile(file) {
    hideError();

    if (!file.name.toLowerCase().endsWith('.wav')) {
        showError('Please select a .wav file');
        return;
    }

    const result = await reader.readWAVFile(file);
    if (!result.success) {
        showError('Could not read file: ' + result.error);
        return;
    }

    // Extract calibrated signal in Pascals (channel 0 only — mono).
    const samples = result.audioBuffer.getChannelData(0);
    const scale = result.metadata.scaleFactor;
    if (!scale || !isFinite(scale)) {
        showError('No Rion calibration chunk found in this WAV file');
        return;
    }

    // The Web Audio API normalises to [-1,1], dividing by 2^(nbits-1).
    // To get Pa: multiply normalised value by 2^(nbits-1) * scaleFactor.
    // The bit depth is known to the WAV but not surfaced in AudioBuffer,
    // so use the value parsed by NX43WRReader (defaults to 24 for NX-43WR).
    const nbits = result.metadata.nBits || 24;
    const norm = Math.pow(2, nbits - 1);
    const pa = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        pa[i] = samples[i] * norm * scale;
    }

    cachedSignalPa = pa;
    cachedFs = result.sampleRate;
    cachedFileName = file.name;
    cachedDuration = result.duration;

    populateFileInfo(file, result);
    setupAudioPlayer(file);

    document.getElementById('chartRow').style.display = '';
    runAnalysis();   // render whichever tab is currently active
}

// ---------------------------------------------------------------------------
//  File info bar + audio player
// ---------------------------------------------------------------------------
function populateFileInfo(file, result) {
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileSampleRate').textContent =
        (result.sampleRate / 1000).toFixed(1) + ' kHz';
    document.getElementById('fileDuration').textContent =
        result.duration.toFixed(2) + ' s';

    const cal = result.metadata.scaleFactor;
    document.getElementById('fileCalibration').textContent =
        cal ? cal.toExponential(3) + ' Pa/count' : 'No Rion chunk';

    if (result.metadata.fullScaleRange) {
        document.getElementById('fileRange').textContent = result.metadata.fullScaleRange;
        document.getElementById('fileRangeInfo').style.display = '';
    } else {
        document.getElementById('fileRangeInfo').style.display = 'none';
    }

    if (result.metadata.recordingTime) {
        document.getElementById('fileDate').textContent = result.metadata.recordingTime;
        document.getElementById('fileDateInfo').style.display = '';
    } else {
        document.getElementById('fileDateInfo').style.display = 'none';
    }

    document.getElementById('fileInfo').style.display = 'flex';
}

function setupAudioPlayer(file) {
    const player = document.getElementById('audioPlayer');
    const wrapper = document.getElementById('playerWrapper');
    player.src = URL.createObjectURL(file);
    wrapper.style.display = 'flex';
}

// ---------------------------------------------------------------------------
//  Tab switching and per-tab control visibility
// ---------------------------------------------------------------------------
function setupTabs() {
    const tabBtns = document.querySelectorAll('.analysis-tabs .tab-btn');
    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            tabBtns.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            cancelZoom();      // exit zoom mode if user switches tabs
            cancelSelect();    // exit selection mode too
            updateControlVisibility();
            updateCanvasVisibility();
            if (cachedSignalPa) runAnalysis();
        });
    });
    updateControlVisibility();
}

function updateControlVisibility() {
    document.querySelectorAll('.tab-control').forEach((el) => {
        const forTabs = (el.dataset.for || '').split(/\s+/);
        // Use explicit 'flex' so we override any inline display:none
        // and don't depend on Bootstrap's d-flex class taking precedence.
        el.style.display = forTabs.includes(currentTab) ? 'flex' : 'none';
    });
}

function updateCanvasVisibility() {
    document.querySelectorAll('.tab-chart').forEach((el) => {
        el.style.display = el.dataset.tab === currentTab ? '' : 'none';
    });
}

// ---------------------------------------------------------------------------
//  Run analysis for the current tab
//
//  The heavier calculations (octave filter cascade, spectrogram FFTs)
//  are synchronous CPU-bound work that would freeze the page if invoked
//  directly. We show a loading overlay first, yield to the browser via
//  requestAnimationFrame + setTimeout so the spinner can actually paint,
//  then run the work, then hide the overlay.
// ---------------------------------------------------------------------------
function runAnalysis() {
    if (!cachedSignalPa) return;

    const tab = currentTab;
    const labels = {
        timehistory: 'Computing time-weighted level...',
        octave:      'Computing octave bands...',
        fft:         'Computing FFT spectrum...',
        spectrogram: 'Computing spectrogram...',
        bs4142:      'Computing BS 4142 view...'
    };
    showOverlay(labels[tab] || 'Computing...');

    // Yield to the browser so the overlay paints before the heavy work starts
    requestAnimationFrame(() => setTimeout(async () => {
        try {
            switch (tab) {
                case 'timehistory': await renderTimeHistory(); break;
                case 'octave':      await renderOctave();      break;
                case 'fft':         await renderFFT();         break;
                case 'spectrogram': await renderSpectrogram(); break;
                case 'bs4142':      await renderBs4142();      break;
            }
        } catch (e) {
            console.error('Analysis error:', e);
            showError('Analysis failed: ' + e.message);
        } finally {
            hideOverlay();
        }
    }, 0));
}

function showOverlay(label) {
    document.getElementById('overlayLabel').textContent = label;
    document.getElementById('chartOverlay').style.display = 'flex';
}
function hideOverlay() {
    document.getElementById('chartOverlay').style.display = 'none';
}

// ---------------------------------------------------------------------------
//  Tab 1: Level vs. Time
// ---------------------------------------------------------------------------
async function renderTimeHistory(canvasId = 'timehistoryChart', chartKey = 'timehistory', heightOverride = null) {
    const tau = getTimeWeightTau();
    const fw = getFreqWeight();

    const { signal: weightedSignal, fs: weightedFs } = await applyFreqWeight(cachedSignalPa, cachedFs);

    const weighted = timeWeight(weightedSignal, weightedFs, tau);
    const spl = signalToSPL(weighted);
    const { times, decimated } = decimateSignal(spl, weightedFs);

    const data = times.map((t, i) => ({ x: t, y: decimated[i] }));
    const ylabel = fw === 'A' ? 'LA (dBA)' :
                   fw === 'C' ? 'LC (dBC)' :
                                'LZ (dB re 20μPa)';

    // User-controlled ranges (null = auto)
    const xRange = readRange('xMinTime', 'xMaxTime');
    const yRange = readRange('yMinLevel', 'yMaxLevel');

    document.getElementById('chartSubtitle').textContent = cachedFileName;

    if (charts[chartKey]) charts[chartKey].destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Build region-box annotations from the current selection store.
    // The annotation plugin handles them as background fills.
    const annotations = {
        playhead: {
            type: 'line',
            scaleID: 'x',
            value: 0,
            borderColor: 'rgba(255,255,255,0.85)',
            borderWidth: 2,
            borderDash: [4, 4],
            display: false
        }
    };
    selectedRegions.forEach((r, i) => {
        annotations['region' + i] = {
            type: 'box',
            xScaleID: 'x',
            xMin: r.tStart,
            xMax: r.tEnd,
            backgroundColor: 'rgba(54, 162, 235, 0.20)',
            borderColor: 'rgba(54, 162, 235, 0.85)',
            borderWidth: 1,
            drawTime: 'beforeDatasetsDraw'
        };
    });

    charts[chartKey] = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: ylabel,
                data: data,
                borderColor: '#cc0000',
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                tension: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: heightOverride === null,  // false = fill parent's height
            animation: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', color: '#e0e0e0' },
                    min: xRange.min !== null ? xRange.min : 0,
                    max: xRange.max !== null ? xRange.max : cachedDuration,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                },
                y: {
                    title: { display: true, text: ylabel, color: '#e0e0e0' },
                    min: yRange.min,
                    max: yRange.max,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => `${c.parsed.y.toFixed(1)} dB`,
                        title: (c) => `${parseFloat(c[0].parsed.x).toFixed(3)} s`
                    }
                },
                annotation: { annotations }
            }
        }
    });
}

// ---------------------------------------------------------------------------
//  Tab 2: Octave Bands
// ---------------------------------------------------------------------------
async function renderOctave() {
    const bandType = getBandType();      // 'whole' | 'third'
    const fw = getFreqWeight();          // 'Lin' | 'A' | 'C'

    // Apply frequency weighting (may return a 48 kHz resampled signal for A/C).
    const { signal: weightedSignal, fs: weightedFs } =
        await applyFreqWeight(cachedSignalPa, cachedFs);

    // octFilt requires 48 kHz. If we're not already there (Z weighting at a
    // non-48 kHz rate), do a second resample.
    const sig48k = weightedFs === 48000
        ? weightedSignal
        : await resampleIfNeeded(weightedSignal, weightedFs, 48000);

    const { freqLabels, spl } = octFilt(sig48k, bandType);

    // User-controlled Y range (null = auto)
    const yRange = readRange('yMinLevel', 'yMaxLevel');

    document.getElementById('chartSubtitle').textContent = cachedFileName;
    if (charts.octave) charts.octave.destroy();
    const ctx = document.getElementById('octaveChart').getContext('2d');
    const colour = bandType === 'whole' ? '#cc0000' : '#888888';

    charts.octave = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: freqLabels,
            datasets: [{
                label: fw === 'A' ? 'SPL (dBA)' :
                       fw === 'C' ? 'SPL (dBC)' :
                                    'SPL (dB Lin)',
                data: spl,
                backgroundColor: colour,
                borderColor: colour,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            animation: false,
            scales: {
                x: {
                    title: { display: true, text: 'Frequency (Hz)', color: '#e0e0e0' },
                    grid: { display: false },
                    ticks: { color: '#e0e0e0' }
                },
                y: {
                    title: {
                        display: true,
                        text: fw === 'A' ? 'SPL (dBA)' :
                              fw === 'C' ? 'SPL (dBC)' :
                                           'SPL (dB re 20μPa)',
                        color: '#e0e0e0'
                    },
                    min: yRange.min,
                    max: yRange.max,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(1)} dB` } }
            }
        }
    });
}

// ---------------------------------------------------------------------------
//  Tab 3: FFT Spectrum
// ---------------------------------------------------------------------------
async function renderFFT() {
    const nfft = getFftSize();
    const useWindow = getUseWindow();
    const fw = getFreqWeight();

    const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

    const { freq, spl } = fftSPL(signal, fs, nfft, useWindow, 0.5);

    // User-controlled ranges with sensible defaults
    const xRange = readRange('xMinFreq', 'xMaxFreq');
    const yRange = readRange('yMinLevel', 'yMaxLevel');
    const minFreq = xRange.min !== null ? xRange.min : 20;
    const maxFreq = xRange.max !== null ? xRange.max : Math.min(20000, fs / 2);

    const data = [];
    for (let i = 0; i < freq.length; i++) {
        if (freq[i] >= minFreq && freq[i] <= maxFreq) {
            data.push({ x: freq[i], y: spl[i] });
        }
    }

    const ylabel = fw === 'A' ? 'SPL (dBA)' :
                   fw === 'C' ? 'SPL (dBC)' :
                                'SPL (dB re 20μPa)';

    document.getElementById('chartSubtitle').textContent = cachedFileName;
    if (charts.fft) charts.fft.destroy();
    const ctx = document.getElementById('fftChart').getContext('2d');

    charts.fft = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: ylabel,
                data: data,
                borderColor: '#cc0000',
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            animation: false,
            scales: {
                x: {
                    type: 'logarithmic',
                    min: minFreq,
                    max: maxFreq,
                    title: { display: true, text: 'Frequency (Hz)', color: '#e0e0e0' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: {
                        color: '#e0e0e0',
                        callback: (v) => {
                            const labels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
                            if (labels.includes(Number(v))) {
                                return v >= 1000 ? (v / 1000) + 'k' : v;
                            }
                            return '';
                        }
                    }
                },
                y: {
                    title: { display: true, text: ylabel, color: '#e0e0e0' },
                    min: yRange.min,
                    max: yRange.max,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => `${c.parsed.y.toFixed(1)} dB`,
                        title: (c) => `${parseFloat(c[0].parsed.x).toFixed(1)} Hz`
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
//  Tab 4: Spectrogram
// ---------------------------------------------------------------------------
async function renderSpectrogram(wrapperId = 'spectrogramWrapper', canvasId = 'spectrogramCanvas') {
    const nfft = getFftSize();
    const useWindow = getUseWindow();

    const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

    const { freq, time, spec, nBins, nFrames } =
        sonogramSPL(signal, fs, nfft, useWindow, 0.75);

    // Auto-determine colour limits from data
    let globalMax = -Infinity;
    for (let i = 0; i < spec.length; i++) {
        if (spec[i] > globalMax) globalMax = spec[i];
    }
    const autoMinDb = 10;
    const autoMaxDb = Math.ceil(globalMax);

    // User overrides (null = auto)
    const cRange = readRange('cMinDb', 'cMaxDb');
    const xRange = readRange('xMinTime', 'xMaxTime');
    const yRange = readRange('yMinSpecFreq', 'yMaxSpecFreq');

    const minDb = cRange.min !== null ? cRange.min : autoMinDb;
    const maxDb = cRange.max !== null ? cRange.max : autoMaxDb;
    const tMin  = xRange.min !== null ? xRange.min : time[0];
    const tMax  = xRange.max !== null ? xRange.max : time[time.length - 1];
    const fMin  = yRange.min !== null ? yRange.min : 20;
    const fMax  = yRange.max !== null ? yRange.max : freq[freq.length - 1];

    // Cache time range for the playhead (use the displayed range, so the
    // cursor lines up with what the user is actually seeing).
    spectrogramTimeRange = { tMin: tMin, tMax: tMax };

    setTimeout(
        () => drawSpectrogram(freq, time, spec, nBins, nFrames,
                              minDb, maxDb, tMin, tMax, fMin, fMax,
                              wrapperId, canvasId),
        50
    );

    document.getElementById('chartSubtitle').textContent = cachedFileName;
}

function drawSpectrogram(freq, time, spec, nBins, nFrames,
                         minDb, maxDb, tMin, tMax, fMin, fMax,
                         wrapperId = 'spectrogramWrapper', canvasId = 'spectrogramCanvas') {
    const wrapper = document.getElementById(wrapperId);
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');

    const W = wrapper.clientWidth || 800;
    const H = wrapper.clientHeight || 500;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;

    // Map pixel rows to log-frequency, pixel columns to time.
    // For each pixel, find the nearest frame and bin from the
    // pre-computed sonogram and look up its dB value.
    const logFMin = Math.log10(Math.max(fMin, 1));
    const logFMax = Math.log10(Math.max(fMax, fMin + 1));
    const fNyquist = freq[freq.length - 1];

    const tDuration = tMax - tMin;
    const totalDuration = time[time.length - 1] - time[0];

    for (let px = 0; px < W; px++) {
        // Time at this pixel
        const t = tMin + (px / W) * tDuration;
        // Index of the frame whose time is nearest t
        const fracFrame = (t - time[0]) / totalDuration;
        let frameIdx = Math.round(fracFrame * (nFrames - 1));
        frameIdx = Math.max(0, Math.min(nFrames - 1, frameIdx));

        for (let py = 0; py < H; py++) {
            const yNorm = 1 - py / H;
            const f = Math.pow(10, logFMin + yNorm * (logFMax - logFMin));
            // Bin index for this frequency in the original FFT
            let binIdx = Math.round(f * nBins / fNyquist);
            binIdx = Math.max(0, Math.min(nBins - 1, binIdx));
            const splVal = spec[binIdx * nFrames + frameIdx];
            const c = splToColour(splVal, minDb, maxDb);
            const idx = (py * W + px) * 4;
            data[idx] = c[0]; data[idx + 1] = c[1]; data[idx + 2] = c[2]; data[idx + 3] = 255;
        }
    }
    ctx.putImageData(imageData, 0, 0);

    // Frequency axis labels: show all standard labels that fall within fMin–fMax
    const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'left';
    freqLabels.forEach((f) => {
        if (f < fMin || f > fMax) return;
        const yNorm = (Math.log10(f) - logFMin) / (logFMax - logFMin);
        const y = H * (1 - yNorm);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(0, y, W, 0.5);
        ctx.fillStyle = '#e0e0e0';
        ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), 4, y - 3);
    });

    // Time axis labels
    const step = tDuration > 30 ? 10 : tDuration > 10 ? 5 : tDuration > 2 ? 1 : 0.1;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
        const x = ((t - tMin) / tDuration) * W;
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(x, 0, 0.5, H);
        ctx.fillStyle = '#e0e0e0';
        const label = step < 1 ? t.toFixed(1) + 's' : t.toFixed(0) + 's';
        ctx.fillText(label, x, H - 4);
    }
}

function splToColour(value, minDb, maxDb) {
    const t = Math.max(0, Math.min(1, (value - minDb) / (maxDb - minDb)));
    let r, g, b;
    if (t < 0.33) {
        const s = t / 0.33;
        r = Math.round(102 * s); g = 0; b = 0;
    } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        r = Math.round(102 + (204 - 102) * s); g = 0; b = 0;
    } else {
        const s = (t - 0.66) / 0.34;
        r = Math.round(204 + (255 - 204) * s);
        g = Math.round(255 * s);
        b = Math.round(255 * s);
    }
    return [r, g, b];
}

// ---------------------------------------------------------------------------
//  Tab 5: BS 4142 — stacked Level vs. Time + Spectrogram with selection
//
//  Both charts share the X (time) axis. The user can drag on either to
//  add a selection region; the same region appears on both. Region overlays
//  are drawn on top via absolutely-positioned divs (and via Chart.js
//  annotations on the time chart). Leq is computed at the top.
// ---------------------------------------------------------------------------
async function renderBs4142() {
    // 1. Custom time chart with two traces: Lp at 100 ms and Leq at 10 ms.
    //    Not the same plot the standalone tab uses — that's a single trace.
    await renderBs4142TimeChart();

    // 2. Spectrogram into the BS 4142 spectrogram wrapper. Note this also
    //    sets `spectrogramTimeRange` — we copy it into the BS 4142-specific
    //    cache so its playhead lines up correctly.
    await renderSpectrogram('bs4142SpectrogramWrapper', 'bs4142SpectrogramCanvas');
    bs4142SpectrogramTimeRange = spectrogramTimeRange;

    // 3. Refresh the spectrogram region overlay and the Leq display
    drawBs4142SpecRegions();
    updateLeqDisplay();
}

// Two-trace time chart for the BS 4142 view:
//   - Lp at 100 ms intervals: time-weighted (F/I/S) and freq-weighted level
//   - Leq at 10 ms intervals: RMS of the freq-weighted pressure, no time wt
async function renderBs4142TimeChart() {
    const tau = getTimeWeightTau();
    const tauLabel = getTimeWeightLabel();
    const fw = getFreqWeight();

    const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

    // Lp series: continuous time-weighted SPL, then sample every 100 ms
    const lp = computeLpTimeSeries(signal, fs, tau, /*stepSec*/ 0.1);

    // Short-time Leq: 10 ms non-overlapping RMS blocks
    const leqShort = computeLeqShortTime(signal, fs, /*blockSec*/ 0.010);

    // Cache the Lp samples on a global so the Leq tile updater can compute
    // L90 from the same series displayed on the plot.
    bs4142LpCache = { values: lp.values, fw };

    const lpLabel  = `Lp ${tauLabel}-${fw === 'Lin' ? 'Z' : fw} (100 ms)`;
    const leqLabel = `Leq-${fw === 'Lin' ? 'Z' : fw} (10 ms)`;
    const ylabel   = fw === 'A' ? 'L (dBA)' :
                     fw === 'C' ? 'L (dBC)' :
                                  'L (dB re 20μPa)';

    const xRange = readRange('xMinTime', 'xMaxTime');
    const yRange = readRange('yMinLevel', 'yMaxLevel');

    // Region annotations (existing pattern from the standalone tab)
    const annotations = {
        playhead: {
            type: 'line', scaleID: 'x', value: 0,
            borderColor: 'rgba(255,255,255,0.85)',
            borderWidth: 2, borderDash: [4, 4],
            display: false
        }
    };
    selectedRegions.forEach((r, i) => {
        annotations['region' + i] = {
            type: 'box', xScaleID: 'x',
            xMin: r.tStart, xMax: r.tEnd,
            backgroundColor: 'rgba(54, 162, 235, 0.20)',
            borderColor: 'rgba(54, 162, 235, 0.85)',
            borderWidth: 1,
            drawTime: 'beforeDatasetsDraw'
        };
    });

    if (charts.bs4142Time) charts.bs4142Time.destroy();
    const ctx = document.getElementById('bs4142TimeChart').getContext('2d');

    charts.bs4142Time = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: leqLabel,
                    data: toXYPairs(leqShort.times, leqShort.values),
                    borderColor: '#cc0000',
                    borderWidth: 1.0,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 2     // draws underneath Lp
                },
                {
                    label: lpLabel,
                    data: toXYPairs(lp.times, lp.values),
                    borderColor: '#ffffff',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 1     // draws on top
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', color: '#e0e0e0' },
                    min: xRange.min !== null ? xRange.min : 0,
                    max: xRange.max !== null ? xRange.max : cachedDuration,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                },
                y: {
                    title: { display: true, text: ylabel, color: '#e0e0e0' },
                    min: yRange.min, max: yRange.max,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'end',
                    labels: { color: '#e0e0e0', boxWidth: 18, font: { size: 11 } }
                },
                tooltip: {
                    callbacks: {
                        label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} dB`,
                        title: (c) => `${parseFloat(c[0].parsed.x).toFixed(3)} s`
                    }
                },
                annotation: { annotations }
            }
        }
    });
}

// Draw the absolutely-positioned region rectangles over the BS 4142
// spectrogram canvas. The time chart uses Chart.js annotations (handled
// inside renderTimeHistory).
function drawBs4142SpecRegions() {
    const overlay = document.getElementById('bs4142SpecRegions');
    const wrapper = document.getElementById('bs4142SpectrogramWrapper');
    if (!overlay || !wrapper || !bs4142SpectrogramTimeRange) return;

    overlay.innerHTML = '';
    const W = wrapper.clientWidth || 1;
    const { tMin, tMax } = bs4142SpectrogramTimeRange;
    const tDur = tMax - tMin;

    selectedRegions.forEach((r, i) => {
        const x1 = ((r.tStart - tMin) / tDur) * W;
        const x2 = ((r.tEnd   - tMin) / tDur) * W;
        const left  = Math.max(0, Math.min(W, x1));
        const right = Math.max(0, Math.min(W, x2));
        if (right - left < 1) return;
        const div = document.createElement('div');
        div.className = 'bs4142-region';
        div.style.left = left + 'px';
        div.style.width = (right - left) + 'px';
        div.title = 'Click to remove (' +
                    r.tStart.toFixed(2) + 's – ' + r.tEnd.toFixed(2) + 's)';
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedRegions.splice(i, 1);
            // Rerender just the region overlays + time chart annotations
            updateBs4142Regions();
        });
        overlay.appendChild(div);
    });
}

// Refresh region visualisation on both BS 4142 plots and the Leq display,
// without redoing the heavy spectrogram FFTs.
function updateBs4142Regions() {
    // Time chart: rebuild annotations by replacing the chart's annotation set
    const c = charts.bs4142Time;
    if (c) {
        const anns = c.options.plugins.annotation.annotations;
        // Drop existing region annotations (preserve playhead)
        Object.keys(anns).forEach((k) => { if (k.startsWith('region')) delete anns[k]; });
        selectedRegions.forEach((r, i) => {
            anns['region' + i] = {
                type: 'box',
                xScaleID: 'x',
                xMin: r.tStart,
                xMax: r.tEnd,
                backgroundColor: 'rgba(54, 162, 235, 0.20)',
                borderColor: 'rgba(54, 162, 235, 0.85)',
                borderWidth: 1,
                drawTime: 'beforeDatasetsDraw'
            };
        });
        c.update('none');
    }
    drawBs4142SpecRegions();
    updateLeqDisplay();
}

// Compute Leq inside vs outside the union of selected regions.
// Leq = 10·log10( mean(p²) / p_ref² ),  p_ref = 20e-6 Pa
// Frequency weighting: applyFreqWeight() handles A/C/Z, including any
// resampling needed to reach a supported rate for the IIR coefficients.
//
// Async because applyFreqWeight may trigger an OfflineAudioContext resample.
// A monotonically-increasing generation token guards against rapid clicks
// causing an older computation to overwrite a newer one — only the most
// recent invocation is allowed to write to the DOM.
let _leqGeneration = 0;
async function updateLeqDisplay() {
    const myGen = ++_leqGeneration;
    const elSelLeq = document.getElementById('bs4142LeqSelected');
    const elExcLeq = document.getElementById('bs4142LeqExcluded');
    const elSelL90 = document.getElementById('bs4142L90Selected');
    const elExcL90 = document.getElementById('bs4142L90Excluded');
    const elSelMeta = document.getElementById('bs4142LeqSelectedMeta');
    const elExcMeta = document.getElementById('bs4142LeqExcludedMeta');
    if (!elSelLeq || !elExcLeq) return;

    const clear = () => {
        elSelLeq.textContent = elSelL90.textContent = '—';
        elExcLeq.textContent = elExcL90.textContent = '—';
    };

    if (!cachedSignalPa) { clear(); return; }

    const fw = getFreqWeight();
    const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);
    if (myGen !== _leqGeneration) return;   // a newer call superseded us

    // ---- Leq: linear walk over freq-weighted samples ----
    // Sample i belongs to "selected" iff i / fs is inside any merged region.
    const N = signal.length;
    const pRefSq = 20e-6 * 20e-6;
    const eps = 1e-30;

    let selSumSq = 0, selCount = 0;
    let excSumSq = 0, excCount = 0;
    let totalSelDuration = 0;
    const merged = mergeRegions(selectedRegions);

    if (merged.length === 0) {
        for (let i = 0; i < N; i++) excSumSq += signal[i] * signal[i];
        excCount = N;
    } else {
        totalSelDuration = merged.reduce((sum, r) => sum + (r.tEnd - r.tStart), 0);
        let regionIdx = 0;
        for (let i = 0; i < N; i++) {
            const t = i / fs;
            while (regionIdx < merged.length && t >= merged[regionIdx].tEnd) regionIdx++;
            const inside = regionIdx < merged.length && t >= merged[regionIdx].tStart;
            const sq = signal[i] * signal[i];
            if (inside) { selSumSq += sq; selCount++; }
            else        { excSumSq += sq; excCount++; }
        }
    }

    const selLeq = selCount > 0 ? 10 * Math.log10((selSumSq / selCount) / pRefSq + eps) : null;
    const excLeq = excCount > 0 ? 10 * Math.log10((excSumSq / excCount) / pRefSq + eps) : null;

    // ---- L90: 10th percentile of the displayed Lp time series, with the
    // same in-region / out-of-region split applied to the 100 ms samples. ----
    let selL90 = null, excL90 = null;
    if (bs4142LpCache && bs4142LpCache.fw === fw) {
        const lpVals = bs4142LpCache.values;
        const stepSec = 0.1;   // matches computeLpTimeSeries default
        const selSamples = [];
        const excSamples = [];
        for (let i = 0; i < lpVals.length; i++) {
            const t = i * stepSec;
            const inside = isInsideMergedRegions(t, merged);
            if (inside) selSamples.push(lpVals[i]);
            else        excSamples.push(lpVals[i]);
        }
        if (selSamples.length > 0) selL90 = computeL90(selSamples);
        if (excSamples.length > 0) excL90 = computeL90(excSamples);
    }

    const wLabel = fw === 'A' ? ' dBA' :
                   fw === 'C' ? ' dBC' :
                                ' dB';

    // ---- Write to DOM ----
    if (selLeq !== null) {
        elSelLeq.textContent = selLeq.toFixed(1) + wLabel;
        elSelL90.textContent = selL90 !== null ? selL90 + wLabel : '—';
        elSelMeta.textContent = merged.length === 0 ? 'no selection' :
            selectedRegions.length + ' region' + (selectedRegions.length === 1 ? '' : 's') +
            ', ' + totalSelDuration.toFixed(2) + ' s total';
    } else {
        elSelLeq.textContent = '—';
        elSelL90.textContent = '—';
        elSelMeta.textContent = 'no selection';
    }

    if (excLeq !== null) {
        elExcLeq.textContent = excLeq.toFixed(1) + wLabel;
        elExcL90.textContent = excL90 !== null ? excL90 + wLabel : '—';
        const excDuration = (excCount / fs);
        elExcMeta.textContent = merged.length === 0
            ? 'whole signal, ' + excDuration.toFixed(2) + ' s'
            : excDuration.toFixed(2) + ' s';
    } else {
        elExcLeq.textContent = '—';
        elExcL90.textContent = '—';
        elExcMeta.textContent = 'fully selected';
    }
}

// Helper: is time t inside any of the (already-merged, sorted) regions?
// Convert two parallel arrays into a Chart.js-friendly array of {x,y}
// objects. Handles both regular Arrays and TypedArrays. (TypedArray.map
// returns another TypedArray, which silently coerces objects to NaN —
// hence this helper exists.)
function toXYPairs(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { x: xs[i], y: ys[i] };
    return out;
}

function isInsideMergedRegions(t, merged) {
    // Linear scan; merged regions are sorted, so we can short-circuit.
    for (let i = 0; i < merged.length; i++) {
        if (t < merged[i].tStart) return false;
        if (t < merged[i].tEnd)   return true;
    }
    return false;
}

// Resample a time-weighted SPL stream onto a regular grid (default 100 ms).
// `signal` is the freq-weighted pressure signal; we apply the time-weighting
// integrator at full sample rate, convert to dB SPL, then pick out the value
// at every stepSec. Returns { times: Float32Array, values: Float32Array }.
function computeLpTimeSeries(signal, fs, tau, stepSec = 0.1) {
    const weighted = timeWeight(signal, fs, tau);
    const spl = signalToSPL(weighted);

    const stride = Math.max(1, Math.round(stepSec * fs));
    const n = Math.floor(spl.length / stride);
    const times  = new Float32Array(n);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const sampleIdx = i * stride;
        times[i]  = sampleIdx / fs;
        values[i] = spl[sampleIdx];
    }
    return { times, values };
}

// Short-time Leq over consecutive non-overlapping blocks of `blockSec`
// (default 10 ms). For each block, Leq = 10·log10(mean(p²)/p_ref²).
function computeLeqShortTime(signal, fs, blockSec = 0.010) {
    const block = Math.max(1, Math.round(blockSec * fs));
    const n = Math.floor(signal.length / block);
    const times  = new Float32Array(n);
    const values = new Float32Array(n);
    const pRefSq = 20e-6 * 20e-6;
    const eps = 1e-30;

    for (let i = 0; i < n; i++) {
        let sumSq = 0;
        const start = i * block;
        for (let j = 0; j < block; j++) {
            const v = signal[start + j];
            sumSq += v * v;
        }
        times[i]  = (start + block / 2) / fs;   // centre of the block
        values[i] = 10 * Math.log10(sumSq / block / pRefSq + eps);
    }
    return { times, values };
}

// L90 (10th percentile) of an Lp time series, with values binned to the
// nearest whole dB. The standard acoustics convention is to histogram in
// 1 dB bins, then walk down from the highest bin accumulating the count
// until ≥ 10% of samples have been counted; the level of that bin is L90.
//
// Returns the L90 in dB (rounded to integer), or null if the series is empty.
function computeL90(values) {
    if (!values || values.length === 0) return null;

    // Find data range
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v)) continue;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    }
    if (!isFinite(minV) || !isFinite(maxV)) return null;

    const lo = Math.floor(minV);
    const hi = Math.ceil(maxV);
    const nBins = hi - lo + 1;
    if (nBins < 1) return Math.round(minV);

    const bins = new Int32Array(nBins);
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v)) continue;
        const idx = Math.max(0, Math.min(nBins - 1, Math.round(v) - lo));
        bins[idx]++;
        total++;
    }
    if (total === 0) return null;

    // Walk DOWN from the highest bin until we've covered 90% of samples;
    // L90 is the dB level of the bin where the cumulative count first
    // crosses 90% (i.e. only 10% of samples remain at lower levels).
    const target = 0.9 * total;
    let cum = 0;
    for (let i = nBins - 1; i >= 0; i--) {
        cum += bins[i];
        if (cum >= target) return lo + i;
    }
    return lo;   // shouldn't reach here, but be safe
}

// Merge overlapping/adjacent regions so the Leq mask has no double-counting.
function mergeRegions(regions) {
    if (regions.length === 0) return [];
    const sorted = regions.slice().sort((a, b) => a.tStart - b.tStart);
    const merged = [{ tStart: sorted[0].tStart, tEnd: sorted[0].tEnd }];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i].tStart <= last.tEnd) {
            last.tEnd = Math.max(last.tEnd, sorted[i].tEnd);
        } else {
            merged.push({ tStart: sorted[i].tStart, tEnd: sorted[i].tEnd });
        }
    }
    return merged;
}

// ---------------------------------------------------------------------------
//  Selection mode (BS 4142): click "Select", then drag on either plot to
//  add a time region. Regions sync between both plots. Click an existing
//  region to delete it.
// ---------------------------------------------------------------------------
function setupSelection() {
    const btn = document.getElementById('selectBtn');
    const clearBtn = document.getElementById('clearSelectionBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        if (selectActive) cancelSelect();
        else activateSelect();
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            selectedRegions = [];
            updateBs4142Regions();
        });
    }

    // Wire mousedown/mousemove/mouseup on each BS 4142 plot wrapper.
    ['plotWrapperBs4142Time', 'plotWrapperBs4142Spec'].forEach((id) => {
        const wrapper = document.getElementById(id);
        if (!wrapper) return;
        const plotKey = id === 'plotWrapperBs4142Time' ? 'time' : 'spec';

        wrapper.addEventListener('mousedown', (e) => {
            if (!selectActive) return;
            // Don't start a new region if the user clicked an existing
            // region div (that's a delete-click).
            if (e.target.classList.contains('bs4142-region')) return;
            const rect = wrapper.getBoundingClientRect();
            selectStart = { plotKey, x: e.clientX - rect.left };
            selectDragging = true;
            // Use the zoom overlay SVG to draw the rubber band — same SVG,
            // different colour scheme would be nicer but this is fine.
            const overlayId = id === 'plotWrapperBs4142Time'
                ? 'zoomOverlayBs4142Time' : 'zoomOverlayBs4142Spec';
            const overlay = document.getElementById(overlayId);
            const r = overlay.querySelector('.zoom-rect');
            overlay.classList.add('active');
            overlay.setAttribute('viewBox',
                `0 0 ${wrapper.clientWidth} ${wrapper.clientHeight}`);
            r.setAttribute('x', selectStart.x);
            r.setAttribute('y', 0);
            r.setAttribute('width', 0);
            r.setAttribute('height', wrapper.clientHeight);
            r.setAttribute('fill', 'rgba(54, 162, 235, 0.20)');
            r.setAttribute('stroke', '#36a2eb');
            e.preventDefault();
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (!selectActive || !selectDragging || selectStart.plotKey !== plotKey) return;
            const rect = wrapper.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const overlayId = id === 'plotWrapperBs4142Time'
                ? 'zoomOverlayBs4142Time' : 'zoomOverlayBs4142Spec';
            const r = document.getElementById(overlayId).querySelector('.zoom-rect');
            r.setAttribute('x', Math.min(selectStart.x, x));
            r.setAttribute('width', Math.abs(x - selectStart.x));
        });
    });

    // Mouseup on window so a release outside the plot still resolves.
    window.addEventListener('mouseup', (e) => {
        if (!selectActive || !selectDragging) return;
        selectDragging = false;

        const id = selectStart.plotKey === 'time'
            ? 'plotWrapperBs4142Time' : 'plotWrapperBs4142Spec';
        const wrapper = document.getElementById(id);
        const rect = wrapper.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const x1 = Math.min(selectStart.x, endX);
        const x2 = Math.max(selectStart.x, endX);

        // Hide the rubber band overlays
        ['zoomOverlayBs4142Time', 'zoomOverlayBs4142Spec'].forEach((oid) => {
            document.getElementById(oid).classList.remove('active');
        });

        // Tiny drags ignored
        if (x2 - x1 < 5) { selectStart = null; return; }

        // Convert pixel range to time range
        const range = pixelsToTimeRange(selectStart.plotKey, x1, x2);
        selectStart = null;
        if (range) {
            selectedRegions.push(range);
            updateBs4142Regions();
        }
    });
}

// Convert a pixel-x range on the named BS 4142 plot ('time' | 'spec') into
// a time-domain range in seconds. The two plots use different mappings:
// the time chart uses Chart.js scales; the spectrogram uses the cached
// time range (which already accounts for the user's X-limit).
function pixelsToTimeRange(plotKey, x1, x2) {
    if (plotKey === 'time') {
        const c = charts.bs4142Time;
        if (!c) return null;
        const wrapper = document.getElementById('plotWrapperBs4142Time');
        const cRect = c.canvas.getBoundingClientRect();
        const wRect = wrapper.getBoundingClientRect();
        const offsetX = cRect.left - wRect.left;
        const t1 = c.scales.x.getValueForPixel(x1 - offsetX);
        const t2 = c.scales.x.getValueForPixel(x2 - offsetX);
        if (!isFinite(t1) || !isFinite(t2)) return null;
        return { tStart: Math.min(t1, t2), tEnd: Math.max(t1, t2) };
    } else {
        // Spectrogram pixel -> time (linear), based on the displayed range
        if (!bs4142SpectrogramTimeRange) return null;
        const wrapper = document.getElementById('plotWrapperBs4142Spec');
        const W = wrapper.clientWidth || 1;
        const { tMin, tMax } = bs4142SpectrogramTimeRange;
        const t1 = tMin + (x1 / W) * (tMax - tMin);
        const t2 = tMin + (x2 / W) * (tMax - tMin);
        return { tStart: Math.min(t1, t2), tEnd: Math.max(t1, t2) };
    }
}

function activateSelect() {
    cancelZoom();   // mutually exclusive with zoom mode
    selectActive = true;
    document.getElementById('selectBtn').classList.add('active');
    document.querySelectorAll('.bs4142-plot').forEach((w) => {
        w.classList.add('select-active');
    });
}

function cancelSelect() {
    selectActive = false;
    selectDragging = false;
    selectStart = null;
    document.getElementById('selectBtn').classList.remove('active');
    document.querySelectorAll('.bs4142-plot').forEach((w) => {
        w.classList.remove('select-active');
    });
    ['zoomOverlayBs4142Time', 'zoomOverlayBs4142Spec'].forEach((oid) => {
        const el = document.getElementById(oid);
        if (el) el.classList.remove('active');
    });
}

// ---------------------------------------------------------------------------
//  Resampling helper
// ---------------------------------------------------------------------------
async function resampleIfNeeded(signal, fromFs, toFs) {
    if (fromFs === toFs) return signal;
    const offlineCtx = new OfflineAudioContext(
        1,
        Math.ceil(signal.length * toFs / fromFs),
        toFs
    );
    const buffer = offlineCtx.createBuffer(1, signal.length, fromFs);
    buffer.getChannelData(0).set(signal);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
}

// ---------------------------------------------------------------------------
//  Control readers
// ---------------------------------------------------------------------------
function getTimeWeightTau() {
    const v = document.querySelector('input[name="timeWeight"]:checked').value;
    if (v === 'I') return 0.035;   // Impulse: 35 ms
    if (v === 'F') return 0.125;   // Fast
    if (v === 'S') return 1.0;     // Slow
    return 0.125;
}

function getTimeWeightLabel() {
    const el = document.querySelector('input[name="timeWeight"]:checked');
    return el ? el.value : 'F';
}

function getFreqWeight() {
    return document.querySelector('input[name="freqWeight"]:checked').value;
}

// Apply the user-selected frequency weighting to a signal.
//
// The freqWeight() filter only has tabulated coefficients at 12, 24, and
// 48 kHz. NX-43WR recordings can be at 12, 24, 48, or other rates depending
// on configuration. If the signal is at one of the supported rates we
// filter directly; otherwise we resample to 48 kHz, filter there, and
// return the 48 kHz signal along with its new sample rate.
//
// Returns { signal, fs } so callers know which sample rate to feed into
// downstream functions. For Z-weighting and supported rates this will
// match the input fs unchanged.
async function applyFreqWeight(signal, fs) {
    const wt = getFreqWeight();
    // The HTML radio uses 'Lin' to mean Z (no weighting); freqWeight() expects 'Z'.
    const filterType = (wt === 'Lin') ? 'Z' : wt;

    if (filterType === 'Z') return { signal, fs };

    const supported = freqWeight.supportedSampleRates(filterType) || [];
    if (supported.includes(Math.round(fs))) {
        return { signal: freqWeight(signal, fs, filterType), fs };
    }

    // Resample to the nearest supported rate (48 kHz is the highest and
    // matches what octFilt already uses, so it's the natural target).
    const targetFs = 48000;
    const resampled = await resampleIfNeeded(signal, fs, targetFs);
    return { signal: freqWeight(resampled, targetFs, filterType), fs: targetFs };
}

function getBandType() {
    return document.querySelector('input[name="bandType"]:checked').value;
}

// Read a numeric range from two inputs. Blank/invalid values become null,
// which Chart.js interprets as "auto-range" for that bound.
function readRange(minId, maxId) {
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    const min = (minEl && minEl.value !== '') ? parseFloat(minEl.value) : null;
    const max = (maxEl && maxEl.value !== '') ? parseFloat(maxEl.value) : null;
    return {
        min: isFinite(min) ? min : null,
        max: isFinite(max) ? max : null
    };
}

function getUseWindow() {
    const v = document.querySelector('input[name="useWindow"]:checked');
    return v ? v.value === 'on' : true;
}

// fftSPL/sonogramSPL use a Cooley-Tukey radix-2 FFT, which requires the
// length to be a power of 2. Snap to the nearest power of 2 within
// [64, 65536]. If the user types a non-power-of-2 we update the input
// in-place so they can see what was actually used.
function getFftSize() {
    const input = document.getElementById('fftSize');
    let n = parseInt(input.value, 10);
    if (!isFinite(n) || n < 64) n = 64;
    if (n > 65536) n = 65536;
    // Round to nearest power of 2 (in log2 space)
    const pow2 = Math.pow(2, Math.round(Math.log2(n)));
    if (pow2 !== parseInt(input.value, 10)) input.value = pow2;
    return pow2;
}

// ---------------------------------------------------------------------------
//  Re-render on control changes
// ---------------------------------------------------------------------------
function setupControlListeners() {
    document.querySelectorAll(
        'input[name="timeWeight"], input[name="freqWeight"], ' +
        'input[name="bandType"], input[name="useWindow"]'
    ).forEach((r) => r.addEventListener('change', () => {
        if (cachedSignalPa) runAnalysis();
    }));

    // FFT size: re-render on commit (change), not on every keystroke,
    // so the user can finish typing before we redo the calculation.
    document.getElementById('fftSize').addEventListener('change', () => {
        if (cachedSignalPa) runAnalysis();
    });

    // Axis range inputs: re-render on commit. Same listener pattern keeps
    // the spinner from triggering on every digit typed.
    const rangeIds = [
        'xMinTime', 'xMaxTime',
        'xMinFreq', 'xMaxFreq',
        'yMinLevel', 'yMaxLevel',
        'yMinSpecFreq', 'yMaxSpecFreq',
        'cMinDb', 'cMaxDb'
    ];
    rangeIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => {
            if (cachedSignalPa) runAnalysis();
        });
    });
}

// ---------------------------------------------------------------------------
//  Audio player playhead
//
//  Two visual cursors are kept in sync with the audio player:
//    - On the time-history chart: a Chart.js annotation line.
//    - On the spectrogram: an absolutely-positioned div over the canvas.
//  Both are updated from the same requestAnimationFrame loop while playing,
//  and on every 'seeked' event.
// ---------------------------------------------------------------------------
function setupPlayhead() {
    const player = document.getElementById('audioPlayer');

    function updateAtTime(t, visible) {
        // Time-history chart on the standalone tab
        const c1 = charts.timehistory;
        if (c1 && c1.options && c1.options.plugins && c1.options.plugins.annotation) {
            const ann = c1.options.plugins.annotation.annotations.playhead;
            ann.value = t;
            ann.display = visible;
            c1.update('none');
        }

        // BS 4142 time chart
        const c2 = charts.bs4142Time;
        if (c2 && c2.options && c2.options.plugins && c2.options.plugins.annotation) {
            const ann = c2.options.plugins.annotation.annotations.playhead;
            ann.value = t;
            ann.display = visible;
            c2.update('none');
        }

        // Standalone spectrogram playhead overlay
        positionSpecPlayhead(
            document.getElementById('spectrogramPlayhead'),
            document.getElementById('spectrogramWrapper'),
            spectrogramTimeRange, t, visible);

        // BS 4142 spectrogram playhead overlay
        positionSpecPlayhead(
            document.getElementById('bs4142SpectrogramPlayhead'),
            document.getElementById('bs4142SpectrogramWrapper'),
            bs4142SpectrogramTimeRange, t, visible);
    }

    function positionSpecPlayhead(ph, wrapper, range, t, visible) {
        if (!ph || !wrapper || !range) return;
        if (visible) {
            const { tMin, tMax } = range;
            const W = wrapper.clientWidth || 1;
            const x = ((t - tMin) / (tMax - tMin)) * W;
            ph.style.left = Math.max(0, Math.min(W, x)) + 'px';
            ph.style.display = 'block';
        } else {
            ph.style.display = 'none';
        }
    }

    function tick() {
        if (!player.paused && !player.ended) {
            updateAtTime(player.currentTime, true);
            animationFrameId = requestAnimationFrame(tick);
        } else {
            updateAtTime(player.currentTime, false);
            animationFrameId = null;
        }
    }

    player.addEventListener('play', () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(tick);
    });
    player.addEventListener('pause', () => {
        if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
        updateAtTime(player.currentTime, false);
    });
    player.addEventListener('ended', () => {
        if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
        updateAtTime(player.currentTime, false);
    });
    player.addEventListener('seeked', () => {
        // Show the cursor at the new position even if paused, so the user
        // can see where they've scrubbed to.
        updateAtTime(player.currentTime, true);
    });
}

// ---------------------------------------------------------------------------
//  Zoom-to-rectangle: click "Zoom" then drag a rectangle on a plot to
//  populate the X/Y range inputs and re-render. Works on any of the plot
//  wrappers — the single-chart wrapper for tabs 1–4, or either of the two
//  BS 4142 wrappers (which share the same controls but distinct overlays).
// ---------------------------------------------------------------------------
let zoomActive = false;
let zoomDragging = false;
let zoomStart = null;       // { wrapperId, x, y }

function setupZoom() {
    const btn = document.getElementById('zoomBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        if (zoomActive) cancelZoom();
        else activateZoom();
    });

    // Each wrapper gets its own listeners. Which overlay to show is keyed
    // off the wrapper's ID via wrapperToOverlay().
    const wrapperIds = ['plotWrapperMain', 'plotWrapperBs4142Time', 'plotWrapperBs4142Spec'];
    wrapperIds.forEach((wid) => {
        const wrapper = document.getElementById(wid);
        if (!wrapper) return;

        wrapper.addEventListener('mousedown', (e) => {
            if (!zoomActive) return;
            // Don't start a zoom-drag if the click landed on a BS 4142 region
            // (that's a delete-click for selection mode, but selection mode
            // should be cancelled when zoom is active anyway).
            const rect = wrapper.getBoundingClientRect();
            zoomStart = {
                wrapperId: wid,
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            zoomDragging = true;
            const overlay = document.getElementById(wrapperToOverlay(wid));
            const r = overlay.querySelector('.zoom-rect');
            overlay.classList.add('active');
            overlay.setAttribute('viewBox',
                `0 0 ${wrapper.clientWidth} ${wrapper.clientHeight}`);
            r.setAttribute('x', zoomStart.x);
            r.setAttribute('y', zoomStart.y);
            r.setAttribute('width', 0);
            r.setAttribute('height', 0);
            r.setAttribute('fill', 'rgba(204, 0, 0, 0.15)');
            r.setAttribute('stroke', '#cc0000');
            e.preventDefault();
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (!zoomActive || !zoomDragging || zoomStart.wrapperId !== wid) return;
            const rect = wrapper.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const r = document.getElementById(wrapperToOverlay(wid)).querySelector('.zoom-rect');
            r.setAttribute('x', Math.min(zoomStart.x, x));
            r.setAttribute('y', Math.min(zoomStart.y, y));
            r.setAttribute('width', Math.abs(x - zoomStart.x));
            r.setAttribute('height', Math.abs(y - zoomStart.y));
        });
    });

    // mouseup on window so a release outside the plot still resolves the drag.
    window.addEventListener('mouseup', (e) => {
        if (!zoomActive || !zoomDragging) return;
        zoomDragging = false;

        const wrapper = document.getElementById(zoomStart.wrapperId);
        const rect = wrapper.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

        const x1 = Math.min(zoomStart.x, endX);
        const x2 = Math.max(zoomStart.x, endX);
        const y1 = Math.min(zoomStart.y, endY);
        const y2 = Math.max(zoomStart.y, endY);

        const wrapperId = zoomStart.wrapperId;

        // Tiny drags ignored
        if (x2 - x1 < 5 || y2 - y1 < 5) {
            cancelZoom();
            return;
        }

        commitZoom(wrapperId, x1, x2, y1, y2);
        cancelZoom();
        if (cachedSignalPa) runAnalysis();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && zoomActive) cancelZoom();
    });
}

function wrapperToOverlay(wrapperId) {
    return {
        plotWrapperMain:        'zoomOverlayMain',
        plotWrapperBs4142Time:  'zoomOverlayBs4142Time',
        plotWrapperBs4142Spec:  'zoomOverlayBs4142Spec'
    }[wrapperId];
}

function activateZoom() {
    cancelSelect();   // mutually exclusive
    zoomActive = true;
    document.getElementById('zoomBtn').classList.add('zoom-btn', 'active');
    document.querySelectorAll('.plot-wrapper').forEach((w) => w.classList.add('zoom-active'));
}

function cancelZoom() {
    zoomActive = false;
    zoomDragging = false;
    zoomStart = null;
    const zb = document.getElementById('zoomBtn');
    if (zb) zb.classList.remove('zoom-btn', 'active');
    document.querySelectorAll('.plot-wrapper').forEach((w) => w.classList.remove('zoom-active'));
    document.querySelectorAll('.zoom-overlay').forEach((o) => o.classList.remove('active'));
}

// Convert a pixel rectangle (in the named wrapper's coordinates) into
// data-space limits and write them into the appropriate range inputs.
function commitZoom(wrapperId, x1, x2, y1, y2) {
    if (currentTab === 'spectrogram') {
        commitZoomSpectrogram(wrapperId, x1, x2, y1, y2);
    } else if (currentTab === 'bs4142') {
        if (wrapperId === 'plotWrapperBs4142Time') {
            commitZoomBs4142Time(x1, x2, y1, y2);
        } else {
            commitZoomBs4142Spec(x1, x2, y1, y2);
        }
    } else {
        commitZoomChart(wrapperId, x1, x2, y1, y2);
    }
}

function commitZoomChart(wrapperId, x1, x2, y1, y2) {
    const chart = charts[currentTab];
    if (!chart) return;

    const wrapper = document.getElementById(wrapperId);
    const canvas = chart.canvas;
    const wRect = wrapper.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const offsetX = cRect.left - wRect.left;
    const offsetY = cRect.top - wRect.top;

    const cx1 = x1 - offsetX, cx2 = x2 - offsetX;
    const cy1 = y1 - offsetY, cy2 = y2 - offsetY;

    const dataXMin = chart.scales.x.getValueForPixel(cx1);
    const dataXMax = chart.scales.x.getValueForPixel(cx2);
    const dataYMax = chart.scales.y.getValueForPixel(cy1);
    const dataYMin = chart.scales.y.getValueForPixel(cy2);

    if (currentTab === 'timehistory') {
        setRangeInputs('xMinTime', 'xMaxTime', dataXMin, dataXMax, 2);
        setRangeInputs('yMinLevel', 'yMaxLevel', dataYMin, dataYMax, 1);
    } else if (currentTab === 'fft') {
        setRangeInputs('xMinFreq', 'xMaxFreq', dataXMin, dataXMax, 0);
        setRangeInputs('yMinLevel', 'yMaxLevel', dataYMin, dataYMax, 1);
    } else if (currentTab === 'octave') {
        setRangeInputs('yMinLevel', 'yMaxLevel', dataYMin, dataYMax, 1);
    }
}

// BS 4142 time chart: like commitZoomChart but uses the BS-specific chart.
function commitZoomBs4142Time(x1, x2, y1, y2) {
    const chart = charts.bs4142Time;
    if (!chart) return;

    const wrapper = document.getElementById('plotWrapperBs4142Time');
    const canvas = chart.canvas;
    const wRect = wrapper.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const offsetX = cRect.left - wRect.left;
    const offsetY = cRect.top - wRect.top;

    const dataXMin = chart.scales.x.getValueForPixel(x1 - offsetX);
    const dataXMax = chart.scales.x.getValueForPixel(x2 - offsetX);
    const dataYMax = chart.scales.y.getValueForPixel(y1 - offsetY);
    const dataYMin = chart.scales.y.getValueForPixel(y2 - offsetY);

    setRangeInputs('xMinTime', 'xMaxTime', dataXMin, dataXMax, 2);
    setRangeInputs('yMinLevel', 'yMaxLevel', dataYMin, dataYMax, 1);
}

// BS 4142 spectrogram: same math as commitZoomSpectrogram but using
// bs4142SpectrogramTimeRange and the BS wrapper.
function commitZoomBs4142Spec(x1, x2, y1, y2) {
    const wrapper = document.getElementById('plotWrapperBs4142Spec');
    if (!wrapper) return;
    const W = wrapper.clientWidth || 1;
    const H = wrapper.clientHeight || 1;

    const xRange = readRange('xMinTime', 'xMaxTime');
    const yRange = readRange('yMinSpecFreq', 'yMaxSpecFreq');
    const tMin = xRange.min !== null ? xRange.min :
                 (bs4142SpectrogramTimeRange ? bs4142SpectrogramTimeRange.tMin : 0);
    const tMax = xRange.max !== null ? xRange.max :
                 (bs4142SpectrogramTimeRange ? bs4142SpectrogramTimeRange.tMax : cachedDuration);
    const fMin = yRange.min !== null ? yRange.min : 20;
    const fMax = yRange.max !== null ? yRange.max : (cachedFs ? cachedFs / 2 : 20000);

    const newTMin = tMin + (x1 / W) * (tMax - tMin);
    const newTMax = tMin + (x2 / W) * (tMax - tMin);

    const logFMin = Math.log10(Math.max(fMin, 1));
    const logFMax = Math.log10(Math.max(fMax, fMin + 1));
    const newFMax = Math.pow(10, logFMin + (1 - y1 / H) * (logFMax - logFMin));
    const newFMin = Math.pow(10, logFMin + (1 - y2 / H) * (logFMax - logFMin));

    setRangeInputs('xMinTime', 'xMaxTime', newTMin, newTMax, 2);
    setRangeInputs('yMinSpecFreq', 'yMaxSpecFreq', newFMin, newFMax, 0);
}

function commitZoomSpectrogram(wrapperId, x1, x2, y1, y2) {
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    const W = wrapper.clientWidth || 1;
    const H = wrapper.clientHeight || 1;

    const xRange = readRange('xMinTime', 'xMaxTime');
    const yRange = readRange('yMinSpecFreq', 'yMaxSpecFreq');
    const tMin = xRange.min !== null ? xRange.min : (spectrogramTimeRange ? spectrogramTimeRange.tMin : 0);
    const tMax = xRange.max !== null ? xRange.max : (spectrogramTimeRange ? spectrogramTimeRange.tMax : cachedDuration);
    const fMin = yRange.min !== null ? yRange.min : 20;
    const fMax = yRange.max !== null ? yRange.max : (cachedFs ? cachedFs / 2 : 20000);

    const newTMin = tMin + (x1 / W) * (tMax - tMin);
    const newTMax = tMin + (x2 / W) * (tMax - tMin);

    const logFMin = Math.log10(Math.max(fMin, 1));
    const logFMax = Math.log10(Math.max(fMax, fMin + 1));
    const newFMax = Math.pow(10, logFMin + (1 - y1 / H) * (logFMax - logFMin));
    const newFMin = Math.pow(10, logFMin + (1 - y2 / H) * (logFMax - logFMin));

    setRangeInputs('xMinTime', 'xMaxTime', newTMin, newTMax, 2);
    setRangeInputs('yMinSpecFreq', 'yMaxSpecFreq', newFMin, newFMax, 0);
}

function setRangeInputs(minId, maxId, minVal, maxVal, decimals) {
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    if (!minEl || !maxEl) return;
    if (isFinite(minVal)) minEl.value = minVal.toFixed(decimals);
    if (isFinite(maxVal)) maxEl.value = maxVal.toFixed(decimals);
}

// ---------------------------------------------------------------------------
//  Reset: clear all range inputs back to "auto"
// ---------------------------------------------------------------------------
function setupResetRange() {
    const btn = document.getElementById('resetRangeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const ids = [
            'xMinTime', 'xMaxTime',
            'xMinFreq', 'xMaxFreq',
            'yMinLevel', 'yMaxLevel',
            'yMinSpecFreq', 'yMaxSpecFreq',
            'cMinDb', 'cMaxDb'
        ];
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        if (cachedSignalPa) runAnalysis();
    });
}

// ---------------------------------------------------------------------------
//  BS 4142 Analysis buttons: Impulse Prominence + Tone Audibility
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const impulseBtn = document.getElementById('impulseBtn');
    const toneBtn    = document.getElementById('toneBtn');

    if (impulseBtn) {
        impulseBtn.addEventListener('click', async () => {
            if (!cachedSignalPa) return;
            showOverlay('Computing impulse prominence…');
            try {
                // freqWeight only supports 12/24/48 kHz — resample if needed
                const supported = freqWeight.supportedSampleRates('A');
                let signal = cachedSignalPa;
                let fs     = cachedFs;
                if (!supported.includes(Math.round(fs))) {
                    signal = await resampleIfNeeded(signal, fs, 48000);
                    fs = 48000;
                }
                const result = calcImpulseProminence(signal, fs);
                openImpulseResults(result, cachedFileName);
            } catch (e) {
                console.error('Impulse prominence error:', e);
                showError('Impulse prominence failed: ' + e.message);
            } finally {
                hideOverlay();
            }
        });
    }

    if (toneBtn) {
        toneBtn.addEventListener('click', async () => {
            if (!cachedSignalPa) return;
            showOverlay('Computing tone audibility…');
            try {
                // JNMv2 uses fftSPL which handles any fs; A-weight correction
                // is applied analytically in calcToneAudibility (no IIR needed).
                const nfft   = getFftSize();
                const result = calcToneAudibility(cachedSignalPa, cachedFs, nfft);
                openToneResults(result, cachedFileName);
            } catch (e) {
                console.error('Tone audibility error:', e);
                showError('Tone audibility failed: ' + e.message);
            } finally {
                hideOverlay();
            }
        });
    }
});

// ---------------------------------------------------------------------------
//  Error display
// ---------------------------------------------------------------------------
function showError(msg) {
    document.getElementById('errorMessage').textContent = msg;
    document.getElementById('errorAlert').style.display = '';
}
function hideError() {
    document.getElementById('errorAlert').style.display = 'none';
}