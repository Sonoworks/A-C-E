// bs4142-acoustic.js
// BS 4142 Annex D (Tone Audibility – Joint Nordic Method v2) and
// Annex E (Impulse Prominence – NT ACOU 112) implemented in JavaScript.
//
// Depends on: freqWeight.js, timeWeight.js, fftSPL.js (loaded before this file).

// ---------------------------------------------------------------------------
//  NT ACOU 112 — Impulse Prominence
// ---------------------------------------------------------------------------
// Ports ActingOnImpulse2.m. Requires that freqWeight and timeWeight are
// already available globally (they are, via the main page's script tags).
//
// Returns:
//   { P, KI, OR, LD_mean, events, times, LpAF, rate, duration }
//   events: array of { Is, Ie, LD } (sample indices into times/LpAF)
function calcImpulseProminence(signalPa, fs) {
    const dT = 0.010; // 10 ms sample interval

    // A-weighting then F time-weighting (tau = 0.125 s)
    // freqWeight needs a rate supported by its coefficient tables.
    // NX-43WR files are typically 48 kHz; callers should resample first if not.
    const pA   = freqWeight(signalPa, fs, 'A');
    const pAF  = timeWeight(pA, fs, 0.125);

    // Sample at dT intervals — MATLAB: LpAF(dT*fs:dT*fs:end)
    const stride = Math.round(dT * fs);
    const n = Math.floor(pAF.length / stride);
    const LpAF = new Float32Array(n);
    const times = new Float32Array(n);
    const pRef  = 20e-6;
    for (let i = 0; i < n; i++) {
        const idx = (i + 1) * stride - 1;   // 0-based, mirrors MATLAB 1-indexed
        const v   = pAF[Math.min(idx, pAF.length - 1)];
        LpAF[i]  = 20 * Math.log10(Math.max(v, pRef * 1e-10) / pRef);
        times[i] = idx / fs;
    }

    // Rate of change (dB/s) — length n-1
    const rate = new Float32Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
        rate[i] = (LpAF[i + 1] - LpAF[i]) / dT;
    }

    // Find onset events: contiguous runs where rate >= 10 dB/s.
    // Is = first index of the run; Ie = first index after the run ends.
    // LD = LpAF[Ie] - LpAF[Is] (total level rise during the onset).
    const events = [];
    let inEvent = false;
    let eventStart = 0;

    for (let i = 0; i < rate.length; i++) {
        if (!inEvent && rate[i] >= 10) {
            inEvent = true;
            eventStart = i;
        } else if (inEvent && rate[i] < 10) {
            inEvent = false;
            const Is = eventStart;
            const Ie = i;
            const LD = LpAF[Ie] - LpAF[Is];
            if (LD > 0) events.push({ Is, Ie, LD });
        }
    }
    // Close any event still open at the end
    if (inEvent) {
        const Is = eventStart;
        const Ie = n - 1;
        const LD = LpAF[Ie] - LpAF[Is];
        if (LD > 0) events.push({ Is, Ie, LD });
    }

    const duration = times[n - 1];

    if (events.length === 0) {
        return { P: null, KI: 0, OR: 0, LD_mean: 0,
                 events: [], times, LpAF, rate, duration };
    }

    const OR     = events.length / duration;
    const LD_sum = events.reduce((s, e) => s + e.LD, 0);
    const LD_mean = LD_sum / events.length;

    let P = null;
    if (OR > 0 && LD_mean > 0) {
        P = 3 * Math.log10(OR) + 2 * Math.log10(LD_mean);
    }
    const KI = (P !== null && P > 5) ? parseFloat((1.8 * (P - 5)).toFixed(1)) : 0;

    return { P, KI, OR, LD_mean, events, times, LpAF, rate, duration };
}

