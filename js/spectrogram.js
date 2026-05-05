// spectrogram.js
// Handles file upload, calibration, spectrogram rendering and playhead

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const chartRow = document.getElementById('chartRow');

let cachedSignal = null;
let cachedFs = null;
let cachedFileName = '';
let cachedFullScale = 1.0;
let audioUrl = null;
let animationFrameId = null;
let cachedTime = null;

// --- ARC custom colourmap ---

function splToColour(value, minDb, maxDb) {
    const t = Math.max(0, Math.min(1, (value - minDb) / (maxDb - minDb)));
    let r, g, b;
    if (t < 0.33) {
        const s = t / 0.33;
        r = Math.round(102 * s);
        g = 0;
        b = 0;
    } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        r = Math.round(102 + (204 - 102) * s);
        g = 0;
        b = 0;
    } else {
        const s = (t - 0.66) / 0.34;
        r = Math.round(204 + (255 - 204) * s);
        g = Math.round(255 * s);
        b = Math.round(255 * s);
    }
    return [r, g, b];
}

// --- Drag and drop ---

dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.style.backgroundColor = '#555555';
});

dropZone.addEventListener('dragleave', function () {
    dropZone.style.backgroundColor = '#3a3a3a';
});

dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.style.backgroundColor = '#3a3a3a';
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.wav')) {
        processFile(file);
    } else {
        alert('Please drop a .wav file.');
    }
});

// --- Browse ---

fileInput.addEventListener('change', function () {
    const file = fileInput.files[0];
    if (file) processFile(file);
});

// --- Process file ---

function processFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        const calResult = parseWavCalibration(arrayBuffer);
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();

        audioContext.decodeAudioData(arrayBuffer.slice(0), function (audioBuffer) {

            const signal = audioBuffer.getChannelData(0);
            const fs = audioBuffer.sampleRate;
            const duration = (signal.length / fs).toFixed(2);

            cachedSignal = signal;
            cachedFs = fs;
            cachedFileName = file.name;

            if (audioUrl) URL.revokeObjectURL(audioUrl);
            audioUrl = URL.createObjectURL(file);
            const player = document.getElementById('audioPlayer');
            player.src = audioUrl;
            document.getElementById('playerWrapper').style.display = 'flex';

            document.getElementById('fileName').textContent = file.name;
            document.getElementById('fileSampleRate').textContent = fs + ' Hz';
            document.getElementById('fileDuration').textContent = duration + ' s';
            fileInfo.style.display = 'flex';

            showCalibrationModal(signal, calResult, function (fullScale) {
                cachedFullScale = fullScale;
                const rmsSPL = computeRmsSPL(signal, fullScale);
                const peakSPL = computePeakSPL(signal, fullScale);
                document.getElementById('calInfoText').textContent =
                    'Cal: RMS ' + rmsSPL.toFixed(1) + ' dB | Peak ' + peakSPL.toFixed(1) + ' dB SPL';
                document.getElementById('calInfo').style.display = 'flex';
                runAnalysis();
            });

        }, function (err) {
            alert('Could not decode audio file.');
            console.error(err);
        });
    };
    reader.readAsArrayBuffer(file);
}

// --- Run analysis ---

function runAnalysis() {
    if (!cachedSignal) return;

    console.log('runAnalysis called');
    console.log('cachedFs:', cachedFs);
    console.log('cachedSignal length:', cachedSignal.length);
    console.log('cachedFullScale:', cachedFullScale);

    const signal = applyCalibration(cachedSignal, cachedFullScale);
    console.log('calibration applied, signal length:', signal.length);

    const nfft = 2048;
    console.log('calling sonogramSPL...');

    const result = sonogramSPL(signal, cachedFs, nfft, true, 0.75);
    console.log('sonogramSPL returned:', result);

    const resFreq = result.freq;
    const resTime = result.time;
    const resSpec = result.spec;
    const resNBins = result.nBins;
    const resNFrames = result.nFrames;

    console.log('nBins:', resNBins);
    console.log('nFrames:', resNFrames);
    console.log('spec length:', resSpec.length);
    console.log('freq[0]:', resFreq[0], 'freq[last]:', resFreq[resFreq.length - 1]);
    console.log('time[0]:', resTime[0], 'time[last]:', resTime[resTime.length - 1]);

    cachedTime = resTime;

    let minDb = parseFloat(document.getElementById('minDb').value);
    let maxDb = parseFloat(document.getElementById('maxDb').value);

    if (isNaN(minDb) || isNaN(maxDb)) {
        let globalMax = -Infinity;
        for (let i = 0; i < resSpec.length; i++) {
            if (resSpec[i] > globalMax) globalMax = resSpec[i];
        }
        minDb = 10;
        maxDb = Math.ceil(globalMax);
        document.getElementById('minDb').value = minDb;
        document.getElementById('maxDb').value = maxDb;
    }

    console.log('minDb:', minDb, 'maxDb:', maxDb);

    chartRow.style.display = 'flex';

    setTimeout(function () {
        const freqScale = document.querySelector('input[name="freqScale"]:checked').value;
        console.log('freqScale:', freqScale);
        drawSpectrogram(resFreq, resTime, resSpec, resNBins, resNFrames, minDb, maxDb, freqScale);
        drawColourbar(minDb, maxDb);
        setupPlayhead(resTime[resNFrames - 1]);
    }, 50);
}

