// octave.js
// Handles file upload, resampling, calibration and octave band analysis

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const chartRow = document.getElementById('chartRow');

const TARGET_FS = 48000;
let octaveChart = null;
let cachedSignal = null;
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

// --- Resample to 48kHz ---

async function resampleTo48k(audioBuffer) {
    const offlineCtx = new OfflineAudioContext(
        1,
        Math.ceil(audioBuffer.duration * TARGET_FS),
        TARGET_FS
    );
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled = await offlineCtx.startRendering();
    return resampled;
}

// --- Process file ---

async function processFile(file) {
    const reader = new FileReader();
    reader.onload = async function (e) {
        const arrayBuffer = e.target.result;

        // Parse calibration from WAV bytes
        const calResult = parseWavCalibration(arrayBuffer);

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.decodeAudioData(arrayBuffer.slice(0), async function (audioBuffer) {

            let signal;
            let fs = audioBuffer.sampleRate;
            let resampleNote = '';

            if (fs !== TARGET_FS) {
                resampleNote = ` (resampled from ${fs} Hz)`;
                const resampled = await resampleTo48k(audioBuffer);
                signal = resampled.getChannelData(0);
                fs = TARGET_FS;
            } else {
                signal = audioBuffer.getChannelData(0);
            }

            cachedSignal = signal;
            cachedFileName = file.name;

            // Set up audio player
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            audioUrl = URL.createObjectURL(file);
            const player = document.getElementById('audioPlayer');
            player.src = audioUrl;
            document.getElementById('playerWrapper').style.display = 'flex';

            // Update file info bar
            document.getElementById('fileName').textContent = file.name;
            document.getElementById('fileSampleRate').textContent =
                TARGET_FS + (resampleNote ? resampleNote : ' Hz');
            document.getElementById('fileDuration').textContent =
                (signal.length / TARGET_FS).toFixed(2) + ' s';
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

    const bandType = document.querySelector('input[name="bandType"]:checked').value;
    const weighting = document.querySelector('input[name="weighting"]:checked').value;

    // Apply calibration
    let signal = applyCalibration(cachedSignal, cachedFullScale);

    // Apply A-weighting if selected
    if (weighting === 'A') {
        signal = aWeight(signal, TARGET_FS);
    }

    const { freqLabels, spl } = octFilt(signal, bandType);
    plotOctave(freqLabels, spl, cachedFileName, bandType, weighting);
}

// --- Plot ---

function plotOctave(freqLabels, spl, filename, bandType, weighting) {

    chartRow.style.display = 'flex';
    document.getElementById('chartSubtitle').textContent = filename;

    const barColour = bandType === 'whole' ? '#cc0000' : '#888888';

    if (octaveChart) octaveChart.destroy();

    const ctx = document.getElementById('octaveChart').getContext('2d');

    octaveChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: freqLabels,
            datasets: [{
                label: weighting === 'A' ? 'SPL (dBA)' : 'SPL (dB Lin)',
                data: spl,
                backgroundColor: barColour,
                borderColor: barColour,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    title: { display: true, text: 'Frequency (Hz)', color: '#e0e0e0' },
                    grid: { display: false },
                    ticks: { color: '#e0e0e0' }
                },
                y: {
                    title: {
                        display: true,
                        text: weighting === 'A' ? 'SPL (dBA)' : 'SPL (dB re 20μPa)',
                        color: '#e0e0e0'
                    },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`
                    }
                }
            }
        }
    });
}

// --- Toggle listeners ---

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[name="bandType"], input[name="weighting"]')
        .forEach(input => {
            input.addEventListener('change', runAnalysis);
        });
});