// ---------------------------------------------------------------------------
//  Joint Nordic Method v2 — Tone Audibility
// ---------------------------------------------------------------------------
// Ports CalcLta.m + NoisePause.m + Latch.m + IndRound.m.
// Expects signalPa (Pa, Float32/64Array) and fs (Hz).
// nfft controls spectral resolution (default 32768 for 48 kHz → ~1.5 Hz bins).
//
// Returns:
//   { KT, deltaLta, tones, F, specA, maskingNoise, critBandBounds }
//   tones: array of { fc, Lpt, Lpn, deltaLta, KT }
function calcToneAudibility(signalPa, fs, nfft) {
    // JNMv2 needs good spectral resolution. Enforce at least ~1 Hz/bin:
    // minimum nfft = next power-of-2 at or above fs (gives df ≤ 1 Hz).
    // The caller may pass a larger value (e.g. user-selected FFT size).
    const minNfft = Math.pow(2, Math.ceil(Math.log2(fs)));
    nfft = nfft ? Math.max(nfft, minNfft) : minNfft;
    nfft = Math.max(4096, Math.min(65536, nfft));

    // ---- 1. FFT autospectrum (Hann, 50% overlap) ----
    const { freq: F, spl: specZ } = fftSPL(signalPa, fs, nfft, true, 0.5);
    const nBins = F.length;

    // ---- 2. A-weighting correction added to spectrum (dB arithmetic) ----
    const specA = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        specA[i] = specZ[i] + aWeightDb(F[i]);
    }

    // ---- 3. Forward and backward noise-pause detection ----
    const npFwd = noisePause(specA);
    const npBwd = noisePause(specA.slice().reverse()).reverse();

    // Combined: a bin is a noise-pause only if flagged in both passes
    const np = new Uint8Array(nBins);
    for (let i = 0; i < nBins; i++) {
        np[i] = npFwd[i] & npBwd[i];
    }

    // ---- 4. Find noise-pause start/end boundary indices ----
    // np_start[i] = 1 marks the first bin of each noise-pause run
    // np_end[i]   = 1 marks the last  bin of each noise-pause run
    const np_start = new Uint8Array(nBins);
    const np_end   = new Uint8Array(nBins);
    for (let i = 0; i < nBins; i++) {
        if (np[i] && (i === 0 || !np[i - 1])) np_start[i] = 1;
        if (np[i] && (i === nBins - 1 || !np[i + 1])) np_end[i] = 1;
    }

    // ---- 5. Find peaks within noise pauses ----
    // A peak is a local maximum inside a noise-pause region that sits > 6 dB
    // above the spectrum value just outside the region on both sides.
    const tones = [];

    let inNp = false;
    let npS  = 0;
    for (let i = 0; i < nBins; i++) {
        if (np_start[i]) { inNp = true; npS = i; }
        if (np_end[i] && inNp) {
            const npE = i;
            inNp = false;

            // Find the bin of maximum level inside the noise pause
            let peakBin = npS;
            let peakVal = specA[npS];
            for (let k = npS + 1; k <= npE; k++) {
                if (specA[k] > peakVal) { peakVal = specA[k]; peakBin = k; }
            }

            // Check it is > 6 dB above the adjacent spectrum bins outside the pause
            const leftVal  = npS > 0       ? specA[npS - 1] : -Infinity;
            const rightVal = npE < nBins - 1 ? specA[npE + 1] : -Infinity;
            const outsideMax = Math.max(leftVal, rightVal);
            if (peakVal - outsideMax < 6) continue;

            const fc = F[peakBin]; // candidate tone frequency

            // ---- 6. Critical band ----
            const CB = fc < 500 ? 100 : 0.20 * fc;  // Hz

            // ---- 7. Classify tone lines (3 dB BW < 10% CB → use 6 dB BW) ----
            // Find 3 dB and 6 dB half-power half-widths
            const level3 = peakVal - 3;
            const level6 = peakVal - 6;
            const bw3half = halfBandwidth(specA, F, peakBin, level3);
            const bw6half = halfBandwidth(specA, F, peakBin, level6);
            const BW3  = 2 * bw3half;
            const BW6  = 2 * bw6half;

            // Decide which bandwidth lines to include as tone
            const isToneLine = BW3 < 0.1 * CB;
            const toneBW = isToneLine ? BW6 : BW3;

            // ---- 8. Tone level Lpt: energy sum of bins within tone BW ----
            const toneHalf = toneBW / 2;
            const fLow  = fc - toneHalf;
            const fHigh = fc + toneHalf;
            const df = fs / nfft; // bin width
            let tonePowerLin = 0;
            for (let k = 0; k < nBins; k++) {
                if (F[k] >= fLow && F[k] <= fHigh) {
                    // specA is dB, convert back to linear power for summation
                    tonePowerLin += Math.pow(10, specA[k] / 10);
                }
            }
            const Lpt = 10 * Math.log10(tonePowerLin + 1e-30);

            // ---- 9. Masking noise Lpn: regression over ±75% CB excluding tone ----
            const maskHalf = 0.75 * CB;
            const maskLow  = fc - maskHalf;
            const maskHigh = fc + maskHalf;

            let maskBins = [];
            for (let k = 0; k < nBins; k++) {
                if (F[k] >= maskLow && F[k] <= maskHigh &&
                    (F[k] < fLow || F[k] > fHigh)) {
                    maskBins.push(k);
                }
            }

            let Lpn;
            if (maskBins.length >= 2) {
                // Linear regression of specA vs F in the masking region,
                // evaluate at fc to get the masking noise level.
                let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
                const nm = maskBins.length;
                for (const k of maskBins) {
                    const x = F[k]; const y = specA[k];
                    sumX += x; sumY += y; sumXX += x * x; sumXY += x * y;
                }
                const denom = nm * sumXX - sumX * sumX;
                if (Math.abs(denom) > 1e-30) {
                    const slope     = (nm * sumXY - sumX * sumY) / denom;
                    const intercept = (sumY - slope * sumX) / nm;
                    Lpn = slope * fc + intercept;
                } else {
                    Lpn = sumY / nm;
                }
            } else {
                // Fall back: mean of available masking bins
                const vals = maskBins.map(k => specA[k]);
                Lpn = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length
                                      : peakVal - 20;
            }

            // ---- 10. Tonal audibility ΔLta (BS 4142 Annex D / JNM v2) ----
            const deltaLta = (Lpt - Lpn) + 2 + Math.log10(1 + Math.pow(fc / 502, 2.5));

            // ---- 11. KT from ΔLta ----
            let KT;
            if (deltaLta > 10)      KT = 6;
            else if (deltaLta >= 4) KT = deltaLta - 4;
            else                    KT = 0;

            tones.push({
                fc, peakBin, Lpt, Lpn, deltaLta, KT,
                fLow, fHigh, maskLow, maskHigh, CB
            });
        }
    }

    // Overall KT = max across all detected tones
    const overallKT = tones.length > 0
        ? Math.min(6, Math.max(...tones.map(t => t.KT)))
        : 0;
    const overallDeltaLta = tones.length > 0
        ? Math.max(...tones.map(t => t.deltaLta))
        : null;

    return { KT: overallKT, deltaLta: overallDeltaLta, tones, F, specA, nfft };
}

