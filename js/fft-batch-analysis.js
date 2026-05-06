// fft-batch-analysis.js
// Batch FFT analysis for Sound and Vibration signals
// Ports SoundAnalysis.m and VibAnalysis.m functionality to JavaScript

class FFTBatchAnalyzer {
    constructor(type = 'sound', calibrationFactor = 1.0) {
        this.type = type;
        this.calibrationFactor = calibrationFactor;
        this.fs = 48000;
        
        // Initialize to a sensible default (exact, no power-of-2 rounding)
        this.currentDF = 2.0;
        this.currentNFFT = Math.round(this.fs / this.currentDF); // exact: 24000

        this.table = {};
        this.freqKeys = [];
        this.results = [];
        this.totalFiles = 0;
        this.processedFiles = 0;
    }
    
    /**
     * Set calibration factor
     */
    setCalibrationFactor(factor) {
        this.calibrationFactor = parseFloat(factor);
    }
    
    /**
     * Set frequency resolution (Hz) — stores EXACT nfft = round(fs/df).
     * No power-of-2 rounding: bin width = fs/nfft exactly.
     */
    setFrequencyResolution(dfHz) {
        dfHz = parseFloat(dfHz);
        if (!dfHz || dfHz <= 0) return;
        this.currentNFFT = Math.round(this.fs / dfHz);
        this.currentDF   = this.fs / this.currentNFFT;   // exact achieved bin width
    }
    
    /**
     * Set window size in samples — bin width = fs/nfft.
     */
    setWindowSize(nfftSize) {
        nfftSize = Math.round(parseInt(nfftSize));
        if (nfftSize < 2) return;
        this.currentNFFT = nfftSize;
        this.currentDF   = this.fs / this.currentNFFT;
    }
    
