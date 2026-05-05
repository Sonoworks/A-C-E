// nx43wr-print.js
// Generates a scientific-style PDF report of whichever analysis tab is
// currently active. Plots are re-rendered in print form (white background,
// black axes/labels, red data lines, hot colourmap for the spectrogram)
// rather than captured from the screen — the on-screen plots use a dark
// theme that wouldn't print well.
//
// The module is otherwise self-contained: it reads the cached signal and
// control values from the analysis module's globals, runs the same DSP
// functions (timeWeight, octFilt, fftSPL, sonogramSPL), and lays the
// results out using jsPDF.

(function () {

    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('printPdfBtn');
        if (!btn) return;
        btn.addEventListener('click', onPrintClicked);
    });

    async function onPrintClicked() {
        if (!cachedSignalPa) {
            alert('Load a WAV file first.');
            return;
        }

        // Show the loading overlay (defined in the analysis module's HTML)
        // because the off-screen renders + PDF assembly take a few seconds.
        const overlayLabel = document.getElementById('overlayLabel');
        const overlay = document.getElementById('chartOverlay');
        if (overlay) {
            if (overlayLabel) overlayLabel.textContent = 'Generating PDF...';
            overlay.style.display = 'flex';
        }

        // Yield to the browser so the overlay actually paints
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

            switch (currentTab) {
                case 'timehistory': await pdfTimeHistory(doc); break;
                case 'octave':      await pdfOctave(doc);      break;
                case 'fft':         await pdfFFT(doc);         break;
                case 'spectrogram': await pdfSpectrogram(doc); break;
                case 'bs4142':      await pdfBs4142(doc);      break;
                default:
                    alert('Unknown tab: ' + currentTab);
                    return;
            }

            const filename = makeFilename(currentTab);
            doc.save(filename);
        } catch (e) {
            console.error('PDF generation failed:', e);
            alert('PDF generation failed: ' + e.message);
        } finally {
            if (overlay) overlay.style.display = 'none';
        }
    }

    function makeFilename(tab) {
        const base = (cachedFileName || 'sonoworks').replace(/\.wav$/i, '');
        const tabLabel = {
            timehistory: 'LevelVsTime',
            octave:      'OctaveBands',
            fft:         'FFTSpectrum',
            spectrogram: 'Spectrogram',
            bs4142:      'BS4142'
        }[tab] || 'Report';
        return base + '_' + tabLabel + '.pdf';
    }

    // -----------------------------------------------------------------------
    //  Page header / footer common to every report
    // -----------------------------------------------------------------------
    function drawHeader(doc, title) {
        const pageW = doc.internal.pageSize.getWidth();

        // Title strip
        doc.setFillColor(204, 0, 0);   // Sonoworks red
        doc.rect(0, 0, pageW, 14, 'F');
        doc.setTextColor(255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('Sonoworks  |  NX-43WR Waveform Analysis', 15, 9);

        // Tab title
        doc.setTextColor(0);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text(title, 15, 22);

        // Metadata block
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        const meta = collectMetadata();
        let y = 28;
        meta.forEach(([k, v]) => {
            doc.setFont('helvetica', 'bold');
            doc.text(k + ':', 15, y);
            doc.setFont('helvetica', 'normal');
            doc.text(String(v), 45, y);
            y += 4.5;
        });

        // Settings used for this view
        const settings = collectSettings();
        if (settings.length > 0) {
            y += 1;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9);
            doc.text('Settings:', 15, y);
            doc.setFont('helvetica', 'normal');
            doc.text(settings.join('   |   '), 45, y);
            y += 4.5;
        }

        return y + 2;   // y position where plot content can begin
    }

    function drawFooter(doc) {
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        doc.setDrawColor(150);
        doc.setLineWidth(0.2);
        doc.line(15, pageH - 12, pageW - 15, pageH - 12);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100);
        const stamp = new Date().toLocaleString();
        doc.text('Generated ' + stamp, 15, pageH - 7);
        doc.text('Page 1 of 1', pageW - 15, pageH - 7, { align: 'right' });
    }

    function collectMetadata() {
        const m = (reader && reader.metadata) ? reader.metadata : {};
        const rows = [
            ['File', cachedFileName || '—'],
            ['Sample rate', (cachedFs / 1000).toFixed(1) + ' kHz'],
            ['Duration', cachedDuration.toFixed(2) + ' s']
        ];
        if (m.scaleFactor) {
            rows.push(['Calibration', m.scaleFactor.toExponential(3) + ' Pa/count']);
        }
        if (m.fullScaleRange) rows.push(['Full scale range', m.fullScaleRange]);
        if (m.recordingTime)  rows.push(['Recorded',         m.recordingTime]);
        return rows;
    }

    function collectSettings() {
        const settings = [];
        const fw = getFreqWeight();
        settings.push('Freq. wt: ' + (fw === 'A' ? 'A' : fw === 'C' ? 'C' : 'Z'));

        if (currentTab === 'timehistory' || currentTab === 'bs4142') {
            const tw = document.querySelector('input[name="timeWeight"]:checked');
            if (tw) settings.push('Time wt: ' + tw.value);
        }
        if (currentTab === 'octave') {
            const bt = document.querySelector('input[name="bandType"]:checked');
            if (bt) settings.push('Bands: ' + (bt.value === 'whole' ? '1/1 octave' : '1/3 octave'));
        }
        if (currentTab === 'fft' || currentTab === 'spectrogram' || currentTab === 'bs4142') {
            settings.push('FFT size: ' + getFftSize());
            settings.push('Window: ' + (getUseWindow() ? 'Hann' : 'None'));
        }
        return settings;
    }

    // -----------------------------------------------------------------------
    //  Off-screen Chart.js renderer
    //
    //  Builds a Chart.js chart on a hidden canvas at high resolution, waits
    //  one frame for it to render, then returns a PNG data URL ready to drop
    //  into the PDF via doc.addImage().
    // -----------------------------------------------------------------------
    async function renderChartToPng(config, widthPx, heightPx) {
        const host = document.createElement('div');
        host.style.position = 'absolute';
        host.style.left = '-99999px';
        host.style.top = '0';
        host.style.width = widthPx + 'px';
        host.style.height = heightPx + 'px';
        host.style.background = '#ffffff';
        document.body.appendChild(host);

        const canvas = document.createElement('canvas');
        canvas.width = widthPx;
        canvas.height = heightPx;
        canvas.style.width = widthPx + 'px';
        canvas.style.height = heightPx + 'px';
        host.appendChild(canvas);

        // Force animation off so toDataURL captures the final state immediately
        if (!config.options) config.options = {};
        config.options.animation = false;
        config.options.responsive = false;
        config.options.maintainAspectRatio = false;

        const chart = new Chart(canvas.getContext('2d'), config);
        // Wait for one paint before reading pixels
        await new Promise((r) => requestAnimationFrame(r));

        const png = canvas.toDataURL('image/png');
        chart.destroy();
        document.body.removeChild(host);
        return png;
    }

    // -----------------------------------------------------------------------
    //  Print colour scheme: a single function returns the chart options
    //  shared by every printed plot. Black axes, gridlines, labels.
    // -----------------------------------------------------------------------
    function printChartScales(xOpts, yOpts) {
        const axis = (opts) => Object.assign({
            grid:   { color: 'rgba(0, 0, 0, 0.10)', drawBorder: true, borderColor: '#000' },
            ticks:  { color: '#000', font: { size: 10 } },
            title:  { color: '#000', font: { size: 11, weight: 'bold' }, display: true }
        }, opts);
        return { x: axis(xOpts), y: axis(yOpts) };
    }

    // -----------------------------------------------------------------------
    //  Tab 1: Level vs. Time
    // -----------------------------------------------------------------------
    async function pdfTimeHistory(doc) {
        const tau = getTimeWeightTau();
        const fw = getFreqWeight();

        const { signal: weightedSignal, fs: weightedFs } =
            await applyFreqWeight(cachedSignalPa, cachedFs);

        const weighted = timeWeight(weightedSignal, weightedFs, tau);
        const spl = signalToSPL(weighted);
        const { times, decimated } = decimateSignal(spl, weightedFs);

        const data = times.map((t, i) => ({ x: t, y: decimated[i] }));
        const ylabel = fw === 'A' ? 'LA (dBA)' :
                       fw === 'C' ? 'LC (dBC)' :
                                    'LZ (dB re 20 µPa)';

        const xRange = readRange('xMinTime', 'xMaxTime');
        const yRange = readRange('yMinLevel', 'yMaxLevel');

        const png = await renderChartToPng({
            type: 'line',
            data: { datasets: [{
                label: ylabel,
                data: data,
                borderColor: '#cc0000',
                borderWidth: 1.2,
                pointRadius: 0,
                fill: false,
                tension: 0
            }] },
            options: {
                scales: printChartScales(
                    {
                        type: 'linear',
                        title: { display: true, text: 'Time (s)' },
                        min: xRange.min !== null ? xRange.min : 0,
                        max: xRange.max !== null ? xRange.max : cachedDuration
                    },
                    {
                        title: { display: true, text: ylabel },
                        min: yRange.min, max: yRange.max
                    }
                ),
                plugins: { legend: { display: false } }
            }
        }, 1600, 900);

        const startY = drawHeader(doc, 'Level vs. Time');
        doc.addImage(png, 'PNG', 15, startY, 180, 100);
        drawFooter(doc);
    }

    // -----------------------------------------------------------------------
    //  Tab 2: Octave Bands
    // -----------------------------------------------------------------------
    async function pdfOctave(doc) {
        const bandType = document.querySelector('input[name="bandType"]:checked').value;
        const fw = getFreqWeight();

        // Apply weighting first (handles A/C resample to 48 kHz). Then make
        // sure the signal is at 48 kHz for octFilt — it will be already if
        // A or C was selected, otherwise resample now.
        const { signal: weightedSignal, fs: weightedFs } =
            await applyFreqWeight(cachedSignalPa, cachedFs);
        const sig = weightedFs === 48000
            ? weightedSignal
            : await resampleIfNeeded(weightedSignal, weightedFs, 48000);

        const { freqLabels, spl } = octFilt(sig, bandType);
        const yRange = readRange('yMinLevel', 'yMaxLevel');
        const ylabel = fw === 'A' ? 'SPL (dBA)' :
                       fw === 'C' ? 'SPL (dBC)' :
                                    'SPL (dB re 20 µPa)';

        const png = await renderChartToPng({
            type: 'bar',
            data: {
                labels: freqLabels,
                datasets: [{
                    label: ylabel,
                    data: spl,
                    backgroundColor: '#cc0000',
                    borderColor: '#000000',
                    borderWidth: 0.5
                }]
            },
            options: {
                scales: printChartScales(
                    { title: { display: true, text: 'Frequency band (Hz)' } },
                    { title: { display: true, text: ylabel },
                      min: yRange.min, max: yRange.max }
                ),
                plugins: { legend: { display: false } }
            }
        }, 1600, 900);

        const startY = drawHeader(doc, bandType === 'whole' ?
            'Octave Bands (1/1)' : 'Octave Bands (1/3)');
        doc.addImage(png, 'PNG', 15, startY, 180, 100);
        drawFooter(doc);
    }

    // -----------------------------------------------------------------------
    //  Tab 3: FFT Spectrum
    // -----------------------------------------------------------------------
    async function pdfFFT(doc) {
        const nfft = getFftSize();
        const useWindow = getUseWindow();
        const fw = getFreqWeight();

        const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

        const { freq, spl } = fftSPL(signal, fs, nfft, useWindow, 0.5);

        const xRange = readRange('xMinFreq', 'xMaxFreq');
        const yRange = readRange('yMinLevel', 'yMaxLevel');
        const minFreq = xRange.min !== null ? xRange.min : 20;
        const maxFreq = xRange.max !== null ? xRange.max : Math.min(20000, fs / 2);

        const data = [];
        for (let i = 0; i < freq.length; i++) {
            if (freq[i] >= minFreq && freq[i] <= maxFreq) {
                data.push({ x: freq[i], y: spl[i] });
            }
        }
        const ylabel = fw === 'A' ? 'SPL (dBA)' :
                       fw === 'C' ? 'SPL (dBC)' :
                                    'SPL (dB re 20 µPa)';

        const png = await renderChartToPng({
            type: 'line',
            data: { datasets: [{
                label: ylabel,
                data: data,
                borderColor: '#cc0000',
                borderWidth: 1.0,
                pointRadius: 0,
                fill: false
            }] },
            options: {
                scales: printChartScales(
                    {
                        type: 'logarithmic',
                        min: minFreq, max: maxFreq,
                        title: { display: true, text: 'Frequency (Hz)' },
                        ticks: {
                            color: '#000', font: { size: 10 },
                            callback: (v) => {
                                const labels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
                                if (labels.includes(Number(v))) {
                                    return v >= 1000 ? (v / 1000) + 'k' : v;
                                }
                                return '';
                            }
                        }
                    },
                    {
                        title: { display: true, text: ylabel },
                        min: yRange.min, max: yRange.max
                    }
                ),
                plugins: { legend: { display: false } }
            }
        }, 1600, 900);

        const startY = drawHeader(doc, 'FFT Spectrum');
        doc.addImage(png, 'PNG', 15, startY, 180, 100);
        drawFooter(doc);
    }

    // -----------------------------------------------------------------------
    //  Tab 4: Spectrogram
    //
    //  Hand-rendered onto an off-screen canvas — same approach as on-screen,
    //  but with a "hot" black-to-white-via-red colourmap that prints well
    //  against a white page. Axis labels and a colourbar are drawn on the
    //  PDF page itself rather than the canvas (so they look crisp at any
    //  scale). The canvas image is overlaid only with the spectrogram pixels.
    // -----------------------------------------------------------------------
    async function pdfSpectrogram(doc) {
        const nfft = getFftSize();
        const useWindow = getUseWindow();

        const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

        const { freq, time, spec, nBins, nFrames } =
            sonogramSPL(signal, fs, nfft, useWindow, 0.75);

        let globalMax = -Infinity;
        for (let i = 0; i < spec.length; i++) {
            if (spec[i] > globalMax) globalMax = spec[i];
        }
        const cRange = readRange('cMinDb', 'cMaxDb');
        const xRange = readRange('xMinTime', 'xMaxTime');
        const yRange = readRange('yMinSpecFreq', 'yMaxSpecFreq');

        const minDb = cRange.min !== null ? cRange.min : 10;
        const maxDb = cRange.max !== null ? cRange.max : Math.ceil(globalMax);
        const tMin  = xRange.min !== null ? xRange.min : time[0];
        const tMax  = xRange.max !== null ? xRange.max : time[time.length - 1];
        const fMin  = yRange.min !== null ? yRange.min : 20;
        const fMax  = yRange.max !== null ? yRange.max : freq[freq.length - 1];

        const dataUrl = renderSpectrogramOffscreen(
            freq, time, spec, nBins, nFrames,
            minDb, maxDb, tMin, tMax, fMin, fMax,
            1400, 700
        );

        const startY = drawHeader(doc, 'Spectrogram');
        const plotX = 25, plotY = startY, plotW = 160, plotH = 90;

        // The image goes inside an inset (so axes can be drawn around it)
        doc.addImage(dataUrl, 'PNG', plotX, plotY, plotW, plotH);

        drawSpecAxes(doc, plotX, plotY, plotW, plotH, tMin, tMax, fMin, fMax);
        drawColourbar(doc, plotX + plotW + 5, plotY, 6, plotH, minDb, maxDb);

        drawFooter(doc);
    }

    // -----------------------------------------------------------------------
    //  Tab 5: BS 4142 (stacked time + spectrogram + Leq summary)
    // -----------------------------------------------------------------------
    async function pdfBs4142(doc) {
        const tau = getTimeWeightTau();
        const fw = getFreqWeight();
        const tauLabel = (document.querySelector('input[name="timeWeight"]:checked') || {}).value || 'F';

        const { signal, fs } = await applyFreqWeight(cachedSignalPa, cachedFs);

        const startY = drawHeader(doc, 'BS 4142 Analysis');

        // ---- Time series for Lp (100 ms) and short-time Leq (10 ms) ----
        const lp       = computeLpTimeSeries(signal, fs, tau, /*stepSec*/ 0.1);
        const leqShort = computeLeqShortTime(signal, fs, /*blockSec*/ 0.010);

        // ---- Period summary table at top: Leq + L90 for selected + residual ----
        const stats = computeLeq(signal, fs, lp);
        const wLabel = fw === 'A' ? ' dBA' : fw === 'C' ? ' dBC' : ' dB';

        let y = startY;
        const pageW = doc.internal.pageSize.getWidth();
        const tableX = 15, tableW = pageW - 30;
        // 5 columns: Period, Leq, L90, Duration, Regions
        const colWs = [42, 36, 36, 36, tableW - 42 - 36 - 36 - 36];
        const colX = [tableX];
        for (let i = 0; i < colWs.length; i++) colX.push(colX[i] + colWs[i]);

        // Header row
        doc.setFillColor(230);
        doc.rect(tableX, y, tableW, 7, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.text('Period',   colX[0] + 2, y + 5);
        doc.text('Leq',      colX[1] + 2, y + 5);
        doc.text('L90',      colX[2] + 2, y + 5);
        doc.text('Duration', colX[3] + 2, y + 5);
        doc.text('Regions',  colX[4] + 2, y + 5);

        // Selected row
        y += 7;
        doc.setDrawColor(180);
        doc.setLineWidth(0.2);
        doc.line(tableX, y, tableX + tableW, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0);
        doc.text('Selected Period', colX[0] + 2, y + 5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(204, 0, 0);
        doc.text(stats.selectedLeq !== null ? stats.selectedLeq.toFixed(1) + wLabel : '—', colX[1] + 2, y + 5);
        doc.text(stats.selectedL90 !== null ? stats.selectedL90 + wLabel             : '—', colX[2] + 2, y + 5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0);
        doc.text(stats.selectedDuration.toFixed(2) + ' s', colX[3] + 2, y + 5);
        doc.text(String(selectedRegions.length),           colX[4] + 2, y + 5);

        // Residual row
        y += 7;
        doc.line(tableX, y, tableX + tableW, y);
        doc.setFont('helvetica', 'normal');
        doc.text('Residual Period', colX[0] + 2, y + 5);
        doc.setFont('helvetica', 'bold');
        doc.text(stats.excludedLeq !== null ? stats.excludedLeq.toFixed(1) + wLabel : '—', colX[1] + 2, y + 5);
        doc.text(stats.excludedL90 !== null ? stats.excludedL90 + wLabel             : '—', colX[2] + 2, y + 5);
        doc.setFont('helvetica', 'normal');
        doc.text(stats.excludedDuration.toFixed(2) + ' s', colX[3] + 2, y + 5);
        doc.text('—',                                      colX[4] + 2, y + 5);
        y += 7;
        doc.line(tableX, y, tableX + tableW, y);
        y += 6;

        // ---- Top plot: dual-trace time history ----
        const ylabel = fw === 'A' ? 'L (dBA)' :
                       fw === 'C' ? 'L (dBC)' :
                                    'L (dB re 20 µPa)';
        const lpLabel  = `Lp ${tauLabel}-${fw === 'Lin' ? 'Z' : fw} (100 ms)`;
        const leqLabel = `Leq-${fw === 'Lin' ? 'Z' : fw} (10 ms)`;

        const xRange = readRange('xMinTime', 'xMaxTime');
        const yRange = readRange('yMinLevel', 'yMaxLevel');

        // Region annotations as light grey boxes for print
        const annotations = {};
        selectedRegions.forEach((r, i) => {
            annotations['region' + i] = {
                type: 'box',
                xScaleID: 'x',
                xMin: r.tStart, xMax: r.tEnd,
                backgroundColor: 'rgba(0, 0, 0, 0.10)',
                borderColor: '#000000',
                borderWidth: 0.5,
                drawTime: 'beforeDatasetsDraw'
            };
        });

        const timePng = await renderChartToPng({
            type: 'line',
            data: {
                datasets: [
                    {
                        label: leqLabel,
                        data: toXYPairs(leqShort.times, leqShort.values),
                        borderColor: '#cc0000',
                        borderWidth: 0.8,
                        pointRadius: 0,
                        fill: false,
                        tension: 0,
                        order: 2
                    },
                    {
                        label: lpLabel,
                        data: toXYPairs(lp.times, lp.values),
                        borderColor: '#000000',
                        borderWidth: 1.2,
                        pointRadius: 0,
                        fill: false,
                        tension: 0,
                        order: 1
                    }
                ]
            },
            options: {
                scales: printChartScales(
                    {
                        type: 'linear',
                        title: { display: true, text: 'Time (s)' },
                        min: xRange.min !== null ? xRange.min : 0,
                        max: xRange.max !== null ? xRange.max : cachedDuration
                    },
                    {
                        title: { display: true, text: ylabel },
                        min: yRange.min, max: yRange.max
                    }
                ),
                plugins: {
                    legend: {
                        display: true, position: 'top', align: 'end',
                        labels: { color: '#000', boxWidth: 16, font: { size: 10 } }
                    },
                    annotation: { annotations }
                }
            }
        }, 1600, 700);

        doc.addImage(timePng, 'PNG', 15, y, 180, 75);
        y += 80;

        // ---- Bottom plot: Spectrogram with hot colourmap ----
        const nfft = getFftSize();
        const useWindow = getUseWindow();
        const sono = sonogramSPL(signal, fs, nfft, useWindow, 0.75);

        let globalMax = -Infinity;
        for (let i = 0; i < sono.spec.length; i++) {
            if (sono.spec[i] > globalMax) globalMax = sono.spec[i];
        }
        const cRange = readRange('cMinDb', 'cMaxDb');
        const yRange2 = readRange('yMinSpecFreq', 'yMaxSpecFreq');
        const minDb = cRange.min !== null ? cRange.min : 10;
        const maxDb = cRange.max !== null ? cRange.max : Math.ceil(globalMax);
        const tMin = xRange.min !== null ? xRange.min : sono.time[0];
        const tMax = xRange.max !== null ? xRange.max : sono.time[sono.time.length - 1];
        const fMin = yRange2.min !== null ? yRange2.min : 20;
        const fMax = yRange2.max !== null ? yRange2.max : sono.freq[sono.freq.length - 1];

        const specImg = renderSpectrogramOffscreen(
            sono.freq, sono.time, sono.spec, sono.nBins, sono.nFrames,
            minDb, maxDb, tMin, tMax, fMin, fMax,
            1400, 600);

        const specX = 25, specW = 160, specH = 70;
        doc.addImage(specImg, 'PNG', specX, y, specW, specH);

        drawSpecAxes(doc, specX, y, specW, specH, tMin, tMax, fMin, fMax);
        drawColourbar(doc, specX + specW + 5, y, 6, specH, minDb, maxDb);

        // Region markers along the top of the spectrogram (vertical bars)
        selectedRegions.forEach((r) => {
            const tDur = tMax - tMin;
            const x1 = specX + ((r.tStart - tMin) / tDur) * specW;
            const x2 = specX + ((r.tEnd   - tMin) / tDur) * specW;
            const lo = Math.max(specX, Math.min(specX + specW, x1));
            const hi = Math.max(specX, Math.min(specX + specW, x2));
            if (hi - lo < 0.3) return;
            doc.setDrawColor(0, 0, 0);
            doc.setFillColor(0, 0, 0);
            doc.setLineWidth(0.4);
            // 2 mm tall mark above the spectrogram
            doc.rect(lo, y - 1.5, hi - lo, 1, 'S');
        });

        drawFooter(doc);
    }

    // -----------------------------------------------------------------------
    //  Spectrogram pixel renderer. Same loops as the on-screen drawer but
    //  with a "hot" colourmap (black→dark red→red→orange→yellow→white) that
    //  prints meaningfully on a white page.
    // -----------------------------------------------------------------------
    function renderSpectrogramOffscreen(freq, time, spec, nBins, nFrames,
                                        minDb, maxDb, tMin, tMax, fMin, fMax,
                                        widthPx, heightPx) {
        const canvas = document.createElement('canvas');
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext('2d');

        const imageData = ctx.createImageData(widthPx, heightPx);
        const data = imageData.data;

        const logFMin = Math.log10(Math.max(fMin, 1));
        const logFMax = Math.log10(Math.max(fMax, fMin + 1));
        const fNyquist = freq[freq.length - 1];

        const tDuration = tMax - tMin;
        const totalDuration = time[time.length - 1] - time[0];

        for (let px = 0; px < widthPx; px++) {
            const t = tMin + (px / widthPx) * tDuration;
            const fracFrame = (t - time[0]) / totalDuration;
            let frameIdx = Math.round(fracFrame * (nFrames - 1));
            frameIdx = Math.max(0, Math.min(nFrames - 1, frameIdx));

            for (let py = 0; py < heightPx; py++) {
                const yNorm = 1 - py / heightPx;
                const f = Math.pow(10, logFMin + yNorm * (logFMax - logFMin));
                let binIdx = Math.round(f * nBins / fNyquist);
                binIdx = Math.max(0, Math.min(nBins - 1, binIdx));
                const splVal = spec[binIdx * nFrames + frameIdx];
                const c = hotColourmap(splVal, minDb, maxDb);
                const idx = (py * widthPx + px) * 4;
                data[idx] = c[0]; data[idx + 1] = c[1]; data[idx + 2] = c[2]; data[idx + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
    }

    // 5-stop hot colourmap for printable spectrograms.
    // 0.0  black            (low energy = blank space on the page)
    // 0.25 dark red
    // 0.5  red
    // 0.75 orange
    // 1.0  yellow
    function hotColourmap(value, minDb, maxDb) {
        const t = Math.max(0, Math.min(1, (value - minDb) / (maxDb - minDb)));
        // Piecewise linear interpolation between the stops above
        const stops = [
            [0.00, 255, 255, 255],   // white (lowest energy → blank)
            [0.20, 255, 230, 150],   // pale yellow
            [0.45, 230, 100,   0],   // orange
            [0.70, 180,   0,   0],   // dark red
            [1.00,  50,   0,   0]    // near-black red
        ];
        for (let i = 1; i < stops.length; i++) {
            if (t <= stops[i][0]) {
                const [t1, r1, g1, b1] = stops[i - 1];
                const [t2, r2, g2, b2] = stops[i];
                const f = (t - t1) / (t2 - t1);
                return [
                    Math.round(r1 + f * (r2 - r1)),
                    Math.round(g1 + f * (g2 - g1)),
                    Math.round(b1 + f * (b2 - b1))
                ];
            }
        }
        return [50, 0, 0];
    }

    // -----------------------------------------------------------------------
    //  Spectrogram axis decoration — black lines and tick labels around
    //  the image rectangle that addImage() puts on the page.
    // -----------------------------------------------------------------------
    function drawSpecAxes(doc, x, y, w, h, tMin, tMax, fMin, fMax) {
        // Frame
        doc.setDrawColor(0);
        doc.setLineWidth(0.3);
        doc.rect(x, y, w, h, 'S');

        // Axis titles
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.text('Time (s)', x + w / 2, y + h + 9, { align: 'center' });
        // Vertical "Frequency (Hz)" label — rotated text via the angle option.
        // Anchor is the centre of the rotation so positioning lines up cleanly
        // along the left edge of the plot.
        doc.text('Frequency (Hz)', x - 14, y + h / 2,
                 { align: 'center', angle: 90 });

        // Frequency tick labels (log scale) on the left side of the frame
        const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        const logFMin = Math.log10(Math.max(fMin, 1));
        const logFMax = Math.log10(Math.max(fMax, fMin + 1));
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        freqLabels.forEach((f) => {
            if (f < fMin || f > fMax) return;
            const yNorm = (Math.log10(f) - logFMin) / (logFMax - logFMin);
            const py = y + h * (1 - yNorm);
            // Tick mark
            doc.setDrawColor(0);
            doc.line(x - 1, py, x, py);
            doc.text(f >= 1000 ? (f / 1000) + 'k' : String(f),
                     x - 2, py + 1, { align: 'right' });
        });

        // Time tick labels along the bottom
        const tDur = tMax - tMin;
        const step = tDur > 30 ? 10 : tDur > 10 ? 5 : tDur > 2 ? 1 : 0.5;
        for (let t = Math.ceil(tMin / step) * step; t <= tMax + 1e-6; t += step) {
            const px = x + ((t - tMin) / tDur) * w;
            doc.setDrawColor(0);
            doc.line(px, y + h, px, y + h + 1);
            const label = step < 1 ? t.toFixed(1) : t.toFixed(0);
            doc.text(label, px, y + h + 4, { align: 'center' });
        }
    }

    // Colourbar drawn beside the spectrogram showing dB range.
    function drawColourbar(doc, x, y, w, h, minDb, maxDb) {
        // Build a tall N-pixel canvas, sample the colourmap, paint it.
        const N = 200;
        const c = document.createElement('canvas');
        c.width = 1; c.height = N;
        const cctx = c.getContext('2d');
        const img = cctx.createImageData(1, N);
        for (let i = 0; i < N; i++) {
            const v = minDb + (1 - i / (N - 1)) * (maxDb - minDb);
            const col = hotColourmap(v, minDb, maxDb);
            const idx = i * 4;
            img.data[idx] = col[0]; img.data[idx + 1] = col[1];
            img.data[idx + 2] = col[2]; img.data[idx + 3] = 255;
        }
        cctx.putImageData(img, 0, 0);
        doc.addImage(c.toDataURL('image/png'), 'PNG', x, y, w, h);

        // Frame
        doc.setDrawColor(0);
        doc.setLineWidth(0.3);
        doc.rect(x, y, w, h, 'S');

        // Tick labels: max at top, min at bottom, plus a midpoint
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(0);
        doc.text(maxDb.toFixed(0), x + w + 1, y + 2);
        doc.text(((minDb + maxDb) / 2).toFixed(0), x + w + 1, y + h / 2 + 1);
        doc.text(minDb.toFixed(0), x + w + 1, y + h);

        doc.setFont('helvetica', 'bold');
        doc.text('dB', x + w / 2, y - 1.5, { align: 'center' });
    }

    // -----------------------------------------------------------------------
    //  Compute Leq (from the freq-weighted full-rate signal) and L90
    //  (from a 100 ms Lp time series) for the selected and residual
    //  partitions, in one pass each.
    //
    //  signal     - freq-weighted pressure samples
    //  fs         - sample rate of `signal` (after any applyFreqWeight resample)
    //  lpSeries   - { times, values } at 100 ms steps (already time/freq weighted)
    // -----------------------------------------------------------------------
    function computeLeq(signal, fs, lpSeries) {
        const N = signal.length;
        const pRefSq = 20e-6 * 20e-6;

        let selSumSq = 0, selCount = 0;
        let excSumSq = 0, excCount = 0;
        let totalSelDuration = 0;
        const merged = mergeRegions(selectedRegions);

        if (merged.length === 0) {
            for (let i = 0; i < N; i++) excSumSq += signal[i] * signal[i];
            excCount = N;
        } else {
            totalSelDuration = merged.reduce((s, r) => s + (r.tEnd - r.tStart), 0);
            let regionIdx = 0;
            for (let i = 0; i < N; i++) {
                const t = i / fs;
                while (regionIdx < merged.length && t >= merged[regionIdx].tEnd) regionIdx++;
                const inside = regionIdx < merged.length && t >= merged[regionIdx].tStart;
                const sq = signal[i] * signal[i];
                if (inside) { selSumSq += sq; selCount++; }
                else        { excSumSq += sq; excCount++; }
            }
        }

        // L90: split the Lp series the same way and compute the percentile
        // of each partition (computeL90 is defined in nx43wr-analysis.js).
        let selL90 = null, excL90 = null;
        if (lpSeries && lpSeries.values && lpSeries.times) {
            const selSamples = [], excSamples = [];
            for (let i = 0; i < lpSeries.values.length; i++) {
                const inside = isInsideMergedRegions(lpSeries.times[i], merged);
                (inside ? selSamples : excSamples).push(lpSeries.values[i]);
            }
            if (selSamples.length > 0) selL90 = computeL90(selSamples);
            if (excSamples.length > 0) excL90 = computeL90(excSamples);
        }

        return {
            selectedLeq: selCount > 0
                ? 10 * Math.log10((selSumSq / selCount) / pRefSq + 1e-30)
                : null,
            excludedLeq: excCount > 0
                ? 10 * Math.log10((excSumSq / excCount) / pRefSq + 1e-30)
                : null,
            selectedL90: selL90,
            excludedL90: excL90,
            selectedDuration: totalSelDuration,
            excludedDuration: excCount / fs
        };
    }

})();