// ---------------------------------------------------------------------------
//  Helper: noise pause detection (one-pass, forward direction)
// ---------------------------------------------------------------------------
// Returns a Uint8Array the same length as spec, where 1 = noise pause.
// A noise pause is a contiguous region where each successive sample rises
// by >= delta (1 dB) from the running minimum since the start of the region.
// Ports NoisePause.m using the gradient-based criterion.
function noisePause(spec) {
    const n   = spec.length;
    const np  = new Uint8Array(n);
    const delta = 1.0; // dB

    // Forward-difference gradient
    const grad = new Float32Array(n - 1);
    for (let i = 0; i < n - 1; i++) grad[i] = spec[i + 1] - spec[i];

    // np_start: bin where gradient first rises to >= delta after a descent
    // np_end:   bin where gradient first drops to <= -delta after a rise
    const npStart = new Uint8Array(n);
    const npEnd   = new Uint8Array(n);

    // MATLAB: np_start = [0  (diff([0  (diff(spec)>=1)]) > 0)]
    // Equivalent: npStart[i+1] = 1 iff grad[i]>=delta and (i==0 or grad[i-1]<delta)
    for (let i = 0; i < n - 1; i++) {
        if (grad[i] >= delta && (i === 0 || grad[i - 1] < delta)) npStart[i + 1] = 1;
    }
    // MATLAB: np_end = [(diff([(diff(spec)<=-1) 0]) < 0)  0]
    for (let i = 0; i < n - 1; i++) {
        if (grad[i] <= -delta && (i === n - 2 || grad[i + 1] > -delta)) npEnd[i] = 1;
    }

    // Fill np=1 between each matching start/end pair
    let startIdx = -1;
    for (let i = 0; i < n; i++) {
        if (npStart[i]) startIdx = i;
        if (npEnd[i] && startIdx >= 0) {
            for (let k = startIdx; k <= i; k++) np[k] = 1;
            startIdx = -1;
        }
    }
    return np;
}