    /**
     * Load audio file as float signal
     */
    async loadAudioFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // Convert to mono if needed
        let signal;
        if (audioBuffer.numberOfChannels === 1) {
            signal = audioBuffer.getChannelData(0);
        } else {
            // Average all channels to mono
            const mono = new Float32Array(audioBuffer.length);
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < audioBuffer.length; i++) {
                    mono[i] += channelData[i] / audioBuffer.numberOfChannels;
                }
            }
            signal = mono;
        }
        
        // Update sample rate if different
        if (audioBuffer.sampleRate !== this.fs) {
            this.fs = audioBuffer.sampleRate;
            // Recompute the achieved bin width for the existing nfft
            this.currentDF = this.fs / this.currentNFFT;
        }
        
        return signal;
    }
    
    /**
     * Extract measurement name from file path using pattern
     */
    extractMeasurementName(filename) {
        // Pattern: \d+\s\d{4}-\d{2}-\d{2}\s\d{2}-\d{2}-\d{2}
        // Example: "1 2024-01-15 14-30-45"
        const pattern = /\d+\s\d{4}-\d{2}-\d{2}\s\d{2}-\d{2}-\d{2}/;
        const match = filename.match(pattern);
        
        if (match) {
            let measName = match[0];
            // Make compatible with table variable names
            return 'x' + measName.replace(/[\s-]/g, '_');
        } else {
            // Fallback: use filename without extension
            return 'x' + filename.replace(/[^a-zA-Z0-9]/g, '_');
        }
    }
    
    /**
     * Hann window function
     */
    hannWindow(n) {
        const win = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
        }
        return win;
    }
    
    /**
     * MATLAB-equivalent single-sided amplitude spectrum, averaged across blocks.
     *
     * Matches fftSPL.m exactly:
     *   acf  = nfft / sum(win)              % amplitude correction factor
     *   Axx  = acf * 2 * |X(k)| / nfft      % single-sided peak amplitude per bin
     *   Pmsq = Axx.^2 / 2                   % mean-square (rms^2) per bin
     *   block-averaged in linear power, returned as Pmsq (units: input^2)
     *
     * Caller converts to dB SPL via 10*log10(Pmsq / pRef^2).
     *
     * Window length = nfft, fixed 50% overlap, Hann window. Pre-pads the
     * signal to an integer multiple of nfft (matches MATLAB's zero-pad
     * before buffer(...,'nodelay')).
     */
    pwelch(signal, nfft, fs) {
        const hopSize = Math.round(nfft / 2);   // 50% overlap, matches MATLAB round(nfft*0.5)
        const win     = this.hannWindow(nfft);
        const sumWin  = win.reduce((a, b) => a + b, 0);
        const acf     = nfft / sumWin;          // amplitude correction (Hann ≈ 2.0)

        // Zero-pad to an integer multiple of nfft (MATLAB:
        //   p = [p; zeros(mod(-length(p), nfft), 1)] )
        const padLen = ((-signal.length) % nfft + nfft) % nfft;
        let padded;
        if (padLen === 0) {
            padded = signal;
        } else {
            padded = new Float64Array(signal.length + padLen);
            padded.set(signal);
        }

        const nBins = Math.floor(nfft / 2) + 1;
        const Pmsq  = new Float64Array(nBins);  // accumulated mean-square per bin
        let numBlocks = 0;

        for (let start = 0; start + nfft <= padded.length; start += hopSize) {
            // Apply Hann window to the block
            const block = new Float64Array(nfft);
            for (let i = 0; i < nfft; i++) {
                block[i] = padded[start + i] * win[i];
            }

            // DFT via Bluestein — handles any length
            const spec = this.computeDFT(block);

            // MATLAB normalisation, single-sided, per bin:
            //   Axx = acf * 2 * |X| / nfft   (peak amplitude)
            //   contribution = Axx^2 / 2     (mean-square)
            // Combined: contribution = (acf^2 * 2 * |X|^2) / nfft^2
            const scale = (acf * acf * 2) / (nfft * nfft);
            for (let k = 0; k < nBins; k++) {
                const re = spec.re[k];
                const im = spec.im[k];
                Pmsq[k] += (re * re + im * im) * scale;
            }
            numBlocks++;
        }

        if (numBlocks === 0) throw new Error('Signal too short for the requested window size.');

        // Average across blocks (linear power → matches MATLAB's
        // 10*log10(mean(10.^(spec/10),2)) which is mathematically the same)
        const f = new Float64Array(nBins);
        for (let i = 0; i < nBins; i++) {
            Pmsq[i] /= numBlocks;
            f[i]     = i * fs / nfft;
        }

        // Return under the same key name used by callers; values are now
        // mean-square per bin (input units squared), not PSD.
        return { Pxx: Pmsq, f };
    }

    /**
     * Bluestein's chirp-z algorithm: arbitrary-length DFT.
     * Returns { re, im } arrays of length n (full spectrum; caller takes first nBins).
     * Internally uses power-of-2 FFTs on padded arrays for efficiency.
     */
    computeDFT(x) {
        const n = x.length;

        // Bluestein chirp factors: w[k] = exp(-j*pi*k^2/n)
        const wRe = new Float64Array(n);
        const wIm = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const ang = Math.PI * k * k / n;
            wRe[k] =  Math.cos(ang);
            wIm[k] = -Math.sin(ang);
        }

        // Choose M = next power of 2 >= 2n-1
        let M = 1;
        while (M < 2 * n - 1) M <<= 1;

        // a[k] = x[k] * w[k]  (zero-padded to M)
        const aRe = new Float64Array(M);
        const aIm = new Float64Array(M);
        for (let k = 0; k < n; k++) {
            aRe[k] = x[k] * wRe[k];
            aIm[k] = x[k] * wIm[k];
        }

        // b[k] = conj(w[k]) for k=0..n-1, and b[M-k] = conj(w[k]) for k=1..n-1
        const bRe = new Float64Array(M);
        const bIm = new Float64Array(M);
        for (let k = 0; k < n; k++) {
            bRe[k]     =  wRe[k];
            bIm[k]     = -wIm[k];   // conj
            if (k > 0) {
                bRe[M - k] =  wRe[k];
                bIm[M - k] = -wIm[k];
            }
        }

        // Convolve: c = IFFT(FFT(a) * FFT(b))
        this._fftInPlace(aRe, aIm, false);
        this._fftInPlace(bRe, bIm, false);
        const cRe = new Float64Array(M);
        const cIm = new Float64Array(M);
        for (let k = 0; k < M; k++) {
            cRe[k] = aRe[k] * bRe[k] - aIm[k] * bIm[k];
            cIm[k] = aRe[k] * bIm[k] + aIm[k] * bRe[k];
        }
        this._fftInPlace(cRe, cIm, true);   // inverse

        // Multiply by chirp factor and scale
        const outRe = new Float64Array(n);
        const outIm = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            outRe[k] = (cRe[k] * wRe[k] - cIm[k] * wIm[k]) / M;
            outIm[k] = (cRe[k] * wIm[k] + cIm[k] * wRe[k]) / M;
        }

        return { re: outRe, im: outIm };
    }

    /**
     * In-place radix-2 Cooley-Tukey FFT (power-of-2 only, used internally by Bluestein).
     * inverse=true computes the unnormalised inverse (caller divides by M).
     */
    _fftInPlace(re, im, inverse) {
        const n = re.length;
        // Bit-reversal
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
        // Butterfly
        for (let len = 2; len <= n; len <<= 1) {
            const ang = (inverse ? 1 : -1) * 2 * Math.PI / len;
            const wRe0 = Math.cos(ang), wIm0 = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let curRe = 1, curIm = 0;
                for (let k = 0; k < len / 2; k++) {
                    const uRe = re[i + k], uIm = im[i + k];
                    const vRe = re[i + k + len/2] * curRe - im[i + k + len/2] * curIm;
                    const vIm = re[i + k + len/2] * curIm + im[i + k + len/2] * curRe;
                    re[i + k]         = uRe + vRe;
                    im[i + k]         = uIm + vIm;
                    re[i + k + len/2] = uRe - vRe;
                    im[i + k + len/2] = uIm - vIm;
                    const nRe = curRe * wRe0 - curIm * wIm0;
                    curIm = curRe * wIm0 + curIm * wRe0;
                    curRe = nRe;
                }
            }
        }
    }
    
    /**
     * Process a single audio file at the currently selected resolution
     */
    async processFile(file) {
        try {
            // Load audio
            const signal = await this.loadAudioFile(file);
            
            // Apply calibration
            const calibrated = new Float32Array(signal.length);
            for (let i = 0; i < signal.length; i++) {
                calibrated[i] = signal[i] * this.calibrationFactor;
            }
            
            // Use the full filename (minus extension) as the column header
            const measName = file.name.replace(/\.[^.]+$/, '');
            
            // Use the single user-chosen resolution
            const nfft = this.currentNFFT;
            // Pxx now holds mean-square (rms^2) per bin — MATLAB convention
            const { Pxx, f } = this.pwelch(calibrated, nfft, this.fs);

            // Calculate output spectrum
            let results;
            if (this.type === 'vibration') {
                // RMS amplitude per bin in engineering units
                results = new Float32Array(Pxx.length);
                for (let i = 0; i < Pxx.length; i++) {
                    results[i] = Math.sqrt(Pxx[i]);
                }
            } else {
                // dB SPL re 20 µPa, computed directly from mean-square:
                //   spec = 10*log10(Pmsq / pRef^2)
                // Equivalent to MATLAB's 20*log10(sqrt(Ppow)/20e-6).
                const pRef2 = 20e-6 * 20e-6;
                results = new Float32Array(Pxx.length);
                for (let i = 0; i < Pxx.length; i++) {
                    results[i] = 10 * Math.log10(Pxx[i] / pRef2 + 1e-30);
                }
            }
            
            // Initialise table on first file
            if (Object.keys(this.table).length === 0) {
                this.freqKeys = Array.from(f).map(freq => freq.toFixed(6));
                for (const key of this.freqKeys) {
                    this.table[key] = [];
                }
            }
            
            // Add this measurement column
            for (let i = 0; i < this.freqKeys.length; i++) {
                this.table[this.freqKeys[i]].push({ measurement: measName, value: results[i] });
            }
            
            this.processedFiles++;
            return true;
        } catch (error) {
            console.error(`Error processing file ${file.name}:`, error);
            return false;
        }
    }
    
    /**
     * Batch process multiple files
     */
    async processFiles(files, progressCallback) {
        this.totalFiles = files.length;
        this.processedFiles = 0;
        this.table = {};      // single table for chosen resolution
        this.freqKeys = [];
        
        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.wav')) {
                await this.processFile(file);
                if (progressCallback) {
                    progressCallback(this.processedFiles / this.totalFiles);
                }
            }
        }
    }
    
    /**
     * Generate a single CSV for the chosen frequency resolution
     */
    generateCSV() {
        const table = this.table;
        const df = this.currentDF;
        const filename = `Fourier_df_${df.toFixed(4)}_Hz.csv`;
        
        // Collect measurement names in insertion order
        const measurements = [];
        const seen = new Set();
        Object.values(table).forEach(col => {
            col.forEach(item => {
                if (!seen.has(item.measurement)) {
                    seen.add(item.measurement);
                    measurements.push(item.measurement);
                }
            });
        });
        
        // Header row: Frequency_Hz then one column per file
        let csv = 'Frequency_Hz,' + measurements.join(',') + '\n';
        
        // Data rows
        const freqKeys = Object.keys(table).map(k => parseFloat(k)).sort((a, b) => a - b);
        for (const freq of freqKeys) {
            const freqStr = freq.toFixed(6);
            let row = freqStr;
            for (const meas of measurements) {
                const match = table[freqStr].find(item => item.measurement === meas);
                row += match ? ',' + match.value.toFixed(6) : ',';
            }
            csv += row + '\n';
        }
        
        return [{ filename, content: csv }];
    }
    
    
    /**
     * Download CSV files as ZIP
     */
    downloadResults() {
        const csvFiles = this.generateCSV();
        
        // Create a simple multi-file download
        for (const { filename, content } of csvFiles) {
            const blob = new Blob([content], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }
    
    /**
     * Get analysis summary
     */
    getSummary() {
        return {
            type: this.type,
            filesProcessed: this.processedFiles,
            calibrationFactor: this.calibrationFactor,
            sampleRate: this.fs,
            df_Hz: this.currentDF,
            nfft: this.currentNFFT
        };
    }
}