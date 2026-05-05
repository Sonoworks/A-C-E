// freqWeight.js
// A- and C-weighting filters for AuralisationLite / Sonoworks.
//
// JavaScript port of freqWeight.m (Matt Torjussen, 2026).
// Implements the design-goal frequency weightings of BS EN 61672-1:2013
// Annex E. Filter coefficients are pre-computed in MATLAB via the bilinear
// transform with frequency pre-warping at 1 kHz, and tabulated below for
// each supported sample rate. This guarantees bit-for-bit equivalence with
// the MATLAB reference at the supported rates.
//
// Usage:
//   const pA = freqWeight(p, 48000, 'A');   // A-weighted time signal
//   const pC = freqWeight(p, 48000, 'C');   // C-weighted time signal
//   const pZ = freqWeight(p, 48000, 'Z');   // pass-through (no weighting)
//
// Author: Matt Torjussen <matt@sonoworks.co.uk>
// Licence: MIT

(function (root) {
    'use strict';

    // ------------------------------------------------------------------
    // Coefficient tables
    // ------------------------------------------------------------------
    // Each entry holds the IIR transfer-function coefficients
    //     H(z) = ( b[0] + b[1] z^-1 + ... ) / ( a[0] + a[1] z^-1 + ... )
    // for the corresponding sample rate. Generated in MATLAB by
    // bilinear-transforming the analogue prototype of BS EN 61672-1:2013
    // Annex E with pre-warping at 1 kHz. See freqWeight.m for the
    // analogue prototype and normalisation. Values printed at full
    // Float64 precision (%.17g) so JS round-trips exactly to MATLAB.
    // ------------------------------------------------------------------
    var COEFFS = {
        A: {
            12000: {
                b: [0.59235211225347129, -1.1847042245069426, -0.59235211225347129,
                    2.3694084490138851, -0.59235211225347129, -1.1847042245069426,
                    0.59235211225347129],
                a: [1, -2.5291558837480923, 1.2679844353858225, 1.2602791380905076,
                    -1.0322157956547136, -0.1414949841615965, 0.17460832222501324]
            },
            24000: {
                b: [0.4272414789664965, -0.854482957932993, -0.4272414789664965,
                    1.708965915865986, -0.4272414789664965, -0.854482957932993,
                    0.4272414789664965],
                a: [1, -3.3194248287072852, 3.6550478095459686, -1.0803322623061902,
                    -0.48396521307650486, 0.18595090285983357, 0.042723811611492184]
            },
            48000: {
                b: [0.23465454883464512, -0.46930909766929024, -0.23465454883464512,
                    0.93861819533858049, -0.23465454883464512, -0.46930909766929024,
                    0.23465454883464512],
                a: [1, -4.1114787166953359, 6.5469866908941654, -4.9816832745297832,
                    1.7794092203638079, -0.2443156669627129, 0.011081754350404083]
            }
        },
        C: {
            12000: {
                b: [0.58397455090901074, 0, -1.1679491018180215, 0, 0.58397455090901074],
                a: [1, -0.91537542564835839, -0.84152341827261012, 0.48103045474226103,
                    0.276151017620895]
            },
            24000: {
                b: [0.38032972057734893, 0, -0.76065944115469786, 0, 0.38032972057734893],
                a: [1, -1.5244551114886136, 0.11877803326998443, 0.3523113430418548,
                    0.053410171233028637]
            },
            48000: {
                b: [0.19820115149492729, 0, -0.39640230298985457, 0, 0.19820115149492729],
                a: [1, -2.2177538040855058, 1.4521532823592662, -0.24677534113750724,
                    0.012381602468368783]
            }
        }
    };

    // ------------------------------------------------------------------
    // IIR filter (Direct Form II Transposed)
    // ------------------------------------------------------------------
    // Equivalent to MATLAB's filter(b, a, x) for real coefficients.
    // Operates in-place-free: returns a new Float64Array of the same
    // length as x. Assumes a[0] === 1 (true for all tabulated sets);
    // if a[0] !== 1 the coefficients are normalised on the fly.
    function iirFilter(b, a, x) {
        var nb = b.length;
        var na = a.length;
        var n  = x.length;
        var y  = new Float64Array(n);

        // Normalise so a[0] = 1 (no-op for our tables, but cheap and safe).
        var a0 = a[0];
        var bn, an;
        if (a0 !== 1) {
            bn = new Float64Array(nb);
            an = new Float64Array(na);
            for (var i = 0; i < nb; i++) bn[i] = b[i] / a0;
            for (var j = 0; j < na; j++) an[j] = a[j] / a0;
        } else {
            bn = b;
            an = a;
        }

        // State buffer for transposed Direct Form II.
        var nz = Math.max(nb, na) - 1;
        var z  = new Float64Array(nz);

        for (var k = 0; k < n; k++) {
            var xk = x[k];
            var yk = bn[0] * xk + (nz > 0 ? z[0] : 0);
            y[k] = yk;
            for (var m = 0; m < nz - 1; m++) {
                var bm = m + 1 < nb ? bn[m + 1] : 0;
                var am = m + 1 < na ? an[m + 1] : 0;
                z[m] = bm * xk - am * yk + z[m + 1];
            }
            if (nz > 0) {
                var bL = nz < nb ? bn[nz] : 0;
                var aL = nz < na ? an[nz] : 0;
                z[nz - 1] = bL * xk - aL * yk;
            }
        }
        return y;
    }

    // ------------------------------------------------------------------
    // Public entry point
    // ------------------------------------------------------------------
    function freqWeight(signal, fs, filterType) {
        if (!signal || typeof signal.length !== 'number' || signal.length === 0) {
            throw new Error('freqWeight: signal must be a non-empty array.');
        }
        if (typeof fs !== 'number' || !isFinite(fs) || fs <= 0) {
            throw new Error('freqWeight: fs must be a positive number.');
        }
        if (typeof filterType !== 'string' || filterType.length === 0) {
            throw new Error('freqWeight: filterType must be "A", "C", or "Z".');
        }

        var ft = filterType.toUpperCase();

        // Z-weighting: flat response, no filtering. Return a copy so callers
        // can safely mutate the result without affecting the input.
        if (ft === 'Z') {
            var out = new Float64Array(signal.length);
            for (var i = 0; i < signal.length; i++) out[i] = signal[i];
            return out;
        }

        if (ft !== 'A' && ft !== 'C') {
            throw new Error('freqWeight: filterType must be "A", "C", or "Z"; received "' + filterType + '".');
        }

        var table = COEFFS[ft];
        var key = String(Math.round(fs));
        if (!table[key]) {
            var supported = Object.keys(table).sort(function (a, b) {
                return Number(a) - Number(b);
            });
            throw new Error(
                'freqWeight: no ' + ft + '-weighting coefficients tabulated for fs = ' +
                fs + ' Hz. Supported rates: ' + supported.join(', ') + ' Hz. ' +
                'Generate new coefficients in MATLAB and add them to COEFFS.'
            );
        }

        var c = table[key];
        return iirFilter(c.b, c.a, signal);
    }

    // Expose supported sample rates so the UI can validate / disable
    // weighting options when a recording's fs is outside the table.
    freqWeight.supportedSampleRates = function (filterType) {
        var ft = (filterType || 'A').toUpperCase();
        if (ft === 'Z') return null; // any rate
        var table = COEFFS[ft];
        if (!table) return [];
        return Object.keys(table).map(Number).sort(function (a, b) { return a - b; });
    };

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------
    root.freqWeight = freqWeight;

    // Back-compat shim: the old aWeight() call site keeps working.
    if (!root.aWeight) {
        root.aWeight = function (signal, fs) {
            return freqWeight(signal, fs, 'A');
        };
    }

})(typeof window !== 'undefined' ? window : this);