// ---------------------------------------------------------------------------
//  Helper: half-bandwidth (one side) at a given level threshold
// ---------------------------------------------------------------------------
// Walk left and right from peakBin until specA drops below `level`.
// Returns the half-bandwidth in Hz (always >= one bin width).
function halfBandwidth(specA, F, peakBin, level) {
    const df = F.length > 1 ? F[1] - F[0] : 1;
    let left  = peakBin;
    let right = peakBin;
    while (left > 0 && specA[left - 1] >= level) left--;
    while (right < specA.length - 1 && specA[right + 1] >= level) right++;
    return Math.max((right - left) * df / 2, df / 2);
}

// ---------------------------------------------------------------------------
//  Helper: A-weighting correction in dB (analytic formula per IEC 61672-1)
// ---------------------------------------------------------------------------
function aWeightDb(f) {
    if (f <= 0) return -Infinity;
    const f2 = f * f;
    const f4 = f2 * f2;
    // Numerator/denominator poles of the A-weighting transfer function
    const num = 12194 * 12194 * f4;
    const d1  = f2 + 20.6  * 20.6;
    const d2  = Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9));
    const d3  = f2 + 12194 * 12194;
    const Ra  = num / (d1 * d2 * d3);
    return 20 * Math.log10(Ra) + 2.0;  // +2.0 dB normalises to 0 dB at 1 kHz
}

