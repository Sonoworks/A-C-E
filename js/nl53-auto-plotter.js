// nl53-auto-plotter.js
// Visualization and interaction logic for NL-53 Auto Store page

let loader = null;
let currentChart = null;

// Wait for DOM to be fully loaded before setting up event listeners
document.addEventListener('DOMContentLoaded', function() {
    console.log('NL53 Auto Plotter: DOM loaded, initializing...');
    
    // Initialize loader now that NL53Loader class is available
    loader = new NL53Loader();
    console.log('Loader initialized:', loader);
    
    // --- Drag and drop ---
    
    const dropZone = document.getElementById('dropZone');
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.backgroundColor = '#f5e6e6';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.backgroundColor = '#ffffff';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.backgroundColor = '#ffffff';
        handleFolderUpload(e.dataTransfer.items);
    });

    // --- Browse button ---

    document.getElementById('folderInput').addEventListener('change', function(e) {
        if (e.target.files && e.target.files.length > 0) {
            handleFolderUpload(e.target.files);
        }
    });
});

// --- Process uploaded folder ---

async function handleFolderUpload(fileList) {
    hideError();
    hideSummary();
    hideChart();
    hideTable();
    document.getElementById('loadStatus').textContent = 'Loading...';
    document.getElementById('dataSummary').style.display = 'block';

    const result = await loader.loadFromFileList(fileList);

    if (!result.success) {
        showError(result.error);
        document.getElementById('dataSummary').style.display = 'none';
        return;
    }

    // Update UI with loaded data
    document.getElementById('folderName').textContent = loader.folderName;
    document.getElementById('folderDetails').innerHTML = 
        `<i class="fas fa-database text-primary"></i> ${loader.dataType} Data`;
    document.getElementById('fileInfo').style.display = 'flex';
    
    document.getElementById('dataType').textContent = loader.dataType === 'SLM' ? 'Broadband (SLM)' : 'Octave Bands (OCT)';
    document.getElementById('filesCount').textContent = result.fileCount;
    document.getElementById('measurementCount').textContent = result.measurementCount;
    document.getElementById('loadStatus').textContent = '✓ Ready';
    document.getElementById('dataSummary').style.display = 'block';

    // Plot data
    if (result.measurementCount > 0) {
        if (loader.dataType === 'SLM') {
            plotSLMData(loader.measurements);
        } else if (loader.dataType === 'OCT') {
            plotOCTData(loader.measurements);
        }
        populateDataTable(loader.measurements);
    }
}

// --- Plot SLM (Broadband) Data ---

function plotSLMData(measurements) {
    const chartData = measurements.map((m, idx) => ({
        x: idx,
        y: m.leq
    }));

    document.getElementById('chartRow').style.display = 'flex';
    document.getElementById('chartSubtitle').textContent = loader.folderName;

    if (currentChart) currentChart.destroy();

    const ctx = document.getElementById('dataChart').getContext('2d');

    currentChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Leq (dB)',
                data: chartData,
                borderColor: '#cc0000',
                backgroundColor: 'rgba(204, 0, 0, 0.05)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.2
            }]
        },
        options: {
            responsive: true,
            animation: false,
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Measurement Index', color: '#e0e0e0' },
                    ticks: { color: '#e0e0e0' }
                },
                y: {
                    title: { display: true, text: 'Leq (dB)', color: '#e0e0e0' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: '#e0e0e0' }
                }
            },
            plugins: {
                legend: { display: true, labels: { color: '#e0e0e0' } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`,
                        title: (ctx) => `Measurement ${ctx[0].parsed.x}`
                    }
                }
            }
        }
    });
}

// --- Plot OCT (Octave Band) Data ---

function plotOCTData(measurements) {
    // For OCT data, show the first measurement's band data as a bar chart
    if (measurements.length === 0) {
        console.warn('No measurements to plot');
        return;
    }

    const firstMeasurement = measurements[0];
    console.log('First measurement:', firstMeasurement);
    console.log('Bands type:', typeof firstMeasurement.bands, firstMeasurement.bands);
    
    // Get band labels from the loader or extract from bands object
    let bandLabels = [...(loader.bandLabels || [])];
    let bandValues = [];

    if (firstMeasurement.bands && typeof firstMeasurement.bands === 'object' && !Array.isArray(firstMeasurement.bands)) {
        // If bands is an object with frequency labels as keys
        console.log('Processing bands as object');
        bandLabels = Object.keys(firstMeasurement.bands).sort((a, b) => {
            const freqA = parseFloat(a);
            const freqB = parseFloat(b);
            return freqA - freqB;
        });
        bandValues = bandLabels.map(label => firstMeasurement.bands[label]);
    } else if (Array.isArray(firstMeasurement.bands)) {
        // If bands is an array of values
        console.log('Processing bands as array');
        bandValues = firstMeasurement.bands;
        
        // Generate labels if not available
        if (bandLabels.length === 0) {
            // 1/3 octave band center frequencies (Hz) - 31 bands
            const thirdOctaveBands = [
                '12.5Hz', '16Hz', '20Hz', '25Hz', '31.5Hz', '40Hz', '50Hz', '63Hz', '80Hz', '100Hz',
                '125Hz', '160Hz', '200Hz', '250Hz', '315Hz', '400Hz', '500Hz', '630Hz', '800Hz', '1kHz',
                '1.25kHz', '1.6kHz', '2kHz', '2.5kHz', '3.15kHz', '4kHz', '5kHz', '6.3kHz', '8kHz', '10kHz', '12.5kHz'
            ];
            bandLabels = thirdOctaveBands.slice(0, bandValues.length);
        }
    }

    // Filter out NaN values
    const validData = bandLabels.map((label, idx) => ({
        label: label,
        value: bandValues[idx]
    })).filter(item => !isNaN(item.value));

    console.log('Valid data points:', validData.length);

    if (validData.length === 0) {
        console.warn('No valid band data found');
        // Show a message in the chart area
        document.getElementById('chartRow').style.display = 'flex';
        const ctx = document.getElementById('dataChart');
        ctx.parentElement.innerHTML = '<p class="text-gray-400" style="padding: 20px;">No valid band data to display</p>';
        return;
    }

    const chartData = {
        labels: validData.map(d => d.label),
        data: validData.map(d => d.value)
    };

    console.log('Chart data ready:', chartData);

    document.getElementById('chartRow').style.display = 'flex';
    document.getElementById('chartSubtitle').textContent = loader.folderName + ' (First Measurement - OCT Bands)';

    if (currentChart) currentChart.destroy();

    const ctx = document.getElementById('dataChart').getContext('2d');

    try {
        currentChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: 'SPL (dB)',
                    data: chartData.data,
                    backgroundColor: '#cc0000',
                    borderColor: '#cc0000',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                indexAxis: 'x',
                scales: {
                    x: {
                        title: { display: true, text: 'Frequency Band', color: '#e0e0e0' },
                        ticks: { color: '#e0e0e0', font: { size: 10 } }
                    },
                    y: {
                        title: { display: true, text: 'SPL (dB)', color: '#e0e0e0' },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        ticks: { color: '#e0e0e0' }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`
                        }
                    }
                }
            }
        });
        console.log('Chart created successfully');
    } catch (error) {
        console.error('Error creating chart:', error);
    }
}

