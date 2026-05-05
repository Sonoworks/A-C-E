// fftSPL.js
// Port of fftSPL.m by Matt Torjussen (matt@sonoworks.co.uk)
// Computes power spectrum from audio signal and returns
// frequency vector and SPL spectrum in dB re 20uPa

function hannWindow(n) {
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return win;
}

function fftSPL(signal, fs, nfft = 4096, useWindow = true, overlap = 0.5) {

    // Step 1: Buffer signal into overlapping blocks
    const hopSize = Math.round(nfft * (1 - overlap));
    const blocks = [];
    for (let start = 0; start + nfft <= signal.length; start += hopSize) {
        blocks.push(signal.slice(start, start + nfft));
    }

    if (blocks.length === 0) {
        throw new Error('Signal is too short for the given nfft size.');
    }

    // Step 2: Apply Hann window if requested
    const win = useWindow ? hannWindow(nfft) : null;
    const acf = useWindow
        ? nfft / win.reduce((a, b) => a + b, 0)
        : 1;

    // Step 3: FFT each block using Web Audio AnalyserNode approach
    // We use a pure JS FFT implementation here
    const specBlocks = blocks.map(block => {
        const windowed = new Float32Array(nfft);
        for (let i = 0; i < nfft; i++) {
            windowed[i] = block[i] * (win ? win[i] : 1);
        }
        return computeFFT(windowed, nfft, acf);
    });

    // Step 4: Average across blocks (in power, then convert to dB)
    const nBins = nfft / 2 + 1;
    const avgPower = new Float32Array(nBins).fill(0);

    for (const spec of specBlocks) {
        for (let i = 0; i < nBins; i++) {
            avgPower[i] += spec[i];
        }
    }

    for (let i = 0; i < nBins; i++) {
        avgPower[i] /= specBlocks.length;
    }

    // Step 5: Convert to SPL in dB re 20uPa
    const pRef = 20e-6;
    const spl = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        spl[i] = 10 * Math.log10(avgPower[i] / (pRef * pRef) + 1e-30);
    }

    // Step 6: Frequency vector
    const freq = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        freq[i] = i * fs / nfft;
    }

    return { freq, spl };
}

function computeFFT(signal, nfft, acf) {
    // Cooley-Tukey FFT (radix-2, in-place)
    const n = nfft;
    const re = new Float32Array(signal);
    const im = new Float32Array(n).fill(0);

    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }

    // FFT butterfly operations
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
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

    // One-sided power spectrum (nfft/2 + 1 bins)
    const nBins = nfft / 2 + 1;
    const power = new Float32Array(nBins);
    for (let i = 0; i < nBins; i++) {
        const mag = acf * 2 * Math.sqrt(re[i] ** 2 + im[i] ** 2) / nfft;
        power[i] = (mag ** 2) / 2;
    }
    return power;
}