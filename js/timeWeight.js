// timeWeight.js
// Port of timeWeight3.m by Matt Torjussen (matt@sonoworks.co.uk)
// Applies IEC 61672-1 time weighting to a pressure signal
// Ported to JavaScript by AuralisationLite

function timeWeight(signal, fs, tau) {
    // Calculate filter coefficient
    const alpha = Math.exp(-1 / (fs * tau));

    // Output array
    const y = new Float32Array(signal.length);

    // Initialise with first squared sample
    y[0] = signal[0] * signal[0];

    // First order IIR difference equation
    // y[n] = (1 - alpha) * x²[n] + alpha * y[n-1]
    for (let n = 1; n < signal.length; n++) {
        y[n] = (1 - alpha) * signal[n] * signal[n] + alpha * y[n - 1];
    }

    // Square root to get time-weighted RMS pressure
    for (let n = 0; n < y.length; n++) {
        y[n] = Math.sqrt(y[n]);
    }

    return y;
}

function signalToSPL(signal) {
    // Convert pressure signal to SPL in dB re 20uPa
    const pRef = 20e-6;
    const spl = new Float32Array(signal.length);
    for (let n = 0; n < signal.length; n++) {
        // Clamp to avoid log(0)
        spl[n] = 20 * Math.log10(Math.max(signal[n], pRef * 1e-6) / pRef);
    }
    return spl;
}

function decimateSignal(signal, fs, targetPoints = 5000) {
    // Reduce number of points for plotting efficiency
    // whilst preserving the overall shape
    const step = Math.max(1, Math.floor(signal.length / targetPoints));
    const decimated = [];
    const times = [];

    for (let i = 0; i < signal.length; i += step) {
        // Take max value in each block to preserve peaks
        let maxVal = signal[i];
        for (let j = i; j < Math.min(i + step, signal.length); j++) {
            if (signal[j] > maxVal) maxVal = signal[j];
        }
        decimated.push(maxVal);
        times.push(i / fs);
    }

    return { times, decimated };
}