// --- Populate data table ---

function populateDataTable(measurements) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    // Display first 20 measurements
    const displayMeasurements = measurements.slice(0, 20);

    if (loader.dataType === 'SLM') {
        // SLM data: show Leq, Lmax, Lmin for each measurement
        displayMeasurements.forEach((m, idx) => {
            const row = document.createElement('tr');
            const leq = isNaN(m.leq) ? '-' : m.leq.toFixed(1);
            const lmax = isNaN(m.lmax) ? '-' : m.lmax.toFixed(1);
            const lmin = isNaN(m.lmin) ? '-' : m.lmin.toFixed(1);
            row.innerHTML = `
                <td>${idx}</td>
                <td>${leq}</td>
                <td>${lmax}</td>
                <td>${lmin}</td>
            `;
            tbody.appendChild(row);
        });
    } else if (loader.dataType === 'OCT') {
        // OCT data: show frequency band labels and their values
        if (displayMeasurements.length > 0 && displayMeasurements[0].bands) {
            const firstMeasurement = displayMeasurements[0];
            const bandLabels = Object.keys(firstMeasurement.bands).sort((a, b) => {
                const freqA = parseFloat(a);
                const freqB = parseFloat(b);
                return freqA - freqB;
            });

            // Create header row with band labels
            const headerRow = document.createElement('tr');
            headerRow.style.fontWeight = 'bold';
            headerRow.innerHTML = '<td>Index</td>' + 
                bandLabels.slice(0, 3).map(b => `<td>${b}</td>`).join('') +
                (bandLabels.length > 3 ? '<td>... (' + (bandLabels.length - 3) + ' more bands)</td>' : '');
            tbody.appendChild(headerRow);

            // Data rows
            displayMeasurements.forEach((m, idx) => {
                const row = document.createElement('tr');
                let cells = `<td>${idx}</td>`;
                
                for (let i = 0; i < Math.min(3, bandLabels.length); i++) {
                    const bandLabel = bandLabels[i];
                    const value = m.bands[bandLabel];
                    const displayValue = isNaN(value) ? '-' : value.toFixed(1);
                    cells += `<td>${displayValue} dB</td>`;
                }
                
                if (bandLabels.length > 3) {
                    const remainingValues = bandLabels.slice(3).map(label => {
                        const value = m.bands[label];
                        return isNaN(value) ? '-' : value.toFixed(1);
                    }).join(', ');
                    cells += `<td>${remainingValues}</td>`;
                }
                
                row.innerHTML = cells;
                tbody.appendChild(row);
            });
        }
    }

    if (measurements.length > 20) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="4" class="text-center text-gray-600 small">
                ... and ${measurements.length - 20} more measurements
            </td>
        `;
        tbody.appendChild(row);
    }

    document.getElementById('tableRow').style.display = 'flex';
}

// --- UI Helpers ---

function showError(message) {
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorAlert').style.display = 'block';
}

function hideError() {
    document.getElementById('errorAlert').style.display = 'none';
}

function hideSummary() {
    document.getElementById('dataSummary').style.display = 'none';
}

function hideChart() {
    document.getElementById('chartRow').style.display = 'none';
}

function hideTable() {
    document.getElementById('tableRow').style.display = 'none';
}