// --- Draw spectrogram ---

function drawSpectrogram(freq, time, spec, nBins, nFrames, minDb, maxDb, freqScale) {

    console.log('drawSpectrogram called');

    const canvas = document.getElementById('spectrogramCanvas');
    const ctx = canvas.getContext('2d');
    const wrapper = canvas.parentElement;
    const W = wrapper.clientWidth || 800;
    const H = wrapper.clientHeight || 500;

    console.log('canvas wrapper size W:', W, 'H:', H);

    canvas.width = W;
    canvas.height = H;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;

    const minFreq = 20;
    const maxFreq = freq[freq.length - 1];
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);

    console.log('maxFreq:', maxFreq, 'rendering', W, 'x', H, 'pixels...');

    for (let px = 0; px < W; px++) {
        const frameIdx = Math.min(Math.floor((px / W) * nFrames), nFrames - 1);
        for (let py = 0; py < H; py++) {
            const yNorm = 1 - py / H;
            let binIdx;
            if (freqScale === 'log') {
                const logFreq = logMin + yNorm * (logMax - logMin);
                const f = Math.pow(10, logFreq);
                binIdx = Math.round(f * nBins / maxFreq);
            } else {
                binIdx = Math.round(yNorm * (nBins - 1));
            }
            binIdx = Math.max(0, Math.min(nBins - 1, binIdx));
            const splVal = spec[binIdx * nFrames + frameIdx];
            const colour = splToColour(splVal, minDb, maxDb);
            const idx = (py * W + px) * 4;
            data[idx]     = colour[0];
            data[idx + 1] = colour[1];
            data[idx + 2] = colour[2];
            data[idx + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);
    console.log('imageData rendered');

    drawFreqAxis(ctx, W, H, minFreq, maxFreq, freqScale);
    drawTimeAxis(ctx, W, H, time[0], time[nFrames - 1]);
}

// --- Draw frequency axis ---

function drawFreqAxis(ctx, W, H, minFreq, maxFreq, freqScale) {
    const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);

    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'left';

    freqLabels.forEach(function (f) {
        if (f < minFreq || f > maxFreq) return;
        let yNorm;
        if (freqScale === 'log') {
            yNorm = (Math.log10(f) - logMin) / (logMax - logMin);
        } else {
            yNorm = f / maxFreq;
        }
        const y = H * (1 - yNorm);
        const label = f >= 1000 ? (f / 1000) + 'k' : String(f);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(0, y, W, 0.5);
        ctx.fillStyle = '#e0e0e0';
        ctx.fillText(label, 4, y - 3);
    });
}

// --- Draw time axis ---

function drawTimeAxis(ctx, W, H, tMin, tMax) {
    const duration = tMax - tMin;
    const step = duration > 30 ? 10 : duration > 10 ? 5 : 1;
    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'center';
    for (let t = Math.ceil(tMin); t <= tMax; t += step) {
        const x = ((t - tMin) / duration) * W;
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(x, 0, 0.5, H);
        ctx.fillStyle = '#e0e0e0';
        ctx.fillText(t + 's', x, H - 4);
    }
}

// --- Draw colourbar ---

function drawColourbar(minDb, maxDb) {
    const canvas = document.getElementById('colourbarCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    for (let py = 0; py < H; py++) {
        const t = 1 - py / H;
        const value = minDb + t * (maxDb - minDb);
        const colour = splToColour(value, minDb, maxDb);
        ctx.fillStyle = 'rgb(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ')';
        ctx.fillRect(0, py, W, 1);
    }
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'left';
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
        const t = 1 - i / steps;
        const y = Math.round(t * H);
        const val = Math.round(minDb + (i / steps) * (maxDb - minDb));
        ctx.fillText(String(val), W + 4, y + 4);
    }
}

// --- Playhead ---

function setupPlayhead(totalDuration) {
    const player = document.getElementById('audioPlayer');
    const canvas = document.getElementById('playheadCanvas');
    const ctx = canvas.getContext('2d');

    function resizePlayhead() {
        const spectroCanvas = document.getElementById('spectrogramCanvas');
        canvas.width = spectroCanvas.width;
        canvas.height = spectroCanvas.height;
        canvas.style.width = spectroCanvas.style.width;
        canvas.style.height = spectroCanvas.style.height;
    }

    resizePlayhead();

    function drawPlayhead() {
        resizePlayhead();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (player.paused && player.currentTime === 0) return;
        const x = (player.currentTime / totalDuration) * canvas.width;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }

    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    function loop() {
        drawPlayhead();
        if (!player.paused && !player.ended) {
            animationFrameId = requestAnimationFrame(loop);
        }
    }

    player.addEventListener('play', function () {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(loop);
    });

    player.addEventListener('pause', function () {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        drawPlayhead();
    });

    player.addEventListener('ended', function () {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });

    player.addEventListener('seeked', drawPlayhead);
}

// --- Listeners ---

document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('input[name="freqScale"]').forEach(function (input) {
        input.addEventListener('change', runAnalysis);
    });
    document.getElementById('minDb').addEventListener('change', runAnalysis);
    document.getElementById('maxDb').addEventListener('change', runAnalysis);
});