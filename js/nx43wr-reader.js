// nx43wr-reader.js
// Reads NX-43WR WAV files and extracts calibration data from Rion RIFF chunk

class NX43WRReader {
    constructor() {
        this.audioData = null;
        this.sampleRate = null;
        this.metadata = {};
        this.audioBuffer = null;
    }

    // Main entry point - read WAV file and extract calibration
    async readWAVFile(file) {
        try {
            console.log('Reading WAV file:', file.name);

            // Read file as ArrayBuffer
            const arrayBuffer = await this.fileToArrayBuffer(file);

            // Parse RIFF/WAVE structure and extract Rion chunk
            this.parseRiffWave(arrayBuffer);

            // Decode audio using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            this.sampleRate = this.audioBuffer.sampleRate;

            console.log('File read successfully:', {
                duration: this.audioBuffer.duration,
                channels: this.audioBuffer.numberOfChannels,
                sampleRate: this.sampleRate,
                metadata: this.metadata
            });

            return {
                success: true,
                metadata: this.metadata,
                audioBuffer: this.audioBuffer,
                sampleRate: this.sampleRate,
                duration: this.audioBuffer.duration,
                channels: this.audioBuffer.numberOfChannels
            };

        } catch (error) {
            console.error('Error reading WAV file:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Parse RIFF/WAVE structure and find Rion chunk
    parseRiffWave(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let offset = 0;

        // RIFF header
        const riffID = this.readString(view, offset, 4);
        offset += 4;
        if (riffID !== 'RIFF') {
            throw new Error('Not a RIFF file');
        }

        const fileSize = view.getUint32(offset, true);
        offset += 4;

        const waveID = this.readString(view, offset, 4);
        offset += 4;
        if (waveID !== 'WAVE') {
            throw new Error('Not a WAVE file');
        }

        // Walk through chunks looking for "fmt " (for bit depth) and "rion"
        let foundRion = false;
        while (offset < arrayBuffer.byteLength - 8) {
            const chunkID = this.readString(view, offset, 4);
            offset += 4;

            const chunkSize = view.getUint32(offset, true);
            offset += 4;

            if (chunkID === 'fmt ') {
                // bitsPerSample is at offset +14 within fmt chunk payload
                if (chunkSize >= 16) {
                    this.metadata.nBits = view.getUint16(offset + 14, true);
                    console.log('Bit depth:', this.metadata.nBits);
                }
            } else if (chunkID === 'rion') {
                console.log('Found Rion chunk, size:', chunkSize);
                this.parseRionChunk(view, offset, chunkSize);
                foundRion = true;
            }

            // Skip to next chunk (pad to even boundary per RIFF spec)
            offset += chunkSize + (chunkSize % 2);
        }

        if (!foundRion) {
            console.warn('No Rion calibration chunk found - will use default scaling');
        }
    }

    // Parse the proprietary Rion calibration chunk
    parseRionChunk(view, offset, chunkSize) {
        try {
            // Pa-per-count scaling factor at offset 0x24 (36 decimal)
            const scaleFactor = view.getFloat64(offset + 36, true);
            if (!isFinite(scaleFactor) || scaleFactor <= 0) {
                throw new Error('Invalid scale factor: ' + scaleFactor);
            }
            this.metadata.scaleFactor = scaleFactor;
            console.log('Scale factor (Pa/count):', scaleFactor);

            // Reference units at offset 0x64 (100 decimal) - 16 bytes, space-padded
            if (chunkSize >= 116) {
                const unitsBytes = new Uint8Array(view.buffer, offset + 100, 16);
                const unitsStr = this.bytesToString(unitsBytes).trim();
                if (unitsStr) {
                    this.metadata.referenceUnits = unitsStr;
                    console.log('Reference units:', unitsStr);
                }
            }

            // Full scale range at offset 0x84 (132 decimal) - 16 bytes
            if (chunkSize >= 148) {
                const rangeBytes = new Uint8Array(view.buffer, offset + 132, 16);
                const rangeStr = this.bytesToString(rangeBytes).trim();
                if (rangeStr) {
                    this.metadata.fullScaleRange = rangeStr;
                    console.log('Full scale range:', rangeStr);
                }
            }

            // Date-time string at offset 0xEF (239 decimal) - 14 bytes: YYYYMMDD HHMMSS
            if (chunkSize >= 253) {
                const dateBytes = new Uint8Array(view.buffer, offset + 239, 14);
                const dateStr = this.bytesToString(dateBytes).trim();
                if (dateStr && dateStr.length >= 14) {
                    this.metadata.recordingDateStr = dateStr;
                    this.metadata.recordingTime = this.parseRionDateTime(dateStr);
                    console.log('Recording time:', this.metadata.recordingTime);
                }
            }

        } catch (error) {
            console.error('Error parsing Rion chunk:', error);
            throw error;
        }
    }

    // Parse Rion datetime format: "YYYYMMDD HHMMSS"
    parseRionDateTime(dateStr) {
        try {
            const year = parseInt(dateStr.substring(0, 4));
            const month = parseInt(dateStr.substring(4, 6));
            const day = parseInt(dateStr.substring(6, 8));
            const hour = parseInt(dateStr.substring(9, 11));
            const minute = parseInt(dateStr.substring(11, 13));
            const second = parseInt(dateStr.substring(13, 15));

            const date = new Date(year, month - 1, day, hour, minute, second);
            return date.toLocaleString();
        } catch (error) {
            console.warn('Could not parse date:', dateStr);
            return dateStr;
        }
    }

    // Helper: Read string from DataView
    readString(view, offset, length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(view.getUint8(offset + i));
        }
        return str;
    }

    // Helper: Convert Uint8Array to string
    bytesToString(bytes) {
        let str = '';
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0) break;
            str += String.fromCharCode(bytes[i]);
        }
        return str;
    }

