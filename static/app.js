// Global variables
let terminal;
let fitAddon;
let socket;
let currentJobId = null;
let currentResults = null;

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    initTerminal();
    initSocket();
    // checkCredentials() removed from here, moved to socket connect

    // Enter key to fetch results
    document.getElementById('job-id-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            fetchResults();
        }
    });
});

// Initialize xterm.js terminal
function initTerminal() {
    terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#0f0f23',
            foreground: '#ffffff',
            cursor: '#e94560',
            selection: '#e9456040'
        }
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    const container = document.getElementById('terminal');
    terminal.open(container);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData(data => {
        if (socket && socket.connected) {
            socket.emit('terminal_input', { data: data });
        }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        fitAddon.fit();
        if (socket && socket.connected) {
            socket.emit('terminal_resize', {
                rows: terminal.rows,
                cols: terminal.cols
            });
        }
    });
}

// Initialize Socket.IO
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Terminal connected');
        fitAddon.fit();
        socket.emit('terminal_resize', {
            rows: terminal.rows,
            cols: terminal.cols
        });
        // Check credentials after connection is established
        checkCredentials();
    });

    socket.on('terminal_output', (data) => {
        terminal.write(data.data);
    });

    socket.on('disconnect', () => {
        console.log('Terminal disconnected');
    });
}

// Send command to terminal
function sendCommand(command) {
    if (socket && socket.connected) {
        socket.emit('terminal_input', { data: command + '\n' });
        terminal.focus();
    }
}

// Check AWS credentials
async function checkCredentials() {
    if (!socket || !socket.connected) return;

    updateCredentialStatus('checking', 'Syncing credentials...');

    try {
        // First sync credentials from terminal
        await fetch('/api/sync-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ socket_id: socket.id })
        });

        updateCredentialStatus('checking', 'Checking credentials...');

        // Then check validity
        const response = await fetch('/api/check-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ socket_id: socket.id })
        });

        const data = await response.json();

        if (data.success) {
            const account = data.account;
            const expectedAccount = '620778743555';

            if (account === expectedAccount) {
                updateCredentialStatus('connected', `✓ Connected to ml-models-dev (${account})`);
            } else {
                updateCredentialStatus('disconnected', `⚠ Wrong account: ${account} (need ${expectedAccount})`);
            }
        } else {
            updateCredentialStatus('disconnected', '✗ Not authenticated');
        }
    } catch (error) {
        updateCredentialStatus('disconnected', '✗ Connection error');
    }
}

function refreshCredentials() {
    checkCredentials();
}

function updateCredentialStatus(status, text) {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    indicator.className = 'status-indicator ' + status;
    statusText.textContent = text;
}

// Fetch results from S3
async function fetchResults() {
    const jobIdInput = document.getElementById('job-id-input');
    const jobId = jobIdInput.value.trim();

    if (!jobId) {
        showStatus('error', 'Please enter a JOB_ID');
        return;
    }

    // Validate UUID format (basic check)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
        showStatus('error', 'Invalid JOB_ID format. Expected UUID format.');
        return;
    }

    const fetchBtn = document.getElementById('fetch-btn');
    fetchBtn.disabled = true;
    fetchBtn.textContent = '⏳ Fetching...';

    showStatus('info', 'Fetching results from S3...');

    try {
        const response = await fetch('/api/fetch-results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_id: jobId,
                socket_id: socket.id
            })
        });

        const data = await response.json();

        if (data.success) {
            currentJobId = jobId;
            currentResults = data.results;
            displayResults(data);
            showStatus('success', `✓ Found ${data.file_count} test case(s)`);
        } else {
            showStatus('error', data.error || 'Failed to fetch results');
            document.getElementById('results-container').innerHTML = `
                <div class="empty-state">
                    <p>❌ ${data.error}</p>
                    ${data.searched_path ? `<p class="hint">Searched: ${data.searched_path}</p>` : ''}
                </div>
            `;
        }
    } catch (error) {
        showStatus('error', 'Network error: ' + error.message);
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '🔍 Fetch Results';
    }
}

