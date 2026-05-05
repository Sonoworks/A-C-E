// fftspectrum.js
// Handles file upload, calibration, WAV decoding and spectrum plotting

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const chartRow = document.getElementById('chartRow');

let spectrumChart = null;
let cachedSignal = null;
let cachedFs = null;
let cachedFileName = '';
let cachedFullScale = 1.0;
let audioUrl = null;

// --- Drag and drop ---

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
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.wav')) {
        processFile(file);
    } else {
        alert('Please drop a .wav file.');
    }
});

// --- Browse ---

fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) processFile(file);
});

// --- Process file ---

function processFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;

        // Set up audio player
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(file);
        const player = document.getElementById('audioPlayer');
        player.src = audioUrl;
        document.getElementById('playerWrapper').style.display = 'flex';

        // Parse calibration from WAV bytes
        const calResult = parseWavCalibration(arrayBuffer);

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.decodeAudioData(arrayBuffer.slice(0), function (audioBuffer) {

            const signal = audioBuffer.getChannelData(0);
            const fs = audioBuffer.sampleRate;
            const duration = (signal.length / fs).toFixed(2);

            cachedSignal = signal;
            cachedFs = fs;
            cachedFileName = file.name;

            document.getElementById('fileName').textContent = file.name;
            document.getElementById('fileSampleRate').textContent = fs + ' Hz';
            document.getElementById('fileDuration').textContent = duration + ' s';
            fileInfo.style.display = 'flex';

            // Show calibration modal
            showCalibrationModal(signal, calResult, function (fullScale) {
                cachedFullScale = fullScale;
                const rmsSPL = computeRmsSPL(signal, fullScale);
                const peakSPL = computePeakSPL(signal, fullScale);
                document.getElementById('calInfoText').textContent =
                    `Cal: RMS ${rmsSPL.toFixed(1)} dB | Peak ${peakSPL.toFixed(1)} dB SPL`;
                document.getElementById('calInfo').style.display = 'flex';
                runAnalysis();
            });

        }, function (err) {
            alert('Could not decode audio file. Please ensure it is a valid .wav file.');
            console.error(err);
        });
    };
    reader.readAsArrayBuffer(file);
}

// --- Run analysis ---

function runAnalysis() {
    if (!cachedSignal) return;

    // Apply calibration
    const calibrated = applyCalibration(cachedSignal, cachedFullScale);

    const nfft = 4096;
    const { freq, spl } = fftSPL(calibrated, cachedFs, nfft, true, 0.5);
    plotSpectrum(freq, spl, cachedFileName);
}

// --- Plot ---

function plotSpectrum(freq, spl, filename) {

    const minFreq = 20;
    const maxFreq = 20000;
    const filteredFreq = [];
    const filteredSPL = [];

    for (let i = 0; i < freq.length; i++) {
        if (freq[i] >= minFreq && freq[i] <= maxFreq) {
            filteredFreq.push(freq[i]);
            filteredSPL.push(spl[i]);
        }
    }

    const chartData = filteredFreq.map((f, i) => ({ x: f, y: filteredSPL[i] }));

    chartRow.style.display = 'flex';
    document.getElementById('chartSubtitle').textContent = filename;

    if (spectrumChart) spectrumChart.destroy();

    const ctx = document.getElementById('spectrumChart').getContext('2d');

    spectrumChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'SPL (dB re 20μPa)',
                data: chartData,
                borderColor: '#cc0000',
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'Frequency (Hz)', color: '#e0e0e0' },
                    min: minFreq,
                    max: maxFreq,
                    ticks: {
                        color: '#e0e0e0',
                        callback: function (value) {
                            const labels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
                            if (labels.includes(Number(value))) {
                                return value >= 1000 ? (value / 1000) + 'k' : value;
                            }
                            return '';
                        }
                    }
                },
                y: {
                    title: { display: true, text: 'SPL (dB re 20μPa)', color: '#e0e0e0' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`,
                        title: (ctx) => `${parseFloat(ctx[0].parsed.x).toFixed(1)} Hz`
                    }
                }
            }
        }
    });
}