    // Helper: Read file as ArrayBuffer
    fileToArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsArrayBuffer(file);
        });
    }

    // Get audio data for a specific channel
    getChannelData(channelIndex = 0) {
        if (!this.audioBuffer) return null;
        if (channelIndex >= this.audioBuffer.numberOfChannels) {
            console.warn('Channel index out of range, using channel 0');
            channelIndex = 0;
        }
        return this.audioBuffer.getChannelData(channelIndex);
    }

    // Convert normalized audio to Pascals using calibration factor
    getAudioInPascals(channelIndex = 0) {
        const rawData = this.getChannelData(channelIndex);
        if (!rawData) return null;

        // Scale factor: Pa per raw integer count
        // audioread gives us [-1, 1] normalized, which represents [-2^(n-1), 2^(n-1)-1] raw counts
        // Undo the normalization and apply Rion's Pa scaling
        const scaleFactor = this.metadata.scaleFactor || 1.0;
        const nbits = 24; // NX-43WR typically 24-bit

        const pascalData = new Float32Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            // Undo normalization: multiply by 2^(nbits-1)
            const rawCount = rawData[i] * Math.pow(2, nbits - 1);
            // Apply Rion calibration
            pascalData[i] = rawCount * scaleFactor;
        }

        return pascalData;
    }

    // Compute RMS sound pressure level in dB SPL
    computeLp(channelIndex = 0) {
        const pascalData = this.getAudioInPascals(channelIndex);
        if (!pascalData) return null;

        // Compute RMS
        let sumSquares = 0;
        for (let i = 0; i < pascalData.length; i++) {
            sumSquares += pascalData[i] * pascalData[i];
        }
        const rms = Math.sqrt(sumSquares / pascalData.length);

        // Convert to dB SPL (reference: 20e-6 Pa)
        const pRef = 20e-6;
        const lp = 20 * Math.log10(rms / pRef);

        return {
            rms: rms,
            lp: lp
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NX43WRReader;
}