// Display results in table
function displayResults(data) {
    const container = document.getElementById('results-container');
    const summaryContainer = document.getElementById('results-summary');
    const summaryStats = document.getElementById('summary-stats');

    if (!data.results || data.results.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
        summaryContainer.classList.add('hidden');
        return;
    }

    // Build table
    const scoreNames = data.score_names;

    let tableHtml = `
        <table class="results-table">
            <thead>
                <tr>
                    <th>Test Case</th>
                    <th>Result</th>
                    ${scoreNames.map(name => `<th>${formatScoreName(name)}</th>`).join('')}
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    // Calculate stats
    const stats = {};
    scoreNames.forEach(name => {
        stats[name] = { sum: 0, count: 0 };
    });

    data.results.forEach(result => {
        const scores = result.scores;

        tableHtml += `
            <tr>
                <td class="test-case-id" onclick="viewDetail('${result.filename}')">${result.test_case_id}</td>
                <td><span class="result-badge ${result.result.toLowerCase()}">${result.result}</span></td>
        `;

        scoreNames.forEach(name => {
            const score = scores[name];
            if (score) {
                const value = score.value;
                const className = getScoreClass(value);
                stats[name].sum += value;
                stats[name].count += 1;
                tableHtml += `<td class="score-cell ${className}">${(value * 100).toFixed(0)}%</td>`;
            } else {
                tableHtml += `<td class="score-cell">-</td>`;
            }
        });

        tableHtml += `
                <td>
                    <button class="btn btn-secondary btn-small" onclick="viewDetail('${result.filename}')">
                        View Details
                    </button>
                </td>
            </tr>
        `;
    });

    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;

    // Display summary
    let summaryHtml = '<div class="summary-grid">';
    summaryHtml += `
        <div class="summary-card">
            <div class="label">Test Cases</div>
            <div class="value">${data.results.length}</div>
        </div>
    `;

    scoreNames.forEach(name => {
        if (stats[name].count > 0) {
            const avg = stats[name].sum / stats[name].count;
            summaryHtml += `
                <div class="summary-card">
                    <div class="label">${formatScoreName(name)}</div>
                    <div class="value" style="color: ${getScoreColor(avg)}">${(avg * 100).toFixed(1)}%</div>
                </div>
            `;
        }
    });

    summaryHtml += '</div>';
    summaryStats.innerHTML = summaryHtml;
    summaryContainer.classList.remove('hidden');
}

// View detail for a specific test case
async function viewDetail(filename) {
    if (!currentJobId) return;

    const modal = document.getElementById('detail-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');

    modalTitle.textContent = filename.replace('.jsonl', '');
    modalBody.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    modal.classList.remove('hidden');

    try {
        const response = await fetch('/api/get-result-detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_id: currentJobId,
                filename: filename,
                socket_id: socket.id
            })
        });

        const data = await response.json();

        if (data.success) {
            displayDetailModal(data.data);
        } else {
            modalBody.innerHTML = `<p class="error">Failed to load details: ${data.error}</p>`;
        }
    } catch (error) {
        modalBody.innerHTML = `<p class="error">Network error: ${error.message}</p>`;
    }
}

function displayDetailModal(data) {
    const modalBody = document.getElementById('modal-body');

    let html = '';

    // Scores section
    html += '<div class="detail-section"><h4>📊 Evaluation Scores</h4>';
    html += '<table class="results-table">';
    html += '<thead><tr><th>Metric</th><th>Score</th><th>Context</th></tr></thead><tbody>';

    (data.scores || []).forEach(score => {
        const className = getScoreClass(score.value);
        html += `
            <tr>
                <td>${formatScoreName(score.name)}</td>
                <td class="score-cell ${className}">${(score.value * 100).toFixed(0)}%</td>
                <td style="max-width: 400px; font-size: 0.85rem; color: #aaa;">
                    ${score.context ? truncateText(score.context, 200) : '-'}
                </td>
            </tr>
        `;
    });

    html += '</tbody></table></div>';

    // Raw JSON section
    html += '<div class="detail-section"><h4>📄 Raw Data</h4>';
    html += `<pre>${JSON.stringify(data, null, 2)}</pre></div>`;

    modalBody.innerHTML = html;
}

function closeModal() {
    document.getElementById('detail-modal').classList.add('hidden');
}

// Close modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// Helper functions
function showStatus(type, message) {
    const statusEl = document.getElementById('status-message');
    statusEl.className = `status-message ${type}`;
    statusEl.textContent = message;
    statusEl.classList.remove('hidden');

    if (type === 'success' || type === 'info') {
        setTimeout(() => {
            statusEl.classList.add('hidden');
        }, 5000);
    }
}

function formatScoreName(name) {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
}

function getScoreClass(value) {
    if (value >= 0.75) return 'high';
    if (value >= 0.5) return 'medium';
    return 'low';
}

function getScoreColor(value) {
    if (value >= 0.75) return '#00d4aa';
    if (value >= 0.5) return '#ffc107';
    return '#e94560';
}

function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}
