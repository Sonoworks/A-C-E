// calibration.js
// Shared calibration module for AuralisationLite
// Reads ICMT chunk from WAV ArrayBuffer and applies scaling to Pascals

const P_REF = 20e-6; // Reference pressure in Pa

// --- Parse ICMT comment from raw WAV ArrayBuffer ---

function parseWavCalibration(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('utf-8');

    // Search for 'ICMT' marker in the binary
    for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i]     === 0x49 && // I
            bytes[i + 1] === 0x43 && // C
            bytes[i + 2] === 0x4D && // M
            bytes[i + 3] === 0x54) { // T

            // Next 4 bytes are chunk size (little-endian uint32)
            const chunkSize = bytes[i + 4]
                | (bytes[i + 5] << 8)
                | (bytes[i + 6] << 16)
                | (bytes[i + 7] << 24);

            // Read the comment string
            const commentBytes = bytes.slice(i + 8, i + 8 + chunkSize);
            const comment = decoder.decode(commentBytes).replace(/\0/g, '').trim();

            // Parse calibration level
            const match = comment.match(/calibration:\s*([\d.]+)\s*dB SPL/);
            if (match) {
                return {
                    found: true,
                    level: parseFloat(match[1]),
                    comment: comment
                };
            }
        }
    }
    return { found: false, level: null, comment: null };
}

// --- Compute fullScale from calibration level ---

function levelToFullScale(level) {
    return 2 * Math.sqrt(2) * P_REF * Math.pow(10, level / 20);
}

// --- Compute fullScale from V/Pa sensitivity ---
// For an uncalibrated file, user supplies sensitivity in V/Pa
// The Web Audio API normalises to ±1.0 which represents full scale
// So: signal_Pa = normalisedSample / sensitivity

function sensitivityToFullScale(sensitivity) {
    return 1.0 / sensitivity;
}

// --- Apply calibration scaling to signal ---

function applyCalibration(signal, fullScale) {
    const scaled = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
        scaled[i] = signal[i] * fullScale;
    }
    return scaled;
}

// --- Compute RMS SPL preview ---

function computeRmsSPL(signal, fullScale) {
    let sumSq = 0;
    for (let i = 0; i < signal.length; i++) {
        const pa = signal[i] * fullScale;
        sumSq += pa * pa;
    }
    const rms = Math.sqrt(sumSq / signal.length);
    return 20 * Math.log10(Math.max(rms, P_REF * 1e-9) / P_REF);
}

// --- Compute Peak SPL preview ---

function computePeakSPL(signal, fullScale) {
    let peak = 0;
    for (let i = 0; i < signal.length; i++) {
        const pa = Math.abs(signal[i] * fullScale);
        if (pa > peak) peak = pa;
    }
    return 20 * Math.log10(Math.max(peak, P_REF * 1e-9) / P_REF);
}

// --- Show calibration modal ---
// Accepts:
//   signal       - normalised Float32Array from Web Audio API
//   calResult    - result from parseWavCalibration()
//   onAccept     - callback(fullScale) called when user accepts

function showCalibrationModal(signal, calResult, onAccept) {

    // Pre-fill values if found in file
    let initialLevel = calResult.found ? calResult.level : null;
    let initialFullScale = initialLevel !== null ? levelToFullScale(initialLevel) : null;

    // Update preview in modal
    function updatePreview(fullScale) {
        if (!fullScale || isNaN(fullScale) || fullScale <= 0) {
            document.getElementById('calRmsSPL').textContent = '---';
            document.getElementById('calPeakSPL').textContent = '---';
            return;
        }
        const rms = computeRmsSPL(signal, fullScale);
        const peak = computePeakSPL(signal, fullScale);
        document.getElementById('calRmsSPL').textContent = rms.toFixed(1) + ' dB SPL';
        document.getElementById('calPeakSPL').textContent = peak.toFixed(1) + ' dB SPL';
    }

    // Set modal source label
    const sourceLabel = document.getElementById('calSourceLabel');
    const calLevelInput = document.getElementById('calLevelInput');
    const calSensInput = document.getElementById('calSensInput');
    const calLevelRow = document.getElementById('calLevelRow');
    const calSensRow = document.getElementById('calSensRow');

    if (calResult.found) {
        sourceLabel.textContent = 'Calibration found in file';
        sourceLabel.className = 'badge badge-success mb-3';
        calLevelRow.style.display = 'flex';
        calSensRow.style.display = 'none';
        calLevelInput.value = initialLevel;
        updatePreview(initialFullScale);
    } else {
        sourceLabel.textContent = 'No calibration found in file';
        sourceLabel.className = 'badge badge-warning mb-3';
        calLevelRow.style.display = 'none';
        calSensRow.style.display = 'flex';
        calSensInput.value = '';
        updatePreview(null);
    }

    // Level input change (when found in file)
    calLevelInput.oninput = function () {
        const level = parseFloat(this.value);
        if (!isNaN(level)) updatePreview(levelToFullScale(level));
        else updatePreview(null);
    };

    // Sensitivity input change (when not found in file)
    calSensInput.oninput = function () {
        const sens = parseFloat(this.value);
        if (!isNaN(sens) && sens > 0) updatePreview(sensitivityToFullScale(sens));
        else updatePreview(null);
    };

    // Accept button
    document.getElementById('calAcceptBtn').onclick = function () {
        let fullScale;
        if (calResult.found) {
            const level = parseFloat(calLevelInput.value);
            fullScale = isNaN(level) ? initialFullScale : levelToFullScale(level);
        } else {
            const sens = parseFloat(calSensInput.value);
            if (isNaN(sens) || sens <= 0) {
                alert('Please enter a valid sensitivity value in V/Pa.');
                return;
            }
            fullScale = sensitivityToFullScale(sens);
        }
        // Hide modal
        $('#calModal').modal('hide');
        // Call back with fullScale
        onAccept(fullScale);
    };

    // Show modal
    $('#calModal').modal('show');
}