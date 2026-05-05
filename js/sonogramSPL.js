// sonogramSPL.js
// Port of sonogramSPL.m by Matt Torjussen (matt@sonoworks.co.uk)
// Returns 2D SPL matrix (freq bins x time frames) for spectrogram display

function hannWindow(n) {
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return win;
}

function sonogramSPL(signal, fs, nfft = 4096, useWindow = true, overlap = 0.75) {

    const hopSize = Math.round(nfft * (1 - overlap));
    const win = useWindow ? hannWindow(nfft) : null;
    const acf = useWindow
        ? nfft / win.reduce((a, b) => a + b, 0)
        : 1;

    // Work out number of frames
    const nFrames = Math.floor((signal.length - nfft) / hopSize) + 1;
    const nBins = nfft / 2 + 1;
    const pRef = 20e-6;

    // Output matrix — flat array [bin * nFrames + frame]
    const spec = new Float32Array(nBins * nFrames);

    for (let frame = 0; frame < nFrames; frame++) {
        const start = frame * hopSize;

        // Extract and window block
        const block = new Float32Array(nfft);
        for (let i = 0; i < nfft; i++) {
            block[i] = signal[start + i] * (win ? win[i] : 1);
        }

        // FFT
        const { re, im } = fftReal(block, nfft);

        // Compute SPL for each bin
        for (let bin = 0; bin < nBins; bin++) {
            const mag = acf * 2 * Math.sqrt(re[bin] ** 2 + im[bin] ** 2) / nfft;
            const power = (mag ** 2) / 2;
            const spl = 20 * Math.log10(Math.max(Math.sqrt(power), pRef * 1e-9) / pRef);
            spec[bin * nFrames + frame] = spl;
        }
    }

    // Frequency vector
    const freq = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        freq[i] = i * fs / nfft;
    }

    // Time vector
    const time = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
        time[i] = (i * hopSize + nfft / 2) / fs;
    }

    return { freq, time, spec, nBins, nFrames };
}

function fftReal(signal, nfft) {
    const re = new Float32Array(signal);
    const im = new Float32Array(nfft).fill(0);

    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < nfft; i++) {
        let bit = nfft >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }

    // FFT butterfly
    for (let len = 2; len <= nfft; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        for (let i = 0; i < nfft; i += len) {
            let curRe = 1, curIm = 0;
            for (let k = 0; k < len / 2; k++) {
                const uRe = re[i + k];
                const uIm = im[i + k];
                const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
                const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
                re[i + k] = uRe + vRe;
                im[i + k] = uIm + vIm;
                re[i + k + len / 2] = uRe - vRe;
                im[i + k + len / 2] = uIm - vIm;
                const newRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = newRe;
            }
        }
    }

    return { re, im };
}