// ---------------------------------------------------------------------------
//  Open Impulse Prominence results in a new tab
// ---------------------------------------------------------------------------
function openImpulseResults(result, fileName) {
    const { P, KI, OR, LD_mean, events, times, LpAF, duration } = result;

    const hasTones = P !== null;

    // Serialise only what we need (arrays as JSON arrays, not TypedArray)
    const timesArr  = Array.from(times);
    const lpafArr   = Array.from(LpAF);
    const eventsArr = events.map(e => ({ Is: e.Is, Ie: e.Ie, LD: e.LD }));

    const payload = JSON.stringify({
        fileName,
        P, KI, OR: OR || 0, LD_mean: LD_mean || 0,
        duration,
        times:  timesArr,
        LpAF:   lpafArr,
        events: eventsArr
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Impulse Prominence – ${escapeHtml(fileName)}</title>
<link href="https://fonts.googleapis.com/css?family=Nunito:400,600,700,800" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1a1a1a;color:#e0e0e0;font-family:'Nunito',sans-serif;padding:24px}
  h1{font-size:1.2rem;font-weight:800;color:#fff;margin-bottom:4px}
  .sub{font-size:.82rem;color:#999;margin-bottom:20px}
  .result-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .card{background:#2a2a2a;border-radius:8px;padding:14px 20px;flex:1;min-width:140px}
  .card-label{font-size:.72rem;text-transform:uppercase;font-weight:700;color:#aaa;letter-spacing:.4px;margin-bottom:4px}
  .card-value{font-size:2rem;font-weight:800;color:#fff;line-height:1}
  .card-sub{font-size:.78rem;color:#888;margin-top:4px}
  .card.red{border-left:4px solid #cc0000}
  .card.amber{border-left:4px solid #e8a020}
  .card.green{border-left:4px solid #3ab567}
  .chart-wrap{background:#222;border-radius:8px;padding:16px;margin-bottom:20px}
  .chart-wrap h2{font-size:.9rem;font-weight:700;color:#ccc;margin-bottom:10px}
  .events-table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:12px}
  .events-table th{text-align:left;color:#aaa;font-weight:700;border-bottom:1px solid #444;padding:4px 8px}
  .events-table td{padding:4px 8px;border-bottom:1px solid #333;color:#ddd}
  .print-btn{background:#cc0000;color:#fff;border:none;padding:10px 22px;border-radius:6px;
             font-family:'Nunito',sans-serif;font-size:.9rem;font-weight:700;cursor:pointer;margin-bottom:20px}
  .print-btn:hover{background:#aa0000}
  @media print{.print-btn{display:none}}
</style>
</head>
<body>
<button class="print-btn" onclick="printToPdf()">Print to PDF</button>
<h1>Impulse Prominence – NT ACOU 112 / BS 4142 Annex E</h1>
<p class="sub" id="subTitle"></p>
<div class="result-row" id="resultCards"></div>
<div class="chart-wrap">
  <h2>LpAF Time Series (10 ms, A-weighted F-time-weighted)</h2>
  <canvas id="lpafChart" height="300"></canvas>
</div>
<div class="chart-wrap" id="eventsWrap" style="display:none">
  <h2>Detected Onset Events</h2>
  <table class="events-table">
    <thead><tr><th>#</th><th>Time (s)</th><th>LD (dB)</th></tr></thead>
    <tbody id="eventsTbody"></tbody>
  </table>
</div>
<script>
const data = ${payload};

document.getElementById('subTitle').textContent = data.fileName +
  '   ·   Duration: ' + data.duration.toFixed(2) + ' s';

// Result cards
const P  = data.P;
const KI = data.KI;
const OR = data.OR;
const LD = data.LD_mean;
const N  = data.events.length;

const cardsEl = document.getElementById('resultCards');

function card(label, value, sub, cls) {
  return '<div class="card ' + cls + '">' +
    '<div class="card-label">' + label + '</div>' +
    '<div class="card-value">' + value + '</div>' +
    (sub ? '<div class="card-sub">' + sub + '</div>' : '') +
    '</div>';
}

if (N === 0) {
  cardsEl.innerHTML = card('Onset events', '0', 'No impulse events detected', 'green') +
    card('P', '—', 'Prominence index', 'green') +
    card('K<sub>I</sub>', '0 dB', 'Impulse adjustment', 'green');
} else {
  const Pstr = P !== null ? P.toFixed(2) : '—';
  const cls  = KI === 0 ? 'green' : KI < 3 ? 'amber' : 'red';
  cardsEl.innerHTML =
    card('Onset events', N, OR.toFixed(2) + ' events/s', N === 0 ? 'green' : 'amber') +
    card('Mean LD', LD.toFixed(1) + ' dB', 'Mean onset level rise', 'amber') +
    card('P', Pstr, 'Prominence index', cls) +
    card('K<sub>I</sub>', KI.toFixed(1) + ' dB', 'Impulse adjustment (BS 4142)', cls);
}

// LpAF chart
const ctx = document.getElementById('lpafChart').getContext('2d');
const datasets = [{
  label: 'LpAF (dBA, F)',
  data: data.times.map((t, i) => ({ x: t, y: data.LpAF[i] })),
  borderColor: '#cc0000',
  borderWidth: 1.2,
  pointRadius: 0,
  fill: false,
  tension: 0
}];

// Overlay onset event markers as vertical boxes
const annotations = {};
data.events.forEach(function(ev, idx) {
  annotations['onset' + idx] = {
    type: 'box',
    xScaleID: 'x',
    xMin: data.times[ev.Is],
    xMax: data.times[ev.Ie],
    backgroundColor: 'rgba(255,180,0,0.18)',
    borderColor: 'rgba(255,180,0,0.7)',
    borderWidth: 1,
    drawTime: 'beforeDatasetsDraw'
  };
});

new Chart(ctx, {
  type: 'line',
  data: { datasets },
  options: {
    responsive: true,
    animation: false,
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Time (s)', color: '#ccc' },
        grid: { color: 'rgba(255,255,255,0.08)' },
        ticks: { color: '#ccc' }
      },
      y: {
        title: { display: true, text: 'LpAF (dBA)', color: '#ccc' },
        grid: { color: 'rgba(255,255,255,0.08)' },
        ticks: { color: '#ccc' }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: function(c) { return c.parsed.y.toFixed(1) + ' dBA'; },
          title: function(c) { return c[0].parsed.x.toFixed(3) + ' s'; }
        }
      },
      annotation: { annotations }
    }
  }
});

// Events table
if (data.events.length > 0) {
  document.getElementById('eventsWrap').style.display = '';
  const tbody = document.getElementById('eventsTbody');
  data.events.forEach(function(ev, i) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (i + 1) + '</td>' +
      '<td>' + data.times[ev.Is].toFixed(3) + ' – ' + data.times[ev.Ie].toFixed(3) + '</td>' +
      '<td>' + ev.LD.toFixed(1) + '</td>';
    tbody.appendChild(tr);
  });
}

function printToPdf() {
  window.print();
}
<\/script>
</body>
</html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow pop-ups to view the results.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
}

// ---------------------------------------------------------------------------
//  Open Tone Audibility results in a new tab
// ---------------------------------------------------------------------------
function openToneResults(result, fileName) {
    const { KT, deltaLta, tones, F, specA, nfft } = result;
    const df = F.length > 1 ? F[1] - F[0] : 1;

    // Trim spectrum to audible range for display (20 Hz – 20 kHz)
    const fMin = 20, fMax = 20000;
    const FArr      = Array.from(F).filter((f, i) => f >= fMin && f <= fMax);
    const specAArr  = Array.from(specA).filter((_, i) => F[i] >= fMin && F[i] <= fMax);

    const tonesArr = tones.map(t => ({
        fc:       t.fc,
        Lpt:      t.Lpt,
        Lpn:      t.Lpn,
        deltaLta: t.deltaLta,
        KT:       t.KT,
        fLow:     t.fLow,
        fHigh:    t.fHigh,
        maskLow:  t.maskLow,
        maskHigh: t.maskHigh
    }));

    const payload = JSON.stringify({
        fileName, KT, deltaLta,
        tones: tonesArr,
        F:     FArr,
        specA: specAArr,
        nfft,
        df
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tone Audibility – ${escapeHtml(fileName)}</title>
<link href="https://fonts.googleapis.com/css?family=Nunito:400,600,700,800" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1a1a1a;color:#e0e0e0;font-family:'Nunito',sans-serif;padding:24px}
  h1{font-size:1.2rem;font-weight:800;color:#fff;margin-bottom:4px}
  .sub{font-size:.82rem;color:#999;margin-bottom:20px}
  .result-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .card{background:#2a2a2a;border-radius:8px;padding:14px 20px;flex:1;min-width:140px}
  .card-label{font-size:.72rem;text-transform:uppercase;font-weight:700;color:#aaa;letter-spacing:.4px;margin-bottom:4px}
  .card-value{font-size:2rem;font-weight:800;color:#fff;line-height:1}
  .card-sub{font-size:.78rem;color:#888;margin-top:4px}
  .card.red{border-left:4px solid #cc0000}
  .card.amber{border-left:4px solid #e8a020}
  .card.green{border-left:4px solid #3ab567}
  .chart-wrap{background:#222;border-radius:8px;padding:16px;margin-bottom:20px}
  .chart-wrap h2{font-size:.9rem;font-weight:700;color:#ccc;margin-bottom:10px}
  .tones-table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:12px}
  .tones-table th{text-align:left;color:#aaa;font-weight:700;border-bottom:1px solid #444;padding:4px 8px}
  .tones-table td{padding:4px 8px;border-bottom:1px solid #333;color:#ddd}
  .print-btn{background:#cc0000;color:#fff;border:none;padding:10px 22px;border-radius:6px;
             font-family:'Nunito',sans-serif;font-size:.9rem;font-weight:700;cursor:pointer;margin-bottom:20px}
  .print-btn:hover{background:#aa0000}
  @media print{.print-btn{display:none}}
</style>
</head>
<body>
<button class="print-btn" onclick="printToPdf()">Print to PDF</button>
<h1>Tone Audibility – Joint Nordic Method v2 / BS 4142 Annex D</h1>
<p class="sub" id="subTitle"></p>
<div class="result-row" id="resultCards"></div>
<div class="chart-wrap">
  <h2>A-weighted Autospectrum with Detected Tones</h2>
  <canvas id="specChart" height="320"></canvas>
</div>
<div class="chart-wrap" id="tonesWrap" style="display:none">
  <h2>Detected Tones</h2>
  <table class="tones-table">
    <thead><tr>
      <th>fc (Hz)</th><th>Lpt (dBA)</th><th>Lpn (dBA)</th>
      <th>ΔLta (dB)</th><th>KT (dB)</th>
    </tr></thead>
    <tbody id="tonesTbody"></tbody>
  </table>
</div>
<script>
const data = ${payload};

document.getElementById('subTitle').textContent = data.fileName +
  '   ·   FFT size: ' + data.nfft + '   ·   Resolution: ' + data.df.toFixed(2) + ' Hz/bin';

// Result cards
const KT       = data.KT;
const deltaLta = data.deltaLta;

function card(label, value, sub, cls) {
  return '<div class="card ' + cls + '">' +
    '<div class="card-label">' + label + '</div>' +
    '<div class="card-value">' + value + '</div>' +
    (sub ? '<div class="card-sub">' + sub + '</div>' : '') +
    '</div>';
}

const cardsEl = document.getElementById('resultCards');
const nTones = data.tones.length;
const cls = KT === 0 ? 'green' : KT < 3 ? 'amber' : 'red';
const dltaStr = deltaLta !== null ? deltaLta.toFixed(1) + ' dB' : '—';
cardsEl.innerHTML =
  card('Tones detected', nTones, nTones === 1 ? '1 tonal component' : nTones + ' tonal components',
       nTones === 0 ? 'green' : 'amber') +
  card('Max ΔLta', dltaStr, 'Tonal audibility', cls) +
  card('K<sub>T</sub>', KT.toFixed(1) + ' dB', 'Tonal adjustment (BS 4142)', cls);

// Spectrum chart
const ctx = document.getElementById('specChart').getContext('2d');
const specData = data.F.map(function(f, i) { return { x: f, y: data.specA[i] }; });

const annotations = {};
data.tones.forEach(function(t, i) {
  annotations['tone_fill' + i] = {
    type: 'box',
    xScaleID: 'x',
    xMin: t.fLow,
    xMax: t.fHigh,
    backgroundColor: 'rgba(255,220,0,0.18)',
    borderColor: 'rgba(255,220,0,0.7)',
    borderWidth: 1,
    drawTime: 'beforeDatasetsDraw'
  };
  annotations['mask_fill' + i] = {
    type: 'box',
    xScaleID: 'x',
    xMin: t.maskLow,
    xMax: t.maskHigh,
    backgroundColor: 'rgba(100,160,255,0.08)',
    borderColor: 'rgba(100,160,255,0.3)',
    borderWidth: 1,
    drawTime: 'beforeDatasetsDraw'
  };
  // Lpn line (masking noise level) across the critical band
  annotations['lpn_line' + i] = {
    type: 'line',
    xScaleID: 'x',
    yScaleID: 'y',
    xMin: t.maskLow,
    xMax: t.maskHigh,
    yMin: t.Lpn,
    yMax: t.Lpn,
    borderColor: 'rgba(100,160,255,0.85)',
    borderWidth: 1.5,
    borderDash: [4, 3]
  };
  // fc marker
  annotations['fc_line' + i] = {
    type: 'line',
    scaleID: 'x',
    value: t.fc,
    borderColor: 'rgba(255,220,0,0.85)',
    borderWidth: 1.5
  };
});

new Chart(ctx, {
  type: 'line',
  data: {
    datasets: [{
      label: 'LpA (dBA)',
      data: specData,
      borderColor: '#cc0000',
      borderWidth: 1.2,
      pointRadius: 0,
      fill: false,
      tension: 0.05
    }]
  },
  options: {
    responsive: true,
    animation: false,
    scales: {
      x: {
        type: 'logarithmic',
        min: 20, max: 20000,
        title: { display: true, text: 'Frequency (Hz)', color: '#ccc' },
        grid: { color: 'rgba(255,255,255,0.08)' },
        ticks: {
          color: '#ccc',
          callback: function(v) {
            var labels = [20,50,100,200,500,1000,2000,5000,10000,20000];
            if (labels.includes(Number(v))) return v >= 1000 ? (v/1000)+'k' : v;
            return '';
          }
        }
      },
      y: {
        title: { display: true, text: 'LpA (dBA)', color: '#ccc' },
        grid: { color: 'rgba(255,255,255,0.08)' },
        ticks: { color: '#ccc' }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: function(c) { return c.parsed.y.toFixed(1) + ' dBA'; },
          title: function(c) { return c[0].parsed.x.toFixed(1) + ' Hz'; }
        }
      },
      annotation: { annotations }
    }
  }
});

// Tones table
if (data.tones.length > 0) {
  document.getElementById('tonesWrap').style.display = '';
  const tbody = document.getElementById('tonesTbody');
  data.tones.sort(function(a,b){ return b.deltaLta - a.deltaLta; })
    .forEach(function(t) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + t.fc.toFixed(1) + '</td>' +
        '<td>' + t.Lpt.toFixed(1) + '</td>' +
        '<td>' + t.Lpn.toFixed(1) + '</td>' +
        '<td>' + t.deltaLta.toFixed(1) + '</td>' +
        '<td>' + t.KT.toFixed(1) + '</td>';
      tbody.appendChild(tr);
    });
}

function printToPdf() {
  window.print();
}
<\/script>
</body>
</html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow pop-ups to view the results.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
}

// ---------------------------------------------------------------------------
//  Tiny HTML-escape helper (used when building the new-tab HTML string)
// ---------------------------------------------------------------------------
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
