// nl53-loader.js
// Loads and parses NL-53 Auto Store folder structure
// Handles both SLM (broadband) and OCT (octave band) data formats
// RND files are CSV (comma-separated values) text, not binary

class NL53Loader {
    constructor() {
        this.data = null;
        this.dataType = null; // 'SLM' or 'OCT'
        this.folderName = '';
        this.files = [];
        this.measurements = [];
        this.header = null;
        this.bandLabels = [];
    }

    // Main entry point - processes dropped/selected files
    async loadFromFileList(fileList) {
        try {
            this.files = Array.from(fileList);
            
            if (this.files.length === 0) {
                throw new Error('No files selected');
            }

            // Determine folder structure
            const folderPath = this.extractFolderPath(this.files[0].webkitRelativePath);
            this.folderName = folderPath.split('/').pop();

            // Check for Auto_Leq and Auto_Lp folders
            const hasLeq = this.files.some(f => f.webkitRelativePath.includes('Auto_Leq'));
            const hasLp = this.files.some(f => f.webkitRelativePath.includes('Auto_Lp'));

            if (!hasLeq && !hasLp) {
                throw new Error('No Auto_Leq or Auto_Lp folders found. Please upload an Auto_XXXX folder from the NL-53 SD card.');
            }

            // Identify data type by checking filenames
            const rndFiles = this.files.filter(f => f.name.endsWith('.rnd'));
            if (rndFiles.length === 0) {
                throw new Error('No RND data files found');
            }

            const firstRndFile = rndFiles[0];
            if (firstRndFile.name.includes('_SLM_')) {
                this.dataType = 'SLM';
            } else if (firstRndFile.name.includes('_OCT_')) {
                this.dataType = 'OCT';
            } else {
                throw new Error('Unable to determine data type (SLM or OCT)');
            }

            // Load .rnh header file first
            const rnhFile = this.files.find(f => f.name.endsWith('.rnh'));
            if (rnhFile) {
                await this.parseRNHFile(rnhFile);
            }

            // Load .rnd data files (CSV text format)
            await this.parseRNDFiles(rndFiles);

            return {
                success: true,
                dataType: this.dataType,
                folderName: this.folderName,
                fileCount: rndFiles.length,
                measurementCount: this.measurements.length,
                measurements: this.measurements,
                bandLabels: this.bandLabels
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Extract folder path from webkitRelativePath
    extractFolderPath(relativePath) {
        const parts = relativePath.split('/');
        return parts.slice(0, -1).join('/');
    }

    // Parse .rnh header file to extract column structure
    async parseRNHFile(file) {
        try {
            const text = await this.readFileAsText(file);
            this.header = this.parseINIFormat(text);
            console.log('RNH header loaded:', file.name);
        } catch (error) {
            console.warn('Could not parse RNH file:', error.message);
        }
    }

    // Parse INI-format RNH file
    parseINIFormat(text) {
        const header = {};
        const lines = text.split('\n');
        let currentSection = null;

        for (const line of lines) {
            const trimmed = line.trim();
            
            // Skip empty lines and CSV magic line
            if (!trimmed || trimmed === 'CSV') continue;

            // Section header [SectionName]
            const sectionMatch = trimmed.match(/^\[(.+)\]$/);
            if (sectionMatch) {
                currentSection = sectionMatch[1];
                header[currentSection] = {};
                continue;
            }

            // Key,Value pairs
            const commaIdx = trimmed.indexOf(',');
            if (commaIdx > -1) {
                const key = trimmed.substring(0, commaIdx).trim();
                const value = trimmed.substring(commaIdx + 1).trim();
                
                if (currentSection) {
                    header[currentSection][key] = value;
                } else {
                    header[key] = value;
                }
            }
        }

        return header;
    }

    // Parse .rnd data files (CSV text format)
    async parseRNDFiles(rndFiles) {
        for (const file of rndFiles) {
            try {
                const text = await this.readFileAsText(file);
                const data = this.parseCSVData(text, file.name);
                
                if (data && data.length > 0) {
                    this.measurements.push(...data);
                }
            } catch (error) {
                console.warn('Error parsing RND file:', file.name, error.message);
            }
        }

        // Sort measurements by index
        this.measurements.sort((a, b) => a.index - b.index);
    }

    // Parse CSV data from RND file
    parseCSVData(text, fileName) {
        const measurements = [];
        const lines = text.split('\n');

        if (lines.length < 2) return measurements;

        // Skip CSV magic line if present
        let startLine = 0;
        if (lines[0].trim() === 'CSV') startLine = 1;

        // First data line is the header
        const headerLine = lines[startLine];
        if (!headerLine) return measurements;

        const headers = headerLine.split(',').map(h => h.trim());
        
        console.log(`[${fileName}] Headers found (${headers.length}):`, headers.slice(0, 10));
        
        // Extract band labels from headers for OCT data
        if (this.dataType === 'OCT') {
            this.bandLabels = headers.filter(h => 
                h.match(/^[\d.]+\s*k?Hz$/i) || 
                h.match(/POA|Overall/i)
            );
            console.log(`[${fileName}] Band labels extracted (${this.bandLabels.length}):`, this.bandLabels.slice(0, 5));
        }

        // Parse data rows
        let index = 0;
        for (let i = startLine + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const values = line.split(',').map(v => v.trim());
            
            if (values.length < headers.length) continue;

            try {
                const measurement = this.parseRow(values, headers, index);
                if (measurement) {
                    measurements.push(measurement);
                    
                    // Log first measurement for debugging
                    if (index === 0) {
                        console.log(`[${fileName}] First measurement:`, measurement);
                        console.log(`[${fileName}] First measurement bands count:`, Object.keys(measurement.bands).length);
                    }
                    index++;
                }
            } catch (error) {
                console.warn('Error parsing row:', i, error.message);
            }
        }

        console.log(`[${fileName}] Parsed ${measurements.length} measurements`);
        return measurements;
    }

    // Parse a single row of CSV data
    parseRow(values, headers, index) {
        const measurement = {
            index: index,
            timestamp: index,
            source: '',
            bands: {}
        };

        // Map headers to values
        for (let i = 0; i < headers.length && i < values.length; i++) {
            const header = headers[i];
            const headerLower = header.toLowerCase().trim();
            const value = this.parseNumeric(values[i]);

            // Broadband (SLM) columns - match various naming conventions
            if (headerLower.includes('leq')) {
                measurement.leq = value;
            } else if ((headerLower.includes('lp') || headerLower.startsWith('lp')) && 
                       !headerLower.includes('lp_') && 
                       !headerLower.includes('lpeak')) {
                measurement.lp = value;
            } else if (headerLower.includes('lmax')) {
                measurement.lmax = value;
            } else if (headerLower.includes('lmin')) {
                measurement.lmin = value;
            } else if (headerLower.includes('lpeak')) {
                measurement.lpeak = value;
            } else if (headerLower.includes('datetime') || headerLower.includes('date/time') || headerLower === 'date') {
                measurement.timestamp = this.parseDateTime(values[i]);
            }
            // Octave band data - match frequency patterns like "12.5Hz", "1kHz", "1.6kHz", etc.
            else if (header.match(/^[\d.]+\s*k?Hz$/i)) {
                // Store with original header case for display
                measurement.bands[header] = value;
                if (index === 0) {
                    console.log(`  Band found: "${header}" = ${value}`);
                }
            } else if (headerLower.includes('poa') || headerLower.includes('overall')) {
                // Overall/POA column
                measurement.bands['Overall'] = value;
            }
        }

        // Ensure we have at least one meaningful value
        const hasBands = Object.keys(measurement.bands).length > 0;
        const hasLeq = !isNaN(measurement.leq);
        const hasLp = !isNaN(measurement.lp);

        if (!hasLeq && !hasLp && !hasBands) {
            return null;
        }

        // For SLM data: compute lmax/lmin as fallback if not present
        if (this.dataType === 'SLM') {
            if (isNaN(measurement.lmax) && !isNaN(measurement.leq)) {
                measurement.lmax = measurement.leq;
            }
            if (isNaN(measurement.lmin) && !isNaN(measurement.leq)) {
                measurement.lmin = measurement.leq;
            }
        }

        // For OCT data: compute overall level from bands
        if (this.dataType === 'OCT' && hasBands) {
            const bandValues = Object.values(measurement.bands).filter(v => !isNaN(v));
            if (bandValues.length > 0) {
                measurement.leq = Math.max(...bandValues);
                measurement.lmax = Math.max(...bandValues);
                measurement.lmin = Math.min(...bandValues);
            }
        }

        return measurement;
    }

    // Parse numeric values, handling Rion format ("-", "-.-", empty)
    parseNumeric(str) {
        if (!str || str === '-' || str === '-.-') return NaN;
        const num = parseFloat(str);
        return isNaN(num) ? NaN : num;
    }

    // Parse datetime strings
    parseDateTime(str) {
        try {
            const date = new Date(str);
            return date.getTime();
        } catch (error) {
            return NaN;
        }
    }

    // Helper: Read file as text
    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }

    // Get summary info
    getSummary() {
        return {
            dataType: this.dataType,
            folderName: this.folderName,
            fileCount: this.files.length,
            measurementCount: this.measurements.length,
            measurements: this.measurements,
            bandLabels: this.bandLabels
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NL53Loader;
}