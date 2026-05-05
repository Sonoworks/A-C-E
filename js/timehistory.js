// timehistory.js
// Handles file upload, time weighting and level vs time plotting for AuralisationLite

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const chartRow = document.getElementById('chartRow');

const TARGET_FS = 48000;
let timeChart = null;
let cachedSignal = null;
let cachedFs = null;
let cachedFileName = '';
let cachedFullScale = 1.0;
let audioUrl = null;
let animationFrameId = null;

// --- Drag and drop events ---

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.backgroundColor = '#eaecf4';
});

dropZone.addEventListener('dragleave', () => {
    dropZone.style.backgroundColor = '#f8f9fc';
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.backgroundColor = '#f8f9fc';
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.wav')) {
        processFile(file);
    } else {
        alert('Please drop a .wav file.');
    }
});

// --- Browse button ---

fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) processFile(file);
});

// --- Process the WAV file ---

function processFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;

        // Parse calibration from WAV bytes BEFORE decoding audio
        const calResult = parseWavCalibration(arrayBuffer);

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.decodeAudioData(arrayBuffer.slice(0), async function (audioBuffer) {

            const signal = audioBuffer.getChannelData(0);
            const fs = audioBuffer.sampleRate;
            const duration = (signal.length / fs).toFixed(2);

            // Cache raw signal and file info
            cachedSignal = signal;
            cachedFs = fs;
            cachedFileName = file.name;

            // Set up audio player
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            audioUrl = URL.createObjectURL(file);
            const player = document.getElementById('audioPlayer');
            player.src = audioUrl;
            document.getElementById('playerWrapper').style.display = 'flex';

            // Update file info bar
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

// --- Get current tau from UI ---

function getTau() {
    const weighting = document.querySelector('input[name="timeWeight"]:checked').value;
    switch (weighting) {
        case 'F': return 0.125;
        case 'S': return 1.0;
        case 'C': {
            const val = parseFloat(document.getElementById('customTau').value);
            return (isNaN(val) ? 10 : Math.min(999, Math.max(10, val))) / 1000;
        }
    }
}

// --- Run analysis ---

function runAnalysis() {
    if (!cachedSignal) return;

    const tau = getTau();
    const freqWeight = document.querySelector('input[name="freqWeight"]:checked').value;

    // Apply calibration scaling
    let signal = applyCalibration(cachedSignal, cachedFullScale);

    // Apply frequency weighting
    if (freqWeight === 'A') {
        signal = aWeight(signal, cachedFs);
    }

    // Apply time weighting
    const weighted = timeWeight(signal, cachedFs, tau);

    // Convert to SPL
    const spl = signalToSPL(weighted);

    // Decimate for plotting
    const { times, decimated } = decimateSignal(spl, cachedFs);

    // Plot
    plotTimeHistory(times, decimated, cachedFileName, freqWeight, tau);
}

// --- Plot ---

function plotTimeHistory(times, spl, filename, freqWeight, tau) {

    chartRow.style.display = 'flex';

    const chartData = times.map((t, i) => ({ x: t, y: spl[i] }));
    const maxTime = times[times.length - 1];

    if (timeChart) timeChart.destroy();

    const ctx = document.getElementById('timeChart').getContext('2d');
    const label = freqWeight === 'A' ? 'LA (dBA)' : 'LZ (dB)';

    timeChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: label,
                data: chartData,
                borderColor: '#e74a3b',
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false,
                tension: 0
            }]
        },
        options: {
            responsive: true,
            animation: false,
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Time (s)'
                    },
                    min: 0,
                    max: maxTime,
                    grid: { color: '#e0e0e0' }
                },
                y: {
                    title: {
                        display: true,
                        text: freqWeight === 'A' ? 'LA (dBA)' : 'LZ (dB re 20μPa)'
                    },
                    grid: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`,
                        title: (ctx) => `${parseFloat(ctx[0].parsed.x).toFixed(3)} s`
                    }
                },
                annotation: {
                    annotations: {
                        playhead: {
                            type: 'line',
                            scaleID: 'x',
                            value: 0,
                            borderColor: 'rgba(255, 255, 255, 0.85)',
                            borderWidth: 2,
                            borderDash: [4, 4],
                            display: false,
                            label: {
                                display: false
                            }
                        }
                    }
                }
            }
        }
    });

    // Set up playhead sync
    setupPlayhead();
}

// --- Playhead cursor sync ---

function setupPlayhead() {
    const player = document.getElementById('audioPlayer');

    // Cancel any existing animation loop
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    function updatePlayhead() {
        if (!timeChart) return;

        const annotation = timeChart.options.plugins.annotation.annotations.playhead;

        if (!player.paused && !player.ended) {
            // Show and update playhead position
            annotation.display = true;
            annotation.value = player.currentTime;
            timeChart.update('none'); // 'none' skips animation for performance
            animationFrameId = requestAnimationFrame(updatePlayhead);
        } else {
            // Hide playhead when not playing
            annotation.display = false;
            timeChart.update('none');
            animationFrameId = null;
        }
    }

    // Start loop on play
    player.addEventListener('play', () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(updatePlayhead);
    });

    // Stop loop on pause/end
    player.addEventListener('pause', () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        if (timeChart) {
            timeChart.options.plugins.annotation.annotations.playhead.display = false;
            timeChart.update('none');
        }
    });

    player.addEventListener('ended', () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        if (timeChart) {
            timeChart.options.plugins.annotation.annotations.playhead.display = false;
            timeChart.update('none');
        }
    });

    // Handle scrubbing
    player.addEventListener('seeked', () => {
        if (timeChart) {
            const annotation = timeChart.options.plugins.annotation.annotations.playhead;
            annotation.value = player.currentTime;
            annotation.display = true;
            timeChart.update('none');
        }
    });
}

// --- Toggle and input listeners ---

document.addEventListener('DOMContentLoaded', () => {

    document.querySelectorAll('input[name="timeWeight"], input[name="freqWeight"]')
        .forEach(input => {
            input.addEventListener('change', () => {
                const isCustom = document.querySelector('input[name="timeWeight"]:checked').value === 'C';
                document.getElementById('customTauWrapper').style.display = isCustom ? 'flex' : 'none';
                runAnalysis();
            });
        });

    document.getElementById('customTau').addEventListener('change', runAnalysis);
    document.getElementById('customTau').addEventListener('input', runAnalysis);

});